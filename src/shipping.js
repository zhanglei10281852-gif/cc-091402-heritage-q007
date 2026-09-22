// 运输交接领域服务：在只追加事件之上做命令校验与状态投影。
// 关键不变量：
//  1. 封签全局唯一，只能绑定一条运输链；
//  2. 未解决异常必然派生“冻结”，解除冻结只能追加 anomaly.resolved，无法靠改旧记录解除；
//  3. 证据按设备序号(deviceSeq)合并，任何证据补传都不参与时间窗计算；
//  4. 时间窗超时提醒每个节点最多一次（确定性 eventId + 事件幂等）；
//  5. 换车/拆箱必须两名授权角色、且为不同的人共同确认；
//  6. 时间线一律按统一事件时间（纪元毫秒）跨时区排序，允许离线乱序补传。

import { randomUUID } from "node:crypto";
import { parseEventTime, formatInTimezone } from "./time.js";
import {
  getFragilitySpec,
  buildChecklist,
  checkVehicleCapability,
  getRoute,
  getRouteNode,
  isAuthorizedDualRole,
} from "./catalog.js";

export const RESOLVE_ROLES = ["管理员", "保护人员"];
const EVIDENCE_LATE_GRACE_MS = 60_000;

export class ShippingError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
const fail = (statusCode, code, message, details) => {
  throw new ShippingError(statusCode, code, message, details);
};
const newId = (prefix) => `${prefix}_${randomUUID()}`;

/** 从请求头解析经办人身份；缺身份的写操作拒绝。x-user-name 按百分号编码传输（HTTP 头只允许 ASCII）。 */
export function actorFromRequest(headers) {
  const id = headers["x-user-id"];
  const rawName = headers["x-user-name"];
  const rawRole = headers["x-user-role"];
  if (!id || !rawName || !rawRole) fail(401, "UNAUTHENTICATED", "写操作需要请求头 x-user-id / x-user-name / x-user-role");
  const decode = (v) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  return { id, name: decode(rawName), role: decode(rawRole) };
}

export class ShippingService {
  #store;
  #now;
  /** sealId -> shipmentId，封签全局绑定索引（重放重建）。 */
  #sealIndex = new Map();

  constructor(store, { now = () => Date.now() } = {}) {
    this.#store = store;
    this.#now = now;
    this.rebuild();
  }

  get now() {
    return this.#now();
  }

  /** 从事件日志重建全部内存状态。重启后调用即恢复冻结、证据合并、提醒去重等。 */
  rebuild() {
    this.#sealIndex = new Map();
    for (const event of this.#store.events) {
      if (event.type === "shipment.created") this.#sealIndex.set(event.payload.sealId, event.shipmentId);
    }
  }

  // ---------------- 命令 ----------------

