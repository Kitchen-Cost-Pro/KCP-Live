import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { isWastageAdjustment } from './wastageClassifier.js';

const tileKeys = [
  'settings',
  'stockValue',
  'openingStock',
  'closingStock',
  'costOfSales',
  'countVariance',
  'manualAdjustments',
  'wastage',
  'lowStockCount',
  'gpPercentage',
  'openPurchaseOrders',
  'activeSuppliers',
  'grvsPending',
  'stockTakesDue',
  'recipesUpdated',
  'pendingExternalTransfers',
  'recentActivity'
];

export const dashboardTileKeys = [...tileKeys];

export function subscribeDashboardTiles(workspaceId, { onSnapshot, onError, range = '7', siteId = '' } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for dashboard tiles.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchDashboardTiles(workspaceKey, { range, siteId });
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'live:dashboard');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

async function fetchDashboardTiles(workspaceId, { range = '7', siteId = '' } = {}) {
  const context = resolveDashboardRangeContext(range);
  const locationId = String(siteId || '').trim();
  const query = {
    from: context.startDate,
    to: context.endDate,
    ...(locationId ? { locationId } : {})
  };

  const [
    dashboardResponse,
    stockResponse,
    productResponse,
    supplierResponse,
    purchaseOrderResponse,
    transferResponse,
    stockTakeResponse,
    stockTakeTemplateResponse,
    locationResponse,
    siteResponse
  ] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceId, 'dashboard', { query }),
    callCloudflareWorkspaceRoute(workspaceId, 'stock-items', { query: { limit: 500, ...(locationId ? { locationId } : {}) } }),
    callCloudflareWorkspaceRoute(workspaceId, 'products', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'suppliers', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'purchase-orders', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'transfers', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'stock-takes', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'stock-take-templates', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'locations'),
    callCloudflareWorkspaceRoute(workspaceId, 'site-configuration')
  ]);

  const stockItems = (stockResponse.stockItems || stockResponse.items || []).map(normalizeStockItem);
  const products = (productResponse.products || productResponse.items || []).filter(isMainMenuProduct);
  const suppliers = supplierResponse.suppliers || supplierResponse.items || [];
  const purchaseOrders = purchaseOrderResponse.orders || purchaseOrderResponse.purchaseOrders || purchaseOrderResponse.items || [];
  const transfers = transferResponse.transfers || transferResponse.items || [];
  const stockTakes = stockTakeResponse.stockTakes || stockTakeResponse.items || [];
  const templates = stockTakeTemplateResponse.templates || stockTakeTemplateResponse.stockTakeTemplates || stockTakeTemplateResponse.items || [];
  const locations = normalizeLocations(locationResponse.locations || []);
  const siteName = siteResponse.siteConfiguration?.site_name || siteResponse.siteConfiguration?.siteName || '';
  const valuation = dashboardResponse.valuation || {};
  const movements = dashboardResponse.movements || [];
  const movementTotals = summarizeMovements(movements);
  const stockValue = numberValue(valuation.stock_value, sumStockValue(stockItems));
  const purchases = movementTotals.grv + movementTotals.creditNote;
  const costOfSales = Math.abs(movementTotals.sale);
  const manualAdjustments = movementTotals.adjustment;
  const countVariance = movementTotals.stockTake;
  const wastage = Math.abs(movementTotals.wastage + movementTotals.manufacturingWastage);
  const openingStock = stockValue + costOfSales - purchases - manualAdjustments - countVariance + wastage;
  const serverSummary = normalizeMetricMap(dashboardResponse.summary || {});
  const serverInsights = dashboardResponse.insights && typeof dashboardResponse.insights === 'object' ? dashboardResponse.insights : {};
  const rawLowStockRows = toArray(serverInsights.lowStockRows).length
    ? toArray(serverInsights.lowStockRows)
    : buildLowStockRows(stockItems, locations);
  // Collapse to one row per item (worst deficit) so an item low at several locations
  // isn't repeated. When a location filter is active the worker already returns one
  // row per item, so this is a no-op in that case.
  const lowStockRows = collapseLowStockRows(rawLowStockRows);
  const lowStockItemCount = uniqueLowStockItemCount(lowStockRows);

  // Daily movement series (from the worker) → chart trends + KPI delta %.
  const movementSeries = dashboardResponse.movementSeries && typeof dashboardResponse.movementSeries === 'object'
    ? dashboardResponse.movementSeries
    : null;
  const trends = buildMovementTrends(movementSeries, String(range || '7'));
  const combinedWastageSeries = mergeNumericSeries(movementSeries?.wastage, movementSeries?.manufacturingWastage);
  const deltas = {
    stockValue: seriesDeltaPct(movementSeries?.stockValue),
    costOfSales: seriesDeltaPct(movementSeries?.costOfSales),
    wastage: seriesDeltaPct(combinedWastageSeries),
    manufacturingWastage: seriesDeltaPct(movementSeries?.manufacturingWastage)
  };
  const recipeCount = products.filter((product) => getEffectiveProductRecipe(product).length || Number(product.recipeCount || 0) > 0).length;
  const averageGp = calculateAverageGp(products, stockItems);
  const pendingExternalTransferRows = toArray(serverInsights.pendingExternalTransferRows).length
    ? toArray(serverInsights.pendingExternalTransferRows)
    : buildPendingExternalTransferRows(transfers);

  const summary = {
    stockValue: serverSummary.stockValue || metricValue(stockValue, 'currency'),
    totalStockValue: serverSummary.totalStockValue || metricValue(stockValue, 'currency'),
    openingStock: serverSummary.openingStock || metricValue(openingStock, 'currency'),
    closingStock: serverSummary.closingStock || metricValue(stockValue, 'currency'),
    costOfSales: serverSummary.costOfSales || metricValue(costOfSales, 'currency'),
    countVariance: serverSummary.countVariance || metricValue(countVariance, 'currency'),
    manualAdjustments: metricValue(manualAdjustments, 'currency'),
    wastage: metricValue(wastage, 'currency'),
    // Manufacturing wastage is its own tile — surface it explicitly (prefer the server value,
    // fall back to the locally-summarized manufacturing movement total) so the tile isn't blank.
    manufacturingWastage: metricValue(Math.abs(movementTotals.manufacturingWastage), 'currency'),
    lowStockCount: serverSummary.lowStockCount || metricValue(lowStockItemCount, 'number'),
    gpPercentage: serverSummary.gpPercentage || metricValue(averageGp, 'percent'),
    averageGp: serverSummary.averageGp || metricValue(averageGp, 'percent')
  };

  const insights = {
    lowStockCount: numberValue(serverInsights.lowStockCount, lowStockItemCount),
    lowStockLocationCount: numberValue(serverInsights.lowStockLocationCount, lowStockRows.length),
    lowStockRows,
    openPurchaseOrders: numberValue(serverInsights.openPurchaseOrders, purchaseOrders.filter(isOpenPurchaseOrder).length),
    activeSuppliers: numberValue(serverInsights.activeSuppliers, suppliers.filter((supplier) => supplier?.active !== false && supplier?.archived !== true).length),
    grvsPending: numberValue(serverInsights.grvsPending, purchaseOrders.filter(isPendingGrvPurchaseOrder).length),
    stockTakesDue: numberValue(serverInsights.stockTakesDue, templates.length || stockTakes.filter(isOpenStockTake).length),
    recipesUpdated: numberValue(serverInsights.recipesUpdated, recipeCount),
    pendingExternalTransfers: numberValue(serverInsights.pendingExternalTransfers, pendingExternalTransferRows.length),
    pendingExternalTransferRows,
    recentActivity: toArray(serverInsights.recentActivity).length
      ? toArray(serverInsights.recentActivity)
      : buildRecentActivity({ transfers, stockTakes, purchaseOrders })
  };

  const now = new Date().toISOString();
  return {
    source: {
      settings: siteResponse.siteConfiguration || {},
      locations,
      ingredients: Object.fromEntries(stockItems.map((item) => [item.id, item])),
      products: Object.fromEntries(products.map((item) => [item.id, item])),
      suppliers,
      purchaseOrders,
      stockTakes,
      stocktakeTemplates: templates,
      transfers
    },
    metrics: {
      today: context.today,
      summary,
      ranges: {},
      trends,
      deltas,
      context: {}
    },
    insights,
    siteName,
    loaded: Object.fromEntries(tileKeys.map((key) => [key, true])),
    errors: {},
    isReady: true,
    isSummary: false,
    isDirectTiles: true,
    connection: {
      status: 'live',
      label: 'Live',
      loadedCount: tileKeys.length,
      sourceCount: tileKeys.length,
      lastUpdated: now,
      isReceiving: true
    }
  };
}

