// 运输交接领域引擎：状态完全由事件重放得到。
// 关键不变量：
//  - 封签全局唯一，只能绑定一条运输链；拆箱即作废，重封须双人确认
//  - 任一未解除异常都会冻结后续放行；解除只能追加 anomaly.resolved 事件
//  - 交接时间窗在交接记录时判定一次；离线补传只并入证据，不重算时间窗
//  - 补传按 (设备序号, 设备内序号) 幂等去重
//  - 换车、拆箱必须两个不同的授权账号双人确认
//  - 超时标记由扫描追加事件，重启后重放仍在

import { requireZonedIso, toIsoUtc, classifyWindow } from "./time.js";

export const WRITE_ROLES = new Set(["管理员", "保护人员"]);

export class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new DomainError(code, message, details);
};

function requireActor(actor) {
  if (!actor || typeof actor.id !== "string" || typeof actor.name !== "string" || typeof actor.role !== "string") {
    fail("invalid_actor", "actor 必须包含 id/name/role");
  }
  if (actor.role === "只读访客") fail("forbidden", "只读访客无权执行写操作");
  if (!WRITE_ROLES.has(actor.role)) fail("forbidden", `角色 ${actor.role} 无权执行写操作`);
  return actor;
}

// 双人确认：两个不同的自然人账号，且角色都在授权集合内。
function requireDualConfirm(confirmations) {
  if (!Array.isArray(confirmations) || confirmations.length !== 2) {
    fail("dual_confirmation_required", "换车或拆箱必须由两名授权角色双人确认");
  }
  const [a, b] = confirmations;
  for (const c of confirmations) {
    if (!c || typeof c.id !== "string" || typeof c.name !== "string" || !WRITE_ROLES.has(c.role)) {
      fail("dual_confirmation_required", "双人确认的双方都必须是管理员或保护人员");
    }
  }
  if (a.id === b.id) fail("dual_confirmation_required", "双人确认必须由两个不同账号完成，不能同一人重复签署");
  return confirmations;
}

function requireOccurredAt(payload, field = "occurredAt") {
  return requireZonedIso(payload[field], field);
}

// ---------- 重放 ----------

function emptyState() {
  return {
    exists: false,
    status: "created",
    seals: [],
    handoffs: new Map(),
    releases: new Map(),
    anomalies: [],
    vehicleChanges: [],
    crateOpenings: [],
    evidence: new Map(),
    devices: new Map(),
    overdue: [],
    completedAt: null,
  };
}

export function replay(events) {
  const state = emptyState();
  for (const e of events) applyEvent(state, e);
  return state;
}

function applyEvent(state, event) {
  const p = event.payload;
  switch (event.type) {
    case "shipment.created": {
      Object.assign(state, {
        exists: true,
        shipmentId: p.shipmentId,
        artifactId: p.artifactId,
        artifactName: p.artifactName,
        fragilityLevel: p.fragilityLevel,
        routeTemplateId: p.routeTemplateId,
        vehicleType: p.vehicleType,
        nodes: p.nodes,
        packingChecks: p.packingChecks,
        requiredPhotoKinds: p.requiredPhotoKinds,
        envLimit: p.envLimit,
        createdAtEpoch: Date.parse(event.recordedAt),
      });
      break;
    }
    case "seal.bound": {
      state.seals.push({
        sealId: p.sealId,
        boundEpoch: p.occurredAtEpoch,
        boundNode: p.nodeSeq,
        status: "active",
        boundBy: event.actor,
        replacement: Boolean(p.replacement),
        presentAtHandoffs: [],
      });
      break;
    }
    case "handoff.recorded": {
      state.handoffs.set(p.nodeSeq, {
        formNo: p.formNo,
        occurredAtEpoch: p.occurredAtEpoch,
        location: p.location,
        temperatureC: p.temperatureC,
        humidityRh: p.humidityRh,
        shockTriggered: p.shockTriggered,
        tiltTriggered: p.tiltTriggered,
        sensorOffline: p.sensorOffline,
        checks: p.checks,
        photos: p.photos,
        sealIds: p.sealIds,
        carrierSignature: p.carrierSignature,
        windowClass: p.windowClass,
        offline: Boolean(p.offline),
        recordedBy: event.actor,
        eventSeq: event.seq,
      });
      for (const seal of state.seals) {
        if (p.sealIds.includes(seal.sealId)) seal.presentAtHandoffs.push(p.nodeSeq);
      }
      break;
    }
    case "anomaly.opened": {
      state.anomalies.push({
        anomalyId: p.anomalyId,
        nodeSeq: p.nodeSeq,
        kind: p.kind,
        severity: p.severity,
        description: p.description,
        occurredAtEpoch: p.occurredAtEpoch,
        status: "open",
        openedBy: event.actor,
        auto: Boolean(p.auto),
        evidence: [],
        resolution: null,
      });
      break;
    }
    case "evidence.supplemented": {
      const list = state.evidence.get(p.nodeSeq) ?? [];
      list.push({
        deviceId: p.deviceId,
        deviceSeq: p.deviceSeq,
        capturedAtEpoch: p.capturedAtEpoch,
        submittedAtEpoch: Date.parse(event.recordedAt),
        photos: p.photos ?? [],
        sensor: p.sensor ?? null,
        note: p.note ?? "",
        eventSeq: event.seq,
      });
      state.evidence.set(p.nodeSeq, list);
      state.devices.set(`${p.deviceId}:${p.deviceSeq}`, { eventSeq: event.seq, nodeSeq: p.nodeSeq });
      for (const anomaly of state.anomalies) {
        if (anomaly.status !== "open" || anomaly.nodeSeq !== p.nodeSeq) continue;
        if (anomaly.kind === "missing_photo" && (p.photos?.length ?? 0) > 0) anomaly.evidence.push({ eventSeq: event.seq });
        if (anomaly.kind === "sensor_offline" && p.sensor?.sensorOnline === true) anomaly.evidence.push({ eventSeq: event.seq });
      }
      break;
    }
    case "anomaly.resolved": {
      const anomaly = state.anomalies.find((a) => a.anomalyId === p.anomalyId);
      if (anomaly) {
        anomaly.status = "resolved";
        anomaly.resolution = { by: event.actor, note: p.note, atEpoch: p.resolvedAtEpoch, eventSeq: event.seq };
      }
      break;
    }
    case "node.released": {
      state.releases.set(p.nodeSeq, p.releasedAtEpoch);
      break;
    }
    case "shipment.completed": {
      state.status = "completed";
      state.completedAt = p.atEpoch;
      break;
    }
    case "vehicle.changed": {
      state.vehicleType = p.toVehicle;
      state.vehicleChanges.push({
        nodeSeq: p.nodeSeq,
        fromVehicle: p.fromVehicle,
        toVehicle: p.toVehicle,
        occurredAtEpoch: p.occurredAtEpoch,
        confirmations: p.confirmations,
        eventSeq: event.seq,
      });
      break;
    }
    case "crate.opened": {
      state.crateOpenings.push({
        nodeSeq: p.nodeSeq,
        reason: p.reason,
        cutSealIds: p.cutSealIds,
        occurredAtEpoch: p.occurredAtEpoch,
        confirmations: p.confirmations,
        eventSeq: event.seq,
      });
      for (const seal of state.seals) {
        if (p.cutSealIds.includes(seal.sealId)) seal.status = "voided";
      }
      break;
    }
    case "overdue.marked": {
      state.overdue.push({ nodeSeq: p.nodeSeq, kind: p.kind, markedEpoch: p.markedEpoch, deadlineEpoch: p.deadlineEpoch });
      break;
    }
    default:
      fail("unknown_event", `未知事件类型 ${event.type}`);
  }
}

