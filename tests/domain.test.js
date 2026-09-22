import assert from "node:assert/strict";
import test from "node:test";
import { ShippingService } from "../src/shipping.js";
import { makeService, createL1, COORDINATOR, CONSERVATOR, GUARD } from "./helpers.js";

const throws = (fn, statusCode, code) => {
  try {
    fn();
    assert.fail("应当抛出异常");
  } catch (error) {
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
  }
};

test("按脆弱等级生成检查项与温湿度限值", () => {
  const { service } = makeService();
  const event = createL1(service);
  const state = service.getShipment(event.shipmentId);
  assert.equal(state.checklist.length, 8);
  assert.deepEqual(state.limits.temperatureC, { min: 18, max: 22 });
  assert.ok(state.checklist.some((i) => i.itemId === "shock-indicator"));
});

test("封签全局唯一：同一封签不能绑定第二条运输链", () => {
  const { service } = makeService();
  createL1(service);
  throws(
    () => createL1(service, { shipmentId: "S-002", eventTime: "2026-09-23T07:40:00+08:00" }),
    409,
    "SEAL_ALREADY_BOUND",
  );
});

test("车辆能力不足时拒绝创建（L1 必须空气悬架+恒温恒湿）", () => {
  const { service } = makeService();
  throws(
    () => createL1(service, { shipmentId: "S-009", sealId: "SEAL-9", vehicleId: "SN-XA-014" }),
    422,
    "VEHICLE_CAPABILITY",
  );
});

test("完整正常交接：全部检查项通过、封签完好、温湿度达标", () => {
  const { service } = makeService();
  const e = createL1(service);
  service.recordArrival(e.shipmentId, { nodeId: "n1-origin", eventTime: "2026-09-23T08:30:00+08:00" }, COORDINATOR);
  const state0 = service.getShipment(e.shipmentId);
  const result = service.completeHandoff(
    e.shipmentId,
    {
      nodeId: "n1-origin",
      eventTime: "2026-09-23T08:45:00+08:00",
      carrierId: "C-001",
      carrierName: "陈承运",
      sealStatus: "intact",
      temperatureC: 20.1,
      humidityPct: 55,
      results: state0.checklist.map((i) => ({ itemId: i.itemId, status: "pass" })),
    },
    COORDINATOR,
  );
  assert.equal(result.frozen, false);
  assert.equal(result.derivedEvents.length, 0);
  assert.equal(service.getShipment(e.shipmentId).frozen, false);
});

test("交接缺照片/检查项未记录自动生成异常并冻结，且冻结时禁止放行", () => {
  const { service } = makeService();
  const e = createL1(service);
  service.recordArrival(e.shipmentId, { nodeId: "n1-origin", eventTime: "2026-09-23T08:30:00+08:00" }, COORDINATOR);
  const result = service.completeHandoff(
    e.shipmentId,
    {
      nodeId: "n1-origin",
      eventTime: "2026-09-23T08:45:00+08:00",
      carrierId: "C-001",
      carrierName: "陈承运",
      sealStatus: "intact",
      temperatureC: 20,
      humidityPct: 55,
      results: [], // 8 项全部未记录
    },
    COORDINATOR,
  );
  assert.equal(result.frozen, true);
  const state = service.getShipment(e.shipmentId);
  assert.equal(state.frozen, true);
  assert.ok(state.openAnomalyIds.length >= 8);

  // 已预约的下一站到达仍可登记，但下一站交接被冻结拦截
  service.recordArrival(e.shipmentId, { nodeId: "n2-xian-airport", eventTime: "2026-09-23T12:30:00+08:00" }, COORDINATOR);
  throws(
    () =>
      service.completeHandoff(
        e.shipmentId,
        { nodeId: "n2-xian-airport", carrierId: "C-002", carrierName: "赵承运", eventTime: "2026-09-23T13:00:00+08:00", results: [] },
        COORDINATOR,
      ),
    409,
    "FROZEN",
  );
});

