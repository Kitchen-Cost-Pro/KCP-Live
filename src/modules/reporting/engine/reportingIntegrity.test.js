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