function summarizeMovements(movements = []) {
  const totals = {
    grv: 0,
    creditNote: 0,
    sale: 0,
    adjustment: 0,
    stockTake: 0,
    wastage: 0,
    manufacturingWastage: 0
  };

  movements.forEach((movement = {}) => {
    const type = String(movement.movement_type || movement.movementType || '').toLowerCase();
    const value = Number(movement.value_delta ?? movement.valueDelta ?? 0) || 0;
    const metadata = parseJsonObject(movement.metadata_json || movement.metadataJson || movement.metadata);
    const isAdjustmentWastage = type.includes('adjust') && isWastageAdjustment(metadata);
    if (type.includes('grv') || type.includes('goods')) totals.grv += value;
    else if (type.includes('credit')) totals.creditNote += value;
    else if (type.includes('sale')) totals.sale += value;
    else if (type.includes('stock_take') || type.includes('stocktake')) totals.stockTake += value;
    else if (type.includes('waste')) totals.wastage += value;
    else if (type.includes('manufact')) totals.manufacturingWastage += value;
    else if (isAdjustmentWastage) totals.wastage += value;
    else if (type.includes('adjust')) totals.adjustment += value;
  });

  return totals;
}

function normalizeMetricMap(source = {}) {
  return Object.fromEntries(
    Object.entries(source && typeof source === 'object' ? source : {})
      .map(([key, value]) => [key, normalizeMetricValue(value)])
      .filter(([, value]) => value)
  );
}

