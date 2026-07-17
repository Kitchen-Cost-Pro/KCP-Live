import type { AuthContext, DbLike } from '../../legacy/types';
import type { YocoV2QueueMessage } from './contracts';
import type { YocoV2QueueEnv } from './capture';
import { yocoV2FeatureFlags, yocoV2RetryConfig } from './config';
import { appendTimeline, markRawEventQueueFailure, markRawEventQueued, newId, nowIso, type Row } from './repository';
import { saveManualRefundAllocation } from './refund-resolver';
import { runYocoV2Reconciliation } from './reconciliation';
import {
  hasYocoV2AdminPermission,
  requireYocoV2AdminPermission,
  YOCO_V2_ADMIN_PERMISSIONS,
  YocoV2AdminPermissionError,
  type YocoV2AdminPermission
} from './admin-permissions';
import { redactSensitiveValue, redactStoredJson } from './admin-security';
import { getModifierEngineControl, setModifierEngineMode } from '../modifier-engine/reliability';

const RELEASE = 'phase-v2-admin-yoco-engine-control-centre';
const PAGE_SIZES = new Set([25, 50, 100]);
const MAX_PAGE = 10_000;
const ACTIONS_PER_MINUTE = 20;
const LIVE_EFFECT_KEYS = [
  'yoco_v2_live_sale_reporting',
  'yoco_v2_live_sale_stock',
  'yoco_v2_live_refund_reporting',
  'yoco_v2_live_refund_stock'
] as const;

interface PageRequest {
  page: number;
  perPage: number;
  offset: number;
}

