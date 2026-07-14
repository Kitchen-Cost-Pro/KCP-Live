import { runReport } from './modules/reporting/index.js';
import {
  buildLocationNameIndex,
  mergeCanonicalLocations,
  normalizeLocationReference,
  resolveLocationDisplayName
} from './utils/locationDisplayName.js';
import { buildDefaultStockSku } from './utils/stockSku.js';

const MAX_REPORT_PAGES = 10;
const LEDGER_PAGE_SIZE = 2000;
const SALES_PAGE_SIZE = 2000;
const STOCK_PAGE_SIZE = 3000;

export async function loadDashboardReportingModel({
  workspaceId = '',
  services = {},
  now = new Date(),
  filters = {}
} = {}) {
  if (!workspaceId) throw new Error('A workspace is required to load the dashboard.');

  const range = getDashboardDateRange(now, filters);
  const locationId = text(filters.locationId);
  const [ledgerResult, salesResult, stockResult] = await Promise.all([
    runPagedReport('operations_dashboard', {
      workspaceId,
      view: 'movement_ledger',
      filters: { from: range.queryFrom, to: range.to, locationId },
      pageSize: LEDGER_PAGE_SIZE,
      services
    }),
    runPagedReport('payment_sales_financial', {
      workspaceId,
      view: 'daily_summary',
      filters: { from: range.queryFrom, to: range.to, locationId },
      pageSize: SALES_PAGE_SIZE,
      services
    }),
    runPagedReport('stock_control', {
      workspaceId,
      view: 'item_detail',
      filters: { locationId },
      pageSize: STOCK_PAGE_SIZE,
      services,
      maxPages: 4
    })
  ]);

  return buildDashboardModel({
    ledgerRows: ledgerResult.rows,
    salesRows: salesResult.rows,
    stockRows: stockResult.rows,
    now,
    range,
    locationId,
    truncated: ledgerResult.truncated || salesResult.truncated || stockResult.truncated,
    generatedAt: new Date().toISOString()
  });
}

export async function runPagedReport(reportId, {
  workspaceId = '',
  view = '',
  filters = {},
  pageSize = 2000,
  maxPages = MAX_REPORT_PAGES,
  services = {}
} = {}) {
  const rows = [];
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await runReport(reportId, {
      workspaceId,
      view,
      filters: {
        ...filters,
        limit: pageSize,
        offset: page * pageSize
      },
      services
    });
    const pageRows = Array.isArray(result?.rows) ? result.rows : [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) return { rows, truncated: false };
  }

  truncated = true;
  return { rows, truncated };
}

