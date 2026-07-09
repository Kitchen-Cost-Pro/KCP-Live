const DASHBOARD_LOG_LIMIT = 2000;
const SUMMARY_SCHEMA_VERSION = 2;

const dashboardSummaryNodes = [
  { key: 'settings', path: 'settings', fallback: {} },
  { key: 'locations', path: 'locations', fallback: [] },
  { key: 'ingredients', path: 'ingredients', fallback: [] },
  { key: 'products', path: 'products', fallback: {} },
  { key: 'suppliers', path: 'suppliers', fallback: [] },
  { key: 'purchaseOrders', path: 'purchaseOrders', fallback: [] },
  { key: 'dashboardMetrics', path: 'dashboardMetrics', fallback: {} },
  { key: 'logs_grv', path: 'logs_grv', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_cn', path: 'logs_cn', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_stocktakes', path: 'logs_stocktakes', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_adj', path: 'logs_adj', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_transfers', path: 'logs_transfers', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_mfg', path: 'logs_mfg', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'logs_sales', path: 'logs_sales', fallback: [], limit: DASHBOARD_LOG_LIMIT },
  { key: 'stockTakes', path: 'stockTakes', fallback: [] },
  { key: 'stocktakeTemplates', path: 'stocktakeTemplates', fallback: [] },
  { key: 'sessionOpeningStock', path: 'sessionOpeningStock', fallback: {} },
  { key: 'logs_snapshots', path: 'logs_snapshots', fallback: [], limit: DASHBOARD_LOG_LIMIT }
];

async function rebuildDashboardSummary(admin, dataPath) {
  const rootRef = admin.database().ref(dataPath);
  const entries = await Promise.all(
    dashboardSummaryNodes.map(async (node) => {
      const ref = rootRef.child(node.path);
      const snapshot = node.limit
        ? await ref.limitToLast(node.limit).get()
        : await ref.get();
      return [node.key, normalizeNodeValue(node.key, snapshot.val(), node.fallback)];
    })
  );
  const source = normalizeDashboardSource(Object.fromEntries(entries));
  const now = new Date();
  const currentMetrics = calculateDashboardMetrics(source);
  const rangeMetrics = buildPresetRangeMetrics(source, currentMetrics.today);
  const metrics = {
    ...currentMetrics,
    summary: enrichSummaryWithTrends(source, currentMetrics.today, currentMetrics.summary),
    ranges: rangeMetrics,
    trends: buildTrendSeries(source),
    context: buildDashboardContext(source, now)
  };
  const summary = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    source: 'functions:dashboardSummary',
    calculatedAt: now.toISOString(),
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    metrics,
    loaded: Object.fromEntries(dashboardSummaryNodes.map((node) => [node.key, true])),
    sourceCount: dashboardSummaryNodes.length
  };
  const liveState = buildDashboardLiveState(source, metrics, summary, now);
  const liveStatePath = resolveDashboardLiveStatePath(dataPath);

  await Promise.all([
    rootRef.child('dashboardSummary/current').set(summary),
    admin.database().ref(liveStatePath).set(liveState)
  ]);
  summary.liveStatePath = liveStatePath;
  summary.liveStateCalculatedAt = liveState.calculatedAt;
  return summary;
}

function resolveDashboardLiveStatePath(dataPath = '') {
  const workspaceMatch = String(dataPath || '').match(/^workspaces\/([^/]+)\/data$/);
  if (workspaceMatch?.[1]) {
    return `workspaces/${workspaceMatch[1]}/dashboard_live_state`;
  }
  return 'appData/dashboard_live_state';
}

function buildDashboardLiveState(source, metrics, summaryEnvelope, now = new Date()) {
  const summary = metrics?.summary || {};
  const insights = buildDashboardInsights(source, summary);
  const settings = source?.settings || {};

  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    source: 'functions:dashboardLiveState',
    calculatedAt: summaryEnvelope.calculatedAt || now.toISOString(),
    updatedAt: summaryEnvelope.updatedAt,
    today: metrics?.today || isoToday(now),
    siteName: settings.siteName || settings.workspaceName || '',
    summary,
    ranges: metrics?.ranges || {},
    trends: metrics?.trends || {},
    context: metrics?.context || {},
    insights
  };
}

