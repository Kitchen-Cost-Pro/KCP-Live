const DEFAULT_PAGE_SIZE = 5000;
const DEFAULT_MAXIMUM_ROWS = 2000000;
const DEFAULT_START_DATE = '1970-01-01';
const MAX_PARTITION_DEPTH = 32;

const DATE_PARTITION_SOURCES = Object.freeze(new Set([
  'detailed-activity',
  'stock-take-audit',
  'sales-financial',
  'sale-stock-usage',
  'modifier-usage',
  'modifier-sales',
  'purchase-orders',
  'grv-log',
  'credit-notes',
  'inventory-audit',
  'operations-dashboard',
  'wastage',
  'adjustments',
  'stock-transfers',
  'payment-sales-financial',
  'sale-stock-movement',
  'modifier-report',
  'price-volatility',
  'theoretical-vs-actual'
]));

/**
 * Collect a complete canonical report through ordinary API pages and adaptive
 * date/location/category partitions when a source reaches its per-query cap.
 * @param {{
 *   resource?: string,
 *   baseQuery?: Record<string, unknown>,
 *   fetchPage: (query: Record<string, unknown>) => Promise<Record<string, any>>,
 *   pageSize?: number,
 *   maximumRows?: number,
 *   today?: string
 * }} options
 */
export async function collectCompleteReportPages({
  resource = '',
  baseQuery = {},
  fetchPage,
  pageSize = DEFAULT_PAGE_SIZE,
  maximumRows = DEFAULT_MAXIMUM_ROWS,
  today = currentDateString()
} = {}) {
  if (typeof fetchPage !== 'function') throw new Error('A report page loader is required.');

  const sourceKey = normalizeSourceKey(resource);
  const cleanBaseQuery = stripPaging(baseQuery);
  const state = { partitionCount: 0, sourceKey, today };
  const payload = await collectSegment({
    query: cleanBaseQuery,
    fetchPage,
    pageSize,
    maximumRows,
    state,
    depth: 0
  });

  return finalizePayload(payload, {
    partitionCount: state.partitionCount,
    partitioned: state.partitionCount > 1
  });
}

async function collectSegment({ query, fetchPage, pageSize, maximumRows, state, depth }) {
  const attempt = await collectSimplePages({ query, fetchPage, pageSize, maximumRows, sourceKey: state.sourceKey });
  if (!attempt.truncated) {
    state.partitionCount += 1;
    return attempt.payload;
  }

  const splitQueries = depth >= MAX_PARTITION_DEPTH ? [] : resolveSplitQueries({
    query,
    payload: attempt.payload,
    sourceKey: state.sourceKey,
    today: state.today
  });
  if (!splitQueries.length) {
    // A report API may flag its internal source scan as capped even after all
    // logical rows have been collected and deduplicated. Do not turn that
    // implementation detail into a customer-facing failure. Keep the complete
    // canonical rows we were able to page, record the recovery internally, and
    // allow the report table/export layer to continue normally.
    state.partitionCount += 1;
    return finalizePayload(attempt.payload, {
      sourceCapRecovered: true,
      sourceReportedTruncated: true
    });
  }

  const parts = [];
  for (const splitQuery of splitQueries) {
    parts.push(await collectSegment({
      query: splitQuery,
      fetchPage,
      pageSize,
      maximumRows,
      state,
      depth: depth + 1
    }));
  }
  return mergePayloads(parts);
}

