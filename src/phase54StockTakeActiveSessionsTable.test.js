import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('Phase 54 launchpad keeps the three primary stock take actions and replaces the draft modal with an inline table', () => {
  const component = read('src/components/StockTake.js');

  assert.match(component, /data-stocktake-open-start/);
  assert.match(component, /data-stocktake-open-quick/);
  assert.match(component, /data-stocktake-open-bulk-scan/);
  assert.match(component, /class="stockTakeActiveSessions"/);
  assert.match(component, /<th scope="col">Session Template<\/th>/);
  assert.match(component, /<th scope="col">Date<\/th>/);
  assert.match(component, /<th scope="col">Actions<\/th>/);
  assert.doesNotMatch(component, /data-stocktake-resume-draft/);
  assert.doesNotMatch(component, /filters\.overlay === 'resume-drafts'/);
});

test('Phase 54 active-session rows expose immediate resume and discard actions and adapt for mobile', () => {
  const component = read('src/components/StockTake.js');
  const css = read('src/styles/stockTake.css');

  assert.match(component, /activeSessions = \[\.\.\.\(Array\.isArray\(savedDrafts\)/);
  assert.match(component, /data-stocktake-resume-specific/);
  assert.match(component, /data-stocktake-discard-draft/);
  assert.match(component, /No active sessions/);
  assert.match(css, /\.stockTakeActiveSessionsTable/);
  assert.match(css, /content: attr\(data-label\)/);
  assert.match(css, /\.stockTakeActiveSessionAction--resume/);
  assert.match(css, /\.stockTakeActiveSessionAction--discard/);
});

test('Phase 54 saving and discarding drafts updates Active Sessions state without a page reload', () => {
  const main = read('src/main.js');

  assert.match(main, /async function saveStockTakeSessionDraft\(\)/);
  assert.match(main, /sessionActive:\s*false/);
  assert.match(main, /savedDrafts:\s*nextSavedDrafts/);
  assert.match(main, /Draft saved to Active Sessions\./);
  assert.match(main, /savedDrafts:\s*remainingDrafts/);
  assert.match(main, /overlay:\s*'',\s*openDropdown:\s*''/s);
  assert.doesNotMatch(main, /function restoreSavedStockTakeDraft/);
  assert.doesNotMatch(main, /overlay:\s*'resume-drafts'/);
});
