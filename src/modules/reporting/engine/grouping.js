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

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOOSE_ISO_DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DIGITS_ONLY_PATTERN = /^\d+$/;

// Date-range filtering compares ISO `YYYY-MM-DD` strings, so a row's raw date value is normalized
// to that shape first. Date instances, epoch milliseconds and other parseable shapes are real
// dates and must keep filtering correctly; only a value that cannot be normalized at all (missing,
// blank, or unparseable) returns '' and counts as unresolvable.
export function normalizeComparableDate(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (value instanceof Date) return fromTimestamp(value.getTime());
  if (typeof value === 'number') return Number.isFinite(value) ? fromTimestamp(value) : '';
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';
  // An ISO date or datetime is taken verbatim so no timezone shift is introduced.
  const isoPrefix = raw.slice(0, 10);
  if (ISO_DATE_PATTERN.test(isoPrefix)) return isoPrefix;
  const loose = LOOSE_ISO_DATE_PATTERN.exec(raw);
  if (loose) return `${loose[1]}-${loose[2].padStart(2, '0')}-${loose[3].padStart(2, '0')}`;
  if (DIGITS_ONLY_PATTERN.test(raw)) return fromTimestamp(Number(raw));
  // A free-text date string (e.g. "July 5, 2026") is parsed by Date.parse/`new Date(...)` as LOCAL
  // midnight per the JS spec, unlike an ISO string. Converting that through fromTimestamp's UTC
  // toISOString() shifts the calendar day whenever the local timezone is ahead of UTC (e.g. SAST,
  // UTC+2) — reading the parsed date back with local getters round-trips to the same day instead.
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : fromLocalDateParts(parsed);
}

function fromLocalDateParts(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isResolvableRowDate(value) {
  return Boolean(normalizeComparableDate(value));
}

// Mirrors getRowDate's `date || timestamp || createdAt` precedence, but keeps looking when a
// candidate is blank or unusable, and returns '' only when none of them resolves.
export function getComparableRowDate(row = {}) {
  for (const candidate of [row.date, row.timestamp, row.createdAt]) {
    const normalized = normalizeComparableDate(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function fromTimestamp(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '';
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export function applyReportFilters(rows = [], filters = {}) {
  const startDate = text(filters.startDate || filters.dateFrom);
  const endDate = text(filters.endDate || filters.dateTo);
  const hasDateRange = Boolean(startDate || endDate);
  const time = text(filters.time).slice(0, 5);
  const locationId = text(filters.locationId);
  const category = normalizeKey(filters.category);
  const source = normalizeKey(filters.source);
  const search = normalizeKey(filters.search);

  return toArray(rows).filter((row) => {
    // Normalize the raw value (not the sliced string) so a Date instance, epoch milliseconds or an
    // unpadded `YYYY-M-D` still compares correctly instead of being dropped as unresolvable.
    const rowDate = hasDateRange ? getComparableRowDate(row) : getRowDate(row);
    // A row whose date cannot be resolved must not silently survive a date-scoped report: when a
    // range filter is active it is excluded rather than kept, so out-of-period or undated rows can
    // never inflate a period's totals. (There is no warnings channel on this helper, so the
    // exclusion is silent by design.)
    if (hasDateRange && !rowDate) return false;
    if (startDate && rowDate < startDate) return false;
    if (endDate && rowDate > endDate) return false;
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
