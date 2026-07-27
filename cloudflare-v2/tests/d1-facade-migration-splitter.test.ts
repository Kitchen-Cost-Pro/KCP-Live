import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { splitSqlStatements } from '../src/d1-facade';
import {
  YOCO_V2_ADMIN_CONTROL_CENTRE_MIGRATION,
  YOCO_V2_CONTROLLED_CUTOVER_MIGRATION,
  YOCO_V2_FOUNDATION_MIGRATION,
  YOCO_V2_LEGACY_SHUTDOWN_MIGRATION,
  YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION,
  YOCO_V2_REFUND_RECONCILIATION_MIGRATION,
  YOCO_V2_SALE_SHADOW_MIGRATION
} from '../src/modules/yoco-engine-v2/migrations';

test('splits ordinary SQL statements and ignores quoted semicolons', () => {
  const statements = splitSqlStatements(`
    CREATE TABLE example (id TEXT, note TEXT DEFAULT ';');
    INSERT INTO example (id, note) VALUES ('1', 'a;b');
  `);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE TABLE/);
  assert.match(statements[1], /^INSERT INTO/);
});

test('keeps a complete SQLite trigger body in one statement', () => {
  const statements = splitSqlStatements(`
    CREATE TABLE example (id TEXT);
    CREATE TRIGGER IF NOT EXISTS example_no_delete
    BEFORE DELETE ON example
    BEGIN
      SELECT RAISE(ABORT, 'cannot delete');
    END;
    CREATE INDEX example_id ON example(id);
  `);
  assert.equal(statements.length, 3);
  assert.match(statements[1], /^CREATE TRIGGER/);
  assert.match(statements[1], /RAISE\(ABORT/);
  assert.match(statements[1], /END;$/);
  assert.doesNotMatch(statements[2], /^END\b/);
});

test('does not mistake CASE END for the end of a trigger body', () => {
  const statements = splitSqlStatements(`
    CREATE TABLE example (id TEXT);
    CREATE TRIGGER example_after_insert
    AFTER INSERT ON example
    BEGIN
      UPDATE example
         SET id = CASE WHEN NEW.id = '' THEN 'fallback' ELSE NEW.id END;
      SELECT 1;
    END;
  `);
  assert.equal(statements.length, 2);
  assert.match(statements[1], /CASE WHEN/);
  assert.match(statements[1], /SELECT 1;/);
  assert.match(statements[1], /END;$/);
});

test('the Durable Object statement splitter applies every Yoco V2 migration including triggers', () => {
  const database = new DatabaseSync(':memory:');
  const migrations = [
    YOCO_V2_FOUNDATION_MIGRATION,
    YOCO_V2_SALE_SHADOW_MIGRATION,
    YOCO_V2_REFUND_RECONCILIATION_MIGRATION,
    YOCO_V2_CONTROLLED_CUTOVER_MIGRATION,
    YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION,
    YOCO_V2_LEGACY_SHUTDOWN_MIGRATION,
    YOCO_V2_ADMIN_CONTROL_CENTRE_MIGRATION
  ];

  let triggerCount = 0;
  for (const migration of migrations) {
    for (const statement of splitSqlStatements(migration)) {
      if (/^CREATE TRIGGER/i.test(statement.trim())) triggerCount += 1;
      assert.doesNotMatch(statement.trim(), /^END\s*;?$/i);
      database.exec(statement);
    }
  }

  assert.ok(triggerCount >= 16);
  const tables = database.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
      ('yoco_v2_raw_events', 'yoco_v2_sale_comparisons', 'yoco_v2_refund_workflows',
       'yoco_v2_reconciliation_runs', 'yoco_v2_admin_actions', 'yoco_v2_webhook_receipts')`
  ).all() as Array<{ name: string }>;
  assert.equal(tables.length, 6);
  const triggers = database.prepare(
    `SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_yoco_v2_%'`
  ).get() as { total: number };
  assert.equal(Number(triggers.total), triggerCount);
});