function normalizeMetricValue(value) {
  if (value && typeof value === 'object') {
    const raw = numberValue(value.raw ?? value.value, 0);
    const type = value.type || 'number';
    return {
      ...value,
      raw,
      type,
      value: typeof value.value === 'string' ? value.value : formatMetric(raw, type)
    };
  }
  if (value === undefined || value === null || value === '') return null;
  return metricValue(value, 'number');
}

function normalizeAbsoluteMetric(metric, fallback = 0) {
  const normalized = normalizeMetricValue(metric);
  if (normalized) return { ...normalized, raw: Math.abs(Number(normalized.raw || 0)), value: formatMetric(Math.abs(Number(normalized.raw || 0)), normalized.type || 'currency') };
  return metricValue(Math.abs(numberValue(fallback, 0)), 'currency');
}

function normalizeStockItem(row = {}) {
  const balances = parseJsonObject(row.balances_json || row.balancesJson || row.balances);
  const stock = numberValue(row.on_hand ?? row.stock ?? row.onHand, sumObjectValues(balances));
  return {
    ...row,
    id: String(row.id || '').trim(),
    name: row.name || '',
    category: row.category || 'General',
    unit: row.unit || 'ea',
    stock,
    onHand: stock,
    balances,
    cost: numberValue(row.unit_cost ?? row.cost ?? row.costEx, 0),
    costEx: numberValue(row.unit_cost ?? row.cost ?? row.costEx, 0),
    lowStockThreshold: numberValue(row.threshold_qty ?? row.lowStockThreshold, 5),
    thresholdQty: numberValue(row.threshold_qty ?? row.lowStockThreshold, 5)
  };
}

