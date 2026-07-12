import { safeNumber } from './calculations.js';
import { DEFAULT_REPORT_TIMEZONE, formatReportTime } from './timezone.js';

export function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') return Object.values(value).filter(Boolean);
  return [];
}

export function text(value) {
  return String(value ?? '').trim();
}

export function normalizeKey(value) {
  return text(value).toLowerCase();
}

export function groupBy(items = [], getKey = (item) => item?.id || '') {
  return toArray(items).reduce((groups, item) => {
    const key = text(typeof getKey === 'function' ? getKey(item) : item?.[getKey]) || 'uncategorised';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    return groups;
  }, new Map());
}

export function indexBy(items = [], getKey = (item) => item?.id || '') {
  return toArray(items).reduce((index, item) => {
    const key = text(typeof getKey === 'function' ? getKey(item) : item?.[getKey]);
    if (key && !index.has(key)) index.set(key, item);
    return index;
  }, new Map());
}

export function sumBy(items = [], getValue = (item) => item) {
  return toArray(items).reduce((sum, item) => {
    const value = typeof getValue === 'function' ? getValue(item) : item?.[getValue];
    return sum + safeNumber(value);
  }, 0);
}

export function sortByText(items = [], getValue = (item) => item?.name || '') {
  return [...toArray(items)].sort((left, right) => text(getValue(left)).localeCompare(text(getValue(right))));
}

export function sortByDateDesc(items = [], getValue = (item) => item?.timestamp || item?.date || '') {
  return [...toArray(items)].sort((left, right) => text(getValue(right)).localeCompare(text(getValue(left))));
}

export function sortRows(rows = [], sort = {}) {
  const key = text(sort.key);
  if (!key) return toArray(rows);
  const direction = normalizeKey(sort.direction) === 'desc' ? 'desc' : 'asc';
  return [...toArray(rows)].sort((left, right) => {
    const leftValue = left?.[key];
    const rightValue = right?.[key];
    const leftNumber = Number(leftValue);
    const rightNumber = Number(rightValue);
    const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
    const comparison = bothNumeric
      ? leftNumber - rightNumber
      : text(leftValue).localeCompare(text(rightValue), undefined, { numeric: true, sensitivity: 'base' });
    return direction === 'desc' ? comparison * -1 : comparison;
  });
}

export function summarizeBy(items = [], keySelector, metrics = {}) {
  const grouped = groupBy(items, keySelector);
  return Array.from(grouped.entries()).map(([key, rows]) => {
    const summary = { key, rows, count: rows.length };
    Object.entries(metrics).forEach(([metricKey, selector]) => {
      summary[metricKey] = sumBy(rows, selector);
    });
    return summary;
  });
}

export function getRowDate(row = {}) {
  return text(row.date || row.timestamp || row.createdAt).slice(0, 10);
}

export function getRowTime(row = {}) {
  const raw = text(row.time || row.timestamp || row.createdAt);
  const timeZone = text(
    row.reportingTimeZone
    || row.timeZone
    || row.timezone
    || row.__apiMeta?.timeZone
    || row.__apiMeta?.timezone
  ) || DEFAULT_REPORT_TIMEZONE;
  return formatReportTime(raw, timeZone);
}

export function applyReportFilters(rows = [], filters = {}) {
  const startDate = text(filters.startDate || filters.dateFrom);
  const endDate = text(filters.endDate || filters.dateTo);
  const time = text(filters.time).slice(0, 5);
  const locationId = text(filters.locationId);
  const category = normalizeKey(filters.category);
  const source = normalizeKey(filters.source);
  const search = normalizeKey(filters.search);

  return toArray(rows).filter((row) => {
    const rowDate = getRowDate(row);
    if (startDate && rowDate && rowDate < startDate) return false;
    if (endDate && rowDate && rowDate > endDate) return false;
    if (time && getRowTime(row) !== time) return false;
    if (locationId && ![row.locationId, row.fromLocationId, row.toLocationId].map(text).includes(locationId)) return false;
    if (category && normalizeKey(row.category || row.itemCategory || row.stockCategory) !== category) return false;
    if (source && normalizeKey(row.source || row.sourceType) !== source) return false;
    if (search) {
      const haystack = normalizeKey([
        row.itemName,
        row.stockItemName,
        row.productName,
        row.category,
        row.locationName,
        row.fromLocationName,
        row.toLocationName,
        row.user,
        row.note,
        row.source,
        row.metric,
        row.mode
      ].filter(Boolean).join(' '));
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}