// ---------- 引擎 ----------

export class ShippingEngine {
  constructor(store, catalog, options = {}) {
    this.store = store;
    this.catalog = catalog;
    this.now = options.now ?? (() => Date.now());
    this._cache = new Map();
    this._sealIndex = null;
  }

  // 读取并缓存重放状态；任何写命令后必须刷新对应运输链。
  _load(shipmentId) {
    if (!this._cache.has(shipmentId)) {
      const events = this.store.load(shipmentId);
      const state = events.length === 0 ? emptyState() : replay(events, this.catalog);
      state._events = events;
      this._cache.set(shipmentId, state);
    }
    return this._cache.get(shipmentId);
  }

  _refresh(shipmentId) {
    this._cache.delete(shipmentId);
    this._sealIndex = null;
    return this._load(shipmentId);
  }

  _append(shipmentId, type, actor, payload) {
    const event = this.store.append(shipmentId, { type, actor, payload });
    this._refresh(shipmentId);
    return event;
  }

  // 封签全局索引：扫描所有运输链，保证一个封签只能绑定一条链。
  _sealOwners() {
    if (this._sealIndex) return this._sealIndex;
    const index = new Map();
    for (const id of this.store.listShipmentIds()) {
      const state = this._load(id);
      for (const seal of state.seals) index.set(seal.sealId, id);
    }
    this._sealIndex = index;
    return index;
  }

  _requireShipment(shipmentId) {
    const state = this._load(shipmentId);
    if (!state.exists) fail("not_found", `运输链 ${shipmentId} 不存在`);
    return state;
  }

  _node(state, nodeSeq) {
    const node = state.nodes.find((n) => n.seq === nodeSeq);
    if (!node) fail("invalid_node", `路线节点 ${nodeSeq} 不存在`);
    return node;
  }

  _openAnomalies(state) {
    return state.anomalies.filter((a) => a.status === "open");
  }

  // 冻结闸门：任何后续放行/交接/换车都先过这一关。
  _requireNotFrozen(state, action) {
    const open = this._openAnomalies(state);
    if (open.length > 0) {
      fail("shipment_frozen", `存在未解除异常，${action}已被冻结，须先按异常处置流程解除`, {
        anomalyIds: open.map((a) => a.anomalyId),
      });
    }
  }

  _openAnomaly(shipmentId, nodeSeq, kind, severity, description, occurredAtEpoch, extra = {}) {
    // 注意：追加事件会刷新缓存中的状态对象，编号必须基于重放后的最新状态，
    // 否则一次交接中连续开出的多个异常会撞号。
    const fresh = this._load(shipmentId);
    const anomalyId = `AN-${shipmentId}-${String(fresh.anomalies.length + 1).padStart(3, "0")}`;
    this._append(shipmentId, "anomaly.opened", extra.actor ?? { id: "system", name: "系统", role: "管理员" }, {
      anomalyId,
      nodeSeq,
      kind,
      severity,
      description,
      occurredAtEpoch,
      auto: extra.auto ?? true,
    });
    return anomalyId;
  }

  // ---------- 命令：创建运输链 ----------

