import { formatCell } from "../engine/formatters.js";
import { DEFAULT_REPORT_TIMEZONE, normalizeReportTimeZone } from "../engine/timezone.js";

export function transactionDetailTimeZone(detail = {}) {
  return normalizeReportTimeZone(
    detail.timeZone
      || detail.metadata?.reportingTimeZone
      || detail.metadata?.timeZone
      || DEFAULT_REPORT_TIMEZONE,
  );
}

export function formatTransactionDetailValue(value, type = "", timeZone = DEFAULT_REPORT_TIMEZONE) {
  return formatCell(value, { type, timeZone: normalizeReportTimeZone(timeZone) });
}

export function transactionDetailFileStem(detail = {}) {
  return String(detail.transactionReference || "transaction")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "transaction";
}

export function transactionDetailMetadataRows(detail = {}) {
  const metadata = detail.metadata && typeof detail.metadata === "object"
    ? detail.metadata
    : {};
  return Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({
      Field: String(key)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase()),
      Value: Array.isArray(value) ? value.join(", ") : String(value),
    }));
}

export function transactionDetailSummaryRows(detail = {}) {
  const timeZone = transactionDetailTimeZone(detail);
  const occurredAt = detail.occurredAt || detail.createdAt || "";
  return [
    { Field: "Transaction ID", Value: detail.transactionReference || "" },
    { Field: "Transaction Type", Value: detail.entityType || "" },
    { Field: "Status", Value: detail.status || "" },
    {
      Field: "Date and Time",
      Value: occurredAt
        ? formatTransactionDetailValue(occurredAt, "datetime", timeZone)
        : "",
    },
    { Field: "Reporting Time Zone", Value: timeZone },
    { Field: "Location", Value: (detail.locationNames || []).join(", ") },
    { Field: "Created By", Value: detail.createdByName || detail.createdBy || "" },
    { Field: "Committed By", Value: detail.committedBy || "" },
    ...(detail.summaryCards || []).map((card) => ({
      Field: card.label || card.key || "Summary",
      Value: formatTransactionDetailValue(card.value, card.type, timeZone),
    })),
    ...transactionDetailMetadataRows(detail)
      .filter((row) => row.Field !== "Reporting Time Zone"),
  ];
}

export function transactionDetailExportRows(rows = [], columns = [], detail = {}) {
  const timeZone = transactionDetailTimeZone(detail);
  const columnTypes = new Map(
    (columns || []).map((column) => [String(column?.key || ""), column?.type || ""]),
  );
  return (Array.isArray(rows) ? rows : []).map((row) => Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => {
      const type = columnTypes.get(key) || inferExportType(key, value);
      if (["date", "datetime", "time"].includes(type)) {
        return [key, formatTransactionDetailValue(value, type, timeZone)];
      }
      if (Array.isArray(value)) return [key, value.join(", ")];
      if (value && typeof value === "object") return [key, JSON.stringify(value)];
      return [key, value];
    }),
  ));
}

function inferExportType(key = "", value) {
  if (!value || typeof value !== "string") return "";
  const normalized = String(key).toLowerCase();
  if (normalized.endsWith("datetime") || normalized.endsWith("_datetime")) return "datetime";
  if (normalized.endsWith("at") || normalized.endsWith("_at") || normalized === "timestamp") return "datetime";
  if (normalized === "date" || normalized.endsWith("date") || normalized.endsWith("_date")) return "date";
  if (normalized === "time" || normalized.endsWith("time") || normalized.endsWith("_time")) return "time";
  return "";
}