export function buildDashboardModel({
  ledgerRows = [],
  salesRows = [],
  stockRows = [],
  now = new Date(),
  range = null,
  locationId = '',
  generatedAt = new Date().toISOString(),
  truncated = false
} = {}) {
  const resolvedRange = range || getDashboardDateRange(now);
  const normalizedLocationId = text(locationId);
  const filteredLedgerRows = filterDashboardRows(ledgerRows, {
    from: resolvedRange.queryFrom,
    to: resolvedRange.to,
    locationId: normalizedLocationId
  });
  const filteredSalesRows = filterDashboardRows(salesRows, {
    from: resolvedRange.queryFrom,
    to: resolvedRange.to,
    locationId: normalizedLocationId
  });
  const filteredStockRows = filterDashboardRows(stockRows, { locationId: normalizedLocationId });
  const trendBuckets = resolvedRange.buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    cos: 0,
    adjustments: 0,
    wastage: 0,
    mfgWastage: 0,
    purchases: 0,
    netMovement: 0,
    grossSales: 0,
    netSales: 0
  }));
  const bucketIndex = new Map(trendBuckets.map((bucket) => [bucket.key, bucket]));
  const supplierSpend = new Map();
  const selectedTotals = emptyMonth();
  const comparisonTotals = emptyMonth();

  for (const row of filteredLedgerRows) {
    const rowDate = getDateKey(row);
    if (!rowDate) continue;
    const movementValue = number(row.movementValue ?? row.netValue ?? row.valueDelta);
    const impact = Math.abs(movementValue);
    const source = normalizeSource(row.source || row.sourceType || row.movementType);
    const target = dateInRange(rowDate, resolvedRange.from, resolvedRange.to)
      ? selectedTotals
      : dateInRange(rowDate, resolvedRange.comparisonFrom, resolvedRange.comparisonTo)
        ? comparisonTotals
        : null;
    if (!target) continue;

    target.netMovement += movementValue;
    if (isSalesUsage(source)) target.cos += impact;
    if (isAdjustment(source)) target.adjustments += impact;
    if (isManufacturingWastage(source)) target.mfgWastage += impact;
    if (isManualWastage(source)) target.wastage += impact;
    if (isPurchase(source)) target.purchases += Math.max(movementValue, 0);

    if (!dateInRange(rowDate, resolvedRange.from, resolvedRange.to)) continue;
    const bucket = bucketIndex.get(toBucketKey(rowDate, resolvedRange.granularity));
    if (!bucket) continue;

    bucket.netMovement += movementValue;
    if (isSalesUsage(source)) bucket.cos += impact;
    if (isAdjustment(source)) bucket.adjustments += impact;
    if (isManufacturingWastage(source)) bucket.mfgWastage += impact;
    if (isManualWastage(source)) bucket.wastage += impact;
    if (isPurchase(source)) {
      bucket.purchases += Math.max(movementValue, 0);
      const supplier = resolveSupplierName(row);
      if (supplier) supplierSpend.set(supplier, (supplierSpend.get(supplier) || 0) + Math.max(movementValue, 0));
    }
  }

  for (const row of filteredSalesRows) {
    const rowDate = getDateKey(row);
    if (!rowDate) continue;
    const grossSales = number(row.grossSales ?? row.grossAmount);
    const netSales = number(row.netSales ?? row.netAmount);
    if (dateInRange(rowDate, resolvedRange.from, resolvedRange.to)) {
      selectedTotals.grossSales += grossSales;
      selectedTotals.netSales += netSales;
      const bucket = bucketIndex.get(toBucketKey(rowDate, resolvedRange.granularity));
      if (bucket) {
        bucket.grossSales += grossSales;
        bucket.netSales += netSales;
      }
    } else if (dateInRange(rowDate, resolvedRange.comparisonFrom, resolvedRange.comparisonTo)) {
      comparisonTotals.grossSales += grossSales;
      comparisonTotals.netSales += netSales;
    }
  }

  const inventoryItems = aggregateInventoryRows(filteredStockRows);
  const totalStockValue = inventoryItems.reduce((total, item) => total + item.totalValue, 0);
  const criticalItems = inventoryItems.filter((item) => item.status === 'critical');
  const lowItems = inventoryItems.filter((item) => item.status === 'low');
  const inventoryLocations = collectInventoryLocations(inventoryItems);
  const currentWastage = selectedTotals.wastage + selectedTotals.mfgWastage;
  const previousWastage = comparisonTotals.wastage + comparisonTotals.mfgWastage;
  const grossMargin = marginPercent(selectedTotals.netSales, selectedTotals.cos);
  const previousGrossMargin = marginPercent(comparisonTotals.netSales, comparisonTotals.cos);
  const estimatedOpeningStockValue = totalStockValue - selectedTotals.netMovement;

  let supplierMode = 'purchase';
  if (![...supplierSpend.values()].some((value) => value > 0)) {
    supplierMode = 'reorder';
    for (const item of inventoryItems) {
      if (!item.supplier || item.estimatedReorderValue <= 0) continue;
      supplierSpend.set(item.supplier, (supplierSpend.get(item.supplier) || 0) + item.estimatedReorderValue);
    }
  }

  const suppliers = buildSupplierBreakdown(supplierSpend);

  return {
    generatedAt,
    truncated,
    dateLabel: formatDashboardDate(now),
    currentPeriodLabel: resolvedRange.label,
    trendRangeLabel: resolvedRange.label,
    trendTitle: `${resolvedRange.displayName} Trend`,
    range: resolvedRange,
    locationId: normalizedLocationId,
    locations: collectDashboardLocations(ledgerRows, salesRows, stockRows),
    inventoryLocations,
    metrics: {
      totalStockValue,
      totalStockValueDelta: percentageChange(totalStockValue, estimatedOpeningStockValue),
      costOfSales: selectedTotals.cos,
      costOfSalesDelta: percentageChange(selectedTotals.cos, comparisonTotals.cos),
      wastage: currentWastage,
      wastageDelta: percentageChange(currentWastage, previousWastage),
      wastagePercentOfCos: selectedTotals.cos > 0 ? (currentWastage / selectedTotals.cos) * 100 : null,
      grossMargin,
      grossMarginDelta: grossMargin === null || previousGrossMargin === null ? null : grossMargin - previousGrossMargin,
      netSales: selectedTotals.netSales
    },
    alerts: {
      criticalCount: criticalItems.length,
      lowCount: lowItems.length,
      criticalNames: criticalItems.slice(0, 3).map((item) => item.locationName ? `${item.name} — ${item.locationName}` : item.name)
    },
    trend: trendBuckets.map((bucket) => ({
      ...bucket,
      cos: roundMoney(bucket.cos),
      adjustments: roundMoney(bucket.adjustments),
      wastage: roundMoney(bucket.wastage),
      mfgWastage: roundMoney(bucket.mfgWastage)
    })),
    supplierMode,
    suppliers,
    inventoryItems
  };
}

