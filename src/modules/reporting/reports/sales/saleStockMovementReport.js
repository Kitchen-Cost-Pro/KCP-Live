import { fetchSaleStockUsageRows } from '../../api/reportingApi.js';
import { formatMoney, formatQuantity } from '../../engine/formatters.js';
import { text, toArray } from '../../engine/grouping.js';
import { validateSaleStockUsageRows } from '../../validators/salesUsageValidators.js';
import { buildRowWarnings } from '../../validators/rowWarningUtils.js';
import { buildSaleStockMovementModel, moneyTooltip, stockMovementTotals } from './salesReportHelpers.js';

const summaryColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'salesCount', label: 'Sales Count', type: 'number', align: 'right', sortable: true },
  { key: 'grossSales', label: 'Gross Sales', type: 'money', align: 'right', tooltipKey: 'grossSales', sortable: true },
  { key: 'vat', label: 'VAT', type: 'money', align: 'right', tooltipKey: 'salesVat', sortable: true },
  { key: 'netSales', label: 'Net Sales', type: 'money', align: 'right', tooltipKey: 'netSales', sortable: true },
  { key: 'recipeStockValueUsed', label: 'Recipe Stock Value Used', type: 'money', align: 'right', tooltipKey: 'stockValueUsed', sortable: true },
  { key: 'modifierStockValueUsed', label: 'Modifier Stock Value Used', type: 'money', align: 'right', tooltipKey: 'stockValueUsed', sortable: true },
  { key: 'totalStockValueUsed', label: 'Total Stock Value Used', type: 'money', align: 'right', tooltipKey: 'totalStockValueUsed', cellTooltip: totalStockValueTooltip, sortable: true },
  { key: 'grossProfit', label: 'Gross Profit', type: 'money', align: 'right', tooltipKey: 'grossProfit', cellTooltip: grossProfitTooltip, sortable: true },
  { key: 'gpPercent', label: 'GP %', type: 'percent', align: 'right', tooltipKey: 'gpPercent', cellTooltip: gpPercentTooltip, sortable: true }
];

