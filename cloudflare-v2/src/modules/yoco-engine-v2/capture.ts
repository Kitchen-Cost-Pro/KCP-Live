import type { Env } from '../../legacy/types';
import type { YocoV2CaptureInput, YocoV2QueueMessage } from './contracts';
import { yocoV2FeatureFlags } from './config';
import { recordYocoV2Diagnostic } from './observability';
import { appendTimeline, insertRawYocoV2Event, markRawEventQueued, markRawEventQueueFailure } from './repository';
import { recordYocoV2WebhookReceipt, sha256Hex } from './admin-security';

export interface YocoV2QueueEnv extends Env {
  YOCO_V2_EVENTS?: Queue<YocoV2QueueMessage>;
  YOCO_V2_EVENTS_DLQ?: Queue<YocoV2QueueMessage>;
}

function sourceReference(payload: Record<string, unknown>): string {
  const source = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : payload;
  return String(source.order_id || source.orderId || source.refund_id || source.refundId || source.payment_id || source.paymentId || source.id || '');
}

async function recordVerifiedReceipt(
  env: YocoV2QueueEnv,
  input: YocoV2CaptureInput,
  values: { rawEventId?: string; traceId?: string; captureStatus: 'CAPTURED' | 'CAPTURE_DISABLED' | 'FAILED'; queueStatus: string; duplicateIdentity?: string }
) {
  await recordYocoV2WebhookReceipt(env.DB, {
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    rawEventId: values.rawEventId,
    yocoEventId: input.yocoEventId,
    eventType: input.eventType,
    sourceReference: sourceReference(input.payload),
    payloadHash: await sha256Hex(input.rawBody),
    signatureStatus: 'VALID',
    captureStatus: values.captureStatus,
    queueStatus: values.queueStatus,
    duplicateIdentity: values.duplicateIdentity,
    traceId: values.traceId,
    headers: input.headers,
    receivedAt: input.receivedAt
  }).catch(() => undefined);
}

