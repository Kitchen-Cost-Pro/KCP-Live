import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { captureVerifiedYocoV2Event, captureVerifiedYocoV2EventSafely } from '../src/modules/yoco-engine-v2/capture';
import { yocoV2FeatureFlags } from '../src/modules/yoco-engine-v2/config';
import { classifyYocoV2Error, computeYocoV2RetryDelayMs } from '../src/modules/yoco-engine-v2/errors';
import { deterministicYocoV2EventKey, redactedWebhookHeaders, sha256Hex } from '../src/modules/yoco-engine-v2/identity';
import { YOCO_V2_FOUNDATION_MIGRATION } from '../src/modules/yoco-engine-v2/migrations';
import { ensureLegacyYocoEffectOwnership } from '../src/modules/yoco-engine-v2/ownership';
import { observeCommittedLegacyYocoSaleSafely } from '../src/modules/yoco-engine-v2/legacy-shadow-observer';
import { handleYocoV2AdminRoute } from '../src/modules/yoco-engine-v2/admin-routes';
import { processYocoV2QueueMessage } from '../src/modules/yoco-engine-v2/processor';
import { consumeYocoV2QueueBatch } from '../src/modules/yoco-engine-v2/queue-consumer';
import type { DbLike, DbStatementLike, DbResult } from '../src/legacy/types';
import type { YocoV2QueueMessage } from '../src/modules/yoco-engine-v2/contracts';

class SqliteStatement implements DbStatementLike {
  private values: unknown[] = [];
  constructor(
    protected readonly database: DatabaseSync,
    protected readonly sql: string,
    private readonly failOnce?: { pattern: RegExp; message: string; consumed: boolean }
  ) {}
  bind(...values: unknown[]): DbStatementLike {
    const statement = new SqliteStatement(this.database, this.sql, this.failOnce);
    statement.values = values.map((value) => value === undefined ? null : value);
    return statement;
  }
  private maybeFail() {
    if (this.failOnce && !this.failOnce.consumed && this.failOnce.pattern.test(this.sql)) {
      this.failOnce.consumed = true;
      throw new Error(this.failOnce.message);
    }
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
    this.maybeFail();
    const materialized = this.materialize();
    const row = this.database.prepare(materialized.sql).get(...materialized.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (column) return (row[column] ?? null) as T;
    return row as T;
  }
  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    this.maybeFail();
    const materialized = this.materialize();
    const rows = this.database.prepare(materialized.sql).all(...materialized.values) as T[];
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
  }
  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    this.maybeFail();
    const materialized = this.materialize();
    const result = this.database.prepare(materialized.sql).run(...materialized.values);
    return { results: [], success: true, meta: { changes: Number(result.changes), rows_written: Number(result.changes) } };
  }
  async raw<T = unknown[]>(): Promise<T[]> {
    this.maybeFail();
    const materialized = this.materialize();
    const rows = this.database.prepare(materialized.sql).all(...materialized.values) as Record<string, unknown>[];
    return rows.map((row) => Object.values(row) as T);
  }
}

class SqliteDb implements DbLike {
  constructor(
    readonly database = new DatabaseSync(':memory:'),
    private readonly failOnce?: { pattern: RegExp; message: string; consumed: boolean }
  ) {}
  prepare(query: string): DbStatementLike {
    return new SqliteStatement(this.database, query, this.failOnce);
  }
  async batch<T = Record<string, unknown>>(statements: DbStatementLike[]): Promise<Array<DbResult<T>>> {
    const results: Array<DbResult<T>> = [];
    for (const statement of statements) results.push(await statement.run<T>());
    return results;
  }
}

function createDb(failure?: { pattern: RegExp; message: string }) {
  const failOnce = failure ? { ...failure, consumed: false } : undefined;
  const db = new SqliteDb(new DatabaseSync(':memory:'), failOnce);
  db.database.exec(`
    CREATE TABLE integration_logs (
      id TEXT PRIMARY KEY, workspace_id TEXT, provider TEXT, operation TEXT, status TEXT,
      severity TEXT, message TEXT, details_json TEXT, correlation_id TEXT, started_at TEXT,
      completed_at TEXT, duration_ms INTEGER, created_at TEXT
    );
  `);
  db.database.exec(YOCO_V2_FOUNDATION_MIGRATION);
  return { db, failOnce };
}

