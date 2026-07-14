import { roundMoney, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { fetchStockOnHandRows } from '../../api/reportingApi.js';
import { mapColumns, rememberPayload, topText, uniqueCount } from '../purchasing/purchasingReportHelpers.js';
import { buildDefaultStockSku } from '../../../../utils/stockSku.js';

const moneyColumn = (key, label, tooltipKey = '') => ({ key, label, type: 'money', align: 'right', sortable: true, ...(tooltipKey ? { tooltipKey } : {}) });
const qtyColumn = (key, label) => ({ key, label, type: 'number', align: 'right', sortable: true });
const numberColumn = (key, label) => ({ key, label, type: 'number', align: 'right', sortable: true });

const summaryColumns = [
  { key: 'locationName', label: 'Location', sortable: true },
  numberColumn('itemsInStock', 'Items In Stock'),
  moneyColumn('totalStockValue', 'Total Stock Value', 'stockValue'),
  numberColumn('lowStockItems', 'Low Stock Items'),
  numberColumn('criticalItems', 'Critical Items'),
  numberColumn('belowParItems', 'Below Par Items'),
  { key: 'lastUpdated', label: 'Last Updated', type: 'datetime', sortable: true }
];

const byLocationColumns = [
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  numberColumn('items', 'Items'),
  moneyColumn('currentStockValue', 'Current Stock Value', 'stockValue'),
  numberColumn('lowStockItems', 'Low Stock Items'),
  numberColumn('criticalItems', 'Critical Items'),
  numberColumn('belowParItems', 'Below Par Items'),
  { key: 'lastMovementDate', label: 'Last Movement Date', type: 'date', sortable: true }
];

const byCategoryColumns = [
  { key: 'category', label: 'Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  numberColumn('items', 'Items'),
  moneyColumn('currentStockValue', 'Current Stock Value', 'stockValue'),
  numberColumn('lowStockItems', 'Low Stock Items'),
  numberColumn('criticalItems', 'Critical Items'),
  numberColumn('belowParItems', 'Below Par Items'),
  { key: 'topSupplier', label: 'Top Supplier', sortable: true }
];

const byItemColumns = [
  { key: 'itemName', label: 'Item', sortable: true },
  { key: 'sku', label: 'SKU', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  qtyColumn('currentStock', 'Current Stock'),
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  moneyColumn('unitCostExVat', 'Unit Cost Ex VAT', 'unitCostExVat'),
  moneyColumn('stockValue', 'Stock Value', 'stockValue'),
  qtyColumn('lowStockThreshold', 'Low Stock Threshold'),
  qtyColumn('parLevel', 'Par Level'),
  { key: 'status', label: 'Status', tooltipKey: 'stockOnHandStatus', sortable: true },
  { key: 'supplierName', label: 'Supplier', sortable: true },
  { key: 'lastMovementDate', label: 'Last Movement Date', type: 'date', sortable: true }
];

const lineDetailColumns = [
  ...byItemColumns.slice(0, 8),
  qtyColumn('openingStock', 'Opening Stock'),
  qtyColumn('qtyIn', 'Qty In'),
  qtyColumn('qtyOut', 'Qty Out'),
  { key: 'lastMovementType', label: 'Last Movement Type', sortable: true },
  { key: 'lastMovementDate', label: 'Last Movement Date', type: 'date', sortable: true },
  { key: 'supplierName', label: 'Supplier', sortable: true },
  { key: 'status', label: 'Status', tooltipKey: 'stockOnHandStatus', sortable: true },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

export const stockOnHandReport = {
  id: 'stock_on_hand',
  title: 'Stock on Hand',
  section: 'inventory',
  description: 'Current stock position by item and location, including value, status, supplier, thresholds, and last movement.',
  emptyState: { title: 'No stock balances found', message: 'No stock-on-hand rows matched the selected filters.' },
  suppressEmptyWarning: true,
  defaultView: 'by_item',
  availableViews: ['summary', 'by_location', 'by_category', 'by_item', 'line_detail'],
  filterConfig: {
    summary: ['search', 'location', 'status'],
    by_location: ['search', 'location', 'category', 'status'],
    by_category: ['search', 'location', 'category', 'supplier', 'status'],
    by_item: ['search', 'location', 'category', 'supplier', 'status'],
    line_detail: ['search', 'location', 'category', 'supplier', 'status']
  },
  columns: {
    summary: summaryColumns,
    by_location: byLocationColumns,
    by_category: byCategoryColumns,
    by_item: byItemColumns,
    line_detail: lineDetailColumns
  },
  exportMapping: {
    summary: mapColumns(summaryColumns),
    by_location: mapColumns(byLocationColumns),
    by_category: mapColumns(byCategoryColumns),
    by_item: {
      itemName: 'Item', sku: 'SKU', category: 'Category', locationName: 'Location', currentStock: 'Current Stock', baseUom: 'UOM', unitCostExVat: 'Unit Cost Ex VAT', stockValue: 'Stock Value', lowStockThreshold: 'Low Stock Threshold', parLevel: 'Par Level', status: 'Status', supplierName: 'Supplier', lastMovementDate: 'Last Movement Date'
    },
    line_detail: mapColumns(lineDetailColumns)
  },
  getRows: async ({ workspaceId, filters, services = {}, view = 'by_item' }) => {
    const payload = services.reporting?.getStockOnHandRows
      ? await services.reporting.getStockOnHandRows({ workspaceId, filters })
      : await fetchStockOnHandRows({ workspaceId, filters });
    rememberPayload(services, '__lastStockOnHandPayload', payload);
    const itemRows = toArray(payload.rows).map(normalizeStockRow);
    const views = buildStockOnHandViews(itemRows);
    return (views[view] || views.by_item).map((row) => ({ ...row, __apiWarnings: payload.warnings || [], __apiMeta: payload.meta || {} }));
  },
  getTotals: ({ rows, view }) => buildTotals(rows, view),
  validate: ({ rows, services, view }) => {
    const warnings = [...toArray(services?.reporting?.__lastStockOnHandPayload?.warnings)];
    if (!rows.length || !['by_item', 'line_detail'].includes(view)) return warnings;
    addCountWarning(rows, warnings, 'stock-on-hand-missing-location', 'critical', 'stock row(s) are missing a location.', (row) => !text(row.locationId || row.locationName));
    addCountWarning(rows, warnings, 'stock-on-hand-missing-item-name', 'critical', 'stock row(s) are missing an item name.', (row) => !text(row.itemName));
    addCountWarning(rows, warnings, 'stock-on-hand-missing-uom', 'critical', 'stock row(s) are missing a base UOM.', (row) => !text(row.baseUom));
    addCountWarning(rows, warnings, 'stock-on-hand-missing-cost', 'critical', 'stock row(s) are missing unit cost.', (row) => !safeNumber(row.unitCostExVat));
    addCountWarning(rows, warnings, 'stock-on-hand-missing-balance', 'critical', 'stock row(s) have no location-specific balance.', (row) => row.hasLocationBalance === false);
    return warnings;
  }
};

export function buildStockOnHandViews(rows = []) {
  return {
    summary: buildSummary(rows),
    by_location: buildLocation(rows),
    by_category: buildCategory(rows),
    by_item: rows,
    line_detail: rows
  };
}

function normalizeStockRow(row = {}, index = 0) {
  const currentStock = safeNumber(row.currentStock ?? row.current_stock);
  const unitCostExVat = safeNumber(row.unitCostExVat ?? row.unit_cost_ex_vat ?? row.unitCost ?? row.unit_cost);
  const lowStockThreshold = safeNumber(row.lowStockThreshold ?? row.low_stock_threshold ?? row.thresholdQty ?? row.threshold_qty);
  const parLevel = safeNumber(row.parLevel ?? row.par_level ?? row.parLevelQty ?? row.par_level_qty);
  const hasLocationBalance = row.hasLocationBalance ?? row.has_location_balance;
  return {
    ...row,
    id: text(row.id) || `stock-on-hand:${text(row.itemId || row.stockItemId)}:${text(row.locationId)}:${index}`,
    itemId: text(row.itemId || row.stockItemId || row.stock_item_id),
    stockItemId: text(row.stockItemId || row.itemId || row.stock_item_id),
    itemName: text(row.itemName || row.item_name),
    sku: text(row.sku) || buildDefaultStockSku(row.itemName || row.item_name),
    category: text(row.category || row.categoryName || row.category_name) || 'General',
    locationId: text(row.locationId || row.location_id),
    locationName: text(row.locationName || row.location_name),
    currentStock,
    baseUom: text(row.baseUom || row.base_uom || row.unit),
    unitCostExVat,
    stockValue: roundMoney(currentStock * unitCostExVat),
    lowStockThreshold,
    parLevel,
    status: resolveStatus(currentStock, lowStockThreshold, parLevel, hasLocationBalance !== false),
    supplierId: text(row.supplierId || row.supplier_id),
    supplierName: text(row.supplierName || row.supplier_name),
    lastMovementDate: text(row.lastMovementDate || row.last_movement_date).slice(0, 10),
    lastMovementType: text(row.lastMovementType || row.last_movement_type),
    lastUpdated: text(row.lastUpdated || row.last_updated || row.balanceUpdatedAt || row.balance_updated_at),
    openingStock: safeNumber(row.openingStock ?? row.opening_stock),
    qtyIn: safeNumber(row.qtyIn ?? row.qty_in),
    qtyOut: safeNumber(row.qtyOut ?? row.qty_out),
    hasLocationBalance: hasLocationBalance === undefined ? true : Boolean(hasLocationBalance),
    sourceId: text(row.sourceId || row.source_id || row.itemId || row.stockItemId)
  };
}

function resolveStatus(currentStock, threshold, parLevel, hasBalance = true) {
  if (!hasBalance || currentStock <= 0) return 'Critical';
  if (currentStock <= threshold) return 'Low';
  if (currentStock < parLevel) return 'Below Par';
  return 'Healthy';
}

function buildSummary(rows) {
  return Array.from(groupBy(rows, (row) => row.locationId || row.locationName).entries()).map(([key, group]) => ({
    id: `stock-on-hand-summary:${key}`,
    locationId: text(group[0]?.locationId),
    locationName: text(group[0]?.locationName) || 'Unknown Location',
    itemsInStock: uniqueCount(group.filter((row) => row.currentStock > 0), (row) => row.itemId || row.itemName),
    totalStockValue: roundMoney(sumBy(group, 'stockValue')),
    lowStockItems: group.filter((row) => row.status === 'Low').length,
    criticalItems: group.filter((row) => row.status === 'Critical').length,
    belowParItems: group.filter((row) => row.currentStock < row.parLevel).length,
    lastUpdated: group.map((row) => row.lastUpdated).filter(Boolean).sort().at(-1) || ''
  }));
}

function buildLocation(rows) {
  return Array.from(groupBy(rows, (row) => `${row.locationId || row.locationName}::${row.category}`).entries()).map(([key, group]) => ({
    id: `stock-on-hand-location:${key}`,
    locationId: text(group[0]?.locationId),
    locationName: text(group[0]?.locationName),
    category: text(group[0]?.category) || 'General',
    items: uniqueCount(group, (row) => row.itemId || row.itemName),
    currentStockValue: roundMoney(sumBy(group, 'stockValue')),
    lowStockItems: group.filter((row) => row.status === 'Low').length,
    criticalItems: group.filter((row) => row.status === 'Critical').length,
    belowParItems: group.filter((row) => row.currentStock < row.parLevel).length,
    lastMovementDate: group.map((row) => row.lastMovementDate).filter(Boolean).sort().at(-1) || ''
  }));
}

function buildCategory(rows) {
  return Array.from(groupBy(rows, (row) => `${row.category}::${row.locationId || row.locationName}`).entries()).map(([key, group]) => ({
    id: `stock-on-hand-category:${key}`,
    category: text(group[0]?.category) || 'General',
    locationId: text(group[0]?.locationId),
    locationName: text(group[0]?.locationName),
    items: uniqueCount(group, (row) => row.itemId || row.itemName),
    currentStockValue: roundMoney(sumBy(group, 'stockValue')),
    lowStockItems: group.filter((row) => row.status === 'Low').length,
    criticalItems: group.filter((row) => row.status === 'Critical').length,
    belowParItems: group.filter((row) => row.currentStock < row.parLevel).length,
    topSupplier: topText(group, (row) => row.supplierName)
  }));
}

function buildTotals(rows, view) {
  if (view === 'summary') return { itemsInStock: sumBy(rows, 'itemsInStock'), totalStockValue: roundMoney(sumBy(rows, 'totalStockValue')), lowStockItems: sumBy(rows, 'lowStockItems'), criticalItems: sumBy(rows, 'criticalItems'), belowParItems: sumBy(rows, 'belowParItems') };
  if (['by_location', 'by_category'].includes(view)) return { items: sumBy(rows, 'items'), currentStockValue: roundMoney(sumBy(rows, 'currentStockValue')), lowStockItems: sumBy(rows, 'lowStockItems'), criticalItems: sumBy(rows, 'criticalItems'), belowParItems: sumBy(rows, 'belowParItems') };
  return { currentStock: sumBy(rows, 'currentStock'), stockValue: roundMoney(sumBy(rows, 'stockValue')), qtyIn: sumBy(rows, 'qtyIn'), qtyOut: sumBy(rows, 'qtyOut') };
}

function addCountWarning(rows, warnings, code, level, message, predicate) {
  if (warnings.some((warning) => warning?.code === code)) return;
  const count = rows.filter(predicate).length;
  if (count) warnings.push({ code, level, message: `${count} ${message}` });
}

export default stockOnHandReport;
