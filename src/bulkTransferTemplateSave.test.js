import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mainSource = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const transferComponentSource = fs.readFileSync(new URL('./components/Transfers.js', import.meta.url), 'utf8');
const transferServiceSource = fs.readFileSync(new URL('./services/transferService.js', import.meta.url), 'utf8');
const workerRouteSource = fs.readFileSync(new URL('../cloudflare-v2/src/legacy/routes.ts', import.meta.url), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing ${endMarker}`);
  return source.slice(start, end);
}

test('bulk transfer template save cannot be submitted twice while pending', () => {
  const handler = section(mainSource, 'async function saveTransferTemplateDraft()', 'async function deleteTransferTemplateEntry');
  assert.match(handler, /actionStatus === 'saving-template'\) return/);
  assert.match(handler, /showTransferToast\(message, 'error'\)/);
  assert.match(handler, /pendingFocusField = null/);
  assert.match(handler, /document\.activeElement\.blur\(\)/);
  assert.ok(
    handler.indexOf('pendingFocusField = null') < handler.indexOf("actionStatus: 'saving-template'"),
    'template form focus must be released before the saving render'
  );
  assert.ok(
    handler.match(/pendingFocusField = null/g)?.length >= 3,
    'focus must also be released before success and error completion renders'
  );

  const builder = section(transferComponentSource, 'function renderTransferTemplateBuilder', 'function bindTransferEvents');
  assert.match(builder, /const isSaving = transfers\.actionStatus === 'saving-template'/);
  assert.match(builder, /selectedIds\.size && !isSaving/);
  assert.match(builder, /aria-busy="\$\{isSaving \? 'true' : 'false'\}"/);
});

test('bulk transfer template request only sends stock item IDs', () => {
  const save = section(transferServiceSource, 'export async function saveTransferTemplate', 'export async function deleteTransferTemplate');
  assert.match(save, /items: template\.items\.map\(\(item\) => \(\{ stockItemId: item\.stockItemId \}\)\)/);
  assert.doesNotMatch(save, /payload: \{ template \}/);
});

test('worker saves any template size with a constant-size atomic SQL batch', () => {
  const route = section(workerRouteSource, 'export async function postTransferTemplate', 'export async function deleteTransferTemplateRoute');
  assert.match(route, /FROM json_each\(\?3\) selected/);
  assert.match(route, /await env\.DB\.batch\(statements\)/);
  assert.doesNotMatch(route, /items\.forEach/);
  assert.doesNotMatch(route, /statements\.push/);
  assert.match(route, /COUNT\(si\.id\) AS valid_count/);
});
