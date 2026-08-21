import test from 'node:test';
import assert from 'node:assert/strict';
import { convertToBaseUom } from './recipeExplosion.js';

// Custom UOM ratios are saved by the UOM builder as { baseUom, customUom, ratio }, where `ratio` is
// base units per ONE custom unit. Menu health flagged "missing UOM conversion" for ratios that were
// configured, because only the custom -> base direction was ever looked up.
const stockItem = {
  id: 'stock_1',
  unit: 'crate',
  uomConfigurations: [{ baseUom: 'kg', customUom: 'crate', ratio: 12 }],
};

test('a configured custom UOM converts to its base unit without a warning', () => {
  const warnings = [];
  const result = convertToBaseUom({ qty: 2, fromUom: 'crate', toUom: 'kg', stockItem, warnings });
  assert.equal(result.qty, 24);
  assert.deepEqual(warnings, []);
});

test('the same ratio also converts back from the base unit', () => {
  const warnings = [];
  const result = convertToBaseUom({ qty: 24, fromUom: 'kg', toUom: 'crate', stockItem, warnings });
  assert.equal(result.qty, 2);
  assert.deepEqual(
    warnings,
    [],
    'a ratio configured in the UOM builder describes both directions, so neither should warn',
  );
});

test('a ratio stored only in raw_json is still found', () => {
  const warnings = [];
  const rawOnly = {
    id: 'stock_2',
    unit: 'crate',
    raw_json: JSON.stringify({ uomConfigurations: [{ baseUom: 'kg', customUom: 'crate', ratio: 12 }] }),
  };
  assert.equal(convertToBaseUom({ qty: 1, fromUom: 'crate', toUom: 'kg', stockItem: rawOnly, warnings }).qty, 12);
  assert.equal(convertToBaseUom({ qty: 12, fromUom: 'kg', toUom: 'crate', stockItem: rawOnly, warnings }).qty, 1);
  assert.deepEqual(warnings, []);
});

test('a genuinely unconfigured custom UOM still warns', () => {
  // The inverse lookup must not paper over a conversion nobody set up.
  const warnings = [];
  convertToBaseUom({
    qty: 1,
    fromUom: 'pallet',
    toUom: 'kg',
    stockItem: { id: 'stock_3', unit: 'pallet', uomConfigurations: [] },
    warnings,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'missing-uom-conversion');
});

test('a zero or missing ratio is not treated as a usable inverse', () => {
  // 1/0 would be Infinity; the conversion must fall through to the warning instead.
  const warnings = [];
  convertToBaseUom({
    qty: 1,
    fromUom: 'kg',
    toUom: 'crate',
    stockItem: { id: 'stock_4', unit: 'crate', uomConfigurations: [{ baseUom: 'kg', customUom: 'crate', ratio: 0 }] },
    warnings,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'missing-uom-conversion');
});
