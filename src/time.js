// 统一时间处理：所有排序、时间窗判定都先归一化为 UTC epoch 毫秒。
// 入参必须是带时区偏移的 ISO 8601 字符串，避免把“无时区本地时间”当成结构化时间。

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function requireZonedIso(value, field = "occurredAt") {
  if (typeof value !== "string" || !ISO_WITH_ZONE.test(value)) {
    const err = new Error(`${field} 必须是带时区的 ISO 8601 字符串`);
    err.code = "invalid_time";
    throw err;
  }
  const epoch = Date.parse(value);
  if (Number.isNaN(epoch)) {
    const err = new Error(`${field} 无法解析`);
    err.code = "invalid_time";
    throw err;
  }
  return epoch;
}

export function toIsoUtc(epoch) {
  return new Date(epoch).toISOString();
}

// 早于窗口 / 落在窗口内 / 晚于窗口；窗口只在交接首次记录时判定一次。
export function classifyWindow(epoch, startEpoch, endEpoch) {
  if (epoch < startEpoch) return "early";
  if (epoch > endEpoch) return "late";
  return "on_time";
}

export function formatInZone(epoch, timeZone) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    hour12: false,
  }).format(new Date(epoch));
}

export function windowLabel(state) {
  return { early: "早于窗口", on_time: "窗口内", late: "超出窗口" }[state] ?? state;
}
