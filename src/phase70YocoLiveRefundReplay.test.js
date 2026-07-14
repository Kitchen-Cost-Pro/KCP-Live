import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 70 creates Yoco subscriptions with the three explicit live stock events', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const createBlock = service.match(/async function createYocoWebhookWithFallback[\s\S]*?\n}\n\n\nfunction subscriptionEnabled/)?.[0] || '';

  assert.match(service, /const YOCO_WEBHOOK_EVENT_TYPES = \['order\.completed', 'order\.updated', 'payment\.refunded'\]/);
  assert.match(createBlock, /event_types: YOCO_WEBHOOK_EVENT_TYPES, name, notification_url: webhookUrl/);
  assert.doesNotMatch(createBlock, /\{ name, notification_url: webhookUrl \}/);
  assert.doesNotMatch(createBlock, /\{ name, url: webhookUrl \}/);
});

test('Phase 70 retries a refund from its exact payment and order webhook identifiers', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const retryBlock = service.match(/export async function retryPendingYocoRefundWebhooks[\s\S]*?\n}\n\nasync function updateWebhookSaleOutcome/)?.[0] || '';

  assert.match(retryBlock, /event\.status IN \('attention', 'failed'\)/);
  assert.match(retryBlock, /const fields = yocoWebhookEventFields\(payload\)/);
  assert.match(retryBlock, /payment = await fetchPayment\(env, apiKey, paymentId\)/);
  assert.match(retryBlock, /order = await fetchOrder\(env, apiKey, orderId\)/);
  assert.match(retryBlock, /const refunds = findRefunds\(order, paymentId, null\)/);
  assert.match(retryBlock, /await processYocoOrder\(env, workspaceId, order/);
  assert.match(retryBlock, /status = allIgnored \? 'ignored' : needsAttention \? 'attention' : 'processed'/);
});

test('Phase 70 always schedules refund replay even when webhook processing throws', () => {
  const workspace = read('cloudflare-v2/src/workspace-do.ts');

  assert.match(workspace, /try \{\s*return await dispatchWorkspaceRoute/);
  assert.match(workspace, /finally \{[\s\S]*resource === 'yoco-webhook'[\s\S]*scheduleRefundRetry/);
  assert.match(workspace, /await retryPendingYocoRefundWebhooks\(this\.legacyEnv\(\), workspaceId, \{ limit: 50 \}\)/);
});

test('Phase 70 does not bulk-mark unresolved refund webhook rows as processed', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const retryFailedBlock = service.match(/export async function retryFailedYocoOrders[\s\S]*$/)?.[0] || '';

  assert.match(retryFailedBlock, /const targetedRefundRetry = await retryPendingYocoRefundWebhooks/);
  assert.match(retryFailedBlock, /lower\(replace\(event_type, '_', '\.'\)\) NOT IN/);
  assert.match(retryFailedBlock, /'payment\.refunded'/);
  assert.match(retryFailedBlock, /targetedRefundRetry/);
});
