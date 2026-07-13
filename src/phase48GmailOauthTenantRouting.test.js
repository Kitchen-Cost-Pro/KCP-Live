import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('Phase 48 routes workspace Gmail OAuth callbacks into the tenant Durable Object', () => {
  const worker = read('../cloudflare-v2/src/index.ts');
  const legacy = read('../cloudflare-v2/src/legacy/index.ts');
  const routes = read('../cloudflare-v2/src/legacy/routes.ts');

  assert.match(worker, /gmailWorkspaceIdFromOauthState/);
  assert.match(worker, /url\.pathname === '\/api\/gmail\/oauth\/callback'/);
  assert.match(worker, /forwardToWorkspaceDO\([\s\S]*'gmail-oauth-callback'/);
  assert.match(legacy, /resource === 'gmail-oauth-callback'/);
  assert.match(legacy, /auth\.uid !== 'gmail-oauth-callback'/);
  assert.match(legacy, /return getGmailOAuthCallback\(request, env\)/);
  assert.match(routes, /FROM workspace_settings/);
});

test('Phase 48 preserves the system Gmail callback on the central admin route', () => {
  const worker = read('../cloudflare-v2/src/index.ts');
  const routes = read('../cloudflare-v2/src/legacy/routes.ts');

  assert.match(worker, /!rawState\.startsWith\('system:'\)/);
  assert.match(routes, /rawState\.startsWith\("system:"\)/);
  assert.match(routes, /return getAdminGmailCallback\(request, env\)/);
});
