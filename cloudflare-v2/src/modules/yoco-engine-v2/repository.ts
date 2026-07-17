import type { DbLike } from '../../legacy/types';
import type { YocoV2CaptureInput, YocoV2ProcessingStatus } from './contracts';
import {
  createTraceId,
  deterministicYocoV2EventKey,
  extractYocoV2EventId,
  extractYocoV2StableReferences,
  redactedWebhookHeaders,
  sha256Hex
} from './identity';

export type Row = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function changes(result: { meta?: Record<string, unknown> } | null | undefined): number {
  return Number(result?.meta?.changes || result?.meta?.rows_written || 0);
}

export async function insertRawYocoV2Event(db: DbLike, input: YocoV2CaptureInput) {
  const receivedAt = input.receivedAt || nowIso();
  const integrationId = String(input.integrationId || `yoco:${input.workspaceId}`);
  const yocoEventId = String(input.yocoEventId || extractYocoV2EventId(input.headers, input.payload));
  const payloadHash = await sha256Hex(input.rawBody);
  const eventType = String(input.eventType || input.payload.type || input.payload.event_type || input.payload.eventType || 'unknown');
  const eventKey = deterministicYocoV2EventKey({
    yocoEventId,
    eventType,
    payloadHash,
    stableReferences: extractYocoV2StableReferences(input.payload)
  });
  const traceId = createTraceId(input.headers);
  const rawEventId = newId('yoco_v2_raw');
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO yoco_v2_raw_events
      (id, workspace_id, integration_id, event_key, yoco_event_id, event_type,
       payload_json, payload_hash, signature_valid, received_at, source_ip, headers_json,
       capture_status, queue_status, processing_status, processing_attempts, trace_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, NULLIF(?5, ''), ?6, ?7, ?8, ?9, ?10, NULLIF(?11, ''), ?12,
       'CAPTURED', 'NOT_REQUESTED', 'RECEIVED', 0, ?13, ?10, ?10)`
  ).bind(
    rawEventId,
    input.workspaceId,
    integrationId,
    eventKey,
    yocoEventId,
    eventType,
    input.rawBody,
    payloadHash,
    input.signatureValid ? 1 : 0,
    receivedAt,
    input.headers.get('cf-connecting-ip') || input.headers.get('x-forwarded-for') || '',
    JSON.stringify(redactedWebhookHeaders(input.headers)),
    traceId
  ).run();

  const wasInserted = changes(inserted) > 0;
  const row = wasInserted
    ? await db.prepare(`SELECT * FROM yoco_v2_raw_events WHERE id = ?1 LIMIT 1`).bind(rawEventId).first<Row>()
    : await db.prepare(
      `SELECT * FROM yoco_v2_raw_events
        WHERE workspace_id = ?1 AND integration_id = ?2 AND event_key = ?3
        LIMIT 1`
    ).bind(input.workspaceId, integrationId, eventKey).first<Row>();

  if (!row) throw new Error('V2 raw event insert could not be confirmed.');
  if (!wasInserted) {
    await db.prepare(
      `UPDATE yoco_v2_raw_events
          SET duplicate_receipts = duplicate_receipts + 1,
              last_duplicate_at = ?2,
              updated_at = ?2
        WHERE id = ?1`
    ).bind(String(row.id), nowIso()).run();
  }
  return { row, wasInserted };
}

export async function markRawEventQueued(db: DbLike, rawEventId: string): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `UPDATE yoco_v2_raw_events
        SET queue_status = 'PUBLISHED', processing_status = 'QUEUED', updated_at = ?2,
            last_error_code = NULL, last_error_message = NULL
      WHERE id = ?1`
  ).bind(rawEventId, now).run();
}

export async function markRawEventQueueFailure(db: DbLike, rawEventId: string, code: string, message: string): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `UPDATE yoco_v2_raw_events
        SET queue_status = 'PUBLISH_FAILED', processing_status = 'WAITING',
            last_error_code = ?2, last_error_message = ?3, updated_at = ?4
      WHERE id = ?1`
  ).bind(rawEventId, code, message.slice(0, 2000), now).run();
}

export async function appendTimeline(db: DbLike, input: {
  rawEventId: string;
  processingRunId?: string;
  step: string;
  status: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.prepare(
    `INSERT INTO yoco_v2_processing_timeline
      (id, raw_event_id, processing_run_id, step, status, message, metadata_json, created_at)
     VALUES (?1, ?2, NULLIF(?3, ''), ?4, ?5, ?6, ?7, ?8)`
  ).bind(
    newId('yoco_v2_timeline'),
    input.rawEventId,
    input.processingRunId || '',
    input.step,
    input.status,
    input.message,
    JSON.stringify(input.metadata || {}),
    nowIso()
  ).run();
}

export async function acquireProcessingLock(db: DbLike, rawEventId: string, workspaceId: string) {
  const now = nowIso();
  const result = await db.prepare(
    `UPDATE yoco_v2_raw_events
        SET processing_status = 'PROCESSING',
            processing_attempts = processing_attempts + 1,
            next_attempt_at = NULL,
            updated_at = ?3
      WHERE id = ?1
        AND workspace_id = ?2
        AND signature_valid = 1
        AND (
          processing_status IN ('RECEIVED', 'QUEUED', 'RETRY_SCHEDULED', 'WAITING', 'MANUAL_REVIEW_REQUIRED')
          OR (processing_status = 'PROCESSING' AND datetime(updated_at) <= datetime(?3, '-10 minutes'))
        )`
  ).bind(rawEventId, workspaceId, now).run();
  if (changes(result) === 0) return null;
  return db.prepare(`SELECT * FROM yoco_v2_raw_events WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`)
    .bind(rawEventId, workspaceId).first<Row>();
}

export async function createProcessingRun(db: DbLike, rawEvent: Row): Promise<Row> {
  const runId = newId('yoco_v2_run');
  const now = nowIso();
  const attemptNumber = Number(rawEvent.processing_attempts || 1);
  await db.prepare(
    `INSERT OR IGNORE INTO yoco_v2_processing_runs
      (id, raw_event_id, workspace_id, integration_id, event_type, trace_id, status,
       current_step, attempt_number, started_at, error_details_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PROCESSING', 'LOCK_ACQUIRED', ?7, ?8, '{}', ?8, ?8)`
  ).bind(
    runId,
    String(rawEvent.id),
    String(rawEvent.workspace_id),
    String(rawEvent.integration_id),
    String(rawEvent.event_type),
    String(rawEvent.trace_id),
    attemptNumber,
    now
  ).run();
  const run = await db.prepare(
    `SELECT * FROM yoco_v2_processing_runs WHERE raw_event_id = ?1 AND attempt_number = ?2 LIMIT 1`
  ).bind(String(rawEvent.id), attemptNumber).first<Row>();
  if (!run) throw new Error('V2 processing run could not be created.');
  return run;
}

