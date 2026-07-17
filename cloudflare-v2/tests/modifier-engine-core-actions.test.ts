import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import type { CanonicalSaleCompletedEvent, CanonicalSaleModifier } from '../src/modules/yoco-engine-v2/contracts';
import {
  YOCO_V2_FOUNDATION_MIGRATION,
  YOCO_V2_REFUND_RECONCILIATION_MIGRATION,
  YOCO_V2_SALE_SHADOW_MIGRATION
} from '../src/modules/yoco-engine-v2/migrations';
import { buildSaleEffectProposals } from '../src/modules/yoco-engine-v2/effect-proposals';
import { actionableYocoModifierGroup } from '../src/modules/yoco-engine-v2/integration-service';
import {
  MODIFIER_ENGINE_CORE_ACTIONS_MIGRATION,
  MODIFIER_ENGINE_REFUNDS_RELIABILITY_NOTES_MIGRATION
} from '../src/modules/modifier-engine/migrations';
import { observeModifier, resolveModifierMapping, upsertModifierRule } from '../src/modules/modifier-engine/rules';
import {
  getApplicableNoteRules,
  loadSaleMovementReversals,
  listModifierEngineDiagnostics,
  listModifierNoteSuggestions,
  normalizeModifierNote,
  observeLineNotes,
  setModifierEngineMode,
  setModifierNoteDisposition,
  upsertModifierNoteRule
} from '../src/modules/modifier-engine/reliability';