export function reconcileDashboardLocationNames(model = {}, canonicalLocations = []) {
  const canonical = mergeCanonicalLocations(canonicalLocations);
  if (!canonical.length) return model;

  const { byReference } = buildLocationNameIndex(canonical);
  const resolveName = (id = '', currentName = '') => {
    const exact = String(id || '').trim();
    const current = String(currentName || '').trim();
    const match = byReference.get(exact) || byReference.get(normalizeLocationReference(exact));
    if (match) return match.name;
    const nameMatch = byReference.get(current) || byReference.get(normalizeLocationReference(current));
    if (nameMatch) return nameMatch.name;
    return resolveLocationDisplayName({ id: exact, name: current }, current || 'Location');
  };

  const inventoryItems = asArray(model.inventoryItems).map((item) => {
    const locationName = resolveName(item.locationId, item.locationName);
    return {
      ...item,
      locationName,
      locations: asArray(item.locations).length
        ? asArray(item.locations).map((name) => resolveName(item.locationId, name))
        : [locationName]
    };
  });

  const inventoryLocations = mergeCanonicalLocations(
    canonical,
    asArray(model.inventoryLocations).map((location) => ({
      ...location,
      name: resolveName(location.id, location.name),
      displayName: resolveName(location.id, location.name)
    }))
  ).map((location) => ({ id: location.id, name: location.name }));

  const locations = mergeCanonicalLocations(
    canonical,
    asArray(model.locations).map((location) => ({
      ...location,
      name: resolveName(location.id, location.name),
      displayName: resolveName(location.id, location.name)
    }))
  ).map((location) => ({ id: location.id, name: location.name }));

  const criticalItems = inventoryItems.filter((item) => item.status === 'critical');
  return {
    ...model,
    locations,
    inventoryLocations,
    inventoryItems,
    alerts: {
      ...(model.alerts || {}),
      criticalNames: criticalItems.slice(0, 3).map((item) => item.locationName ? `${item.name} — ${item.locationName}` : item.name)
    }
  };
}

