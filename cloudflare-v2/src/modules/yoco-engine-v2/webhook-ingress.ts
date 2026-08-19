import type { AuthContext } from '../../legacy/types';
import type { YocoV2QueueEnv } from './capture';
import { captureVerifiedYocoV2Event } from './capture';
import { recordYocoV2WebhookReceipt, sha256Hex } from './admin-security';
import { verifyYocoV2WebhookSignature, normalizeStandardWebhookSecret } from './webhook-signature';
import { KCP_WORKER_RELEASE } from '../../release';
import type { Row } from './repository';
import { migrateYocoV2EffectOwnershipForConnection } from './ownership';
import { processYocoV2QueueMessage } from './processor';
import { scheduleImmediateYocoV2Processing } from './queue-consumer';

function text(value: unknown, fallback = ''): string {
  return String(value ?? fallback).trim();
}

function objectValue(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function eventFields(payload: Row, headers: Headers): { eventType: string; eventId: string; sourceReference: string } {
  const envelope = objectValue(payload.payload);
  const data = objectValue(payload.data);
  const envelopeData = objectValue(envelope.data);
  const eventType = text(
    payload.event_type || payload.eventType || payload.event || payload.type ||
    data.event_type || data.eventType || data.event || data.type ||
    envelope.event_type || envelope.eventType || envelope.event || envelope.type ||
    headers.get('x-yoco-event-type') || 'unknown'
  ).toLowerCase().replace(/[\s_]+/g, '.').replace(/\.+/g, '.');
  const eventId = text(
    headers.get('webhook-id') || headers.get('svix-id') || headers.get('x-yoco-event-id') ||
    payload.id || payload.event_id || payload.eventId || envelope.id || data.id
  ) || `yoco-webhook-${crypto.randomUUID()}`;
  const candidates = [payload, envelope, data, envelopeData];
  const sourceReference = candidates.map((row) => text(
    row.refund_id || row.refundId || row.order_id || row.orderId ||
    row.payment_id || row.paymentId || objectValue(row.order).id || objectValue(row.payment).id || row.id
  )).find(Boolean) || '';
  return { eventType: eventType || 'unknown', eventId, sourceReference };
}

// Normalise on read as well as on write: secrets stored before the write-side normalisation existed
// are still sitting in yoco_connections without the `whsec_` prefix, and the verifier fails closed on
// those — so every delivery for an already-connected workspace stayed unverifiable. Doing it here
// repairs existing connections without requiring anyone to disconnect and reconnect Yoco.
function activeWebhookSecrets(connection: Row | null): string[] {
  const secrets = [normalizeStandardWebhookSecret(connection?.webhook_secret)];
  const previousSecret = normalizeStandardWebhookSecret(connection?.webhook_previous_secret);
  const previousUntil = Date.parse(text(connection?.webhook_previous_until));
  if (previousSecret && Number.isFinite(previousUntil) && previousUntil > Date.now()) secrets.push(previousSecret);
  return secrets.filter(Boolean);
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function recordRejectedReceipt(
  env: YocoV2QueueEnv,
  input: {
    workspaceId: string;
    eventId: string;
    eventType: string;
    sourceReference: string;
    rawBody: string;
    headers: Headers;
    signatureStatus: 'SECRET_MISSING' | 'INVALID';
  }
): Promise<void> {
  await recordYocoV2WebhookReceipt(env.DB, {
    workspaceId: input.workspaceId,
    integrationId: `yoco:${input.workspaceId}`,
    yocoEventId: input.eventId,
    eventType: input.eventType,
    sourceReference: input.sourceReference,
    payloadHash: await sha256Hex(input.rawBody),
    signatureStatus: input.signatureStatus,
    captureStatus: 'REJECTED',
    queueStatus: 'NOT_REQUESTED',
    traceId: input.eventId,
    headers: input.headers,
    receivedAt: new Date().toISOString()
  }).catch(() => undefined);
}

/**
 * The sole production Yoco webhook business ingress.
 * It verifies the provider signature, stores an immutable V2 raw event, publishes identifier-only queue work,
 * and schedules idempotent background processing in the workspace Durable Object. The queue remains the durable
 * retry lane, so a queue trigger/configuration delay cannot silently block live stock and reporting effects.
 */
export async function handleYocoV2WebhookIngress(
  request: Request,
  env: YocoV2QueueEnv,
  auth: AuthContext,
  workspaceId: string
): Promise<Response> {
  if (request.method !== 'POST' || auth.uid !== 'yoco-webhook') {
    return response({ ok: false, error: 'Invalid Yoco webhook ingress route.' }, 403);
  }

  const rawBody = await request.text();
  let payload: Row;
  try {
    payload = rawBody.trim() ? JSON.parse(rawBody) as Row : {};
  } catch {
    return response({ ok: false, error: 'Yoco webhook payload was not valid JSON.' }, 400);
  }
  const fields = eventFields(payload, request.headers);
  const connection = await env.DB.prepare(
    `SELECT webhook_secret, webhook_previous_secret, webhook_previous_until
       FROM yoco_connections WHERE workspace_id = ?1 LIMIT 1`
  ).bind(workspaceId).first<Row>();
  const secrets = activeWebhookSecrets(connection || null);
  if (!secrets.length) {
    await recordRejectedReceipt(env, {
      workspaceId,
      eventId: fields.eventId,
      eventType: fields.eventType,
      sourceReference: fields.sourceReference,
      rawBody,
      headers: request.headers,
      signatureStatus: 'SECRET_MISSING'
    });
    return response({ ok: false, error: 'Yoco webhook secret is not configured for this workspace.' }, 401);
  }

  const signatureValid = await verifyYocoV2WebhookSignature(rawBody, request.headers, secrets);
  if (!signatureValid) {
    await recordRejectedReceipt(env, {
      workspaceId,
      eventId: fields.eventId,
      eventType: fields.eventType,
      sourceReference: fields.sourceReference,
      rawBody,
      headers: request.headers,
      signatureStatus: 'INVALID'
    });
    await env.DB.prepare(
      `UPDATE yoco_connections
          SET last_error = ?2, updated_at = ?3
        WHERE workspace_id = ?1`
    ).bind(workspaceId, 'Yoco webhook signature could not be verified.', new Date().toISOString()).run().catch(() => undefined);
    return response({ ok: false, error: 'Yoco webhook signature could not be verified.' }, 401);
  }

  try {
    // The legacy Yoco writer has been removed. Workspaces connected before the
    // V2-only release may still carry historic LEGACY ownership rows, which
    // makes both live reporting and stock fail closed even though the webhook
    // is valid. A verified webhook is a safe, idempotent point to self-heal
    // those existing connections without requiring users to disconnect and
    // reconnect Yoco. Existing V2 ownership and deliberate pause controls are
    // left unchanged.
    await migrateYocoV2EffectOwnershipForConnection(
      env.DB,
      workspaceId,
      `yoco:${workspaceId}`,
      'yoco-v2-verified-webhook',
    );

    const captured = await captureVerifiedYocoV2Event(env, {
      workspaceId,
      integrationId: `yoco:${workspaceId}`,
      rawBody,
      payload,
      headers: request.headers,
      eventType: fields.eventType,
      yocoEventId: fields.eventId,
      signatureValid: true,
      receivedAt: new Date().toISOString(),
      liveEffects: true
    });
    if (!captured.captured) {
      return response({
        ok: false,
        error: 'YOCO_V2_CAPTURE_DISABLED',
        message: 'The V2 webhook capture path is not enabled for this workspace.',
        workerRelease: KCP_WORKER_RELEASE
      }, 503);
    }
    // A verified, captured event proves the webhook secret is healthy. Clear any stale
    // signature/webhook error so the integration status self-heals without a manual reconnect.
    await env.DB.prepare(
      `UPDATE yoco_connections
          SET last_error = '', updated_at = ?2
        WHERE workspace_id = ?1 AND COALESCE(last_error, '') <> ''`
    ).bind(workspaceId, new Date().toISOString()).run().catch(() => undefined);
    const immediateProcessingScheduled = Boolean(captured.rawEventId) && scheduleImmediateYocoV2Processing(
      env.YOCO_V2_WAIT_UNTIL,
      {
        raw_event_id: String(captured.rawEventId),
        workspace_id: workspaceId,
        integration_id: `yoco:${workspaceId}`,
        event_type: fields.eventType,
        trace_id: String(captured.traceId || fields.eventId),
        live_effects: true
      },
      (message) => processYocoV2QueueMessage(env, message)
    );
    return response({
      ok: true,
      status: captured.duplicate ? 'duplicate' : captured.queued ? 'queued' : 'captured',
      engine: 'V2',
      rawEventId: captured.rawEventId,
      traceId: captured.traceId,
      immediateProcessingScheduled,
      workerRelease: KCP_WORKER_RELEASE
    }, captured.queued || captured.duplicate ? 200 : 202);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return response({
      ok: false,
      error: 'YOCO_V2_CAPTURE_OR_QUEUE_FAILED',
      message,
      retryable: true,
      workerRelease: KCP_WORKER_RELEASE
    }, 503);
  }
}
