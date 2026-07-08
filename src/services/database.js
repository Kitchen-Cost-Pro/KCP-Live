import { callCloudflareWorkspaceRoute, callOptionalCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { normalizeAdjustmentLogs, normalizeWastageResponse } from './adjustmentLog.js';
import { normalizeSites, normalizeStockLocations } from './locationModel.js';
import { isWastageAdjustment } from './wastageClassifier.js';
import { getManufacturingWastageValue, normalizeManufacturingLogs } from './manufacturingLog.js';

const DASHBOARD_LOG_LIMIT = 2000;
const DASHBOARD_ENTITY_LIMIT = 200;

const dashboardNodes = [
  { key: 'settings', path: 'settings', fallback: {} },
  { key: 'sites', path: 'sites', fallback: [], limit: DASHBOARD_ENTITY_LIMIT },
  { key: 'locations', path: 'locations', fallback: [], limit: DASHBOARD_ENTITY_LIMIT },
  { key: 'ingredients', path: 'ingredients', fallback: [], limit: DASHBOARD_ENTITY_LIMIT },
  { key: 'products', path: 'products', fallback: {}, limit: DASHBOARD_ENTITY_LIMIT },
  { key: 'suppliers', path: 'suppliers', fallback: [], limit: DASHBOARD_ENTITY_LIMIT },
  { key: 'purchaseOrders', path: 'purchaseOrders', fallback: [], limit: DASHBOARD_ENTITY_LIMIT },
  { key: 'stockTakes', path: 'stockTakes', fallback: [], limit: DASHBOARD_ENTITY_LIMIT },
  { key: 'stockTakeTemplates', path: 'stocktakeTemplates', fallback: [], limit: DASHBOARD_ENTITY_LIMIT },
  { key: 'dashboardMetrics', path: 'dashboardMetrics', fallback: {} },
  { key: 'logs_grv', path: 'logs_grv', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_cn', path: 'logs_cn', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_stocktakes', path: 'logs_stocktakes', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_adj', path: 'logs_adj', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_inventory_audit', path: 'logs_inventory_audit', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_transfers', path: 'logs_transfers', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_mfg', path: 'logs_mfg', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_sales', path: 'logs_sales', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_sales_errors', path: 'logs_sales_errors', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'sessionOpeningStock', path: 'sessionOpeningStock', fallback: {}, limit: DASHBOARD_ENTITY_LIMIT },
  { key: 'logs_snapshots', path: 'logs_snapshots', fallback: [], limit: DASHBOARD_LOG_LIMIT }
];

export function getWorkspaceDataPath(workspaceId) {
  const id = String(workspaceId || '').trim();
  if (!id) throw new Error('Workspace id is required.');
  if (id === 'appData' || id === 'appData_legacy' || id === 'ROOT_WORKSPACE') return 'appData';
  return `workspaces/${id}/data`;
}

export function getWorkspaceRootPath(workspaceId) {
  const id = String(workspaceId || '').trim();
  if (!id) throw new Error('Workspace id is required.');
  if (id === 'appData' || id === 'appData_legacy' || id === 'ROOT_WORKSPACE') return 'appData';
  return `workspaces/${id}`;
}

export function resolveWorkspaceOptions(profile = {}) {
  const workspaces = profile?.workspaces || {};
  const entries = Object.entries(workspaces).map(([id, info]) => ({
    id,
    role: info?.role || profile?.role || 'member',
    siteName: info?.siteName || profile?.siteName || id
  }));

  if (!entries.length && profile?.workspaceId) {
    entries.push({
      id: profile.workspaceId,
      role: profile.role || 'member',
      siteName: profile.siteName || profile.workspaceId
    });
  }

  return entries.sort((a, b) => a.siteName.localeCompare(b.siteName));
}

export async function resolveActiveWorkspaceOptions(profile = {}) {
  return resolveWorkspaceOptions(profile);
}

export async function getWorkspaceSettings(workspaceId) {
  const response = await callCloudflareWorkspaceRoute(workspaceId, 'settings');
  return response.settings || {};
}

export async function getDashboardSourceOnce(workspaceId) {
  return fetchCloudflareDashboardSource(workspaceId);
}

export async function getDashboardSummaryOnce(workspaceId) {
  const source = await getDashboardSourceOnce(workspaceId);
  const metrics = calculateDashboardMetrics(source);
  return {
    metrics,
    loaded: Object.fromEntries(dashboardNodes.map((node) => [node.key, true])),
    errors: {},
    isReady: true,
    isSummary: true,
    calculatedAt: new Date().toISOString(),
    sourceCount: dashboardNodes.length
  };
}

export async function getConversionStats(workspaceId) {
  const source = await getDashboardSourceOnce(workspaceId);
  return calculateDashboardMetrics(source).summary;
}

export async function getLiveLogs(workspaceId) {
  const source = await getDashboardSourceOnce(workspaceId);
  return [
    ...toArray(source.logs_grv).map((entry) => ({ ...entry, type: 'GRV' })),
    ...toArray(source.logs_cn).map((entry) => ({ ...entry, type: 'CN' })),
    ...toArray(source.logs_adj).map((entry) => ({ ...entry, type: 'ADJ' })),
    ...toArray(source.logs_stocktakes).map((entry) => ({ ...entry, type: 'STOCKTAKE' })),
    ...toArray(source.logs_transfers).map((entry) => ({ ...entry, type: 'TRANSFER' })),
    ...toArray(source.logs_mfg).map((entry) => ({ ...entry, type: 'MFG' })),
    ...toArray(source.logs_sales).map((entry) => ({ ...entry, type: 'SALE' }))
  ].sort((a, b) => String(b.timestamp || b.date || '').localeCompare(String(a.timestamp || a.date || '')));
}

export function subscribeDashboardSource(workspaceId, { onData, onError, nodes = null } = {}) {
  const selectedNodes = resolveDashboardNodes(nodes);
  let closed = false;
  const errors = {};

  const load = async () => {
    try {
      const source = await getDashboardSourceOnce(workspaceId);
      if (closed) return;
      const metrics = calculateDashboardMetrics(source);
      onData?.({
        source,
        metrics,
        loaded: Object.fromEntries(selectedNodes.map((node) => [node.key, true])),
        errors,
        isReady: true
      });
    } catch (error) {
      if (closed) return;
      errors.live = error;
      onError?.(error, 'live');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export function subscribeDashboardSummary(workspaceId, { onData, onError } = {}) {
  return subscribeCloudflareValue(
    () => getDashboardSummaryOnce(workspaceId),
    (value) => value && onData?.(value),
    (error) => onError?.(error, 'dashboardSummary')
  );
}

export function subscribeDashboardLiveState(workspaceId, { onData, onError } = {}) {
  return subscribeCloudflareValue(
    () => getDashboardSummaryOnce(workspaceId),
    (value) => value && onData?.(value),
    (error) => onError?.(error, 'dashboard_live_state')
  );
}

async function fetchCloudflareDashboardSource(workspaceId) {
  const [
    settingsResponse,
    locationResponse,
    stockItems,
    productResponse,
    supplierResponse,
    purchaseOrderResponse,
    grvResponse,
    creditNoteResponse,
    adjustmentResponse,
    wastageResponse,
    stockTakeResponse,
    stockTakeTemplateResponse,
    manufacturingResponse,
    transferResponse,
    dashboardResponse,
    reportingResponse
  ] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceId, 'settings'),
    callCloudflareWorkspaceRoute(workspaceId, 'locations'),
    fetchAllCloudflareRows(workspaceId, 'stock-items', 'stockItems', 200),
    callCloudflareWorkspaceRoute(workspaceId, 'products', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'suppliers', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'purchase-orders', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'grvs', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'credit-notes', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'adjustments', { query: { limit: 500 } }),
    callOptionalCloudflareWorkspaceRoute(workspaceId, 'wastage-adjustments', { query: { limit: 500 }, fallback: {} }),
    callCloudflareWorkspaceRoute(workspaceId, 'stock-takes', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'stock-take-templates', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'manufacturing-batches', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'transfers', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceId, 'dashboard'),
    callCloudflareWorkspaceRoute(workspaceId, 'reporting-source', { query: { limit: DASHBOARD_LOG_LIMIT } })
  ]);

  return normalizeDashboardSource({
    settings: settingsResponse.settings || {},
    sites: [],
    locations: locationResponse.locations || [],
    ingredients: normalizeCloudflareStockItems(stockItems),
    products: Object.fromEntries(toArray(productResponse.products || productResponse.items).map((item) => [String(item.id), item])),
    suppliers: supplierResponse.suppliers || supplierResponse.items || [],
    purchaseOrders: purchaseOrderResponse.orders || purchaseOrderResponse.purchaseOrders || purchaseOrderResponse.items || [],
    stockTakes: stockTakeResponse.stockTakes || stockTakeResponse.items || [],
    stockTakeTemplates: stockTakeTemplateResponse.templates || stockTakeTemplateResponse.stockTakeTemplates || stockTakeTemplateResponse.items || [],
    dashboardMetrics: dashboardResponse.valuation || {},
    logs_grv: grvResponse.receipts || grvResponse.grvs || [],
    logs_cn: creditNoteResponse.creditNotes || creditNoteResponse.items || [],
    logs_adj: normalizeAdjustmentLogs([
      ...(adjustmentResponse.adjustments || adjustmentResponse.items || []),
      ...normalizeWastageResponse(wastageResponse)
    ]),
    logs_stocktakes: stockTakeResponse.stockTakes || stockTakeResponse.items || [],
    logs_inventory_audit: reportingResponse.logs_inventory_audit || [],
    logs_mfg: manufacturingResponse.batches || manufacturingResponse.manufacturingBatches || manufacturingResponse.items || [],
    logs_transfers: [
      ...(transferResponse.transfers || []),
      ...(transferResponse.externalTransfers || [])
    ],
    logs_sales: reportingResponse.logs_sales || [],
    logs_sales_errors: reportingResponse.logs_sales_errors || [],
    logs_snapshots: [],
    sessionOpeningStock: {}
  });
}

async function fetchAllCloudflareRows(workspaceId, resource, key, limit = 500) {
  const rows = [];
  let offset = 0;
  while (true) {
    const response = await callCloudflareWorkspaceRoute(workspaceId, resource, {
      query: { limit, offset }
    });
    const pageRows = toArray(response[key] || response.items);
    rows.push(...pageRows);
    if (pageRows.length < limit) break;
    offset += limit;
  }
  return rows;
}

function subscribeCloudflareValue(loader, onValue, onError) {
  let closed = false;
  const load = async () => {
    try {
      const value = await loader();
      if (!closed) onValue(value);
    } catch (error) {
      if (!closed) onError?.(error);
    }
  };
  load();
  return () => {
    closed = true;
  };
}

function normalizeCloudflareStockItems(items = []) {
  return toArray(items).map((item) => {
    const balances = parseJsonObject(item.balances_json || item.balancesJson || item.balances);
    const stock = Object.values(balances).reduce((sum, value) => sum + Number(value || 0), 0);
    return {
      ...item,
      id: String(item.id || ''),
      name: item.name || '',
      category: item.category || 'General',
      unit: item.unit || 'ea',
      cost: Number(item.unit_cost ?? item.cost ?? item.costEx ?? 0),
      costEx: Number(item.unit_cost ?? item.cost ?? item.costEx ?? 0),
      stock: Object.keys(balances).length ? stock : Number(item.on_hand ?? item.stock ?? 0),
      balances,
      lowStockThreshold: Number(item.threshold_qty ?? item.lowStockThreshold ?? 5),
      thresholdQty: Number(item.threshold_qty ?? item.lowStockThreshold ?? 5)
    };
  });
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapDashboardLiveStateValue(value) {
  if (!value?.summary) return null;
  const sourceCount = Number(value.sourceCount || 1) || 1;
  return {
    metrics: {
      today: value.today || '',
      summary: value.summary || {},
      ranges: value.ranges || {},
      trends: value.trends || {},
      context: value.context || {}
    },
    insights: value.insights || {},
    siteName: value.siteName || '',
    loaded: { dashboard_live_state: true },
    errors: {},
    isReady: true,
    isSummary: true,
    isLiveState: true,
    calculatedAt: value.calculatedAt || '',
    sourceCount
  };
}

function mapDashboardSummaryValue(value) {
  if (!value?.metrics?.summary) return null;
  return {
    metrics: value.metrics,
    loaded: Object.fromEntries(dashboardNodes.map((node) => [node.key, true])),
    errors: {},
    isReady: true,
    isSummary: true,
    calculatedAt: value.calculatedAt || '',
    sourceCount: Number(value.sourceCount || dashboardNodes.length) || dashboardNodes.length
  };
}

function resolveDashboardNodes(keys) {
  if (!Array.isArray(keys) || !keys.length) return dashboardNodes;
  const requested = new Set(keys.map((key) => String(key || '').trim()).filter(Boolean));
  return dashboardNodes.filter((node) => requested.has(node.key));
}

function createEmptyDashboardSource(nodes = dashboardNodes) {
  return Object.fromEntries(nodes.map((node) => [node.key, node.fallback]));
}

function normalizeNodeValue(key, value, fallback) {
  if (value === null || value === undefined) return structuredCloneSafe(fallback);
  if (
    key.startsWith('logs_') ||
    ['sites', 'locations', 'ingredients', 'suppliers', 'purchaseOrders', 'stockTakes', 'stockTakeTemplates'].includes(key)
  ) return toArray(value);
  return value;
}

function normalizeDashboardSource(source) {
  const ingredients = normalizeIngredients(toArray(source.ingredients));
  const sites = normalizeSites(source.sites, source.settings || {});
  const locations = normalizeStockLocations(source.locations, sites, source.settings || {});
  return {
    settings: source.settings || {},
    sites,
    locations,
    ingredients,
    suppliers: toArray(source.suppliers),
    purchaseOrders: toArray(source.purchaseOrders),
    stockTakes: toArray(source.stockTakes),
    stockTakeTemplates: toArray(source.stockTakeTemplates),
    products: source.products || {},
    dashboardMetrics: source.dashboardMetrics || {},
    logs_grv: toArray(source.logs_grv),
    logs_cn: toArray(source.logs_cn),
    logs_stocktakes: toArray(source.logs_stocktakes),
    logs_adj: normalizeAdjustmentLogs(source.logs_adj),
    logs_inventory_audit: toArray(source.logs_inventory_audit),
    logs_transfers: toArray(source.logs_transfers),
    logs_mfg: normalizeManufacturingLogs(source.logs_mfg),
    logs_sales: toArray(source.logs_sales),
    logs_sales_errors: toArray(source.logs_sales_errors),
    sessionOpeningStock: source.sessionOpeningStock || {},
    logs_snapshots: toArray(source.logs_snapshots)
      .sort((a, b) => String(a?.date || a?.timestamp || '').localeCompare(String(b?.date || b?.timestamp || '')))
  };
}

function normalizeIngredients(ingredients) {
  return ingredients.map((ingredient) => {
    const balances = ingredient?.balances && typeof ingredient.balances === 'object' ? ingredient.balances : null;
    const stockFromBalances = balances
      ? Object.values(balances).reduce((sum, value) => sum + (Number(value) || 0), 0)
      : Number(ingredient?.stock || 0);
    return {
      ...ingredient,
      stock: stockFromBalances
    };
  });
}

export function calculateDashboardMetrics(source, dateKey = isoToday()) {
  const today = dateKey || getTradeDateKey(new Date(), source?.settings);
  const ingredients = toArray(source.ingredients);
  const products = Object.values(source.products || {});
  const ingredientMap = new Map(ingredients.map((ingredient) => [String(ingredient.id), ingredient]));
  const tradingDay = getTradingDayConfig(source?.settings);

  const currentStockValue = calculateCurrentStockValue(ingredients);

  const lowStockCount = ingredients.filter((ingredient) => {
    const threshold = Number(ingredient.lowStockThreshold || 5);
    return (Number(ingredient.stock) || 0) < threshold;
  }).length;

  let totalGp = 0;
  let gpCount = 0;
  products.forEach((product) => {
    const sellingPrice = Number(product.sellingPrice || 0);
    if (sellingPrice > 0) {
      const recipeCost = calculateRecipeCost(product.recipe || [], ingredientMap);
      totalGp += ((sellingPrice - recipeCost) / sellingPrice) * 100;
      gpCount += 1;
    }
  });
  const averageGp = gpCount > 0 ? totalGp / gpCount : 0;
  const dashboardAverageGp = averageGp;
  const dashboardProductCount = products.length;
  const dashboardLowStockCount = lowStockCount;

  const purchases = sumByDate(source.logs_grv, today, 'totalEx', tradingDay) - sumByDate(source.logs_cn, today, 'totalEx', tradingDay);
  const dailyNetStockChange = calculateDailyNetStockValueChange(source, today, tradingDay);
  const openingStock = resolveOpeningStockValue(source, today, currentStockValue, dailyNetStockChange);
  const closingStock = resolveClosingStockValue(source, today, currentStockValue);
  const stockValue = closingStock;
  const costOfSales = openingStock + purchases - closingStock;

  const countVariance = toArray(source.logs_stocktakes)
    .filter((log) => getLogDate(log, tradingDay) === today)
    .reduce((total, log) => total + toArray(log.items).reduce((sum, item) => {
      return sum + calculateStockTakeItemImpact(item);
    }, 0), 0);

  let manualAdjustments = 0;
  let manualWastage = 0;
  toArray(source.logs_adj)
    .filter((log) => getLogDate(log, tradingDay) === today)
    .forEach((log) => {
      // Derive impactQty × unified cost first; stored impactEx only as fallback.
      const qty = Number(log.impactQty ?? log.qty ?? 0);
      const cost = getStockValuationUnitCost(ingredientMap.get(String(log.stockItemId || log.itemId)) || {});
      const impact = (qty !== 0 && cost > 0) ? qty * cost : Number(log.impactEx || 0);
      if (isWastageAdjustment(log)) manualWastage += Math.abs(impact);
      else manualAdjustments += impact;
    });

  const manufacturingWastage = toArray(source.logs_mfg)
    .filter((log) => getLogDate(log, tradingDay) === today)
    .reduce((total, log) => total + getManufacturingWastageValue(log), 0);

  const wastage = manualWastage + manufacturingWastage;

  return {
    today,
    summary: {
      stockValue: metricValue(stockValue, 'currency'),
      productCount: metricValue(dashboardProductCount, 'number'),
      lowStockCount: metricValue(dashboardLowStockCount, 'number'),
      averageGp: metricValue(dashboardAverageGp, 'percent'),
      purchases: metricValue(purchases, 'currency'),
      openingStock: metricValue(openingStock, 'currency'),
      closingStock: metricValue(closingStock, 'currency'),
      costOfSales: metricValue(costOfSales, 'currency'),
      countVariance: metricValue(countVariance, 'currency', percentOf(countVariance, stockValue)),
      manualAdjustments: metricValue(manualAdjustments, 'currency', percentOf(manualAdjustments, stockValue)),
      wastage: metricValue(wastage, 'currency', percentOf(wastage, stockValue)),
      manufacturingWastage: metricValue(manufacturingWastage, 'currency', percentOf(manufacturingWastage, stockValue))
    }
  };
}

function calculateCurrentStockValue(ingredients = []) {
  return ingredients.reduce((sum, ingredient) => {
    const unitCost = getStockValuationUnitCost(ingredient);
    return sum + unitCost * (Number(ingredient.stock) || 0);
  }, 0);
}

function resolveOpeningStockValue(source, dateKey, currentStockValue, dailyNetStockChange = null) {
  const storedOpening = getSessionOpeningStockValue(source, dateKey);
  const movement = dailyNetStockChange === null
    ? calculateDailyNetStockValueChange(source, dateKey)
    : Number(dailyNetStockChange || 0);
  let derivedOpening;
  if (dateKey === getTradeDateKey(new Date(), source?.settings)) {
    derivedOpening = (Number(currentStockValue || 0) || 0) - movement;
  } else {
    const previousTradeDate = addDays(dateKey, -1);
    derivedOpening = resolveClosingStockValue(source, previousTradeDate, currentStockValue);
  }

  if (
    storedOpening !== null &&
    isStoredOpeningConsistent(source, dateKey, storedOpening, currentStockValue, movement)
  ) {
    return storedOpening;
  }

  return derivedOpening;
}

function isStoredOpeningConsistent(source, dateKey, storedOpening, currentStockValue, dailyNetStockChange) {
  const closingStock = resolveClosingStockValue(source, dateKey, currentStockValue);
  const expectedClosing = Number(storedOpening || 0) + Number(dailyNetStockChange || 0);
  const tolerance = Math.max(1, Math.abs(Number(closingStock || 0)) * 0.005);
  return Math.abs(expectedClosing - Number(closingStock || 0)) <= tolerance;
}

function resolveClosingStockValue(source, dateKey, currentStockValue) {
  const sameDaySnapshot = findSnapshotForDate(source.logs_snapshots, dateKey);
  if (sameDaySnapshot) return Number(sameDaySnapshot.value || 0) || 0;

  if (dateKey === getTradeDateKey(new Date(), source?.settings)) return Number(currentStockValue || 0) || 0;

  return deriveClosingStockValueFromMovements(source, dateKey, currentStockValue);
}

function deriveClosingStockValueFromMovements(source, dateKey, currentStockValue) {
  const target = String(dateKey || '').trim();
  const tradingDay = getTradingDayConfig(source?.settings);
  const today = getTradeDateKey(new Date(), source?.settings);
  const liveValue = Number(currentStockValue || 0) || 0;
  if (!target) return liveValue;
  if (target >= today) return liveValue;

  const movementAfterTarget = enumerateDates(addDays(target, 1), today).reduce((sum, date) => {
    return sum + calculateDailyNetStockValueChange(source, date, tradingDay);
  }, 0);

  return liveValue - movementAfterTarget;
}

function calculateDailyNetStockValueChange(source, dateKey, tradingDay = getTradingDayConfig(source?.settings)) {
  const date = String(dateKey || '').trim();
  if (!date) return 0;

  // Ingredient valuation map (unified last-purchase cost) so every delta can be
  // derived from qty × cost rather than trusting stored impactEx (stale/corrupt).
  const ingredientMap = new Map(toArray(source.ingredients).map((ingredient) => [String(ingredient.id), ingredient]));
  const unitCostFor = (id) => getStockValuationUnitCost(ingredientMap.get(String(id)) || {});

  const purchases = sumByDate(source.logs_grv, date, 'totalEx', tradingDay) - sumByDate(source.logs_cn, date, 'totalEx', tradingDay);

  const adjustmentDelta = toArray(source.logs_adj)
    .filter((log) => getLogDate(log, tradingDay) === date)
    .reduce((total, log) => {
      // Signed: derive impactQty × unified cost first; stored impactEx fallback.
      const qty = Number(log.impactQty ?? log.qty ?? 0);
      const cost = unitCostFor(log.stockItemId || log.itemId);
      const derived = (qty !== 0 && cost > 0) ? qty * cost : Number(log.impactEx || 0);
      return total + (Number.isFinite(derived) ? derived : 0);
    }, 0);

  const stockTakeDelta = toArray(source.logs_stocktakes)
    .filter((log) => getLogDate(log, tradingDay) === date)
    .reduce((total, log) => total + toArray(log.items).reduce((sum, item) => {
      // calculateStockTakeItemImpact now derives variance × cost first.
      return sum + calculateStockTakeItemImpact(item);
    }, 0), 0);

  const manufacturingDelta = toArray(source.logs_mfg)
    .filter((log) => getLogDate(log, tradingDay) === date)
    .reduce((total, log) => total - getManufacturingWastageValue(log), 0);

  const salesDelta = toArray(source.logs_sales)
    .filter((log) => getLogDate(log, tradingDay) === date)
    .reduce((total, log) => {
      return total + toArray(log.details).reduce((sum, detail) => {
        // A sale depletes stock, so it REDUCES stock value: −(qty × unified cost).
        // Derive first; only trust a stored impact when we can't compute one.
        const qty = Math.abs(Number(detail.qtyDepleted ?? detail.depletedQty ?? detail.impactQty ?? detail.qty ?? detail.quantity ?? 0));
        const cost = unitCostFor(detail.ingredientId ?? detail.ingId ?? detail.stockItemId ?? detail.itemId ?? detail.id);
        if (qty > 0 && cost > 0) return sum - (qty * cost);
        if (Number.isFinite(Number(detail.impactEx))) return sum + (Number(detail.impactEx) || 0);
        if (Number.isFinite(Number(detail.impact))) return sum + (Number(detail.impact) || 0);
        return sum;
      }, 0);
    }, 0);

  return purchases + adjustmentDelta + stockTakeDelta + manufacturingDelta + salesDelta;
}

function getSessionOpeningStockValue(source, dateKey) {
  const openings = source?.sessionOpeningStock;
  if (!openings || typeof openings !== 'object') return null;
  const value = openings[String(dateKey || '')];
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function calculateStockTakeItemImpact(item = {}) {
  // Derive variance × cost first; stored varianceImpactEx only as fallback.
  const variance = Number(item.variance || 0) || 0;
  const cost = Number(item.cost ?? item.unitCost ?? 0) || 0;
  if (variance !== 0 && cost > 0) return variance * cost;
  if (Number.isFinite(Number(item.varianceImpactEx))) return Number(item.varianceImpactEx || 0);
  return variance * cost;
}

export function calculateRecipeCost(recipe, ingredientMap, seen = new Set()) {
  return toArray(recipe).reduce((total, item) => {
    return total + getIngredientUnitCost(item.ingId, ingredientMap, new Set(seen)) * (Number(item.qty) || 0);
  }, 0);
}

export function getIngredientUnitCost(ingredientId, ingredientMap, seen = new Set()) {
  const ingredient = ingredientMap.get(String(ingredientId));
  if (!ingredient) return 0;

  const key = String(ingredient.id);
  if (seen.has(key)) return 0;
  seen.add(key);

  const baseCost = getStockValuationUnitCost(ingredient);
  const recipe = toArray(ingredient.recipe);
  const isManufactured = ingredient.isManufactured === true ||
    String(ingredient.category || '').toLowerCase().includes('manufactured');

  if (isManufactured && recipe.length) {
    const yieldBatch = Number(ingredient.yieldBatch ?? ingredient.yieldQty ?? 1);
    return calculateRecipeCost(recipe, ingredientMap, seen) / (yieldBatch > 0 ? yieldBatch : 1);
  }

  return baseCost;
}

export function getStockValuationUnitCost(ingredient = {}) {
  return Number(
    ingredient.lastPurchasePrice ??
    ingredient.lastPurchaseCost ??
    ingredient.latestPurchasePrice ??
    ingredient.costEx ??
    ingredient.cost ??
    0
  ) || 0;
}

function metricValue(raw, type, ratio = null) {
  return {
    raw,
    type,
    value: formatMetric(raw, type),
    ratio
  };
}

function formatMetric(value, type) {
  const numeric = Number(value || 0);
  if (type === 'currency') {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(numeric);
  }
  if (type === 'percent') return `${numeric.toFixed(1)}%`;
  return new Intl.NumberFormat('en-ZA').format(numeric);
}

function percentOf(value, total) {
  return total ? (Number(value || 0) / Number(total || 0)) * 100 : 0;
}

function sumByDate(logs, date, field, tradingDay = getTradingDayConfig()) {
  return toArray(logs)
    .filter((log) => getLogDate(log, tradingDay) === date)
    .reduce((sum, log) => sum + (Number(log?.[field] || 0)), 0);
}

function findSnapshotForDate(logs, dateKey) {
  return toArray(logs).find((snapshot) => String(snapshot?.date || '') === String(dateKey)) || null;
}

function findLatestSnapshotBefore(logs, dateKey) {
  return toArray(logs)
    .filter((snapshot) => String(snapshot?.date || '') < String(dateKey))
    .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')))[0] || null;
}

function findEarliestSnapshotAfter(logs, dateKey) {
  return toArray(logs)
    .filter((snapshot) => String(snapshot?.date || '') > String(dateKey))
    .sort((left, right) => String(left.date || '').localeCompare(String(right.date || '')))[0] || null;
}

function getLogDate(log, tradingDay = getTradingDayConfig()) {
  const timestamp = getTimestampValue(log?.timestamp ?? log?.createdAt ?? log?.updatedAt ?? log?.modifiedAt);
  if (timestamp) {
    return getTradeDateKey(new Date(timestamp), tradingDay);
  }
  return String(log?.date || '').trim();
}

function getTimestampValue(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value < 10000000000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === 'object' && typeof value.seconds === 'number') {
    return value.seconds * 1000;
  }
  return 0;
}

function normalizeNumberMap(value) {
  if (!value || typeof value !== 'object') return {};
  if (Array.isArray(value)) {
    return value.reduce((out, entry) => {
      if (entry && typeof entry === 'object') {
        Object.entries(entry).forEach(([key, item]) => {
          out[String(key)] = Number(item || 0);
        });
      }
      return out;
    }, {});
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(key), Number(item || 0)]));
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === 'object') return Object.values(value).filter(Boolean);
  return [];
}

