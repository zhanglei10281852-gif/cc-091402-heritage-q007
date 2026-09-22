import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/store.js";
import { ShippingService } from "../src/shipping.js";

export function makeService(now = () => Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), "shipping-"));
  const store = new EventStore({ path: join(dir, "events.jsonl"), now }).load();
  const service = new ShippingService(store, { now });
  return { service, store, dir };
}

export const COORDINATOR = { id: "u-zhang", name: "张协调", role: "运输协调员" };
export const CONSERVATOR = { id: "u-li", name: "李保护", role: "保护人员" };
export const GUARD = { id: "u-wang", name: "王押运", role: "押运员" };

export function createL1(service, overrides = {}) {
  return service.createShipment(
    {
      shipmentId: "S-001",
      artifactId: "artifact-0001",
      artifactName: "唐代三彩腾空马",
      fragilityLevel: "L1",
      routeId: "xian-to-berlin-2026-09",
      sealId: "SEAL-XA-88001",
      vehicleId: "SN-XA-001",
      eventTime: "2026-09-23T07:30:00+08:00",
      ...overrides,
    },
    COORDINATOR,
  );
}
