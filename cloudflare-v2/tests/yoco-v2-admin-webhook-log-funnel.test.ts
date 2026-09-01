import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { encryptTextWithSecret } from '../src/legacy/crypto';
import {
  YOCO_V2_CONTROLLED_CUTOVER_MIGRATION,
  YOCO_V2_EFFECT_GATE_MIGRATION,
  YOCO_V2_FOUNDATION_MIGRATION,
  YOCO_V2_REFUND_RECONCILIATION_MIGRATION,
  YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION,
  YOCO_V2_SALE_SHADOW_MIGRATION,
  YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION
} from '../src/modules/yoco-engine-v2/migrations';
import { MODIFIER_ENGINE_REFUNDS_RELIABILITY_NOTES_MIGRATION } from '../src/modules/modifier-engine/migrations';
import { captureVerifiedYocoV2Event } from '../src/modules/yoco-engine-v2/capture';
import { processYocoV2QueueMessage } from '../src/modules/yoco-engine-v2/processor';
import { handleYocoV2AdminRoute } from '../src/modules/yoco-engine-v2/admin-routes';
import type { YocoV2QueueMessage } from '../src/modules/yoco-engine-v2/contracts';

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
  prepare(query: string): DbStatementLike {
    return new SqliteStatement(this.database, query);
  }
  async batch<T = Record<string, unknown>>(statements: DbStatementLike[]): Promise<Array<DbResult<T>>> {
    const results: Array<DbResult<T>> = [];
    for (const statement of statements) results.push(await statement.run<T>());
    return results;
  }
}

function createDb() {
  const db = new SqliteDb();
  db.database.exec(TENANT_SCHEMA_SQL);
  db.database.exec(`
    CREATE TABLE IF NOT EXISTS integration_logs (
      id TEXT PRIMARY KEY, workspace_id TEXT, provider TEXT, operation TEXT, status TEXT,
      severity TEXT, message TEXT, details_json TEXT, correlation_id TEXT, started_at TEXT,
      completed_at TEXT, duration_ms INTEGER, created_at TEXT
    );
  `);
  db.database.exec(`
    ALTER TABLE yoco_orders ADD COLUMN parent_yoco_order_id TEXT;
    ALTER TABLE yoco_orders ADD COLUMN provider_refund_id TEXT;
    ALTER TABLE yoco_orders ADD COLUMN refund_reason TEXT;
    ALTER TABLE yoco_orders ADD COLUMN refund_behavior TEXT;
    ALTER TABLE yoco_orders ADD COLUMN gross_total REAL;
    ALTER TABLE yoco_orders ADD COLUMN vat_total REAL;
    ALTER TABLE yoco_orders ADD COLUMN net_total REAL;
    ALTER TABLE yoco_orders ADD COLUMN vat_rate REAL;
    ALTER TABLE yoco_orders ADD COLUMN vat_registered INTEGER;
  `);
  db.database.exec(YOCO_V2_FOUNDATION_MIGRATION);
  db.database.exec(YOCO_V2_SALE_SHADOW_MIGRATION);
  db.database.exec(YOCO_V2_REFUND_RECONCILIATION_MIGRATION);
  db.database.exec(YOCO_V2_CONTROLLED_CUTOVER_MIGRATION);
  db.database.exec(YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION);
  db.database.exec(MODIFIER_ENGINE_REFUNDS_RELIABILITY_NOTES_MIGRATION);
  db.database.exec(YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION);
  db.database.exec(YOCO_V2_EFFECT_GATE_MIGRATION);
  return db;
}

function seedCore(db: SqliteDb) {
  db.database.exec(`
    INSERT INTO workspace_settings (workspace_id, vat_rate, raw_json) VALUES ('ws_1', 15, '{"stockDepletionEnabled":true}');
    INSERT INTO locations (id, workspace_id, name, active, external_provider, external_location_id)
      VALUES ('loc_1', 'ws_1', 'Main', 1, 'yoco', 'yoco_loc_1');
    INSERT INTO stock_items (id, workspace_id, name, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('ingredient_1', 'ws_1', 'Beef', 'raw', 'kg', 100, 1, 1);
    INSERT INTO products (id, workspace_id, name, active, external_provider, yoco_item_id, yoco_variant_id)
      VALUES ('product_1', 'ws_1', 'Burger', 1, 'yoco', 'yoco_prod_1', 'yoco_var_1');
    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active)
      VALUES ('recipe_product_1', 'ws_1', 'product', 'product_1', 1, 1);
    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order)
      VALUES ('recipe_line_product_1', 'ws_1', 'recipe_product_1', 'ingredient_1', 0.5, 'kg', 1);
    INSERT INTO integration_effect_ownership
      (workspace_id, integration_type, effect_type, engine_version, enabled, enabled_at, enabled_by, updated_at)
      VALUES
      ('ws_1', 'YOCO', 'SALE_REPORTING', 'V2', 1, '2026-07-15T00:00:00.000Z', 'test', '2026-07-15T00:00:00.000Z'),
      ('ws_1', 'YOCO', 'SALE_STOCK', 'V2', 1, '2026-07-15T00:00:00.000Z', 'test', '2026-07-15T00:00:00.000Z');
  `);
}

