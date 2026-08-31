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

// Regression: switching a GRV draft line's UOM (e.g. base "KG" -> custom "Bottle" = 30 x base)
// updated packSize to the new ratio but left packPriceEx/packPriceDisplay untouched — so the
// Pack Price field kept showing the price for the OLD pack size instead of unitCost * new ratio.
// Since unitCost (cost per base unit) doesn't change when the UOM selector changes, the pack
// price must be re-derived from it whenever the ratio changes.

test('changing selectedUom re-derives packPriceEx from the unchanged base unitCost and the new ratio', () => {
  const handler = section(mainSource, 'function updateGrvLine(index, updates = {}) {', 'function removeGrvLine(');
  const uomBlock = section(handler, "Object.hasOwn(normalizedUpdates, 'selectedUom')", 'items[index] = {');
  assert.match(uomBlock, /normalizedUpdates\.packSize = String\(selection\.ratio\)/);
  assert.match(uomBlock, /normalizedUpdates\.packPriceEx = String\(unitCostEx \* selection\.ratio\)/);
  assert.match(uomBlock, /normalizedUpdates\.packPriceDisplay = ''/);
});
