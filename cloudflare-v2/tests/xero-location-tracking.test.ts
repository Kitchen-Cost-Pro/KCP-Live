import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { resolveLocationTracking, type LocationTrackingContext } from '../src/modules/xero-engine/tracking';

// resolveLocationTracking is the only half of tracking.ts testable without a live Xero API call —
// loadLocationTrackingContext just wraps fetchXeroTrackingCategories (a network call), so these
// tests build a LocationTrackingContext directly, exactly as loadLocationTrackingContext's return
// shape would, and exercise the actual matching/logging behavior downstream of it.

class SqliteStatement implements DbStatementLike {
  private values: unknown[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]): DbStatementLike {
    const statement = new SqliteStatement(this.database, this.sql);
    statement.values = values.map((value) => (value === undefined ? null : value));
    return statement;
  }
  private materialize() {
    const numberedValues: unknown[] = [];
    const numberedSql = this.sql.replace(/\?(\d+)/g, (_match, index) => {
      numberedValues.push(this.values[Number(index) - 1] ?? null);
      return '?';
    });
    return numberedValues.length ? { sql: numberedSql, values: numberedValues } : { sql: this.sql, values: this.values };
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const materialized = this.materialize();
    const row = this.database.prepare(materialized.sql).get(...materialized.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const materialized = this.materialize();
    const rows = this.database.prepare(materialized.sql).all(...materialized.values) as T[];
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
  }
  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const materialized = this.materialize();
    const result = this.database.prepare(materialized.sql).run(...materialized.values);
    return { results: [], success: true, meta: { changes: Number(result.changes), rows_written: Number(result.changes) } };
  }
  async raw<T = unknown[]>(): Promise<T[]> {
    const materialized = this.materialize();
    const rows = this.database.prepare(materialized.sql).all(...materialized.values) as Record<string, unknown>[];
    return rows.map((row) => Object.values(row) as T);
  }
}

class SqliteDb implements DbLike {
  constructor(readonly database = new DatabaseSync(':memory:')) {}
  prepare(query: string): DbStatementLike { return new SqliteStatement(this.database, query); }
  async batch<T = Record<string, unknown>>(statements: DbStatementLike[]): Promise<Array<DbResult<T>>> {
    const results: Array<DbResult<T>> = [];
    for (const statement of statements) results.push(await statement.run<T>());
    return results;
  }
}

function createEnv() {
  const DB = new SqliteDb();
  DB.database.exec(TENANT_SCHEMA_SQL);
  // integration_logs is added by a later tenant migration (16), not the baseline schema — created
  // directly here since it isn't exported as its own named migration constant to import.
  DB.database.exec(`CREATE TABLE integration_logs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'yoco',
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    correlation_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  return { DB } as any;
}

function context(optionIdByName: Record<string, string>): LocationTrackingContext {
  return {
    categoryId: 'cat_1',
    optionIdByLowerName: new Map(Object.entries(optionIdByName).map(([name, id]) => [name.toLowerCase(), id])),
    loggedMisses: new Set()
  };
}

test('no context configured (no category chosen in settings) resolves to undefined, never throws', async () => {
  const env = createEnv();
  const result = await resolveLocationTracking(env, 'ws_1', null, 'Down Bar');
  assert.equal(result, undefined);
});

test('no location name on the line resolves to undefined even with a valid context', async () => {
  const env = createEnv();
  const ctx = context({ 'Down Bar': 'opt_1' });
  const result = await resolveLocationTracking(env, 'ws_1', ctx, null);
  assert.equal(result, undefined);
});

test('an exact-name match returns the resolved TrackingCategoryID/TrackingOptionID pair', async () => {
  const env = createEnv();
  const ctx = context({ 'Down Bar': 'opt_1' });
  const result = await resolveLocationTracking(env, 'ws_1', ctx, 'Down Bar');
  assert.deepEqual(result, [{ TrackingCategoryID: 'cat_1', TrackingOptionID: 'opt_1' }]);
});

test('matching is case-insensitive', async () => {
  const env = createEnv();
  const ctx = context({ 'Down Bar': 'opt_1' });
  const result = await resolveLocationTracking(env, 'ws_1', ctx, 'down bar');
  assert.deepEqual(result, [{ TrackingCategoryID: 'cat_1', TrackingOptionID: 'opt_1' }]);
});

// Xero silently DROPS an unmatched Name/Option pair rather than rejecting the request — so an
// unresolved location must never guess at an option, only skip tracking on that line and leave a
// visible trail (a warning row in integration_logs) instead of failing silently the way Xero itself
// would.
test('no matching option: resolves to undefined and logs one warning diagnostic', async () => {
  const env = createEnv();
  const ctx = context({ 'Down Bar': 'opt_1' });
  const result = await resolveLocationTracking(env, 'ws_1', ctx, 'Unmapped Location');
  assert.equal(result, undefined);

  const logs = await env.DB.prepare(`SELECT * FROM integration_logs WHERE workspace_id = 'ws_1'`).all();
  assert.equal(logs.results.length, 1);
  assert.equal(logs.results[0].status, 'warning');
  assert.match(logs.results[0].message, /Unmapped Location/);
});

test('the same unmatched location across many lines in one sync run logs only once, not once per line', async () => {
  const env = createEnv();
  const ctx = context({ 'Down Bar': 'opt_1' });
  await resolveLocationTracking(env, 'ws_1', ctx, 'Unmapped Location');
  await resolveLocationTracking(env, 'ws_1', ctx, 'Unmapped Location');
  await resolveLocationTracking(env, 'ws_1', ctx, 'Unmapped Location');

  const logs = await env.DB.prepare(`SELECT * FROM integration_logs WHERE workspace_id = 'ws_1'`).all();
  assert.equal(logs.results.length, 1, 'loggedMisses must dedupe repeated misses within the same context/run');
});

test('two different unmatched locations in the same run each get their own single diagnostic', async () => {
  const env = createEnv();
  const ctx = context({ 'Down Bar': 'opt_1' });
  await resolveLocationTracking(env, 'ws_1', ctx, 'Unmapped A');
  await resolveLocationTracking(env, 'ws_1', ctx, 'Unmapped B');

  const logs = await env.DB.prepare(`SELECT * FROM integration_logs WHERE workspace_id = 'ws_1'`).all();
  assert.equal(logs.results.length, 2);
});
