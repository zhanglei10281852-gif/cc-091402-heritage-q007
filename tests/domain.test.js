import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ShippingEngine } from "../src/domain.js";
import { EventStore, shipmentFilePath } from "../src/store.js";
import { writeFileSync, readFileSync as readRaw } from "node:fs";
import { freshDataDir } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "..", "reference", "catalog.json"), "utf8"));

const A_WANG = { id: "u-wang", name: "王保护", role: "保护人员" };
const A_LI = { id: "u-li", name: "李管理", role: "管理员" };
const A_VISITOR = { id: "u-guest", name: "旁观", role: "只读访客" };

const SIGNATURE = { name: "张承运", staffNo: "YD-778", org: "中外运西安分公司" };

function engine(context, label, now = () => Date.parse("2026-09-23T07:00:00Z")) {
  const store = new EventStore(freshDataDir(context, label));
  return new ShippingEngine(store, catalog, { now });
}

function createInput(overrides = {}) {
  return {
    shipmentId: "S-001",
    artifactId: "artifact-0001",
    artifactName: "唐三彩骆驼载乐俑",
    fragilityLevel: 4,
    routeTemplateId: "xian-overseas-2026",
    vehicleType: "恒温气垫车",
    seals: ["SEAL-XA-0001"],
    actor: A_WANG,
    ...overrides,
  };
}

// 等级4 有 10 个检查项
function allPass(checks) {
  return checks.map((item) => ({ item, result: "pass" }));
}

function level4Photos() {
  return [
    { kind: "封签照片", ref: "p/seal/1" },
    { kind: "箱体照片", ref: "p/box/1" },
    { kind: "交接现场照片", ref: "p/scene/1" },
    { kind: "缓冲材料照片", ref: "p/foam/1" },
    { kind: "指示器读数照片", ref: "p/indicator/1" },
  ];
}

test("按脆弱等级生成包装检查项、温湿度限值与路线节点，并校验车辆能力", (context) => {
  const eng = engine(context, "rules");
  const shipment = eng.createShipment(createInput());
  assert.equal(shipment.packingChecks.length, 10);
  assert.ok(shipment.packingChecks.some((c) => c.includes("双人核对")));
  assert.deepEqual(shipment.envLimit.temperatureRangeC, { min: 18, max: 22 });
  assert.equal(shipment.nodes.length, 5);
  assert.equal(shipment.nodes[3].timezone, "Europe/Berlin");

  // 普通厢式车不能承运极脆弱器
  assert.throws(
    () => eng.createShipment(createInput({ shipmentId: "S-002", seals: ["SEAL-XA-0002"], vehicleType: "普通厢式车" })),
    (err) => err.code === "vehicle_capability_exceeded",
  );
});

test("每个封签只能绑定一条运输链", (context) => {
  const eng = engine(context, "seal");
  eng.createShipment(createInput());
  assert.throws(
    () => eng.createShipment(createInput({ shipmentId: "S-002", artifactId: "artifact-0002", seals: ["SEAL-XA-0001"] })),
    (err) => err.code === "seal_already_circulating" && err.message.includes("S-001"),
  );
  // 同一链内重绑也拒绝
  assert.throws(
    () => eng.bindSeal({ shipmentId: "S-001", sealId: "SEAL-XA-0001", occurredAt: "2026-09-23T09:00:00+08:00", actor: A_WANG }),
    (err) => err.code === "seal_exists",
  );
});