  createShipment(body, actor) {
    const eventTimeMs = parseEventTime(body.eventTime ?? new Date(this.now).toISOString());
    const spec = getFragilitySpec(body.fragilityLevel);
    const route = getRoute(body.routeId);
    const shipmentId = body.shipmentId ?? newId("S");
    if (this.getShipment(shipmentId)) fail(409, "SHIPMENT_EXISTS", `运输链 ${shipmentId} 已存在`);
    if (!body.artifactName) fail(400, "MISSING_FIELD", "缺少 artifactName");
    if (!body.sealId) fail(400, "MISSING_FIELD", "缺少 sealId（封签号码）");
    if (this.#sealIndex.has(body.sealId)) {
      fail(409, "SEAL_ALREADY_BOUND", `封签 ${body.sealId} 已绑定运输链 ${this.#sealIndex.get(body.sealId)}，不得跨链流转`);
    }
    const vehicle = body.vehicleId ? checkVehicleCapability(body.fragilityLevel, body.vehicleId) : null;
    if (vehicle && !vehicle.ok) {
      fail(422, "VEHICLE_CAPABILITY", `车辆 ${body.vehicleId} 不满足 ${body.fragilityLevel} 级运输要求`, { missing: vehicle.missing });
    }

    const event = this.#append({
      eventId: body.eventId ?? newId("evt"),
      type: "shipment.created",
      shipmentId,
      actor,
      eventTimeMs,
      payload: {
        artifact: {
          artifactId: body.artifactId ?? shipmentId,
          name: body.artifactName,
          fragilityLevel: body.fragilityLevel,
        },
        routeId: body.routeId,
        sealId: body.sealId,
        vehicleId: body.vehicleId ?? null,
        coordinator: actor,
        checklist: buildChecklist(body.fragilityLevel),
        limits: {
          temperatureC: spec.temperatureRangeC,
          humidityPct: spec.humidityRangePct,
        },
        routeSnapshot: route.nodes.map((n) => ({ nodeId: n.nodeId, name: n.name, kind: n.kind, timezone: n.timezone })),
      },
    });
    this.#sealIndex.set(body.sealId, shipmentId);
    return event;
  }

  recordArrival(shipmentId, body, actor) {
    const state = this.#requireShipment(shipmentId);
    const node = getRouteNode(state.routeId, body.nodeId);
    const eventTimeMs = parseEventTime(body.eventTime ?? new Date(this.now).toISOString());
    if (state.nodes[node.nodeId]?.reached) fail(409, "ALREADY_REACHED", `节点 ${node.nodeId} 已有到达记录`);
    return this.#append({
      eventId: body.eventId ?? newId("evt"),
      type: "node.reached",
      shipmentId,
      actor,
      eventTimeMs,
      payload: { nodeId: node.nodeId, note: body.note ?? null },
    });
  }

  completeHandoff(shipmentId, body, actor) {
    const state = this.#requireShipment(shipmentId);
    const node = getRouteNode(state.routeId, body.nodeId);
    const nodeState = state.nodes[node.nodeId];
    if (!nodeState?.reached) fail(409, "NOT_REACHED", `节点 ${node.nodeId} 尚未记录到达，不能交接`);
    // 到达可照常记录；冻结拦截的是“放行”——交接动作本身。
    if (state.frozen) fail(409, "FROZEN", "运输链处于冻结状态，未解决异常处理完毕前禁止放行交接", { openAnomalies: state.openAnomalyIds });
    if (nodeState.handoff) fail(409, "HANDOFF_EXISTS", `节点 ${node.nodeId} 已完成交接，记录不可修改`);
    if (!body.carrierName || !body.carrierId) fail(400, "MISSING_FIELD", "交接必须记录承运人签名 carrierName 与工号 carrierId");
    const eventTimeMs = parseEventTime(body.eventTime ?? new Date(this.now).toISOString());
    const sealStatus = body.sealStatus ?? "intact";
    if (!["intact", "broken"].includes(sealStatus)) fail(400, "BAD_SEAL_STATUS", "sealStatus 只能为 intact / broken");

    const temperatureC = optionalNumber(body.temperatureC, "temperatureC");
    const humidityPct = optionalNumber(body.humidityPct, "humidityPct");
    const results = normalizeResults(state.checklist, body.results);

    const handoffEventId = body.eventId ?? newId("evt");
    const emitted = [];
    const handoff = this.#append({
      eventId: handoffEventId,
      type: "handoff.completed",
      shipmentId,
      actor,
      eventTimeMs,
      payload: {
        nodeId: node.nodeId,
        carrier: { carrierId: body.carrierId, carrierName: body.carrierName, company: body.carrierCompany ?? null },
        signature: body.signatureRef ? { ref: body.signatureRef, method: "image" } : { method: "text", text: body.carrierName },
        sealStatus,
        environment: { temperatureC, humidityPct },
        results,
        note: body.note ?? null,
      },
    });
    emitted.push(handoff);

    // 异常自动留痕：封签断裂 / 检查项失败 / 温湿度超标 / 必检项缺失。
    // 异常事件先落盘，派生出的冻结状态在重启后依然有效。
    if (sealStatus === "broken") {
      emitted.push(
        this.#autoAnomaly(shipmentId, handoffEventId, "seal", node.nodeId, eventTimeMs, actor,
          `节点 ${node.name} 交接发现封签 ${state.sealId} 断裂`, "critical")
      );
    }
    for (const item of state.checklist) {
      const r = results.find((x) => x.itemId === item.itemId);
      if (!r || r.status !== "pass") {
        const reason = !r ? "检查项未记录，按证据缺失处理" : r.note ?? "检查项未通过";
        const type = item.itemId === "handoff-photos" ? "evidence" : "inspection";
        emitted.push(
          this.#autoAnomaly(shipmentId, handoffEventId, type, node.nodeId, eventTimeMs, actor,
            `检查项「${item.label}」${reason}`, "high", `${type}:${item.itemId}`)
        );
      }
    }
    if (temperatureC != null && outside(temperatureC, state.limits.temperatureC)) {
      emitted.push(this.#autoAnomaly(shipmentId, handoffEventId, "temperature", node.nodeId, eventTimeMs, actor,
        `箱内温度 ${temperatureC}℃ 超出限值 ${state.limits.temperatureC.min}~${state.limits.temperatureC.max}℃`, "high"));
    }
    if (humidityPct != null && outside(humidityPct, state.limits.humidityPct)) {
      emitted.push(this.#autoAnomaly(shipmentId, handoffEventId, "humidity", node.nodeId, eventTimeMs, actor,
        `箱内湿度 ${humidityPct}% 超出限值 ${state.limits.humidityPct.min}~${state.limits.humidityPct.max}%`, "high"));
    }
    return { handoff: emitted[0], derivedEvents: emitted.slice(1), frozen: emitted.length > 1 };
  }

  reportAnomaly(shipmentId, body, actor) {
    const state = this.#requireShipment(shipmentId);
    if (body.nodeId) getRouteNode(state.routeId, body.nodeId);
    if (!body.type) fail(400, "MISSING_FIELD", "缺少异常类型 type");
    if (!body.description) fail(400, "MISSING_FIELD", "缺少异常描述 description");
    const eventTimeMs = parseEventTime(body.eventTime ?? new Date(this.now).toISOString());
    const event = this.#append({
      eventId: body.eventId ?? newId("evt"),
      type: "anomaly.reported",
      shipmentId,
      actor,
      eventTimeMs,
      payload: {
        anomalyId: body.anomalyId ?? newId("AN"),
        nodeId: body.nodeId ?? null,
        type: body.type, // shock | tilt | temperature | humidity | seal | device-offline | evidence | inspection | other
        severity: body.severity ?? "high",
        deviceId: body.deviceId ?? null,
        description: body.description,
        response: body.response ?? null, // 先期处置说明
      },
    });
    return { event, frozen: true };
  }

  resolveAnomaly(shipmentId, body, actor) {
    const state = this.#requireShipment(shipmentId);
    if (!RESOLVE_ROLES.includes(actor.role)) {
      fail(403, "FORBIDDEN", `只有 ${RESOLVE_ROLES.join("/")} 可以解除异常，当前角色：${actor.role}`);
    }
    const anomaly = state.anomalies[body.anomalyId];
    if (!anomaly) fail(404, "ANOMALY_NOT_FOUND", `异常 ${body.anomalyId} 不存在`);
    if (anomaly.status !== "open") fail(409, "ANOMALY_CLOSED", `异常 ${body.anomalyId} 已关闭`);
    if (!body.resolution) fail(400, "MISSING_FIELD", "解除异常必须填写处置结论 resolution");
    // 是否需要补交证据才能解除：要求时必须给出已合并的设备序号。
    if (body.requiresEvidence && !body.evidenceDeviceSeq) {
      fail(400, "MISSING_FIELD", "该异常要求补交证据，请提供 evidenceDeviceSeq");
    }
    const eventTimeMs = parseEventTime(body.eventTime ?? new Date(this.now).toISOString());
    const event = this.#append({
      eventId: body.eventId ?? newId("evt"),
      type: "anomaly.resolved",
      shipmentId,
      actor,
      eventTimeMs,
      payload: {
        anomalyId: body.anomalyId,
        resolution: body.resolution,
        evidenceDeviceSeq: body.evidenceDeviceSeq ?? null,
      },
    });
    return { event, frozen: this.project(shipmentId).frozen };
  }

  changeVehicle(shipmentId, body, actor) {
    const state = this.#requireShipment(shipmentId);
    if (state.frozen) fail(409, "FROZEN", "冻结状态下禁止换车", { openAnomalies: state.openAnomalyIds });
    if (!body.fromVehicleId || !body.toVehicleId) fail(400, "MISSING_FIELD", "换车需要 fromVehicleId / toVehicleId");
    if (body.fromVehicleId !== state.currentVehicleId) {
      fail(409, "VEHICLE_MISMATCH", `当前承载工具为 ${state.currentVehicleId}，与 fromVehicleId 不一致`);
    }
    if (body.fromVehicleId === body.toVehicleId) fail(400, "SAME_VEHICLE", "新车与旧车不能相同");
    const cap = checkVehicleCapability(state.fragilityLevel, body.toVehicleId);
    if (!cap.ok) fail(422, "VEHICLE_CAPABILITY", "拟换车辆能力不足", { missing: cap.missing });
    const confirmations = validateDualConfirmations(body.confirmations);
    if (!body.reason) fail(400, "MISSING_FIELD", "换车必须填写原因 reason");
    const eventTimeMs = parseEventTime(body.eventTime ?? new Date(this.now).toISOString());
    return this.#append({
      eventId: body.eventId ?? newId("evt"),
      type: "vehicle.changed",
      shipmentId,
      actor,
      eventTimeMs,
      payload: {
        reason: body.reason,
        fromVehicleId: body.fromVehicleId,
        toVehicleId: body.toVehicleId,
        confirmations,
      },
    });
  }

  openCrate(shipmentId, body, actor) {
    const state = this.#requireShipment(shipmentId);
    if (state.frozen) fail(409, "FROZEN", "冻结状态下禁止拆箱", { openAnomalies: state.openAnomalyIds });
    if (body.nodeId) getRouteNode(state.routeId, body.nodeId);
    if (!body.reason) fail(400, "MISSING_FIELD", "拆箱必须填写原因 reason");
    const confirmations = validateDualConfirmations(body.confirmations);
    const eventTimeMs = parseEventTime(body.eventTime ?? new Date(this.now).toISOString());
    return this.#append({
      eventId: body.eventId ?? newId("evt"),
      type: "crate.opened",
      shipmentId,
      actor,
      eventTimeMs,
      payload: { nodeId: body.nodeId ?? null, reason: body.reason, confirmations },
    });
  }

  /**
   * 证据上传/离线补传。同一 (运输链, 设备序号) 的多次上传合并为一条证据记录，
   * 且绝不写入节点时间窗状态——补传不会把节点重新算成准时/超时。
   */
  uploadEvidence(shipmentId, body, actor) {
    const state = this.#requireShipment(shipmentId);
    if (!body.deviceSeq) fail(400, "MISSING_FIELD", "证据必须带设备序号 deviceSeq，用于合并去重");
    if (body.nodeId) getRouteNode(state.routeId, body.nodeId);
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0 && !body.note) fail(400, "MISSING_FIELD", "证据至少包含一个文件或备注");
    const capturedAtMs = parseEventTime(body.capturedAt ?? body.eventTime ?? new Date(this.now).toISOString(), "capturedAt");
    const existing = state.evidence[body.deviceSeq];
    const knownHashes = new Set(existing?.files.map((f) => f.sha256 ?? f.name) ?? []);
    const mergedFiles = [];
    for (const f of files) {
      const key = f.sha256 ?? f.name;
      if (knownHashes.has(key)) continue; // 同设备重传同一文件，合并去重
      knownHashes.add(key);
      mergedFiles.push({ name: f.name, sha256: f.sha256 ?? null, size: f.size ?? null });
    }
    const receivedAtMs = this.now;
    const late = existing != null || receivedAtMs - capturedAtMs > EVIDENCE_LATE_GRACE_MS;
    const event = this.#append({
      eventId: body.eventId ?? newId("evt"),
      type: "evidence.uploaded",
      shipmentId,
      actor,
      eventTimeMs: capturedAtMs,
      payload: {
        deviceSeq: body.deviceSeq,
        deviceId: body.deviceId ?? null,
        evidenceType: body.evidenceType ?? "photo", // photo | shock-log | temp-log | signature
        nodeId: body.nodeId ?? null,
        files: mergedFiles,
        note: body.note ?? null,
        late,
        receivedAtMs,
      },
    });
    return { event, merged: existing != null || mergedFiles.length < files.length, late };
  }

  /** 系统：为超时未到达的节点登记提醒（确定性幂等，重启后只发一次）。 */
  markOverdue(shipmentId, nodeId) {
    const state = this.#requireShipment(shipmentId);
    const node = getRouteNode(state.routeId, nodeId);
    const eventId = `overdue:${shipmentId}:${nodeId}`;
    if (this.#store.events.some((e) => e.eventId === eventId)) return { event: null, duplicate: true };
    if (state.nodes[nodeId]?.reached) return { event: null, duplicate: true, reason: "already-reached" };
    const windowEndMs = parseEventTime(node.windowEnd);
    if (this.now < windowEndMs) return { event: null, duplicate: true, reason: "window-open" };
    const event = this.#append({
      eventId,
      type: "window.overdue",
      shipmentId,
      actor: { id: "system", name: "超时提醒服务", role: "系统" },
      eventTimeMs: this.now,
      payload: { nodeId, windowStartMs: parseEventTime(node.windowStart), windowEndMs },
    });
    return { event, duplicate: false };
  }

  // ---------------- 查询 ----------------

  listShipments() {
    const ids = [...new Set(this.#store.events.map((e) => e.shipmentId))];
    return ids.map((id) => this.project(id)).filter(Boolean);
  }

  getShipment(shipmentId) {
    if (!this.#store.events.some((e) => e.shipmentId === shipmentId)) return null;
    return this.project(shipmentId);
  }
  #requireShipment(shipmentId) {
    const state = this.getShipment(shipmentId);
    if (!state) fail(404, "SHIPMENT_NOT_FOUND", `运输链 ${shipmentId} 不存在`);
    return state;
  }

  /** 纯投影：把一条运输链的事件折叠为当前状态。 */
  project(shipmentId, asOfMs = null) {
    const all = this.#store.byShipment(shipmentId);
    const events = asOfMs == null ? all : all.filter((e) => e.eventTimeMs <= asOfMs);
    return projectShipment(events);
  }

  /** 节点“当时”快照：箱况、责任人、未解决异常、可执行的下一步。 */
  nodeSnapshot(shipmentId, nodeId, asOfIso = null) {
    const state = this.#requireShipment(shipmentId);
    const node = getRouteNode(state.routeId, nodeId);
    const asOfMs = asOfIso == null ? null : parseEventTime(asOfIso, "asOf");
    const projected = this.project(shipmentId, asOfMs);
    const ns = projected.nodes[nodeId] ?? blankNode(nodeId);

    const latestHandoff = ns.handoff;
    const boxCondition = {
      sealId: projected.sealId,
      sealStatus: latestHandoff?.sealStatus ?? "unsealed-at-node",
      temperatureC: latestHandoff?.environment.temperatureC ?? null,
      humidityPct: latestHandoff?.environment.humidityPct ?? null,
      withinLimits: latestHandoff
        ? {
            temperature: latestHandoff.environment.temperatureC == null ? null
              : !outside(latestHandoff.environment.temperatureC, projected.limits.temperatureC),
            humidity: latestHandoff.environment.humidityPct == null ? null
              : !outside(latestHandoff.environment.humidityPct, projected.limits.humidityPct),
          }
        : null,
      checklist: projected.checklist.map((item) => ({
        ...item,
        result: latestHandoff?.results.find((r) => r.itemId === item.itemId)?.status ?? "pending",
      })),
    };
    const responsible = latestHandoff?.carrier
      ? { atNode: latestHandoff.carrier, coordinator: projected.coordinator }
      : { coordinator: projected.coordinator };

    const windowStartMs = parseEventTime(node.windowStart);
    const windowEndMs = parseEventTime(node.windowEnd);
    const fmtLocal = (ms) => formatInTimezone(ms, node.timezone);

    return {
      shipmentId,
      node: {
        nodeId: node.nodeId,
        name: node.name,
        kind: node.kind,
        address: node.address,
        timezone: node.timezone,
        windowStart: node.windowStart,
        windowEnd: node.windowEnd,
        windowLocal: `${fmtLocal(windowStartMs)} ~ ${fmtLocal(windowEndMs)}（${node.timezone}）`,
      },
      arrival: ns.reached
        ? {
            at: new Date(ns.reachedAtMs).toISOString(),
            by: ns.reachedBy,
            withinWindow: ns.withinWindow,
            overdue: ns.overdue,
            pastWindowEnd: ns.reachedAtMs > windowEndMs,
          }
        : null,
      handoff: latestHandoff
        ? {
            eventId: latestHandoff.eventId,
            at: new Date(latestHandoff.atMs).toISOString(),
            carrier: latestHandoff.carrier,
            note: latestHandoff.note,
          }
        : null,
      boxCondition,
      responsible,
      openAnomalies: Object.values(projected.anomalies)
        .filter((a) => a.status === "open")
        .map((a) => ({ anomalyId: a.anomalyId, type: a.type, severity: a.severity, description: a.description, nodeId: a.nodeId, reportedAt: new Date(a.reportedAtMs).toISOString() })),
      frozen: projected.frozen,
      evidenceAtNode: Object.values(projected.evidence)
        .filter((e) => e.nodeId === nodeId)
        .map((e) => ({ deviceSeq: e.deviceSeq, evidenceType: e.evidenceType, fileCount: e.files.length, mergedUploads: e.mergedUploads, late: e.late, lastCapturedAt: new Date(e.lastCapturedAtMs).toISOString() })),
      nextActions: nextActions(projected, nodeId),
      asOf: asOfMs == null ? new Date(this.now).toISOString() : new Date(asOfMs).toISOString(),
    };
  }

  // ---------------- 内部 ----------------

  #autoAnomaly(shipmentId, handoffEventId, anomalyType, nodeId, eventTimeMs, actor, description, severity, keySuffix = anomalyType) {
    return this.#append({
      eventId: `${handoffEventId}:anomaly:${keySuffix}`,
      type: "anomaly.reported",
      shipmentId,
      actor,
      eventTimeMs: eventTimeMs + 1, // 与交接事件同刻但排序在后
      payload: {
        anomalyId: `AN-${hashCode(`${handoffEventId}:${keySuffix}`)}`,
        nodeId,
        type: anomalyType,
        severity,
        deviceId: null,
        description,
        response: null,
        auto: true,
      },
    });
  }

  #append({ eventId, type, shipmentId, actor, eventTimeMs, payload }) {
    const { event, duplicate } = this.#store.append({
      eventId,
      type,
      shipmentId,
      actor: actor ?? null,
      eventTime: new Date(eventTimeMs).toISOString(),
      eventTimeMs,
      payload,
    });
    if (duplicate) return event;
    return event;
  }
}

