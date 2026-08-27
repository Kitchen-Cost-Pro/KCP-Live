import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finalizeLedgerRows,
  mapGenericLedgerRows,
  mapGrvLedgerRows,
  mapManufacturingLedgerRows,
  mapSaleUsageLedgerRows,
  mapTransferLedgerRows
} from './stockLedgerMapper.js';
import { buildStockCostLookup, buildStockItemLookup, resolveUnitCost, resolveUnitCostOrNull } from './reportDataMapper.js';
import { applyReportFilters, normalizeComparableDate } from './grouping.js';
import { calculateValueVariancePercent } from './calculations.js';
import { calculateQuantityVariancePercent } from './statistics.js';

const indexById = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));

test('a trusted API row with partial running-balance data still advances the running balance for later rows', () => {
  // Regression: the partial-row early return never wrote to the balances map, so every later row
  // for the same item/location was computed off a stale previous balance.
  const rows = finalizeLedgerRows([
    { id: 'api-complete', __fromReportingApi: true, timestamp: '2026-07-01T08:00:00Z', locationId: 'loc-1', itemId: 'item-1', netQty: 10, unitCost: 2, runningQty: 10, runningValue: 20 },
    { id: 'api-partial', __fromReportingApi: true, timestamp: '2026-07-02T08:00:00Z', locationId: 'loc-1', itemId: 'item-1', netQty: 5, unitCost: 2, runningQty: 15 },
    { id: 'local', timestamp: '2026-07-03T08:00:00Z', locationId: 'loc-1', itemId: 'item-1', netQty: 4, unitCost: 2 }
  ]);
  const byId = indexById(rows);
  assert.equal(byId['api-partial'].runningQty, 15);
  assert.equal(byId['api-partial'].runningValue, null);
  assert.equal(byId.local.runningQty, 19);
  assert.equal(byId.local.runningValue, 38);
});

test('a trusted API row with no running-balance data at all still advances the balance by its net movement', () => {
  const rows = finalizeLedgerRows([
    { id: 'api-complete', __fromReportingApi: true, timestamp: '2026-07-01T08:00:00Z', locationId: 'loc-1', itemId: 'item-1', netQty: 10, unitCost: 1, runningQty: 10, runningValue: 10 },
    { id: 'api-empty', __fromReportingApi: true, timestamp: '2026-07-02T08:00:00Z', locationId: 'loc-1', itemId: 'item-1', netQty: 5, unitCost: 1 },
    { id: 'local', timestamp: '2026-07-03T08:00:00Z', locationId: 'loc-1', itemId: 'item-1', netQty: 5, unitCost: 1 }
  ]);
  const byId = indexById(rows);
  assert.equal(byId['api-empty'].runningQty, null);
  assert.equal(byId.local.runningQty, 20);
  assert.equal(byId.local.runningValue, 20);
});

test('carried running balances stay scoped to their own item and location', () => {
  const rows = finalizeLedgerRows([
    { id: 'other-location-seed', __fromReportingApi: true, timestamp: '2026-07-01T08:00:00Z', locationId: 'loc-1', itemId: 'item-1', netQty: 10, unitCost: 1 },
    { id: 'local', timestamp: '2026-07-02T08:00:00Z', locationId: 'loc-2', itemId: 'item-1', netQty: 3, unitCost: 1 }
  ]);
  assert.equal(indexById(rows).local.runningQty, 3);
});

test('a genuine zero unit cost is returned as zero and only a missing cost falls through to the lookup', () => {
  const lookup = buildStockCostLookup([{ id: 'item-1', name: 'Tap Water', unitCost: 12.5 }]);
  assert.equal(resolveUnitCost({ id: 'item-1', unitCostExVat: 0 }, lookup), 0);
  assert.equal(resolveUnitCost({ id: 'item-1' }, lookup), 12.5);
  assert.equal(resolveUnitCost({ id: 'item-1', unitCost: '' }, lookup), 12.5);
  assert.equal(resolveUnitCost({ id: 'item-1', unitCost: 'not-a-number' }, lookup), 12.5);
  assert.equal(resolveUnitCost({ id: 'item-1', unitCost: '3.25' }, lookup), 3.25);
  assert.equal(resolveUnitCost({ unitCostExVat: 0 }), 0);
});

