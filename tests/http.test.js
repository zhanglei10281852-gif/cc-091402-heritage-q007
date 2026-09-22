import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { freshDataDir } from "./helpers.js";

const A_WANG = { id: "u-wang", name: "王保护", role: "保护人员" };
const SIGNATURE = { name: "张承运", staffNo: "YD-778", org: "中外运西安分公司" };

async function harness(context) {
  const server = createApp({ dataDir: freshDataDir(context, "http") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json() };
  };
  return { req };
}

const CHECKS4 = [
  "外箱无破损、无变形、无受潮痕迹",
  "封签编号一致且封签牢固（双人核对）",
  "定制缓冲内衬与器物轮廓贴合，缓冲厚度符合规范",
  "冲击指示器、倾斜指示器已安装且读数留证",
  "箱内温湿度记录仪已开启并读数正常",
  "气垫防震底座与车厢固定点已锁紧",
  "外箱与车厢间无窜动间隙",
  "箱内无异常响动",
  "随箱单证、保险单与交接单齐全",
  "装箱过程影像记录完整",
].map((item) => ({ item, result: "pass" }));

const PHOTOS4 = [
  { kind: "封签照片", ref: "p/seal/1" },
  { kind: "箱体照片", ref: "p/box/1" },
  { kind: "交接现场照片", ref: "p/scene/1" },
  { kind: "缓冲材料照片", ref: "p/foam/1" },
  { kind: "指示器读数照片", ref: "p/indicator/1" },
];

test("HTTP：场景演练——创建→传感器离线冻结→离线补证→解除→放行，查询节点全景", async (context) => {
  const { req } = await harness(context);

  const catalog = await req("GET", "/catalog/packing-checks?fragilityLevel=4");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.json.packingChecks.length, 10);

  const created = await req("POST", "/shipments", {
    shipmentId: "S-HTTP-1",
    artifactId: "artifact-0001",
    artifactName: "唐三彩骆驼载乐俑",
    fragilityLevel: 4,
    routeTemplateId: "xian-overseas-2026",
    vehicleType: "恒温气垫车",
    seals: ["SEAL-HTTP-1"],
    actor: A_WANG,
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.shipment.frozen, false);

  // 冲击传感器离线 + 照片缺两种
  const handoff = await req("POST", "/shipments/S-HTTP-1/handoffs", {
    nodeSeq: 0, actor: A_WANG, formNo: "HF-0",
    occurredAt: "2026-09-23T09:00:00+08:00", location: "西安库房月台",
    temperatureC: 20, humidityRh: 50, checks: CHECKS4, sensorOffline: true,
    photos: PHOTOS4.slice(0, 3), carrierSignature: SIGNATURE, offline: true,
  });
  assert.equal(handoff.status, 201);
  assert.equal(handoff.json.projection.frozen, true);

  // 放行 → 423 冻结
  const blocked = await req("POST", "/shipments/S-HTTP-1/releases", { nodeSeq: 0, actor: A_WANG, occurredAt: "2026-09-23T09:30:00+08:00" });
  assert.equal(blocked.status, 423);
  assert.equal(blocked.json.error, "shipment_frozen");

  // 节点全景
  const nodeView = await req("GET", "/shipments/S-HTTP-1/nodes/0");
  assert.equal(nodeView.status, 200);
  assert.equal(nodeView.json.node.handoff.sensorOffline, true);
  assert.equal(nodeView.json.node.openAnomalies.length, 2);
  assert.ok(nodeView.json.node.nextActions.some((a) => a.includes("补交证据")));
  assert.match(nodeView.json.node.windowLocal, /GMT\+8|西安|上海|中国/);

  // 离线终端补传照片与恢复在线读数
  const sup1 = await req("POST", "/shipments/S-HTTP-1/evidence", {
    nodeSeq: 0, actor: A_WANG, deviceId: "HK-09", deviceSeq: 1,
    capturedAt: "2026-09-23T09:02:00+08:00",
    photos: [{ kind: "缓冲材料照片", ref: "p/foam/late" }, { kind: "指示器读数照片", ref: "p/indicator/late" }],
  });
  assert.equal(sup1.status, 201);
  assert.equal(sup1.json.deduped, false);
  const supDup = await req("POST", "/shipments/S-HTTP-1/evidence", {
    nodeSeq: 0, actor: A_WANG, deviceId: "HK-09", deviceSeq: 1,
    capturedAt: "2026-09-23T09:02:00+08:00", photos: [{ kind: "缓冲材料照片", ref: "p/foam/late" }],
  });
  assert.equal(supDup.status, 201);
  assert.equal(supDup.json.deduped, true);
  await req("POST", "/shipments/S-HTTP-1/evidence", {
    nodeSeq: 0, actor: A_WANG, deviceId: "HK-09", deviceSeq: 2,
    capturedAt: "2026-09-23T11:30:00+08:00",
    sensor: { sensorOnline: true, temperatureC: 20.4, humidityRh: 51 },
  });

  const ids = nodeView.json.node.openAnomalies.map((a) => a.anomalyId);
  for (const id of ids) {
    const res = await req("POST", "/shipments/S-HTTP-1/anomalies/resolve", {
      anomalyId: id, actor: A_WANG, resolvedAt: "2026-09-23T12:10:00+08:00", note: "补证齐全，排除运输风险，同意放行",
    });
    assert.equal(res.status, 201, `异常 ${id} 应能解除`);
  }

  const released = await req("POST", "/shipments/S-HTTP-1/releases", { nodeSeq: 0, actor: A_WANG, occurredAt: "2026-09-23T12:15:00+08:00" });
  assert.equal(released.status, 201);
  assert.equal(released.json.nodes[0].status, "released");
  assert.equal(released.json.frozen, false);

  // 时间线：补交证据按实际拍摄时刻入列
  const timeline = await req("GET", "/shipments/S-HTTP-1/timeline");
  const ev = timeline.json.timeline.find((t) => t.kind === "evidence_supplemented" && t.data.deviceSeq === 1);
  assert.equal(ev.utcTime, "2026-09-23T01:02:00.000Z");

  // 封签流转链
  const seal = await req("GET", "/seals/SEAL-HTTP-1");
  assert.equal(seal.status, 200);
  assert.equal(seal.json.seal.shipmentId, "S-HTTP-1");
  assert.deepEqual(seal.json.seal.chain.map((c) => c.nodeSeq), [0]);

  // 无权角色
  const forbidden = await req("POST", "/shipments/S-HTTP-1/anomalies", {
    nodeSeq: 1, kind: "other", description: "访客上报", occurredAt: "2026-09-23T13:00:00+08:00",
    actor: { id: "g", name: "访客", role: "只读访客" },
  });
  assert.equal(forbidden.status, 403);
});

test("HTTP：错误输入映射为 4xx，未知路由 404", async (context) => {
  const { req } = await harness(context);
  const bad = await req("POST", "/shipments", {
    shipmentId: "S-X", artifactId: "a", artifactName: "n",
    fragilityLevel: 9, vehicleType: "恒温气垫车", seals: ["S1"], actor: A_WANG,
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "invalid_fragility");

  const missing = await req("GET", "/shipments/NOPE");
  assert.equal(missing.status, 404);

  const notRoute = await req("GET", "/nonsense");
  assert.equal(notRoute.status, 404);
});
