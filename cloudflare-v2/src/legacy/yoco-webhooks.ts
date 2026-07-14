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

export function findRefund(order: Record<string, unknown>, paymentId: string) {
  const refunds = Array.isArray(order.refunds) ? order.refunds as Record<string, unknown>[] : [];
  return refunds.find((refund) => (
    text(refund.payment_id || refund.paymentId || refund.id) === paymentId
  )) || refunds[0] || null;
}
