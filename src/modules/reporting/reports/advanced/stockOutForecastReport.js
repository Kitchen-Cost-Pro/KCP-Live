import { roundMoney, safeNumber } from '../../engine/calculations.js';
import { dateDaysAgo, calculateAverageDailyUsage, calculateCoveragePercent, calculateDaysUntilStockOut, calculateEstimatedReorderValue, calculateForecastStockOutDate, calculateRecommendedReorderQty, calculateWeightedAverageUsage, resolveStockOutRiskStatus, stockOutProbabilityScore } from '../../engine/forecasting.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { calculateRiskScore } from '../../engine/riskScoring.js';
import { buildDailySeries } from '../../engine/trendAnalysis.js';
import { applyAdvancedFilters, attachModelMeta, countWarning, isUsageLedgerRow, itemLocationKey, loadAdvancedSources, normalizeDate, normalizeUsageQty, sourceWarnings } from './advancedReportHelpers.js';
import { DEFAULT_REPORT_TIMEZONE, zonedDateTimeStrings } from '../../engine/timezone.js';

const money = (key, label, tooltipKey = '') => ({ key, label, type: 'money', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const qty = (key, label, tooltipKey = '') => ({ key, label, type: 'number', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const percent = (key, label, tooltipKey = '') => ({ key, label, type: 'percent', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const number = (key, label, tooltipKey = '') => ({ key, label, type: 'number', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const badge = (key, label) => ({ key, label, type: 'badge', sortable: true });

const forecastSummaryColumns = [
  { key: 'itemName', label: 'Item', sortable: true }, { key: 'category', label: 'Category', sortable: true }, { key: 'locationName', label: 'Location', sortable: true },
  qty('currentStock', 'Current Stock'), { key: 'baseUom', label: 'Base UOM', sortable: true }, qty('usageLast7Days', 'Usage Last 7 Days'), qty('usageLast30Days', 'Usage Last 30 Days'),
  qty('averageDailyUsage', 'Average Daily Usage', 'averageDailyUsage'), qty('weightedDailyUsage', 'Weighted Daily Usage', 'weightedDailyUsage'),
  number('daysUntilStockOut', 'Days Until Stock-Out', 'daysUntilStockOut'), { key: 'forecastStockOutDate', label: 'Forecast Stock-Out Date', type: 'date', sortable: true, tooltipKey: 'forecastStockOutDate' }, percent('coveragePercent', 'Coverage %', 'coveragePercent'),
  qty('lowStockThreshold', 'Low Stock Threshold'), qty('parLevel', 'Par Level'), { key: 'supplierName', label: 'Supplier', sortable: true },
  qty('recommendedReorderQty', 'Recommended Reorder Qty', 'recommendedReorderQty'), money('estimatedReorderValue', 'Estimated Reorder Value', 'estimatedReorderValue'),
  number('riskScore', 'Risk Score', 'advancedRiskScore'), badge('riskStatus', 'Risk Status'), percent('dataConfidence', 'Data Confidence', 'dataConfidence')
];

const riskMatrixColumns = [
  { key: 'itemName', label: 'Item', sortable: true }, { key: 'category', label: 'Category', sortable: true }, { key: 'locationName', label: 'Location', sortable: true },
  number('probabilityScore', 'Probability Score'), number('financialImpactScore', 'Financial Impact Score'), number('urgencyScore', 'Urgency Score'),
  percent('dataConfidence', 'Data Confidence', 'dataConfidence'), number('riskScore', 'Risk Score', 'advancedRiskScore'), badge('riskStatus', 'Risk Status'), { key: 'suggestedAction', label: 'Suggested Action', sortable: true }
];

const byLocationColumns = [
  { key: 'locationName', label: 'Location', sortable: true }, number('itemsForecastToRunOut', 'Items Forecast To Run Out'), number('criticalItems', 'Critical Items'), number('highRiskItems', 'High Risk Items'),
  number('averageDaysCoverage', 'Average Days Coverage'), money('estimatedReorderValue', 'Estimated Reorder Value'), { key: 'topRiskItem', label: 'Top Risk Item', sortable: true }, number('riskScore', 'Risk Score'), badge('riskStatus', 'Risk Status')
];

const byCategoryColumns = [
  { key: 'category', label: 'Category', sortable: true }, { key: 'locationName', label: 'Location', sortable: true }, number('itemsForecastToRunOut', 'Items Forecast To Run Out'), number('criticalItems', 'Critical Items'), number('highRiskItems', 'High Risk Items'),
  number('averageDaysCoverage', 'Average Days Coverage'), money('estimatedReorderValue', 'Estimated Reorder Value'), { key: 'topRiskItem', label: 'Top Risk Item', sortable: true }, number('riskScore', 'Risk Score'), badge('riskStatus', 'Risk Status')
];

const byItemColumns = [
  { key: 'itemName', label: 'Item', sortable: true }, { key: 'category', label: 'Category', sortable: true }, { key: 'locationName', label: 'Location', sortable: true }, qty('currentStock', 'Current Stock'),
  qty('averageDailyUsage', 'Average Daily Usage', 'averageDailyUsage'), qty('weightedDailyUsage', 'Weighted Daily Usage', 'weightedDailyUsage'), qty('usageLast7Days', 'Usage Last 7 Days'), qty('usageLast30Days', 'Usage Last 30 Days'),
  number('daysUntilStockOut', 'Days Until Stock-Out', 'daysUntilStockOut'), { key: 'forecastStockOutDate', label: 'Forecast Stock-Out Date', type: 'date', sortable: true, tooltipKey: 'forecastStockOutDate' }, { key: 'supplierName', label: 'Supplier', sortable: true },
  qty('recommendedReorderQty', 'Recommended Reorder Qty', 'recommendedReorderQty'), money('estimatedReorderValue', 'Estimated Reorder Value', 'estimatedReorderValue'), badge('riskStatus', 'Risk Status')
];

const usageDetailColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true }, { key: 'locationName', label: 'Location', sortable: true }, { key: 'itemName', label: 'Item', sortable: true },
  { key: 'sourceType', label: 'Source Type', sortable: true }, qty('qtyUsed', 'Qty Used'), { key: 'baseUom', label: 'Base UOM', sortable: true }, money('unitCostExVat', 'Unit Cost Ex VAT'), money('usageValue', 'Usage Value'),
  { key: 'documentNumber', label: 'Document Number', sortable: true }, { key: 'sourceId', label: 'Source ID', sortable: true }
];

export const stockOutForecastReport = {
  id: 'stock_out_forecast',
  title: 'Stock-Out Forecast',
  section: 'advanced',
  description: 'Forecasts when stock items may run out based on current stock, recent usage patterns, sales usage, manufacturing usage, wastage, and transfers.',
  emptyState: { title: 'No forecast rows available', message: 'No stock balances and usage rows matched the selected filters.' },
  suppressEmptyWarning: true,
  showAllWarnings: true,
  allowAllViewsExport: false,
  defaultView: 'forecast_summary',
  defaultFilters: { lookbackPeriod: '30' },
  availableViews: ['forecast_summary', 'risk_matrix', 'by_location', 'by_category', 'by_item', 'usage_detail'],
  filterConfig: {
    default: ['search', 'location', 'category', 'inventoryItem', 'supplier', 'riskStatus', 'lookbackPeriod', 'onlyCritical', 'onlyHighRisk'],
    usage_detail: ['search', 'dateRange', 'location', 'category', 'inventoryItem', 'supplier', 'sourceType', 'riskStatus', 'lookbackPeriod']
  },
  columns: { forecast_summary: forecastSummaryColumns, risk_matrix: riskMatrixColumns, by_location: byLocationColumns, by_category: byCategoryColumns, by_item: byItemColumns, usage_detail: usageDetailColumns },
  exportMapping: {
    forecast_summary: mapColumns(forecastSummaryColumns), risk_matrix: mapColumns(riskMatrixColumns), by_location: mapColumns(byLocationColumns), by_category: mapColumns(byCategoryColumns), by_item: mapColumns(byItemColumns), usage_detail: mapColumns(usageDetailColumns)
  },
  getRows: async ({ workspaceId, filters, services = {}, dataSet = {}, view = 'forecast_summary' }) => {
    const model = await buildStockOutForecastModel({ workspaceId, filters, services, dataSet });
    rememberModel(services, model);
    return attachModelMeta(model.views[view] || model.views.forecast_summary, model, model.meta);
  },
  getTotals: ({ rows, view }) => stockOutTotals(rows, view),
  getPresentation: ({ services }) => buildStockOutPresentation(services?.reporting?.__lastStockOutForecastModel),
  validate: ({ services }) => validateStockOutModel(services?.reporting?.__lastStockOutForecastModel)
};

export async function buildStockOutForecastModel({ workspaceId = '', filters = {}, services = {}, dataSet = {} } = {}) {
  const lookbackDays = normalizeLookback(filters.lookbackPeriod);
  // `sources.stock`'s `currentStock` (used below for daysUntilStockOut/coveragePercent/
  // recommendedReorderQty) comes from the live stock-on-hand feed, which has no point-in-time
  // query — it always reflects the balance AS OF RIGHT NOW, computed in the report's own business
  // timezone rather than UTC (a UTC "today" can be off by the timezone's offset around local
  // midnight). The USAGE window may still be legitimately scoped to a historical `filters.endDate`
  // (e.g. drilling into the usage_detail view for a past period, which only filters ledger rows),
  // but the forecast's stock-out projection itself must always be anchored to today's real stock,
  // not to whatever `endDate` happens to be set to — otherwise a leftover historical date filter
  // silently treats today's live stock as if it were valid for that past date (the same bug
  // already fixed in theoreticalVsActualReport.js and operationsDashboardReport.js).
  const todayDate = zonedDateTimeStrings(new Date(), DEFAULT_REPORT_TIMEZONE).date;
  const usageAsOfDate = text(filters.endDate) || todayDate;
  const sourceFilters = { ...filters, startDate: dateDaysAgo(usageAsOfDate, Math.max(lookbackDays, 30) - 1), endDate: usageAsOfDate, riskStatus: '', onlyCritical: '', onlyHighRisk: '' };
  const sources = await loadAdvancedSources({ workspaceId, filters: sourceFilters, services, dataSet, sources: ['stock', 'ledger'] });
  const usageRows = toArray(sources.ledger).filter(isUsageLedgerRow).map(normalizeUsageRow);
  const usageByItemLocation = groupBy(usageRows, itemLocationKey);
  const baseRows = toArray(sources.stock).map((stockRow) => buildForecastRow(stockRow, usageByItemLocation.get(itemLocationKey(stockRow)) || [], { lookbackDays, usageAsOfDate, asOfDate: todayDate }));
  const maxReorderValue = Math.max(...baseRows.map((row) => row.estimatedReorderValue), 1);
  const scoredRows = baseRows.map((row) => scoreForecastRow(row, maxReorderValue));
  let filteredRows = applyAdvancedFilters(scoredRows, filters);
  if (String(filters.onlyCritical || '').toLowerCase() === 'true') filteredRows = filteredRows.filter((row) => ['Out', 'Critical'].includes(row.riskStatus));
  if (String(filters.onlyHighRisk || '').toLowerCase() === 'true') filteredRows = filteredRows.filter((row) => ['Out', 'Critical', 'High Risk'].includes(row.riskStatus));
  const filteredKeys = new Set(filteredRows.map(itemLocationKey));
  const filteredUsageRows = applyAdvancedFilters(usageRows.filter((row) => filteredKeys.has(itemLocationKey(row))), filters, { riskField: 'riskStatus' });
  return {
    id: `stock-out:${usageAsOfDate}:${lookbackDays}`,
    lookbackDays,
    asOfDate: todayDate,
    baseRows: scoredRows,
    filteredRows,
    usageRows: filteredUsageRows,
    sourceWarnings: [...sourceWarnings(sources.stock), ...sourceWarnings(sources.ledger)],
    meta: sources.stock?.[0]?.__apiMeta || sources.ledger?.[0]?.__apiMeta || {},
    views: {
      forecast_summary: filteredRows,
      risk_matrix: filteredRows,
      by_location: aggregateForecastRows(filteredRows, 'location'),
      by_category: aggregateForecastRows(filteredRows, 'category'),
      by_item: filteredRows,
      usage_detail: filteredUsageRows
    }
  };
}

function buildForecastRow(stockRow, usageRows, { lookbackDays, usageAsOfDate, asOfDate }) {
  const usageLast7Days = usageWithinDays(usageRows, usageAsOfDate, 7);
  const usageLast14Days = usageWithinDays(usageRows, usageAsOfDate, 14);
  const usageLast30Days = usageWithinDays(usageRows, usageAsOfDate, 30);
  const totalUsage = usageWithinDays(usageRows, usageAsOfDate, lookbackDays);
  const averageDailyUsage = calculateAverageDailyUsage(totalUsage, lookbackDays);
  const weightedDailyUsage = calculateWeightedAverageUsage({ usage7Day: usageLast7Days, usage14Day: usageLast14Days, usage30Day: usageLast30Days });
  const effectiveDailyUsage = weightedDailyUsage || averageDailyUsage;
  const daysUntilStockOut = calculateDaysUntilStockOut(stockRow.currentStock, effectiveDailyUsage);
  const recommendedReorderQty = calculateRecommendedReorderQty(stockRow.currentStock, stockRow.parLevel);
  const dataConfidence = calculateForecastConfidence(stockRow, usageRows, lookbackDays);
  const riskStatus = resolveStockOutRiskStatus({ currentStock: stockRow.currentStock, daysUntilStockOut, averageDailyUsage: effectiveDailyUsage });
  return {
    id: `stock-out:${stockRow.itemId || stockRow.itemName}:${stockRow.locationId || stockRow.locationName}`,
    ...stockRow,
    usageLast7Days,
    usageLast14Days,
    usageLast30Days,
    averageDailyUsage,
    weightedDailyUsage,
    effectiveDailyUsage,
    daysUntilStockOut: Number.isFinite(daysUntilStockOut) ? daysUntilStockOut : '',
    forecastStockOutDate: calculateForecastStockOutDate(asOfDate, daysUntilStockOut),
    coveragePercent: calculateCoveragePercent(stockRow.currentStock, stockRow.parLevel),
    recommendedReorderQty,
    estimatedReorderValue: calculateEstimatedReorderValue(recommendedReorderQty, stockRow.unitCostExVat),
    dataConfidence,
    riskStatus,
    usageTrend: buildDailySeries(usageRows, { dateSelector: normalizeDate, valueSelector: (row) => row.qtyUsed, from: dateDaysAgo(usageAsOfDate, 13), to: usageAsOfDate }).map((point) => point.value)
  };
}

function scoreForecastRow(row, maxReorderValue) {
  const days = row.daysUntilStockOut === '' ? Number.POSITIVE_INFINITY : safeNumber(row.daysUntilStockOut);
  const probabilityScore = stockOutProbabilityScore(days, row.currentStock, row.effectiveDailyUsage);
  const financialImpactScore = Math.min(100, (safeNumber(row.estimatedReorderValue) / maxReorderValue) * 100);
  const urgencyScore = probabilityScore;
  const riskScore = calculateRiskScore({ probability: probabilityScore, financialImpact: financialImpactScore, urgency: urgencyScore, dataConfidence: row.dataConfidence * 100 });
  return { ...row, probabilityScore, financialImpactScore, urgencyScore, riskScore, suggestedAction: suggestedAction({ ...row, riskScore }) };
}

function aggregateForecastRows(rows, mode) {
  const grouped = groupBy(rows, (row) => mode === 'location' ? (row.locationId || row.locationName) : `${row.category}::${row.locationId || row.locationName}`);
  return [...grouped.entries()].map(([key, group]) => {
    const sorted = [...group].sort((a, b) => b.riskScore - a.riskScore);
    const finiteDays = group.map((row) => Number(row.daysUntilStockOut)).filter(Number.isFinite);
    const base = {
      id: `stock-out-${mode}:${key}`,
      locationId: text(group[0]?.locationId), locationName: text(group[0]?.locationName) || 'Unknown Location', category: text(group[0]?.category) || 'General',
      itemsForecastToRunOut: group.filter((row) => ['Out', 'Critical', 'High Risk', 'Watch'].includes(row.riskStatus)).length,
      criticalItems: group.filter((row) => ['Out', 'Critical'].includes(row.riskStatus)).length,
      highRiskItems: group.filter((row) => row.riskStatus === 'High Risk').length,
      averageDaysCoverage: finiteDays.length ? finiteDays.reduce((sum, value) => sum + value, 0) / finiteDays.length : '',
      estimatedReorderValue: roundMoney(sumBy(group, 'estimatedReorderValue')),
      topRiskItem: sorted[0]?.itemName || '',
      riskScore: sorted[0]?.riskScore || 0,
      riskStatus: sorted[0]?.riskStatus || 'Healthy'
    };
    return mode === 'location' ? base : { ...base, category: text(group[0]?.category) || 'General' };
  });
}

function normalizeUsageRow(row, index) {
  const qtyUsed = normalizeUsageQty(row);
  return {
    id: `forecast-usage:${row.id || row.sourceId || index}`,
    date: normalizeDate(row), locationId: text(row.locationId), locationName: text(row.locationName), itemId: text(row.itemId || row.stockItemId), itemName: text(row.itemName), category: text(row.category) || 'General',
    sourceType: text(row.sourceType || row.source || row.movementType), qtyUsed, baseUom: text(row.baseUom), unitCostExVat: safeNumber(row.unitCostExVat), usageValue: roundMoney(qtyUsed * safeNumber(row.unitCostExVat)),
    documentNumber: text(row.documentNumber), sourceId: text(row.sourceId), supplierId: text(row.supplierId), supplierName: text(row.supplierName)
  };
}

function usageWithinDays(rows, asOfDate, days) {
  const from = dateDaysAgo(asOfDate, days - 1);
  return toArray(rows).filter((row) => normalizeDate(row) >= from && normalizeDate(row) <= asOfDate).reduce((sum, row) => sum + safeNumber(row.qtyUsed), 0);
}

function calculateForecastConfidence(stockRow, usageRows, lookbackDays) {
  let score = 0;
  if (stockRow.hasLocationBalance !== false && stockRow.currentStock !== undefined) score += 0.25;
  if (safeNumber(stockRow.unitCostExVat) > 0) score += 0.15;
  if (safeNumber(stockRow.parLevel) > 0) score += 0.15;
  if (text(stockRow.supplierName)) score += 0.10;
  const uniqueDays = new Set(toArray(usageRows).map(normalizeDate).filter(Boolean)).size;
  score += Math.min(0.30, (uniqueDays / Math.max(7, lookbackDays)) * 0.30);
  if (usageRows.length) score += 0.05;
  return Math.min(1, score);
}

function suggestedAction(row) {
  if (row.currentStock <= 0 || row.riskStatus === 'Critical') return 'Order immediately';
  if (row.riskStatus === 'High Risk') return 'Order now';
  if (!safeNumber(row.parLevel)) return 'Review par level';
  if (!row.effectiveDailyUsage) return 'Check recipe mapping';
  if (row.riskStatus === 'Watch') return 'Monitor usage';
  return 'No action needed';
}

function buildStockOutPresentation(model) {
  if (!model) return {};
  const rows = model.filteredRows || [];
  const atRisk = rows.filter((row) => ['Out', 'Critical', 'High Risk', 'Watch'].includes(row.riskStatus));
  const critical = rows.filter((row) => ['Out', 'Critical'].includes(row.riskStatus));
  const finiteDays = rows.map((row) => Number(row.daysUntilStockOut)).filter(Number.isFinite);
  const byLocation = aggregateForecastRows(rows, 'location').sort((a, b) => b.riskScore - a.riskScore);
  const highestRisk = [...rows].sort((a, b) => b.riskScore - a.riskScore)[0];
  const heatmap = [...groupBy(rows, (row) => `${row.locationName}::${row.category}`).values()].map((group) => ({ row: group[0]?.locationName || 'Unknown', column: group[0]?.category || 'General', value: Math.max(...group.map((row) => row.riskScore), 0), meta: `${group.filter((row) => ['Out', 'Critical', 'High Risk'].includes(row.riskStatus)).length} high risk` }));
  const supplierBars = [...groupBy(rows, (row) => row.supplierName || 'Missing Supplier').entries()].map(([label, group]) => ({ label, value: sumBy(group, 'estimatedReorderValue') })).sort((a, b) => b.value - a.value).slice(0, 10);
  return {
    summaryCards: [
      { label: 'Items Forecast To Run Out', value: atRisk.length, detail: `Within ${model.lookbackDays}-day usage model`, tone: 'warning' },
      { label: 'Critical Items', value: critical.length, detail: 'Out now or within 2 days', tone: 'critical' },
      { label: 'Average Days Coverage', value: finiteDays.length ? finiteDays.reduce((sum, value) => sum + value, 0) / finiteDays.length : '', format: 'days', tone: 'neutral' },
      { label: 'Estimated Reorder Value', value: sumBy(rows, 'estimatedReorderValue'), format: 'money', tone: 'positive' },
      { label: 'Highest Risk Location', value: byLocation[0]?.locationName || '-', detail: byLocation[0] ? `Risk score ${byLocation[0].riskScore}` : '', tone: 'accent' }
    ],
    visuals: [
      { type: 'heatmap', title: 'Stock-Out Risk Heatmap', description: 'Maximum risk score by location and category.', data: heatmap },
      { type: 'bar', title: 'Lowest Days Coverage', description: 'Top 10 items with the shortest forecast coverage.', format: 'number', data: rows.filter((row) => row.daysUntilStockOut !== '').sort((a, b) => a.daysUntilStockOut - b.daysUntilStockOut).slice(0, 10).map((row) => ({ label: `${row.itemName} · ${row.locationName}`, value: row.daysUntilStockOut })) },
      { type: 'line', title: highestRisk ? `Usage Trend · ${highestRisk.itemName}` : 'Usage Trend', description: 'Recent daily usage for the highest-risk item.', data: (highestRisk?.usageTrend || []).map((value, index) => ({ label: String(index + 1), value })) },
      { type: 'bar', title: 'Reorder Value by Supplier', description: 'Estimated reorder value grouped by preferred or latest supplier.', format: 'money', data: supplierBars },
      { type: 'riskMatrix', title: 'Likelihood vs Impact', description: 'High-risk items move toward the upper-right corner.', data: rows.slice().sort((a, b) => b.riskScore - a.riskScore).slice(0, 18).map((row) => ({ label: row.itemName, probability: row.probabilityScore, impact: row.financialImpactScore, tooltip: `${row.itemName} · ${row.locationName} · Risk ${row.riskScore}` })) }
    ],
    explanation: {
      title: 'How the stock-out forecast is calculated',
      description: 'The table remains the auditable source of detail; visuals summarise the same rows.',
      formulas: [
        { label: 'Average Daily Usage', formula: 'Total Usage / Lookback Days', example: '5 units/day = 150 units / 30 days' },
        { label: 'Weighted Daily Usage', formula: '(7-day average × 50%) + (14-day average × 30%) + (30-day average × 20%)' },
        { label: 'Days Until Stock-Out', formula: 'Current Stock / Effective Daily Usage', example: '4 days = 20 units / 5 units per day' },
        { label: 'Recommended Reorder Qty', formula: 'max(Par Level - Current Stock, 0)' },
        { label: 'Risk Score', formula: '35% probability + 30% financial impact + 25% urgency + 10% data risk' }
      ],
      notes: ['Transfer Out is included because it reduces location-specific coverage.', 'No Usage means the forecast cannot estimate a stock-out date from recent history.']
    }
  };
}

function validateStockOutModel(model) {
  if (!model) return [];
  const rows = model.filteredRows || [];
  return [...model.sourceWarnings,
    countWarning(rows, 'forecast-missing-current-stock', 'critical', 'forecast row(s) are missing current stock.', (row) => row.currentStock === undefined || row.hasLocationBalance === false),
    countWarning(rows, 'forecast-missing-usage-history', 'warning', 'forecast row(s) have no usage history.', (row) => !row.usageLast30Days),
    countWarning(rows, 'forecast-missing-unit-cost', 'warning', 'forecast row(s) are missing unit cost.', (row) => safeNumber(row.unitCostExVat) <= 0),
    countWarning(rows, 'forecast-missing-par-level', 'warning', 'forecast row(s) are missing par level.', (row) => safeNumber(row.parLevel) <= 0),
    countWarning(rows, 'forecast-missing-supplier', 'warning', 'forecast row(s) are missing supplier.', (row) => !text(row.supplierName)),
    countWarning(rows, 'forecast-average-usage-zero', 'info', 'forecast row(s) have zero average daily usage.', (row) => !safeNumber(row.effectiveDailyUsage)),
    countWarning(rows, 'forecast-low-history', 'warning', 'forecast row(s) have less than 50% calculation confidence.', (row) => safeNumber(row.dataConfidence) < 0.5)
  ].filter(Boolean);
}

function stockOutTotals(rows, view) {
  if (view === 'usage_detail') return { qtyUsed: sumBy(rows, 'qtyUsed'), usageValue: roundMoney(sumBy(rows, 'usageValue')) };
  if (['by_location', 'by_category'].includes(view)) return { itemsForecastToRunOut: sumBy(rows, 'itemsForecastToRunOut'), criticalItems: sumBy(rows, 'criticalItems'), highRiskItems: sumBy(rows, 'highRiskItems'), estimatedReorderValue: roundMoney(sumBy(rows, 'estimatedReorderValue')) };
  return { currentStock: sumBy(rows, 'currentStock'), recommendedReorderQty: sumBy(rows, 'recommendedReorderQty'), estimatedReorderValue: roundMoney(sumBy(rows, 'estimatedReorderValue')) };
}

function rememberModel(services, model) { if (!services.reporting) services.reporting = {}; services.reporting.__lastStockOutForecastModel = model; }
function normalizeLookback(value) { const parsed = Math.floor(safeNumber(value, 30)); return [7, 14, 30, 60, 90].includes(parsed) ? parsed : 30; }
function mapColumns(columns) { return Object.fromEntries(columns.filter((column) => column.key).map((column) => [column.key, column.label])); }

export default stockOutForecastReport;
