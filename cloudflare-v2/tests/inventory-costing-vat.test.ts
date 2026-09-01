import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import {
  getWorkspaceEffectiveVatRate,
  isWorkspaceVatRegistered,
  loadVatEnabledByStockItemId,
  sumVatAwareLineTotals,
} from '../src/legacy/inventory-costing';

// Regression: VAT on stock items (GRV/PO/Credit Note) must always follow each item's own
// vat_enabled flag (bread never VATable, beer always is), independent of whether the WORKSPACE is
// VAT registered — a non-registered business still pays real VAT to a VAT-registered supplier, it
// just can't reclaim it. getWorkspaceEffectiveVatRate used to return 0 outright for a non-
// registered workspace, wiping out that per-item distinction for everyone at once.

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

function createEnv({ vatRate = 15, vatRegistered = 1 }: { vatRate?: number; vatRegistered?: number } = {}) {
  const DB = new SqliteDb();
  DB.database.exec(TENANT_SCHEMA_SQL);
  // vat_registered is added by a later tenant migration, not the baseline schema — see
  // tenant-migrations.ts:578.
  DB.database.exec(`ALTER TABLE workspace_settings ADD COLUMN vat_registered INTEGER NOT NULL DEFAULT 1;`);
  DB.database.prepare(
    `INSERT INTO workspace_settings (workspace_id, vat_rate, vat_registered) VALUES ('ws_1', ?1, ?2)`,
  ).run(vatRate, vatRegistered);
  DB.database.prepare(
    `INSERT INTO stock_items (id, workspace_id, name, vat_enabled) VALUES ('bread', 'ws_1', 'Bread', 0)`,
  ).run();
  DB.database.prepare(
    `INSERT INTO stock_items (id, workspace_id, name, vat_enabled) VALUES ('beer', 'ws_1', 'Beer', 1)`,
  ).run();
  return { DB } as any;
}

test('getWorkspaceEffectiveVatRate returns the real configured rate for a VAT-registered workspace', async () => {
  const env = createEnv({ vatRate: 15, vatRegistered: 1 });
  assert.equal(await getWorkspaceEffectiveVatRate(env, 'ws_1'), 0.15);
});

test('getWorkspaceEffectiveVatRate returns the SAME real rate for a NON-registered workspace (no longer zeroed)', async () => {
  const env = createEnv({ vatRate: 15, vatRegistered: 0 });
  assert.equal(await getWorkspaceEffectiveVatRate(env, 'ws_1'), 0.15);
});

test('isWorkspaceVatRegistered reflects the stored flag', async () => {
  assert.equal(await isWorkspaceVatRegistered(createEnv({ vatRegistered: 1 }), 'ws_1'), true);
  assert.equal(await isWorkspaceVatRegistered(createEnv({ vatRegistered: 0 }), 'ws_1'), false);
});

test('loadVatEnabledByStockItemId reports each item\'s real vat_enabled flag, and defaults an unknown item to VATable', async () => {
  const env = createEnv();
  const map = await loadVatEnabledByStockItemId(env, 'ws_1', ['bread', 'beer', 'unknown_item']);
  assert.equal(map.get('bread'), false);
  assert.equal(map.get('beer'), true);
  assert.equal(map.has('unknown_item'), false); // caller treats a missing entry as VATable too
});

test('a PO/GRV with mixed VATable and non-VATable stock items computes VAT per line, not a flat rate on the whole order', () => {
  const vatEnabled = new Map([['bread', false], ['beer', true]]);
  const totals = sumVatAwareLineTotals(
    [
      { stockItemId: 'bread', lineTotalEx: 100 },
      { stockItemId: 'beer', lineTotalEx: 100 },
    ],
    0.15,
    vatEnabled,
  );
  // Only beer's line carries VAT — bread's stays untouched.
  assert.equal(totals.totalEx, 200);
  assert.equal(totals.totalVat, 15); // 100 * 0.15, not 200 * 0.15
  assert.equal(totals.totalInc, 215);
});

test('a non-VAT-registered business still applies VAT correctly per item: bread = no VAT, beer = real VAT', () => {
  // Registered-business submission: lines are genuine ex-VAT amounts (Purchase Orders always;
  // GRVs when the workspace IS registered) — linesAreAlreadyVatInclusive stays false (default).
  const vatEnabled = new Map([['bread', false], ['beer', true]]);
  const registered = sumVatAwareLineTotals(
    [
      { stockItemId: 'bread', lineTotalEx: 50 },
      { stockItemId: 'beer', lineTotalEx: 50 },
    ],
    0.15,
    vatEnabled,
    false,
  );
  assert.equal(registered.totalVat, 7.5); // 50 * 0.15, beer only
  assert.equal(registered.totalInc, 107.5);

  // Non-registered GRV submission: GRVEntry.js's finalizeReceivedCost has already folded VAT into
  // beer's submitted cost (57.5 = 50 * 1.15), bread stays untouched at 50 (never VATable).
  const notRegistered = sumVatAwareLineTotals(
    [
      { stockItemId: 'bread', lineTotalEx: 50 },
      { stockItemId: 'beer', lineTotalEx: 57.5 },
    ],
    0.15,
    vatEnabled,
    true,
  );
  assert.ok(Math.abs(notRegistered.totalVat - 7.5) < 1e-9, `expected ~7.5, got ${notRegistered.totalVat}`);
  assert.ok(Math.abs(notRegistered.totalEx - 100) < 1e-9, `expected ~100, got ${notRegistered.totalEx}`);
  // Crucially, totalInc equals what was ACTUALLY paid (107.5) — not double-counted to ~115.75
  // (which is what naively adding 15% on top of the already-inclusive 57.5 would have produced).
  assert.ok(Math.abs(notRegistered.totalInc - 107.5) < 1e-9, `expected ~107.5, got ${notRegistered.totalInc}`);
});

test('regression: an all-VATable order gives the same total under per-line math as the old flat-rate math (VAT-registered, unchanged behavior)', () => {
  const vatEnabled = new Map([['beer1', true], ['beer2', true]]);
  const totals = sumVatAwareLineTotals(
    [
      { stockItemId: 'beer1', lineTotalEx: 60 },
      { stockItemId: 'beer2', lineTotalEx: 40 },
    ],
    0.15,
    vatEnabled,
  );
  assert.equal(totals.totalEx, 100);
  assert.equal(totals.totalVat, 15); // same as the old flat totalEx * vatRate for an all-VATable order
  assert.equal(totals.totalInc, 115);
});

test('a non-VATable-only order never carries VAT, registered or not', () => {
  const vatEnabled = new Map([['bread1', false], ['bread2', false]]);
  const items = [
    { stockItemId: 'bread1', lineTotalEx: 30 },
    { stockItemId: 'bread2', lineTotalEx: 20 },
  ];
  const registered = sumVatAwareLineTotals(items, 0.15, vatEnabled, false);
  const notRegistered = sumVatAwareLineTotals(items, 0.15, vatEnabled, true);
  assert.equal(registered.totalVat, 0);
  assert.equal(notRegistered.totalVat, 0);
  assert.equal(registered.totalInc, 50);
  assert.equal(notRegistered.totalInc, 50);
});
