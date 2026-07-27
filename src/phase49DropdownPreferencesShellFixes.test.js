import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { exportSchemas } from './services/exportService.js';

const read = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('Phase 50 stores personal preferences independently of workspace membership rows', () => {
  const routes = read('../cloudflare-v2/src/legacy/routes.ts');
  const migration = read('../cloudflare-v2/migrations/0004_user_preferences.sql');

  assert.match(routes, /async function ensureUserPreferencesSchema/);
  assert.match(routes, /CREATE TABLE IF NOT EXISTS user_preferences/);
  assert.match(routes, /principal_key TEXT PRIMARY KEY/);
  assert.match(routes, /userPreferencePrincipal\(auth\)/);
  assert.doesNotMatch(routes, /Your active workspace membership was not found/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_preferences/);
});

test('Phase 50 uses one reliable body portal for report filters, scheduling and pagination', () => {
  const select = read('./modules/reporting/ui/customSelect.js');
  const filters = read('./modules/reporting/tables/ReportFilters.js');
  const css = read('./styles/reporting.css');

  assert.match(select, /const PORTAL_ID = 'report-enhanced-select-portal'/);
  assert.match(select, /document\.body\.append\(menu\)/);
  assert.match(select, /installGlobalListeners/);
  assert.match(select, /schedulePositionActiveSelect/);
  assert.doesNotMatch(select, /scrollIntoView/);
  assert.match(filters, /<select name="\$\{escapeHtml\(name\)\}"/);
  assert.match(css, /#report-enhanced-select-portal/);
});

test('Phase 49 moves Default Ordering UOM to the last stock import column', () => {
  assert.equal(exportSchemas.stock.at(-1), 'Default_Ordering_UOM');
});

test('Phase 49 keeps reporting on the standard app shell and makes schedule views vertical', () => {
  const appShell = read('./appShell.js');
  const navigation = read('./components/Navigation.js');
  const css = read('./styles/reporting.css');

  assert.doesNotMatch(appShell, /styles\.reportingMainPane/);
  assert.doesNotMatch(navigation, /styles\.reportingSidebar/);
  assert.match(css, /reportSchedulingPage[\s\S]*background:\s*transparent\s*!important/);
  assert.match(css, /\.reportScheduleViewPanel__list\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)\s*!important/);
});

test('Phase 49 colours and centres scheduling actions and widens pagination', () => {
  const css = read('./styles/reporting.css');

  assert.match(css, /reportSchedulingTable th:last-child/);
  assert.match(css, /reportScheduleRowActions \.reportScheduleIconAction--run[\s\S]*#22c55e/);
  assert.match(css, /reportScheduleRowActions \.reportScheduleIconAction--edit[\s\S]*#f59e0b/);
  assert.match(css, /reportScheduleRowActions \.reportScheduleIconAction--duplicate[\s\S]*#3b82f6/);
  assert.match(css, /reportScheduleRowActions \.reportScheduleIconAction--delete[\s\S]*#ef4444/);
  assert.match(css, /reportPagination__pageSize \.reportEnhancedSelect[\s\S]*7\.25rem/);
});
