import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomBytes } from 'node:crypto';
import { verifyYocoV2WebhookSignature } from '../src/modules/yoco-engine-v2/webhook-signature';

// Independently reproduce the Yoco / Standard Webhooks (Svix) signing scheme so this is a
// true round-trip against the verifier: signature = base64(HMAC-SHA256(rawKey, `id.ts.body`)),
// with the shared secret encoded as `whsec_<base64(rawKey)>`.
function buildSignedWebhook(input: {
  body: string;
  webhookId: string;
  timestampSeconds: number;
  rawKey: Buffer;
  scheme?: string;
}) {
  const secret = `whsec_${input.rawKey.toString('base64')}`;
  const signedContent = `${input.webhookId}.${input.timestampSeconds}.${input.body}`;
  const signature = createHmac('sha256', input.rawKey).update(signedContent).digest('base64');
  const headers = new Headers({
    'content-type': 'application/json',
    'webhook-id': input.webhookId,
    'webhook-timestamp': String(input.timestampSeconds),
    'webhook-signature': `${input.scheme ?? 'v1'},${signature}`,
  });
  return { secret, headers, signature };
}

function freshTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

test('accepts a correctly signed Yoco Standard Webhooks payload', async () => {
  const rawKey = randomBytes(24);
  const body = JSON.stringify({ type: 'order.completed', payload: { id: 'order_123' } });
  const { secret, headers } = buildSignedWebhook({
    body,
    webhookId: 'msg_2abc',
    timestampSeconds: freshTimestamp(),
    rawKey,
  });

  assert.equal(await verifyYocoV2WebhookSignature(body, headers, secret), true);
});

test('accepts when the correct secret is one of several candidates (rotation grace)', async () => {
  const rawKey = randomBytes(24);
  const body = JSON.stringify({ type: 'payment.refunded', payload: { id: 'ref_9' } });
  const { secret, headers } = buildSignedWebhook({
    body,
    webhookId: 'msg_rot',
    timestampSeconds: freshTimestamp(),
    rawKey,
  });
  const staleSecret = `whsec_${randomBytes(24).toString('base64')}`;

  assert.equal(await verifyYocoV2WebhookSignature(body, headers, [staleSecret, secret]), true);
});

test('accepts a space-separated multi-signature header', async () => {
  const rawKey = randomBytes(24);
  const body = JSON.stringify({ type: 'order.updated' });
  const { secret, headers, signature } = buildSignedWebhook({
    body,
    webhookId: 'msg_multi',
    timestampSeconds: freshTimestamp(),
    rawKey,
  });
  // A bogus v1 signature preceding the valid one must not prevent verification.
  headers.set('webhook-signature', `v1,AAAAINVALIDsignatureBASE64== v1,${signature}`);

  assert.equal(await verifyYocoV2WebhookSignature(body, headers, secret), true);
});

test('rejects a signature produced by a different secret', async () => {
  const body = JSON.stringify({ type: 'order.completed' });
  const { headers } = buildSignedWebhook({
    body,
    webhookId: 'msg_bad',
    timestampSeconds: freshTimestamp(),
    rawKey: randomBytes(24),
  });
  const wrongSecret = `whsec_${randomBytes(24).toString('base64')}`;

  assert.equal(await verifyYocoV2WebhookSignature(body, headers, wrongSecret), false);
});

test('rejects a stale timestamp outside the freshness tolerance', async () => {
  const rawKey = randomBytes(24);
  const body = JSON.stringify({ type: 'order.completed' });
  const { secret, headers } = buildSignedWebhook({
    body,
    webhookId: 'msg_stale',
    timestampSeconds: freshTimestamp() - 10 * 60, // 10 minutes old > 3 minute tolerance
    rawKey,
  });

  assert.equal(await verifyYocoV2WebhookSignature(body, headers, secret), false);
});

test('rejects a stored secret missing the whsec_ prefix (the observed misconfiguration)', async () => {
  const rawKey = randomBytes(24);
  const body = JSON.stringify({ type: 'order.completed' });
  const { secret, headers } = buildSignedWebhook({
    body,
    webhookId: 'msg_noprefix',
    timestampSeconds: freshTimestamp(),
    rawKey,
  });
  const withoutPrefix = secret.slice('whsec_'.length);

  assert.equal(await verifyYocoV2WebhookSignature(body, headers, withoutPrefix), false);
});

test('rejects when signature/id/timestamp headers are absent', async () => {
  const rawKey = randomBytes(24);
  const body = JSON.stringify({ type: 'order.completed' });
  const secret = `whsec_${rawKey.toString('base64')}`;

  assert.equal(await verifyYocoV2WebhookSignature(body, new Headers(), secret), false);
});
