import { roundMoney, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { calculatePriceRiskScore, priceVolatilityStatus } from '../../engine/riskScoring.js';
import { average, calculateCoefficientOfVariation, calculateCostChange, calculateCostChangePercent, calculatePriceRange, calculateVolatilityPercent, calculateWeightedAverageCost, percentileRank } from '../../engine/statistics.js';
import { runningAverage } from '../../engine/trendAnalysis.js';
import { applyAdvancedFilters, attachModelMeta, countWarning, itemSupplierKey, loadAdvancedSources, normalizeDate, sourceWarnings } from './advancedReportHelpers.js';

const money = (key, label, tooltipKey = '') => ({ key, label, type: 'money', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const qty = (key, label) => ({ key, label, type: 'number', align: 'right', sortable: true });
const percent = (key, label, tooltipKey = '') => ({ key, label, type: 'percent', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const number = (key, label, tooltipKey = '') => ({ key, label, type: 'number', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const badge = (key, label) => ({ key, label, type: 'badge', sortable: true });

const summaryColumns = [
  { key: 'itemName', label: 'Item', sortable: true }, { key: 'category', label: 'Category', sortable: true }, { key: 'supplierName', label: 'Supplier', sortable: true },
  money('firstCostExVat', 'First Cost Ex VAT'), money('lastPurchaseCostExVat', 'Last Purchase Cost Ex VAT'), money('weightedAverageCostExVat', 'Weighted Average Cost Ex VAT', 'weightedAverageCost'),
  money('lowestCostExVat', 'Lowest Cost Ex VAT'), money('highestCostExVat', 'Highest Cost Ex VAT'), money('priceRange', 'Price Range', 'priceRange'), money('costChange', 'Cost Change', 'costChange'),
  percent('costChangePercent', 'Cost Change %', 'costChangePercent'), percent('volatilityPercent', 'Volatility %', 'volatilityPercent'), percent('coefficientOfVariation', 'Coefficient of Variation', 'coefficientOfVariation'),
  number('purchasesCount', 'Purchases Count'), money('purchaseValue', 'Purchase Value'), { key: 'lastPurchaseDate', label: 'Last Purchase Date', type: 'date', sortable: true }, number('riskScore', 'Risk Score', 'advancedRiskScore'), badge('riskStatus', 'Risk Status')
];

const volatilityMatrixColumns = [
  { key: 'itemName', label: 'Item', sortable: true }, { key: 'supplierName', label: 'Supplier', sortable: true }, { key: 'category', label: 'Category', sortable: true },
  percent('volatilityPercent', 'Volatility %', 'volatilityPercent'), percent('costChangePercent', 'Cost Change %', 'costChangePercent'), money('purchaseValue', 'Purchase Value'), percent('supplierDependencePercent', 'Supplier Dependence %'),
  number('riskScore', 'Risk Score', 'advancedRiskScore'), badge('riskStatus', 'Risk Status'), { key: 'suggestedAction', label: 'Suggested Action', sortable: true }
];

const bySupplierColumns = [
  { key: 'supplierName', label: 'Supplier', sortable: true }, number('itemsPurchased', 'Items Purchased'), number('purchasesCount', 'Purchases Count'), percent('averageCostChangePercent', 'Average Cost Change %'),
  percent('averageVolatilityPercent', 'Average Volatility %'), number('highVolatilityItems', 'High Volatility Items'), money('totalPurchaseValue', 'Total Purchase Value'), { key: 'mostVolatileItem', label: 'Most Volatile Item', sortable: true },
  { key: 'lastPurchaseDate', label: 'Last Purchase Date', type: 'date', sortable: true }, badge('riskStatus', 'Risk Status')
];

const byCategoryColumns = [
  { key: 'category', label: 'Category', sortable: true }, number('itemsPurchased', 'Items Purchased'), percent('averageCostChangePercent', 'Average Cost Change %'), percent('averageVolatilityPercent', 'Average Volatility %'),
  number('highVolatilityItems', 'High Volatility Items'), money('totalPurchaseValue', 'Total Purchase Value'), { key: 'topVolatileItem', label: 'Top Volatile Item', sortable: true }, badge('riskStatus', 'Risk Status')
];

const byItemColumns = [
  { key: 'itemName', label: 'Item', sortable: true }, { key: 'category', label: 'Category', sortable: true }, { key: 'supplierName', label: 'Supplier', sortable: true },
  money('firstCostExVat', 'First Cost Ex VAT'), money('lastPurchaseCostExVat', 'Last Cost Ex VAT'), money('lowestCostExVat', 'Lowest Cost Ex VAT'), money('highestCostExVat', 'Highest Cost Ex VAT'), money('weightedAverageCostExVat', 'Weighted Average Cost Ex VAT', 'weightedAverageCost'),
  money('costChange', 'Cost Change', 'costChange'), percent('costChangePercent', 'Cost Change %', 'costChangePercent'), percent('volatilityPercent', 'Volatility %', 'volatilityPercent'), percent('coefficientOfVariation', 'Coefficient of Variation', 'coefficientOfVariation'),
  number('purchasesCount', 'Purchases Count'), { key: 'lastPurchaseDate', label: 'Last Purchase Date', type: 'date', sortable: true }, badge('riskStatus', 'Risk Status')
];

const priceHistoryColumns = [
  { key: 'purchaseDate', label: 'Purchase Date', type: 'date', sortable: true }, { key: 'supplierName', label: 'Supplier', sortable: true }, { key: 'itemName', label: 'Item', sortable: true }, { key: 'category', label: 'Category', sortable: true },
  { key: 'documentNumber', label: 'Document Number', sortable: true }, { key: 'sourceType', label: 'Source Type', sortable: true }, qty('qtyPurchased', 'Qty Purchased'), { key: 'baseUom', label: 'Base UOM', sortable: true },
  money('unitCostExVat', 'Unit Cost Ex VAT'), money('previousUnitCostExVat', 'Previous Unit Cost Ex VAT'), money('costChange', 'Cost Change', 'costChange'), percent('costChangePercent', 'Cost Change %', 'costChangePercent'), money('runningAverageCost', 'Running Average Cost'),
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

export const priceVolatilityReport = {
  id: 'price_volatility_analysis',
  title: 'Price Volatility Analysis',
  section: 'advanced',
  description: 'Tracks supplier cost changes, purchase price volatility, cost trends, supplier instability, and margin risk.',
  emptyState: { title: 'No purchase cost history available', message: 'No committed GRV purchase lines matched the selected filters.' },
  suppressEmptyWarning: true,
  showAllWarnings: true,
  allowAllViewsExport: false,
  defaultView: 'summary',
  availableViews: ['summary', 'volatility_matrix', 'by_supplier', 'by_category', 'by_item', 'price_history'],
  filterConfig: {
    default: ['search', 'dateRange', 'location', 'category', 'inventoryItem', 'supplier', 'riskStatus', 'costChangeThreshold', 'volatilityThreshold', 'onlyHighVolatility'],
    price_history: ['search', 'dateRange', 'location', 'category', 'inventoryItem', 'supplier']
  },
  columns: { summary: summaryColumns, volatility_matrix: volatilityMatrixColumns, by_supplier: bySupplierColumns, by_category: byCategoryColumns, by_item: byItemColumns, price_history: priceHistoryColumns },
  exportMapping: { summary: mapColumns(summaryColumns), volatility_matrix: mapColumns(volatilityMatrixColumns), by_supplier: mapColumns(bySupplierColumns), by_category: mapColumns(byCategoryColumns), by_item: mapColumns(byItemColumns), price_history: mapColumns(priceHistoryColumns) },
  getRows: async ({ workspaceId, filters, services = {}, dataSet = {}, view = 'summary' }) => {
    const model = await buildPriceVolatilityModel({ workspaceId, filters, services, dataSet });
    rememberModel(services, model);
    return attachModelMeta(model.views[view] || model.views.summary, model, model.meta);
  },
  getTotals: ({ rows, view }) => priceVolatilityTotals(rows, view),
  getPresentation: ({ services }) => buildPriceVolatilityPresentation(services?.reporting?.__lastPriceVolatilityModel),
  validate: ({ services }) => validatePriceVolatilityModel(services?.reporting?.__lastPriceVolatilityModel)
};

export async function buildPriceVolatilityModel({ workspaceId = '', filters = {}, services = {}, dataSet = {} } = {}) {
  const sources = await loadAdvancedSources({ workspaceId, filters: { ...filters, riskStatus: '', onlyHighVolatility: '' }, services, dataSet, sources: ['grv', 'purchaseOrders', 'creditNotes'] });
  const history = toArray(sources.grv).map(normalizePurchaseHistoryRow).sort((a, b) => `${a.purchaseDate}:${a.sourceId}`.localeCompare(`${b.purchaseDate}:${b.sourceId}`));
  const creditHistory = toArray(sources.creditNotes).map(normalizeCreditHistoryRow).filter((row) => row.itemId || row.itemName !== 'Missing Item');
  const itemTotals = new Map();
  groupBy(history, (row) => text(row.itemId || row.itemName).toLowerCase()).forEach((rows, key) => itemTotals.set(key, sumBy(rows, 'purchaseValue')));
  const baseRows = [...groupBy(history, itemSupplierKey).entries()].map(([key, rows]) => buildVolatilityRow(key, rows, itemTotals));
  const purchaseValues = baseRows.map((row) => row.purchaseValue);
  const scoredRows = baseRows.map((row) => ({ ...row, riskScore: calculatePriceRiskScore({ volatilityPercent: row.volatilityPercent, costChangePercent: row.costChangePercent, purchaseValueImpact: percentileRank(row.purchaseValue, purchaseValues), supplierDependence: row.supplierDependencePercent * 100, dataConfidence: row.dataConfidence * 100 }) }));
  scoredRows.forEach((row) => { row.suggestedAction = volatilityAction(row); });
  let filtered = applyAdvancedFilters(scoredRows, filters);
  const costThreshold = Math.abs(safeNumber(filters.costChangeThreshold)) / (safeNumber(filters.costChangeThreshold) > 1 ? 100 : 1);
  const volatilityThreshold = Math.abs(safeNumber(filters.volatilityThreshold)) / (safeNumber(filters.volatilityThreshold) > 1 ? 100 : 1);
  if (costThreshold) filtered = filtered.filter((row) => Math.abs(row.costChangePercent) >= costThreshold);
  if (volatilityThreshold) filtered = filtered.filter((row) => Math.abs(row.volatilityPercent) >= volatilityThreshold);
  if (String(filters.onlyHighVolatility || '').toLowerCase() === 'true') filtered = filtered.filter((row) => row.riskStatus === 'High');
  const allowedKeys = new Set(filtered.map((row) => itemSupplierKey(row)));
  const priceHistory = applyAdvancedFilters(
    [...history, ...creditHistory]
      .filter((row) => allowedKeys.has(itemSupplierKey(row)))
      .sort((a, b) => `${a.purchaseDate}:${a.sourceId}`.localeCompare(`${b.purchaseDate}:${b.sourceId}`)),
    filters
  );
  enrichHistoryWithPrevious(priceHistory);
  return {
    id: `price-volatility:${filters.startDate || 'all'}:${filters.endDate || 'all'}`,
    rows: filtered,
    allRows: scoredRows,
    priceHistory,
    purchaseOrders: sources.purchaseOrders || [],
    creditNotes: sources.creditNotes || [],
    sourceWarnings: [...sourceWarnings(sources.grv), ...sourceWarnings(sources.purchaseOrders), ...sourceWarnings(sources.creditNotes)],
    meta: sources.grv?.[0]?.__apiMeta || {},
    views: {
      summary: filtered,
      volatility_matrix: filtered,
      by_supplier: aggregateVolatility(filtered, 'supplier'),
      by_category: aggregateVolatility(filtered, 'category'),
      by_item: filtered,
      price_history: priceHistory
    }
  };
}

function normalizePurchaseHistoryRow(row, index) {
  const qtyPurchased = safeNumber(row.receivedQty ?? row.qtyPurchased ?? row.quantity);
  const unitCostExVat = safeNumber(row.unitCostExVat);
  return {
    id: `price-history:${row.id || row.sourceId || index}`,
    purchaseDate: normalizeDate(row), supplierId: text(row.supplierId), supplierName: text(row.supplierName) || 'Missing Supplier', itemId: text(row.itemId || row.stockItemId), itemName: text(row.itemName) || 'Missing Item',
    category: text(row.category) || 'General', locationId: text(row.locationId), locationName: text(row.locationName), documentNumber: text(row.grvNumber || row.invoiceNumber || row.documentNumber), sourceType: 'GRV',
    qtyPurchased, baseUom: text(row.baseUom), unitCostExVat, purchaseValue: roundMoney(row.lineValueExVat !== undefined ? safeNumber(row.lineValueExVat) : qtyPurchased * unitCostExVat), sourceId: text(row.sourceId || row.grvId)
  };
}

function normalizeCreditHistoryRow(row, index) {
  const qtyCredited = Math.abs(safeNumber(row.qtyCredited ?? row.quantity));
  const unitCostExVat = safeNumber(row.unitCostExVat);
  const lineCreditExVat = Math.abs(safeNumber(row.lineCreditExVat ?? row.creditValueExVat ?? qtyCredited * unitCostExVat));
  return {
    id: `price-credit-history:${row.id || row.sourceId || index}`,
    purchaseDate: text(row.creditNoteDate).slice(0, 10) || normalizeDate(row),
    supplierId: text(row.supplierId),
    supplierName: text(row.supplierName) || 'Missing Supplier',
    itemId: text(row.itemId || row.stockItemId),
    itemName: text(row.itemName) || 'Missing Item',
    category: text(row.category) || 'General',
    locationId: text(row.locationId),
    locationName: text(row.locationName),
    documentNumber: text(row.creditNoteNumber || row.documentNumber),
    sourceType: 'Credit Note',
    qtyPurchased: -qtyCredited,
    baseUom: text(row.baseUom),
    unitCostExVat,
    purchaseValue: -roundMoney(lineCreditExVat),
    sourceId: text(row.sourceId || row.creditNoteId)
  };
}

function buildVolatilityRow(key, rows, itemTotals) {
  const sorted = [...rows].sort((a, b) => `${a.purchaseDate}:${a.sourceId}`.localeCompare(`${b.purchaseDate}:${b.sourceId}`));
  const costs = sorted.map((row) => row.unitCostExVat).filter((value) => value > 0);
  const firstCost = costs[0] || 0;
  const lastCost = costs.at(-1) || 0;
  const weightedAverageCost = calculateWeightedAverageCost(sorted.map((row) => ({ qty: row.qtyPurchased, unitCostExVat: row.unitCostExVat })));
  const lowestCost = costs.length ? Math.min(...costs) : 0;
  const highestCost = costs.length ? Math.max(...costs) : 0;
  const itemKey = text(sorted[0]?.itemId || sorted[0]?.itemName).toLowerCase();
  const purchaseValue = roundMoney(sumBy(sorted, 'purchaseValue'));
  const supplierDependencePercent = itemTotals.get(itemKey) ? purchaseValue / itemTotals.get(itemKey) : 0;
  const purchasesCount = sorted.length;
  const volatilityPercent = calculateVolatilityPercent(lowestCost, highestCost, weightedAverageCost);
  const costChangePercent = calculateCostChangePercent(firstCost, lastCost);
  const validCostCount = sorted.filter((row) => safeNumber(row.unitCostExVat) > 0).length;
  const costCompleteness = purchasesCount ? validCostCount / purchasesCount : 0;
  const dateCompleteness = purchasesCount ? sorted.filter((row) => row.purchaseDate).length / purchasesCount : 0;
  const dataConfidence = Math.min(1, purchasesCount / 6) * 0.65 + costCompleteness * 0.20 + dateCompleteness * 0.15;
  return {
    id: `price-volatility:${key}`, itemId: sorted[0]?.itemId, itemName: sorted[0]?.itemName, category: sorted[0]?.category || 'General', supplierId: sorted[0]?.supplierId, supplierName: sorted[0]?.supplierName || 'Missing Supplier',
    firstCostExVat: firstCost, lastPurchaseCostExVat: lastCost, weightedAverageCostExVat: weightedAverageCost, lowestCostExVat: lowestCost, highestCostExVat: highestCost,
    priceRange: calculatePriceRange(lowestCost, highestCost), costChange: calculateCostChange(firstCost, lastCost), costChangePercent, volatilityPercent, coefficientOfVariation: calculateCoefficientOfVariation(costs),
    purchasesCount, purchaseValue, lastPurchaseDate: sorted.at(-1)?.purchaseDate || '', supplierDependencePercent, riskStatus: priceVolatilityStatus({ purchasesCount, volatilityPercent, costChangePercent }), dataConfidence,
    priceTrend: costs
  };
}

function enrichHistoryWithPrevious(rows) {
  groupBy(rows, itemSupplierKey).forEach((group) => {
    const sorted = [...group].sort((a, b) => `${a.purchaseDate}:${a.sourceId}`.localeCompare(`${b.purchaseDate}:${b.sourceId}`));
    const averages = runningAverage(sorted.map((row) => row.unitCostExVat));
    sorted.forEach((row, index) => {
      row.previousUnitCostExVat = index ? sorted[index - 1].unitCostExVat : 0;
      row.costChange = index ? calculateCostChange(row.previousUnitCostExVat, row.unitCostExVat) : 0;
      row.costChangePercent = index ? calculateCostChangePercent(row.previousUnitCostExVat, row.unitCostExVat) : 0;
      row.runningAverageCost = averages[index] || 0;
    });
  });
}

function aggregateVolatility(rows, mode) {
  const grouped = groupBy(rows, (row) => mode === 'supplier' ? (row.supplierId || row.supplierName) : row.category);
  return [...grouped.entries()].map(([key, group]) => {
    const sorted = [...group].sort((a, b) => b.volatilityPercent - a.volatilityPercent);
    const high = group.filter((row) => row.riskStatus === 'High').length;
    const common = {
      id: `volatility-${mode}:${key}`,
      itemsPurchased: new Set(group.map((row) => row.itemId || row.itemName)).size,
      purchasesCount: sumBy(group, 'purchasesCount'),
      averageCostChangePercent: average(group.map((row) => row.costChangePercent)),
      averageVolatilityPercent: average(group.map((row) => row.volatilityPercent)),
      highVolatilityItems: high,
      totalPurchaseValue: roundMoney(sumBy(group, 'purchaseValue')),
      lastPurchaseDate: group.map((row) => row.lastPurchaseDate).filter(Boolean).sort().pop() || '',
      riskStatus: high ? 'High' : group.some((row) => row.riskStatus === 'Medium') ? 'Medium' : group.every((row) => row.riskStatus === 'Insufficient Data') ? 'Insufficient Data' : 'Low'
    };
    return mode === 'supplier'
      ? { ...common, supplierId: group[0]?.supplierId, supplierName: group[0]?.supplierName || 'Missing Supplier', mostVolatileItem: sorted[0]?.itemName || '' }
      : { ...common, category: group[0]?.category || 'General', topVolatileItem: sorted[0]?.itemName || '' };
  });
}

function volatilityAction(row) {
  if (row.purchasesCount < 2) return 'Monitor next GRV';
  if (row.riskStatus === 'High' && row.supplierDependencePercent >= 0.8) return 'Find alternative supplier';
  if (row.riskStatus === 'High' && row.costChangePercent > 0) return 'Negotiate supplier cost';
  if (row.riskStatus === 'High') return 'Review supplier pricing';
  if (row.riskStatus === 'Medium') return 'Monitor next GRV';
  return 'No action needed';
}

function buildPriceVolatilityPresentation(model) {
  if (!model) return {};
  const rows = model.rows || [];
  const high = rows.filter((row) => row.riskStatus === 'High');
  const increases = rows.filter((row) => row.costChangePercent > 0);
  const largest = [...rows].sort((a, b) => b.costChangePercent - a.costChangePercent)[0];
  const supplierAgg = aggregateVolatility(rows, 'supplier').sort((a, b) => b.averageVolatilityPercent - a.averageVolatilityPercent);
  const categorySupplierHeat = [...groupBy(rows, (row) => `${row.supplierName}::${row.category}`).values()].map((group) => ({ row: group[0]?.supplierName || 'Missing Supplier', column: group[0]?.category || 'General', value: average(group.map((row) => row.volatilityPercent)), meta: `${group.length} item${group.length === 1 ? '' : 's'}` }));
  const trendItem = [...rows].sort((a, b) => b.riskScore - a.riskScore)[0];
  return {
    summaryCards: [
      { label: 'High Volatility Items', value: high.length, detail: '20% volatility or 15% cost change', tone: 'critical' },
      { label: 'Average Cost Increase %', value: increases.length ? average(increases.map((row) => row.costChangePercent)) : 0, format: 'percent', tone: 'warning' },
      { label: 'Largest Cost Increase', value: largest?.costChangePercent || 0, format: 'percent', detail: largest?.itemName || '-', tone: 'critical' },
      { label: 'Most Volatile Supplier', value: supplierAgg[0]?.supplierName || '-', detail: supplierAgg[0] ? `${(supplierAgg[0].averageVolatilityPercent * 100).toFixed(1)}% average volatility` : '', tone: 'accent' },
      { label: 'Purchase Value at Risk', value: sumBy(high, 'purchaseValue'), format: 'money', tone: 'warning' }
    ],
    visuals: [
      { type: 'line', title: trendItem ? `Price Trend · ${trendItem.itemName}` : 'Price Trend', description: trendItem ? `Supplier: ${trendItem.supplierName}` : 'Select a longer date range to build a cost trend.', format: 'money', data: (trendItem?.priceTrend || []).map((value, index) => ({ label: String(index + 1), value })) },
      { type: 'bar', title: 'Volatility by Supplier', description: 'Average volatility across purchased items.', format: 'percent', data: supplierAgg.slice(0, 10).map((row) => ({ label: row.supplierName, value: row.averageVolatilityPercent })) },
      { type: 'heatmap', title: 'Category Volatility Heatmap', description: 'Average price volatility by supplier and category.', format: 'percent', data: categorySupplierHeat },
      { type: 'delta', title: 'Largest Cost Changes', description: 'First purchase cost compared with latest purchase cost.', format: 'percent', data: rows.slice().sort((a, b) => Math.abs(b.costChangePercent) - Math.abs(a.costChangePercent)).slice(0, 10).map((row) => ({ label: row.itemName, value: row.costChangePercent })) },
      { type: 'sparkTable', title: 'Top Volatile Items', description: 'Purchase cost history for the highest-risk items.', format: 'percent', data: rows.slice().sort((a, b) => b.riskScore - a.riskScore).slice(0, 8).map((row) => ({ label: row.itemName, meta: row.supplierName, values: row.priceTrend, value: row.volatilityPercent })) }
    ],
    explanation: {
      title: 'How price volatility is calculated',
      description: 'Committed GRV unit costs drive volatility calculations; credit notes are retained in the audit history when they carry a usable cost.',
      formulas: [
        { label: 'Weighted Average Cost', formula: 'Σ(Qty Purchased × Unit Cost) / Σ(Qty Purchased)' },
        { label: 'Cost Change', formula: 'Last Purchase Cost - First Purchase Cost' },
        { label: 'Cost Change %', formula: '(Last Cost - First Cost) / First Cost' },
        { label: 'Volatility %', formula: '(Highest Cost - Lowest Cost) / Weighted Average Cost' },
        { label: 'Coefficient of Variation', formula: 'Standard Deviation of Unit Costs / Average Unit Cost' }
      ],
      notes: ['Purchase orders are compared for data-quality checks but do not replace committed GRV prices.', 'Credit notes appear as negative audit-history rows and do not inflate purchased quantity or weighted average cost.', 'Fewer than two purchases produces Insufficient Data rather than a false zero-volatility result.']
    }
  };
}

function validatePriceVolatilityModel(model) {
  if (!model) return [];
  const history = model.priceHistory || [];
  const rows = model.rows || [];
  const warnings = [...model.sourceWarnings,
    countWarning(history, 'volatility-missing-supplier', 'critical', 'purchase line(s) are missing supplier.', (row) => !text(row.supplierName) || row.supplierName === 'Missing Supplier'),
    countWarning(history, 'volatility-missing-item', 'critical', 'purchase line(s) are missing item.', (row) => !text(row.itemName) || row.itemName === 'Missing Item'),
    countWarning(history, 'volatility-missing-unit-cost', 'critical', 'purchase line(s) are missing unit cost.', (row) => safeNumber(row.unitCostExVat) <= 0),
    countWarning(history, 'volatility-missing-date', 'warning', 'purchase line(s) are missing purchase date.', (row) => !text(row.purchaseDate)),
    countWarning(rows, 'volatility-insufficient-history', 'warning', 'item/supplier combination(s) have fewer than 2 purchases, so volatility cannot be calculated.', (row) => row.purchasesCount < 2)
  ].filter(Boolean);
  const latestGrvByItem = new Map();
  rows.forEach((row) => latestGrvByItem.set(text(row.itemId || row.itemName).toLowerCase(), row));
  const mismatches = toArray(model.purchaseOrders).filter((po) => {
    const grv = latestGrvByItem.get(text(po.itemId || po.itemName).toLowerCase());
    return grv && safeNumber(po.unitCostExVat) > 0 && Math.abs(safeNumber(po.unitCostExVat) - safeNumber(grv.lastPurchaseCostExVat)) > 0.01;
  });
  if (mismatches.length) warnings.push({ code: 'po-grv-cost-difference', level: 'warning', message: `${mismatches.length} purchase order line(s) differ from the latest committed GRV cost.` });
  const unclearCredits = toArray(model.creditNotes).filter((row) => !text(row.reason) || safeNumber(row.unitCostExVat) <= 0);
  if (unclearCredits.length) warnings.push({ code: 'credit-note-cost-impact-unclear', level: 'warning', message: `${unclearCredits.length} credit note line(s) have unclear purchase-cost impact.` });
  return warnings;
}

function priceVolatilityTotals(rows, view) {
  if (view === 'price_history') return { qtyPurchased: sumBy(rows, 'qtyPurchased'), purchaseValue: roundMoney(sumBy(rows, 'purchaseValue')) };
  if (['by_supplier', 'by_category'].includes(view)) return { itemsPurchased: sumBy(rows, 'itemsPurchased'), purchasesCount: sumBy(rows, 'purchasesCount'), highVolatilityItems: sumBy(rows, 'highVolatilityItems'), totalPurchaseValue: roundMoney(sumBy(rows, 'totalPurchaseValue')) };
  return { purchasesCount: sumBy(rows, 'purchasesCount'), purchaseValue: roundMoney(sumBy(rows, 'purchaseValue')) };
}

function rememberModel(services, model) { if (!services.reporting) services.reporting = {}; services.reporting.__lastPriceVolatilityModel = model; }
function mapColumns(columns) { return Object.fromEntries(columns.filter((column) => column.key).map((column) => [column.key, column.label])); }

export default priceVolatilityReport;