test("正常链路：逐节点交接放行直至完成，交接单要素齐全", (context) => {
  const eng = engine(context, "happy");
  eng.createShipment(createInput());

  // 节点0 西安库房 08:00-10:00 +08:00
  let r = eng.recordHandoff({
    shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, formNo: "HF-000",
    occurredAt: "2026-09-23T09:00:00+08:00", location: "西安博物院库房装箱月台",
    temperatureC: 20, humidityRh: 50, checks: allPass(catalog.fragilityRules["4"].packingChecks),
    photos: level4Photos(), carrierSignature: SIGNATURE,
  });
  assert.equal(r.anomalies.length, 0);
  assert.equal(r.projection.nodes[0].windowClass, "on_time");
  assert.deepEqual(r.projection.nodes[0].handoff.carrierSignature, SIGNATURE);

  let s = eng.releaseNode({ shipmentId: "S-001", nodeSeq: 0, occurredAt: "2026-09-23T09:30:00+08:00", actor: A_WANG });
  assert.equal(s.nodes[0].status, "released");

  // 节点1
  eng.recordHandoff({
    shipmentId: "S-001", nodeSeq: 1, actor: A_LI, formNo: "HF-001",
    occurredAt: "2026-09-23T14:00:00+08:00", location: "咸阳机场国际货站",
    temperatureC: 21, humidityRh: 52, checks: allPass(catalog.fragilityRules["4"].packingChecks),
    photos: [{ kind: "封签照片", ref: "p/seal/2" }, { kind: "箱体照片", ref: "p/box/2" }, { kind: "交接现场照片", ref: "p/scene/2" }, { kind: "缓冲材料照片", ref: "p/foam/2" }, { kind: "指示器读数照片", ref: "p/indicator/2" }],
    carrierSignature: { ...SIGNATURE, staffNo: "YD-779" },
  });
  eng.releaseNode({ shipmentId: "S-001", nodeSeq: 1, occurredAt: "2026-09-23T15:00:00+08:00", actor: A_LI });

  // 不能跳过节点
  assert.throws(
    () => eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 3, actor: A_WANG, formNo: "X", occurredAt: "2026-09-24T07:00:00+02:00", location: "x", temperatureC: 20, humidityRh: 50, checks: allPass(catalog.fragilityRules["4"].packingChecks), photos: level4Photos(), carrierSignature: SIGNATURE }),
    (err) => err.code === "node_locked",
  );

  // 节点2、3
  for (const [seq, at, loc, photos] of [
    [2, "2026-09-23T20:00:00+08:00", "出港航班舱位", level4Photos()],
    [3, "2026-09-24T07:30:00+02:00", "法兰克福机场货站", level4Photos()],
  ]) {
    eng.recordHandoff({ shipmentId: "S-001", nodeSeq: seq, actor: A_WANG, formNo: `HF-00${seq}`, occurredAt: at, location: loc, temperatureC: 20, humidityRh: 50, checks: allPass(catalog.fragilityRules["4"].packingChecks), photos, carrierSignature: SIGNATURE });
    eng.releaseNode({ shipmentId: "S-001", nodeSeq: seq, occurredAt: at, actor: A_WANG });
  }

  // 末节点交接+放行 -> 运输链完成
  eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 4, actor: A_LI, formNo: "HF-004", occurredAt: "2026-09-24T12:00:00+02:00", location: "海外展馆卸货平台", temperatureC: 20, humidityRh: 50, checks: allPass(catalog.fragilityRules["4"].packingChecks), photos: level4Photos(), carrierSignature: SIGNATURE });
  const done = eng.releaseNode({ shipmentId: "S-001", nodeSeq: 4, occurredAt: "2026-09-24T12:30:00+02:00", actor: A_LI });
  assert.equal(done.status, "completed");
  assert.equal(done.nodes[4].status, "released");

  // 封签沿唯一链条流转，可查到全部在场节点
  const seal = eng.getSeal("SEAL-XA-0001");
  assert.equal(seal.shipmentId, "S-001");
  assert.deepEqual(seal.chain.map((c) => c.nodeSeq), [0, 1, 2, 3, 4]);
});

test("交接后不能修改旧记录，只能补传；旧交接重复提交被拒绝", (context) => {
  const eng = engine(context, "immutable");
  eng.createShipment(createInput());
  const checks = allPass(catalog.fragilityRules["4"].packingChecks);
  eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, formNo: "HF-0", occurredAt: "2026-09-23T09:00:00+08:00", location: "库房", temperatureC: 20, humidityRh: 50, checks, photos: level4Photos(), carrierSignature: SIGNATURE });
  assert.throws(
    () => eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, formNo: "HF-0", occurredAt: "2026-09-23T09:05:00+08:00", location: "库房", temperatureC: 20, humidityRh: 50, checks, photos: level4Photos(), carrierSignature: SIGNATURE }),
    (err) => err.code === "handoff_exists",
  );
});