function normalizeLocations(rows = []) {
  return (rows || []).map((row) => {
    const id = String(row.id || row.locationId || '').trim();
    const name = String(row.display_name || row.displayName || row.name || row.external_name || id).trim();
    return {
      id,
      locationId: id,
      name,
      displayName: name,
      type: String(row.kind || row.type || 'selling').trim() || 'selling',
      active: row.active !== false && Number(row.active ?? 1) !== 0,
      isDefault: Number(row.is_default || row.isDefault || 0) === 1
    };
  }).filter((location) => location.id);
}

function buildLowStockRows(stockItems = [], locations = []) {
  const locationMap = new Map(locations.map((location) => [String(location.id), location]));
  const rows = [];

  stockItems.filter((item) => item.isStocked !== false).forEach((item) => {
    const threshold = numberValue(item.lowStockThreshold ?? item.thresholdQty, 5);
    const balances = parseJsonObject(item.balances);
    const balanceEntries = Object.entries(balances);
    if (balanceEntries.length) {
      balanceEntries.forEach(([locationId, quantity]) => {
        const stock = Number(quantity || 0) || 0;
        if (stock > threshold) return;
        const location = locationMap.get(String(locationId));
        rows.push({
          id: `${item.id}:${locationId}`,
          itemId: item.id,
          name: item.name,
          item: item.name,
          category: item.category,
          locationId,
          locationName: location?.displayName || location?.name || 'Workspace',
          currentStock: stock,
          threshold,
          unit: item.unit,
          severity: stock <= 0 ? 'Critical' : 'Medium',
          deficitValue: Math.max(0, threshold - stock) * numberValue(item.costEx ?? item.cost, 0)
        });
      });
      return;
    }

    if (Number(item.stock || 0) <= threshold) {
      rows.push({
        id: item.id,
        itemId: item.id,
        name: item.name,
        item: item.name,
        category: item.category,
        locationId: '',
        locationName: 'Workspace',
        currentStock: Number(item.stock || 0),
        threshold,
        unit: item.unit,
        severity: Number(item.stock || 0) <= 0 ? 'Critical' : 'Medium',
        deficitValue: Math.max(0, threshold - Number(item.stock || 0)) * numberValue(item.costEx ?? item.cost, 0)
      });
    }
  });

  return rows;
}

function isMainMenuProduct(product = {}) {
  const id = String(product.id || '').trim().toLowerCase();
  const category = String(product.category || '').trim().toLowerCase();
  const ownerType = String(product.recipeOwnerType || product.ownerType || '').trim().toLowerCase();
  const source = String(product.source || product.recipeSource || '').trim().toLowerCase();
  return product?.active !== false &&
    product?.archived !== true &&
    product?.deleted !== true &&
    String(product.catalogueStatus || '').toLowerCase() !== 'archived' &&
    !id.startsWith('modifier:') &&
    ownerType !== 'yoco_modifier' &&
    !category.startsWith('modifier -') &&
    !source.includes('yoco modifier');
}

function uniqueLowStockItemCount(rows = []) {
  const keys = new Set();
  toArray(rows).forEach((row) => {
    const key = String(row.itemId || row.stockItemId || row.id || row.name || row.item || '').split(':')[0].trim();
    if (key) keys.add(key);
  });
  return keys.size;
}

