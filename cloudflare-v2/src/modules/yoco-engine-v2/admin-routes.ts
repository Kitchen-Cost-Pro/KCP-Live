import type { AuthContext, Env } from '../../legacy/types';
import type { YocoV2QueueMessage, YocoV2EffectType } from './contracts';
import type { YocoV2QueueEnv } from './capture';
import { yocoV2FeatureFlags } from './config';
import { appendTimeline, markRawEventQueueFailure, markRawEventQueued, newId, nowIso, type Row } from './repository';
import { recordYocoV2Diagnostic } from './observability';
import { saveManualRefundAllocation } from './refund-resolver';
import { runYocoV2Reconciliation, setYocoV2ReconciliationPause } from './reconciliation';
import { getEffectRuntime, pauseEffect, resumeEffect } from './effect-gate';
import { countActiveYocoWebhookSubscriptions, disconnectYoco, getYocoConnection, reconcileYocoWebhookSubscription } from './integration-service';
import { processYocoV2QueueMessage } from './processor';

const RECEIPT_STATS_WINDOWS_MINUTES: Array<[string, number]> = [
  ['last5m', 5],
  ['last15m', 15],
  ['last30m', 30],
  ['last1h', 60],
  ['last24h', 24 * 60]
];

/**
 * Date-only floor ('YYYY-MM-DD') of an instant, for use as a SARGABLE prefilter alongside an exact
 * datetime() predicate.
 *
 * The receipt-stats queries below all filter `datetime(received_at) >= datetime(<bound>)`. Wrapping
 * the column in datetime() makes it non-sargable, so idx_yoco_v2_webhook_receipts_workspace_received
 * (workspace_id, received_at DESC) cannot be used and each query degrades to a full scan of the
 * receipts table. getReceiptStats issues SIX of them per workspace (a 24h aggregate plus one per
 * window), and /api/admin/webhook-health fans that out across EVERY workspace — so opening the admin
 * webhook page cost roughly six full receipt-table scans per workspace, all at once.
 *
 * Keeping the exact datetime() predicate preserves behaviour for any legacy row whose timestamp
 * format differs; the added bare-column bound only has to be a guaranteed superset, which a
 * date-only floor is, because ISO-8601 sorts lexicographically and any timestamp on or after the
 * bound shares or exceeds that date prefix.
 */
function sargableDayFloor(isoInstant: string): string {
  return String(isoInstant || '').slice(0, 10);
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function positiveInteger(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, Math.floor(parsed))) : fallback;
}

async function loadEvent(env: Env, workspaceId: string, rawEventId: string) {
  return env.DB.prepare(
    `SELECT * FROM yoco_v2_raw_events WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`
  ).bind(workspaceId, rawEventId).first<Row>();
}

function buildAdminReplayMessage(
  event: Row,
  reason: string,
  options: Pick<YocoV2QueueMessage, 'force_refresh' | 'rerun_stage' | 'live_effects'> = {}
): YocoV2QueueMessage {
  return {
    raw_event_id: String(event.id),
    workspace_id: String(event.workspace_id),
    integration_id: String(event.integration_id),
    event_type: String(event.event_type),
    trace_id: String(event.trace_id),
    replay_reason: reason,
    live_effects: false,
    ...options
  };
}

async function publishAdminReplay(env: YocoV2QueueEnv, message: YocoV2QueueMessage): Promise<void> {
  if (!env.YOCO_V2_EVENTS) throw new Error('YOCO_V2_EVENTS queue binding is not configured.');
  await env.YOCO_V2_EVENTS.send(message, { contentType: 'json' });
}

async function resetForAdminReplay(env: Env, rawEventId: string, resetAttempts: boolean): Promise<void> {
  await env.DB.prepare(
    `UPDATE yoco_v2_raw_events
        SET queue_status = 'PUBLISHING', processing_status = 'WAITING',
            processing_attempts = CASE WHEN ?2 = 1 THEN 0 ELSE processing_attempts END,
            next_attempt_at = NULL, last_error_code = NULL, last_error_message = NULL,
            completed_at = NULL, updated_at = ?3
      WHERE id = ?1`
  ).bind(rawEventId, resetAttempts ? 1 : 0, nowIso()).run();
}

