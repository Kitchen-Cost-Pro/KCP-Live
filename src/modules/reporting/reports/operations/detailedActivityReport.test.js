import test from 'node:test';
import assert from 'node:assert/strict';
import { detailedActivityReport } from './detailedActivityReport.js';

// Regression: the Detailed Activity ledger (the report the app already treats as "the" stock
// movement report — see reportRegistry.js's `stock_movement -> detailed_activity` redirect) only
// showed Qty In/Qty Out/Net Qty/Running Qty, not a bank-statement-style Opening/Closing Balance per
// row. This adds those two columns, derived from the same running balance the backend already
// computes per movement (reporting-routes.ts's detailed-activity route).

function ledgerRow(overrides = {}) {
  return {
    id: 'movement-1',
    itemId: 'flour',
    itemName: 'Flour',
    locationId: 'main',
    locationName: 'Main Kitchen',
    category: 'Dry Goods',
    baseUom: 'kg',
    date: '2026-08-31',
    timestamp: '2026-08-31T08:00:00.000Z',
    source: 'GRV',
    sourceType: 'grv',
    movementType: 'GRV',
    sourceId: 'grv-1',
    qtyIn: 50,
    qtyOut: 0,
    netQty: 50,
    unitCostExVat: 10,
    movementValue: 500,
    runningQty: 50,
    runningValue: 500,
    ...overrides
  };
}

async function getRows(rows) {
  const services = { reporting: { getDetailedActivityLedger: async () => ({ rows, warnings: [], meta: {} }) } };
  return detailedActivityReport.getRows({ workspaceId: 'ws_1', filters: {}, services });
}

test('opening/closing balance are derived from the backend-supplied running balance', async () => {
  const rows = await getRows([
    ledgerRow(), // GRV +50: running balance goes from 0 to 50
    ledgerRow({
      id: 'movement-2',
      timestamp: '2026-08-31T09:00:00.000Z',
      source: 'Sale Usage',
      sourceType: 'saleUsage',
      movementType: 'Sale',
      sourceId: 'sale-1',
      qtyIn: 0,
      qtyOut: 10,
      netQty: -10,
      movementValue: -100,
      runningQty: 40,
      runningValue: 400
    })
  ]);

  const grvRow = rows.find((row) => row.sourceId === 'grv-1');
  assert.ok(grvRow);
  assert.equal(grvRow.closingBalance, 50, 'closing balance mirrors the running balance after the movement');
  assert.equal(grvRow.openingBalance, 0, 'opening balance = closing balance - net qty (50 - 50)');

  const saleRow = rows.find((row) => row.sourceId === 'sale-1');
  assert.ok(saleRow);
  assert.equal(saleRow.closingBalance, 40);
  assert.equal(saleRow.openingBalance, 50, 'opening balance = closing balance - net qty (40 - (-10))');
});

test('opening/closing balance stay null (not a fabricated 0) when the backend has no running balance for a row', async () => {
  const rows = await getRows([ledgerRow({ runningQty: null, runningValue: null })]);
  const row = rows[0];
  assert.equal(row.closingBalance, null);
  assert.equal(row.openingBalance, null);
});