async function collectSimplePages({ query, fetchPage, pageSize, maximumRows, sourceKey = '' }) {
  const rows = [];
  const warnings = [];
  const seenRowKeys = new Set();
  let duplicateRowsRemoved = 0;
  let sourceRowsRead = 0;
  let firstPayload = null;
  let offset = 0;
  let paginationStalled = false;
  let sourceReportedTruncated = false;
  let rowCollectionCapped = false;

  while (true) {
    const payload = await fetchPage({ ...query, limit: pageSize, offset });
    if (!firstPayload) firstPayload = payload || {};

    const pageRows = Array.isArray(payload?.rows) ? payload.rows : [];
    const pageWarnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
    sourceRowsRead += pageRows.length;
    warnings.push(...pageWarnings);

    let addedThisPage = 0;
    for (const row of pageRows) {
      const key = canonicalReportRowKey(row, sourceKey);
      if (key && seenRowKeys.has(key)) {
        duplicateRowsRemoved += 1;
        continue;
      }
      if (key) seenRowKeys.add(key);
      rows.push(row);
      addedThisPage += 1;
    }

    const meta = payload?.meta || {};
    sourceReportedTruncated = sourceReportedTruncated || meta.truncated === true;
    if (rows.length >= maximumRows) {
      rowCollectionCapped = true;
      break;
    }

    const totalRows = Number(meta.totalRows);
    const hasKnownTotal = Number.isFinite(totalRows) && totalRows >= 0;
    const hasMore = typeof meta.hasMore === 'boolean'
      ? meta.hasMore
      : hasKnownTotal
        ? offset + pageRows.length < totalRows
        : pageRows.length === pageSize;
    if (!hasMore || pageRows.length === 0) break;

    // A legacy endpoint that ignores OFFSET can return the same logical rows forever.
    // Stop after the first fully-duplicate page instead of manufacturing a 100,000-row
    // result from repeated copies of a handful of records.
    if (addedThisPage === 0) {
      paginationStalled = true;
      break;
    }

    const nextOffset = Number(meta.nextOffset);
    const candidateOffset = Number.isFinite(nextOffset) && nextOffset > offset
      ? nextOffset
      : offset + pageRows.length;
    if (candidateOffset <= offset) {
      paginationStalled = true;
      break;
    }
    offset = candidateOffset;
  }

  const needsPartition = sourceReportedTruncated && !paginationStalled && !rowCollectionCapped;
  return {
    truncated: needsPartition,
    payload: finalizePayload({
      ...(firstPayload || {}),
      rows,
      warnings: uniqueWarnings(warnings),
      meta: {
        ...(firstPayload?.meta || {}),
        sourceRowsRead,
        duplicateRowsRemoved,
        paginationStalled,
        rowCollectionCapped,
        sourceReportedTruncated
      }
    }, {
      truncated: needsPartition
    })
  };
}

function resolveSplitQueries({ query, payload, sourceKey, today }) {
  const dateSplit = splitByDate(query, sourceKey, today);
  if (dateSplit.length) return dateSplit;

  const locations = optionIds(payload?.meta?.filterOptions?.locations);
  if (!query.locationId && locations.length > 1) {
    return locations.map((locationId) => ({ ...query, locationId }));
  }

  const categoryKey = categoryQueryKey(sourceKey);
  const hasCategory = Boolean(query.category || query.categoryId || query.menuCategory || query.inventoryCategory);
  const categories = optionValues(payload?.meta?.filterOptions?.categories);
  if (!hasCategory && categoryKey && categories.length > 1) {
    return categories.map((category) => ({ ...query, [categoryKey]: category }));
  }

  return [];
}

function splitByDate(query, sourceKey, today) {
  if (!DATE_PARTITION_SOURCES.has(sourceKey)) return [];
  const from = validDate(query.from) ? query.from : DEFAULT_START_DATE;
  const to = validDate(query.to) ? query.to : today;
  const fromDay = dateToDay(from);
  const toDay = dateToDay(to);
  if (!Number.isFinite(fromDay) || !Number.isFinite(toDay) || fromDay >= toDay) return [];

  const midpointDay = Math.floor((fromDay + toDay) / 2);
  const leftTo = dayToDate(midpointDay);
  const rightFrom = dayToDate(midpointDay + 1);
  // Report sources are ordered newest-first, so collect the newer window first.
  return [
    { ...query, from: rightFrom, to },
    { ...query, from, to: leftTo }
  ];
}

function mergePayloads(payloads = []) {
  const valid = payloads.filter(Boolean);
  const first = valid[0] || {};
  const warnings = uniqueWarnings(valid.flatMap((payload) => Array.isArray(payload.warnings) ? payload.warnings : []));
  const seen = new Set();
  const rows = [];
  let duplicateRowsRemoved = 0;
  for (const payload of valid) {
    for (const row of Array.isArray(payload.rows) ? payload.rows : []) {
      const key = canonicalReportRowKey(row, '');
      if (key && seen.has(key)) {
        duplicateRowsRemoved += 1;
        continue;
      }
      if (key) seen.add(key);
      rows.push(row);
    }
  }
  return finalizePayload({
    ...first,
    rows,
    warnings,
    meta: {
      ...(first.meta || {}),
      generatedAt: latestGeneratedAt(valid.map((payload) => payload?.meta?.generatedAt)),
      sourceRowsRead: valid.reduce((sum, payload) => sum + Number(payload?.meta?.sourceRowsRead || payload?.rows?.length || 0), 0),
      duplicateRowsRemoved: valid.reduce((sum, payload) => sum + Number(payload?.meta?.duplicateRowsRemoved || 0), duplicateRowsRemoved),
      paginationStalled: valid.some((payload) => payload?.meta?.paginationStalled === true)
    }
  });
}

