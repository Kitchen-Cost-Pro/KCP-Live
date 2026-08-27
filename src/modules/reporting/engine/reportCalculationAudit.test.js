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

test('all Payment Summary views reconcile gross to VAT plus net when the workspace is genuinely not VAT-registered', () => {
  // The backend's buildVatRateSqlExpression() (reporting-routes.ts) applies NULLIF(vat_rate, 0)
  // before a row is ever emitted, so an API row can only ever carry a literal vatRate: 0 when the
  // workspace is genuinely non-VAT-registered — never as a stand-in for "unset". The frontend must
  // trust that zero rather than re-defaulting it to 15%, or it fabricates VAT the backend never
  // charged (see normalizeSalesFinancialRow's vatRateSupplied handling).
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
    assert.equal(cents(row.vat), 0);
    assert.equal(cents(row.netSales), 70000);
    assertGrossVatNet(row, 'grossSales', 'vat', 'netSales');
  }

  for (const row of model.views.transaction_detail) {
    assertGrossVatNet(row, 'grossAmount', 'vatAmount', 'netAmount');
  }
});

test('Stock Movement sales totals keep VAT at zero for a non-VAT-registered workspace even when ingredients repeat', () => {
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
  assert.equal(summary.vat, 0);
  assert.equal(summary.netSales, 560);
  assert.equal(summary.totalStockValueUsed, 30);
  assertGrossVatNet(summary, 'grossSales', 'vat', 'netSales');
});

test('Modifier Report keeps VAT at zero for a non-VAT-registered workspace and calculates GP from net sales', () => {
  const model = buildModifierReportModel([{
    id: 'modifier-1', saleDate: '2026-07-10', receiptNumber: 'R-1', locationName: 'Downstairs Bar',
    menuItemName: 'Burger', modifierGroupId: 'extras', modifierGroupName: 'Extras', modifierId: 'cheese',
    modifierName: 'Cheese', modifierType: 'Product', grossAmount: 115, vatAmount: 0, netAmount: 115,
    vatRate: 0, timesSelected: 1, stockCost: 20, stockQtyDeducted: 1, stockDeductionStatus: 'Deducted'
  }]);
  const detail = model.views.sales_log[0];
  assert.equal(detail.vatAmount, 0);
  assert.equal(detail.netAmount, 115);
  assert.equal(detail.grossProfit, 95);
  assertGrossVatNet(detail, 'grossAmount', 'vatAmount', 'netAmount');
});

test('Worker reporting routes apply the same VAT fallback to every Yoco reporting source', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'cloudflare-v2/src/legacy/reporting-routes.ts'), 'utf8');
  // The three per-order/per-line reports (Sales Financial, Sale Stock Usage, Modifier Sales) now
  // share one buildVatRateSqlExpression() helper instead of duplicating this fallback subquery
  // inline three times — assert all three call sites actually use it, and that the shared
  // function itself still carries the correct fallback SQL (see reporting-routes.ts).
  assert.equal((source.match(/\$\{buildVatRateSqlExpression\(\{/g) || []).length, 3);
  assert.match(source, /function buildVatRateSqlExpression/);
  assert.match(source, /SELECT NULLIF\(ws\.vat_rate, 0\) FROM workspace_settings/);
  assert.match(source, /SELECT COALESCE\(NULLIF\(vat_rate, 0\), 15\) AS vat_rate\s+FROM workspace_settings/);
  assert.match(source, /const lineFinancials = deriveYocoFinancialAmounts/);
  assert.match(source, /const modifierFinancials = deriveYocoFinancialAmounts/);
});