test("冻结只能靠追加解除事件解除：协调员无权，保护人员解除后放行，旧事件不变", () => {
  const { service, store } = makeService();
  const e = createL1(service, { shipmentId: "S-010", sealId: "SEAL-10" });
  service.recordArrival(e.shipmentId, { nodeId: "n1-origin", eventTime: "2026-09-23T08:30:00+08:00" }, COORDINATOR);
  const reported = service.reportAnomaly(
    e.shipmentId,
    { nodeId: "n1-origin", type: "shock", description: "冲击传感器离线，包装箱受撞击", eventTime: "2026-09-23T08:50:00+08:00" },
    GUARD,
  );
  const anomalyId = reported.event.payload.anomalyId;
  assert.equal(service.getShipment(e.shipmentId).frozen, true);

  throws(
    () => service.resolveAnomaly(e.shipmentId, { anomalyId, resolution: "协调员尝试解除" }, COORDINATOR),
    403,
    "FORBIDDEN",
  );
  assert.equal(service.getShipment(e.shipmentId).frozen, true, "无权解除不改变冻结");

  service.resolveAnomaly(
    e.shipmentId,
    { anomalyId, resolution: "开箱复检器物无损，更换缓冲后放行", evidenceDeviceSeq: "D-77", eventTime: "2026-09-23T09:30:00+08:00" },
    CONSERVATOR,
  );
  const after = service.getShipment(e.shipmentId);
  assert.equal(after.frozen, false);
  assert.equal(after.anomalies[anomalyId].status, "resolved");

  // 原始上报事件仍在日志中，没有被修改或删除
  const reportedEvents = store.byShipment(e.shipmentId).filter((x) => x.type === "anomaly.reported");
  assert.equal(reportedEvents.length, 1);
  assert.equal(reportedEvents[0].payload.description, "冲击传感器离线，包装箱受撞击");
});

test("补传证据按设备序号合并、文件去重，且不改变节点时间窗判定", () => {
  const { service } = makeService();
  const e = createL1(service, { shipmentId: "S-020", sealId: "SEAL-20" });
  service.recordArrival(e.shipmentId, { nodeId: "n1-origin", eventTime: "2026-09-23T08:30:00+08:00" }, COORDINATOR);
  const r1 = service.uploadEvidence(
    e.shipmentId,
    {
      deviceSeq: "D-77",
      evidenceType: "photo",
      nodeId: "n1-origin",
      capturedAt: "2026-09-23T08:45:00+08:00",
      files: [{ name: "a.jpg", sha256: "ha" }, { name: "b.jpg", sha256: "hb" }],
    },
    COORDINATOR,
  );
  assert.equal(r1.merged, false);
  const r2 = service.uploadEvidence(
    e.shipmentId,
    {
      deviceSeq: "D-77",
      nodeId: "n1-origin",
      capturedAt: "2026-09-23T09:00:00+08:00",
      files: [{ name: "b.jpg", sha256: "hb" }, { name: "c.jpg", sha256: "hc" }],
    },
    COORDINATOR,
  );
  assert.equal(r2.merged, true);
  const state = service.getShipment(e.shipmentId);
  const rec = state.evidence["D-77"];
  assert.equal(rec.mergedUploads, 2);
  assert.deepEqual(rec.files.map((f) => f.name), ["a.jpg", "b.jpg", "c.jpg"]);

  // 时间窗判定只来自到达事件：补传证据没有把节点重算
  assert.equal(state.nodes["n1-origin"].withinWindow, true);
});

test("换车必须两名不同的授权角色确认", () => {
  const { service } = makeService();
  const e = createL1(service, { shipmentId: "S-030", sealId: "SEAL-30" });
  const body = {
    fromVehicleId: "SN-XA-001",
    toVehicleId: "SN-BER-007",
    reason: "航班到达后接驳",
    eventTime: "2026-09-23T23:00:00+02:00",
  };
  throws(() => service.changeVehicle(e.shipmentId, body, COORDINATOR), 400, "DUAL_CONFIRMATION_REQUIRED");
  throws(
    () => service.changeVehicle(e.shipmentId, { ...body, confirmations: [
      { personId: "u-li", name: "李保护", role: "保护人员" },
      { personId: "u-li", name: "李保护", role: "保护人员" },
    ] }, COORDINATOR),
    400,
    "DUAL_CONFIRMATION_REQUIRED",
  );
  throws(
    () => service.changeVehicle(e.shipmentId, { ...body, confirmations: [
      { personId: "u-zhang", name: "张协调", role: "运输协调员" },
      { personId: "u-wang", name: "王押运", role: "押运员" },
    ] }, COORDINATOR),
    403,
    "FORBIDDEN",
  );
  service.changeVehicle(e.shipmentId, { ...body, confirmations: [
    { personId: "u-li", name: "李保护", role: "保护人员" },
    { personId: "u-wang", name: "王押运", role: "押运员" },
  ] }, COORDINATOR);
  assert.equal(service.getShipment(e.shipmentId).currentVehicleId, "SN-BER-007");
});