export async function captureVerifiedYocoV2Event(env: YocoV2QueueEnv, input: YocoV2CaptureInput) {
  const started = Date.now();
  const flags = yocoV2FeatureFlags(env, input.workspaceId);
  if (!flags.yoco_v2_capture_enabled || !input.signatureValid) {
    if (input.signatureValid) await recordVerifiedReceipt(env, input, { captureStatus: 'CAPTURE_DISABLED', queueStatus: 'NOT_REQUESTED' });
    return { captured: false, reason: 'capture_disabled_or_invalid_signature' };
  }

  const { row, wasInserted } = await insertRawYocoV2Event(env.DB, input);
  const rawEventId = String(row.id);
  const traceId = String(row.trace_id);
  const integrationId = String(row.integration_id);
  const eventType = String(row.event_type);

  if (!wasInserted) {
    await appendTimeline(env.DB, {
      rawEventId,
      step: 'DUPLICATE_RECEIPT',
      status: 'DUPLICATE_EVENT',
      message: 'Duplicate webhook receipt matched the deterministic V2 event identity.',
      metadata: { event_key: row.event_key }
    });
    await recordYocoV2Diagnostic(env.DB, {
      trace_id: traceId,
      raw_event_id: rawEventId,
      workspace_id: input.workspaceId,
      integration_id: integrationId,
      event_type: eventType,
      status: 'duplicate',
      duration_ms: Date.now() - started,
      error_category: 'DUPLICATE_EVENT',
      operation: 'yoco.v2.capture.duplicate',
      message: 'Duplicate V2 webhook receipt observed; no duplicate queue work was published.'
    });
    await recordVerifiedReceipt(env, input, {
      rawEventId,
      traceId,
      captureStatus: 'CAPTURED',
      queueStatus: String(row.queue_status || 'NOT_REQUESTED'),
      duplicateIdentity: String(row.event_key || '')
    });
    return { captured: true, duplicate: true, rawEventId, traceId };
  }

  await appendTimeline(env.DB, {
    rawEventId,
    step: 'RAW_EVENT_CAPTURED',
    status: 'RECEIVED',
    message: 'Verified webhook payload captured exactly as received.',
    metadata: { payload_hash: row.payload_hash, signature_valid: true }
  });

  if (!flags.yoco_v2_queue_enabled) {
    await recordYocoV2Diagnostic(env.DB, {
      trace_id: traceId,
      raw_event_id: rawEventId,
      workspace_id: input.workspaceId,
      integration_id: integrationId,
      event_type: eventType,
      status: 'captured',
      duration_ms: Date.now() - started,
      operation: 'yoco.v2.capture',
      message: 'V2 raw event captured. Queue publication is disabled for this workspace.'
    });
    await recordVerifiedReceipt(env, input, { rawEventId, traceId, captureStatus: 'CAPTURED', queueStatus: 'NOT_REQUESTED' });
    return { captured: true, queued: false, rawEventId, traceId };
  }

  if (!env.YOCO_V2_EVENTS) {
    await markRawEventQueueFailure(env.DB, rawEventId, 'YOCO_V2_QUEUE_BINDING_MISSING', 'YOCO_V2_EVENTS queue binding is not configured.');
    throw new Error('YOCO_V2_EVENTS queue binding is not configured.');
  }

  const message: YocoV2QueueMessage = {
    raw_event_id: rawEventId,
    workspace_id: input.workspaceId,
    integration_id: integrationId,
    event_type: eventType,
    trace_id: traceId,
    live_effects: input.liveEffects !== false,
    replay_reason: input.replayReason
  };
  try {
    await env.YOCO_V2_EVENTS.send(message, { contentType: 'json' });
    await markRawEventQueued(env.DB, rawEventId);
    await appendTimeline(env.DB, {
      rawEventId,
      step: 'QUEUE_PUBLISHED',
      status: 'QUEUED',
      message: 'Identifier-only V2 queue message published.',
      metadata: { queue: 'kcp-yoco-v2-events' }
    });
    await recordYocoV2Diagnostic(env.DB, {
      trace_id: traceId,
      raw_event_id: rawEventId,
      workspace_id: input.workspaceId,
      integration_id: integrationId,
      event_type: eventType,
      status: 'queued',
      duration_ms: Date.now() - started,
      operation: 'yoco.v2.capture',
      message: 'V2 raw event captured and queued.'
    });
    await recordVerifiedReceipt(env, input, { rawEventId, traceId, captureStatus: 'CAPTURED', queueStatus: 'PUBLISHED' });
    return { captured: true, queued: true, rawEventId, traceId };
  } catch (cause) {
    const messageText = cause instanceof Error ? cause.message : String(cause);
    await markRawEventQueueFailure(env.DB, rawEventId, 'YOCO_V2_QUEUE_PUBLISH_FAILED', messageText);
    await recordVerifiedReceipt(env, input, { rawEventId, traceId, captureStatus: 'CAPTURED', queueStatus: 'PUBLISH_FAILED' });
    await appendTimeline(env.DB, {
      rawEventId,
      step: 'QUEUE_PUBLISH_FAILED',
      status: 'WAITING',
      message: 'Queue publication failed. The immutable raw event remains available for manual replay.',
      metadata: { error: messageText }
    });
    throw cause;
  }
}

export async function captureVerifiedYocoV2EventSafely(env: YocoV2QueueEnv, input: YocoV2CaptureInput) {
  try {
    return await captureVerifiedYocoV2Event(env, input);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await recordYocoV2Diagnostic(env.DB, {
      trace_id: `yoco-v2-capture-failure-${crypto.randomUUID()}`,
      workspace_id: input.workspaceId,
      integration_id: input.integrationId,
      event_type: input.eventType,
      status: 'failed',
      error_category: 'INTERNAL_ERROR',
      operation: 'yoco.v2.capture.failed',
      message: `V2 capture failed without interrupting the legacy webhook path: ${message}`
    });
    return { captured: false, reason: 'capture_failed', error: message };
  }
}
