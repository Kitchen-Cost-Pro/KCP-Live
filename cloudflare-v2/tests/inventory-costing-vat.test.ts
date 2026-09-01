import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import {
  applyProRataDiscount,
  computeGrvTotals,
  getWorkspaceEffectiveVatRate,
  isSupplierVatRegistered,
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
  DB.database.prepare(
    `INSERT INTO suppliers (id, workspace_id, name, raw_json) VALUES ('sup_registered', 'ws_1', 'Registered Supplier', '{"vatRegistered":true}')`,
  ).run();
  DB.database.prepare(
    `INSERT INTO suppliers (id, workspace_id, name, raw_json) VALUES ('sup_not_registered', 'ws_1', 'Cash Supplier', '{"vatRegistered":false}')`,
  ).run();
  DB.database.prepare(
    `INSERT INTO suppliers (id, workspace_id, name, raw_json) VALUES ('sup_no_flag', 'ws_1', 'Legacy Supplier', '{}')`,
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

// applyProRataDiscount — a GRV header-level discount (GRVEntry.js's "Discount (Ex)" field) must
// reduce taxable and non-taxable spend in proportion to their share of the pre-discount subtotal,
// mirroring calculateDraftTotals exactly, not apply at one flat rate to the whole discount.

test('applyProRataDiscount on an all-VATable order reduces the taxable base by the full discount', () => {
  const vatEnabled = new Map([['beer', true]]);
  const preDiscount = sumVatAwareLineTotals([{ stockItemId: 'beer', lineTotalEx: 100 }], 0.15, vatEnabled);
  const result = applyProRataDiscount(preDiscount, 20, 0.15);
  assert.ok(Math.abs(result.totalEx - 80) < 1e-9);
  assert.ok(Math.abs(result.totalVat - 12) < 1e-9); // 80 * 0.15
  assert.ok(Math.abs(result.totalInc - 92) < 1e-9);
});

test('applyProRataDiscount on a mixed VATable/exempt order splits the discount by taxable share', () => {
  // 60 taxable + 40 exempt = 100 subtotal; a 10 discount removes 6 from taxable, 4 from exempt.
  const vatEnabled = new Map([['beer', true], ['bread', false]]);
  const preDiscount = sumVatAwareLineTotals(
    [{ stockItemId: 'beer', lineTotalEx: 60 }, { stockItemId: 'bread', lineTotalEx: 40 }],
    0.15,
    vatEnabled,
  );
  const result = applyProRataDiscount(preDiscount, 10, 0.15);
  assert.ok(Math.abs(result.taxableEx - 54) < 1e-9, `expected ~54, got ${result.taxableEx}`); // 60 - 6
  assert.ok(Math.abs(result.totalEx - 90) < 1e-9); // 100 - 10
  assert.ok(Math.abs(result.totalVat - 8.1) < 1e-9, `expected ~8.1, got ${result.totalVat}`); // 54 * 0.15
});

test('applyProRataDiscount is a no-op when the discount is 0', () => {
  const vatEnabled = new Map([['beer', true]]);
  const preDiscount = sumVatAwareLineTotals([{ stockItemId: 'beer', lineTotalEx: 100 }], 0.15, vatEnabled);
  assert.deepEqual(applyProRataDiscount(preDiscount, 0, 0.15), preDiscount);
});

// computeGrvTotals — the shared item + transport + discount total, used by postGoodsReceipt,
// loadGrvDetail, and the Xero GRV push so this math can't diverge across call sites again.
//
// Regression this covers: `transport_ex` was previously fed through `sumVatAwareLineTotals`
// alongside stock items using the workspace-registration-dependent `linesAreAlreadyVatInclusive`
// flag — i.e. for a non-registered workspace, transport's ex-VAT/VAT split was backed OUT of it
// like a folded stock-item cost. But "Transport (Ex)" (confirmed with David 2026-09-01, same as
// "Discount (Ex)") is ALWAYS a genuine ex-VAT figure regardless of registration — VAT is always
// added on top, and only becomes non-reclaimable (folded into the final total) once the workspace
// itself isn't registered. Backing it out instead silently dropped the transport line's own VAT
// from the total.

test('computeGrvTotals: VAT-registered workspace — transport and discount behave exactly as before this fix (unchanged)', () => {
  const vatEnabled = new Map([['water', true], ['bread', false]]);
  const result = computeGrvTotals({
    items: [
      { stockItemId: 'bread', lineTotalEx: 100 },
      { stockItemId: 'water', lineTotalEx: 100 }
    ],
    vatRate: 0.15,
    vatEnabledByStockItemId: vatEnabled,
    linesAreAlreadyVatInclusive: false,
    supplierIsVatRegistered: true,
    transportEx: 100,
    discountEx: 50
  });
  // Pre-discount: bread 100/0, water 100/15, transport 100/15 -> totalEx 300, totalVat 30, taxableEx 200.
  // Discount 50 pro-rated: taxableShare = 50*(200/300) = 33.333; totalEx = 300-50 = 250; totalVat = (200-33.333)*0.15 = 25.
  assert.ok(Math.abs(result.totalEx - 250) < 1e-6, `expected totalEx ~250, got ${result.totalEx}`);
  assert.ok(Math.abs(result.totalVat - 25) < 1e-6, `expected totalVat ~25, got ${result.totalVat}`);
  assert.ok(Math.abs(result.totalInc - 275) < 1e-6, `expected totalInc ~275, got ${result.totalInc}`);
  assert.ok(Math.abs(result.transportVat - 15) < 1e-9);
});

test('computeGrvTotals: the exact live regression — non-registered workspace, mixed item, transport, and discount', () => {
  const vatEnabled = new Map([['water', true], ['bread', false]]);
  const result = computeGrvTotals({
    items: [
      { stockItemId: 'bread', lineTotalEx: 100 }, // not VATable, passes through untouched
      { stockItemId: 'water', lineTotalEx: 115 }  // VAT-inclusive item, folds to 100 ex / 15 VAT
    ],
    vatRate: 0.15,
    vatEnabledByStockItemId: vatEnabled,
    linesAreAlreadyVatInclusive: true, // non-registered workspace: ITEM lines are inclusive-typed
    supplierIsVatRegistered: true,
    transportEx: 100, // always ex-VAT, regardless of registration
    discountEx: 50    // always ex-VAT, regardless of registration
  });
  // Correct answer, confirmed against real supplier math: transport adds R15 VAT (non-reclaimable
  // but real) -> true pre-discount total R330; a R50 ex-VAT discount pro-rated over the R200
  // taxable/R300 total base removes R55 of real value -> true final total R275.00. NOT R265
  // (transport's VAT dropped) or R260.11 (both bugs at once) — both were live production bugs.
  assert.ok(Math.abs(result.totalEx - 250) < 1e-6, `expected totalEx ~250, got ${result.totalEx}`);
  assert.ok(Math.abs(result.totalVat - 25) < 1e-6, `expected totalVat ~25, got ${result.totalVat}`);
  assert.ok(Math.abs(result.totalInc - 275) < 1e-6, `expected the true cash total ~275, got ${result.totalInc}`);
  assert.ok(Math.abs(result.transportEx - 100) < 1e-9);
  assert.ok(Math.abs(result.transportVat - 15) < 1e-9, `transport must still carry its own VAT even though the workspace can't reclaim it`);
  assert.ok(Math.abs(result.transportInc - 115) < 1e-9);
  assert.ok(Math.abs(result.discountIncImpact - -55) < 1e-6, `the discount's true cash impact must include its own VAT share, expected ~-55, got ${result.discountIncImpact}`);
});

test('computeGrvTotals: transport carries no VAT at all when the supplier itself is not VAT-registered', () => {
  const vatEnabled = new Map([['water', true]]);
  const result = computeGrvTotals({
    items: [{ stockItemId: 'water', lineTotalEx: 100 }],
    vatRate: 0.15,
    vatEnabledByStockItemId: vatEnabled,
    linesAreAlreadyVatInclusive: false,
    supplierIsVatRegistered: false,
    transportEx: 50,
    discountEx: 0
  });
  assert.equal(result.transportVat, 0);
  assert.equal(result.transportInc, 50);
  assert.ok(Math.abs(result.totalInc - 150) < 1e-9);
});

test('computeGrvTotals: zero transport and zero discount is a pure pass-through of the item totals', () => {
  const vatEnabled = new Map([['beer', true]]);
  const result = computeGrvTotals({
    items: [{ stockItemId: 'beer', lineTotalEx: 100 }],
    vatRate: 0.15,
    vatEnabledByStockItemId: vatEnabled,
    linesAreAlreadyVatInclusive: false,
    supplierIsVatRegistered: true,
    transportEx: 0,
    discountEx: 0
  });
  assert.equal(result.transportVat, 0);
  assert.equal(result.discountIncImpact, 0);
  assert.ok(Math.abs(result.totalInc - 115) < 1e-9);
});

// isSupplierVatRegistered / the supplierIsVatRegistered gate on sumVatAwareLineTotals — a
// non-VAT-registered supplier never charges VAT on anything they sell, regardless of the item.

test('isSupplierVatRegistered reflects the supplier\'s own raw_json flag', async () => {
  const env = createEnv();
  assert.equal(await isSupplierVatRegistered(env, 'ws_1', 'sup_registered'), true);
  assert.equal(await isSupplierVatRegistered(env, 'ws_1', 'sup_not_registered'), false);
});

test('isSupplierVatRegistered defaults to true when the flag is unset or there is no supplier', async () => {
  const env = createEnv();
  assert.equal(await isSupplierVatRegistered(env, 'ws_1', 'sup_no_flag'), true);
  assert.equal(await isSupplierVatRegistered(env, 'ws_1', 'unknown_supplier'), true);
  assert.equal(await isSupplierVatRegistered(env, 'ws_1', ''), true);
});

test('a non-VAT-registered supplier zeroes VAT on a beer line, even though beer is normally VATable', () => {
  const vatEnabled = new Map([['beer', true]]);
  const registered = sumVatAwareLineTotals([{ stockItemId: 'beer', lineTotalEx: 100 }], 0.15, vatEnabled, false, true);
  const notRegistered = sumVatAwareLineTotals([{ stockItemId: 'beer', lineTotalEx: 100 }], 0.15, vatEnabled, false, false);
  assert.equal(registered.totalVat, 15);
  assert.equal(notRegistered.totalVat, 0);
  assert.equal(notRegistered.totalEx, 100); // the ex-VAT cost itself is unaffected, only the tax
  assert.equal(notRegistered.totalInc, 100);
});

test('a non-VAT-registered supplier gate applies to every line uniformly, bread and beer alike', () => {
  const vatEnabled = new Map([['beer', true], ['bread', false]]);
  const items = [{ stockItemId: 'beer', lineTotalEx: 60 }, { stockItemId: 'bread', lineTotalEx: 40 }];
  const notRegistered = sumVatAwareLineTotals(items, 0.15, vatEnabled, false, false);
  assert.equal(notRegistered.totalVat, 0);
  assert.equal(notRegistered.taxableEx, 0);
  assert.equal(notRegistered.totalEx, 100);
});
