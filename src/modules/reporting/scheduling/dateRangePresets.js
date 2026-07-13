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

export function resolveDateRangePreset(type = 'today', { now = new Date() } = {}) {
  const normalized = normalizeDateRangeType(type);
  if (normalized === 'custom') return { startDate: '', endDate: '', dateRangeType: 'custom' };

  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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

export function applyDateRangePreset(filters = {}, { now = new Date() } = {}) {
  const type = normalizeDateRangeType(filters.dateRangeType || inferDateRangeType(filters));
  if (type === 'custom') return { ...filters, dateRangeType: 'custom' };
  const range = resolveDateRangePreset(type, { now });
  return {
    ...filters,
    dateRangeType: type,
    startDate: range.startDate,
    endDate: range.endDate,
    from: range.startDate,
    to: range.endDate
  };
}

export function inferDateRangeType(filters = {}) {
  return filters.dateRangeType || filters.date_range_type || 'today';
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