function isoToday(date = new Date()) {
  return formatLocalDateKey(date);
}

function formatLocalDateKey(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function getTradingDayConfig(settings = {}) {
  const mode = String(
    settings?.tradingDayMode ??
    settings?.tradeDayMode ??
    settings?.businessDayMode ??
    ''
  ).trim().toLowerCase();

  const candidates = [
    deriveStartHourFromTradingTime(settings?.tradingTime || settings?.tradingEndTime),
    settings?.tradingDayStartHour,
    settings?.tradeDayStartHour,
    settings?.businessDayStartHour,
    settings?.dayStartHour,
    settings?.rolloverHour
  ];

  let startHour = candidates
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value));

  if (!Number.isFinite(startHour)) {
    if (mode.includes('4')) startHour = 4;
    else if (mode.includes('12') || mode.includes('midnight') || mode.includes('calendar')) startHour = 0;
    else startHour = 0;
  }

  startHour = Math.max(0, Math.min(23, Math.round(startHour)));

  return {
    startHour,
    mode: startHour === 0 ? '12-12' : `${startHour}-${startHour}`
  };
}

function deriveStartHourFromTradingTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minutes = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return Math.ceil((hours * 60 + minutes) / 60) % 24;
}

export function getTradeDateKey(date = new Date(), settingsOrConfig = {}) {
  const config = 'startHour' in (settingsOrConfig || {})
    ? settingsOrConfig
    : getTradingDayConfig(settingsOrConfig);
  const shifted = new Date(date.getTime() - (Number(config.startHour || 0) * 60 * 60 * 1000));
  return formatLocalDateKey(shifted);
}

function addDays(dateKey, offset) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  if (!startDate || !endDate) return dates;
  let cursor = startDate;
  let guard = 0;
  while (cursor <= endDate && guard < 400) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return dates;
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}
