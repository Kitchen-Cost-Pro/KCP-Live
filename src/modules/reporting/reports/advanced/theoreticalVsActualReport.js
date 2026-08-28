import { roundMoney, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { DEFAULT_REPORT_TIMEZONE, zonedDateTimeStrings } from '../../engine/timezone.js';
import { calculateVarianceImpactScore, scoreToRiskStatus } from '../../engine/riskScoring.js';
import { calculateAccuracyPercent, calculateExpectedClosingStock, calculateQuantityVariancePercent, calculateTheoreticalUsage, calculateVarianceQty, calculateVarianceValue, percentileRank } from '../../engine/statistics.js';
import { buildDailySeries } from '../../engine/trendAnalysis.js';
import { applyAdvancedFilters, attachModelMeta, countWarning, isManufacturingInRow, isManufacturingOutRow, isPurchaseLedgerRow, isTransferInRow, isTransferOutRow, isWastageRow, itemLocationKey, latestByDate, loadAdvancedSources, maxAbs, normalizeDate, sourceWarnings } from './advancedReportHelpers.js';
import { filterCustomerActionableIssueText } from '../../validators/warningCategories.js';

const money = (key, label, tooltipKey = '') => ({ key, label, type: 'money', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const qty = (key, label, tooltipKey = '') => ({ key, label, type: 'number', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const percent = (key, label, tooltipKey = '') => ({ key, label, type: 'percent', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const number = (key, label, tooltipKey = '') => ({ key, label, type: 'number', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const badge = (key, label) => ({ key, label, type: 'badge', sortable: true });

const summaryColumns = [
  { key: 'dateRange', label: 'Date Range', sortable: true }, { key: 'locationName', label: 'Location', sortable: true }, number('itemsCompared', 'Items Compared'),
  money('theoreticalUsageValue', 'Theoretical Usage Value'), money('actualUsageValue', 'Actual Usage Value'), money('expectedClosingValue', 'Expected Closing Value', 'expectedClosingStock'), money('actualClosingValue', 'Actual Closing Value'),
  money('varianceValue', 'Variance Value', 'advancedVarianceValue'), percent('variancePercent', 'Variance %', 'advancedVariancePercent'), percent('accuracyPercent', 'Accuracy %', 'advancedAccuracyPercent'),
  money('positiveVarianceValue', 'Positive Variance Value'), money('negativeVarianceValue', 'Negative Variance Value'), number('highRiskItems', 'High Risk Items'), badge('status', 'Status')
];

const heatmapColumns = [
  { key: 'locationName', label: 'Location', sortable: true }, { key: 'category', label: 'Category', sortable: true }, number('itemsCompared', 'Items Compared'), money('varianceValue', 'Variance Value', 'advancedVarianceValue'),
  percent('variancePercent', 'Variance %', 'advancedVariancePercent'), percent('accuracyPercent', 'Accuracy %', 'advancedAccuracyPercent'), number('highRiskItems', 'High Risk Items'), badge('status', 'Status')
];

const byLocationColumns = [
  { key: 'locationName', label: 'Location', sortable: true }, number('itemsCompared', 'Items Compared'), money('theoreticalUsageValue', 'Theoretical Usage Value'), money('actualUsageValue', 'Actual Usage Value'),
  money('expectedClosingValue', 'Expected Closing Value', 'expectedClosingStock'), money('actualClosingValue', 'Actual Closing Value'), money('varianceValue', 'Variance Value', 'advancedVarianceValue'),
  percent('variancePercent', 'Variance %', 'advancedVariancePercent'), percent('accuracyPercent', 'Accuracy %', 'advancedAccuracyPercent'), number('highRiskItems', 'High Risk Items'),
  { key: 'lastStockTakeDate', label: 'Last Stock Take Date', type: 'date', sortable: true }, badge('status', 'Status')
];

const byCategoryColumns = [
  { key: 'category', label: 'Category', sortable: true }, { key: 'locationName', label: 'Location', sortable: true }, number('itemsCompared', 'Items Compared'), qty('theoreticalUsageQty', 'Theoretical Usage Qty'), qty('actualUsageQty', 'Actual Usage Qty'),
  { key: 'baseUom', label: 'Base UOM', sortable: true }, money('theoreticalUsageValue', 'Theoretical Usage Value'), money('actualUsageValue', 'Actual Usage Value'), money('varianceValue', 'Variance Value', 'advancedVarianceValue'),
  percent('variancePercent', 'Variance %', 'advancedVariancePercent'), percent('accuracyPercent', 'Accuracy %', 'advancedAccuracyPercent'), number('highRiskItems', 'High Risk Items'), badge('status', 'Status')
];

const byItemColumns = [
  { key: 'itemName', label: 'Item', sortable: true }, { key: 'category', label: 'Category', sortable: true }, { key: 'locationName', label: 'Location', sortable: true },
  qty('openingStock', 'Opening Stock'), qty('purchases', 'Purchases'), qty('transfersIn', 'Transfers In'), qty('manufacturingIn', 'Manufacturing In'), qty('theoreticalUsageQty', 'Theoretical Usage Qty', 'theoreticalUsage'),
  qty('actualUsageQty', 'Actual Usage Qty'), qty('wastageQty', 'Wastage Qty'), qty('stockTakeVarianceQty', 'Stock Take Variance Qty'), qty('expectedClosingStock', 'Expected Closing Stock', 'expectedClosingStock'), qty('actualClosingStock', 'Actual Closing Stock'),
  qty('varianceQty', 'Variance Qty', 'advancedVarianceQty'), { key: 'baseUom', label: 'Base UOM', sortable: true }, money('unitCostExVat', 'Unit Cost Ex VAT'), money('varianceValue', 'Variance Value', 'advancedVarianceValue'),
  percent('variancePercent', 'Variance %', 'advancedVariancePercent'), percent('accuracyPercent', 'Accuracy %', 'advancedAccuracyPercent'), number('varianceImpactScore', 'Variance Impact Score', 'varianceImpactScore'), badge('status', 'Status')
];

const varianceDetailColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true }, { key: 'locationName', label: 'Location', sortable: true }, { key: 'itemName', label: 'Item', sortable: true }, { key: 'category', label: 'Category', sortable: true },
  { key: 'source', label: 'Source', sortable: true }, { key: 'documentNumber', label: 'Document Number', sortable: true }, qty('theoreticalQty', 'Theoretical Qty'), qty('actualQty', 'Actual Qty'), qty('varianceQty', 'Variance Qty', 'advancedVarianceQty'),
  { key: 'baseUom', label: 'Base UOM', sortable: true }, money('unitCostExVat', 'Unit Cost Ex VAT'), money('varianceValue', 'Variance Value', 'advancedVarianceValue'), { key: 'reason', label: 'Reason', sortable: true }, { key: 'sourceId', label: 'Source ID', sortable: true }
];

const formulaColumns = [
  { key: 'itemName', label: 'Item', sortable: true }, { key: 'locationName', label: 'Location', sortable: true }, qty('openingStock', 'Opening Stock'), qty('purchases', 'Purchases'), qty('transfersIn', 'Transfers In'), qty('manufacturingIn', 'Manufacturing In'),
  qty('theoreticalUsageQty', 'Theoretical Usage', 'theoreticalUsage'), qty('wastageQty', 'Wastage'), qty('transfersOut', 'Transfers Out'), qty('expectedClosingStock', 'Expected Closing Stock', 'expectedClosingStock'), qty('actualClosingStock', 'Actual Closing Stock'),
  { key: 'formulaResult', label: 'Formula Result' }, qty('varianceQty', 'Variance Qty', 'advancedVarianceQty'), money('varianceValue', 'Variance Value', 'advancedVarianceValue'), percent('calculationConfidence', 'Calculation Confidence', 'dataConfidence'), { key: 'warnings', label: 'Warnings' }
];

export const theoreticalVsActualReport = {
  id: 'theoretical_vs_actual',
  title: 'Theoretical vs Actual',
  section: 'advanced',
  description: 'Compares theoretical stock usage from recipes and sales against actual stock movement, stock takes, wastage, and variances.',
  emptyState: { title: 'No comparison rows available', message: 'No stock items, usage rows, or stock balances matched the selected filters.' },
  suppressEmptyWarning: true,
  showAllWarnings: true,
  allowAllViewsExport: false,
  defaultView: 'summary',
  availableViews: ['summary', 'variance_heatmap', 'by_location', 'by_category', 'by_item', 'variance_detail', 'formula_breakdown'],
  filterConfig: {
    default: ['search', 'dateRange', 'location', 'category', 'inventoryItem', 'riskStatus', 'varianceThreshold', 'onlyHighRisk', 'onlyItemsWithStockTake', 'onlyNegativeVariance', 'onlyPositiveVariance']
  },
  columns: { summary: summaryColumns, variance_heatmap: heatmapColumns, by_location: byLocationColumns, by_category: byCategoryColumns, by_item: byItemColumns, variance_detail: varianceDetailColumns, formula_breakdown: formulaColumns },
  exportMapping: { summary: mapColumns(summaryColumns), variance_heatmap: mapColumns(heatmapColumns), by_location: mapColumns(byLocationColumns), by_category: mapColumns(byCategoryColumns), by_item: mapColumns(byItemColumns), variance_detail: mapColumns(varianceDetailColumns), formula_breakdown: mapColumns(formulaColumns) },
  getRows: async ({ workspaceId, filters, services = {}, dataSet = {}, view = 'summary' }) => {
    const model = await buildTheoreticalVsActualModel({ workspaceId, filters, services, dataSet });
    rememberModel(services, model);
    return attachModelMeta(model.views[view] || model.views.summary, model, model.meta);
  },
  getTotals: ({ rows, view }) => theoreticalTotals(rows, view),
  getPresentation: ({ services }) => buildTheoreticalPresentation(services?.reporting?.__lastTheoreticalVsActualModel),
  validate: ({ services }) => validateTheoreticalModel(services?.reporting?.__lastTheoreticalVsActualModel)
};

export async function buildTheoreticalVsActualModel({ workspaceId = '', filters = {}, services = {}, dataSet = {} } = {}) {
  const cleanFilters = { ...filters, riskStatus: '', onlyHighRisk: '', onlyItemsWithStockTake: '', onlyNegativeVariance: '', onlyPositiveVariance: '' };
  const sources = await loadAdvancedSources({ workspaceId, filters: cleanFilters, services, dataSet, sources: ['stock', 'ledger', 'stockTakes', 'saleUsage'] });
  const stockByKey = new Map(toArray(sources.stock).map((row) => [itemLocationKey(row), row]));
  const ledgerByKey = groupBy(sources.ledger, itemLocationKey);
  const theoreticalUsageRows = toArray(sources.saleUsage).map(normalizeTheoreticalUsageRow);
  const usageByKey = groupBy(theoreticalUsageRows, itemLocationKey);
  const latestStockTake = latestByDate(sources.stockTakes, itemLocationKey, (row) => row.stockTakeDate || normalizeDate(row));
  const keys = new Set([...stockByKey.keys(), ...ledgerByKey.keys(), ...usageByKey.keys(), ...latestStockTake.keys()]);
  const rawRows = [...keys].map((key) => buildComparisonRow(key, { stock: stockByKey.get(key), ledger: ledgerByKey.get(key) || [], usage: usageByKey.get(key) || [], stockTake: latestStockTake.get(key), filters }));
  const varianceValues = rawRows.map((row) => Math.abs(row.varianceValue));
  const scored = rawRows.map((row) => {
    const varianceImpactScore = calculateVarianceImpactScore({ varianceValueImpact: percentileRank(Math.abs(row.varianceValue), varianceValues), variancePercent: row.variancePercent, itemValueImpact: percentileRank(Math.abs(row.actualClosingValue), rawRows.map((item) => Math.abs(item.actualClosingValue))), salesImportance: percentileRank(Math.abs(row.theoreticalUsageValue), rawRows.map((item) => Math.abs(item.theoreticalUsageValue))), dataConfidence: row.calculationConfidence * 100 });
    return { ...row, varianceImpactScore, status: scoreToRiskStatus(varianceImpactScore) };
  });
  let filtered = applyAdvancedFilters(scored, filters, { riskField: 'status' });
  const varianceThreshold = Math.abs(safeNumber(filters.varianceThreshold));
  if (varianceThreshold) filtered = filtered.filter((row) => Math.abs(row.varianceValue) >= varianceThreshold || Math.abs(row.variancePercent * 100) >= varianceThreshold);
  if (String(filters.onlyHighRisk || '').toLowerCase() === 'true') filtered = filtered.filter((row) => ['Critical', 'High Risk'].includes(row.status));
  if (String(filters.onlyItemsWithStockTake || '').toLowerCase() === 'true') filtered = filtered.filter((row) => row.hasStockTake);
  if (String(filters.onlyNegativeVariance || '').toLowerCase() === 'true') filtered = filtered.filter((row) => row.varianceQty < 0);
  if (String(filters.onlyPositiveVariance || '').toLowerCase() === 'true') filtered = filtered.filter((row) => row.varianceQty > 0);
  const dateRange = `${text(filters.startDate) || 'Start'} to ${text(filters.endDate) || 'Today'}`;
  const varianceDetail = filtered.map((row) => ({ id: `variance-detail:${row.id}`, date: text(filters.endDate) || row.lastStockTakeDate || new Date().toISOString().slice(0, 10), locationId: row.locationId, locationName: row.locationName, itemId: row.itemId, itemName: row.itemName, category: row.category, source: row.hasStockTake ? 'Committed Stock Take' : 'Current Stock Balance', documentNumber: row.stockTakeSourceId || '', theoreticalQty: row.theoreticalUsageQty, actualQty: row.actualUsageQty, varianceQty: row.varianceQty, baseUom: row.baseUom, unitCostExVat: row.unitCostExVat, varianceValue: row.varianceValue, reason: varianceReason(row), sourceId: row.stockTakeSourceId || row.itemId }));
  const formulaBreakdown = filtered.map((row) => ({ ...row, formulaResult: `${formatQty(row.expectedClosingStock)} = ${formatQty(row.openingStock)} + ${formatQty(row.purchases)} + ${formatQty(row.transfersIn)} + ${formatQty(row.manufacturingIn)} - ${formatQty(row.theoreticalUsageQty)} - ${formatQty(row.wastageQty)} - ${formatQty(row.transfersOut)}`, warnings: filterCustomerActionableIssueText(row.calculationWarnings.join('; ')) }));
  const summary = aggregateComparison(filtered, 'location', dateRange);
  const heatmap = aggregateComparison(filtered, 'category', dateRange);
  return {
    id: `theoretical:${filters.startDate || 'all'}:${filters.endDate || 'all'}`,
    rows: filtered,
    allRows: scored,
    theoreticalUsageRows,
    stockTakeRows: sources.stockTakes || [],
    sourceWarnings: [...sourceWarnings(sources.stock), ...sourceWarnings(sources.ledger), ...sourceWarnings(sources.stockTakes), ...sourceWarnings(sources.saleUsage)],
    hasAnyCommittedStockTake: toArray(sources.stockTakes).some(isCommittedStockTake),
    meta: sources.ledger?.[0]?.__apiMeta || sources.stock?.[0]?.__apiMeta || {},
    views: { summary, variance_heatmap: heatmap, by_location: summary.map((row) => ({ ...row, dateRange: undefined })), by_category: heatmap, by_item: filtered, variance_detail: varianceDetail, formula_breakdown: formulaBreakdown }
  };
}

function buildComparisonRow(key, { stock = {}, ledger = [], usage = [], stockTake = null, filters = {} }) {
  const sortedLedger = [...toArray(ledger)].sort((a, b) => `${normalizeDate(a)}:${text(a.time)}`.localeCompare(`${normalizeDate(b)}:${text(b.time)}`));
  const firstLedger = sortedLedger[0];
  const ledgerNet = sumBy(sortedLedger, (row) => safeNumber(row.netQty));
  // `stock.currentStock` comes from the live stock-on-hand feed, which has no point-in-time
  // query — it always reflects the balance AS OF RIGHT NOW. It can only be trusted as this
  // period's actual opening/closing basis when the filter's end date is today (or
  // unbounded/future). For any earlier endDate, movements between endDate and today are already
  // baked into it with no way to back them out, which used to fabricate a variance proportional
  // to that gap on every historical-period report run — the report's own comment explains it
  // exists specifically to catch real shrinkage/theft, so a false positive here is as harmful as
  // a missed real one. A committed stock take is unaffected, since it is itself a point-in-time
  // count regardless of when the report is run.
  const endDateFilter = text(filters.endDate).slice(0, 10);
  // Computed in the report's own business timezone, not UTC — a UTC "today" can be off by up to
  // the timezone's offset around local midnight (e.g. ~2 hours for Africa/Johannesburg, UTC+2),
  // occasionally admitting or rejecting the live balance incorrectly right at the day boundary.
  const todayDate = zonedDateTimeStrings(new Date(), DEFAULT_REPORT_TIMEZONE).date;
  const currentStockAsOfPeriodEnd = !endDateFilter || endDateFilter >= todayDate;
  const currentStock = (currentStockAsOfPeriodEnd && stock.currentStock !== undefined) ? safeNumber(stock.currentStock) : null;
  const hasRunningOpening = Boolean(
    firstLedger
    && firstLedger.runningQty !== undefined
    && firstLedger.runningQty !== null
    && String(firstLedger.runningQty).trim() !== ''
  );
  const derivedOpening = hasRunningOpening
    ? safeNumber(firstLedger.runningQty) - safeNumber(firstLedger.netQty)
    : currentStock !== null && sortedLedger.length
      ? currentStock - ledgerNet
      : stock.openingStock !== undefined
        ? safeNumber(stock.openingStock)
        : currentStock ?? 0;
  const purchases = sumBy(sortedLedger.filter(isPurchaseLedgerRow), 'qtyIn');
  const transfersIn = sumBy(sortedLedger.filter(isTransferInRow), 'qtyIn');
  const transfersOut = sumBy(sortedLedger.filter(isTransferOutRow), 'qtyOut');
  const manufacturingIn = sumBy(sortedLedger.filter(isManufacturingInRow), 'qtyIn');
  const manufacturingUsage = sumBy(sortedLedger.filter(isManufacturingOutRow), 'qtyOut');
  const wastageQty = sumBy(sortedLedger.filter(isWastageRow), (row) => Math.abs(safeNumber(row.wastageQty)) || safeNumber(row.qtyOut));
  const recipeUsage = sumBy(usage.filter((row) => row.usageType === 'recipe'), 'qtyUsed');
  const modifierUsage = sumBy(usage.filter((row) => row.usageType === 'modifier'), 'qtyUsed');
  const theoreticalUsageQty = calculateTheoreticalUsage(recipeUsage, modifierUsage, manufacturingUsage);
  const hasStockTake = Boolean(stockTake && isCommittedStockTake(stockTake));
  const expectedClosingStock = calculateExpectedClosingStock({ openingStock: derivedOpening, purchases, transfersIn, manufacturingIn, theoreticalUsage: theoreticalUsageQty, wastage: wastageQty, transfersOut });
  // Without a committed stock take AND without a currentStock figure that's actually usable as of
  // this period's end date, there is no reliable "actual" number at all — falling back to 0 (or
  // to today's stale currentStock) would itself fabricate a variance. Falling back to
  // expectedClosingStock instead makes variance 0-by-construction for this row: an honest "no
  // verified variance available" rather than a false shrinkage/overage signal either way.
  const hasReliableActual = hasStockTake || currentStock !== null;
  const actualClosingStock = hasStockTake
    ? safeNumber(stockTake.countedQty ?? stockTake.convertedBaseQty)
    : (currentStock !== null ? currentStock : expectedClosingStock);
  const varianceQty = calculateVarianceQty(actualClosingStock, expectedClosingStock);
  const unitCostExVat = safeNumber(stock.unitCostExVat || stockTake?.unitCostExVat || firstLedger?.unitCostExVat);
  const varianceValue = calculateVarianceValue(varianceQty, unitCostExVat);
  const variancePercent = calculateQuantityVariancePercent(varianceQty, expectedClosingStock);
  const actualUsageQty = derivedOpening + purchases + transfersIn + manufacturingIn - wastageQty - transfersOut - actualClosingStock;
  const theoreticalUsageValue = roundMoney(theoreticalUsageQty * unitCostExVat);
  const actualUsageValue = roundMoney(actualUsageQty * unitCostExVat);
  const calculationWarnings = [];
  if (!hasStockTake) calculationWarnings.push('No committed stock take in selected period');
  if (!hasReliableActual) calculationWarnings.push('Actual closing stock could not be verified for this historical period without a stock take — variance is not computed and defaults to zero');
  if (!sortedLedger.length) calculationWarnings.push('No stock movement history');
  if (!usage.length && !manufacturingUsage) calculationWarnings.push('No theoretical recipe or modifier usage rows');
  if (!unitCostExVat) calculationWarnings.push('Missing unit cost');
  if (!text(stock.baseUom || stockTake?.baseUom || firstLedger?.baseUom)) calculationWarnings.push('Missing base UOM');
  let confidence = 0;
  if (hasStockTake) confidence += 0.35;
  if (firstLedger || stock.openingStock !== undefined) confidence += 0.20;
  if (usage.length || manufacturingUsage) confidence += 0.20;
  if (currentStock !== null) confidence += 0.10;
  if (unitCostExVat) confidence += 0.10;
  if (text(stock.baseUom || stockTake?.baseUom || firstLedger?.baseUom)) confidence += 0.05;
  return {
    id: `theoretical-item:${key}`, itemId: text(stock.itemId || stockTake?.itemId || firstLedger?.itemId || usage[0]?.itemId), itemName: text(stock.itemName || stockTake?.itemName || firstLedger?.itemName || usage[0]?.itemName) || 'Missing Item',
    category: text(stock.category || stockTake?.category || firstLedger?.category || usage[0]?.category) || 'General', locationId: text(stock.locationId || stockTake?.locationId || firstLedger?.locationId || usage[0]?.locationId), locationName: text(stock.locationName || stockTake?.locationName || firstLedger?.locationName || usage[0]?.locationName) || 'Unknown Location',
    openingStock: derivedOpening, purchases, transfersIn, manufacturingIn, recipeUsageQty: recipeUsage, modifierUsageQty: modifierUsage, manufacturingUsageQty: manufacturingUsage,
    theoreticalUsageQty, actualUsageQty, wastageQty, transfersOut, stockTakeVarianceQty: safeNumber(stockTake?.varianceQty), expectedClosingStock, actualClosingStock, varianceQty,
    baseUom: text(stock.baseUom || stockTake?.baseUom || firstLedger?.baseUom), unitCostExVat, theoreticalUsageValue, actualUsageValue, expectedClosingValue: roundMoney(expectedClosingStock * unitCostExVat), actualClosingValue: roundMoney(actualClosingStock * unitCostExVat), varianceValue, variancePercent,
    accuracyPercent: calculateAccuracyPercent(actualClosingStock, expectedClosingStock), calculationConfidence: Math.min(1, confidence), calculationWarnings, hasStockTake, hasReliableActual, lastStockTakeDate: text(stockTake?.stockTakeDate), stockTakeSourceId: text(stockTake?.sourceId),
    accuracyTrend: []
  };
}

function normalizeTheoreticalUsageRow(row, index) {
  const sourceType = text(row.sourceType || row.source);
  return {
    id: `theoretical-usage:${row.id || row.sourceId || index}`,
    date: text(row.saleDate || row.date).slice(0, 10), locationId: text(row.locationId), locationName: text(row.locationName), itemId: text(row.inventoryItemId || row.itemId), itemName: text(row.inventoryIngredient || row.inventoryItemName || row.itemName),
    category: text(row.inventoryCategoryName || row.category) || 'General', qtyUsed: safeNumber(row.qtyUsed || row.totalQtyUsed), baseUom: text(row.baseUom), unitCostExVat: safeNumber(row.unitCostExVat), sourceType,
    usageType: /modifier/i.test(sourceType) ? 'modifier' : 'recipe', sourceId: text(row.sourceId)
  };
}

function aggregateComparison(rows, mode, dateRange = '') {
  const grouped = groupBy(rows, (row) => mode === 'location' ? (row.locationId || row.locationName) : `${row.locationId || row.locationName}::${row.category}`);
  return [...grouped.entries()].map(([key, group]) => {
    const theoreticalUsageValue = roundMoney(sumBy(group, 'theoreticalUsageValue'));
    const actualUsageValue = roundMoney(sumBy(group, 'actualUsageValue'));
    const expectedClosingValue = roundMoney(sumBy(group, 'expectedClosingValue'));
    const actualClosingValue = roundMoney(sumBy(group, 'actualClosingValue'));
    const varianceValue = roundMoney(actualClosingValue - expectedClosingValue);
    const variancePercent = expectedClosingValue ? varianceValue / expectedClosingValue : 0;
    const accuracyPercent = expectedClosingValue ? Math.max(0, 1 - Math.abs(variancePercent)) : (actualClosingValue === 0 ? 1 : 0);
    const highRiskItems = group.filter((row) => ['Critical', 'High Risk'].includes(row.status)).length;
    const status = highRiskItems ? (group.some((row) => row.status === 'Critical') ? 'Critical' : 'High Risk') : group.some((row) => row.status === 'Watch') ? 'Watch' : 'Healthy';
    const uoms = [...new Set(group.map((row) => row.baseUom).filter(Boolean))];
    return {
      id: `theoretical-${mode}:${key}`, dateRange, locationId: text(group[0]?.locationId), locationName: text(group[0]?.locationName) || 'Unknown Location', category: text(group[0]?.category) || 'General', itemsCompared: group.length,
      theoreticalUsageQty: uoms.length === 1 ? sumBy(group, 'theoreticalUsageQty') : '', actualUsageQty: uoms.length === 1 ? sumBy(group, 'actualUsageQty') : '', baseUom: uoms.length === 1 ? uoms[0] : '',
      theoreticalUsageValue, actualUsageValue, expectedClosingValue, actualClosingValue, varianceValue, variancePercent, accuracyPercent,
      positiveVarianceValue: roundMoney(sumBy(group.filter((row) => row.varianceValue > 0), 'varianceValue')),
      negativeVarianceValue: roundMoney(sumBy(group.filter((row) => row.varianceValue < 0), 'varianceValue')),
      highRiskItems, lastStockTakeDate: group.map((row) => row.lastStockTakeDate).filter(Boolean).sort().pop() || '', status
    };
  });
}

function buildTheoreticalPresentation(model) {
  if (!model) return {};
  const rows = model.rows || [];
  const totalExpected = sumBy(rows, 'expectedClosingValue');
  const totalActual = sumBy(rows, 'actualClosingValue');
  const totalVariance = totalActual - totalExpected;
  const accuracy = totalExpected ? Math.max(0, 1 - Math.abs(totalVariance / totalExpected)) : (totalActual === 0 ? 1 : 0);
  const negative = [...rows].filter((row) => row.varianceValue < 0).sort((a, b) => a.varianceValue - b.varianceValue)[0];
  const positive = [...rows].filter((row) => row.varianceValue > 0).sort((a, b) => b.varianceValue - a.varianceValue)[0];
  const heatData = aggregateComparison(rows, 'category').map((row) => ({ row: row.locationName, column: row.category, value: Math.abs(row.variancePercent), meta: `${row.highRiskItems} high risk`, tooltip: `${row.locationName} / ${row.category}: ${row.varianceValue.toFixed(2)} variance` }));
  const categoryRows = aggregateComparison(rows, 'category').sort((a, b) => Math.abs(b.varianceValue) - Math.abs(a.varianceValue));
  const totalOpening = sumBy(rows, (row) => row.openingStock * row.unitCostExVat);
  const totalPurchases = sumBy(rows, (row) => row.purchases * row.unitCostExVat);
  const totalTransfersIn = sumBy(rows, (row) => row.transfersIn * row.unitCostExVat);
  const totalManufacturingIn = sumBy(rows, (row) => row.manufacturingIn * row.unitCostExVat);
  const totalTheoretical = sumBy(rows, 'theoreticalUsageValue');
  const totalWastage = sumBy(rows, (row) => row.wastageQty * row.unitCostExVat);
  const totalTransfersOut = sumBy(rows, (row) => row.transfersOut * row.unitCostExVat);
  const stockTakeTrend = buildStockTakeAccuracyTrend(model.stockTakeRows || []);
  return {
    summaryCards: [
      { label: 'Total Variance Value', value: totalVariance, format: 'money', tone: totalVariance < 0 ? 'critical' : 'warning' },
      { label: 'Accuracy %', value: accuracy, format: 'percent', tone: accuracy >= 0.95 ? 'positive' : 'warning' },
      { label: 'High Risk Items', value: rows.filter((row) => ['Critical', 'High Risk'].includes(row.status)).length, tone: 'critical' },
      { label: 'Largest Negative Variance', value: negative?.varianceValue || 0, format: 'money', detail: negative?.itemName || '-', tone: 'critical' },
      { label: 'Largest Positive Variance', value: positive?.varianceValue || 0, format: 'money', detail: positive?.itemName || '-', tone: 'accent' }
    ],
    visuals: [
      { type: 'heatmap', title: 'Variance Heatmap', description: 'Absolute variance severity by location and category.', format: 'percent', data: heatData },
      { type: 'bar', title: 'Theoretical vs Actual Usage', description: 'Usage value difference by category and location.', format: 'money', data: categoryRows.slice(0, 10).flatMap((row) => [{ label: `${row.category} · Theoretical`, value: row.theoreticalUsageValue }, { label: `${row.category} · Actual`, value: row.actualUsageValue }]) },
      { type: 'stacked', title: 'Expected Closing Reconciliation', description: 'Value inputs used to calculate expected closing stock.', format: 'money', data: [
        { label: 'Opening Stock', value: totalOpening }, { label: 'Purchases', value: totalPurchases }, { label: 'Transfers In', value: totalTransfersIn }, { label: 'Manufacturing In', value: totalManufacturingIn },
        { label: 'Theoretical Usage', value: totalTheoretical }, { label: 'Wastage', value: totalWastage }, { label: 'Transfers Out', value: totalTransfersOut }, { label: 'Actual Closing', value: totalActual }
      ] },
      { type: 'delta', title: 'Top Variance Items', description: 'Largest negative and positive item variances.', format: 'money', data: rows.slice().sort((a, b) => Math.abs(b.varianceValue) - Math.abs(a.varianceValue)).slice(0, 12).map((row) => ({ label: `${row.itemName} · ${row.locationName}`, value: row.varianceValue })) },
      { type: 'line', title: 'Accuracy Trend', description: 'Accuracy across recent committed stock take dates.', format: 'percent', data: stockTakeTrend }
    ],
    explanation: {
      title: 'How Theoretical vs Actual is calculated',
      description: 'Formula Breakdown exports all calculation inputs and results for item-level audit.',
      formulas: [
        { label: 'Theoretical Usage', formula: 'Sale Usage + Modifier Usage + Manufacturing Ingredient Consumption' },
        { label: 'Expected Closing Stock', formula: 'Opening + Purchases + Transfers In + Manufacturing In - Theoretical Usage - Wastage - Transfers Out', example: '82 = 100 + 20 + 5 + 0 - 35 - 3 - 5' },
        { label: 'Variance Qty', formula: 'Actual Closing Stock - Expected Closing Stock' },
        { label: 'Variance Value', formula: 'Variance Qty × Unit Cost Ex VAT' },
        { label: 'Accuracy %', formula: '1 - absolute(Variance Qty / Expected Closing Stock)' }
      ],
      notes: [model.hasAnyCommittedStockTake ? 'Committed stock takes are used as the preferred actual closing stock.' : 'Theoretical vs Actual is limited because no committed stock take exists for this period.', 'When no committed stock take exists, current location balance is shown as actual closing with lower calculation confidence.']
    }
  };
}

function buildStockTakeAccuracyTrend(rows) {
  const groups = groupBy(toArray(rows).filter(isCommittedStockTake), (row) => row.stockTakeDate || normalizeDate(row));
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, group]) => {
    const expected = sumBy(group, 'expectedValue');
    const counted = sumBy(group, 'countedValue');
    const value = expected ? Math.max(0, 1 - Math.abs((counted - expected) / expected)) : (counted === 0 ? 1 : 0);
    return { label: date, value };
  });
}

function validateTheoreticalModel(model) {
  if (!model) return [];
  const rows = model.rows || [];
  const warnings = [...model.sourceWarnings];
  if (!model.hasAnyCommittedStockTake) warnings.push({ code: 'theoretical-no-committed-stock-take', level: 'warning', message: 'Theoretical vs Actual is limited because no committed stock take exists for this period.' });
  return [...warnings,
    countWarning(rows, 'theoretical-missing-opening-stock', 'warning', 'item/location comparison(s) are missing a trusted opening stock snapshot.', (row) => row.calculationWarnings.includes('No stock movement history')),
    countWarning(rows, 'theoretical-missing-current-stock', 'critical', 'item/location comparison(s) are missing current stock.', (row) => row.actualClosingStock === undefined || row.actualClosingStock === null),
    countWarning(rows, 'theoretical-missing-stock-take', 'warning', 'item/location comparison(s) have no committed stock take.', (row) => !row.hasStockTake),
    countWarning(rows, 'theoretical-missing-recipe-usage', 'warning', 'item/location comparison(s) have no recipe, modifier, or manufacturing usage rows.', (row) => !safeNumber(row.theoreticalUsageQty)),
    countWarning(rows, 'theoretical-missing-unit-cost', 'critical', 'item/location comparison(s) are missing unit cost.', (row) => safeNumber(row.unitCostExVat) <= 0),
    countWarning(rows, 'theoretical-missing-uom', 'critical', 'item/location comparison(s) are missing base UOM.', (row) => !text(row.baseUom)),
    countWarning(rows, 'theoretical-low-confidence', 'warning', 'item/location comparison(s) have low calculation confidence due to incomplete data.', (row) => row.calculationConfidence < 0.6)
  ].filter(Boolean);
}

function isCommittedStockTake(row) {
  const status = text(row?.status || 'committed').toLowerCase();
  return !status || /committed|posted|complete|completed|final/.test(status);
}

function varianceReason(row) {
  if (!row.hasStockTake) return 'Current balance used because no committed stock take exists';
  if (row.varianceQty < 0) return 'Actual closing stock is below expected closing stock';
  if (row.varianceQty > 0) return 'Actual closing stock is above expected closing stock';
  return 'Actual closing stock matches expected closing stock';
}

function theoreticalTotals(rows, view) {
  if (view === 'variance_detail') return { theoreticalQty: sameUomTotal(rows, 'theoreticalQty'), actualQty: sameUomTotal(rows, 'actualQty'), varianceQty: sameUomTotal(rows, 'varianceQty'), varianceValue: roundMoney(sumBy(rows, 'varianceValue')) };
  if (view === 'formula_breakdown' || view === 'by_item') return { theoreticalUsageQty: sameUomTotal(rows, 'theoreticalUsageQty'), actualUsageQty: sameUomTotal(rows, 'actualUsageQty'), varianceQty: sameUomTotal(rows, 'varianceQty'), varianceValue: roundMoney(sumBy(rows, 'varianceValue')) };
  return { itemsCompared: sumBy(rows, 'itemsCompared'), theoreticalUsageValue: roundMoney(sumBy(rows, 'theoreticalUsageValue')), actualUsageValue: roundMoney(sumBy(rows, 'actualUsageValue')), expectedClosingValue: roundMoney(sumBy(rows, 'expectedClosingValue')), actualClosingValue: roundMoney(sumBy(rows, 'actualClosingValue')), varianceValue: roundMoney(sumBy(rows, 'varianceValue')), highRiskItems: sumBy(rows, 'highRiskItems') };
}

function sameUomTotal(rows, key) { return new Set(toArray(rows).map((row) => row.baseUom).filter(Boolean)).size <= 1 ? sumBy(rows, key) : ''; }
function formatQty(value) { return Number(safeNumber(value).toFixed(4)).toString(); }
function rememberModel(services, model) { if (!services.reporting) services.reporting = {}; services.reporting.__lastTheoreticalVsActualModel = model; }
function mapColumns(columns) { return Object.fromEntries(columns.filter((column) => column.key).map((column) => [column.key, column.label])); }

export default theoreticalVsActualReport;
