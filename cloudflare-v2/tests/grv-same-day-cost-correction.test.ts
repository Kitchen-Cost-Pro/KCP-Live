import assert from 'node:assert/strict';
import test from 'node:test';

import { replaySameDayCostCorrections } from '../src/legacy/inventory-costing';

// The exact live scenario this feature exists for: a GRV line was typed as R2 instead of R20,
// a same-day sale was rung up (and costed) against that wrong R2 figure, and the GRV is then
// edited to the correct R20. Under 'last' costing the fix is a flat swap: any sale in the window
// that was costed at the old figure should be corrected to the new one.
test('last costing: a same-day sale costed at the mistaken price is corrected to the fixed price', () => {
  const corrections = replaySameDayCostCorrections({
    costingMethod: 'last',
    startingQuantity: 10,
    startingUnitCost: 20, // the REVISED GRV line's cost — this is the starting point of the replay
    events: [
      { id: 'sale_1', quantityDelta: -3, unitCost: 2, isSale: true }, // recorded against the mistake
    ],
  });
  assert.deepEqual(corrections, [{ id: 'sale_1', correctedUnitCost: 20 }]);
});

test('last costing: a sale already recorded at the correct cost is left alone', () => {
  const corrections = replaySameDayCostCorrections({
    costingMethod: 'last',
    startingQuantity: 10,
    startingUnitCost: 20,
    events: [{ id: 'sale_1', quantityDelta: -3, unitCost: 20, isSale: true }],
  });
  assert.deepEqual(corrections, []);
});

test('last costing: a LATER same-day GRV resets the cost forward, so a sale after it is not touched', () => {
  const corrections = replaySameDayCostCorrections({
    costingMethod: 'last',
    startingQuantity: 10,
    startingUnitCost: 20,
    events: [
      // A second, independent GRV for the same item/location later that day at R25 — 'last'
      // costing means every sale after this point should be costed at R25, not R20.
      { id: 'grv2_line', quantityDelta: 5, unitCost: 25, isSale: false },
      { id: 'sale_1', quantityDelta: -2, unitCost: 25, isSale: true },
    ],
  });
  assert.deepEqual(corrections, []);
});

test('last costing: a sale BEFORE the later GRV still gets corrected against the original fix', () => {
  const corrections = replaySameDayCostCorrections({
    costingMethod: 'last',
    startingQuantity: 10,
    startingUnitCost: 20,
    events: [
      { id: 'sale_1', quantityDelta: -2, unitCost: 2, isSale: true }, // before the later GRV, still wrong
      { id: 'grv2_line', quantityDelta: 5, unitCost: 25, isSale: false },
      { id: 'sale_2', quantityDelta: -2, unitCost: 25, isSale: true }, // after, already correct
    ],
  });
  assert.deepEqual(corrections, [{ id: 'sale_1', correctedUnitCost: 20 }]);
});

// Weighted-average costing: the mistake doesn't produce a clean flat wrong price — it blends into
// whatever was already on hand. Replicates the exact blend math calculateIncomingLocationCost uses.
test('wac costing: a same-day sale costed off the mistaken blend is corrected to the true blend', () => {
  // Before the GRV: 10 units on hand at R10. The corrected GRV brings in 10 more units at the
  // FIXED R20 (the mistake was R2). True post-GRV blend: (10*10 + 10*20) / 20 = 15.
  // The sale was actually costed off the mistaken blend at the time: (10*10 + 10*2) / 20 = 6.
  const corrections = replaySameDayCostCorrections({
    costingMethod: 'wac',
    startingQuantity: 20, // 10 pre-existing + 10 from this (revised) GRV
    startingUnitCost: 15, // the TRUE blend using the corrected R20
    events: [{ id: 'sale_1', quantityDelta: -5, unitCost: 6, isSale: true }], // costed off the mistaken blend
  });
  assert.deepEqual(corrections, [{ id: 'sale_1', correctedUnitCost: 15 }]);
});

test('wac costing: a further inbound in the window blends on top of the corrected running cost', () => {
  const corrections = replaySameDayCostCorrections({
    costingMethod: 'wac',
    startingQuantity: 20,
    startingUnitCost: 15,
    events: [
      // 20 more units in at R25: true blend = (20*15 + 20*25) / 40 = 20.
      { id: 'grv2_line', quantityDelta: 20, unitCost: 25, isSale: false },
      { id: 'sale_1', quantityDelta: -5, unitCost: 12, isSale: true }, // costed off some other wrong figure
    ],
  });
  assert.deepEqual(corrections, [{ id: 'sale_1', correctedUnitCost: 20 }]);
});

test('non-sale outbound movements (credit note / wastage) are never flagged, even at a mismatched cost', () => {
  const corrections = replaySameDayCostCorrections({
    costingMethod: 'last',
    startingQuantity: 10,
    startingUnitCost: 20,
    events: [{ id: 'credit_note_1', quantityDelta: -3, unitCost: 2, isSale: false }],
  });
  assert.deepEqual(corrections, []);
});

test('quantity never goes negative even if outbound events would over-deplete the replayed balance', () => {
  assert.doesNotThrow(() =>
    replaySameDayCostCorrections({
      costingMethod: 'last',
      startingQuantity: 2,
      startingUnitCost: 20,
      events: [{ id: 'sale_1', quantityDelta: -10, unitCost: 20, isSale: true }],
    }),
  );
});
