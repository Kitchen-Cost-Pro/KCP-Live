import styles from './styles/dashboard.module.css';
import {
  loadDashboardReportingModel,
  reconcileDashboardLocationNames
} from './dashboardData.js';
import { fetchWorkspaceLocationOptions } from './services/locationService.js';
import { mergeCanonicalLocations } from './utils/locationDisplayName.js';
import { positionDashboardSelectMenu } from './utils/dashboardDropdown.js';
import {
  loadLowStockNotificationSettings,
  saveLowStockNotificationSettings,
  acknowledgeLowStockItem,
  acknowledgeAllLowStockItems,
  unacknowledgeLowStockItem
} from './services/notificationService.js';

const DASHBOARD_CACHE_TTL = 60_000;
const dashboardCache = new Map();
// A background data-version poll can silently trigger a full renderDashboard() remount (a fresh
// `ui` object + DOM tree) while the user is mid-interaction with the mute/unmute checkboxes — see
// renderActiveSection in appShell.js, which calls renderDashboard() fresh on every app re-render,
// not just on navigation. Keying these two Sets by workspace and reusing the same instances across
// remounts means a checkbox selection or an in-flight mute/unmute request survives a remount
// instead of silently resetting (which looked like "clicking does nothing" / a stuck spinner).
const dashboardAckStateByWorkspace = new Map();
function getDashboardAckState(workspaceId) {
  let state = dashboardAckStateByWorkspace.get(workspaceId);
  if (!state) {
    state = { ackPendingKeys: new Set(), selectedAckKeys: new Set() };
    dashboardAckStateByWorkspace.set(workspaceId, state);
  }
  return state;
}
const SERIES = [
  { key: 'cos', label: 'Cost of Sales', color: '#00e5a0' },
  { key: 'adjustments', label: 'Adjustments', color: '#f5a623' },
  { key: 'wastage', label: 'Wastage', color: '#ff4455' },
  { key: 'mfgWastage', label: 'Manufacture Wastage', color: '#7b61ff' }
];
const SUPPLIER_COLORS = ['#00e5a0', '#f5a623', '#7b61ff', '#00b3ff', '#ff4455'];
const RANGE_PRESETS = [
  ['today', 'Today'],
  ['this_week', 'This Week'],
  ['two_weeks', '2 Weeks'],
  ['month', 'This month'],
  ['3m', 'Last 3 months'],
  ['6m', 'Last 6 months'],
  ['12m', 'Last 12 months'],
  ['ytd', 'Year to date'],
  ['custom', 'Custom range']
];

export function renderDashboard({ state = {}, onNavigate, onStockFilterChange } = {}) {
  const workspaceId = String(state.workspace?.id || '');
  const workspaceName = state.workspace?.siteName || state.source?.settings?.siteName || 'Workspace';
  const initialRange = getPresetRange('today');
  const view = document.createElement('section');
  view.className = styles.shell;
  view.setAttribute('aria-label', 'Main dashboard');
  view.dataset.dashboardWorkspace = workspaceId;

  const ui = {
    search: '',
    category: 'All',
    sortCol: 'status',
    sortDir: 'desc',
    activeSeries: new Set(SERIES.map((series) => series.key)),
    visibleRows: 75,
    model: null,
    loading: true,
    error: '',
    requestId: 0,
    locationId: '',
    locationOptions: [],
    inventoryLocationId: '',
    openSelect: '',
    rangePreset: 'today',
    from: initialRange.from,
    to: initialRange.to,
    calendarOpen: false,
    calendarCursor: startOfCalendarMonth(initialRange.from),
    pendingRangeStart: '',
    notificationsOpen: false,
    notificationSettingsOpen: false,
    notificationSettingsStatus: 'idle',
    notificationSettingsMessage: '',
    notificationDispatchTime: '08:00',
    notificationRecipientIds: new Set(),
    notificationWorkspaceUsers: [],
    ackAllPending: false,
    ...getDashboardAckState(workspaceId)
  };

  renderLoading(view, workspaceName);
  const initialCacheKey = getDashboardCacheKey(workspaceId, ui);
  const cached = dashboardCache.get(initialCacheKey);
  if (cached?.model && Date.now() - cached.loadedAt < DASHBOARD_CACHE_TTL) {
    ui.model = cached.model;
    ui.locationOptions = mergeLocationOptions(ui.locationOptions, cached.model.locations);
    syncInventoryLocation(ui, cached.model);
    ui.loading = false;
    renderModel(view, ui, { workspaceName, onNavigate, onStockFilterChange, workspaceId });
  } else {
    loadModel(false);
  }

  async function loadModel(force = false) {
    const requestId = ++ui.requestId;
    ui.loading = true;
    ui.error = '';
    if (!ui.model) renderLoading(view, workspaceName);
    else setRefreshing(view, true);

    try {
      const model = await getDashboardModel(workspaceId, ui, force);
      if (!document.contains(view) || view.dataset.dashboardWorkspace !== workspaceId || requestId !== ui.requestId) return;
      ui.model = model;
      ui.locationOptions = mergeLocationOptions(ui.locationOptions, model.locations);
      syncInventoryLocation(ui, model);
      ui.loading = false;
      ui.visibleRows = 75;
      renderModel(view, ui, { workspaceName, onNavigate, onStockFilterChange, workspaceId });
    } catch (error) {
      if (!document.contains(view) || requestId !== ui.requestId) return;
      ui.loading = false;
      ui.error = error?.message || 'The dashboard could not load.';
      renderError(view, ui.error, () => loadModel(true));
    }
  }

  async function getDashboardModel(workspaceKey, dashboardUi, force) {
    const key = getDashboardCacheKey(workspaceKey, dashboardUi);
    if (force) dashboardCache.delete(key);
    const entry = dashboardCache.get(key);
    if (entry?.promise) return entry.promise;
    if (entry?.model && Date.now() - entry.loadedAt < DASHBOARD_CACHE_TTL) return entry.model;

    const stateLocations = getKnownStateLocations(state);
    const promise = Promise.all([
      loadDashboardReportingModel({
        workspaceId: workspaceKey,
        filters: {
          from: dashboardUi.from,
          to: dashboardUi.to,
          locationId: dashboardUi.locationId
        },
        services: { reporting: {} }
      }),
      fetchWorkspaceLocationOptions(workspaceKey).catch(() => stateLocations)
    ])
      .then(([model, fetchedLocations]) => {
        const canonicalLocations = mergeCanonicalLocations(stateLocations, fetchedLocations);
        const resolvedModel = reconcileDashboardLocationNames(model, canonicalLocations);
        dashboardCache.set(key, { model: resolvedModel, loadedAt: Date.now(), promise: null });
        return resolvedModel;
      })
      .catch((error) => {
        dashboardCache.delete(key);
        throw error;
      });
    dashboardCache.set(key, { promise, model: entry?.model || null, loadedAt: entry?.loadedAt || 0 });
    return promise;
  }

  view.__dashboardRefresh = () => loadModel(true);
  view.__dashboardApplyFilters = () => loadModel(false);
  return view;
}

function getKnownStateLocations(state = {}) {
  return mergeCanonicalLocations(
    state.locations?.items,
    state.stock?.locations,
    state.stockTake?.locations,
    state.transfers?.locations,
    state.purchaseOrders?.locations,
    state.grv?.locations,
    state.creditNotes?.locations,
    state.adjustments?.locations,
    state.manufacturing?.locations
  );
}

function getDashboardCacheKey(workspaceId, ui = {}) {
  return [workspaceId, ui.from || '', ui.to || '', ui.locationId || 'all'].join('::');
}

function mergeLocationOptions(existing = [], incoming = []) {
  const options = new Map();
  [...existing, ...incoming].forEach((location) => {
    const id = String(location?.id || '').trim();
    if (!id) return;
    const name = String(location?.name || id).trim() || id;
    if (!options.has(id) || options.get(id).name === id) options.set(id, { id, name });
  });
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }));
}

function getInventoryLocationOptions(model = {}) {
  const source = Array.isArray(model.inventoryLocations) && model.inventoryLocations.length
    ? model.inventoryLocations
    : (model.inventoryItems || []).map((item) => ({ id: item.locationId, name: item.locationName }));
  return mergeLocationOptions([], source);
}

function syncInventoryLocation(ui, model = {}) {
  const options = getInventoryLocationOptions(model);
  if (ui.locationId && options.some((location) => location.id === ui.locationId)) {
    ui.inventoryLocationId = ui.locationId;
    return;
  }
  if (options.some((location) => location.id === ui.inventoryLocationId)) return;
  ui.inventoryLocationId = options[0]?.id || '';
}

function getScopedInventoryItems(ui) {
  const items = Array.isArray(ui.model?.inventoryItems) ? ui.model.inventoryItems : [];
  if (!ui.inventoryLocationId) return items;
  return items.filter((item) => String(item.locationId || '') === ui.inventoryLocationId);
}