function calculateAverageGp(products = [], stockItems = []) {
  const ingredientMap = new Map(stockItems.map((item) => [String(item.id), item]));
  let gpTotal = 0;
  let gpCount = 0;

  products.forEach((product = {}) => {
    const sellingPrice = Number(product.sellingPrice ?? product.price ?? 0) || 0;
    if (!(sellingPrice > 0)) return;
	    const recipeCost = getEffectiveProductRecipe(product).reduce((sum, line) => {
      const ingredientId = String(line.ingId || line.stockItemId || line.stock_item_id || '').trim();
      const ingredient = ingredientMap.get(ingredientId);
      return sum + (Number(line.qty ?? line.quantity ?? 0) || 0) * numberValue(ingredient?.costEx ?? ingredient?.cost, 0);
    }, 0);
    gpTotal += ((sellingPrice - recipeCost) / sellingPrice) * 100;
    gpCount += 1;
  });

  return gpCount ? gpTotal / gpCount : 0;
}

function buildPendingExternalTransferRows(transfers = []) {
  return transfers
    .filter((transfer) => transfer?.status === 'pending_receipt' || transfer?.status === 'pending')
    .map((transfer) => ({
      id: transfer.id || transfer.transferId || '',
      transferId: transfer.transferId || transfer.id || '',
      fromSiteName: transfer.fromSiteName || transfer.from_location_name || 'Sending site',
      fromLocationName: transfer.fromLocationName || transfer.from_location_name || '',
      toLocationName: transfer.toLocationName || transfer.to_location_name || '',
      lineCount: Number(transfer.lineCount || toArray(transfer.items).length || 0) || 0,
      createdAt: transfer.createdAt || transfer.occurred_at || transfer.timestamp || ''
    }));
}

function buildRecentActivity({ transfers = [], stockTakes = [], purchaseOrders = [] } = {}) {
  const rows = [
    ...transfers.map((transfer) => ({
      id: transfer.id || transfer.transferId,
      type: 'transfer',
      title: transfer.status === 'pending_receipt' ? 'External Transfer Awaiting Receipt' : 'Transfer Posted',
      location: transfer.toLocationName || transfer.fromLocationName || 'Workspace activity',
      timestamp: transfer.createdAt || transfer.occurred_at || transfer.timestamp || ''
    })),
    ...stockTakes.map((take) => ({
      id: take.id,
      type: 'stocktake',
      title: 'Stock Count Completed',
      location: take.locationName || 'Workspace activity',
      timestamp: take.completedAt || take.createdAt || ''
    })),
    ...purchaseOrders.map((po) => ({
      id: po.id,
      type: 'purchase-order',
      title: 'Purchase Order Updated',
      location: po.supplierName || 'Workspace activity',
      timestamp: po.updatedAt || po.createdAt || ''
    }))
  ];

  return rows
    .filter((row) => row.id)
    .sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0))
    .slice(0, 8);
}

function isOpenPurchaseOrder(po = {}) {
  const status = String(po.status || '').toLowerCase();
  return !['closed', 'complete', 'completed', 'cancelled', 'archived'].includes(status);
}

function isPendingGrvPurchaseOrder(po = {}) {
  const status = String(po.status || po.grvStatus || '').toLowerCase();
  return status.includes('pending') || status.includes('open') || status === 'ordered';
}

function isOpenStockTake(take = {}) {
  const status = String(take.status || '').toLowerCase();
  return !['posted', 'complete', 'completed', 'closed', 'cancelled', 'canceled', 'deleted', 'archived'].includes(status);
}

function metricValue(raw, type) {
  return {
    raw: Number(raw || 0) || 0,
    type,
    value: formatMetric(raw, type)
  };
}

function formatMetric(raw, type) {
  const value = Number(raw || 0) || 0;
  if (type === 'currency') {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(value);
  }
  if (type === 'percent') return `${value.toFixed(1)}%`;
  return new Intl.NumberFormat('en-ZA').format(value);
}

