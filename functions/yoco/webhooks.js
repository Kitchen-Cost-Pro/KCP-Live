const crypto = require('crypto');
const { fetchOrder } = require('./client');
const { hashSignature, serverTimestampIso } = require('./utils');
const { processYocoOrder } = require('./sales');

async function handleYocoWebhook({ admin, db, req, res, getSecrets }) {
  const workspaceId = String(req.query.workspaceId || '').trim();
  if (!workspaceId) {
    res.status(400).json({ error: 'workspaceId is required' });
    return;
  }

  const dataPath = workspaceId === 'appData' || workspaceId === 'appData_legacy' || workspaceId === 'ROOT_WORKSPACE'
    ? 'appData'
    : `workspaces/${workspaceId}/data`;
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const signatureHeader = String(req.get('webhook-signature') || req.get('svix-signature') || '').trim();
  const webhookId = String(req.get('webhook-id') || req.get('svix-id') || '').trim();
  const webhookTimestamp = String(req.get('webhook-timestamp') || req.get('svix-timestamp') || '').trim();
  const secrets = await getSecrets(db, workspaceId);

  if (!verifyWebhookSignature(rawBody, signatureHeader, secrets.webhookSecret, {
    webhookId,
    webhookTimestamp
  })) {
    await recordWebhookEvent(admin, dataPath, {
      eventType: 'signature_failed',
      status: 'rejected',
      message: 'Invalid Yoco webhook signature.',
      webhookId,
      hasTimestamp: Boolean(webhookTimestamp),
      hasSignature: Boolean(signatureHeader)
    });
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  const payload = parsePayload(rawBody);
  const eventType = String(payload.event_type || '').trim();
  const orderId = String(payload.order_id || '').trim();
  const paymentId = String(payload.payment_id || '').trim();
  const eventKey = hashSignature(`yoco:webhook:${eventType}:${orderId}:${paymentId}`);

  const auditRef = admin.database().ref(`${dataPath}/integrations/yoco/webhookEvents/${eventKey}`);
  const existing = await auditRef.get();
  if (existing.exists() && existing.val()?.status === 'processed') {
    res.status(200).json({ status: 'duplicate' });
    return;
  }

  await auditRef.set({
    id: eventKey,
    eventType,
    orderId,
    paymentId,
    receivedAt: serverTimestampIso(),
    status: 'received'
  });

  try {
    if (!eventType || !orderId) {
      throw new Error('Yoco webhook payload is missing event_type or order_id.');
    }
    const order = await fetchOrder(secrets.apiKey, orderId);
    const refundEvent = eventType === 'payment.refunded';
    const result = await processYocoOrder(admin, dataPath, order, {
      mode: refundEvent ? 'refund' : 'sale',
      refund: refundEvent ? findRefund(order, paymentId) : null
    });
    await auditRef.update({
      status: 'processed',
      processedAt: serverTimestampIso(),
      result
    });
    await admin.database().ref(`${dataPath}/integrations/yoco/webhook`).update({
      lastReceivedAt: serverTimestampIso(),
      lastProcessedAt: serverTimestampIso()
    });
    res.status(200).json({ status: 'processed' });
  } catch (error) {
    await auditRef.update({
      status: 'failed',
      failedAt: serverTimestampIso(),
      message: error.message || 'Yoco webhook processing failed.'
    });
    await incrementWebhookFailure(admin, dataPath);
    res.status(500).json({ error: 'processing failed' });
  }
}

function verifyWebhookSignature(rawBody, signatureHeader, secret, headers = {}) {
  if (!signatureHeader || !secret) return false;
  const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const svixSignedContent = headers.webhookId && headers.webhookTimestamp
    ? `${headers.webhookId}.${headers.webhookTimestamp}.${bodyText}`
    : '';
  const candidates = new Set();
  getWebhookSigningKeys(secret).forEach((signingKey) => {
    [svixSignedContent, bodyText].filter(Boolean).forEach((content) => {
      const digestHex = crypto.createHmac('sha256', signingKey).update(content).digest('hex');
      const digestBase64 = crypto.createHmac('sha256', signingKey).update(content).digest('base64');
      candidates.add(digestHex);
      candidates.add(digestBase64);
      candidates.add(`sha256=${digestHex}`);
      candidates.add(`sha256=${digestBase64}`);
    });
  });
  const providedSignatures = parseSignatureHeader(signatureHeader);
  return [...providedSignatures].some((signature) => (
    [...candidates].some((candidate) => timingSafeEqual(candidate, signature))
  ));
}

function getWebhookSigningKeys(secret) {
  const value = String(secret || '').trim();
  const keys = [value];
  if (value.startsWith('whsec_')) {
    const afterPrefix = value.slice('whsec_'.length);
    const afterLastUnderscore = value.slice(value.lastIndexOf('_') + 1);
    keys.push(Buffer.from(afterPrefix, 'base64'));
    if (afterLastUnderscore !== afterPrefix) {
      keys.push(Buffer.from(afterLastUnderscore, 'base64'));
    }
  } else {
    try {
      keys.push(Buffer.from(value, 'base64'));
    } catch {
      // Keep the raw string key above when the value is not base64.
    }
  }
  return keys;
}

function parseSignatureHeader(signatureHeader) {
  return String(signatureHeader || '')
    .split(/\s+/)
    .flatMap((part) => {
      const trimmed = part.trim();
      if (!trimmed) return [];
      const commaIndex = trimmed.indexOf(',');
      return commaIndex >= 0 ? [trimmed.slice(commaIndex + 1), trimmed] : [trimmed];
    })
    .filter(Boolean);
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parsePayload(rawBody) {
  try {
    return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '{}'));
  } catch {
    return {};
  }
}

function findRefund(order = {}, paymentId = '') {
  const refunds = Array.isArray(order.refunds) ? order.refunds : Object.values(order.refunds || {});
  return refunds.find((refund) => String(refund.payment_id || '') === String(paymentId || '')) || refunds[0] || null;
}

async function recordWebhookEvent(admin, dataPath, event) {
  const key = event.id || hashSignature(`yoco:webhook:${event.eventType}:${Date.now()}`);
  await admin.database().ref(`${dataPath}/integrations/yoco/webhookEvents/${key}`).set({
    id: key,
    ...event,
    timestamp: serverTimestampIso()
  });
}

async function incrementWebhookFailure(admin, dataPath) {
  const ref = admin.database().ref(`${dataPath}/integrations/yoco/webhook`);
  await ref.transaction((current) => ({
    ...(current || {}),
    lastReceivedAt: serverTimestampIso(),
    failedCount: (Number(current?.failedCount || 0) || 0) + 1
  }));
}

module.exports = {
  handleYocoWebhook,
  verifyWebhookSignature
};
