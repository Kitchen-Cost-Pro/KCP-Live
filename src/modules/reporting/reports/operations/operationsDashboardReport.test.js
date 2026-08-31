import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationsDashboardModel } from './operationsDashboardReport.js';

// Regression guard: resolveQuantitySnapshot() used to fall back to `dataSet.stockItems`'
// live `currentStock` figure with no gating on the report's `endDate` filter — the same live,
// "as of right now" feed `stockOnHandReport.js` exposes, with no point-in-time query. Running the
// dashboard for a historical period silently blended today's live balance into that period's
// "actual closing qty," fabricating a variance (the same bug already fixed in
// theoreticalVsActualReport.js).

function ledgerRow(overrides = {}) {
  return {
    id: 'movement-1',
    date: '2020-01-02',
    locationId: 'main',
    locationName: 'Main Kitchen',
    itemId: 'flour',
    itemName: 'Flour',
    category: 'Dry Goods',
    baseUom: 'kg',
    source: 'GRV',
    movementType: 'GRV',
    qtyIn: 20,
    qtyOut: 0,
    netQty: 20,
    unitCostExVat: 5,
    movementValue: 100,
    ...overrides
  };
}

test('a historical dashboard run does not fabricate an actual closing qty from today\'s live stock balance', () => {
  const dataSet = {
    stockItems: [{ id: 'flour', name: 'Flour', currentStock: 999, baseUom: 'kg' }]
  };
  const model = buildOperationsDashboardModel({
    ledgerRows: [ledgerRow()],
    filters: { startDate: '2020-01-01', endDate: '2020-01-02' },
    dataSet
  });
  const row = model.views.by_item.find((item) => item.itemId === 'flour');
  assert.ok(row);
  assert.equal(row.actualClosingQty, null, 'without a stock take, a historical period must not trust the live balance');
});

test('a genuine period-scoped closing-stock snapshot is trusted for a historical period, unlike the live stock item', () => {
  // `dataSet.closingStockSnapshots` is a distinct, presumably period-aware data source from
  // `dataSet.stockItems`'s live currentStock — it must NOT be gated behind the "as of today" check,
  // since (unlike the live stock item) a dedicated snapshot record is exactly the kind of
  // point-in-time figure a historical query is allowed to trust.
  const dataSet = {
    stockItems: [{ id: 'flour', name: 'Flour', currentStock: 999, baseUom: 'kg' }],
    closingStockSnapshots: [{ itemId: 'flour', locationId: 'main', actualClosingQty: 42 }]
  };
  const model = buildOperationsDashboardModel({
    ledgerRows: [ledgerRow()],
    filters: { startDate: '2020-01-01', endDate: '2020-01-02' },
    dataSet
  });
  const row = model.views.by_item.find((item) => item.itemId === 'flour');
  assert.ok(row);
  assert.equal(row.actualClosingQty, 42, 'a genuine period snapshot must still be used for a historical period, unlike the live stock item');
});

test('a dashboard run with no end-date filter still uses the live stock balance normally', () => {
  const dataSet = {
    stockItems: [{ id: 'flour', name: 'Flour', currentStock: 999, baseUom: 'kg' }]
  };
  const model = buildOperationsDashboardModel({
    ledgerRows: [ledgerRow()],
    filters: { startDate: '2020-01-01' },
    dataSet
  });
  const row = model.views.by_item.find((item) => item.itemId === 'flour');
  assert.ok(row);
  assert.equal(row.actualClosingQty, 999, 'an "as of right now" query (no endDate) should still use the live balance');
});

// Regression: Opening Stock Value/Qty had no fallback at all once there was no stored point-in-time
// opening snapshot (the common case — most workspaces never populate dataSet.stockSnapshots), so it
// silently showed 0 for everyone, even when the actual/current balance resolved fine via the live
// stock item. Opening should instead be derived by walking the resolved actual balance backwards by
// the net of the period's own ledger movements.
test('opening qty/value is derived from the live actual balance minus the period\'s net movement when no snapshot exists', () => {
  const dataSet = {
    stockItems: [{ id: 'flour', name: 'Flour', currentStock: 999, baseUom: 'kg' }]
  };
  const model = buildOperationsDashboardModel({
    ledgerRows: [ledgerRow()], // netQty: 20 for the period
    filters: { startDate: '2020-01-01' },
    dataSet
  });
  const row = model.views.by_item.find((item) => item.itemId === 'flour');
  assert.ok(row);
  assert.equal(row.actualClosingQty, 999);
  assert.equal(row.openingQty, 979, 'opening = actual (999) minus the period\'s net movement (+20)');

  const overviewRow = model.views.overview.find((item) => item.locationId === 'main');
  assert.ok(overviewRow);
  assert.ok(overviewRow.openingStockValue !== 0, 'opening stock value must not silently fall back to 0 when it can be derived');
  assert.equal(overviewRow.openingStockValue, 979 * 5, 'openingValue = openingQty * unit cost (5)');
});

test('opening stays unavailable (not fabricated as 0) when the actual balance itself cannot be trusted for a historical period', () => {
  const dataSet = {
    stockItems: [{ id: 'flour', name: 'Flour', currentStock: 999, baseUom: 'kg' }]
  };
  const model = buildOperationsDashboardModel({
    ledgerRows: [ledgerRow()],
    filters: { startDate: '2020-01-01', endDate: '2020-01-02' },
    dataSet
  });
  const row = model.views.by_item.find((item) => item.itemId === 'flour');
  assert.ok(row);
  assert.equal(row.actualClosingQty, null, 'sanity: no trustworthy actual balance for this historical period (see earlier test)');
  assert.equal(row.openingQty, 0);
  assert.equal(row.missingOpeningCount, 1, 'must be flagged as missing, not silently reported as a real 0');
});
