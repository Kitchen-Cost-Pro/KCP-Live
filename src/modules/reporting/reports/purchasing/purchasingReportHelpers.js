import { roundMoney, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';

export const QTY_TOLERANCE = 0.0001;
export const VALUE_TOLERANCE = 0.01;

export function normalizePayload(payload = {}) {
  return {
    rows: toArray(payload.rows),
    warnings: toArray(payload.warnings),
    meta: payload.meta || {}
  };
}

export function rememberPayload(services = {}, key = '', payload = {}) {
  if (!services.reporting || !key) return;
  services.reporting[key] = normalizePayload(payload);
}

export function apiRows(payload = {}, normalizer = (row) => row) {
  const normalized = normalizePayload(payload);
  return normalized.rows.map((row, index) => ({
    ...normalizer(row, index, normalized.meta),
    __apiWarnings: normalized.warnings,
    __apiMeta: normalized.meta
  }));
}

export function groupRows(rows = [], selector) {
  return groupBy(rows, selector);
}

export function money(value) {
  return roundMoney(safeNumber(value));
}

export function quantity(value) {
  return safeNumber(value);
}

export function sumMoney(rows = [], selector) {
  return money(sumBy(rows, selector));
}

export function uniqueCount(rows = [], selector) {
  return new Set(toArray(rows).map((row) => text(typeof selector === 'function' ? selector(row) : row?.[selector])).filter(Boolean)).size;
}

export function uniqueValues(rows = [], selector) {
  return [...new Set(toArray(rows).map((row) => text(typeof selector === 'function' ? selector(row) : row?.[selector])).filter(Boolean))];
}

export function latestText(rows = [], selector) {
  return uniqueValues(rows, selector).sort().at(-1) || '';
}

export function firstText(rows = [], selector, fallback = '') {
  for (const row of toArray(rows)) {
    const value = text(typeof selector === 'function' ? selector(row) : row?.[selector]);
    if (value) return value;
  }
  return fallback;
}

export function firstNumber(rows = [], selector, fallback = 0) {
  for (const row of toArray(rows)) {
    const raw = typeof selector === 'function' ? selector(row) : row?.[selector];
    if (raw !== undefined && raw !== null && text(raw) !== '') return safeNumber(raw, fallback);
  }
  return fallback;
}

export function topText(rows = [], selector, fallback = '') {
  const counts = new Map();
  toArray(rows).forEach((row) => {
    const value = text(typeof selector === 'function' ? selector(row) : row?.[selector]);
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || fallback;
}

export function countWarning(rows = [], warnings = [], code = '', level = 'warning', message = '', predicate = () => false) {
  const affected = toArray(rows).filter((row) => {
    try { return Boolean(predicate(row)); } catch { return false; }
  });
  if (!affected.length) return;
  warnings.push({ code, level, message: `${affected.length} ${message}` });
}

export function titleStatus(value = '') {
  const normalized = text(value).toLowerCase().replace(/[\s-]+/g, '_');
  const known = {
    draft: 'Draft', pending: 'Pending', sent: 'Pending', submitted: 'Pending', approved: 'Approved',
    partially_received: 'Partially Received', partial: 'Partially Received', received: 'Received', complete: 'Received',
    completed: 'Received', cancelled: 'Cancelled', canceled: 'Cancelled', committed: 'Committed', posted: 'Committed'
  };
  return known[normalized] || normalized.split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ') || 'Unknown';
}

export function mapColumns(columns = []) {
  return Object.fromEntries(columns.map((column) => [column.key, column.label]));
}
