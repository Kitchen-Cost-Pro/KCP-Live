import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStockItemType, stripStockCategoryTypeSuffix } from './stockItemType.js';

// The bug: an explicit itemType and the category TEXT were tested with equal priority via an OR, so
// stale category text kept re-deriving the old type on every save. Converting a Non Stock item back
// to a normal stock item therefore never stuck — it silently stayed Non Stock forever.
test('an explicit item type wins over stale category text', () => {
  assert.equal(
    deriveStockItemType({ itemType: 'standard', category: 'General - Non Stock' }),
    'standard',
  );
  assert.equal(
    deriveStockItemType({ itemType: 'raw', category: 'General - Non Stock - Raw Materials' }),
    'standard',
  );
});

test('category text still classifies legacy rows that carry no explicit type', () => {
  assert.equal(deriveStockItemType({ category: 'General - Non Stock' }), 'recipe_source');
  assert.equal(deriveStockItemType({ category: 'Sauces - Sub Recipe' }), 'sub_recipe');
  assert.equal(deriveStockItemType({ category: 'Bakery - Manufactured' }), 'manufactured');
  assert.equal(deriveStockItemType({ category: 'General - Raw Materials' }), 'standard');
  assert.equal(deriveStockItemType({}), 'standard');
});

test('explicit non-stock spellings all resolve to recipe_source', () => {
  ['recipe_source', 'non_stock', 'nonstock', 'Non Stock', 'non-stock'].forEach((value) => {
    assert.equal(deriveStockItemType({ itemType: value }), 'recipe_source', `failed for ${value}`);
  });
});

test('virtual stays distinct from recipe_source so callers can decide', () => {
  assert.equal(deriveStockItemType({ itemType: 'virtual' }), 'virtual');
  assert.equal(deriveStockItemType({ itemType: 'menu_item' }), 'virtual');
});

test('boolean type flags rank with the explicit type, not with category text', () => {
  assert.equal(deriveStockItemType({ isSubRecipe: true, category: 'General - Raw Materials' }), 'sub_recipe');
  assert.equal(deriveStockItemType({ isManufactured: true, category: 'General - Raw Materials' }), 'manufactured');
});

test('an unrecognised explicit type does not fall through to category guessing', () => {
  assert.equal(deriveStockItemType({ itemType: 'something_new', category: 'General - Non Stock' }), 'standard');
});

// The second half of the same bug: markers were appended without the previous one being removed, so
// a round trip produced "General - Non Stock - Raw Materials" and the stale text won again.
test('stripping removes accumulated type markers', () => {
  assert.equal(stripStockCategoryTypeSuffix('General - Non Stock'), 'General');
  assert.equal(stripStockCategoryTypeSuffix('General - Non Stock - Raw Materials'), 'General');
  assert.equal(stripStockCategoryTypeSuffix('General - Raw Materials'), 'General');
  assert.equal(stripStockCategoryTypeSuffix('Sauces - Sub Recipe'), 'Sauces');
  assert.equal(stripStockCategoryTypeSuffix('Bakery - Manufactured'), 'Bakery');
});

test('stripping leaves a plain category and multi-word names intact', () => {
  assert.equal(stripStockCategoryTypeSuffix('General'), 'General');
  assert.equal(stripStockCategoryTypeSuffix(''), '');
  // "Dry Goods" is the user's own category and must survive, markers or not.
  assert.equal(stripStockCategoryTypeSuffix('Dry Goods - Raw Materials'), 'Dry Goods');
  assert.equal(stripStockCategoryTypeSuffix('Dry Goods'), 'Dry Goods');
});

test('a Non Stock round trip returns to the original category and type', () => {
  const base = 'Dry Goods';
  // Convert to Non Stock the way normalizeStockPayload does.
  const asNonStock = `${stripStockCategoryTypeSuffix(base) || 'General'} - Non Stock`;
  assert.equal(asNonStock, 'Dry Goods - Non Stock');
  assert.equal(deriveStockItemType({ itemType: 'recipe_source', category: asNonStock }), 'recipe_source');

  // Convert back: strip the marker, append the stock one, and the explicit type must hold.
  const backToStock = `${stripStockCategoryTypeSuffix(asNonStock)} - Raw Materials`;
  assert.equal(backToStock, 'Dry Goods - Raw Materials');
  assert.equal(deriveStockItemType({ itemType: 'standard', category: backToStock }), 'standard');
});

test('a base category that IS a marker word does not get it appended twice', () => {
  // Stripping only removes a marker that follows a " - " separator, so a bare "Raw Materials" or
  // "Non Stock" survives as the user's own category name and must not be doubled up.
  assert.equal(stripStockCategoryTypeSuffix('Raw Materials'), 'Raw Materials');
  assert.equal(stripStockCategoryTypeSuffix('Non Stock'), 'Non Stock');
});
