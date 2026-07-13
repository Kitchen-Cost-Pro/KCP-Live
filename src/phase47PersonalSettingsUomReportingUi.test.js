import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { exportSchemas } from './services/exportService.js';

const read = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('Phase 47 stores appearance and UI scale as user preferences instead of workspace settings', () => {
  const service = read('./services/settingsService.js');
  const routes = read('../cloudflare-v2/src/legacy/routes.ts');
  const migration = read('../cloudflare-v2/migrations/0003_user_preferences.sql');

  assert.match(service, /const PERSONAL_SETTING_KEYS = new Set\(\[/);
  assert.match(service, /'uiScale'/);
  assert.match(service, /'restaurantThemeId'/);
  assert.match(service, /'restaurantBackgroundId'/);
  assert.match(service, /export async function savePersonalSettings/);
  assert.match(service, /user-preferences/);
  assert.match(routes, /export async function getUserPreferencesRoute/);
  assert.match(routes, /export async function patchUserPreferencesRoute/);
  assert.match(migration, /user_preferences_json/);
});

test('Phase 47 removes low-stock summary controls from business settings and user creation', () => {
  const settings = read('./components/Settings.js');
  const users = read('./components/UserManagement.js');
  const createStart = users.indexOf('function renderCreateModal');
  const createEnd = users.indexOf('function renderEditModal', createStart);
  const createSection = users.slice(createStart, createEnd);

  assert.doesNotMatch(settings, /Low Stock Summary/i);
  assert.doesNotMatch(settings, /Alert Time/i);
  assert.doesNotMatch(createSection, /low.?stock.?email/i);
});

test('Phase 47 locks the Yoco key fingerprint and restricts replacement and disconnect operations', () => {
  const yoco = read('../cloudflare-v2/src/legacy/yoco-service.ts');
  const routes = read('../cloudflare-v2/src/legacy/routes.ts');

  assert.match(yoco, /api_key_fingerprint/);
  assert.match(yoco, /allowKeyReplacement/);
  assert.match(yoco, /lockedFingerprint !== fingerprint/);
  assert.match(routes, /allowKeyReplacement: true/);
  assert.match(routes, /normalizeRoleKey\(actorRole\) !== 'superuser'/);
});

test('Phase 47 portals report dropdowns above report surfaces and widens pagination controls', () => {
  const selectSource = read('./modules/reporting/ui/customSelect.js');
  const css = read('./styles/reporting.css');

  assert.match(selectSource, /document\.body\.append\(menu\)/);
  assert.match(selectSource, /position|getBoundingClientRect/);
  assert.match(css, /body > \.reportEnhancedSelect__menu--portal/);
  assert.match(css, /z-index:\s*2147483647/);
  assert.match(css, /reportPagination__pageSize[\s\S]*min-width:\s*6\.4rem/);
});

test('Phase 47 adds a per-item default ordering UOM to stock editing and XLSX import', () => {
  const stockItems = read('./components/StockItems.js');
  const dataService = read('./services/dataService.js');
  const main = read('./main.js');

  assert.equal(exportSchemas.stock.includes('Default_Ordering_UOM'), true);
  assert.match(stockItems, /data-stock-uom-default-ordering/);
  assert.match(stockItems, /isDefaultOrdering/);
  assert.match(dataService, /UOM_Options/);
  assert.match(dataService, /Select only the Base UOM or one of the Custom UOMs entered on this same row/);
  assert.match(main, /Default_Ordering_UOM must match the Base_UOM or one of the UOM_1, UOM_2, or UOM_3 names on the same row/);
  assert.match(main, /\.find\(\(entry\) => entry\.isDefaultOrdering\)/);
});

test('Phase 47 restores workspace users to scheduling and applies compact coloured report-pack actions', () => {
  const api = read('./modules/reporting/scheduling/reportSchedulingApi.js');
  const routes = read('../cloudflare-v2/src/legacy/report-scheduling-routes.ts');
  const page = read('./modules/reporting/scheduling/SchedulingPage.js');
  const css = read('./styles/reporting.css');

  assert.match(api, /users: Array\.isArray\(response\.users\) \? response\.users : \[\]/);
  assert.match(routes, /listActiveScheduleRecipientUsers/);
  assert.match(routes, /workspace_members/);
  assert.match(page, /reportScheduleIconAction--\$\{escapeHtml\(action\)\}/);
  assert.match(css, /reportScheduleIconAction--run[\s\S]*#22c55e/);
  assert.match(css, /reportScheduleIconAction--edit[\s\S]*#f59e0b/);
  assert.match(css, /reportScheduleIconAction--duplicate[\s\S]*#3b82f6/);
  assert.match(css, /reportScheduleIconAction--delete[\s\S]*#ef4444/);
  assert.match(css, /reportScheduleViewPanel__list input\[type="checkbox"\]/);
});

test('Phase 47 themes report title surfaces and keeps quick Create PO limited to low-stock rows', () => {
  const css = read('./styles/reporting.css');
  const table = read('./modules/reporting/tables/ReportTable.js');
  const warnings = read('./modules/reporting/validators/rowWarningUtils.js');

  assert.match(css, /\.reportViewer \.reportHeader\.reportHeader--compact/);
  assert.match(css, /color-mix\(in srgb, var\(--accent-blue\)/);
  assert.match(table, /row\.menuItem/);
  assert.match(warnings, /row\.menuItem/);
  assert.match(table, /isLowStock/);
  assert.match(table, /Create PO/);
});
