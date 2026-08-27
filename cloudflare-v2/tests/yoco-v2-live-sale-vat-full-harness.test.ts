import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { splitSqlStatements, isRetryableAddColumnError } from '../src/d1-facade';
import { TENANT_MIGRATIONS } from '../src/tenant-migrations';
import { applyControlledLiveSaleEffects } from '../src/modules/yoco-engine-v2/live-sale';
import type { CanonicalSaleCompletedEvent, YocoV2QueueMessage } from '../src/modules/yoco-engine-v2/contracts';
import type { DbLike, DbResult, DbStatementLike, Env, Row } from '../src/legacy/types';

// Full end-to-end harness: applies the REAL tenant migration chain to a real in-memory SQLite
// database, then drives the REAL applyControlledLiveSaleEffects() entry point (the exact function
// a live Yoco webhook calls in production) through a DbLike adapter backed by that database — no
// hand-rolled fakes standing in for the sale-processing logic itself. Only the environment
// (feature flags, workspace_id/integration_id) and the D1-shaped access layer are test doubles.

function applyMigration(database: DatabaseSync, script: string): void {
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

function freshMigratedTenantDb(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const migration of TENANT_MIGRATIONS) applyMigration(database, migration);
  return database;
}

// Adapts a real node:sqlite DatabaseSync to the DbLike interface WorkspaceDO's D1Facade exposes
// as env.DB in production. SQLite's native ?1/?2 numbered-parameter binding (confirmed to work
// identically under node:sqlite) means the exact same query text a production statement uses can
// run unmodified here.
function dbLikeFor(database: DatabaseSync): DbLike {
  function meta(changes: number): DbResult['meta'] {
    return { changes, last_row_id: 0, rows_read: 0, rows_written: changes, duration: 0 };
  }
  function makeStatement(query: string, bound: unknown[] = []): DbStatementLike {
    const prepared: StatementSync = database.prepare(query);
    const statement: DbStatementLike = {
      bind(...values: unknown[]) {
        return makeStatement(query, values);
      },
      async first<T>(_column?: string) {
        return (prepared.get(...(bound as never[])) ?? null) as T | null;
      },
      async all<T>() {
        const results = prepared.all(...(bound as never[])) as T[];
        return { results, success: true, meta: meta(0) };
      },
      async run<T>() {
        const info = prepared.run(...(bound as never[]));
        return { results: [] as T[], success: true, meta: meta(Number(info.changes || 0)) };
      },
      async raw<T>() {
        return (prepared.all(...(bound as never[])) as Record<string, unknown>[]).map((row) => Object.values(row)) as T[];
      },
    };
    return statement;
  }
  return {
    prepare(query: string) {
      return makeStatement(query);
    },
    async batch<T>(statements: DbStatementLike[]) {
      const results: Array<DbResult<T>> = [];
      for (const statement of statements) results.push(await statement.run<T>());
      return results;
    },
  };
}

function insertWorkspaceSettings(database: DatabaseSync, workspaceId: string, vatRate: number, vatRegistered: boolean): void {
  database.prepare(
    `INSERT INTO workspace_settings (workspace_id, vat_rate, vat_registered) VALUES (?1, ?2, ?3)`,
  ).run(workspaceId, vatRate, vatRegistered ? 1 : 0);
}

function insertV2Ownership(database: DatabaseSync, workspaceId: string): void {
  for (const effectType of ['SALE_REPORTING', 'SALE_STOCK']) {
    database.prepare(
      `INSERT INTO integration_effect_ownership
        (workspace_id, integration_type, effect_type, engine_version, enabled, updated_at)
       VALUES (?1, 'YOCO', ?2, 'V2', 1, datetime('now'))`,
    ).run(workspaceId, effectType);
  }
}

