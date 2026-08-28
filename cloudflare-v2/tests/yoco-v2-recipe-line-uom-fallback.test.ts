import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import type { CanonicalSaleCompletedEvent } from '../src/modules/yoco-engine-v2/contracts';
import {
  YOCO_V2_FOUNDATION_MIGRATION,
  YOCO_V2_REFUND_RECONCILIATION_MIGRATION,
  YOCO_V2_SALE_SHADOW_MIGRATION
} from '../src/modules/yoco-engine-v2/migrations';
import { buildSaleEffectProposals } from '../src/modules/yoco-engine-v2/effect-proposals';
import {
  MODIFIER_ENGINE_CORE_ACTIONS_MIGRATION,
  MODIFIER_ENGINE_REFUNDS_RELIABILITY_NOTES_MIGRATION
} from '../src/modules/modifier-engine/migrations';
import { expandProductIngredients } from '../src/inventory/recipe-expansion';

// Regression guard for the production incident on WS-leo-s-demo-de3159 (2026-08-28): a menu item
// with a perfectly valid one-line recipe ("2 Queen Prawns" -> 2 kg Beef Mince) deducted NOTHING on
// every completed sale, twelve in a row, while reporting posted normally.
//
// Cause: the recipe editor stores 'ea' in recipe_lines.unit whenever no explicit UOM was chosen
// (normalizeRecipeLines in services/recipeService.js). 'ea' there means "unspecified", and the
// editor renders such a line using the stock item's BASE unit — so the screen showed "2 KG" and
// looked correct. resolveCustomUomFactor, however, treated 'ea' as a custom UOM, found no
// configured ratio for it on a kg-based item, and returned null -> MODIFIER_STOCK_UOM_INVALID ->
// quantity 0 -> partitionSaleStockProposals skipped the line -> no stock movement, no visible
// error. Every ingredient measured in kg/g/L/ml was affected; 'ea'-based ingredients resolved
// fine, which is why some items on a basket deducted and others silently did not.

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
    const m = this.materialize();
    const row = this.database.prepare(m.sql).get(...m.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const m = this.materialize();
    const rows = this.database.prepare(m.sql).all(...m.values) as T[];
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
  }
  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const m = this.materialize();
    const result = this.database.prepare(m.sql).run(...m.values);
    return { results: [], success: true, meta: { changes: Number(result.changes), rows_written: Number(result.changes) } };
  }
  async raw<T = unknown[]>(): Promise<T[]> {
    const m = this.materialize();
    const rows = this.database.prepare(m.sql).all(...m.values) as Record<string, unknown>[];
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
  DB.database.exec(YOCO_V2_FOUNDATION_MIGRATION);
  DB.database.exec(YOCO_V2_SALE_SHADOW_MIGRATION);
  DB.database.exec(YOCO_V2_REFUND_RECONCILIATION_MIGRATION);
  DB.database.exec(MODIFIER_ENGINE_CORE_ACTIONS_MIGRATION);
  DB.database.exec(MODIFIER_ENGINE_REFUNDS_RELIABILITY_NOTES_MIGRATION);
  DB.database.exec(`
    INSERT INTO workspace_settings (workspace_id, vat_rate) VALUES ('ws_1', 15);
    INSERT INTO locations (id, workspace_id, name, active, external_provider, external_location_id)
      VALUES ('loc_1', 'ws_1', 'Main Kitchen', 1, 'yoco', 'yoco_loc_1');

    INSERT INTO stock_items (id, workspace_id, name, item_type, unit, unit_cost, active, is_stocked) VALUES
      ('beef_mince', 'ws_1', 'Beef Mince', 'raw', 'kg', 99.99, 1, 1),
      ('cheese',     'ws_1', 'Cheese Slice', 'raw', 'ea', 5, 1, 1),
      ('flour',      'ws_1', 'Flour', 'raw', 'kg', 20, 1, 1),
      ('cream',      'ws_1', 'Cream', 'raw', 'l', 40, 1, 1),
      ('portion',    'ws_1', 'Portioned Fish', 'raw', 'kg', 300, 1, 1);
    -- An item that genuinely configures 'ea' as a custom UOM must keep using that ratio, NOT the
    -- unspecified-sentinel fallback: 1 portion = 0.25 kg.
    UPDATE stock_items SET raw_json = '{"uomConfigurations":[{"customUom":"ea","ratio":0.25}]}'
     WHERE id = 'portion';
    -- Flour DOES have a real custom UOM configured, so a genuinely named-but-unconfigured unit on
    -- it must still fail rather than silently deducting 1 base unit.
    UPDATE stock_items SET raw_json = '{"uomConfigurations":[{"customUom":"box","ratio":12}]}'
     WHERE id = 'flour';

    INSERT INTO products (id, workspace_id, name, active, external_provider, yoco_item_id, yoco_variant_id) VALUES
      ('queen_prawns', 'ws_1', '2 Queen Prawns', 1, 'yoco', 'prod_qp', 'var_qp'),
      ('cheese_side',  'ws_1', 'Cheese Side',    1, 'yoco', 'prod_cs', 'var_cs'),
      ('bread',        'ws_1', 'Bread',          1, 'yoco', 'prod_br', 'var_br'),
      ('curry',        'ws_1', 'Curry',          1, 'yoco', 'prod_cu', 'var_cu'),
      ('fish_dish',    'ws_1', 'Fish Dish',      1, 'yoco', 'prod_fd', 'var_fd');

    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active) VALUES
      ('recipe_qp', 'ws_1', 'product', 'queen_prawns', 1, 1),
      ('recipe_cs', 'ws_1', 'product', 'cheese_side',  1, 1),
      ('recipe_br', 'ws_1', 'product', 'bread',        1, 1),
      ('recipe_cu', 'ws_1', 'product', 'curry',        1, 1),
      ('recipe_fd', 'ws_1', 'product', 'fish_dish',    1, 1);

    -- The exact production shape: a kg-based ingredient whose line unit is the 'ea' sentinel.
    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order) VALUES
      ('qp_beef',   'ws_1', 'recipe_qp', 'beef_mince', 2, 'ea',  1),
      ('cs_cheese', 'ws_1', 'recipe_cs', 'cheese',     1, 'ea',  1),
      ('br_flour',  'ws_1', 'recipe_br', 'flour',      1, 'sack', 1),
      -- How a kitchen actually writes a recipe: grams and millilitres against kg/L stock.
      ('cu_beef',   'ws_1', 'recipe_cu', 'beef_mince', 250, 'g',  1),
      ('cu_cream',  'ws_1', 'recipe_cu', 'cream',      150, 'ml', 2),
      ('fd_portion','ws_1', 'recipe_fd', 'portion',      2, 'ea', 1);
  `);
  return { DB } as any;
}

