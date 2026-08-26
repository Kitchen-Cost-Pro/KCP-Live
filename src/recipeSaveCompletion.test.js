import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mainSource = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing ${endMarker}`);
  return source.slice(start, end);
}

test('recipe save closes cleanly after focused quantity edits and cannot be submitted twice', () => {
  const handler = section(mainSource, 'async function saveCurrentRecipe()', 'async function importRecipeFile');

  assert.match(handler, /if \(appState\.recipes\.actionStatus === 'saving'\) return/);
  assert.ok(
    handler.indexOf('pendingFocusField = null') < handler.indexOf("actionStatus: 'saving'"),
    'recipe field focus must be released before the saving render'
  );
  assert.ok(
    handler.match(/pendingFocusField = null/g)?.length >= 3,
    'focus must be released before saving, success, and error renders'
  );
  assert.ok(
    handler.match(/document\.activeElement\.blur\(\)/g)?.length >= 3,
    'the active recipe field must be blurred before each state-changing render'
  );
  assert.match(handler, /editingItem: null/);
  assert.match(handler, /actionStatus: ''/);
  assert.match(handler, /showRecipeToast\('Recipe Blueprint Saved\.', 'success'\)/);
  assert.match(handler, /finally \{\s*hideGlobalSaving\(\);\s*\}/);
});
