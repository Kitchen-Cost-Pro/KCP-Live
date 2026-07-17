import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentModel, paymentTotals } from './modules/reporting/reports/sales/salesReportHelpers.js';
import { paymentSalesFinancialReport } from './modules/reporting/reports/sales/paymentSalesFinancialReport.js';

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('Legal Details has its own save action', () => {
  const settings = read('src/components/Settings.js');
  assert.match(settings, /Save Legal Details/);
  assert.match(settings, /settingsActions--legal/);
  assert.match(settings, /renderCompanyTaxPanel\(draft, \{ isSaving \}\)/);
});

test('Payment Summary columns follow the mental-math order in every summary view', () => {
  const expected = ['grossSales', 'vat', 'netSales', 'tips', 'refunds', 'discounts', 'fees', 'payoutAmount'];
  for (const view of ['daily_summary', 'by_payment_method', 'by_location']) {
    const keys = paymentSalesFinancialReport.columns[view].map((column) => column.key);
    const actual = keys.filter((key) => expected.includes(key));
    assert.deepEqual(actual, expected);
  }
  const detailExpected = ['grossAmount', 'vatAmount', 'netAmount', 'tipAmount', 'refundAmount', 'discountAmount', 'feeAmount', 'payoutAmount'];
  const detailKeys = paymentSalesFinancialReport.columns.transaction_detail.map((column) => column.key).filter((key) => detailExpected.includes(key));
  assert.deepEqual(detailKeys, detailExpected);
});

test('Payout equals Net Sales plus Tips less Refunds and Fees', () => {
  const model = buildPaymentModel([
    {
      id: 'sale',
      saleDate: '2026-07-13',
      locationName: 'Main',
      status: 'completed',
      grossAmount: 115,
      vatAmount: 15,
      netAmount: 100,
      tipAmount: 5,
      feeAmount: 2,
      refundAmount: 0
    },
    {
      id: 'refund',
      saleDate: '2026-07-13',
      locationName: 'Main',
      status: 'refunded',
      grossAmount: 0,
      vatAmount: -3,
      netAmount: -20,
      refundAmount: 23,
      tipAmount: 0,
      feeAmount: 0
    }
  ]);
  const summary = model.views.by_location[0];
  assert.equal(summary.grossSales, 115);
  assert.equal(summary.vat, 15);
  assert.equal(summary.netSales, 100);
  assert.equal(summary.tips, 5);
  assert.equal(summary.refunds, 23);
  assert.equal(summary.fees, 2);
  assert.equal(summary.payoutAmount, 80);
  assert.equal(paymentTotals([summary]).payoutAmount, 80);
});

 test('Payout tooltip states the exact report formula', () => {
  const tooltips = read('src/modules/reporting/tooltips/formulaTooltips.js');
  assert.match(tooltips, /Net Sales \+ Tips - Refunds - Fees/);
});
