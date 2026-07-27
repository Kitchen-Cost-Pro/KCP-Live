import test from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitRecipeSave,
  buildProductRecipeSavePayload,
  isRecipePersistenceApiCompatible,
  mergeVerifiedRecipeSave,
  normalizeRecipeLines,
  recipeLinesMatch,
  REQUIRED_RECIPE_PERSISTENCE_VERSION,
  settleRecipeSaveState
} from './recipePayload.js';

test('recipe save payload contains only recipe-specific fields', () => {
  const payload = buildProductRecipeSavePayload({
    id: 'menu-1',
    name: 'Burger',
    sellingPrice: 95,
    recipeSourceStockItemId: 'source-1'
  }, [
    { ingId: 'bun', qty: '1', unit: 'ea' },
    { stockItemId: 'patty', quantity: '0,125', unit: 'kg' }
  ]);

  assert.deepEqual(payload, {
    recipeSourceStockItemId: 'source-1',
    recipe: [
      { ingId: 'bun', stockItemId: 'bun', qty: 1, quantity: 1, unit: 'ea' },
      { ingId: 'patty', stockItemId: 'patty', qty: 0.125, quantity: 0.125, unit: 'kg' }
    ]
  });
  assert.equal(Object.hasOwn(payload, 'name'), false);
  assert.equal(Object.hasOwn(payload, 'sellingPrice'), false);
});

test('recipe normalization removes invalid and zero-quantity lines', () => {
  assert.deepEqual(normalizeRecipeLines([
    { ingId: '', qty: 1 },
    { ingId: 'salt', qty: 0 },
    { stock_item_id: 'pepper', quantity: 2, uom: 'g' }
  ]), [
    { ingId: 'pepper', stockItemId: 'pepper', qty: 2, quantity: 2, unit: 'g' }
  ]);
});

test('recipe normalization saves the edited qty instead of a stale loaded quantity alias', () => {
  const loadedLineAfterEditing = {
    ingId: 'patty',
    stockItemId: 'patty',
    qty: '0,250',
    quantity: 0.125,
    unit: 'kg'
  };

  assert.deepEqual(normalizeRecipeLines([loadedLineAfterEditing]), [
    {
      ingId: 'patty',
      stockItemId: 'patty',
      qty: 0.25,
      quantity: 0.25,
      unit: 'kg'
    }
  ]);
});

test('persisted recipe verification compares ids, quantities, units, and order', () => {
  const expected = [
    { ingId: 'bun', qty: 1, unit: 'ea' },
    { ingId: 'patty', qty: 0.125, unit: 'kg' }
  ];
  assert.equal(recipeLinesMatch(expected, [
    { stockItemId: 'bun', quantity: 1, unit: 'ea' },
    { stockItemId: 'patty', quantity: 0.125, unit: 'kg' }
  ]), true);
  assert.equal(recipeLinesMatch(expected, [
    { stockItemId: 'patty', quantity: 0.125, unit: 'kg' },
    { stockItemId: 'bun', quantity: 1, unit: 'ea' }
  ]), false);
});

test('verified recipe response can update the UI immediately without a full catalogue refresh', () => {
  const saved = mergeVerifiedRecipeSave({
    id: 'menu-1',
    name: 'Burger',
    recipe: [{ ingId: 'old', qty: 1, unit: 'ea' }]
  }, {
    persisted: true,
    recipeStatus: 'COMPLETE',
    recipe: [{ stockItemId: 'patty', quantity: 0.15, unit: 'kg' }]
  });

  assert.equal(saved.recipeCount, 1);
  assert.equal(saved.recipeStatus, 'COMPLETE');
  assert.equal(saved.status, 'complete');
  assert.deepEqual(saved.recipe, [
    { ingId: 'patty', stockItemId: 'patty', qty: 0.15, quantity: 0.15, unit: 'kg' }
  ]);
});

test('verified linked recipe save remains complete when the direct recipe is empty', () => {
  const saved = mergeVerifiedRecipeSave({
    id: 'menu-2',
    recipeSourceStockItemId: 'sub-1',
    recipeSourceRecipeLines: [{ ingId: 'flour', qty: 0.2, unit: 'kg' }]
  }, {
    persisted: true,
    recipeStatus: 'COMPLETE_VIA_LINKED_STOCK_ITEM',
    recipeSourceStockItemId: 'sub-1',
    recipe: []
  });

  assert.equal(saved.recipeCount, 1);
  assert.equal(saved.recipeStatus, 'COMPLETE_VIA_LINKED_STOCK_ITEM');
  assert.equal(saved.missingRecipe, false);
});

test('recipe save deadline resolves successful writes and rejects stalled writes', async () => {
  assert.equal(await awaitRecipeSave(Promise.resolve('saved'), 20), 'saved');
  await assert.rejects(
    awaitRecipeSave(new Promise(() => {}), 5),
    /editor has been unlocked/i
  );
});

test('recipe save terminal cleanup always unlocks a saving editor', () => {
  assert.deepEqual(settleRecipeSaveState({
    actionStatus: 'saving',
    editingItem: { id: 'menu-1' },
    actionError: 'Network error'
  }), {
    actionStatus: '',
    editingItem: { id: 'menu-1' },
    actionError: 'Network error'
  });

  const idle = { actionStatus: '', editingItem: null };
  assert.equal(settleRecipeSaveState(idle), idle);
});

test('recipe saving requires the database read-back Worker contract', () => {
  assert.equal(REQUIRED_RECIPE_PERSISTENCE_VERSION, 'dual-store-readback-v1');
  assert.equal(isRecipePersistenceApiCompatible({
    recipePersistenceVersion: 'dual-store-readback-v1'
  }), true);
  assert.equal(isRecipePersistenceApiCompatible({
    workerRelease: 'phase92-modifier-replacement-picker-and-scope-fix'
  }), false);
});
