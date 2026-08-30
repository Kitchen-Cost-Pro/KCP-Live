import test from 'node:test';
import assert from 'node:assert/strict';
import { isStockCountableItem } from './stockCountEligibility.js';

test('sub-recipe items are excluded from stock counts even when stocked', () => {
  assert.equal(isStockCountableItem({
    itemType: 'sub_recipe',
    isStocked: true,
    stock: 12,
    category: 'Prep'
  }), false);
});

test('subrecipe spelling is excluded from stock counts', () => {
  assert.equal(isStockCountableItem({
    itemType: 'subrecipe',
    isStocked: true
  }), false);
});

test('sub-recipe category is excluded from stock counts', () => {
  assert.equal(isStockCountableItem({
    itemType: 'raw',
    isStocked: true,
    category: 'Sauces - Sub Recipe'
  }), false);
});

test('non-stock and recipe-source items remain countable', () => {
  assert.equal(isStockCountableItem({ itemType: 'non_stock', isStocked: false }), true);
  assert.equal(isStockCountableItem({ itemType: 'recipe_source', isStocked: false }), true);
});
