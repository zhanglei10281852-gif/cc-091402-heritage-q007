// 运输交接服务 HTTP 入口。纯路由/序列化，业务规则全部在 shipping.js。

import { createServer } from "node:http";
import { ShippingError, actorFromRequest } from "./shipping.js";
import { loadCatalog, getFragilitySpec } from "./catalog.js";
import { renderHandoffSheet } from "./handoff-sheet.js";

const JSON_LIMIT = 2_000_000;

export function createApp({ service, monitor = null } = {}) {
  if (!service) throw new Error("createApp 需要注入 shipping service");

  const send = (response, statusCode, body) => {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  };

  const readJson = (request) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > JSON_LIMIT) {
          reject(new ShippingError(413, "PAYLOAD_TOO_LARGE", "请求体过大"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw === "") return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new ShippingError(400, "BAD_JSON", "请求体不是合法 JSON"));
        }
      });
      request.on("error", reject);
    });

  const handler = async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    const method = request.method;
    try {
      if (method === "GET" && path === "/health") {
        send(response, 200, { status: "ok", service: "heritage-shipping-service" });
        return;
      }

      // ---- 参考数据 ----
      if (method === "GET" && path === "/reference/fragility") {
        const level = url.searchParams.get("level");
        const data = loadCatalog();
        send(response, 200, level ? getFragilitySpec(level) : data.fragilityLevels);
        return;
      }
      if (method === "GET" && path === "/reference/vehicles") {
        send(response, 200, loadCatalog().vehicles);
        return;
      }
      if (method === "GET" && path === "/reference/routes") {
        send(response, 200, loadCatalog().routes);
        return;
      }

      // ---- 运输链命令/查询 ----
      const mShipment = path.match(/^\/shipments\/([^/]+)$/);
      const mSub = path.match(/^\/shipments\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);

      if (method === "POST" && path === "/shipments") {
        const body = await readJson(request);
        applyIdempotency(body, request);
        const result = service.createShipment(body, actorFromRequest(request.headers));
        send(response, 201, { event: result, shipmentId: result.shipmentId });
        return;
      }
      if (method === "GET" && path === "/shipments") {
        send(response, 200, { shipments: service.listShipments() });
        return;
      }

      if (mShipment && method === "GET") {
        const state = service.getShipment(mShipment[1]);
        if (!state) throw new ShippingError(404, "SHIPMENT_NOT_FOUND", "运输链不存在");
        send(response, 200, state);
        return;
      }

      if (mSub) {
        const [, shipmentId, resource, sub] = mSub;
        switch (`${method} ${resource}`) {
          case "POST arrivals": {
            const body = await readJson(request);
            applyIdempotency(body, request);
            send(response, 201, { event: service.recordArrival(shipmentId, body, actorFromRequest(request.headers)) });
            return;
          }
          case "POST handoffs": {
            const body = await readJson(request);
            applyIdempotency(body, request);
            send(response, 201, service.completeHandoff(shipmentId, body, actorFromRequest(request.headers)));
            return;
          }
          case "POST anomalies": {
            const body = await readJson(request);
            applyIdempotency(body, request);
            send(response, 201, service.reportAnomaly(shipmentId, body, actorFromRequest(request.headers)));
            return;
          }
          case "POST resolve-anomaly": {
            const body = await readJson(request);
            applyIdempotency(body, request);
            send(response, 200, service.resolveAnomaly(shipmentId, body, actorFromRequest(request.headers)));
            return;
          }
          case "POST vehicle-changes": {
            const body = await readJson(request);
            applyIdempotency(body, request);
            send(response, 201, { event: service.changeVehicle(shipmentId, body, actorFromRequest(request.headers)) });
            return;
          }
          case "POST crate-openings": {
            const body = await readJson(request);
            applyIdempotency(body, request);
            send(response, 201, { event: service.openCrate(shipmentId, body, actorFromRequest(request.headers)) });
            return;
          }
          case "POST evidence": {
            const body = await readJson(request);
            applyIdempotency(body, request);
            send(response, 201, service.uploadEvidence(shipmentId, body, actorFromRequest(request.headers)));
            return;
          }
          case "GET timeline": {
            const state = service.getShipment(shipmentId);
            if (!state) throw new ShippingError(404, "SHIPMENT_NOT_FOUND", "运输链不存在");
            send(response, 200, { shipmentId, timeline: state.timeline, frozen: state.frozen });
            return;
          }
          case "GET nodes": {
            if (!sub) throw new ShippingError(404, "NOT_FOUND", "请指定节点 /shipments/:id/nodes/:nodeId");
            const snapshot = service.nodeSnapshot(shipmentId, sub, url.searchParams.get("asOf"));
            send(response, 200, snapshot);
            return;
          }
          case "GET handoff-sheet": {
            if (!sub) throw new ShippingError(404, "NOT_FOUND", "请指定节点 /shipments/:id/handoff-sheet/:nodeId");
            const state = service.getShipment(shipmentId);
            if (!state) throw new ShippingError(404, "SHIPMENT_NOT_FOUND", "运输链不存在");
            const snapshot = service.nodeSnapshot(shipmentId, sub, url.searchParams.get("asOf"));
            send(response, 200, renderHandoffSheet(state, snapshot, loadCatalog().handoffTemplate));
            return;
          }
          default:
            break;
        }
      }

      if (method === "POST" && path === "/admin/scan-overdue") {
        if (!monitor) throw new ShippingError(404, "NOT_FOUND", "未启用超时监控");
        send(response, 200, { fired: monitor.scanOnce() });
        return;
      }

      throw new ShippingError(404, "NOT_FOUND", `未知路由: ${method} ${path}`);
    } catch (error) {
      if (error instanceof ShippingError || Number.isInteger(error.statusCode)) {
        send(response, error.statusCode, { error: error.code ?? "ERROR", message: error.message, details: error.details ?? undefined });
      } else {
        send(response, 500, { error: "INTERNAL", message: error.message });
      }
    }
  };

  return createServer(handler);
}

/** 支持离线终端重试：Idempotency-Key 作为事件幂等键。 */
function applyIdempotency(body, request) {
  if (!body.eventId && request.headers["idempotency-key"]) {
    body.eventId = String(request.headers["idempotency-key"]);
  }
}
