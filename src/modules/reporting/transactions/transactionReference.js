const PREFIXES = Object.freeze({
  grv: "GRV",
  credit_note: "CN",
  manufacturing_batch: "MFG",
  transfer: "TRF",
  stock_take: "STK",
  adjustment: "ADJ",
});

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeDate(value, { fallbackToNow = true } = {}) {
  const parsed = value ? new Date(value) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  return fallbackToNow ? new Date() : null;
}

export function transactionDateKey(
  value,
  timeZone = "Africa/Johannesburg",
) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(normalizeDate(value));
  const part = (type) =>
    parts.find((entry) => entry.type === type)?.value || "00";
  return `${part("year")}${part("month")}${part("day")}`;
}

export function transactionPrefix(entityType) {
  const prefix = PREFIXES[clean(entityType)];
  if (!prefix) throw new Error(`Unsupported transaction type: ${entityType}`);
  return prefix;
}

export function formatTransactionReference(entityType, dateKey, sequence) {
  return `${transactionPrefix(entityType)}-${clean(dateKey)}-${Math.max(0, Math.trunc(Number(sequence) || 0)).toString().padStart(4, "0")}`;
}

function shortStableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(6, "0").slice(-6);
}

export function historicalTransactionReference(
  entityType,
  entityId,
  occurredAt,
) {
  const id = clean(entityId) || "unknown";
  const parsed = normalizeDate(occurredAt, { fallbackToNow: false });
  const dateKey = parsed ? transactionDateKey(parsed) : "000000";
  return `${transactionPrefix(entityType)}-${dateKey}-H${shortStableHash(`${entityType}:${id}`)}`;
}

export function isTransactionReference(value, entityType = "") {
  const prefix = entityType
    ? transactionPrefix(entityType)
    : "(?:GRV|CN|MFG|TRF|STK|ADJ)";
  return new RegExp(`^${prefix}-\\d{6}-(?:\\d{4,}|H[A-Z0-9]{6})$`, "i").test(
    clean(value),
  );
}