function testEnv(database: DatabaseSync): Env {
  const db = dbLikeFor(database);
  return {
    DB: db,
    CENTRAL_DB: db,
    // SALE_STOCK is intentionally left disabled (no YOCO_V2_LIVE_SALE_STOCK flag) — this harness
    // is scoped to the VAT-snapshot behaviour on the reporting path, not stock deduction.
    YOCO_V2_LIVE_SALE_REPORTING: 'all',
  } as Env;
}

let saleCounter = 0;
function saleEvent(workspaceId: string, grossAmount: number): CanonicalSaleCompletedEvent {
  saleCounter += 1;
  const orderId = `order-${saleCounter}`;
  return {
    event_id: `evt-${saleCounter}`,
    event_type: 'sale.completed',
    source: 'yoco',
    source_version: 'v2',
    workspace_id: workspaceId,
    integration_id: `yoco:${workspaceId}`,
    source_order_id: orderId,
    source_payment_id: `pay-${saleCounter}`,
    payment_method: 'card',
    occurred_at: new Date('2026-08-26T10:00:00.000Z').toISOString(),
    received_at: new Date('2026-08-26T10:00:01.000Z').toISOString(),
    currency: 'ZAR',
    gross_amount: grossAmount,
    discount_amount: 0,
    net_amount: grossAmount,
    tax_amount: 0,
    tip_amount: 0,
    status: 'completed',
    lines: [],
    metadata: { source_order: { id: orderId } },
    schema_version: 'v1',
    resolution_status: 'RESOLVED',
  };
}

function queueMessage(workspaceId: string, event: CanonicalSaleCompletedEvent): YocoV2QueueMessage {
  return {
    raw_event_id: `raw-${event.event_id}`,
    workspace_id: workspaceId,
    integration_id: `yoco:${workspaceId}`,
    event_type: 'sale.completed',
    trace_id: `trace-${event.event_id}`,
    live_effects: true,
  };
}

// Mirrors buildVatRateSqlExpression()'s per-order CASE exactly (reporting-routes.ts): the raw
// yoco_orders.vat_rate column legitimately keeps the workspace's configured rate even when the
// workspace is not VAT-registered — vat_registered = 0 is what forces the EFFECTIVE rate to zero,
// not a zeroed vat_rate column. Reporting derives the effective rate with this formula; a test
// that only checked the raw column would fail to prove the actual reporting outcome is correct.
function effectiveVatRateAsReportingWouldDeriveIt(order: { vat_rate: number | null; vat_registered: number | null }): number {
  if (order.vat_rate === null || order.vat_rate === undefined) return 15;
  if ((order.vat_registered ?? 1) === 0) return 0;
  return order.vat_rate === 0 ? 15 : order.vat_rate;
}

async function processSale(database: DatabaseSync, workspaceId: string, grossAmount: number) {
  const env = testEnv(database);
  const canonical = saleEvent(workspaceId, grossAmount);
  const message = queueMessage(workspaceId, canonical);
  const result = await applyControlledLiveSaleEffects(env, {
    domainEvent: { id: `domain-${canonical.event_id}` } as Row,
    canonical,
    rawEvent: { id: `raw-${canonical.event_id}` } as Row,
    rawEventId: `raw-${canonical.event_id}`,
    processingRunId: `run-${canonical.event_id}`,
    message,
  });
  const order = database.prepare(
    `SELECT vat_rate, vat_registered, gross_total, vat_total, net_total
       FROM yoco_orders WHERE workspace_id = ?1 AND yoco_order_id = ?2`,
  ).get(workspaceId, canonical.source_order_id) as
    | { vat_rate: number; vat_registered: number; gross_total: number; vat_total: number; net_total: number }
    | undefined;
  return { result, order, orderId: canonical.source_order_id };
}

