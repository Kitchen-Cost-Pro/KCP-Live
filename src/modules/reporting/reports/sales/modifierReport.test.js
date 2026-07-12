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
  assert.equal(model.views.by_menu_item.length, 3);
  assert.equal(model.views.by_modifier.length, 3);
  assert.equal(model.views.sales_log.length, 3);

  const cheese = model.views.summary.find((row) => row.modifierName === 'Extra Cheese');
  assert.equal(cheese.timesSelected, 2);
  assert.equal(cheese.stockCost, 10);
  assert.equal(cheese.grossProfit, 30);
  assert.equal(cheese.gpPercent, 0.75);
  assert.equal(cheese.selectedPercent, 0.5);

  const bacon = model.views.summary.find((row) => row.modifierName === 'Extra Bacon');
  assert.equal(bacon.netSales, 0);
  assert.equal(bacon.stockCost, 12);
  assert.equal(bacon.grossProfit, -12);
});

test('Modifier mapper keeps modifier payment values and usage costs separate', () => {
  const row = normalizeApiModifierSalesRow({
    id: 'm-1',
    sale_date: '2026-07-09',
    receipt_number: 'R-100',
    modifier_group_name: 'Burger Extras',
    modifier_name: 'Extra Cheese',
    modifier_type: 'Product',
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
});