export function aggregateInventoryRows(stockRows = []) {
  const groups = new Map();

  for (const row of asArray(stockRows)) {
    const itemId = text(row.itemId || row.stockItemId);
    const name = text(row.itemName || row.name) || 'Unnamed Item';
    const baseUom = text(row.baseUom || row.uom || row.unit);
    const itemKey = itemId || `${name.toLowerCase()}::${baseUom.toLowerCase()}`;
    const location = resolveInventoryLocation(row);
    const key = `${itemKey}::${location.id || location.name.toLowerCase() || 'unassigned'}`;
    const unitCost = number(row.unitCostExVat ?? row.unitCost);
    const currentStock = number(row.currentStock ?? row.quantity);
    const status = normalizeStockStatus(row.status || row.stockStatus, currentStock, row.lowStockThreshold, row.parLevel);
    const existing = groups.get(key) || {
      id: key,
      itemId,
      sku: resolveSku(row),
      name,
      category: text(row.category) || 'General',
      qty: 0,
      reorder: 0,
      lowStockThreshold: 0,
      parLevel: 0,
      baseUom,
      unitCost: 0,
      totalValue: 0,
      status: 'ok',
      supplier: '',
      supplierId: '',
      estimatedReorderValue: 0,
      locationId: location.id,
      locationName: location.name,
      locationCount: 1,
      locations: [location.name],
      sourceRowCount: 0,
      lastUpdated: ''
    };

    existing.qty += currentStock;
    existing.lowStockThreshold += number(row.lowStockThreshold);
    existing.parLevel += number(row.parLevel);
    existing.reorder += number(row.parLevel || row.lowStockThreshold);
    existing.totalValue += currentStock * unitCost;
    existing.unitCost = weightedUnitCost(existing.unitCost, existing.sourceRowCount, unitCost);
    existing.status = moreSevereStatus(existing.status, status);
    existing.supplier = existing.supplier || text(row.supplierName);
    existing.supplierId = existing.supplierId || text(row.supplierId);
    existing.estimatedReorderValue += number(row.estimatedReorderValue);
    existing.sourceRowCount += 1;
    existing.lastUpdated = latestDate(existing.lastUpdated, row.lastUpdated);
    if (!existing.sku) existing.sku = resolveSku(row);
    groups.set(key, existing);
  }

  return [...groups.values()]
    .map(({ sourceRowCount, ...item }) => ({
      ...item,
      qty: roundQuantity(item.qty),
      reorder: roundQuantity(item.reorder),
      lowStockThreshold: roundQuantity(item.lowStockThreshold),
      parLevel: roundQuantity(item.parLevel),
      unitCost: roundMoney(item.unitCost),
      totalValue: roundMoney(item.totalValue),
      estimatedReorderValue: roundMoney(item.estimatedReorderValue),
      locations: [...new Set(item.locations)].sort()
    }))
    .sort((left, right) => left.locationName.localeCompare(right.locationName, 'en', { sensitivity: 'base' }) || severityRank(right.status) - severityRank(left.status) || left.name.localeCompare(right.name));
}

export function getDashboardDateRange(now = new Date(), filters = {}) {
  const anchor = validDate(now) ? startOfLocalDay(now) : startOfLocalDay(new Date());
  const fallbackFrom = new Date(anchor.getFullYear(), anchor.getMonth() - 5, 1);
  let fromDate = parseLocalDate(filters.from || filters.dateFrom) || fallbackFrom;
  let toDate = parseLocalDate(filters.to || filters.dateTo) || anchor;
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

  const dayCount = Math.max(1, daysBetween(fromDate, toDate) + 1);
  const comparisonToDate = addDays(fromDate, -1);
  const comparisonFromDate = addDays(comparisonToDate, -(dayCount - 1));
  const granularity = dayCount <= 31 ? 'day' : dayCount <= 120 ? 'week' : 'month';
  const buckets = buildTrendBuckets(fromDate, toDate, granularity);
  const label = formatRangeLabel(fromDate, toDate);
  const displayName = getRangeDisplayName(dayCount, granularity, buckets.length);

  return {
    from: formatLocalDate(fromDate),
    to: formatLocalDate(toDate),
    queryFrom: formatLocalDate(comparisonFromDate),
    comparisonFrom: formatLocalDate(comparisonFromDate),
    comparisonTo: formatLocalDate(comparisonToDate),
    currentFrom: formatLocalDate(new Date(anchor.getFullYear(), anchor.getMonth(), 1)),
    dayCount,
    granularity,
    label,
    displayName,
    buckets,
    months: buckets
  };
}

function filterDashboardRows(rows = [], { from = '', to = '', locationId = '' } = {}) {
  const locationKey = text(locationId);
  return asArray(rows).filter((row) => {
    if (locationKey && !getRowLocationIds(row).includes(locationKey)) return false;
    if (!from && !to) return true;
    const rowDate = getDateKey(row);
    if (!rowDate) return false;
    if (from && rowDate < from) return false;
    if (to && rowDate > to) return false;
    return true;
  });
}

function collectInventoryLocations(items = []) {
  const locations = new Map();
  for (const item of asArray(items)) {
    const id = text(item.locationId);
    const name = text(item.locationName) || id || 'Unassigned';
    const key = id || `unassigned:${name.toLowerCase()}`;
    if (!locations.has(key)) locations.set(key, { id: key, name });
  }
  return [...locations.values()].sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }));
}

