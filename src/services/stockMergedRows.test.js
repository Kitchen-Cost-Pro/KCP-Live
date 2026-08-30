import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStockItemPersistedIds } from './stockService.js';

// `dedupeStockItems` collapses stock rows sharing name+category+unit into ONE visible row, keeping
// the primary's `id` and recording the whole group in `mergedIds`. Deleting only `id` left the
// siblings active in the database, and the next refresh rebuilt the merged row from them — which is
// why deleted stock items "came back". Anything that mutates a displayed row must resolve the full
// group first.
test('a merged row resolves to every id it stands for', () => {
  assert.deepEqual(
    resolveStockItemPersistedIds({ id: 'stock_1', mergedIds: 'stock_1,stock_2,stock_3' }),
    ['stock_1', 'stock_2', 'stock_3'],
  );
});

test('an unmerged row resolves to just its own id', () => {
  assert.deepEqual(resolveStockItemPersistedIds({ id: 'stock_1' }), ['stock_1']);
  assert.deepEqual(resolveStockItemPersistedIds({ id: 'stock_1', mergedIds: '' }), ['stock_1']);
});

test('the primary id is included even when mergedIds omits it', () => {
  // Defensive: mergedIds is built by merging, so a hand-edited or partial value must not silently
  // drop the row the user actually clicked.
  assert.deepEqual(
    resolveStockItemPersistedIds({ id: 'stock_1', mergedIds: 'stock_2,stock_3' }),
    ['stock_1', 'stock_2', 'stock_3'],
  );
});

test('duplicates and whitespace in mergedIds are cleaned up', () => {
  assert.deepEqual(
    resolveStockItemPersistedIds({ id: 'stock_1', mergedIds: ' stock_1 , stock_2 ,, stock_2 ' }),
    ['stock_1', 'stock_2'],
  );
});

test('a row with no usable id resolves to nothing rather than a blank id', () => {
  // A blank id would otherwise be sent to DELETE /stock-items/ and hit the wrong route.
  assert.deepEqual(resolveStockItemPersistedIds({}), []);
  assert.deepEqual(resolveStockItemPersistedIds({ id: '   ' }), []);
});
