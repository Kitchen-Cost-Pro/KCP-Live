import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { splitSqlStatements, isRetryableAddColumnError } from '../src/d1-facade';
import {
  YOCO_V2_RUNTIME_SCHEMA_REPAIR,
  YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID,
  YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR,
  YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR_ID,
} from '../src/modules/yoco-engine-v2/schema-repair';

// Uses the real production classification (d1-facade.ts) rather than a hand-rolled copy — the
// vat-snapshot repair embeds YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION, whose ADD COLUMN statements
// carry a leading explanatory comment; only the real, comment-stripping classifier recognizes
// those as safe to retry (see isRetryableAddColumnError's own tests for why that matters).
function applyScript(database: DatabaseSync, script: string): void {
  for (const statement of splitSqlStatements(script)) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    try {
      database.exec(trimmed);
    } catch (cause) {
      if (isRetryableAddColumnError(trimmed, cause)) continue;
      throw cause;
    }
  }
}

test('repairs a partially migrated Yoco tenant and is safe to run repeatedly', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE yoco_connections (
      workspace_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'disconnected',
      api_key_encrypted TEXT,
      webhook_id TEXT,
      webhook_secret TEXT
    );
  `);

  applyScript(database, YOCO_V2_RUNTIME_SCHEMA_REPAIR);
  applyScript(database, YOCO_V2_RUNTIME_SCHEMA_REPAIR);

  const columns = database.prepare(`PRAGMA table_info(yoco_connections)`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const required of [
    'webhook_url',
    'webhook_previous_secret',
    'connection_active',
    'api_key_fingerprint',
    'last_successful_order_updated_at',
    'last_successful_refund_updated_at',
    'sales_baseline_at',
    'updated_at',
  ]) {
    assert.ok(names.has(required), `missing repaired column ${required}`);
  }

  const tables = database.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name IN (
         'integration_effect_ownership',
         'yoco_v2_api_requests',
         'yoco_v2_raw_events',
         'yoco_v2_webhook_receipts',
         'integration_logs'
       )
  `).all() as Array<{ name: string }>;
  assert.equal(tables.length, 5);
});

test('the VAT-snapshot repair is small, standalone, and repairs the 2026-08-26 incident columns without re-running the big historical repair', () => {
  // Deliberately does NOT seed yoco_connections or run YOCO_V2_RUNTIME_SCHEMA_REPAIR first — this
  // repair must stand on its own against a tenant that already has an ordinary baseline schema
  // (workspace_settings, yoco_orders — from TENANT_SCHEMA_SQL) but is missing only these columns,
  // which is exactly the state a tenant whose _kcp_schema.version drifted ahead of the indexed
  // migration array would be in for a workspace that had already received the big repair earlier.
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE workspace_settings (
      workspace_id TEXT PRIMARY KEY,
      vat_rate REAL NOT NULL DEFAULT 15
    );
    CREATE TABLE yoco_orders (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      yoco_order_id TEXT NOT NULL,
      order_type TEXT NOT NULL DEFAULT 'sale'
    );
    CREATE TABLE yoco_v2_reconciliation_state (
      workspace_id TEXT NOT NULL,
      integration_id TEXT NOT NULL,
      last_hourly_run_at TEXT,
      last_daily_run_at TEXT
    );
  `);

  applyScript(database, YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR);
  applyScript(database, YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR);

  const settingsColumns = database.prepare(`PRAGMA table_info(workspace_settings)`).all() as Array<{ name: string }>;
  assert.ok(settingsColumns.some((c) => c.name === 'vat_registered'), 'missing workspace_settings.vat_registered');

  const ordersColumns = database.prepare(`PRAGMA table_info(yoco_orders)`).all() as Array<{ name: string }>;
  const orderColumnNames = new Set(ordersColumns.map((c) => c.name));
  assert.ok(orderColumnNames.has('vat_rate'), 'missing yoco_orders.vat_rate');
  assert.ok(orderColumnNames.has('vat_registered'), 'missing yoco_orders.vat_registered');

  // 2026-08-26 follow-up: without these columns, runScheduledYocoV2Reconciliation's very first
  // write (recording last_attempt_at) throws on every single tick — which is the exact write-storm
  // precondition index 33 was built to prevent (last_daily_run_at/last_hourly_run_at never advance,
  // so dailyDue/hourlyDue stay true forever and every ~15-minute cron tick retries indefinitely).
  const reconciliationColumns = database.prepare(`PRAGMA table_info(yoco_v2_reconciliation_state)`).all() as Array<{ name: string }>;
  const reconciliationColumnNames = new Set(reconciliationColumns.map((c) => c.name));
  for (const required of ['consecutive_failures', 'next_retry_at', 'last_failure_reason', 'last_attempt_at']) {
    assert.ok(reconciliationColumnNames.has(required), `missing yoco_v2_reconciliation_state.${required}`);
  }

  // Deliberately does NOT touch yoco_v2_reconciliation_findings — the dedupe UPDATE queries with
  // correlated subqueries are excluded from this emergency pass (see schema-repair.ts's comment).
  assert.match(YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR_ID, /^yoco-v2-vat-snapshot-schema-repair-v\d+$/);
  assert.doesNotMatch(YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR, /yoco_v2_reconciliation_findings/);
});

test('Yoco connection implementation lives in the V2 engine module', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const sourceRoot = path.resolve(import.meta.dirname, '../src');
  const v2Service = path.join(sourceRoot, 'modules/yoco-engine-v2/integration-service.ts');
  const removedLegacyService = path.join(sourceRoot, 'legacy/yoco-service.ts');
  await fs.access(v2Service);
  await assert.rejects(fs.access(removedLegacyService));
});

test('WorkspaceDO runs the V2 schema repair once per tenant and retries failed repairs', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const workspaceSource = await fs.readFile(path.resolve(import.meta.dirname, '../src/workspace-do.ts'), 'utf8');
  // The exact id is expected to change over time (see schema-repair.ts's history of bumps — a
  // fixed id only ever runs once per tenant, so it must change whenever content is appended, or
  // tenants that already ran an earlier version silently never receive the new content). Assert
  // the shape/convention rather than freezing a specific version, which is what made this
  // assertion itself go stale the last two times the id was bumped for a real production fix.
  assert.match(YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID, /^yoco-v2-connect-schema-v\d+$/);
  assert.match(workspaceSource, /CREATE TABLE IF NOT EXISTS _kcp_runtime_repairs/);
  assert.match(workspaceSource, /if \(!repairApplied\)/);
  assert.match(workspaceSource, /this\.db\.execScript\(YOCO_V2_RUNTIME_SCHEMA_REPAIR\)/);
  assert.match(workspaceSource, /INSERT OR REPLACE INTO _kcp_runtime_repairs/);
  // The vat-snapshot repair is wired the same way but as an independent block/id, precisely so it
  // does not force a re-run of the big repair above (see its own schema-repair.ts comment for why
  // that distinction matters — it's what a real production CPU-limit incident was traced to).
  assert.match(workspaceSource, /if \(!vatSnapshotRepairApplied\)/);
  assert.match(workspaceSource, /this\.db\.execScript\(YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR\)/);
});
