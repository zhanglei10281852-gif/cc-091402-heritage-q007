// 预约时间窗超时监控。
// 提醒本身是只追加事件（window.overdue，确定性 eventId），
// 所以重启后已发提醒不会重复；启动时立即扫描一次，把停机期间错过的时间窗补齐。

import { getRoute } from "./catalog.js";
import { parseEventTime } from "./time.js";

export class OverdueMonitor {
  #service;
  #intervalMs;
  #timer = null;
  #onReminder;

  constructor(service, { intervalMs = 30_000, onReminder = null } = {}) {
    this.#service = service;
    this.#intervalMs = intervalMs;
    this.#onReminder = onReminder;
  }

  start() {
    // 启动先扫一遍：恢复停机期间到期的窗口。
    setImmediate(() => this.scanOnce());
    this.#timer = setInterval(() => this.scanOnce(), this.#intervalMs);
    this.#timer.unref?.();
    return this;
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 扫描全部在途运输链，对超过窗口结束时间仍未到达的节点登记提醒。 */
  scanOnce() {
    const fired = [];
    for (const state of this.#service.listShipments()) {
      if (state.status === "delivered") continue;
      const route = getRoute(state.routeId);
      for (const node of route.nodes) {
        const ns = state.nodes[node.nodeId];
        if (ns?.reached) continue;
        if (this.#service.now < parseEventTime(node.windowEnd)) continue;
        const result = this.#service.markOverdue(state.shipmentId, node.nodeId);
        if (result.event) {
          fired.push({ shipmentId: state.shipmentId, nodeId: node.nodeId, event: result.event });
          this.#onReminder?.(result.event);
        }
      }
    }
    return fired;
  }
}
