import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const viteConfigUrl = new URL('../../vite.config.js', import.meta.url);
const adminConsoleUrl = new URL('../../public/KCP Admin ConsoleByYOCO.html', import.meta.url);

test('Vite serves the admin console locally and proxies API requests to the Worker', async () => {
  const config = await readFile(viteConfigUrl, 'utf8');
  assert.match(config, /url\.pathname === '\/admin'/);
  assert.match(config, /url\.pathname !== '\/admin\/'/);
  assert.match(config, /'\/api':\s*\{/);
  assert.match(config, /VITE_CLOUDFLARE_API_URL/);
});

test('admin console discovers Turnstile configuration at runtime', async () => {
  const html = await readFile(adminConsoleUrl, 'utf8');
  assert.doesNotMatch(html, /%%VITE_TURNSTILE_SITEKEY%%/);
  assert.match(html, /fetch\('\/api\/admin\/security-config'/);
  assert.match(html, /adminTurnstileRequired && !adminTurnstileToken/);
  assert.match(html, /render=explicit/);
});
