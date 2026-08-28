import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { expandProductIngredients } from '../src/inventory/recipe-expansion';

// Regression guard: resolveUomRatio() in recipe-expansion.ts silently fell back to a ratio of 1
// when a recipe line's custom UOM (e.g. "1 box") couldn't be matched on the stock item's
// uomConfigurations — so a wastage/adjustment deduction would silently write off the wrong
// quantity with no indication anything went wrong. `uomResolved` now reports this explicitly so a
// stock-mutating caller (the wastage endpoint) can skip the deduction instead of trusting it.

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
    INSERT INTO stock_items (id, workspace_id, name, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('flour', 'ws_1', 'Flour', 'raw', 'kg', 2, 1, 1);
    UPDATE stock_items SET raw_json = '{"uomConfigurations":[{"customUom":"box","ratio":12}]}' WHERE id = 'flour';
    INSERT INTO stock_items (id, workspace_id, name, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('sugar', 'ws_1', 'Sugar', 'raw', 'kg', 3, 1, 1);

    INSERT INTO products (id, workspace_id, name, active) VALUES ('pizza', 'ws_1', 'Pizza', 1);
    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active)
      VALUES ('recipe_pizza', 'ws_1', 'product', 'pizza', 1, 1);
    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order) VALUES
      ('pizza_flour', 'ws_1', 'recipe_pizza', 'flour', 1, 'box', 1),
      ('pizza_sugar', 'ws_1', 'recipe_pizza', 'sugar', 1, 'bag', 2);
  `);
  return { DB } as any;
}

test('a recipe line in a resolvable custom UOM reports uomResolved: true with the converted quantity', async () => {
  const env = createEnv();
  const ingredients = await expandProductIngredients(env, 'ws_1', 'pizza', 1);
  const flour = ingredients.find((i) => i.stockItemId === 'flour');
  assert.ok(flour);
  assert.equal(flour!.uomResolved, true);
  assert.equal(flour!.totalQty, 12);
});

test('a recipe line whose custom UOM cannot be resolved reports uomResolved: false, not a silent 1:1 quantity', async () => {
  const env = createEnv();
  const ingredients = await expandProductIngredients(env, 'ws_1', 'pizza', 1);
  const sugar = ingredients.find((i) => i.stockItemId === 'sugar');
  assert.ok(sugar);
  assert.equal(sugar!.uomResolved, false, 'sugar has no "bag" ratio configured, so it must not be reported as resolved');
});
