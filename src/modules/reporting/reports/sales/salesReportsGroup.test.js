import test from 'node:test';
import assert from 'node:assert/strict';
import { getReportDefinition, listReports } from '../index.js';
import { getExportColumns } from '../../exports/exportMappers.js';
import { buildPaymentModel, buildSaleStockMovementModel } from './salesReportHelpers.js';

const saleRows = [
  {
    id: 'sale-1',
    workspaceId: 'ws-1',
    locationId: 'loc-1',
    locationName: 'Main Bar',
    saleDate: '2026-07-09',
    saleTime: '12:00',
    receiptNumber: 'R-001',
    paymentMethod: 'Card',
    status: 'completed',
    grossAmount: 115,
    vatAmount: 15,
    netAmount: 100,
    discountAmount: 5,
    refundAmount: 0,
    tipAmount: 10,
    feeAmount: 2,
    payoutAmount: 123,
    createdBy: 'yoco',
    sourceId: 'yo-1'
  }
];

const usageRows = [
  {
    id: 'usage-1',
    locationId: 'loc-1',
    locationName: 'Main Bar',
    saleDate: '2026-07-09',
    saleTime: '12:00',
    receiptNumber: 'R-001',
    saleId: 'sale-1',
    saleLineId: 'line-1',
    menuItemId: 'burger',
    menuItemName: 'Burger',
    menuCategory: 'Food',
    inventoryItemId: 'bun',
    inventoryItemName: 'Burger Bun',
    inventoryCategoryName: 'Bakery',
    sourceType: 'Sale Usage',
    sourceId: 'yo-1',
    qtySold: 2,
    qtyUsed: 2,
    baseUom: 'ea',
    unitCostExVat: 5,
    stockValueUsed: 10,
    grossSaleAmount: 230,
    vatAmount: 30,
    netSaleAmount: 200,
    recipeLineType: 'Direct Ingredient',
    recipeName: 'Burger Recipe',
    recipeLevel: 'Level 1',
    parentRecipe: 'Burger Recipe',
    createdBy: 'yoco'
  },
  {
    id: 'usage-2',
    locationId: 'loc-1',
    locationName: 'Main Bar',
    saleDate: '2026-07-09',
    saleTime: '12:00',
    receiptNumber: 'R-001',
    saleId: 'sale-1',
    saleLineId: 'line-1',
    menuItemId: 'burger',
    menuItemName: 'Burger',
    menuCategory: 'Food',
    modifierId: 'cheese',
    modifierName: 'Cheese Extra',
    inventoryItemId: 'cheese-slice',
    inventoryItemName: 'Cheese Slice',
    inventoryCategoryName: 'Dairy',
    sourceType: 'Modifier Usage',
    sourceId: 'yo-1',
    qtySold: 2,
    qtyUsed: 2,
    baseUom: 'ea',
    unitCostExVat: 3,
    stockValueUsed: 6,
    grossSaleAmount: 230,
    vatAmount: 30,
    netSaleAmount: 200,
    recipeLineType: 'Modifier Ingredient',
    recipeName: 'Cheese Extra',
    recipeLevel: 'Level 1',
    parentRecipe: 'Burger Recipe',
    createdBy: 'yoco'
  }
];

test('Sales Reports dashboard tile groups payment and stock movement reports without hiding direct report definitions', () => {
  const salesReports = listReports({ section: 'sales' });
  assert.deepEqual(salesReports.map((report) => report.id), ['sales_reports', 'modifier_report']);
  const group = getReportDefinition('sales_reports');
  assert.equal(group.type, 'group');
  assert.equal(group.defaultReportId, 'payment_sales_financial');
  assert.deepEqual(group.reports.map((report) => report.id), ['payment_sales_financial', 'sale_stock_movement']);
  assert.equal(getReportDefinition('payment_sales_financial').hiddenFromDashboard, true);
  assert.equal(getReportDefinition('sale_stock_movement').hiddenFromDashboard, true);
});

test('Payment Summary keeps gross, VAT, net, refunds, discounts, tips, fees, and payout separate', () => {
  const model = buildPaymentModel(saleRows);
  const daily = model.views.daily_summary[0];
  assert.equal(daily.grossSales, 115);
  assert.equal(daily.vat, 15);
  assert.equal(daily.netSales, 100);
  assert.equal(daily.discounts, 5);
  assert.equal(daily.tips, 10);
  assert.equal(daily.fees, 2);
  assert.equal(daily.payoutAmount, 108);
  assert.notEqual(daily.grossSales, daily.netSales);
});

test('Sale Stock Movement builds advanced recipe line detail and separates modifier usage cost', () => {
  const model = buildSaleStockMovementModel(usageRows);
  const summary = model.views.summary[0];
  assert.equal(summary.recipeStockValueUsed, 10);
  assert.equal(summary.modifierStockValueUsed, 6);
  assert.equal(summary.totalStockValueUsed, 16);
  assert.equal(summary.grossProfit, 184);
  const detail = model.views.recipe_line_detail;
  assert.equal(detail.length, 2);
  assert.deepEqual(detail.map((row) => row.recipeLineType), ['Direct Ingredient', 'Modifier Ingredient']);
  assert.equal(detail[0].totalQtyUsed, 2);
  assert.equal(detail[0].ingredientQtyPerSale, 1);
});


test('Sale Stock Movement exports each view with its visible view columns', () => {
  const report = getReportDefinition('sale_stock_movement');
  const expectations = {
    summary: ['date', 'locationName', 'salesCount', 'grossSales', 'vat', 'netSales', 'recipeStockValueUsed', 'modifierStockValueUsed', 'totalStockValueUsed', 'grossProfit', 'gpPercent'],
    by_menu_item: ['menuItemName', 'menuCategory', 'locationName', 'qtySold', 'grossSales', 'vat', 'netSales', 'recipeStockCost', 'modifierStockCost', 'totalStockCost', 'grossProfit', 'gpPercent', 'foodCostPercent'],
    by_inventory_category: ['date', 'locationName', 'inventoryCategoryName', 'qtyUsed', 'baseUom', 'stockValueUsed', 'linkedSalesNet', 'grossProfit', 'gpPercent'],
    by_inventory_item: ['inventoryItemName', 'inventoryCategoryName', 'locationName', 'qtyUsed', 'baseUom', 'unitCostExVat', 'stockValueUsed', 'linkedMenuItems', 'saleCount', 'sourceType']
  };
  Object.entries(expectations).forEach(([view, keys]) => {
    const columns = getExportColumns({ report, view, columns: report.columns[view], exportMapping: report.exportMapping[view] });
    assert.deepEqual(columns.map((column) => column.key), keys);
  });
});
