// 只追加事件日志（JSONL）。
// 业务记录不可修改：任何状态变化都只能追加新事件；
// 进程重启时从头重放即可恢复全部状态、冻结标记与超时提醒。

import { existsSync, readFileSync, openSync, closeSync, writeFileSync, fsyncSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class EventStore {
  #path;
  #now;
  #events = [];
  #eventIds = new Set();
  #listeners = [];

  constructor({ path, now = () => Date.now() } = {}) {
    if (!path) throw new Error("EventStore 需要 path");
    this.#path = path;
    this.#now = now;
  }

  /** 启动时加载并重放历史事件。 */
  load() {
    this.#events = [];
    this.#eventIds = new Set();
    if (!existsSync(this.#path)) return this;
    const raw = readFileSync(this.#path, "utf8");
    if (raw.trim() === "") return this;
    const lines = raw.split("\n");
    // 末段一律丢弃：文件以换行结尾时它是空串，否则说明最后一行在崩溃时未写完整。
    for (const line of lines.slice(0, -1)) {
      if (line.trim() === "") continue;
      const event = JSON.parse(line);
      if (this.#eventIds.has(event.eventId)) {
        throw new Error(`事件日志损坏：eventId 重复 ${event.eventId}`);
      }
      this.#eventIds.add(event.eventId);
      this.#events.push(event);
    }
    return this;
  }

  /**
   * 追加事件。幂等键为 eventId：同一事件重复提交返回既有事件，不产生第二条。
   * 写入后 fsync，确保重启后冻结/超时等状态不丢失。
   */
  append(input) {
    if (!input || typeof input !== "object") throw httpError(400, "事件必须是对象");
    if (!input.eventId) throw httpError(400, "缺少 eventId");
    if (this.#eventIds.has(input.eventId)) {
      return { event: this.#events.find((e) => e.eventId === input.eventId), duplicate: true };
    }
    const event = { ...input, seq: this.#events.length + 1, receivedAt: new Date(this.#now()).toISOString() };
    if (!existsSync(dirname(this.#path))) mkdirSync(dirname(this.#path), { recursive: true });
    const fd = openSync(this.#path, "a");
    try {
      writeFileSync(fd, JSON.stringify(event) + "\n");
      fsyncSync(fd); // 刷盘保证崩溃/重启后冻结等状态仍在
    } finally {
      closeSync(fd);
    }
    this.#events.push(event);
    this.#eventIds.add(event.eventId);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* 监听器异常不影响落盘 */
      }
    }
    return { event, duplicate: false };
  }

  /** 订阅实时追加的新事件（重启重放不会触发）。 */
  onEvent(listener) {
    this.#listeners.push(listener);
  }

  get events() {
    return this.#events;
  }

  byShipment(shipmentId) {
    return this.#events.filter((e) => e.shipmentId === shipmentId);
  }
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { code: "BAD_REQUEST", statusCode });
}