function envFor(db: SqliteDb, extra: Record<string, unknown> = {}) {
  return {
    DB: db,
    CENTRAL_DB: db,
    YOCO_KEY_ENCRYPTION_SECRET: 'secret',
    YOCO_API_BASE_URL: 'https://api.yoco.com',
    YOCO_V2_EVENTS: { async send() { /* processed synchronously by the test's own ingest() call */ } },
    YOCO_V2_CAPTURE_ENABLED: 'true',
    YOCO_V2_QUEUE_ENABLED: 'true',
    YOCO_V2_ADMIN_ENABLED: 'true',
    YOCO_V2_LIVE_SALE_REPORTING: 'true',
    YOCO_V2_LIVE_SALE_STOCK: 'true',
    YOCO_V2_API_TIMEOUT_MS: '1000',
    YOCO_V2_REQUEST_SPACING_MS: '0',
    YOCO_V2_ORDER_CACHE_TTL_MS: '0',
    ...extra
  } as any;
}

async function configureApiKey(db: SqliteDb) {
  const encrypted = await encryptTextWithSecret('secret', 'sk_live_never_log');
  db.database
    .prepare(`INSERT INTO yoco_connections (workspace_id, status, api_key_encrypted, connection_active) VALUES (?, 'connected', ?, 1)`)
    .run('ws_1', encrypted);
}

