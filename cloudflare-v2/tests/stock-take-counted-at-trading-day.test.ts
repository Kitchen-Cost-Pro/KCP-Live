import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { resolveStockTakeCountedAt } from '../src/legacy/stock-take-counted-at';
// @ts-ignore Shared timezone helpers used by the reporting client and Worker.
import { localDateRangeToUtcBounds } from '../../src/modules/reporting/engine/timezone.js';

// Regression: a stock take counted on a given date used to be stored as raw UTC midnight of that
// date (`new Date("2026-08-31T00:00:00.000Z")`), ignoring the workspace's actual timezone and its
// configured trading-day-start hour (Settings > trading day — real for late-trading venues like
// bars/clubs). Stock Take Audit's "Today"/"Yesterday" filters compute their query bounds FROM that
// timezone + trading-day-start (see getStockTakeAuditReport/addZonedDateRange), so a naive
// UTC-midnight timestamp could land on the wrong side of the boundary and make a stock take counted
// "today" invisible to the "Today" (and sometimes "Yesterday") filter.

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

function createEnv(tradingDayStartHour: number) {
  const DB = new SqliteDb();
  DB.database.exec(TENANT_SCHEMA_SQL);
  DB.database.exec(`
    CREATE TABLE workspaces (id TEXT, timezone TEXT);
    INSERT INTO workspaces (id, timezone) VALUES ('ws_1', 'Africa/Johannesburg');
  `);
  DB.database.prepare(
    `INSERT INTO workspace_settings (workspace_id, raw_json) VALUES ('ws_1', ?1)`,
  ).run(JSON.stringify({ tradingDayStartHour }));
  return { DB, CENTRAL_DB: DB } as any;
}

for (const tradingDayStartHour of [0, 4, 6, 10, 12]) {
  test(`a stock take dated "today" resolves inside today's report window when trading day starts at ${tradingDayStartHour}:00`, async () => {
    const env = createEnv(tradingDayStartHour);
    const countedAt = await resolveStockTakeCountedAt(env, 'ws_1', '2026-08-31');

    const bounds = localDateRangeToUtcBounds({
      from: '2026-08-31',
      to: '2026-08-31',
      timeZone: 'Africa/Johannesburg',
      tradingDayStartMinutes: tradingDayStartHour * 60,
    });

    assert.ok(
      countedAt >= bounds.fromUtc && countedAt < bounds.toExclusiveUtc,
      `expected ${countedAt} to be within [${bounds.fromUtc}, ${bounds.toExclusiveUtc})`,
    );
  });
}

test('a malformed date falls back to the current instant rather than throwing', async () => {
  const env = createEnv(0);
  const before = new Date().toISOString();
  const countedAt = await resolveStockTakeCountedAt(env, 'ws_1', 'not-a-date');
  const after = new Date().toISOString();
  assert.ok(countedAt >= before && countedAt <= after);
});

test('a stock take dated as the workspace\'s actual current trading day uses the real submission instant, not a synthetic midnight/anchor', async () => {
  const env = createEnv(0);
  const todayIso = new Date().toISOString().slice(0, 10);
  const before = new Date().toISOString();
  const countedAt = await resolveStockTakeCountedAt(env, 'ws_1', todayIso);
  const after = new Date().toISOString();
  assert.ok(
    countedAt >= before && countedAt <= after,
    `expected ${countedAt} to be the real submission instant, within [${before}, ${after}]`,
  );
});

test('a backdated stock take (a past date, not the workspace\'s current trading day) is anchored to that day\'s trading-day start', async () => {
  const env = createEnv(6);
  const countedAt = await resolveStockTakeCountedAt(env, 'ws_1', '2020-01-01');

  const bounds = localDateRangeToUtcBounds({
    from: '2020-01-01',
    to: '2020-01-01',
    timeZone: 'Africa/Johannesburg',
    tradingDayStartMinutes: 6 * 60,
  });

  assert.equal(countedAt, bounds.fromUtc);
});
