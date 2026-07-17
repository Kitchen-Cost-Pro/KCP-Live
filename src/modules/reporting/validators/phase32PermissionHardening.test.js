import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const auth = read('cloudflare-v2/src/legacy/auth.ts');
const routes = read('cloudflare-v2/src/legacy/routes.ts');
const reporting = read('cloudflare-v2/src/legacy/reporting-routes.ts');
const reporting21 = read('cloudflare-v2/src/legacy/reporting-phase21-routes.ts');
const worker = read('cloudflare-v2/src/legacy/index.ts');

function section(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const end = source.indexOf('\nexport async function ', start + 1);
  return source.slice(start, end > start ? end : source.length);
}

test('location assignments fail closed for non-manager users', () => {
  assert.match(auth, /missing, malformed, or empty assignments mean zero accessible locations/);
  assert.match(auth, /catch\s*\{\s*return \[\]/s);
  assert.match(auth, /return ids;/);
  assert.doesNotMatch(auth, /return ids\.length \? ids : null/);
});

test('unrestricted location access requires owner, admin, superuser, or an explicit all marker', () => {
  assert.match(auth, /FULL_PERMISSION_ROLE_KEYS\.has\(normalizedRole\)/);
  assert.doesNotMatch(auth, /MANAGER_ROLE_KEYS\.has\(normalizedRole\)/);
  assert.match(auth, /parsed === ["']all["']/);
  assert.match(auth, /record\.all === true/);
});

test('major inventory mutations require action permission and assigned location', () => {
  const contracts = [
    ['postAdjustment', 'nav-adjustments', 'adjustment'],
    ['postWastageAdjustment', 'nav-adjustments', 'wastage'],
    ['postGoodsReceipt', 'nav-grv', 'grv'],
    ['postCreditNote', 'nav-credit-note', 'credit_note'],
    ['postStockTake', 'nav-stock-count', 'stock_take'],
    ['postManufacturingBatch', 'nav-mfg-products', 'manufacturing'],
    ['postInternalTransfer', 'nav-transfers', 'transfer_source'],
    ['postExternalTransfer', 'nav-transfers', 'external_transfer_source'],
    ['patchStockLevel', 'nav-ingredients', 'stock_level_update'],
  ];
  for (const [name, permission, context] of contracts) {
    const source = section(routes, name);
    assert.match(source, new RegExp(`assertWorkspacePermission\\([\\s\\S]*?["']${permission}["']`), `${name} permission guard missing`);
    assert.match(source, new RegExp(`assertLocationAccess\\([\\s\\S]*?["']${context}["']`), `${name} location guard missing`);
  }
  const transfer = section(routes, 'postInternalTransfer');
  assert.match(transfer, /["']transfer_destination["']/);
});

test('reporting routes enforce reporting permission and automatically scope restricted users to assigned locations', () => {
  assert.match(auth, /assertWorkspacePermission\(env, auth, workspaceId, ["']nav-reporting["']\)/);
  assert.match(auth, /const resolved = requested\.length \? requested : allowed/);
  assert.match(auth, /RESOLVED_REPORT_LOCATION_SCOPES\.set\(request, resolved\)/);
  assert.match(reporting, /getResolvedReportLocationScope/);
  assert.match(reporting, /addLocationSqlScope/);
  assert.match(reporting21, /getResolvedReportLocationScope/);
  assert.match(reporting21, /addSqlLocationScope/);
});

test('permission denials are audited and returned as HTTP 403', () => {
  assert.match(auth, /permission_denied/);
  assert.match(auth, /recordPermissionDenial/);
  assert.match(worker, /\? 403/);
});