export async function handleYocoV2AdminRoute(
  request: Request,
  env: YocoV2QueueEnv,
  auth: AuthContext,
  workspaceId: string,
  resource: string
): Promise<Response | null> {
  if (!resource.startsWith('yoco-v2/admin')) return null;
  const flags = yocoV2FeatureFlags(env, workspaceId);
  if (!flags.yoco_v2_admin_enabled) return response({ ok: false, error: 'Yoco V2 admin diagnostics are disabled.' }, 404);
  if (!auth.uid) return response({ ok: false, error: 'Authentication required.' }, 401);
  if (auth.systemRole !== 'admin') return response({ ok: false, error: 'Administrator access required.' }, 403);

  // `resource` doubles as the routing key AND (for callWorkspaceDO-style fan-outs, unlike
  // forwardToWorkspaceDO) may carry its own query string appended by the caller — strip it here
  // so suffix matching below is exact; the actual query values still come from `url.searchParams`.
  const suffix = resource.replace(/^yoco-v2\/admin\/?/, '').split('?')[0];
  const url = new URL(request.url);

  if (request.method === 'GET' && (suffix === '' || suffix === 'summary')) {
    const [summary, byType, ownership, shadow, runtime, refundShadow, reconciliation] = await Promise.all([
      env.DB.prepare(
        `SELECT
           COUNT(*) AS total_events,
           SUM(CASE WHEN duplicate_receipts > 0 THEN duplicate_receipts ELSE 0 END) AS duplicate_receipts,
           SUM(CASE WHEN queue_status = 'PUBLISH_FAILED' THEN 1 ELSE 0 END) AS queue_publication_failures,
           SUM(CASE WHEN processing_status = 'RETRY_SCHEDULED' THEN 1 ELSE 0 END) AS retries,
           SUM(CASE WHEN processing_status = 'DEAD_LETTERED' THEN 1 ELSE 0 END) AS dead_letters,
           SUM(CASE WHEN processing_status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN last_error_code = 'YOCO_V2_UNSUPPORTED_EVENT' THEN 1 ELSE 0 END) AS unsupported_events
         FROM yoco_v2_raw_events WHERE workspace_id = ?1`
      ).bind(workspaceId).first<Row>(),
      env.DB.prepare(
        `SELECT event_type, COUNT(*) AS event_count
           FROM yoco_v2_raw_events WHERE workspace_id = ?1
          GROUP BY event_type ORDER BY event_count DESC, event_type LIMIT 50`
      ).bind(workspaceId).all<Row>(),
      env.DB.prepare(
        `SELECT * FROM integration_effect_ownership
          WHERE workspace_id = ?1 AND integration_type = 'YOCO' ORDER BY effect_type`
      ).bind(workspaceId).all<Row>(),
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND event_type = 'sale.completed') AS canonical_sales,
           -- A sale that resolved as UNSUPPORTED_ORDER_STATE never posts to reporting or stock —
           -- correct behavior, but previously had zero visibility anywhere. Surfaced here so an
           -- admin can tell "N sales were silently excluded from Operations" instead of assuming
           -- Operations is complete by default.
           (SELECT COUNT(*) FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND event_type = 'sale.completed' AND resolution_status = 'UNSUPPORTED_ORDER_STATE') AS unsupported_order_state_sales,
           (SELECT COUNT(*) FROM yoco_v2_proposed_stock_movements WHERE workspace_id = ?1 AND COALESCE(warning_code, '') = '') AS stock_proposals,
           -- Lines that resolved but never became a stock movement (unmapped item/modifier,
           -- missing recipe, invalid UOM, etc.) — previously only visible one-by-one in each
           -- order's processing timeline, never as an aggregate count.
           (SELECT COUNT(*) FROM yoco_v2_proposed_stock_movements WHERE workspace_id = ?1 AND COALESCE(warning_code, '') <> '') AS unresolved_stock_proposals,
           (SELECT COUNT(*) FROM yoco_v2_sale_comparisons WHERE workspace_id = ?1) AS comparisons,
           (SELECT COUNT(*) FROM yoco_v2_sale_comparisons WHERE workspace_id = ?1 AND comparison_status = 'MATCHED') AS matched_comparisons,
           (SELECT COUNT(*) FROM yoco_v2_api_requests WHERE workspace_id = ?1) AS api_requests,
           (SELECT COUNT(*) FROM yoco_v2_api_requests WHERE workspace_id = ?1 AND rate_limited = 1) AS rate_limited_requests`
      ).bind(workspaceId).first<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_integration_runtime WHERE workspace_id = ?1 ORDER BY updated_at DESC`).bind(workspaceId).all<Row>(),
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND event_type = 'sale.refunded') AS canonical_refunds,
           (SELECT COUNT(*) FROM yoco_v2_manual_reviews WHERE workspace_id = ?1 AND status = 'OPEN') AS open_manual_reviews,
           (SELECT COUNT(*) FROM yoco_v2_proposed_refund_reporting WHERE workspace_id = ?1) AS refund_reporting_proposals,
           (SELECT COUNT(*) FROM yoco_v2_proposed_refund_stock_movements WHERE workspace_id = ?1 AND COALESCE(warning_code, '') = '') AS refund_stock_proposals,
           (SELECT COUNT(*) FROM yoco_v2_proposed_refund_stock_movements WHERE workspace_id = ?1 AND COALESCE(warning_code, '') <> '') AS unresolved_refund_stock_proposals,
           (SELECT COUNT(*) FROM yoco_v2_refund_comparisons WHERE workspace_id = ?1) AS refund_comparisons`
      ).bind(workspaceId).first<Row>(),
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM yoco_v2_reconciliation_runs WHERE workspace_id = ?1) AS runs,
           (SELECT COUNT(*) FROM yoco_v2_reconciliation_findings WHERE workspace_id = ?1 AND status = 'OPEN') AS open_findings`
      ).bind(workspaceId).first<Row>()
    ]);
    return response({
      ok: true,
      release: 'phase-v2-12-yoco-legacy-shutdown',
      flags,
      summary: summary || {},
      shadow: { ...(shadow || {}), ...(refundShadow || {}) },
      reconciliation: reconciliation || {},
      eventsByType: byType.results || [],
      ownership: ownership.results || [],
      integrationRuntime: runtime.results || []
    });
  }

  if (request.method === 'GET' && suffix === 'events') {
    const limit = positiveInteger(url.searchParams.get('limit'), 50, 100);
    const offset = positiveInteger(url.searchParams.get('offset'), 0, 100_000);
    const eventType = String(url.searchParams.get('eventType') || '');
    const status = String(url.searchParams.get('status') || '');
    const rows = await env.DB.prepare(
      `SELECT id, workspace_id, integration_id, event_key, yoco_event_id, event_type,
              payload_hash, signature_valid, received_at, capture_status, queue_status,
              processing_status, processing_attempts, next_attempt_at, last_error_code,
              last_error_message, completed_at, duplicate_receipts, last_duplicate_at,
              trace_id, created_at, updated_at
         FROM yoco_v2_raw_events
        WHERE workspace_id = ?1
          AND (?2 = '' OR event_type = ?2)
          AND (?3 = '' OR processing_status = ?3)
        ORDER BY received_at DESC
        LIMIT ?4 OFFSET ?5`
    ).bind(workspaceId, eventType, status, limit, offset).all<Row>();
    return response({ ok: true, rows: rows.results || [], limit, offset });
  }

  if (request.method === 'GET' && suffix === 'api-requests') {
    const limit = positiveInteger(url.searchParams.get('limit'), 100, 250);
    const integrationId = String(url.searchParams.get('integrationId') || '');
    const rows = await env.DB.prepare(
      `SELECT * FROM yoco_v2_api_requests
        WHERE workspace_id = ?1 AND (?2 = '' OR integration_id = ?2)
        ORDER BY created_at DESC LIMIT ?3`
    ).bind(workspaceId, integrationId, limit).all<Row>();
    return response({ ok: true, rows: rows.results || [], limit });
  }

  if (request.method === 'GET' && suffix === 'runtime') {
    const rows = await env.DB.prepare(
      `SELECT * FROM yoco_v2_integration_runtime WHERE workspace_id = ?1 ORDER BY updated_at DESC`
    ).bind(workspaceId).all<Row>();
    return response({ ok: true, rows: rows.results || [] });
  }

  if (request.method === 'GET' && suffix === 'sales') {
    const limit = positiveInteger(url.searchParams.get('limit'), 50, 100);
    const rows = await env.DB.prepare(
      `SELECT event.id AS domain_event_id, event.raw_event_id, event.source_entity_id AS source_order_id,
              event.occurred_at, event.resolution_status, event.updated_at,
              comparison.comparison_status, comparison.financial_match_status,
              comparison.stock_match_status, comparison.location_match_status,
              comparison.mapping_match_status, comparison.compared_at
         FROM yoco_v2_domain_events event
         LEFT JOIN yoco_v2_sale_comparisons comparison
           ON comparison.workspace_id = event.workspace_id
          AND comparison.source_order_id = event.source_entity_id
        WHERE event.workspace_id = ?1 AND event.event_type = 'sale.completed'
        ORDER BY event.occurred_at DESC LIMIT ?2`
    ).bind(workspaceId, limit).all<Row>();
    return response({ ok: true, rows: rows.results || [], limit });
  }

  const saleMatch = suffix.match(/^sales\/([^/]+)$/);
  if (request.method === 'GET' && saleMatch) {
    const sourceOrderId = decodeURIComponent(saleMatch[1]);
    const domainEvent = await env.DB.prepare(
      `SELECT * FROM yoco_v2_domain_events
        WHERE workspace_id = ?1 AND event_type = 'sale.completed' AND source_entity_id = ?2 LIMIT 1`
    ).bind(workspaceId, sourceOrderId).first<Row>();
    if (!domainEvent) return response({ ok: false, error: 'Canonical V2 sale was not found.' }, 404);
    const [rawEvent, timeline, apiRequests, proposals, comparison, legacySale, legacyMovements] = await Promise.all([
      env.DB.prepare(`SELECT * FROM yoco_v2_raw_events WHERE id = ?1 LIMIT 1`).bind(String(domainEvent.raw_event_id)).first<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_processing_timeline WHERE raw_event_id = ?1 ORDER BY created_at, id`).bind(String(domainEvent.raw_event_id)).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_api_requests WHERE workspace_id = ?1 AND (raw_event_id = ?2 OR resource_id = ?3) ORDER BY created_at`).bind(workspaceId, String(domainEvent.raw_event_id), sourceOrderId).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_proposed_stock_movements WHERE domain_event_id = ?1 ORDER BY source_line_id, modifier_id, ingredient_item_id`).bind(String(domainEvent.id)).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_sale_comparisons WHERE workspace_id = ?1 AND source_order_id = ?2 LIMIT 1`).bind(workspaceId, sourceOrderId).first<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_orders WHERE workspace_id = ?1 AND yoco_order_id = ?2 AND order_type = 'sale' LIMIT 1`).bind(workspaceId, sourceOrderId).first<Row>(),
      env.DB.prepare(`SELECT * FROM stock_movements WHERE workspace_id = ?1 AND document_type = 'yoco_order' AND document_id = ?2 AND movement_type = 'sale_depletion' ORDER BY stock_item_id, location_id`).bind(workspaceId, sourceOrderId).all<Row>()
    ]);
    return response({
      ok: true,
      domainEvent: { ...domainEvent, payload: JSON.parse(String(domainEvent.payload_json || '{}')) },
      rawEvent,
      timeline: timeline.results || [],
      apiRequests: apiRequests.results || [],
      proposals: proposals.results || [],
      comparison,
      legacySale,
      legacyMovements: legacyMovements.results || []
    });
  }


  if (request.method === 'GET' && suffix === 'refunds') {
    const limit = positiveInteger(url.searchParams.get('limit'), 50, 100);
    const rows = await env.DB.prepare(
      `SELECT event.id AS domain_event_id, event.raw_event_id, event.source_entity_id AS refund_id,
              event.occurred_at, event.resolution_status, event.updated_at,
              workflow.source_order_id, workflow.current_step, workflow.financial_status,
              workflow.inventory_status, workflow.reporting_status, workflow.reconciliation_status,
              workflow.overall_status, comparison.comparison_status, comparison.financial_match_status,
              comparison.stock_match_status, comparison.compared_at
         FROM yoco_v2_domain_events event
         LEFT JOIN yoco_v2_refund_workflows workflow
           ON workflow.workspace_id = event.workspace_id AND workflow.domain_event_id = event.id
         LEFT JOIN yoco_v2_refund_comparisons comparison
           ON comparison.workspace_id = event.workspace_id AND comparison.refund_id = event.source_entity_id
        WHERE event.workspace_id = ?1 AND event.event_type = 'sale.refunded'
        ORDER BY event.occurred_at DESC LIMIT ?2`
    ).bind(workspaceId, limit).all<Row>();
    return response({ ok: true, rows: rows.results || [], limit });
  }

  const refundMatch = suffix.match(/^refunds\/([^/]+)$/);
  if (request.method === 'GET' && refundMatch) {
    const refundId = decodeURIComponent(refundMatch[1]);
    const domainEvent = await env.DB.prepare(
      `SELECT * FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND event_type = 'sale.refunded' AND source_entity_id = ?2 LIMIT 1`
    ).bind(workspaceId, refundId).first<Row>();
    if (!domainEvent) return response({ ok: false, error: 'Canonical V2 refund was not found.' }, 404);
    const canonical = JSON.parse(String(domainEvent.payload_json || '{}')) as Record<string, unknown>;
    const sourceOrderId = String(canonical.source_order_id || '');
    const [rawEvent, timeline, apiRequests, workflow, reviews, reportingProposal, stockProposals, comparison, originalSale, originalLines, previousRefunds, legacyRefund, legacyMovements] = await Promise.all([
      env.DB.prepare(`SELECT * FROM yoco_v2_raw_events WHERE id = ?1 LIMIT 1`).bind(String(domainEvent.raw_event_id)).first<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_processing_timeline WHERE raw_event_id = ?1 ORDER BY created_at, id`).bind(String(domainEvent.raw_event_id)).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_api_requests WHERE workspace_id = ?1 AND (raw_event_id = ?2 OR resource_id IN (?3, ?4)) ORDER BY created_at`).bind(workspaceId, String(domainEvent.raw_event_id), refundId, sourceOrderId).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_refund_workflows WHERE workspace_id = ?1 AND refund_id = ?2 LIMIT 1`).bind(workspaceId, refundId).first<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_manual_reviews WHERE workspace_id = ?1 AND domain_event_id = ?2 ORDER BY created_at`).bind(workspaceId, String(domainEvent.id)).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_proposed_refund_reporting WHERE domain_event_id = ?1 LIMIT 1`).bind(String(domainEvent.id)).first<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_proposed_refund_stock_movements WHERE domain_event_id = ?1 ORDER BY source_original_line_id, modifier_id, ingredient_item_id`).bind(String(domainEvent.id)).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_refund_comparisons WHERE workspace_id = ?1 AND refund_id = ?2 LIMIT 1`).bind(workspaceId, refundId).first<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_orders WHERE workspace_id = ?1 AND yoco_order_id = ?2 AND order_type = 'sale' LIMIT 1`).bind(workspaceId, sourceOrderId).first<Row>(),
      env.DB.prepare(`SELECT line.* FROM yoco_order_lines line JOIN yoco_orders sale ON sale.id = line.yoco_order_id AND sale.workspace_id = line.workspace_id WHERE line.workspace_id = ?1 AND sale.yoco_order_id = ?2 ORDER BY line.yoco_line_id, line.id`).bind(workspaceId, sourceOrderId).all<Row>(),
      env.DB.prepare(`SELECT id, source_entity_id AS refund_id, occurred_at, payload_json, resolution_status FROM yoco_v2_domain_events WHERE workspace_id = ?1 AND event_type = 'sale.refunded' AND source_entity_id <> ?2 AND json_extract(payload_json, '$.source_order_id') = ?3 ORDER BY occurred_at`).bind(workspaceId, refundId, sourceOrderId).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_orders WHERE workspace_id = ?1 AND order_type = 'refund' AND (provider_refund_id = ?2 OR yoco_order_id = ?2) LIMIT 1`).bind(workspaceId, refundId).first<Row>(),
      env.DB.prepare(`SELECT * FROM stock_movements WHERE workspace_id = ?1 AND movement_type = 'sale_refund' AND (document_id = ?2 OR document_id = ?3 OR json_extract(metadata_json, '$.refundId') = ?2) ORDER BY stock_item_id, location_id`).bind(workspaceId, refundId, sourceOrderId).all<Row>()
    ]);
    const canonicalMetadata = canonical.metadata && typeof canonical.metadata === 'object' ? canonical.metadata as Record<string, unknown> : {};
    const sourceOriginalOrder = canonicalMetadata.original_order && typeof canonicalMetadata.original_order === 'object' ? canonicalMetadata.original_order as Record<string, unknown> : {};
    const sourceOriginalLines = Array.isArray(sourceOriginalOrder.line_items)
      ? sourceOriginalOrder.line_items as Array<Record<string, unknown>>
      : Array.isArray(sourceOriginalOrder.lines)
        ? sourceOriginalOrder.lines as Array<Record<string, unknown>>
        : [];
    const previouslyRefunded = new Map<string, number>();
    for (const previous of previousRefunds.results || []) {
      try {
        const payload = JSON.parse(String(previous.payload_json || '{}')) as Record<string, unknown>;
        const lines = Array.isArray(payload.lines) ? payload.lines as Array<Record<string, unknown>> : [];
        for (const line of lines) {
          const lineId = String(line.source_original_line_id || '');
          if (!lineId) continue;
          previouslyRefunded.set(lineId, (previouslyRefunded.get(lineId) || 0) + Math.abs(Number(line.quantity || 0)));
        }
      } catch {
        // A malformed historical shadow payload remains visible in previousRefunds but is not used for allocation arithmetic.
      }
    }
    const refundableLines = sourceOriginalLines.map((line, index) => {
      const sourceLineId = String(line.id || line.line_id || line.lineId || `line:${index}`);
      const soldQuantity = Math.abs(Number(line.quantity || line.qty || 0));
      const previousQuantity = previouslyRefunded.get(sourceLineId) || 0;
      return {
        ...line,
        source_original_line_id: sourceLineId,
        originally_sold_quantity: soldQuantity,
        previously_refunded_quantity: previousQuantity,
        remaining_refundable_quantity: Math.max(0, soldQuantity - previousQuantity)
      };
    });
    return response({
      ok: true,
      domainEvent: { ...domainEvent, payload: canonical },
      rawEvent,
      timeline: timeline.results || [],
      apiRequests: apiRequests.results || [],
      workflow,
      manualReviews: reviews.results || [],
      reportingProposal,
      stockProposals: stockProposals.results || [],
      comparison,
      originalSale,
      originalLines: originalLines.results || [],
      sourceOriginalLines,
      refundableLines,
      previousRefunds: previousRefunds.results || [],
      legacyRefund,
      legacyMovements: legacyMovements.results || []
    });
  }

  if (request.method === 'GET' && suffix === 'manual-reviews') {
    const status = String(url.searchParams.get('status') || 'OPEN');
    const rows = await env.DB.prepare(
      `SELECT review.*, event.source_entity_id AS refund_id, event.occurred_at
         FROM yoco_v2_manual_reviews review
         LEFT JOIN yoco_v2_domain_events event ON event.id = review.domain_event_id
        WHERE review.workspace_id = ?1 AND (?2 = '' OR review.status = ?2)
        ORDER BY review.created_at DESC LIMIT 100`
    ).bind(workspaceId, status).all<Row>();
    return response({ ok: true, rows: rows.results || [] });
  }

  const allocationMatch = suffix.match(/^manual-reviews\/([^/]+)\/allocate$/);
  if (request.method === 'POST' && allocationMatch) {
    const reviewId = decodeURIComponent(allocationMatch[1]);
    const body = await request.json<{ allocation?: Array<{ source_original_line_id: string; quantity: number }>; acknowledge_financial_difference?: boolean }>().catch(() => ({ allocation: [], acknowledge_financial_difference: false }));
    try {
      const review = await saveManualRefundAllocation(env, {
        workspaceId,
        reviewId,
        allocation: Array.isArray(body.allocation) ? body.allocation : [],
        resolvedBy: auth.uid,
        acknowledgeFinancialDifference: Boolean(body.acknowledge_financial_difference)
      });
      const domainEvent = await env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`).bind(String(review.domain_event_id), workspaceId).first<Row>();
      if (!domainEvent) return response({ ok: false, error: 'Canonical refund event was not found after allocation.' }, 409);
      const event = await loadEvent(env, workspaceId, String(domainEvent.raw_event_id));
      if (!event) return response({ ok: false, error: 'Raw refund event was not found after allocation.' }, 409);
      if (!flags.yoco_v2_queue_enabled) return response({ ok: true, review, queued: false, message: 'Allocation saved. Queue is disabled, so re-resolution remains pending.' });
      await resetForAdminReplay(env, String(event.id), false);
      const replayMessage = buildAdminReplayMessage(event, 'manual-refund-allocation', { force_refresh: false, rerun_stage: 'all', live_effects: true });
      await publishAdminReplay(env, replayMessage);
      await markRawEventQueued(env.DB, String(event.id));
      // Durable Cloudflare Queue delivery can lag well beyond its configured batch window (seen
      // directly in production — see the sale replay action below for the full explanation), so
      // also process inline here rather than leaving the admin waiting on queue latency alone. The
      // publish above still lands as a durable, idempotent fallback if this inline attempt fails.
      await processYocoV2QueueMessage(env, replayMessage).catch((cause) => {
        console.error('[admin] inline manual-refund-allocation replay failed; durable queue fallback remains pending', cause);
      });
      await appendTimeline(env.DB, {
        rawEventId: String(event.id),
        step: 'MANUAL_REFUND_ALLOCATION_SAVED',
        status: 'QUEUED',
        message: 'Authorised manual refund allocation saved and controlled re-resolution queued. Live refund effects remain ownership and feature gated.',
        metadata: { actor_uid: auth.uid, review_id: reviewId, allocation_count: Array.isArray(body.allocation) ? body.allocation.length : 0 }
      });
      return response({ ok: true, review, queued: true });
    } catch (cause) {
      return response({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }, 400);
    }
  }

  if (request.method === 'GET' && suffix === 'reconciliation') {
    const [state, latest, findings] = await Promise.all([
      env.DB.prepare(`SELECT * FROM yoco_v2_reconciliation_state WHERE workspace_id = ?1 ORDER BY updated_at DESC`).bind(workspaceId).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_reconciliation_runs WHERE workspace_id = ?1 ORDER BY started_at DESC LIMIT 25`).bind(workspaceId).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_reconciliation_findings WHERE workspace_id = ?1 AND status = 'OPEN' ORDER BY severity DESC, created_at DESC LIMIT 100`).bind(workspaceId).all<Row>()
    ]);
    return response({ ok: true, state: state.results || [], runs: latest.results || [], findings: findings.results || [] });
  }

  if (request.method === 'POST' && suffix === 'reconciliation/run') {
    const body = await request.json<{ integration_id?: string; window_start?: string; window_end?: string; deep?: boolean }>().catch(() => ({ integration_id: undefined, window_start: undefined, window_end: undefined, deep: false }));
    const integrationId = String(body.integration_id || `yoco:${workspaceId}`);
    try {
      const run = await runYocoV2Reconciliation(env, workspaceId, integrationId, {
        windowStart: body.window_start,
        windowEnd: body.window_end,
        deep: Boolean(body.deep),
        force: true,
        traceId: `admin-reconciliation-${newId('trace')}`
      });
      return response({ ok: true, run });
    } catch (cause) {
      return response({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }, 503);
    }
  }

  const reconciliationPauseMatch = suffix.match(/^reconciliation\/([^/]+)\/(pause|resume)$/);
  if (request.method === 'POST' && reconciliationPauseMatch) {
    const integrationId = decodeURIComponent(reconciliationPauseMatch[1]);
    const paused = reconciliationPauseMatch[2] === 'pause';
    const body = await request.json<{ reason?: string }>().catch(() => ({ reason: '' }));
    const state = await setYocoV2ReconciliationPause(env, workspaceId, integrationId, paused, String(body.reason || (paused ? 'Paused by administrator.' : '')));
    return response({ ok: true, state });
  }

  if (request.method === 'GET' && (suffix === 'cutover' || suffix === 'refund-cutover' || suffix === 'effects')) {
    const integrationId = String(url.searchParams.get('integrationId') || `yoco:${workspaceId}`);
    const [saleReporting, saleStock, refundReporting, refundStock, ownership, controls] = await Promise.all([
      getEffectRuntime(env, workspaceId, integrationId, 'SALE_REPORTING'),
      getEffectRuntime(env, workspaceId, integrationId, 'SALE_STOCK'),
      getEffectRuntime(env, workspaceId, integrationId, 'REFUND_REPORTING'),
      getEffectRuntime(env, workspaceId, integrationId, 'REFUND_STOCK'),
      env.DB.prepare(`SELECT * FROM integration_effect_ownership WHERE workspace_id=?1 AND integration_type='YOCO' ORDER BY effect_type`).bind(workspaceId).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_effect_gate WHERE workspace_id=?1 AND integration_id=?2 ORDER BY effect_type`).bind(workspaceId, integrationId).all<Row>()
    ]);
    const controlRows = controls.results || [];
    return response({
      ok: true,
      release: 'phase-v2-final-legacy-removal-reporting-audit',
      integrationId,
      ownership: ownership.results || [],
      runtimes: { SALE_REPORTING: saleReporting, SALE_STOCK: saleStock, REFUND_REPORTING: refundReporting, REFUND_STOCK: refundStock },
      controls: {
        sales: controlRows.filter((r: Row) => String(r.effect_type).startsWith('SALE_')),
        refunds: controlRows.filter((r: Row) => String(r.effect_type).startsWith('REFUND_'))
      },
      historical_cutover_records_retained_for_audit: true
    });
  }

  const effectAction = suffix.match(/^(?:cutover\/|refund-cutover\/)?effects\/(SALE_REPORTING|SALE_STOCK|REFUND_REPORTING|REFUND_STOCK)\/(pause|resume)$/);
  if (request.method === 'POST' && effectAction) {
    const effectType = effectAction[1] as YocoV2EffectType;
    const action = effectAction[2];
    const body = await request.json<{ integration_id?: string; reason?: string }>().catch(() => ({} as { integration_id?: string; reason?: string }));
    const integrationId = String(body.integration_id || `yoco:${workspaceId}`);
    const result = action === 'pause'
      ? await pauseEffect(env, { workspaceId, integrationId, effectType, actorId: auth.uid, reason: body.reason })
      : await resumeEffect(env, { workspaceId, integrationId, effectType, actorId: auth.uid });
    return response({ ok: true, action, result });
  }

  if (request.method === 'GET' && suffix === 'dead-letters') {
    const rows = await env.DB.prepare(
      `SELECT * FROM yoco_v2_raw_events
        WHERE workspace_id = ?1 AND processing_status IN ('DEAD_LETTERED', 'FAILED_PERMANENTLY')
        ORDER BY updated_at DESC LIMIT 100`
    ).bind(workspaceId).all<Row>();
    return response({ ok: true, rows: rows.results || [] });
  }

  if (request.method === 'GET' && suffix === 'ownership') {
    const rows = await env.DB.prepare(
      `SELECT * FROM integration_effect_ownership
        WHERE workspace_id = ?1 AND integration_type = 'YOCO' ORDER BY effect_type`
    ).bind(workspaceId).all<Row>();
    return response({ ok: true, rows: rows.results || [] });
  }

  const eventMatch = suffix.match(/^events\/([^/]+)$/);
  if (request.method === 'GET' && eventMatch) {
    const rawEventId = decodeURIComponent(eventMatch[1]);
    const event = await loadEvent(env, workspaceId, rawEventId);
    if (!event) return response({ ok: false, error: 'V2 raw event not found.' }, 404);
    const [runs, timeline, apiRequests, domainEvents] = await Promise.all([
      env.DB.prepare(`SELECT * FROM yoco_v2_processing_runs WHERE raw_event_id = ?1 ORDER BY attempt_number DESC`).bind(rawEventId).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_processing_timeline WHERE raw_event_id = ?1 ORDER BY created_at, id`).bind(rawEventId).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_api_requests WHERE raw_event_id = ?1 ORDER BY created_at`).bind(rawEventId).all<Row>(),
      env.DB.prepare(`SELECT * FROM yoco_v2_domain_events WHERE raw_event_id = ?1 ORDER BY created_at`).bind(rawEventId).all<Row>()
    ]);
    return response({ ok: true, event, runs: runs.results || [], timeline: timeline.results || [], apiRequests: apiRequests.results || [], domainEvents: domainEvents.results || [] });
  }

  const runtimeAction = suffix.match(/^runtime\/([^/]+)\/clear-credential-circuit$/);
  if (request.method === 'POST' && runtimeAction) {
    const integrationId = decodeURIComponent(runtimeAction[1]);
    if (!env.YOCO_V2_RATE_GATE) return response({ ok: false, error: 'Yoco V2 rate gate binding is not configured.' }, 503);
    const stub = env.YOCO_V2_RATE_GATE.get(env.YOCO_V2_RATE_GATE.idFromName(integrationId));
    const gateResponse = await stub.fetch('https://rate-gate/clear-credential-circuit', { method: 'POST' });
    if (!gateResponse.ok) return response({ ok: false, error: 'Rate-gate circuit could not be cleared.' }, 503);
    const result = await gateResponse.json<Record<string, unknown>>();
    await env.DB.prepare(
      `UPDATE yoco_v2_integration_runtime
          SET paused_until = NULL, pause_reason = NULL, intervention_required = 0,
              consecutive_auth_failures = 0, consecutive_rate_limits = 0, updated_at = ?3
        WHERE workspace_id = ?1 AND integration_id = ?2`
    ).bind(workspaceId, integrationId, nowIso()).run();
    return response({ ok: true, integrationId, ...result });
  }

  const actionMatch = suffix.match(/^events\/([^/]+)\/(replay|requeue-dead-letter|manual-review|refetch|reresolve|repropose|recompare|discard-stock-effects)$/);
  if (request.method === 'POST' && actionMatch) {
    const rawEventId = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    const event = await loadEvent(env, workspaceId, rawEventId);
    if (!event) return response({ ok: false, error: 'V2 raw event not found.' }, 404);
    if (Number(event.signature_valid || 0) !== 1) return response({ ok: false, error: 'Invalid-signature events cannot enter V2 processing.' }, 409);

    // Cleans up a stock effect that was proposed but never actually applied to the stock ledger
    // (e.g. a test order stuck by a since-fixed race condition) — deletes the unapplied proposal
    // rows and marks the raw event for manual review so it's never auto-retried again. Refuses if
    // a real stock_movements row already exists for this order, so this can never silently erase
    // the record of an inventory change that genuinely happened. Does NOT touch the immutable raw
    // event, the processing timeline, or the sale's reporting/financial record — those stay intact.
    if (action === 'discard-stock-effects') {
      const domainEvent = await env.DB.prepare(
        `SELECT * FROM yoco_v2_domain_events WHERE raw_event_id = ?1 AND workspace_id = ?2 LIMIT 1`
      ).bind(rawEventId, workspaceId).first<Row>();
      if (!domainEvent) return response({ ok: false, error: 'No canonical sale found for this event.' }, 404);
      const sourceOrderId = String(domainEvent.source_entity_id || '');
      const existingMovements = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM stock_movements
          WHERE workspace_id = ?1 AND document_type = 'yoco_order' AND document_id = ?2 AND movement_type = 'sale_depletion'`
      ).bind(workspaceId, sourceOrderId).first<Row>();
      if (Number(existingMovements?.count || 0) > 0) {
        return response({ ok: false, error: 'Refusing to discard: real stock movements already exist for this order.' }, 409);
      }
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM yoco_v2_proposed_stock_movements WHERE workspace_id = ?1 AND source_order_id = ?2`).bind(workspaceId, sourceOrderId),
        env.DB.prepare(`DELETE FROM yoco_v2_live_sale_stock_effects WHERE workspace_id = ?1 AND source_order_id = ?2`).bind(workspaceId, sourceOrderId),
        env.DB.prepare(`DELETE FROM yoco_v2_live_effect_outbox WHERE workspace_id = ?1 AND domain_event_id = ?2 AND effect_type = 'SALE_STOCK'`).bind(workspaceId, String(domainEvent.id)),
        env.DB.prepare(`UPDATE yoco_v2_raw_events SET processing_status = 'MANUAL_REVIEW_REQUIRED', updated_at = ?2 WHERE id = ?1`).bind(rawEventId, nowIso())
      ]);
      await appendTimeline(env.DB, {
        rawEventId,
        step: 'ADMIN_STOCK_EFFECTS_DISCARDED',
        status: 'MANUAL_REVIEW_REQUIRED',
        message: 'Administrator discarded unapplied stock effect proposals for this order and marked the event for manual review. The immutable raw event, its timeline, and the sale reporting record are unaffected.',
        metadata: { actor_uid: auth.uid, actor_email: auth.email, source_order_id: sourceOrderId }
      });
      return response({ ok: true, status: 'DISCARDED', sourceOrderId });
    }

    if (action === 'manual-review') {
      await env.DB.prepare(
        `UPDATE yoco_v2_raw_events
            SET processing_status = 'MANUAL_REVIEW_REQUIRED', updated_at = ?2
          WHERE id = ?1`
      ).bind(rawEventId, nowIso()).run();
      await appendTimeline(env.DB, {
        rawEventId,
        step: 'MANUAL_REVIEW_MARKED',
        status: 'MANUAL_REVIEW_REQUIRED',
        message: 'Administrator marked the event for manual review.',
        metadata: { actor_uid: auth.uid, actor_email: auth.email }
      });
      return response({ ok: true, status: 'MANUAL_REVIEW_REQUIRED' });
    }

    if (!flags.yoco_v2_queue_enabled) return response({ ok: false, error: 'Yoco V2 queue is disabled for this workspace.' }, 409);
    if (action === 'requeue-dead-letter' && !['DEAD_LETTERED', 'FAILED_PERMANENTLY'].includes(String(event.processing_status))) {
      return response({ ok: false, error: 'Only dead-lettered or permanently failed events may be requeued.' }, 409);
    }
    if (String(event.processing_status) === 'PROCESSING') return response({ ok: false, error: 'Event is currently processing.' }, 409);

    const rerunStage = action === 'reresolve' ? 'resolution'
      : action === 'repropose' ? 'proposal'
        : action === 'recompare' ? 'comparison'
          : 'all';
    await resetForAdminReplay(env, rawEventId, action === 'requeue-dead-letter');
    try {
      const replayMessage = buildAdminReplayMessage(event, action, {
        force_refresh: action === 'refetch',
        rerun_stage: rerunStage
      });
      await publishAdminReplay(env, replayMessage);
      await markRawEventQueued(env.DB, rawEventId);
      await appendTimeline(env.DB, {
        rawEventId,
        step: action === 'requeue-dead-letter' ? 'DEAD_LETTER_REQUEUED' : 'ADMIN_SHADOW_REPROCESS_QUEUED',
        status: 'QUEUED',
        message: `Administrator queued V2 shadow action ${action}.`,
        metadata: { actor_uid: auth.uid, actor_email: auth.email, action, rerun_stage: rerunStage, force_refresh: action === 'refetch', action_id: newId('yoco_v2_admin_action') }
      });
      // The durable Cloudflare Queue message above is the fallback of record, but its delivery
      // latency has been observed in production to run well past its configured 5s batch window
      // (root cause not yet isolated — tracked separately). An admin waiting on a manual replay
      // shouldn't be stuck on that: process inline here too and surface the real outcome now.
      // Idempotent by design (same effect_key/proposal_key guards), so a later duplicate delivery
      // from the queue is a harmless no-op.
      const inlineResult = await processYocoV2QueueMessage(env, replayMessage).catch((cause) => {
        console.error('[admin] inline replay failed; durable queue fallback remains pending', cause);
        return null;
      });
      return response({ ok: true, status: 'QUEUED', action, rerunStage, inlineResult });
    } catch (cause) {
      const errorMessage = cause instanceof Error ? cause.message : String(cause);
      await markRawEventQueueFailure(env.DB, rawEventId, 'YOCO_V2_ADMIN_REPLAY_PUBLISH_FAILED', errorMessage);
      await appendTimeline(env.DB, {
        rawEventId,
        step: 'ADMIN_REPLAY_QUEUE_PUBLISH_FAILED',
        status: 'WAITING',
        message: 'Administrator shadow action could not be published. The immutable event remains available for retry.',
        metadata: { actor_uid: auth.uid, actor_email: auth.email, action, error: errorMessage }
      });
      await recordYocoV2Diagnostic(env.DB, {
        trace_id: String(event.trace_id),
        raw_event_id: rawEventId,
        workspace_id: workspaceId,
        integration_id: String(event.integration_id),
        event_type: String(event.event_type),
        status: 'failed',
        error_category: 'CONFIGURATION_ERROR',
        operation: 'yoco.v2.admin.replay.publish.failed',
        message: errorMessage
      });
      return response({ ok: false, error: 'Replay queue publication failed. The raw event remains available for retry.' }, 503);
    }
  }

  // Workspace Health dashboard: per-workspace webhook call-rate + active subscription count.
  if (request.method === 'GET' && suffix === 'receipt-stats') {
    const [connection, subscriptions, outcome, ...windowCounts] = await Promise.all([
      getYocoConnection(env, workspaceId),
      countActiveYocoWebhookSubscriptions(env, workspaceId),
      // A receipt counts as failed if signature verification rejected it, capture rejected it,
      // or it was captured but never made it onto the processing queue. Everything else (including
      // CAPTURE_DISABLED, a deliberate feature-flag state rather than a per-event failure) counts
      // as successful — this mirrors what an operator actually needs to react to.
      env.DB.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE
             WHEN signature_status != 'VALID' THEN 1
             WHEN capture_status IN ('REJECTED', 'FAILED', 'BUDGET_EXHAUSTED') THEN 1
             WHEN queue_status = 'PUBLISH_FAILED' THEN 1
             ELSE 0
           END) AS failed
         FROM yoco_v2_webhook_receipts
        WHERE workspace_id = ?1
          AND datetime(received_at) >= datetime('now', '-24 hours')
          AND received_at >= ?2`
      ).bind(workspaceId, sargableDayFloor(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())).first<Row>(),
      ...RECEIPT_STATS_WINDOWS_MINUTES.map(([, minutes]) =>
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM yoco_v2_webhook_receipts
            WHERE workspace_id = ?1
              AND datetime(received_at) >= datetime('now', ?2)
              AND received_at >= ?3`
        ).bind(
          workspaceId,
          `-${minutes} minutes`,
          sargableDayFloor(new Date(Date.now() - minutes * 60 * 1000).toISOString()),
        ).first<Row>()
      )
    ]);
    const calls: Record<string, number> = {};
    RECEIPT_STATS_WINDOWS_MINUTES.forEach(([key], index) => {
      calls[key] = Number((windowCounts[index] as Row | null)?.count || 0);
    });
    const lastEvent = await env.DB.prepare(
      `SELECT MAX(received_at) AS last_received_at FROM yoco_v2_webhook_receipts WHERE workspace_id = ?1`
    ).bind(workspaceId).first<Row>();
    const total24h = Number((outcome as Row | null)?.total || 0);
    const failed24h = Number((outcome as Row | null)?.failed || 0);
    return response({
      ok: true,
      workspaceId,
      connectionStatus: String(connection?.status || 'disconnected'),
      connectionActive: connection?.connection_active === 1,
      lastError: String(connection?.last_error || ''),
      activeSubscriptions: subscriptions.count,
      subscriptionCheckError: subscriptions.error || '',
      calls,
      lastReceivedAt: String((lastEvent as Row | null)?.last_received_at || ''),
      total24h,
      failed24h,
      succeeded24h: total24h - failed24h
    });
  }

  // Workspace Health dashboard: bucketed call counts for the time-series chart. The central
  // route computes bucket boundaries (so every workspace's series lines up on the same x-axis)
  // and passes them here as windowStart/bucketMinutes/bucketCount; this is a single grouped query.
  if (request.method === 'GET' && suffix === 'receipt-timeseries') {
    const windowStart = String(url.searchParams.get('windowStart') || '');
    const bucketMinutes = Math.max(1, Number(url.searchParams.get('bucketMinutes')) || 60);
    const bucketCount = Math.min(500, Math.max(1, Number(url.searchParams.get('bucketCount')) || 24));
    if (!windowStart) return response({ ok: false, error: 'windowStart is required.' }, 400);

    const rows = await env.DB.prepare(
      `SELECT CAST((julianday(received_at) - julianday(?2)) * 1440.0 / ?3 AS INTEGER) AS bucket_idx,
              COUNT(*) AS count
         FROM yoco_v2_webhook_receipts
        WHERE workspace_id = ?1
          AND datetime(received_at) >= datetime(?2)
          AND received_at >= ?4
        GROUP BY bucket_idx`
    ).bind(workspaceId, windowStart, bucketMinutes, sargableDayFloor(String(windowStart))).all<Row>();

    const buckets = new Array(bucketCount).fill(0);
    for (const row of rows.results || []) {
      const idx = Number((row as Row).bucket_idx);
      if (Number.isInteger(idx) && idx >= 0 && idx < bucketCount) {
        buckets[idx] = Number((row as Row).count || 0);
      }
    }
    return response({ ok: true, workspaceId, buckets });
  }

  if (request.method === 'GET' && suffix === 'receipts') {
    const limit = positiveInteger(url.searchParams.get('limit'), 50, 200);
    const offset = positiveInteger(url.searchParams.get('offset'), 0, 100_000);
    const rows = await env.DB.prepare(
      `SELECT id, event_type, signature_status, capture_status, queue_status, source_reference,
              trace_id, received_at
         FROM yoco_v2_webhook_receipts
        WHERE workspace_id = ?1
        ORDER BY received_at DESC
        LIMIT ?2 OFFSET ?3`
    ).bind(workspaceId, limit, offset).all<Row>();
    return response({ ok: true, rows: rows.results || [], limit, offset });
  }

  if (request.method === 'GET' && suffix === 'actions') {
    const limit = positiveInteger(url.searchParams.get('limit'), 50, 200);
    const rows = await env.DB.prepare(
      `SELECT id, actor_uid, actor_email, action, target_type, target_id, reason, status,
              created_at, completed_at
         FROM yoco_v2_admin_actions
        WHERE workspace_id = ?1
        ORDER BY created_at DESC
        LIMIT ?2`
    ).bind(workspaceId, limit).all<Row>();
    return response({ ok: true, rows: rows.results || [] });
  }

  // Manual trigger for the Phase 0 reconcile-to-one-subscription backstop. Not yet on a
  // schedule (crons are disabled account-wide pending unrelated fixes) — callable on demand
  // from the Webhook Health dashboard or directly for now.
  if (request.method === 'POST' && suffix === 'reconcile-subscription') {
    try {
      const result = await reconcileYocoWebhookSubscription(env, workspaceId);
      return response({ ...result, ok: true });
    } catch (cause) {
      return response({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }, 503);
    }
  }

  if (request.method === 'POST' && suffix === 'disconnect-all') {
    const actionId = newId('yoco_v2_admin_action');
    const startedAt = nowIso();
    try {
      const result = await disconnectYoco(env, workspaceId);
      await env.DB.prepare(
        `INSERT INTO yoco_v2_admin_actions
          (id, workspace_id, integration_id, actor_uid, actor_email, action, target_type, target_id,
           idempotency_key, previous_state_json, resulting_state_json, reason, status, trace_id, created_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'disconnect_all_subscriptions', 'yoco_connection', ?2,
                 ?6, '{}', ?7, '', 'completed', ?6, ?8, ?8)`
      ).bind(
        actionId,
        workspaceId,
        `yoco:${workspaceId}`,
        auth.uid || 'admin',
        auth.email || '',
        actionId,
        JSON.stringify(result),
        startedAt
      ).run();
      return response({ ok: true, ...result });
    } catch (cause) {
      const errorMessage = cause instanceof Error ? cause.message : String(cause);
      await env.DB.prepare(
        `INSERT INTO yoco_v2_admin_actions
          (id, workspace_id, integration_id, actor_uid, actor_email, action, target_type, target_id,
           idempotency_key, previous_state_json, resulting_state_json, reason, status, trace_id, created_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'disconnect_all_subscriptions', 'yoco_connection', ?2,
                 ?6, '{}', '{}', ?7, 'failed', ?6, ?8, ?8)`
      ).bind(
        actionId,
        workspaceId,
        `yoco:${workspaceId}`,
        auth.uid || 'admin',
        auth.email || '',
        actionId,
        errorMessage,
        startedAt
      ).run();
      return response({ ok: false, error: errorMessage }, 503);
    }
  }

  return response({ ok: false, error: 'Unknown Yoco V2 admin route.' }, 404);
}