function resolveDashboardRangeContext(range = 'today') {
  const text = String(range || 'today');
  if (text === 'today') {
    const endDate = isoToday();
    return { startDate: endDate, endDate, today: endDate };
  }

  const customMatch = text.match(/^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
  if (customMatch) {
    const startDate = customMatch[1] <= customMatch[2] ? customMatch[1] : customMatch[2];
    const endDate = customMatch[1] <= customMatch[2] ? customMatch[2] : customMatch[1];
    return { startDate, endDate, today: endDate };
  }

  const days = text === '30' ? 30 : 7;
  const endDate = isoToday();
  const startDate = addDays(endDate, -(days - 1));
  return { startDate, endDate, today: endDate };
}

function addDays(dateKey, delta) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + Number(delta || 0));
  return date.toISOString().slice(0, 10);
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

// Map the worker's daily movementSeries into the chart's trend shape:
// { metricKey: { [rangeKey]: [{ value, label }] } }. The series always reflects the
// currently-fetched range, so it's stored under that range key (chart falls back to
// whatever key is present).
function buildMovementTrends(series, rangeKey = '7') {
  if (!series || !Array.isArray(series.labels)) return {};
  const labels = series.labels.map((label) => String(label || '').slice(5)); // MM-DD
  const toSeries = (values) => (Array.isArray(values) ? values : [])
    .map((value, index) => ({ value: numberValue(value, 0), label: labels[index] || '' }));
  const combinedWastageSeries = mergeNumericSeries(series.wastage, series.manufacturingWastage);
  return {
    stockValue: { [rangeKey]: toSeries(series.stockValue) },
    costOfSales: { [rangeKey]: toSeries(series.costOfSales) },
    wastage: { [rangeKey]: toSeries(combinedWastageSeries) },
    manufacturingWastage: { [rangeKey]: toSeries(series.manufacturingWastage) }
  };
}

function mergeNumericSeries(left = [], right = []) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  const size = Math.max(a.length, b.length);
  return Array.from({ length: size }, (_, index) => numberValue(a[index], 0) + numberValue(b[index], 0));
}

function seriesDeltaPct(values) {
  const arr = (Array.isArray(values) ? values : []).map((value) => numberValue(value, 0));
  if (arr.length < 2) return null;
  const first = arr[0];
  const last = arr[arr.length - 1];
  if (!first) return null;
  return ((last - first) / Math.abs(first)) * 100;
}

// One row per stock item, keeping the worst (largest) deficit.
function collapseLowStockRows(rows = []) {
  const byItem = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const itemId = String(row.itemId || row._id || row.id || row.name || '').split(':')[0];
    const key = itemId || String(row.name || row.Item || '');
    if (!key) continue;
    const deficit = numberValue(row.deficitValue ?? row['Deficit Value'], 0);
    const existing = byItem.get(key);
    if (!existing || deficit > numberValue(existing.deficitValue ?? existing['Deficit Value'], 0)) {
      byItem.set(key, row);
    }
  }
  return [...byItem.values()].sort((a, b) => (
    numberValue(b.deficitValue ?? b['Deficit Value'], 0) - numberValue(a.deficitValue ?? a['Deficit Value'], 0)
  ));
}

function sumStockValue(stockItems = []) {
  return stockItems
    .filter((item) => item.isStocked !== false)
    .reduce((total, item) => total + Number(item.stock || 0) * numberValue(item.costEx ?? item.cost, 0), 0);
}

function getEffectiveProductRecipe(product = {}) {
  const directRecipe = toArray(product.recipe);
  if (directRecipe.length) return directRecipe;
  return toArray(product.effectiveRecipe || product.effectiveRecipeLines || product.recipeSourceRecipeLines || product.recipeSourceStockItem?.recipe || []);
}

function parseJsonObject(value = {}) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sumObjectValues(value = {}) {
  return Object.values(parseJsonObject(value)).reduce((sum, entry) => sum + Number(entry || 0), 0);
}

function toArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : value && typeof value === 'object' ? Object.values(value).filter(Boolean) : [];
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
