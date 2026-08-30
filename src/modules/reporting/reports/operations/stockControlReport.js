import { fetchStockControlRows } from '../../api/reportingApi.js';
import { calculateStockValue, roundMoney, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { formatMoney } from '../../engine/formatters.js';
import { buildRowFormulaTooltip } from '../../tooltips/tooltipBuilder.js';
import { filterCustomerActionableQualityRows } from '../../validators/warningCategories.js';
export { isManufacturedStockControlRow, isOrderableStockControlRow } from './stockControlOrderability.js';

const money = (value) => formatMoney(value || 0);
const qty = (value) => safeNumber(value).toFixed(3).replace(/\.000$/, '');
const tooltip = (key, values = '') => buildRowFormulaTooltip(key, values);

const requiredQtyTooltip = (row) => tooltip('requiredQty', `Required Qty = Par Level - Current Stock\n${qty(row.requiredQty)} = ${qty(row.parLevel)} - ${qty(row.currentStock)}`);
const estimatedReorderValueTooltip = (row) => tooltip('estimatedReorderValue', `Estimated Reorder Value = Required Qty x Unit Cost Ex VAT\n${money(row.estimatedReorderValue)} = ${qty(row.requiredQty)} x ${money(row.unitCostExVat)}`);
const purchaseUomQtyTooltip = (row) => tooltip('purchaseUomQty', `Purchase UOM Qty = Required Qty / Purchase UOM Conversion Ratio\n${qty(row.purchaseUomQty)} = ${qty(row.requiredQty)} / ${qty(row.purchaseUomRatio || 1)}`);

const moneyColumn = (key, label, tooltipKey, cellTooltip) => ({ key, label, type: 'money', align: 'right', tooltipKey, cellTooltip, sortable: true });
const numberColumn = (key, label) => ({ key, label, type: 'number', align: 'right', sortable: true });
const qtyColumn = (key, label, tooltipKey, cellTooltip) => ({ key, label, type: 'qty', align: 'right', tooltipKey, cellTooltip, sortable: true });

const locationSummaryColumns = [
  { key: 'locationName', label: 'Location', sortable: true },
  numberColumn('lowStockItems', 'Low Stock Items'),
  numberColumn('criticalItems', 'Critical Items'),
  numberColumn('belowParItems', 'Below Par Items'),
  moneyColumn('estimatedReorderValue', 'Estimated Reorder Value', 'estimatedReorderValue'),
  { key: 'lastUpdated', label: 'Last Updated', type: 'date', sortable: true }
];

const categorySummaryColumns = [
  { key: 'category', label: 'Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  numberColumn('lowStockItems', 'Low Stock Items'),
  numberColumn('criticalItems', 'Critical Items'),
  numberColumn('belowParItems', 'Below Par Items'),
  qtyColumn('requiredQty', 'Required Qty', 'requiredQty'),
  moneyColumn('estimatedReorderValue', 'Estimated Reorder Value', 'estimatedReorderValue')
];

const itemDetailColumns = [
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  qtyColumn('currentStock', 'Current Stock'),
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  qtyColumn('lowStockThreshold', 'Low Stock Threshold'),
  qtyColumn('parLevel', 'Par Level'),
  qtyColumn('requiredQty', 'Required Qty', 'requiredQty', requiredQtyTooltip),
  moneyColumn('unitCostExVat', 'Unit Cost Ex VAT', 'unitCostExVat'),
  moneyColumn('estimatedReorderValue', 'Estimated Reorder Value', 'estimatedReorderValue', estimatedReorderValueTooltip),
  moneyColumn('lastPurchaseCost', 'Last Purchase Cost', 'unitCostExVat'),
  { key: 'lastPurchasedDate', label: 'Last Purchased Date', type: 'date', sortable: true },
  { key: 'status', label: 'Status', sortable: true, tooltipKey: 'stockControlStatus' }
];

const reorderDetailColumns = [
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  qtyColumn('currentStock', 'Current Stock'),
  qtyColumn('parLevel', 'Par Level'),
  qtyColumn('requiredQty', 'Required Qty', 'requiredQty', requiredQtyTooltip),
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'purchaseUom', label: 'Purchase UOM', sortable: true },
  qtyColumn('purchaseUomQty', 'Purchase UOM Qty', 'purchaseUomQty', purchaseUomQtyTooltip),
  moneyColumn('unitCostExVat', 'Unit Cost Ex VAT', 'unitCostExVat'),
  moneyColumn('estimatedReorderValue', 'Estimated Reorder Value', 'estimatedReorderValue', estimatedReorderValueTooltip),
  moneyColumn('lastPurchaseCost', 'Last Purchase Cost', 'unitCostExVat'),
  { key: 'lastPurchasedDate', label: 'Last Purchased Date', type: 'date', sortable: true },
  { key: 'suggestedAction', label: 'Suggested Action', sortable: true }
];

const warningsColumns = [
  { key: 'severity', label: 'Severity', sortable: true },
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'issueType', label: 'Issue Type', sortable: true },
  { key: 'issue', label: 'Issue', sortable: false },
  { key: 'impact', label: 'Impact', sortable: false },
  { key: 'suggestedFix', label: 'Suggested Fix', sortable: false }
];