interface AdminActionContext {
  id: string;
  traceId: string;
  duplicateResult?: Record<string, unknown>;
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function text(value: unknown, fallback = ''): string {
  return String(value ?? fallback).trim();
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readJsonBody<T extends Record<string, unknown>>(request: { json(): Promise<unknown> }): Promise<Partial<T>> {
  const value = await request.json().catch(() => null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<T> : {};
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    if (value == null || value === '') return fallback;
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function pageRequest(url: URL): PageRequest {
  const page = Math.max(1, Math.min(MAX_PAGE, Math.floor(numberValue(url.searchParams.get('page'), 1))));
  const requested = Math.floor(numberValue(url.searchParams.get('perPage'), 25));
  const perPage = PAGE_SIZES.has(requested) ? requested : 25;
  return { page, perPage, offset: (page - 1) * perPage };
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KCP_TIMEZONE_OFFSET = '+02:00';

function dateBoundary(value: unknown, boundary: 'start' | 'end'): string | null {
  const raw = text(value);
  if (!raw) return null;
  const candidate = DATE_ONLY_PATTERN.test(raw)
    ? `${raw}T${boundary === 'start' ? '00:00:00.000' : '23:59:59.999'}${KCP_TIMEZONE_OFFSET}`
    : raw;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function dateRange(url: URL): { from: string; to: string } {
  const to = dateBoundary(url.searchParams.get('to'), 'end') || nowIso();
  const from = dateBoundary(url.searchParams.get('from'), 'start')
    || new Date(Date.parse(to) - 24 * 60 * 60_000).toISOString();
  return Date.parse(from) <= Date.parse(to) ? { from, to } : { from: to, to: from };
}

function durationMs(start: unknown, end: unknown): number | null {
  const a = Date.parse(text(start));
  const b = Date.parse(text(end));
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function sourceReferenceFromPayload(payload: Record<string, unknown>): Record<string, string> {
  const data = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : payload;
  const nested = data.resource && typeof data.resource === 'object' ? data.resource as Record<string, unknown> : data;
  return {
    order_id: text(nested.order_id || nested.orderId || data.order_id || data.orderId),
    refund_id: text(nested.refund_id || nested.refundId || data.refund_id || data.refundId),
    payment_id: text(nested.payment_id || nested.paymentId || data.payment_id || data.paymentId),
    location_id: text(nested.location_id || nested.locationId || data.location_id || data.locationId),
    source_entity_id: text(nested.id || data.id)
  };
}

function healthLevel(input: {
  critical?: boolean;
  degraded?: boolean;
  attention?: boolean;
}): 'Healthy' | 'Attention' | 'Degraded' | 'Critical' {
  if (input.critical) return 'Critical';
  if (input.degraded) return 'Degraded';
  if (input.attention) return 'Attention';
  return 'Healthy';
}

function permissionPayload(auth: AuthContext): Record<string, boolean> {
  return Object.fromEntries(YOCO_V2_ADMIN_PERMISSIONS.map((permission) => [permission, hasYocoV2AdminPermission(auth, permission)]));
}

function forbidden(permission: YocoV2AdminPermission): Response {
  return response({ ok: false, error: 'Permission denied.', permission }, 403);
}

async function tableExists(db: DbLike, name: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1`
  ).bind(name).first<{ name?: string }>();
  return Boolean(row?.name);
}

async function listPage(
  db: DbLike,
  countSql: string,
  rowsSql: string,
  values: unknown[],
  page: PageRequest
): Promise<{ rows: Row[]; pagination: Record<string, number> }> {
  const [count, rows] = await Promise.all([
    db.prepare(countSql).bind(...values).first<{ total?: number | string }>(),
    db.prepare(rowsSql).bind(...values, page.perPage, page.offset).all<Row>()
  ]);
  const total = numberValue(count?.total);
  return {
    rows: rows.results || [],
    pagination: {
      page: page.page,
      perPage: page.perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / page.perPage))
    }
  };
}

function eventActions(row: Row): Array<{ action: string; enabled: boolean; reason?: string; confirmation?: boolean }> {
  const signatureValid = numberValue(row.signature_valid) === 1;
  const processing = text(row.processing_status);
  const queue = text(row.queue_status);
  const busy = processing === 'PROCESSING';
  const requeueEligible = ['DEAD_LETTERED', 'FAILED_PERMANENTLY', 'WAITING', 'RETRY_SCHEDULED'].includes(processing)
    || ['PUBLISH_FAILED', 'NOT_REQUESTED', 'WAITING'].includes(queue);
  return [
    { action: 'view', enabled: true },
    { action: 'timeline', enabled: true },
    { action: 'replay', enabled: signatureValid && !busy, reason: !signatureValid ? 'Signature validation failed.' : busy ? 'Event is currently processing.' : undefined, confirmation: true },
    { action: 'requeue', enabled: signatureValid && !busy && requeueEligible, reason: busy ? 'Event is currently processing.' : !signatureValid ? 'Signature validation failed.' : 'Requeue is available only for waiting, retrying, failed, or unpublished events.', confirmation: true },
    { action: 'manual-review', enabled: !busy && processing !== 'MANUAL_REVIEW_REQUIRED', reason: busy ? 'Event is currently processing.' : processing === 'MANUAL_REVIEW_REQUIRED' ? 'Event is already in manual review.' : undefined, confirmation: true }
  ];
}

async function loadRawEvent(db: DbLike, workspaceId: string, rawEventId: string): Promise<Row | null> {
  return db.prepare(`SELECT * FROM yoco_v2_raw_events WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`)
    .bind(workspaceId, rawEventId).first<Row>();
}

async function publishCanonicalReplay(
  env: YocoV2QueueEnv,
  event: Row,
  reason: string,
  options: Pick<YocoV2QueueMessage, 'force_refresh' | 'rerun_stage' | 'live_effects'> = {}
): Promise<void> {
  if (!env.YOCO_V2_EVENTS) throw new Error('YOCO_V2_EVENTS queue binding is not configured.');
  const message: YocoV2QueueMessage = {
    raw_event_id: text(event.id),
    workspace_id: text(event.workspace_id),
    integration_id: text(event.integration_id),
    event_type: text(event.event_type),
    trace_id: text(event.trace_id),
    replay_reason: reason,
    live_effects: true,
    ...options
  };
  await env.YOCO_V2_EVENTS.send(message, { contentType: 'json' });
}

async function resetForCanonicalReplay(db: DbLike, event: Row, resetAttempts: boolean): Promise<void> {
  await db.prepare(
    `UPDATE yoco_v2_raw_events
        SET queue_status = 'PUBLISHING', processing_status = 'WAITING',
            processing_attempts = CASE WHEN ?3 = 1 THEN 0 ELSE processing_attempts END,
            next_attempt_at = NULL, last_error_code = NULL, last_error_message = NULL,
            completed_at = NULL, updated_at = ?4
      WHERE workspace_id = ?1 AND id = ?2`
  ).bind(text(event.workspace_id), text(event.id), resetAttempts ? 1 : 0, nowIso()).run();
}

function idempotencyKey(request: Request): string {
  const key = text(request.headers.get('idempotency-key'));
  if (key.length < 12 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new Error('A valid Idempotency-Key header is required for this action.');
  }
  return key;
}

async function existingAdminAction(request: Request, db: DbLike, workspaceId: string): Promise<Record<string, unknown> | null> {
  const key = idempotencyKey(request);
  const existing = await db.prepare(
    `SELECT * FROM yoco_v2_admin_actions WHERE workspace_id = ?1 AND idempotency_key = ?2 LIMIT 1`
  ).bind(workspaceId, key).first<Row>();
  if (!existing) return null;
  return {
    idempotent_replay: true,
    action_id: existing.id,
    action_status: existing.status,
    result: parseJson(existing.resulting_state_json, {})
  };
}

async function beginAdminAction(
  request: Request,
  env: YocoV2QueueEnv,
  auth: AuthContext,
  workspaceId: string,
  input: {
    integrationId: string;
    action: string;
    targetType: string;
    targetId: string;
    previousState?: unknown;
    reason?: string;
  }
): Promise<AdminActionContext> {
  const key = idempotencyKey(request);
  const existing = await env.DB.prepare(
    `SELECT * FROM yoco_v2_admin_actions WHERE workspace_id = ?1 AND idempotency_key = ?2 LIMIT 1`
  ).bind(workspaceId, key).first<Row>();
  if (existing) {
    return {
      id: text(existing.id),
      traceId: text(existing.trace_id),
      duplicateResult: {
        idempotent_replay: true,
        action_id: existing.id,
        action_status: existing.status,
        result: parseJson(existing.resulting_state_json, {})
      }
    };
  }

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM yoco_v2_admin_actions
      WHERE workspace_id = ?1 AND actor_uid = ?2 AND created_at >= datetime('now', '-1 minute')`
  ).bind(workspaceId, auth.uid).first<{ total?: number | string }>();
  if (numberValue(recent?.total) >= ACTIONS_PER_MINUTE) throw new Error('Admin action rate limit reached. Retry after one minute.');

  const actionId = newId('yoco_v2_admin_action');
  const traceId = `admin-${crypto.randomUUID()}`;
  const createdAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO yoco_v2_admin_actions
      (id, workspace_id, integration_id, actor_uid, actor_email, action, target_type, target_id,
       idempotency_key, previous_state_json, resulting_state_json, reason, status, trace_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '{}', NULLIF(?11, ''), 'STARTED', ?12, ?13)`
  ).bind(
    actionId,
    workspaceId,
    input.integrationId,
    auth.uid,
    auth.email,
    input.action,
    input.targetType,
    input.targetId,
    key,
    JSON.stringify(redactSensitiveValue(input.previousState || {})),
    text(input.reason),
    traceId,
    createdAt
  ).run();
  return { id: actionId, traceId };
}

async function completeAdminAction(
  db: DbLike,
  action: AdminActionContext,
  status: 'COMPLETED' | 'FAILED',
  result: unknown
): Promise<void> {
  await db.prepare(
    `UPDATE yoco_v2_admin_actions
        SET resulting_state_json = ?2, status = ?3, completed_at = ?4
      WHERE id = ?1`
  ).bind(action.id, JSON.stringify(redactSensitiveValue(result)), status, nowIso()).run();
}

async function performEventReplay(
  request: Request,
  env: YocoV2QueueEnv,
  auth: AuthContext,
  workspaceId: string,
  rawEventId: string,
  mode: 'replay' | 'requeue' | 'refetch' | 'reresolve' | 'repropose',
  reason: string
): Promise<Response> {
  requireYocoV2AdminPermission(auth, 'yoco_v2.replay');
  const duplicate = await existingAdminAction(request, env.DB, workspaceId);
  if (duplicate) return response({ ok: true, ...duplicate });
  const event = await loadRawEvent(env.DB, workspaceId, rawEventId);
  if (!event) return response({ ok: false, error: 'V2 raw event not found.' }, 404);
  if (numberValue(event.signature_valid) !== 1) return response({ ok: false, error: 'Invalid-signature events cannot be processed.' }, 409);
  if (text(event.processing_status) === 'PROCESSING') return response({ ok: false, error: 'Event is currently processing.' }, 409);
  if (mode === 'requeue' && !['DEAD_LETTERED', 'FAILED_PERMANENTLY', 'WAITING', 'RETRY_SCHEDULED'].includes(text(event.processing_status))
      && !['PUBLISH_FAILED', 'NOT_REQUESTED'].includes(text(event.queue_status))) {
    return response({ ok: false, error: 'The current event state is not eligible for requeue.' }, 409);
  }
  const flags = yocoV2FeatureFlags(env, workspaceId);
  if (!flags.yoco_v2_queue_enabled) return response({ ok: false, error: 'Yoco V2 queue is disabled for this workspace.' }, 409);

  const action = await beginAdminAction(request, env, auth, workspaceId, {
    integrationId: text(event.integration_id),
    action: `event.${mode}`,
    targetType: 'raw_event',
    targetId: rawEventId,
    previousState: { queue_status: event.queue_status, processing_status: event.processing_status, attempts: event.processing_attempts },
    reason
  });
  if (action.duplicateResult) return response({ ok: true, ...action.duplicateResult });
  const rerunStage = mode === 'reresolve' ? 'resolution' : mode === 'repropose' ? 'proposal' : 'all';
  try {
    const retry = yocoV2RetryConfig(env);
    const terminal = ['DEAD_LETTERED', 'FAILED_PERMANENTLY'].includes(text(event.processing_status));
    const exhausted = numberValue(event.processing_attempts) >= retry.maxAttempts;
    await resetForCanonicalReplay(env.DB, event, mode === 'requeue' || terminal || exhausted);
    await publishCanonicalReplay(env, event, `admin-${mode}`, { force_refresh: mode === 'refetch', rerun_stage: rerunStage, live_effects: rerunStage === 'all' });
    await markRawEventQueued(env.DB, rawEventId);
    const liveEffects = rerunStage === 'all';
    const result = { status: 'QUEUED', mode, rerun_stage: rerunStage, live_effects: liveEffects, trace_id: action.traceId };
    await appendTimeline(env.DB, {
      rawEventId,
      step: mode === 'requeue' ? 'ADMIN_REQUEUED' : 'ADMIN_CANONICAL_REPLAY_QUEUED',
      status: 'QUEUED',
      message: `Administrator queued canonical V2 ${mode}.`,
      metadata: { actor_uid: auth.uid, actor_email: auth.email, action_id: action.id, trace_id: action.traceId, live_effects: liveEffects, reason }
    });
    await completeAdminAction(env.DB, action, 'COMPLETED', result);
    return response({ ok: true, ...result, action_id: action.id });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await markRawEventQueueFailure(env.DB, rawEventId, 'YOCO_V2_ADMIN_QUEUE_PUBLISH_FAILED', message);
    await appendTimeline(env.DB, {
      rawEventId,
      step: 'ADMIN_CANONICAL_REPLAY_FAILED',
      status: 'WAITING',
      message: 'Canonical V2 replay queue publication failed. Historical processing data was retained.',
      metadata: { actor_uid: auth.uid, action_id: action.id, trace_id: action.traceId, error: message }
    });
    await completeAdminAction(env.DB, action, 'FAILED', { error: message });
    return response({ ok: false, error: message, action_id: action.id }, 503);
  }
}

async function overview(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const { from, to } = dateRange(url);
  const integration = text(url.searchParams.get('integration'));
  const eventType = text(url.searchParams.get('eventType'));
  const status = text(url.searchParams.get('status'));
  const search = text(url.searchParams.get('search'));
  const eventClauses = ['workspace_id = ?1', 'received_at >= ?2', 'received_at <= ?3'];
  const eventValues: unknown[] = [workspaceId, from, to];
  const eventAdd = (column: string, value: unknown) => { eventValues.push(value); eventClauses.push(`${column} = ?${eventValues.length}`); };
  if (integration) eventAdd('integration_id', integration);
  if (eventType) eventAdd('event_type', eventType);
  if (status) eventAdd('processing_status', status);
  if (search) {
    eventValues.push(`%${search.replace(/[%_]/g, '\\$&')}%`);
    const p = `?${eventValues.length}`;
    eventClauses.push(`(yoco_event_id LIKE ${p} ESCAPE '\\' OR event_key LIKE ${p} ESCAPE '\\' OR trace_id LIKE ${p} ESCAPE '\\' OR EXISTS (SELECT 1 FROM yoco_v2_domain_events d WHERE d.raw_event_id = yoco_v2_raw_events.id AND d.source_entity_id LIKE ${p} ESCAPE '\\'))`);
  }
  const receiptClauses = ['workspace_id = ?1', 'received_at >= ?2', 'received_at <= ?3'];
  const receiptValues: unknown[] = [workspaceId, from, to];
  const receiptAdd = (column: string, value: unknown) => { receiptValues.push(value); receiptClauses.push(`${column} = ?${receiptValues.length}`); };
  if (integration) receiptAdd('integration_id', integration);
  if (eventType) receiptAdd('event_type', eventType);
  if (search) {
    receiptValues.push(`%${search.replace(/[%_]/g, '\\$&')}%`);
    const p = `?${receiptValues.length}`;
    receiptClauses.push(`(yoco_event_id LIKE ${p} ESCAPE '\\' OR source_reference LIKE ${p} ESCAPE '\\' OR trace_id LIKE ${p} ESCAPE '\\')`);
  }
  const apiClauses = ['workspace_id = ?1', 'created_at >= ?2', 'created_at <= ?3'];
  const apiValues: unknown[] = [workspaceId, from, to];
  if (integration) { apiValues.push(integration); apiClauses.push(`integration_id = ?${apiValues.length}`); }
  const [events, receipts, api, runtime, reconciliation, recState, durations] = await Promise.all([
    env.DB.prepare(
      `SELECT
        COUNT(*) AS unique_events,
        COALESCE(SUM(duplicate_receipts), 0) AS duplicate_deliveries,
        SUM(CASE WHEN processing_status = 'COMPLETED' THEN 1 ELSE 0 END) AS successfully_processed,
        SUM(CASE WHEN processing_status = 'PROCESSING' THEN 1 ELSE 0 END) AS processing_now,
        SUM(CASE WHEN processing_status = 'RETRY_SCHEDULED' THEN 1 ELSE 0 END) AS waiting_retry,
        SUM(CASE WHEN processing_status = 'MANUAL_REVIEW_REQUIRED' THEN 1 ELSE 0 END) AS manual_review_required,
        SUM(CASE WHEN processing_status = 'FAILED_PERMANENTLY' THEN 1 ELSE 0 END) AS permanently_failed,
        SUM(CASE WHEN processing_status = 'DEAD_LETTERED' THEN 1 ELSE 0 END) AS dead_lettered,
        SUM(CASE WHEN queue_status = 'PUBLISH_FAILED' THEN 1 ELSE 0 END) AS queue_publication_failures,
        MIN(CASE WHEN processing_status NOT IN ('COMPLETED', 'FAILED_PERMANENTLY', 'DEAD_LETTERED') THEN received_at END) AS oldest_unprocessed,
        MAX(received_at) AS last_event_received
       FROM yoco_v2_raw_events
       WHERE ${eventClauses.join(' AND ')}`
    ).bind(...eventValues).first<Row>(),
    env.DB.prepare(
      `SELECT
        COUNT(*) AS webhooks_received,
        SUM(CASE WHEN signature_status = 'VALID' THEN 1 ELSE 0 END) AS valid_signatures,
        SUM(CASE WHEN signature_status IN ('INVALID','SECRET_MISSING') THEN 1 ELSE 0 END) AS invalid_signatures,
        SUM(CASE WHEN capture_status = 'FAILED' THEN 1 ELSE 0 END) AS capture_failures,
        SUM(CASE WHEN capture_status = 'CAPTURED' THEN 1 ELSE 0 END) AS captured,
        SUM(CASE WHEN duplicate_identity IS NOT NULL AND duplicate_identity <> '' THEN 1 ELSE 0 END) AS duplicate_receipts,
        MAX(received_at) AS last_webhook_received
       FROM yoco_v2_webhook_receipts
       WHERE ${receiptClauses.join(' AND ')}`
    ).bind(...receiptValues).first<Row>(),
    env.DB.prepare(
      `SELECT
        COUNT(*) AS requests,
        SUM(CASE WHEN response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS successful_requests,
        SUM(CASE WHEN response_status = 429 THEN 1 ELSE 0 END) AS rate_limits,
        SUM(CASE WHEN response_status IN (401,403) THEN 1 ELSE 0 END) AS auth_failures,
        SUM(CASE WHEN error_category = 'TIMEOUT' OR error_code LIKE '%TIMEOUT%' THEN 1 ELSE 0 END) AS timeouts,
        SUM(CASE WHEN response_status >= 500 THEN 1 ELSE 0 END) AS server_errors,
        SUM(CASE WHEN cache_status = 'HIT' THEN 1 ELSE 0 END) AS cache_hits,
        AVG(duration_ms) AS average_duration_ms
       FROM yoco_v2_api_requests
       WHERE ${apiClauses.join(' AND ')}`
    ).bind(...apiValues).first<Row>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS active_pauses,
              MAX(updated_at) AS last_runtime_update,
              SUM(CASE WHEN pause_reason LIKE '%rate%' THEN 1 ELSE 0 END) AS rate_limit_pauses
         FROM yoco_v2_integration_runtime
        WHERE workspace_id = ?1 AND (paused_until IS NOT NULL AND paused_until > ?2 OR intervention_required = 1)`
    ).bind(workspaceId, nowIso()).first<Row>(),
    env.DB.prepare(
      `SELECT
        (SELECT MAX(completed_at) FROM yoco_v2_reconciliation_runs WHERE workspace_id = ?1 AND status = 'COMPLETED') AS latest_successful_run,
        (SELECT COUNT(*) FROM yoco_v2_reconciliation_findings WHERE workspace_id = ?1 AND status = 'OPEN') AS unresolved_findings,
        (SELECT COUNT(*) FROM yoco_v2_reconciliation_findings WHERE workspace_id = ?1 AND status = 'OPEN' AND finding_type = 'MISSING_SALE') AS missing_sales,
        (SELECT COUNT(*) FROM yoco_v2_reconciliation_findings WHERE workspace_id = ?1 AND status = 'OPEN' AND finding_type = 'MISSING_REFUND') AS missing_refunds,
        (SELECT COUNT(*) FROM yoco_v2_reconciliation_findings WHERE workspace_id = ?1 AND status = 'OPEN' AND finding_type = 'FINANCIAL_MISMATCH') AS financial_mismatches,
        (SELECT COUNT(*) FROM yoco_v2_reconciliation_findings WHERE workspace_id = ?1 AND status = 'OPEN' AND finding_type = 'STOCK_MISMATCH') AS stock_mismatches`
    ).bind(workspaceId).first<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_reconciliation_state WHERE workspace_id = ?1 ORDER BY updated_at DESC LIMIT 1`)
      .bind(workspaceId).first<Row>(),
    env.DB.prepare(
      `SELECT started_at, completed_at FROM yoco_v2_processing_runs
        WHERE workspace_id = ?1 AND completed_at IS NOT NULL AND started_at >= ?2 AND started_at <= ?3
        ORDER BY started_at DESC LIMIT 1000`
    ).bind(workspaceId, from, to).all<Row>()
  ]);

  const e = events || {};
  const r = receipts || {};
  const a = api || {};
  const runDurations = (durations.results || []).map((row) => durationMs(row.started_at, row.completed_at)).filter((value): value is number => value != null);
  const webhookCount = numberValue(r.webhooks_received);
  const captureRate = webhookCount ? Math.round((numberValue(r.captured) / webhookCount) * 10_000) / 100 : null;
  const duplicateRate = webhookCount ? Math.round((numberValue(r.duplicate_receipts) / webhookCount) * 10_000) / 100 : null;
  const apiRequests = numberValue(a.requests);
  const cacheHitRate = apiRequests ? Math.round((numberValue(a.cache_hits) / apiRequests) * 10_000) / 100 : null;
  const retryBacklog = numberValue(e.waiting_retry);
  const deadLetterBacklog = numberValue(e.dead_lettered);
  const invalidSignatures = numberValue(r.invalid_signatures);
  const activePauses = numberValue(runtime?.active_pauses);
  const unresolvedFindings = numberValue(reconciliation?.unresolved_findings);

  return response({
    ok: true,
    release: RELEASE,
    generated_at: nowIso(),
    range: { from, to },
    applied_filters: { workspace: workspaceId, integration: integration || null, event_type: eventType || null, status: status || null, search: search || null },
    kpis: {
      webhooks_received: webhookCount,
      unique_events: numberValue(e.unique_events),
      duplicate_deliveries: numberValue(e.duplicate_deliveries),
      successfully_processed: numberValue(e.successfully_processed),
      processing_now: numberValue(e.processing_now),
      waiting_for_retry: retryBacklog,
      manual_review_required: numberValue(e.manual_review_required),
      permanently_failed: numberValue(e.permanently_failed),
      dead_lettered: deadLetterBacklog,
      capture_failures: numberValue(r.capture_failures),
      queue_publication_failures: numberValue(e.queue_publication_failures),
      api_rate_limit_events: numberValue(a.rate_limits),
      reconciliation_findings: unresolvedFindings
    },
    health: {
      webhook_intake: {
        level: healthLevel({ critical: numberValue(r.capture_failures) > 0, degraded: invalidSignatures > 5 || numberValue(e.queue_publication_failures) > 0, attention: invalidSignatures > 0 || numberValue(r.duplicate_receipts) > 0 }),
        last_webhook_received: r.last_webhook_received || e.last_event_received || null,
        capture_success_rate: captureRate,
        invalid_signatures: invalidSignatures,
        duplicate_rate: duplicateRate,
        queue_publication_health: numberValue(e.queue_publication_failures) === 0 ? 'Healthy' : 'Degraded'
      },
      processing: {
        level: healthLevel({ critical: deadLetterBacklog > 0, degraded: retryBacklog > 25, attention: retryBacklog > 0 || numberValue(e.processing_now) > 0 }),
        oldest_unprocessed_event: e.oldest_unprocessed || null,
        median_processing_duration_ms: median(runDurations),
        retry_backlog: retryBacklog,
        dead_letter_backlog: deadLetterBacklog,
        events_waiting_for_yoco: numberValue(a.rate_limits) + activePauses
      },
      api_health: {
        level: healthLevel({ critical: numberValue(a.auth_failures) > 0, degraded: numberValue(a.server_errors) > 0 || activePauses > 0, attention: numberValue(a.rate_limits) > 0 || numberValue(a.timeouts) > 0 }),
        successful_requests: numberValue(a.successful_requests),
        responses_429: numberValue(a.rate_limits),
        responses_401_403: numberValue(a.auth_failures),
        timeouts: numberValue(a.timeouts),
        responses_5xx: numberValue(a.server_errors),
        active_integration_pauses: activePauses,
        cache_hit_rate: cacheHitRate,
        average_duration_ms: a.average_duration_ms == null ? null : Math.round(numberValue(a.average_duration_ms))
      },
      reconciliation: {
        level: healthLevel({ critical: numberValue(reconciliation?.stock_mismatches) > 0, degraded: numberValue(reconciliation?.financial_mismatches) > 0, attention: unresolvedFindings > 0 }),
        latest_successful_run: reconciliation?.latest_successful_run || null,
        current_checkpoint: recState?.checkpoint_at || null,
        unresolved_findings: unresolvedFindings,
        missing_sales: numberValue(reconciliation?.missing_sales),
        missing_refunds: numberValue(reconciliation?.missing_refunds),
        financial_mismatches: numberValue(reconciliation?.financial_mismatches),
        stock_mismatches: numberValue(reconciliation?.stock_mismatches)
      }
    }
  });
}

async function eventList(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const page = pageRequest(url);
  const clauses = ['event.workspace_id = ?1'];
  const values: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', `?${values.length}`)); };
  const exactFilters: Array<[string, string, string]> = [
    ['eventType', 'event.event_type', ''],
    ['captureStatus', 'event.capture_status', ''],
    ['queueStatus', 'event.queue_status', ''],
    ['processingStatus', 'event.processing_status', ''],
    ['integration', 'event.integration_id', '']
  ];
  for (const [parameter, column] of exactFilters) {
    const value = text(url.searchParams.get(parameter));
    if (value) add(`${column} = ?`, value);
  }
  const signature = text(url.searchParams.get('signatureValid'));
  if (signature === 'true' || signature === 'false') add('event.signature_valid = ?', signature === 'true' ? 1 : 0);
  const duplicate = text(url.searchParams.get('duplicate'));
  if (duplicate === 'true') clauses.push('event.duplicate_receipts > 0');
  if (duplicate === 'false') clauses.push('event.duplicate_receipts = 0');
  const from = dateBoundary(url.searchParams.get('from'), 'start');
  const to = dateBoundary(url.searchParams.get('to'), 'end');
  if (from) add('event.received_at >= ?', from);
  if (to) add('event.received_at <= ?', to);
  const search = text(url.searchParams.get('search'));
  if (search) {
    values.push(`%${search.replace(/[%_]/g, '\\$&')}%`);
    const p = `?${values.length}`;
    clauses.push(`(event.yoco_event_id LIKE ${p} ESCAPE '\\' OR event.event_key LIKE ${p} ESCAPE '\\' OR event.trace_id LIKE ${p} ESCAPE '\\' OR event.integration_id LIKE ${p} ESCAPE '\\' OR EXISTS (SELECT 1 FROM yoco_v2_domain_events domain WHERE domain.raw_event_id = event.id AND domain.source_entity_id LIKE ${p} ESCAPE '\\'))`);
  }
  const allowedSort: Record<string, string> = { received: 'event.received_at', attempts: 'event.processing_attempts', status: 'event.processing_status', eventType: 'event.event_type' };
  const sort = allowedSort[text(url.searchParams.get('sort'))] || 'event.received_at';
  const direction = text(url.searchParams.get('direction')).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const where = clauses.join(' AND ');
  const countSql = `SELECT COUNT(*) AS total FROM yoco_v2_raw_events event WHERE ${where}`;
  const rowsSql = `SELECT event.id, event.workspace_id, event.integration_id, event.event_type, event.yoco_event_id,
      event.event_key, event.signature_valid, event.received_at, event.capture_status, event.queue_status,
      event.processing_status, event.processing_attempts, event.next_attempt_at, event.last_error_code,
      event.last_error_message, event.duplicate_receipts, event.trace_id,
      (SELECT domain.source_entity_id FROM yoco_v2_domain_events domain WHERE domain.raw_event_id = event.id ORDER BY domain.created_at LIMIT 1) AS source_entity
    FROM yoco_v2_raw_events event WHERE ${where}
    ORDER BY ${sort} ${direction}, event.id ${direction} LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`;
  const result = await listPage(env.DB, countSql, rowsSql, values, page);
  return response({ ok: true, ...result, rows: result.rows.map((row) => ({ ...row, available_actions: eventActions(row) })) });
}

async function eventDetail(env: YocoV2QueueEnv, auth: AuthContext, workspaceId: string, rawEventId: string): Promise<Response> {
  const event = await loadRawEvent(env.DB, workspaceId, rawEventId);
  if (!event) return response({ ok: false, error: 'V2 raw event not found.' }, 404);
  const canViewPayload = hasYocoV2AdminPermission(auth, 'yoco_v2.view_payload');
  const [runs, timeline, apiRequests, domainEvents, receipts, reviews, adminActions] = await Promise.all([
    env.DB.prepare(`SELECT * FROM yoco_v2_processing_runs WHERE workspace_id = ?1 AND raw_event_id = ?2 ORDER BY attempt_number, started_at, id`).bind(workspaceId, rawEventId).all<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_processing_timeline WHERE raw_event_id = ?1 ORDER BY created_at, id`).bind(rawEventId).all<Row>(),
    env.DB.prepare(`SELECT id, integration_id, processing_run_id, trace_id, method, endpoint_name, resource_id, attempt, request_started_at, request_completed_at, duration_ms, response_status, rate_limited, retry_after_seconds, cache_status, error_category, error_code, redacted_metadata_json, created_at FROM yoco_v2_api_requests WHERE workspace_id = ?1 AND raw_event_id = ?2 ORDER BY created_at, id`).bind(workspaceId, rawEventId).all<Row>(),
    env.DB.prepare(`SELECT id, event_type, source_entity_id, occurred_at, resolution_status, created_at, updated_at FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND raw_event_id = ?2 ORDER BY created_at, id`).bind(workspaceId, rawEventId).all<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_webhook_receipts WHERE workspace_id = ?1 AND raw_event_id = ?2 ORDER BY received_at, id`).bind(workspaceId, rawEventId).all<Row>(),
    env.DB.prepare(`SELECT review.* FROM yoco_v2_manual_reviews review JOIN yoco_v2_domain_events domain ON domain.id = review.domain_event_id WHERE review.workspace_id = ?1 AND domain.raw_event_id = ?2 ORDER BY review.created_at`).bind(workspaceId, rawEventId).all<Row>(),
    env.DB.prepare(`SELECT id, actor_uid, actor_email, action, target_type, target_id, status, reason, trace_id, created_at, completed_at FROM yoco_v2_admin_actions WHERE workspace_id = ?1 AND target_id = ?2 ORDER BY created_at`).bind(workspaceId, rawEventId).all<Row>()
  ]);
  const payload = parseJson<Record<string, unknown>>(event.payload_json, {});
  const references = sourceReferenceFromPayload(payload);
  const latestRun = [...(runs.results || [])].reverse().find(Boolean);
  const eventSafe: Row = { ...event };
  delete eventSafe.payload_json;
  delete eventSafe.headers_json;
  delete eventSafe.source_ip;
  const errors = (runs.results || []).filter((run) => run.error_code || run.error_message).map((run) => ({
    category: run.error_category || null,
    code: run.error_code || null,
    message: run.error_message || null,
    retryable: text(run.status) === 'RETRY_SCHEDULED',
    permanent: ['FAILED_PERMANENTLY', 'DEAD_LETTERED'].includes(text(run.status)),
    next_retry: run.next_retry_at || null,
    details: redactStoredJson(run.error_details_json)
  }));
  return response({
    ok: true,
    payload_access: canViewPayload,
    summary: {
      ...eventSafe,
      current_step: latestRun?.current_step || null,
      attempt_count: event.processing_attempts,
      available_actions: eventActions(event)
    },
    source_references: {
      yoco_event_id: event.yoco_event_id || null,
      ...references
    },
    webhook_verification: {
      signature_result: numberValue(event.signature_valid) === 1 ? 'VALID' : 'INVALID',
      payload_hash: event.payload_hash,
      duplicate_identity: event.event_key,
      receipt_history: (receipts.results || []).map((row) => ({ ...row, redacted_headers: redactStoredJson(row.redacted_headers_json), redacted_headers_json: undefined }))
    },
    timeline: (timeline.results || []).map((row) => ({ ...row, metadata: redactStoredJson(row.metadata_json), metadata_json: undefined })),
    raw_payload: canViewPayload ? redactSensitiveValue(payload) : null,
    headers: canViewPayload ? redactStoredJson(event.headers_json) : null,
    errors,
    related_records: {
      processing_runs: runs.results || [],
      api_requests: (apiRequests.results || []).map((row) => ({ ...row, redacted_metadata: redactStoredJson(row.redacted_metadata_json), redacted_metadata_json: undefined })),
      domain_events: domainEvents.results || [],
      manual_reviews: reviews.results || [],
      admin_actions: adminActions.results || []
    }
  });
}

async function processingRuns(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const page = pageRequest(url);
  const clauses = ['run.workspace_id = ?1'];
  const values: unknown[] = [workspaceId];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', `?${values.length}`)); };
  for (const [parameter, column] of [['status', 'run.status'], ['step', 'run.current_step'], ['errorCategory', 'run.error_category'], ['integration', 'run.integration_id']] as const) {
    const value = text(url.searchParams.get(parameter));
    if (value) add(`${column} = ?`, value);
  }
  const attempt = numberValue(url.searchParams.get('attempt'), -1);
  if (attempt >= 0) add('run.attempt_number = ?', attempt);
  const { from, to } = dateRange(url);
  add('run.started_at >= ?', from);
  add('run.started_at <= ?', to);
  const where = clauses.join(' AND ');
  const countSql = `SELECT COUNT(*) AS total FROM yoco_v2_processing_runs run WHERE ${where}`;
  const rowsSql = `SELECT run.*,
      COALESCE(domain.source_entity_id, event.yoco_event_id, event.event_key) AS source_reference,
      CAST((julianday(COALESCE(run.completed_at, ?${values.length + 1})) - julianday(run.started_at)) * 86400000 AS INTEGER) AS duration_ms
    FROM yoco_v2_processing_runs run
    JOIN yoco_v2_raw_events event ON event.id = run.raw_event_id AND event.workspace_id = run.workspace_id
    LEFT JOIN yoco_v2_domain_events domain ON domain.raw_event_id = run.raw_event_id
    WHERE ${where}
    GROUP BY run.id
    ORDER BY run.started_at DESC, run.id DESC LIMIT ?${values.length + 2} OFFSET ?${values.length + 3}`;
  const now = nowIso();
  const count = await env.DB.prepare(countSql).bind(...values).first<{ total?: number | string }>();
  const rows = await env.DB.prepare(rowsSql).bind(...values, now, page.perPage, page.offset).all<Row>();
  const total = numberValue(count?.total);
  return response({ ok: true, rows: rows.results || [], pagination: { page: page.page, perPage: page.perPage, total, totalPages: Math.max(1, Math.ceil(total / page.perPage)) } });
}

async function processingRunDetail(env: YocoV2QueueEnv, workspaceId: string, runId: string): Promise<Response> {
  const run = await env.DB.prepare(`SELECT * FROM yoco_v2_processing_runs WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`).bind(workspaceId, runId).first<Row>();
  if (!run) return response({ ok: false, error: 'Processing run not found.' }, 404);
  const [attempts, timeline, apiRequests, event] = await Promise.all([
    env.DB.prepare(`SELECT * FROM yoco_v2_processing_runs WHERE workspace_id = ?1 AND raw_event_id = ?2 ORDER BY attempt_number, started_at`).bind(workspaceId, text(run.raw_event_id)).all<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_processing_timeline WHERE raw_event_id = ?1 ORDER BY created_at, id`).bind(text(run.raw_event_id)).all<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_api_requests WHERE workspace_id = ?1 AND raw_event_id = ?2 ORDER BY created_at, id`).bind(workspaceId, text(run.raw_event_id)).all<Row>(),
    loadRawEvent(env.DB, workspaceId, text(run.raw_event_id))
  ]);
  const timelineRows = timeline.results || [];
  const queueReceipt = timelineRows.find((row) => ['QUEUE_RECEIVED', 'QUEUE_PUBLISHED'].includes(text(row.step)));
  return response({
    ok: true,
    run: { ...run, duration_ms: durationMs(run.started_at, run.completed_at) },
    event: event ? { id: event.id, event_type: event.event_type, yoco_event_id: event.yoco_event_id, trace_id: event.trace_id } : null,
    attempts: (attempts.results || []).map((row) => ({ ...row, error_details: redactStoredJson(row.error_details_json), duration_ms: durationMs(row.started_at, row.completed_at), error_details_json: undefined })),
    exact_step_transitions: timelineRows.map((row) => ({ ...row, metadata: redactStoredJson(row.metadata_json), metadata_json: undefined })),
    queue_receipt_time: queueReceipt?.created_at || null,
    processing_start: run.started_at,
    processing_end: run.completed_at || null,
    retry_scheduling: run.next_retry_at || null,
    error_classification: { category: run.error_category || null, code: run.error_code || null, message: run.error_message || null },
    api_requests: (apiRequests.results || []).map((row) => ({ ...row, redacted_metadata: redactStoredJson(row.redacted_metadata_json), redacted_metadata_json: undefined }))
  });
}

async function salesList(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const page = pageRequest(url);
  const clauses = ["domain.workspace_id = ?1", "domain.event_type = 'sale.completed'"];
  const values: unknown[] = [workspaceId];
  const status = text(url.searchParams.get('status'));
  if (status) { values.push(status); clauses.push(`comparison.comparison_status = ?${values.length}`); }
  const search = text(url.searchParams.get('search'));
  if (search) { values.push(`%${search.replace(/[%_]/g, '\\$&')}%`); clauses.push(`domain.source_entity_id LIKE ?${values.length} ESCAPE '\\'`); }
  const where = clauses.join(' AND ');
  const countSql = `SELECT COUNT(*) AS total FROM yoco_v2_domain_events domain LEFT JOIN yoco_v2_sale_comparisons comparison ON comparison.workspace_id = domain.workspace_id AND comparison.source_order_id = domain.source_entity_id WHERE ${where}`;
  const rowsSql = `SELECT domain.workspace_id, domain.source_entity_id AS source_order, domain.source_entity_id AS source_order_id, domain.occurred_at AS sale_time,
      domain.resolution_status AS canonical_status,
      comparison.mapping_match_status AS mapping_status,
      comparison.legacy_sale_found, comparison.legacy_stock_movement_count,
      comparison.v2_stock_proposal_count AS v2_proposal_count,
      comparison.financial_match_status AS financial_match,
      comparison.stock_match_status AS stock_match,
      comparison.comparison_status, comparison.compared_at AS last_compared,
      (SELECT location_id FROM yoco_v2_proposed_stock_movements proposal WHERE proposal.domain_event_id = domain.id AND location_id IS NOT NULL LIMIT 1) AS location_id,
      domain.raw_event_id
    FROM yoco_v2_domain_events domain
    LEFT JOIN yoco_v2_sale_comparisons comparison ON comparison.workspace_id = domain.workspace_id AND comparison.source_order_id = domain.source_entity_id
    WHERE ${where} ORDER BY domain.occurred_at DESC, domain.id DESC LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`;
  const result = await listPage(env.DB, countSql, rowsSql, values, page);
  return response({ ok: true, available: true, ...result });
}

async function saleDetail(env: YocoV2QueueEnv, workspaceId: string, orderId: string): Promise<Response> {
  const domain = await env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND event_type = 'sale.completed' AND source_entity_id = ?2 LIMIT 1`).bind(workspaceId, orderId).first<Row>();
  if (!domain) return response({ ok: false, error: 'Canonical V2 sale not found.' }, 404);
  const [comparison, proposals, legacySale, legacyMovements, raw] = await Promise.all([
    env.DB.prepare(`SELECT * FROM yoco_v2_sale_comparisons WHERE workspace_id = ?1 AND source_order_id = ?2 LIMIT 1`).bind(workspaceId, orderId).first<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_proposed_stock_movements WHERE workspace_id = ?1 AND domain_event_id = ?2 ORDER BY source_line_id, modifier_id, ingredient_item_id`).bind(workspaceId, text(domain.id)).all<Row>(),
    env.DB.prepare(`SELECT id, yoco_order_id, location_id, status, total, gross_total, vat_total, net_total, occurred_at FROM yoco_orders WHERE workspace_id = ?1 AND yoco_order_id = ?2 AND order_type = 'sale' LIMIT 1`).bind(workspaceId, orderId).first<Row>(),
    env.DB.prepare(`SELECT stock_item_id, location_id, quantity_delta AS quantity, unit_cost, value_delta AS total_cost, movement_type, occurred_at AS created_at FROM stock_movements WHERE workspace_id = ?1 AND document_type = 'yoco_order' AND document_id = ?2 AND movement_type = 'sale_depletion' ORDER BY stock_item_id, location_id`).bind(workspaceId, orderId).all<Row>(),
    loadRawEvent(env.DB, workspaceId, text(domain.raw_event_id))
  ]);
  const canonical = redactSensitiveValue(parseJson(domain.payload_json, {}));
  const differences = comparison ? parseJson<Record<string, unknown>>(comparison.difference_summary_json, {}) : {};
  return response({
    ok: true,
    source_order: orderId,
    canonical_sale: canonical,
    historical_legacy_evidence: { reporting_record: legacySale || null, stock_movements: legacyMovements.results || [] },
    v2_effect_proposals: proposals.results || [],
    differences: redactSensitiveValue(differences),
    comparison: comparison || null,
    raw_event_id: raw?.id || domain.raw_event_id,
    available_actions: ['refetch', 'reresolve', 'repropose'].map((action) => ({ action, enabled: true, live_effects_idempotent: true, confirmation: true }))
  });
}

async function refundsList(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const page = pageRequest(url);
  const clauses = ["domain.workspace_id = ?1", "domain.event_type = 'sale.refunded'", "COALESCE(domain.resolution_status, '') <> 'SUPERSEDED'"];
  const values: unknown[] = [workspaceId];
  const status = text(url.searchParams.get('status'));
  if (status) { values.push(status); clauses.push(`workflow.overall_status = ?${values.length}`); }
  const search = text(url.searchParams.get('search'));
  if (search) { values.push(`%${search.replace(/[%_]/g, '\\$&')}%`); const p = `?${values.length}`; clauses.push(`(domain.source_entity_id LIKE ${p} ESCAPE '\\' OR workflow.source_order_id LIKE ${p} ESCAPE '\\')`); }
  const where = clauses.join(' AND ');
  const countSql = `SELECT COUNT(*) AS total FROM yoco_v2_domain_events domain LEFT JOIN yoco_v2_refund_workflows workflow ON workflow.domain_event_id = domain.id AND workflow.workspace_id = domain.workspace_id WHERE ${where}`;
  const rowsSql = `SELECT domain.workspace_id, domain.source_entity_id AS refund_id, domain.occurred_at AS refund_time,
      COALESCE(json_extract(domain.payload_json, '$.refund_type'), json_extract(domain.payload_json, '$.type'), 'UNKNOWN') AS refund_type,
      workflow.source_order_id AS original_order, workflow.current_step,
      reporting.gross_amount AS gross_refund,
      workflow.financial_status, workflow.inventory_status, workflow.reporting_status,
      workflow.reconciliation_status, workflow.overall_status,
      CASE WHEN review.status = 'OPEN' THEN 1 ELSE 0 END AS manual_review,
      raw.processing_attempts AS attempts, domain.raw_event_id
    FROM yoco_v2_domain_events domain
    LEFT JOIN yoco_v2_refund_workflows workflow ON workflow.domain_event_id = domain.id AND workflow.workspace_id = domain.workspace_id
    LEFT JOIN yoco_v2_proposed_refund_reporting reporting ON reporting.domain_event_id = domain.id AND reporting.workspace_id = domain.workspace_id
    LEFT JOIN yoco_v2_manual_reviews review ON review.domain_event_id = domain.id AND review.workspace_id = domain.workspace_id AND review.status = 'OPEN'
    LEFT JOIN yoco_v2_raw_events raw ON raw.id = domain.raw_event_id
    WHERE ${where} GROUP BY domain.id ORDER BY domain.occurred_at DESC, domain.id DESC LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`;
  const result = await listPage(env.DB, countSql, rowsSql, values, page);
  return response({ ok: true, available: true, ...result });
}

async function refundDetail(env: YocoV2QueueEnv, workspaceId: string, refundId: string): Promise<Response> {
  const domain = await env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND event_type = 'sale.refunded' AND source_entity_id = ?2 LIMIT 1`).bind(workspaceId, refundId).first<Row>();
  if (!domain) return response({ ok: false, error: 'Canonical V2 refund not found.' }, 404);
  const canonical = parseJson<Record<string, unknown>>(domain.payload_json, {});
  const sourceOrderId = text(canonical.source_order_id);
  const [workflow, reporting, proposals, comparison, reviews, legacyRefund, legacyMovements, originalLines] = await Promise.all([
    env.DB.prepare(`SELECT * FROM yoco_v2_refund_workflows WHERE workspace_id = ?1 AND refund_id = ?2 LIMIT 1`).bind(workspaceId, refundId).first<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_proposed_refund_reporting WHERE workspace_id = ?1 AND domain_event_id = ?2 LIMIT 1`).bind(workspaceId, text(domain.id)).first<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_proposed_refund_stock_movements WHERE workspace_id = ?1 AND domain_event_id = ?2 ORDER BY source_original_line_id, modifier_id, ingredient_item_id`).bind(workspaceId, text(domain.id)).all<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_refund_comparisons WHERE workspace_id = ?1 AND refund_id = ?2 LIMIT 1`).bind(workspaceId, refundId).first<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_manual_reviews WHERE workspace_id = ?1 AND domain_event_id = ?2 ORDER BY created_at`).bind(workspaceId, text(domain.id)).all<Row>(),
    env.DB.prepare(`SELECT id, yoco_order_id, parent_yoco_order_id, provider_refund_id, total, gross_total, vat_total, net_total, status, occurred_at FROM yoco_orders WHERE workspace_id = ?1 AND order_type = 'refund' AND (provider_refund_id = ?2 OR yoco_order_id = ?2) LIMIT 1`).bind(workspaceId, refundId).first<Row>(),
    env.DB.prepare(`SELECT stock_item_id, location_id, quantity_delta AS quantity, unit_cost, value_delta AS total_cost, movement_type, occurred_at AS created_at FROM stock_movements WHERE workspace_id = ?1 AND movement_type = 'sale_refund' AND (document_id = ?2 OR document_id = ?3 OR json_extract(metadata_json, '$.refundId') = ?2) ORDER BY stock_item_id, location_id`).bind(workspaceId, refundId, sourceOrderId).all<Row>(),
    env.DB.prepare(`SELECT line.yoco_line_id AS source_line, line.name AS item, line.quantity AS quantity_sold, line.total, line.raw_json FROM yoco_order_lines line JOIN yoco_orders sale ON sale.id = line.yoco_order_id AND sale.workspace_id = line.workspace_id WHERE line.workspace_id = ?1 AND sale.yoco_order_id = ?2 ORDER BY line.yoco_line_id, line.id`).bind(workspaceId, sourceOrderId).all<Row>()
  ]);
  const previousRefunds = await env.DB.prepare(`SELECT payload_json FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND event_type = 'sale.refunded' AND source_entity_id <> ?2 AND json_extract(payload_json, '$.source_order_id') = ?3 ORDER BY occurred_at`).bind(workspaceId, refundId, sourceOrderId).all<Row>();
  const refundedByLine = new Map<string, number>();
  for (const previous of previousRefunds.results || []) {
    const payload = parseJson<Record<string, unknown>>(previous.payload_json, {});
    for (const line of Array.isArray(payload.lines) ? payload.lines as Array<Record<string, unknown>> : []) {
      const id = text(line.source_original_line_id);
      if (id) refundedByLine.set(id, (refundedByLine.get(id) || 0) + Math.abs(numberValue(line.quantity)));
    }
  }
  const lines = (originalLines.results || []).map((line) => {
    const sourceLine = text(line.source_line);
    const sold = Math.abs(numberValue(line.quantity_sold));
    const previous = refundedByLine.get(sourceLine) || 0;
    return { ...line, raw_json: undefined, quantity_previously_refunded: previous, remaining_refundable_quantity: Math.max(0, sold - previous) };
  });
  return response({
    ok: true,
    refund_id: refundId,
    workflow,
    financial_summary: reporting || redactSensitiveValue(canonical),
    original_order_lines: lines,
    returned_lines: Array.isArray(canonical.lines) ? redactSensitiveValue(canonical.lines) : [],
    historical_legacy_evidence: { refund_reporting_entry: legacyRefund || null, stock_returns: legacyMovements.results || [], warnings: comparison ? redactStoredJson(comparison.difference_summary_json) : {} },
    v2_outcome: { proposed_reporting_reversal: reporting || null, proposed_stock_returns: proposals.results || [], comparison_status: comparison?.comparison_status || null },
    independent_statuses: {
      financial: workflow?.financial_status || 'PENDING',
      inventory: workflow?.inventory_status || 'PENDING',
      reporting: workflow?.reporting_status || 'PENDING',
      reconciliation: workflow?.reconciliation_status || 'PENDING'
    },
    manual_reviews: reviews.results || [],
    raw_event_id: domain.raw_event_id,
    available_actions: ['refetch', 'reresolve', 'repropose'].map((action) => ({ action, enabled: true, live_effects_idempotent: true, confirmation: true }))
  });
}

async function manualReviews(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const page = pageRequest(url);
  const clauses = ['review.workspace_id = ?1'];
  const values: unknown[] = [workspaceId];
  for (const [parameter, column] of [['status', 'review.status'], ['reviewType', 'review.review_type'], ['integration', 'review.integration_id']] as const) {
    const value = text(url.searchParams.get(parameter));
    if (value) { values.push(value); clauses.push(`${column} = ?${values.length}`); }
  }
  const where = clauses.join(' AND ');
  const countSql = `SELECT COUNT(*) AS total FROM yoco_v2_manual_reviews review WHERE ${where}`;
  const rowsSql = `SELECT review.id, review.workspace_id, review.integration_id, review.review_type, review.status, review.reason_code, review.reason_message AS reason, review.reason_message,
      review.created_at, review.resolved_at, review.resolved_by,
      domain.source_entity_id AS source_reference, domain.event_type,
      CAST((julianday(?${values.length + 1}) - julianday(review.created_at)) * 86400000 AS INTEGER) AS age_ms
    FROM yoco_v2_manual_reviews review
    LEFT JOIN yoco_v2_domain_events domain ON domain.id = review.domain_event_id AND domain.workspace_id = review.workspace_id
    WHERE ${where} ORDER BY review.created_at DESC, review.id DESC LIMIT ?${values.length + 2} OFFSET ?${values.length + 3}`;
  const count = await env.DB.prepare(countSql).bind(...values).first<{ total?: number | string }>();
  const rows = await env.DB.prepare(rowsSql).bind(...values, nowIso(), page.perPage, page.offset).all<Row>();
  const total = numberValue(count?.total);
  return response({ ok: true, rows: rows.results || [], pagination: { page: page.page, perPage: page.perPage, total, totalPages: Math.max(1, Math.ceil(total / page.perPage)) } });
}

async function manualReviewDetail(env: YocoV2QueueEnv, workspaceId: string, reviewId: string): Promise<Response> {
  const review = await env.DB.prepare(`SELECT * FROM yoco_v2_manual_reviews WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`).bind(workspaceId, reviewId).first<Row>();
  if (!review) return response({ ok: false, error: 'Manual review not found.' }, 404);
  const domain = review.domain_event_id ? await env.DB.prepare(`SELECT id, raw_event_id, event_type, source_entity_id, payload_json, occurred_at, resolution_status FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`).bind(workspaceId, text(review.domain_event_id)).first<Row>() : null;
  return response({
    ok: true,
    review: {
      ...review,
      available_source_lines: redactStoredJson(review.available_source_lines_json),
      refund_financials: redactStoredJson(review.refund_financials_json),
      proposed_allocation: redactStoredJson(review.proposed_allocation_json),
      resolved_allocation: redactStoredJson(review.resolved_allocation_json),
      audit_history: redactStoredJson(review.audit_history_json),
      available_source_lines_json: undefined,
      refund_financials_json: undefined,
      proposed_allocation_json: undefined,
      resolved_allocation_json: undefined,
      audit_history_json: undefined
    },
    domain_event: domain ? { ...domain, payload: redactStoredJson(domain.payload_json), payload_json: undefined } : null,
    approval_requires_confirmation: true,
    live_effects: false
  });
}

async function approveManualAllocation(request: Request, env: YocoV2QueueEnv, auth: AuthContext, workspaceId: string, reviewId: string): Promise<Response> {
  requireYocoV2AdminPermission(auth, 'yoco_v2.manual_review');
  const body = await readJsonBody<{ allocation?: Array<{ source_original_line_id: string; quantity: number }>; acknowledge_financial_difference?: boolean; reason?: string; confirmed?: boolean }>(request);
  if (body.confirmed !== true) return response({ ok: false, error: 'Explicit confirmation is required.' }, 409);
  const review = await env.DB.prepare(`SELECT * FROM yoco_v2_manual_reviews WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`).bind(workspaceId, reviewId).first<Row>();
  if (!review) return response({ ok: false, error: 'Manual review not found.' }, 404);
  if (text(review.status) !== 'OPEN') return response({ ok: false, error: 'Only open reviews can be approved.' }, 409);
  const action = await beginAdminAction(request, env, auth, workspaceId, {
    integrationId: text(review.integration_id),
    action: 'manual_review.approve_allocation',
    targetType: 'manual_review',
    targetId: reviewId,
    previousState: review,
    reason: text(body.reason)
  });
  if (action.duplicateResult) return response({ ok: true, ...action.duplicateResult });
  try {
    const saved = await saveManualRefundAllocation(env, {
      workspaceId,
      reviewId,
      allocation: Array.isArray(body.allocation) ? body.allocation : [],
      resolvedBy: auth.uid,
      acknowledgeFinancialDifference: Boolean(body.acknowledge_financial_difference)
    });
    const domain = await env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`).bind(workspaceId, text(saved.domain_event_id)).first<Row>();
    let queued = false;
    if (domain) {
      const event = await loadRawEvent(env.DB, workspaceId, text(domain.raw_event_id));
      const flags = yocoV2FeatureFlags(env, workspaceId);
      if (event && flags.yoco_v2_queue_enabled) {
        await resetForCanonicalReplay(env.DB, event, false);
        await publishCanonicalReplay(env, event, 'manual-review-approved', { force_refresh: false, rerun_stage: 'all', live_effects: true });
        await markRawEventQueued(env.DB, text(event.id));
        await appendTimeline(env.DB, {
          rawEventId: text(event.id),
          step: 'MANUAL_REVIEW_APPROVED',
          status: 'QUEUED',
          message: 'Authorised manual allocation saved and controlled re-resolution queued. Live refund effects remain ownership and feature gated.',
          metadata: { actor_uid: auth.uid, review_id: reviewId, action_id: action.id, live_effects: true }
        });
        queued = true;
      }
    }
    const result = { review: saved, rebuild_queued: queued, live_effects: true };
    await completeAdminAction(env.DB, action, 'COMPLETED', result);
    return response({ ok: true, ...result, action_id: action.id });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await completeAdminAction(env.DB, action, 'FAILED', { error: message });
    return response({ ok: false, error: message, action_id: action.id }, 400);
  }
}

async function reconciliationRuns(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const page = pageRequest(url);
  const clauses = ['workspace_id = ?1'];
  const values: unknown[] = [workspaceId];
  const status = text(url.searchParams.get('status'));
  if (status) { values.push(status); clauses.push(`status = ?${values.length}`); }
  const where = clauses.join(' AND ');
  const countSql = `SELECT COUNT(*) AS total FROM yoco_v2_reconciliation_runs WHERE ${where}`;
  const rowsSql = `SELECT *, missing_events_found AS missing_events, mismatches_found AS mismatches, manual_reviews_created AS manual_reviews, CAST((julianday(COALESCE(completed_at, ?${values.length + 1})) - julianday(started_at)) * 86400000 AS INTEGER) AS duration_ms FROM yoco_v2_reconciliation_runs WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT ?${values.length + 2} OFFSET ?${values.length + 3}`;
  const count = await env.DB.prepare(countSql).bind(...values).first<{ total?: number | string }>();
  const rows = await env.DB.prepare(rowsSql).bind(...values, nowIso(), page.perPage, page.offset).all<Row>();
  const total = numberValue(count?.total);
  return response({ ok: true, rows: rows.results || [], pagination: { page: page.page, perPage: page.perPage, total, totalPages: Math.max(1, Math.ceil(total / page.perPage)) } });
}

async function reconciliationRunDetail(env: YocoV2QueueEnv, workspaceId: string, runId: string): Promise<Response> {
  const run = await env.DB.prepare(`SELECT * FROM yoco_v2_reconciliation_runs WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`).bind(workspaceId, runId).first<Row>();
  if (!run) return response({ ok: false, error: 'Reconciliation run not found.' }, 404);
  const findings = await env.DB.prepare(`SELECT * FROM yoco_v2_reconciliation_findings WHERE workspace_id = ?1 AND reconciliation_run_id = ?2 ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'ERROR' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END, created_at, id`).bind(workspaceId, runId).all<Row>();
  const bySeverity: Record<string, number> = {};
  for (const row of findings.results || []) bySeverity[text(row.severity, 'UNKNOWN')] = (bySeverity[text(row.severity, 'UNKNOWN')] || 0) + 1;
  return response({
    ok: true,
    run: { ...run, duration_ms: durationMs(run.started_at, run.completed_at), errors: redactStoredJson(run.error_summary_json), error_summary_json: undefined },
    checkpoint_before: run.checkpoint_before || null,
    checkpoint_after: run.checkpoint_after || null,
    coverage_window: { start: run.window_start, end: run.window_end },
    overlap_window: null,
    rate_limit_pauses: numberValue((parseJson<Record<string, unknown>>(run.error_summary_json, {})).rate_limit_pauses),
    findings_by_severity: bySeverity,
    repairs_performed: numberValue(run.automatic_repairs),
    findings: (findings.results || []).map((row) => ({ ...row, details: redactStoredJson(row.details_json), details_json: undefined }))
  });
}

async function runReconciliation(request: Request, env: YocoV2QueueEnv, auth: AuthContext, workspaceId: string): Promise<Response> {
  requireYocoV2AdminPermission(auth, 'yoco_v2.reconcile');
  const body = await readJsonBody<{ integration_id?: string; window_start?: string; window_end?: string; deep?: boolean; force?: boolean; confirmed?: boolean; reason?: string }>(request);
  const integrationId = text(body.integration_id, `yoco:${workspaceId}`);
  const end = Number.isFinite(Date.parse(text(body.window_end))) ? new Date(text(body.window_end)).toISOString() : nowIso();
  const start = Number.isFinite(Date.parse(text(body.window_start))) ? new Date(text(body.window_start)).toISOString() : new Date(Date.parse(end) - 24 * 60 * 60_000).toISOString();
  const days = Math.max(0, (Date.parse(end) - Date.parse(start)) / 86_400_000);
  if (days > 31 && body.confirmed !== true) return response({ ok: false, error: 'Date ranges over 31 days require explicit confirmation.' }, 409);
  if (days > 90) return response({ ok: false, error: 'Reconciliation is limited to 90 days per run.' }, 400);
  const action = await beginAdminAction(request, env, auth, workspaceId, {
    integrationId,
    action: 'reconciliation.run',
    targetType: 'reconciliation_window',
    targetId: `${start}:${end}`,
    previousState: { window_start: start, window_end: end },
    reason: text(body.reason)
  });
  if (action.duplicateResult) return response({ ok: true, ...action.duplicateResult });
  try {
    const run = await runYocoV2Reconciliation(env, workspaceId, integrationId, {
      windowStart: start,
      windowEnd: end,
      deep: Boolean(body.deep),
      force: Boolean(body.force),
      traceId: action.traceId
    });
    await completeAdminAction(env.DB, action, 'COMPLETED', run);
    return response({ ok: true, run, action_id: action.id, trace_id: action.traceId });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await completeAdminAction(env.DB, action, 'FAILED', { error: message });
    return response({ ok: false, error: message, action_id: action.id }, 409);
  }
}

async function reconciliationFindings(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const page = pageRequest(url);
  const clauses = ['workspace_id = ?1'];
  const values: unknown[] = [workspaceId];
  for (const [parameter, column] of [['status', 'status'], ['severity', 'severity'], ['findingType', 'finding_type']] as const) {
    const value = text(url.searchParams.get(parameter));
    if (value) { values.push(value); clauses.push(`${column} = ?${values.length}`); }
  }
  const where = clauses.join(' AND ');
  const countSql = `SELECT COUNT(*) AS total FROM yoco_v2_reconciliation_findings WHERE ${where}`;
  const rowsSql = `SELECT * FROM yoco_v2_reconciliation_findings WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`;
  const result = await listPage(env.DB, countSql, rowsSql, values, page);
  return response({ ok: true, ...result, rows: result.rows.map((row) => ({ ...row, details: redactStoredJson(row.details_json), details_json: undefined })) });
}

async function reconciliationFindingAction(
  request: Request,
  env: YocoV2QueueEnv,
  auth: AuthContext,
  workspaceId: string,
  findingId: string,
  requestedAction: 'retry' | 'refetch' | 'rerun-resolver' | 'manual-review'
): Promise<Response> {
  const body = await readJsonBody<{ confirmed?: boolean; reason?: string }>(request.clone());
  if (body.confirmed !== true) return response({ ok: false, error: 'Explicit confirmation is required.' }, 409);
  const finding = await env.DB.prepare(`SELECT * FROM yoco_v2_reconciliation_findings WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`).bind(workspaceId, findingId).first<Row>();
  if (!finding) return response({ ok: false, error: 'Reconciliation finding not found.' }, 404);
  const details = parseJson<Record<string, unknown>>(finding.details_json, {});
  const domain = await env.DB.prepare(`SELECT id, raw_event_id FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND source_entity_id = ?2 ORDER BY created_at DESC LIMIT 1`).bind(workspaceId, text(finding.source_entity_id)).first<Row>();
  const rawEventId = text(domain?.raw_event_id || details.raw_event_id || details.rawEventId);
  const reason = text(body.reason, `Administrator action for reconciliation finding ${findingId}.`);

  if (requestedAction === 'manual-review') {
    requireYocoV2AdminPermission(auth, 'yoco_v2.manual_review');
    const duplicate = await existingAdminAction(request, env.DB, workspaceId);
    if (duplicate) return response({ ok: true, ...duplicate });
    const action = await beginAdminAction(request, env, auth, workspaceId, {
      integrationId: text(finding.integration_id), action: 'reconciliation_finding.manual_review',
      targetType: 'reconciliation_finding', targetId: findingId, previousState: finding, reason
    });
    const reviewId = newId('yoco_v2_manual_review');
    await env.DB.prepare(`INSERT INTO yoco_v2_manual_reviews
      (id, workspace_id, integration_id, domain_event_id, review_type, status, reason_code, reason_message,
       available_source_lines_json, refund_financials_json, proposed_allocation_json, resolved_allocation_json,
       audit_history_json, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'Other', 'OPEN', 'RECONCILIATION_FINDING', ?5, '[]', '{}', '[]', '[]', ?6, ?7, ?7)`
    ).bind(reviewId, workspaceId, text(finding.integration_id), domain?.id || null, reason,
      JSON.stringify([{ action: 'CREATED_FROM_RECONCILIATION', actor_uid: auth.uid, finding_id: findingId, action_id: action.id, at: nowIso() }]), nowIso()).run();
    await env.DB.prepare(`UPDATE yoco_v2_reconciliation_findings SET repair_action = 'MANUAL_REVIEW', status = 'MANUAL_REVIEW' WHERE workspace_id = ?1 AND id = ?2`).bind(workspaceId, findingId).run();
    const result = { finding_id: findingId, manual_review_id: reviewId, live_effects: false };
    await completeAdminAction(env.DB, action, 'COMPLETED', result);
    return response({ ok: true, ...result, action_id: action.id });
  }

  requireYocoV2AdminPermission(auth, 'yoco_v2.reconcile');
  if (!rawEventId) return response({ ok: false, error: 'This finding has no linked raw event to replay. Send it to manual review instead.' }, 409);
  const mode = requestedAction === 'refetch' ? 'refetch'
    : requestedAction === 'rerun-resolver' ? 'reresolve' : 'replay';
  return performEventReplay(request, env, auth, workspaceId, rawEventId, mode, `${reason} Finding: ${findingId}.`);
}

async function apiHealth(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const { from, to } = dateRange(url);
  const [summary, endpoints, runtime] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS requests, SUM(CASE WHEN response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success, SUM(CASE WHEN cache_status = 'HIT' THEN 1 ELSE 0 END) AS cache_hits, SUM(CASE WHEN cache_status <> 'HIT' THEN 1 ELSE 0 END) AS cache_misses, SUM(CASE WHEN response_status = 429 THEN 1 ELSE 0 END) AS responses_429, SUM(CASE WHEN response_status IN (401,403) THEN 1 ELSE 0 END) AS responses_401_403, SUM(CASE WHEN error_category = 'TIMEOUT' OR error_code LIKE '%TIMEOUT%' THEN 1 ELSE 0 END) AS timeouts, SUM(CASE WHEN response_status >= 500 THEN 1 ELSE 0 END) AS responses_5xx, AVG(duration_ms) AS average_duration_ms FROM yoco_v2_api_requests WHERE workspace_id = ?1 AND created_at >= ?2 AND created_at <= ?3`).bind(workspaceId, from, to).first<Row>(),
    env.DB.prepare(`SELECT endpoint_name, COUNT(*) AS requests, SUM(CASE WHEN response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success, SUM(CASE WHEN response_status = 429 THEN 1 ELSE 0 END) AS responses_429, AVG(duration_ms) AS average_duration_ms FROM yoco_v2_api_requests WHERE workspace_id = ?1 AND created_at >= ?2 AND created_at <= ?3 GROUP BY endpoint_name ORDER BY requests DESC, endpoint_name LIMIT 100`).bind(workspaceId, from, to).all<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_integration_runtime WHERE workspace_id = ?1 ORDER BY updated_at DESC`).bind(workspaceId).all<Row>()
  ]);
  const requests = numberValue(summary?.requests);
  return response({ ok: true, range: { from, to }, summary: { ...summary, success_rate: requests ? Math.round((numberValue(summary?.success) / requests) * 10_000) / 100 : null, average_duration_ms: summary?.average_duration_ms == null ? null : Math.round(numberValue(summary.average_duration_ms)) }, requests_by_endpoint: endpoints.results || [], integration_pause_state: runtime.results || [] });
}

async function apiRequests(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const page = pageRequest(url);
  const clauses = ['workspace_id = ?1'];
  const values: unknown[] = [workspaceId];
  for (const [parameter, column] of [['endpoint', 'endpoint_name'], ['integration', 'integration_id'], ['errorCategory', 'error_category'], ['cache', 'cache_status']] as const) {
    const value = text(url.searchParams.get(parameter));
    if (value) { values.push(value); clauses.push(`${column} = ?${values.length}`); }
  }
  const status = numberValue(url.searchParams.get('httpStatus'), -1);
  if (status >= 0) { values.push(status); clauses.push(`response_status = ?${values.length}`); }
  const rateLimited = text(url.searchParams.get('rateLimited'));
  if (rateLimited === 'true' || rateLimited === 'false') { values.push(rateLimited === 'true' ? 1 : 0); clauses.push(`rate_limited = ?${values.length}`); }
  const { from, to } = dateRange(url);
  values.push(from); clauses.push(`created_at >= ?${values.length}`);
  values.push(to); clauses.push(`created_at <= ?${values.length}`);
  const where = clauses.join(' AND ');
  const countSql = `SELECT COUNT(*) AS total FROM yoco_v2_api_requests WHERE ${where}`;
  const rowsSql = `SELECT id, workspace_id, integration_id, raw_event_id, processing_run_id, trace_id, method, endpoint_name, resource_id, attempt, request_started_at, request_completed_at, duration_ms, response_status, rate_limited, retry_after_seconds, cache_status, error_category, error_code, redacted_metadata_json, created_at FROM yoco_v2_api_requests WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`;
  const result = await listPage(env.DB, countSql, rowsSql, values, page);
  return response({ ok: true, ...result, rows: result.rows.map((row) => ({ ...row, redacted_metadata: redactStoredJson(row.redacted_metadata_json), redacted_metadata_json: undefined })) });
}

async function deadLetters(env: YocoV2QueueEnv, workspaceId: string, url: URL): Promise<Response> {
  const page = pageRequest(url);
  const values: unknown[] = [workspaceId, nowIso()];
  const countSql = `SELECT COUNT(*) AS total FROM yoco_v2_raw_events WHERE workspace_id = ?1 AND processing_status IN ('DEAD_LETTERED','FAILED_PERMANENTLY')`;
  const rowsSql = `SELECT event.id, event.workspace_id, event.integration_id, event.event_type, event.yoco_event_id,
      COALESCE(domain.source_entity_id, event.yoco_event_id, event.event_key) AS source_reference,
      event.processing_attempts AS attempts, run.current_step AS last_step,
      COALESCE(run.error_category, event.last_error_code) AS error_category,
      COALESCE(run.error_message, event.last_error_message) AS last_error,
      event.updated_at AS dead_lettered_at,
      CAST((julianday(?2) - julianday(event.updated_at)) * 86400000 AS INTEGER) AS age_ms,
      event.trace_id
    FROM yoco_v2_raw_events event
    LEFT JOIN yoco_v2_domain_events domain ON domain.raw_event_id = event.id
    LEFT JOIN yoco_v2_processing_runs run ON run.raw_event_id = event.id AND run.attempt_number = (SELECT MAX(last.attempt_number) FROM yoco_v2_processing_runs last WHERE last.raw_event_id = event.id)
    WHERE event.workspace_id = ?1 AND event.processing_status IN ('DEAD_LETTERED','FAILED_PERMANENTLY')
    GROUP BY event.id ORDER BY event.updated_at DESC, event.id DESC LIMIT ?3 OFFSET ?4`;
  const count = await env.DB.prepare(countSql).bind(workspaceId).first<{ total?: number | string }>();
  const rows = await env.DB.prepare(rowsSql).bind(...values, page.perPage, page.offset).all<Row>();
  const total = numberValue(count?.total);
  return response({ ok: true, rows: rows.results || [], pagination: { page: page.page, perPage: page.perPage, total, totalPages: Math.max(1, Math.ceil(total / page.perPage)) } });
}

async function markManualReview(request: Request, env: YocoV2QueueEnv, auth: AuthContext, workspaceId: string, rawEventId: string): Promise<Response> {
  requireYocoV2AdminPermission(auth, 'yoco_v2.manual_review');
  const body = await readJsonBody<{ reason?: string; confirmed?: boolean }>(request);
  if (body.confirmed !== true) return response({ ok: false, error: 'Explicit confirmation is required.' }, 409);
  const event = await loadRawEvent(env.DB, workspaceId, rawEventId);
  if (!event) return response({ ok: false, error: 'V2 raw event not found.' }, 404);
  const domain = await env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND raw_event_id = ?2 ORDER BY created_at LIMIT 1`).bind(workspaceId, rawEventId).first<Row>();
  const action = await beginAdminAction(request, env, auth, workspaceId, {
    integrationId: text(event.integration_id), action: 'event.manual_review', targetType: 'raw_event', targetId: rawEventId,
    previousState: { processing_status: event.processing_status }, reason: text(body.reason)
  });
  if (action.duplicateResult) return response({ ok: true, ...action.duplicateResult });
  try {
    await env.DB.prepare(`UPDATE yoco_v2_raw_events SET processing_status = 'MANUAL_REVIEW_REQUIRED', updated_at = ?3 WHERE workspace_id = ?1 AND id = ?2`).bind(workspaceId, rawEventId, nowIso()).run();
    const reviewId = newId('yoco_v2_manual_review');
    await env.DB.prepare(`INSERT INTO yoco_v2_manual_reviews (id, workspace_id, integration_id, domain_event_id, review_type, status, reason_code, reason_message, available_source_lines_json, refund_financials_json, proposed_allocation_json, resolved_allocation_json, audit_history_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'Other', 'OPEN', 'ADMIN_REVIEW', ?5, '[]', '{}', '[]', '[]', ?6, ?7, ?7)`).bind(reviewId, workspaceId, text(event.integration_id), domain?.id || null, text(body.reason, 'Administrator requested manual review.'), JSON.stringify([{ action: 'CREATED', actor_uid: auth.uid, action_id: action.id, at: nowIso() }]), nowIso()).run();
    await appendTimeline(env.DB, { rawEventId, step: 'MANUAL_REVIEW_MARKED', status: 'MANUAL_REVIEW_REQUIRED', message: 'Administrator sent the event to manual review.', metadata: { actor_uid: auth.uid, reason: text(body.reason), review_id: reviewId, action_id: action.id } });
    const result = { status: 'MANUAL_REVIEW_REQUIRED', review_id: reviewId };
    await completeAdminAction(env.DB, action, 'COMPLETED', result);
    return response({ ok: true, ...result, action_id: action.id });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await completeAdminAction(env.DB, action, 'FAILED', { error: message });
    return response({ ok: false, error: message, action_id: action.id }, 400);
  }
}

async function closeDeadLetter(request: Request, env: YocoV2QueueEnv, auth: AuthContext, workspaceId: string, rawEventId: string): Promise<Response> {
  requireYocoV2AdminPermission(auth, 'yoco_v2.replay');
  const body = await readJsonBody<{ reason?: string; confirmed?: boolean }>(request);
  const reason = text(body.reason);
  if (body.confirmed !== true || reason.length < 5) return response({ ok: false, error: 'Confirmation and a closure reason are required.' }, 409);
  const event = await loadRawEvent(env.DB, workspaceId, rawEventId);
  if (!event) return response({ ok: false, error: 'Dead-letter event not found.' }, 404);
  if (!['DEAD_LETTERED', 'FAILED_PERMANENTLY'].includes(text(event.processing_status))) return response({ ok: false, error: 'Event is not in dead letter.' }, 409);
  const action = await beginAdminAction(request, env, auth, workspaceId, { integrationId: text(event.integration_id), action: 'dead_letter.close', targetType: 'raw_event', targetId: rawEventId, previousState: event, reason });
  if (action.duplicateResult) return response({ ok: true, ...action.duplicateResult });
  await env.DB.prepare(`UPDATE yoco_v2_raw_events SET processing_status = 'FAILED_PERMANENTLY', updated_at = ?3 WHERE workspace_id = ?1 AND id = ?2`).bind(workspaceId, rawEventId, nowIso()).run();
  await appendTimeline(env.DB, { rawEventId, step: 'DEAD_LETTER_PERMANENTLY_CLOSED', status: 'FAILED_PERMANENTLY', message: 'Administrator permanently closed the dead-letter item. Historical failures were retained.', metadata: { actor_uid: auth.uid, reason, action_id: action.id } });
  const result = { status: 'FAILED_PERMANENTLY', reason };
  await completeAdminAction(env.DB, action, 'COMPLETED', result);
  return response({ ok: true, ...result, action_id: action.id });
}

async function locationReadiness(env: YocoV2QueueEnv, workspaceId: string): Promise<Response> {
  const [mapped, seen] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, external_location_id FROM locations
        WHERE workspace_id = ?1 AND lower(COALESCE(external_provider, '')) = 'yoco' AND active = 1
        ORDER BY name`
    ).bind(workspaceId).all<Row>(),
    env.DB.prepare(
      `SELECT json_extract(payload_json, '$.source_location_id') AS yoco_location_id,
              COUNT(*) AS event_count,
              SUM(CASE WHEN resolution_status = 'LOCATION_MAPPING_MISSING' THEN 1 ELSE 0 END) AS mapping_missing_count,
              MAX(occurred_at) AS last_seen
         FROM yoco_v2_domain_events
        WHERE workspace_id = ?1 AND event_type IN ('sale.completed', 'sale.refunded')
          AND json_extract(payload_json, '$.source_location_id') IS NOT NULL
          AND json_extract(payload_json, '$.source_location_id') <> ''
        GROUP BY yoco_location_id
        ORDER BY event_count DESC`
    ).bind(workspaceId).all<Row>()
  ]);
  const mappedIds = new Set((mapped.results || []).map((row) => text(row.external_location_id)).filter(Boolean));
  const seenLocations = (seen.results || []).map((row) => ({
    yoco_location_id: text(row.yoco_location_id),
    event_count: numberValue(row.event_count),
    mapping_missing_count: numberValue(row.mapping_missing_count),
    last_seen: row.last_seen || null,
    mapped: mappedIds.has(text(row.yoco_location_id))
  }));
  const unmapped = seenLocations.filter((row) => !row.mapped);
  return response({
    ok: true,
    ready: unmapped.length === 0,
    seen_count: seenLocations.length,
    mapped_count: mappedIds.size,
    unmapped_count: unmapped.length,
    mapped_locations: mapped.results || [],
    seen_locations: seenLocations,
    unmapped_locations: unmapped
  });
}

async function configuration(env: YocoV2QueueEnv, auth: AuthContext, workspaceId: string): Promise<Response> {
  const flags = yocoV2FeatureFlags(env, workspaceId);
  const [ownership, runtime, lastWebhook, lastApi, lastReconciliation] = await Promise.all([
    env.DB.prepare(`SELECT * FROM integration_effect_ownership WHERE workspace_id = ?1 AND integration_type = 'YOCO' ORDER BY effect_type`).bind(workspaceId).all<Row>(),
    env.DB.prepare(`SELECT * FROM yoco_v2_integration_runtime WHERE workspace_id = ?1 ORDER BY updated_at DESC`).bind(workspaceId).all<Row>(),
    env.DB.prepare(`SELECT MAX(received_at) AS value FROM yoco_v2_webhook_receipts WHERE workspace_id = ?1`).bind(workspaceId).first<Row>(),
    env.DB.prepare(`SELECT MAX(created_at) AS value FROM yoco_v2_api_requests WHERE workspace_id = ?1 AND response_status BETWEEN 200 AND 299`).bind(workspaceId).first<Row>(),
    env.DB.prepare(`SELECT MAX(completed_at) AS value FROM yoco_v2_reconciliation_runs WHERE workspace_id = ?1 AND status = 'COMPLETED'`).bind(workspaceId).first<Row>()
  ]);
  const ownershipRows = ownership.results || [];
  const requiredEffects = ['SALE_REPORTING', 'SALE_STOCK', 'REFUND_REPORTING', 'REFUND_STOCK'];
  const owned = new Map(ownershipRows.map((row) => [text(row.effect_type), row]));
  const allV2 = requiredEffects.every((effect) => {
    const row = owned.get(effect);
    return text(row?.engine_version).toUpperCase() === 'V2' && numberValue(row?.enabled) === 1;
  });
  const environment = text(env.ENVIRONMENT, 'local').toLowerCase();
  return response({
    ok: true,
    release: RELEASE,
    environment: environment === 'production' ? 'Production' : environment === 'staging' ? 'Staging' : 'Local',
    permissions: permissionPayload(auth),
    mode: allV2 ? 'V2 live' : 'Blocked: V2 ownership incomplete',
    capture: { enabled: flags.yoco_v2_capture_enabled, read_only: true },
    queue: { enabled: flags.yoco_v2_queue_enabled, read_only: true },
    admin: { enabled: flags.yoco_v2_admin_enabled, read_only: true },
    live_effects: {
      sale_reporting: flags.yoco_v2_live_sale_reporting,
      sale_stock: flags.yoco_v2_live_sale_stock,
      refund_reporting: flags.yoco_v2_live_refund_reporting,
      refund_stock: flags.yoco_v2_live_refund_stock,
      read_only: true
    },
    effect_ownership: ownershipRows,
    ownership_all_v2: allV2,
    ownership_warning: allV2 ? null : 'All four Yoco effects must be explicitly owned by V2 before processing can apply authoritative effects.',
    integration_state: {
      active: runtime.results?.some((row) => !row.paused_until && numberValue(row.intervention_required) === 0) || false,
      paused: runtime.results?.some((row) => Boolean(row.paused_until) || numberValue(row.intervention_required) === 1) || false,
      pause_reason: runtime.results?.map((row) => row.pause_reason).filter(Boolean).join('; ') || null,
      last_successful_api_call: lastApi?.value || null,
      last_webhook: lastWebhook?.value || null,
      last_reconciliation: lastReconciliation?.value || null
    },
    effect_controls: { permission_exists: hasYocoV2AdminPermission(auth, 'yoco_v2.cutover'), usable: true, reason: null }
  });
}


async function modifierEngineDiagnostics(
  env: YocoV2QueueEnv,
  workspaceId: string,
  url: URL,
): Promise<Response> {
  const page = pageRequest(url);
  const status = text(url.searchParams.get('status')).toUpperCase();
  const clauses = ['comparison.workspace_id = ?1'];
  const values: unknown[] = [workspaceId];
  if (status && ['MATCH', 'MISMATCH', 'PENDING'].includes(status)) {
    values.push(status);
    clauses.push(`comparison.comparison_status = ?${values.length}`);
  }
  const search = text(url.searchParams.get('search'));
  if (search) {
    values.push(`%${search.replace(/[%_]/g, '\\$&')}%`);
    const p = `?${values.length}`;
    clauses.push(`(comparison.source_order_id LIKE ${p} ESCAPE '\\'
      OR comparison.source_line_id LIKE ${p} ESCAPE '\\'
      OR COALESCE(product.name, '') LIKE ${p} ESCAPE '\\'
      OR comparison.mismatch_reason LIKE ${p} ESCAPE '\\')`);
  }
  const where = clauses.join(' AND ');
  const countSql = `SELECT COUNT(*) AS total
    FROM modifier_engine_comparisons comparison
    LEFT JOIN products product ON product.workspace_id = comparison.workspace_id AND product.id = comparison.menu_item_id
    WHERE ${where}`;
  const rowsSql = `SELECT comparison.*, product.name AS menu_item_name
    FROM modifier_engine_comparisons comparison
    LEFT JOIN products product ON product.workspace_id = comparison.workspace_id AND product.id = comparison.menu_item_id
    WHERE ${where}
    ORDER BY comparison.compared_at DESC, comparison.id DESC
    LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`;
  const [result, control, ownership, totals] = await Promise.all([
    listPage(env.DB, countSql, rowsSql, values, page),
    getModifierEngineControl(env, workspaceId),
    env.DB.prepare(
      `SELECT engine_version, enabled, enabled_at, enabled_by, updated_at
         FROM integration_effect_ownership
        WHERE workspace_id = ?1 AND integration_type = 'YOCO' AND effect_type = 'SALE_STOCK'
        LIMIT 1`,
    ).bind(workspaceId).first<Row>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS comparisons,
              SUM(CASE WHEN comparison_status = 'MATCH' THEN 1 ELSE 0 END) AS matches,
              SUM(CASE WHEN comparison_status = 'MISMATCH' THEN 1 ELSE 0 END) AS mismatches,
              SUM(CASE WHEN comparison_status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN ABS(quantity_difference) > 0.000001 THEN 1 ELSE 0 END) AS quantity_differences,
              SUM(CASE WHEN ABS(cost_difference) > 0.01 THEN 1 ELSE 0 END) AS cost_differences,
              MAX(compared_at) AS last_compared_at
         FROM modifier_engine_comparisons
        WHERE workspace_id = ?1
          AND compared_at >= COALESCE(
            (SELECT observation_started_at
               FROM modifier_engine_workspace_controls
              WHERE workspace_id = ?1),
            ''
          )`,
    ).bind(workspaceId).first<Row>(),
  ]);
  const saleStockOwnedByV2 = text(ownership?.engine_version).toUpperCase() === 'V2' && numberValue(ownership?.enabled) === 1;
  return response({
    ok: true,
    control,
    ownership: {
      sale_stock_engine: text(ownership?.engine_version, 'UNASSIGNED'),
      sale_stock_enabled: numberValue(ownership?.enabled) === 1,
      authoritative_writer: saleStockOwnedByV2 ? 'V2' : 'LEGACY',
      modifier_path: text(control.mode).toUpperCase() === 'LIVE'
        ? 'NEW_MODIFIER_ENGINE'
        : 'EXISTING_MODIFIER_BASELINE',
      updated_at: ownership?.updated_at || ownership?.enabled_at || null,
    },
    summary: {
      comparisons: numberValue(totals?.comparisons),
      matches: numberValue(totals?.matches),
      mismatches: numberValue(totals?.mismatches),
      pending: numberValue(totals?.pending),
      quantity_differences: numberValue(totals?.quantity_differences),
      cost_differences: numberValue(totals?.cost_differences),
      last_compared_at: totals?.last_compared_at || null,
      ready_for_live: saleStockOwnedByV2
        && numberValue(totals?.comparisons) > 0
        && numberValue(totals?.mismatches) === 0
        && numberValue(totals?.pending) === 0,
    },
    ...result,
    rows: result.rows.map((row) => ({
      id: text(row.id),
      order: text(row.source_order_id),
      line_item: text(row.menu_item_name || row.source_line_id),
      source_line_id: text(row.source_line_id),
      old_resolved_usage: parseJson(row.old_resolved_usage_json, []),
      new_resolved_usage: parseJson(row.new_resolved_usage_json, []),
      quantity_difference: numberValue(row.quantity_difference),
      cost_difference: numberValue(row.cost_difference),
      reason: text(row.mismatch_reason),
      status: text(row.comparison_status),
      compared_at: text(row.compared_at),
    })),
  });
}

