import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { splitSqlStatements } from '../src/d1-facade';
import {
  YOCO_V2_RUNTIME_SCHEMA_REPAIR,
  YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID,
} from '../src/modules/yoco-engine-v2/schema-repair';

function applyRepair(database: DatabaseSync): void {
  for (const statement of splitSqlStatements(YOCO_V2_RUNTIME_SCHEMA_REPAIR)) {
    try {
      database.exec(statement);
    } catch (cause) {
      const message = String((cause as Error)?.message || cause || '');
      const isAddColumn = /^ALTER\s+TABLE\s+[^\s]+\s+ADD\s+COLUMN\s+/i.test(statement.trim());
      if (isAddColumn && /duplicate column name|already exists/i.test(message)) continue;
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

  applyRepair(database);
  applyRepair(database);

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
  assert.equal(YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID, 'yoco-v2-connect-schema-v1');
  assert.match(workspaceSource, /CREATE TABLE IF NOT EXISTS _kcp_runtime_repairs/);
  assert.match(workspaceSource, /if \(!repairApplied\)/);
  assert.match(workspaceSource, /this\.db\.execScript\(YOCO_V2_RUNTIME_SCHEMA_REPAIR\)/);
  assert.match(workspaceSource, /INSERT OR REPLACE INTO _kcp_runtime_repairs/);
});
