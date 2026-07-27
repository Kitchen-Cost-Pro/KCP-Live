const RUNTIME_FILTER_KEYS = new Set([
  'limit',
  'offset',
  'page',
  'pageSize',
  'page_size',
  'cursor',
  'nextOffset',
  'next_offset',
  'generatedAt',
  'generated_at',
  'scheduleRunId',
  'schedule_run_id',
  'sourceFetchId',
  'source_fetch_id',
  'view',
  'download',
  'export',
  '_scheduleRun',
  '_sourceFetch'
]);

const DATE_FILTER_KEYS = new Set(['from', 'to', 'startDate', 'endDate']);
const LOCATION_FILTER_KEYS = new Set([
  'locationId',
  'locationName',
  'locationIds',
  'locations',
  'location_id',
  'location_ids'
]);

export function normalizeScheduledReportFilters({
  reportId = '',
  scheduleFilters = {},
  itemFilters = {},
  range = {},
  dateRangeType = 'custom',
  location = null
} = {}) {
  const filters = {
    ...objectValue(scheduleFilters),
    ...objectValue(itemFilters)
  };

  for (const key of RUNTIME_FILTER_KEYS) delete filters[key];
  for (const key of DATE_FILTER_KEYS) delete filters[key];
  for (const key of LOCATION_FILTER_KEYS) delete filters[key];

  const normalizedRange = objectValue(range);
  for (const key of DATE_FILTER_KEYS) {
    if (normalizedRange[key] !== undefined && normalizedRange[key] !== null) {
      filters[key] = normalizedRange[key];
    }
  }
  filters.dateRangeType = clean(dateRangeType || 'custom');

  if (location && clean(location.id)) {
    filters.locationId = clean(location.id);
    filters.locationName = clean(location.name || location.id);
  }

  return normalizeReportSpecificFilters(clean(reportId), filters);
}

export function summarizeScheduledReportOutput(reportId = '', rows = [], reportTotals = {}, meta = {}) {
  const normalizedRows = arrayValue(rows);
  const totals = objectValue(reportTotals);
  const metadata = objectValue(meta);
  const statusCounts = countStatuses(normalizedRows);

  const explicitLow = firstFinite(totals.lowStockItems, totals.lowItems);
  const explicitCritical = firstFinite(totals.criticalItems, totals.criticalStockItems);
  const lowStockCount = Math.max(0, explicitLow || 0, statusCounts.low) +
    Math.max(0, explicitCritical || 0, statusCounts.critical);

  const totalWastage = clean(reportId) === 'wastage'
    ? preferNonZeroFinite(
      totals.wastageValue,
      totals.totalWastage,
      absoluteSum(normalizedRows, ['wastageValue', 'valueOut', 'valueDelta', 'movementValue'])
    )
    : 0;

  const totalSales = ['payment_sales_financial', 'sale_stock_movement'].includes(clean(reportId))
    ? preferNonZeroFinite(
      totals.grossSales,
      totals.netSales,
      totals.totalSales,
      sumRows(normalizedRows, ['grossAmount', 'grossSales', 'salesValue', 'amount'])
    )
    : 0;

  const criticalWarnings = firstFinite(
    totals.criticalWarnings,
    totals.critical,
    metadata.criticalWarnings
  ) || 0;

  return {
    ...totals,
    rowCount: normalizedRows.length,
    totalWastage,
    totalSales,
    lowStockCount,
    criticalWarnings
  };
}

export function buildScheduledSourceHeaders(existingHeaders = {}, executionId = '', sourceSequence = 0) {
  const headers = new Headers(existingHeaders || {});
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
  if (clean(executionId)) headers.set('X-KCP-Schedule-Run-Id', clean(executionId));
  headers.set('X-KCP-Schedule-Source-Sequence', String(Number(sourceSequence) || 0));
  return headers;
}

export function addScheduledSourceCacheBuster(url, executionId = '', sourceSequence = 0, offset = 0) {
  const target = url instanceof URL ? new URL(url.toString()) : new URL(String(url));
  if (clean(executionId)) target.searchParams.set('_scheduleRun', clean(executionId));
  target.searchParams.set('_sourceFetch', `${Number(sourceSequence) || 0}:${Number(offset) || 0}`);
  return target;
}

function normalizeReportSpecificFilters(reportId, filters) {
  if (reportId === 'stock_control') {
    // Historical Stock Controller templates stored both flags. They are AND filters,
    // which excludes Low rows because a row cannot be both Low and Critical.
    // Below Par already includes Critical, Low, and Below Par rows.
    if (truthy(filters.onlyCritical) && truthy(filters.onlyBelowPar)) {
      delete filters.onlyCritical;
      filters.onlyBelowPar = 'true';
    }
  }
  return filters;
}

function countStatuses(rows) {
  return rows.reduce((counts, row) => {
    const status = clean(row?.status || row?.stockStatus).toLowerCase();
    const critical = status === 'critical' || truthy(row?.isCritical);
    const low = status === 'low' || (!critical && truthy(row?.isLowStock));
    if (low) counts.low += 1;
    if (critical) counts.critical += 1;
    return counts;
  }, { low: 0, critical: 0 });
}

function sumRows(rows, keys) {
  return rows.reduce((total, row) => total + rowNumber(row, keys), 0);
}

function absoluteSum(rows, keys) {
  return Math.abs(sumRows(rows, keys));
}

function rowNumber(row, keys) {
  for (const key of keys) {
    const numeric = Number(row?.[key]);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function firstFinite(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function preferNonZeroFinite(...values) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  return finite.find((value) => value !== 0) ?? finite[0] ?? 0;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'y'].includes(clean(value).toLowerCase());
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value ?? '').trim();
}