function queueMock(options: { fail?: boolean } = {}) {
  const sent: unknown[] = [];
  return {
    sent,
    queue: {
      async send(message: unknown) {
        if (options.fail) throw new Error('queue unavailable');
        sent.push(message);
      }
    }
  };
}

function captureInput(body = '{"type":"order.completed","data":{"order":{"id":"ord_1"}}}') {
  return {
    workspaceId: 'ws_1',
    integrationId: 'yoco:ws_1',
    rawBody: body,
    payload: JSON.parse(body),
    headers: new Headers({
      'webhook-id': 'evt_1',
      'webhook-signature': 'secret-signature-value',
      'webhook-timestamp': '1700000000',
      authorization: 'Bearer should-not-be-stored',
      'cf-connecting-ip': '203.0.113.4'
    }),
    eventType: 'order.completed',
    yocoEventId: 'evt_1',
    signatureValid: true,
    receivedAt: '2026-07-15T09:00:00.000Z'
  };
}

function envFor(db: DbLike, queues: { main?: any; dlq?: any } = {}, flags: Record<string, string> = {}) {
  return {
    DB: db,
    CENTRAL_DB: db,
    YOCO_V2_EVENTS: queues.main,
    YOCO_V2_EVENTS_DLQ: queues.dlq,
    YOCO_V2_CAPTURE_ENABLED: 'true',
    YOCO_V2_QUEUE_ENABLED: 'true',
    YOCO_V2_ADMIN_ENABLED: 'true',
    YOCO_V2_SHADOW_SALES_ENABLED: 'false',
    YOCO_V2_SHADOW_REFUNDS_ENABLED: 'false',
    ...flags
  } as any;
}

async function capturedEvent(db: SqliteDb, queues = queueMock()) {
  const result = await captureVerifiedYocoV2Event(envFor(db, { main: queues.queue }), captureInput());
  const event = db.database.prepare(`SELECT * FROM yoco_v2_raw_events LIMIT 1`).get() as Record<string, unknown>;
  return { result, event, queues };
}

test('valid webhook is captured once and duplicate delivery does not duplicate raw event or queue work', async () => {
  const { db } = createDb();
  const main = queueMock();
  const env = envFor(db, { main: main.queue });
  const first = await captureVerifiedYocoV2Event(env, captureInput());
  const second = await captureVerifiedYocoV2Event(env, captureInput());
  assert.equal(first.captured, true);
  assert.equal(second.duplicate, true);
  assert.equal(Number((db.database.prepare(`SELECT COUNT(*) AS count FROM yoco_v2_raw_events`).get() as any).count), 1);
  assert.equal(Number((db.database.prepare(`SELECT duplicate_receipts FROM yoco_v2_raw_events`).get() as any).duplicate_receipts), 1);
  assert.equal(main.sent.length, 1);
});


test('successful legacy sale commit creates one idempotent shadow-only V2 observation', async () => {
  const { db } = createDb();
  const main = queueMock();
  const env = envFor(db, { main: main.queue }, { YOCO_V2_SHADOW_SALES_ENABLED: 'true' });
  const input = {
    workspaceId: 'ws_1',
    order: {
      id: 'ord_legacy_1',
      status: 'completed',
      closed_at: '2026-07-15T12:00:00.000Z',
      amounts: { gross_amount: { amount: 10000, currency: 'ZAR' } },
      line_items: [{ id: 'line_1', name: 'Test sale', quantity: 1, total_price: 10000 }]
    },
    result: { processed: true, stockMovements: 2, orderLines: 1 },
    eventType: 'yoco.sync.sale',
    observedAt: '2026-07-15T12:00:01.000Z'
  };
  const first = await observeCommittedLegacyYocoSaleSafely(env, input);
  const second = await observeCommittedLegacyYocoSaleSafely(env, input);
  assert.equal(first.observed, true);
  assert.equal(second.observed, true);
  assert.equal(main.sent.length, 1);
  assert.equal((main.sent[0] as any).live_effects, false);
  assert.equal((main.sent[0] as any).replay_reason, 'legacy_sale_post_commit_observation');
  const raw = db.database.prepare(`SELECT * FROM yoco_v2_raw_events WHERE yoco_event_id = ?`).get('kcp-legacy-sale-committed:ord_legacy_1') as any;
  assert.ok(raw);
  assert.equal(raw.event_type, 'order.completed');
  assert.equal(Number(raw.duplicate_receipts), 1);
  const timeline = db.database.prepare(`SELECT step, metadata_json FROM yoco_v2_processing_timeline WHERE raw_event_id = ? ORDER BY created_at, id`).all(raw.id) as any[];
  assert.ok(timeline.some((entry) => entry.step === 'LEGACY_SALE_EFFECTS_COMMITTED'));
  assert.ok(timeline.every((entry) => !String(entry.metadata_json || '').includes('"live_effects":true')));
});

