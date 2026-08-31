import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mainSource = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const recipesSource = fs.readFileSync(new URL('./components/Recipes.js', import.meta.url), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing ${endMarker}`);
  return source.slice(start, end);
}

// Regression: renderRecipes() resolves `selectedItem` from the master items list whenever the item
// is already loaded there (`allItems.find(...) || ...`) — the same reason `draftRecipe` is tracked
// as its own top-level appState.recipes field rather than written onto `editingItem`. The "No
// Recipe Required" toggle originally wrote straight onto `editingItem.noRecipeRequired`, which the
// very next render silently discarded via that same selectedItem resolution — the checkbox looked
// like it did nothing because it reverted before the user's eyes on the next re-render.

test('the toggle writes to a top-level draftNoRecipeRequired field, not onto editingItem', () => {
  const handler = section(mainSource, 'function toggleRecipeNoRecipeRequired(', 'function updateRecipeSourceStockItem(');
  assert.match(handler, /draftNoRecipeRequired: checked === true/);
  assert.doesNotMatch(handler, /editingItem:\s*\{/, 'must not nest the flag onto editingItem — selectedItem resolution discards it there');
});

test('openRecipeEditor initializes draftNoRecipeRequired the same way it initializes draftRecipe', () => {
  const handler = section(mainSource, 'function openRecipeEditor(itemId) {', 'function openRecipeSetupFromMenu(');
  assert.match(handler, /draftRecipe: structuredCloneSafe\(item\.recipe \|\| \[\]\)/);
  assert.match(handler, /draftNoRecipeRequired: item\.noRecipeRequired === true/);
});

test('saveCurrentRecipe reads the draft flag, not editingItem.noRecipeRequired, when building the save payload', () => {
  const handler = section(mainSource, 'async function saveCurrentRecipe()', 'async function importRecipeFile');
  assert.match(handler, /noRecipeRequired:\s*appState\.recipes\.draftNoRecipeRequired === true/);
});

test('closing the recipe editor resets draftNoRecipeRequired so it cannot leak into the next item opened', () => {
  const closeHandler = section(mainSource, 'function closeRecipeEditor()', 'function updateRecipeLine(');
  assert.match(closeHandler, /draftNoRecipeRequired: false/);
});

test('completing a save also resets draftNoRecipeRequired', () => {
  const saveHandler = section(mainSource, 'async function saveCurrentRecipe()', 'async function importRecipeFile');
  const successBlock = saveHandler.slice(saveHandler.indexOf('editingItem: null'));
  assert.match(successBlock, /draftNoRecipeRequired: false/);
});

test('the modal render call merges the draft flag onto the item it passes to renderRecipeModal, not raw selectedItem alone', () => {
  const callSite = section(recipesSource, 'selectedItem ? renderRecipeModal(', 'renderRecipePickerModal(');
  assert.match(callSite, /noRecipeRequired:\s*recipes\.draftNoRecipeRequired\s*\?\?\s*selectedItem\.noRecipeRequired/);
});
