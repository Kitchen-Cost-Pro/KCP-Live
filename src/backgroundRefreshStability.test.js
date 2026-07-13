import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing ${endMarker}`);
  return source.slice(start, end);
}

test('background integration completion does not remount the active module', () => {
  const block = section(
    "window.addEventListener('kcp:integrations-sync-complete'",
    "let unsubscribeAccess",
  );
  assert.doesNotMatch(block, /refreshActiveTabFromApi/);
  assert.doesNotMatch(block, /renderApp|refreshActiveTabFromApi|flushDeferredRealtimeSnapshots/);
});

test('automatic Yoco sync is silent and has no delayed startup refresh', () => {
  const block = section('function startIntegrationAutoSync()', 'function stopIntegrationAutoSync()');
  assert.doesNotMatch(block, /refreshActiveTabFromApi/);
  assert.doesNotMatch(block, /4000/);
  assert.match(block, /setInterval\(runSync, 900000\)/);
});

test('data version polling records changes without repainting the page', () => {
  const block = section('function startDataVersionPoll()', 'function stopDataVersionPoll()');
  assert.doesNotMatch(block, /refreshActiveTabFromApi/);
  assert.match(block, /kcp:data-version-changed/);
});

test('background system broadcast polling does not replace the active module', () => {
  const block = section('function startSystemBroadcastRefresh()', 'function stopSystemBroadcastRefresh()');
  const silentCalls = block.match(/loadSystemBroadcast\(\{ render: false \}\)/g) || [];
  assert.equal(silentCalls.length, 2);
});

test('application does not contain a hard browser reload call', () => {
  assert.doesNotMatch(source, /(?:window\.)?location\.reload\s*\(/);
  assert.doesNotMatch(source, /history\.go\s*\(\s*0\s*\)/);
});
