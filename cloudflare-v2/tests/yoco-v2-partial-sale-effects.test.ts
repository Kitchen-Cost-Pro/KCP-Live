import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionSaleStockProposals } from '../src/modules/yoco-engine-v2/live-sale';
import type { Row } from '../src/modules/yoco-engine-v2/repository';

// Best-effort partial sale effects: an unmapped modifier (or item / missing recipe / bad UOM)
// must NOT block the order. partitionSaleStockProposals decides which rows deduct and which are
// skipped-and-flagged, with no throwing anywhere.

function resolvedMovement(over: Partial<Row> = {}): Row {
  return {
    resolution_status: 'RESOLVED',
    warning_code: '',
    quantity: -2,
    location_id: 'loc_1',
    ingredient_item_id: 'stock_1',
    ...over,
  } as Row;
}

function warningRow(warningCode: string): Row {
  return {
    resolution_status: 'WARNING',
    warning_code: warningCode,
    quantity: 0,
    location_id: 'loc_1',
    ingredient_item_id: `unresolved:${warningCode}`,
  } as Row;
}

test('applies resolved lines and skips the unmapped modifier (the Americano case)', () => {
  const rows = [
    resolvedMovement({ ingredient_item_id: 'espresso' }), // base Americano
    resolvedMovement({ ingredient_item_id: 'hot_milk', modifier_id: 'mod_hot_milk' }), // mapped modifier
    warningRow('MODIFIER_MAPPING_MISSING'), // Decaf
    warningRow('MODIFIER_MAPPING_MISSING'), // Almond milk
  ];
  const { applied, skipped, warningCodeCounts } = partitionSaleStockProposals(rows);
  assert.equal(applied.length, 2, 'base item + mapped modifier deduct');
  assert.equal(skipped.length, 2, 'both unmapped modifiers are skipped');
  assert.deepEqual(warningCodeCounts, { MODIFIER_MAPPING_MISSING: 2 });
});

test('all-unresolved order yields nothing applied (SKIPPED), never throws', () => {
  const rows = [warningRow('ITEM_MAPPING_MISSING'), warningRow('MENU_RECIPE_MISSING')];
  const { applied, skipped, warningCodeCounts } = partitionSaleStockProposals(rows);
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 2);
  assert.deepEqual(warningCodeCounts, { ITEM_MAPPING_MISSING: 1, MENU_RECIPE_MISSING: 1 });
});

test('recipe-cycle and invalid-UOM rows are skipped (recorded), not applied', () => {
  const rows = [
    resolvedMovement(),
    warningRow('RECIPE_CYCLE_DETECTED'),
    warningRow('MODIFIER_STOCK_UOM_INVALID'),
  ];
  const { applied, skipped } = partitionSaleStockProposals(rows);
  assert.equal(applied.length, 1);
  assert.equal(skipped.length, 2);
});

test('a fully-resolved order applies everything and skips nothing', () => {
  const rows = [resolvedMovement({ ingredient_item_id: 'a' }), resolvedMovement({ ingredient_item_id: 'b' })];
  const { applied, skipped } = partitionSaleStockProposals(rows);
  assert.equal(applied.length, 2);
  assert.equal(skipped.length, 0);
});

test('a resolved but non-negative row is neither applied nor flagged as a warning', () => {
  const rows = [resolvedMovement({ quantity: 0 })];
  const { applied, skipped } = partitionSaleStockProposals(rows);
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 0);
});

test('a resolved row missing a location is not applied (cannot deduct without a location)', () => {
  const rows = [resolvedMovement({ location_id: '' })];
  const { applied, skipped } = partitionSaleStockProposals(rows);
  assert.equal(applied.length, 0);
  // Not a warning row either — it just cannot become a movement.
  assert.equal(skipped.length, 0);
});