class SqliteStatement implements DbStatementLike {
  private values: unknown[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]): DbStatementLike {
    const statement = new SqliteStatement(this.database, this.sql);
    statement.values = values.map((value) => value === undefined ? null : value);
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

test('modifier migration converts existing recipes into versioned ADD_RECIPE rules', () => {
  const DB = new SqliteDb();
  DB.database.exec(TENANT_SCHEMA_SQL);
  DB.database.exec(`
    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active)
    VALUES ('legacy_modifier_recipe', 'ws_migration', 'yoco_modifier', 'legacy_extra', 1, 1);
  `);
  DB.database.exec(MODIFIER_ENGINE_CORE_ACTIONS_MIGRATION);
  const rule = DB.database.prepare(
    `SELECT id, action_type, target_owner_type, target_owner_id FROM modifier_rules
      WHERE workspace_id = 'ws_migration' AND modifier_owner_id = 'legacy_extra'`
  ).get() as any;
  assert.equal(rule.action_type, 'ADD_RECIPE');
  assert.equal(rule.target_owner_type, 'yoco_modifier');
  assert.equal(rule.target_owner_id, 'legacy_extra');
  assert.equal(Number(DB.database.prepare(`SELECT COUNT(*) AS count FROM modifier_rule_versions WHERE modifier_rule_id = ?`).get(rule.id)?.count), 1);
});

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
      ('beef', 'ws_1', 'Beef Patty', 'raw', 'kg', 100, 1, 1),
      ('cheese', 'ws_1', 'Cheese Slice', 'raw', 'ea', 5, 1, 1),
      ('dairy', 'ws_1', 'Dairy Milk', 'raw', 'ml', 0.03, 1, 1),
      ('almond', 'ws_1', 'Almond Milk', 'raw', 'ml', 0.05, 1, 1),
      ('sauce', 'ws_1', 'Extra Sauce', 'raw', 'ml', 0.02, 1, 1);
    UPDATE stock_items
       SET raw_json = '{"uoms":[{"name":"pump","qtyInBase":30}]}'
     WHERE id = 'sauce';

    INSERT INTO products (id, workspace_id, name, active, external_provider, yoco_item_id, yoco_variant_id) VALUES
      ('burger', 'ws_1', 'Burger', 1, 'yoco', 'prod_burger', 'var_burger'),
      ('coffee', 'ws_1', 'Coffee', 1, 'yoco', 'prod_coffee', 'var_coffee'),
      ('patty_recipe_product', 'ws_1', 'Beef Patty Recipe', 1, 'manual', '', '');
    UPDATE products SET raw_json = '{"yocoModifierGroupIds":["group_global","group_burger"]}' WHERE id = 'burger';
    UPDATE products SET raw_json = '{"yocoModifierGroupIds":["group_global"]}' WHERE id = 'coffee';

    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active) VALUES
      ('recipe_burger', 'ws_1', 'product', 'burger', 1, 1),
      ('recipe_coffee', 'ws_1', 'product', 'coffee', 1, 1),
      ('recipe_patty', 'ws_1', 'product', 'patty_recipe_product', 1, 1),
      ('recipe_extra_patty', 'ws_1', 'yoco_modifier', 'extra_patty', 1, 1),
      ('recipe_extra_sauce', 'ws_1', 'yoco_modifier', 'extra_sauce', 1, 1),
      ('recipe_no_cheese', 'ws_1', 'yoco_modifier', 'no_cheese', 1, 1),
      ('recipe_almond', 'ws_1', 'yoco_modifier', 'almond_swap', 1, 1);

    UPDATE recipes SET linked_product_id = 'patty_recipe_product' WHERE id = 'recipe_extra_patty';

    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order) VALUES
      ('burger_beef', 'ws_1', 'recipe_burger', 'beef', 0.2, 'kg', 1),
      ('burger_cheese', 'ws_1', 'recipe_burger', 'cheese', 1, 'ea', 2),
      ('coffee_dairy', 'ws_1', 'recipe_coffee', 'dairy', 200, 'ml', 1),
      ('patty_beef', 'ws_1', 'recipe_patty', 'beef', 0.2, 'kg', 1);

    INSERT INTO yoco_modifier_groups
      (id, workspace_id, yoco_modifier_group_id, name, raw_json, created_at, updated_at)
      VALUES (
        'group_row', 'ws_1', 'group_catalogue', 'Extras',
        '{"id":"group_catalogue","name":"Extras","options":[{"id":"catalogue_extra_patty","name":"Extra Patty","product_id":"variant_extra_patty"}]}',
        datetime('now'), datetime('now')
      ), (
        'group_option_row', 'ws_1', 'group_options', 'Sauces',
        '{"id":"group_options","name":"Sauces","options":[{"id":"option_extra_sauce","name":"Extra Sauce","type":"option"}]}',
        datetime('now'), datetime('now')
      );
  `);
  return { DB } as any;
}

function noteCanonical(input: {
  orderId: string;
  productId: string;
  note: string;
  quantity?: number;
}): CanonicalSaleCompletedEvent {
  const sale = canonical({
    orderId: input.orderId,
    productId: input.productId,
    quantity: input.quantity,
    modifier: modifier('unused_note_modifier')
  });
  sale.lines[0].modifiers = [];
  sale.lines[0].metadata = {
    raw_note_texts: [input.note],
    normalized_note_texts: [normalizeModifierNote(input.note)]
  };
  return sale;
}

function canonical(input: {
  orderId: string;
  productId: string;
  quantity?: number;
  modifier: CanonicalSaleModifier;
}): CanonicalSaleCompletedEvent {
  return {
    event_id: `event_${input.orderId}`,
    event_type: 'sale.completed',
    source: 'yoco',
    source_version: 'v1',
    workspace_id: 'ws_1',
    integration_id: 'integration_1',
    source_order_id: input.orderId,
    source_location_id: 'yoco_loc_1',
    kcp_location_id: 'loc_1',
    occurred_at: '2026-07-16T12:00:00.000Z',
    received_at: '2026-07-16T12:00:01.000Z',
    currency: 'ZAR',
    gross_amount: 100,
    discount_amount: 0,
    net_amount: 86.96,
    tax_amount: 13.04,
    tip_amount: 0,
    status: 'completed',
    lines: [{
      source_line_id: `line_${input.orderId}`,
      source_product_id: `source_${input.productId}`,
      source_name: input.productId,
      quantity: input.quantity || 1,
      unit_gross_amount: 100,
      gross_amount: 100,
      discount_amount: 0,
      net_amount: 86.96,
      tax_amount: 13.04,
      modifiers: [input.modifier],
      mapping_status: 'MAPPED',
      mapped_menu_item_id: input.productId,
      metadata: {}
    }],
    metadata: {},
    schema_version: '1.0.0',
    resolution_status: 'RESOLVED'
  };
}

function modifier(ownerId: string, sourceId = ownerId): CanonicalSaleModifier {
  return {
    source_modifier_id: sourceId,
    source_name: sourceId,
    quantity: 1,
    gross_amount: 0,
    mapping_status: 'MAPPED',
    mapped_modifier_id: ownerId,
    metadata: {}
  };
}

async function proposals(env: any, sale: CanonicalSaleCompletedEvent) {
  return buildSaleEffectProposals(
    env,
    { id: sale.event_id },
    sale,
    `raw_${sale.source_order_id}`,
    `run_${sale.source_order_id}`
  );
}

test('modifier sale identity resolves through source ids and catalogue variant aliases', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1',
    ownerId: 'extra_patty',
    rule: {
      actionType: 'ADD_RECIPE',
      targetOwnerType: 'yoco_modifier',
      targetOwnerId: 'extra_patty',
      sourceModifierId: 'runtime_selection_id',
      sourceModifierGroupId: 'runtime_group_id',
      sourceModifierVariantId: 'variant_extra_patty',
      sourceName: 'Extra Patty',
      applyAllMatchingProducts: true
    }
  });

  const exact = await resolveModifierMapping(env, 'ws_1', {
    id: 'runtime_selection_id',
    groupId: 'runtime_group_id',
    variantId: 'variant_extra_patty',
    name: 'Extra Patty'
  });
  assert.equal(exact.ownerId, 'extra_patty');
  assert.equal(exact.source, 'rule');

  const catalogue = await resolveModifierMapping(env, 'ws_1', {
    id: 'sale_generated_selection_id',
    groupId: 'different_assignment_group_id',
    variantId: 'variant_extra_patty',
    name: 'Extra Patty'
  });
  assert.equal(catalogue.ownerId, 'extra_patty');
  assert.notEqual(catalogue.source, 'none');

  const uniqueNameFallback = await resolveModifierMapping(env, 'ws_1', {
    id: 'another_runtime_selection_id',
    groupId: 'runtime_assignment_group_not_catalogue_group',
    name: 'Extra Patty'
  });
  assert.equal(uniqueNameFallback.ownerId, 'extra_patty');
  assert.notEqual(uniqueNameFallback.source, 'none');

  const optionModifier = await resolveModifierMapping(env, 'ws_1', {
    id: 'option_extra_sauce',
    groupId: 'group_options',
    name: 'Extra Sauce'
  });
  assert.equal(optionModifier.ownerId, 'extra_sauce');
  assert.notEqual(optionModifier.source, 'none');
});

test('catalogue sync keeps product, option and structured note modifiers for stock setup', () => {
  const group = actionableYocoModifierGroup({
    id: 'group_all',
    options: [
      { id: 'product_modifier', name: 'Extra Patty', type: 'product', product_id: 'variant_patty' },
      { id: 'option_modifier', name: 'No Salt', type: 'option' },
      { id: 'note_modifier', name: 'Kitchen note', type: 'note' }
    ]
  }) as any;
  assert.deepEqual(group.modifiers.map((entry: any) => entry.id), ['product_modifier', 'option_modifier', 'note_modifier']);
  assert.deepEqual(group.modifiers.map((entry: any) => entry._kcp_modifier_kind), ['product', 'option', 'note']);
});

test('type-specific Yoco collections retain product, option and note identities even without per-row type fields', () => {
  const group = actionableYocoModifierGroup({
    id: 'group_typed_collections',
    product_modifiers: [{ id: 'linked_drink', name: 'Linked Drink', product_id: 'drink_variant' }],
    option_modifiers: [{ id: 'extra_ice', name: 'Extra Ice' }],
    note_modifiers: [{ id: 'no_straw', name: 'No Straw' }]
  }) as any;
  assert.deepEqual(group.modifiers.map((entry: any) => entry.id), ['linked_drink', 'extra_ice', 'no_straw']);
  assert.deepEqual(group.modifiers.map((entry: any) => entry._kcp_modifier_kind), ['product', 'option', 'note']);
});

test('structured note modifiers can use the normal stock action engine by stable modifier id', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1', ownerId: 'note_no_salt',
    rule: { actionType: 'ADD_STOCK_ITEM', targetOwnerType: 'stock_item', targetOwnerId: 'sauce', quantity: 5, unit: 'ml', applyAllMatchingProducts: true }
  });
  const rows = await proposals(env, canonical({ orderId: 'structured_note', productId: 'burger', modifier: modifier('note_no_salt') }));
  const movement = rows.find((row: any) => row.modifier_id === 'note_no_salt' && row.ingredient_item_id === 'sauce');
  assert.equal(movement?.quantity, -5);
  assert.equal(movement?.modifier_id, 'note_no_salt');
});

test('ADD_RECIPE follows a linked product recipe and deducts it once per sale quantity', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1', ownerId: 'extra_patty',
    rule: { actionType: 'ADD_RECIPE', targetOwnerType: 'yoco_modifier', targetOwnerId: 'extra_patty', quantity: 1, applyAllMatchingProducts: true }
  });
  const rows = await proposals(env, canonical({ orderId: 'add_recipe', productId: 'burger', quantity: 2, modifier: modifier('extra_patty') }));
  const extra = rows.find((row: any) => row.modifier_id === 'extra_patty' && row.ingredient_item_id === 'beef');
  assert.equal(extra?.quantity, -0.4);
  assert.equal(extra?.warning_code, null);
});

test('ADD_STOCK_ITEM deducts the configured stock item with rule quantity', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1', ownerId: 'extra_sauce',
    rule: { actionType: 'ADD_STOCK_ITEM', targetOwnerType: 'stock_item', targetOwnerId: 'sauce', quantity: 30, unit: 'ml', applyAllMatchingProducts: true }
  });
  const rows = await proposals(env, canonical({ orderId: 'add_stock', productId: 'burger', quantity: 2, modifier: modifier('extra_sauce') }));
  const extra = rows.find((row: any) => row.modifier_id === 'extra_sauce' && row.ingredient_item_id === 'sauce');
  assert.equal(extra?.quantity, -60);
  assert.equal(extra?.base_uom, 'ml');
});

test('REMOVE_INGREDIENT omits the ingredient without writing a reversal movement', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1', ownerId: 'no_cheese',
    rule: { actionType: 'REMOVE_INGREDIENT', sourceStockItemId: 'cheese', menuItemIds: ['burger'], applyAllMatchingProducts: false }
  });
  const rows = await proposals(env, canonical({ orderId: 'remove', productId: 'burger', modifier: modifier('no_cheese') }));
  assert.equal(rows.some((row: any) => row.ingredient_item_id === 'cheese'), false);
  assert.equal(rows.some((row: any) => Number(row.quantity) > 0), false);
  assert.equal(rows.find((row: any) => row.ingredient_item_id === 'beef')?.quantity, -0.2);
});

test('REPLACE_INGREDIENT deducts only the compatible replacement in the removed base-UOM quantity', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1', ownerId: 'almond_swap',
    rule: {
      actionType: 'REPLACE_INGREDIENT',
      sourceStockItemId: 'dairy',
      replacementStockItemId: 'almond',
      menuItemIds: ['coffee'],
      applyAllMatchingProducts: false
    }
  });
  const rows = await proposals(env, canonical({ orderId: 'replace', productId: 'coffee', modifier: modifier('almond_swap') }));
  assert.equal(rows.some((row: any) => row.ingredient_item_id === 'dairy'), false);
  assert.equal(rows.find((row: any) => row.ingredient_item_id === 'almond')?.quantity, -200);
  assert.equal(rows.filter((row: any) => row.warning_code).length, 0);
});

test('menu and location scopes fail closed instead of falling back to legacy modifier deductions', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1', ownerId: 'no_cheese',
    rule: { actionType: 'REMOVE_INGREDIENT', sourceStockItemId: 'cheese', menuItemIds: ['burger'], applyAllMatchingProducts: false }
  });
  const rows = await proposals(env, canonical({ orderId: 'scope', productId: 'coffee', modifier: modifier('no_cheese') }));
  assert.equal(rows.find((row: any) => row.ingredient_item_id === 'dairy')?.quantity, -200);
  assert.equal(rows.some((row: any) => row.modifier_id === 'no_cheese'), false);
  assert.equal(rows.filter((row: any) => row.warning_code).length, 0);
});

test('ADD_STOCK_ITEM validates custom UOMs and converts them to base quantity', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1', ownerId: 'extra_sauce',
    rule: { actionType: 'ADD_STOCK_ITEM', targetOwnerType: 'stock_item', targetOwnerId: 'sauce', quantity: 2, unit: 'pump', applyAllMatchingProducts: true }
  });
  const rows = await proposals(env, canonical({ orderId: 'add_custom_uom', productId: 'burger', quantity: 2, modifier: modifier('extra_sauce') }));
  assert.equal(rows.find((row: any) => row.modifier_id === 'extra_sauce' && row.ingredient_item_id === 'sauce')?.quantity, -120);

  await assert.rejects(() => upsertModifierRule(env, {
    workspaceId: 'ws_1', ownerId: 'bad_sauce_unit',
    rule: { actionType: 'ADD_STOCK_ITEM', targetOwnerType: 'stock_item', targetOwnerId: 'sauce', quantity: 1, unit: 'invalid-carton', applyAllMatchingProducts: true }
  }), /not a valid base or custom UOM/i);
});

test('global remove and replace rules skip matching menu items that do not contain the source ingredient', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1', ownerId: 'global_no_cheese',
    rule: {
      actionType: 'REMOVE_INGREDIENT',
      sourceStockItemId: 'cheese',
      sourceModifierGroupId: 'group_global',
      applyAllMatchingProducts: true
    }
  });
  const coffeeRows = await proposals(env, canonical({ orderId: 'global_skip', productId: 'coffee', modifier: modifier('global_no_cheese') }));
  assert.equal(coffeeRows.find((row: any) => row.ingredient_item_id === 'dairy')?.quantity, -200);
  assert.equal(coffeeRows.some((row: any) => row.modifier_id === 'global_no_cheese'), false);
  assert.equal(coffeeRows.filter((row: any) => row.warning_code).length, 0);
});

test('REPLACE_INGREDIENT supports a larger or smaller replacement quantity multiplier', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1', ownerId: 'almond_swap_more',
    rule: {
      actionType: 'REPLACE_INGREDIENT',
      sourceStockItemId: 'dairy',
      replacementStockItemId: 'almond',
      quantity: 1.25,
      menuItemIds: ['coffee'],
      applyAllMatchingProducts: false
    }
  });
  const rows = await proposals(env, canonical({ orderId: 'replace_more', productId: 'coffee', modifier: modifier('almond_swap_more') }));
  assert.equal(rows.some((row: any) => row.ingredient_item_id === 'dairy'), false);
  assert.equal(rows.find((row: any) => row.ingredient_item_id === 'almond')?.quantity, -250);
});

test('an invalid persisted replacement rule fails closed and preserves the original ingredient deduction', async () => {
  const env = createEnv();
  await env.DB.prepare(
    `INSERT INTO modifier_rules
      (id, workspace_id, modifier_owner_id, action_type, source_stock_item_id, replacement_stock_item_id, quantity, unit, status)
     VALUES ('bad_rule', 'ws_1', 'bad_swap', 'REPLACE_INGREDIENT', 'dairy', 'cheese', 1, 'ea', 'active')`
  ).run();
  const rows = await proposals(env, canonical({ orderId: 'bad_replace', productId: 'coffee', modifier: modifier('bad_swap') }));
  assert.equal(rows.find((row: any) => row.ingredient_item_id === 'dairy')?.quantity, -200);
  assert.equal(rows.some((row: any) => row.warning_code === 'MODIFIER_REPLACEMENT_UOM_INCOMPATIBLE'), true);
});

test('modifier observations are idempotent when the sale payload has no variant id', async () => {
  const env = createEnv();
  const input = {
    workspaceId: 'ws_1',
    sourceOrderId: 'order_observation',
    sourceLineId: 'line_observation',
    identity: { id: 'option_extra_sauce', groupId: 'group_options', name: 'Extra Sauce' },
    ownerId: 'extra_sauce',
    mappingStatus: 'MAPPED',
    raw: { id: 'option_extra_sauce' }
  };
  await observeModifier(env, input);
  await observeModifier(env, input);
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM modifier_observations WHERE workspace_id = 'ws_1' AND source_order_id = 'order_observation'`
  ).first<any>();
  assert.equal(Number(count?.count), 1);
});