test('ledger rows keep a genuine zero unit cost instead of inheriting the stock item cost', () => {
  const stockItems = [{ id: 'item-1', name: 'Tap Water', unitCost: 12.5, baseUom: 'ml' }];
  const dataSet = {
    stockItemLookup: buildStockItemLookup(stockItems),
    stockCostLookup: buildStockCostLookup(stockItems),
    ledgerRows: [
      { id: 'zero-cost', timestamp: '2026-07-01T08:00:00Z', locationId: 'loc-1', itemId: 'item-1', itemName: 'Tap Water', qtyOut: 4, unitCost: 0 },
      { id: 'missing-cost', timestamp: '2026-07-02T08:00:00Z', locationId: 'loc-1', itemId: 'item-1', itemName: 'Tap Water', qtyOut: 4 }
    ]
  };
  const byId = indexById(mapGenericLedgerRows(dataSet));
  assert.equal(byId['zero-cost'].unitCost, 0);
  assert.equal(byId['zero-cost'].movementValue, 0);
  assert.equal(byId['missing-cost'].unitCost, 12.5);
});

test('GRV ledger lines keep a genuine zero unit cost while missing costs still resolve from the lookup', () => {
  const stockItems = [{ id: 'item-1', name: 'Tap Water', unitCost: 12.5, baseUom: 'ml' }];
  const rows = mapGrvLedgerRows({
    stockItemLookup: buildStockItemLookup(stockItems),
    stockCostLookup: buildStockCostLookup(stockItems),
    grvs: [{
      id: 'grv-1',
      date: '2026-07-01',
      locationId: 'loc-1',
      items: [
        { id: 'line-zero', stockItemId: 'item-1', stockItemName: 'Tap Water', qty: 2, unitCost: 0 },
        { id: 'line-missing', stockItemId: 'item-1', stockItemName: 'Tap Water', qty: 2 }
      ]
    }]
  });
  assert.equal(rows[0].unitCost, 0);
  assert.equal(rows[0].valueIn, 0);
  assert.equal(rows[1].unitCost, 12.5);
  assert.equal(rows[1].valueIn, 25);
});

test('resolveUnitCostOrNull separates a genuine zero cost from a lookup miss', () => {
  const lookup = buildStockCostLookup([{ id: 'item-1', name: 'Tap Water', unitCost: 12.5 }, { id: 'item-free', name: 'Ice', unitCost: 0 }]);
  assert.equal(resolveUnitCostOrNull({ id: 'item-1', unitCostExVat: 0 }, lookup), 0);
  assert.equal(resolveUnitCostOrNull({ id: 'item-1' }, lookup), 12.5);
  assert.equal(resolveUnitCostOrNull({ id: 'item-free' }, lookup), 0, 'a looked-up cost of exactly zero is a hit, not a miss');
  assert.equal(resolveUnitCostOrNull({ id: 'not-in-lookup' }, lookup), null);
  assert.equal(resolveUnitCostOrNull({ id: 'item-1' }), null, 'no lookup at all is a miss, not a zero cost');
  // The historical number-only contract is unchanged for existing callers.
  assert.equal(resolveUnitCost({ id: 'not-in-lookup' }, lookup), 0);
  assert.equal(resolveUnitCost({ id: 'item-1' }, lookup), 12.5);
});

