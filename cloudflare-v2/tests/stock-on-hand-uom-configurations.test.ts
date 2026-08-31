import test from 'node:test';
import assert from 'node:assert/strict';
import { reportUomConfigurations } from '../src/legacy/reporting-phase21-routes';

// Powers the Stock on Hand "by_uom" view: stock_items.raw_json.uomConfigurations (as saved by
// StockItems.js's Cost by Location / UOM Configuration editor) must be reduced to only the entries
// that are actually usable for a base-unit -> custom-unit conversion.

test('only entries with a name and a positive ratio survive, capped at 3', () => {
  const result = reportUomConfigurations([
    { baseUom: 'ml', customUom: 'Bottle', ratio: 750, barcode: '', isDefaultOrdering: true },
    { baseUom: 'ml', customUom: 'Case', ratio: 9000 },
    { baseUom: 'ml', customUom: '', ratio: 500 },
    { baseUom: 'ml', customUom: 'Zero Ratio', ratio: 0 },
    { baseUom: 'ml', customUom: 'Fourth', ratio: 12 },
  ]);
  assert.deepEqual(result, [
    { customUom: 'Bottle', ratio: 750 },
    { customUom: 'Case', ratio: 9000 },
    { customUom: 'Fourth', ratio: 12 },
  ]);
});

test('missing, non-array, or malformed input degrades to an empty list', () => {
  assert.deepEqual(reportUomConfigurations(undefined), []);
  assert.deepEqual(reportUomConfigurations(null), []);
  assert.deepEqual(reportUomConfigurations({}), []);
  assert.deepEqual(reportUomConfigurations('not an array'), []);
  assert.deepEqual(reportUomConfigurations([null, 'x', 42, { customUom: 'ea' }]), []);
});

test('a negative ratio is not usable', () => {
  assert.deepEqual(reportUomConfigurations([{ customUom: 'Broken', ratio: -5 }]), []);
});
