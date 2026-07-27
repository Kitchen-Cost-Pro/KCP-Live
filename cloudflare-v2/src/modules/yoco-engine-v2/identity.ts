function text(value: unknown): string {
  return String(value ?? '').trim();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function extractYocoV2EventId(headers: Headers, payload: Record<string, unknown>): string {
  const envelope = objectValue(payload.payload);
  const data = objectValue(payload.data);
  return text(
    headers.get('webhook-id') ||
    headers.get('svix-id') ||
    headers.get('x-yoco-event-id') ||
    payload.id ||
    payload.event_id ||
    payload.eventId ||
    envelope.id ||
    envelope.event_id ||
    envelope.eventId ||
    data.event_id ||
    data.eventId
  );
}

export function extractYocoV2StableReferences(payload: Record<string, unknown>): string[] {
  const envelope = objectValue(payload.payload);
  const data = objectValue(payload.data);
  const envelopeData = objectValue(envelope.data);
  const order = objectValue(payload.order || envelope.order || data.order || envelopeData.order);
  const payment = objectValue(payload.payment || envelope.payment || data.payment || envelopeData.payment);
  const refund = objectValue(payload.refund || envelope.refund || data.refund || envelopeData.refund);
  return [
    order.id,
    order.order_id,
    order.orderId,
    payment.id,
    payment.payment_id,
    payment.paymentId,
    refund.id,
    refund.refund_id,
    refund.refundId
  ].map(text).filter(Boolean);
}

export function deterministicYocoV2EventKey(input: {
  yocoEventId?: string;
  eventType?: string;
  payloadHash: string;
  stableReferences?: string[];
}): string {
  const explicit = text(input.yocoEventId);
  if (explicit) return `yoco-event:${explicit}`;
  const eventType = text(input.eventType).toLowerCase() || 'unknown';
  const references = [...new Set((input.stableReferences || []).map(text).filter(Boolean))].sort().join(':');
  return `yoco-derived:${eventType}:${references || 'no-reference'}:${text(input.payloadHash)}`;
}

const SECRET_HEADER_PATTERN = /(authorization|cookie|secret|token|api[-_]?key|signature)/i;
const SAFE_HEADER_NAMES = new Set([
  'content-type',
  'content-length',
  'user-agent',
  'webhook-id',
  'svix-id',
  'webhook-timestamp',
  'svix-timestamp',
  'x-yoco-event-id',
  'x-yoco-event-type',
  'cf-ray',
  'cf-connecting-ip',
  'x-forwarded-for',
  'traceparent',
  'x-request-id'
]);

export function redactedWebhookHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (!SAFE_HEADER_NAMES.has(normalized) && !SECRET_HEADER_PATTERN.test(normalized)) return;
    result[normalized] = SECRET_HEADER_PATTERN.test(normalized) ? '[REDACTED]' : value;
  });
  return result;
}

export function createTraceId(headers?: Headers): string {
  const existing = text(headers?.get('x-kcp-trace-id') || headers?.get('x-request-id'));
  return existing || `yoco-v2-trace-${crypto.randomUUID()}`;
}
