import { hmacSha256Base64, timingSafeEqual } from './crypto';

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function signatureValues(header: string) {
  const raw = text(header);
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const commaIndex = entry.indexOf(',');
      const value = commaIndex >= 0 ? entry.slice(commaIndex + 1) : entry;
      return value.replace(/^(?:sha256=|v1=)/i, '').trim();
    })
    .filter(Boolean);
}

function base64SecretBytes(value: string) {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function standardWebhookSecret(secret: string) {
  const value = text(secret);
  if (!value) return null;
  if (!value.startsWith('whsec_')) return null;
  return base64SecretBytes(value.slice('whsec_'.length));
}

function uniqueSecrets(secrets: string | string[]) {
  return (Array.isArray(secrets) ? secrets : [secrets])
    .map((secret) => text(secret))
    .filter((secret, index, list) => Boolean(secret) && list.indexOf(secret) === index);
}

function webhookTimestampIsFresh(value: string, toleranceSeconds = 3 * 60) {
  const raw = text(value);
  if (!raw) return false;
  const numeric = Number(raw);
  const timestampMs = Number.isFinite(numeric)
    ? (numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : Date.parse(raw);
  if (!Number.isFinite(timestampMs)) return false;
  return Math.abs(Date.now() - timestampMs) <= toleranceSeconds * 1000;
}

export async function verifyYocoWebhook(rawBody: string, headers: Headers, webhookSecrets: string | string[]) {
  const signatureHeader = text(headers.get('webhook-signature') || headers.get('svix-signature'));
  const webhookId = text(headers.get('webhook-id') || headers.get('svix-id'));
  const webhookTimestamp = text(headers.get('webhook-timestamp') || headers.get('svix-timestamp'));
  const provided = signatureValues(signatureHeader);
  const secrets = uniqueSecrets(webhookSecrets);
  if (!signatureHeader || !provided.length || !secrets.length) return false;
  if (!webhookId || !webhookTimestamp || !webhookTimestampIsFresh(webhookTimestamp)) return false;

  // Yoco documents the Standard Webhooks v1 format: signed content is
  // webhook-id + '.' + webhook-timestamp + '.' + the raw request body, and the
  // whsec_ prefix is removed before base64-decoding the HMAC key.
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  for (const secret of secrets) {
    const decodedSecret = standardWebhookSecret(secret);
    if (!decodedSecret) continue;
    const expected = await hmacSha256Base64(decodedSecret, signedContent);
    if (provided.some((signature) => timingSafeEqual(expected, signature))) return true;
  }
  return false;
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function refundId(refund: Record<string, unknown>) {
  return text(
    refund.id ||
    refund.refund_id ||
    refund.refundId ||
    refund.transaction_id ||
    refund.transactionId
  );
}

function objectArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) as Record<string, unknown>[]
    : [];
}

function refundStatusIsFinal(refund: Record<string, unknown>) {
  const status = text(refund.status).toLowerCase();
  if (!status) return true;
  return ['approved', 'complete', 'completed', 'refunded', 'succeeded', 'successful', 'success'].includes(status);
}

function timestampMs(value: Record<string, unknown>) {
  const raw = text(
    value.processed_at ||
    value.processedAt ||
    value.updated_at ||
    value.updatedAt ||
    value.created_at ||
    value.createdAt
  );
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function moneyMinor(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const amount = Number((value as Record<string, unknown>).amount);
    return Number.isFinite(amount) ? Math.round(Math.abs(amount)) : 0;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(Math.abs(numeric) * 100) : 0;
}

function refundAmountMinor(value: Record<string, unknown>) {
  const amounts = objectValue(value.amounts);
  const direct = [
    value.total_amount,
    value.totalAmount,
    value.refund_amount,
    value.refundAmount,
    value.amount,
    value.net_amount,
    value.netAmount,
    amounts.net_amount,
    amounts.netAmount,
    amounts.total_amount,
    amounts.totalAmount
  ];
  for (const candidate of direct) {
    const amount = moneyMinor(candidate);
    if (amount > 0) return amount;
  }
  return 0;
}

const RETURN_LINE_KEYS = [
  'returned_line_items',
  'returnedLineItems',
  'line_items',
  'lineItems',
  'items',
  'return_lines',
  'returnLines'
];

function returnLines(value: Record<string, unknown>) {
  for (const key of RETURN_LINE_KEYS) {
    const lines = objectArray(value[key]);
    if (lines.length) return lines;
  }
  return [];
}

function refundCandidates(order: Record<string, unknown>, webhookRefund: Record<string, unknown> | null) {
  const candidates: Record<string, unknown>[] = [];
  if (webhookRefund) candidates.push(webhookRefund);
  candidates.push(...objectArray(order.refunds));
  for (const payment of objectArray(order.payments)) {
    const paymentId = text(payment.id || payment.payment_id || payment.paymentId);
    for (const refund of objectArray(payment.refunds)) {
      candidates.push(paymentId && !text(refund.payment_id || refund.paymentId)
        ? { ...refund, payment_id: paymentId }
        : refund);
    }
  }
  const byKey = new Map<string, Record<string, unknown>>();
  candidates.forEach((candidate, index) => {
    const key = refundId(candidate) || `${text(candidate.payment_id || candidate.paymentId)}:${timestampMs(candidate)}:${refundAmountMinor(candidate)}:${index}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? { ...existing, ...candidate } : candidate);
  });
  return [...byKey.values()];
}

function returnReferenceValues(value: Record<string, unknown>) {
  const metadata = objectValue(value.metadata);
  return [
    value.refund_id,
    value.refundId,
    value.payment_id,
    value.paymentId,
    value.source_refund_id,
    value.sourceRefundId,
    metadata.refund_id,
    metadata.refundId,
    metadata.payment_id,
    metadata.paymentId
  ].map((entry) => text(entry)).filter(Boolean);
}

function mergeRefundAndReturn(refund: Record<string, unknown>, returned: Record<string, unknown> | null) {
  if (!returned) return refund;
  const lines = returnLines(returned);
  return {
    ...returned,
    ...refund,
    returned_line_items: lines.length ? lines : refund.returned_line_items,
    return_id: text(returned.id || returned.return_id || returned.returnId) || undefined,
    return_reason: refund.return_reason || refund.returnReason || returned.return_reason || returned.returnReason || returned.reason,
    return_note: refund.return_note || refund.returnNote || returned.return_note || returned.returnNote || returned.note,
    kcpMatchedReturn: returned
  };
}

function pairRefundsWithReturns(order: Record<string, unknown>, refunds: Record<string, unknown>[]) {
  const returns = objectArray(order.returns).filter((entry) => returnLines(entry).length > 0);
  if (!returns.length || !refunds.length) return refunds;
  const sortedReturns = [...returns].sort((left, right) => timestampMs(left) - timestampMs(right));
  const used = new Set<number>();
  return refunds.map((refund, refundIndex) => {
    const refundRefs = new Set([refundId(refund), text(refund.payment_id || refund.paymentId)].filter(Boolean));
    let selected = sortedReturns.findIndex((entry, index) => !used.has(index)
      && returnReferenceValues(entry).some((value) => refundRefs.has(value)));

    if (selected < 0) {
      const amount = refundAmountMinor(refund);
      const amountMatches = sortedReturns
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry, index }) => !used.has(index) && amount > 0 && refundAmountMinor(entry) === amount);
      if (amountMatches.length === 1) selected = amountMatches[0].index;
      else if (amountMatches.length > 1) {
        const refundTime = timestampMs(refund);
        amountMatches.sort((a, b) => Math.abs(timestampMs(a.entry) - refundTime) - Math.abs(timestampMs(b.entry) - refundTime));
        const firstDistance = Math.abs(timestampMs(amountMatches[0].entry) - refundTime);
        const secondDistance = Math.abs(timestampMs(amountMatches[1].entry) - refundTime);
        if (firstDistance < secondDistance) selected = amountMatches[0].index;
      }
    }

    // Never pair multiple partial refunds and returns by array position. Yoco can
    // expose those collections in different orders, and positional matching can
    // restore the wrong product. A single unambiguous refund/return pair is safe;
    // otherwise wait for an id, payment reference, unique amount, or timestamp match.
    if (selected < 0 && sortedReturns.length === 1 && refunds.length === 1) selected = 0;
    if (selected >= 0) used.add(selected);
    return mergeRefundAndReturn(refund, selected >= 0 ? sortedReturns[selected] : null);
  });
}

export function extractYocoRefund(payload: Record<string, unknown>) {
  const envelope = objectValue(payload.payload);
  const data = objectValue(payload.data);
  const envelopeData = objectValue(envelope.data);
  const candidates = [
    objectValue(payload.refund),
    objectValue(envelope.refund),
    objectValue(data.refund),
    objectValue(envelopeData.refund),
    envelope,
    data
  ];
  return candidates.find((candidate) => Boolean(
    refundId(candidate) ||
    candidate.refund_amount ||
    candidate.refundAmount ||
    candidate.total_amount ||
    candidate.totalAmount
  )) || null;
}

export function findRefunds(
  order: Record<string, unknown>,
  paymentId: string,
  webhookRefund: Record<string, unknown> | null = null
) {
  const wantedPaymentId = text(paymentId);
  const wantedRefundId = webhookRefund ? refundId(webhookRefund) : '';
  const matches = refundCandidates(order, webhookRefund)
    .filter(refundStatusIsFinal)
    .filter((refund) => {
      const currentId = refundId(refund);
      const currentPaymentId = text(refund.payment_id || refund.paymentId);
      if (wantedRefundId && currentId === wantedRefundId) return true;
      if (wantedPaymentId && currentPaymentId === wantedPaymentId) return true;
      return !wantedRefundId && !wantedPaymentId;
    })
    .sort((left, right) => timestampMs(left) - timestampMs(right));
  return pairRefundsWithReturns(order, matches);
}

export function findRefund(
  order: Record<string, unknown>,
  paymentId: string,
  webhookRefund: Record<string, unknown> | null = null
) {
  const refunds = findRefunds(order, paymentId, webhookRefund);
  return refunds.length ? refunds[refunds.length - 1] : null;
}
