import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import {
  YOCO_V2_CONTROLLED_CUTOVER_MIGRATION,
  YOCO_V2_EFFECT_GATE_MIGRATION,
  YOCO_V2_FOUNDATION_MIGRATION,
  YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION,
} from '../src/modules/yoco-engine-v2/migrations';
import {
  assertAllYocoEffectsOwnedByV2,
  migrateYocoV2EffectOwnershipForConnection,
} from '../src/modules/yoco-engine-v2/ownership';

class SqliteStatement implements DbStatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): DbStatementLike {
    const next = new SqliteStatement(this.database, this.sql);
    next.values = values.map((value) => value === undefined ? null : value);
    return next;
  }

  private materialize(): { sql: string; values: unknown[] } {
    const values: unknown[] = [];
    const sql = this.sql.replace(/\?(\d+)/g, (_match, index) => {
      values.push(this.values[Number(index) - 1] ?? null);
      return '?';
    });
    return { sql, values: values.length ? values : this.values };
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

  prepare(query: string): DbStatementLike {
    return new SqliteStatement(this.database, query);
  }

  async batch<T = Record<string, unknown>>(statements: DbStatementLike[]): Promise<Array<DbResult<T>>> {
    this.database.exec('BEGIN');
    try {
      const results: Array<DbResult<T>> = [];
      for (const statement of statements) results.push(await statement.run<T>());
      this.database.exec('COMMIT');
      return results;
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
  }
}

function createDb(): SqliteDb {
  const db = new SqliteDb();
  db.database.exec(YOCO_V2_FOUNDATION_MIGRATION);
  db.database.exec(YOCO_V2_CONTROLLED_CUTOVER_MIGRATION);
  db.database.exec(YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION);
  // Phase V2 14 unified the separate sale/refund cutover tables into yoco_v2_effect_gate, and
  // effectControlStatement() in ownership.ts writes to it. Production always has it — it is
  // TENANT_MIGRATIONS index 35 AND part of YOCO_V2_RUNTIME_SCHEMA_REPAIR — but this harness was
  // never updated, so these tests failed on "no such table: yoco_v2_effect_gate" against code
  // that is correct in production.
  db.database.exec(YOCO_V2_EFFECT_GATE_MIGRATION);
  return db;
}

const EFFECTS = ['SALE_REPORTING', 'SALE_STOCK', 'REFUND_REPORTING', 'REFUND_STOCK'];

test('authorised connect performs a one-way migration from historic ownership rows to V2', async () => {
  const db = createDb();
  const insert = db.database.prepare(`
    INSERT INTO integration_effect_ownership
      (workspace_id, integration_type, effect_type, engine_version, enabled, enabled_at, enabled_by, updated_at)
    VALUES ('ws_legacy', 'YOCO', ?, 'LEGACY', 1, datetime('now'), 'old-runtime', datetime('now'))
  `);
  for (const effect of EFFECTS) insert.run(effect);

  const result = await migrateYocoV2EffectOwnershipForConnection(
    db,
    'ws_legacy',
    'yoco:ws_legacy',
    'manager_1',
  );

  assert.equal(result.ownershipMigrated, true);
  assert.deepEqual([...result.migratedEffects].sort(), [...EFFECTS].sort());
  assert.deepEqual(result.initializedEffects, []);
  await assertAllYocoEffectsOwnedByV2(db, 'ws_legacy');

  const ownership = db.database.prepare(`
    SELECT effect_type, engine_version, enabled, enabled_by
      FROM integration_effect_ownership
     WHERE workspace_id = 'ws_legacy'
     ORDER BY effect_type
  `).all() as Array<Record<string, unknown>>;
  assert.equal(ownership.length, 4);
  assert.ok(ownership.every((row) => row.engine_version === 'V2' && Number(row.enabled) === 1));
  assert.ok(ownership.every((row) => row.enabled_by === 'manager_1'));

  const saleControls = db.database.prepare(`
    SELECT effect_type, feature_enabled, consumption_paused, cutover_at, activated_by
      FROM yoco_v2_effect_controls
     WHERE workspace_id = 'ws_legacy'
     ORDER BY effect_type
  `).all() as Array<Record<string, unknown>>;
  const refundControls = db.database.prepare(`
    SELECT effect_type, feature_enabled, consumption_paused, cutover_at, activated_by
      FROM yoco_v2_refund_effect_controls
     WHERE workspace_id = 'ws_legacy'
     ORDER BY effect_type
  `).all() as Array<Record<string, unknown>>;
  assert.equal(saleControls.length, 2);
  assert.equal(refundControls.length, 2);
  assert.ok([...saleControls, ...refundControls].every((row) => (
    Number(row.feature_enabled) === 1
    && Number(row.consumption_paused) === 0
    && Boolean(row.cutover_at)
    && row.activated_by === 'manager_1'
  )));

  const saleHistory = Number((db.database.prepare(`SELECT COUNT(*) count FROM yoco_v2_cutover_history`).get() as { count: number }).count);
  const refundHistory = Number((db.database.prepare(`SELECT COUNT(*) count FROM yoco_v2_refund_cutover_history`).get() as { count: number }).count);
  assert.equal(saleHistory, 2);
  assert.equal(refundHistory, 2);
});

test('V2 ownership connect migration is idempotent and does not duplicate cutover history', async () => {
  const db = createDb();
  db.database.prepare(`
    INSERT INTO integration_effect_ownership
      (workspace_id, integration_type, effect_type, engine_version, enabled, updated_at)
    VALUES ('ws_retry', 'YOCO', 'SALE_REPORTING', 'LEGACY', 1, datetime('now'))
  `).run();

  const first = await migrateYocoV2EffectOwnershipForConnection(db, 'ws_retry', 'yoco:ws_retry', 'manager_1');
  const second = await migrateYocoV2EffectOwnershipForConnection(db, 'ws_retry', 'yoco:ws_retry', 'manager_1');

  assert.equal(first.changedEffects.length, 4);
  assert.equal(second.changedEffects.length, 0);
  assert.equal(second.ownershipMigrated, false);
  assert.equal(Number((db.database.prepare(`SELECT COUNT(*) count FROM yoco_v2_cutover_history`).get() as { count: number }).count), 1);
  assert.equal(Number((db.database.prepare(`SELECT COUNT(*) count FROM yoco_v2_refund_cutover_history`).get() as { count: number }).count), 0);
  await assertAllYocoEffectsOwnedByV2(db, 'ws_retry');
});
