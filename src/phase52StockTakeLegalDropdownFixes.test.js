import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('Stock Take Save Draft immediately exits the session and publishes the resumable draft', () => {
  const main = read('src/main.js');
  const component = read('src/components/StockTake.js');

  assert.match(main, /async function saveStockTakeSessionDraft\(\)/);
  assert.match(main, /const nextSavedDrafts = \[/);
  assert.match(main, /sessionActive:\s*false/);
  assert.match(main, /savedDrafts:\s*nextSavedDrafts/);
  assert.match(main, /overlay:\s*''/);
  assert.match(component, /actionStatus === 'saving-draft'/);
  assert.match(component, /Active Sessions/);
});

test('Legal Details saves all visible fields atomically and does not call unrelated personal preferences', () => {
  const main = read('src/main.js');
  const settings = read('src/components/Settings.js');
  const service = read('src/services/settingsService.js');

  assert.match(settings, /onTaxFieldChangeSilent/);
  assert.match(settings, /querySelectorAll\('\[data-settings-tax-field\]'\)/);
  assert.match(settings, /draftPatch:\s*\{ companyTaxInfo \}/);
  assert.match(settings, /syncSiteName:\s*false/);
  assert.match(main, /companyTaxInfo:\s*options\.draftPatch\.companyTaxInfo/);
  assert.match(main, /includePersonal:\s*false/);
  assert.match(main, /options\.syncSiteName !== false/);
  assert.match(service, /\{ includePersonal = false \}/);
  assert.match(service, /const workspaceResponse = await callCloudflareWorkspaceRoute/);
  assert.match(service, /const personalResponse = includePersonal/);
});

test('App dropdowns use a shared browser top layer above modal stacking contexts', () => {
  const portal = read('src/utils/appDropdownPortal.js');
  const main = read('src/main.js');
  const reportingSelect = read('src/modules/reporting/ui/customSelect.js');

  for (const root of [
    'adj', 'cn', 'grv', 'integrations', 'menu', 'mfg', 'po', 'recipe',
    'settings', 'stock', 'stocktake', 'supplier', 'transfer', 'user'
  ]) {
    assert.match(portal, new RegExp(`data-${root}-dropdown-root`));
  }
  assert.match(portal, /menu\.setAttribute\('popover', 'manual'\)/);
  assert.match(portal, /menu\.showPopover\(\)/);
  assert.doesNotMatch(portal, /document\.body\.append\(menu\)/);
  assert.match(portal, /z-index', '2147483646'/);
  assert.match(portal, /positionTopLayer/);
  assert.match(main, /installAppDropdownPortalSystem\(\)/);
  assert.match(main, /scheduleAppDropdownPortalRefresh\(\)/);
  assert.match(reportingSelect, /event\.stopPropagation\(\)/);
  assert.match(reportingSelect, /syncSelectLabel\(wrapper, select\);\s*closeActiveSelect\(\);\s*select\.dispatchEvent/s);
});
