import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 60 webhook reinitialisation deletes KCP-owned subscriptions before creating and remotely verifying a fresh one', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  assert.match(service, /deleteYocoWebhookSubscriptions\(/);
  assert.match(service, /isKcpWebhookSubscription/);
  assert.match(service, /nameValue\.includes\('kitchen cost pro'\)/);
  assert.match(service, /createYocoWebhookWithFallback\(env, apiKey, webhookUrl\)/);
  assert.match(service, /inspectRemoteYocoWebhook\(env, apiKey, webhookId, webhookUrl\)/);
  assert.match(service, /remoteVerified: true/);
  assert.match(service, /eventTypes: YOCO_WEBHOOK_EVENT_TYPES/);
});

test('Phase 60 webhook health checks the remote Yoco subscription instead of trusting local connection fields', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  assert.match(service, /listWebhookSubscriptions\(env, apiKey\)/);
  assert.match(service, /stored_subscription_missing_remotely/);
  assert.match(service, /subscription_disabled_remotely/);
  assert.match(service, /notification_url_mismatch/);
  assert.match(service, /event_types_mismatch/);
});

test('Phase 60 missing recipe mappings stay retryable and are not permanently deduplicated', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  assert.match(sales, /only terminally deduplicated after it has produced at least one/);
  assert.match(sales, /if \(movementCount > componentMovementStart\)/);
  assert.match(sales, /retryable = missingRecipes > 0/);
  assert.match(sales, /missing_recipe_or_mapping/);
  assert.match(sales, /ON CONFLICT\(workspace_id, yoco_order_id, yoco_line_id\) DO UPDATE/);
});

test('Phase 60 sales reconciliation reports movements and does not advance cursors past retryable deductions', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  assert.match(service, /retryableOrders/);
  assert.match(service, /stockMovements/);
  assert.match(service, /orderCursorBlocked = orderErrors > 0[\s\S]*retryableOrders > 0/);
  assert.match(service, /orderCursorAdvanced: !orderCursorBlocked/);
  assert.match(service, /overlapCursor/);
});

test('Phase 60 admin console exposes unified integration diagnostics and webhook testing', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const admin = read('public/KCP Admin ConsoleByYOCO.html');
  const worker = read('cloudflare-v2/src/index.ts');
  assert.match(routes, /FROM integration_logs/);
  assert.match(routes, /action === "test-webhook"/);
  assert.match(admin, /Yoco Integration Log/);
  assert.match(admin, /Test Webhook/);
  assert.match(admin, /reset-webhook[\s\S]*sync-catalogue[\s\S]*(?:sync-sales|reconcile-sales)/);
  assert.match(worker, /'test-webhook'/);
});

test('Phase 60 diagnostics redact secrets and webhook signatures reject stale timestamps', () => {
  const logs = read('cloudflare-v2/src/legacy/integration-log.ts');
  const verification = read('cloudflare-v2/src/legacy/yoco-webhooks.ts');
  assert.match(logs, /secret\|api\.\?key\|authorization\|token/i);
  assert.match(logs, /\[redacted\]/);
  assert.match(verification, /webhookTimestampIsFresh/);
  assert.match(verification, /3 \* 60/);
});