const itemDetailExportMapping = {
  itemName: 'Item',
  category: 'Category',
  locationName: 'Location',
  currentStock: 'Current Stock',
  baseUom: 'UOM',
  lowStockThreshold: 'Low Stock Threshold',
  parLevel: 'Par Level',
  requiredQty: 'Required Qty',
  unitCostExVat: 'Unit Cost Ex VAT',
  estimatedReorderValue: 'Estimated Reorder Value',
  lastPurchaseCost: 'Last Purchase Cost',
  lastPurchasedDate: 'Last Purchased Date',
  status: 'Status'
};

const reorderDetailExportMapping = {
  itemName: 'Item',
  category: 'Category',
  locationName: 'Location',
  currentStock: 'Current Stock',
  parLevel: 'Par Level',
  requiredQty: 'Required Qty',
  baseUom: 'UOM',
  purchaseUom: 'Purchase UOM',
  purchaseUomQty: 'Purchase UOM Qty',
  unitCostExVat: 'Unit Cost Ex VAT',
  estimatedReorderValue: 'Estimated Reorder Value',
  lastPurchaseCost: 'Last Purchase Cost',
  lastPurchasedDate: 'Last Purchased Date',
  suggestedAction: 'Suggested Action'
};

const warningsExportMapping = {
  severity: 'Severity',
  itemName: 'Item',
  category: 'Category',
  locationName: 'Location',
  issueType: 'Issue Type',
  issue: 'Issue',
  impact: 'Impact',
  suggestedFix: 'Suggested Fix'
};

export const stockControlReport = {
  id: 'stock_control',
  title: 'Stock Control',
  section: 'stock_control',
  description: 'Shows low stock, critical stock, below-par items, reorder requirements, estimated reorder value, and stock control warnings. Items are not restricted to a saved supplier or ordering location.',
  emptyState: { title: 'No low stock items found', message: 'No low stock items found for the selected filters.' },
  suppressEmptyWarning: true,
  defaultView: 'item_detail',
  availableViews: ['location_summary', 'category_summary', 'item_detail', 'reorder_detail', 'warnings'],
  filterConfig: {
    default: ['search', 'location', 'category', 'status', 'itemType', 'onlyCritical', 'onlyBelowPar', 'missingCost'],
    warnings: ['search', 'location', 'category', 'itemType', 'warningSeverity']
  },
  columns: {
    location_summary: locationSummaryColumns,
    category_summary: categorySummaryColumns,
    item_detail: itemDetailColumns,
    reorder_detail: reorderDetailColumns,
    warnings: warningsColumns
  },
  exportMapping: {
    location_summary: {
      locationName: 'Location', lowStockItems: 'Low Stock Items', criticalItems: 'Critical Items', belowParItems: 'Below Par Items', estimatedReorderValue: 'Estimated Reorder Value', lastUpdated: 'Last Updated'
    },
    category_summary: {
      category: 'Category', locationName: 'Location', lowStockItems: 'Low Stock Items', criticalItems: 'Critical Items', belowParItems: 'Below Par Items', requiredQty: 'Required Qty', estimatedReorderValue: 'Estimated Reorder Value'
    },
    item_detail: itemDetailExportMapping,
    reorder_detail: reorderDetailExportMapping,
    warnings: warningsExportMapping
  },
  getRows: async ({ workspaceId, filters, services = {}, view = 'item_detail' }) => {
    const payload = services.reporting?.getStockControlRows
      ? await services.reporting.getStockControlRows({ workspaceId, filters })
      : await fetchStockControlRows({ workspaceId, filters });
    rememberStockControlPayload(services, payload);
    const rowsByView = buildStockControlViews(payload);
    return rowsByView[view] || rowsByView.item_detail;
  },
  getTotals: ({ rows, view }) => buildStockControlTotals(rows, view),
  validate: ({ rows, services }) => {
    if (!rows.length) return [];
    return filterCustomerActionableQualityRows(toArray(services?.reporting?.__lastStockControlPayload?.warnings)).filter((row) => !isSupplierOnlyWarning(row));
  }
};

export function buildStockControlViews(payload = {}) {
  const itemRows = toArray(payload.rows).map(normalizeStockControlItem);
  const warningRows = filterCustomerActionableQualityRows(toArray(payload.warningRows)).filter((row) => !isSupplierOnlyWarning(row));
  const reorderRows = itemRows.filter((row) => safeNumber(row.requiredQty) > 0 || row.status === 'Critical' || row.status === 'Low' || row.status === 'Below Par');
  return {
    location_summary: buildLocationSummaryRows(itemRows),
    category_summary: buildCategorySummaryRows(itemRows),
    item_detail: itemRows,
    reorder_detail: reorderRows,
    warnings: warningRows
  };
}

