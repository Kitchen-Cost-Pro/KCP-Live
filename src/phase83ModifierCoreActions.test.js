import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('modifier setup drawer exposes core stock actions, scope and preview', () => {
  const source = read('src/components/Recipes.js');
  assert.match(source, /What should happen to stock when this is selected\?/);
  assert.match(source, /Deduct extra recipe/);
  assert.match(source, /Deduct extra stock item/);
  assert.match(source, /Remove an ingredient/);
  assert.match(source, /Replace an ingredient/);
  assert.match(source, /No stock change/);
  assert.match(source, /Apply to all matching products/);
  assert.match(source, /Plain-language preview/);
  assert.match(source, /data-modifier-stock-picker-open/);
  assert.match(source, /data-modifier-stock-replacement-quantity/);
  assert.doesNotMatch(source, /data-modifier-stock-location/);
});

test('modifier recipe save sends the rule and provider identities to the Worker', () => {
  const service = read('src/services/recipeService.js');
  assert.match(service, /stockRule:\s*normalizeModifierStockRule\(item\)/);
  assert.match(service, /yocoModifierId:\s*item\.yocoModifierId/);
  assert.match(service, /yocoModifierGroupId:\s*item\.yocoModifierGroupId/);
  assert.match(service, /yocoModifierVariantId:\s*item\.yocoModifierVariantId/);
});

test('modifier engine migration and sale proposal path own all five actions', () => {
  const migration = read('cloudflare-v2/src/modules/modifier-engine/migrations.ts');
  const proposals = read('cloudflare-v2/src/modules/yoco-engine-v2/effect-proposals.ts');
  const resolver = read('cloudflare-v2/src/modules/yoco-engine-v2/sale-resolver.ts');
  for (const action of ['ADD_RECIPE', 'ADD_STOCK_ITEM', 'REMOVE_INGREDIENT', 'REPLACE_INGREDIENT', 'NO_STOCK_CHANGE']) {
    assert.match(migration, new RegExp(action));
  }
  assert.match(proposals, /getApplicableModifierRule/);
  assert.match(proposals, /MODIFIER_RULE_SOURCE_INGREDIENT_MISSING/);
  assert.match(resolver, /resolveModifierMapping/);
  assert.match(resolver, /observeModifier/);
});

test('modifier catalogue exposes option modifiers as configurable recipe rows', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const integration = read('cloudflare-v2/src/modules/yoco-engine-v2/integration-service.ts');
  assert.match(routes, /option_unmapped/);
  assert.match(routes, /actionableYocoModifierGroup/);
  assert.match(integration, /function actionableModifierGroup/);
  assert.match(integration, /filter\(isActionableModifier\)/);
});

test('modifier rule validation runs before recipe lines are replaced', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const routeStart = routes.indexOf('export async function patchYocoModifierRecipe');
  const validation = routes.indexOf('await validateModifierRule', routeStart);
  const recipeSave = routes.indexOf('await saveYocoModifierRecipe', routeStart);
  assert.ok(validation > routeStart);
  assert.ok(recipeSave > validation);
  const rules = read('cloudflare-v2/src/modules/modifier-engine/rules.ts');
  assert.match(rules, /MODIFIER_RULE_VALIDATION_FAILED/);
});
