import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockOnHandViews, stockOnHandReport } from './stockOnHandReport.js';

// "Stock on Hand by UOM" — converts a stock balance held in its base unit into each of the item's
// configured custom ordering/receiving UOMs (e.g. a wine held as 750ml with Custom UOM 1 = "Bottle"
// at a ratio of 750 should show as "1 Bottle").

function wineRow(overrides = {}) {
  return {
    id: 'soh:wine:loc-a:0',
    itemId: 'item-wine',
    itemName: 'Merlot 750ml',
    locationId: 'loc-a',
    locationName: 'Main Bar',
    currentStock: 750,
    baseUom: 'ml',
    uomConfigurations: [{ customUom: 'Bottle', ratio: 750 }],
    ...overrides,
  };
}

test('the by_uom view is registered on the report', () => {
  assert.ok(stockOnHandReport.availableViews.includes('by_uom'));
  assert.ok(stockOnHandReport.columns.by_uom);
});

test('converts a base-unit balance into its configured custom UOM using the stored ratio', () => {
  const views = buildStockOnHandViews([wineRow()]);
  assert.equal(views.by_uom.length, 1);
  const row = views.by_uom[0];
  assert.equal(row.itemName, 'Merlot 750ml');
  assert.equal(row.baseUomDisplay, '750 ml');
  assert.equal(row.customUom1Display, '1 Bottle');
  assert.equal(row.customUom2Display, '');
  assert.equal(row.customUom3Display, '');
});

test('a partial case still divides cleanly by the ratio (2.5 bottles worth)', () => {
  const views = buildStockOnHandViews([wineRow({ currentStock: 1875 })]);
  assert.equal(views.by_uom[0].customUom1Display, '2.5 Bottle');
});

test('up to three configured custom UOMs are shown, each independently converted', () => {
  const row = wineRow({
    currentStock: 1200,
    baseUom: 'ea',
    uomConfigurations: [
      { customUom: 'Six-Pack', ratio: 6 },
      { customUom: 'Case', ratio: 24 },
      { customUom: 'Pallet', ratio: 1200 },
    ],
  });
  const views = buildStockOnHandViews([row]);
  const out = views.by_uom[0];
  assert.equal(out.customUom1Display, '200 Six-Pack');
  assert.equal(out.customUom2Display, '50 Case');
  assert.equal(out.customUom3Display, '1 Pallet');
});

test('an item with no configured custom UOMs shows only the base UOM, blank custom columns', () => {
  const row = wineRow({ uomConfigurations: [] });
  const out = buildStockOnHandViews([row]).by_uom[0];
  assert.equal(out.baseUomDisplay, '750 ml');
  assert.equal(out.customUom1Display, '');
  assert.equal(out.customUom2Display, '');
  assert.equal(out.customUom3Display, '');
});

test('a zero or malformed ratio is not usable for conversion and is dropped', () => {
  const row = wineRow({
    uomConfigurations: [
      { customUom: 'Bottle', ratio: 0 },
      { customUom: '', ratio: 750 },
      { customUom: 'Case', ratio: 9000 },
    ],
  });
  const out = buildStockOnHandViews([row]).by_uom[0];
  // Only the valid entry ("Case") survives filtering, and it becomes slot 1 — an unusable entry is
  // dropped entirely rather than rendered as a broken/blank slot in the middle.
  assert.equal(out.customUom1Display, '0.083 Case');
  assert.equal(out.customUom2Display, '');
});

test('by_uom has no totals row, since its cells mix incompatible units across rows', () => {
  const rows = [wineRow(), wineRow({ id: 'soh:wine:loc-b:1', locationId: 'loc-b', locationName: 'Main Store' })];
  const totals = stockOnHandReport.getTotals({ rows: buildStockOnHandViews(rows).by_uom, view: 'by_uom' });
  assert.deepEqual(totals, {});
});