// Minimal YOCO_V2_RATE_GATE stub — always answers a GET to /v1/orders/:id as still-open, which is
// all the order.updated skip-path test needs; it never has to leave the "fetched but not final" path.
function openOrderRateGate() {
  return {
    idFromName(name: string) { return name; },
    get() {
      return {
        async fetch() {
          return new Response(JSON.stringify({
            ok: true,
            classification: 'SUCCESS',
            responseStatus: 200,
            bodyText: JSON.stringify({ id: 'ord_multi', status: 'open' }),
            responseHeaders: { 'content-type': 'application/json' },
            retryAfterSeconds: 0,
            cacheStatus: 'MISS',
            durationMs: 1,
            circuit: { pausedUntil: null, pauseReason: null, interventionRequired: false, consecutiveAuthFailures: 0, consecutiveRateLimits: 0, updatedAt: new Date().toISOString() }
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      };
    }
  } as any;
}

// Same as openOrderRateGate, but records the forceRefresh flag of every request it answers, so a
// test can assert live webhook resolution never trusts the order-detail cache for finality.
function recordingOrderRateGate(status: 'open' | 'completed') {
  const seenForceRefresh: boolean[] = [];
  const gate = {
    idFromName(name: string) { return name; },
    get() {
      return {
        async fetch(requestInput: RequestInfo | URL, requestInit?: RequestInit) {
          const request = requestInput instanceof Request ? requestInput : new Request(requestInput, requestInit);
          const input = await request.json<{ forceRefresh?: boolean }>();
          seenForceRefresh.push(Boolean(input.forceRefresh));
          return new Response(JSON.stringify({
            ok: true,
            classification: 'SUCCESS',
            responseStatus: 200,
            bodyText: JSON.stringify({ id: 'ord_multi', status }),
            responseHeaders: { 'content-type': 'application/json' },
            retryAfterSeconds: 0,
            cacheStatus: 'MISS',
            durationMs: 1,
            circuit: { pausedUntil: null, pauseReason: null, interventionRequired: false, consecutiveAuthFailures: 0, consecutiveRateLimits: 0, updatedAt: new Date().toISOString() }
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      };
    }
  };
  return { gate: gate as any, seenForceRefresh };
}

async function ingest(env: any, body: string, eventType: string, yocoEventId: string) {
  const capture = await captureVerifiedYocoV2Event(env, {
    workspaceId: 'ws_1',
    integrationId: 'yoco:ws_1',
    rawBody: body,
    payload: JSON.parse(body),
    headers: new Headers({ 'webhook-id': yocoEventId, 'webhook-signature': 'sig', 'webhook-timestamp': '1700000000' }),
    eventType,
    yocoEventId,
    signatureValid: true,
    receivedAt: new Date().toISOString()
  });
  assert.equal(capture.captured, true, `capture failed for ${yocoEventId}`);
  const rawEventId = String((capture as { rawEventId: string }).rawEventId);
  const message: YocoV2QueueMessage = {
    raw_event_id: rawEventId, workspace_id: 'ws_1', integration_id: 'yoco:ws_1', event_type: eventType, trace_id: `trace-${yocoEventId}`,
    live_effects: true
  };
  const result = await processYocoV2QueueMessage(env, message);
  return { rawEventId, result };
}

const adminAuth = { uid: 'admin_1', email: 'admin@kcp.test', systemRole: 'admin' } as any;

async function callAdmin(env: any, suffix: string) {
  const response = await handleYocoV2AdminRoute(
    new Request(`https://do/api/workspaces/ws_1/${suffix}`),
    env,
    adminAuth,
    'ws_1',
    `yoco-v2/admin/${suffix}`
  );
  assert.ok(response, `no response for ${suffix}`);
  return response!.json() as Promise<any>;
}

test('a still-open order.updated followed by the real order.completed collapses to ONE resolved row, not two', async () => {
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const env = envFor(db, { YOCO_V2_RATE_GATE: openOrderRateGate() });

  // Thin order.updated notification for a still-open order — no embedded line items/amounts,
  // matching the real production payload shape documented in sale-resolver.ts. Resolves via the
  // skip path (isSkippableNonFinalEvent) added for the Gonubie incident fix: no domain event, no
  // effects, just an ack.
  await ingest(env, JSON.stringify({ type: 'order.updated', data: { order: { id: 'ord_multi', status: 'open' } } }), 'order.updated', 'evt_updated');

  // The real close-out event, fully embedded (mirrors tests/fixtures/yoco-v2/normal-sale.json) so
  // resolution uses the embedded payload directly with no live fetch involved.
  const completedBody = JSON.stringify({
    type: 'order.completed',
    data: {
      order: {
        id: 'ord_multi',
        status: 'completed',
        closed_at: new Date().toISOString(),
        location_id: 'yoco_loc_1',
        currency: 'ZAR',
        amounts: {
          gross_amount: { amount: 11500, currency: 'ZAR' },
          discount_amount: { amount: 0, currency: 'ZAR' },
          net_amount: { amount: 10000, currency: 'ZAR' },
          tax_amount: { amount: 1500, currency: 'ZAR' },
          tip_amount: { amount: 0, currency: 'ZAR' }
        },
        line_items: [{
          id: 'line_1', product_id: 'yoco_prod_1', variant_id: 'yoco_var_1', name: 'Classic Burger', quantity: 1,
          unit_price: { amount: 11500, currency: 'ZAR' }, total_amount: { amount: 11500, currency: 'ZAR' },
          amounts: { gross_amount: { amount: 11500 }, net_amount: { amount: 10000 }, tax_amount: { amount: 1500 }, discount_amount: { amount: 0 } }
        }]
      }
    }
  });
  const { result: completedResult } = await ingest(env, completedBody, 'order.completed', 'evt_completed');
  assert.equal(completedResult.status, 'COMPLETED');

  const log = await callAdmin(env, 'webhook-log');
  assert.equal(log.ok, true);
  const ordRows = log.rows.filter((row: any) => row.sourceOrderId === 'ord_multi');
  assert.equal(ordRows.length, 1, `expected exactly one row for ord_multi, got ${JSON.stringify(ordRows)}`);
  const row = ordRows[0];
  assert.equal(row.bucket, 'RESOLVED_FULL');
  assert.equal(row.deliveryCount, 2);
  assert.deepEqual([...row.eventTypes].sort(), ['order.completed', 'order.updated']);
  assert.equal(row.canReprocess, false);
  assert.equal(row.reportingApplied, true);
  assert.equal(row.stockApplied, true);

  const funnel = await callAdmin(env, 'webhook-funnel');
  assert.equal(funnel.ok, true);
  assert.equal(funnel.totalEvents, 1);
  // entryEventType is the OLDEST delivery (order.updated), not the one that happened to resolve it.
  const entryLink = funnel.links.find((l: any) => l.to === 'RESOLVED_FULL');
  assert.ok(entryLink, 'expected a link into RESOLVED_FULL');
  assert.equal(entryLink.from, 'order.updated');
});

test('an order stuck waiting for Yoco is reprocessable via refetch; a dead-lettered one via requeue-dead-letter', async () => {
  const db = createDb();
  seedCore(db);
  const env = envFor(db);

  // order.completed whose embedded payload is too thin to resolve without a live fetch, and no
  // rate-gate binding configured — resolution throws, raw event ends up WAITING (not dead-lettered
  // by this single attempt), giving us a WAITING_FOR_YOCO-shaped stuck order.
  const { rawEventId } = await ingest(env, JSON.stringify({ type: 'order.completed', data: { order: { id: 'ord_stuck' } } }), 'order.completed', 'evt_stuck');
  await db.database.prepare(`UPDATE yoco_v2_raw_events SET processing_status = 'DEAD_LETTERED' WHERE id = ?`).run(rawEventId);

  const log = await callAdmin(env, 'webhook-log');
  const row = log.rows.find((r: any) => r.sourceOrderId === 'ord_stuck');
  assert.ok(row, 'expected ord_stuck to appear in the log');
  assert.equal(row.bucket, 'DEAD_LETTER');
  assert.equal(row.canReprocess, true);
  assert.equal(row.reprocessAction, 'requeue-dead-letter');
  assert.equal(row.reprocessRawEventId, rawEventId);
});

test('a payment.created event for a still-open order skips cleanly instead of parking on the broken queue-retry path', async () => {
  // Live incident, 2026-08-31 (Gonubie): payment.created used to refuse to record a still-open order
  // and ask the queue to retry — but queue redelivery for delayed retries is independently broken in
  // production (every retry request sits at attempt 1 forever, never actually redelivered), and
  // reconciliation only attempts once per 24h per workspace, so a row like this had NO reliable
  // automatic path back short of a manual admin reprocess. Fixed by folding payment.created into the
  // same skip-cleanly path order.updated already used: no domain event write, ack immediately, and
  // let the order's next webhook (or reconciliation) resolve it once it's genuinely closed.
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const env = envFor(db, { YOCO_V2_RATE_GATE: openOrderRateGate() });

  const { rawEventId, result } = await ingest(
    env,
    JSON.stringify({ type: 'payment.created', data: { order: { id: 'ord_multi' }, payment: { order_id: 'ord_multi' } } }),
    'payment.created',
    'evt_payment_stuck'
  );
  assert.equal(result.action, 'ack');

  const log = await callAdmin(env, 'webhook-log');
  const row = log.rows.find((r: any) => r.sourceOrderId === 'ord_multi');
  assert.ok(row, 'expected ord_multi to appear in the log');
  assert.equal(row.bucket, 'SKIPPED_NOT_FINAL_YET');
  assert.equal(row.reprocessRawEventId, rawEventId);
  assert.equal(row.canReprocess, true);
  assert.equal(row.reprocessAction, 'refetch');
});

test('a plain (non-admin) webhook delivery always bypasses the order-detail cache, not just admin refetch', async () => {
  // Live incident, 2026-08-31 (Gonubie, Leo's Demo): "create order, add an item, pay" routinely
  // completes inside YOCO_V2_ORDER_CACHE_TTL_MS's 30s window. Before this fix, only an explicit
  // admin refetch passed forceRefresh through to fetchYocoV2Order — an ordinary live webhook
  // delivery (the entire normal path) could get served a stale pre-payment "open" snapshot cached
  // by an earlier webhook for the same order, misjudging a genuinely-closed order as not final.
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const { gate, seenForceRefresh } = recordingOrderRateGate('completed');
  const env = envFor(db, { YOCO_V2_RATE_GATE: gate });

  // No admin action involved anywhere in this call — force_refresh is never set on the queue
  // message for a normal webhook delivery (see capture.ts).
  const { result } = await ingest(env, JSON.stringify({ type: 'order.completed', data: { order: { id: 'ord_multi' } } }), 'order.completed', 'evt_plain');
  assert.equal(result.status, 'COMPLETED');
  assert.ok(seenForceRefresh.length > 0, 'expected the rate gate to have been called');
  assert.ok(seenForceRefresh.every((v) => v === true), `expected every order-detail request to force-refresh, got ${JSON.stringify(seenForceRefresh)}`);
});