// ---------------- 纯函数：投影 / 规则 ----------------

function blankNode(nodeId) {
  return { nodeId, reached: false, handoff: null, overdue: false };
}

/** 把单条运输链事件折叠为状态。事件可乱序补传，投影只按追加顺序因果折叠。 */
export function projectShipment(events) {
  const created = events.find((e) => e.type === "shipment.created");
  if (!created) return null;
  const state = {
    shipmentId: created.shipmentId,
    artifact: created.payload.artifact,
    fragilityLevel: created.payload.artifact.fragilityLevel,
    routeId: created.payload.routeId,
    sealId: created.payload.sealId,
    currentVehicleId: created.payload.vehicleId,
    coordinator: created.payload.coordinator,
    checklist: created.payload.checklist,
    limits: created.payload.limits,
    status: "in-transit",
    nodes: {},
    anomalies: {},
    evidence: {},
    vehicleChanges: 0,
    crateOpenings: [],
    openAnomalyIds: [],
    frozen: false,
    createdAtMs: created.eventTimeMs,
    completedAtMs: null,
  };
  for (const e of events.slice(1)) {
    switch (e.type) {
      case "node.reached": {
        const route = getRoute(state.routeId);
        const node = route.nodes.find((n) => n.nodeId === e.payload.nodeId);
        const withinWindow = e.eventTimeMs >= parseEventTime(node.windowStart) && e.eventTimeMs <= parseEventTime(node.windowEnd);
        state.nodes[e.payload.nodeId] = {
          ...(state.nodes[e.payload.nodeId] ?? blankNode(e.payload.nodeId)),
          reached: true,
          reachedAtMs: e.eventTimeMs,
          reachedBy: e.actor,
          withinWindow,
        };
        break;
      }
      case "handoff.completed": {
        const ns = state.nodes[e.payload.nodeId] ?? blankNode(e.payload.nodeId);
        ns.handoff = {
          eventId: e.eventId,
          atMs: e.eventTimeMs,
          carrier: e.payload.carrier,
          sealStatus: e.payload.sealStatus,
          environment: e.payload.environment,
          results: e.payload.results,
          note: e.payload.note,
        };
        state.nodes[e.payload.nodeId] = ns;
        const route = getRoute(state.routeId);
        if (route.nodes.at(-1).nodeId === e.payload.nodeId) {
          state.status = "delivered";
          state.completedAtMs = e.eventTimeMs;
        }
        break;
      }
      case "anomaly.reported":
        state.anomalies[e.payload.anomalyId] = {
          anomalyId: e.payload.anomalyId,
          status: "open",
          type: e.payload.type,
          severity: e.payload.severity,
          description: e.payload.description,
          nodeId: e.payload.nodeId,
          deviceId: e.payload.deviceId,
          reportedAtMs: e.eventTimeMs,
          reportedBy: e.actor,
          auto: Boolean(e.payload.auto),
          resolution: null,
        };
        break;
      case "anomaly.resolved": {
        const a = state.anomalies[e.payload.anomalyId];
        if (a) {
          a.status = "resolved";
          a.resolution = { by: e.actor, atMs: e.eventTimeMs, note: e.payload.resolution, evidenceDeviceSeq: e.payload.evidenceDeviceSeq ?? null };
        }
        break;
      }
      case "vehicle.changed":
        state.vehicleChanges += 1;
        state.currentVehicleId = e.payload.toVehicleId;
        break;
      case "crate.opened":
        state.crateOpenings.push({ atMs: e.eventTimeMs, nodeId: e.payload.nodeId, reason: e.payload.reason, confirmations: e.payload.confirmations });
        break;
      case "evidence.uploaded": {
        const prev = state.evidence[e.payload.deviceSeq];
        if (prev) {
          const seen = new Set(prev.files.map((f) => f.sha256 ?? f.name));
          for (const f of e.payload.files) {
            if (!seen.has(f.sha256 ?? f.name)) prev.files.push(f);
          }
          prev.mergedUploads += 1;
          prev.lastCapturedAtMs = Math.max(prev.lastCapturedAtMs, e.eventTimeMs);
          prev.late = prev.late || e.payload.late;
          if (e.payload.nodeId) prev.nodeId = e.payload.nodeId;
        } else {
          state.evidence[e.payload.deviceSeq] = {
            deviceSeq: e.payload.deviceSeq,
            evidenceType: e.payload.evidenceType,
            nodeId: e.payload.nodeId,
            files: [...e.payload.files],
            mergedUploads: 1,
            firstCapturedAtMs: e.eventTimeMs,
            lastCapturedAtMs: e.eventTimeMs,
            late: e.payload.late,
          };
        }
        break;
      }
      case "window.overdue": {
        const ns = state.nodes[e.payload.nodeId] ?? blankNode(e.payload.nodeId);
        ns.overdue = true;
        ns.overdueAtMs = e.eventTimeMs;
        state.nodes[e.payload.nodeId] = ns;
        break;
      }
      // 其余事件不改变投影
    }
  }
  state.openAnomalyIds = Object.values(state.anomalies).filter((a) => a.status === "open").map((a) => a.anomalyId);
  // 冻结是未解决异常的纯派生值：不允许被直接改写，只能追加 anomaly.resolved 使其消失。
  state.frozen = state.openAnomalyIds.length > 0;
  // 统一事件时间排序后的时间线（跨时区安全）。
  state.timeline = events
    .slice()
    .sort((a, b) => a.eventTimeMs - b.eventTimeMs || a.seq - b.seq)
    .map((e) => ({
      eventId: e.eventId,
      type: e.type,
      at: new Date(e.eventTimeMs).toISOString(),
      actor: e.actor?.name ?? null,
      nodeId: e.payload?.nodeId ?? null,
      summary: summarize(e),
    }));
  return state;
}

