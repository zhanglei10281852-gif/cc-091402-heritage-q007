// HTTP 适配层：只做参数解析与错误码映射，业务规则全部在领域引擎。
// 写操作的身份由请求体 actor 携带（id 不可变、role 决定权限）。

import { createServer } from "node:http";
import { DomainError } from "./domain.js";
import { formatInZone, windowLabel } from "./time.js";

const STATUS_BY_CODE = {
  invalid_time: 400,
  invalid_shipment_id: 400,
  invalid_fragility: 400,
  invalid_vehicle: 400,
  invalid_route: 400,
  invalid_window: 400,
  invalid_seal: 400,
  invalid_actor: 400,
  invalid_artifact: 400,
  invalid_node: 400,
  invalid_checks: 400,
  invalid_reading: 400,
  invalid_photo: 400,
  invalid_signature: 400,
  invalid_location: 400,
  invalid_form: 400,
  invalid_anomaly: 400,
  invalid_resolution: 400,
  invalid_reason: 400,
  invalid_device: 400,
  invalid_evidence: 400,
  forbidden: 403,
  not_found: 404,
  already_exists: 409,
  handoff_exists: 409,
  already_released: 409,
  anomaly_closed: 409,
  seal_exists: 409,
  shipment_completed: 409,
  no_handoff: 409,
  node_locked: 409,
  no_active_seal: 409,
  seal_already_circulating: 409,
  shipment_frozen: 423,
  evidence_outstanding: 423,
  vehicle_capability_exceeded: 422,
  dual_confirmation_required: 422,
  chain_broken: 500,
};

function decorateNode(node) {
  return {
    ...node,
    windowClassLabel: node.windowClass ? windowLabel(node.windowClass) : null,
    windowLocal: `${formatInZone(Date.parse(node.windowStart), node.timezone)} 至 ${formatInZone(Date.parse(node.windowEnd), node.timezone)}`,
  };
}

export function createApiServer(engine, catalog) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };

    try {
      // ---------- 基础与参考数据 ----------
      if (request.method === "GET" && path === "/health") {
        return send(200, { status: "ok", service: "heritage-service-starter" });
      }
      if (request.method === "GET" && path === "/catalog") {
        return send(200, {
          fragilityRules: catalog.fragilityRules,
          vehicleCapabilities: catalog.vehicleCapabilities,
          routeTemplates: catalog.routeTemplates,
          handoffForm: catalog.handoffForm,
        });
      }
      if (request.method === "GET" && path === "/catalog/packing-checks") {
        const level = url.searchParams.get("fragilityLevel");
        const rule = catalog.fragilityRules[String(level)];
        if (!rule) return send(404, { error: "not_found", message: `未知脆弱等级 ${level}` });
        return send(200, rule);
      }

      // ---------- 运输链 ----------
      if (request.method === "POST" && path === "/shipments") {
        const body = await readJson(request);
        const projection = engine.createShipment(body);
        return send(201, { shipment: projection });
      }
      if (request.method === "GET" && path === "/shipments") {
        return send(200, { shipments: engine.listShipments() });
      }

      const shipmentMatch = path.match(/^\/shipments\/([A-Za-z0-9_-]+)(\/.+)?$/);
      if (request.method === "GET" && shipmentMatch && !shipmentMatch[2]) {
        const shipment = engine.getShipment(shipmentMatch[1]);
        shipment.nodes = shipment.nodes.map(decorateNode);
        return send(200, { shipment });
      }
      if (request.method === "GET" && shipmentMatch && shipmentMatch[2] === "/timeline") {
        return send(200, { timeline: engine.getTimeline(shipmentMatch[1]) });
      }

      const nodeMatch = path.match(/^\/shipments\/([A-Za-z0-9_-]+)\/nodes\/(\d+)$/);
      if (request.method === "GET" && nodeMatch) {
        const shipment = engine.getShipment(nodeMatch[1]);
        const node = shipment.nodes.find((n) => n.seq === Number(nodeMatch[2]));
        if (!node) return send(404, { error: "not_found", message: "节点不存在" });
        return send(200, {
          shipment: {
            shipmentId: shipment.shipmentId,
            artifactId: shipment.artifactId,
            artifactName: shipment.artifactName,
            fragilityLevel: shipment.fragilityLevel,
            frozen: shipment.frozen,
            vehicleType: shipment.vehicleType,
          },
          node: decorateNode(node),
        });
      }

      // ---------- 写操作 ----------
      const routes = [
        ["/handoffs", "recordHandoff"],
        ["/releases", "releaseNode"],
        ["/evidence", "supplementEvidence"],
        ["/anomalies", "openAnomaly"],
        ["/anomalies/resolve", "resolveAnomaly"],
        ["/vehicle-change", "changeVehicle"],
        ["/crate-open", "openCrate"],
        ["/seals", "bindSeal"],
      ];
      if (request.method === "POST" && shipmentMatch) {
        const route = routes.find(([suffix]) => shipmentMatch[2] === suffix);
        if (route) {
          const body = await readJson(request);
          const result = engine[route[1]]({ ...body, shipmentId: shipmentMatch[1] });
          return send(201, result);
        }
      }

      // ---------- 封签查询与管理扫描 ----------
      const sealMatch = path.match(/^\/seals\/(.+)$/);
      if (request.method === "GET" && sealMatch) {
        return send(200, { seal: engine.getSeal(decodeURIComponent(sealMatch[1])) });
      }
      if (request.method === "POST" && path === "/admin/scan-overdue") {
        return send(200, { marked: engine.scanOverdue() });
      }

      return send(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DomainError) {
        const status = STATUS_BY_CODE[error.code] ?? 400;
        return send(status, { error: error.code, message: error.message, details: error.details });
      }
      if (error instanceof SyntaxError) {
        return send(400, { error: "invalid_json", message: "请求体不是合法 JSON" });
      }
      console.error(error);
      return send(500, { error: "internal_error", message: error.message });
    }
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        const err = new Error("请求体过大");
        err.code = "payload_too_large";
        reject(err);
        request.destroy();
      }
    });
    request.on("end", () => {
      if (raw === "") return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    request.on("error", reject);
  });
}
