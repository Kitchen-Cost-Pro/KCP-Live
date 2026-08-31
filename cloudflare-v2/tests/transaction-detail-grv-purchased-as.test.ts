import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { loadGrvDetail } from '../src/legacy/transaction-detail-routes';

// The GRV "Transaction Detail" drawer (Line Items tab) is a SEPARATE code path from the GRV Log
// report — it used to (a) match each grv_lines row back to its raw draft entry by stockItemId
// alone (no location, so a same-item/different-location split GRV could pick the wrong one), and
// (b) always reported the already-converted base-unit quantity as "Received Qty", so a line bought
// as "1 Bottle" (30 tots per bottle) showed "Received Qty: 30, Received UOM: Tot" — identical to
// "Base Qty"/"Base UOM" — silently discarding how it was actually purchased.

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
  // attachActor() looks the GRV's created_by up against these central-plane tables — irrelevant to
  // what these tests check (the line item quantity/UOM fields), but the query still needs the
  // tables to exist, or it throws before loadGrvDetail can return anything at all.
  DB.database.exec(`
    CREATE TABLE workspace_members (workspace_id TEXT, auth_uid TEXT, email TEXT, display_name TEXT);
    CREATE TABLE app_users (id TEXT, email TEXT, display_name TEXT);
  `);
  return { DB, CENTRAL_DB: DB } as any;
}

test('a line bought as "1 Bottle" (30 tots/bottle) reports Received Qty "1 Bottle" distinct from Base Qty "30 Tot"', async () => {
  const env = createEnv();
  env.DB.database.exec(`
    INSERT INTO locations (id, workspace_id, name, active) VALUES ('loc-a', 'ws_1', 'Main Store', 1);
    INSERT INTO stock_items (id, workspace_id, name, category, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('stock-1', 'ws_1', 'Jagermeister', 'Spirits', 'raw', 'Tot', 5, 1, 1);
    INSERT INTO grvs (id, workspace_id, received_at, prices_include_vat, split_by_location, total_ex, total_vat, total_inc, created_by, raw_json, created_at)
      VALUES ('grv-1', 'ws_1', '2026-08-31T00:00:00.000Z', 0, 0, 150, 22.5, 172.5, 'user_1', ?, '2026-08-31T00:00:00.000Z');
    INSERT INTO grv_lines (id, workspace_id, grv_id, stock_item_id, location_id, quantity, unit, unit_price, total_ex, total_vat, total_inc)
      VALUES ('grvl-1', 'ws_1', 'grv-1', 'stock-1', 'loc-a', 30, 'Tot', 5, 150, 22.5, 172.5);
  `.replace('?', `'${JSON.stringify({
    items: [{ stockItemId: 'stock-1', locationId: 'loc-a', receivedQty: 1, packSize: 30, selectedUom: 'Bottle', unitCost: 5 }],
  }).replace(/'/g, "''")}'`));

  const detail = await loadGrvDetail(env, 'ws_1', 'grv-1');
  assert.ok(detail);
  assert.equal(detail!.lineItems.length, 1);
  const line: any = detail!.lineItems[0];
  assert.equal(line.receivedUomQuantity, 1);
  assert.equal(line.receivedUom, 'Bottle');
  assert.equal(line.baseQuantity, 30);
  assert.equal(line.baseUom, 'Tot');
  assert.equal(line.conversionFactor, 30);
});

test('a line bought directly in the base unit (no custom UOM) shows the same value on both sides', async () => {
  const env = createEnv();
  env.DB.database.exec(`
    INSERT INTO locations (id, workspace_id, name, active) VALUES ('loc-a', 'ws_1', 'Main Store', 1);
    INSERT INTO stock_items (id, workspace_id, name, category, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('stock-1', 'ws_1', 'Almond Flour', 'Bakery', 'raw', 'kg', 10, 1, 1);
    INSERT INTO grvs (id, workspace_id, received_at, prices_include_vat, split_by_location, total_ex, total_vat, total_inc, created_by, raw_json, created_at)
      VALUES ('grv-1', 'ws_1', '2026-08-31T00:00:00.000Z', 0, 0, 1200, 0, 1200, 'user_1', ?, '2026-08-31T00:00:00.000Z');
    INSERT INTO grv_lines (id, workspace_id, grv_id, stock_item_id, location_id, quantity, unit, unit_price, total_ex, total_vat, total_inc)
      VALUES ('grvl-1', 'ws_1', 'grv-1', 'stock-1', 'loc-a', 120, 'kg', 10, 1200, 0, 1200);
  `.replace('?', `'${JSON.stringify({
    items: [{ stockItemId: 'stock-1', locationId: 'loc-a', receivedQty: 120, packSize: 1, selectedUom: 'kg', unitCost: 10 }],
  }).replace(/'/g, "''")}'`));

  const detail = await loadGrvDetail(env, 'ws_1', 'grv-1');
  const line: any = detail!.lineItems[0];
  assert.equal(line.receivedUomQuantity, 120);
  assert.equal(line.receivedUom, 'kg');
  assert.equal(line.baseQuantity, 120);
  assert.equal(line.baseUom, 'kg');
});

test('the same item split across two DIFFERENT locations in one GRV is not confused between rows', async () => {
  const env = createEnv();
  env.DB.database.exec(`
    INSERT INTO locations (id, workspace_id, name, active) VALUES ('loc-a', 'ws_1', 'Main Store', 1);
    INSERT INTO locations (id, workspace_id, name, active) VALUES ('loc-b', 'ws_1', 'Bar', 1);
    INSERT INTO stock_items (id, workspace_id, name, category, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('stock-1', 'ws_1', 'Jagermeister', 'Spirits', 'raw', 'Tot', 5, 1, 1);
    INSERT INTO grvs (id, workspace_id, received_at, prices_include_vat, split_by_location, total_ex, total_vat, total_inc, created_by, raw_json, created_at)
      VALUES ('grv-1', 'ws_1', '2026-08-31T00:00:00.000Z', 0, 1, 300, 45, 345, 'user_1', ?, '2026-08-31T00:00:00.000Z');
    INSERT INTO grv_lines (id, workspace_id, grv_id, stock_item_id, location_id, quantity, unit, unit_price, total_ex, total_vat, total_inc)
      VALUES ('grvl-a', 'ws_1', 'grv-1', 'stock-1', 'loc-a', 30, 'Tot', 5, 150, 22.5, 172.5);
    INSERT INTO grv_lines (id, workspace_id, grv_id, stock_item_id, location_id, quantity, unit, unit_price, total_ex, total_vat, total_inc)
      VALUES ('grvl-b', 'ws_1', 'grv-1', 'stock-1', 'loc-b', 60, 'Tot', 5, 300, 45, 345);
  `.replace('?', `'${JSON.stringify({
    items: [
      { stockItemId: 'stock-1', locationId: 'loc-a', receivedQty: 1, packSize: 30, selectedUom: 'Bottle', unitCost: 5 },
      { stockItemId: 'stock-1', locationId: 'loc-b', receivedQty: 2, packSize: 30, selectedUom: 'Bottle', unitCost: 5 },
    ],
  }).replace(/'/g, "''")}'`));

  const detail = await loadGrvDetail(env, 'ws_1', 'grv-1');
  const lineA: any = detail!.lineItems.find((l: any) => l.locationId === 'loc-a');
  const lineB: any = detail!.lineItems.find((l: any) => l.locationId === 'loc-b');
  assert.equal(lineA.receivedUomQuantity, 1);
  assert.equal(lineA.baseQuantity, 30);
  assert.equal(lineB.receivedUomQuantity, 2);
  assert.equal(lineB.baseQuantity, 60);
});
