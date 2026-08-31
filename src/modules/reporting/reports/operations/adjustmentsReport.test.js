import test from 'node:test';
import assert from 'node:assert/strict';
import { __adjustmentsReportInternals } from './adjustmentsReport.js';

// Regression: Adjustments Summary used to group by date::location::type::reason::createdBy, which
// can bundle several separate adjustment submissions (same day/location/type/reason/user) into one
// row -- unusable for "click a summary row -> open its transaction drawer" (the user asked for
// exactly the same behaviour GRV Log's summary already has, which groups 1 row = 1 document). Summary
// now groups by sourceId (the adjustment document id), matching GRV's grvId grouping.

function ledgerRow(overrides = {}) {
  return {
    id: `movement-${overrides.sourceId || '1'}-${overrides.itemId || 'x'}`,
    date: '2026-08-31',
    timestamp: '2026-08-31T09:00:00.000Z',
    locationId: 'main',
    locationName: 'Main Kitchen',
    itemId: 'flour',
    itemName: 'Flour',
    category: 'Dry Goods',
    baseUom: 'kg',
    source: 'Manual Adjustment',
    movementType: 'Manual Adjustment',
    sourceType: 'adjustment',
    sourceId: 'adj-1',
    transactionReference: 'ADJ-260831-0001',
    qtyIn: 0,
    qtyOut: 2,
    netQty: -2,
    unitCostExVat: 10,
    movementValue: -20,
    createdBy: 'M. van Tonder',
    reason: 'Stock correction',
    ...overrides
  };
}

test('summary groups by adjustment document (sourceId), not by date/location/type/reason/user', () => {
  const ledgerRows = [
    ledgerRow({ sourceId: 'adj-1', transactionReference: 'ADJ-260831-0001', itemId: 'flour', itemName: 'Flour' }),
    // Same date/location/type/reason/user as adj-1, but a genuinely separate submission.
    ledgerRow({ sourceId: 'adj-2', transactionReference: 'ADJ-260831-0002', itemId: 'sugar', itemName: 'Sugar', qtyOut: 1, netQty: -1, movementValue: -10 })
  ];
  const adjustmentRows = __adjustmentsReportInternals.buildAdjustmentRows(ledgerRows);
  const model = __adjustmentsReportInternals.buildAdjustmentModel(adjustmentRows, ledgerRows);

  assert.equal(model.views.summary.length, 2, 'two separate submissions must produce two summary rows, not one merged row');
  const first = model.views.summary.find((row) => row.sourceId === 'adj-1');
  const second = model.views.summary.find((row) => row.sourceId === 'adj-2');
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.transactionReference, 'ADJ-260831-0001');
  assert.equal(second.transactionReference, 'ADJ-260831-0002');
});

test('multiple lines within one adjustment document collapse into a single summary row', () => {
  const ledgerRows = [
    ledgerRow({ sourceId: 'adj-1', transactionReference: 'ADJ-260831-0001', itemId: 'flour', itemName: 'Flour', qtyOut: 2, netQty: -2, movementValue: -20 }),
    ledgerRow({ sourceId: 'adj-1', transactionReference: 'ADJ-260831-0001', itemId: 'sugar', itemName: 'Sugar', qtyOut: 1, netQty: -1, movementValue: -10 })
  ];
  const adjustmentRows = __adjustmentsReportInternals.buildAdjustmentRows(ledgerRows);
  const model = __adjustmentsReportInternals.buildAdjustmentModel(adjustmentRows, ledgerRows);

  assert.equal(model.views.summary.length, 1);
  const row = model.views.summary[0];
  assert.equal(row.sourceId, 'adj-1');
  assert.equal(row.itemsAdjusted, 2);
  assert.equal(row.totalQtyAdjusted, 3);
  assert.equal(row.totalValueAdjusted, -30);
  assert.equal(row.transactionReference, 'ADJ-260831-0001');
});
