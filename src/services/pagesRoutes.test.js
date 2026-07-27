import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pagesWorker from '../../public/_worker.js';

test('Pages routes explicitly send both admin URL forms through the asset worker', () => {
  const routes = JSON.parse(readFileSync(new URL('../../public/_routes.json', import.meta.url), 'utf8'));
  assert.equal(routes.include.includes('/admin'), true);
  assert.equal(routes.include.includes('/admin/*'), true);
});

test('Pages worker redirects /admin and serves the admin index at /admin/', () => {
  const worker = readFileSync(new URL('../../public/_worker.js', import.meta.url), 'utf8');
  assert.match(worker, /url\.pathname === '\/admin'/);
  assert.match(worker, /url\.pathname === '\/admin\/'/);
  assert.match(worker, /\/admin\/index\.html/);
});

test('Pages worker executes the admin redirect and asset response', async () => {
  let requestedAsset = '';
  const env = {
    ASSETS: {
      fetch: async (request) => {
        requestedAsset = new URL(request.url).pathname;
        return new Response('<title>Admin</title>', {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }
    }
  };

  const redirect = await pagesWorker.fetch(new Request('https://kcp.example/admin?from=test'), env);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), 'https://kcp.example/admin/?from=test');

  const admin = await pagesWorker.fetch(new Request('https://kcp.example/admin/'), env);
  assert.equal(admin.status, 200);
  assert.equal(requestedAsset, '/admin/index.html');
  assert.equal(admin.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, max-age=0');
  assert.match(await admin.text(), /Admin/);
});
