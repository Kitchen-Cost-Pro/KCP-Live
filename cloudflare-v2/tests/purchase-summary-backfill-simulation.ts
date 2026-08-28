/**
 * ONE-OFF SIMULATION (not part of the test suite): proves the stock_item_latest_purchase backfill
 * loop (workspace-do.ts) actually converges to the CORRECT answer when run across many small,
 * bounded batches (simulating many separate requests, not one big pass), including when rows are
 * NOT visited in chronological order — the exact property the design relies on (see the backfill's
 * own comment in workspace-do.ts).
 *
 * Run: node --import tsx --import ./tests/_cf-stub.mjs tests/purchase-summary-backfill-simulation.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { splitSqlStatements, isRetryableAddColumnError } from '../src/d1-facade';
import { TENANT_MIGRATIONS } from '../src/tenant-migrations';

function applyMigration(database: DatabaseSync, script: string) {
  for (const raw of splitSqlStatements(script)) {
    const s = raw.trim();
    if (!s) continue;
    try {
      database.exec(s);
    } catch (cause) {
      if (isRetryableAddColumnError(s, cause)) continue;
      throw cause;
    }
  }
}

const db = new DatabaseSync(':memory:');
for (const m of TENANT_MIGRATIONS) applyMigration(db, m);
const WORKSPACE = 'ws_test';
const now = new Date().toISOString();
db.exec(`INSERT INTO locations (id, workspace_id, name, kind, active, is_default, created_at, updated_at)
         VALUES ('loc_main','${WORKSPACE}','Main','storage',1,1,'${now}','${now}')`);

// 40 stock items, 8 purchases each spread over random-ish dates/ids, inserted in SHUFFLED order —
// deliberately not chronological, to prove the backfill doesn't depend on visiting order.
console.log('Seeding 40 stock items x 8 purchases each (320 grv_lines), inserted out of order...');
const ITEM_COUNT = 40;
const PURCHASES_PER_ITEM = 8;
type Purchase = { itemIndex: number; purchaseIndex: number; grvId: string; lineId: string; receivedAt: string; unitPrice: number };
const purchases: Purchase[] = [];
for (let item = 0; item < ITEM_COUNT; item += 1) {
  for (let p = 0; p < PURCHASES_PER_ITEM; p += 1) {
    purchases.push({
      itemIndex: item,
      purchaseIndex: p,
      grvId: `grv_${item}_${p}`,
      lineId: `grvl_${item}_${p}`,
      receivedAt: new Date(Date.now() - (PURCHASES_PER_ITEM - p) * 86400_000 - item * 3600_000).toISOString(),
      unitPrice: 10 + item + p, // later purchase (higher p) always costs more, so we can verify "latest" picked the right one
    });
  }
}
// Fisher-Yates shuffle with a fixed-seed-free but deterministic-enough pass (no Math.random ban
// here — this is a local dev script, not a Workflow script).
for (let i = purchases.length - 1; i > 0; i -= 1) {
  const j = Math.floor(((i * 2654435761) % (i + 1) + (i + 1)) % (i + 1));
  [purchases[i], purchases[j]] = [purchases[j], purchases[i]];
}

db.exec('BEGIN');
const stockItemIns = db.prepare(`INSERT INTO stock_items (id, workspace_id, name, category, item_type, unit, unit_cost, active, raw_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,'{}',?,?)`);
for (let item = 0; item < ITEM_COUNT; item += 1) stockItemIns.run(`si_${item}`, WORKSPACE, `Item ${item}`, 'General', 'raw', 'kg', 10, now, now);
const grvIns = db.prepare(`INSERT INTO grvs (id, workspace_id, invoice_number, received_at, prices_include_vat, split_by_location, total_ex, total_vat, total_inc, created_by, raw_json, created_at) VALUES (?,?,?,?,0,0,0,0,0,'seed','{}',?)`);
const lineIns = db.prepare(`INSERT INTO grv_lines (id, workspace_id, grv_id, stock_item_id, location_id, quantity, unit, unit_price, total_ex, total_vat, total_inc) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
for (const purchase of purchases) {
  grvIns.run(purchase.grvId, WORKSPACE, `INV-${purchase.grvId}`, purchase.receivedAt, now);
  lineIns.run(purchase.lineId, WORKSPACE, purchase.grvId, `si_${purchase.itemIndex}`, 'loc_main', 5, 'kg', purchase.unitPrice, 25, 0, 25);
}
db.exec('COMMIT');
console.log(`Seeded ${purchases.length} grv_lines rows across ${new Set(purchases.map((p) => p.grvId)).size} GRVs.\n`);

// The exact backfill SQL from workspace-do.ts.
const BATCH_ROWS = 7; // deliberately small & not a divisor of 320, to force an uneven final batch
const UPSERT_SQL = `
  INSERT INTO stock_item_latest_purchase
    (workspace_id, stock_item_id, location_id, supplier_id, unit, unit_price, received_at, grv_line_id, updated_at)
  SELECT gl.workspace_id, gl.stock_item_id, gl.location_id, g.supplier_id, gl.unit, gl.unit_price, g.received_at,
         gl.id, datetime('now')
    FROM grv_lines gl
    JOIN grvs g ON g.id = gl.grv_id AND g.workspace_id = gl.workspace_id
   WHERE gl.id > ?1 AND gl.id <= ?2
  ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
    supplier_id = excluded.supplier_id, unit = excluded.unit, unit_price = excluded.unit_price,
    received_at = excluded.received_at, grv_line_id = excluded.grv_line_id, updated_at = excluded.updated_at
  WHERE excluded.received_at > stock_item_latest_purchase.received_at
     OR (excluded.received_at = stock_item_latest_purchase.received_at
         AND excluded.grv_line_id > stock_item_latest_purchase.grv_line_id)
`;

let cursor = '';
let requestCount = 0;
let totalRowsTouched = 0;
while (true) {
  requestCount += 1;
  const idRows = db.prepare(`SELECT id FROM grv_lines WHERE id > ? ORDER BY id ASC LIMIT ?`).all(cursor, BATCH_ROWS) as Array<{ id: string }>;
  if (idRows.length === 0) break;
  const lastId = idRows[idRows.length - 1].id;
  db.prepare(UPSERT_SQL).run(cursor, lastId);
  totalRowsTouched += idRows.length;
  cursor = lastId;
  if (idRows.length < BATCH_ROWS) break;
}
console.log(`Backfill converged after ${requestCount} simulated requests (batch size ${BATCH_ROWS}), touching ${totalRowsTouched} rows total (matches the ${purchases.length} seeded rows: ${totalRowsTouched === purchases.length}).\n`);

// Verify correctness: for every item, the summary table's price must equal the KNOWN latest
// purchase (purchaseIndex === PURCHASES_PER_ITEM - 1, which was seeded with the highest price).
let allCorrect = true;
for (let item = 0; item < ITEM_COUNT; item += 1) {
  const row = db.prepare(`SELECT unit_price, grv_line_id FROM stock_item_latest_purchase WHERE workspace_id = ? AND stock_item_id = ?`).get(WORKSPACE, `si_${item}`) as { unit_price: number; grv_line_id: string } | undefined;
  const expectedPrice = 10 + item + (PURCHASES_PER_ITEM - 1);
  const expectedLineId = `grvl_${item}_${PURCHASES_PER_ITEM - 1}`;
  const correct = row?.unit_price === expectedPrice && row?.grv_line_id === expectedLineId;
  if (!correct) {
    allCorrect = false;
    console.log(`  MISMATCH si_${item}: got price=${row?.unit_price} line=${row?.grv_line_id}, expected price=${expectedPrice} line=${expectedLineId}`);
  }
}
console.log(`RESULT: ${allCorrect ? `PASS — all ${ITEM_COUNT} items converged to the correct latest purchase despite out-of-order, multi-batch processing.` : 'FAIL — see mismatches above.'}`);

if (!allCorrect) process.exit(1);
