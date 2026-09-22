// 统一事件时间：所有业务时间必须是带时区偏移的 ISO 8601 字符串，
// 比较与排序一律换算为毫秒纪元（UTC），节点展示可换算回当地时区。

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 校验并解析带时区的 ISO 8601 时间，返回纪元毫秒。
 * 拒绝无时区的“墙上时间”，避免跨时区节点排序歧义。
 */
export function parseEventTime(value, fieldName = "eventTime") {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value)) {
    throw Object.assign(new Error(`${fieldName} 必须是带时区偏移的 ISO 8601 字符串`), {
      code: "INVALID_TIME",
      statusCode: 400,
    });
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw Object.assign(new Error(`${fieldName} 无法解析`), { code: "INVALID_TIME", statusCode: 400 });
  }
  return ms;
}

/** 纪元毫秒 -> 带偏移 ISO 字符串（用于对外输出）。 */
export function toIso(ms) {
  return new Date(ms).toISOString();
}

/** 比较两个事件时间字符串（按绝对时刻）。 */
export function compareEventTime(a, b) {
  return parseEventTime(a) - parseEventTime(b);
}

/** 在指定 IANA 时区把纪元毫秒格式化为当地墙上时间，仅用于展示。 */
export function formatInTimezone(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}
