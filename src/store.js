// 只追加事件日志：每个运输链一个 JSONL 文件，事件带 SHA-256 哈希链。
// 业务状态只能由重放事件得到；不提供任何“修改/删除旧事件”的接口，
// 因此异常冻结不可能通过改写旧记录解除，只能追加新的处置事件。

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";

export function shipmentFilePath(dataDir, shipmentId) {
  if (!/^[A-Za-z0-9_-]+$/.test(shipmentId)) {
    const err = new Error("运输链编号只能包含字母、数字、下划线、连字符");
    err.code = "invalid_shipment_id";
    throw err;
  }
  return join(dataDir, `shipment-${shipmentId}.log`);
}

function canonicalHash(envelope) {
  const { hash, ...body } = envelope;
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export class EventStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
  }

  listShipmentIds() {
    return readdirSync(this.dataDir)
      .filter((name) => name.startsWith("shipment-") && name.endsWith(".log"))
      .map((name) => name.slice("shipment-".length, -".log".length));
  }

  load(shipmentId) {
    const file = shipmentFilePath(this.dataDir, shipmentId);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    let prevHash = "0".repeat(64);
    const events = [];
    for (const [index, line] of lines.entries()) {
      const event = JSON.parse(line);
      if (event.prevHash !== prevHash) {
        const err = new Error(`${shipmentId} 第 ${index + 1} 行哈希链断裂：事件被改动或缺失`);
        err.code = "chain_broken";
        throw err;
      }
      if (canonicalHash(event) !== event.hash) {
        const err = new Error(`${shipmentId} 第 ${index + 1} 行事件内容与哈希不符`);
        err.code = "chain_broken";
        throw err;
      }
      prevHash = event.hash;
      events.push(event);
    }
    return events;
  }

  // 追加时由领域层给出下一条业务事件；seq/prevHash/hash/recordedAt 在此封死。
  append(shipmentId, { type, actor, payload, recordedAt, eventId = randomUUID() }) {
    const events = this.load(shipmentId);
    const seq = events.length;
    const prevHash = events.length === 0 ? "0".repeat(64) : events[events.length - 1].hash;
    const envelope = {
      eventId,
      shipmentId,
      seq,
      type,
      actor,
      recordedAt: recordedAt ?? new Date().toISOString(),
      payload,
      prevHash,
    };
    envelope.hash = canonicalHash(envelope);
    appendFileSync(shipmentFilePath(this.dataDir, shipmentId), JSON.stringify(envelope) + "\n");
    return envelope;
  }
}