test('note observation uses exact harmless normalization, appears after three orders, and supports ignore and restore', async () => {
  const env = createEnv();
  assert.equal(normalizeModifierNote('  Almond-Milk!!!  '), 'almond milk');
  assert.notEqual(normalizeModifierNote('No almond milk'), normalizeModifierNote('Almond Milk'));
  assert.notEqual(normalizeModifierNote('Extra almond milk'), normalizeModifierNote('Almond Milk'));

  for (const [index, note] of ['Almond Milk', ' almond   milk ', 'ALMOND-MILK!'].entries()) {
    await observeLineNotes(env, {
      workspaceId: 'ws_1',
      sourceOrderId: `note_order_${index}`,
      sourceLineId: `note_line_${index}`,
      menuItemId: 'coffee',
      locationId: 'loc_1',
      notes: [note],
      observedAt: `2026-07-16T12:0${index}:00.000Z`
    });
  }

  // Reprocessing the same line is idempotent and must not inflate the suggestion count.
  await observeLineNotes(env, {
    workspaceId: 'ws_1',
    sourceOrderId: 'note_order_2',
    sourceLineId: 'note_line_2',
    menuItemId: 'coffee',
    locationId: 'loc_1',
    notes: ['Almond milk']
  });

  let suggestions = await listModifierNoteSuggestions(env, 'ws_1');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].normalizedText, 'almond milk');
  assert.equal(suggestions[0].timesSeen, 3);
  assert.deepEqual(suggestions[0].menuItemIds, ['coffee']);
  assert.deepEqual(suggestions[0].locationIds, ['loc_1']);

  await setModifierNoteDisposition(env, {
    workspaceId: 'ws_1', noteText: 'Almond Milk', disposition: 'IGNORED'
  });
  suggestions = await listModifierNoteSuggestions(env, 'ws_1');
  assert.equal(suggestions.length, 0);
  const ignored = await listModifierNoteSuggestions(env, 'ws_1', { includeIgnored: true });
  assert.equal(ignored[0].disposition, 'IGNORED');

  await setModifierNoteDisposition(env, {
    workspaceId: 'ws_1', noteText: 'Almond Milk', disposition: 'SUGGESTED'
  });
  suggestions = await listModifierNoteSuggestions(env, 'ws_1');
  assert.equal(suggestions[0].disposition, 'SUGGESTED');
});

