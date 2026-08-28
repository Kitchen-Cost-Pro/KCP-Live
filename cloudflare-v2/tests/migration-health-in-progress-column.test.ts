import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { isRetryableAddColumnError } from '../src/d1-facade';

// Exercises the exact SQL sequence workspace-do.ts's migrate() runs to introduce
// in_progress_since on both a pre-existing tenant (old table shape) and a fresh one, since
// migrate() itself can't be unit-tested directly (it imports 'cloudflare:workers').
function ensureMigrationHealthTable(database: DatabaseSync): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS _kcp_migration_health (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       consecutive_failures INTEGER NOT NULL DEFAULT 0,
       next_retry_at TEXT,
       in_progress_since TEXT
     )`
  );
  try {
    database.exec(`ALTER TABLE _kcp_migration_health ADD COLUMN in_progress_since TEXT`);
  } catch (cause) {
    if (!isRetryableAddColumnError('ALTER TABLE _kcp_migration_health ADD COLUMN in_progress_since TEXT', cause)) throw cause;
  }
  database.exec(
    `INSERT OR IGNORE INTO _kcp_migration_health (id, consecutive_failures, next_retry_at, in_progress_since) VALUES (1, 0, NULL, NULL)`
  );
}

test('a pre-existing tenant whose _kcp_migration_health table predates in_progress_since gets the column added, and the id=1 row seeded', () => {
  const database = new DatabaseSync(':memory:');
  // Old shape: no in_progress_since, and — critically — no id=1 row yet either (a tenant that has
  // never failed a migration before today never had a reason to write one).
  database.exec(
    `CREATE TABLE _kcp_migration_health (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       consecutive_failures INTEGER NOT NULL DEFAULT 0,
       next_retry_at TEXT
     )`
  );

  ensureMigrationHealthTable(database);

  const columns = database.prepare(`PRAGMA table_info(_kcp_migration_health)`).all() as Array<{ name: string }>;
  assert.ok(columns.some((c) => c.name === 'in_progress_since'), 'in_progress_since column was not added');

  const row = database.prepare(`SELECT * FROM _kcp_migration_health WHERE id = 1`).get() as
    | { consecutive_failures: number; next_retry_at: string | null; in_progress_since: string | null }
    | undefined;
  assert.ok(row, 'id=1 row was not seeded — markInProgress()\'s UPDATE would silently no-op on this tenant');
  assert.equal(row!.in_progress_since, null);

  // The actual guard this whole fix is for: writing and reading back the marker must work.
  const startedAt = new Date().toISOString();
  database.prepare(`UPDATE _kcp_migration_health SET in_progress_since = ?1 WHERE id = 1`).run(startedAt);
  const marked = database.prepare(`SELECT in_progress_since FROM _kcp_migration_health WHERE id = 1`).get() as { in_progress_since: string };
  assert.equal(marked.in_progress_since, startedAt);
});

test('running the same setup twice (retried migration attempt on the same tenant) is safe', () => {
  const database = new DatabaseSync(':memory:');
  ensureMigrationHealthTable(database);
  ensureMigrationHealthTable(database);

  const row = database.prepare(`SELECT * FROM _kcp_migration_health WHERE id = 1`).get() as { consecutive_failures: number };
  assert.equal(row.consecutive_failures, 0);
});

test('a brand-new tenant (no table at all yet) ends up with the same correct shape', () => {
  const database = new DatabaseSync(':memory:');
  ensureMigrationHealthTable(database);

  const columns = database.prepare(`PRAGMA table_info(_kcp_migration_health)`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));
  for (const required of ['id', 'consecutive_failures', 'next_retry_at', 'in_progress_since']) {
    assert.ok(names.has(required), `missing column ${required}`);
  }
  assert.ok(database.prepare(`SELECT 1 FROM _kcp_migration_health WHERE id = 1`).get(), 'id=1 row missing');
});
