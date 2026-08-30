/*
 * ============================================================================================
 * !! MERGE BLOCKER — THIS FILE NEEDS TEST INFRASTRUCTURE THIS PACKAGE DOES NOT HAVE YET !!
 * ============================================================================================
 * Unlike every other *.test.js in this project (plain fs.readFileSync + assert.match text
 * checks), these are BEHAVIOURAL regression tests: they render the real components and drive
 * the real DOM. They need two things that are not wired up here yet:
 *
 *   1. devDependency:  jsdom            (npm i -D jsdom)
 *   2. runner flag:    node --experimental-test-module-mocks --test ...
 *                      (required by node:test's mock.module on Node 20/22; add it to whatever
 *                       npm script / CI step runs this file)
 *
 * WITHOUT BOTH, 18 OF THE 22 TESTS BELOW SKIP INSTEAD OF RUNNING (no jsdom: 18 skip, only the
 * 4 pure-function tests run; jsdom but no flag: the 5 saved-view tests still skip), and the
 * suite still reports green — which looks like coverage of three ship-blocking regressions (B1 focus loss, B2
 * saved-view overwrite, date-less reports narrowed to a one-day range) while enforcing none of
 * them. Every skip names exactly what is missing; grep a CI log for "SKIP" to see the gap.
 * Please add the dependency and the flag in the same change that merges this file.
 * ============================================================================================
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { applyDateRangePreset, hasDateRangeContext, inferDateRangeType } from './scheduling/dateRangePresets.js';
import { resolveScheduledRelativeRange } from './scheduling/scheduleTiming.js';
import { normalizeScheduledReportFilters } from './scheduling/scheduleExecutionFreshness.js';
import { getSchedulableReportCatalog } from './scheduling/reportCatalog.js';
import {
  normalizeFormValues,
  readScheduleForm,
  renderScheduleModal,
  syncSavedViewSelectState,
  toSchedulePayload
} from './scheduling/SchedulingPage.js';
import { enhanceReportingSelects } from './ui/customSelect.js';
import { readReportFilters, renderReportFilters } from './tables/ReportFilters.js';

// These regressions are about behaviour, so they drive the real functions. Two of them need seams
// this package may not have wired up yet; those announce themselves instead of passing vacuously.
const jsdomModule = await import('jsdom').then((module) => module, () => null);
const NO_DOM = jsdomModule?.JSDOM
  ? false
  : 'MISSING INFRA: jsdom is not installed — add it as a devDependency (npm i -D jsdom). This behavioural test did NOT run.';
const NO_MODULE_MOCK = typeof mock.module === 'function'
  ? false
  : 'MISSING INFRA: node:test mock.module is unavailable — run this file with node --experimental-test-module-mocks. This behavioural test did NOT run.';

function setupDom() {
  const dom = new jsdomModule.JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.FormData = dom.window.FormData;
  globalThis.Event = dom.window.Event;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  return dom;
}

function buildSavedViewSelect() {
  const form = document.createElement('form');
  form.innerHTML = `
    <div class="reportScheduleViewChoice" data-schedule-view-choice>
      <select data-schedule-item-saved-view data-report-id="wastage" data-view-id="line_detail">
        <option value="">Use report defaults</option>
        <option value="sv-1">Weekly Wastage</option>
        <option value="sv-2">Monthly Wastage</option>
      </select>
    </div>`;
  document.body.append(form);
  enhanceReportingSelects(form);
  const select = form.querySelector('[data-schedule-item-saved-view]');
  const button = () => select.closest('[data-report-enhanced-select]').querySelector('.reportEnhancedSelect__button');
  return { form, select, button };
}

const SCHEDULE_BASE = {
  name: 'Kitchen wastage',
  reportId: 'wastage',
  viewId: 'line_detail',
  reportItems: [{ reportId: 'wastage', viewId: 'line_detail' }],
  recipients: ['chef@example.com'],
  scheduleFrequency: 'weekly',
  scheduleTime: '07:00',
  isEnabled: true
};

function openScheduleForm(storedSchedule, { permitted = [], allowAllLocations = true } = {}) {
  const catalog = getSchedulableReportCatalog();
  const values = normalizeFormValues(storedSchedule, {}, catalog, permitted, allowAllLocations, [], []);
  const host = document.createElement('div');
  host.innerHTML = renderScheduleModal(values, catalog, [], true);
  document.body.append(host);
  const form = host.querySelector('[data-schedule-form]');
  return { values, form, save: () => readScheduleForm(form, catalog, [], values.reportItems) };
}

test('B1: re-enabling a saved-view select re-enables the visible enhanced control', { skip: NO_DOM }, () => {
  setupDom();
  const { form, select, button } = buildSavedViewSelect();

  syncSavedViewSelectState(form, 'wastage', 'line_detail', false);
  assert.equal(select.disabled, true);
  assert.equal(button().disabled, true, 'disabling must disable the visible button');

  syncSavedViewSelectState(form, 'wastage', 'line_detail', true);
  assert.equal(select.disabled, false);
  assert.equal(button().disabled, false, 'the visible button must be usable again after re-enabling');
  assert.equal(select.closest('[data-report-enhanced-select]').classList.contains('is-disabled'), false);
});

test('B1: syncing an already-enabled select does not rebuild the control or steal focus', { skip: NO_DOM }, () => {
  setupDom();
  const { form, select, button } = buildSavedViewSelect();
  const original = button();
  original.focus();
  assert.equal(document.activeElement, original, 'precondition: the enhanced button holds focus');

  // This is what the saved-view select's own change handler does on every selection.
  select.value = 'sv-2';
  syncSavedViewSelectState(form, 'wastage', 'line_detail', true);

  assert.equal(button(), original, 'no disabled-state change means no rebuild of the button');
  assert.equal(document.activeElement, original, 'keyboard focus must survive picking a saved view');
  assert.equal(select.value, 'sv-2', 'the selection itself must be left alone');
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// The saved-view API is stubbed once and reads from whatever fixture the current test mounted:
// re-mocking per test would not reach an already-imported SavedViewsControl.
let savedViewsFixture = null;
let savedViewsApiStubbed = false;

async function mountSavedViews({ defaultViewId = '', initialActiveSavedViewId = '', failFirstLoad = false } = {}) {
  savedViewsFixture = {
    calls: [],
    announced: [],
    failNextList: failFirstLoad,
    screen: { filters: { status: 'Active' }, visibleColumns: ['a'] },
    views: [
      { id: 'alpha', name: 'Alpha', scope: 'personal', reportId: 'wastage', viewId: 'line_detail', isDefault: defaultViewId === 'alpha', filters: { status: 'Active' }, visibleColumns: ['a'] },
      { id: 'beta', name: 'Beta', scope: 'personal', reportId: 'wastage', viewId: 'line_detail', isDefault: defaultViewId === 'beta', filters: { status: 'Void' }, visibleColumns: ['b'] }
    ]
  };
  if (!savedViewsApiStubbed) {
    savedViewsApiStubbed = true;
    mock.module(new URL('./scheduling/reportSchedulingApi.js', import.meta.url).href, {
      namedExports: {
        listSavedViews: async () => {
          if (savedViewsFixture.failNextList) {
            savedViewsFixture.failNextList = false;
            throw new Error('network down');
          }
          return savedViewsFixture.views.map((view) => ({ ...view }));
        },
        updateSavedView: async (workspaceId, viewId, payload) => {
          savedViewsFixture.calls.push({ op: 'update', viewId, payload });
          if (payload?.isDefault) savedViewsFixture.views.forEach((view) => { view.isDefault = view.id === viewId; });
          return { ok: true };
        },
        createSavedView: async (workspaceId, payload) => { savedViewsFixture.calls.push({ op: 'create', payload }); return { ok: true }; },
        deleteSavedView: async (workspaceId, viewId) => { savedViewsFixture.calls.push({ op: 'delete', viewId }); return { ok: true }; }
      }
    });
  }
  const { renderSavedViewsControl } = await import('./savedViews/SavedViewsControl.js');

  const fixture = savedViewsFixture;
  const root = renderSavedViewsControl({
    workspaceId: 'ws1',
    reportId: 'wastage',
    viewId: 'line_detail',
    initialActiveSavedViewId,
    getConfiguration: () => ({ ...fixture.screen }),
    onLoad: (view) => {
      fixture.screen = { filters: { ...view.filters }, visibleColumns: [...view.visibleColumns] };
    },
    onDefaultAvailable: (view) => {
      fixture.announced.push(view.id);
      fixture.screen = { filters: { ...view.filters }, visibleColumns: [...view.visibleColumns] };
    }
  });
  document.body.append(root);
  await settle();
  return { root, announced: fixture.announced, updates: () => fixture.calls.filter((call) => call.op === 'update') };
}

test('B2: starring a view as default never retargets a later Update', { skip: NO_DOM || NO_MODULE_MOCK }, async () => {
  setupDom();
  const { root, announced, updates } = await mountSavedViews();

  root.querySelector('[data-saved-view-load="alpha"]').click();
  await settle();
  root.querySelector('[data-saved-view-default="beta"]').click();
  await settle();
  root.querySelector('[data-saved-view-update]').click();
  await settle();

  assert.deepEqual(updates().at(-2), { op: 'update', viewId: 'beta', payload: { isDefault: true } },
    'starring may only flip isDefault on the starred view');
  assert.equal(updates().at(-1).viewId, 'alpha', 'Update must target the explicitly loaded view');
  assert.deepEqual(updates().at(-1).payload.filters, { status: 'Active' },
    "Alpha's own configuration, not Beta's");
  assert.deepEqual(announced, [], 'starring must not re-announce a default and pull the screen elsewhere');
});

test('B2: an existing default is still announced and adopted on first load', { skip: NO_DOM || NO_MODULE_MOCK }, async () => {
  setupDom();
  const { root, announced, updates } = await mountSavedViews({ defaultViewId: 'beta' });
  await settle();
  assert.deepEqual(announced, ['beta'], 'the default-available notification still fires on load');

  root.querySelector('[data-saved-view-update]').click();
  await settle();
  assert.equal(updates().at(-1).viewId, 'beta', 'the adopted default is what Update targets');
  assert.deepEqual(updates().at(-1).payload.filters, { status: 'Void' });
});

test('B2: a default is not announced while another view is already active', { skip: NO_DOM || NO_MODULE_MOCK }, async () => {
  setupDom();
  const { root, announced, updates } = await mountSavedViews({ defaultViewId: 'beta', initialActiveSavedViewId: 'alpha' });
  await settle();

  assert.deepEqual(announced, [],
    'telling the caller to load Beta while Alpha is the active view is the same overwrite by another route');
  root.querySelector('[data-saved-view-update]').click();
  await settle();
  assert.equal(updates().at(-1).viewId, 'alpha', 'Update still targets the already-active view');
  assert.deepEqual(updates().at(-1).payload.filters, { status: 'Active' }, "and writes Alpha's own filters");
});

test('B2: starring a default is never treated as a request to load it', { skip: NO_DOM || NO_MODULE_MOCK }, async () => {
  setupDom();
  // Nothing loaded and no default yet: starring one must not yank the unsaved screen to that view.
  const { root, announced } = await mountSavedViews();
  root.querySelector('[data-saved-view-default="beta"]').click();
  await settle();

  assert.deepEqual(announced, [], 'a default created by the user mid-session is not auto-loaded');
  assert.equal(root.querySelector('[data-saved-view-update]'), null,
    'nothing became the active view, so there is nothing to Update onto');
});

test('B2: a failed first load does not permanently disable default adoption', { skip: NO_DOM || NO_MODULE_MOCK }, async () => {
  setupDom();
  const { root, announced } = await mountSavedViews({ defaultViewId: 'beta', failFirstLoad: true });
  assert.deepEqual(announced, [], 'precondition: the first fetch failed, so nothing was announced');

  // A later successful refresh (here: saving a new view) must still be able to adopt the default.
  root.querySelector('[data-saved-view-save]').click();
  const dialog = document.querySelector('[data-saved-view-form]');
  dialog.querySelector('input[name="name"]').value = 'Fresh view';
  dialog.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  await settle();

  assert.deepEqual(announced, ['beta'], 'the initial-load window survives a failed fetch');
});

test('H1: a range typed into the visible input beats stale hidden fields', { skip: NO_DOM }, () => {
  setupDom();
  const form = renderReportFilters({
    filters: { dateRangeType: 'custom', startDate: '2026-01-01', endDate: '2026-01-31' },
    config: { enabled: ['dateRange'] }
  });
  document.body.append(form);
  form.querySelector('[data-report-date-display]').value = '2026-03-01 → 2026-03-07';

  const applied = readReportFilters(form);
  assert.equal(applied.startDate, '2026-03-01');
  assert.equal(applied.endDate, '2026-03-07');
  assert.equal(form.querySelector('[data-report-start-date]').value, '2026-03-01', 'hidden fields resync to what was applied');
  assert.equal(form.querySelector('[data-report-end-date]').value, '2026-03-07');
});

test('H1: a reversed typed range is ordered instead of returning nothing', { skip: NO_DOM }, () => {
  setupDom();
  const form = renderReportFilters({ filters: { dateRangeType: 'custom' }, config: { enabled: ['dateRange'] } });
  document.body.append(form);
  form.querySelector('[data-report-date-display]').value = '2026-04-20 → 2026-04-02';

  const applied = readReportFilters(form);
  assert.deepEqual([applied.startDate, applied.endDate], ['2026-04-02', '2026-04-20']);
});

test('H4: filters the report does not render are omitted, not returned as empty strings', { skip: NO_DOM }, () => {
  setupDom();
  const form = renderReportFilters({
    filters: {},
    locations: [{ id: 'loc-1', name: 'Kitchen' }],
    config: { enabled: ['dateRange', 'location'] }
  });
  document.body.append(form);

  const filters = readReportFilters(form);
  for (const key of ['status', 'itemType', 'category', 'search', 'supplierId', 'onlyBelowPar']) {
    assert.equal(key in filters, false, `${key} must not be reported by a date/location-only report`);
  }
  assert.equal('locationId' in filters, true, 'rendered filters are still reported');
  assert.equal({ ...{ status: 'Active' }, ...filters }.status, 'Active', 'an omitted filter cannot beat a report default');
});

test('#4: the date-range placeholder option means custom, not "infer for me"', { skip: NO_DOM }, () => {
  setupDom();
  const form = renderReportFilters({ filters: { dateRangeType: 'custom' }, config: { enabled: ['dateRange'] } });
  document.body.append(form);
  form.querySelector('[name="dateRangeType"]').value = ''; // the enhanced-select placeholder

  assert.equal(readReportFilters(form).dateRangeType, 'custom');
});

test('BLOCKER #3: a date-less report keeps the unbounded range, never a one-day window', { skip: NO_DOM }, () => {
  setupDom();
  const form = renderReportFilters({ filters: {}, config: { enabled: ['search', 'status'] }, statuses: ['Active'] });
  document.body.append(form);

  const filters = readReportFilters(form);
  assert.equal('dateRangeType' in filters, false, 'a date-less report reports no date keys at all');
  assert.equal(hasDateRangeContext(filters), false);

  // This is what SavedViewsControl serialises for such a report on save/update/duplicate.
  const serialised = inferDateRangeType(filters);
  assert.equal(serialised, 'custom');
  assert.deepEqual(
    resolveScheduledRelativeRange(serialised, filters),
    { from: '', to: '', startDate: '', endDate: '' },
    'blank custom is the unbounded range the scheduler expects'
  );
  assert.notEqual(resolveScheduledRelativeRange('today', filters).from, '', 'guard: today really would narrow it to a single day');
});

test('H5: inferDateRangeType reflects the dates it is handed', () => {
  assert.equal(inferDateRangeType({ startDate: '2026-02-01', endDate: '2026-02-28' }), 'custom');
  assert.equal(inferDateRangeType({ from: '2026-02-01', to: '2026-02-28' }), 'custom');
  assert.equal(inferDateRangeType({ startDate: '2026-02-01' }), 'custom');
  assert.equal(inferDateRangeType({ dateRangeType: 'last_7_days', startDate: '2026-02-01' }), 'last_7_days');
  assert.equal(inferDateRangeType({ dateRangeType: '', startDate: '', endDate: '' }), 'today', 'date filtering, nothing chosen yet');
  assert.equal(inferDateRangeType({}), 'custom', 'no date filtering at all stays unbounded');
  assert.equal(inferDateRangeType({}, { fallback: 'today' }), 'today', 'callers that must stay bounded say so');
});

test('applyDateRangePreset keeps its historic bounded default for a range-less filter set', () => {
  // This helper predates the unbounded/bounded distinction; a filters object with no range at all
  // must still resolve to today's range, not to an unbounded custom one.
  const applied = applyDateRangePreset({}, { now: new Date('2026-08-21T10:00:00Z') });
  assert.equal(applied.dateRangeType, 'today');
  assert.notEqual(applied.startDate, '');
  assert.equal(applied.startDate, applied.endDate);
});

test('#5: the scheduler execution path shares the same blank-range default', () => {
  const unbounded = normalizeScheduledReportFilters({ reportId: 'wastage', scheduleFilters: { status: 'Active' } });
  assert.equal(unbounded.dateRangeType, 'custom');
  const explicit = normalizeScheduledReportFilters({ reportId: 'wastage', dateRangeType: 'last_7_days', range: { from: '2026-01-01', to: '2026-01-07' } });
  assert.equal(explicit.dateRangeType, 'last_7_days');
});

test('#5: a chosen saved view infers its range through the shared helper', { skip: NO_DOM }, () => {
  setupDom();
  const catalog = getSchedulableReportCatalog();
  const savedView = (id, filters) => ({ id, name: id, scope: 'personal', reportId: 'wastage', viewId: 'line_detail', filters, sort: null, visibleColumns: [] });

  const snapshotRangeFor = (filters) => {
    const savedViews = [savedView('sv-1', filters)];
    const values = normalizeFormValues(SCHEDULE_BASE, {}, catalog, [], true, savedViews, []);
    const host = document.createElement('div');
    host.innerHTML = renderScheduleModal(values, catalog, savedViews, true);
    document.body.append(host);
    const form = host.querySelector('[data-schedule-form]');
    // renderScheduleModal renders one [data-schedule-item-saved-view] select per report×view in
    // the WHOLE catalog (100+ of them), not just for wastage/line_detail — an unscoped
    // querySelector here silently grabs an unrelated report's select instead of this one, which
    // made this test pass or fail by accident of restoreSavedViewSnapshot's separate auto-match
    // heuristic rather than actually exercising "a user picks this saved view from the dropdown".
    const select = [...form.querySelectorAll('[data-schedule-item-saved-view]')]
      .find((entry) => entry.dataset.reportId === 'wastage' && entry.dataset.viewId === 'line_detail');
    select.value = 'sv-1';
    return readScheduleForm(form, catalog, savedViews, values.reportItems).reportItems[0].dateRangeType;
  };

  assert.equal(snapshotRangeFor({}), 'custom', 'a date-less saved view stays unbounded');
  assert.equal(snapshotRangeFor({ dateRangeType: '', startDate: '', endDate: '' }), 'today',
    'a date-filtering saved view with nothing chosen is bounded — not a hardcoded custom');
  assert.equal(snapshotRangeFor({ startDate: '2026-02-01', endDate: '2026-02-28' }), 'custom');
});

test('H5: a legacy schedule row opens as the custom range it really is', { skip: NO_DOM }, () => {
  setupDom();
  // Real dates in filters, no stored dateRangeType (a row written before the field existed).
  const legacy = { ...SCHEDULE_BASE, filters: { startDate: '2026-02-01', endDate: '2026-02-28' } };
  const { values, form, save } = openScheduleForm(legacy);

  assert.equal(values.dateRangeType, 'custom', 'the edit modal must not label a real range "today"');
  assert.equal(form.querySelector('[name="dateRangeType"]').value, 'custom');
  assert.equal(form.querySelector('[name="customFrom"]').value, '2026-02-01');
  assert.equal(form.querySelector('[name="customTo"]').value, '2026-02-28');

  form.querySelector('[name="name"]').value = 'Renamed only';
  const payload = save();
  assert.equal(payload.dateRangeType, 'custom');
  assert.deepEqual(
    { startDate: payload.filters.startDate, endDate: payload.filters.endDate },
    { startDate: '2026-02-01', endDate: '2026-02-28' },
    'saving an unrelated field must not destroy the stored range'
  );

  // A row with no range at all still opens bounded, exactly as before.
  assert.equal(openScheduleForm({ ...SCHEDULE_BASE, filters: {} }).values.dateRangeType, 'today');
});

test('H2: a stored location outside the permitted list survives an unrelated edit', { skip: NO_DOM }, () => {
  setupDom();
  const permitted = [{ id: 'loc-alpha', name: 'Alpha Cafe' }, { id: 'loc-zulu', name: 'Zulu Bar' }];
  const { values, form, save } = openScheduleForm(
    { ...SCHEDULE_BASE, locationMode: 'selected', locationIds: ['loc-kitchen'] },
    { permitted }
  );
  assert.equal(values.locationSelection, 'loc-kitchen');
  form.querySelector('[name="name"]').value = 'Kitchen wastage (renamed)';

  const payload = save();
  assert.deepEqual(payload.locationIds, ['loc-kitchen'], 'must not be retargeted at a permitted location');
  assert.equal(payload.locationId, 'loc-kitchen');
  assert.equal(payload.name, 'Kitchen wastage (renamed)');
});

test('H2: an all-locations schedule is not narrowed for a location-restricted user', { skip: NO_DOM }, () => {
  setupDom();
  const permitted = [{ id: 'loc-alpha', name: 'Alpha Cafe' }];
  const { form, save } = openScheduleForm(
    { ...SCHEDULE_BASE, locationMode: 'all', locationIds: [] },
    { permitted, allowAllLocations: false }
  );
  assert.equal(form.querySelector('[name="locationSelection"]').value, 'all');

  const payload = save();
  assert.equal(payload.locationMode, 'all');
  assert.deepEqual(payload.locationIds, []);
});

test('H2: an explicit dropdown pick still changes the target', { skip: NO_DOM }, () => {
  setupDom();
  const permitted = [{ id: 'loc-alpha', name: 'Alpha Cafe' }, { id: 'loc-zulu', name: 'Zulu Bar' }];
  const { form, save } = openScheduleForm({ ...SCHEDULE_BASE, locationMode: 'selected', locationIds: ['loc-alpha'] }, { permitted });
  form.querySelector('[name="locationSelection"]').value = 'loc-zulu';

  assert.deepEqual(save().locationIds, ['loc-zulu']);
});

test('#7: a selected-mode schedule with no stored location never silently widens to all', { skip: NO_DOM }, () => {
  setupDom();
  const permitted = [{ id: 'loc-alpha', name: 'Alpha Cafe' }, { id: 'loc-zulu', name: 'Zulu Bar' }];
  const { values, form, save } = openScheduleForm({ ...SCHEDULE_BASE, locationMode: 'selected', locationIds: [] }, { permitted });

  assert.equal(values.locationSelection, '');
  assert.equal(form.querySelector('[name="locationSelection"]').value, '', 'the browser must not fall through to All Locations');
  assert.throws(save, /Select a location/, 'corrupt scope demands an explicit choice instead of an invented one');
});

test('H3: toSchedulePayload round-trips a legacy schedule instead of widening it', () => {
  const catalog = getSchedulableReportCatalog();
  const legacy = {
    ...SCHEDULE_BASE,
    locationIds: ['loc-kitchen'],
    filters: { startDate: '2026-02-01', endDate: '2026-02-28' }
  };
  const payload = { ...toSchedulePayload(legacy, catalog), isEnabled: false };
  assert.equal(payload.locationMode, 'selected', 'populated locationIds must not be reported as all-locations');
  assert.deepEqual(payload.locationIds, ['loc-kitchen']);
  assert.equal(payload.locationId, 'loc-kitchen');
  assert.equal(payload.dateRangeType, 'custom');
  assert.equal(payload.isEnabled, false);

  const single = toSchedulePayload({ ...legacy, locationIds: undefined, locationId: 'loc-bar' }, catalog);
  assert.equal(single.locationMode, 'selected');
  assert.deepEqual(single.locationIds, ['loc-bar']);

  const all = toSchedulePayload({ ...legacy, locationIds: [], locationMode: 'all' }, catalog);
  assert.equal(all.locationMode, 'all');
  assert.deepEqual(all.locationIds, []);

  const bare = toSchedulePayload({ ...legacy, filters: {} }, catalog);
  assert.equal(bare.dateRangeType, 'today', 'a schedule with no range at all stays bounded');
});

test('#8: pre-existing half a custom range does not block an unrelated edit', { skip: NO_DOM }, () => {
  setupDom();
  const legacy = { ...SCHEDULE_BASE, dateRangeType: 'custom', filters: { startDate: '2026-02-01' } };

  const untouched = openScheduleForm(legacy);
  untouched.form.querySelector('[name="recipients"]').value = 'newchef@example.com';
  const payload = untouched.save();
  assert.deepEqual(payload.recipients, ['newchef@example.com']);
  assert.equal('from' in payload.filters, false, 'the unusable half-range is dropped, as it always was');

  const edited = openScheduleForm(legacy);
  edited.form.querySelector('[name="customFrom"]').value = '2026-05-01';
  assert.throws(edited.save, /Select both custom dates/, 'editing the range itself is still validated');
});
