import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION } from '../src/modules/yoco-engine-v2/migrations';

/**
 * Migration 33 collapses historical duplicate reconciliation findings so a UNIQUE index can be
 * created on the finding identity. That DELETE is destructive, so it is covered here directly:
 * the surviving row must carry the whole group's history, and must never reopen a finding that had
 * already been repaired.
 */
function seed(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
CREATE TABLE yoco_v2_reconciliation_state (
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  schedule_mode TEXT NOT NULL DEFAULT 'HOURLY_AND_DAILY',
  checkpoint_at TEXT,
  overlap_minutes INTEGER NOT NULL DEFAULT 120,
  last_hourly_run_at TEXT,
  last_daily_run_at TEXT,
  pause_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, integration_id)
);
CREATE TABLE yoco_v2_reconciliation_findings (
  id TEXT PRIMARY KEY,
  reconciliation_run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  source_entity_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  finding_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  details_json TEXT NOT NULL DEFAULT '{}',
  repair_action TEXT,
  repaired_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (reconciliation_run_id, finding_type, source_entity_type, source_entity_id)
);
  `);
  return database;
}

function inserter(database: DatabaseSync) {
  const statement = database.prepare(
    `INSERT INTO yoco_v2_reconciliation_findings
      (id, reconciliation_run_id, workspace_id, integration_id, source_entity_type, source_entity_id,
       finding_type, severity, status, details_json, repair_action, repaired_at, created_at)
     VALUES (?, ?, 'ws_1', 'int_1', 'ORDER', ?, 'UNRESOLVED_MAPPING', 'MEDIUM', ?, '{}', NULL, ?, ?)`,
  );
  return (id: string, runId: string, entityId: string, status: string, repairedAt: string | null, createdAt: string) =>
    statement.run(id, runId, entityId, status, repairedAt, createdAt);
}

test('migration collapses per-run duplicate findings onto one row without losing history', () => {
  const database = seed();
  const insert = inserter(database);
  // The write storm: one unresolved order re-reported by four consecutive 15-minute runs, the third
  // of which repaired it.
  insert('f1', 'run_1', 'order_1', 'OPEN', null, '2026-07-15T02:00:00.000Z');
  insert('f2', 'run_2', 'order_1', 'OPEN', null, '2026-07-15T02:15:00.000Z');
  insert('f3', 'run_3', 'order_1', 'REPAIRED', '2026-07-15T02:30:00.000Z', '2026-07-15T02:30:00.000Z');
  insert('f4', 'run_4', 'order_1', 'OPEN', null, '2026-07-15T02:45:00.000Z');
  // A genuinely different finding must be left alone.
  insert('g1', 'run_1', 'order_2', 'OPEN', null, '2026-07-15T02:00:00.000Z');

  database.exec(YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION);

  const rows = database
    .prepare(`SELECT * FROM yoco_v2_reconciliation_findings ORDER BY source_entity_id`)
    .all() as any[];
  assert.equal(rows.length, 2);

  const collapsed = rows.find((row) => row.source_entity_id === 'order_1');
  assert.equal(collapsed.id, 'f1', 'the earliest row survives so created_at still means "first detected"');
  assert.equal(collapsed.created_at, '2026-07-15T02:00:00.000Z');
  assert.equal(Number(collapsed.occurrence_count), 4, 'the sighting count must be carried onto the survivor');
  assert.equal(collapsed.last_seen_at, '2026-07-15T02:45:00.000Z');
  assert.equal(collapsed.status, 'REPAIRED', 'dedupe must never reopen an already-repaired finding');
  assert.equal(collapsed.repaired_at, '2026-07-15T02:30:00.000Z');

  const untouched = rows.find((row) => row.source_entity_id === 'order_2');
  assert.equal(Number(untouched.occurrence_count), 1);
  assert.equal(untouched.status, 'OPEN');
});

test('migration makes a cross-run duplicate finding impossible afterwards', () => {
  const database = seed();
  const insert = inserter(database);
  insert('f1', 'run_1', 'order_1', 'OPEN', null, '2026-07-15T02:00:00.000Z');
  database.exec(YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION);
  // Before the migration this succeeded on every run, which is what grew the table without bound.
  assert.throws(
    () => insert('f2', 'run_2', 'order_1', 'OPEN', null, '2026-07-15T02:15:00.000Z'),
    /UNIQUE/,
  );
});

test('migration adds backoff bookkeeping columns with safe defaults', () => {
  const database = seed();
  database.exec(YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION);
  database
    .prepare(`INSERT INTO yoco_v2_reconciliation_state (workspace_id, integration_id, updated_at) VALUES ('ws_1','int_1','2026-07-15T02:00:00.000Z')`)
    .run();
  const state = database
    .prepare(`SELECT consecutive_failures, next_retry_at, last_failure_reason, last_attempt_at FROM yoco_v2_reconciliation_state`)
    .get() as any;
  // A fresh workspace must start with no backoff in effect, otherwise reconciliation would be
  // skipped forever rather than merely rate-limited after failures.
  assert.equal(Number(state.consecutive_failures), 0);
  assert.equal(state.next_retry_at, null);
  assert.equal(state.last_failure_reason, null);
  assert.equal(state.last_attempt_at, null);
});