function buildLocationSummaryRows(rows = []) {
  return Array.from(groupBy(rows, (row) => row.locationId || row.locationName).entries()).map(([key, group]) => ({
    id: `stock-control-location:${key}`,
    locationId: text(group[0]?.locationId),
    locationName: text(group[0]?.locationName) || 'Unknown Location',
    lowStockItems: group.filter((row) => row.status === 'Low').length,
    criticalItems: group.filter((row) => row.status === 'Critical').length,
    belowParItems: group.filter((row) => row.status === 'Below Par' || row.status === 'Low' || row.status === 'Critical').length,
    estimatedReorderValue: roundMoney(sumBy(group, (row) => row.estimatedReorderValue)),
    lastUpdated: maxText(group, (row) => row.lastUpdated)
  }));
}

function buildCategorySummaryRows(rows = []) {
  return Array.from(groupBy(rows, (row) => `${row.category || 'General'}::${row.locationId || row.locationName}`).entries()).map(([key, group]) => ({
    id: `stock-control-category:${key}`,
    category: text(group[0]?.category) || 'General',
    locationId: text(group[0]?.locationId),
    locationName: text(group[0]?.locationName) || 'Unknown Location',
    lowStockItems: group.filter((row) => row.status === 'Low').length,
    criticalItems: group.filter((row) => row.status === 'Critical').length,
    belowParItems: group.filter((row) => row.status === 'Below Par' || row.status === 'Low' || row.status === 'Critical').length,
    requiredQty: singleUomOrBlank(group, 'requiredQty'),
    estimatedReorderValue: roundMoney(sumBy(group, (row) => row.estimatedReorderValue))
  }));
}

function normalizeStockControlItem(row = {}) {
  const currentStock = safeNumber(row.currentStock);
  // A deliberately-set `parLevel: 0` (e.g. a discontinued item that should never be reordered) is
  // falsy in JS — `parLevel || lowStockThreshold` would silently replace it with the low-stock
  // threshold instead of respecting the explicit zero, fabricating a nonzero reorder recommendation
  // for an item the business explicitly wants at zero. Check presence on the raw field before it's
  // coerced to a number, since `safeNumber` itself already collapses "missing" and "zero" to 0.
  const parLevelSupplied = row.parLevel !== undefined && row.parLevel !== null && text(row.parLevel) !== '';
  const parLevel = safeNumber(row.parLevel);
  const lowStockThreshold = safeNumber(row.lowStockThreshold);
  const requiredQty = row.requiredQty !== undefined
    ? safeNumber(row.requiredQty)
    : Math.max((parLevelSupplied ? parLevel : lowStockThreshold) - currentStock, 0);
  const unitCostExVat = safeNumber(row.unitCostExVat);
  return {
    ...row,
    currentStock,
    parLevel,
    lowStockThreshold,
    requiredQty,
    unitCostExVat,
    estimatedReorderValue: row.estimatedReorderValue !== undefined ? safeNumber(row.estimatedReorderValue) : calculateStockValue(requiredQty, unitCostExVat),
    purchaseUomQty: safeNumber(row.purchaseUomQty),
    purchaseUomRatio: safeNumber(row.purchaseUomRatio, 1)
  };
}

function buildStockControlTotals(rows = [], view = 'item_detail') {
  const totals = {};
  if (['location_summary', 'category_summary'].includes(view)) {
    totals.lowStockItems = sumBy(rows, (row) => row.lowStockItems);
    totals.criticalItems = sumBy(rows, (row) => row.criticalItems);
    totals.belowParItems = sumBy(rows, (row) => row.belowParItems);
    totals.requiredQty = singleUomOrBlank(rows, 'requiredQty');
    totals.estimatedReorderValue = roundMoney(sumBy(rows, (row) => row.estimatedReorderValue));
  }
  if (['item_detail', 'reorder_detail'].includes(view)) {
    totals.requiredQty = singleUomOrBlank(rows, 'requiredQty');
    totals.purchaseUomQty = singlePurchaseUomOrBlank(rows);
    totals.estimatedReorderValue = roundMoney(sumBy(rows, (row) => row.estimatedReorderValue));
  }
  return totals;
}

function maxText(rows = [], selector) {
  return rows.map(selector).map(text).filter(Boolean).sort().pop() || '';
}

function uniqueText(values = []) {
  return Array.from(new Set(toArray(values).map(text).filter(Boolean))).sort();
}

function singleUomOrBlank(rows = [], key = 'requiredQty') {
  const uoms = uniqueText(rows.map((row) => row.baseUom));
  if (uoms.length > 1) return '';
  return sumBy(rows, (row) => row[key]);
}

function singlePurchaseUomOrBlank(rows = []) {
  const uoms = uniqueText(rows.map((row) => row.purchaseUom));
  if (uoms.length > 1) return '';
  return sumBy(rows, (row) => row.purchaseUomQty);
}

function isSupplierOnlyWarning(row = {}) {
  const content = [row.issueType, row.issue, row.impact, row.suggestedFix, row.message]
    .map(text)
    .join(' ')
    .toLowerCase();
  return /supplier/.test(content);
}

function rememberStockControlPayload(services = {}, payload = {}) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastStockControlPayload = payload;
}

export default stockControlReport;