test("传感器离线与照片缺失立即冻结放行，离线补证+处置解除后才能继续", (context) => {
  const eng = engine(context, "freeze");
  eng.createShipment(createInput());
  const checks = allPass(catalog.fragilityRules["4"].packingChecks);

  // 传感器离线 + 只交了 3/5 种照片
  const r = eng.recordHandoff({
    shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, formNo: "HF-0",
    occurredAt: "2026-09-23T09:00:00+08:00", location: "库房月台",
    temperatureC: 20, humidityRh: 50, checks, sensorOffline: true,
    photos: [{ kind: "封签照片", ref: "p/seal/1" }, { kind: "箱体照片", ref: "p/box/1" }, { kind: "交接现场照片", ref: "p/scene/1" }],
    carrierSignature: SIGNATURE, offline: true,
  });
  const kinds = r.projection.anomalies.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["missing_photo", "sensor_offline"]);
  assert.equal(r.projection.frozen, true);

  // 放行被冻结（423 语义）
  assert.throws(
    () => eng.releaseNode({ shipmentId: "S-001", nodeSeq: 0, occurredAt: "2026-09-23T09:30:00+08:00", actor: A_WANG }),
    (err) => err.code === "shipment_frozen" && err.details.anomalyIds.length === 2,
  );

  // 冻结期间连下一节点交接也不允许
  assert.throws(
    () => eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 1, actor: A_WANG, formNo: "HF-1", occurredAt: "2026-09-23T14:00:00+08:00", location: "货站", temperatureC: 20, humidityRh: 50, checks, photos: level4Photos(), carrierSignature: SIGNATURE }),
    (err) => err.code === "shipment_frozen",
  );

  // 无证据不能解除
  const [photoAnomaly, sensorAnomaly] = [
    r.projection.anomalies.find((a) => a.kind === "missing_photo"),
    r.projection.anomalies.find((a) => a.kind === "sensor_offline"),
  ];
  assert.throws(
    () => eng.resolveAnomaly({ shipmentId: "S-001", anomalyId: photoAnomaly.anomalyId, actor: A_WANG, resolvedAt: "2026-09-23T12:00:00+08:00", note: "已核实" }),
    (err) => err.code === "evidence_outstanding",
  );

  // 离线终端恢复网络后补交：设备 HK-09 序号 1（照片）与序号 2（传感器恢复在线）
  const sup1 = eng.supplementEvidence({
    shipmentId: "S-001", nodeSeq: 0, actor: { id: "u-term", name: "押运终端", role: "保护人员" },
    deviceId: "HK-09", deviceSeq: 1, capturedAt: "2026-09-23T09:02:00+08:00",
    photos: [{ kind: "缓冲材料照片", ref: "p/foam/late1" }, { kind: "指示器读数照片", ref: "p/indicator/late1" }],
    note: "装箱时拍摄，出港区隧道无网络",
  });
  assert.equal(sup1.deduped, false);
  const sup2 = eng.supplementEvidence({
    shipmentId: "S-001", nodeSeq: 0, actor: { id: "u-term", name: "押运终端", role: "保护人员" },
    deviceId: "HK-09", deviceSeq: 2, capturedAt: "2026-09-23T11:30:00+08:00",
    sensor: { sensorOnline: true, temperatureC: 20.4, humidityRh: 51 },
  });
  assert.equal(sup2.deduped, false);

  // 重复补传：同一设备同一序号合并且不再次落账
  const dup = eng.supplementEvidence({
    shipmentId: "S-001", nodeSeq: 0, actor: { id: "u-term", name: "押运终端", role: "保护人员" },
    deviceId: "HK-09", deviceSeq: 1, capturedAt: "2026-09-23T09:02:00+08:00",
    photos: [{ kind: "缓冲材料照片", ref: "p/foam/late1" }],
  });
  assert.equal(dup.deduped, true);
  assert.equal(dup.eventSeq, sup1.eventSeq);
  const view = eng.getShipment("S-001");
  assert.equal(view.nodes[0].evidence.length, 2);

  // 时间窗不重算：交接仍是窗口内 on_time，补交事件按拍摄时刻进入时间线但不影响窗口判定
  assert.equal(view.nodes[0].windowClass, "on_time");

  // 只读访客不能解除异常
  assert.throws(
    () => eng.resolveAnomaly({ shipmentId: "S-001", anomalyId: photoAnomaly.anomalyId, actor: A_VISITOR, resolvedAt: "2026-09-23T12:00:00+08:00", note: "x" }),
    (err) => err.code === "forbidden",
  );

  eng.resolveAnomaly({ shipmentId: "S-001", anomalyId: photoAnomaly.anomalyId, actor: A_WANG, resolvedAt: "2026-09-23T12:05:00+08:00", note: "照片已补交并核对，缓冲与指示器无异常" });
  eng.resolveAnomaly({ shipmentId: "S-001", anomalyId: sensorAnomaly.anomalyId, actor: A_LI, resolvedAt: "2026-09-23T12:06:00+08:00", note: "传感器因隧道屏蔽离线，恢复在线读数连续，排除冲击" });

  const unfrozen = eng.getShipment("S-001");
  assert.equal(unfrozen.frozen, false);
  const released = eng.releaseNode({ shipmentId: "S-001", nodeSeq: 0, occurredAt: "2026-09-23T12:10:00+08:00", actor: A_WANG });
  assert.equal(released.nodes[0].status, "released");
});

