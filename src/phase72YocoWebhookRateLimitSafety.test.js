import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 72 identifies the rate-limit-safe Worker release', () => {
  const release = read('cloudflare-v2/src/release.ts');
  const admin = read('public/KCP Admin ConsoleByYOCO.html');
  const verify = read('scripts/verify-worker-release.mjs');

  assert.match(release, /phase72-yoco-webhook-rate-limit-safe/);
  assert.match(admin, /KCP_EXPECTED_WORKER_RELEASE = 'phase72-yoco-webhook-rate-limit-safe'/);
  assert.match(verify, /phase72-yoco-webhook-rate-limit-safe/);
});

test('Phase 72 creates and stores the replacement webhook before scheduling stale cleanup', () => {
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const connectBlock = service.match(/export async function connectYoco[\s\S]*?\n}\n\nexport async function resetYocoWebhook/)?.[0] || '';
  const resetBlock = service.match(/export async function resetYocoWebhook[\s\S]*?\n}\n\nexport async function ensureYocoWebhook/)?.[0] || '';

  assert.match(connectBlock, /createYocoWebhookWithFallback/);
  assert.match(connectBlock, /planYocoWebhookCleanup/);
  assert.doesNotMatch(connectBlock, /await deleteYocoWebhookSubscriptions/);

  const resetCreate = resetBlock.indexOf('createYocoWebhookWithFallback');
  const resetStore = resetBlock.indexOf('UPDATE yoco_connections', resetCreate);
  const resetPlan = resetBlock.indexOf('planYocoWebhookCleanup', resetStore);
  assert.ok(resetCreate >= 0 && resetStore > resetCreate && resetPlan > resetStore, 'reset must store the new secret before scheduling cleanup');
  assert.match(resetBlock, /createBeforeCleanup: true/);
  assert.match(resetBlock, /webhookCleanupPending/);
  assert.match(routes, /cleanupStaleYocoWebhookSubscriptions/);
  assert.match(routes, /action === "yoco-webhook-health"/);
});

test('Phase 72 makes stale subscription deletion paced and non-fatal when Yoco remains rate limited', () => {
  const client = read('cloudflare-v2/src/legacy/yoco-client.ts');
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const cleanupBlock = service.match(/async function deleteYocoWebhookSubscriptions[\s\S]*?\n}\n\nexport async function getYocoConnection/)?.[0] || '';

  assert.match(client, /attempt < 4/);
  assert.match(client, /retryAfterMs/);
  assert.match(client, /deleteWebhookSubscription[\s\S]*withYocoRetry/);
  assert.match(client, /createWebhookSubscription[\s\S]*withYocoRetry/);
  assert.match(cleanupBlock, /paceMs/);
  assert.match(cleanupBlock, /setTimeout/);
  assert.match(cleanupBlock, /cleanupPending: failed\.length > 0/);
  assert.match(cleanupBlock, /options\.throwOnFailure === true/);
});

test('Phase 72 admin webhook reset no longer disconnects and reconnects', () => {
  const routes = read('cloudflare-v2/src/legacy/admin-routes.ts');
  const resetBlock = routes.match(/export async function postAdminYocoResetWebhook[\s\S]*?\n}\n/)?.[0] || '';

  assert.match(resetBlock, /resetYocoWebhook\(env, workspaceId, apiKey\)/);
  assert.doesNotMatch(resetBlock, /disconnectYoco\(/);
  assert.doesNotMatch(resetBlock, /connectYoco\(/);
});

test('Phase 72 admin connect does not trigger a second catalogue sync request', () => {
  const admin = read('public/KCP Admin ConsoleByYOCO.html');
  const connectBlock = admin.match(/async function connectYocoIntegrationFromAdmin[\s\S]*?\n}\n\nasync function syncYocoCatalogueFromAdmin/)?.[0] || '';

  assert.match(connectBlock, /\/yoco\/connect/);
  assert.match(connectBlock, /result\?\.catalogueSync/);
  assert.doesNotMatch(connectBlock, /\/yoco\/sync-catalogue/);
});