test("跨时区事件按统一事件时间（绝对时刻）排序", () => {
  const { service } = makeService();
  const e = createL1(service, { shipmentId: "S-040", sealId: "SEAL-40", eventTime: "2026-09-22T23:30:00+08:00" });
  // 柏林 22:40+02 = 20:40Z，晚于西安 08:30+08 = 00:30Z
  service.recordArrival(e.shipmentId, { nodeId: "n3-fra-airport", eventTime: "2026-09-23T22:40:00+02:00" }, GUARD);
  service.recordArrival(e.shipmentId, { nodeId: "n1-origin", eventTime: "2026-09-23T08:30:00+08:00" }, COORDINATOR);
  const timeline = service.getShipment(e.shipmentId).timeline;
  const at = timeline.map((t) => t.at);
  assert.deepEqual(at, [...at].sort(), "时间线必须按纪元毫秒升序");
  assert.equal(timeline[0].type, "shipment.created");
  assert.equal(timeline[1].nodeId, "n1-origin");
  assert.equal(timeline[2].nodeId, "n3-fra-airport");
});

test("拒绝无时区偏移的时间", () => {
  const { service } = makeService();
  throws(() => createL1(service, { eventTime: "2026-09-23 08:00:00" }), 400, "INVALID_TIME");
  throws(() => createL1(service, { eventTime: "2026-09-23T08:00:00" }), 400, "INVALID_TIME");
});

test("节点查询给出箱况、责任人、未解决异常与可执行下一步；支持 asOf 历史快照", () => {
  const { service } = makeService();
  const e = createL1(service, { shipmentId: "S-050", sealId: "SEAL-50" });
  const before = service.nodeSnapshot(e.shipmentId, "n1-origin", "2026-09-23T08:00:00+08:00");
  assert.equal(before.arrival, null);
  assert.ok(before.nextActions.some((a) => a.action === "RECORD_ARRIVAL"));

  service.recordArrival(e.shipmentId, { nodeId: "n1-origin", eventTime: "2026-09-23T08:30:00+08:00" }, COORDINATOR);
  service.reportAnomaly(
    e.shipmentId,
    { nodeId: "n1-origin", type: "device-offline", description: "冲击传感器离线", eventTime: "2026-09-23T08:31:00+08:00" },
    GUARD,
  );
  const snap = service.nodeSnapshot(e.shipmentId, "n1-origin");
  assert.equal(snap.frozen, true);
  assert.equal(snap.openAnomalies.length, 1);
  assert.equal(snap.openAnomalies[0].type, "device-offline");
  assert.equal(snap.responsible.coordinator.name, "张协调");
  assert.equal(snap.boxCondition.sealId, "SEAL-50");
  assert.ok(snap.node.windowLocal.includes("Asia/Shanghai"));
  const enabled = snap.nextActions.filter((a) => a.enabled).map((a) => a.action);
  assert.ok(enabled.includes("RESOLVE_ANOMALY"));
  assert.ok(!enabled.includes("COMPLETE_HANDOFF"), "冻结时交接动作必须不可用");
});

test("超时提醒确定性幂等：每节点只触发一次", () => {
  const fixedNow = () => Date.parse("2026-09-23T10:05:00+08:00");
  const { service, store } = makeService(fixedNow);
  const e = createL1(service, { shipmentId: "S-060", sealId: "SEAL-60", eventTime: "2026-09-23T07:30:00+08:00" });
  const first = service.markOverdue(e.shipmentId, "n1-origin");
  assert.equal(first.duplicate, false);
  const second = service.markOverdue(e.shipmentId, "n1-origin");
  assert.equal(second.duplicate, true);
  assert.equal(store.events.filter((x) => x.type === "window.overdue").length, 1);
});