test('legacy sale observer does nothing when the sale was not processed or shadow sales are disabled', async () => {
  const { db } = createDb();
  const main = queueMock();
  const disabled = await observeCommittedLegacyYocoSaleSafely(
    envFor(db, { main: main.queue }, { YOCO_V2_SHADOW_SALES_ENABLED: 'false' }),
    { workspaceId: 'ws_1', order: { id: 'ord_disabled' }, result: { processed: true } }
  );
  const unprocessed = await observeCommittedLegacyYocoSaleSafely(
    envFor(db, { main: main.queue }, { YOCO_V2_SHADOW_SALES_ENABLED: 'true' }),
    { workspaceId: 'ws_1', order: { id: 'ord_unprocessed' }, result: { processed: false } }
  );
  assert.equal(disabled.observed, false);
  assert.equal(unprocessed.observed, false);
  assert.equal(main.sent.length, 0);
});

test('invalid signature is never captured or queued by V2', async () => {
  const { db } = createDb();
  const main = queueMock();
  const result = await captureVerifiedYocoV2Event(envFor(db, { main: main.queue }), { ...captureInput(), signatureValid: false });
  assert.equal(result.captured, false);
  assert.equal(Number((db.database.prepare(`SELECT COUNT(*) AS count FROM yoco_v2_raw_events`).get() as any).count), 0);
  assert.equal(main.sent.length, 0);
});

test('exact payload is preserved and secret-bearing headers are redacted', async () => {
  const { db } = createDb();
  const body = '{\n  "type": "order.completed", "unknown_field": {"keep": true}\n}';
  const input = captureInput(body);
  input.payload = JSON.parse(body);
  await captureVerifiedYocoV2Event(envFor(db, { main: queueMock().queue }), input);
  const row = db.database.prepare(`SELECT payload_json, headers_json FROM yoco_v2_raw_events`).get() as any;
  assert.equal(row.payload_json, body);
  const headers = JSON.parse(row.headers_json);
  assert.equal(headers.authorization, '[REDACTED]');
  assert.equal(headers['webhook-signature'], '[REDACTED]');
  assert.equal(headers['webhook-id'], 'evt_1');
});

test('V2 capture failure is isolated and returns a safe failure result', async () => {
  const brokenDb = {
    prepare() { throw new Error('database unavailable'); },
    async batch() { throw new Error('database unavailable'); }
  } as any;
  const result = await captureVerifiedYocoV2EventSafely(envFor(brokenDb, { main: queueMock().queue }), captureInput());
  assert.equal(result.captured, false);
  assert.equal(result.reason, 'capture_failed');
});

test('queue publication failure remains observable and raw event remains replayable', async () => {
  const { db } = createDb();
  const result = await captureVerifiedYocoV2EventSafely(envFor(db, { main: queueMock({ fail: true }).queue }), captureInput());
  assert.equal(result.captured, false);
  const row = db.database.prepare(`SELECT queue_status, processing_status, last_error_code FROM yoco_v2_raw_events`).get() as any;
  assert.equal(row.queue_status, 'PUBLISH_FAILED');
  assert.equal(row.processing_status, 'WAITING');
  assert.equal(row.last_error_code, 'YOCO_V2_QUEUE_PUBLISH_FAILED');
});

