import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { loadAdjustmentDetail } from '../src/legacy/transaction-detail-routes';

// The Adjustments report's Summary table now groups one row per posted adjustment/wastage
// submission (matching how GRV Log's summary already groups by grvId) and opens the same shared
// Transaction Detail drawer on click. This exercises the new "adjustment" entity type's detail
// loader end to end against real adjustments/adjustment_lines rows.

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
  DB.database.exec(`
    CREATE TABLE workspace_members (workspace_id TEXT, auth_uid TEXT, email TEXT, display_name TEXT);
    CREATE TABLE app_users (id TEXT, email TEXT, display_name TEXT);
  `);
  return { DB, CENTRAL_DB: DB } as any;
}

test('a multi-item manual adjustment loads all its lines under one transaction detail', async () => {
  const env = createEnv();
  env.DB.database.exec(`
    INSERT INTO locations (id, workspace_id, name, active) VALUES ('loc-a', 'ws_1', 'Main Store', 1);
    INSERT INTO stock_items (id, workspace_id, name, category, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('stock-1', 'ws_1', 'Flour', 'Dry Goods', 'raw', 'kg', 10, 1, 1);
    INSERT INTO stock_items (id, workspace_id, name, category, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('stock-2', 'ws_1', 'Sugar', 'Dry Goods', 'raw', 'kg', 8, 1, 1);
    INSERT INTO adjustments (id, workspace_id, adjustment_type, occurred_at, reason, created_by, raw_json, created_at)
      VALUES ('adj-1', 'ws_1', 'manual', '2026-08-31T09:00:00.000Z', 'Stock correction', 'user_1', '{}', '2026-08-31T09:00:00.000Z');
    INSERT INTO adjustment_lines (id, workspace_id, adjustment_id, stock_item_id, location_id, quantity_delta, unit_cost)
      VALUES ('line-1', 'ws_1', 'adj-1', 'stock-1', 'loc-a', -2, 10);
    INSERT INTO adjustment_lines (id, workspace_id, adjustment_id, stock_item_id, location_id, quantity_delta, unit_cost)
      VALUES ('line-2', 'ws_1', 'adj-1', 'stock-2', 'loc-a', 1, 8);
  `);

  const detail = await loadAdjustmentDetail(env, 'ws_1', 'adj-1');
  assert.ok(detail);
  assert.equal(detail!.entityType, 'adjustment');
  assert.equal(detail!.lineItems.length, 2);
  assert.equal(detail!.metadata?.reason, 'Stock correction');

  const flourLine: any = detail!.lineItems.find((line: any) => line.itemId === 'stock-1');
  assert.equal(flourLine.quantityDelta, -2);
  assert.equal(flourLine.unit, 'kg');
  assert.equal(flourLine.valueImpact, -20);

  const sugarLine: any = detail!.lineItems.find((line: any) => line.itemId === 'stock-2');
  assert.equal(sugarLine.quantityDelta, 1);
  assert.equal(sugarLine.valueImpact, 8);

  const totalValueCard = detail!.summaryCards.find((card) => card.key === 'totalValueImpact');
  assert.equal(totalValueCard?.value, -12);
});

test('a wastage adjustment (document_type wastage_adjustment) is labelled distinctly from a manual adjustment', async () => {
  const env = createEnv();
  env.DB.database.exec(`
    INSERT INTO locations (id, workspace_id, name, active) VALUES ('loc-a', 'ws_1', 'Main Store', 1);
    INSERT INTO stock_items (id, workspace_id, name, category, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('stock-1', 'ws_1', 'Flour', 'Dry Goods', 'raw', 'kg', 10, 1, 1);
    INSERT INTO adjustments (id, workspace_id, adjustment_type, occurred_at, reason, created_by, raw_json, created_at)
      VALUES ('adj-2', 'ws_1', 'wastage', '2026-08-31T09:00:00.000Z', 'Wastage: Spoiled', 'user_1', '{}', '2026-08-31T09:00:00.000Z');
    INSERT INTO adjustment_lines (id, workspace_id, adjustment_id, stock_item_id, location_id, quantity_delta, unit_cost)
      VALUES ('line-1', 'ws_1', 'adj-2', 'stock-1', 'loc-a', -3, 10);
  `);

  const detail = await loadAdjustmentDetail(env, 'ws_1', 'adj-2');
  assert.ok(detail);
  assert.match(detail!.title, /Wastage Adjustment/);
  const typeCard = detail!.summaryCards.find((card) => card.key === 'adjustmentType');
  assert.equal(typeCard?.value, 'Wastage Adjustment');
});

test('an unknown adjustment id returns null rather than throwing', async () => {
  const env = createEnv();
  const detail = await loadAdjustmentDetail(env, 'ws_1', 'does-not-exist');
  assert.equal(detail, null);
});
