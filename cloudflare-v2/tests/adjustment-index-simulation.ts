/**
 * ONE-OFF SIMULATION (not part of the test suite): quantifies the adjustment_lines/transfers/
 * stocktake full-scan finding from read-cost-audit.ts at a REALISTIC one-year data volume, and
 * confirms a proposed index actually flips the plan (same "don't assume, verify" lesson as the
 * reconciliation fix, where adding an index alone did NOT change the plan for a different query
 * shape). Run: node --import tsx --import ./tests/_cf-stub.mjs tests/adjustment-index-simulation.ts
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
db.exec(`INSERT INTO stock_items (id, workspace_id, name, category, item_type, unit, unit_cost, active, raw_json, created_at, updated_at)
         VALUES ('si_0','${WORKSPACE}','Item 0','General','raw','kg',10,1,'{}','${now}','${now}')`);

// One year of daily wastage adjustments, ~5 lines each — realistic for an active kitchen, not a
// stress test. 365 days x 5 lines = 1,825 adjustment_lines rows.
console.log('Seeding ~1 year of adjustments (365 adjustments x 5 lines = 1,825 lines)...');
db.exec('BEGIN');
const adjIns = db.prepare(`INSERT INTO adjustments (id, workspace_id, adjustment_type, occurred_at, created_at) VALUES (?,?,?,?,?)`);
const lineIns = db.prepare(`INSERT INTO adjustment_lines (id, workspace_id, adjustment_id, stock_item_id, location_id, quantity_delta, unit_cost) VALUES (?,?,?,?,?,?,?)`);
for (let d = 0; d < 365; d += 1) {
  const aid = `adj_${d}`;
  const occurredAt = new Date(Date.now() - d * 86400_000).toISOString();
  adjIns.run(aid, WORKSPACE, 'wastage', occurredAt, occurredAt);
  for (let l = 0; l < 5; l += 1) {
    lineIns.run(`adjl_${d}_${l}`, WORKSPACE, aid, 'si_0', 'loc_main', -1, 10);
  }
}
// Also seed a year of transfers and stocktake sessions, same realistic daily-ish cadence.
const transferIns = db.prepare(`INSERT INTO transfers (id, workspace_id, status, from_location_id, to_location_id, requested_at) VALUES (?,?,?,?,?,?)`);
for (let d = 0; d < 200; d += 1) transferIns.run(`tr_${d}`, WORKSPACE, 'posted', 'loc_main', 'loc_main', new Date(Date.now() - d * 86400_000).toISOString());
const stIns = db.prepare(`INSERT INTO stocktake_sessions (id, workspace_id, status, created_at, updated_at) VALUES (?,?,?,?,?)`);
for (let d = 0; d < 100; d += 1) stIns.run(`stt_${d}`, WORKSPACE, 'draft', now, now);
db.exec('COMMIT');

const DASHBOARD_ADJUSTMENT_QUERY = `
  SELECT COALESCE(SUM(abs(al.quantity_delta * CASE WHEN al.unit_cost IS NOT NULL THEN al.unit_cost ELSE 10 END)),0) AS wastage_value
    FROM adjustment_lines al
    JOIN adjustments a ON a.id = al.adjustment_id
   WHERE a.workspace_id = ? AND a.adjustment_type = 'wastage'`;

const TRANSFER_COUNT_QUERY = `SELECT COUNT(*) AS count FROM transfers WHERE transfer_type <> 'internal' AND to_workspace_id = ? AND lower(status) IN ('pending_receipt', 'pending')`;
const STOCKTAKE_COUNT_QUERY = `SELECT COUNT(*) AS count FROM stocktake_sessions WHERE workspace_id = ? AND lower(status) NOT IN ('posted', 'complete', 'completed', 'closed', 'cancelled', 'canceled', 'deleted', 'archived')`;

function showPlan(label: string, sql: string, params: unknown[]) {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as any[])) as Array<{ detail?: string }>;
  console.log(`  ${label}: ${rows.map((r) => r.detail).join(' | ')}`);
}

console.log('\n=== BEFORE any new index ===');
showPlan('adjustment wastage total', DASHBOARD_ADJUSTMENT_QUERY, [WORKSPACE]);
showPlan('transfer pending count', TRANSFER_COUNT_QUERY, [WORKSPACE]);
showPlan('stocktake in-progress count', STOCKTAKE_COUNT_QUERY, [WORKSPACE]);

console.log('\nAdding proposed indexes...');
db.exec(`CREATE INDEX idx_adjustment_lines_adjustment ON adjustment_lines(adjustment_id);`);
db.exec(`CREATE INDEX idx_adjustments_workspace_type ON adjustments(workspace_id, adjustment_type, occurred_at);`);
db.exec(`CREATE INDEX idx_transfers_workspace_type_status ON transfers(workspace_id, transfer_type, status, to_workspace_id);`);
db.exec(`CREATE INDEX idx_stocktake_sessions_workspace_status ON stocktake_sessions(workspace_id, status);`);

console.log('\n=== AFTER indexes ===');
showPlan('adjustment wastage total', DASHBOARD_ADJUSTMENT_QUERY, [WORKSPACE]);
showPlan('transfer pending count', TRANSFER_COUNT_QUERY, [WORKSPACE]);
showPlan('stocktake in-progress count', STOCKTAKE_COUNT_QUERY, [WORKSPACE]);

console.log('\nDone.\n');
