import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('canonical modifier reporting reads sale-time names, types and stock actions', () => {
  const resolver = read('cloudflare-v2/src/modules/yoco-engine-v2/sale-resolver.ts');
  const routes = read('cloudflare-v2/src/legacy/reporting-routes.ts');
  assert.match(resolver, /source_name: identity\.name/);
  assert.match(resolver, /modifier_type: identity\.type/);
  assert.match(routes, /modifier\.source_name/);
  assert.match(routes, /metadata\.modifier_type/);
  assert.match(routes, /stockActionType/);
  assert.match(routes, /modifierStockActionLabel/);
  assert.match(routes, /return raw \? titleCase\(raw\) : "Option"/);
});

test('modifier catalogue uses a custom stock-action dropdown and a read-only linked-items modal', () => {
  const catalogue = read('src/components/MenuCatalogue.js');
  const styles = read('src/styles/menu.css');
  assert.match(catalogue, /renderModifierActionDropdown/);
  assert.match(catalogue, /menuCatalogue__stockActionMenu/);
  assert.doesNotMatch(catalogue, /<select[^>]*data-menu-modifier-action/);
  assert.match(catalogue, /renderModifierLinkedItemsModal/);
  assert.match(catalogue, /data-menu-modifier-links-close/);
  assert.match(styles, /\.menuCatalogue__stockActionPicker/);
  assert.match(styles, /\.menuCatalogue__linkedItemsModal/);
});

test('replace ingredient setup identifies the source from linked base recipes and the replacement item', () => {
  const recipes = read('src/components/Recipes.js');
  assert.match(recipes, /getModifierBaseRecipeStockItems/);
  assert.match(recipes, /What are we replacing from the base recipe\?/);
  assert.match(recipes, /What should replace it\?/);
  assert.match(recipes, /The original ingredient must come from one of the linked base recipes/);
  assert.match(recipes, /mode: 'source'/);
  assert.match(recipes, /mode: 'replacement'/);
});
