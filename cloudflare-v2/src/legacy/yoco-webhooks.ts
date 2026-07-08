import { hmacSha256Base64, hmacSha256Hex, timingSafeEqual } from './crypto';

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

function signatureValues(header: string) {
  return text(header)
    .split(/[,\s]+/)
    .map((part) => {
      if (part.startsWith('sha256=')) return part.slice('sha256='.length);
      if (part.startsWith('v1=')) return part.slice('v1='.length);
      return part;
    })
    .map((part) => part.trim())
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

function secretCandidates(secret: string) {
  const value = text(secret);
  if (!value) return [];
  const candidates: Array<string | Uint8Array> = [value];
  if (value.startsWith('whsec_')) {
    const afterPrefix = value.slice('whsec_'.length);
    const afterLastUnderscore = value.slice(value.lastIndexOf('_') + 1);
    const decoded = base64SecretBytes(afterPrefix);
    if (decoded) candidates.unshift(decoded);
    candidates.push(afterPrefix);
    if (afterLastUnderscore !== afterPrefix) candidates.push(afterLastUnderscore);
  }
  return candidates.filter((candidate, index) => (
    typeof candidate !== 'string' || candidates.findIndex((entry) => entry === candidate) === index
  ));
}

export async function verifyYocoWebhook(rawBody: string, headers: Headers, webhookSecret: string) {
  const signatureHeader = text(headers.get('webhook-signature') || headers.get('svix-signature'));
  const webhookId = text(headers.get('webhook-id') || headers.get('svix-id'));
  const webhookTimestamp = text(headers.get('webhook-timestamp') || headers.get('svix-timestamp'));
  if (!signatureHeader || !webhookSecret) return false;

  const signedBodies = [
    webhookId && webhookTimestamp ? `${webhookId}.${webhookTimestamp}.${rawBody}` : '',
    rawBody
  ].filter(Boolean);
  const provided = signatureValues(signatureHeader);

  for (const secret of secretCandidates(webhookSecret)) {
    for (const body of signedBodies) {
      const base64 = await hmacSha256Base64(secret, body);
      const hex = await hmacSha256Hex(secret, body);
      const expected = [base64, hex, `sha256=${base64}`, `sha256=${hex}`];
      if (provided.some((sig) => expected.some((candidate) => timingSafeEqual(candidate, sig)))) {
        return true;
      }
    }
  }
  return false;
}

export function findRefund(order: Record<string, unknown>, paymentId: string) {
  const refunds = Array.isArray(order.refunds) ? order.refunds as Record<string, unknown>[] : [];
  return refunds.find((refund) => (
    text(refund.payment_id || refund.paymentId || refund.id) === paymentId
  )) || refunds[0] || null;
}