test("补传不重复计算时间窗：窗口内交接后补交晚到证据不改变窗口结论", (context) => {
  const eng = engine(context, "window-once");
  eng.createShipment(createInput());
  eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, formNo: "HF-0", occurredAt: "2026-09-23T09:00:00+08:00", location: "库房", temperatureC: 20, humidityRh: 50, checks: allPass(catalog.fragilityRules["4"].packingChecks), photos: level4Photos(), carrierSignature: SIGNATURE });
  eng.releaseNode({ shipmentId: "S-001", nodeSeq: 0, occurredAt: "2026-09-23T09:30:00+08:00", actor: A_WANG });
  // 晚于窗口结束的补交
  eng.supplementEvidence({ shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, deviceId: "HK-10", deviceSeq: 0, capturedAt: "2026-09-23T18:00:00+08:00", photos: [{ kind: "封签照片", ref: "p/seal/extra" }] });
  const node = eng.getShipment("S-001").nodes[0];
  assert.equal(node.windowClass, "on_time");
  assert.equal(node.evidence.length, 1);
});

test("温湿度越界与检查不合格自动开异常并冻结", (context) => {
  const eng = engine(context, "env");
  eng.createShipment(createInput());
  const checks = catalog.fragilityRules["4"].packingChecks.map((item, i) => ({ item, result: i === 3 ? "fail" : "pass" }));
  const r = eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, formNo: "HF-0", occurredAt: "2026-09-23T09:00:00+08:00", location: "库房", temperatureC: 26, humidityRh: 80, checks, photos: level4Photos(), carrierSignature: SIGNATURE });
  const kinds = r.projection.anomalies.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["check_failed", "env_out_of_range", "env_out_of_range"]);
  assert.equal(r.projection.frozen, true);
});