function getScopedInventoryAlerts(ui) {
  // Muted items no longer need immediate attention — they're excluded from this banner (and its
  // count/name list) the same way they're excluded from the daily email, even though they still
  // show up in the low/critical worklist table below so a user can see and unmute them.
  const items = getScopedInventoryItems(ui).filter((item) => !item.acknowledged);
  const critical = items.filter((item) => item.status === 'critical');
  const low = items.filter((item) => item.status === 'low');
  return {
    criticalCount: critical.length,
    lowCount: low.length,
    criticalNames: critical.slice(0, 3).map((item) => item.name),
    locationName: getInventoryLocationOptions(ui.model).find((location) => location.id === ui.inventoryLocationId)?.name || ''
  };
}

function getNotificationInventoryItems(ui) {
  const items = Array.isArray(ui.model?.inventoryItems) ? ui.model.inventoryItems : [];
  if (!ui.locationId) return items;
  return items.filter((item) => String(item.locationId || '') === ui.locationId);
}

function getNotificationInventoryAlerts(ui) {
  const items = getNotificationInventoryItems(ui).filter((item) => !item.acknowledged);
  const critical = items.filter((item) => item.status === 'critical');
  const low = items.filter((item) => item.status === 'low');
  return {
    criticalCount: critical.length,
    lowCount: low.length,
    criticalNames: critical.slice(0, 3).map((item) => item.name),
    locationName: ui.locationId
      ? ui.locationOptions.find((location) => location.id === ui.locationId)?.name || 'Selected location'
      : 'All permitted locations'
  };
}

function startOfCalendarMonth(value = '') {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  const now = new Date();
  return match
    ? new Date(Number(match[1]), Number(match[2]) - 1, 1)
    : new Date(now.getFullYear(), now.getMonth(), 1);
}

function getPresetRange(preset = 'today', now = new Date()) {
  const anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let from = new Date(anchor);
  if (preset === 'this_week') {
    const mondayOffset = (anchor.getDay() + 6) % 7;
    from = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - mondayOffset);
  }
  if (preset === 'two_weeks') from = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 13);
  if (preset === 'month') from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  if (preset === '3m') from = new Date(anchor.getFullYear(), anchor.getMonth() - 2, 1);
  if (preset === '6m') from = new Date(anchor.getFullYear(), anchor.getMonth() - 5, 1);
  if (preset === '12m') from = new Date(anchor.getFullYear(), anchor.getMonth() - 11, 1);
  if (preset === 'ytd') from = new Date(anchor.getFullYear(), 0, 1);
  return { from: formatDateInput(from), to: formatDateInput(anchor) };
}

function formatDateInput(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function todayKey() {
  return formatDateInput(new Date());
}

function normalizeDateKey(value = '') {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return '';
  return formatDateInput(date);
}

function renderLoading(view, workspaceName) {
  view.innerHTML = `
    <div class="${styles.loadingWrap}" role="status" aria-live="polite">
      <div class="${styles.loadingHeader}">
        <div class="${styles.loadingBrand}"></div>
        <div><span></span><span></span></div>
      </div>
      <div class="${styles.loadingGrid}">${Array.from({ length: 4 }, () => `<div></div>`).join('')}</div>
      <div class="${styles.loadingPanels}"><div></div><div></div></div>
      <div class="${styles.loadingTable}"></div>
      <p>Loading ${escapeHtml(workspaceName)} reporting data…</p>
    </div>
  `;
}

function renderError(view, message, onRetry) {
  view.innerHTML = `
    <div class="${styles.errorState}" role="alert">
      ${icon('alert', 24)}
      <p>Dashboard unavailable</p>
      <span>${escapeHtml(message)}</span>
      <button type="button" data-dashboard-retry>${icon('refresh', 14)} Retry</button>
    </div>
  `;
  view.querySelector('[data-dashboard-retry]')?.addEventListener('click', onRetry);
}

function renderDashboardSelect({ kind, label, value, options = [], open = false, displayValue = '', calendarHtml = '' } = {}) {
  const selected = options.find(([optionValue]) => optionValue === value);
  const selectedLabel = displayValue || selected?.[1] || options[0]?.[1] || 'Select';
  return `
    <div class="${styles.customField}" data-dashboard-custom-select="${escapeAttribute(kind)}">
      <span class="${styles.customFieldLabel}">${escapeHtml(label)}</span>
      <button type="button" class="${styles.customSelectButton}" aria-haspopup="listbox" aria-expanded="${open}" data-dashboard-select-button="${escapeAttribute(kind)}">
        <span>${escapeHtml(selectedLabel)}</span>
        ${icon('chevronDown', 14)}
      </button>
      <div class="${styles.customSelectMenu} ${open ? styles.customSelectMenuOpen : ''}" role="listbox" aria-label="${escapeAttribute(label)}" ${open ? '' : 'hidden'} data-dashboard-select-menu="${escapeAttribute(kind)}">
        ${options.map(([optionValue, optionLabel]) => `
          <button type="button" role="option" aria-selected="${optionValue === value}" class="${styles.customSelectOption} ${optionValue === value ? styles.customSelectOptionSelected : ''}" data-dashboard-select-option="${escapeAttribute(kind)}" data-value="${escapeAttribute(optionValue)}">
            <span>${escapeHtml(optionLabel)}</span>
            ${optionValue === value ? icon('check', 13) : ''}
          </button>
        `).join('')}
      </div>
      ${calendarHtml}
    </div>
  `;
}

function getRangePresetLabel(preset = '6m') {
  return RANGE_PRESETS.find(([value]) => value === preset)?.[1] || 'Date range';
}

function renderDateRangeCalendar(ui) {
  if (ui.rangePreset !== 'custom' || !ui.calendarOpen) return '';
  const cursor = ui.calendarCursor instanceof Date && Number.isFinite(ui.calendarCursor.getTime())
    ? ui.calendarCursor
    : startOfCalendarMonth(ui.from);
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = firstDay.getDay();
  const selectedStart = ui.pendingRangeStart || ui.from;
  const selectedEnd = ui.pendingRangeStart ? '' : ui.to;
  const cells = [];
  for (let index = 0; index < leading; index += 1) cells.push(`<span class="${styles.calendarDayEmpty}"></span>`);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const value = formatDateInput(new Date(year, month, day));
    const isStart = value === selectedStart;
    const isEnd = value === selectedEnd;
    const isInRange = Boolean(selectedStart && selectedEnd && value > selectedStart && value < selectedEnd);
    const isToday = value === todayKey();
    const isFuture = value > todayKey();
    cells.push(`
      <button type="button" class="${styles.calendarDay} ${isStart || isEnd ? styles.calendarDaySelected : ''} ${isInRange ? styles.calendarDayInRange : ''} ${isToday ? styles.calendarDayToday : ''}" data-dashboard-calendar-date="${escapeAttribute(value)}" ${isFuture ? 'disabled' : ''} aria-label="${escapeAttribute(new Date(year, month, day).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }))}">${day}</button>
    `);
  }
  const monthLabel = cursor.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
  const instruction = ui.pendingRangeStart ? 'Select an end date' : 'Select a start date, then an end date';
  return `
    <div class="${styles.dateCalendar}" role="dialog" aria-label="Choose a custom dashboard date range" data-dashboard-date-calendar>
      <div class="${styles.calendarHeader}">
        <button type="button" data-dashboard-calendar-shift="-1" aria-label="Previous month">${icon('chevronLeft', 15)}</button>
        <div><strong>${escapeHtml(monthLabel)}</strong><span>${escapeHtml(instruction)}</span></div>
        <button type="button" data-dashboard-calendar-shift="1" aria-label="Next month">${icon('chevronRight', 15)}</button>
      </div>
      <div class="${styles.calendarWeekdays}" aria-hidden="true"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
      <div class="${styles.calendarGrid}">${cells.join('')}</div>
      <div class="${styles.calendarFooter}">
        <span>${ui.pendingRangeStart ? `${formatShortDate(ui.pendingRangeStart)} → Select end` : `${formatShortDate(ui.from)} → ${formatShortDate(ui.to)}`}</span>
        <button type="button" data-dashboard-calendar-cancel>Cancel</button>
      </div>
    </div>
  `;
}