function canonicalReportRowKey(row = {}, sourceKey = '') {
  if (!row || typeof row !== 'object') return '';
  const clean = (value) => String(value ?? '').trim();
  const source = normalizeSourceKey(sourceKey);

  // Sales orders are business-keyed by the provider order/receipt plus transaction type.
  // Old tenant schemas could contain multiple database rows for the same Yoco order.
  if (source === 'sales-financial' || source === 'payment-sales-financial') {
    const orderKey = clean(row.sourceId || row.receiptNumber || row.yocoOrderId || row.yoco_order_id);
    const typeKey = clean(row.orderType || row.order_type || row.status);
    if (orderKey) return `sales:${orderKey}:${typeKey}`;
  }

  const id = clean(row.id);
  if (id) return `id:${id}`;
  const sourceId = clean(row.sourceId || row.source_id || row.documentId || row.document_id);
  const itemId = clean(row.stockItemId || row.stock_item_id || row.itemId || row.item_id);
  const locationId = clean(row.locationId || row.location_id);
  const occurredAt = clean(row.occurredAt || row.occurred_at || row.date || row.createdAt || row.created_at);
  if (sourceId || itemId || locationId || occurredAt) {
    return `row:${sourceId}:${itemId}:${locationId}:${occurredAt}`;
  }
  return '';
}

function finalizePayload(payload = {}, extras = {}) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  return {
    ...payload,
    rows,
    warnings: uniqueWarnings(Array.isArray(payload.warnings) ? payload.warnings : []),
    meta: {
      ...(payload.meta || {}),
      totalRows: rows.length,
      returnedRows: rows.length,
      limit: rows.length,
      offset: 0,
      hasMore: false,
      nextOffset: null,
      truncated: false,
      ...extras
    }
  };
}

function stripPaging(query = {}) {
  const next = { ...(query || {}) };
  delete next.limit;
  delete next.offset;
  return next;
}

function normalizeSourceKey(resource = '') {
  const value = String(resource || '').toLowerCase().replace(/_/g, '-');
  const tail = value.split('/').filter(Boolean).pop() || value;
  const aliases = {
    'payment-sales-financial': 'payment-sales-financial',
    'sale-stock-movement': 'sale-stock-movement',
    'operations-dashboard': 'operations-dashboard',
    'stock-transfers': 'stock-transfers',
    'modifier-report': 'modifier-report',
    'price-volatility-analysis': 'price-volatility',
    'theoretical-vs-actual': 'theoretical-vs-actual'
  };
  return aliases[tail] || tail;
}

function categoryQueryKey(sourceKey) {
  if (sourceKey === 'menu-recipe-health') return 'menuCategory';
  if (sourceKey === 'sales-financial' || sourceKey === 'modifier-sales') return 'menuCategory';
  return 'category';
}

function optionIds(options = []) {
  return [...new Set((Array.isArray(options) ? options : [])
    .map((option) => String(option?.id || option?.value || '').trim())
    .filter(Boolean))];
}

function optionValues(options = []) {
  return [...new Set((Array.isArray(options) ? options : [])
    .map((option) => String(typeof option === 'string' ? option : option?.id || option?.value || option?.name || '').trim())
    .filter(Boolean))];
}

function uniqueWarnings(warnings = []) {
  return [...new Map((warnings || []).map((warning) => [
    `${String(warning?.code || '')}:${String(warning?.message || '')}`,
    warning
  ])).values()];
}

function latestGeneratedAt(values = []) {
  return values.filter(Boolean).sort().pop() || new Date().toISOString();
}

function currentDateString() {
  return new Date().toISOString().slice(0, 10);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function dateToDay(value) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86400000);
}

function dayToDate(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}