test("换车与拆箱必须两个不同授权角色双人确认；拆箱作废封签后须双人重封", (context) => {
  const eng = engine(context, "dual");
  eng.createShipment(createInput());
  eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, formNo: "HF-0", occurredAt: "2026-09-23T09:00:00+08:00", location: "库房", temperatureC: 20, humidityRh: 50, checks: allPass(catalog.fragilityRules["4"].packingChecks), photos: level4Photos(), carrierSignature: SIGNATURE });
  eng.releaseNode({ shipmentId: "S-001", nodeSeq: 0, occurredAt: "2026-09-23T09:30:00+08:00", actor: A_WANG });

  // 同一人签两次不行
  assert.throws(
    () => eng.changeVehicle({ shipmentId: "S-001", actor: A_WANG, toVehicle: "温控航空ULD舱", occurredAt: "2026-09-23T12:00:00+08:00", confirmations: [A_WANG, { ...A_WANG }] }),
    (err) => err.code === "dual_confirmation_required",
  );
  // 访客参与不行
  assert.throws(
    () => eng.changeVehicle({ shipmentId: "S-001", actor: A_WANG, toVehicle: "温控航空ULD舱", occurredAt: "2026-09-23T12:00:00+08:00", confirmations: [A_WANG, A_VISITOR] }),
    (err) => err.code === "dual_confirmation_required",
  );
  // 能力不足的车不行
  assert.throws(
    () => eng.changeVehicle({ shipmentId: "S-001", actor: A_WANG, toVehicle: "普通厢式车", occurredAt: "2026-09-23T12:00:00+08:00", confirmations: [A_WANG, A_LI] }),
    (err) => err.code === "vehicle_capability_exceeded",
  );

  const changed = eng.changeVehicle({ shipmentId: "S-001", actor: A_WANG, toVehicle: "温控航空ULD舱", occurredAt: "2026-09-23T12:00:00+08:00", confirmations: [A_WANG, A_LI] });
  assert.equal(changed.projection.vehicleType, "温控航空ULD舱");
  assert.deepEqual(changed.projection.vehicleChanges[0].confirmations.map((c) => c.id), ["u-wang", "u-li"]);

  // 拆箱：双人确认，旧封签作废
  const opened = eng.openCrate({ shipmentId: "S-001", actor: A_WANG, reason: "航班安检要求开箱复核", occurredAt: "2026-09-23T17:00:00+08:00", confirmations: [A_WANG, A_LI] });
  assert.deepEqual(opened.projection.crateOpenings[0].cutSealIds, ["SEAL-XA-0001"]);
  assert.equal(opened.projection.seals[0].status, "voided");

  // 无有效封签不能交接
  assert.throws(
    () => eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 1, actor: A_WANG, formNo: "HF-1", occurredAt: "2026-09-23T14:00:00+08:00", location: "货站", temperatureC: 20, humidityRh: 50, checks: allPass(catalog.fragilityRules["4"].packingChecks), photos: level4Photos(), carrierSignature: SIGNATURE }),
    (err) => err.code === "no_active_seal",
  );
  // 单人重封不行
  assert.throws(
    () => eng.bindSeal({ shipmentId: "S-001", actor: A_WANG, sealId: "SEAL-XA-0002", occurredAt: "2026-09-23T17:20:00+08:00" }),
    (err) => err.code === "dual_confirmation_required",
  );
  const rebound = eng.bindSeal({ shipmentId: "S-001", actor: A_WANG, sealId: "SEAL-XA-0002", occurredAt: "2026-09-23T17:20:00+08:00", confirmations: [A_WANG, A_LI] });
  assert.equal(rebound.projection.seals.find((s) => s.sealId === "SEAL-XA-0002").replacement, true);
  assert.equal(rebound.projection.seals.find((s) => s.sealId === "SEAL-XA-0002").status, "active");

  // 新封签不能流到别的链
  assert.throws(
    () => eng.createShipment(createInput({ shipmentId: "S-009", seals: ["SEAL-XA-0002"] })),
    (err) => err.code === "seal_already_circulating",
  );
});

test("跨时区时间线以 UTC 统一排序并给出节点本地时间", (context) => {
  const eng = engine(context, "tz");
  eng.createShipment(createInput());
  const pass = allPass(catalog.fragilityRules["4"].packingChecks);
  eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, formNo: "HF-0", occurredAt: "2026-09-23T09:00:00+08:00", location: "库房", temperatureC: 20, humidityRh: 50, checks: pass, photos: level4Photos(), carrierSignature: SIGNATURE });
  eng.releaseNode({ shipmentId: "S-001", nodeSeq: 0, occurredAt: "2026-09-23T09:30:00+08:00", actor: A_WANG });
  eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 1, actor: A_WANG, formNo: "HF-1", occurredAt: "2026-09-23T14:00:00+08:00", location: "咸阳货站", temperatureC: 20, humidityRh: 50, checks: pass, photos: level4Photos(), carrierSignature: SIGNATURE });
  eng.releaseNode({ shipmentId: "S-001", nodeSeq: 1, occurredAt: "2026-09-23T15:00:00+08:00", actor: A_WANG });
  eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 2, actor: A_WANG, formNo: "HF-2", occurredAt: "2026-09-23T20:00:00+08:00", location: "航班舱位", temperatureC: 20, humidityRh: 50, checks: pass, photos: level4Photos(), carrierSignature: SIGNATURE });
  eng.releaseNode({ shipmentId: "S-001", nodeSeq: 2, occurredAt: "2026-09-23T20:30:00+08:00", actor: A_WANG });
  eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 3, actor: A_WANG, formNo: "HF-3", occurredAt: "2026-09-24T07:30:00+02:00", location: "法兰克福", temperatureC: 20, humidityRh: 50, checks: pass, photos: level4Photos(), carrierSignature: SIGNATURE });

  const timeline = eng.getTimeline("S-001");
  const epochs = timeline.map((t) => Date.parse(t.utcTime));
  assert.deepEqual(epochs, [...epochs].sort((a, b) => a - b));
  const fraHandoff = timeline.find((t) => t.nodeSeq === 3 && t.kind === "handoff");
  assert.equal(fraHandoff.utcTime, "2026-09-24T05:30:00.000Z");
  assert.ok(fraHandoff.localTime.includes("UTC+2") || fraHandoff.localTime.includes("GMT+2") || fraHandoff.localTime.includes("中欧"));
});