function nextActions(state, nodeId) {
  const route = getRoute(state.routeId);
  const idx = route.nodes.findIndex((n) => n.nodeId === nodeId);
  const node = route.nodes[idx];
  const ns = state.nodes[nodeId];
  const actions = [];
  if (state.status === "delivered") {
    actions.push({ action: "ARCHIVE", enabled: true, hint: "器物已送达，可归档交接单" });
    return actions;
  }
  if (!ns?.reached) {
    actions.push({ action: "RECORD_ARRIVAL", enabled: !state.frozen, hint: state.frozen ? "冻结中：可记录到达，但需先解除异常才能交接" : "记录车辆到达节点" });
  } else if (!ns.handoff) {
    actions.push({
      action: "COMPLETE_HANDOFF",
      enabled: !state.frozen,
      hint: state.frozen ? "冻结中：禁止放行交接，先处理未解决异常" : "记录封签/温湿度/检查项并由承运人签名",
    });
  }
  actions.push({ action: "UPLOAD_EVIDENCE", enabled: true, hint: "可随时（含离线补传）上传照片或传感器日志，按设备序号合并" });
  if (state.frozen) {
    actions.push({ action: "REPORT_ANOMALY_UPDATE", enabled: true, hint: "补充异常处置进展" });
    actions.push({ action: "RESOLVE_ANOMALY", enabled: true, roles: RESOLVE_ROLES, hint: "由管理员/保护人员填写处置结论后解除冻结" });
  } else {
    actions.push({ action: "REPORT_ANOMALY", enabled: true, hint: "发现冲击/离线/封签异常时立即上报，上报后链条冻结" });
    if (idx < route.nodes.length - 1) {
      actions.push({ action: "CHANGE_VEHICLE", enabled: true, dualConfirmation: true, hint: "换车需两名授权角色双人确认" });
    }
    actions.push({ action: "OPEN_CRATE", enabled: true, dualConfirmation: true, hint: "拆箱（含到场开箱）需两名授权角色双人确认并记录原因" });
  }
  return actions;
}

