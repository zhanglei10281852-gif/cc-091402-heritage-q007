import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { OverdueMonitor } from "../src/scheduler.js";
import { makeService, COORDINATOR, CONSERVATOR } from "./helpers.js";

const HEADERS = {
  "content-type": "application/json",
  "x-user-id": COORDINATOR.id,
  "x-user-name": encodeURIComponent(COORDINATOR.name),
  "x-user-role": encodeURIComponent(COORDINATOR.role),
};

async function withServer(t, { now } = {}) {
  const { service } = makeService(now);
  const monitor = new OverdueMonitor(service, { intervalMs: 9_999_999 });
  const server = createApp({ service, monitor });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, body, extra = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? HEADERS : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json() };
  };
  return { req, base };
}

test("端到端：创建→到达→异常冻结→补证据→解除→交接→节点查询", async () => {
  // 固定“当前时间”在事件当天中午，使 08:34 采集的证据被识别为延迟补交
  const { req } = await withServer(test, { now: () => Date.parse("2026-09-23T12:00:00+08:00") });

  const created = await req("POST", "/shipments", {
    shipmentId: "S-E2E",
    artifactName: "北朝石刻佛首",
    fragilityLevel: "L2",
    routeId: "xian-to-berlin-2026-09",
    sealId: "SEAL-E2E",
    vehicleId: "SN-XA-001",
    eventTime: "2026-09-23T07:30:00+08:00",
  });
  assert.equal(created.status, 201);

  const ref = await req("GET", "/reference/fragility?level=L2");
  assert.equal(ref.json.checklist.length, 6);

  const arrived = await req("POST", "/shipments/S-E2E/arrivals", {
    nodeId: "n1-origin",
    eventTime: "2026-09-23T08:30:00+08:00",
  });
  assert.equal(arrived.status, 201);

  // 冲击传感器离线：异常上报，链条冻结
  const anomaly = await req("POST", "/shipments/S-E2E/anomalies", {
    nodeId: "n1-origin",
    type: "device-offline",
    severity: "critical",
    description: "包装箱冲击传感器离线，交接照片缺失",
    response: "暂停放行，等待传感器日志补传",
    eventTime: "2026-09-23T08:35:00+08:00",
  });
  assert.equal(anomaly.status, 201);
  const anomalyId = anomaly.json.event.payload.anomalyId;

  const blocked = await req("POST", "/shipments/S-E2E/handoffs", {
    nodeId: "n1-origin",
    carrierId: "C-9",
    carrierName: "陈承运",
    eventTime: "2026-09-23T08:40:00+08:00",
    results: [],
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, "FROZEN");

  // 离线终端稍后补交证据
  const evidence = await req("POST", "/shipments/S-E2E/evidence", {
    deviceSeq: "SHOCK-LOGGER-07",
    evidenceType: "shock-log",
    nodeId: "n1-origin",
    capturedAt: "2026-09-23T08:34:00+08:00",
    files: [{ name: "shock-0834.csv", sha256: "abc" }],
  });
  assert.equal(evidence.status, 201);
  assert.equal(evidence.json.late, true);

  // 同一设备序号重发（网络重试）：幂等合并，不新增证据记录
  const retry = await req("POST", "/shipments/S-E2E/evidence", {
    deviceSeq: "SHOCK-LOGGER-07",
    nodeId: "n1-origin",
    capturedAt: "2026-09-23T08:34:00+08:00",
    files: [{ name: "shock-0834.csv", sha256: "abc" }],
  }, { "idempotency-key": "evt-evidence-77" });
  // 第一次没用固定键，这里验证按设备序号仍合并：文件不重复
  const stateRes = await req("GET", "/shipments/S-E2E");
  assert.equal(stateRes.json.evidence["SHOCK-LOGGER-07"].files.length, 1);
  assert.equal(stateRes.json.evidence["SHOCK-LOGGER-07"].mergedUploads, 2);

  // 保护人员解除异常
  const resolved = await req("POST", "/shipments/S-E2E/resolve-anomaly", {
    anomalyId,
    resolution: "传感器日志显示全程低于阈值，离线仅为信号问题，准予放行",
    evidenceDeviceSeq: "SHOCK-LOGGER-07",
    eventTime: "2026-09-23T09:10:00+08:00",
  }, {
    "content-type": "application/json",
    "x-user-id": CONSERVATOR.id,
    "x-user-name": encodeURIComponent(CONSERVATOR.name),
    "x-user-role": encodeURIComponent(CONSERVATOR.role),
  });
  assert.equal(resolved.status, 200);

  // 放行交接（L2 六项全过，温湿度达标）
  const results = stateRes.json.checklist.map((i) => ({ itemId: i.itemId, status: "pass" }));
  const handoff = await req("POST", "/shipments/S-E2E/handoffs", {
    nodeId: "n1-origin",
    carrierId: "C-9",
    carrierName: "陈承运",
    carrierCompany: "西安文物运输队",
    sealStatus: "intact",
    temperatureC: 20,
    humidityPct: 55,
    results,
    eventTime: "2026-09-23T09:20:00+08:00",
  });
  assert.equal(handoff.status, 201);
  assert.equal(handoff.json.frozen, false);

  // 节点快照
  const node = await req("GET", "/shipments/S-E2E/nodes/n1-origin");
  assert.equal(node.status, 200);
  assert.equal(node.json.boxCondition.sealStatus, "intact");
  assert.equal(node.json.responsible.atNode.carrierName, "陈承运");
  assert.deepEqual(node.json.openAnomalies, []);
  assert.ok(node.json.nextActions.some((a) => a.action === "RECORD_ARRIVAL" || a.action === "CHANGE_VEHICLE"));
  assert.ok(node.json.node.windowLocal.includes("2026"));

  // 交接单
  const sheet = await req("GET", "/shipments/S-E2E/handoff-sheet/n1-origin");
  assert.equal(sheet.status, 200);
  assert.equal(sheet.json.title, "文物运输交接单");
  const sealField = sheet.json.fields.find((f) => f.key === "sealId");
  assert.equal(sealField.value, "SEAL-E2E");
  assert.equal(sheet.json.status, "已完成");

  // 时间线按统一事件时间排序
  const timeline = await req("GET", "/shipments/S-E2E/timeline");
  const ats = timeline.json.timeline.map((t) => t.at);
  assert.deepEqual(ats, [...ats].sort());
});

test("写操作缺少身份头返回 401", async () => {
  const { base } = await withServer(test);
  const response = await fetch(base + "/shipments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shipmentId: "S-NOAUTH", artifactName: "x", fragilityLevel: "L3", routeId: "xian-to-berlin-2026-09", sealId: "SEAL-X" }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, "UNAUTHENTICATED");
});

test("Idempotency-Key 防止离线重试重复登记异常", async () => {
  const { req } = await withServer(test);
  await req("POST", "/shipments", {
    shipmentId: "S-IDEM",
    artifactName: "陶罐",
    fragilityLevel: "L3",
    routeId: "xian-to-berlin-2026-09",
    sealId: "SEAL-IDEM",
    eventTime: "2026-09-23T07:30:00+08:00",
  });
  const payload = {
    nodeId: "n1-origin",
    type: "tilt",
    description: "倒车时倾侧报警",
    eventTime: "2026-09-23T08:35:00+08:00",
  };
  const opts = { "idempotency-key": "client-evt-tilt-1" };
  const r1 = await req("POST", "/shipments/S-IDEM/anomalies", payload, opts);
  const r2 = await req("POST", "/shipments/S-IDEM/anomalies", payload, opts);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r1.json.event.eventId, r2.json.event.eventId);
  const state = await req("GET", "/shipments/S-IDEM");
  assert.equal(Object.keys(state.json.anomalies).length, 1, "同一客户端事件重放不得产生第二条异常");
});

test("超过预约时间窗未到达：监控触发提醒，重复扫描不重复", async () => {
  const now = () => Date.parse("2026-09-23T10:30:00+08:00");
  const { req } = await withServer(test, { now });
  await req("POST", "/shipments", {
    shipmentId: "S-LATE",
    artifactName: "铜鼎",
    fragilityLevel: "L3",
    routeId: "xian-to-berlin-2026-09",
    sealId: "SEAL-LATE",
    eventTime: "2026-09-23T07:30:00+08:00",
  });
  const scan1 = await req("POST", "/admin/scan-overdue");
  assert.equal(scan1.status, 200);
  assert.ok(scan1.json.fired.some((f) => f.nodeId === "n1-origin"));
  const scan2 = await req("POST", "/admin/scan-overdue");
  assert.deepEqual(scan2.json.fired, []);
});
