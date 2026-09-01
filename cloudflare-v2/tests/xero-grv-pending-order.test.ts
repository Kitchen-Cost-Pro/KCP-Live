import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { XERO_V2_FOUNDATION_MIGRATION, XERO_V2_GRV_PUSH_MIGRATION } from '../src/modules/xero-engine/migrations';
import { GRV_TRANSPORT_EX_MIGRATION, GRV_DISCOUNT_EX_MIGRATION } from '../src/tenant-migrations';
import { loadPendingGrvs } from '../src/modules/xero-engine/grv-sync';

// Regression: "Sync GRVs now" (and the automatic daily job, which shares this same scan) used to
// order pending GRVs oldest-first with a capped LIMIT. A backlog of older never-pushed GRVs (e.g.
// everything captured before Xero sync was turned on) permanently filled that cap, so brand-new
// GRVs captured "today" never got reached — they always sorted to the back of an ever-growing
// queue. Newest-first guarantees today's GRVs are never starved by a stale backlog.

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
  DB.database.exec(XERO_V2_FOUNDATION_MIGRATION);
  DB.database.exec(XERO_V2_GRV_PUSH_MIGRATION);
  DB.database.exec(GRV_TRANSPORT_EX_MIGRATION);
  DB.database.exec(GRV_DISCOUNT_EX_MIGRATION);
  return { DB } as any;
}

function insertGrv(env: any, id: string, receivedAt: string) {
  env.DB.database.prepare(
    `INSERT INTO grvs (id, workspace_id, invoice_number, received_at, total_ex, total_vat, total_inc, raw_json, created_at)
     VALUES (?1, 'ws_1', ?1, ?2, 100, 15, 115, '{}', ?2)`
  ).run(id, receivedAt);
}

test('a backlog of old GRVs does not starve a brand-new one out of the pending scan', async () => {
  const env = createEnv();
  // 5 old, backlogged GRVs, then 1 brand-new one captured "today".
  insertGrv(env, 'grv_old_1', '2026-01-01T00:00:00.000Z');
  insertGrv(env, 'grv_old_2', '2026-01-02T00:00:00.000Z');
  insertGrv(env, 'grv_old_3', '2026-01-03T00:00:00.000Z');
  insertGrv(env, 'grv_old_4', '2026-01-04T00:00:00.000Z');
  insertGrv(env, 'grv_old_5', '2026-01-05T00:00:00.000Z');
  insertGrv(env, 'grv_today', '2026-08-31T00:00:00.000Z');

  // A tiny limit simulates "the backlog is bigger than the cap" without needing 500+ inserts.
  const pending = await loadPendingGrvs(env, 'ws_1', 3);

  assert.ok(
    pending.some((grv) => grv.id === 'grv_today'),
    "today's GRV must be included even when a backlog exceeds the scan limit"
  );
});

test('pending GRVs are ordered newest-first', async () => {
  const env = createEnv();
  insertGrv(env, 'grv_a', '2026-08-01T00:00:00.000Z');
  insertGrv(env, 'grv_b', '2026-08-15T00:00:00.000Z');
  insertGrv(env, 'grv_c', '2026-08-31T00:00:00.000Z');

  const pending = await loadPendingGrvs(env, 'ws_1', 10);
  assert.deepEqual(pending.map((grv) => grv.id), ['grv_c', 'grv_b', 'grv_a']);
});

test('a GRV that already applied is excluded, even if it would otherwise be the newest', async () => {
  const env = createEnv();
  insertGrv(env, 'grv_old', '2026-08-01T00:00:00.000Z');
  insertGrv(env, 'grv_new_but_applied', '2026-08-31T00:00:00.000Z');
  env.DB.database.prepare(
    `INSERT INTO xero_v2_effect_outbox (id, workspace_id, effect_type, effect_key, status, attempt_count, created_at, updated_at)
     VALUES ('outbox_1', 'ws_1', 'GRV_PUSH', 'grv:ws_1:grv_new_but_applied', 'APPLIED', 1, '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')`
  ).run();

  const pending = await loadPendingGrvs(env, 'ws_1', 10);
  assert.deepEqual(pending.map((grv) => grv.id), ['grv_old']);
});