function summarize(e) {
  switch (e.type) {
    case "shipment.created": return `创建运输链，封签 ${e.payload.sealId}`;
    case "node.reached": return `到达节点 ${e.payload.nodeId}`;
    case "handoff.completed": return `完成节点 ${e.payload.nodeId} 交接，承运人 ${e.payload.carrier.carrierName}`;
    case "anomaly.reported": return `上报异常：${e.payload.description}`;
    case "anomaly.resolved": return `解除异常 ${e.payload.anomalyId}`;
    case "vehicle.changed": return `换车 ${e.payload.fromVehicleId} → ${e.payload.toVehicleId}`;
    case "crate.opened": return `拆箱：${e.payload.reason}`;
    case "evidence.uploaded": return `${e.payload.late ? "离线补传" : "上传"}证据（设备 ${e.payload.deviceSeq}）`;
    case "window.overdue": return `节点 ${e.payload.nodeId} 超出预约时间窗未到达`;
    default: return e.type;
  }
}

function validateDualConfirmations(confirmations) {
  if (!Array.isArray(confirmations) || confirmations.length !== 2) {
    fail(400, "DUAL_CONFIRMATION_REQUIRED", "换车/拆箱必须提供恰好两名确认人");
  }
  const [a, b] = confirmations;
  for (const c of confirmations) {
    if (!c?.personId || !c.name || !c.role) fail(400, "DUAL_CONFIRMATION_REQUIRED", "确认人缺少 personId/name/role");
    if (!isAuthorizedDualRole(c.role)) fail(403, "FORBIDDEN", `角色 ${c.role} 不具备换车/拆箱确认资格`);
  }
  if (a.personId === b.personId) fail(400, "DUAL_CONFIRMATION_REQUIRED", "双人确认必须是两个不同的人");
  return confirmations.map((c) => ({ personId: c.personId, name: c.name, role: c.role, at: c.at ?? null }));
}

function normalizeResults(checklist, results) {
  if (results == null) return [];
  if (!Array.isArray(results)) fail(400, "BAD_RESULTS", "results 必须是数组");
  const ids = new Set(checklist.map((i) => i.itemId));
  for (const r of results) {
    if (!ids.has(r.itemId)) fail(400, "UNKNOWN_CHECK_ITEM", `未知检查项 ${r.itemId}`);
    if (!["pass", "fail", "na"].includes(r.status)) fail(400, "BAD_RESULT_STATUS", `${r.itemId} 状态只能为 pass/fail/na`);
  }
  const seen = new Set();
  return results.filter((r) => (seen.has(r.itemId) ? false : (seen.add(r.itemId), true)))
    .map((r) => ({ itemId: r.itemId, status: r.status, note: r.note ?? null }));
}

function optionalNumber(value, field) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isNaN(n)) fail(400, "BAD_NUMBER", `${field} 必须是数值`);
  return n;
}
function outside(value, range) {
  return range ? value < range.min || value > range.max : false;
}
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).toUpperCase();
}