export async function updateRunAndRawEvent(db: DbLike, input: {
  rawEventId: string;
  processingRunId: string;
  status: YocoV2ProcessingStatus;
  currentStep: string;
  completedAt?: string | null;
  nextRetryAt?: string | null;
  errorCategory?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorDetails?: Record<string, unknown>;
}): Promise<void> {
  const now = nowIso();
  await db.batch([
    db.prepare(
      `UPDATE yoco_v2_processing_runs
          SET status = ?2, current_step = ?3, completed_at = ?4, next_retry_at = ?5,
              error_category = ?6, error_code = ?7, error_message = ?8,
              error_details_json = ?9, updated_at = ?10
        WHERE id = ?1`
    ).bind(
      input.processingRunId,
      input.status,
      input.currentStep,
      input.completedAt || null,
      input.nextRetryAt || null,
      input.errorCategory || null,
      input.errorCode || null,
      input.errorMessage ? input.errorMessage.slice(0, 2000) : null,
      JSON.stringify(input.errorDetails || {}),
      now
    ),
    db.prepare(
      `UPDATE yoco_v2_raw_events
          SET processing_status = ?2, next_attempt_at = ?3,
              last_error_code = ?4, last_error_message = ?5,
              completed_at = ?6, updated_at = ?7
        WHERE id = ?1`
    ).bind(
      input.rawEventId,
      input.status,
      input.nextRetryAt || null,
      input.errorCode || null,
      input.errorMessage ? input.errorMessage.slice(0, 2000) : null,
      input.completedAt || null,
      now
    )
  ]);
}
