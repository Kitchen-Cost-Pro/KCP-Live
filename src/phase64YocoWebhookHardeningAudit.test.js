import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 64 parses Yoco webhook identifiers and payment status from the nested payload envelope', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  assert.match(sales, /function webhookEnvelope\(payload: Row\)[\s\S]*objectValue\(payload\.payload\)/);
  assert.match(sales, /envelope\.reference/);
  assert.match(sales, /envelopeOrder\.id/);
  assert.match(sales, /envelopePayment\.id/);
  assert.match(sales, /\['successful', 'succeeded', 'success'\]/);
  assert.match(sales, /\['order\.completed', 'payment\.succeeded', 'payment\.successful'\]/);
  assert.match(sales, /if \(!statuses\.length\) return hasCompletionTimestamp/);
  assert.match(sales, /status\.includes\('succeed'\)/);
});

test('Phase 64 does not turn nested Yoco API collections into false empty order or subscription lists', () => {
  const client = read('cloudflare-v2/src/legacy/yoco-client.ts');
  assert.match(client, /'subscriptions'/);
  assert.match(client, /const containers = \[page, page\?\.data, page\?\.result, page\?\.payload\]/);
  assert.match(client, /Array\.isArray\(container\?\.data\)/);
  assert.match(client, /Array\.isArray\(container\?\.\[key\]\)/);
  assert.match(client, /function nextCursor\(page: any\)/);
});

test('Phase 64 atomically claims provider events and safely ignores non-stock event types', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const service = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const verification = read('cloudflare-v2/src/legacy/yoco-webhooks.ts');
  assert.match(routes, /provider_event_id = \?3/);
  assert.match(routes, /SET status = 'processing'/);
  assert.match(routes, /status IN \('received', 'failed', 'rejected', 'attention'\)/);
  assert.match(routes, /status = 'processing'[\s\S]*datetime\(\?2, '-5 minutes'\)/);
  assert.match(routes, /eventDisposition === "ignored"/);
  assert.match(routes, /eventDisposition === "waiting"/);
  assert.match(routes, /yocoWebhookPaymentSucceeded\(payload\)/);
  assert.match(service, /lower\(replace\(event\.event_type, '_', '\.'\)\) IN/);
  assert.match(service, /lower\(COALESCE\(event\.status, 'received'\)\) <> 'ignored'/);
  assert.match(verification, /if \(!webhookId \|\| !webhookTimestamp \|\| !webhookTimestampIsFresh\(webhookTimestamp\)\) return false/);
  assert.match(verification, /const signedContent = `\$\{webhookId\}\.\$\{webhookTimestamp\}\.\$\{rawBody\}`/);
  assert.doesNotMatch(verification, /fallbackSecretCandidates|hmacSha256Hex/);
});

test('Phase 64 prevents partial recipe deductions and guards stock from becoming negative', () => {
  const sales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
  assert.match(sales, /Preflight the entire recipe component/);
  assert.match(sales, /componentBalanceDeltas/);
  assert.match(sales, /componentInsufficient/);
  assert.match(sales, /for \(const plan of componentInsufficient \? \[\] : depletionPlans\)/);
  assert.match(sales, /AND \(\?4 >= 0 OR quantity \+ \?4 >= 0\)/);
  assert.match(sales, /WHERE changes\(\) = 1/);
  assert.match(sales, /WHERE EXISTS \([\s\S]*FROM stock_movements/);
});

test('Phase 64 enforces unique provider event ids at tenant schema level', () => {
  const migrations = read('cloudflare-v2/src/tenant-migrations.ts');
  assert.match(migrations, /ux_yoco_webhook_events_workspace_provider_event/);
  assert.match(migrations, /ON yoco_webhook_events\(workspace_id, provider_event_id\)/);
  assert.match(migrations, /WHERE COALESCE\(TRIM\(provider_event_id\), ''\) <> ''/);
});
