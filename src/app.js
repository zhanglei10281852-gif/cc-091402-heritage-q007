import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { EventStore } from "./store.js";
import { ShippingEngine } from "./domain.js";
import { createApiServer } from "./http.js";

const here = dirname(fileURLToPath(import.meta.url));

export function loadCatalog() {
  return JSON.parse(readFileSync(join(here, "..", "reference", "catalog.json"), "utf8"));
}

export function createApp(options = {}) {
  const catalog = options.catalog ?? loadCatalog();
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? join(here, "..", ".data");
  const store = new EventStore(dataDir);
  const engine = new ShippingEngine(store, catalog, { now: options.now });
  const server = createApiServer(engine, catalog);

  // 超时提醒落为事件：重启后立即重扫一次，冻结与提醒状态随重放恢复。
  engine.scanOverdue();
  const scanInterval = setInterval(() => engine.scanOverdue(), Number(process.env.SCAN_INTERVAL_MS ?? 60_000));
  scanInterval.unref?.();

  return server;
}