test('a lookup miss still falls back to the stock item cost instead of collapsing to zero', () => {
  // Regression: the zero-preserving cost fix briefly made a lookup miss (which also resolves to 0)
  // look authoritative, so rows whose own id shadows the lookup key lost their stock item cost.
  const stockItems = [
    { id: 'FG1', name: 'Finished Good', unitCost: 40, baseUom: 'ea' },
    { id: 'RM1', name: 'Raw Material', unitCost: 5, baseUom: 'kg' }
  ];
  const lookups = { stockItemLookup: buildStockItemLookup(stockItems), stockCostLookup: buildStockCostLookup(stockItems) };

  const manufacturing = indexById(mapManufacturingLedgerRows({
    ...lookups,
    manufacturingLogs: [{
      id: 'ML1', date: '2026-07-01', locationId: 'loc-1', stockItemId: 'FG1', itemId: 'FG1', producedQty: 3,
      components: [{ id: 'C1', stockItemId: 'RM1', qty: 2 }]
    }]
  }));
  assert.equal(manufacturing['manufacturing-in:ML1'].unitCost, 40);
  assert.equal(manufacturing['manufacturing-in:ML1'].movementValue, 120);
  assert.equal(manufacturing['manufacturing-out:ML1:RM1'].unitCost, 5);

  const saleUsage = mapSaleUsageLedgerRows({
    ...lookups,
    saleUsage: [{ id: 'SU1', date: '2026-07-01', locationId: 'loc-1', stockItemId: 'RM1', qty: 4 }]
  });
  assert.equal(saleUsage[0].unitCost, 5);
  assert.equal(saleUsage[0].movementValue, -20);

  const transfers = mapTransferLedgerRows({
    ...lookups,
    transfers: [{
      id: 'T1', date: '2026-07-01', fromLocationId: 'loc-1', toLocationId: 'loc-2', status: 'accepted',
      items: [{ id: 'TL1', stockItemId: 'RM1', stockItemName: 'Raw Material', qty: 3, shippedQty: 3, receivedQty: 3 }]
    }]
  });
  assert.ok(transfers.every((row) => row.unitCost === 5));
});

test('a dataSet without a stock cost lookup still falls back to the stock item cost', () => {
  const stockItems = [{ id: 'FG1', name: 'Finished Good', unitCost: 40, baseUom: 'ea' }];
  const rows = mapGrvLedgerRows({
    stockItemLookup: buildStockItemLookup(stockItems),
    grvs: [{
      id: 'grv-1', date: '2026-07-01', locationId: 'loc-1',
      items: [
        { id: 'line-missing', stockItemId: 'FG1', stockItemName: 'Finished Good', qty: 2 },
        { id: 'line-zero', stockItemId: 'FG1', stockItemName: 'Finished Good', qty: 2, unitCost: 0 }
      ]
    }]
  });
  assert.equal(rows[0].unitCost, 40);
  assert.equal(rows[0].valueIn, 80);
  assert.equal(rows[1].unitCost, 0, 'a genuine zero on the line still wins over the stock item cost');
  assert.equal(rows[1].valueIn, 0);
});

test('value and quantity variance percentages are exported under unambiguous names', () => {
  // Regression: both modules exported `calculateVariancePercent` with the same signature but
  // different meanings, so a caller could import the wrong one without any error.
  assert.equal(calculateValueVariancePercent(-50, 500), -0.1);
  assert.equal(calculateValueVariancePercent(-50, 0), 0);
  assert.equal(calculateQuantityVariancePercent(-5, 100), -0.05);
  assert.equal(calculateQuantityVariancePercent(-5, 0), 0);
});

test('the old ambiguous calculateVariancePercent name is no longer exported by either module', async () => {
  const calculations = await import('./calculations.js');
  const statistics = await import('./statistics.js');
  assert.equal(calculations.calculateVariancePercent, undefined);
  assert.equal(statistics.calculateVariancePercent, undefined);
});

test('rows with an unresolvable date are excluded while a date range filter is active', () => {
  // Regression: `startDate && rowDate && ...` short-circuited to "keep" for undated rows, so rows
  // with no usable date silently survived a date-scoped report and inflated its totals.
  const rows = [
    { id: 'in-range', date: '2026-07-05' },
    { id: 'out-of-range', date: '2026-08-05' },
    { id: 'undated' },
    { id: 'blank-date', date: '' },
    { id: 'whitespace-date', date: '   ' },
    { id: 'non-date-value', date: true },
    { id: 'unparseable-date', date: 'not-a-date' }
  ];
  assert.deepEqual(
    applyReportFilters(rows, { startDate: '2026-07-01', endDate: '2026-07-31' }).map((row) => row.id),
    ['in-range']
  );
  assert.deepEqual(
    applyReportFilters(rows, { startDate: '2026-07-01' }).map((row) => row.id),
    ['in-range', 'out-of-range']
  );
  assert.deepEqual(
    applyReportFilters(rows, { endDate: '2026-07-31' }).map((row) => row.id),
    ['in-range']
  );
});

