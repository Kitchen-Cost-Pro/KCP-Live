import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { splitSqlStatements, isRetryableAddColumnError } from '../src/d1-facade';
import { TENANT_MIGRATIONS } from '../src/tenant-migrations';
import type { AuthContext, DbLike, DbResult, DbStatementLike, Env } from '../src/legacy/types';
import * as routes from '../src/legacy/routes';

// Integration coverage for the actual DB-wired SQL in patchGoodsReceipt/patchCreditNote — the
// reversal+reapply statement construction, the negative-balance guard, the same-day cost
// correction wiring, and the PO over-return guard — none of which the pure-function tests in
// grv-same-day-cost-correction.test.ts can see, since that file only exercises
// replaySameDayCostCorrections in isolation. Runs the ACTUAL exported route handlers against a
// real in-memory SQLite database built from the full TENANT_MIGRATIONS chain, same approach as
// tests/write-cost-audit.ts.

class SqliteStatement implements DbStatementLike {
  private values: unknown[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]): DbStatementLike {
    const statement = new SqliteStatement(this.database, this.sql);
    statement.values = values.map((value) =>
      value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value,
    );
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

function applyMigration(database: DatabaseSync, script: string) {
  for (const raw of splitSqlStatements(script)) {
    const statement = raw.trim();
    if (!statement) continue;
    try {
      database.exec(statement);
    } catch (cause) {
      if (isRetryableAddColumnError(statement, cause)) continue;
      throw cause;
    }
  }
}

const WORKSPACE = 'ws_1';
const AUTH: AuthContext = { uid: 'uid_super', email: 'super@kcp.test', token: {} };

function createEnv() {
  const tenant = new DatabaseSync(':memory:');
  for (const migration of TENANT_MIGRATIONS) applyMigration(tenant, migration);

  const central = new DatabaseSync(':memory:');
  central.exec(`
    CREATE TABLE admin_users (id TEXT PRIMARY KEY, auth_uid TEXT, email TEXT, role_key TEXT, status TEXT);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_uid TEXT, status TEXT, name TEXT);
    CREATE TABLE workspace_members (id TEXT PRIMARY KEY, workspace_id TEXT, auth_uid TEXT, email TEXT,
      display_name TEXT, role_key TEXT, status TEXT, allowed_locations_json TEXT);
  `);
  // transaction-references.ts's ensureSchema() caches its "ready" state at module scope (a plain
  // `let schemaReady` shared across every call in this process) — the first test in this file to
  // touch it creates these tables in ITS central DB, then every later test's fresh central DB
  // never gets them (the cache short-circuits ensureSchema as a no-op). Pre-creating them here,
  // matching that module's own schema exactly, sidesteps the cross-test leak entirely.
  central.exec(`
    CREATE TABLE IF NOT EXISTS transaction_reference_sequences (
      entity_type TEXT NOT NULL, date_key TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (entity_type, date_key));
    CREATE TABLE IF NOT EXISTS transaction_references (
      reference TEXT PRIMARY KEY, entity_type TEXT NOT NULL, prefix TEXT NOT NULL, date_key TEXT NOT NULL,
      sequence INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (entity_type, date_key, sequence));
    CREATE TABLE IF NOT EXISTS transaction_reference_links (
      workspace_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      reference TEXT NOT NULL REFERENCES transaction_references(reference) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, entity_type, entity_id),
      UNIQUE (workspace_id, entity_type, reference));
    CREATE INDEX IF NOT EXISTS idx_transaction_reference_links_reference ON transaction_reference_links(reference);
  `);
  central.exec(`INSERT INTO admin_users VALUES ('a1','uid_super','super@kcp.test','kcp-superuser','active')`);
  central.exec(`INSERT INTO workspaces VALUES ('${WORKSPACE}','uid_super','active','Test WS')`);

  const now = new Date().toISOString();
  tenant.prepare(
    `INSERT INTO locations (id, workspace_id, legacy_source_id, name, kind, active, is_default, created_at, updated_at)
     VALUES ('loc_main', ?1, 'loc_main', 'Main Store', 'storage', 1, 1, ?2, ?2)`,
  ).run(WORKSPACE, now);
  tenant.prepare(
    `INSERT INTO stock_items (id, workspace_id, legacy_source_id, name, category, item_type, unit, unit_cost,
      vat_enabled, is_stocked, threshold_qty, par_level_qty, yield_pct, batch_yield, active, raw_json, created_at, updated_at)
     VALUES ('si_1', ?1, 'si_1', 'Flour', 'General', 'raw', 'kg', 10, 1, 1, 0, 0, 100, 1, 1, '{}', ?2, ?2)`,
  ).run(WORKSPACE, now);
  tenant.prepare(
    `INSERT INTO suppliers (id, workspace_id, legacy_source_id, name, active, raw_json, created_at, updated_at)
     VALUES ('sup_1', ?1, 'sup_1', 'Test Supplier', 1, '{}', ?2, ?2)`,
  ).run(WORKSPACE, now);

  const env = {
    DB: new SqliteDb(tenant),
    CENTRAL_DB: new SqliteDb(central),
    ENVIRONMENT: 'test',
    ALLOWED_ORIGINS: 'https://app.test',
  } as unknown as Env;
  return { env, tenant, central };
}

function req(method: string, body: unknown) {
  return new Request('https://api.test/x', {
    method,
    headers: { 'content-type': 'application/json', origin: 'https://app.test' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

async function postGrv(env: Env, overrides: Record<string, unknown> = {}) {
  const response = await routes.postGoodsReceipt(
    req('POST', {
      receipt: {
        supplierId: 'sup_1',
        invoiceNumber: 'INV-1',
        locationId: 'loc_main',
        overrideCostPrice: true,
        items: [{ stockItemId: 'si_1', receivedQty: 10, baseQuantity: 10, unitCost: 10, unit: 'kg' }],
        ...overrides,
      },
    }),
    env,
    AUTH,
    WORKSPACE,
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

function balance(tenant: DatabaseSync, stockItemId = 'si_1', locationId = 'loc_main') {
  const row = tenant
    .prepare(`SELECT quantity FROM stock_balances WHERE workspace_id = ? AND stock_item_id = ? AND location_id = ?`)
    .get(WORKSPACE, stockItemId, locationId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

// --- GRV edit ---

test('patchGoodsReceipt: editing quantity correctly nets the stock balance delta', async () => {
  const { env, tenant } = createEnv();
  const created = await postGrv(env);
  const grvId = created.id as string;
  assert.equal(balance(tenant), 10);

  const response = await routes.patchGoodsReceipt(
    req('PATCH', {
      receipt: {
        supplierId: 'sup_1',
        invoiceNumber: 'INV-1',
        locationId: 'loc_main',
        overrideCostPrice: true,
        items: [{ stockItemId: 'si_1', receivedQty: 7, baseQuantity: 7, unitCost: 10, unit: 'kg' }],
      },
    }),
    env,
    AUTH,
    WORKSPACE,
    grvId,
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(balance(tenant), 7);
  assert.equal(body.version, 2);

  const lines = tenant.prepare(`SELECT quantity FROM grv_lines WHERE workspace_id = ? AND grv_id = ?`).all(WORKSPACE, grvId) as Array<{ quantity: number }>;
  assert.deepEqual(lines.map((l) => l.quantity), [7]);

  const grvRow = tenant.prepare(`SELECT version FROM grvs WHERE workspace_id = ? AND id = ?`).get(WORKSPACE, grvId) as { version: number };
  assert.equal(grvRow.version, 2);

  const auditEvents = tenant.prepare(`SELECT event_type FROM audit_events WHERE workspace_id = ? AND entity_id = ? ORDER BY created_at`).all(WORKSPACE, grvId) as Array<{ event_type: string }>;
  assert.deepEqual(auditEvents.map((e) => e.event_type), ['grv_saved', 'grv_edited']);
});

test('patchGoodsReceipt: editing unit cost (last costing) updates the location cost snapshot', async () => {
  const { env, tenant } = createEnv();
  const created = await postGrv(env);
  const grvId = created.id as string;

  await routes.patchGoodsReceipt(
    req('PATCH', {
      receipt: {
        supplierId: 'sup_1',
        invoiceNumber: 'INV-1',
        locationId: 'loc_main',
        overrideCostPrice: true,
        items: [{ stockItemId: 'si_1', receivedQty: 10, baseQuantity: 10, unitCost: 20, unit: 'kg' }],
      },
    }),
    env,
    AUTH,
    WORKSPACE,
    grvId,
  );

  const priceRow = tenant
    .prepare(`SELECT price FROM stock_item_location_prices WHERE workspace_id = ? AND stock_item_id = 'si_1' AND location_id = 'loc_main'`)
    .get(WORKSPACE) as { price: number };
  assert.equal(priceRow.price, 20);
});

test('patchGoodsReceipt: reducing quantity below what has since sold is blocked with a 409', async () => {
  const { env, tenant } = createEnv();
  const created = await postGrv(env);
  const grvId = created.id as string;

  // Simulate 8 of the 10 units having since sold.
  const now = new Date().toISOString();
  tenant.prepare(
    `UPDATE stock_balances SET quantity = quantity - 8, updated_at = ?1 WHERE workspace_id = ?2 AND stock_item_id = 'si_1' AND location_id = 'loc_main'`,
  ).run(now, WORKSPACE);
  tenant.prepare(
    `INSERT INTO stock_movements (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
     VALUES ('mv_sale_1', ?1, 'si_1', 'loc_main', 'sale_depletion', 'yoco_order', 'order_1', -8, 10, -80, ?2, 'test', '{}', ?2)`,
  ).run(WORKSPACE, now);
  assert.equal(balance(tenant), 2);

  const response = await routes.patchGoodsReceipt(
    req('PATCH', {
      receipt: {
        supplierId: 'sup_1',
        invoiceNumber: 'INV-1',
        locationId: 'loc_main',
        overrideCostPrice: true,
        items: [{ stockItemId: 'si_1', receivedQty: 1, baseQuantity: 1, unitCost: 10, unit: 'kg' }],
      },
    }),
    env,
    AUTH,
    WORKSPACE,
    grvId,
  );
  assert.equal(response.status, 409);
  // Balance must be untouched — the edit was rejected before any statement ran.
  assert.equal(balance(tenant), 2);
});

test('patchGoodsReceipt: correcting a mistaken cost retroactively compensates a same-day sale costed off the mistake', async () => {
  const { env, tenant } = createEnv();
  // GRV posted at the MISTAKEN cost (R2 instead of the intended R20).
  const created = await postGrv(env, {
    items: [{ stockItemId: 'si_1', receivedQty: 10, baseQuantity: 10, unitCost: 2, unit: 'kg' }],
  });
  const grvId = created.id as string;
  const receivedAt = (tenant.prepare(`SELECT received_at FROM grvs WHERE workspace_id = ? AND id = ?`).get(WORKSPACE, grvId) as { received_at: string }).received_at;

  // A same-day sale, costed (correctly, at the time) off the mistaken R2 figure.
  const saleAt = new Date(new Date(receivedAt).getTime() + 60_000).toISOString();
  tenant.prepare(
    `INSERT INTO stock_movements (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
     VALUES ('mv_sale_1', ?1, 'si_1', 'loc_main', 'sale_depletion', 'yoco_order', 'order_1', -3, 2, -6, ?2, 'test', '{}', ?2)`,
  ).run(WORKSPACE, saleAt);
  tenant.prepare(
    `UPDATE stock_balances SET quantity = quantity - 3 WHERE workspace_id = ?1 AND stock_item_id = 'si_1' AND location_id = 'loc_main'`,
  ).run(WORKSPACE);

  // Now fix the GRV's cost to the true R20.
  const response = await routes.patchGoodsReceipt(
    req('PATCH', {
      receipt: {
        supplierId: 'sup_1',
        invoiceNumber: 'INV-1',
        locationId: 'loc_main',
        overrideCostPrice: true,
        items: [{ stockItemId: 'si_1', receivedQty: 10, baseQuantity: 10, unitCost: 20, unit: 'kg' }],
      },
    }),
    env,
    AUTH,
    WORKSPACE,
    grvId,
  );
  assert.equal(response.status, 200);

  const corrections = tenant
    .prepare(`SELECT unit_cost, value_delta, quantity_delta FROM stock_movements WHERE workspace_id = ? AND movement_type = 'cost_correction'`)
    .all(WORKSPACE) as Array<{ unit_cost: number; value_delta: number; quantity_delta: number }>;
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].unit_cost, 20);
  assert.equal(corrections[0].quantity_delta, 0);
  // The sale's original value_delta (-6) already carries the negative "value left inventory"
  // sign; correcting R2 -> R20 means MORE value left, so the compensating delta is itself
  // negative: quantityDelta(-3) * (correctedCost(20) - previousCost(2)) = -3 * 18 = -54.
  assert.equal(corrections[0].value_delta, -54);

  // Stock quantity must be completely unaffected by a cost-only correction.
  assert.equal(balance(tenant), 7);
});

test('patchGoodsReceipt: correcting a mistaken cost retroactively compensates a sale made days after the GRV, not just its own trading day', async () => {
  const { env, tenant } = createEnv();
  // A mispriced GRV isn't always caught same-day — this backdates receipt to 3 days ago, well
  // outside the GRV's own trading-day window the correction scan used to be limited to.
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
  const created = await postGrv(env, {
    date: threeDaysAgo,
    items: [{ stockItemId: 'si_1', receivedQty: 10, baseQuantity: 10, unitCost: 2, unit: 'kg' }],
  });
  const grvId = created.id as string;

  // A sale made a full day after the GRV's own trading day (but still before "now") — exactly
  // the case a trading-day-only correction window would miss entirely.
  const saleAt = new Date(new Date(threeDaysAgo).getTime() + 86400000).toISOString();
  tenant.prepare(
    `INSERT INTO stock_movements (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
     VALUES ('mv_sale_1', ?1, 'si_1', 'loc_main', 'sale_depletion', 'yoco_order', 'order_1', -3, 2, -6, ?2, 'test', '{}', ?2)`,
  ).run(WORKSPACE, saleAt);
  tenant.prepare(
    `UPDATE stock_balances SET quantity = quantity - 3 WHERE workspace_id = ?1 AND stock_item_id = 'si_1' AND location_id = 'loc_main'`,
  ).run(WORKSPACE);

  // Now fix the GRV's cost to the true R20 — no `date` in this PATCH, same as a real edit that
  // only touches the price.
  const response = await routes.patchGoodsReceipt(
    req('PATCH', {
      receipt: {
        supplierId: 'sup_1',
        invoiceNumber: 'INV-1',
        locationId: 'loc_main',
        overrideCostPrice: true,
        items: [{ stockItemId: 'si_1', receivedQty: 10, baseQuantity: 10, unitCost: 20, unit: 'kg' }],
      },
    }),
    env,
    AUTH,
    WORKSPACE,
    grvId,
  );
  assert.equal(response.status, 200);

  const corrections = tenant
    .prepare(`SELECT unit_cost, value_delta, quantity_delta FROM stock_movements WHERE workspace_id = ? AND movement_type = 'cost_correction'`)
    .all(WORKSPACE) as Array<{ unit_cost: number; value_delta: number; quantity_delta: number }>;
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].unit_cost, 20);
  assert.equal(corrections[0].quantity_delta, 0);
  assert.equal(corrections[0].value_delta, -54);

  assert.equal(balance(tenant), 7);
});

// --- Credit note edit ---

async function postCreditNote(env: Env, overrides: Record<string, unknown> = {}) {
  const response = await routes.postCreditNote(
    req('POST', {
      creditNote: {
        supplierName: 'Test Supplier',
        supplierId: 'sup_1',
        creditNoteNumber: 'CN-1',
        reason: 'Damaged goods',
        locationId: 'loc_main',
        items: [{ stockItemId: 'si_1', returnedQty: 2, baseQuantity: 2, unitCost: 10, unit: 'kg' }],
        ...overrides,
      },
    }),
    env,
    AUTH,
    WORKSPACE,
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test('patchCreditNote: editing quantity correctly nets the stock balance delta', async () => {
  const { env, tenant } = createEnv();
  await postGrv(env); // 10 units on hand
  const createdCn = await postCreditNote(env);
  const creditNoteId = createdCn.id as string;
  assert.equal(balance(tenant), 8); // 10 - 2 credited

  const response = await routes.patchCreditNote(
    req('PATCH', {
      creditNote: {
        supplierName: 'Test Supplier',
        supplierId: 'sup_1',
        creditNoteNumber: 'CN-1',
        reason: 'Damaged goods',
        locationId: 'loc_main',
        items: [{ stockItemId: 'si_1', returnedQty: 5, baseQuantity: 5, unitCost: 10, unit: 'kg' }],
      },
    }),
    env,
    AUTH,
    WORKSPACE,
    creditNoteId,
  );
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(balance(tenant), 5); // 10 - 5 credited
  assert.equal(body.version, 2);
});

test('patchCreditNote: crediting more than is on hand is blocked with a 409, balance untouched', async () => {
  const { env, tenant } = createEnv();
  await postGrv(env); // 10 units on hand
  const createdCn = await postCreditNote(env);
  const creditNoteId = createdCn.id as string;
  assert.equal(balance(tenant), 8);

  const response = await routes.patchCreditNote(
    req('PATCH', {
      creditNote: {
        supplierName: 'Test Supplier',
        supplierId: 'sup_1',
        creditNoteNumber: 'CN-1',
        reason: 'Damaged goods',
        locationId: 'loc_main',
        items: [{ stockItemId: 'si_1', returnedQty: 50, baseQuantity: 50, unitCost: 10, unit: 'kg' }],
      },
    }),
    env,
    AUTH,
    WORKSPACE,
    creditNoteId,
  );
  assert.equal(response.status, 409);
  assert.equal(balance(tenant), 8);
});

test('patchCreditNote: cannot edit-inflate a return past the source purchase order\'s ordered quantity', async () => {
  const { env, tenant } = createEnv();
  const now = new Date().toISOString();
  tenant.prepare(
    `INSERT INTO purchase_orders (id, workspace_id, supplier_id, status, po_number, created_at, updated_at)
     VALUES ('po_1', ?1, 'sup_1', 'received', 'PO-1', ?2, ?2)`,
  ).run(WORKSPACE, now);
  tenant.prepare(
    `INSERT INTO purchase_order_lines (id, workspace_id, purchase_order_id, stock_item_id, description, quantity, unit, unit_price, total_ex, total_vat, total_inc)
     VALUES ('pol_1', ?1, 'po_1', 'si_1', 'Flour', 10, 'kg', 10, 100, 0, 100)`,
  ).run(WORKSPACE);
  await postGrv(env, { purchaseOrderId: 'po_1' });

  // Original credit note returns 8 of the 10 ordered — within bounds.
  const createdCn = await postCreditNote(env, {
    sourcePoId: 'po_1',
    items: [{ stockItemId: 'si_1', returnedQty: 8, baseQuantity: 8, unitCost: 10, unit: 'kg' }],
  });
  const creditNoteId = createdCn.id as string;

  // Editing it to return 25 (well past the PO's ordered 10) must be blocked.
  const response = await routes.patchCreditNote(
    req('PATCH', {
      creditNote: {
        supplierName: 'Test Supplier',
        supplierId: 'sup_1',
        creditNoteNumber: 'CN-1',
        reason: 'Damaged goods',
        locationId: 'loc_main',
        sourcePoId: 'po_1',
        items: [{ stockItemId: 'si_1', returnedQty: 25, baseQuantity: 25, unitCost: 10, unit: 'kg' }],
      },
    }),
    env,
    AUTH,
    WORKSPACE,
    creditNoteId,
  );
  assert.equal(response.status, 409);
  const body = await response.json() as Record<string, unknown>;
  assert.match(String(body.error || body.message || ''), /cannot return more than the original purchase order quantity/);
});