test('approved note rules apply only to the exact normalized phrase and snapshot their version', async () => {
  const env = createEnv();
  const saved = await upsertModifierNoteRule(env, {
    workspaceId: 'ws_1',
    noteText: 'Almond Milk',
    actor: 'admin_1',
    rule: {
      actionType: 'REPLACE_INGREDIENT',
      sourceStockItemId: 'dairy',
      replacementStockItemId: 'almond',
      menuItemIds: ['coffee'],
      locationIds: ['loc_1'],
      applyAllMatchingProducts: false
    }
  });
  assert.equal(saved.version, 1);

  const exact = await proposals(env, noteCanonical({
    orderId: 'note_exact', productId: 'coffee', note: '  ALMOND-MILK! '
  }));
  assert.equal(exact.some((row: any) => row.ingredient_item_id === 'dairy'), false);
  assert.equal(exact.find((row: any) => row.ingredient_item_id === 'almond')?.quantity, -200);
  assert.ok(exact.some((row: any) => String(row.modifier_id).startsWith('note:')));

  const snapshot = env.DB.database.prepare(
    `SELECT modifier_rule_id, modifier_rule_version, modifier_action_type, rule_snapshot_json
       FROM modifier_sale_movement_snapshots
      WHERE workspace_id = 'ws_1' AND source_order_id = 'note_exact' AND modifier_id LIKE 'note:%'`
  ).get() as any;
  assert.equal(snapshot.modifier_rule_id, saved.id);
  assert.equal(snapshot.modifier_rule_version, 1);
  assert.equal(snapshot.modifier_action_type, 'REPLACE_INGREDIENT');
  assert.equal(JSON.parse(snapshot.rule_snapshot_json).normalized_text, 'almond milk');

  for (const [orderId, note] of [['note_no', 'No almond milk'], ['note_extra', 'Extra almond milk']]) {
    const rows = await proposals(env, noteCanonical({ orderId, productId: 'coffee', note }));
    assert.equal(rows.find((row: any) => row.ingredient_item_id === 'dairy')?.quantity, -200);
    assert.equal(rows.some((row: any) => row.ingredient_item_id === 'almond'), false);
    assert.equal(rows.some((row: any) => String(row.modifier_id).startsWith('note:')), false);
  }

  const applicable = await getApplicableNoteRules(env, {
    workspaceId: 'ws_1',
    normalizedNotes: ['almond milk', 'no almond milk', 'extra almond milk'],
    menuItemId: 'coffee',
    locationId: 'loc_1'
  });
  assert.equal(applicable.length, 1);
  assert.equal(applicable[0].normalized_text, 'almond milk');
});

