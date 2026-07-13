import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPaymentModel, buildSaleStockMovementModel } from '../reports/sales/salesReportHelpers.js';
import { buildModifierReportModel } from '../reports/sales/modifierReport.js';

const cents = (value) => Math.round(Number(value || 0) * 100);

function assertGrossVatNet(row, grossKey, vatKey, netKey) {
  assert.equal(cents(row[grossKey]), cents(row[vatKey]) + cents(row[netKey]));
}

test('all Payment Summary views reconcile gross to VAT plus net with zero stored VAT rate', () => {
  const model = buildPaymentModel([
    {
      id: 'sale-560', saleDate: '2026-07-10', locationId: 'downstairs', locationName: 'Downstairs Bar',
      paymentMethod: 'cash', status: 'completed', grossAmount: 560, vatAmount: 0, netAmount: 560, vatRate: 0
    },
    {
      id: 'sale-140', saleDate: '2026-07-10', locationId: 'downstairs', locationName: 'Downstairs Bar',
      paymentMethod: 'cash', status: 'completed', grossAmount: 140, vatAmount: 0, netAmount: 140, vatRate: 0
    }
  ]);

  for (const view of ['daily_summary', 'by_payment_method', 'by_location']) {
    assert.equal(model.views[view].length, 1);
    const row = model.views[view][0];
    assert.equal(row.grossSales, 700);
    assert.equal(cents(row.vat), 9130);
    assert.equal(cents(row.netSales), 60870);
    assertGrossVatNet(row, 'grossSales', 'vat', 'netSales');
  }

  for (const row of model.views.transaction_detail) {
    assertGrossVatNet(row, 'grossAmount', 'vatAmount', 'netAmount');
  }
});

test('Stock Movement sales totals calculate VAT once per sale line even when ingredients repeat', () => {
  const common = {
    saleDate: '2026-07-10', saleId: 'sale-1', saleLineId: 'line-1', receiptNumber: 'R-1',
    locationId: 'downstairs', locationName: 'Downstairs Bar', menuItemId: 'burger', menuItemName: 'Burger',
    qtySold: 1, grossSaleAmount: 560, vatAmount: 0, netSaleAmount: 560, vatRate: 0,
    sourceType: 'Sale Usage', baseUom: 'ea'
  };
  const model = buildSaleStockMovementModel([
    { ...common, id: 'usage-1', inventoryItemId: 'bun', inventoryItemName: 'Bun', qtyUsed: 1, unitCostExVat: 5, stockValueUsed: 5 },
    { ...common, id: 'usage-2', inventoryItemId: 'patty', inventoryItemName: 'Patty', qtyUsed: 1, unitCostExVat: 25, stockValueUsed: 25 }
  ]);

  const summary = model.views.summary[0];
  assert.equal(summary.grossSales, 560);
  assert.equal(summary.vat, 73.04);
  assert.equal(summary.netSales, 486.96);
  assert.equal(summary.totalStockValueUsed, 30);
  assertGrossVatNet(summary, 'grossSales', 'vat', 'netSales');
});

test('Modifier Report repairs zero VAT rate and calculates GP from net sales', () => {
  const model = buildModifierReportModel([{
    id: 'modifier-1', saleDate: '2026-07-10', receiptNumber: 'R-1', locationName: 'Downstairs Bar',
    menuItemName: 'Burger', modifierGroupId: 'extras', modifierGroupName: 'Extras', modifierId: 'cheese',
    modifierName: 'Cheese', modifierType: 'Product', grossAmount: 115, vatAmount: 0, netAmount: 115,
    vatRate: 0, timesSelected: 1, stockCost: 20, stockQtyDeducted: 1, stockDeductionStatus: 'Deducted'
  }]);
  const detail = model.views.sales_log[0];
  assert.equal(detail.vatAmount, 15);
  assert.equal(detail.netAmount, 100);
  assert.equal(detail.grossProfit, 80);
  assertGrossVatNet(detail, 'grossAmount', 'vatAmount', 'netAmount');
});

test('Worker reporting routes apply the same VAT fallback to every Yoco reporting source', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'cloudflare-v2/src/legacy/reporting-routes.ts'), 'utf8');
  assert.equal((source.match(/SELECT NULLIF\(ws\.vat_rate, 0\) FROM workspace_settings/g) || []).length, 3);
  assert.match(source, /SELECT COALESCE\(NULLIF\(vat_rate, 0\), 15\) AS vat_rate FROM workspace_settings/);
  assert.match(source, /const lineFinancials = deriveYocoFinancialAmounts/);
  assert.match(source, /const modifierFinancials = deriveYocoFinancialAmounts/);
});
