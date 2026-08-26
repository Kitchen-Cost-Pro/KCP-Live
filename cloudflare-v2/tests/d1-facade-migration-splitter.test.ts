import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { splitSqlStatements, isRetryableAddColumnError } from '../src/d1-facade';
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

test('isRetryableAddColumnError still recognizes a retried ADD COLUMN when the statement carries a leading explanatory comment', () => {
  // splitSqlStatements() keeps a leading `--` comment glued to the statement that follows it (no
  // statement-terminating semicolon inside a comment), so a documented migration written as
  // `-- why this column exists...\nALTER TABLE t ADD COLUMN c ...;` produces one statement whose
  // trimmed text does not literally start with ALTER. A retry of that exact migration (the
  // scenario this whole mechanism exists for — see execScript's comment) must still be tolerated.
  const commented = `-- Stop the write storm.\n--\n-- Root cause: see migration history.\nALTER TABLE t ADD COLUMN c INTEGER NOT NULL DEFAULT 0;`;
  const duplicateColumnError = new Error('duplicate column name: c');
  assert.equal(isRetryableAddColumnError(commented.trim(), duplicateColumnError), true);

  // A block-comment header must be tolerated the same way.
  const blockCommented = `/* Stop the write storm. */\nALTER TABLE t ADD COLUMN c INTEGER NOT NULL DEFAULT 0;`;
  assert.equal(isRetryableAddColumnError(blockCommented.trim(), duplicateColumnError), true);

  // An uncommented ADD COLUMN keeps working exactly as before.
  assert.equal(isRetryableAddColumnError('ALTER TABLE t ADD COLUMN c INTEGER;', duplicateColumnError), true);

  // A genuine, unrelated SQL error is never swallowed, comment or no comment.
  const syntaxError = new Error('near "COLUM": syntax error');
  assert.equal(isRetryableAddColumnError(commented.trim(), syntaxError), false);

  // A non-ADD-COLUMN statement is never swallowed even if the error text happens to match.
  assert.equal(isRetryableAddColumnError('-- some note\nCREATE TABLE t (c INTEGER);', duplicateColumnError), false);
});