test('consumer processes a captured event idempotently and creates one run', async () => {
  const { db } = createDb();
  const main = queueMock();
  const dlq = queueMock();
  const { event } = await capturedEvent(db, main);
  const message: YocoV2QueueMessage = {
    raw_event_id: String(event.id), workspace_id: 'ws_1', integration_id: 'yoco:ws_1', event_type: 'order.completed', trace_id: String(event.trace_id)
  };
  const env = envFor(db, { main: main.queue, dlq: dlq.queue });
  const first = await processYocoV2QueueMessage(env, message);
  const second = await processYocoV2QueueMessage(env, message);
  assert.equal(first.status, 'COMPLETED');
  assert.equal(second.status, 'COMPLETED');
  assert.equal(Number((db.database.prepare(`SELECT COUNT(*) AS count FROM yoco_v2_processing_runs`).get() as any).count), 1);
});

test('temporary database error schedules retry with bounded exponential backoff', async () => {
  const base = createDb();
  const main = queueMock();
  const { event } = await capturedEvent(base.db, main);
  const failingDb = new SqliteDb(base.db.database, { pattern: /UPDATE yoco_v2_processing_runs/, message: 'database temporarily unavailable', consumed: false });
  const message: YocoV2QueueMessage = {
    raw_event_id: String(event.id), workspace_id: 'ws_1', integration_id: 'yoco:ws_1', event_type: 'order.completed', trace_id: String(event.trace_id)
  };
  const result = await processYocoV2QueueMessage(envFor(failingDb, { main: main.queue, dlq: queueMock().queue }), message);
  assert.equal(result.action, 'retry');
  assert.equal(result.status, 'RETRY_SCHEDULED');
  assert.ok(Number(result.delaySeconds) >= 1);
  const row = base.db.database.prepare(`SELECT processing_status, next_attempt_at FROM yoco_v2_raw_events`).get() as any;
  assert.equal(row.processing_status, 'RETRY_SCHEDULED');
  assert.ok(row.next_attempt_at);
});

test('permanent authentication error does not retry indefinitely and enters permanent failure/DLQ handling', async () => {
  const base = createDb();
  const main = queueMock();
  const dlq = queueMock();
  const { event } = await capturedEvent(base.db, main);
  const failingDb = new SqliteDb(base.db.database, { pattern: /UPDATE yoco_v2_processing_runs/, message: 'Invalid API key authentication failed', consumed: false });
  const message: YocoV2QueueMessage = {
    raw_event_id: String(event.id), workspace_id: 'ws_1', integration_id: 'yoco:ws_1', event_type: 'order.completed', trace_id: String(event.trace_id)
  };
  const result = await processYocoV2QueueMessage(envFor(failingDb, { main: main.queue, dlq: dlq.queue }), message);
  assert.equal(result.action, 'ack');
  assert.equal(result.status, 'FAILED_PERMANENTLY');
  assert.equal(dlq.sent.length, 1);
});

test('exhausted temporary failure enters dead-letter state', async () => {
  const base = createDb();
  const main = queueMock();
  const dlq = queueMock();
  const { event } = await capturedEvent(base.db, main);
  const failingDb = new SqliteDb(base.db.database, { pattern: /UPDATE yoco_v2_processing_runs/, message: 'database temporarily unavailable', consumed: false });
  const message: YocoV2QueueMessage = {
    raw_event_id: String(event.id), workspace_id: 'ws_1', integration_id: 'yoco:ws_1', event_type: 'order.completed', trace_id: String(event.trace_id)
  };
  const result = await processYocoV2QueueMessage(envFor(failingDb, { main: main.queue, dlq: dlq.queue }, { YOCO_V2_MAX_ATTEMPTS: '1' }), message);
  assert.equal(result.status, 'DEAD_LETTERED');
  assert.equal(dlq.sent.length, 1);
  assert.equal((base.db.database.prepare(`SELECT processing_status FROM yoco_v2_raw_events`).get() as any).processing_status, 'DEAD_LETTERED');
});

