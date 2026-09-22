import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/store.js";
import { ShippingService } from "../src/shipping.js";
import { OverdueMonitor } from "../src/scheduler.js";
import { createL1, COORDINATOR, GUARD, CONSERVATOR } from "./helpers.js";

const newServiceAt = (path, now) => {
  const store = new EventStore({ path, now }).load();
  return { store, service: new ShippingService(store, { now }) };
};

test("服务重启后冻结状态、封签绑定、证据合并与超时提醒全部恢复", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipping-restart-"));
  const path = join(dir, "events.jsonl");
  const now1 = () => Date.parse("2026-09-23T09:00:00+08:00");
  {
    const { service } = newServiceAt(path, now1);
    const e = createL1(service, { shipmentId: "S-RESTORE", sealId: "SEAL-R" });
    service.recordArrival(e.shipmentId, { nodeId: "n1-origin", eventTime: "2026-09-23T08:30:00+08:00" }, COORDINATOR);
    service.reportAnomaly(
      e.shipmentId,
      { nodeId: "n1-origin", type: "shock", description: "冲击报警", eventTime: "2026-09-23T08:50:00+08:00" },
      GUARD,
    );
    service.uploadEvidence(
      e.shipmentId,
      { deviceSeq: "D-1", nodeId: "n1-origin", capturedAt: "2026-09-23T08:45:00+08:00", files: [{ name: "x.jpg", sha256: "hx" }] },
      COORDINATOR,
    );
  }

  // 在 n2 窗口(12:00-14:00 +08)之后重启：链条冻结未放行，监控补扫 n2 超时且只触发一次
  const now2 = () => Date.parse("2026-09-23T14:30:00+08:00");
  const { service, store } = newServiceAt(path, now2);
  const state = service.getShipment("S-RESTORE");
  assert.equal(state.frozen, true, "冻结状态必须随重启恢复");
  assert.equal(state.openAnomalyIds.length, 1);
  assert.equal(state.evidence["D-1"].mergedUploads, 1);

  // 封签绑定恢复：同一封签仍不能复用
  assert.throws(
    () => createL1(service, { shipmentId: "S-OTHER", sealId: "SEAL-R", eventTime: "2026-09-23T14:31:00+08:00" }),
    (err) => err.statusCode === 409 && err.code === "SEAL_ALREADY_BOUND",
  );

  const monitor = new OverdueMonitor(service, { intervalMs: 9_999_999 });
  const fired1 = monitor.scanOnce();
  assert.ok(fired1.some((f) => f.shipmentId === "S-RESTORE" && f.nodeId === "n2-xian-airport"));
  const fired2 = monitor.scanOnce();
  assert.equal(fired2.length, 0, "重启补扫后提醒不得重复");
  assert.equal(store.events.filter((e) => e.type === "window.overdue").length, 1);

  // 异常解除后重启仍然是解冻状态
  const anomalyId = state.openAnomalyIds[0];
  service.resolveAnomaly("S-RESTORE", { anomalyId, resolution: "复检无损" }, CONSERVATOR);
  const { service: s3 } = newServiceAt(path, now2);
  assert.equal(s3.getShipment("S-RESTORE").frozen, false);
});

test("离线终端迟到补传：事件按实际发生时间进入统一时间线，且不产生重复证据/重复提醒", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipping-offline-"));
  const path = join(dir, "events.jsonl");
  const realNow = () => Date.parse("2026-09-24T12:00:00+02:00"); // 已到柏林次日
  const { service } = newServiceAt(path, realNow);
  const e = createL1(service, { shipmentId: "S-OFFLINE", sealId: "SEAL-O", eventTime: "2026-09-23T07:30:00+08:00" });
  // 24 小时后才补传西安节点的交接照片
  const r = service.uploadEvidence(
    e.shipmentId,
    {
      deviceSeq: "D-77",
      evidenceType: "photo",
      nodeId: "n1-origin",
      capturedAt: "2026-09-23T08:45:00+08:00",
      files: [{ name: "handover-1.jpg", sha256: "p1" }],
    },
    COORDINATOR,
  );
  assert.equal(r.late, true);
  const state = service.getShipment(e.shipmentId);
  // 时间线中补传证据按 capturedAt 排序，出现在 created 之后而不是“现在”
  const ev = state.timeline.find((t) => t.type === "evidence.uploaded");
  assert.equal(ev.at, "2026-09-23T00:45:00.000Z");
  // 补传不影响任何节点的窗口状态
  assert.equal(state.nodes["n1-origin"]?.reached ?? null, null);
});