function sale(orderId: string, productId: string, quantity = 1): CanonicalSaleCompletedEvent {
  return {
    event_id: `event_${orderId}`,
    event_type: 'sale.completed',
    source: 'yoco',
    source_version: 'v1',
    workspace_id: 'ws_1',
    integration_id: 'integration_1',
    source_order_id: orderId,
    source_location_id: 'yoco_loc_1',
    kcp_location_id: 'loc_1',
    occurred_at: '2026-08-28T13:16:14.745Z',
    received_at: '2026-08-28T13:16:20.000Z',
    currency: 'ZAR',
    gross_amount: 60,
    discount_amount: 0,
    net_amount: 52.17,
    tax_amount: 7.83,
    tip_amount: 0,
    status: 'completed',
    lines: [{
      source_line_id: `line_${orderId}`,
      source_product_id: `source_${productId}`,
      source_name: productId,
      quantity,
      unit_gross_amount: 60,
      gross_amount: 60,
      discount_amount: 0,
      net_amount: 52.17,
      tax_amount: 7.83,
      modifiers: [],
      mapping_status: 'MAPPED',
      mapped_menu_item_id: productId,
      metadata: {}
    }],
    metadata: {},
    schema_version: '1.0.0',
    resolution_status: 'RESOLVED'
  } as CanonicalSaleCompletedEvent;
}

async function proposalsFor(env: any, event: CanonicalSaleCompletedEvent) {
  return buildSaleEffectProposals(env, { id: event.event_id }, event, `raw_${event.source_order_id}`, `run_${event.source_order_id}`);
}

test('a kg ingredient whose recipe line carries the "ea" no-UOM sentinel deducts in the base unit', async () => {
  const env = createEnv();
  const rows = await proposalsFor(env, sale('order_qp', 'queen_prawns'));
  const beef = rows.find((row: any) => row.ingredient_item_id === 'beef_mince') as any;

  assert.ok(beef, 'the Beef Mince line must produce a proposal');
  assert.equal(beef.warning_code, null, 'an unspecified UOM is not a misconfiguration and must not warn');
  assert.equal(beef.resolution_status, 'RESOLVED');
  assert.equal(beef.quantity, -2, 'the recipe says 2, the item is measured in kg, so 2 kg must be deducted');
  assert.equal(beef.base_uom, 'kg');
});