function collectDashboardLocations(...rowSets) {
  const locations = new Map();
  for (const row of rowSets.flatMap((rows) => asArray(rows))) {
    const raw = row.raw || row.rawSourceRow || {};
    const id = text(
      row.locationId || row.location_id ||
      raw.locationId || raw.location_id ||
      raw.location?.id
    );
    if (!id) continue;
    const name = text(
      row.locationName || row.location_name ||
      raw.locationName || raw.location_name ||
      raw.location?.displayName || raw.location?.name
    ) || id;
    if (!locations.has(id) || locations.get(id).name === id) locations.set(id, { id, name });
  }
  return [...locations.values()].sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }));
}

function getRowLocationIds(row = {}) {
  const raw = row.raw || row.rawSourceRow || {};
  return [
    row.locationId,
    row.location_id,
    row.fromLocationId,
    row.from_location_id,
    row.toLocationId,
    row.to_location_id,
    raw.locationId,
    raw.location_id,
    raw.location?.id
  ].map(text).filter(Boolean);
}

function getDateKey(row = {}) {
  const value = text(
    row.date || row.saleDate || row.sale_date || row.movementDate || row.movement_date ||
    row.timestamp || row.createdAt || row.created_at
  );
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function dateInRange(value = '', from = '', to = '') {
  const key = text(value);
  return Boolean(key && (!from || key >= from) && (!to || key <= to));
}

function buildTrendBuckets(fromDate, toDate, granularity) {
  const buckets = [];
  if (granularity === 'day') {
    for (let cursor = new Date(fromDate); cursor <= toDate; cursor = addDays(cursor, 1)) {
      buckets.push({
        key: formatLocalDate(cursor),
        label: cursor.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })
      });
    }
    return buckets;
  }

  if (granularity === 'week') {
    for (let cursor = startOfWeek(fromDate); cursor <= toDate; cursor = addDays(cursor, 7)) {
      buckets.push({
        key: formatLocalDate(cursor),
        label: cursor.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })
      });
    }
    return buckets;
  }

  for (
    let cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    cursor <= toDate;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  ) {
    buckets.push({
      key: formatMonthKey(cursor),
      label: cursor.toLocaleDateString('en-ZA', {
        month: 'short',
        ...(fromDate.getFullYear() === toDate.getFullYear() ? {} : { year: '2-digit' })
      })
    });
  }
  return buckets;
}

function toBucketKey(value = '', granularity = 'month') {
  const date = parseLocalDate(value);
  if (!date) return '';
  if (granularity === 'day') return formatLocalDate(date);
  if (granularity === 'week') return formatLocalDate(startOfWeek(date));
  return formatMonthKey(date);
}

function startOfWeek(value) {
  const date = startOfLocalDay(value);
  const day = date.getDay() || 7;
  return addDays(date, 1 - day);
}

