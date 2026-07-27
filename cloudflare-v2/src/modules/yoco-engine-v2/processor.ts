import type { Env } from '../../legacy/types';
import type { YocoV2QueueDispatchResult, YocoV2QueueMessage } from './contracts';
import { yocoV2FeatureFlags, yocoV2RetryConfig } from './config';
import { classifyYocoV2Error, computeYocoV2RetryDelayMs } from './errors';
import { recordYocoV2Diagnostic } from './observability';
import {
  acquireProcessingLock,
  appendTimeline,
  createProcessingRun,
  nowIso,
  updateRunAndRawEvent,
  type Row
} from './repository';
import type { YocoV2QueueEnv } from './capture';
import { isSupportedCompletedSaleEvent, resolveCanonicalYocoSale } from './sale-resolver';
import { buildSaleEffectProposals } from './effect-proposals';
import { isSupportedRefundEvent, resolveCanonicalYocoRefund } from './refund-resolver';
import { buildRefundReportingProposal, buildRefundStockProposals } from './refund-effect-proposals';
import { applyControlledLiveSaleEffects } from './live-sale';
import { applyControlledLiveRefundEffects } from './live-refund';

const SUPPORTED_EVENT_MARKERS = [
  'order.',
  'payment.',
  'refund.',
  'return.'
];

function supportedEventType(value: unknown): boolean {
  const eventType = String(value || '').trim().toLowerCase().replace(/_/g, '.');
  return SUPPORTED_EVENT_MARKERS.some((marker) => eventType.startsWith(marker));
}

async function sendToDeadLetter(env: YocoV2QueueEnv, message: YocoV2QueueMessage, reason: string): Promise<void> {
  if (!env.YOCO_V2_EVENTS_DLQ) throw new Error('YOCO_V2_EVENTS_DLQ binding is not configured.');
  await env.YOCO_V2_EVENTS_DLQ.send({ ...message, replay_reason: reason }, { contentType: 'json' });
}