test('real dates in non-ISO shapes are normalized and still filter correctly', () => {
  // The unresolvable-date exclusion must catch genuinely undated rows only — a Date instance,
  // epoch milliseconds or an unpadded YYYY-M-D is a real date and has to keep filtering.
  const rows = [
    { id: 'date-object', date: new Date('2026-07-07T00:00:00Z') },
    { id: 'epoch-ms', date: Date.UTC(2026, 6, 8) },
    { id: 'epoch-ms-string', date: String(Date.UTC(2026, 6, 9)) },
    { id: 'unpadded', date: '2026-7-10' },
    { id: 'iso-datetime', date: '2026-07-06T09:30:00Z' },
    { id: 'timestamp-fallback', date: '', timestamp: '2026-07-11T12:00:00Z' },
    { id: 'date-object-out-of-range', date: new Date('2026-09-01T00:00:00Z') },
    { id: 'epoch-ms-out-of-range', date: Date.UTC(2026, 8, 2) }
  ];
  assert.deepEqual(
    applyReportFilters(rows, { startDate: '2026-07-01', endDate: '2026-07-31' }).map((row) => row.id),
    ['date-object', 'epoch-ms', 'epoch-ms-string', 'unpadded', 'iso-datetime', 'timestamp-fallback']
  );
});

test('normalizeComparableDate resolves real dates and rejects only genuinely unusable values', () => {
  assert.equal(normalizeComparableDate('2026-07-05'), '2026-07-05');
  assert.equal(normalizeComparableDate('2026-07-05T22:15:00Z'), '2026-07-05');
  assert.equal(normalizeComparableDate('2026-7-5'), '2026-07-05');
  assert.equal(normalizeComparableDate(new Date('2026-07-05T00:00:00Z')), '2026-07-05');
  assert.equal(normalizeComparableDate(Date.UTC(2026, 6, 5)), '2026-07-05');
  assert.equal(normalizeComparableDate(String(Date.UTC(2026, 6, 5))), '2026-07-05');
  assert.equal(normalizeComparableDate('July 5, 2026'), '2026-07-05');
  for (const unusable of ['', '   ', 'not-a-date', null, undefined, true, false, {}, [], new Date('nope'), NaN]) {
    assert.equal(normalizeComparableDate(unusable), '', `expected ${JSON.stringify(unusable)} to be unresolvable`);
  }
});

test('a whitespace, boolean or array cost is treated as missing rather than as a genuine zero', () => {
  // Regression: `Number('  ')`, `Number(false)` and `Number([])` are all 0, so these masqueraded as
  // real zero costs and suppressed both the lookup fallback and the missing-cost warning.
  const lookup = buildStockCostLookup([{ id: 'item-1', name: 'Tap Water', unitCost: 12.5 }]);
  for (const missing of ['   ', '', false, true, [], {}, 'abc', null, undefined]) {
    assert.equal(resolveUnitCostOrNull({ unitCost: missing }), null, `expected ${JSON.stringify(missing)} to be missing`);
    assert.equal(resolveUnitCost({ id: 'item-1', unitCost: missing }, lookup), 12.5);
  }
  assert.equal(resolveUnitCostOrNull({ unitCost: 0 }), 0);
  assert.equal(resolveUnitCostOrNull({ unitCost: '0' }), 0);
  assert.equal(resolveUnitCostOrNull({ unitCost: ' 3.5 ' }), 3.5);
});

test('rows with an unresolvable date are still kept when no date range filter is active', () => {
  const rows = [{ id: 'undated' }, { id: 'dated', date: '2026-07-05' }];
  assert.deepEqual(applyReportFilters(rows, {}).map((row) => row.id), ['undated', 'dated']);
  assert.deepEqual(applyReportFilters(rows, { locationId: '' }).map((row) => row.id), ['undated', 'dated']);
});
