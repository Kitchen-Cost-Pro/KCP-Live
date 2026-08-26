import test from 'node:test';
import assert from 'node:assert/strict';
import { getReportDefinition, listReports } from '../index.js';
import { buildModifierReportModel } from './modifierReport.js';
import { normalizeApiModifierSalesRow } from '../../api/reportingMappers.js';

const modifierRows = [
  {
    id: 'm-1',
    saleDate: '2026-07-09',
    saleTime: '12:00',
    receiptNumber: 'R-100',
    locationName: 'Main Bar',
    menuItemId: 'burger',
    menuItemName: 'Burger',
    menuCategory: 'Food',
    modifierGroupId: 'extras',
    modifierGroupName: 'Burger Extras',
    modifierId: 'cheese',
    yocoModifierId: 'cheese',
    modifierName: 'Extra Cheese',
    modifierType: 'Product',
    stockActionType: 'ADD_RECIPE',
    qty: 2,
    timesSelected: 2,
    grossAmount: 46,
    vatAmount: 6,
    netAmount: 40,
    linkedProduct: 'Extra Cheese',
    linkedStockItemName: 'Cheese Slice',
    stockQtyDeducted: 2,
    baseUom: 'ea',
    unitCostExVat: 5,
    stockCost: 10,
    grossProfit: 30,
    stockDeductionStatus: 'Deducted',
    createdBy: 'yoco',
    sourceId: 'mov-1',
    sourceType: 'Modifier Usage',
    parentLineId: 'line-100',
    menuItemSaleKey: 'R-100|line-100',
    menuItemGrossAmount: 115,
    menuItemVatAmount: 15,
    menuItemNetAmount: 100,
    menuItemBaseStockCost: 40,
    menuItemModifierStockCost: 10,
    menuItemTotalStockCost: 50,
    menuItemGrossProfit: 50,
    menuItemGpPercent: 0.5,
    hasModifierUsage: true,
    modifierMarkedStockDeducting: true
  },
  {
    id: 'm-2',
    saleDate: '2026-07-09',
    saleTime: '12:01',
    receiptNumber: 'R-101',
    locationName: 'Main Bar',
    menuItemId: 'burger',
    menuItemName: 'Burger',
    menuCategory: 'Food',
    modifierGroupId: 'extras',
    modifierGroupName: 'Burger Extras',
    modifierId: 'no-onion',
    yocoModifierId: 'no-onion',
    modifierName: 'No Onion',
    modifierType: 'Note',
    stockActionType: 'REMOVE_INGREDIENT',
    qty: 1,
    timesSelected: 1,
    grossAmount: 0,
    vatAmount: 0,
    netAmount: 0,
    stockQtyDeducted: 0,
    stockCost: 0,
    stockDeductionStatus: 'No Stock Mapping Required',
    createdBy: 'yoco',
    sourceId: 'R-101:line-1:modifier:no-onion',
    sourceType: 'Modifier Usage',
    parentLineId: 'line-101',
    menuItemSaleKey: 'R-101|line-101',
    menuItemGrossAmount: 92,
    menuItemVatAmount: 12,
    menuItemNetAmount: 80,
    menuItemBaseStockCost: 35,
    menuItemModifierStockCost: 0,
    menuItemTotalStockCost: 35,
    menuItemGrossProfit: 45,
    menuItemGpPercent: 0.5625,
    hasModifierUsage: false,
    modifierMarkedStockDeducting: false
  },
  {
    id: 'm-3',
    saleDate: '2026-07-09',
    saleTime: '12:02',
    receiptNumber: 'R-102',
    locationName: 'Main Bar',
    menuItemId: 'burger',
    menuItemName: 'Burger',
    menuCategory: 'Food',
    modifierGroupId: 'extras',
    modifierGroupName: 'Burger Extras',
    modifierId: 'bacon',
    yocoModifierId: 'bacon',
    modifierName: 'Extra Bacon',
    modifierType: 'Product',
    stockActionType: 'ADD_STOCK_ITEM',
    qty: 1,
    timesSelected: 1,
    grossAmount: 0,
    vatAmount: 0,
    netAmount: 0,
    linkedProduct: 'Extra Bacon',
    linkedStockItemName: 'Bacon',
    stockQtyDeducted: 1,
    baseUom: 'ea',
    unitCostExVat: 12,
    stockCost: 12,
    grossProfit: -12,
    stockDeductionStatus: 'Deducted',
    createdBy: 'yoco',
    sourceId: 'mov-3',
    sourceType: 'Modifier Usage',
    parentLineId: 'line-102',
    menuItemSaleKey: 'R-102|line-102',
    menuItemGrossAmount: 138,
    menuItemVatAmount: 18,
    menuItemNetAmount: 120,
    menuItemBaseStockCost: 50,
    menuItemModifierStockCost: 12,
    menuItemTotalStockCost: 62,
    menuItemGrossProfit: 58,
    menuItemGpPercent: 0.4833333333,
    hasModifierUsage: true,
    modifierMarkedStockDeducting: true
  }
];