test('modifier observation mode records old-versus-new line diagnostics without double-writing stock', async () => {
  const env = createEnv();
  await setModifierEngineMode(env, {
    workspaceId: 'ws_1', mode: 'OBSERVE', actor: 'admin_1', reason: 'Pilot comparison'
  });
  env.DB.database.prepare(
    `INSERT INTO stock_movements
      (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
       quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
     VALUES (?, 'ws_1', 'beef', 'loc_1', 'sale_depletion', 'yoco_order', ?, -0.2, 100, -20,
       '2026-07-16T12:00:00.000Z', 'legacy-yoco', ?, '2026-07-16T12:00:00.000Z')`
  ).run('legacy_observe_movement', 'observe_match', JSON.stringify({ source_line_id: 'line_observe_match', engine: 'LEGACY' }));
  env.DB.database.prepare(
    `INSERT INTO stock_movements
      (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
       quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
     VALUES (?, 'ws_1', 'cheese', 'loc_1', 'sale_depletion', 'yoco_order', ?, -1, 5, -5,
       '2026-07-16T12:00:00.000Z', 'legacy-yoco', ?, '2026-07-16T12:00:00.000Z')`
  ).run('legacy_observe_cheese', 'observe_match', JSON.stringify({ source_line_id: 'line_observe_match', engine: 'LEGACY' }));

  const sale = canonical({
    orderId: 'observe_match', productId: 'burger', modifier: modifier('unmapped_observe_modifier')
  });
  sale.lines[0].source_line_id = 'line_observe_match';
  sale.lines[0].modifiers = [];
  const beforeMovementCount = Number((env.DB.database.prepare(`SELECT COUNT(*) AS count FROM stock_movements`).get() as any).count);
  await proposals(env, sale);
  const afterMovementCount = Number((env.DB.database.prepare(`SELECT COUNT(*) AS count FROM stock_movements`).get() as any).count);
  assert.equal(afterMovementCount, beforeMovementCount);

  const diagnostics = await listModifierEngineDiagnostics(env, 'ws_1');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].order, 'observe_match');
  assert.equal(diagnostics[0].status, 'MATCH');
  assert.equal(diagnostics[0].reason, 'MATCH');
  assert.ok(Array.isArray(diagnostics[0].oldResolvedUsage));
  assert.ok(Array.isArray(diagnostics[0].newResolvedUsage));
});

