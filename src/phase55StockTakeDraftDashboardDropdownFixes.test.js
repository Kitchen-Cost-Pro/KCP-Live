import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDashboardSelectMenuLayout,
  positionDashboardSelectMenu
} from './utils/dashboardDropdown.js';

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('Phase 55 stock take draft save releases focused fields and cannot be double-submitted', () => {
  const main = read('src/main.js');

  assert.match(main, /if \(appState\.stockTake\.actionStatus === 'saving-draft'\) return;/);
  assert.match(main, /pendingFocusField = null;\s*if \(typeof document !== 'undefined'[\s\S]*?document\.activeElement\.blur\(\);/);
  assert.match(main, /id: String\(hydratedDraft\.id \|\| makeStableSubmitId\('std'\)\)/);
  assert.match(main, /draftSession: draft,\s*actionStatus: 'saving-draft'/s);
  assert.match(main, /sessionActive: false,\s*savedDrafts: nextSavedDrafts/s);
  assert.match(main, /showStockTakeToast\('Draft saved to Active Sessions\.', 'success'\)/);
  assert.match(main, /showStockTakeToast\(message, 'error'\)/);
});

test('Phase 55 stock take draft save exposes progress and failures beside the action buttons', () => {
  const component = read('src/components/StockTake.js');
  const css = read('src/styles/stockTake.css');

  assert.match(component, /Saving this draft and returning to Active Sessions\.\.\./);
  assert.match(component, /role="status" aria-live="polite"/);
  assert.match(component, /stockTakeSessionFeedback--error/);
  assert.match(component, /const actionPending = \['saving', 'saving-draft'\]\.includes\(actionStatus\)/);
  assert.match(component, /data-stocktake-save-draft \${draft\.locationId && !actionPending/);
  assert.match(component, /data-stocktake-save \${\(draft\.items \|\| \[\]\)\.length && !actionPending/);
  assert.match(css, /\.stockTakeSessionFeedback\s*\{/);
  assert.match(css, /\.stockTakeSessionFeedback--error\s*\{/);
});

test('Phase 55 stock take drafts use the authenticated Worker identity even when the browser has no uid', () => {
  const service = read('src/services/stockTakeService.js');
  const api = read('src/services/cloudflareApi.js');
  const worker = read('cloudflare-v2/src/legacy/routes.ts');

  assert.doesNotMatch(service, /User id is required to save stock take drafts/);
  assert.doesNotMatch(service, /User id is required to delete stock take drafts/);
  assert.match(service, /payload: uid \? \{ userId: uid, draft: savedDraft \} : \{ draft: savedDraft \}/);
  assert.match(service, /const routeUser = uid \|\| 'current'/);
  assert.match(service, /timeoutMs: 15000/);
  assert.match(api, /timeoutMs = REQUEST_TIMEOUT_MS/);
  assert.match(api, /normalizeRequestTimeoutMs\(timeoutMs\)/);
  assert.match(worker, /export async function getStockTakeDrafts[\s\S]*?const userId = auth\.uid;/);
  assert.match(worker, /export async function postStockTakeDraft[\s\S]*?const userId = auth\.uid;/);
  assert.match(worker, /export async function deleteStockTakeDraftRoute[\s\S]*?const uid = auth\.uid;/);
});



test('Phase 55 dropdown outside-click handling cannot swallow Save or Commit actions', () => {
  const portal = read('src/utils/appDropdownPortal.js');

  assert.match(portal, /document\.addEventListener\('click', handleOutsideClick, \{ capture: true \}\)/);
  assert.match(portal, /function handleOutsideClick\(event\)[\s\S]*?queueMicrotask\(\(\) =>/);
  assert.match(portal, /if \(activeLayer !== layer\) return;/);
  assert.match(portal, /root\.isConnected && trigger\.isConnected && isRootOpen\(root\)/);
  assert.doesNotMatch(portal, /addEventListener\('pointerdown', handleOutsidePointerDown/);
  assert.doesNotMatch(portal, /function handleOutsidePointerDown/);
});

test('Phase 55 appends the stock take draft table migration for existing tenant databases', () => {
  const migrations = read('cloudflare-v2/src/tenant-migrations.ts');

  assert.match(migrations, /\/\/ 15 — repair existing Durable Object tenants[\s\S]*?CREATE TABLE IF NOT EXISTS stocktake_drafts/);
  assert.match(migrations, /CREATE INDEX IF NOT EXISTS idx_stocktake_drafts_workspace_user/);
  assert.match(migrations, /workspace_id TEXT NOT NULL,[\s\S]*?user_id TEXT NOT NULL,[\s\S]*?raw_json TEXT NOT NULL DEFAULT '\{\}'/);
});

test('Phase 55 dashboard menu layout matches the trigger on first open and stays inside the viewport', () => {
  assert.deepEqual(
    getDashboardSelectMenuLayout({
      buttonRect: { width: 240 },
      fieldRect: { left: 24, width: 240 },
      viewportWidth: 1440
    }),
    { width: 240, left: 0 }
  );

  assert.deepEqual(
    getDashboardSelectMenuLayout({
      buttonRect: { width: 280 },
      fieldRect: { left: 760, width: 280 },
      viewportWidth: 1000
    }),
    { width: 280, left: -52 }
  );

  assert.deepEqual(
    getDashboardSelectMenuLayout({
      buttonRect: { width: 500 },
      fieldRect: { left: 0, width: 500 },
      viewportWidth: 320
    }),
    { width: 296, left: 12 }
  );
});

test('Phase 55 dashboard applies the calculated width before paint and removes flex-row percentage sizing', () => {
  const menu = { hidden: false, style: {} };
  const field = { getBoundingClientRect: () => ({ left: 700, width: 240 }) };
  const button = {
    closest: () => field,
    getBoundingClientRect: () => ({ width: 240 })
  };
  const view = {
    querySelector(selector) {
      if (selector.includes('select-button')) return button;
      if (selector.includes('select-menu')) return menu;
      return null;
    }
  };

  const layout = positionDashboardSelectMenu(view, 'range', 900);
  assert.deepEqual(layout, { width: 240, left: -52 });
  assert.deepEqual(menu.style, {
    width: '240px',
    minWidth: '240px',
    maxWidth: '240px',
    left: '-52px'
  });

  const dashboard = read('src/dashboard.js');
  const css = read('src/styles/dashboard.module.css');
  assert.match(dashboard, /positionDashboardSelectMenu\(view, except\)/);
  assert.match(dashboard, /if \(ui\.openSelect\) positionDashboardSelectMenu\(view, ui\.openSelect\)/);
  assert.match(css, /\.customField\s*\{[\s\S]*?width: clamp\(190px, 22vw, 280px\);/);
  assert.match(css, /\.customSelectMenu\s*\{[\s\S]*?width: 100%;[\s\S]*?overflow-x: hidden;/);
  assert.doesNotMatch(css, /width:\s*max\(100%,\s*220px\)/);
});
