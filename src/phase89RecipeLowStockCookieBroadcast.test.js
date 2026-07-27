import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('recipe quantity edits keep qty and quantity aliases synchronized end to end', () => {
  const main = read('src/main.js');
  const service = read('src/services/recipeService.js');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  assert.match(main, /qty:\s*normalizedQty,\s*quantity:\s*normalizedQty/s);
  assert.match(service, /const quantity = parseDecimal\(line\?\.qty \?\? line\?\.quantity/);
  assert.match(routes, /quantity:\s*numberValue\(line\.qty \?\? line\.quantity/);
});

test('successful recipe saves clear the saving UI before the background refresh', () => {
  const main = read('src/main.js');
  const saveFlow = main.match(/async function saveCurrentRecipe\(\) \{[\s\S]*?\n\}\n\nasync function importRecipeFile/)?.[0] || '';
  assert.match(
    saveFlow,
    /actionStatus:\s*'',\s*actionError:\s*''\s*\};\s*\/\/[\s\S]*?hideGlobalSaving\(\);\s*renderApp\(\{\s*forceDomRefresh:\s*true\s*\}\);\s*showRecipeToast\('Recipe Blueprint Saved\.', 'success'\);\s*refreshActiveTabFromApi\(\)\.catch/s
  );
  assert.match(main, /function renderApp\(\{\s*forceDomRefresh\s*=\s*false\s*\}\s*=\s*\{\}\)/);
  assert.match(main, /!forceDomRefresh\s*&&\s*_active\s*&&\s*_active\.tagName\s*===\s*'SELECT'/);
});

test('request timeout remains active while the response body is consumed', () => {
  const api = read('src/services/cloudflareApi.js');
  const requestFlow = api.match(/async function executeRequest\([\s\S]*?\n\}\n\nfunction normalizeRequestTimeoutMs/)?.[0] || '';
  assert.match(requestFlow, /await fetch\([\s\S]*?result = await response\.json\(\)/);
  assert.match(requestFlow, /response\.json\(\)\.catch\(\(error\) => \{\s*if \(error\?\.name === 'AbortError'\) throw error;/s);
  assert.match(requestFlow, /finally \{\s*clearTimeout\(timeoutId\);\s*\}/s);
});

test('low-stock relevance uses 30-day activity, positive stock and active count templates', () => {
  const relevance = read('cloudflare-v2/src/legacy/low-stock-relevance.ts');
  const email = read('cloudflare-v2/src/legacy/low-stock-email.ts');
  const migrations = read('cloudflare-v2/src/tenant-migrations.ts');
  assert.match(relevance, /quantity > 0/);
  assert.match(relevance, /datetime\('now', '-30 days'\)/);
  for (const type of ['sale', 'grv', 'transfer', 'manufact', 'adjust', 'stock_take']) {
    assert.match(relevance, new RegExp(type));
  }
  assert.match(relevance, /stocktake_template_lines/);
  assert.match(relevance, /lsr_template\.active = 1/);
  assert.match(email, /LOW_STOCK_REMINDER_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS low_stock_alert_state/);
  assert.match(migrations, /trg_low_stock_alert_clear_on_balance_update/);
});

test('first-visit cookie notice is centred, persistent and links to the policy', () => {
  const consent = read('src/cookieConsent.js');
  const styles = read('src/styles/main.css');
  assert.match(consent, /kcp:cookie-consent:v1/);
  assert.match(consent, /PRIVACY_POLICY_URL.*#cookies/s);
  assert.match(consent, /Essential only/);
  assert.match(styles, /\.cookieConsent\s*\{[\s\S]*place-items:\s*center/);
});

test('admin broadcast queue exposes active and paused notices without historical entries', () => {
  const adminRoutes = read('cloudflare-v2/src/legacy/admin-routes.ts');
  const adminUi = read('public/KCP Admin ConsoleByYOCO.html');
  assert.match(adminRoutes, /isBroadcastItemManageable/);
  assert.match(adminRoutes, /requestedAction === 'delete'/);
  assert.match(adminRoutes, /requestedAction === 'status'/);
  assert.match(adminRoutes, /requestedAction === 'stop'/);
  assert.match(adminUi, /id="broadcast-queue"/);
  assert.match(adminUi, /changeBroadcastStatus/);
  assert.match(adminUi, /stopBroadcast/);
  assert.match(adminUi, /deleteBroadcast/);
});
