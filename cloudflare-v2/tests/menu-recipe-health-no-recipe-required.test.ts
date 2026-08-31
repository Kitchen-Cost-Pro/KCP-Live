import test from 'node:test';
import assert from 'node:assert/strict';
import { __menuHealthInternals } from '../src/legacy/reporting-routes';

const { buildMenuHealthContext, buildMenuRecipeHealthRows } = __menuHealthInternals;

// A menu item can be explicitly opted out of recipe tracking (products.raw_json.noRecipeRequired,
// toggled from the Menu Catalogue edit form) — e.g. a resold bottled drink, gift card, or service
// charge that legitimately never has a recipe. That must not surface as a "Missing recipe" problem
// on Menu & Recipe Health.

function buildProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 'product-1',
    workspace_id: 'workspace-1',
    name: 'Bottled Water',
    category: 'Beverages',
    price: 25,
    active: 1,
    yoco_item_id: 'yoco-item-1',
    yoco_variant_id: '',
    raw_json: '{}',
    sale_count: 0,
    qty_sold: 0,
    ...overrides,
  };
}

function emptyContext(overrides: Record<string, unknown> = {}) {
  return buildMenuHealthContext({
    vatRate: 15,
    locations: [],
    recipes: [],
    recipeLines: [],
    priceRows: [],
    locationCostRows: [],
    modifierGroups: [],
    modifierUsageCounts: [],
    salesStats: [],
    ...overrides,
  });
}

test('a product with no recipe and no opt-out is flagged Missing Recipe with a warning', () => {
  const context = emptyContext();
  const warnings: Array<{ code: string; level: string; message: string }> = [];
  const built = buildMenuRecipeHealthRows([buildProduct()], context, warnings);

  assert.equal(built.rows[0].recipeStatus, 'Missing Recipe');
  assert.equal(built.rows[0].stockDeductionStatus, 'Not Ready');
  assert.ok(built.warningRows.some((w: any) => w.issueType === 'Missing recipe'));
});

test('a product opted out via noRecipeRequired reports NOT_REQUIRED status and raises no missing-recipe warning', () => {
  const context = emptyContext();
  const warnings: Array<{ code: string; level: string; message: string }> = [];
  const product = buildProduct({ raw_json: JSON.stringify({ noRecipeRequired: true }) });
  const built = buildMenuRecipeHealthRows([product], context, warnings);

  assert.equal(built.rows[0].recipeStatus, 'No Recipe Required');
  assert.equal(built.rows[0].stockDeductionStatus, 'Not Required');
  assert.equal(built.rows[0].riskStatus, 'Healthy');
  assert.ok(!built.warningRows.some((w: any) => w.issueType === 'Missing recipe'));
});

test('noRecipeRequired never suppresses the warning when the item actually has a broken recipe', () => {
  // Opting a product out only matters while it truly has no recipe at all — if a recipe DOES exist
  // for it (owner:product), that recipe's own problems (e.g. no ingredient lines) must still surface.
  const recipe = { id: 'recipe-1', owner_type: 'product', owner_id: 'product-1', linked_product_id: 'product-1', yield_qty: 1, active: 1 };
  const context = emptyContext({ recipes: [recipe] });
  const warnings: Array<{ code: string; level: string; message: string }> = [];
  const product = buildProduct({ raw_json: JSON.stringify({ noRecipeRequired: true }) });
  const built = buildMenuRecipeHealthRows([product], context, warnings);

  assert.equal(built.rows[0].recipeStatus, 'Recipe Missing Ingredients');
  assert.ok(built.warningRows.some((w: any) => w.issueType === 'Recipe has no ingredients'));
});
