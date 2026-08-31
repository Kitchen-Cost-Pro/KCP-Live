import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { removeStockItemFromRecipeLines } from '../src/legacy/recipe-line-cleanup';

// Regression: deleting a stock item left a dangling recipe_lines.stock_item_id reference behind —
// every recipe using it showed a permanent "Missing ingredient" placeholder with no way to clear
// it. removeStockItemFromRecipeLines() (called from deleteStockItemRoute / postStockBulkDelete)
// must remove those lines and log the removal as an auditable, recipe-classified event instead.

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
    INSERT INTO stock_items (id, workspace_id, name, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('sponge', 'ws_1', 'Sponge Base', 'sub_recipe', 'ea', 5, 1, 0);

    INSERT INTO products (id, workspace_id, name, active) VALUES ('cake', 'ws_1', 'Chocolate Cake', 1);
    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active)
      VALUES ('recipe_cake', 'ws_1', 'product', 'cake', 1, 1);
    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order)
      VALUES ('cake_flour', 'ws_1', 'recipe_cake', 'flour', 2, 'kg', 1);

    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active)
      VALUES ('recipe_sponge', 'ws_1', 'stock_item', 'sponge', 1, 1);
    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order)
      VALUES ('sponge_flour', 'ws_1', 'recipe_sponge', 'flour', 0.5, 'kg', 1);
  `);
  return { DB } as any;
}

test('removes the recipe line from every recipe that used the deleted item, across both product and sub-recipe owners', async () => {
  const env = createEnv();
  const statements = await removeStockItemFromRecipeLines(env, 'ws_1', 'user_1', 'flour', 'Flour', '2026-08-31T00:00:00.000Z');
  assert.ok(statements.length > 0);
  await env.DB.batch(statements);

  const remainingLines = (await env.DB.prepare(
    `SELECT id FROM recipe_lines WHERE workspace_id = 'ws_1' AND stock_item_id = 'flour'`,
  ).all()).results;
  assert.equal(remainingLines.length, 0);

  // The other recipe's own lines (unrelated to flour) must be untouched.
  const untouchedLine = await env.DB.prepare(
    `SELECT id FROM recipe_lines WHERE id = 'sponge_flour'`,
  ).first();
  assert.equal(untouchedLine, null, 'sponge_flour used flour too and should also have been removed');
});

test('logs one recipe-classified audit event per removed line, naming the recipe/product and the removed ingredient', async () => {
  const env = createEnv();
  const statements = await removeStockItemFromRecipeLines(env, 'ws_1', 'user_1', 'flour', 'Flour', '2026-08-31T00:00:00.000Z');
  await env.DB.batch(statements);

  const events = (await env.DB.prepare(
    `SELECT event_type, entity_type, entity_id, before_json, after_json FROM audit_events WHERE workspace_id = 'ws_1' ORDER BY entity_id`,
  ).all()).results as Array<Record<string, unknown>>;

  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.event_type, 'recipe_ingredient_removed');
    assert.equal(event.entity_type, 'recipe_line');
    assert.equal(event.after_json, '{}');
    const before = JSON.parse(String(event.before_json));
    assert.equal(before.ingredientName, 'Flour');
    assert.equal(before.stockItemName, 'Flour');
  }

  const cakeEvent = events.find((event) => event.entity_id === 'recipe_cake')!;
  const cakeBefore = JSON.parse(String(cakeEvent.before_json));
  assert.equal(cakeBefore.quantity, 2);
  assert.equal(cakeBefore.unit, 'kg');
  assert.equal(cakeBefore.recipeName, 'Chocolate Cake');

  const spongeEvent = events.find((event) => event.entity_id === 'recipe_sponge')!;
  const spongeBefore = JSON.parse(String(spongeEvent.before_json));
  assert.equal(spongeBefore.quantity, 0.5);
  assert.equal(spongeBefore.recipeName, 'Sponge Base');
});

test('an item not used in any recipe produces no statements at all', async () => {
  const env = createEnv();
  const statements = await removeStockItemFromRecipeLines(env, 'ws_1', 'user_1', 'unused-item', 'Unused Item', '2026-08-31T00:00:00.000Z');
  assert.deepEqual(statements, []);
});

// Regression: deleting a stock item that is ITSELF a sub-recipe's owner (recipes.owner_type=
// 'stock_item', owner_id=<deleted item>) previously left that recipe (and its own lines)
// permanently dangling — nothing referenced it anymore after cleanup, so it had no cleanup path
// and no UI artifact to even notice it by.
test('deleting a stock item that owns its own sub-recipe deactivates that recipe and logs it', async () => {
  const env = createEnv();
  const statements = await removeStockItemFromRecipeLines(env, 'ws_1', 'user_1', 'sponge', 'Sponge Base', '2026-08-31T00:00:00.000Z');
  assert.ok(statements.length > 0);
  await env.DB.batch(statements);

  const recipe = await env.DB.prepare(
    `SELECT active FROM recipes WHERE id = 'recipe_sponge'`,
  ).first() as Record<string, unknown>;
  assert.equal(Number(recipe.active), 0);

  // Its own recipe_lines (sponge_flour) are left in place — an inactive parent recipe is already
  // unreachable via every active=1-filtered read path, so there's nothing further to clean up.
  const spongeLine = await env.DB.prepare(
    `SELECT id FROM recipe_lines WHERE id = 'sponge_flour'`,
  ).first();
  assert.ok(spongeLine, 'the deactivated recipe\'s own lines are left as-is, not deleted');

  const event = await env.DB.prepare(
    `SELECT event_type, entity_type, entity_id, before_json, after_json FROM audit_events WHERE workspace_id = 'ws_1' AND entity_type = 'recipe'`,
  ).first() as Record<string, unknown>;
  assert.equal(event.event_type, 'recipe_deactivated');
  assert.equal(event.entity_id, 'recipe_sponge');
  assert.equal(JSON.parse(String(event.after_json)).active, false);
});

test('deleting a stock item with no owned recipe does not touch the recipes table at all', async () => {
  const env = createEnv();
  const statements = await removeStockItemFromRecipeLines(env, 'ws_1', 'user_1', 'flour', 'Flour', '2026-08-31T00:00:00.000Z');
  await env.DB.batch(statements);

  const recipeEvents = (await env.DB.prepare(
    `SELECT id FROM audit_events WHERE workspace_id = 'ws_1' AND entity_type = 'recipe'`,
  ).all()).results;
  assert.equal(recipeEvents.length, 0);

  const cakeRecipe = await env.DB.prepare(`SELECT active FROM recipes WHERE id = 'recipe_cake'`).first() as Record<string, unknown>;
  assert.equal(Number(cakeRecipe.active), 1);
});
