import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRecipeLines } from './services/recipeService.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('recipe normalization prefers edited qty and emits one canonical value', () => {
  const [line] = normalizeRecipeLines([{
    ingId: 'stock-1',
    qty: '2,75',
    quantity: 1,
    unit: 'g',
  }]);
  assert.equal(line.qty, 2.75);
  assert.equal(line.quantity, 2.75);
  assert.equal(line.stockItemId, 'stock-1');
});

test('Worker recipe persistence prefers qty over stale quantity', () => {
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  assert.match(routes, /line\.qty !== undefined[\s\S]*\? line\.qty[\s\S]*: line\.quantity/);
});

test('low-stock monitoring has rolling relevance and seven-day state', () => {
  const policy = read('cloudflare-v2/src/legacy/low-stock-policy.ts');
  const email = read('cloudflare-v2/src/legacy/low-stock-email.ts');
  const migrations = read('cloudflare-v2/src/tenant-migrations.ts');
  assert.match(policy, /LOW_STOCK_RELEVANCE_DAYS = 30/);
  assert.match(policy, /LOW_STOCK_REMINDER_DAYS = 7/);
  assert.match(policy, /COALESCE\(\$\{balanceAlias\}\.quantity, 0\) > 0/);
  assert.match(policy, /stocktake_templates/);
  assert.match(email, /syncLowStockAlertState/);
  assert.match(email, /markLowStockRowsNotified/);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS low_stock_alert_state/);
});

test('first-visit cookie policy is bottom-centered, non-blocking, and persisted', () => {
  const main = read('src/main.js');
  const styles = read('src/styles/main.css');
  assert.match(main, /mountCookiePolicyNotice\(\)/);
  assert.match(main, /kcp:cookie-consent:v1/);
  assert.doesNotMatch(main, /querySelector\('\[data-cookie-accept\]'\)\?\.focus\(\)/);
  assert.match(styles, /\.cookiePolicy\s*\{[\s\S]*align-items: flex-end[\s\S]*justify-content: center[\s\S]*pointer-events: none/);
  assert.match(styles, /\.cookiePolicy__card\s*\{[\s\S]*rgba\(15, 29, 46, 0\.97\)[\s\S]*pointer-events: auto/);
  assert.doesNotMatch(styles, /\.cookiePolicy\s*\{[^}]*backdrop-filter/);
});

test('Main Store is labelled as storage while keeping its default badge', () => {
  const locations = read('src/components/Locations.js');
  assert.match(locations, /const typeLabel = isStorageLocation\(location\) \? 'Storage' : 'Selling Location'/);
  assert.match(locations, /Default Location/);
});

test('Admin Broadcast shows only current queue controls', () => {
  const admin = read('public/KCP Admin ConsoleByYOCO.html');
  const routes = read('cloudflare-v2/src/legacy/admin-routes.ts');
  assert.match(admin, /id="broadcast-queue"/);
  assert.match(admin, /data-broadcast-stop/);
  assert.match(admin, /data-broadcast-delete/);
  assert.match(routes, /currentBroadcastConfig/);
  assert.match(routes, /requestedAction === 'status'/);
  assert.match(routes, /requestedAction === 'remove' \|\| requestedAction === 'delete'/);
});

test('unmapped Yoco locations fall back to Main Storage for sales and refunds', () => {
  const routing = read('cloudflare-v2/src/modules/yoco-engine-v2/location-routing.ts');
  const sale = read('cloudflare-v2/src/modules/yoco-engine-v2/sale-resolver.ts');
  const refund = read('cloudflare-v2/src/modules/yoco-engine-v2/refund-resolver.ts');
  const webhook = read('cloudflare-v2/src/modules/yoco-engine-v2/webhook-ingress.ts');
  assert.match(routing, /main storage/);
  assert.match(routing, /COALESCE\(is_default, 0\) = 1/);
  assert.match(routing, /'main storeroom'/);
  assert.match(sale, /resolveYocoStockLocation/);
  assert.match(refund, /resolveYocoStockLocation/);
  assert.match(webhook, /migrateYocoV2EffectOwnershipForConnection/);
  assert.match(webhook, /yoco-v2-verified-webhook/);
});
