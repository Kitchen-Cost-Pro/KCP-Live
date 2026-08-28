/**
 * ONE-OFF SIMULATION (not part of the test suite): proves the repair mechanism actually reaches a
 * tenant whose _kcp_schema.version has drifted ahead of TENANT_MIGRATIONS.length — the exact real
 * production scenario (WS-lellos-trattoria-bee300, version 44 vs a shorter migrations array) that
 * would otherwise silently skip migrations 40, 41, and 42 forever.
 *
 * Run: node --import tsx --import ./tests/_cf-stub.mjs tests/drifted-tenant-repair-simulation.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { splitSqlStatements, isRetryableAddColumnError } from '../src/d1-facade';
import { TENANT_MIGRATIONS } from '../src/tenant-migrations';
import {
  RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR,
  ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR,
} from '../src/modules/yoco-engine-v2/schema-repair';

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

function indexExists(db: DatabaseSync, name: string): boolean {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name) as unknown) !== undefined;
}
function tableExists(db: DatabaseSync, name: string): boolean {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as unknown) !== undefined;
}

console.log('=== Scenario: a tenant stuck ahead of TENANT_MIGRATIONS.length (the real WS-lellos-trattoria-bee300 shape) ===\n');

// Simulate a tenant that genuinely progressed through most of real history (so everything the
// repairs' own SQL depends on — e.g. yoco_v2_domain_events — actually exists), but never received
// the LAST 3 entries (40, 41, 42) because its recorded version got stuck ahead of the array
// length — the real incident's actual shape (a tenant with real schema history, just an
// off-by-however-much counter from reused migration slots during earlier development), not a
// tenant missing everything.
const drifted = new DatabaseSync(':memory:');
for (const migration of TENANT_MIGRATIONS.slice(0, -3)) applyMigration(drifted, migration);
drifted.exec(`CREATE TABLE IF NOT EXISTS _kcp_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)`);
drifted.exec(`INSERT INTO _kcp_schema (id, version) VALUES (1, ${TENANT_MIGRATIONS.length + 4})`); // stuck ahead of the array
drifted.exec(`CREATE TABLE IF NOT EXISTS _kcp_runtime_repairs (repair_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

const fakeVersion = TENANT_MIGRATIONS.length + 4;
console.log(`_kcp_schema.version = ${fakeVersion}, TENANT_MIGRATIONS.length = ${TENANT_MIGRATIONS.length}`);
console.log(`Normal indexed loop condition (applied < TENANT_MIGRATIONS.length): ${fakeVersion < TENANT_MIGRATIONS.length} <- if false, migrations 40-42 NEVER apply via the normal path\n`);

console.log('Before repairs:');
console.log(`  idx_yoco_v2_domain_events_workspace_status exists: ${indexExists(drifted, 'idx_yoco_v2_domain_events_workspace_status')}`);
console.log(`  stock_item_latest_purchase table exists: ${tableExists(drifted, 'stock_item_latest_purchase')}`);
console.log(`  idx_adjustment_lines_adjustment exists: ${indexExists(drifted, 'idx_adjustment_lines_adjustment')}`);
console.log(`  idx_adjustments_workspace_type exists: ${indexExists(drifted, 'idx_adjustments_workspace_type')}`);

// This is exactly what workspace-do.ts's ensureMigrated() runs for these two repairs, independent
// of the (stuck) _kcp_schema.version counter.
console.log('\nApplying RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR and ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR (the repair path, not the migration counter)...\n');
applyMigration(drifted, RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR);
applyMigration(drifted, ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR);

console.log('After repairs:');
const afterYoco = indexExists(drifted, 'idx_yoco_v2_domain_events_workspace_status');
const afterPurchase = tableExists(drifted, 'stock_item_latest_purchase');
const afterAdjLines = indexExists(drifted, 'idx_adjustment_lines_adjustment');
const afterAdjType = indexExists(drifted, 'idx_adjustments_workspace_type');
console.log(`  idx_yoco_v2_domain_events_workspace_status exists: ${afterYoco}`);
console.log(`  stock_item_latest_purchase table exists: ${afterPurchase}`);
console.log(`  idx_adjustment_lines_adjustment exists: ${afterAdjLines}`);
console.log(`  idx_adjustments_workspace_type exists: ${afterAdjType}`);

const allFixed = afterYoco && afterPurchase && afterAdjLines && afterAdjType;
console.log(`\nRESULT: ${allFixed ? 'PASS — the drifted tenant now has all three fixes despite never running the normal migration loop.' : 'FAIL'}`);

// Re-running the repair scripts again (idempotency check — this runs on EVERY request until the
// repair marker is recorded, so it must never error on a second pass).
console.log('\nRe-applying both repairs a second time (idempotency check)...');
try {
  applyMigration(drifted, RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR);
  applyMigration(drifted, ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR);
  console.log('RESULT: PASS — re-running both repairs did not throw.');
} catch (cause) {
  console.log(`RESULT: FAIL — re-running threw: ${cause instanceof Error ? cause.message : String(cause)}`);
}

if (!allFixed) process.exit(1);