test('Reporting Dashboard exposes one Modifier Report tile and keeps old modifier IDs hidden as aliases', () => {
  const salesReports = listReports({ section: 'sales' }).map((report) => report.id);
  assert.deepEqual(salesReports, ['sales_reports', 'modifier_report']);
  assert.equal(getReportDefinition('modifier_report').title, 'Modifier Report');
  assert.equal(getReportDefinition('modifier_summary').hiddenFromDashboard, true);
  assert.equal(getReportDefinition('modifier_summary').defaultView, 'summary');
  assert.equal(getReportDefinition('modifier_gp_tracker').defaultView, 'gp_tracker');
  assert.equal(getReportDefinition('modifier_sales_log').defaultView, 'sales_log');
});

test('Modifier Report builds summary, GP tracker, group, menu item, modifier, and sales log views from real modifier rows', () => {
  const model = buildModifierReportModel(modifierRows);
  assert.equal(model.views.summary.length, 3);
  assert.equal(model.views.gp_tracker.length, 3);
  assert.equal(model.views.by_group.length, 1);
  assert.equal(model.views.by_menu_item.length, 1);
  assert.equal(model.views.by_modifier.length, 3);
  assert.equal(model.views.sales_log.length, 3);

  const cheese = model.views.summary.find((row) => row.modifierName === 'Extra Cheese');
  assert.equal(cheese.timesSelected, 2);
  assert.equal(cheese.stockCost, 10);
  assert.equal(cheese.grossProfit, 30);
  assert.equal(cheese.gpPercent, 0.75);
  assert.equal(cheese.selectedPercent, 0.5);
  assert.equal(cheese.modifierType, 'Product');
  assert.equal(cheese.stockAction, 'Add recipe');

  const noOnion = model.views.summary.find((row) => row.modifierName === 'No Onion');
  assert.equal(noOnion.modifierType, 'Note');
  assert.equal(noOnion.stockAction, 'Remove ingredient');

  const bacon = model.views.summary.find((row) => row.modifierName === 'Extra Bacon');
  assert.equal(bacon.netSales, 0);
  assert.equal(bacon.stockCost, 12);
  assert.equal(bacon.grossProfit, -12);
  const burger = model.views.by_menu_item[0];
  assert.equal(burger.menuItemName, 'Burger');
  assert.equal(burger.modifierSelections, 4);
  assert.equal(burger.grossMenuSales, 345);
  assert.equal(burger.vat, 45);
  assert.equal(burger.netMenuSales, 300);
  assert.equal(burger.baseStockCost, 125);
  assert.equal(burger.modifierStockCost, 22);
  assert.equal(burger.totalStockCost, 147);
  assert.equal(burger.grossProfit, 153);
  assert.equal(burger.gpPercent, 0.51);
});

test('Modifier mapper keeps modifier payment values and usage costs separate', () => {
  const row = normalizeApiModifierSalesRow({
    id: 'm-1',
    sale_date: '2026-07-09',
    receipt_number: 'R-100',
    modifier_group_name: 'Burger Extras',
    modifier_name: 'Extra Cheese',
    modifier_type: 'Product',
    stock_action_type: 'REPLACE_INGREDIENT',
    stock_action: 'Replace ingredient',
    gross_amount: 46,
    vat_amount: 6,
    net_amount: 40,
    stock_qty_deducted: 2,
    unit_cost_ex_vat: 5,
    stock_cost: 10
  });
  assert.equal(row.grossAmount, 46);
  assert.equal(row.netAmount, 40);
  assert.equal(row.stockCost, 10);
  assert.equal(row.grossProfit, 30);
  assert.equal(row.modifierType, 'Product');
  assert.equal(row.stockActionType, 'REPLACE_INGREDIENT');
  assert.equal(row.stockAction, 'Replace ingredient');
});


test('Modifier report does not misclassify missing modifier types as notes', () => {
  const mapped = normalizeApiModifierSalesRow({ modifier_name: 'Choose Sauce' });
  assert.equal(mapped.modifierType, 'Option');
  const model = buildModifierReportModel([{ modifierName: 'Choose Sauce', stockActionType: 'NO_STOCK_CHANGE' }]);
  assert.equal(model.views.summary[0].modifierType, 'Option');
  assert.equal(model.views.summary[0].stockAction, 'No stock change');
});

test('Modifier report does not fabricate VAT when the backend explicitly reports vatRate: 0 for a non-VAT-registered workspace', () => {
  const model = buildModifierReportModel([{
    modifierName: 'Extra Cheese',
    grossAmount: 100,
    vatRate: 0
  }]);
  const row = model.views.summary[0];
  assert.equal(row.vat, 0);
  assert.equal(row.netSales, 100);
});