test('a non-VAT-registered workspace: applyControlledLiveSaleEffects stamps vat_registered = 0, and the reporting-derived effective VAT rate is 0 (the raw vat_rate column legitimately keeps the configured rate)', async () => {
  const database = freshMigratedTenantDb();
  const workspaceId = 'ws-not-registered';
  insertWorkspaceSettings(database, workspaceId, 15, false);
  insertV2Ownership(database, workspaceId);

  const { result, order } = await processSale(database, workspaceId, 115);

  assert.equal(result.reporting, 'APPLIED');
  assert.ok(order, 'order row was not written');
  assert.equal(order!.vat_registered, 0);
  assert.equal(order!.vat_rate, 15, 'raw vat_rate should keep the configured rate — only vat_registered flags it as not effective');
  assert.equal(effectiveVatRateAsReportingWouldDeriveIt(order!), 0);
  // NOTE: gross_total/vat_total/net_total on yoco_orders come straight from the CanonicalSaleCompletedEvent
  // passed in (see applyReporting's INSERT: input.canonical.gross_amount/tax_amount/net_amount) — this
  // harness constructs that event directly rather than through sale-resolver.ts's
  // deriveYocoFinancialAmounts(), so those three columns only prove pass-through wiring here, not the
  // VAT amount calculation itself (that calculation is unit-tested separately and already covered by
  // yocoFinancials.test.js / salesReportingFoundation.test.js). This test's job is the vat_rate/
  // vat_registered snapshot columns, which applyReporting computes itself via fetchWorkspaceVatSnapshot.
});

test('a VAT-registered workspace: applyControlledLiveSaleEffects stamps vat_registered = 1 and vat_rate = 15 on the real order row', async () => {
  const database = freshMigratedTenantDb();
  const workspaceId = 'ws-registered';
  insertWorkspaceSettings(database, workspaceId, 15, true);
  insertV2Ownership(database, workspaceId);

  const { result, order } = await processSale(database, workspaceId, 115);

  assert.equal(result.reporting, 'APPLIED');
  assert.ok(order, 'order row was not written');
  assert.equal(order!.vat_rate, 15);
  assert.equal(order!.vat_registered, 1);
});

test('the same workspace, one sale while registered and one after switching to not-registered, keeps each order\'s own snapshot independently', async () => {
  // Directly exercises the reason migration 36 exists: editing VAT settings must never
  // retroactively change what an already-processed order reports.
  const database = freshMigratedTenantDb();
  const workspaceId = 'ws-switches-mid-stream';
  insertWorkspaceSettings(database, workspaceId, 15, true);
  insertV2Ownership(database, workspaceId);

  const first = await processSale(database, workspaceId, 115);
  assert.equal(first.order!.vat_registered, 1);
  assert.equal(first.order!.vat_rate, 15);

  database.prepare(`UPDATE workspace_settings SET vat_registered = 0 WHERE workspace_id = ?1`).run(workspaceId);

  const second = await processSale(database, workspaceId, 200);
  assert.equal(second.order!.vat_registered, 0);
  assert.equal(effectiveVatRateAsReportingWouldDeriveIt(second.order!), 0);

  // The first order's snapshot must be unchanged by the later settings edit.
  const reread = database.prepare(
    `SELECT vat_rate, vat_registered FROM yoco_orders WHERE workspace_id = ?1 AND yoco_order_id = ?2`,
  ).get(workspaceId, first.orderId) as { vat_rate: number; vat_registered: number };
  assert.equal(reread.vat_registered, 1);
  assert.equal(reread.vat_rate, 15);
});

test('negative control: without V2 ownership of SALE_REPORTING, applyControlledLiveSaleEffects reports SKIPPED and writes no order row at all — proving the passing tests above are not passing merely because the gate is a no-op', async () => {
  const database = freshMigratedTenantDb();
  const workspaceId = 'ws-not-owned-by-v2';
  insertWorkspaceSettings(database, workspaceId, 15, false);
  // Deliberately no insertV2Ownership() call — this is the exact fail-closed gate effect-gate.ts
  // exists to enforce (see getEffectRuntime's ownerIsV2 check).

  const { result, order } = await processSale(database, workspaceId, 115);

  assert.equal(result.reporting, 'SKIPPED');
  assert.equal(order, undefined, 'no order row should be written when the SALE_REPORTING effect is not owned by V2');
});