  createShipment(input) {
    const actor = requireActor(input.actor);
    const shipmentId = String(input.shipmentId ?? "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(shipmentId)) fail("invalid_shipment_id", "运输链编号只能包含字母、数字、下划线、连字符");
    if (this.store.load(shipmentId).length > 0) fail("already_exists", `运输链 ${shipmentId} 已存在`);

    const level = Number(input.fragilityLevel);
    const rule = this.catalog.fragilityRules[String(level)];
    if (!rule) fail("invalid_fragility", `未知脆弱等级 ${input.fragilityLevel}`);

    const vehicle = this.catalog.vehicleCapabilities.find((v) => v.type === input.vehicleType);
    if (!vehicle) fail("invalid_vehicle", `车辆类型 ${input.vehicleType} 不在能力目录中`);
    if (vehicle.maxFragility < level) {
      fail("vehicle_capability_exceeded", `${vehicle.type} 最高只支持脆弱等级 ${vehicle.maxFragility}，无法承运等级 ${level}`);
    }

    let nodes;
    if (Array.isArray(input.nodes) && input.nodes.length >= 2) {
      nodes = this._validateCustomNodes(input.nodes);
    } else {
      const template = this.catalog.routeTemplates.find((t) => t.id === (input.routeTemplateId ?? this.catalog.routeTemplates[0]?.id));
      if (!template) fail("invalid_route", "找不到路线模板");
      nodes = template.nodes.map((n) => ({
        seq: n.seq,
        code: n.code,
        name: n.name,
        owner: n.owner,
        timezone: n.timezone,
        windowStartEpoch: Date.parse(n.windowStart),
        windowEndEpoch: Date.parse(n.windowEnd),
        dwellMinutes: n.dwellMinutes,
      }));
    }

    const seals = Array.isArray(input.seals) ? input.seals : [];
    if (seals.length === 0) fail("invalid_seal", "创建运输链时必须至少绑定一个封签");
    const owners = this._sealOwners();
    for (const sealId of seals) {
      if (typeof sealId !== "string" || sealId.trim() === "") fail("invalid_seal", "封签编号不能为空");
      if (owners.has(sealId)) fail("seal_already_circulating", `封签 ${sealId} 已在运输链 ${owners.get(sealId)} 上流转，不得重复使用`);
    }
    if (new Set(seals).size !== seals.length) fail("invalid_seal", "同一运输链不能重复绑定同一封签");

    if (!input.artifactId || !input.artifactName) fail("invalid_artifact", "器物编号与名称必填");

    this._append(shipmentId, "shipment.created", actor, {
      shipmentId,
      artifactId: String(input.artifactId),
      artifactName: String(input.artifactName),
      fragilityLevel: level,
      routeTemplateId: input.routeTemplateId ?? null,
      vehicleType: vehicle.type,
      nodes,
      packingChecks: rule.packingChecks,
      requiredPhotoKinds: rule.requiredPhotoKinds,
      envLimit: {
        temperatureRangeC: rule.temperatureRangeC,
        humidityRangeRh: rule.humidityRangeRh,
      },
    });

    for (const sealId of seals) {
      this._append(shipmentId, "seal.bound", actor, {
        sealId,
        nodeSeq: 0,
        occurredAtEpoch: this.now(),
        replacement: false,
      });
    }
    return this.getShipment(shipmentId);
  }

  _validateCustomNodes(raw) {
    let lastEnd = -Infinity;
    const nodes = raw.map((n, i) => {
      const startEpoch = requireZonedIso(n.windowStart, `nodes[${i}].windowStart`);
      const endEpoch = requireZonedIso(n.windowEnd, `nodes[${i}].windowEnd`);
      if (endEpoch <= startEpoch) fail("invalid_window", `节点 ${n.code ?? i} 时间窗结束早于开始`);
      if (startEpoch < lastEnd) fail("invalid_window", `节点 ${n.code ?? i} 时间窗早于前一节点，UTC 排序不成立`);
      lastEnd = endEpoch;
      return {
        seq: i,
        code: String(n.code ?? `N${i}`),
        name: String(n.name ?? n.code ?? `节点${i}`),
        owner: String(n.owner ?? ""),
        timezone: String(n.timezone ?? "UTC"),
        windowStartEpoch: startEpoch,
        windowEndEpoch: endEpoch,
        dwellMinutes: Number(n.dwellMinutes ?? 60),
      };
    });
    return nodes;
  }

  // ---------- 命令：交接 ----------

  recordHandoff(input) {
    const actor = requireActor(input.actor);
    const state = this._requireShipment(input.shipmentId);
    const nodeSeq = Number(input.nodeSeq);
    this._node(state, nodeSeq);
    if (state.handoffs.has(nodeSeq)) fail("handoff_exists", `节点 ${nodeSeq} 已交接，旧记录不能修改，如有遗漏请走证据补传`);
    if (state.status === "completed") fail("shipment_completed", "运输链已完成");
    // 冻结是全局闸门，优先于节点顺序：异常未解除时任何后续交接一律拒绝。
    this._requireNotFrozen(state, "本节点交接");
    if (nodeSeq > 0) {
      const prevHandoff = state.handoffs.get(nodeSeq - 1);
      if (!prevHandoff) fail("node_locked", `前序节点 ${nodeSeq - 1} 尚未交接`);
      if (!state.releases.has(nodeSeq - 1)) fail("node_locked", `前序节点 ${nodeSeq - 1} 尚未放行，不能在节点 ${nodeSeq} 交接`);
    }

    const activeSeals = state.seals.filter((s) => s.status === "active");
    if (activeSeals.length === 0) fail("no_active_seal", "当前无有效封签，须先双人确认重封后才能交接");

    const checks = this._validateChecks(input.checks, state.packingChecks);
    const readings = this._validateReadings(input, state.envLimit);
    const photos = this._validatePhotos(input.photos);
    const signature = this._validateSignature(input.carrierSignature);
    const occurredAtEpoch = requireOccurredAt(input);
    const location = String(input.location ?? "").trim() || fail("invalid_location", "交接地点必填");
    const formNo = String(input.formNo ?? "").trim() || fail("invalid_form", "交接单号必填");

    const node = state.nodes[nodeSeq];
    const windowClass = classifyWindow(occurredAtEpoch, node.windowStartEpoch, node.windowEndEpoch);

    const event = this._append(input.shipmentId, "handoff.recorded", actor, {
      formNo,
      nodeSeq,
      occurredAtEpoch,
      location,
      ...readings,
      shockTriggered: Boolean(input.shockTriggered),
      tiltTriggered: Boolean(input.tiltTriggered),
      sensorOffline: Boolean(input.sensorOffline),
      checks,
      photos,
      sealIds: activeSeals.map((s) => s.sealId),
      carrierSignature: signature,
      windowClass,
      offline: Boolean(input.offline),
    });

    // 交接落账后逐项判定异常；任何异常都立即冻结后续放行。
    const opened = [];
    const at = occurredAtEpoch;
    if (readings.temperatureC < state.envLimit.temperatureRangeC.min || readings.temperatureC > state.envLimit.temperatureRangeC.max) {
      opened.push(this._openAnomaly(input.shipmentId, nodeSeq, "env_out_of_range", "high",
        `箱内温度 ${readings.temperatureC}℃ 超出等级${state.fragilityLevel}允许范围`, at, { actor }));
    }
    if (readings.humidityRh < state.envLimit.humidityRangeRh.min || readings.humidityRh > state.envLimit.humidityRangeRh.max) {
      opened.push(this._openAnomaly(input.shipmentId, nodeSeq, "env_out_of_range", "high",
        `箱内湿度 ${readings.humidityRh}%RH 超出允许范围`, at, { actor }));
    }
    if (input.shockTriggered) opened.push(this._openAnomaly(input.shipmentId, nodeSeq, "impact_triggered", "high", "冲击指示器触发", at, { actor }));
    if (input.tiltTriggered) opened.push(this._openAnomaly(input.shipmentId, nodeSeq, "tilt_triggered", "high", "倾斜指示器触发", at, { actor }));
    if (input.sensorOffline) opened.push(this._openAnomaly(input.shipmentId, nodeSeq, "sensor_offline", "high", "包装箱冲击传感器离线", at, { actor }));
    const failed = checks.filter((c) => c.result === "fail");
    if (failed.length > 0) {
      opened.push(this._openAnomaly(input.shipmentId, nodeSeq, "check_failed", "high",
        `包装检查项不合格：${failed.map((c) => c.item).join("；")}`, at, { actor }));
    }
    const missingKinds = state.requiredPhotoKinds.filter((kind) => !photos.some((photo) => photo.kind === kind));
    if (missingKinds.length > 0) {
      opened.push(this._openAnomaly(input.shipmentId, nodeSeq, "missing_photo", "medium",
        `交接照片缺失：${missingKinds.join("、")}`, at, { actor }));
    }
    if (windowClass === "late") {
      opened.push(this._openAnomaly(input.shipmentId, nodeSeq, "window_overdue", "medium",
        `交接时间 ${toIsoUtc(at)} 晚于节点时间窗结束 ${toIsoUtc(node.windowEndEpoch)}`, at, { actor }));
    }

    return { event, anomalies: opened, projection: this.getShipment(input.shipmentId) };
  }

  _validateChecks(inputChecks, expected) {
    if (!Array.isArray(inputChecks) || inputChecks.length !== expected.length) {
      fail("invalid_checks", `必须提交全部 ${expected.length} 项包装检查结果`);
    }
    return expected.map((item, i) => {
      const c = inputChecks[i];
      if (!c || (c.item !== undefined && c.item !== item)) fail("invalid_checks", `第 ${i + 1} 项检查内容与规范不一致`);
      if (!["pass", "fail"].includes(c.result)) fail("invalid_checks", `检查项「${item}」结果必须是 pass 或 fail`);
      return { item, result: c.result, note: typeof c.note === "string" ? c.note : "" };
    });
  }

  _validateReadings(input) {
    const temperatureC = Number(input.temperatureC);
    const humidityRh = Number(input.humidityRh);
    if (!Number.isFinite(temperatureC) || !Number.isFinite(humidityRh)) {
      fail("invalid_reading", "箱内温湿度必须是数值");
    }
    if (humidityRh < 0 || humidityRh > 100) fail("invalid_reading", "相对湿度必须在 0-100 之间");
    return { temperatureC, humidityRh };
  }

  _validatePhotos(inputPhotos) {
    if (!Array.isArray(inputPhotos)) return [];
    return inputPhotos.map((photo, i) => {
      if (!photo || typeof photo.kind !== "string" || typeof photo.ref !== "string") {
        fail("invalid_photo", `photos[${i}] 必须包含 kind 与 ref`);
      }
      return { kind: photo.kind, ref: photo.ref };
    });
  }

  _validateSignature(sig) {
    if (!sig || !sig.name || !sig.staffNo || !sig.org) {
      fail("invalid_signature", "承运人签名必须包含姓名 name、工号 staffNo、单位 org");
    }
    return { name: String(sig.name), staffNo: String(sig.staffNo), org: String(sig.org) };
  }

  // ---------- 命令：放行 ----------

  releaseNode(input) {
    const actor = requireActor(input.actor);
    const state = this._requireShipment(input.shipmentId);
    const nodeSeq = Number(input.nodeSeq);
    this._node(state, nodeSeq);
    if (!state.handoffs.has(nodeSeq)) fail("no_handoff", `节点 ${nodeSeq} 尚未交接，不能放行`);
    if (state.releases.has(nodeSeq)) fail("already_released", `节点 ${nodeSeq} 已放行`);
    this._requireNotFrozen(state, `节点 ${nodeSeq} 放行`);
    const releasedAtEpoch = requireOccurredAt(input);

    this._append(input.shipmentId, "node.released", actor, { nodeSeq, releasedAtEpoch });
    if (nodeSeq === state.nodes.length - 1) {
      this._append(input.shipmentId, "shipment.completed", actor, { atEpoch: releasedAtEpoch });
    }
    return this.getShipment(input.shipmentId);
  }

  // ---------- 命令：异常 ----------

  openAnomaly(input) {
    const actor = requireActor(input.actor);
    const state = this._requireShipment(input.shipmentId);
    const nodeSeq = Number(input.nodeSeq);
    this._node(state, nodeSeq);
    const occurredAtEpoch = requireOccurredAt(input);
    const kind = String(input.kind ?? "other");
    const severity = ["low", "medium", "high"].includes(input.severity) ? input.severity : "medium";
    const description = String(input.description ?? "").trim() || fail("invalid_anomaly", "异常描述必填");
    const anomalyId = this._openAnomaly(input.shipmentId, nodeSeq, kind, severity, description, occurredAtEpoch, { actor, auto: false });
    return { anomalyId, projection: this.getShipment(input.shipmentId) };
  }

  resolveAnomaly(input) {
    const actor = requireActor(input.actor);
    const state = this._requireShipment(input.shipmentId);
    const anomaly = state.anomalies.find((a) => a.anomalyId === input.anomalyId);
    if (!anomaly) fail("not_found", `异常 ${input.anomalyId} 不存在`);
    if (anomaly.status === "resolved") fail("anomaly_closed", "异常已解除，不能重复解除");
    const note = String(input.note ?? "").trim() || fail("invalid_resolution", "解除异常必须填写处置说明");
    // 证据类异常必须先收到离线补传证据，才能解除冻结。
    if (anomaly.kind === "missing_photo" && anomaly.evidence.length === 0) {
      fail("evidence_outstanding", "缺失照片尚未补交，不能解除冻结");
    }
    if (anomaly.kind === "sensor_offline" && anomaly.evidence.length === 0) {
      fail("evidence_outstanding", "传感器恢复在线的补传证据未收到，不能解除冻结");
    }
    const resolvedAtEpoch = requireOccurredAt(input, "resolvedAt");
    this._append(input.shipmentId, "anomaly.resolved", actor, { anomalyId: anomaly.anomalyId, note, resolvedAtEpoch });
    return this.getShipment(input.shipmentId);
  }

  // ---------- 命令：换车 / 拆箱 / 重封 ----------

  changeVehicle(input) {
    const actor = requireActor(input.actor);
    const confirmations = requireDualConfirm(input.confirmations);
    const state = this._requireShipment(input.shipmentId);
    this._requireNotFrozen(state, "换车");
    const toVehicle = this.catalog.vehicleCapabilities.find((v) => v.type === input.toVehicle);
    if (!toVehicle) fail("invalid_vehicle", `车辆类型 ${input.toVehicle} 不在能力目录中`);
    if (toVehicle.maxFragility < state.fragilityLevel) {
      fail("vehicle_capability_exceeded", `${toVehicle.type} 能力不足，不能承运脆弱等级 ${state.fragilityLevel}`);
    }
    if (toVehicle.type === state.vehicleType) fail("invalid_vehicle", "新车与当前车辆相同，无需换车");
    const nodeSeq = this._currentNodeSeq(state);
    const occurredAtEpoch = requireOccurredAt(input);

    const event = this._append(input.shipmentId, "vehicle.changed", actor, {
      nodeSeq,
      fromVehicle: state.vehicleType,
      toVehicle: toVehicle.type,
      occurredAtEpoch,
      confirmations: confirmations.map((c) => ({ id: c.id, name: c.name, role: c.role })),
    });
    return { event, projection: this.getShipment(input.shipmentId) };
  }

  openCrate(input) {
    const actor = requireActor(input.actor);
    const confirmations = requireDualConfirm(input.confirmations);
    const state = this._requireShipment(input.shipmentId);
    // 拆箱本身是异常处置手段，冻结期间允许（双人确认）；放行仍被冻结。
    const nodeSeq = this._currentNodeSeq(state);
    const cutSealIds = Array.isArray(input.cutSealIds) && input.cutSealIds.length > 0
      ? input.cutSealIds
      : state.seals.filter((s) => s.status === "active").map((s) => s.sealId);
    for (const sealId of cutSealIds) {
      const seal = state.seals.find((s) => s.sealId === sealId);
      if (!seal) fail("invalid_seal", `封签 ${sealId} 不属于本运输链`);
      if (seal.status !== "active") fail("invalid_seal", `封签 ${sealId} 已作废，不能重复拆封`);
    }
    const reason = String(input.reason ?? "").trim() || fail("invalid_reason", "拆箱原因必填");
    const occurredAtEpoch = requireOccurredAt(input);

    const event = this._append(input.shipmentId, "crate.opened", actor, {
      nodeSeq,
      reason,
      cutSealIds,
      occurredAtEpoch,
      confirmations: confirmations.map((c) => ({ id: c.id, name: c.name, role: c.role })),
    });
    return { event, projection: this.getShipment(input.shipmentId) };
  }

  bindSeal(input) {
    const actor = requireActor(input.actor);
    const state = this._requireShipment(input.shipmentId);
    const sealId = String(input.sealId ?? "").trim();
    if (!sealId) fail("invalid_seal", "封签编号不能为空");
    const owners = this._sealOwners();
    if (owners.has(sealId) && owners.get(sealId) !== input.shipmentId) {
      fail("seal_already_circulating", `封签 ${sealId} 已在另一条运输链 ${owners.get(sealId)} 上流转`);
    }
    if (state.seals.some((s) => s.sealId === sealId)) fail("seal_exists", "该封签在本运输链已绑定，不能重复绑定");

    // 首次施封随创建完成；任何再次施封都意味着中途开箱，必须双人确认。
    const replacement = state.seals.length > 0;
    const confirmations = replacement ? requireDualConfirm(input.confirmations) : null;
    const nodeSeq = this._currentNodeSeq(state);
    const occurredAtEpoch = requireOccurredAt(input);

    const event = this._append(input.shipmentId, "seal.bound", actor, {
      sealId,
      nodeSeq,
      occurredAtEpoch,
      replacement,
      confirmations: replacement ? confirmations.map((c) => ({ id: c.id, name: c.name, role: c.role })) : null,
    });
    return { event, projection: this.getShipment(input.shipmentId) };
  }

  _currentNodeSeq(state) {
    let current = 0;
    for (const node of state.nodes) {
      if (state.handoffs.has(node.seq)) current = node.seq;
    }
    return current;
  }

  // ---------- 命令：离线补传 ----------

  supplementEvidence(input) {
    const actor = requireActor(input.actor);
    const state = this._requireShipment(input.shipmentId);
    const nodeSeq = Number(input.nodeSeq);
    if (!state.handoffs.has(nodeSeq)) fail("no_handoff", `节点 ${nodeSeq} 没有交接记录，证据应随交接一并提交`);
    const deviceId = String(input.deviceId ?? "").trim();
    const deviceSeq = Number(input.deviceSeq);
    if (!deviceId) fail("invalid_device", "设备序号 deviceId 必填");
    if (!Number.isInteger(deviceSeq) || deviceSeq < 0) fail("invalid_device", "设备内序号 deviceSeq 必须是非负整数");

    // 按 (设备序号, 设备内序号) 合并：重复补传直接返回原事件，不重复落账、不重复并入时间窗。
    const key = `${deviceId}:${deviceSeq}`;
    const existing = state.devices.get(key);
    if (existing) {
      return { deduped: true, eventSeq: existing.eventSeq, nodeSeq: existing.nodeSeq, projection: this.getShipment(input.shipmentId) };
    }

    const capturedAtEpoch = requireZonedIso(input.capturedAt, "capturedAt");
    const photos = this._validatePhotos(input.photos);
    let sensor = null;
    if (input.sensor) {
      sensor = {
        temperatureC: input.sensor.temperatureC === undefined ? null : Number(input.sensor.temperatureC),
        humidityRh: input.sensor.humidityRh === undefined ? null : Number(input.sensor.humidityRh),
        shockTriggered: input.sensor.shockTriggered === undefined ? null : Boolean(input.sensor.shockTriggered),
        tiltTriggered: input.sensor.tiltTriggered === undefined ? null : Boolean(input.sensor.tiltTriggered),
        sensorOnline: Boolean(input.sensor.sensorOnline),
      };
    }
    if (photos.length === 0 && !sensor) fail("invalid_evidence", "补传必须至少包含照片或传感器读数");

    const event = this._append(input.shipmentId, "evidence.supplemented", actor, {
      nodeSeq,
      deviceId,
      deviceSeq,
      capturedAtEpoch,
      photos,
      sensor,
      note: String(input.note ?? ""),
    });
    return { deduped: false, eventSeq: event.seq, projection: this.getShipment(input.shipmentId) };
  }

  // ---------- 超时扫描（重启后仍有效：结果是追加事件） ----------

  scanOverdue(nowEpoch = this.now()) {
    const marked = [];
    for (const shipmentId of this.store.listShipmentIds()) {
      const state = this._load(shipmentId);
      if (!state.exists || state.status === "completed") continue;

      // 最早尚未交接的节点：错过结束时间即提醒，逐节点只记一次。
      const nextNode = state.nodes.find((n) => !state.handoffs.has(n.seq));
      if (nextNode && nextNode.windowEndEpoch < nowEpoch) {
        const already = state.overdue.some((o) => o.nodeSeq === nextNode.seq && o.kind === "window_missed");
        if (!already) {
          this._append(shipmentId, "overdue.marked", { id: "system", name: "超时扫描", role: "管理员" }, {
            nodeSeq: nextNode.seq,
            kind: "window_missed",
            deadlineEpoch: nextNode.windowEndEpoch,
            markedEpoch: nowEpoch,
          });
          marked.push({ shipmentId, nodeSeq: nextNode.seq, kind: "window_missed" });
        }
      }

      // 已交接未放行：超过节点停留时长仍未放行也提醒。
      for (const node of state.nodes) {
        const handoff = state.handoffs.get(node.seq);
        if (handoff && !state.releases.has(node.seq)) {
          const deadline = handoff.occurredAtEpoch + node.dwellMinutes * 60_000;
          const already = state.overdue.some((o) => o.nodeSeq === node.seq && o.kind === "release_overdue");
          if (deadline < nowEpoch && !already) {
            this._append(shipmentId, "overdue.marked", { id: "system", name: "超时扫描", role: "管理员" }, {
              nodeSeq: node.seq,
              kind: "release_overdue",
              deadlineEpoch: deadline,
              markedEpoch: nowEpoch,
            });
            marked.push({ shipmentId, nodeSeq: node.seq, kind: "release_overdue" });
          }
        }
      }
    }
    return marked;
  }

  // ---------- 查询 ----------

  getShipment(shipmentId) {
    const state = this._requireShipment(shipmentId);
    return this._project(shipmentId, state);
  }

  listShipments() {
    return this.store.listShipmentIds().map((id) => {
      const state = this._load(id);
      return {
        shipmentId: id,
        artifactId: state.artifactId,
        artifactName: state.artifactName,
        fragilityLevel: state.fragilityLevel,
        status: state.status,
        vehicleType: state.vehicleType,
        openAnomalies: this._openAnomalies(state).map((a) => a.anomalyId),
        currentNodeSeq: this._currentNodeSeq(state),
      };
    });
  }

  _project(shipmentId, state) {
    const open = this._openAnomalies(state);
    return {
      shipmentId,
      artifactId: state.artifactId,
      artifactName: state.artifactName,
      fragilityLevel: state.fragilityLevel,
      status: state.status,
      vehicleType: state.vehicleType,
      frozen: open.length > 0,
      packingChecks: state.packingChecks,
      requiredPhotoKinds: state.requiredPhotoKinds,
      envLimit: state.envLimit,
      seals: state.seals.map((s) => ({
        sealId: s.sealId,
        status: s.status,
        boundAt: toIsoUtc(s.boundEpoch),
        boundNode: s.boundNode,
        replacement: s.replacement,
        presentAtHandoffs: s.presentAtHandoffs,
      })),
      nodes: state.nodes.map((n) => this._projectNode(state, n)),
      anomalies: state.anomalies.map((a) => ({
        anomalyId: a.anomalyId,
        nodeSeq: a.nodeSeq,
        kind: a.kind,
        severity: a.severity,
        description: a.description,
        occurredAt: toIsoUtc(a.occurredAtEpoch),
        status: a.status,
        auto: a.auto,
        openedBy: a.openedBy,
        evidenceCount: a.evidence.length,
        resolution: a.resolution && {
          by: a.resolution.by,
          note: a.resolution.note,
          resolvedAt: toIsoUtc(a.resolution.atEpoch),
        },
      })),
      vehicleChanges: state.vehicleChanges.map((v) => ({
        nodeSeq: v.nodeSeq,
        fromVehicle: v.fromVehicle,
        toVehicle: v.toVehicle,
        occurredAt: toIsoUtc(v.occurredAtEpoch),
        confirmations: v.confirmations,
      })),
      crateOpenings: state.crateOpenings.map((c) => ({
        nodeSeq: c.nodeSeq,
        reason: c.reason,
        cutSealIds: c.cutSealIds,
        occurredAt: toIsoUtc(c.occurredAtEpoch),
        confirmations: c.confirmations,
      })),
      overdue: state.overdue.map((o) => ({
        nodeSeq: o.nodeSeq,
        kind: o.kind,
        deadline: toIsoUtc(o.deadlineEpoch),
        markedAt: toIsoUtc(o.markedEpoch),
      })),
    };
  }

  _projectNode(state, node) {
    const handoff = state.handoffs.get(node.seq);
    const released = state.releases.has(node.seq);
    const status = released ? "released" : handoff ? "handed_over" : "pending";
    const evidence = (state.evidence.get(node.seq) ?? []).map((e) => ({
      deviceId: e.deviceId,
      deviceSeq: e.deviceSeq,
      capturedAt: toIsoUtc(e.capturedAtEpoch),
      submittedAt: toIsoUtc(e.submittedAtEpoch),
      photos: e.photos,
      sensor: e.sensor,
      note: e.note,
    }));
    return {
      seq: node.seq,
      code: node.code,
      name: node.name,
      owner: node.owner,
      timezone: node.timezone,
      windowStart: toIsoUtc(node.windowStartEpoch),
      windowEnd: toIsoUtc(node.windowEndEpoch),
      dwellMinutes: node.dwellMinutes,
      status,
      windowClass: handoff?.windowClass ?? null,
      handoff: handoff && {
        formNo: handoff.formNo,
        occurredAt: toIsoUtc(handoff.occurredAtEpoch),
        location: handoff.location,
        temperatureC: handoff.temperatureC,
        humidityRh: handoff.humidityRh,
        shockTriggered: handoff.shockTriggered,
        tiltTriggered: handoff.tiltTriggered,
        sensorOffline: handoff.sensorOffline,
        checks: handoff.checks,
        photos: handoff.photos,
        sealIds: handoff.sealIds,
        carrierSignature: handoff.carrierSignature,
        offline: handoff.offline,
        recordedBy: handoff.recordedBy,
      },
      evidence,
      openAnomalies: state.anomalies
        .filter((a) => a.nodeSeq === node.seq && a.status === "open")
        .map((a) => ({ anomalyId: a.anomalyId, kind: a.kind, severity: a.severity, description: a.description, evidenceCount: a.evidence.length })),
      nextActions: this._nextActions(state, node),
    };
  }

  // 可执行的下一步：综合冻结、节点状态、封签、时间窗给出。
  _nextActions(state, node) {
    const actions = [];
    const open = this._openAnomalies(state);
    const handoff = state.handoffs.get(node.seq);
    const released = state.releases.has(node.seq);
    const activeSeal = state.seals.some((s) => s.status === "active");

    if (state.status === "completed") return ["运输链已完成，无后续动作"];

    if (open.length > 0) {
      for (const a of open) {
        const needs = a.kind === "missing_photo" ? "（等待离线终端按设备序号补交照片）"
          : a.kind === "sensor_offline" ? "（等待设备恢复在线的补传读数）"
          : "";
        actions.push(`处置异常 ${a.anomalyId}（${a.kind}）${needs}，由管理员/保护人员提交处置说明后解除冻结`);
      }
    }

    if (!handoff) {
      if (node.seq > 0 && !state.releases.has(node.seq - 1)) {
        actions.push(`等待前序节点 ${node.seq - 1} 放行后再交接`);
      } else if (open.length === 0) {
        if (!activeSeal) actions.push("无有效封签：拆箱后须由两名授权角色双人确认重封（bindSeal）");
        actions.push(`在时间窗 ${toIsoUtc(node.windowStartEpoch)} 至 ${toIsoUtc(node.windowEndEpoch)} 内记录节点 ${node.seq} 交接（检查项、温湿度、照片、承运人签名）`);
      }
    } else if (!released) {
      if (open.length === 0) actions.push(`节点 ${node.seq} 资料齐全，可执行放行（releaseNode）`);
      else actions.push(`节点 ${node.seq} 交接已记录但放行被冻结`);
      if (handoff.offline || handoff.sensorOffline || handoff.photos.length < state.requiredPhotoKinds.length) {
        actions.push("等待离线终端补交证据（supplementEvidence，按设备序号去重）");
      }
    } else if (node.seq < state.nodes.length - 1) {
      actions.push(`前往节点 ${node.seq + 1}（${state.nodes[node.seq + 1].name}）交接`);
    }

    return [...new Set(actions)];
  }

  // 跨时区统一时间线：全部归一到 UTC epoch 排序，同时给出节点本地时间。
  getTimeline(shipmentId) {
    const state = this._requireShipment(shipmentId);
    const items = [];
    const push = (epoch, kind, nodeSeq, data) => items.push({ epoch: epoch ?? 0, kind, nodeSeq, data });

    items.push({ epoch: state.createdAtEpoch, kind: "shipment_created", nodeSeq: null, data: { vehicleType: state.vehicleType } });
    for (const seal of state.seals) push(seal.boundEpoch, "seal_bound", seal.boundNode, { sealId: seal.sealId, replacement: seal.replacement });
    for (const [seq, h] of state.handoffs) {
      push(h.occurredAtEpoch, "handoff", seq, {
        formNo: h.formNo, location: h.location, windowClass: h.windowClass,
        temperatureC: h.temperatureC, humidityRh: h.humidityRh, carrier: h.carrierSignature,
      });
    }
    for (const [seq, epoch] of state.releases) push(epoch, "node_released", seq, {});
    for (const a of state.anomalies) {
      push(a.occurredAtEpoch, "anomaly_opened", a.nodeSeq, { anomalyId: a.anomalyId, kind: a.kind, severity: a.severity });
      if (a.resolution) push(a.resolution.atEpoch, "anomaly_resolved", a.nodeSeq, { anomalyId: a.anomalyId, note: a.resolution.note });
    }
    for (const v of state.vehicleChanges) push(v.occurredAtEpoch, "vehicle_changed", v.nodeSeq, { from: v.fromVehicle, to: v.toVehicle });
    for (const c of state.crateOpenings) push(c.occurredAtEpoch, "crate_opened", c.nodeSeq, { reason: c.reason, cutSealIds: c.cutSealIds });
    for (const [seq, list] of state.evidence) {
      for (const e of list) push(e.capturedAtEpoch, "evidence_supplemented", seq, { deviceId: e.deviceId, deviceSeq: e.deviceSeq, submittedAtEpoch: e.submittedAtEpoch });
    }
    for (const o of state.overdue) push(o.markedEpoch, "overdue_marked", o.nodeSeq, { kind: o.kind });

    items.sort((x, y) => (x.epoch - y.epoch) || Number(x.nodeSeq ?? -1) - Number(y.nodeSeq ?? -1));
    return items.map((item, index) => {
      const node = item.nodeSeq !== null ? state.nodes[item.nodeSeq] : null;
      return {
        order: index,
        kind: item.kind,
        nodeSeq: item.nodeSeq,
        utcTime: toIsoUtc(item.epoch),
        localTime: node ? new Intl.DateTimeFormat("zh-CN", {
          timeZone: node.timezone, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short", hour12: false,
        }).format(new Date(item.epoch)) : null,
        data: item.data,
      };
    });
  }

  getSeal(sealId) {
    for (const shipmentId of this.store.listShipmentIds()) {
      const state = this._load(shipmentId);
      const seal = state.seals.find((s) => s.sealId === sealId);
      if (seal) {
        return {
          sealId,
          shipmentId,
          status: seal.status,
          boundAt: toIsoUtc(seal.boundEpoch),
          boundNode: seal.boundNode,
          chain: seal.presentAtHandoffs.map((seq) => ({
            nodeSeq: seq,
            nodeCode: state.nodes[seq].code,
            nodeName: state.nodes[seq].name,
            handoffAt: toIsoUtc(state.handoffs.get(seq).occurredAtEpoch),
            carrier: state.handoffs.get(seq).carrierSignature,
          })),
        };
      }
    }
    fail("not_found", `封签 ${sealId} 无流转记录`);
  }
}