function buildDashboardInsights(source = {}, summary = {}) {
  const products = Object.values(source.products || {});
  const purchaseOrders = toArray(source.purchaseOrders);
  const stockTakes = toArray(source.stockTakes);
  const stockTakeTemplates = toArray(source.stockTakeTemplates);
  const suppliers = toArray(source.suppliers);
  const lowStockRows = buildLowStockRows(source);

  return {
    lowStockCount: Number(summary.lowStockCount?.raw ?? lowStockRows.length) || 0,
    lowStockRows,
    openPurchaseOrders: purchaseOrders.filter(isOpenPurchaseOrder).length,
    activeSuppliers: suppliers.filter((supplier) => !isArchived(supplier)).length,
    grvsPending: purchaseOrders.filter(isPendingGrvPurchaseOrder).length,
    stockTakesDue: stockTakeTemplates.length || stockTakes.filter(isOpenStockTake).length,
    recipesUpdated: products.filter((product) => toArray(product.recipe).length > 0).length,
    recentActivity: buildRecentActivity(source)
  };
}

function buildLowStockRows(source = {}) {
  const locations = toArray(source.locations);
  return toArray(source.ingredients)
    .filter((item) => !isArchived(item))
    .map((item) => {
      const threshold = Number(item.lowStockThreshold || item.threshold || 5) || 5;
      const stock = Number(item.stock || 0) || 0;
      const severity = getLowStockSeverity(stock, threshold);
      return {
        id: item.id || '',
        name: item.name || item.itemName || 'Unnamed item',
        location: resolveLowStockLocation(item, locations),
        stock,
        threshold,
        severity: severity.label,
        severityTone: severity.tone
      };
    })
    .filter((item) => item.stock < item.threshold)
    .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name))
    .slice(0, 5);
}

function resolveLowStockLocation(item = {}, locations = []) {
  const balances = item.balances && typeof item.balances === 'object' ? item.balances : null;
  if (balances) {
    const lowest = Object.entries(balances)
      .map(([locationId, qty]) => ({ locationId, qty: Number(qty || 0) }))
      .sort((a, b) => a.qty - b.qty)[0];
    if (lowest?.locationId) return getLocationName(locations, lowest.locationId);
  }
  return getLocationName(locations, item.locationId || item.location || item.storeLocationId || '');
}

function getLocationName(locations = [], locationId = '') {
  if (!locationId) return 'Main Kitchen';
  return locations.find((location) => String(location.id) === String(locationId))?.name ||
    locations.find((location) => String(location.name).toLowerCase() === String(locationId).toLowerCase())?.name ||
    locationId ||
    'Main Kitchen';
}

function getLowStockSeverity(stock, threshold) {
  if (stock <= 0 || stock <= threshold * 0.25) return { label: 'Critical', tone: 'critical' };
  if (stock <= threshold * 0.6) return { label: 'Medium', tone: 'medium' };
  return { label: 'Low', tone: 'low' };
}

function buildRecentActivity(source = {}) {
  return [
    ...toArray(source.logs_stocktakes).map((entry) => activityEntry(entry, 'Stock Count Completed', 'variance', 'blue')),
    ...toArray(source.logs_grv).map((entry) => activityEntry(entry, 'GRV Received', 'receipt', 'amber')),
    ...toArray(source.logs_adj).map((entry) => activityEntry(entry, 'Manual Adjustment Added', 'sliders', 'orange')),
    ...toArray(source.logs_sales).map((entry) => activityEntry(entry, 'Sale Synced', 'receipt', 'emerald')),
    ...toArray(source.logs_transfers).map((entry) => activityEntry(entry, 'Transfer Posted', 'cube', 'indigo'))
  ]
    .filter((entry) => entry.stamp > 0)
    .sort((a, b) => b.stamp - a.stamp)
    .slice(0, 5);
}

function activityEntry(entry = {}, fallbackTitle, icon, tone) {
  const stamp = getTimestamp(entry.timestamp || entry.createdAt || entry.updatedAt || entry.date || entry.tradeDate);
  return {
    stamp,
    time: formatActivityTime(stamp),
    title: entry.title || entry.action || entry.type || fallbackTitle,
    detail: entry.locationName || entry.supplierName || entry.itemName || entry.note || entry.reference || 'Workspace activity',
    icon,
    tone
  };
}

