import { hmacSha256Base64, timingSafeEqual } from '../../legacy/crypto';

function text(value: unknown, fallback = ''): string {
  return String(value ?? fallback).trim();
}

function signatureValues(header: string): string[] {
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

function base64SecretBytes(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Normalise a stored signing secret to the Standard Webhooks `whsec_<base64>` form.
 *
 * Verification below fails closed on any secret without the prefix — it cannot know how to decode
 * one — so a secret stored without it makes every delivery unverifiable. Yoco does not always
 * include the prefix on the value it returns, which is what left the integration permanently
 * reporting "signature cannot be verified".
 *
 * Only a value that actually looks like the bare base64 body is prefixed. Anything else is returned
 * untouched so it still fails closed and stays visible as a misconfiguration, rather than being
 * reshaped into a plausible-looking secret that would fail in a more confusing way.
 */
export function normalizeStandardWebhookSecret(secret: unknown): string {
  const value = text(secret);
  if (!value || value.startsWith('whsec_')) return value;
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) ? `whsec_${value}` : value;
}

// Intentionally strict: the verifier itself only accepts an explicitly prefixed secret, so a
// malformed one fails closed here rather than being guessed at during verification. Callers
// normalise with normalizeStandardWebhookSecret when they load a secret from storage.
function standardWebhookSecret(secret: string): Uint8Array | null {
  const value = text(secret);
  if (!value.startsWith('whsec_')) return null;
  return base64SecretBytes(value.slice('whsec_'.length));
}

function uniqueSecrets(secrets: string | string[]): string[] {
  return (Array.isArray(secrets) ? secrets : [secrets])
    .map((secret) => text(secret))
    .filter((secret, index, list) => Boolean(secret) && list.indexOf(secret) === index);
}

function webhookTimestampIsFresh(value: string, toleranceSeconds = 3 * 60): boolean {
  const raw = text(value);
  if (!raw) return false;
  const numeric = Number(raw);
  const timestampMs = Number.isFinite(numeric)
    ? (numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : Date.parse(raw);
  if (!Number.isFinite(timestampMs)) return false;
  return Math.abs(Date.now() - timestampMs) <= toleranceSeconds * 1000;
}

/** Verify the Yoco Standard Webhooks v1 signature against the exact raw body. */
export async function verifyYocoV2WebhookSignature(
  rawBody: string,
  headers: Headers,
  webhookSecrets: string | string[]
): Promise<boolean> {
  const signatureHeader = text(headers.get('webhook-signature') || headers.get('svix-signature'));
  const webhookId = text(headers.get('webhook-id') || headers.get('svix-id'));
  const webhookTimestamp = text(headers.get('webhook-timestamp') || headers.get('svix-timestamp'));
  const provided = signatureValues(signatureHeader);
  const secrets = uniqueSecrets(webhookSecrets);
  if (!signatureHeader || !provided.length || !secrets.length) return false;
  if (!webhookId || !webhookTimestamp || !webhookTimestampIsFresh(webhookTimestamp)) return false;

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  for (const secret of secrets) {
    const decodedSecret = standardWebhookSecret(secret);
    if (!decodedSecret) continue;
    const expected = await hmacSha256Base64(decodedSecret, signedContent);
    if (provided.some((signature) => timingSafeEqual(expected, signature))) return true;
  }
  return false;
}