function formatShortDate(value = '') {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '—';
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderModel(view, ui, context) {
  const model = ui.model;
  syncInventoryLocation(ui, model);
  const inventoryAlerts = getNotificationInventoryAlerts(ui);
  const criticalCount = inventoryAlerts.criticalCount;
  const attentionCount = inventoryAlerts.criticalCount + inventoryAlerts.lowCount;
  const alertNames = inventoryAlerts.criticalNames.join(', ');
  const selectedLocation = ui.locationOptions.find((location) => location.id === ui.locationId);

  view.innerHTML = `
    <div class="${styles.frame}">
      <header class="${styles.topbar}">
        <div class="${styles.brandBlock}">
          <div class="${styles.brandIcon}">${icon('package', 14)}</div>
          <div>
            <h1>STOCKROOM</h1>
            <p>${escapeHtml(context.workspaceName)} · ${escapeHtml(model.dateLabel)}</p>
          </div>
        </div>
        <div class="${styles.topbarActions}">
          <button type="button" class="${styles.refreshButton}" aria-label="Refresh dashboard" title="Refresh dashboard" data-dashboard-refresh>${icon('refresh', 14)}<span>Refresh</span></button>
          <div class="${styles.notificationWrap}" data-dashboard-notification-wrap>
            <button type="button" class="${styles.iconButton} ${ui.notificationsOpen ? styles.iconButtonActive : ''}" aria-label="Open stock notifications" title="Stock notifications" aria-expanded="${ui.notificationsOpen}" aria-controls="dashboard-stock-notifications" data-dashboard-alert-button>
              ${icon('bell', 15)}
              ${attentionCount ? `<span class="${styles.notificationCount}">${attentionCount > 99 ? '99+' : attentionCount}</span>` : ''}
            </button>
            <div id="dashboard-stock-notifications" class="${styles.notificationMenu}" data-dashboard-notification-menu ${ui.notificationsOpen ? '' : 'hidden'}></div>
          </div>
          <button type="button" class="${styles.iconButton}" aria-label="Open business settings" title="Open business settings" data-dashboard-settings>${icon('settings', 15)}</button>
        </div>
      </header>

      <section class="${styles.filterBar}" aria-label="Dashboard filters">
        <div class="${styles.filterControls}">
          ${renderDashboardSelect({
            kind: 'location',
            label: 'Location',
            value: ui.locationId,
            options: [['', 'All locations'], ...ui.locationOptions.map((location) => [location.id, location.name])],
            open: ui.openSelect === 'location'
          })}
          ${renderDashboardSelect({
            kind: 'range',
            label: 'Date range',
            value: ui.rangePreset,
            options: RANGE_PRESETS,
            open: ui.openSelect === 'range',
            displayValue: ui.rangePreset === 'custom' ? `Custom · ${model.trendRangeLabel}` : getRangePresetLabel(ui.rangePreset),
            calendarHtml: renderDateRangeCalendar(ui)
          })}
        </div>
        <div class="${styles.filterSummary}">
          ${icon('filter', 13)}
          <span>${escapeHtml(selectedLocation?.name || 'All locations')} · ${escapeHtml(model.trendRangeLabel)}</span>
        </div>
      </section>

      <main class="${styles.body}" data-dashboard-body>
        <section class="${styles.kpiGrid}" aria-label="Dashboard key performance indicators">
          ${kpiCard({ label: 'Total Stock Value', value: money(model.metrics.totalStockValue), delta: model.metrics.totalStockValueDelta, iconName: 'package', accent: '#00e5a0' })}
          ${kpiCard({ label: 'Cost of Sales', value: money(model.metrics.costOfSales), sub: model.currentPeriodLabel, delta: model.metrics.costOfSalesDelta, iconName: 'money', accent: '#f5a623', invert: true })}
          ${kpiCard({ label: 'Wastage', value: money(model.metrics.wastage), sub: model.metrics.wastagePercentOfCos === null ? model.currentPeriodLabel : `${decimal(model.metrics.wastagePercentOfCos)}% of COS · ${model.currentPeriodLabel}`, delta: model.metrics.wastageDelta, iconName: 'trendDown', accent: '#ff4455', invert: true })}
          ${kpiCard({ label: 'Gross Margin', value: model.metrics.grossMargin === null ? '—' : `${decimal(model.metrics.grossMargin)}%`, sub: model.metrics.netSales ? `Net sales ${compactMoney(model.metrics.netSales)}` : 'No sales recorded', delta: model.metrics.grossMarginDelta, iconName: 'activity', accent: '#7b61ff', deltaIsPoints: true })}
        </section>

        <section class="${styles.alertBar} ${criticalCount ? styles.alertBarCritical : styles.alertBarHealthy}" data-dashboard-alert>
          ${icon(criticalCount ? 'alert' : 'check', 14)}
          <p>${criticalCount
            ? `<strong>${criticalCount} item${criticalCount === 1 ? '' : 's'}</strong> critically low and require immediate attention.${alertNames ? ` <span>${escapeHtml(alertNames)}.</span>` : ''}`
            : `<strong>Stock control is clear.</strong> <span>No critical stock items were returned by the reporting engine.</span>`}
          </p>
          ${criticalCount ? '<button type="button" data-dashboard-review-stock>Review stock</button>' : ''}
        </section>

        <section class="${styles.chartGrid}">
          <article class="${styles.panel} ${styles.trendPanel}">
            <div class="${styles.panelHeader}">
              <div>
                <h2>${escapeHtml(model.trendTitle)}</h2>
                <p>${escapeHtml(model.trendRangeLabel)}</p>
              </div>
              <div class="${styles.seriesToggles}" data-dashboard-series-toggles></div>
            </div>
            <div class="${styles.chartStage}" data-dashboard-trend-chart></div>
          </article>

          <article class="${styles.panel} ${styles.supplierPanel}">
            <div class="${styles.panelHeader}">
              <div>
                <h2>Supplier ${model.supplierMode === 'purchase' ? 'Spend' : 'Reorder Value'}</h2>
                <p>${model.supplierMode === 'purchase' ? `% of purchase value · ${escapeHtml(model.currentPeriodLabel)}` : '% of estimated reorder value'}</p>
              </div>
            </div>
            <div data-dashboard-supplier-chart></div>
          </article>
        </section>

        <section class="${styles.inventoryPanel}" data-dashboard-inventory-panel>
          <div class="${styles.inventoryHeader}">
            <div>
              <h2>Inventory — Low &amp; Critical Stock</h2>
              <p data-dashboard-row-count></p>
            </div>
            <div class="${styles.inventoryFilters}">
              <div class="${styles.locationPills}" data-dashboard-inventory-locations aria-label="Inventory location"></div>
              <div class="${styles.categoryStrip}" data-dashboard-categories aria-label="Inventory category"></div>
            </div>
          </div>
          <div class="${styles.tableActions}" data-dashboard-table-actions></div>
          <div class="${styles.tableWrap}" data-dashboard-table-wrap></div>
          <div class="${styles.tableFooter}" data-dashboard-table-footer></div>
        </section>

        ${model.truncated ? `<p class="${styles.dataNote}">${icon('info', 12)} Large datasets were capped for dashboard performance. Open Reporting for the complete ledger.</p>` : ''}
      </main>
    </div>
  `;

  bindDashboardEvents(view, ui, context);
  renderInventoryAlert(view, ui, context);
  renderTrendChart(view, ui);
  renderSupplierChart(view, model);
  renderInventory(view, ui, context);
}

function bindDashboardEvents(view, ui, context) {
  view.__dashboardAbortController?.abort();
  const controller = new AbortController();
  view.__dashboardAbortController = controller;
  const { signal } = controller;

  const closeMenus = (except = '') => {
    view.querySelectorAll('[data-dashboard-select-menu]').forEach((menu) => {
      const kind = menu.dataset.dashboardSelectMenu || '';
      const keepOpen = Boolean(except && kind === except);
      menu.hidden = !keepOpen;
      menu.classList.toggle(styles.customSelectMenuOpen, keepOpen);
      view.querySelector(`[data-dashboard-select-button="${kind}"]`)?.setAttribute('aria-expanded', String(keepOpen));
    });
    ui.openSelect = except;
    if (except) positionDashboardSelectMenu(view, except);
  };

  view.querySelectorAll('[data-dashboard-select-button]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const kind = button.dataset.dashboardSelectButton || '';
      const menu = view.querySelector(`[data-dashboard-select-menu="${kind}"]`);
      const shouldOpen = Boolean(menu?.hidden);
      closeMenus(shouldOpen ? kind : '');
    }, { signal });
  });

  view.querySelectorAll('[data-dashboard-select-option]').forEach((option) => {
    option.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const kind = option.dataset.dashboardSelectOption || '';
      const value = String(option.dataset.value || '');
      closeMenus('');
      if (kind === 'location') {
        if (ui.locationId === value) return;
        ui.locationId = value;
        ui.inventoryLocationId = value || ui.inventoryLocationId;
        ui.category = 'All';
        ui.visibleRows = 75;
        ui.calendarOpen = false;
        ui.pendingRangeStart = '';
        hideChartTooltip(view);
        view.__dashboardApplyFilters?.();
        return;
      }
      if (kind !== 'range') return;
      ui.rangePreset = value || 'today';
      ui.pendingRangeStart = '';
      if (ui.rangePreset === 'custom') {
        ui.calendarOpen = true;
        ui.calendarCursor = startOfCalendarMonth(ui.from || ui.to);
        renderModel(view, ui, context);
        return;
      }
      const range = getPresetRange(ui.rangePreset);
      ui.from = range.from;
      ui.to = range.to;
      ui.calendarOpen = false;
      hideChartTooltip(view);
      view.__dashboardApplyFilters?.();
    }, { signal });
  });

  view.querySelectorAll('[data-dashboard-calendar-shift]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const shift = number(button.dataset.dashboardCalendarShift);
      const cursor = ui.calendarCursor instanceof Date ? ui.calendarCursor : startOfCalendarMonth(ui.from);
      ui.calendarCursor = new Date(cursor.getFullYear(), cursor.getMonth() + shift, 1);
      renderModel(view, ui, context);
    }, { signal });
  });

  view.querySelectorAll('[data-dashboard-calendar-date]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const value = normalizeDateKey(button.dataset.dashboardCalendarDate);
      if (!value || value > todayKey()) return;
      if (!ui.pendingRangeStart) {
        ui.pendingRangeStart = value;
        ui.calendarCursor = startOfCalendarMonth(value);
        renderModel(view, ui, context);
        return;
      }
      const [from, to] = value < ui.pendingRangeStart
        ? [value, ui.pendingRangeStart]
        : [ui.pendingRangeStart, value];
      ui.from = from;
      ui.to = to;
      ui.pendingRangeStart = '';
      ui.calendarOpen = false;
      ui.rangePreset = 'custom';
      hideChartTooltip(view);
      view.__dashboardApplyFilters?.();
    }, { signal });
  });

  view.querySelector('[data-dashboard-calendar-cancel]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    ui.pendingRangeStart = '';
    ui.calendarOpen = false;
    renderModel(view, ui, context);
  }, { signal });

  view.querySelector('[data-dashboard-refresh]')?.addEventListener('click', () => view.__dashboardRefresh?.(), { signal });
  view.querySelector('[data-dashboard-settings]')?.addEventListener('click', () => context.onNavigate?.('settings-business'), { signal });
  view.querySelector('[data-dashboard-alert-button]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeMenus('');
    ui.calendarOpen = false;
    ui.pendingRangeStart = '';
    ui.notificationsOpen = !ui.notificationsOpen;
    renderNotificationCenter(view, ui, context);
  }, { signal });
  view.querySelector('[data-dashboard-review-stock]')?.addEventListener('click', () => {
    const panel = view.querySelector('[data-dashboard-inventory-panel]');
    panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    ui.category = 'All';
    ui.sortCol = 'status';
    ui.sortDir = 'desc';
    renderInventory(view, ui, context);
  }, { signal });
  view.querySelector('[data-dashboard-body]')?.addEventListener('scroll', () => hideChartTooltip(view), { passive: true, signal });
  window.addEventListener('resize', () => {
    if (ui.openSelect) positionDashboardSelectMenu(view, ui.openSelect);
  }, { passive: true, signal });

  document.addEventListener('pointerdown', (event) => {
    if (!document.contains(view)) {
      controller.abort();
      return;
    }
    if (event.target.closest('[data-dashboard-custom-select]')) return;
    if (event.target.closest('[data-dashboard-notification-wrap]')) return;
    closeMenus('');
    if (ui.notificationsOpen) {
      ui.notificationsOpen = false;
      renderNotificationCenter(view, ui, context);
    }
    if (ui.calendarOpen) {
      ui.calendarOpen = false;
      ui.pendingRangeStart = '';
      view.querySelector('[data-dashboard-date-calendar]')?.remove();
    }
  }, { signal });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeMenus('');
    if (ui.notificationsOpen) {
      ui.notificationsOpen = false;
      renderNotificationCenter(view, ui, context);
    }
    if (ui.calendarOpen) {
      ui.calendarOpen = false;
      ui.pendingRangeStart = '';
      view.querySelector('[data-dashboard-date-calendar]')?.remove();
    }
  }, { signal });
}

