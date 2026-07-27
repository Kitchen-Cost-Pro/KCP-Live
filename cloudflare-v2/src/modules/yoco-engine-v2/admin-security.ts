import type { DbLike } from '../../legacy/types';
import { newId, nowIso } from './repository';

const SENSITIVE_KEY = /(authorization|api[-_]?key|secret|token|password|credential|signature|cookie|set-cookie|client_secret|access_token|refresh_token)/i;
const SAFE_HEADER_NAMES = new Set([
  'content-type',
  'user-agent',
  'webhook-id',
  'webhook-timestamp',
  'svix-id',
  'svix-timestamp',
  'x-yoco-event-type',
  'x-request-id',
  'cf-ray',
  'cf-connecting-ip'
]);

export function redactSensitiveValue(value: unknown, keyHint = ''): unknown {
  if (SENSITIVE_KEY.test(keyHint)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, keyHint));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitiveValue(child, key);
    }
    return out;
  }
  return value;
}

export function redactStoredJson(value: unknown): unknown {
  if (value == null || value === '') return value;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return redactSensitiveValue(parsed);
  } catch {
    return '[UNPARSEABLE_REDACTED_VALUE]';
  }
}

export function redactedHeaders(headers: Headers | Record<string, unknown> | null | undefined): Record<string, string> {
  const source: Array<[string, string]> = [];
  if (headers instanceof Headers) headers.forEach((value, key) => source.push([key, value]));
  else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) source.push([key, String(value ?? '')]);
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of source) {
    const key = rawKey.toLowerCase();
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (!SAFE_HEADER_NAMES.has(key)) continue;
    out[key] = key === 'cf-connecting-ip' ? '[REDACTED_IP]' : rawValue.slice(0, 500);
  }
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface YocoV2ReceiptInput {
  workspaceId: string;
  integrationId?: string;
  rawEventId?: string | null;
  yocoEventId?: string | null;
  eventType?: string | null;
  sourceReference?: string | null;
  payloadHash: string;
  signatureStatus: 'VALID' | 'INVALID' | 'SECRET_MISSING';
  captureStatus: 'CAPTURED' | 'CAPTURE_DISABLED' | 'REJECTED' | 'FAILED';
  queueStatus?: string;
  duplicateIdentity?: string | null;
  traceId?: string | null;
  headers?: Headers | Record<string, unknown> | null;
  receivedAt?: string;
}

export async function recordYocoV2WebhookReceipt(db: DbLike, input: YocoV2ReceiptInput): Promise<string> {
  const receiptId = newId('yoco_v2_receipt');
  const createdAt = nowIso();
  await db.prepare(
    `INSERT INTO yoco_v2_webhook_receipts
      (id, workspace_id, integration_id, raw_event_id, yoco_event_id, event_type,
       source_reference, payload_hash, signature_status, capture_status, queue_status,
       duplicate_identity, trace_id, redacted_headers_json, received_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
  ).bind(
    receiptId,
    input.workspaceId,
    input.integrationId || `yoco:${input.workspaceId}`,
    input.rawEventId || null,
    input.yocoEventId || null,
    input.eventType || 'unknown',
    input.sourceReference || null,
    input.payloadHash,
    input.signatureStatus,
    input.captureStatus,
    input.queueStatus || 'NOT_REQUESTED',
    input.duplicateIdentity || null,
    input.traceId || `yoco-v2-receipt-${crypto.randomUUID()}`,
    JSON.stringify(redactedHeaders(input.headers)),
    input.receivedAt || createdAt,
    createdAt
  ).run();
  return receiptId;
}
