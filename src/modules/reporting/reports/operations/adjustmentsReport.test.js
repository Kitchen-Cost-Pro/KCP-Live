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

// Regression: a Product Sales Adjustment (a manual, recipe-expansion deduction for a sale the POS
// never captured -- see postSalesAdjustment in routes.ts) carries the exact same product-level
// metadata shape as a Product Wastage Adjustment. It must classify as its own "Sale Adjustment"
// type and never get swept into wastage classification, even when its reason text happens to
// contain a wastage-sounding word like "lost" (a very plausible thing to type for a missed sale).
test('a sale adjustment classifies as "Sale Adjustment", never as wastage, even with a wastage-sounding reason', () => {
  const ledgerRows = [
    ledgerRow({
      sourceId: 'sale-adj-1',
      transactionReference: 'ADJ-260831-0003',
      source: 'Sale Adjustment',
      movementType: 'Sale Adjustment',
      sourceType: 'sale_adjustment',
      itemId: 'patty',
      itemName: 'Beef Patty',
      qtyOut: 4,
      netQty: -4,
      movementValue: -48,
      reason: 'Lost sale - till was offline',
    })
  ];
  const adjustmentRows = __adjustmentsReportInternals.buildAdjustmentRows(ledgerRows);
  assert.equal(adjustmentRows.length, 1);
  assert.equal(adjustmentRows[0].adjustmentType, 'Sale Adjustment');
  assert.equal(adjustmentRows[0].isWastageAdjustment, false);
  assert.equal(adjustmentRows[0].wastageKind, '');

  const model = __adjustmentsReportInternals.buildAdjustmentModel(adjustmentRows, ledgerRows);
  const summaryRow = model.views.summary.find((row) => row.sourceId === 'sale-adj-1');
  assert.ok(summaryRow);
  assert.equal(summaryRow.adjustmentType, 'Sale Adjustment');
  // Must not appear in the Menu Items (product wastage) rollup.
  assert.equal(model.views.menu_items.length, 0);
});

// Regression: Stock Take Variance/Correction has its own dedicated Stock Take Audit report and must
// never also appear under Adjustments — even though it shares the generic "correction" wording that
// the fallback classification regex would otherwise match.
test('stock take variance/correction rows never appear in the Adjustments report', () => {
  const ledgerRows = [
    ledgerRow({ sourceId: 'st-1', source: 'Stock Take Variance', movementType: 'Stock Take Variance', sourceType: 'stockTake' }),
    ledgerRow({ sourceId: 'st-2', itemId: 'sugar', itemName: 'Sugar', source: 'Stock Take Correction', movementType: 'Stock Take Correction', sourceType: 'stockTakeCorrection' })
  ];
  assert.equal(__adjustmentsReportInternals.buildAdjustmentRows(ledgerRows).length, 0);
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