function renderInventoryAlert(view, ui, context) {
  const root = view.querySelector('[data-dashboard-alert]');
  if (!root) return;
  const alerts = getScopedInventoryAlerts(ui);
  const criticalCount = alerts.criticalCount;
  const names = alerts.criticalNames.join(', ');
  const locationText = alerts.locationName ? ` at ${alerts.locationName}` : '';
  root.classList.toggle(styles.alertBarCritical, criticalCount > 0);
  root.classList.toggle(styles.alertBarHealthy, criticalCount === 0);
  root.innerHTML = `
    ${icon(criticalCount ? 'alert' : 'check', 14)}
    <p>${criticalCount
      ? `<strong>${criticalCount} item${criticalCount === 1 ? '' : 's'}</strong> critically low${escapeHtml(locationText)} and require immediate attention.${names ? ` <span>${escapeHtml(names)}.</span>` : ''}`
      : `<strong>Stock control is clear${escapeHtml(locationText)}.</strong> <span>No critical stock items were returned for this location.</span>`}
    </p>
    ${criticalCount ? '<button type="button" data-dashboard-review-stock>Review stock</button>' : ''}
  `;
  root.querySelector('[data-dashboard-review-stock]')?.addEventListener('click', () => {
    reviewDashboardStock(view, ui, context);
  });
  renderNotificationCenter(view, ui, context);
}

function renderNotificationCenter(view, ui, context) {
  const wrap = view.querySelector('[data-dashboard-notification-wrap]');
  const bell = view.querySelector('[data-dashboard-alert-button]');
  const menu = view.querySelector('[data-dashboard-notification-menu]');
  if (!wrap || !bell || !menu) return;

  const scopedItems = getNotificationInventoryItems(ui);
  const criticalItems = scopedItems.filter((item) => item.status === 'critical');
  const lowItems = scopedItems.filter((item) => item.status === 'low');
  const attentionItems = [...criticalItems, ...lowItems]
    .sort((left, right) => Number(Boolean(left.acknowledged)) - Number(Boolean(right.acknowledged)))
    .slice(0, 8);
  // Muted items still show in the list (so a user can confirm/undo a mute) but don't count toward
  // the badge — the badge should reflect items that still need attention, same as an "unread" count.
  const count = criticalItems.filter((item) => !item.acknowledged).length
    + lowItems.filter((item) => !item.acknowledged).length;
  const locationName = getNotificationInventoryAlerts(ui).locationName;

  bell.classList.toggle(styles.iconButtonActive, ui.notificationsOpen);
  bell.setAttribute('aria-expanded', String(ui.notificationsOpen));
  bell.setAttribute('aria-label', count ? `Open ${count} stock notification${count === 1 ? '' : 's'}` : 'Open stock notifications');
  bell.innerHTML = `${icon('bell', 15)}${count ? `<span class="${styles.notificationCount}">${count > 99 ? '99+' : count}</span>` : ''}`;
  menu.hidden = !ui.notificationsOpen;
  if (!ui.notificationsOpen) return;

  menu.innerHTML = `
    <div class="${styles.notificationHeader}">
      <div>
        <strong>${ui.notificationSettingsOpen ? 'Low-stock email settings' : 'Stock notifications'}</strong>
        <span>${ui.notificationSettingsOpen ? 'Daily workspace alert' : escapeHtml(locationName)}</span>
      </div>
      <div class="${styles.notificationHeaderActions}">
        <button type="button" class="${styles.notificationClose} ${ui.notificationSettingsOpen ? styles.notificationSettingsActive : ''}" aria-label="${ui.notificationSettingsOpen ? 'Back to stock notifications' : 'Configure low-stock email'}" title="${ui.notificationSettingsOpen ? 'Back to notifications' : 'Email settings'}" data-dashboard-notification-settings>${icon(ui.notificationSettingsOpen ? 'arrowLeft' : 'settings', 14)}</button>
        <button type="button" class="${styles.notificationClose}" aria-label="Close stock notifications" data-dashboard-notification-close>${icon('x', 14)}</button>
      </div>
    </div>
    ${ui.notificationSettingsOpen ? renderLowStockNotificationSettings(ui) : renderStockNotificationList({ count, criticalItems, lowItems, attentionItems }, ui)}
  `;

  menu.querySelector('[data-dashboard-notification-close]')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    ui.notificationsOpen = false;
    ui.notificationSettingsOpen = false;
    renderNotificationCenter(view, ui, context);
    bell.focus();
  });

  menu.querySelector('[data-dashboard-notification-settings]')?.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    ui.notificationSettingsOpen = !ui.notificationSettingsOpen;
    renderNotificationCenter(view, ui, context);
    if (ui.notificationSettingsOpen && ui.notificationSettingsStatus === 'idle') {
      await loadDashboardNotificationSettings(view, ui, context);
    }
  });

  menu.querySelector('[data-dashboard-notification-settings-save]')?.addEventListener('click', async () => {
    if (ui.notificationSettingsStatus === 'saving') return;
    const dispatchTime = String(menu.querySelector('[data-dashboard-notification-time]')?.value || '08:00');
    const recipientMemberIds = [...menu.querySelectorAll('[data-dashboard-notification-recipient]:checked')]
      .map((input) => String(input.value || ''))
      .filter(Boolean);
    ui.notificationDispatchTime = dispatchTime;
    ui.notificationRecipientIds = new Set(recipientMemberIds);
    ui.notificationSettingsStatus = 'saving';
    ui.notificationSettingsMessage = '';
    renderNotificationCenter(view, ui, context);
    try {
      const result = await saveLowStockNotificationSettings(context.workspaceId, { dispatchTime, recipientMemberIds });
      applyLowStockNotificationSettings(ui, result);
      ui.notificationSettingsStatus = 'saved';
      ui.notificationSettingsMessage = 'Daily low-stock email settings saved.';
    } catch (cause) {
      ui.notificationSettingsStatus = 'error';
      ui.notificationSettingsMessage = cause?.message || 'Low-stock email settings could not be saved.';
    }
    renderNotificationCenter(view, ui, context);
  });

  menu.querySelector('[data-dashboard-notification-review]')?.addEventListener('click', () => {
    ui.notificationsOpen = false;
    renderNotificationCenter(view, ui, context);
    reviewDashboardStock(view, ui, context);
  });
  menu.querySelector('[data-dashboard-notification-open-stock]')?.addEventListener('click', () => {
    ui.notificationsOpen = false;
    context.onStockFilterChange?.({ query: '' });
    context.onNavigate?.('ingredients');
  });
  menu.querySelectorAll('[data-dashboard-notification-item]').forEach((button) => {
    button.addEventListener('click', () => {
      const itemName = String(button.dataset.itemName || '');
      ui.notificationsOpen = false;
      context.onStockFilterChange?.({ query: itemName });
      context.onNavigate?.('ingredients');
    });
  });
  menu.querySelectorAll('[data-ack-item]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const key = button.dataset.ackItem || '';
      const item = attentionItems.find((row) => itemAckKey(row) === key);
      if (item) handleToggleAcknowledgeItem(view, ui, context, item);
    });
  });
}

