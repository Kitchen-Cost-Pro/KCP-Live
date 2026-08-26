import {
  calculateDashboardMetrics,
  subscribeDashboardLiveState,
  subscribeDashboardSource,
} from './database.js';

const trendGoals = {
  stockValue: 'higher',
  productCount: 'higher',
  lowStockCount: 'lower',
  averageGp: 'higher',
  purchases: 'neutral',
  openingStock: 'higher',
  closingStock: 'higher',
  costOfSales: 'lower',
  countVariance: 'lower',
  manualAdjustments: 'lower',
  wastage: 'lower'
};

/**
 * Subscribes to the live dashboard source.
 *
 * Subscribes to live dashboard data through the compatibility dashboard
 * source. Kept for older callers while dashboard tiles use their own direct
 * service.
 */
export function subscribeDashboardMetrics(workspaceId, {
  onSnapshot,
  onError,
  includeSource = false,
  sourceNodes = [],
  sourceHydrationDelayMs = 300
} = {}) {
  const unsubscribers = [];
  let sourceTimer = null;
  let isActive = true;
  let acceptedSummary = false;
  let sourceHydrationStarted = false;

  const requestFreshSummary = () => {
    if (!isActive || !workspaceId) return;
    unsubscribers.push(subscribeDashboardSource(workspaceId, {
      nodes: sourceNodes,
      onData: (payload) => {
        acceptedSummary = true;
        onSnapshot?.(mapDashboardSnapshot(payload));
      },
      onError
    }));
  };

  const startSourceHydration = () => {
    if (
      sourceHydrationStarted ||
      !includeSource ||
      !Array.isArray(sourceNodes) ||
      !sourceNodes.length
    ) return;
    sourceHydrationStarted = true;
    sourceTimer = window.setTimeout(() => {
      if (!isActive) return;
      unsubscribers.push(subscribeDashboardSource(workspaceId, {
        nodes: sourceNodes,
        onData: (payload) => {
          onSnapshot?.(mapDashboardSnapshot(payload));
        },
        onError
      }));
    }, Math.max(0, Number(sourceHydrationDelayMs) || 0));
  };

  unsubscribers.push(subscribeDashboardLiveState(workspaceId, {
    onData: (payload) => {
      if (!payload) {
        requestFreshSummary();
        return;
      }
      acceptedSummary = true;
      const snapshot = mapDashboardLiveStateSnapshot(payload);
      onSnapshot?.(snapshot);
      startSourceHydration();
    },
    onError
  }));

  const refreshTimer = window.setTimeout(() => {
    if (!isActive || acceptedSummary) return;
    requestFreshSummary();
  }, 1500);

  return () => {
    isActive = false;
    window.clearTimeout(refreshTimer);
    if (sourceTimer) window.clearTimeout(sourceTimer);
    unsubscribers.forEach((unsubscribe) => unsubscribe?.());
  };
}

function mapDashboardLiveStateSnapshot(payload) {
  const now = new Date();
  const loaded = payload.loaded || {};
  const sourceCount = payload.sourceCount || Object.keys(loaded).length;

  return {
    source: null,
    metrics: payload.metrics,
    insights: payload.insights || {},
    siteName: payload.siteName || '',
    loaded,
    errors: {},
    isReady: true,
    isSummary: true,
    isLiveState: true,
    connection: {
      status: 'live',
      label: 'Live',
      loadedCount: Object.values(loaded).filter(Boolean).length || sourceCount,
      sourceCount,
      lastUpdated: payload.calculatedAt || now.toISOString(),
      isReceiving: true,
      summaryBacked: true
    }
  };
}

function mapDashboardSnapshot(payload) {
  const summary = payload.metrics?.summary || {};
  const enrichedSummary = enrichSummaryWithTrends(payload.source, payload.metrics?.today, summary);
  const errors = payload.errors || {};
  const hasErrors = Object.keys(errors).length > 0;
  const now = new Date();

  return {
    ...payload,
    metrics: {
      ...payload.metrics,
      summary: enrichedSummary,
      trends: buildTrendSeries(payload.source, payload.metrics?.today),
      context: buildDashboardContext(payload.source, now)
    },
    connection: {
      status: hasErrors ? 'error' : payload.isReady ? 'live' : 'syncing',
      label: hasErrors ? 'Attention' : payload.isReady ? 'Live' : 'Syncing',
      loadedCount: Object.values(payload.loaded || {}).filter(Boolean).length,
      sourceCount: Object.keys(payload.loaded || {}).length,
      lastUpdated: now.toISOString(),
      isReceiving: !hasErrors
    }
  };
}

function enrichSummaryWithTrends(source, dateKey, summary) {
  const today = dateKey || isoToday();
  const previousDate = addDays(today, -1);
  const previousSummary = calculateDashboardMetrics(source, previousDate).summary || {};
  const enriched = {};

  Object.entries(summary).forEach(([key, metric]) => {
    const previousMetric = previousSummary[key] || metric;
    enriched[key] = enrichMetric(key, metric, previousMetric);
  });

  const productContext = buildDashboardContext(source, new Date());
  if (enriched.productCount) {
    const previousProductCount = Math.max(0, Number(enriched.productCount.raw || 0) - productContext.menuItems.newLast24h);
    enriched.productCount = enrichMetric('productCount', enriched.productCount, {
      raw: previousProductCount,
      type: 'number',
      value: formatMetric(previousProductCount, 'number')
    });
  }

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
  const goal = trendGoals[key] || 'higher';
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const tone = getTrendTone(goal, direction, key);
  const isPercentMetric = metric.type === 'percent';

  return {
    ...metric,
    previousRaw,
    previousValue: formatMetric(previousRaw, metric.type),
    trend: {
      delta,
      deltaPercent,
      direction,
      tone,
      label: formatTrendLabel(delta, deltaPercent, isPercentMetric),
      comparisonText: `${formatCompactPercent(deltaPercent)} vs yesterday`
    }
  };
}

function getTrendTone(goal, direction, key) {
  if (direction === 'flat') return key === 'lowStockCount' ? 'warning' : 'neutral';
  if (key === 'lowStockCount') return direction === 'up' ? 'warning' : 'positive';
  if (goal === 'lower') return direction === 'down' ? 'positive' : 'negative';
  if (goal === 'neutral') return direction === 'up' ? 'warning' : direction === 'down' ? 'positive' : 'neutral';
  return direction === 'up' ? 'positive' : 'negative';
}

function formatTrendLabel(delta, deltaPercent, isPercentMetric) {
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '•';
  if (isPercentMetric) return `${arrow} ${Math.abs(delta).toFixed(1)} pp`;
  return `${arrow} ${formatCompactPercent(deltaPercent)}`;
}

function formatCompactPercent(value) {
  return `${Math.abs(Number(value || 0)).toFixed(2)}%`;
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

function getTimestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value < 10000000000 ? value * 1000 : value;
  if (typeof value === 'object' && typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function addDays(dateKey, offset) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function isoToday(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatSeriesLabel(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00`);
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit',
    month: days > 7 ? 'short' : 'short'
  }).format(date);
}

function formatMetric(value, type) {
  const numeric = Number(value || 0);
  if (type === 'currency') {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(numeric);
  }
  if (type === 'percent') return `${numeric.toFixed(1)}%`;
  return new Intl.NumberFormat('en-ZA').format(numeric);
}