test('line quantity still multiplies through for a sentinel-UOM line', async () => {
  const env = createEnv();
  const rows = await proposalsFor(env, sale('order_qp_x3', 'queen_prawns', 3));
  const beef = rows.find((row: any) => row.ingredient_item_id === 'beef_mince') as any;
  assert.equal(beef.quantity, -6, 'three sold portions of a 2 kg recipe must deduct 6 kg');
});

test('an ingredient whose base unit really is "ea" is unaffected', async () => {
  const env = createEnv();
  const rows = await proposalsFor(env, sale('order_cs', 'cheese_side'));
  const cheese = rows.find((row: any) => row.ingredient_item_id === 'cheese') as any;
  assert.equal(cheese.warning_code, null);
  assert.equal(cheese.quantity, -1);
});

test('a genuinely named but unconfigured custom UOM still fails loudly rather than deducting 1', async () => {
  const env = createEnv();
  const rows = await proposalsFor(env, sale('order_br', 'bread'));
  const flour = rows.find((row: any) => row.ingredient_item_id === 'flour') as any;

  assert.ok(flour, 'the flour line must still surface for review');
  assert.equal(flour.warning_code, 'MODIFIER_STOCK_UOM_INVALID',
    '"sack" is a real unit choice with no configured ratio — deducting 1 kg would be a silent under-deduction');
  assert.equal(flour.quantity, 0);
});

test('recipe-expansion.ts applies the identical sentinel contract', async () => {
  const env = createEnv();

  const prawns = await expandProductIngredients(env, 'ws_1', 'queen_prawns', 1);
  const beef = prawns.find((entry) => entry.stockItemId === 'beef_mince');
  assert.ok(beef);
  assert.equal(beef!.uomResolved, true, 'the two resolvers must not disagree about the same recipe line');
  assert.equal(beef!.totalQty, 2);

  const bread = await expandProductIngredients(env, 'ws_1', 'bread', 1);
  const flour = bread.find((entry) => entry.stockItemId === 'flour');
  assert.equal(flour!.uomResolved, false, 'an unconfigured named UOM stays unresolved here too');
});

test('a recipe written in grams and millilitres deducts against kg and litre stock', async () => {
  const env = createEnv();
  const rows = await proposalsFor(env, sale('order_curry', 'curry'));

  const beef = rows.find((row: any) => row.ingredient_item_id === 'beef_mince') as any;
  assert.equal(beef.warning_code, null, '250 g against a kg item is a standard conversion, not a misconfiguration');
  assert.ok(Math.abs(beef.quantity - -0.25) < 1e-9, `250 g must deduct 0.25 kg, got ${beef.quantity}`);

  const cream = rows.find((row: any) => row.ingredient_item_id === 'cream') as any;
  assert.equal(cream.warning_code, null);
  assert.ok(Math.abs(cream.quantity - -0.15) < 1e-9, `150 ml must deduct 0.15 l, got ${cream.quantity}`);
});

test('an item that genuinely configures "ea" as a custom UOM keeps its own ratio', async () => {
  const env = createEnv();
  const rows = await proposalsFor(env, sale('order_fd', 'fish_dish'));
  const portion = rows.find((row: any) => row.ingredient_item_id === 'portion') as any;

  assert.equal(portion.warning_code, null);
  assert.ok(Math.abs(portion.quantity - -0.5) < 1e-9,
    `2 portions at a configured 0.25 kg each must deduct 0.5 kg, not the sentinel fallback of 2 — got ${portion.quantity}`);
});

test('recipe-expansion.ts converts grams and millilitres identically', async () => {
  const env = createEnv();
  const curry = await expandProductIngredients(env, 'ws_1', 'curry', 1);
  const beef = curry.find((entry) => entry.stockItemId === 'beef_mince');
  const cream = curry.find((entry) => entry.stockItemId === 'cream');

  assert.equal(beef!.uomResolved, true);
  assert.ok(Math.abs(beef!.totalQty - 0.25) < 1e-9, `expected 0.25 kg, got ${beef!.totalQty}`);
  assert.equal(cream!.uomResolved, true);
  assert.ok(Math.abs(cream!.totalQty - 0.15) < 1e-9, `expected 0.15 l, got ${cream!.totalQty}`);
});