function renderStockNotificationList({ count, criticalItems, lowItems, attentionItems }, ui) {
  const totalAttention = criticalItems.length + lowItems.length;
  if (!totalAttention) {
    return `
      <div class="${styles.notificationEmpty}">
        ${icon('check', 20)}
        <strong>All clear</strong>
        <span>No critical or low-stock items at this location.</span>
      </div>
      <div class="${styles.notificationActions}">
        <button type="button" data-dashboard-notification-review>Review on dashboard</button>
        <button type="button" data-dashboard-notification-open-stock>Open Stock Items ${icon('arrowRight', 12)}</button>
      </div>`;
  }
  return `
    <div class="${styles.notificationSummary}">
      <span class="${styles.notificationSummaryCritical}">${criticalItems.length} critical</span>
      <span class="${styles.notificationSummaryLow}">${lowItems.length} low stock</span>
      ${count < totalAttention ? `<span>${totalAttention - count} muted</span>` : ''}
    </div>
    <div class="${styles.notificationList}">
      ${attentionItems.map((item) => notificationItem(item, ui)).join('')}
    </div>
    ${totalAttention > attentionItems.length ? `<p class="${styles.notificationMore}">+${totalAttention - attentionItems.length} more item${totalAttention - attentionItems.length === 1 ? '' : 's'}</p>` : ''}
    <div class="${styles.notificationActions}">
      <button type="button" data-dashboard-notification-review>Review on dashboard</button>
      <button type="button" data-dashboard-notification-open-stock>Open Stock Items ${icon('arrowRight', 12)}</button>
    </div>`;
}

function renderLowStockNotificationSettings(ui) {
  if (ui.notificationSettingsStatus === 'loading') {
    return `<div class="${styles.notificationSettingsState}">${icon('refresh', 16)}<span>Loading workspace users…</span></div>`;
  }
  const users = Array.isArray(ui.notificationWorkspaceUsers) ? ui.notificationWorkspaceUsers : [];
  return `
    <div class="${styles.notificationSettingsPanel}">
      <div class="${styles.notificationSettingsIntro}">
        ${icon('mail', 16)}
        <div><strong>Daily low-stock alert</strong><span>KCP checks low-stock thresholds every day and emails the selected workspace users.</span></div>
      </div>
      <label class="${styles.notificationTimeField}">
        <span>Send time</span>
        <input type="time" value="${escapeAttribute(ui.notificationDispatchTime || '08:00')}" data-dashboard-notification-time />
        <small>Africa/Johannesburg time</small>
      </label>
      <div class="${styles.notificationRecipientSection}">
        <div class="${styles.notificationRecipientHeader}"><span>Email list</span><small>${ui.notificationRecipientIds.size} selected</small></div>
        <div class="${styles.notificationRecipientList}">
          ${users.length ? users.map((user) => `
            <label class="${styles.notificationRecipient}">
              <input type="checkbox" value="${escapeAttribute(user.id)}" data-dashboard-notification-recipient ${ui.notificationRecipientIds.has(String(user.id)) ? 'checked' : ''} />
              <span><strong>${escapeHtml(user.name || user.email)}</strong><small>${escapeHtml(user.email)}</small></span>
            </label>`).join('') : '<p class="' + styles.notificationSettingsEmpty + '">No active workspace users are available.</p>'}
        </div>
      </div>
      ${ui.notificationSettingsMessage ? `<p class="${styles.notificationEmailStatus} ${ui.notificationSettingsStatus === 'error' ? styles.notificationEmailStatusError : ''}">${escapeHtml(ui.notificationSettingsMessage)}</p>` : ''}
      <div class="${styles.notificationSettingsActions}">
        <button type="button" data-dashboard-notification-settings-save ${ui.notificationSettingsStatus === 'saving' ? 'disabled' : ''}>${ui.notificationSettingsStatus === 'saving' ? `${icon('refresh', 12)} Saving…` : 'Save email settings'}</button>
      </div>
    </div>`;
}

async function loadDashboardNotificationSettings(view, ui, context) {
  ui.notificationSettingsStatus = 'loading';
  ui.notificationSettingsMessage = '';
  renderNotificationCenter(view, ui, context);
  try {
    const result = await loadLowStockNotificationSettings(context.workspaceId);
    applyLowStockNotificationSettings(ui, result);
    ui.notificationSettingsStatus = 'ready';
  } catch (cause) {
    ui.notificationSettingsStatus = 'error';
    ui.notificationSettingsMessage = cause?.message || 'Low-stock email settings could not be loaded.';
  }
  renderNotificationCenter(view, ui, context);
}

function applyLowStockNotificationSettings(ui, result = {}) {
  const settings = result.settings || result;
  ui.notificationDispatchTime = String(settings.dispatchTime || '08:00');
  ui.notificationWorkspaceUsers = Array.isArray(settings.users) ? settings.users : [];
  const selected = Array.isArray(settings.recipientMemberIds)
    ? settings.recipientMemberIds
    : ui.notificationWorkspaceUsers.filter((user) => user.selected).map((user) => user.id);
  ui.notificationRecipientIds = new Set(selected.map(String));
}

function notificationItem(item = {}, ui) {
  const status = statusPresentation(item.status);
  const stockText = `${quantity(item.qty)} / ${quantity(item.reorder)} ${item.baseUom || ''}`.trim();
  const key = itemAckKey(item);
  const pending = ui?.ackPendingKeys?.has(key);
  return `
    <div class="${styles.notificationItem} ${item.acknowledged ? styles.notificationItemAcked : ''}">
      <button type="button" class="${styles.notificationItemBody}" data-dashboard-notification-item data-item-name="${escapeAttribute(item.name)}">
        <span class="${styles.notificationItemIcon}" style="--notification-tone:${status.color}">${icon(item.status === 'critical' ? 'alert' : 'trendDown', 13)}</span>
        <span class="${styles.notificationItemCopy}">
          <strong>${escapeHtml(item.name)}</strong>
          <small>${escapeHtml(stockText)}${item.supplier ? ` · ${escapeHtml(item.supplier)}` : ''}</small>
        </span>
      </button>
      <span class="${styles.notificationItemStatus}" style="--notification-tone:${status.color}">${escapeHtml(status.label)}</span>
      <button type="button" class="${styles.iconButton} ${styles.notificationItemAck} ${item.acknowledged ? styles.iconButtonActive : ''}" data-ack-item="${escapeAttribute(key)}" ${pending ? 'disabled' : ''} title="${item.acknowledged ? 'Muted — click to unmute' : 'Mute daily low-stock email for this item'}" aria-label="${item.acknowledged ? 'Unmute low-stock email' : 'Mute low-stock email'}">${pending ? icon('refresh', 12) : icon(item.acknowledged ? 'bellOff' : 'bell', 12)}</button>
    </div>
  `;
}

