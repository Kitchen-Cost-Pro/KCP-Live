import { zonedTradingDateTimeStrings } from "../engine/timezone.js";

export const REPORT_DATE_RANGE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last_2_days', label: 'Last 2 Days' },
  { value: 'this_week', label: 'This Week' },
  { value: 'last_7_days', label: 'Last 1 Week' },
  { value: 'last_14_days', label: 'Last 2 Weeks' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_30_days', label: 'Last 1 Month' },
  { value: 'last_week', label: 'Previous Week' },
  { value: 'last_month', label: 'Previous Month' },
  { value: 'custom', label: 'Custom Range' }
];

export function normalizeDateRangeType(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return REPORT_DATE_RANGE_PRESETS.some((preset) => preset.value === normalized) ? normalized : 'today';
}

export function resolveDateRangePreset(
  type = 'today',
  { now = new Date(), timeZone = 'Africa/Johannesburg', tradingDayStartMinutes = 0 } = {},
) {
  const normalized = normalizeDateRangeType(type);
  if (normalized === 'custom') return { startDate: '', endDate: '', dateRangeType: 'custom' };

  const tradingDate = zonedTradingDateTimeStrings(now, timeZone, tradingDayStartMinutes).date;
  const match = tradingDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const local = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start = new Date(local);
  let end = new Date(local);

  if (normalized === 'yesterday') {
    start.setDate(start.getDate() - 1);
    end = new Date(start);
  } else if (normalized === 'last_2_days') {
    start.setDate(start.getDate() - 1);
  } else if (normalized === 'this_week') {
    start = startOfWeek(local);
    end = new Date(local);
  } else if (normalized === 'last_week') {
    end = startOfWeek(local);
    end.setDate(end.getDate() - 1);
    start = new Date(end);
    start.setDate(start.getDate() - 6);
  } else if (normalized === 'this_month') {
    start = new Date(local.getFullYear(), local.getMonth(), 1);
    end = new Date(local);
  } else if (normalized === 'last_month') {
    start = new Date(local.getFullYear(), local.getMonth() - 1, 1);
    end = new Date(local.getFullYear(), local.getMonth(), 0);
  } else if (normalized === 'last_7_days') {
    start.setDate(start.getDate() - 6);
  } else if (normalized === 'last_14_days') {
    start.setDate(start.getDate() - 13);
  } else if (normalized === 'last_30_days') {
    start.setDate(start.getDate() - 29);
  }

  return {
    dateRangeType: normalized,
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(end)
  };
}

export function applyDateRangePreset(
  filters = {},
  { now = new Date(), timeZone = 'Africa/Johannesburg', tradingDayStartMinutes = 0 } = {},
) {
  // Threaded explicitly: this helper's semantics predate the unbounded-vs-bounded distinction and
  // must keep resolving a range-less filters object to 'today', exactly as it always did.
  const type = normalizeDateRangeType(filters.dateRangeType || inferDateRangeType(filters, { fallback: 'today' }));
  if (type === 'custom') return { ...filters, dateRangeType: 'custom' };
  const range = resolveDateRangePreset(type, { now, timeZone, tradingDayStartMinutes });
  return {
    ...filters,
    dateRangeType: type,
    startDate: range.startDate,
    endDate: range.endDate,
    from: range.startDate,
    to: range.endDate
  };
}

const DATE_RANGE_CONTEXT_KEYS = ['dateRangeType', 'date_range_type', 'startDate', 'endDate', 'from', 'to', 'dateFrom', 'dateTo'];

/**
 * Does this filters object come from a report/schedule that does date filtering at all?
 * A report with no date-range filter enabled carries none of these keys, and its correct
 * range is the unbounded blank 'custom' one (see resolveScheduledRelativeRange), never 'today'.
 */
export function hasDateRangeContext(filters = {}) {
  const source = filters && typeof filters === 'object' ? filters : {};
  return DATE_RANGE_CONTEXT_KEYS.some((key) => key in source);
}

export function inferDateRangeType(filters = {}, { fallback = '' } = {}) {
  const explicit = String(filters.dateRangeType || filters.date_range_type || '').trim();
  if (explicit) return explicit;
  // Explicit dates with no stored range type are a custom range. Defaulting to 'today' here made the
  // filter bar render "Today" with the custom-date row hidden while those real dates stayed in the
  // hidden fields — so the dates shown never matched the dates queried.
  const startDate = String(filters.startDate || filters.from || filters.dateFrom || '').trim();
  const endDate = String(filters.endDate || filters.to || filters.dateTo || '').trim();
  if (startDate || endDate) return 'custom';
  if (fallback) return fallback;
  // No dates at all: 'today' only for something that actually does date filtering (the user simply
  // has not chosen a range yet). A date-less report must stay unbounded, so it keeps blank 'custom'
  // — defaulting it to 'today' silently turned an all-time saved view into a one-day one.
  return hasDateRangeContext(filters) ? 'today' : 'custom';
}

function startOfWeek(date) {
  const result = new Date(date);
  const day = result.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + delta);
  return result;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