test('observation keeps the existing modifier baseline authoritative until live cutover and supports rollback', async () => {
  const env = createEnv();
  await upsertModifierRule(env, {
    workspaceId: 'ws_1',
    ownerId: 'extra_patty',
    rule: {
      actionType: 'NO_STOCK_CHANGE',
      applyAllMatchingProducts: true,
    },
  });
  await setModifierEngineMode(env, {
    workspaceId: 'ws_1', mode: 'OBSERVE', actor: 'admin_1', reason: 'Compare baseline to new rule'
  });

  const observed = await proposals(env, canonical({
    orderId: 'observe_baseline_writer', productId: 'burger', modifier: modifier('extra_patty')
  }));
  assert.equal(
    observed.find((row: any) => row.modifier_id === 'extra_patty' && row.ingredient_item_id === 'beef')?.quantity,
    -0.2,
  );
  const observedDiagnostics = await listModifierEngineDiagnostics(env, 'ws_1');
  assert.equal(observedDiagnostics[0].status, 'MISMATCH');
  assert.equal(observedDiagnostics[0].reason, 'QUANTITY_DIFFERENCE');

  await setModifierEngineMode(env, {
    workspaceId: 'ws_1', mode: 'LIVE', actor: 'admin_1', reason: 'Validated cutover', rollbackHours: 72
  });
  const live = await proposals(env, canonical({
    orderId: 'live_new_writer', productId: 'burger', modifier: modifier('extra_patty')
  }));
  assert.equal(live.some((row: any) => row.modifier_id === 'extra_patty'), false);

  await setModifierEngineMode(env, {
    workspaceId: 'ws_1', mode: 'ROLLED_BACK', actor: 'admin_1', reason: 'Temporary rollback'
  });
  const rolledBack = await proposals(env, canonical({
    orderId: 'rollback_baseline_writer', productId: 'burger', modifier: modifier('extra_patty')
  }));
  assert.equal(
    rolledBack.find((row: any) => row.modifier_id === 'extra_patty' && row.ingredient_item_id === 'beef')?.quantity,
    -0.2,
  );
});

test('refund reversal ignores sale snapshots that were proposed but never applied', async () => {
  const env = createEnv();
  env.DB.database.prepare(
    `INSERT INTO modifier_sale_movement_snapshots
      (id,workspace_id,domain_event_id,source_order_id,source_line_id,menu_item_id,
       ingredient_item_id,location_id,original_line_quantity,movement_quantity,base_uom,
       unit_cost_ex_vat,movement_value,proposal_key,rule_snapshot_json,status,created_at,updated_at)
     VALUES ('unapplied_snapshot','ws_1','event_unapplied','order_unapplied','line_unapplied','burger',
       'beef','loc_1',1,-0.2,'kg',100,-20,'proposal_unapplied','{}','PROPOSED',
       '2026-07-16T12:00:00.000Z','2026-07-16T12:00:00.000Z')`
  ).run();

  const reversals = await loadSaleMovementReversals(env, {
    workspaceId: 'ws_1',
    sourceOrderId: 'order_unapplied',
    sourceLineId: 'line_unapplied',
    refundQuantity: 1,
    originalLineQuantity: 1,
  });
  assert.deepEqual(reversals, []);
});