function reviewDashboardStock(view, ui, context) {
  const panel = view.querySelector('[data-dashboard-inventory-panel]');
  ui.search = '';
  ui.category = 'All';
  ui.sortCol = 'status';
  ui.sortDir = 'desc';
  ui.visibleRows = 75;
  renderInventory(view, ui, context);
  panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderTrendChart(view, ui) {
  const toggleRoot = view.querySelector('[data-dashboard-series-toggles]');
  const chartRoot = view.querySelector('[data-dashboard-trend-chart]');
  if (!toggleRoot || !chartRoot) return;

  toggleRoot.innerHTML = SERIES.map((series) => {
    const active = ui.activeSeries.has(series.key);
    return `<button type="button" class="${styles.seriesToggle} ${active ? styles.seriesToggleActive : ''}" style="--series-color:${series.color}" data-series-key="${series.key}" aria-pressed="${active}"><span></span>${escapeHtml(series.label)}</button>`;
  }).join('');
  toggleRoot.querySelectorAll('[data-series-key]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.seriesKey;
      if (ui.activeSeries.has(key)) {
        if (ui.activeSeries.size === 1) return;
        ui.activeSeries.delete(key);
      } else {
        ui.activeSeries.add(key);
      }
      renderTrendChart(view, ui);
    });
  });

  const width = 800;
  const height = 240;
  const pad = { top: 18, right: 18, bottom: 34, left: 66 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const activeSeries = SERIES.filter((series) => ui.activeSeries.has(series.key));
  const values = ui.model.trend.flatMap((month) => activeSeries.map((series) => number(month[series.key])));
  const rawMax = Math.max(...values, 0);
  const maxY = niceMax(rawMax || 1);
  const xAt = (index) => pad.left + (ui.model.trend.length === 1 ? chartWidth / 2 : (index / (ui.model.trend.length - 1)) * chartWidth);
  const yAt = (value) => pad.top + chartHeight - (number(value) / maxY) * chartHeight;

  const grids = Array.from({ length: 5 }, (_, index) => {
    const value = maxY - (index * maxY / 4);
    const y = pad.top + index * chartHeight / 4;
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="${styles.gridLine}"/><text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" class="${styles.axisText}">${escapeHtml(axisMoney(value))}</text>`;
  }).join('');

  const paths = activeSeries.map((series) => {
    const points = ui.model.trend.map((month, index) => `${xAt(index)},${yAt(month[series.key])}`).join(' ');
    const dots = ui.model.trend.map((month, index) => `<circle cx="${xAt(index)}" cy="${yAt(month[series.key])}" r="3.2" fill="${series.color}" class="${styles.chartDot}"/>`).join('');
    return `<polyline points="${points}" fill="none" stroke="${series.color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="${styles.chartLine}"/>${dots}`;
  }).join('');

  const xLabels = ui.model.trend.map((month, index) => `<text x="${xAt(index)}" y="${height - 10}" text-anchor="middle" class="${styles.axisText}">${escapeHtml(month.label)}</text>`).join('');
  const hoverWidth = chartWidth / Math.max(ui.model.trend.length, 1);
  const hitZones = ui.model.trend.map((month, index) => `<rect x="${xAt(index) - hoverWidth / 2}" y="${pad.top}" width="${hoverWidth}" height="${chartHeight}" fill="transparent" data-trend-index="${index}" tabindex="0" aria-label="${escapeAttribute(month.label)} trend values"/>`).join('');

  chartRoot.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Cost and stock movement trend for ${escapeAttribute(ui.model.trendRangeLabel)}">
      ${grids}${paths}${xLabels}${hitZones}
    </svg>
    <div class="${styles.chartTooltip}" data-dashboard-chart-tooltip hidden></div>
    ${rawMax <= 0 ? `<div class="${styles.chartEmpty}">No movement values recorded for this period.</div>` : ''}
  `;

  const tooltip = chartRoot.querySelector('[data-dashboard-chart-tooltip]');
  const show = (target, event) => {
    const index = number(target.dataset.trendIndex);
    const month = ui.model.trend[index];
    if (!month || !tooltip) return;
    tooltip.innerHTML = `<strong>${escapeHtml(month.label)}</strong>${activeSeries.map((series) => `<span style="color:${series.color}">${escapeHtml(series.label)} <b>${money(month[series.key])}</b></span>`).join('')}`;
    tooltip.hidden = false;
    const bounds = chartRoot.getBoundingClientRect();
    const clientX = event?.clientX || bounds.left + (xAt(index) / width) * bounds.width;
    const left = Math.min(Math.max(clientX - bounds.left + 10, 8), Math.max(bounds.width - 180, 8));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = '18px';
  };
  chartRoot.querySelectorAll('[data-trend-index]').forEach((target) => {
    target.addEventListener('pointerenter', (event) => show(target, event));
    target.addEventListener('pointermove', (event) => show(target, event));
    target.addEventListener('focus', (event) => show(target, event));
    target.addEventListener('blur', () => hideChartTooltip(view));
  });
  chartRoot.addEventListener('pointerleave', () => hideChartTooltip(view));
  chartRoot.addEventListener('pointercancel', () => hideChartTooltip(view));
}

function renderSupplierChart(view, model) {
  const root = view.querySelector('[data-dashboard-supplier-chart]');
  if (!root) return;
  if (!model.suppliers.length) {
    root.innerHTML = `<div class="${styles.supplierEmpty}">${icon('pie', 26)}<strong>No supplier values yet</strong><span>Supplier spend will appear after purchase movements are recorded.</span></div>`;
    return;
  }

  let cursor = 0;
  const stops = model.suppliers.map((supplier, index) => {
    const start = cursor;
    cursor += supplier.percent;
    return `${SUPPLIER_COLORS[index]} ${start}% ${cursor}%`;
  }).join(', ');
  const total = model.suppliers.reduce((sum, supplier) => sum + supplier.value, 0);
  root.innerHTML = `
    <div class="${styles.supplierChartWrap}">
      <div class="${styles.donut}" style="background:conic-gradient(${stops})">
        <div><strong>${compactMoney(total)}</strong><span>${model.supplierMode === 'purchase' ? 'Purchases' : 'Reorder'}</span></div>
      </div>
      <div class="${styles.supplierLegend}">
        ${model.suppliers.map((supplier, index) => `<div><span style="background:${SUPPLIER_COLORS[index]}"></span><p title="${escapeAttribute(supplier.name)}">${escapeHtml(supplier.name)}</p><strong>${decimal(supplier.percent)}%</strong></div>`).join('')}
      </div>
    </div>
  `;
}

function renderInventory(view, ui, context) {
  const model = ui.model;
  const locationsRoot = view.querySelector('[data-dashboard-inventory-locations]');
  const categoriesRoot = view.querySelector('[data-dashboard-categories]');
  const actionsRoot = view.querySelector('[data-dashboard-table-actions]');
  const tableRoot = view.querySelector('[data-dashboard-table-wrap]');
  const countRoot = view.querySelector('[data-dashboard-row-count]');
  const footerRoot = view.querySelector('[data-dashboard-table-footer]');
  if (!locationsRoot || !categoriesRoot || !actionsRoot || !tableRoot || !countRoot || !footerRoot) return;

  const inventoryLocations = getInventoryLocationOptions(model);
  syncInventoryLocation(ui, model);
  locationsRoot.innerHTML = inventoryLocations.map((location) => `
    <button type="button" class="${styles.locationPill} ${ui.inventoryLocationId === location.id ? styles.locationPillActive : ''}" data-inventory-location="${escapeAttribute(location.id)}" aria-pressed="${ui.inventoryLocationId === location.id}">${escapeHtml(location.name)}</button>
  `).join('');
  locationsRoot.querySelectorAll('[data-inventory-location]').forEach((button) => {
    button.addEventListener('click', () => {
      const locationId = String(button.dataset.inventoryLocation || '');
      if (!locationId || locationId === ui.inventoryLocationId) return;
      ui.inventoryLocationId = locationId;
      ui.category = 'All';
      ui.visibleRows = 75;
      renderInventory(view, ui, context);
      renderInventoryAlert(view, ui, context);
    });
  });

  // This panel is a low/critical stock worklist, not a general inventory browser — it always
  // shows only items needing attention. Browse everything (including healthy stock) from the
  // full Stock Items screen via the "Open Stock Items" link below.
  const scopedItems = getScopedInventoryItems(ui).filter((item) => isAttentionStatus(item.status));
  const selectedInventoryLocation = inventoryLocations.find((location) => location.id === ui.inventoryLocationId);

  const categories = ['All', ...new Set(scopedItems.map((item) => item.category).filter(Boolean))];
  if (!categories.includes(ui.category)) ui.category = 'All';
  categoriesRoot.innerHTML = categories.map((category) => `<button type="button" class="${styles.categoryButton} ${ui.category === category ? styles.categoryButtonActive : ''}" data-category="${escapeAttribute(category)}">${escapeHtml(category)}</button>`).join('');
  categoriesRoot.querySelectorAll('[data-category]').forEach((button) => {
    button.addEventListener('click', () => {
      ui.category = button.dataset.category || 'All';
      ui.visibleRows = 75;
      renderInventory(view, ui, context);
    });
  });

  const needle = ui.search.toLowerCase().trim();
  const filtered = scopedItems
    .filter((item) => ui.category === 'All' || item.category === ui.category)
    .filter((item) => !needle || [item.name, item.sku, item.category, item.supplier, item.locationName, ...item.locations].join(' ').toLowerCase().includes(needle))
    .sort((left, right) => compareInventory(left, right, ui.sortCol, ui.sortDir));
  const visible = filtered.slice(0, ui.visibleRows);
  countRoot.textContent = `${filtered.length.toLocaleString('en-ZA')} item${filtered.length === 1 ? '' : 's'} needing attention${selectedInventoryLocation ? ` · ${selectedInventoryLocation.name}` : ''}`;

  const mutableAttentionItems = filtered.filter((item) => isAttentionStatus(item.status) && !item.acknowledged);
  const mutableKeys = new Set(mutableAttentionItems.map((item) => itemAckKey(item)));
  // Selections only ever hold currently-visible, still-mutable items — drop anything that scrolled
  // out of the filtered set or already got muted since it was selected.
  for (const key of ui.selectedAckKeys) {
    if (!mutableKeys.has(key)) ui.selectedAckKeys.delete(key);
  }
  const selectedItems = mutableAttentionItems.filter((item) => ui.selectedAckKeys.has(itemAckKey(item)));

  if (selectedItems.length) {
    actionsRoot.innerHTML = `
      <button type="button" class="${styles.categoryButton}" data-dashboard-ack-selected ${ui.ackAllPending ? 'disabled' : ''}>
        ${ui.ackAllPending ? `${icon('refresh', 12)} Muting…` : `${icon('bellOff', 12)}Mute selected (${selectedItems.length})`}
      </button>
      <button type="button" class="${styles.categoryButton}" data-dashboard-clear-selection ${ui.ackAllPending ? 'disabled' : ''}>Clear selection</button>
      <span>Mutes today's low-stock email for the selected items until they restock and fall low again.</span>
    `;
    actionsRoot.querySelector('[data-dashboard-ack-selected]')?.addEventListener('click', () => {
      handleAcknowledgeAllItems(view, ui, context, selectedItems);
    });
    actionsRoot.querySelector('[data-dashboard-clear-selection]')?.addEventListener('click', () => {
      ui.selectedAckKeys.clear();
      renderInventory(view, ui, context);
    });
  } else if (mutableAttentionItems.length) {
    actionsRoot.innerHTML = `
      <button type="button" class="${styles.categoryButton}" data-dashboard-ack-all ${ui.ackAllPending ? 'disabled' : ''}>
        ${ui.ackAllPending ? `${icon('refresh', 12)} Muting…` : `${icon('bellOff', 12)}Acknowledge all (${mutableAttentionItems.length})`}
      </button>
      <span>Select items below to mute just those, or mute everything shown here.</span>
    `;
    actionsRoot.querySelector('[data-dashboard-ack-all]')?.addEventListener('click', () => {
      handleAcknowledgeAllItems(view, ui, context, mutableAttentionItems);
    });
  } else {
    actionsRoot.innerHTML = '';
  }

  if (!visible.length) {
    const hasAnyAttentionItem = getScopedInventoryItems(ui).some((item) => isAttentionStatus(item.status));
    tableRoot.innerHTML = hasAnyAttentionItem
      ? `<div class="${styles.tableEmpty}">${icon('search', 20)}<strong>No matching items</strong><span>Change the category or location filter.</span></div>`
      : `<div class="${styles.tableEmpty}">${icon('check', 20)}<strong>Stock control is clear</strong><span>No items are currently low or critical at this location.</span></div>`;
    footerRoot.innerHTML = `<button type="button" data-dashboard-open-stock>Open Stock Items</button>`;
  } else {
    const columns = [
      ['sku', 'SKU'], ['name', 'Item Name'], ['category', 'Category'], ['qty', 'Qty'], ['unitCost', 'Unit Cost'], ['totalValue', 'Total Value'], ['status', 'Status'], ['supplier', 'Supplier'], [null, 'Alerts']
    ];
    const visibleMutableKeys = visible.filter((item) => mutableKeys.has(itemAckKey(item))).map((item) => itemAckKey(item));
    const visibleSelectedCount = visibleMutableKeys.filter((key) => ui.selectedAckKeys.has(key)).length;
    const selectAllChecked = visibleMutableKeys.length > 0 && visibleSelectedCount === visibleMutableKeys.length;
    const selectAllIndeterminate = visibleSelectedCount > 0 && !selectAllChecked;
    tableRoot.innerHTML = `
      <table class="${styles.inventoryTable}">
        <thead><tr>
          <th><input type="checkbox" data-select-all-mute aria-label="Select all mutable items shown" ${visibleMutableKeys.length ? '' : 'disabled'} ${selectAllChecked ? 'checked' : ''} /></th>
          ${columns.map(([key, label]) => key ? `<th><button type="button" data-sort="${key}">${escapeHtml(label)} ${sortIcon(ui, key)}</button></th>` : `<th>${escapeHtml(label)}</th>`).join('')}
        </tr></thead>
        <tbody>${visible.map((item) => inventoryRow(item, ui)).join('')}</tbody>
      </table>
    `;
    const selectAllBox = tableRoot.querySelector('[data-select-all-mute]');
    if (selectAllBox) selectAllBox.indeterminate = selectAllIndeterminate;
    selectAllBox?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target.checked) visibleMutableKeys.forEach((key) => ui.selectedAckKeys.add(key));
      else visibleMutableKeys.forEach((key) => ui.selectedAckKeys.delete(key));
      renderInventory(view, ui, context);
    });
    tableRoot.querySelectorAll('[data-sort]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.sort || 'name';
        if (ui.sortCol === key) ui.sortDir = ui.sortDir === 'asc' ? 'desc' : 'asc';
        else { ui.sortCol = key; ui.sortDir = 'asc'; }
        renderInventory(view, ui, context);
      });
    });
    tableRoot.querySelectorAll('[data-stock-item]').forEach((row) => {
      row.addEventListener('click', () => openStockItem(row.dataset.itemName || '', context));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openStockItem(row.dataset.itemName || '', context);
        }
      });
    });
    tableRoot.querySelectorAll('[data-select-item]').forEach((checkbox) => {
      checkbox.addEventListener('click', (event) => event.stopPropagation());
      checkbox.addEventListener('change', () => {
        const key = checkbox.dataset.selectItem || '';
        if (!key) return;
        if (checkbox.checked) ui.selectedAckKeys.add(key);
        else ui.selectedAckKeys.delete(key);
        renderInventory(view, ui, context);
      });
    });
    tableRoot.querySelectorAll('[data-ack-item]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const key = button.dataset.ackItem || '';
        const item = visible.find((row) => itemAckKey(row) === key);
        if (item) handleToggleAcknowledgeItem(view, ui, context, item);
      });
    });

    footerRoot.innerHTML = `
      <span>Showing ${visible.length.toLocaleString('en-ZA')} of ${filtered.length.toLocaleString('en-ZA')}</span>
      <div>
        ${visible.length < filtered.length ? '<button type="button" data-dashboard-load-more>Load more</button>' : ''}
        <button type="button" data-dashboard-open-stock>Open Stock Items ${icon('arrowRight', 12)}</button>
      </div>
    `;
    footerRoot.querySelector('[data-dashboard-load-more]')?.addEventListener('click', () => {
      ui.visibleRows += 75;
      renderInventory(view, ui, context);
    });
  }
  footerRoot.querySelector('[data-dashboard-open-stock]')?.addEventListener('click', () => context.onNavigate?.('ingredients'));
}

function isAttentionStatus(status) {
  return status === 'low' || status === 'critical';
}

function itemAckKey(item) {
  return `${item.itemId || item.id || ''}::${item.locationId || ''}`;
}

// A background remount (see dashboardAckStateByWorkspace's comment) can detach `view` from the
// document while a mute/unmute request is still in flight. Re-rendering a detached node is
// harmless but invisible — the user is looking at whatever view replaced it. Resolving the
// currently-attached view by workspace right before each post-request render keeps the visible
// DOM in sync instead of leaving a spinner stuck on a node nobody can see anymore.
function resolveLiveDashboardView(view, context) {
  if (view.isConnected) return view;
  return document.querySelector(`[data-dashboard-workspace="${context.workspaceId}"]`) || view;
}

async function handleToggleAcknowledgeItem(view, ui, context, item) {
  const key = itemAckKey(item);
  if (ui.ackPendingKeys.has(key)) return;
  const wasAcknowledged = Boolean(item.acknowledged);
  ui.ackPendingKeys.add(key);
  renderInventory(view, ui, context);
  try {
    if (wasAcknowledged) {
      await unacknowledgeLowStockItem(context.workspaceId, { itemId: item.itemId, locationId: item.locationId });
      item.acknowledged = false;
    } else {
      await acknowledgeLowStockItem(context.workspaceId, { itemId: item.itemId, locationId: item.locationId });
      item.acknowledged = true;
    }
  } catch (cause) {
    console.error(`[dashboard] low-stock ${wasAcknowledged ? 'unmute' : 'mute'} failed:`, cause?.message || cause);
  }
  ui.ackPendingKeys.delete(key);
  const liveView = resolveLiveDashboardView(view, context);
  renderInventory(liveView, ui, context);
  renderInventoryAlert(liveView, ui, context);
}

async function handleAcknowledgeAllItems(view, ui, context, items) {
  if (!items.length || ui.ackAllPending) return;
  ui.ackAllPending = true;
  renderInventory(view, ui, context);
  try {
    await acknowledgeAllLowStockItems(context.workspaceId, items.map((item) => ({ itemId: item.itemId, locationId: item.locationId })));
    items.forEach((item) => { item.acknowledged = true; });
  } catch (cause) {
    console.error('[dashboard] low-stock acknowledge-all failed:', cause?.message || cause);
  }
  ui.ackAllPending = false;
  const liveView = resolveLiveDashboardView(view, context);
  renderInventory(liveView, ui, context);
  renderInventoryAlert(liveView, ui, context);
}

function inventoryRow(item, ui) {
  const status = statusPresentation(item.status);
  const qtyClass = item.status === 'critical' ? styles.qtyCritical : item.status === 'low' ? styles.qtyLow : '';
  const key = itemAckKey(item);
  const pending = ui.ackPendingKeys.has(key);
  const ackCell = isAttentionStatus(item.status)
    ? `<button type="button" class="${styles.iconButton} ${item.acknowledged ? styles.iconButtonActive : ''}" data-ack-item="${escapeAttribute(key)}" ${pending ? 'disabled' : ''} title="${item.acknowledged ? 'Muted — click to unmute' : 'Mute daily low-stock email for this item'}" aria-label="${item.acknowledged ? 'Unmute low-stock email' : 'Mute low-stock email'}">${pending ? icon('refresh', 13) : icon(item.acknowledged ? 'bellOff' : 'bell', 13)}</button>`
    : '—';
  const selectable = isAttentionStatus(item.status) && !item.acknowledged;
  const selected = ui.selectedAckKeys.has(key);
  const selectCell = selectable
    ? `<input type="checkbox" data-select-item="${escapeAttribute(key)}" ${selected ? 'checked' : ''} aria-label="Select ${escapeAttribute(item.name)} to mute" />`
    : '';
  return `
    <tr tabindex="0" role="button" data-stock-item data-item-name="${escapeAttribute(item.name)}" title="Open ${escapeAttribute(item.name)} in Stock Items">
      <td>${selectCell}</td>
      <td>${escapeHtml(item.sku || '—')}</td>
      <td><strong>${escapeHtml(item.name)}</strong>${item.locationName ? `<span>${escapeHtml(item.locationName)}</span>` : ''}</td>
      <td>${escapeHtml(item.category)}</td>
      <td class="${qtyClass}">${quantity(item.qty)} <span>/ ${quantity(item.reorder)} ${escapeHtml(item.baseUom)}</span></td>
      <td>${money(item.unitCost)}</td>
      <td>${money(item.totalValue)}</td>
      <td><span class="${styles.statusBadge}" style="--status-color:${status.color}">${status.label}</span></td>
      <td>${escapeHtml(item.supplier || 'Not assigned')}</td>
      <td>${ackCell}</td>
    </tr>
  `;
}

function openStockItem(name, context) {
  context.onStockFilterChange?.({ query: name });
  context.onNavigate?.('ingredients');
}

function kpiCard({ label, value, sub = '', delta = null, iconName, accent, invert = false, deltaIsPoints = false }) {
  const hasDelta = Number.isFinite(delta);
  const positiveDirection = hasDelta && delta >= 0;
  const favourable = hasDelta ? (invert ? !positiveDirection : positiveDirection) : null;
  const deltaText = hasDelta
    ? `${Math.abs(delta).toFixed(1)}${deltaIsPoints ? ' pts' : '%'} vs prior period`
    : 'No prior-period comparison';
  return `
    <article class="${styles.kpiCard}" style="--kpi-accent:${accent}">
      <div><span>${escapeHtml(label)}</span>${icon(iconName, 17)}</div>
      <p><strong>${escapeHtml(value)}</strong>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}</p>
      <footer class="${hasDelta ? (favourable ? styles.deltaGood : styles.deltaBad) : styles.deltaNeutral}">
        ${hasDelta ? icon(positiveDirection ? 'arrowUp' : 'arrowDown', 12) : icon('minus', 12)} ${escapeHtml(deltaText)}
      </footer>
    </article>
  `;
}

function compareInventory(left, right, col, dir) {
  let a = left[col];
  let b = right[col];
  if (col === 'status') {
    a = statusRank(left.status);
    b = statusRank(right.status);
  }
  const result = typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? result : -result;
}

function sortIcon(ui, key) {
  if (ui.sortCol !== key) return `<span class="${styles.sortMuted}">↕</span>`;
  return ui.sortDir === 'asc' ? '↑' : '↓';
}

function statusPresentation(status) {
  if (status === 'critical') return { label: 'CRITICAL', color: '#ff4455' };
  if (status === 'low') return { label: 'LOW STOCK', color: '#f5a623' };
  return { label: 'IN STOCK', color: '#00e5a0' };
}

function statusRank(status) {
  return status === 'critical' ? 3 : status === 'low' ? 2 : 1;
}

function hideChartTooltip(view) {
  const tooltip = view.querySelector('[data-dashboard-chart-tooltip]');
  if (tooltip) tooltip.hidden = true;
}

function setRefreshing(view, refreshing) {
  const button = view.querySelector('[data-dashboard-refresh]');
  if (!button) return;
  button.disabled = refreshing;
  button.classList.toggle(styles.refreshing, refreshing);
}

function niceMax(value) {
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / (10 ** exponent);
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * (10 ** exponent);
}

function axisMoney(value) {
  if (Math.abs(value) >= 1_000_000) return `R${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (Math.abs(value) >= 1_000) return `R${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return `R${Math.round(value)}`;
}

function money(value) {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(number(value));
}

function compactMoney(value) {
  const amount = number(value);
  if (Math.abs(amount) >= 1_000_000) return `R${(amount / 1_000_000).toFixed(1)}m`;
  if (Math.abs(amount) >= 1_000) return `R${(amount / 1_000).toFixed(1)}k`;
  return money(amount);
}

function quantity(value) {
  return number(value).toLocaleString('en-ZA', { maximumFractionDigits: 3 });
}

function decimal(value) {
  return number(value).toLocaleString('en-ZA', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value = '') {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

function icon(name, size = 16) {
  const paths = {
    package: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    filter: '<path d="M4 5h16"/><path d="M7 12h10"/><path d="M10 19h4"/>',
    refresh: '<path d="M20 6v6h-6"/><path d="M4 18v-6h6"/><path d="M18.5 9a7 7 0 0 0-11.8-2.6L4 9"/><path d="M5.5 15a7 7 0 0 0 11.8 2.6L20 15"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    bellOff: '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="2" x2="22" y1="2" y2="22"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
    settings: '<path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/>',
    money: '<circle cx="12" cy="12" r="9"/><path d="M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8"/><path d="M12 6v12"/>',
    trendDown: '<path d="m3 7 6 6 4-4 8 8"/><path d="M21 10v7h-7"/>',
    activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
    alert: '<path d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    arrowUp: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
    arrowDown: '<path d="m7 7 10 10"/><path d="M17 7v10H7"/>',
    minus: '<path d="M5 12h14"/>',
    pie: '<path d="M21 12a9 9 0 1 1-9-9v9Z"/><path d="M12 3a9 9 0 0 1 9 9h-9Z"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
}
