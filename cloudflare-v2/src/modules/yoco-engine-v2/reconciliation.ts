import type { Env } from '../../legacy/types';
import type { CanonicalSaleRefundedEvent } from './contracts';
import { listYocoV2Orders, listYocoV2Refunds, YocoV2ApiClientError, type YocoV2ApiClientEnv } from './api-client';
import { yocoV2ReconciliationConfig } from './config';
import { insertRawYocoV2Event, acquireProcessingLock, createProcessingRun, updateRunAndRawEvent, appendTimeline, newId, nowIso, type Row } from './repository';
import { resolveCanonicalYocoSale } from './sale-resolver';
import { buildSaleEffectProposals } from './effect-proposals';
import { applyControlledLiveSaleEffects } from './live-sale';
import { resolveCanonicalYocoRefund } from './refund-resolver';
import { buildRefundReportingProposal, buildRefundStockProposals } from './refund-effect-proposals';
import { applyControlledLiveRefundEffects } from './live-refund';

function text(value: unknown, fallback = ''): string { return String(value ?? fallback).trim(); }
function numberValue(value: unknown, fallback = 0): number { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function objectValue(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function arrayValue(value: unknown): Row[] { return Array.isArray(value) ? value.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) as Row[] : []; }
function parseJson(value: unknown): Row { try { return objectValue(JSON.parse(text(value, '{}'))); } catch { return {}; } }

function listRows(value: unknown, names: string[]): Row[] {
  if (Array.isArray(value)) return arrayValue(value);
  const root = objectValue(value);
  const containers = [root, objectValue(root.data), objectValue(root.result), objectValue(root.payload)];
  for (const container of containers) {
    if (Array.isArray(container.data)) return arrayValue(container.data);
    for (const name of names) if (Array.isArray(container[name])) return arrayValue(container[name]);
  }
  return [];
}
function orderId(order: Row): string { return text(order.id || order.order_id || order.orderId); }
function refundId(refund: Row): string { return text(refund.id || refund.refund_id || refund.refundId || refund.refund_order_id || refund.refundOrderId); }
function entityOccurredAt(entity: Row): string { return text(entity.updated_at || entity.updatedAt || entity.completed_at || entity.completedAt || entity.closed_at || entity.closedAt || entity.created_at || entity.createdAt, nowIso()); }

function continuationCursor(value: unknown): string {
  const root = objectValue(value);
  const data = objectValue(root.data);
  const meta = objectValue(root.meta || root.pagination || data.meta || data.pagination);
  const direct = text(root.next_cursor || root.nextCursor || root.next_page_token || root.nextPageToken || data.next_cursor || data.nextCursor || meta.next_cursor || meta.nextCursor || meta.next_page_token || meta.nextPageToken);
  if (direct) return direct;
  const links = objectValue(root.links || data.links || meta.links);
  const next = text(links.next || root.next || data.next);
  if (!next) return '';
  try {
    const url = new URL(next, 'https://api.yoco.com');
    return text(url.searchParams.get('cursor') || url.searchParams.get('page_token') || url.searchParams.get('pageToken'));
  } catch {
    return '';
  }
}

async function fetchReconciliationPages(
  env: YocoV2ApiClientEnv,
  input: { workspaceId: string; integrationId: string; traceId: string; windowStart: string; windowEnd: string; kind: 'order' | 'refund'; deep: boolean }
): Promise<Row[]> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  let cursor = '';
  const maxPages = input.deep ? 25 : 10;
  for (let page = 0; page < maxPages; page += 1) {
    const params: Record<string, unknown> = {
      created_at__gte: input.windowStart,
      created_at__lte: input.windowEnd,
      limit: 100
    };
    if (cursor) params.cursor = cursor;
    const result = input.kind === 'order'
      ? await listYocoV2Orders<unknown>(env, { workspaceId: input.workspaceId, integrationId: input.integrationId, traceId: input.traceId, attempt: page + 1, params, forceRefresh: true })
      : await listYocoV2Refunds<unknown>(env, { workspaceId: input.workspaceId, integrationId: input.integrationId, traceId: input.traceId, attempt: page + 1, params, forceRefresh: true });
    for (const row of listRows(result.data, input.kind === 'order' ? ['orders'] : ['refunds'])) {
      const id = input.kind === 'order' ? orderId(row) : refundId(row);
      const key = id || JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    const nextCursor = continuationCursor(result.data);
    if (!nextCursor) return rows;
    if (nextCursor === cursor) throw new Error(`Yoco V2 reconciliation ${input.kind} pagination returned the same cursor twice.`);
    cursor = nextCursor;
  }
  throw new Error(`Yoco V2 reconciliation ${input.kind} pagination exceeded the safe ${maxPages}-page boundary; checkpoint was not advanced.`);
}

async function ensureState(env: Env, workspaceId: string, integrationId: string): Promise<Row> {
  const config = yocoV2ReconciliationConfig(env);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO yoco_v2_reconciliation_state
      (workspace_id, integration_id, paused, schedule_mode, checkpoint_at, overlap_minutes, updated_at)
     VALUES (?1, ?2, 0, 'HOURLY_AND_DAILY', NULL, ?3, ?4)`
  ).bind(workspaceId, integrationId, config.overlapMinutes, now).run();
  return (await env.DB.prepare(`SELECT * FROM yoco_v2_reconciliation_state WHERE workspace_id = ?1 AND integration_id = ?2`)
    .bind(workspaceId, integrationId).first<Row>()) || {};
}

async function addFinding(env: Env, input: {
  runId: string;
  workspaceId: string;
  integrationId: string;
  entityType: string;
  entityId: string;
  findingType: string;
  severity: string;
  details?: Record<string, unknown>;
  repairAction?: string;
  repaired?: boolean;
}): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO yoco_v2_reconciliation_findings
      (id, reconciliation_run_id, workspace_id, integration_id, source_entity_type,
       source_entity_id, finding_type, severity, status, details_json, repair_action,
       repaired_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
  ).bind(newId('yoco_v2_reconciliation_finding'), input.runId, input.workspaceId, input.integrationId,
    input.entityType, input.entityId, input.findingType, input.severity, input.repaired ? 'REPAIRED' : 'OPEN',
    JSON.stringify(input.details || {}), input.repairAction || null, input.repaired ? now : null, now).run();
}

async function syntheticRawEvent(env: Env, input: {
  workspaceId: string;
  integrationId: string;
  entityType: 'order' | 'refund';
  entityId: string;
  entity: Row;
}): Promise<Row> {
  const eventType = input.entityType === 'order' ? 'order.completed' : 'refund.succeeded';
  const payload = input.entityType === 'order'
    ? { id: `reconciliation:${input.entityType}:${input.entityId}`, type: eventType, data: { order: input.entity }, reconciliation: true }
    : { id: `reconciliation:${input.entityType}:${input.entityId}`, type: eventType, data: { refund: input.entity }, reconciliation: true };
  const rawBody = JSON.stringify(payload);
  const inserted = await insertRawYocoV2Event(env.DB, {
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    rawBody,
    payload,
    headers: new Headers({ 'x-yoco-event-id': `reconciliation:${input.entityType}:${input.entityId}`, 'x-kcp-trace-id': `reconciliation-${input.entityType}-${input.entityId}` }),
    eventType,
    yocoEventId: `reconciliation:${input.entityType}:${input.entityId}`,
    signatureValid: true,
    receivedAt: entityOccurredAt(input.entity)
  });
  return inserted.row;
}

async function rebuildSale(env: YocoV2ApiClientEnv, raw: Row): Promise<boolean> {
  const locked = await acquireProcessingLock(env.DB, text(raw.id), text(raw.workspace_id));
  if (!locked) return false;
  const run = await createProcessingRun(env.DB, locked);
  try {
    const resolved = await resolveCanonicalYocoSale(env, { rawEvent: locked, processingRun: run, forceRefresh: false });
    await buildSaleEffectProposals(env, resolved.domainEvent, resolved.canonical, text(locked.id), text(run.id));
    await applyControlledLiveSaleEffects(env, { domainEvent: resolved.domainEvent, canonical: resolved.canonical, rawEvent: locked, rawEventId: text(locked.id), processingRunId: text(run.id), message: { raw_event_id: text(locked.id), workspace_id: text(locked.workspace_id), integration_id: text(locked.integration_id), event_type: text(locked.event_type), trace_id: text(locked.trace_id), live_effects: true } });
    await updateRunAndRawEvent(env.DB, { rawEventId: text(locked.id), processingRunId: text(run.id), status: 'COMPLETED', currentStep: 'RECONCILIATION_REBUILT_SALE', completedAt: nowIso() });
    return true;
  } catch (cause) {
    await updateRunAndRawEvent(env.DB, { rawEventId: text(locked.id), processingRunId: text(run.id), status: 'WAITING', currentStep: 'RECONCILIATION_SALE_WAITING', errorCode: cause instanceof YocoV2ApiClientError ? cause.code : 'YOCO_V2_RECONCILIATION_SALE_FAILED', errorMessage: cause instanceof Error ? cause.message : String(cause) });
    return false;
  }
}

async function rebuildRefund(env: YocoV2ApiClientEnv, raw: Row): Promise<{ repaired: boolean; manualReview: boolean }> {
  const locked = await acquireProcessingLock(env.DB, text(raw.id), text(raw.workspace_id));
  if (!locked) return { repaired: false, manualReview: false };
  const run = await createProcessingRun(env.DB, locked);
  try {
    const resolved = await resolveCanonicalYocoRefund(env, { rawEvent: locked, processingRun: run, forceRefresh: false });
    await buildRefundReportingProposal(env, resolved.domainEvent, resolved.canonical, text(locked.id), text(run.id));
    await buildRefundStockProposals(env, resolved.domainEvent, resolved.canonical, text(locked.id), text(run.id));
    await applyControlledLiveRefundEffects(env, { domainEvent: resolved.domainEvent, canonical: resolved.canonical, rawEvent: locked, rawEventId: text(locked.id), processingRunId: text(run.id), message: { raw_event_id: text(locked.id), workspace_id: text(locked.workspace_id), integration_id: text(locked.integration_id), event_type: text(locked.event_type), trace_id: text(locked.trace_id), live_effects: true } });
    const manualReview = resolved.canonical.inventory_resolution_status === 'MANUAL_REVIEW_REQUIRED';
    await updateRunAndRawEvent(env.DB, { rawEventId: text(locked.id), processingRunId: text(run.id), status: manualReview ? 'MANUAL_REVIEW_REQUIRED' : 'COMPLETED', currentStep: manualReview ? 'RECONCILIATION_REFUND_MANUAL_REVIEW' : 'RECONCILIATION_REBUILT_REFUND', completedAt: nowIso() });
    return { repaired: !manualReview, manualReview };
  } catch (cause) {
    await updateRunAndRawEvent(env.DB, { rawEventId: text(locked.id), processingRunId: text(run.id), status: 'WAITING', currentStep: 'RECONCILIATION_REFUND_WAITING', errorCode: cause instanceof YocoV2ApiClientError ? cause.code : 'YOCO_V2_RECONCILIATION_REFUND_FAILED', errorMessage: cause instanceof Error ? cause.message : String(cause) });
    return { repaired: false, manualReview: false };
  }
}

export interface ReconciliationRunOptions {
  windowStart?: string;
  windowEnd?: string;
  deep?: boolean;
  force?: boolean;
  traceId?: string;
}

export async function runYocoV2Reconciliation(env: YocoV2ApiClientEnv, workspaceId: string, integrationId: string, options: ReconciliationRunOptions = {}): Promise<Row> {
  const state = await ensureState(env, workspaceId, integrationId);
  if (numberValue(state.paused) === 1 && !options.force) throw new Error(`Yoco V2 reconciliation is paused: ${text(state.pause_reason, 'workspace pause')}`);
  const config = yocoV2ReconciliationConfig(env);
  const windowEnd = options.windowEnd || nowIso();
  const checkpointBefore = text(state.checkpoint_at);
  const baseStart = options.windowStart || checkpointBefore || new Date(Date.parse(windowEnd) - config.initialLookbackHours * 60 * 60_000).toISOString();
  const overlapMinutes = Math.max(5, numberValue(state.overlap_minutes, config.overlapMinutes));
  const windowStart = options.windowStart || new Date(Date.parse(baseStart) - overlapMinutes * 60_000).toISOString();
  const runId = newId('yoco_v2_reconciliation_run');
  const startedAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO yoco_v2_reconciliation_runs
      (id, workspace_id, integration_id, started_at, window_start, window_end, checkpoint_before,
       status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULLIF(?7, ''), 'RUNNING', ?4)`
  ).bind(runId, workspaceId, integrationId, startedAt, windowStart, windowEnd, checkpointBefore).run();

  let ordersExamined = 0;
  let refundsExamined = 0;
  let missingEvents = 0;
  let mismatches = 0;
  let automaticRepairs = 0;
  let manualReviews = 0;
  try {
    const traceId = options.traceId || `reconciliation-${runId}`;
    const [orders, refunds] = await Promise.all([
      fetchReconciliationPages(env, { workspaceId, integrationId, traceId, windowStart, windowEnd, kind: 'order', deep: Boolean(options.deep) }),
      fetchReconciliationPages(env, { workspaceId, integrationId, traceId, windowStart, windowEnd, kind: 'refund', deep: Boolean(options.deep) })
    ]);
    ordersExamined = orders.length;
    refundsExamined = refunds.length;

    for (const order of orders) {
      const id = orderId(order);
      if (!id) continue;
      const existing = await env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND integration_id = ?2 AND event_key = ?3 LIMIT 1`)
        .bind(workspaceId, integrationId, `sale:${id}`).first<Row>();
      if (!existing) {
        missingEvents += 1;
        const raw = await syntheticRawEvent(env, { workspaceId, integrationId, entityType: 'order', entityId: id, entity: order });
        const repaired = await rebuildSale(env, raw);
        if (repaired) automaticRepairs += 1;
        await addFinding(env, { runId, workspaceId, integrationId, entityType: 'ORDER', entityId: id, findingType: 'MISSING_SALE_EVENT', severity: 'HIGH', details: { window_start: windowStart, window_end: windowEnd }, repairAction: 'CREATE_CANONICAL_SALE_AND_LIVE_EFFECTS', repaired });
      }
    }

    for (const refund of refunds) {
      const id = refundId(refund);
      if (!id) continue;
      const existing = await env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND integration_id = ?2 AND event_key = ?3 LIMIT 1`)
        .bind(workspaceId, integrationId, `refund:${id}`).first<Row>();
      if (!existing) {
        missingEvents += 1;
        const raw = await syntheticRawEvent(env, { workspaceId, integrationId, entityType: 'refund', entityId: id, entity: refund });
        const result = await rebuildRefund(env, raw);
        if (result.repaired) automaticRepairs += 1;
        if (result.manualReview) manualReviews += 1;
        await addFinding(env, { runId, workspaceId, integrationId, entityType: 'REFUND', entityId: id, findingType: 'MISSING_REFUND_EVENT', severity: 'HIGH', details: { window_start: windowStart, window_end: windowEnd }, repairAction: result.manualReview ? 'CREATE_MANUAL_REFUND_REVIEW' : 'CREATE_CANONICAL_REFUND_AND_LIVE_EFFECTS', repaired: result.repaired });
      }
    }

    const incomplete = await env.DB.prepare(
      `SELECT * FROM yoco_v2_refund_workflows WHERE workspace_id = ?1 AND integration_id = ?2
        AND overall_status NOT IN ('COMPLETED', 'CANONICAL_EVENT_CREATED')`
    ).bind(workspaceId, integrationId).all<Row>();
    for (const workflow of incomplete.results || []) {
      mismatches += 1;
      await addFinding(env, { runId, workspaceId, integrationId, entityType: 'REFUND', entityId: text(workflow.refund_id), findingType: text(workflow.overall_status) === 'MANUAL_REVIEW_REQUIRED' ? 'MANUAL_REVIEW_REQUIRED' : 'INCOMPLETE_WORKFLOW', severity: 'MEDIUM', details: workflow, repairAction: 'RERUN_REFUND_RESOLVER', repaired: false });
    }
    const unresolvedSales = await env.DB.prepare(
      `SELECT source_entity_id, event_type, resolution_status, payload_json FROM yoco_v2_domain_events
        WHERE workspace_id = ?1 AND integration_id = ?2 AND event_type = 'sale.completed'
          AND resolution_status IN ('PARTIALLY_RESOLVED', 'LOCATION_MAPPING_MISSING', 'ITEM_MAPPING_MISSING', 'MODIFIER_MAPPING_MISSING', 'MANUAL_REVIEW_REQUIRED')`
    ).bind(workspaceId, integrationId).all<Row>();
    const unresolvedRefunds = await env.DB.prepare(
      `SELECT refund_id AS source_entity_id, 'sale.refunded' AS event_type, inventory_status AS resolution_status,
              json_object('workflow_id', id, 'overall_status', overall_status, 'current_step', current_step) AS payload_json
         FROM yoco_v2_refund_workflows
        WHERE workspace_id = ?1 AND integration_id = ?2 AND inventory_status = 'MAPPING_MISSING'`
    ).bind(workspaceId, integrationId).all<Row>();
    for (const row of [...(unresolvedSales.results || []), ...(unresolvedRefunds.results || [])]) {
      mismatches += 1;
      await addFinding(env, { runId, workspaceId, integrationId, entityType: text(row.event_type) === 'sale.refunded' ? 'REFUND' : 'ORDER', entityId: text(row.source_entity_id), findingType: 'UNRESOLVED_MAPPING', severity: 'MEDIUM', details: { resolution_status: row.resolution_status, context: parseJson(row.payload_json) }, repairAction: 'RESOLVE_MAPPING_AND_RERUN', repaired: false });
    }

    // Historical legacy comparison tables are retained for audit only and are not read by the V2 reconciliation runtime.


    const completedAt = nowIso();
    await env.DB.prepare(
      `UPDATE yoco_v2_reconciliation_runs SET completed_at = ?2, checkpoint_after = ?3, status = 'COMPLETED',
        orders_examined = ?4, refunds_examined = ?5, missing_events_found = ?6, mismatches_found = ?7,
        automatic_repairs = ?8, manual_reviews_created = ?9 WHERE id = ?1`
    ).bind(runId, completedAt, windowEnd, ordersExamined, refundsExamined, missingEvents, mismatches, automaticRepairs, manualReviews).run();
    await env.DB.prepare(
      `UPDATE yoco_v2_reconciliation_state SET checkpoint_at = ?3, updated_at = ?4 WHERE workspace_id = ?1 AND integration_id = ?2`
    ).bind(workspaceId, integrationId, windowEnd, completedAt).run();
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const rateLimited = cause instanceof YocoV2ApiClientError && cause.category === 'RATE_LIMITED';
    await env.DB.prepare(
      `UPDATE yoco_v2_reconciliation_runs SET completed_at = ?2, status = ?3,
        orders_examined = ?4, refunds_examined = ?5, missing_events_found = ?6,
        mismatches_found = ?7, automatic_repairs = ?8, manual_reviews_created = ?9,
        error_summary_json = ?10 WHERE id = ?1`
    ).bind(runId, nowIso(), rateLimited ? 'PAUSED_RATE_LIMIT' : 'FAILED', ordersExamined, refundsExamined, missingEvents, mismatches, automaticRepairs, manualReviews, JSON.stringify({ message: error, rate_limited: rateLimited })).run();
    throw cause;
  }
  return (await env.DB.prepare(`SELECT * FROM yoco_v2_reconciliation_runs WHERE id = ?1`).bind(runId).first<Row>()) || { id: runId };
}

