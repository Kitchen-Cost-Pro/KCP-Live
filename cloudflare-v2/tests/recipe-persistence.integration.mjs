import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  buildProductRecipeSavePayload
} from '../../src/services/recipePayload.js';
import {
  getProductRecipe,
  putProductRecipe
} from './.recipe-routes.bundle.mjs';

const workspaceId = 'WS-recipe-persistence-test';
const productId = 'product-burger';
const stockItemId = 'stock-patty';

class SqliteStatement {
  constructor(database, query, params = []) {
    this.database = database;
    this.query = query;
    this.params = params;
  }

  bind(...params) {
    return new SqliteStatement(this.database, this.query, params);
  }

  async first(column) {
    const row = this.database.prepare(this.query).get(...this.params);
    if (!row) return null;
    return column === undefined ? row : (row[column] ?? null);
  }

  async all() {
    const results = this.database.prepare(this.query).all(...this.params);
    return { results, success: true, meta: {} };
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.params);
    return {
      results: [],
      success: true,
      meta: { changes: Number(result.changes || 0) }
    };
  }

  async raw() {
    return this.database.prepare(this.query).all(...this.params).map((row) => Object.values(row));
  }
}

class SqliteDatabase {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new SqliteStatement(this.database, query);
  }

  async batch(statements) {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function createTenantDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE stock_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'raw',
      active INTEGER NOT NULL DEFAULT 1,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      recipe_source_stock_item_id TEXT,
      missing_recipe INTEGER NOT NULL DEFAULT 1,
      raw_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE recipes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      yield_qty REAL NOT NULL DEFAULT 1,
      yield_unit TEXT NOT NULL DEFAULT 'ea',
      linked_product_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, owner_type, owner_id)
    );

    CREATE TABLE recipe_lines (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      stock_item_id TEXT NOT NULL REFERENCES stock_items(id),
      quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      actor_uid TEXT,
      event_type TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  database.prepare(
    `INSERT INTO stock_items (id, workspace_id, name, item_type, active, raw_json)
     VALUES (?1, ?2, 'Beef Patty', 'raw', 1, '{}')`
  ).run(stockItemId, workspaceId);
  database.prepare(
    `INSERT INTO products
      (id, workspace_id, name, active, recipe_source_stock_item_id, missing_recipe, raw_json, updated_at)
     VALUES (?1, ?2, 'Burger', 1, NULL, 0, ?3, ?4)`
  ).run(
    productId,
    workspaceId,
    JSON.stringify({
      recipe: [{
        ingId: stockItemId,
        stockItemId,
        qty: 0.125,
        quantity: 0.125,
        unit: 'kg'
      }]
    }),
    new Date().toISOString()
  );
  database.prepare(
    `INSERT INTO recipes
      (id, workspace_id, owner_type, owner_id, yield_qty, yield_unit, active, created_at, updated_at)
     VALUES ('recipe-burger', ?1, 'product', ?2, 1, 'ea', 1, ?3, ?3)`
  ).run(workspaceId, productId, new Date().toISOString());
  database.prepare(
    `INSERT INTO recipe_lines
      (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order, created_at)
     VALUES ('line-patty', ?1, 'recipe-burger', ?2, 0.125, 'kg', 0, ?3)`
  ).run(workspaceId, stockItemId, new Date().toISOString());
  return database;
}

function createCentralDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE admin_users (
      auth_uid TEXT,
      email TEXT,
      role_key TEXT,
      status TEXT
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      status TEXT
    );
    CREATE TABLE workspace_members (
      id TEXT,
      workspace_id TEXT,
      auth_uid TEXT,
      email TEXT,
      role_key TEXT,
      status TEXT
    );
  `);
  database.prepare(
    `INSERT INTO admin_users (auth_uid, email, role_key, status)
     VALUES ('test-user', 'test@example.com', 'superuser', 'active')`
  ).run();
  database.prepare(
    `INSERT INTO workspaces (id, status) VALUES (?1, 'active')`
  ).run(workspaceId);
  return database;
}

const tenantSqlite = createTenantDatabase();
const centralSqlite = createCentralDatabase();
const env = {
  DB: new SqliteDatabase(tenantSqlite),
  CENTRAL_DB: new SqliteDatabase(centralSqlite),
  ALLOWED_ORIGINS: 'http://localhost:5173'
};
const auth = {
  uid: 'test-user',
  email: 'test@example.com',
  token: { sub: 'test-user', email: 'test@example.com' }
};

try {
  // This is the exact shape that previously failed: the user edited `qty`, while
  // the loaded API alias `quantity` still held the old database value.
  const editedLine = {
    ingId: stockItemId,
    stockItemId,
    qty: '0,250',
    quantity: 0.125,
    unit: 'kg'
  };
  const payload = buildProductRecipeSavePayload({ id: productId }, [editedLine]);
  assert.equal(payload.recipe[0].quantity, 0.25);

  const saveRequest = new Request(
    `http://localhost/api/workspaces/${workspaceId}/products/${productId}/recipe`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173'
      },
      body: JSON.stringify(payload)
    }
  );
  const saveResponse = await putProductRecipe(
    saveRequest,
    env,
    auth,
    workspaceId,
    productId
  );
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json();
  assert.equal(saved.persisted, true);
  assert.equal(saved.recipe[0].quantity, 0.25);

  const readRequest = new Request(
    `http://localhost/api/workspaces/${workspaceId}/products/${productId}/recipe`,
    {
      headers: { origin: 'http://localhost:5173' }
    }
  );
  const readResponse = await getProductRecipe(
    readRequest,
    env,
    auth,
    workspaceId,
    productId
  );
  const readBack = await readResponse.json();
  assert.equal(readBack.persisted, true);
  assert.equal(readBack.recipe[0].quantity, 0.25);

  const relationalQuantity = tenantSqlite.prepare(
    `SELECT quantity FROM recipe_lines
      WHERE workspace_id = ?1
        AND recipe_id = 'recipe-burger'`
  ).get(workspaceId).quantity;
  assert.equal(relationalQuantity, 0.25);

  const productRaw = JSON.parse(tenantSqlite.prepare(
    `SELECT raw_json FROM products WHERE workspace_id = ?1 AND id = ?2`
  ).get(workspaceId, productId).raw_json);
  assert.equal(productRaw.recipe[0].quantity, 0.25);

  console.log('Recipe edit persisted through payload, route, relational rows, product JSON, and GET read-back.');
} finally {
  tenantSqlite.close();
  centralSqlite.close();
  await unlink(new URL('./.recipe-routes.bundle.mjs', import.meta.url)).catch(() => {});
}