async function updateModifierEngineControl(
  request: Request,
  env: YocoV2QueueEnv,
  auth: AuthContext,
  workspaceId: string,
): Promise<Response> {
  requireYocoV2AdminPermission(auth, 'yoco_v2.cutover');
  const body = await readJsonBody<{
    mode?: string;
    reason?: string;
    confirmed?: boolean;
    rollbackHours?: number;
  }>(request);
  if (body.confirmed !== true) return response({ ok: false, error: 'Explicit confirmation is required.' }, 409);
  const mode = text(body.mode).toUpperCase();
  if (!['LEGACY_WRITE', 'OBSERVE', 'LIVE', 'ROLLED_BACK'].includes(mode)) {
    return response({ ok: false, error: 'Modifier engine mode is invalid.' }, 400);
  }
  const reason = text(body.reason);
  if (reason.length < 8) return response({ ok: false, error: 'A meaningful cutover reason is required.' }, 400);

  const current = await getModifierEngineControl(env, workspaceId);
  const [ownership, observation] = await Promise.all([
    env.DB.prepare(
      `SELECT engine_version, enabled FROM integration_effect_ownership
        WHERE workspace_id = ?1 AND integration_type = 'YOCO' AND effect_type = 'SALE_STOCK'
        LIMIT 1`,
    ).bind(workspaceId).first<Row>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS comparisons,
              SUM(CASE WHEN comparison_status = 'MISMATCH' THEN 1 ELSE 0 END) AS mismatches,
              SUM(CASE WHEN comparison_status = 'PENDING' THEN 1 ELSE 0 END) AS pending
         FROM modifier_engine_comparisons
        WHERE workspace_id = ?1
          AND (?2 = '' OR compared_at >= ?2)`,
    ).bind(workspaceId, text(current.observation_started_at)).first<Row>(),
  ]);
  const saleStockOwnedByV2 = text(ownership?.engine_version).toUpperCase() === 'V2' && numberValue(ownership?.enabled) === 1;
  if (mode === 'LIVE') {
    if (!saleStockOwnedByV2) {
      return response({ ok: false, error: 'SALE_STOCK must be explicitly owned and enabled by V2 before modifier cutover.' }, 409);
    }
    if (numberValue(observation?.comparisons) < 1 || numberValue(observation?.mismatches) > 0 || numberValue(observation?.pending) > 0) {
      return response({
        ok: false,
        error: 'Modifier cutover is blocked until the observation period has comparisons with no mismatches or pending rows.',
        observation: {
          comparisons: numberValue(observation?.comparisons),
          mismatches: numberValue(observation?.mismatches),
          pending: numberValue(observation?.pending),
        },
      }, 409);
    }
  }
  if (mode === 'ROLLED_BACK') {
    const rollbackUntil = Date.parse(text(current.rollback_available_until));
    if (!Number.isFinite(rollbackUntil) || Date.now() > rollbackUntil) {
      return response({ ok: false, error: 'The temporary modifier rollback window is no longer available.' }, 409);
    }
  }
  const control = await setModifierEngineMode(env, {
    workspaceId,
    mode: mode as 'LEGACY_WRITE' | 'OBSERVE' | 'LIVE' | 'ROLLED_BACK',
    actor: auth.email || auth.uid,
    reason,
    rollbackHours: numberValue(body.rollbackHours, 72),
  });
  return response({
    ok: true,
    control,
    authoritative_sale_stock_writer: saleStockOwnedByV2 ? 'V2' : 'LEGACY',
    no_double_write: true,
  });
}

async function configurationUpdate(request: Request, auth: AuthContext): Promise<Response> {
  requireYocoV2AdminPermission(auth, 'yoco_v2.configure');
  const body = await readJsonBody<Record<string, unknown>>(request);
  const attemptedLive = LIVE_EFFECT_KEYS.some((key) => body[key] === true) || body.live_effects != null || body.effect_ownership != null;
  return response({
    ok: false,
    error: attemptedLive
      ? 'Live V2 flags and ownership are deployment-managed and cannot be changed from this endpoint.'
      : 'V2 engine configuration is environment-managed in this release and is read-only from the admin console.',
    live_effects_idempotent: true,
    live_flags_locked: true
  }, 409);
}

export async function handleYocoV2ControlCentreRoute(
  request: Request,
  env: YocoV2QueueEnv,
  auth: AuthContext,
  workspaceId: string,
  suffix: string
): Promise<Response | null> {
  if (!suffix.startsWith('control-centre')) return null;
  try {
    requireYocoV2AdminPermission(auth, 'yoco_v2.view');
  } catch {
    return forbidden('yoco_v2.view');
  }
  const path = suffix.replace(/^control-centre\/?/, '');
  const url = new URL(request.url);

  try {
    if (request.method === 'GET' && (path === '' || path === 'capabilities')) {
      const flags = yocoV2FeatureFlags(env, workspaceId);
      const tables = Object.fromEntries(await Promise.all([
        ['sales', 'yoco_v2_domain_events'],
        ['refunds', 'yoco_v2_refund_workflows'],
        ['manual_review', 'yoco_v2_manual_reviews'],
        ['reconciliation', 'yoco_v2_reconciliation_runs'],
        ['api_health', 'yoco_v2_api_requests'],
        ['dead_letter', 'yoco_v2_raw_events'],
        ['modifier_engine', 'modifier_engine_comparisons']
      ].map(async ([key, table]) => [key, await tableExists(env.DB, table)])));
      return response({ ok: true, release: RELEASE, permissions: permissionPayload(auth), flags, tabs: tables, live_effects_idempotent: true });
    }
    if (request.method === 'GET' && path === 'overview') return overview(env, workspaceId, url);
    if (request.method === 'GET' && path === 'events') return eventList(env, workspaceId, url);
    const eventMatch = path.match(/^events\/([^/]+)$/);
    if (request.method === 'GET' && eventMatch) return eventDetail(env, auth, workspaceId, decodeURIComponent(eventMatch[1]));
    const eventAction = path.match(/^events\/([^/]+)\/(replay|requeue|manual-review)$/);
    if (request.method === 'POST' && eventAction) {
      const id = decodeURIComponent(eventAction[1]);
      const action = eventAction[2];
      if (action === 'manual-review') return markManualReview(request, env, auth, workspaceId, id);
      const body = await readJsonBody<{ reason?: string; confirmed?: boolean }>(request.clone());
      if (body.confirmed !== true) return response({ ok: false, error: 'Explicit confirmation is required.' }, 409);
      return performEventReplay(request, env, auth, workspaceId, id, action as 'replay' | 'requeue', text(body.reason));
    }
    if (request.method === 'GET' && path === 'processing-runs') return processingRuns(env, workspaceId, url);
    const runMatch = path.match(/^processing-runs\/([^/]+)$/);
    if (request.method === 'GET' && runMatch) return processingRunDetail(env, workspaceId, decodeURIComponent(runMatch[1]));
    if (request.method === 'GET' && path === 'sales') return salesList(env, workspaceId, url);
    const saleMatch = path.match(/^sales\/([^/]+)$/);
    if (request.method === 'GET' && saleMatch) return saleDetail(env, workspaceId, decodeURIComponent(saleMatch[1]));
    const saleAction = path.match(/^sales\/([^/]+)\/(refetch|reresolve|repropose)$/);
    if (request.method === 'POST' && saleAction) {
      const orderId = decodeURIComponent(saleAction[1]);
      const domain = await env.DB.prepare(`SELECT raw_event_id FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND event_type = 'sale.completed' AND source_entity_id = ?2 LIMIT 1`).bind(workspaceId, orderId).first<Row>();
      if (!domain) return response({ ok: false, error: 'Canonical V2 sale not found.' }, 404);
      const body = await readJsonBody<{ reason?: string; confirmed?: boolean }>(request.clone());
      if (body.confirmed !== true) return response({ ok: false, error: 'Explicit confirmation is required.' }, 409);
      return performEventReplay(request, env, auth, workspaceId, text(domain.raw_event_id), saleAction[2] as 'refetch' | 'reresolve' | 'repropose', text(body.reason));
    }
    if (request.method === 'GET' && path === 'refunds') return refundsList(env, workspaceId, url);
    const refundMatch = path.match(/^refunds\/([^/]+)$/);
    if (request.method === 'GET' && refundMatch) return refundDetail(env, workspaceId, decodeURIComponent(refundMatch[1]));
    const refundAction = path.match(/^refunds\/([^/]+)\/(refetch|reresolve|repropose)$/);
    if (request.method === 'POST' && refundAction) {
      const refundId = decodeURIComponent(refundAction[1]);
      const domain = await env.DB.prepare(`SELECT raw_event_id FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND event_type = 'sale.refunded' AND source_entity_id = ?2 LIMIT 1`).bind(workspaceId, refundId).first<Row>();
      if (!domain) return response({ ok: false, error: 'Canonical V2 refund not found.' }, 404);
      const body = await readJsonBody<{ reason?: string; confirmed?: boolean }>(request.clone());
      if (body.confirmed !== true) return response({ ok: false, error: 'Explicit confirmation is required.' }, 409);
      return performEventReplay(request, env, auth, workspaceId, text(domain.raw_event_id), refundAction[2] as 'refetch' | 'reresolve' | 'repropose', text(body.reason));
    }
    if (request.method === 'GET' && path === 'manual-reviews') return manualReviews(env, workspaceId, url);
    const reviewMatch = path.match(/^manual-reviews\/([^/]+)$/);
    if (request.method === 'GET' && reviewMatch) return manualReviewDetail(env, workspaceId, decodeURIComponent(reviewMatch[1]));
    const approveMatch = path.match(/^manual-reviews\/([^/]+)\/approve$/);
    if (request.method === 'POST' && approveMatch) return approveManualAllocation(request, env, auth, workspaceId, decodeURIComponent(approveMatch[1]));
    if (request.method === 'GET' && path === 'reconciliation/runs') return reconciliationRuns(env, workspaceId, url);
    const reconciliationRunMatch = path.match(/^reconciliation\/runs\/([^/]+)$/);
    if (request.method === 'GET' && reconciliationRunMatch) return reconciliationRunDetail(env, workspaceId, decodeURIComponent(reconciliationRunMatch[1]));
    if (request.method === 'GET' && path === 'reconciliation/findings') return reconciliationFindings(env, workspaceId, url);
    const reconciliationFindingActionMatch = path.match(/^reconciliation\/findings\/([^/]+)\/(retry|refetch|rerun-resolver|manual-review)$/);
    if (request.method === 'POST' && reconciliationFindingActionMatch) {
      return reconciliationFindingAction(request, env, auth, workspaceId, decodeURIComponent(reconciliationFindingActionMatch[1]), reconciliationFindingActionMatch[2] as 'retry' | 'refetch' | 'rerun-resolver' | 'manual-review');
    }
    if (request.method === 'POST' && path === 'reconciliation/run') return runReconciliation(request, env, auth, workspaceId);
    if (request.method === 'GET' && path === 'api-health') return apiHealth(env, workspaceId, url);
    if (request.method === 'GET' && path === 'api-requests') return apiRequests(env, workspaceId, url);
    if (request.method === 'GET' && path === 'dead-letters') return deadLetters(env, workspaceId, url);
    const deadAction = path.match(/^dead-letters\/([^/]+)\/(requeue|manual-review|close)$/);
    if (request.method === 'POST' && deadAction) {
      const id = decodeURIComponent(deadAction[1]);
      if (deadAction[2] === 'manual-review') return markManualReview(request, env, auth, workspaceId, id);
      if (deadAction[2] === 'close') return closeDeadLetter(request, env, auth, workspaceId, id);
      const body = await readJsonBody<{ reason?: string; confirmed?: boolean }>(request.clone());
      if (body.confirmed !== true) return response({ ok: false, error: 'Explicit confirmation is required.' }, 409);
      return performEventReplay(request, env, auth, workspaceId, id, 'requeue', text(body.reason));
    }
    if (request.method === 'GET' && path === 'modifier-engine') return modifierEngineDiagnostics(env, workspaceId, url);
    if ((request.method === 'PATCH' || request.method === 'POST') && path === 'modifier-engine/control') return updateModifierEngineControl(request, env, auth, workspaceId);
    if (request.method === 'GET' && path === 'location-readiness') return locationReadiness(env, workspaceId);
    if (request.method === 'GET' && path === 'configuration') return configuration(env, auth, workspaceId);
    if ((request.method === 'PATCH' || request.method === 'POST') && path === 'configuration') return configurationUpdate(request, auth);
    return response({ ok: false, error: 'Unknown Yoco V2 control-centre route.' }, 404);
  } catch (cause) {
    if (cause instanceof YocoV2AdminPermissionError) return forbidden(cause.permission);
    const message = cause instanceof Error ? cause.message : String(cause);
    return response({ ok: false, error: message }, message.includes('rate limit') ? 429 : 400);
  }
}