test("查询节点可见箱况、责任人、未解决异常与下一步", (context) => {
  const eng = engine(context, "query");
  eng.createShipment(createInput());
  const checks = allPass(catalog.fragilityRules["4"].packingChecks);
  eng.recordHandoff({ shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, formNo: "HF-0", occurredAt: "2026-09-23T09:00:00+08:00", location: "库房月台", temperatureC: 20, humidityRh: 50, checks, sensorOffline: true, photos: level4Photos(), carrierSignature: SIGNATURE });
  const node = eng.getShipment("S-001").nodes[0];
  assert.equal(node.handoff.temperatureC, 20);
  assert.equal(node.handoff.recordedBy.name, "王保护");
  assert.equal(node.openAnomalies[0].kind, "sensor_offline");
  assert.ok(node.nextActions.some((a) => a.includes("AN-S-001-001")));
  assert.ok(node.nextActions.some((a) => a.includes("放行被冻结")));

  const nextNode = eng.getShipment("S-001").nodes[1];
  assert.equal(nextNode.status, "pending");
  // 冻结期间节点 0 未放行，下一节点的可执行动作是等待前序放行，而不是直接交接
  assert.ok(nextNode.nextActions.some((a) => a.includes("等待前序节点 0 放行")));
});

test("超时扫描：错过窗口与放行超时被标记，重启后仍生效且不重复", (context) => {
  const dir = freshDataDir(context, "restart");
  const store1 = new EventStore(dir);
  const fixedNow = () => Date.parse("2026-09-24T12:30:00+02:00"); // 法兰克福窗口已过
  const eng1 = new ShippingEngine(store1, catalog, { now: fixedNow });
  eng1.createShipment(createInput());
  // 一个节点都没交接：节点0 窗口（09-23 10:00+08）早已错过
  const marked = eng1.scanOverdue();
  assert.ok(marked.some((m) => m.nodeSeq === 0 && m.kind === "window_missed"));
  // 再扫一次不重复
  assert.deepEqual(eng1.scanOverdue(), []);

  // 模拟服务重启：全新引擎重放同一数据目录
  const eng2 = new ShippingEngine(new EventStore(dir), catalog, { now: fixedNow });
  const restored = eng2.getShipment("S-001");
  assert.ok(restored.overdue.some((o) => o.nodeSeq === 0 && o.kind === "window_missed"));
  assert.deepEqual(eng2.scanOverdue(), []);
});

test("异常冻结状态在服务重启后仍然有效", (context) => {
  const dir = freshDataDir(context, "freeze-restart");
  const eng1 = new ShippingEngine(new EventStore(dir), catalog);
  eng1.createShipment(createInput());
  eng1.recordHandoff({ shipmentId: "S-001", nodeSeq: 0, actor: A_WANG, formNo: "HF-0", occurredAt: "2026-09-23T09:00:00+08:00", location: "库房", temperatureC: 20, humidityRh: 50, checks: allPass(catalog.fragilityRules["4"].packingChecks), sensorOffline: true, photos: level4Photos(), carrierSignature: SIGNATURE });

  const eng2 = new ShippingEngine(new EventStore(dir), catalog);
  const restored = eng2.getShipment("S-001");
  assert.equal(restored.frozen, true);
  assert.throws(
    () => eng2.releaseNode({ shipmentId: "S-001", nodeSeq: 0, occurredAt: "2026-09-23T12:00:00+08:00", actor: A_WANG }),
    (err) => err.code === "shipment_frozen",
  );
});

test("事件日志被篡改时重放报哈希链断裂", (context) => {
  const dir = freshDataDir(context, "tamper");
  const store = new EventStore(dir);
  const eng = new ShippingEngine(store, catalog);
  eng.createShipment(createInput());
  const logPath = shipmentFilePath(dir, "S-001");
  const lines = readRaw(logPath, "utf8").split("\n").filter(Boolean);
  const tampered = JSON.parse(lines[0]);
  tampered.payload.artifactName = "被篡改的名称";
  lines[0] = JSON.stringify(tampered);
  writeFileSync(logPath, lines.join("\n") + "\n");
  const eng2 = new ShippingEngine(new EventStore(dir), catalog);
  assert.throws(() => eng2.getShipment("S-001"), (err) => err.code === "chain_broken");
});