const byMenuItemColumns = [
  { key: 'menuItemName', label: 'Menu Item', sortable: true },
  { key: 'menuCategory', label: 'Menu Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'qtySold', label: 'Qty Sold', type: 'number', align: 'right', sortable: true },
  { key: 'grossSales', label: 'Gross Sales', type: 'money', align: 'right', tooltipKey: 'grossSales', sortable: true },
  { key: 'vat', label: 'VAT', type: 'money', align: 'right', tooltipKey: 'salesVat', sortable: true },
  { key: 'netSales', label: 'Net Sales', type: 'money', align: 'right', tooltipKey: 'netSales', sortable: true },
  { key: 'recipeStockCost', label: 'Recipe Stock Cost', type: 'money', align: 'right', tooltipKey: 'stockValueUsed', sortable: true },
  { key: 'modifierStockCost', label: 'Modifier Stock Cost', type: 'money', align: 'right', tooltipKey: 'stockValueUsed', sortable: true },
  { key: 'totalStockCost', label: 'Total Stock Cost', type: 'money', align: 'right', tooltipKey: 'totalStockValueUsed', cellTooltip: totalStockCostTooltip, sortable: true },
  { key: 'grossProfit', label: 'Gross Profit', type: 'money', align: 'right', tooltipKey: 'grossProfit', cellTooltip: grossProfitByMenuTooltip, sortable: true },
  { key: 'gpPercent', label: 'GP %', type: 'percent', align: 'right', tooltipKey: 'gpPercent', sortable: true },
  { key: 'foodCostPercent', label: 'Food Cost %', type: 'percent', align: 'right', tooltipKey: 'foodCostPercent', sortable: true }
];

const byInventoryCategoryColumns = [
  { key: 'date', label: 'Date', type: 'date', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'inventoryCategoryName', label: 'Inventory Category', sortable: true },
  { key: 'qtyUsed', label: 'Qty Used', type: 'number', align: 'right', sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'stockValueUsed', label: 'Stock Value Used', type: 'money', align: 'right', tooltipKey: 'stockValueUsed', sortable: true },
  { key: 'linkedSalesNet', label: 'Linked Sales Net', type: 'money', align: 'right', tooltipKey: 'netSales', sortable: true },
  { key: 'grossProfit', label: 'Gross Profit', type: 'money', align: 'right', tooltipKey: 'grossProfit', sortable: true },
  { key: 'gpPercent', label: 'GP %', type: 'percent', align: 'right', tooltipKey: 'gpPercent', sortable: true }
];

const byInventoryItemColumns = [
  { key: 'inventoryItemName', label: 'Inventory Item', sortable: true },
  { key: 'inventoryCategoryName', label: 'Inventory Category', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'qtyUsed', label: 'Qty Used', type: 'number', align: 'right', sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money', align: 'right', sortable: true },
  { key: 'stockValueUsed', label: 'Stock Value Used', type: 'money', align: 'right', tooltipKey: 'stockValueUsed', cellTooltip: stockValueDetailTooltip, sortable: true },
  { key: 'linkedMenuItems', label: 'Linked Menu Items', sortable: true },
  { key: 'saleCount', label: 'Sale Count', type: 'number', align: 'right', sortable: true },
  { key: 'sourceType', label: 'Source Type', sortable: true }
];

const recipeLineDetailColumns = [
  { key: 'saleDate', label: 'Sale Date', type: 'date', sortable: true },
  { key: 'saleTime', label: 'Sale Time', type: 'time', sortable: true },
  { key: 'receiptNumber', label: 'Receipt Number', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'menuItemSold', label: 'Menu Item Sold', sortable: true },
  { key: 'qtySold', label: 'Qty Sold', type: 'number', align: 'right', sortable: true },
  { key: 'recipeLineType', label: 'Recipe Line Type', sortable: true },
  { key: 'recipeSubRecipe', label: 'Recipe / Sub-Recipe', sortable: true },
  { key: 'inventoryIngredient', label: 'Inventory Ingredient', sortable: true },
  { key: 'inventoryCategoryName', label: 'Inventory Category', sortable: true },
  { key: 'ingredientQtyPerSale', label: 'Ingredient Qty Per Sale', type: 'number', align: 'right', tooltipKey: 'recipeQtyUsed', sortable: true },
  { key: 'totalQtyUsed', label: 'Total Qty Used', type: 'number', align: 'right', tooltipKey: 'recipeQtyUsed', cellTooltip: recipeQtyTooltip, sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money', align: 'right', sortable: true },
  { key: 'stockValueUsed', label: 'Stock Value Used', type: 'money', align: 'right', tooltipKey: 'stockValueUsed', cellTooltip: stockValueDetailTooltip, sortable: true },
  { key: 'recipeLevel', label: 'Recipe Level', sortable: true },
  { key: 'parentRecipe', label: 'Parent Recipe', sortable: true },
  { key: 'sourceType', label: 'Source Type', sortable: true },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];

const transactionDetailColumns = [
  { key: 'saleDate', label: 'Sale Date', type: 'date', sortable: true },
  { key: 'saleTime', label: 'Sale Time', type: 'time', sortable: true },
  { key: 'receiptNumber', label: 'Receipt Number', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  { key: 'menuItemName', label: 'Menu Item', sortable: true },
  { key: 'inventoryIngredient', label: 'Inventory Ingredient', sortable: true },
  { key: 'inventoryCategoryName', label: 'Inventory Category', sortable: true },
  { key: 'sourceType', label: 'Source Type', sortable: true },
  { key: 'qtyUsed', label: 'Qty Used', type: 'number', align: 'right', sortable: true },
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  { key: 'unitCostExVat', label: 'Unit Cost Ex VAT', type: 'money', align: 'right', sortable: true },
  { key: 'stockValueUsed', label: 'Stock Value Used', type: 'money', align: 'right', tooltipKey: 'stockValueUsed', cellTooltip: stockValueDetailTooltip, sortable: true },
  { key: 'grossSaleAmount', label: 'Gross Sale Amount', type: 'money', align: 'right', tooltipKey: 'grossSales', sortable: true },
  { key: 'vatAmount', label: 'VAT', type: 'money', align: 'right', tooltipKey: 'salesVat', sortable: true },
  { key: 'netSaleAmount', label: 'Net Sale Amount', type: 'money', align: 'right', tooltipKey: 'netSales', sortable: true },
  { key: 'createdBy', label: 'Created By', sortable: true },
  { key: 'sourceId', label: 'Source ID', sortable: true }
];


const summaryExportMapping = {
  date: 'Date',
  locationName: 'Location',
  salesCount: 'Sales Count',
  grossSales: 'Gross Sales',
  vat: 'VAT',
  netSales: 'Net Sales',
  recipeStockValueUsed: 'Recipe Stock Value Used',
  modifierStockValueUsed: 'Modifier Stock Value Used',
  totalStockValueUsed: 'Total Stock Value Used',
  grossProfit: 'Gross Profit',
  gpPercent: 'GP %'
};

const byMenuItemExportMapping = {
  menuItemName: 'Menu Item',
  menuCategory: 'Menu Category',
  locationName: 'Location',
  qtySold: 'Qty Sold',
  grossSales: 'Gross Sales',
  vat: 'VAT',
  netSales: 'Net Sales',
  recipeStockCost: 'Recipe Stock Cost',
  modifierStockCost: 'Modifier Stock Cost',
  totalStockCost: 'Total Stock Cost',
  grossProfit: 'Gross Profit',
  gpPercent: 'GP %',
  foodCostPercent: 'Food Cost %'
};

const byInventoryCategoryExportMapping = {
  date: 'Date',
  locationName: 'Location',
  inventoryCategoryName: 'Inventory Category',
  qtyUsed: 'Qty Used',
  baseUom: 'Base UOM',
  stockValueUsed: 'Stock Value Used',
  linkedSalesNet: 'Linked Sales Net',
  grossProfit: 'Gross Profit',
  gpPercent: 'GP %'
};

const byInventoryItemExportMapping = {
  inventoryItemName: 'Inventory Item',
  inventoryCategoryName: 'Inventory Category',
  locationName: 'Location',
  qtyUsed: 'Qty Used',
  baseUom: 'Base UOM',
  unitCostExVat: 'Unit Cost Ex VAT',
  stockValueUsed: 'Stock Value Used',
  linkedMenuItems: 'Linked Menu Items',
  saleCount: 'Sale Count',
  sourceType: 'Source Type'
};

const movementExportMapping = {
  saleDate: 'Sale Date',
  saleTime: 'Sale Time',
  receiptNumber: 'Receipt Number',
  locationName: 'Location',
  menuItemSold: 'Menu Item Sold',
  qtySold: 'Qty Sold',
  recipeSubRecipe: 'Recipe / Sub-Recipe',
  inventoryIngredient: 'Inventory Ingredient',
  inventoryCategoryName: 'Inventory Category',
  sourceType: 'Source Type',
  qtyUsed: 'Qty Used',
  baseUom: 'UOM',
  unitCostExVat: 'Unit Cost Ex VAT',
  stockValueUsed: 'Stock Value Used',
  grossSaleAmount: 'Gross Sale Amount',
  vatAmount: 'VAT',
  netSaleAmount: 'Net Sale Amount',
  createdBy: 'Created By',
  sourceId: 'Source ID'
};

export const saleStockMovementReport = {
  id: 'sale_stock_movement',
  title: 'Sale Stock Movement Report',
  section: 'sales',
  description: 'Advanced recipe and inventory usage per menu item sold from Yoco sales data.',
  emptyState: { title: 'No Yoco sales found', message: 'No Yoco sales found for the selected filters.' },
  suppressEmptyWarning: true,
  hiddenFromDashboard: true,
  defaultView: 'summary',
  availableViews: ['summary', 'by_menu_item', 'by_inventory_category', 'by_inventory_item', 'recipe_line_detail', 'transaction_detail'],
  filterConfig: {
    summary: ['search', 'dateRange', 'location', 'menuCategory', 'menuItem', 'inventoryCategory', 'inventoryItem', 'sourceType'],
    by_menu_item: ['search', 'dateRange', 'location', 'menuCategory', 'menuItem', 'sourceType'],
    by_inventory_category: ['search', 'dateRange', 'location', 'inventoryCategory', 'sourceType'],
    by_inventory_item: ['search', 'dateRange', 'location', 'inventoryCategory', 'inventoryItem', 'sourceType'],
    recipe_line_detail: ['search', 'dateRange', 'location', 'menuCategory', 'menuItem', 'inventoryCategory', 'inventoryItem', 'sourceType'],
    transaction_detail: ['search', 'dateRange', 'location', 'menuCategory', 'menuItem', 'inventoryCategory', 'inventoryItem', 'sourceType']
  },
  columns: {
    summary: summaryColumns,
    by_menu_item: byMenuItemColumns,
    by_inventory_category: byInventoryCategoryColumns,
    by_inventory_item: byInventoryItemColumns,
    recipe_line_detail: recipeLineDetailColumns,
    transaction_detail: transactionDetailColumns
  },
  exportColumns: {
    summary: summaryColumns,
    by_menu_item: byMenuItemColumns,
    by_inventory_category: byInventoryCategoryColumns,
    by_inventory_item: byInventoryItemColumns,
    recipe_line_detail: recipeLineDetailColumns,
    transaction_detail: transactionDetailColumns
  },
  getRows: async ({ workspaceId, filters, services = {}, view = 'summary' }) => {
    const payload = services.reporting?.getSaleStockUsageRows
      ? await services.reporting.getSaleStockUsageRows({ workspaceId, filters })
      : await fetchSaleStockUsageRows({ workspaceId, filters });
    const model = buildSaleStockMovementModel(payload.rows || []);
    rememberStockMovementModel(services, model, payload);
    return (model.views[view] || model.views.summary).map((row) => withUsageMeta(row, payload));
  },
  getTotals: ({ rows }) => stockMovementTotals(rows),
  validate: ({ rows, services }) => [
    ...toArray(services?.reporting?.__lastSaleStockMovementPayload?.warnings),
    ...validateSaleStockUsageRows(rows),
    ...validateMovementRows(rows)
  ],
  exportMapping: {
    summary: summaryExportMapping,
    by_menu_item: byMenuItemExportMapping,
    by_inventory_category: byInventoryCategoryExportMapping,
    by_inventory_item: byInventoryItemExportMapping,
    recipe_line_detail: movementExportMapping,
    transaction_detail: movementExportMapping
  }
};

function rememberStockMovementModel(services = {}, model = {}, payload = {}) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastSaleStockMovementModel = model;
  services.reporting.__lastSaleStockMovementPayload = payload;
}

function withUsageMeta(row = {}, payload = {}) {
  return {
    ...row,
    __apiMeta: payload.meta,
    __reportSourceRows: payload.rows
  };
}

function validateMovementRows(rows = []) {
  const warnings = [];
  const sourceRows = toArray(rows).flatMap((row) => toArray(row.__rows).length ? row.__rows : [row]);
  const add = (predicate, code, level, message) => {
    warnings.push(...buildRowWarnings(sourceRows, code, level, message, predicate));
  };
  add((row) => !text(row.menuItemId) || text(row.menuItemName) === 'Unmapped Menu Item', 'yoco-sale-line-unmatched', 'critical', 'YOCO sale line is not matched to a local menu item.');
  add((row) => !text(row.inventoryItemId) || text(row.inventoryItemName) === 'Unmapped Ingredient', 'recipe-missing-stock-item', 'critical', 'Recipe line is missing stock item mapping.');
  add((row) => !text(row.locationId) || text(row.locationName) === 'Unmapped Location', 'yoco-location-unmapped', 'warning', 'YOCO sale line is not mapped to a local location.');
  add((row) => !text(row.receiptNumber), 'receipt-number-missing', 'warning', 'Usage line is missing receipt number.');
  add((row) => !text(row.sourceId), 'source-id-missing', 'critical', 'Usage line is missing source ID.');
  add((row) => row.sourceType === 'Modifier Usage' && !text(row.modifierId) && !text(row.modifierName), 'modifier-stock-mapping-missing', 'critical', 'Modifier usage line is missing modifier mapping details.');
  return warnings;
}

function totalStockValueTooltip(row = {}) {
  return moneyTooltip('totalStockValueUsed', `${formatMoney(row.totalStockValueUsed)} = ${formatMoney(row.recipeStockValueUsed)} + ${formatMoney(row.modifierStockValueUsed)}`);
}

function totalStockCostTooltip(row = {}) {
  return moneyTooltip('totalStockValueUsed', `${formatMoney(row.totalStockCost)} = ${formatMoney(row.recipeStockCost)} + ${formatMoney(row.modifierStockCost)}`);
}

function grossProfitTooltip(row = {}) {
  return moneyTooltip('grossProfit', `${formatMoney(row.grossProfit)} = ${formatMoney(row.netSales)} - ${formatMoney(row.totalStockValueUsed)}`);
}

function grossProfitByMenuTooltip(row = {}) {
  return moneyTooltip('grossProfit', `${formatMoney(row.grossProfit)} = ${formatMoney(row.netSales)} - ${formatMoney(row.totalStockCost)}`);
}

function gpPercentTooltip(row = {}) {
  return moneyTooltip('gpPercent', `${(Number(row.gpPercent || 0) * 100).toFixed(2)}% = ${formatMoney(row.grossProfit)} / ${formatMoney(row.netSales)}`);
}

function stockValueDetailTooltip(row = {}) {
  return moneyTooltip('stockValueUsed', `${formatMoney(row.stockValueUsed)} = ${formatQuantity(row.qtyUsed || row.totalQtyUsed, row.baseUom)} x ${formatMoney(row.unitCostExVat)}`);
}

function recipeQtyTooltip(row = {}) {
  return moneyTooltip('recipeQtyUsed', `${formatQuantity(row.totalQtyUsed, row.baseUom)} = ${row.qtySold || 0} sold x ${formatQuantity(row.ingredientQtyPerSale, row.baseUom)}`);
}