test('admin replay queues existing raw event without creating a duplicate event', async () => {
  const { db } = createDb();
  const main = queueMock();
  const { event } = await capturedEvent(db, main);
  db.database.prepare(`UPDATE yoco_v2_raw_events SET processing_status='COMPLETED', completed_at=datetime('now') WHERE id=?`).run(String(event.id));
  const request = new Request(`https://example.test/events/${event.id}/replay`, { method: 'POST' });
  const response = await handleYocoV2AdminRoute(
    request,
    envFor(db, { main: main.queue }),
    { uid: 'admin_1', email: 'admin@example.com', token: {}, systemRole: 'admin' },
    'ws_1',
    `yoco-v2/admin/events/${event.id}/replay`
  );
  assert.equal(response?.status, 200);
  assert.equal(Number((db.database.prepare(`SELECT COUNT(*) AS count FROM yoco_v2_raw_events`).get() as any).count), 1);
  assert.equal(main.sent.length, 2);
});

test('timeline is append-only and raw payload immutable', async () => {
  const { db } = createDb();
  const { event } = await capturedEvent(db);
  assert.throws(() => db.database.prepare(`UPDATE yoco_v2_raw_events SET payload_json='{}' WHERE id=?`).run(String(event.id)), /immutable/);
  assert.throws(() => db.database.prepare(`UPDATE yoco_v2_processing_timeline SET message='changed'`).run(), /append-only/);
  assert.throws(() => db.database.prepare(`DELETE FROM yoco_v2_processing_timeline`).run(), /append-only/);
});

test('sale and refund live flags are independently workspace-selective', () => {
  const flags = yocoV2FeatureFlags({
    YOCO_V2_LIVE_SALE_REPORTING: 'ws_1',
    YOCO_V2_LIVE_SALE_STOCK: 'ws_1',
    YOCO_V2_LIVE_REFUND_REPORTING: 'true',
    YOCO_V2_LIVE_REFUND_STOCK: 'true'
  }, 'ws_1');
  assert.equal(flags.yoco_v2_live_sale_reporting, true);
  assert.equal(flags.yoco_v2_live_sale_stock, true);
  assert.equal(flags.yoco_v2_live_refund_reporting, true);
  assert.equal(flags.yoco_v2_live_refund_stock, true);
  const other = yocoV2FeatureFlags({ YOCO_V2_LIVE_SALE_REPORTING: 'ws_1', YOCO_V2_LIVE_SALE_STOCK: 'ws_1' }, 'ws_2');
  assert.equal(other.yoco_v2_live_sale_reporting, false);
  assert.equal(other.yoco_v2_live_sale_stock, false);
});

test('effect ownership is seeded as LEGACY for all four effects', async () => {
  const { db } = createDb();
  await ensureLegacyYocoEffectOwnership(db, 'ws_1');
  const rows = db.database.prepare(`SELECT effect_type, engine_version, enabled FROM integration_effect_ownership ORDER BY effect_type`).all() as any[];
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.engine_version === 'LEGACY' && Number(row.enabled) === 1));
});

test('retry classification supports rate limits, Retry-After and deterministic jitter tests', () => {
  const classified = classifyYocoV2Error({ status: 429, message: 'Too many requests', retryAfterSeconds: 45 });
  assert.equal(classified.category, 'RATE_LIMITED');
  assert.equal(classified.retryable, true);
  assert.equal(classified.retryAfterMs, 45_000);
  const delay = computeYocoV2RetryDelayMs({ attemptNumber: 3, baseRetryMs: 1_000, maxRetryMs: 60_000, retryAfterMs: 45_000, random: 0 });
  assert.equal(delay, 45_000);
});

test('queue batch acknowledges success and retries temporary result', async () => {
  const states: string[] = [];
  const messages = [
    { body: { raw_event_id: '1' }, ack: () => states.push('ack'), retry: () => states.push('retry') },
    { body: { raw_event_id: '2' }, ack: () => states.push('ack'), retry: () => states.push('retry') }
  ] as any;
  await consumeYocoV2QueueBatch({ messages } as any, async (message: any) => message.raw_event_id === '1'
    ? { ok: true, action: 'ack' }
    : { ok: false, action: 'retry', delaySeconds: 5 });
  assert.deepEqual(states.sort(), ['ack', 'retry']);
});

