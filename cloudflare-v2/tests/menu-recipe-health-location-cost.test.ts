import test from 'node:test';
import assert from 'node:assert/strict';
import { __menuHealthInternals } from '../src/legacy/reporting-routes';

const {
  buildMenuHealthContext,
  buildMenuRecipeHealthRows,
  calculateLocationRecipeCost,
  resolveMenuRecipeIngredientCost,
} = __menuHealthInternals;

// Regression guard: the Menu & Recipe Health report already resolves selling price per location
// (via product_location_prices), but recipe/ingredient cost used to come from stock_items.unit_cost
// with no join to stock_item_location_prices — so GP%/food-cost% mixed a location-scoped selling
// price against a workspace-global cost whenever a location had a cost override.

function buildRecipeLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    workspace_id: 'workspace-1',
    recipe_id: 'recipe-1',
    stock_item_id: 'stock-1',
    quantity: 2,
    unit: 'kg',
    sort_order: 0,
    stock_item_name: 'Flour',
    stock_category: 'Dry Goods',
    item_type: 'standard',
    base_uom: 'kg',
    unit_cost: 10,
    threshold_qty: 0,
    stock_raw_json: '{}',
    is_stocked: 1,
    in_stock_qty: 100,
    stock_active: 1,
    ...overrides,
  };
}

test('calculateLocationRecipeCost resolves a location cost override, falling back to the workspace unit cost', () => {
  const recipe = { id: 'recipe-1', yield_qty: 1 };
  const context = buildMenuHealthContext({
    vatRate: 15,
    locations: [],
    recipes: [recipe],
    recipeLines: [buildRecipeLine()],
    priceRows: [],
    locationCostRows: [{ stock_item_id: 'stock-1', location_id: 'loc-a', price: 15 }],
    modifierGroups: [],
    modifierUsageCounts: [],
    salesStats: [],
  });

  // 2kg at the loc-a override price of 15/kg.
  assert.equal(calculateLocationRecipeCost(recipe, context, 'loc-a'), 30);
  // loc-b has no override row — falls back to stock_items.unit_cost (10/kg).
  assert.equal(calculateLocationRecipeCost(recipe, context, 'loc-b'), 20);
  // No location supplied at all — same fallback.
  assert.equal(calculateLocationRecipeCost(recipe, context, ''), 20);
});

test('resolveMenuRecipeIngredientCost prefers the location override only when one exists', () => {
  const line = buildRecipeLine();
  const context = buildMenuHealthContext({
    vatRate: 15,
    locations: [],
    recipes: [],
    recipeLines: [line],
    priceRows: [],
    locationCostRows: [{ stock_item_id: 'stock-1', location_id: 'loc-a', price: 15 }],
    modifierGroups: [],
    modifierUsageCounts: [],
    salesStats: [],
  });

  assert.equal(resolveMenuRecipeIngredientCost('stock-1', line, context, 'loc-a'), 15);
  assert.equal(resolveMenuRecipeIngredientCost('stock-1', line, context, 'loc-b'), 10);
  assert.equal(resolveMenuRecipeIngredientCost('stock-1', line, context, ''), 10);
});

test('the per-location pricing breakdown costs each location independently; the summary row is unchanged', () => {
  const product = {
    id: 'product-1',
    workspace_id: 'workspace-1',
    name: 'Bread Roll',
    category: 'Bakery',
    price: 0,
    active: 1,
    yoco_item_id: 'yoco-item-1',
    yoco_variant_id: '',
    raw_json: '{}',
    sale_count: 0,
    qty_sold: 0,
  };
  const recipe = {
    id: 'recipe-1',
    owner_type: 'product',
    owner_id: 'product-1',
    linked_product_id: 'product-1',
    yield_qty: 1,
    active: 1,
  };
  const context = buildMenuHealthContext({
    vatRate: 15,
    locations: [
      { id: 'loc-a', name: 'Location A' },
      { id: 'loc-b', name: 'Location B' },
    ],
    recipes: [recipe],
    recipeLines: [buildRecipeLine()],
    priceRows: [
      { product_id: 'product-1', location_id: 'loc-a', price: 100, location_name: 'Location A' },
      { product_id: 'product-1', location_id: 'loc-b', price: 100, location_name: 'Location B' },
    ],
    locationCostRows: [{ stock_item_id: 'stock-1', location_id: 'loc-a', price: 15 }],
    modifierGroups: [],
    modifierUsageCounts: [],
    salesStats: [],
  });

  const warnings: Array<{ code: string; level: string; message: string }> = [];
  const built = buildMenuRecipeHealthRows([product], context, warnings);

  const pricingByLocation = new Map(built.pricingRows.map((row: any) => [row.locationId, row]));
  const locA = pricingByLocation.get('loc-a');
  const locB = pricingByLocation.get('loc-b');
  assert.ok(locA && locB, 'expected a pricing row for both locations');

  // loc-a has a cost override (15/kg * 2kg = 30); loc-b falls back to unit_cost (10/kg * 2kg = 20).
  assert.equal(locA.recipeCostExVat, 30);
  assert.equal(locB.recipeCostExVat, 20);
  assert.notEqual(locA.recipeCostExVat, locB.recipeCostExVat);

  // The single per-product summary row is intentionally unaffected — it stays workspace-level,
  // matching how its selling price is already just "the first positive price row" rather than
  // location-scoped.
  assert.equal(built.rows[0].recipeCostExVat, 20);
});
