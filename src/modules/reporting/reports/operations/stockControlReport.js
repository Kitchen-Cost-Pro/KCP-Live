import { fetchStockControlRows } from '../../api/reportingApi.js';
import { calculateStockValue, roundMoney, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { formatMoney } from '../../engine/formatters.js';
import { buildRowFormulaTooltip } from '../../tooltips/tooltipBuilder.js';
import { filterCustomerActionableQualityRows } from '../../validators/warningCategories.js';

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
  { key: 'topSupplier', label: 'Top Supplier', sortable: true },
  { key: 'lastUpdated', label: 'Last Updated', type: 'date', sortable: true }
];

const categorySummaryColumns = [
  { key: 'category', label: 'Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  numberColumn('lowStockItems', 'Low Stock Items'),
  numberColumn('criticalItems', 'Critical Items'),
  numberColumn('belowParItems', 'Below Par Items'),
  qtyColumn('requiredQty', 'Required Qty', 'requiredQty'),
  moneyColumn('estimatedReorderValue', 'Estimated Reorder Value', 'estimatedReorderValue'),
  { key: 'topSupplier', label: 'Top Supplier', sortable: true }
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
  { key: 'supplierName', label: 'Supplier', sortable: true },
  moneyColumn('lastPurchaseCost', 'Last Purchase Cost', 'unitCostExVat'),
  { key: 'lastPurchasedDate', label: 'Last Purchased Date', type: 'date', sortable: true },
  { key: 'status', label: 'Status', sortable: true, tooltipKey: 'stockControlStatus' }
];

const reorderDetailColumns = [
  { key: 'supplierName', label: 'Supplier', sortable: true },
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

const supplierReorderColumns = [
  { key: 'supplierName', label: 'Supplier', sortable: true },
  { key: 'locationsText', label: 'Locations', sortable: true },
  numberColumn('itemsToOrder', 'Items To Order'),
  numberColumn('lowStockItems', 'Low Stock Items'),
  numberColumn('criticalItems', 'Critical Items'),
  moneyColumn('estimatedReorderValue', 'Estimated Reorder Value', 'estimatedReorderValue'),
  { key: 'lastPurchaseDate', label: 'Last Purchase Date', type: 'date', sortable: true },
  numberColumn('missingCostItems', 'Missing Cost Items'),
  numberColumn('missingPurchaseUomItems', 'Missing Purchase UOM Items'),
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
  supplierName: 'Supplier',
  lastPurchaseCost: 'Last Purchase Cost',
  lastPurchasedDate: 'Last Purchased Date',
  status: 'Status'
};

const reorderDetailExportMapping = {
  supplierName: 'Supplier',
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

const supplierReorderExportMapping = {
  supplierName: 'Supplier',
  locationsText: 'Locations',
  itemsToOrder: 'Items To Order',
  lowStockItems: 'Low Stock Items',
  criticalItems: 'Critical Items',
  estimatedReorderValue: 'Estimated Reorder Value',
  lastPurchaseDate: 'Last Purchase Date',
  missingCostItems: 'Missing Cost Items',
  missingPurchaseUomItems: 'Missing Purchase UOM Items',
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
  description: 'Shows low stock, critical stock, below-par items, reorder requirements, supplier grouping, estimated reorder value, and stock control warnings.',
  emptyState: { title: 'No low stock items found', message: 'No low stock items found for the selected filters.' },
  suppressEmptyWarning: true,
  defaultView: 'item_detail',
  availableViews: ['location_summary', 'category_summary', 'item_detail', 'reorder_detail', 'supplier_reorder', 'warnings'],
  filterConfig: {
    default: ['search', 'location', 'category', 'supplier', 'status', 'itemType', 'onlyCritical', 'onlyBelowPar', 'missingSupplier', 'missingCost'],
    warnings: ['search', 'location', 'category', 'supplier', 'itemType', 'warningSeverity']
  },
  columns: {
    location_summary: locationSummaryColumns,
    category_summary: categorySummaryColumns,
    item_detail: itemDetailColumns,
    reorder_detail: reorderDetailColumns,
    supplier_reorder: supplierReorderColumns,
    warnings: warningsColumns
  },
  exportMapping: {
    location_summary: {
      locationName: 'Location', lowStockItems: 'Low Stock Items', criticalItems: 'Critical Items', belowParItems: 'Below Par Items', estimatedReorderValue: 'Estimated Reorder Value', topSupplier: 'Top Supplier', lastUpdated: 'Last Updated'
    },
    category_summary: {
      category: 'Category', locationName: 'Location', lowStockItems: 'Low Stock Items', criticalItems: 'Critical Items', belowParItems: 'Below Par Items', requiredQty: 'Required Qty', estimatedReorderValue: 'Estimated Reorder Value', topSupplier: 'Top Supplier'
    },
    item_detail: itemDetailExportMapping,
    reorder_detail: reorderDetailExportMapping,
    supplier_reorder: supplierReorderExportMapping,
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
    return toArray(services?.reporting?.__lastStockControlPayload?.warnings);
  }
};

export function buildStockControlViews(payload = {}) {
  const itemRows = toArray(payload.rows).map(normalizeStockControlItem);
  const warningRows = filterCustomerActionableQualityRows(toArray(payload.warningRows));
  const reorderRows = itemRows.filter((row) => safeNumber(row.requiredQty) > 0 || row.status === 'Critical' || row.status === 'Low' || row.status === 'Below Par');
  return {
    location_summary: buildLocationSummaryRows(itemRows),
    category_summary: buildCategorySummaryRows(itemRows),
    item_detail: itemRows,
    reorder_detail: reorderRows,
    supplier_reorder: buildSupplierReorderRows(reorderRows),
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
    topSupplier: topText(group, (row) => row.supplierName || 'Missing Supplier'),
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
    estimatedReorderValue: roundMoney(sumBy(group, (row) => row.estimatedReorderValue)),
    topSupplier: topText(group, (row) => row.supplierName || 'Missing Supplier')
  }));
}

function buildSupplierReorderRows(rows = []) {
  return Array.from(groupBy(rows, (row) => row.supplierId || row.supplierName || 'Missing Supplier').entries()).map(([key, group]) => ({
    id: `stock-control-supplier:${key}`,
    supplierId: text(group[0]?.supplierId),
    supplierName: text(group[0]?.supplierName) || 'Missing Supplier',
    locationsText: uniqueText(group.map((row) => row.locationName)).join(', '),
    itemsToOrder: group.length,
    lowStockItems: group.filter((row) => row.status === 'Low').length,
    criticalItems: group.filter((row) => row.status === 'Critical').length,
    estimatedReorderValue: roundMoney(sumBy(group, (row) => row.estimatedReorderValue)),
    lastPurchaseDate: maxText(group, (row) => row.lastPurchasedDate),
    missingCostItems: group.filter((row) => safeNumber(row.unitCostExVat) <= 0).length,
    missingPurchaseUomItems: group.filter((row) => !text(row.purchaseUom) || !safeNumber(row.purchaseUomRatio)).length,
    suggestedAction: resolveSupplierAction(group)
  }));
}

function normalizeStockControlItem(row = {}) {
  const currentStock = safeNumber(row.currentStock);
  const parLevel = safeNumber(row.parLevel);
  const lowStockThreshold = safeNumber(row.lowStockThreshold);
  const requiredQty = row.requiredQty !== undefined ? safeNumber(row.requiredQty) : Math.max((parLevel || lowStockThreshold) - currentStock, 0);
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
  if (view === 'supplier_reorder') {
    totals.itemsToOrder = sumBy(rows, (row) => row.itemsToOrder);
    totals.lowStockItems = sumBy(rows, (row) => row.lowStockItems);
    totals.criticalItems = sumBy(rows, (row) => row.criticalItems);
    totals.estimatedReorderValue = roundMoney(sumBy(rows, (row) => row.estimatedReorderValue));
  }
  return totals;
}

function resolveSupplierAction(rows = []) {
  if (rows.some((row) => row.status === 'Critical')) return 'Reorder urgently';
  if (rows.some((row) => row.status === 'Low')) return 'Reorder soon';
  if (rows.some((row) => !text(row.supplierName))) return 'Missing supplier';
  if (rows.some((row) => safeNumber(row.unitCostExVat) <= 0)) return 'Missing cost';
  if (rows.some((row) => !text(row.purchaseUom) || !safeNumber(row.purchaseUomRatio))) return 'Missing purchase UOM';
  return 'Review par level';
}

function topText(rows = [], selector) {
  const counts = new Map();
  rows.forEach((row) => {
    const value = text(selector(row));
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
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

function rememberStockControlPayload(services = {}, payload = {}) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastStockControlPayload = payload;
}

export default stockControlReport;
