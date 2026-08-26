import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('catalogue sync always enumerates and hydrates the complete Yoco modifier catalogue', () => {
  const integration = read('cloudflare-v2/src/modules/yoco-engine-v2/integration-service.ts');
  assert.match(integration, /async function fetchCompleteYocoModifierCatalogue/);
  assert.match(integration, /await listModifierGroups\(env, workspaceId, apiKey\)/);
  assert.match(integration, /await fetchModifierGroup\(env, workspaceId, apiKey, groupId\)/);
  assert.match(integration, /const modifierCatalogue = await fetchCompleteYocoModifierCatalogue/);
});

test('catalogue reconciliation preserves cached modifiers when the provider enumeration is incomplete', () => {
  const integration = read('cloudflare-v2/src/modules/yoco-engine-v2/integration-service.ts');
  assert.match(integration, /if \(modifierCatalogue\.complete && assignedModifierGroupIds\.length\)/);
  assert.match(integration, /else if \(modifierCatalogue\.complete\)/);
  assert.match(integration, /preserv/i);
});

test('Menu Catalogue owns a simple four-column modifier action table and linked-items viewer', () => {
  const catalogue = read('src/components/MenuCatalogue.js');
  for (const heading of ['Modifier Name', 'Group', 'Linked Items', 'Stock Action']) {
    assert.match(catalogue, new RegExp(heading));
  }
  assert.doesNotMatch(catalogue, /<span>Price<\/span>[\s\S]*<span>Linked Product<\/span>/);
  assert.match(catalogue, /Suggestions from orders/);
  assert.doesNotMatch(catalogue, /<span>Setup<\/span>/);
  assert.match(catalogue, /renderModifierActionDropdown/);
  assert.match(catalogue, /data-menu-modifier-action-option/);
  assert.doesNotMatch(catalogue, /<select[^>]*data-menu-modifier-action/);
  assert.match(catalogue, /data-menu-modifier-links/);
  assert.match(catalogue, /renderModifierLinkedItemsModal/);
  assert.match(catalogue, /renderModifierStockActionDrawer/);
  assert.match(catalogue, /renderNoteSuggestionsModal/);
});

test('menu catalogue data subscription includes ingredients and observed note suggestions', () => {
  const service = read('src/services/menuService.js');
  assert.match(service, /fetchStock\(workspaceKey\)/);
  assert.match(service, /fetchModifierNoteSuggestions\(workspaceKey/);
  assert.match(service, /ingredients/);
  assert.match(service, /noteSuggestions/);
});

test('integration status reports every modifier type separately', () => {
  const integrations = read('src/components/Integrations.js');
  assert.match(integrations, /Modifier choices stored/);
  assert.match(integrations, /Product modifiers/);
  assert.match(integrations, /Option modifiers/);
  assert.match(integrations, /Note modifiers/);
});