async function completeCanonicalProcessing(
  env: YocoV2QueueEnv,
  rawEvent: Row,
  run: Row,
  message: YocoV2QueueMessage
): Promise<YocoV2QueueDispatchResult> {
  const rawEventId = String(rawEvent.id);
  const runId = String(run.id);
  const eventType = String(rawEvent.event_type || 'unknown');
    const payloadText = String(rawEvent.payload_json || '');
  const isRefund = /refund|return/.test(eventType.toLowerCase())
    || /returned_line_items|returnedLineItems|\"refunds?\"|refund_id|refundId|refund_order_id|refundOrderId|\"order_type\"\s*:\s*\"refund\"|\"orderType\"\s*:\s*\"refund\"/i.test(payloadText);

  if (!supportedEventType(eventType)) {
    await appendTimeline(env.DB, {
      rawEventId,
      processingRunId: runId,
      step: 'UNSUPPORTED_EVENT_RECORDED',
      status: 'COMPLETED',
      message: 'Event type is outside the current V2 sale/refund domain and was retained without business effects.',
      metadata: { event_type: eventType, error_category: 'UNSUPPORTED_EVENT' }
    });
    await updateRunAndRawEvent(env.DB, {
      rawEventId,
      processingRunId: runId,
      status: 'COMPLETED',
      currentStep: 'UNSUPPORTED_EVENT_RECORDED',
      completedAt: nowIso(),
      errorCategory: 'UNSUPPORTED_EVENT',
      errorCode: 'YOCO_V2_UNSUPPORTED_EVENT',
      errorMessage: 'Unsupported event retained for observability; no live effect attempted.'
    });
    return { ok: true, action: 'ack', status: 'COMPLETED' };
  }

  if (isRefund) {
    if (!isSupportedRefundEvent(eventType)) {
      await appendTimeline(env.DB, {
        rawEventId,
        processingRunId: runId,
        step: 'REFUND_EVENT_UNSUPPORTED',
        status: 'COMPLETED',
        message: 'Refund-related event is not a supported resolver trigger and remains observable without effects.',
        metadata: { event_type: eventType }
      });
      await updateRunAndRawEvent(env.DB, {
        rawEventId,
        processingRunId: runId,
        status: 'COMPLETED',
        currentStep: 'REFUND_EVENT_UNSUPPORTED',
        completedAt: nowIso(),
        errorCategory: 'UNSUPPORTED_EVENT',
        errorCode: 'YOCO_V2_REFUND_EVENT_UNSUPPORTED',
        errorMessage: 'Refund event is not supported by the canonical resolver.'
      });
      return { ok: true, action: 'ack', status: 'COMPLETED' };
    }
    const resolved = await resolveCanonicalYocoRefund(env, {
      rawEvent,
      processingRun: run,
      forceRefresh: Boolean(message.force_refresh)
    });
    const stage = message.rerun_stage || 'all';
    if (stage === 'resolution') {
      const status = resolved.canonical.inventory_resolution_status === 'MANUAL_REVIEW_REQUIRED' ? 'MANUAL_REVIEW_REQUIRED' : 'COMPLETED';
      await updateRunAndRawEvent(env.DB, {
        rawEventId,
        processingRunId: runId,
        status,
        currentStep: 'CANONICAL_REFUND_RESOLUTION_COMPLETED',
        completedAt: nowIso()
      });
      return { ok: true, action: 'ack', status };
    }
    if (stage === 'proposal' || stage === 'all') {
      await buildRefundReportingProposal(env, resolved.domainEvent, resolved.canonical, rawEventId, runId);
      await buildRefundStockProposals(env, resolved.domainEvent, resolved.canonical, rawEventId, runId);
    }
    if (stage === 'all') {
      await applyControlledLiveRefundEffects(env, {
        domainEvent: resolved.domainEvent,
        canonical: resolved.canonical,
        rawEvent,
        rawEventId,
        processingRunId: runId,
        message
      });
    }
    const status = resolved.canonical.inventory_resolution_status === 'MANUAL_REVIEW_REQUIRED' ? 'MANUAL_REVIEW_REQUIRED' : 'COMPLETED';
    await updateRunAndRawEvent(env.DB, {
      rawEventId,
      processingRunId: runId,
      status,
      currentStep: 'CANONICAL_REFUND_EFFECTS_COMPLETED',
      completedAt: nowIso()
    });
    return { ok: true, action: 'ack', status };
  }

  if (!isSupportedCompletedSaleEvent(eventType)) {
    await appendTimeline(env.DB, {
      rawEventId,
      processingRunId: runId,
      step: 'SALE_EVENT_NOT_FINAL',
      status: 'COMPLETED',
      message: 'Sale-related event is not a supported completed-sale trigger. It remains observable without effects.',
      metadata: { event_type: eventType }
    });
    await updateRunAndRawEvent(env.DB, {
      rawEventId,
      processingRunId: runId,
      status: 'COMPLETED',
      currentStep: 'SALE_EVENT_NOT_FINAL',
      completedAt: nowIso(),
      errorCategory: 'UNSUPPORTED_EVENT',
      errorCode: 'YOCO_V2_SALE_EVENT_NOT_FINAL',
      errorMessage: 'Sale event is not a supported completed-sale trigger.'
    });
    return { ok: true, action: 'ack', status: 'COMPLETED' };
  }

  const resolved = await resolveCanonicalYocoSale(env, {
    rawEvent,
    processingRun: run,
    forceRefresh: Boolean(message.force_refresh)
  });
  const stage = message.rerun_stage || 'all';
  if (stage === 'resolution') {
    await updateRunAndRawEvent(env.DB, {
      rawEventId,
      processingRunId: runId,
      status: 'COMPLETED',
      currentStep: 'CANONICAL_SALE_RESOLUTION_COMPLETED',
      completedAt: nowIso()
    });
    return { ok: true, action: 'ack', status: 'COMPLETED' };
  }
  if (stage === 'proposal' || stage === 'all') {
    await buildSaleEffectProposals(env, resolved.domainEvent, resolved.canonical, rawEventId, runId);
  }
  if (stage === 'all') {
    const effectResult = await applyControlledLiveSaleEffects(env, {
      domainEvent: resolved.domainEvent,
      canonical: resolved.canonical,
      rawEvent,
      rawEventId,
      processingRunId: runId,
      message
    });
    // Record the live-effect outcome so a partial/skipped sale is never silently "completed".
    // Stock is best-effort: unmapped/unresolved lines are skipped (not blocked), so surface
    // whether stock fully APPLIED, PARTIAL-ly applied, or was SKIPPED, plus the reason.
    const reportingOutcome = String(effectResult.reporting ?? 'UNKNOWN');
    const stockOutcome = String(effectResult.stock ?? 'UNKNOWN');
    const status = stockOutcome === 'PARTIAL'
      ? 'PARTIAL'
      : stockOutcome === 'SKIPPED' || stockOutcome.startsWith('SKIPPED')
        ? 'SKIPPED'
        : 'APPLIED';
    await appendTimeline(env.DB, {
      rawEventId,
      processingRunId: runId,
      step: 'LIVE_SALE_EFFECTS_EVALUATED',
      status,
      message: status === 'PARTIAL'
        ? 'Live sale effects applied for all resolvable lines; unmapped/unresolved lines were skipped and flagged for review.'
        : status === 'SKIPPED'
          ? 'Live sale stock was skipped (no resolvable lines or a closed ownership/control gate); reporting outcome recorded below.'
          : 'Live sale effects were applied through the ownership gates.',
      metadata: {
        reporting: reportingOutcome,
        stock: stockOutcome,
        reporting_runtime: effectResult.reporting_runtime ?? null,
        stock_runtime: effectResult.stock_runtime ?? null
      }
    });
  }
  await updateRunAndRawEvent(env.DB, {
    rawEventId,
    processingRunId: runId,
    status: 'COMPLETED',
    currentStep: 'CANONICAL_SALE_EFFECTS_COMPLETED',
    completedAt: nowIso()
  });
  return { ok: true, action: 'ack', status: 'COMPLETED' };
}

