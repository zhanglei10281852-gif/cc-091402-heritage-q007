// 组装事件存储、领域服务与超时监控。
// 数据落盘位置由环境变量配置（domain 约定），默认 .runtime/events.jsonl。

import { join } from "node:path";
import { EventStore } from "./store.js";
import { ShippingService } from "./shipping.js";
import { OverdueMonitor } from "./scheduler.js";
import { loadCatalog } from "./catalog.js";

export function buildRuntime({ eventLogPath, now, monitorIntervalMs = 30_000 } = {}) {
  loadCatalog(); // 提前失败：参考数据缺失/损坏时不启动
  const path = eventLogPath ?? process.env.EVENT_LOG_PATH ?? join(process.cwd(), ".runtime", "events.jsonl");
  const store = new EventStore({ path, now }).load();
  const service = new ShippingService(store, { now });
  const monitor = new OverdueMonitor(service, {
    intervalMs: monitorIntervalMs,
    onReminder: (event) => console.warn(`[超时提醒] 运输链 ${event.shipmentId} 节点 ${event.payload.nodeId} 已超过预约时间窗`),
  });
  return { store, service, monitor, path };
}
