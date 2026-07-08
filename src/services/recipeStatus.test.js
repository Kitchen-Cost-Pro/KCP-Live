import test from 'node:test';
import assert from 'node:assert/strict';
import { getRecipeStatus, RECIPE_STATUS } from './recipeStatus.js';

test('menu item with direct recipe returns COMPLETE', () => {
  assert.equal(
    getRecipeStatus({ recipeLines: [{ stockItemId: 'bun', quantity: 1 }] }),
    RECIPE_STATUS.COMPLETE
  );
});

test('menu item with linked non-stock stock item recipe returns COMPLETE_VIA_LINKED_STOCK_ITEM', () => {
  assert.equal(
    getRecipeStatus({
      recipeSourceStockItem: {
        id: 'burger_build',
        itemType: 'recipe_source',
        isStocked: false,
        recipeLines: [{ stockItemId: 'patty', quantity: 1 }]
      }
    }),
    RECIPE_STATUS.COMPLETE_VIA_LINKED_STOCK_ITEM
  );
});

test('menu item with linked stock item but no recipe returns MISSING_RECIPE', () => {
  assert.equal(
    getRecipeStatus({
      recipeSourceStockItem: {
        id: 'empty_build',
        itemType: 'recipe_source',
        isStocked: false,
        recipeLines: []
      }
    }),
    RECIPE_STATUS.MISSING_RECIPE
  );
});

test('menu item with only modifiers returns MISSING_RECIPE', () => {
  assert.equal(
    getRecipeStatus({
      modifiers: [{ id: 'drink_upsell', price: 10 }],
      modifierGroups: [{ id: 'drink_upsell' }]
    }),
    RECIPE_STATUS.MISSING_RECIPE
  );
});

test('menu item with add-on or upsell modifiers still returns MISSING_RECIPE', () => {
  assert.equal(
    getRecipeStatus({
      addOns: [{ id: 'cheese', recipeLines: [{ stockItemId: 'cheese', quantity: 1 }] }],
      upsells: [{ id: 'chips', recipeLines: [{ stockItemId: 'chips', quantity: 1 }] }]
    }),
    RECIPE_STATUS.MISSING_RECIPE
  );
});

test('direct recipe takes precedence over linked recipe source stock item', () => {
  assert.equal(
    getRecipeStatus({
      recipeLines: [{ stockItemId: 'chicken', quantity: 1 }],
      recipeSourceStockItem: {
        id: 'chicken_build',
        itemType: 'recipe_source',
        isStocked: false,
        recipeLines: [{ stockItemId: 'bun', quantity: 1 }]
      }
    }),
    RECIPE_STATUS.COMPLETE
  );
});