function startOfLocalDay(value) {
  const date = validDate(value) ? new Date(value) : new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(value, amount) {
  const date = startOfLocalDay(value);
  date.setDate(date.getDate() + Number(amount || 0));
  return date;
}

function daysBetween(fromDate, toDate) {
  const fromUtc = Date.UTC(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const toUtc = Date.UTC(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
  return Math.round((toUtc - fromUtc) / 86400000);
}

function parseLocalDate(value) {
  if (validDate(value)) return startOfLocalDay(value);
  const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return validDate(date) ? date : null;
}

function formatRangeLabel(fromDate, toDate) {
  const sameYear = fromDate.getFullYear() === toDate.getFullYear();
  if (formatLocalDate(fromDate) === formatLocalDate(toDate)) {
    return fromDate.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const from = fromDate.toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  });
  const to = toDate.toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
  return `${from} – ${to}`;
}

function getRangeDisplayName(dayCount, granularity, bucketCount = 0) {
  if (granularity === 'day') return `${dayCount} Day`;
  if (granularity === 'week') return `${Math.max(1, bucketCount || Math.ceil(dayCount / 7))} Week`;
  return `${Math.max(1, bucketCount || Math.round(dayCount / 30.4375))} Month`;
}

function buildSupplierBreakdown(spendMap = new Map()) {
  const ranked = [...spendMap.entries()]
    .filter(([, value]) => number(value) > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5);
  const total = ranked.reduce((sum, [, value]) => sum + number(value), 0);
  return ranked.map(([name, value]) => ({
    name,
    value: roundMoney(value),
    percent: total > 0 ? (number(value) / total) * 100 : 0
  }));
}

function resolveSupplierName(row = {}) {
  const raw = row.raw || row.rawSourceRow || {};
  const metadata = raw.metadata || raw.raw?.metadata || raw.movement?.metadata || {};
  const grvRaw = parseMaybeJson(raw.movement?.grv_raw_json || raw.grvRawJson || raw.grv_raw_json);
  return text(
    row.supplierName || row.supplier_name ||
    raw.supplierName || raw.supplier_name ||
    metadata.supplierName || metadata.supplier || metadata.supplier_name ||
    grvRaw.supplierName || grvRaw.supplier
  );
}


function resolveInventoryLocation(row = {}) {
  const raw = row.raw || row.rawSourceRow || {};
  const id = text(
    row.locationId || row.location_id ||
    raw.locationId || raw.location_id ||
    raw.location?.id
  );
  const name = text(
    row.locationName || row.location_name ||
    raw.locationName || raw.location_name ||
    raw.location?.displayName || raw.location?.name
  ) || id || 'Unassigned';
  return { id: id || `unassigned:${name.toLowerCase()}`, name };
}

function resolveSku(row = {}) {
  const raw = row.raw || {};
  const stockItem = raw.stockItem || raw.stock_item || {};
  const stockRaw = parseMaybeJson(stockItem.stock_raw_json || stockItem.raw_json || row.stockRawJson || row.stock_raw_json);
  return text(
    row.sku || row.SKU || row.stockCode || row.stock_code ||
    stockItem.sku || stockItem.SKU || stockItem.stock_code ||
    stockRaw.sku || stockRaw.SKU || stockRaw.itemSku || stockRaw.item_sku || stockRaw.Stock_Code || stockRaw['Stock Code']
  ) || buildDefaultStockSku(row.itemName || row.name || stockItem.name);
}

function normalizeStockStatus(value, currentStock, lowThreshold, parLevel) {
  const status = text(value).toLowerCase();
  if (status.includes('critical') || number(currentStock) <= 0) return 'critical';
  if (status.includes('low') || status.includes('below par')) return 'low';
  if (number(lowThreshold) > 0 && number(currentStock) <= number(lowThreshold)) return 'low';
  if (number(parLevel) > 0 && number(currentStock) < number(parLevel)) return 'low';
  return 'ok';
}

function moreSevereStatus(left = 'ok', right = 'ok') {
  return severityRank(right) > severityRank(left) ? right : left;
}

function severityRank(status = 'ok') {
  return status === 'critical' ? 3 : status === 'low' ? 2 : 1;
}

function weightedUnitCost(existing, count, next) {
  if (!count) return number(next);
  if (!number(next)) return number(existing);
  return ((number(existing) * count) + number(next)) / (count + 1);
}

function marginPercent(netSales, costOfSales) {
  const sales = number(netSales);
  if (sales <= 0) return null;
  return ((sales - number(costOfSales)) / sales) * 100;
}

function percentageChange(current, previous) {
  const before = number(previous);
  if (Math.abs(before) < 0.000001) return null;
  return ((number(current) - before) / Math.abs(before)) * 100;
}

function normalizeSource(value) {
  return text(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isPurchase(source) {
  return source === 'grv' || source.includes('purchase order receive') || source.includes('goods receipt');
}

function isSalesUsage(source) {
  return source.includes('sale usage') || source.includes('modifier usage') || source.includes('sale depletion');
}

function isManufacturingWastage(source) {
  return source.includes('manufacturing wastage');
}

function isManualWastage(source) {
  return !isManufacturingWastage(source) && (source.includes('wastage adjustment') || source === 'wastage' || source.includes('manual wastage'));
}

function isAdjustment(source) {
  return source.includes('manual adjustment') || source.includes('stock take variance') || source.includes('stock take correction') || source.includes('system correction') || source.includes('manufacturing correction');
}

function formatDashboardDate(date) {
  const day = date.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${day} — Week ${isoWeek(date)}`;
}

function isoWeek(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
}

function formatMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function latestDate(left, right) {
  const a = text(left);
  const b = text(right);
  return a > b ? a : b;
}

function parseMaybeJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function emptyMonth() {
  return { cos: 0, adjustments: 0, wastage: 0, mfgWastage: 0, purchases: 0, netMovement: 0, grossSales: 0, netSales: 0 };
}

function roundMoney(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function roundQuantity(value) {
  return Math.round((number(value) + Number.EPSILON) * 1000) / 1000;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value) {
  return String(value ?? '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
