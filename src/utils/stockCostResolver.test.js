import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLocationUnitCost,
  resolveRecipeIngredientUnitCost,
  shouldExpandIngredientRecipe
} from './stockCostResolver.js';

test('uses primitive per-location costs instead of stale global costs', () => {
  const item = {
    cost: 23.49,
    locationCosts: { downstairs: 2 }
  };
  assert.equal(resolveLocationUnitCost(item, 'downstairs'), 2);
});

test('honours an explicit zero location cost instead of falling back globally', () => {
  const item = {
    cost: 23.49,
    locationCosts: { downstairs: { cost: 0 } }
  };
  assert.equal(resolveLocationUnitCost(item, 'downstairs'), 0);
});

test('physical Prep ingredients use their stored location cost and are not recursively re-costed', () => {
  const ingredients = [
    {
      id: 'bun',
      itemType: 'raw',
      cost: 23.49,
      locationCosts: { downstairs: { cost: 23.49 } }
    },
    {
      id: 'patty',
      itemType: 'manufactured',
      isManufactured: true,
      isStocked: true,
      cost: 23.49,
      locationCosts: { downstairs: 2 },
      recipe: [{ ingId: 'flour', qty: 1 }],
      yieldBatch: 1
    },
    {
      id: 'flour',
      itemType: 'raw',
      cost: 23.49,
      locationCosts: { downstairs: { cost: 23.49 } }
    }
  ];

  assert.equal(shouldExpandIngredientRecipe(ingredients[1]), false);
  assert.equal(resolveRecipeIngredientUnitCost('patty', ingredients, 'downstairs'), 2);
  assert.equal(
    resolveRecipeIngredientUnitCost('bun', ingredients, 'downstairs') +
      resolveRecipeIngredientUnitCost('patty', ingredients, 'downstairs'),
    25.49
  );
});

test('virtual sub-recipes still expand through their ingredient recipe', () => {
  const ingredients = [
    {
      id: 'sauce',
      itemType: 'sub_recipe',
      isSubRecipe: true,
      isStocked: false,
      recipe: [{ ingId: 'tomato', qty: 2 }],
      yieldBatch: 4
    },
    {
      id: 'tomato',
      itemType: 'raw',
      locationCosts: { downstairs: { unitCost: 10 } }
    }
  ];

  assert.equal(shouldExpandIngredientRecipe(ingredients[0]), true);
  assert.equal(resolveRecipeIngredientUnitCost('sauce', ingredients, 'downstairs'), 5);
});
