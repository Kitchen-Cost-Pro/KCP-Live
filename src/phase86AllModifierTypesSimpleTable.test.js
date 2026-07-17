import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('catalogue parser recognises product, option, add-on and note collections', () => {
  const integration = read('cloudflare-v2/src/modules/yoco-engine-v2/integration-service.ts');
  for (const key of ['product_modifiers', 'option_modifiers', 'add_on_modifiers', 'note_modifiers']) {
    assert.match(integration, new RegExp(key));
  }
  assert.match(integration, /kindFromCollectionKey/);
  assert.match(integration, /listModifierGroupChildren/);
  assert.match(integration, /if \(!modifierGroupModifiers\(merged\)\.length\)/);
});

test('structured note modifiers use the normal versioned stock rule setup', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const catalogue = read('src/components/MenuCatalogue.js');
  assert.match(routes, /modifierKind: isNoteRule \? "note"/);
  assert.match(routes, /stockRule: serializeModifierRule/);
  assert.doesNotMatch(catalogue, /NOTE_RULES/);
  assert.match(catalogue, /renderModifierActionDropdown\(item, action, openDropdown\)/);
});

test('free-text note suggestions remain separate and exact', () => {
  const catalogue = read('src/components/MenuCatalogue.js');
  const recipes = read('src/components/Recipes.js');
  assert.match(catalogue, /Suggestions from orders/);
  assert.match(recipes, /Nothing changes stock until you approve an exact rule/);
  assert.match(recipes, /Matching is exact after safe normalization/);
});