function formatActivityTime(stamp) {
  if (!stamp) return '--:--';
  const now = new Date();
  const date = new Date(stamp);
  const isToday = now.toDateString() === date.toDateString();
  if (isToday) {
    return new Intl.DateTimeFormat('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  return new Intl.DateTimeFormat('en-ZA', { day: '2-digit', month: 'short' }).format(date);
}

function isOpenPurchaseOrder(order = {}) {
  const status = String(order.status || order.state || '').trim().toLowerCase();
  return !['closed', 'complete', 'completed', 'cancelled', 'canceled', 'received', 'deleted', 'archived'].includes(status);
}

function isPendingGrvPurchaseOrder(order = {}) {
  const status = String(order.status || order.state || '').trim().toLowerCase();
  return isOpenPurchaseOrder(order) && status !== 'draft';
}

function isOpenStockTake(entry = {}) {
  const status = String(entry.status || entry.state || '').trim().toLowerCase();
  return !['closed', 'complete', 'completed', 'cancelled', 'canceled', 'deleted', 'archived'].includes(status);
}

function isArchived(item = {}) {
  const status = String(item.status || item.state || '').trim().toLowerCase();
  return Boolean(item.archived || item.deleted || item.isDeleted || ['deleted', 'archived', 'inactive'].includes(status));
}

function buildPresetRangeMetrics(source, today = isoToday()) {
  return {
    7: {
      startDate: addDays(today, -6),
      endDate: today,
      summary: enrichRangeSummary(
        buildRangeDashboardSummary(source, addDays(today, -6), today),
        buildRangeDashboardSummary(source, addDays(today, -13), addDays(today, -7))
      )
    },
    30: {
      startDate: addDays(today, -29),
      endDate: today,
      summary: enrichRangeSummary(
        buildRangeDashboardSummary(source, addDays(today, -29), today),
        buildRangeDashboardSummary(source, addDays(today, -59), addDays(today, -30))
      )
    }
  };
}

function buildRangeDashboardSummary(source, startDate, endDate) {
  const dates = enumerateDates(startDate, endDate).slice(0, 92);
  if (!dates.length) return {};

  const dailySummaries = dates.map((date) => calculateDashboardMetrics(source, date).summary || {});
  const firstSummary = dailySummaries[0] || {};
  const lastSummary = dailySummaries[dailySummaries.length - 1] || {};
  const aggregateKeys = ['purchases', 'costOfSales', 'countVariance', 'manualAdjustments', 'wastage'];
  const summary = {
    stockValue: cloneMetric(lastSummary.closingStock || lastSummary.stockValue),
    totalStockValue: cloneMetric(lastSummary.totalStockValue || lastSummary.closingStock || lastSummary.stockValue),
    productCount: cloneMetric(lastSummary.productCount),
    lowStockCount: cloneMetric(lastSummary.lowStockCount),
    averageGp: cloneMetric(lastSummary.averageGp),
    gpPercentage: cloneMetric(lastSummary.gpPercentage || lastSummary.averageGp),
    openingStock: cloneMetric(firstSummary.openingStock),
    closingStock: cloneMetric(lastSummary.closingStock)
  };

  aggregateKeys.forEach((key) => {
    const type = firstSummary[key]?.type || lastSummary[key]?.type || 'currency';
    const raw = dailySummaries.reduce((sum, daySummary) => {
      const metric = daySummary?.[key];
      return sum + Number(metric?.raw || 0);
    }, 0);
    const ratioBase = Number(summary.stockValue?.raw || lastSummary.stockValue?.raw || 0);
    summary[key] = metricValue(raw, type, ratioBase && ['countVariance', 'manualAdjustments', 'wastage'].includes(key)
      ? (raw / ratioBase) * 100
      : null);
  });

  const openingRaw = Number(summary.openingStock?.raw || 0);
  const purchasesRaw = Number(summary.purchases?.raw || 0);
  const closingRaw = Number(summary.closingStock?.raw || 0);
  summary.costOfSales = metricValue(openingRaw + purchasesRaw - closingRaw, 'currency');

  return summary;
}

function enrichRangeSummary(current = {}, previous = {}) {
  const summary = {};

  Object.entries(current || {}).forEach(([key, metric]) => {
    if (!metric) return;
    const previousMetric = previous?.[key] || metric;
    summary[key] = enrichMetric(key, metric, previousMetric);
    summary[key].trend = {
      ...summary[key].trend,
      comparisonText: `${Math.abs(Number(summary[key].trend?.deltaPercent || 0)).toFixed(2)}% vs prior range`,
      contextLabel: 'vs prior range'
    };
  });

  summary.totalStockValue = summary.totalStockValue || summary.stockValue;
  summary.gpPercentage = summary.gpPercentage || summary.averageGp;
  return summary;
}

function cloneMetric(metric) {
  if (!metric) return null;
  return { ...metric };
}

function normalizeNodeValue(key, value, fallback) {
  if (value === null || value === undefined) return structuredCloneSafe(fallback);
  if (
    key.startsWith('logs_') ||
    ['locations', 'ingredients', 'suppliers', 'purchaseOrders', 'stockTakes', 'stocktakeTemplates'].includes(key)
  ) return toArray(value);
  return value;
}

function normalizeDashboardSource(source) {
  const ingredients = normalizeIngredients(toArray(source.ingredients));
  return {
    settings: source.settings || {},
    locations: toArray(source.locations),
    ingredients,
    suppliers: toArray(source.suppliers),
    purchaseOrders: toArray(source.purchaseOrders),
    products: source.products || {},
    dashboardMetrics: source.dashboardMetrics || {},
    logs_grv: toArray(source.logs_grv),
    logs_cn: toArray(source.logs_cn),
    logs_stocktakes: toArray(source.logs_stocktakes),
    logs_adj: toArray(source.logs_adj),
    logs_transfers: toArray(source.logs_transfers),
    logs_mfg: toArray(source.logs_mfg),
    logs_sales: toArray(source.logs_sales),
    stockTakes: toArray(source.stockTakes),
    stockTakeTemplates: toArray(source.stocktakeTemplates),
    sessionOpeningStock: source.sessionOpeningStock || {},
    logs_snapshots: toArray(source.logs_snapshots)
  };
}

function calculateDashboardMetrics(source, dateKey = isoToday()) {
  const today = dateKey || getTradeDateKey(new Date(), source?.settings);
  const ingredients = source.ingredients || [];
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

  const purchases = sumByDate(source.logs_grv, today, 'totalEx', tradingDay) - sumByDate(source.logs_cn, today, 'totalEx', tradingDay);
  const dailyNetStockChange = calculateDailyNetStockValueChange(source, today, tradingDay);
  const openingStock = resolveOpeningStockValue(source, today, currentStockValue, dailyNetStockChange);
  const closingStock = resolveClosingStockValue(source, today, currentStockValue);
  const stockValue = closingStock;
  const costOfSales = openingStock + purchases - closingStock;

  const countVariance = source.logs_stocktakes
    .filter((log) => getLogDate(log, tradingDay) === today)
    .reduce((total, log) => total + toArray(log.items).reduce((sum, item) => {
      return sum + calculateStockTakeItemImpact(item);
    }, 0), 0);

  let manualAdjustments = 0;
  let manualWastage = 0;
  source.logs_adj
    .filter((log) => getLogDate(log, tradingDay) === today)
    .forEach((log) => {
      const qty = Number(log.impactQty ?? log.qty ?? 0);
      const cost = getStockValuationUnitCost(ingredientMap.get(String(log.stockItemId || log.itemId)) || {});
      const impact = (qty !== 0 && cost > 0) ? qty * cost : Number(log.impactEx || 0);
      if (isWastageAdjustment(log)) manualWastage += Math.abs(impact);
      else manualAdjustments += impact;
    });

  const manufacturingWastage = source.logs_mfg
    .filter((log) => getLogDate(log, tradingDay) === today)
    .reduce((total, log) => {
      const variance = Number(log.variance || 0);
      if (!(variance > 0)) return total;
      const expectedQty = Number(log.expectedQty || 1) || 1;
      const unitCost = toArray(log.components).reduce((sum, component) => {
        return sum + ((Number(component.qty || 0) || 0) / expectedQty) * (Number(component.cost || 0) || 0);
      }, 0);
      return total + variance * unitCost;
    }, 0);

  const averageGp = gpCount > 0 ? totalGp / gpCount : 0;
  const summary = {
    stockValue: metricValue(stockValue, 'currency'),
    productCount: metricValue(products.length, 'number'),
    lowStockCount: metricValue(lowStockCount, 'number'),
    averageGp: metricValue(averageGp, 'percent'),
    purchases: metricValue(purchases, 'currency'),
    openingStock: metricValue(openingStock, 'currency'),
    closingStock: metricValue(closingStock, 'currency'),
    costOfSales: metricValue(costOfSales, 'currency'),
    countVariance: metricValue(countVariance, 'currency', percentOf(countVariance, stockValue)),
    manualAdjustments: metricValue(manualAdjustments, 'currency', percentOf(manualAdjustments, stockValue)),
    wastage: metricValue(manualWastage + manufacturingWastage, 'currency', percentOf(manualWastage + manufacturingWastage, stockValue))
  };

  summary.totalStockValue = summary.stockValue;
  summary.gpPercentage = summary.averageGp;
  return { today, summary };
}

function enrichSummaryWithTrends(source, dateKey, summary) {
  const today = dateKey || isoToday();
  const previousDate = addDays(today, -1);
  const previousSummary = calculateDashboardMetrics(source, previousDate).summary || {};
  const enriched = {};

  Object.entries(summary || {}).forEach(([key, metric]) => {
    const previousMetric = previousSummary[key] || metric;
    enriched[key] = enrichMetric(key, metric, previousMetric);
  });

  enriched.totalStockValue = enriched.stockValue;
  enriched.gpPercentage = enriched.averageGp;
  return enriched;
}

function enrichMetric(key, metric = {}, previousMetric = {}) {
  const currentRaw = Number(metric.raw || 0);
  const previousRaw = Number(previousMetric.raw || 0);
  const delta = currentRaw - previousRaw;
  const deltaPercent = previousRaw === 0
    ? (currentRaw === 0 ? 0 : 100)
    : (delta / Math.abs(previousRaw)) * 100;
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';

  return {
    ...metric,
    previousRaw,
    previousValue: formatMetric(previousRaw, metric.type),
    trend: {
      delta,
      deltaPercent,
      direction,
      tone: getTrendTone(key, direction),
      label: formatTrendLabel(delta, deltaPercent, metric.type === 'percent'),
      comparisonText: `${Math.abs(deltaPercent).toFixed(2)}% vs yesterday`
    }
  };
}

function getTrendTone(key, direction) {
  const lowerIsBetter = new Set(['lowStockCount', 'costOfSales', 'countVariance', 'manualAdjustments', 'wastage']);
  const neutral = new Set(['purchases']);
  if (direction === 'flat') return key === 'lowStockCount' ? 'warning' : 'neutral';
  if (neutral.has(key)) return direction === 'up' ? 'warning' : 'positive';
  if (lowerIsBetter.has(key)) return direction === 'down' ? 'positive' : 'negative';
  return direction === 'up' ? 'positive' : 'negative';
}

function buildTrendSeries(source, today = isoToday()) {
  return {
    stockValue: {
      7: buildSeries(source, today, 7, 'stockValue'),
      30: buildSeries(source, today, 30, 'stockValue')
    },
    averageGp: {
      7: buildSeries(source, today, 7, 'averageGp'),
      30: buildSeries(source, today, 30, 'averageGp')
    },
    costOfSales: {
      7: buildSeries(source, today, 7, 'costOfSales'),
      30: buildSeries(source, today, 30, 'costOfSales')
    },
    wastage: {
      7: buildSeries(source, today, 7, 'wastage'),
      30: buildSeries(source, today, 30, 'wastage')
    }
  };
}

function buildSeries(source, today, days, metricKey) {
  return Array.from({ length: days }, (_, index) => {
    const date = addDays(today, index - (days - 1));
    const summary = calculateDashboardMetrics(source, date).summary || {};
    const metric = metricKey === 'stockValue' ? summary.closingStock : summary[metricKey];
    return {
      date,
      label: formatSeriesLabel(date, days),
      value: Number(metric?.raw || 0)
    };
  });
}

function buildDashboardContext(source, now) {
  const products = Object.values(source?.products || {});
  const since = now.getTime() - 24 * 60 * 60 * 1000;
  const newLast24h = products.filter((product) => {
    const stamp = getTimestamp(product.createdAt || product.importedAt || product.updatedAt || product.modifiedAt);
    return stamp && stamp >= since;
  }).length;

  return {
    menuItems: {
      newLast24h
    }
  };
}

function calculateCurrentStockValue(ingredients = []) {
  return ingredients.reduce((sum, ingredient) => {
    return sum + getStockValuationUnitCost(ingredient) * (Number(ingredient.stock) || 0);
  }, 0);
}

function calculateRecipeCost(recipe = [], ingredientMap = new Map()) {
  return toArray(recipe).reduce((sum, line) => {
    const ingredient = ingredientMap.get(String(line.ingId || line.ingredientId || line.stockItemId || ''));
    const qty = Number(line.qty || line.quantity || 0) || 0;
    return sum + qty * getStockValuationUnitCost(ingredient || line);
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

  const purchases = sumByDate(source.logs_grv, date, 'totalEx', tradingDay) - sumByDate(source.logs_cn, date, 'totalEx', tradingDay);
  const adjustmentDelta = toArray(source.logs_adj)
    .filter((log) => getLogDate(log, tradingDay) === date)
    .reduce((total, log) => total + (Number(log.impactEx || 0) || 0), 0);
  const stockTakeDelta = toArray(source.logs_stocktakes)
    .filter((log) => getLogDate(log, tradingDay) === date)
    .reduce((total, log) => total + toArray(log.items).reduce((sum, item) => {
      return sum + calculateStockTakeItemImpact(item);
    }, 0), 0);
  const manufacturingDelta = toArray(source.logs_mfg)
    .filter((log) => getLogDate(log, tradingDay) === date)
    .reduce((total, log) => {
      const variance = Number(log.variance || 0);
      if (!(variance > 0)) return total;
      const expectedQty = Number(log.expectedQty || 1) || 1;
      const unitCost = toArray(log.components).reduce((sum, component) => {
        return sum + ((Number(component.qty || 0) || 0) / expectedQty) * (Number(component.cost || 0) || 0);
      }, 0);
      return total - (variance * unitCost);
    }, 0);
  const salesDelta = toArray(source.logs_sales)
    .filter((log) => getLogDate(log, tradingDay) === date)
    .reduce((total, log) => total + toArray(log.details).reduce((sum, detail) => {
      if (Number.isFinite(Number(detail.impactEx))) return sum + (Number(detail.impactEx) || 0);
      if (Number.isFinite(Number(detail.impact))) return sum + (Number(detail.impact) || 0);
      return sum;
    }, 0), 0);

  return purchases + adjustmentDelta + stockTakeDelta + manufacturingDelta + salesDelta;
}

function getSessionOpeningStockValue(source, dateKey) {
  const openings = source?.sessionOpeningStock;
  if (!openings) return null;
  const direct = openings[dateKey];
  if (direct && typeof direct === 'object') {
    const value = Number(direct.value ?? direct.openingStockValue ?? direct.stockValue ?? 0);
    return Number.isFinite(value) ? value : null;
  }
  const numeric = Number(direct);
  return Number.isFinite(numeric) && direct !== undefined ? numeric : null;
}

function calculateStockTakeItemImpact(item = {}) {
  if (Number.isFinite(Number(item.varianceImpactEx))) return Number(item.varianceImpactEx || 0);
  return (Number(item.variance || 0) || 0) * (Number(item.cost ?? item.unitCost ?? 0) || 0);
}

function findSnapshotForDate(snapshots = [], dateKey) {
  const tradingDay = getTradingDayConfig({});
  return toArray(snapshots)
    .filter((snapshot) => getLogDate(snapshot, tradingDay) === dateKey)
    .sort((left, right) => String(right.timestamp || right.createdAt || '').localeCompare(String(left.timestamp || left.createdAt || '')))[0] || null;
}

function sumByDate(logs = [], dateKey, field, tradingDay = getTradingDayConfig({})) {
  return toArray(logs)
    .filter((log) => getLogDate(log, tradingDay) === dateKey)
    .reduce((sum, log) => sum + (Number(log[field] || 0) || 0), 0);
}

function getLogDate(log = {}, tradingDay = getTradingDayConfig({})) {
  const stamp = log.timestamp || log.createdAt || log.date;
  if (!stamp) return String(log.date || '').slice(0, 10);
  return getTradeDateKey(new Date(stamp), { tradingTime: tradingDay.endTime });
}

function getTradeDateKey(date = new Date(), settings = {}) {
  const tradingTime = String(settings.tradingTime || settings.endOfDay || '23:59');
  const [hour, minute] = tradingTime.split(':').map((part) => Number(part) || 0);
  const local = new Date(date);
  const cutoff = new Date(local);
  cutoff.setHours(hour, minute, 0, 0);
  if (local > cutoff) cutoff.setDate(cutoff.getDate() + 1);
  return localDateKey(cutoff);
}

function getTradingDayConfig(settings = {}) {
  return { endTime: String(settings.tradingTime || settings.endOfDay || '23:59') };
}

function normalizeIngredients(items = []) {
  return toArray(items).map((item) => {
    const balances = item.balances && typeof item.balances === 'object' ? item.balances : {};
    const stock = Object.keys(balances).length
      ? Object.values(balances).reduce((sum, value) => sum + (Number(value) || 0), 0)
      : Number(item.stock || item.qty || item.onHand || 0) || 0;
    return {
      ...item,
      stock,
      cost: getStockValuationUnitCost(item)
    };
  });
}

function getStockValuationUnitCost(item = {}) {
  return Number(item.lastPurchasePrice ?? item.cost ?? item.costExVat ?? item.unitCost ?? 0) || 0;
}

// Kept in sync by hand with src/services/wastageClassifier.js (Cloud Functions can't
// import from src/). Wastage = adjustment_type 'wastage' or an explicit wasteReason/waste
// note. A plain 'remove' with no wasteReason is a manual stock correction, not wastage.
function isWastageAdjustment(log = {}) {
  const mode = String(log.mode || log.adjustmentType || log.adjustment_type || '').toLowerCase();
  const note = String(log.note || log.notes || log.reason || '').toLowerCase();
  
  if (mode === 'add' || mode === 'override') {
    return false;
  }
  
  return mode === 'wastage' || Boolean(log.wasteReason || log.waste_reason) || note.includes('waste') || note.includes('wastage');
}

function metricValue(raw, type, ratio = null) {
  return {
    raw,
    type,
    value: formatMetric(raw, type),
    ratio
  };
}

function percentOf(value, total) {
  const base = Number(total || 0);
  if (!base) return 0;
  return (Number(value || 0) / base) * 100;
}

function formatMetric(value, type) {
  const numeric = Number(value || 0);
  if (type === 'currency') {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(numeric);
  }
  if (type === 'percent') return `${numeric.toFixed(1)}%`;
  return new Intl.NumberFormat('en-ZA').format(numeric);
}

function formatTrendLabel(delta, deltaPercent, isPercentMetric) {
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '•';
  if (isPercentMetric) return `${arrow} ${Math.abs(delta).toFixed(1)} pp`;
  return `${arrow} ${Math.abs(deltaPercent).toFixed(2)}%`;
}

function formatSeriesLabel(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00`);
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit',
    month: days > 7 ? 'short' : 'short'
  }).format(date);
}

function addDays(dateKey, offset) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  let cursor = String(startDate || '').slice(0, 10);
  const end = String(endDate || '').slice(0, 10);
  while (cursor && end && cursor <= end && dates.length < 370) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function localDateKey(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function isoToday(date = new Date()) {
  return localDateKey(date);
}

function getTimestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value < 10000000000 ? value * 1000 : value;
  if (typeof value === 'object' && typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  return Object.entries(value)
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => ({ id: String(item.id || id), ...item }));
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

async function rebuildDashboardSummaryForWorkspace(admin, workspaceId) {
  const dataPath = workspaceId === 'appData' || workspaceId === 'appData_legacy' || workspaceId === 'ROOT_WORKSPACE'
    ? 'appData'
    : `workspaces/${workspaceId}/data`;
  return rebuildDashboardSummary(admin, dataPath);
}

module.exports = {
  dashboardSummaryNodes,
  enrichSummaryWithTrends,
  rebuildDashboardSummary,
  rebuildDashboardSummaryForWorkspace
};
