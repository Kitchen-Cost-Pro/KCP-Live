import { text, toArray } from "../engine/grouping.js";

export function isTransactionIdColumn(column = {}) {
  return text(column.type).toLowerCase() === "transaction_id";
}

export function prioritizeTransactionColumns(columns = []) {
  const list = toArray(columns);
  const transactionColumns = list.filter(isTransactionIdColumn);
  if (!transactionColumns.length) return [...list];
  return [
    ...transactionColumns,
    ...list.filter((column) => !isTransactionIdColumn(column)),
  ];
}

export function getRequiredTransactionColumnKeys(columns = []) {
  return prioritizeTransactionColumns(columns)
    .filter(isTransactionIdColumn)
    .map((column) => text(column.key))
    .filter(Boolean);
}

export function normalizeVisibleReportColumns(
  columns = [],
  visibleColumns = null,
) {
  const orderedColumns = prioritizeTransactionColumns(columns);
  const validKeys = orderedColumns.map((column) => text(column.key)).filter(Boolean);
  const validKeySet = new Set(validKeys);
  const requiredKeys = getRequiredTransactionColumnKeys(orderedColumns);
  const requested = Array.isArray(visibleColumns)
    ? visibleColumns.map((key) => text(key)).filter((key) => validKeySet.has(key))
    : validKeys;
  const requestedSet = new Set(requested);
  return [
    ...requiredKeys,
    ...validKeys.filter(
      (key) => !requiredKeys.includes(key) && requestedSet.has(key),
    ),
  ];
}

export function prepareTransactionReportResult(result = {}) {
  const columns = prioritizeTransactionColumns(result.columns || []);
  return {
    ...result,
    columns,
  };
}
