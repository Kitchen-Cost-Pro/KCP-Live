import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdjustmentLog } from './adjustmentLog.js';
import { isSalesAdjustment, isWastageAdjustment } from './wastageClassifier.js';

test('explicit wastage mode is classified as wastage', () => {
  assert.equal(isWastageAdjustment({ mode: 'wastage' }), true);
});

test('plain remove adjustment is classified as manual adjustment', () => {
  assert.equal(isWastageAdjustment({ mode: 'remove', impactQty: -2 }), false);
});

test('remove adjustment with waste reason is classified as wastage', () => {
  assert.equal(isWastageAdjustment({ mode: 'remove', wasteReason: 'Burnt' }), true);
});

test('normalized product wastage is classified as wastage', () => {
  const log = normalizeAdjustmentLog('wst_1', {
    productId: 'burger',
    productName: 'Burger',
    quantity: 2,
    wasteReason: 'Burnt'
  });

  assert.equal(log.mode, 'wastage');
  assert.equal(isWastageAdjustment(log), true);
});

// Regression: a Product Sales Adjustment (a manual correction for a sale the POS never captured)
// must classify as its own type, never as wastage -- even when its note happens to contain a
// wastage-sounding word like "lost", a plausible thing to type for a missed sale.
test('a sale adjustment is classified as its own type, never as wastage, even with a wastage-sounding note', () => {
  assert.equal(isSalesAdjustment({ mode: 'sale' }), true);
  assert.equal(isWastageAdjustment({ mode: 'sale' }), false);
  assert.equal(isWastageAdjustment({ mode: 'sale', note: 'Lost sale - till was offline' }), false);
});