test('event identity is deterministic with provider id and safe fallback hash', async () => {
  const hash = await sha256Hex('{"a":1}');
  assert.equal(deterministicYocoV2EventKey({ yocoEventId: 'evt_x', eventType: 'order.completed', payloadHash: hash }), 'yoco-event:evt_x');
  assert.equal(
    deterministicYocoV2EventKey({ eventType: 'order.completed', payloadHash: hash, stableReferences: ['ord_1'] }),
    deterministicYocoV2EventKey({ eventType: 'order.completed', payloadHash: hash, stableReferences: ['ord_1'] })
  );
  const redacted = redactedWebhookHeaders(new Headers({ authorization: 'secret', 'webhook-signature': 'sig', 'webhook-id': 'evt' }));
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted['webhook-signature'], '[REDACTED]');
});

test('legacy webhook path remains operational and live writes are isolated to the controlled sale consumer', () => {
  const root = resolve(import.meta.dirname, '..');
  const legacyRoutes = readFileSync(join(root, 'src/legacy/routes.ts'), 'utf8');
  const frontIndex = readFileSync(join(root, 'src/index.ts'), 'utf8');
  assert.match(frontIndex, /const yocoWebhookM = url\.pathname\.match/);
  assert.match(frontIndex, /webhooks\\\/yoco/);
  assert.match(legacyRoutes, /verifyYocoWebhook/);
  assert.match(legacyRoutes, /captureVerifiedYocoV2EventSafely/);
  assert.match(legacyRoutes, /processYocoOrder/);
  const legacySales = readFileSync(join(root, 'src/legacy/yoco-sales.ts'), 'utf8');
  assert.match(legacySales, /observeCommittedLegacyYocoSaleSafely/);
  assert.ok(legacySales.indexOf('if (statements.length) await env.DB.batch(statements)') < legacySales.indexOf('observeCommittedLegacyYocoSaleSafely(env'));
  assert.ok(legacyRoutes.indexOf('verifyYocoWebhook') < legacyRoutes.indexOf('captureVerifiedYocoV2EventSafely(env'));
  assert.ok(legacyRoutes.indexOf('captureVerifiedYocoV2EventSafely(env') < legacyRoutes.indexOf('processYocoOrder(env'));
  const moduleDir = join(root, 'src/modules/yoco-engine-v2');
  const liveSource = readFileSync(join(moduleDir, 'live-sale.ts'), 'utf8');
  const liveRefundSource = readFileSync(join(moduleDir, 'live-refund.ts'), 'utf8');
  const allOtherSource = readdirSync(moduleDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !['live-sale.ts', 'live-refund.ts'].includes(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
  assert.match(liveSource, /INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+stock_movements/i);
  assert.match(liveSource, /UPDATE\s+stock_balances/i);
  assert.match(liveSource, /INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+yoco_orders/i);
  assert.match(liveRefundSource, /INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+stock_movements/i);
  assert.match(liveRefundSource, /INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+yoco_orders/i);
  assert.doesNotMatch(allOtherSource, /INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+stock_movements/i);
  assert.doesNotMatch(allOtherSource, /(?:create|update|delete)WebhookSubscription/);
  assert.doesNotMatch(allOtherSource, /yocoFetch\s*\(/);
});

test('admin replay queue publication failure is observable and leaves the raw event replayable', async () => {
  const { db } = createDb();
  const initialQueue = queueMock();
  const { event } = await capturedEvent(db, initialQueue);
  db.database.prepare(`UPDATE yoco_v2_raw_events SET processing_status='COMPLETED', completed_at=datetime('now') WHERE id=?`).run(String(event.id));
  const request = new Request(`https://example.test/events/${event.id}/replay`, { method: 'POST' });
  const response = await handleYocoV2AdminRoute(
    request,
    envFor(db, { main: queueMock({ fail: true }).queue }),
    { uid: 'admin_1', email: 'admin@example.com', token: {}, systemRole: 'admin' },
    'ws_1',
    `yoco-v2/admin/events/${event.id}/replay`
  );
  assert.equal(response?.status, 503);
  const row = db.database.prepare(`SELECT queue_status, processing_status, last_error_code FROM yoco_v2_raw_events WHERE id=?`).get(String(event.id)) as any;
  assert.equal(row.queue_status, 'PUBLISH_FAILED');
  assert.equal(row.processing_status, 'WAITING');
  assert.equal(row.last_error_code, 'YOCO_V2_ADMIN_REPLAY_PUBLISH_FAILED');
  const timeline = db.database.prepare(`SELECT step FROM yoco_v2_processing_timeline WHERE raw_event_id=? ORDER BY created_at, id`).all(String(event.id)) as any[];
  assert.ok(timeline.some((entry) => entry.step === 'ADMIN_REPLAY_QUEUE_PUBLISH_FAILED'));
});

test('all project Markdown files are consolidated under docs', () => {
  const repositoryRoot = resolve(import.meta.dirname, '../..');
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.wrangler')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.toLowerCase().endsWith('.md')) found.push(path);
    }
  };
  walk(repositoryRoot);
  assert.ok(found.length > 0);
  assert.ok(found.every((path) => path.startsWith(join(repositoryRoot, 'docs'))), found.join('\n'));
});

test('queue processing pauses safely when the workspace queue flag is disabled', async () => {
  const { db } = createDb();
  const main = queueMock();
  const { event } = await capturedEvent(db, main);
  const message: YocoV2QueueMessage = {
    raw_event_id: String(event.id), workspace_id: 'ws_1', integration_id: 'yoco:ws_1', event_type: 'order.completed', trace_id: String(event.trace_id)
  };
  const result = await processYocoV2QueueMessage(envFor(db, { main: main.queue }, { YOCO_V2_QUEUE_ENABLED: 'false' }), message);
  assert.equal(result.action, 'ack');
  assert.equal(result.status, 'WAITING');
  const row = db.database.prepare(`SELECT queue_status, processing_status, processing_attempts FROM yoco_v2_raw_events WHERE id=?`).get(String(event.id)) as any;
  assert.equal(row.queue_status, 'PAUSED');
  assert.equal(row.processing_status, 'WAITING');
  assert.equal(Number(row.processing_attempts), 0);
});

test('a retry-scheduled event cannot process before its next retry timestamp', async () => {
  const { db } = createDb();
  const main = queueMock();
  const { event } = await capturedEvent(db, main);
  const nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
  db.database.prepare(`UPDATE yoco_v2_raw_events SET processing_status='RETRY_SCHEDULED', next_attempt_at=? WHERE id=?`).run(nextAttemptAt, String(event.id));
  const message: YocoV2QueueMessage = {
    raw_event_id: String(event.id), workspace_id: 'ws_1', integration_id: 'yoco:ws_1', event_type: 'order.completed', trace_id: String(event.trace_id)
  };
  const result = await processYocoV2QueueMessage(envFor(db, { main: main.queue, dlq: queueMock().queue }), message);
  assert.equal(result.action, 'retry');
  assert.equal(result.status, 'RETRY_SCHEDULED');
  assert.ok(Number(result.delaySeconds) >= 1);
  assert.equal(Number((db.database.prepare(`SELECT COUNT(*) AS count FROM yoco_v2_processing_runs`).get() as any).count), 0);
});

test('segregated admin and queue routes require internal front-worker roles', async () => {
  const { db } = createDb();
  const request = new Request('https://example.test/summary');
  const response = await handleYocoV2AdminRoute(
    request,
    envFor(db),
    { uid: 'member_1', email: 'member@example.com', token: {} },
    'ws_1',
    'yoco-v2/admin/summary'
  );
  assert.equal(response?.status, 403);

  const routeSource = readFileSync(resolve(import.meta.dirname, '../src/modules/yoco-engine-v2/route-dispatch.ts'), 'utf8');
  assert.match(routeSource, /auth\.systemRole !== 'queue'/);
  const frontSource = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
  assert.match(frontSource, /systemRole: 'admin'/);
  assert.match(frontSource, /systemRole: 'queue'/);
});
