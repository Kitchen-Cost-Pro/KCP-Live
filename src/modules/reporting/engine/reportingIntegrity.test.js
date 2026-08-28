import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportIntegritySummary } from './reportingIntegrity.js';

test('reporting integrity accepts reconciled sales, movement and stocktake rows', () => {
  const summary = buildReportIntegritySummary([
    { id: 'sale', grossAmount: 560, vatAmount: 73.04, netAmount: 486.96, refundAmount: 0, feeAmount: 10, tipAmount: 0, payoutAmount: 476.96 },
    { id: 'movement', qtyIn: 5, qtyOut: 2, netQty: 3, unitCostExVat: 10, movementValue: 30 },
    { id: 'stocktake', expectedQty: 10, countedQty: 8, varianceQty: -2, expectedValue: 100, countedValue: 80, varianceValue: -20 }
  ]);
  assert.equal(summary.valid, true);
  assert.equal(summary.issueCount, 0);
});

test('reporting integrity identifies calculation mismatches', () => {
  const summary = buildReportIntegritySummary([
    { id: 'sale', grossAmount: 560, vatAmount: 0, netAmount: 560, refundAmount: 0, feeAmount: 10, tipAmount: 0, payoutAmount: 560 },
    { id: 'movement', qtyIn: 5, qtyOut: 2, netQty: 4, unitCostExVat: 10, movementValue: 30 },
    { id: 'stocktake', expectedQty: 10, countedQty: 8, varianceQty: 1, expectedValue: 100, countedValue: 80, varianceValue: 10 }
  ]);
  assert.equal(summary.valid, false);
  assert.ok(summary.issues.some((issue) => issue.code === 'sales-payout-reconciliation'));
  assert.ok(summary.issues.some((issue) => issue.code === 'movement-quantity-reconciliation'));
  assert.ok(summary.issues.some((issue) => issue.code === 'stocktake-quantity-reconciliation'));
  assert.ok(summary.issues.some((issue) => issue.code === 'stocktake-value-reconciliation'));
});

test('reporting integrity does not flag a correctly-reversed refund row as a false integrity issue', () => {
  // Regression guard: a refund row deliberately zeroes grossAmount and reports its reversal as
  // negative netAmount/vatAmount (see yocoFinancials.js / modifierReport.js) — checking
  // gross === net + vat regardless of isRefund flagged EVERY refund as a false critical issue,
  // and the payout check made the same mistake using the row's own (zeroed) netAmount instead of
  // the refund-aware payout formula.
  const summary = buildReportIntegritySummary([{
    id: 'refund-1',
    isRefund: true,
    grossAmount: 0,
    vatAmount: -15,
    netAmount: -100,
    refundAmount: 115,
    tipAmount: 0,
    feeAmount: 0,
    payoutAmount: -115
  }]);
  assert.equal(summary.valid, true);
  assert.equal(summary.issueCount, 0);
});

test('reporting integrity still catches a genuinely broken refund row', () => {
  const summary = buildReportIntegritySummary([{
    id: 'refund-broken',
    isRefund: true,
    grossAmount: 0,
    vatAmount: -15,
    netAmount: -100,
    refundAmount: 999,
    tipAmount: 0,
    feeAmount: 0,
    payoutAmount: -115
  }]);
  assert.equal(summary.valid, false);
  assert.ok(summary.issues.some((issue) => issue.code === 'sales-gross-net-vat-reconciliation'));
});

test('reporting integrity rejects taxable Yoco rows that still resolve to zero VAT', () => {
  const result = buildReportIntegritySummary([{
    id: 'yoco-zero-vat',
    createdBy: 'yoco',
    vatSource: 'calculated',
    grossAmount: 560,
    vatAmount: 0,
    netAmount: 560,
    isVatExempt: false
  }]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'sales-taxable-zero-vat'));
});
