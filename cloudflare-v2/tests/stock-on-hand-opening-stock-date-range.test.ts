import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';

// Regression: Stock on Hand's "Opening Stock" used to be computed from ALL-TIME movement totals
// (currentStock - lifetime qtyIn + lifetime qtyOut), which is really "balance before the very first
// movement ever recorded" — for almost every item that's 0, which looked like the column was simply
// broken. There was also no date-range filter at all, so a user could never see qty in/out or opening
// stock for a specific period.
//
// This mirrors the movement_totals CTE added to getStockOnHandReport in
// ../src/legacy/reporting-phase21-routes.ts — kept in sync manually since that SQL lives inline in
// the route (importing routes.ts/reporting-phase21-routes.ts directly pulls in Cloudflare-runtime-only
// imports that fail under node:sqlite, per the established stock-take-counted-at.ts extraction
// precedent). If the CTE in the route changes, update this copy to match.
const MOVEMENT_TOTALS_SQL = `
  SELECT workspace_id, stock_item_id, location_id,
         SUM(CASE WHEN quantity_delta > 0 AND (?2 = '' OR occurred_at >= ?2) AND (?3 = '' OR occurred_at < ?3) THEN quantity_delta ELSE 0 END) AS qty_in,
         SUM(CASE WHEN quantity_delta < 0 AND (?2 = '' OR occurred_at >= ?2) AND (?3 = '' OR occurred_at < ?3) THEN -quantity_delta ELSE 0 END) AS qty_out,
         SUM(quantity_delta) AS ledger_closing_stock,
         SUM(CASE WHEN (?2 = '' OR occurred_at >= ?2) THEN quantity_delta ELSE 0 END) AS net_since_period_start,
         MAX(occurred_at) AS last_movement_date
    FROM stock_movements WHERE workspace_id = ?1
   GROUP BY workspace_id, stock_item_id, location_id
`;

function seedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(TENANT_SCHEMA_SQL);
  db.exec(`
    INSERT INTO locations (id, workspace_id, name) VALUES ('loc_1', 'ws_1', 'Main Store');
    INSERT INTO stock_items (id, workspace_id, name, unit) VALUES ('item_1', 'ws_1', 'Test Item', 'ea');
  `);
  const insert = db.prepare(
    `INSERT INTO stock_movements (id, workspace_id, stock_item_id, location_id, movement_type, quantity_delta, occurred_at, created_at)
     VALUES (?, 'ws_1', 'item_1', 'loc_1', 'grv', ?, ?, ?)`,
  );
  // Lifetime movement history for item_1 @ loc_1, spanning several days.
  insert.run('m1', 100, '2026-08-01T08:00:00.000Z', '2026-08-01T08:00:00.000Z'); // +100 (received)
  insert.run('m2', -20, '2026-08-15T09:00:00.000Z', '2026-08-15T09:00:00.000Z'); // -20 (sold)
  insert.run('m3', 50, '2026-08-30T10:00:00.000Z', '2026-08-30T10:00:00.000Z'); // +50 (received)
  insert.run('m4', -10, '2026-08-31T06:00:00.000Z', '2026-08-31T06:00:00.000Z'); // -10 (sold, "today")
  // currentStock (live, e.g. from stock_balances) = 100 - 20 + 50 - 10 = 120
  return db;
}

function queryMovementTotals(db: DatabaseSync, fromUtc: string, toExclusiveUtc: string) {
  const row = db.prepare(MOVEMENT_TOTALS_SQL).get('ws_1', fromUtc, toExclusiveUtc) as Record<string, unknown> | undefined;
  return {
    qtyIn: Number(row?.qty_in ?? 0),
    qtyOut: Number(row?.qty_out ?? 0),
    netSincePeriodStart: Number(row?.net_since_period_start ?? 0),
  };
}

test('with no date range, opening stock reduces to the original all-time formula (backward compatible)', () => {
  const db = seedDb();
  const totals = queryMovementTotals(db, '', '');
  const currentStock = 120;
  // Old formula: currentStock - lifetime qtyIn + lifetime qtyOut.
  const oldOpeningStock = currentStock - totals.qtyIn + totals.qtyOut;
  // New formula: currentStock - netSincePeriodStart (period start = beginning of time when fromUtc is '').
  const newOpeningStock = currentStock - totals.netSincePeriodStart;
  assert.equal(newOpeningStock, oldOpeningStock);
  assert.equal(newOpeningStock, 0); // balance before the very first movement ever recorded
  assert.equal(totals.qtyIn, 150);
  assert.equal(totals.qtyOut, 30);
});

test('with a date range covering only "today", qty in/out are scoped to that day and opening stock is the balance at the start of the day', () => {
  const db = seedDb();
  // "Today" = 2026-08-31, bounds computed the same way addZonedDateRange/localDateRangeToUtcBounds would.
  const fromUtc = '2026-08-31T00:00:00.000Z';
  const toExclusiveUtc = '2026-09-01T00:00:00.000Z';
  const totals = queryMovementTotals(db, fromUtc, toExclusiveUtc);
  const currentStock = 120;

  // Only m4 (-10) falls inside today's window.
  assert.equal(totals.qtyIn, 0);
  assert.equal(totals.qtyOut, 10);

  // Opening stock = balance at the start of today = currentStock minus everything that happened
  // since the start of today through now (m4 only) = 120 - (-10) = 130.
  const openingStock = currentStock - totals.netSincePeriodStart;
  assert.equal(openingStock, 130);
  // Sanity check against the full ledger: balance immediately before m4 was 100-20+50 = 130.
  assert.equal(openingStock, 100 - 20 + 50);
});

test('with a date range covering a past day only, qty in/out and opening stock reflect that day, not today', () => {
  const db = seedDb();
  // 2026-08-15 only: just m2 (-20) falls inside.
  const fromUtc = '2026-08-15T00:00:00.000Z';
  const toExclusiveUtc = '2026-08-16T00:00:00.000Z';
  const totals = queryMovementTotals(db, fromUtc, toExclusiveUtc);
  const currentStock = 120;

  assert.equal(totals.qtyIn, 0);
  assert.equal(totals.qtyOut, 20);

  // Opening stock = balance at the start of 2026-08-15 = currentStock minus everything from
  // 2026-08-15 onward through now (m2, m3, m4 = -20+50-10 = 20) = 120 - 20 = 100.
  const openingStock = currentStock - totals.netSincePeriodStart;
  assert.equal(openingStock, 100);
  // Sanity check: balance immediately before m2 was just m1 = 100.
  assert.equal(openingStock, 100);
});
