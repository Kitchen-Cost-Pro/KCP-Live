import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');

const adminHtml = read('public/KCP Admin ConsoleByYOCO.html');
const worker = read('cloudflare-v2/src/index.ts');
const adminRoutes = read('cloudflare-v2/src/legacy/admin-routes.ts');
const tenantRoutes = read('cloudflare-v2/src/legacy/routes.ts');
const tenantDispatcher = read('cloudflare-v2/src/legacy/index.ts');

test('admin portal has no direct Supabase or Firebase authentication path', () => {
  assert.doesNotMatch(adminHtml, /supabase\.co|SUPABASE_ANON_KEY|callAdminYocoFunctionJson/i);
  assert.doesNotMatch(adminHtml, /Firebase Authentication account/i);
  assert.doesNotMatch(adminRoutes, /verifyFirebaseJwt|securetoken\.google\.com/i);
});

test('admin workspace actions are explicitly routed to workspace Durable Objects', () => {
  assert.match(worker, /adminWorkspaceYocoM/);
  assert.match(worker, /admin-yoco\/\$\{action\}/);
  assert.match(worker, /adminWorkspaceActionM/);
  assert.match(worker, /admin-action\/\$\{action\}/);
  assert.match(worker, /send-low-stock-email/);
  assert.match(tenantDispatcher, /resource === [\"']admin-yoco\/events[\"']/);
  assert.match(tenantDispatcher, /resource === [\"']admin-audit-events[\"']/);
  assert.match(tenantRoutes, /adminYocoEventsDO/);
  assert.match(tenantRoutes, /repair-baseline/);
  assert.match(worker, /new Request\(request, \{ headers \}\)/);
  assert.doesNotMatch(worker, /body:\s*request\.body/);
});

test('admin maintenance controls call real D1 integrity endpoints', () => {
  assert.match(adminHtml, /\/api\/admin\/maintenance\/integrity/);
  assert.match(adminHtml, /\/api\/admin\/maintenance\/repair/);
  assert.match(worker, /getAdminIntegrityReport/);
  assert.match(worker, /postAdminIntegrityRepair/);
  assert.doesNotMatch(adminHtml, /Sync Global Access|syncGlobalAccess|ensureCurrentAdminWorkspaceAccess/);
});

test('admin workspace refresh cannot recurse through its cached reader', () => {
  const refreshBody = adminHtml.match(/async function refreshAdminWorkspaceRecord\(wsId\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const readBody = adminHtml.match(/async function readWorkspaceRecord\(wsId\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(refreshBody, /readWorkspaceRecord\(/);
  assert.doesNotMatch(readBody, /refreshAdminWorkspaceRecord\(/);
  assert.match(refreshBody, /\/yoco\/status/);
});

test('admin UI actions use valid handlers and D1 session logout', () => {
  assert.doesNotMatch(adminHtml, /changeAuditPage\(/);
  assert.match(adminHtml, /changeAuditLogPage\(-1\)/);
  assert.match(adminHtml, /changeAuditLogPage\(1\)/);
  assert.match(adminHtml, /onclick="addAdmin\(this\)"/);
  assert.match(adminHtml, /fetch\('\/api\/auth\/logout'/);
  assert.match(adminHtml, /clearAdminSession\(\)/);
});
