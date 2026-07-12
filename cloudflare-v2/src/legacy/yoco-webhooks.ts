import { hmacSha256Base64, hmacSha256Hex, timingSafeEqual } from './crypto';

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

function fallbackSecretCandidates(secret: string) {
  const value = text(secret);
  if (!value) return [];
  const candidates: Array<string | Uint8Array> = [value];
  if (value.startsWith('whsec_')) {
    const afterPrefix = value.slice('whsec_'.length);
    const decoded = base64SecretBytes(afterPrefix);
    if (decoded) candidates.unshift(decoded);
    candidates.push(afterPrefix);
  }
  return candidates.filter((candidate, index) => (
    typeof candidate !== 'string' || candidates.findIndex((entry) => entry === candidate) === index
  ));
}

function uniqueSecrets(secrets: string | string[]) {
  return (Array.isArray(secrets) ? secrets : [secrets])
    .map((secret) => text(secret))
    .filter((secret, index, list) => Boolean(secret) && list.indexOf(secret) === index);
}

export async function verifyYocoWebhook(rawBody: string, headers: Headers, webhookSecrets: string | string[]) {
  const signatureHeader = text(headers.get('webhook-signature') || headers.get('svix-signature'));
  const webhookId = text(headers.get('webhook-id') || headers.get('svix-id'));
  const webhookTimestamp = text(headers.get('webhook-timestamp') || headers.get('svix-timestamp'));
  const provided = signatureValues(signatureHeader);
  const secrets = uniqueSecrets(webhookSecrets);
  if (!signatureHeader || !provided.length || !secrets.length) return false;

  // Yoco documents the Standard Webhooks v1 format: signed content is
  // webhook-id + '.' + webhook-timestamp + '.' + the raw request body, and the
  // whsec_ prefix is removed before base64-decoding the HMAC key.
  if (webhookId && webhookTimestamp) {
    const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
    for (const secret of secrets) {
      const decodedSecret = standardWebhookSecret(secret);
      if (!decodedSecret) continue;
      const expected = await hmacSha256Base64(decodedSecret, signedContent);
      if (provided.some((signature) => timingSafeEqual(expected, signature))) return true;
    }
  }

  // Compatibility fallback for older/staged tenants that may have saved a raw
  // signing key or received an older non-standard signature header. Standard
  // Yoco deliveries are accepted by the branch above.
  const fallbackBodies = [
    webhookId && webhookTimestamp ? `${webhookId}.${webhookTimestamp}.${rawBody}` : '',
    rawBody
  ].filter(Boolean);
  for (const secret of secrets) {
    for (const candidateSecret of fallbackSecretCandidates(secret)) {
      for (const body of fallbackBodies) {
        const base64 = await hmacSha256Base64(candidateSecret, body);
        const hex = await hmacSha256Hex(candidateSecret, body);
        if (provided.some((sig) => timingSafeEqual(base64, sig) || timingSafeEqual(hex, sig))) {
          return true;
        }
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