export async function runScheduledYocoV2Reconciliation(env: YocoV2ApiClientEnv, workspaceId: string, integrationId: string, at = new Date()): Promise<Row | null> {
  const state = await ensureState(env, workspaceId, integrationId);
  if (numberValue(state.paused) === 1) return null;
  const now = at.getTime();
  const lastHourly = Date.parse(text(state.last_hourly_run_at));
  const lastDaily = Date.parse(text(state.last_daily_run_at));
  const dailyDue = !Number.isFinite(lastDaily) || now - lastDaily >= 24 * 60 * 60_000;
  const hourlyDue = !Number.isFinite(lastHourly) || now - lastHourly >= 60 * 60_000;
  if (!dailyDue && !hourlyDue) return null;
  const options: ReconciliationRunOptions = dailyDue
    ? { deep: true, windowStart: new Date(now - 7 * 24 * 60 * 60_000).toISOString(), windowEnd: at.toISOString() }
    : { windowEnd: at.toISOString() };
  const run = await runYocoV2Reconciliation(env, workspaceId, integrationId, options);
  await env.DB.prepare(
    `UPDATE yoco_v2_reconciliation_state SET last_hourly_run_at = ?3,
      last_daily_run_at = CASE WHEN ?4 = 1 THEN ?3 ELSE last_daily_run_at END, updated_at = ?3
      WHERE workspace_id = ?1 AND integration_id = ?2`
  ).bind(workspaceId, integrationId, at.toISOString(), dailyDue ? 1 : 0).run();
  return run;
}

export async function setYocoV2ReconciliationPause(env: Env, workspaceId: string, integrationId: string, paused: boolean, reason = ''): Promise<Row> {
  await ensureState(env, workspaceId, integrationId);
  await env.DB.prepare(
    `UPDATE yoco_v2_reconciliation_state SET paused = ?3, pause_reason = NULLIF(?4, ''), updated_at = ?5
      WHERE workspace_id = ?1 AND integration_id = ?2`
  ).bind(workspaceId, integrationId, paused ? 1 : 0, reason, nowIso()).run();
  return (await env.DB.prepare(`SELECT * FROM yoco_v2_reconciliation_state WHERE workspace_id = ?1 AND integration_id = ?2`)
    .bind(workspaceId, integrationId).first<Row>()) || {};
}
