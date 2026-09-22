// 包装规范 / 车辆能力 / 路线时间窗目录。
// 数据来自 reference/shipping-data.json，内存只读加载。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.SHIPPING_DATA_PATH ?? join(here, "..", "reference", "shipping-data.json");

let data;
let loadedPath;
export function loadCatalog(path = DATA_PATH) {
  if (data && loadedPath === path) return data;
  data = JSON.parse(readFileSync(path, "utf8"));
  loadedPath = path;
  return data;
}
function catalog() {
  if (!data) loadCatalog();
  return data;
}

/** 角色是否具备换车/拆箱双人确认资格。 */
export function isAuthorizedDualRole(role) {
  return catalog().authorizedDualRoles.includes(role);
}

/** 取脆弱等级规范；未知等级抛 400。 */
export function getFragilitySpec(level) {
  const spec = catalog().fragilityLevels[level];
  if (!spec) {
    throw Object.assign(new Error(`未知脆弱等级: ${level}，可选 ${Object.keys(catalog().fragilityLevels).join("/")}`), {
      code: "UNKNOWN_FRAGILITY",
      statusCode: 400,
    });
  }
  return spec;
}

/** 按脆弱等级生成包装检查项模板（每项待确认，未默认通过）。 */
export function buildChecklist(level) {
  return getFragilitySpec(level).checklist.map((item) => ({
    ...item,
    required: true,
    status: "pending",
  }));
}

export function getVehicle(vehicleId) {
  const vehicle = catalog().vehicles.find((v) => v.vehicleId === vehicleId);
  if (!vehicle) {
    throw Object.assign(new Error(`未知车辆/舱位: ${vehicleId}`), { code: "UNKNOWN_VEHICLE", statusCode: 400 });
  }
  return vehicle;
}

/** 能力蕴含：拥有某能力即视为同时拥有其蕴含项（恒温恒湿车自然具备恒温能力）。 */
const CAPABILITY_IMPLIES = { 恒温恒湿: ["恒温"] };

export function effectiveCapabilities(vehicle) {
  const set = new Set(vehicle.capabilities);
  for (const cap of [...set]) {
    for (const implied of CAPABILITY_IMPLIES[cap] ?? []) set.add(implied);
  }
  return [...set];
}

/**
 * 车辆能力校验：车辆必须具备脆弱等级要求的全部能力；
 * 有温控要求时车辆温控范围必须覆盖器物限值。
 * 返回 { ok, missing } 。
 */
export function checkVehicleCapability(level, vehicleId) {
  const spec = getFragilitySpec(level);
  const vehicle = getVehicle(vehicleId);
  const caps = effectiveCapabilities(vehicle);
  const missing = spec.requiredCapabilities.filter((cap) => !caps.includes(cap));
  const temp = checkTemperatureCoverage(spec, vehicle);
  if (!temp.ok) missing.push(temp.reason);
  return { ok: missing.length === 0, missing, vehicle };
}

function checkTemperatureCoverage(spec, vehicle) {
  const need = spec.temperatureRangeC;
  if (!need || !vehicle.temperatureRangeC) return { ok: true };
  const cover = vehicle.temperatureRangeC;
  if (cover.min <= need.min && cover.max >= need.max) return { ok: true };
  return { ok: false, reason: `温控范围不覆盖（车辆 ${cover.min}~${cover.max}℃，器物要求 ${need.min}~${need.max}℃）` };
}

export function getRoute(routeId) {
  const route = catalog().routes.find((r) => r.routeId === routeId);
  if (!route) {
    throw Object.assign(new Error(`未知路线: ${routeId}`), { code: "UNKNOWN_ROUTE", statusCode: 400 });
  }
  return route;
}

export function getRouteNode(routeId, nodeId) {
  const node = getRoute(routeId).nodes.find((n) => n.nodeId === nodeId);
  if (!node) {
    throw Object.assign(new Error(`路线 ${routeId} 上不存在节点 ${nodeId}`), {
      code: "UNKNOWN_NODE",
      statusCode: 400,
    });
  }
  return node;
}