export async function processYocoV2QueueMessage(env: YocoV2QueueEnv, message: YocoV2QueueMessage): Promise<YocoV2QueueDispatchResult> {
  const started = Date.now();
  const rawEventId = String(message.raw_event_id || '');
  const workspaceId = String(message.workspace_id || '');
  if (!rawEventId || !workspaceId) return { ok: false, action: 'ack', status: 'FAILED_PERMANENTLY', error: 'Queue message is missing raw_event_id or workspace_id.' };

  const existing = await env.DB.prepare(
    `SELECT * FROM yoco_v2_raw_events WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`
  ).bind(rawEventId, workspaceId).first<Row>();
  if (!existing) return { ok: false, action: 'ack', status: 'FAILED_PERMANENTLY', error: 'Raw event was not found.' };
  if (Number(existing.signature_valid || 0) !== 1) {
    return { ok: false, action: 'ack', status: 'FAILED_PERMANENTLY', error: 'Raw event signature is not valid.' };
  }
  const existingStatus = String(existing.processing_status || '');
  if (['COMPLETED', 'DEAD_LETTERED', 'FAILED_PERMANENTLY'].includes(existingStatus)) {
    return { ok: true, action: 'ack', status: existingStatus as YocoV2QueueDispatchResult['status'] };
  }

  const flags = yocoV2FeatureFlags(env, workspaceId);
  if (!flags.yoco_v2_queue_enabled) {
    const now = nowIso();
    await env.DB.prepare(
      `UPDATE yoco_v2_raw_events
          SET queue_status = 'PAUSED', processing_status = 'WAITING', updated_at = ?2
        WHERE id = ?1`
    ).bind(rawEventId, now).run();
    await appendTimeline(env.DB, {
      rawEventId,
      step: 'QUEUE_PROCESSING_DISABLED',
      status: 'WAITING',
      message: 'V2 queue processing is disabled for this workspace. The raw event remains available for replay.',
      metadata: { queue_enabled: false }
    });
    await recordYocoV2Diagnostic(env.DB, {
      trace_id: String(existing.trace_id || message.trace_id),
      raw_event_id: rawEventId,
      workspace_id: workspaceId,
      integration_id: String(existing.integration_id || message.integration_id),
      event_type: String(existing.event_type || message.event_type),
      status: 'waiting',
      duration_ms: Date.now() - started,
      operation: 'yoco.v2.queue.paused',
      message: 'Queue processing is disabled for this workspace.'
    });
    return { ok: true, action: 'ack', status: 'WAITING' };
  }

  if (existingStatus === 'RETRY_SCHEDULED' && existing.next_attempt_at) {
    const retryAt = Date.parse(String(existing.next_attempt_at));
    const remainingMs = retryAt - Date.now();
    if (Number.isFinite(retryAt) && remainingMs > 0) {
      return {
        ok: false,
        action: 'retry',
        delaySeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
        status: 'RETRY_SCHEDULED'
      };
    }
  }

  const rawEvent = await acquireProcessingLock(env.DB, rawEventId, workspaceId);
  if (!rawEvent) return { ok: true, action: 'ack', status: existingStatus as YocoV2QueueDispatchResult['status'] };
  const run = await createProcessingRun(env.DB, rawEvent);
  const attemptNumber = Number(rawEvent.processing_attempts || 1);
  const traceId = String(rawEvent.trace_id || message.trace_id);
  const eventType = String(rawEvent.event_type || message.event_type || 'unknown');

  await appendTimeline(env.DB, {
    rawEventId,
    processingRunId: String(run.id),
    step: 'PROCESSING_LOCK_ACQUIRED',
    status: 'PROCESSING',
    message: 'Idempotent V2 processing lock acquired.',
    metadata: { attempt_number: attemptNumber }
  });

  try {
    const result = await completeCanonicalProcessing(env, rawEvent, run, message);
    await recordYocoV2Diagnostic(env.DB, {
      trace_id: traceId,
      raw_event_id: rawEventId,
      workspace_id: workspaceId,
      integration_id: String(rawEvent.integration_id),
      event_type: eventType,
      attempt: attemptNumber,
      status: result.status || 'COMPLETED',
      duration_ms: Date.now() - started,
      operation: 'yoco.v2.queue.process',
      message: message.live_effects ? 'V2 canonical processing completed; live effects were evaluated through ownership gates.' : 'V2 canonical processing completed without live effects.'
    });
    return result;
  } catch (cause) {
    const classified = classifyYocoV2Error(cause);
    const retry = yocoV2RetryConfig(env);
    const exhausted = attemptNumber >= retry.maxAttempts;
    const runId = String(run.id);

    if (classified.retryable && !exhausted) {
      const delayMs = computeYocoV2RetryDelayMs({
        attemptNumber,
        baseRetryMs: retry.baseRetryMs,
        maxRetryMs: retry.maxRetryMs,
        retryAfterMs: classified.retryAfterMs
      });
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      await updateRunAndRawEvent(env.DB, {
        rawEventId,
        processingRunId: runId,
        status: 'RETRY_SCHEDULED',
        currentStep: 'RETRY_SCHEDULED',
        nextRetryAt,
        errorCategory: classified.category,
        errorCode: classified.code,
        errorMessage: classified.message,
        errorDetails: classified.details
      });
      await appendTimeline(env.DB, {
        rawEventId,
        processingRunId: runId,
        step: 'RETRY_SCHEDULED',
        status: 'RETRY_SCHEDULED',
        message: 'Temporary failure classified and scheduled with exponential backoff and jitter.',
        metadata: { delay_ms: delayMs, next_retry_at: nextRetryAt, error_category: classified.category }
      });
      await recordYocoV2Diagnostic(env.DB, {
        trace_id: traceId,
        raw_event_id: rawEventId,
        workspace_id: workspaceId,
        integration_id: String(rawEvent.integration_id),
        event_type: eventType,
        attempt: attemptNumber,
        status: 'retry_scheduled',
        duration_ms: Date.now() - started,
        error_category: classified.category,
        operation: 'yoco.v2.queue.retry',
        message: classified.message
      });
      return { ok: false, action: 'retry', delaySeconds: Math.max(1, Math.ceil(delayMs / 1000)), status: 'RETRY_SCHEDULED', error: classified.message };
    }

    const finalStatus = exhausted ? 'DEAD_LETTERED' : 'FAILED_PERMANENTLY';
    await updateRunAndRawEvent(env.DB, {
      rawEventId,
      processingRunId: runId,
      status: finalStatus,
      currentStep: finalStatus,
      completedAt: nowIso(),
      errorCategory: classified.category,
      errorCode: classified.code,
      errorMessage: classified.message,
      errorDetails: { ...classified.details, exhausted }
    });
    await appendTimeline(env.DB, {
      rawEventId,
      processingRunId: runId,
      step: finalStatus,
      status: finalStatus,
      message: exhausted
        ? 'Maximum processing attempts exhausted. Event moved to dead-letter handling.'
        : 'Permanent processing error classified. Event moved to dead-letter handling.',
      metadata: { error_category: classified.category, error_code: classified.code, attempt_number: attemptNumber }
    });
    try {
      await sendToDeadLetter(env, message, exhausted ? 'attempts_exhausted' : 'permanent_failure');
    } catch (dlqCause) {
      await recordYocoV2Diagnostic(env.DB, {
        trace_id: traceId,
        raw_event_id: rawEventId,
        workspace_id: workspaceId,
        integration_id: String(rawEvent.integration_id),
        event_type: eventType,
        attempt: attemptNumber,
        status: 'dead_letter_publish_failed',
        duration_ms: Date.now() - started,
        error_category: 'CONFIGURATION_ERROR',
        operation: 'yoco.v2.queue.dead_letter.failed',
        message: dlqCause instanceof Error ? dlqCause.message : String(dlqCause)
      });
    }
    return { ok: false, action: 'ack', status: finalStatus, error: classified.message };
  }
}
