import '../styles/settings.css';
import { renderLoadingPanel } from './LoadingPanel.js';
import {
  DEFAULT_RESTAURANT_BACKGROUND_ID,
  DEFAULT_RESTAURANT_THEME_ID,
  RESTAURANT_BACKGROUND_PRESETS,
  RESTAURANT_THEME_PRESETS
} from '../themePresets.js';

export function renderSettings({ state, onSettingsAction = {} } = {}) {
  const settingsState = state.settings || {};
  const draft = settingsState.draft || createDefaultSettings(state);
  const reportingDayHour = resolveReportingDayHour(draft);
  const vatRegistered = draft.vatRegistered !== false;
  const workspaceName = state.workspace?.siteName || draft.siteName || 'Workspace';
  const isSaving = settingsState.actionStatus === 'saving';
  const isImporting = settingsState.actionStatus === 'importing';
  const isExporting = settingsState.actionStatus === 'exporting';
  const isResetting = settingsState.actionStatus === 'resetting';
  const openDropdown = settingsState.openDropdown || '';
  // Only KCP-designated super-users (admin_users table) or explicit super-user roles may access
  // snapshots and data reset tools — workspace owners and admins are excluded.
  const canManageSnapshots = state.access?.currentIsKcpSuperUser === true || isSuperUserRole(state.access?.currentRole);
  const settingsArea = resolveSettingsArea(state.route?.active);
  const isCustomization = settingsArea === 'customization';
  const pageTitle = isCustomization ? 'Customization' : 'Business Settings';
  const pageEyebrow = isCustomization ? 'Visual Identity' : 'System Control';
  const pageSubtitle = isCustomization ? 'Backgrounds, logos, and themes' : workspaceName;

  const view = document.createElement('section');
  view.className = 'settingsView';
  if (settingsState.status === 'loading') {
    view.innerHTML = renderLoadingPanel('Loading settings', 'Fetching your workspace configuration.');
    return view;
  }
  view.innerHTML = `
    <div class="max-w-[1680px] mx-auto px-6 py-7 md:px-8">
      <header class="mb-6">
        <p class="text-primary text-xs font-extrabold tracking-[0.16em] uppercase">${escapeHtml(pageEyebrow)}</p>
        <h1 class="text-3xl font-bold mt-1 text-base-content">${escapeHtml(pageTitle)}</h1>
        <p class="text-base-content/60 mt-1">${escapeHtml(pageSubtitle)}</p>
      </header>

      ${settingsState.error ? renderNotice(settingsState.error, 'error') : ''}
      ${settingsState.actionError ? renderNotice(settingsState.actionError, 'error') : ''}

      ${!isCustomization ? `
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          <section class="card bg-base-100/70 backdrop-blur-md border border-base-300 shadow-sm lg:col-span-8">
            <div class="card-body gap-5">
              ${panelHead('percent', 'Tax Settings', 'Workspace Logic')}

              <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                <label class="form-control w-full">
                  <div class="label"><span class="label-text font-semibold">VAT Rate %</span></div>
                  <input type="text" inputmode="decimal" class="input input-bordered w-full" value="${escapeAttribute(draft.vatRate ?? 15)}" data-settings-field="vatRate" data-focus-key="settings-vat-rate" />
                </label>
                <div class="form-control w-full">
                  <div class="label"><span class="label-text font-semibold">VAT Registration</span></div>
                  <label class="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" class="toggle ${vatRegistered !== false ? 'toggle-success' : 'toggle-error'}" data-settings-vat-registered-toggle ${vatRegistered !== false ? 'checked' : ''} />
                    <span class="text-sm font-medium ${vatRegistered !== false ? 'text-success' : 'text-error'}">${vatRegistered !== false ? 'VAT Registered' : 'Not VAT Registered'}</span>
                  </label>
                  <p class="text-xs text-base-content/60 mt-1">${vatRegistered !== false
                    ? 'Reports and recipe costs show VAT (ex-VAT recipe costs, VAT column reflects real values).'
                    : 'Reports show R0 VAT and recipe costs are treated as VAT-inclusive of what was actually paid.'}</p>
                </div>
                <label class="form-control w-full">
                  <div class="label"><span class="label-text font-semibold">Business Profile Name</span></div>
                  <input type="text" class="input input-bordered w-full" value="${escapeAttribute(draft.siteName || '')}" placeholder="e.g. Main Kitchen" data-settings-field="siteName" data-focus-key="settings-site-name" />
                </label>
                <div class="form-control w-full sm:col-span-2 xl:col-span-3">
                  <div class="label"><span class="label-text font-semibold">Reporting Day Hours</span></div>
                  <div class="flex flex-wrap items-center gap-3" role="group" aria-label="Reporting day hours">
                    <span class="text-xs uppercase tracking-wide text-base-content/50 font-semibold">From</span>
                    ${renderReportingHourSelector('reportingDayFromHour', reportingDayHour, openDropdown, 'Reporting day starts at')}
                    <span class="text-base-content/40" aria-hidden="true">→</span>
                    <span class="text-xs uppercase tracking-wide text-base-content/50 font-semibold">To</span>
                    ${renderReportingHourSelector('reportingDayToHour', reportingDayHour, openDropdown, 'Reporting day ends at on the next day')}
                    <span class="text-xs text-base-content/50">next day</span>
                  </div>
                  <p class="text-xs text-base-content/60 mt-1">Reports always cover a full 24-hour day. Selecting either hour keeps From and To aligned.</p>
                </div>
                <label class="form-control w-full">
                  <div class="label"><span class="label-text font-semibold">Auto Logout Timeout (Minutes)</span></div>
                  <input type="text" inputmode="numeric" class="input input-bordered w-full" value="${escapeAttribute(draft.logoutTimeout ?? 30)}" data-settings-field="logoutTimeout" data-focus-key="settings-logout-timeout" />
                </label>
                <label class="form-control w-full">
                  <div class="label"><span class="label-text font-semibold">Costing Method</span></div>
                  ${renderSettingsDropdown({
                    id: 'costingMethod',
                    selectedValue: draft.costingMethod || 'last',
                    openDropdown,
                    options: [
                      { value: 'last', label: 'Last Receive Price' },
                      { value: 'wac', label: 'Weighted Average Cost' }
                    ]
                  })}
                </label>
              </div>

              <div class="card-actions justify-end pt-1">
                <button type="button" class="btn btn-primary" data-settings-save="workspace" ${isSaving ? 'disabled' : ''}>
                  ${isSaving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>
          </section>

          ${renderGoLivePanel(draft, state, { isSaving, onRelaunchOnboarding: onSettingsAction.onRelaunchOnboarding })}
          ${renderCompanyTaxPanel(draft, { isSaving })}
          ${renderProfileLinkingPanel(draft, { fullWidth: !canManageSnapshots })}

          ${canManageSnapshots ? `
            <section class="card bg-base-100/70 backdrop-blur-md border border-base-300 shadow-sm lg:col-span-6">
              <div class="card-body gap-5">
                ${panelHead('database', 'Infrastructure', 'Snapshots')}

                <div class="flex flex-wrap gap-3">
                  <button type="button" class="btn btn-success" data-settings-export ${isExporting ? 'disabled' : ''}>
                    ${isExporting ? 'Preparing...' : 'Save Full Snapshot'}
                  </button>
                  <button type="button" class="btn btn-outline" data-settings-import-trigger ${isImporting ? 'disabled' : ''}>
                    ${isImporting ? 'Importing...' : 'Import Full Snapshot'}
                  </button>
                  <input type="file" accept="application/json,.json" data-settings-import hidden />
                </div>

                <div class="rounded-box border border-base-300 bg-base-200/50 p-4">
                  <strong class="block text-sm font-semibold mb-1">Snapshot Import</strong>
                  <p class="text-sm text-base-content/70">Imports operational workspace data from a KCP JSON snapshot. Membership and roles stay managed by the live workspace.</p>
                </div>

                <div class="rounded-box border border-error/30 bg-error/5 p-4">
                  <strong class="block text-sm font-semibold text-error mb-1">Super User Reset Tools</strong>
                  <p class="text-sm text-base-content/70">Use reporting reset to clear reporting ledger/history data. Use reporting + stock reset when this store also needs all selling-location stock on hand set to zero. Products, recipes, stock items, and item costings are preserved.</p>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                    <button type="button" class="btn btn-warning btn-outline" data-settings-reset-reporting ${isResetting ? 'disabled' : ''}>
                      ${smallIcon('database')}
                      <span>${isResetting ? 'Resetting...' : 'Reset Reporting'}</span>
                    </button>
                    <button type="button" class="btn btn-error" data-settings-reset-reporting-stock ${isResetting ? 'disabled' : ''}>
                      ${smallIcon('trash')}
                      <span>${isResetting ? 'Resetting...' : 'Reset Reporting + Stock'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </section>
          ` : ''}
        </div>
      ` : `
        ${renderAppearancePanel(draft, settingsState)}
      `}
    </div>

    ${settingsState.appearanceModal === 'backgrounds' ? renderBackgroundModal(draft, settingsState) : ''}
    ${settingsState.appearanceModal === 'themes' ? renderThemeModal(draft, settingsState) : ''}
    ${settingsState.appearanceModal === 'logo' ? renderLogoModal(draft, settingsState) : ''}
    ${renderResetTotalsDialog(settingsState)}
  `;

  bindSettingsEvents(view, onSettingsAction, draft, settingsState);
  return view;
}

// Shared card header used across the daisyUI-styled Business Settings panels: a small tinted
// icon badge next to an eyebrow/title pair, matching daisyUI's card-title conventions.
function panelHead(iconName, eyebrow, title) {
  return `
    <div class="flex items-center gap-3">
      <span class="text-primary shrink-0">${smallIcon(iconName, 'w-6 h-6')}</span>
      <div>
        <p class="text-primary text-xs font-extrabold tracking-widest uppercase">${escapeHtml(eyebrow)}</p>
        <h2 class="text-base font-semibold mt-0.5">${escapeHtml(title)}</h2>
      </div>
    </div>
  `;
}

// Anchored to the bottom of the Yoco Integration card, set off from the main content by a
// divider — deliberately its own section rather than sitting inline with the Go Live/Live copy.
function renderRelaunchOnboardingSection(onboardingProgress, onRelaunchOnboarding) {
  if (!onRelaunchOnboarding) return '';
  return `
    <div class="flex flex-wrap items-center justify-between gap-3 mt-2 pt-4 border-t border-base-200">
      ${onboardingProgress ? `<p class="text-sm text-base-content/60 m-0">Setup: ${onboardingProgress.completed} of ${onboardingProgress.total} steps completed</p>` : '<span></span>'}
      <button type="button" class="btn btn-outline btn-sm" data-settings-relaunch-onboarding>
        Relaunch Setup Wizard
      </button>
    </div>
  `;
}

function renderGoLivePanel(draft = {}, state = {}, { isSaving = false, onRelaunchOnboarding } = {}) {
  // Feature: setup progress visible outside the wizard too, not only while it's open — the same
  // 4-step completion count the wizard itself shows.
  const onboardingProgress = state.settings?.onboardingProgress || null;
  const relaunchSection = renderRelaunchOnboardingSection(onboardingProgress, onRelaunchOnboarding);

  if (draft.stockDepletionEnabled) {
    return `
      <section class="card bg-base-100/70 backdrop-blur-md border border-success/30 shadow-sm lg:col-span-4">
        <div class="card-body gap-4 justify-between">
          <div class="flex flex-col gap-4">
            <div class="flex items-center justify-between gap-3">
              ${panelHead('check', 'Yoco Integration', 'Live')}
              <span class="badge badge-success gap-1 shrink-0">${smallIcon('check', 'w-3 h-3')} Live</span>
            </div>
            <p class="text-sm text-base-content/70">Completed Yoco sales are depleting stock.</p>
          </div>
          ${relaunchSection}
        </div>
      </section>
    `;
  }

  const readiness = state.settings?.goLiveReadiness || {};
  const checklist = [
    { label: 'Products', ready: Number(readiness.productCount || 0) > 0 },
    { label: 'Recipes', ready: Number(readiness.recipeCount || 0) > 0 },
    { label: 'Locations', ready: Number(readiness.locationCount || 0) > 0 }
  ];
  const isReady = checklist.every((item) => item.ready);

  return `
    <section class="card bg-base-100/70 backdrop-blur-md border border-base-300 shadow-sm lg:col-span-4">
      <div class="card-body gap-4">
        ${panelHead('rocket', 'Yoco Integration', 'Go Live')}
        <p class="text-sm text-base-content/70">Once live, completed Yoco sales will start depleting stock automatically.</p>
        <ul class="flex flex-col gap-2">
          ${checklist.map((item) => `
            <li class="flex items-center gap-2 text-sm ${item.ready ? 'text-success font-medium' : 'text-base-content/50'}">
              <span class="grid place-items-center w-5 h-5 rounded-full border ${item.ready ? 'bg-success/15 border-success/40' : 'border-base-300'}">${item.ready ? '✓' : ''}</span>
              <span>${escapeHtml(item.label)}</span>
            </li>
          `).join('')}
        </ul>
        ${!isReady ? '<p class="text-xs text-warning">Complete the checklist before enabling stock depletion.</p>' : ''}
        <div class="card-actions">
          <button type="button" class="btn btn-primary w-full" data-settings-go-live ${!isReady || isSaving ? 'disabled' : ''}>
            ${isSaving ? 'Going Live...' : 'Go Live'}
          </button>
        </div>
        ${relaunchSection}
      </div>
    </section>
  `;
}

function renderCompanyTaxPanel(draft = {}, { isSaving = false } = {}) {
  const taxInfo = normalizeTaxInfo(draft.companyTaxInfo || {});
  const fields = [
    ['Registered Company Name', 'registeredCompanyName', 'Legal registered entity name'],
    ['Trading Name', 'tradingName', 'Public trading name, if different'],
    ['Company Registration No', 'companyRegistrationNumber', 'Optional company registration number'],
    ['VAT Number', 'vatNumber', 'Optional VAT number'],
    ['Tax Number', 'taxNumber', 'Optional tax identifier'],
    ['Registered Address Line 1', 'registeredAddressLine1', 'Street address'],
    ['Registered Address Line 2', 'registeredAddressLine2', 'Building, suite, or floor'],
    ['Suburb', 'suburb', ''],
    ['City', 'city', ''],
    ['Province', 'province', ''],
    ['Postal Code', 'postalCode', ''],
    ['Country', 'country', ''],
    ['Accounts Contact Name', 'accountsContactName', ''],
    ['Accounts Contact Email', 'accountsContactEmail', ''],
    ['Accounts Contact Phone', 'accountsContactPhone', '']
  ];
  return `
    <section class="card bg-base-100/70 backdrop-blur-md border border-base-300 shadow-sm lg:col-span-12">
      <div class="card-body gap-5">
        ${panelHead('receipt', 'Legal Details', 'Company Tax Information')}

        <div class="rounded-box border border-base-300 bg-base-200/50 p-4">
          <strong class="block text-sm font-semibold mb-1">Workspace default</strong>
          <p class="text-sm text-base-content/70">Used for supplier-facing documents unless a selling location has its own tax information enabled.</p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          ${fields.map(([label, key, help]) => `
            <label class="form-control w-full ${key === 'registeredAddressLine1' || key === 'registeredAddressLine2' ? 'sm:col-span-2' : ''}">
              <div class="label"><span class="label-text font-semibold">${escapeHtml(label)}</span></div>
              <input
                type="${key === 'accountsContactEmail' ? 'email' : 'text'}"
                class="input input-bordered w-full"
                value="${escapeAttribute(taxInfo[key] || '')}"
                placeholder="${escapeAttribute(help || label)}"
                data-settings-tax-field="${escapeAttribute(key)}"
                data-focus-key="settings-tax-${escapeAttribute(key)}"
              />
            </label>
          `).join('')}
        </div>

        <div class="card-actions justify-end">
          <button type="button" class="btn btn-primary" data-settings-save="legal" ${isSaving ? 'disabled' : ''}>
            ${isSaving ? 'Saving...' : 'Save Legal Details'}
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderStockRoutingPanel(draft = {}, state = {}) {
  const categories = getStockCategories(state, draft);
  const categoryMap = draft.stockCategoryRoutingMap && typeof draft.stockCategoryRoutingMap === 'object' ? draft.stockCategoryRoutingMap : {};
  const quickLabels = ['Food', 'Drinks', 'Tobacco', 'Sides', 'Retail'];
  const mappedCount = categories.filter((category) => getRoutingLabelForStockCategory(category, categoryMap)).length;
  return `
    <section class="settingsPanel settingsPanel--routing">
      <div class="settingsPanelHead">
        <span>${icon('network')}</span>
        <div>
          <p>Stock Routing</p>
          <h2>Internal Category Routing</h2>
        </div>
      </div>

      <div class="settingsSnapshotNote">
        <strong>Smart stock routing</strong>
        <p>Sales now route stock by ingredient category, not menu category. This keeps combos accurate because each recipe line can pull from the right location.</p>
      </div>

      <div class="settingsRoutingSummary">
        <article>
          <small>Stock Categories</small>
          <strong>${categories.length}</strong>
        </article>
        <article>
          <small>Mapped</small>
          <strong>${mappedCount}</strong>
        </article>
        <button type="button" class="settingsSecondaryButton" data-settings-open-stock-routing>
          ${icon('network')}
          <span>Manage Routing</span>
        </button>
      </div>

      <div class="settingsRoutingChips settingsRoutingChips--top" aria-label="Common routing labels">
        ${quickLabels.map((label) => `<span>${escapeHtml(label)}</span>`).join('')}
      </div>

      <p class="settingsRoutingMicrocopy">Yoco category mapping remains available for sales routing consistency, but depletion is controlled from stock categories.</p>
    </section>
  `;
}

function renderStockRoutingModal(draft = {}, state = {}) {
  const categories = getStockCategories(state, draft);
  const categoryMap = draft.stockCategoryRoutingMap && typeof draft.stockCategoryRoutingMap === 'object' ? draft.stockCategoryRoutingMap : {};
  const labels = getRoutingLabelOptions(categories, categoryMap);
  return `
    <div class="settingsModalBackdrop" role="presentation">
      <section class="settingsModal settingsModal--wide" role="dialog" aria-modal="true" aria-labelledby="settings-routing-title">
        <header>
          <div>
            <p>Stock Routing</p>
            <h2 id="settings-routing-title">Map Stock Categories</h2>
          </div>
          <button type="button" class="settingsIconButton" data-settings-close-stock-routing aria-label="Close">${icon('x')}</button>
        </header>

        <p class="settingsConfirmText">
          Choose the routing label each internal stock category belongs to. Locations use these labels in their Stock Routing rules, for example Food=Kitchen and Drinks=self.
        </p>

        <div class="settingsRoutingChips settingsRoutingChips--top" aria-label="Available routing labels">
          ${labels.map((label) => `<span>${escapeHtml(label)}</span>`).join('')}
        </div>

        <div class="settingsRoutingList settingsRoutingList--modal">
          ${categories.length ? categories.map((category) => {
            const selected = getRoutingLabelForStockCategory(category, categoryMap) || category.name;
            return `
              <article class="settingsRoutingRow settingsRoutingRow--selector">
                <div>
                  <small>Internal Stock Category</small>
                  <strong>${escapeHtml(category.name)}</strong>
                  ${category.tags?.length ? `<div class="settingsRoutingTags">${category.tags.map((tag) => `<span class="settingsRoutingTag--${escapeAttribute(normalizeSettingsRoutingTagClass(tag))}">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
                  ${category.itemCount ? `<em>${escapeHtml(String(category.itemCount))} stock items</em>` : ''}
                </div>
                <div class="settingsRoutingSelector" role="group" aria-label="Routing label for ${escapeAttribute(category.name)}">
                  ${labels.map((label) => `
                    <button
                      type="button"
                      class="${normalizeLookup(label) === normalizeLookup(selected) ? 'is-active' : ''}"
                      data-stock-category-routing-label="${escapeAttribute(label)}"
                      data-stock-category-routing-id="${escapeAttribute(category.id)}"
                    >
                      ${escapeHtml(label)}
                    </button>
                  `).join('')}
                </div>
              </article>
            `;
          }).join('') : `
            <div class="settingsSnapshotNote">
              <strong>No stock categories found</strong>
              <p>Create or import stock items first. Routing is based on stock item categories so mixed menu items deplete correctly.</p>
            </div>
          `}
        </div>

        <div class="settingsModalActions">
          <button type="button" class="settingsSecondaryButton" data-settings-close-stock-routing>Done</button>
          <button type="button" class="settingsPrimaryButton" data-settings-save>Save Settings</button>
        </div>
      </section>
    </div>
  `;
}

function getStockCategories(state = {}, draft = {}) {
  const loadedCategories = Array.isArray(state.settings?.stockCategories) ? state.settings.stockCategories : [];
  const map = new Map();
  loadedCategories.forEach((category) => {
    const name = normalizeStockCategoryName(category.name || category.id || category.rawCategory || '');
    if (name) map.set(name, { id: name, name, itemCount: Number(category.itemCount || 0) || 0, tags: getSettingsRoutingTags(category.rawCategory || category.name || name) });
  });
  Object.entries(draft.stockCategoryRoutingMap || {}).forEach(([id]) => {
    const name = normalizeStockCategoryName(id);
    if (name && !map.has(name)) map.set(name, { id: name, name, itemCount: 0, tags: getSettingsRoutingTags(name) });
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}


function getSettingsRoutingTags(categoryName = '') {
  const text = String(categoryName || '').toLowerCase();
  const tags = [];
  if (text.includes('prep') || text.includes('manufactur')) tags.push('PREP');
  if (text.includes('raw') || text.includes('material')) tags.push('RAW');
  if (!tags.length) tags.push('RAW');
  return [...new Set(tags)];
}

function normalizeSettingsRoutingTagClass(tag = '') {
  return String(tag || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'standard';
}

function getRoutingLabelForStockCategory(category = {}, categoryMap = {}) {
  const entry = categoryMap[category.id] || categoryMap[category.name] || categoryMap[normalizeStockCategoryName(category.name)] || '';
  return String(entry && typeof entry === 'object' ? entry.routingLabel || entry.label || entry.name || '' : entry).trim();
}

function getRoutingLabelOptions(categories = [], categoryMap = {}) {
  const defaults = ['Food', 'Drinks', 'Tobacco', 'Sides', 'Retail'];
  const mapped = Object.values(categoryMap || {}).map((entry) => (
    entry && typeof entry === 'object' ? entry.routingLabel || entry.label || entry.name : entry
  ));
  return [...new Set([...defaults, ...categories.map((category) => category.name), ...mapped]
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function normalizeStockCategoryName(value = '') {
  return String(value || 'General')
    .trim()
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s*\(([^)]+)\)\s*-\s*Manufactured$/i, '$1')
    .trim() || 'General';
}

function normalizeLookup(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function renderProfileLinkingPanel(draft = {}, { fullWidth = false } = {}) {
  const orgId = String(draft.orgId || '').trim();
  const corpId = String(draft.corpId || '').trim();
  const status = orgId || corpId ? 'Linked' : 'Standalone';
  return `
    <section class="card bg-base-100/70 backdrop-blur-md border border-base-300 shadow-sm ${fullWidth ? 'lg:col-span-12' : 'lg:col-span-6'}">
      <div class="card-body gap-5">
        ${panelHead('network', 'Profile Links', 'Org / Corp Transfer Logic')}

        <div class="stats stats-vertical sm:stats-horizontal bg-base-100/70 backdrop-blur-md shadow-none border border-base-300 w-full">
          <div class="stat py-3">
            <div class="stat-title">Status</div>
            <div class="stat-value text-lg">${escapeHtml(status)}</div>
          </div>
          <div class="stat py-3">
            <div class="stat-title">External Transfers</div>
            <div class="stat-value text-lg">${Number(draft.linkedSiteCount || 0) ? `${Number(draft.linkedSiteCount || 0)} Linked` : orgId || corpId ? 'Waiting for peer' : 'Off'}</div>
          </div>
          <div class="stat py-3">
            <div class="stat-title">Access Mode</div>
            <div class="stat-value text-lg">${draft.viewingOnly ? 'Viewing Only' : 'Full Workspace'}</div>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label class="form-control w-full">
            <div class="label"><span class="label-text font-semibold">Org ID</span></div>
            <input type="text" class="input input-bordered w-full" value="${escapeAttribute(orgId || 'Not linked')}" disabled />
          </label>
          <label class="form-control w-full">
            <div class="label"><span class="label-text font-semibold">Corp ID</span></div>
            <input type="text" class="input input-bordered w-full" value="${escapeAttribute(corpId || 'Not linked')}" disabled />
          </label>
        </div>

        <div class="rounded-box border border-base-300 bg-base-200/50 p-4">
          <strong class="block text-sm font-semibold mb-1">Admin managed</strong>
          <p class="text-sm text-base-content/70">Org and Corp links are assigned from the Admin Portal so profile linking stays controlled. This workspace still uses Locations as selling locations inside one business profile.</p>
        </div>
      </div>
    </section>
  `;
}

function renderAppearancePanel(draft = {}, settingsState = {}) {
  const selectedThemeId = draft.restaurantThemeId || DEFAULT_RESTAURANT_THEME_ID;
  const selectedTheme = RESTAURANT_THEME_PRESETS.find((theme) => theme.id === selectedThemeId) || RESTAURANT_THEME_PRESETS[0];
  const selectedBackgroundId = draft.restaurantBackgroundId || draft.restaurantThemeId || DEFAULT_RESTAURANT_BACKGROUND_ID;
  const selectedBackground = RESTAURANT_BACKGROUND_PRESETS.find((background) => background.id === selectedBackgroundId) || RESTAURANT_BACKGROUND_PRESETS[0];
  const logoDataUrl = String(draft.restaurantLogoDataUrl || '').trim();
  const customBackgroundDataUrl = String(draft.restaurantBackgroundDataUrl || '').trim();
  const activeBackgroundStyle = customBackgroundDataUrl
    ? getUploadedBackgroundPreviewStyle(customBackgroundDataUrl)
    : getThemePreviewStyle(selectedBackground);
  return `
    <section class="settingsPanel settingsPanel--appearance">
      <div class="settingsPanelHead settingsPanelHead--split">
        <span>${icon('palette')}</span>
        <div>
          <p>Restaurant Appearance</p>
          <h2>Backgrounds & Logo</h2>
        </div>
      </div>

      <div class="settingsAppearanceSummary">
        <article class="settingsActiveBackground" style="${escapeAttribute(activeBackgroundStyle)}">
          <small>Active Background</small>
          <strong>${escapeHtml(customBackgroundDataUrl ? 'Customer Upload' : selectedBackground?.label || 'Kitchen Pass')}</strong>
          <span>${escapeHtml(customBackgroundDataUrl ? draft.restaurantBackgroundName || 'Custom workspace background' : selectedBackground?.description || '')}</span>
        </article>
        <div class="settingsLogoPreview">
          ${logoDataUrl
            ? `<img src="${escapeAttribute(logoDataUrl)}" alt="Current restaurant logo" />`
            : `<span>KCP</span>`}
        </div>
      </div>

      <div class="settingsPersonalPreferenceRow">
        <label>
          <span>Personal UI Scale</span>
          ${renderSettingsDropdown({
            id: 'uiScale',
            selectedValue: draft.uiScale || 'normal',
            openDropdown: settingsState.openDropdown || '',
            options: [
              { value: 'normal', label: 'Normal' },
              { value: 'large', label: 'Large Text' }
            ]
          })}
          <small class="settingsFieldHint">Saved only for your user in this workspace.</small>
        </label>
        <button type="button" class="settingsPrimaryButton" data-settings-save-appearance>Save My Appearance</button>
      </div>

      <div class="settingsAppearanceActions">
        <button type="button" class="settingsAppearanceAction" data-settings-open-appearance-modal="backgrounds">
          ${icon('image')}
          <span>
            <small>Background</small>
            <strong>${escapeHtml(customBackgroundDataUrl ? 'Customer Upload' : selectedBackground?.label || 'Kitchen Pass')}</strong>
          </span>
        </button>
        <button type="button" class="settingsAppearanceAction" data-settings-open-appearance-modal="themes">
          ${icon('palette')}
          <span>
            <small>Colour Theme</small>
            <strong>${escapeHtml(selectedTheme?.label || 'KCP Classic')}</strong>
          </span>
        </button>
        <button type="button" class="settingsAppearanceAction" data-settings-open-appearance-modal="logo">
          ${icon('upload')}
          <span>
            <small>Logo</small>
            <strong>${escapeHtml(logoDataUrl ? draft.restaurantLogoName || 'Customer Logo' : 'Add Logo')}</strong>
          </span>
        </button>
      </div>
    </section>
  `;
}

function renderBackgroundModal(draft = {}, settingsState = {}) {
  const selectedBackgroundId = draft.restaurantBackgroundId || draft.restaurantThemeId || DEFAULT_RESTAURANT_BACKGROUND_ID;
  const customBackgroundDataUrl = String(draft.restaurantBackgroundDataUrl || '').trim();
  const showAll = settingsState.themeGalleryOpen === true;
  const visibleBackgrounds = showAll ? RESTAURANT_BACKGROUND_PRESETS : RESTAURANT_BACKGROUND_PRESETS.slice(0, 6);
  return `
    <div class="settingsModalBackdrop" role="presentation">
      <section class="settingsModal settingsModal--appearance" role="dialog" aria-modal="true" aria-labelledby="settings-background-title">
        <header>
          <div>
            <p>Backgrounds</p>
            <h2 id="settings-background-title">Choose Workspace Background</h2>
          </div>
          <button type="button" class="settingsIconButton" data-settings-close-appearance-modal aria-label="Close">${icon('x')}</button>
        </header>

        <div class="settingsModalTopActions">
          <button type="button" class="settingsLinkButton" data-settings-toggle-theme-gallery>
            ${showAll ? 'Show less' : 'View all'}
          </button>
        </div>

        <div class="settingsThemeGrid settingsThemeGrid--modal" aria-label="Restaurant background presets">
          ${visibleBackgrounds.map((theme) => {
            const isActive = !customBackgroundDataUrl && theme.id === selectedBackgroundId;
            return `
              <button
                type="button"
                class="settingsThemeCard ${isActive ? 'is-active' : ''}"
                data-settings-background-preset="${escapeAttribute(theme.id)}"
                aria-pressed="${isActive}"
              >
                <span class="settingsThemeSwatch" style="${escapeAttribute(getThemePreviewStyle(theme))}">
                ${isActive ? `<em>${icon('check')}</em>` : ''}
                </span>
                <strong>${escapeHtml(theme.label)}</strong>
                <small>Background Image</small>
              </button>
            `;
          }).join('')}
        </div>

        <div class="settingsBackgroundActions">
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-settings-background-upload hidden />
          <button type="button" class="settingsSecondaryButton" data-settings-background-trigger>
            ${icon('upload')}
            <span>Upload Custom Background</span>
          </button>
          ${customBackgroundDataUrl ? `
            <button type="button" class="settingsGhostButton" data-settings-background-clear>
              ${icon('x')}
              <span>Use Built-In Background</span>
            </button>
          ` : ''}
        </div>
        <p class="settingsFieldHint">Customer backgrounds replace the selected built-in image after saving. Use a wide PNG, JPG, WebP, GIF, or SVG under 2.5MB.</p>

        <div class="settingsModalActions">
          <button type="button" class="settingsSecondaryButton" data-settings-close-appearance-modal>Cancel</button>
          <button type="button" class="settingsPrimaryButton" data-settings-save-appearance>
            ${settingsState.actionStatus === 'saving' ? 'Saving...' : 'Save Background'}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderThemeModal(draft = {}, settingsState = {}) {
  const selectedThemeId = draft.restaurantThemeId || DEFAULT_RESTAURANT_THEME_ID;
  const selectedTheme = RESTAURANT_THEME_PRESETS.find((theme) => theme.id === selectedThemeId) || RESTAURANT_THEME_PRESETS[0];
  const customBackgroundDataUrl = String(draft.restaurantBackgroundDataUrl || '').trim();
  return `
    <div class="settingsModalBackdrop" role="presentation">
      <section class="settingsModal settingsModal--appearance" role="dialog" aria-modal="true" aria-labelledby="settings-theme-title">
        <header>
          <div>
            <p>Colour Themes</p>
            <h2 id="settings-theme-title">Choose Interface Theme</h2>
          </div>
          <button type="button" class="settingsIconButton" data-settings-close-appearance-modal aria-label="Close">${icon('x')}</button>
        </header>

        <div class="settingsMiniHeader settingsMiniHeader--modal">
          <small>Active Theme</small>
          <strong>${escapeHtml(selectedTheme?.label || 'KCP Classic')}</strong>
        </div>

        <div class="settingsColorThemeGrid settingsColorThemeGrid--modal" aria-label="Restaurant colour themes">
          ${RESTAURANT_THEME_PRESETS.map((theme) => {
            const isActive = theme.id === selectedThemeId;
            return `
              <button
                type="button"
                class="settingsColorThemeCard ${isActive ? 'is-active' : ''}"
                data-settings-color-theme-preset="${escapeAttribute(theme.id)}"
                aria-pressed="${isActive}"
              >
                <span style="${escapeAttribute(getColorThemePreviewStyle(theme))}">
                  ${isActive ? `<em>${icon('check')}</em>` : ''}
                </span>
                <strong>${escapeHtml(theme.label)}</strong>
              </button>
            `;
          }).join('')}
        </div>

        <div class="settingsThemeBackgroundUpload">
          <div>
            <small>Custom Background</small>
            <strong>${escapeHtml(customBackgroundDataUrl ? draft.restaurantBackgroundName || 'Customer Upload' : 'Optional Upload')}</strong>
          </div>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-settings-background-upload hidden />
          <button type="button" class="settingsSecondaryButton" data-settings-background-trigger>
            ${icon('upload')}
            <span>Upload Background</span>
          </button>
        </div>

        <div class="settingsModalActions">
          <button type="button" class="settingsSecondaryButton" data-settings-close-appearance-modal>Cancel</button>
          <button type="button" class="settingsPrimaryButton" data-settings-save-appearance>
            ${settingsState.actionStatus === 'saving' ? 'Saving...' : 'Save Theme'}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderLogoModal(draft = {}, settingsState = {}) {
  const logoDataUrl = String(draft.restaurantLogoDataUrl || '').trim();
  return `
    <div class="settingsModalBackdrop" role="presentation">
      <section class="settingsModal settingsModal--logo" role="dialog" aria-modal="true" aria-labelledby="settings-logo-title">
        <header>
          <div>
            <p>Customer Logo</p>
            <h2 id="settings-logo-title">Upload Workspace Logo</h2>
          </div>
          <button type="button" class="settingsIconButton" data-settings-close-appearance-modal aria-label="Close">${icon('x')}</button>
        </header>

        <div class="settingsLogoDropZone" data-settings-logo-dropzone>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-settings-logo-upload hidden />
          <div class="settingsLogoDropPreview">
            ${logoDataUrl
              ? `<img src="${escapeAttribute(logoDataUrl)}" alt="Current restaurant logo" />`
              : icon('upload')}
          </div>
          <strong>${escapeHtml(logoDataUrl ? draft.restaurantLogoName || 'Customer Logo' : 'Drop Logo Here')}</strong>
          <span>Drag and drop a logo, or choose a file. Uploads auto-save.</span>
          <button type="button" class="settingsSecondaryButton" data-settings-logo-trigger>
            ${icon('upload')}
            <span>Select Logo</span>
          </button>
        </div>

        <p class="settingsFieldHint">Logo replaces the KCP icon in the top-left sidebar and exported documents. Use PNG, JPG, WebP, GIF, or SVG under 300KB.</p>

        <div class="settingsModalActions settingsModalActions--single">
          ${logoDataUrl ? `
            <button type="button" class="settingsGhostButton" data-settings-logo-clear>
              ${icon('x')}
              <span>Remove Logo</span>
            </button>
          ` : ''}
          <button type="button" class="settingsSecondaryButton" data-settings-close-appearance-modal>Done</button>
        </div>
      </section>
    </div>
  `;
}

function getThemePreviewStyle(theme = {}) {
  const backgroundImage = String(theme.backgroundImage || '').trim();
  const backgroundPosition = String(theme.backgroundPosition || 'center').trim();
  if (backgroundImage) {
    return `background-image: linear-gradient(135deg, rgba(2, 6, 23, 0.04), rgba(2, 6, 23, 0.18)), url("${backgroundImage}"); background-size: cover; background-position: ${backgroundPosition};`;
  }
  const colors = Array.isArray(theme.preview) && theme.preview.length ? theme.preview : ['#60a5fa', '#34d399', '#101c2b'];
  const [first, second = first, third = second] = colors;
  return `background: radial-gradient(circle at 24% 24%, ${first}, transparent 36%), radial-gradient(circle at 78% 32%, ${second}, transparent 34%), linear-gradient(135deg, ${third}, ${first});`;
}

function getUploadedBackgroundPreviewStyle(dataUrl = '') {
  return `background-image: linear-gradient(135deg, rgba(2, 6, 23, 0.04), rgba(2, 6, 23, 0.18)), url("${dataUrl}"); background-size: cover; background-position: center;`;
}

function getColorThemePreviewStyle(theme = {}) {
  const colors = Array.isArray(theme.preview) && theme.preview.length ? theme.preview : ['#60a5fa', '#34d399', '#101c2b'];
  const [first, second = first, third = second] = colors;
  return `background: radial-gradient(circle at 22% 26%, ${first}, transparent 38%), radial-gradient(circle at 76% 32%, ${second}, transparent 34%), linear-gradient(135deg, ${third}, ${first});`;
}

function bindSettingsEvents(view, onSettingsAction, draft = {}, settingsState = {}) {
  view.querySelectorAll('[data-settings-vat-registered-toggle]').forEach((field) => {
    field.addEventListener('change', () => {
      const nextValue = field.checked;
      // Revert the visual toggle immediately — the actual state only changes once the person
      // confirms in the dialog (see requestVatRegisteredToggle in main.js), since this
      // recalculates recipe costs and GRV VAT handling across the whole workspace.
      field.checked = !nextValue;
      onSettingsAction.onVatRegisteredToggle?.(nextValue);
    });
  });

  view.querySelectorAll('[data-settings-field]').forEach((field) => {
    const isTextLike = field.tagName === 'INPUT' && field.type !== 'checkbox' && field.type !== 'radio';
    if (isTextLike) {
      // Text inputs: silent update only — blur/change re-renders corrupt typing by replacing the DOM mid-keystroke
      field.addEventListener('input', () => {
        onSettingsAction.onDraftChangeSilent?.({ [field.dataset.settingsField]: field.value });
      });
    } else {
      // Selects, checkboxes: change is safe to re-render (no cursor to disrupt)
      field.addEventListener('change', () => {
        // Time-part and reporting-hour selects are handled by their dedicated combiners below.
        if (field.dataset.timePart || field.dataset.reportingHour) return;
        onSettingsAction.onPreserveFocus?.(field);
        onSettingsAction.onDraftChange?.({ [field.dataset.settingsField]: field.value });
      });
    }
  });

  view.querySelectorAll('[data-time-part]').forEach((select) => {
    select.addEventListener('change', () => {
      const fieldKey = select.dataset.settingsField || '';
      if (!fieldKey) return;
      // Find sibling selects for the same field
      const siblings = view.querySelectorAll(`[data-settings-field="${CSS.escape(fieldKey)}"][data-time-part]`);
      let hour = 0;
      let minute = 0;
      siblings.forEach((s) => {
        if (s.dataset.timePart === 'hour') hour = parseInt(s.value, 10) || 0;
        if (s.dataset.timePart === 'minute') minute = parseInt(s.value, 10) || 0;
      });
      const combined = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      onSettingsAction.onDraftChange?.({ [fieldKey]: combined });
    });
  });

  view.querySelectorAll('[data-settings-tax-field]').forEach((field) => {
    const handleTaxChange = () => {
      const key = field.dataset.settingsTaxField || '';
      if (!key) return;
      onSettingsAction.onTaxFieldChangeSilent?.(key, field.value);
    };
    field.addEventListener('input', handleTaxChange);
    field.addEventListener('change', handleTaxChange);
  });

  view.querySelectorAll('[data-settings-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      onSettingsAction.onDropdownToggle?.(button.dataset.settingsDropdown || '');
    });
  });

  view.querySelectorAll('[data-settings-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const field = button.dataset.settingsOptionField || '';
      const value = button.dataset.settingsOptionValue || '';
      if (field === 'reportingDayFromHour' || field === 'reportingDayToHour') {
        const hour = normalizeHourValue(value);
        const previousHour = (hour + 23) % 24;
        onSettingsAction.onDraftChange?.({
          reportingDayFromHour: hour,
          reportingDayToHour: hour,
          tradingDayStartHour: hour,
          tradingDayStartMinutes: hour * 60,
          // Keep the legacy end-of-day field in sync for older report and snapshot readers.
          tradingTime: `${String(previousHour).padStart(2, '0')}:59`
        });
      } else {
        onSettingsAction.onDraftChange?.({ [field]: value });
      }
      onSettingsAction.onDropdownToggle?.('');
    });
  });

  view.querySelectorAll('[data-settings-theme-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      onSettingsAction.onThemePresetChange?.(button.dataset.settingsThemePreset || DEFAULT_RESTAURANT_THEME_ID);
    });
  });

  view.querySelectorAll('[data-settings-background-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      onSettingsAction.onBackgroundPresetChange?.(button.dataset.settingsBackgroundPreset || DEFAULT_RESTAURANT_BACKGROUND_ID);
    });
  });

  view.querySelectorAll('[data-settings-color-theme-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      onSettingsAction.onThemePresetChange?.(button.dataset.settingsColorThemePreset || DEFAULT_RESTAURANT_THEME_ID);
    });
  });

  view.querySelectorAll('[data-settings-open-appearance-modal]').forEach((button) => {
    button.addEventListener('click', () => {
      onSettingsAction.onOpenAppearanceModal?.(button.dataset.settingsOpenAppearanceModal || '');
    });
  });

  view.querySelectorAll('[data-settings-close-appearance-modal]').forEach((button) => {
    button.addEventListener('click', () => onSettingsAction.onCloseAppearanceModal?.());
  });

  view.querySelector('[data-settings-toggle-theme-gallery]')?.addEventListener('click', () => {
    onSettingsAction.onToggleThemeGallery?.();
  });

  const logoInput = view.querySelector('[data-settings-logo-upload]');
  view.querySelector('[data-settings-logo-trigger]')?.addEventListener('click', () => logoInput?.click());
  logoInput?.addEventListener('change', (event) => {
    const file = event.currentTarget.files?.[0];
    if (file) onSettingsAction.onLogoUpload?.(file);
    event.currentTarget.value = '';
  });
  view.querySelector('[data-settings-logo-clear]')?.addEventListener('click', () => {
    onSettingsAction.onLogoClear?.();
  });

  const logoDropZone = view.querySelector('[data-settings-logo-dropzone]');
  logoDropZone?.addEventListener('dragover', (event) => {
    event.preventDefault();
    logoDropZone.classList.add('is-dragging');
  });
  logoDropZone?.addEventListener('dragleave', (event) => {
    if (!logoDropZone.contains(event.relatedTarget)) {
      logoDropZone.classList.remove('is-dragging');
    }
  });
  logoDropZone?.addEventListener('drop', (event) => {
    event.preventDefault();
    logoDropZone.classList.remove('is-dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) onSettingsAction.onLogoUpload?.(file);
  });

  const backgroundInput = view.querySelector('[data-settings-background-upload]');
  view.querySelector('[data-settings-background-trigger]')?.addEventListener('click', () => backgroundInput?.click());
  backgroundInput?.addEventListener('change', (event) => {
    const file = event.currentTarget.files?.[0];
    if (file) onSettingsAction.onBackgroundUpload?.(file);
    event.currentTarget.value = '';
  });
  view.querySelector('[data-settings-background-clear]')?.addEventListener('click', () => {
    onSettingsAction.onBackgroundClear?.();
  });

  view.querySelector('[data-settings-open-stock-routing]')?.addEventListener('click', () => {
    onSettingsAction.onOpenStockRoutingModal?.();
  });

  view.querySelectorAll('[data-settings-close-stock-routing]').forEach((button) => {
    button.addEventListener('click', () => onSettingsAction.onCloseStockRoutingModal?.());
  });

  view.querySelectorAll('[data-stock-category-routing-label]').forEach((button) => {
    button.addEventListener('click', () => {
      onSettingsAction.onStockCategoryRoutingChange?.(
        button.dataset.stockCategoryRoutingId || '',
        button.dataset.stockCategoryRoutingLabel || ''
      );
    });
  });

  view.addEventListener('click', (event) => {
    if (event.target.closest('[data-settings-dropdown-root]')) return;
    if (event.target.closest('.settingsTimeSelector')) return;
    if (event.target.tagName === 'SELECT') return;
    onSettingsAction.onDropdownToggle?.('');
  });

  view.querySelectorAll('[data-settings-save]').forEach((button) => {
    button.addEventListener('click', () => {
      const saveScope = button.dataset.settingsSave || 'workspace';
      if (saveScope === 'legal') {
        const companyTaxInfo = normalizeTaxInfo(draft.companyTaxInfo || {});
        view.querySelectorAll('[data-settings-tax-field]').forEach((field) => {
          const key = field.dataset.settingsTaxField || '';
          if (key) companyTaxInfo[key] = field.value;
        });
        onSettingsAction.onSave?.({
          draftPatch: { companyTaxInfo },
          successMessage: 'Legal details saved.',
          syncSiteName: false
        });
        return;
      }
      onSettingsAction.onSave?.();
    });
  });
  view.querySelectorAll('[data-settings-save-appearance]').forEach((button) => {
    button.addEventListener('click', () => onSettingsAction.onSaveAppearance?.());
  });
  view.querySelector('[data-settings-relaunch-onboarding]')?.addEventListener('click', () => onSettingsAction.onRelaunchOnboarding?.());
  view.querySelector('[data-settings-go-live]')?.addEventListener('click', () => {
    onSettingsAction.onGoLive?.();
  });
  view.querySelector('[data-settings-export]')?.addEventListener('click', () => onSettingsAction.onExportSnapshot?.());
  view.querySelector('[data-settings-reset-reporting]')?.addEventListener('click', () => onSettingsAction.onRequestResetTotals?.('reporting'));
  view.querySelector('[data-settings-reset-reporting-stock]')?.addEventListener('click', () => onSettingsAction.onRequestResetTotals?.('reporting_stock'));
  view.querySelector('[data-settings-reset-confirm-text]')?.addEventListener('input', (event) => {
    onSettingsAction.onPreserveFocus?.(event.currentTarget);
    onSettingsAction.onResetConfirmTextChange?.(event.currentTarget.value);
  });
  view.querySelector('[data-settings-confirm-reset-totals]')?.addEventListener('click', () => onSettingsAction.onConfirmResetTotals?.());
  view.querySelectorAll('[data-settings-cancel-reset-totals]').forEach((button) => {
    button.addEventListener('click', () => onSettingsAction.onCancelResetTotals?.());
  });

  // Portal the reset dialog to document.body so position:fixed is relative to the
  // viewport — backdrop-filter on .mainPane creates a stacking context that breaks fixed.
  document.getElementById('kcp-reset-dialog-portal')?.remove();
  const resetDialog = view.querySelector('.settingsModalBackdrop');
  if (resetDialog) {
    const portal = document.createElement('div');
    portal.id = 'kcp-reset-dialog-portal';
    portal.appendChild(resetDialog);
    document.body.appendChild(portal);
  }

  // Toast portal — renders outside any stacking context so it always appears on top
  document.getElementById('kcp-settings-toast-portal')?.remove();
  const toastPortal = document.createElement('div');
  toastPortal.id = 'kcp-settings-toast-portal';
  toastPortal.innerHTML = renderToast(settingsState.toast);
  document.body.appendChild(toastPortal);
  toastPortal.querySelector('[data-settings-toast-close]')?.addEventListener('click', () => onSettingsAction.onDismissToast?.());

  const importInput = view.querySelector('[data-settings-import]');
  view.querySelector('[data-settings-import-trigger]')?.addEventListener('click', () => {
    const confirmed = window.confirm('Importing a full snapshot will replace the active operational data in this workspace. Continue?');
    if (confirmed) importInput?.click();
  });

  importInput?.addEventListener('change', (event) => {
    const file = event.currentTarget.files?.[0];
    if (file) onSettingsAction.onImportSnapshot?.(file);
    event.currentTarget.value = '';
  });

  view.querySelector('[data-settings-toast-close]')?.addEventListener('click', () => onSettingsAction.onDismissToast?.());
}

function isSuperUserRole(role = '') {
  const normalized = String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  return ['super', 'super-user', 'superuser', 'root'].includes(normalized);
}

function resolveSettingsArea(routeId = '') {
  return String(routeId || '').trim() === 'settings-customization' ? 'customization' : 'business';
}

function normalizeTaxInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    registeredCompanyName: String(source.registeredCompanyName || '').trim(),
    tradingName: String(source.tradingName || '').trim(),
    companyRegistrationNumber: String(source.companyRegistrationNumber || '').trim(),
    vatNumber: String(source.vatNumber || '').trim(),
    taxNumber: String(source.taxNumber || '').trim(),
    registeredAddressLine1: String(source.registeredAddressLine1 || '').trim(),
    registeredAddressLine2: String(source.registeredAddressLine2 || '').trim(),
    suburb: String(source.suburb || '').trim(),
    city: String(source.city || '').trim(),
    province: String(source.province || '').trim(),
    postalCode: String(source.postalCode || '').trim(),
    country: String(source.country || '').trim(),
    accountsContactName: String(source.accountsContactName || '').trim(),
    accountsContactEmail: String(source.accountsContactEmail || '').trim(),
    accountsContactPhone: String(source.accountsContactPhone || '').trim()
  };
}

function renderReportingHourSelector(fieldKey, value = 0, openDropdown = '', ariaLabel = 'Reporting hour') {
  const currentHour = normalizeHourValue(value);
  const options = Array.from({ length: 24 }, (_, hour) => ({
    value: hour,
    label: `${String(hour).padStart(2, '0')}:00`
  }));
  return renderSettingsDropdown({
    id: fieldKey,
    selectedValue: currentHour,
    openDropdown,
    options,
    className: 'settingsReportingHourDropdown',
    ariaLabel
  });
}

function resolveReportingDayHour(settings = {}) {
  const direct = settings.reportingDayFromHour
    ?? settings.reportingFromHour
    ?? settings.tradingDayStartHour
    ?? settings.tradeDayStartHour;
  if (direct !== undefined && direct !== null && direct !== '') return normalizeHourValue(direct);
  const match = String(settings.tradingTime || settings.tradingEndTime || '23:59').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  const endHour = normalizeHourValue(match[1]);
  const endMinute = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return Math.ceil((endHour * 60 + endMinute) / 60) % 24;
}

function normalizeHourValue(value, fallback = 0) {
  const match = String(value ?? '').trim().match(/^(\d{1,2})(?::\d{2})?$/);
  const number = match ? Number(match[1]) : Number(value);
  if (!Number.isFinite(number)) return Math.max(0, Math.min(23, Number(fallback) || 0));
  return Math.max(0, Math.min(23, Math.round(number)));
}

function renderSettingsDropdown({ id, selectedValue, options = [], openDropdown = '', className = '', ariaLabel = '' }) {
  const selected = options.find((option) => String(option.value) === String(selectedValue));
  const isOpen = openDropdown === id;
  const isCompact = className.includes('ReportingHour');
  // Deliberately NOT using daisyUI's `dropdown`/`dropdown-content` classes: daisyUI v5's dropdown
  // positioning relies on the CSS anchor-positioning API, which briefly renders the popup at its
  // fallback position (screen center) before the anchor calculation resolves — very visible here
  // since this whole component re-renders from scratch on every open/close rather than toggling
  // an already-mounted element. Plain `relative`/`absolute` positioning has no such flash, and the
  // menu is only rendered into the DOM at all while open, so there's nothing to mis-position.
  return `
    <div class="relative ${isCompact ? '' : 'w-full'}" data-settings-dropdown-root>
      <button type="button" class="btn btn-outline font-normal ${isCompact ? 'btn-sm w-28 justify-between gap-1 px-3' : 'btn-block justify-between'}" data-settings-dropdown="${escapeAttribute(id)}" aria-expanded="${isOpen}" ${ariaLabel ? `aria-label="${escapeAttribute(ariaLabel)}"` : ''}>
        <span class="truncate">${escapeHtml(selected?.label || 'Select')}</span>
        ${smallIcon('chevronDown', 'w-4 h-4 opacity-60')}
      </button>
      ${isOpen ? `
        <ul class="menu menu-sm gap-1 p-2 bg-base-100/80 backdrop-blur-md rounded-box shadow-lg border border-base-300/60 absolute top-full left-0 z-20 mt-1 flex-nowrap overflow-y-auto max-h-64 ${isCompact ? 'w-28' : 'w-full'}">
          ${options.map((option) => {
            const isSelected = String(option.value) === String(selectedValue);
            return `
            <li>
              <button
                type="button"
                data-settings-option
                data-settings-option-field="${escapeAttribute(id)}"
                data-settings-option-value="${escapeAttribute(option.value)}"
                class="btn btn-sm btn-block justify-start font-normal normal-case ${isSelected ? 'btn-primary' : 'btn-ghost'}"
              >
                ${escapeHtml(option.label)}
              </button>
            </li>
          `;
          }).join('')}
        </ul>
      ` : ''}
    </div>
  `;
}

function createDefaultSettings(state = {}) {
  return {
    vatRate: 15,
    siteName: state.workspace?.siteName || '',
    tradingTime: '23:59',
    reportingDayFromHour: 0,
    reportingDayToHour: 0,
    tradingDayStartHour: 0,
    tradingDayStartMinutes: 0,
    uiScale: 'normal',
    logoutTimeout: 30,
    costingMethod: 'last',
    orgId: '',
    corpId: '',
    viewingOnly: false,
    stockDepletionEnabled: false,
    stockDepletionEnabledAt: '',
    yocoCategoryMap: {},
    stockCategoryRoutingMap: {},
    yocoStoreLocationsAsStockLocations: false,
    restaurantThemeId: DEFAULT_RESTAURANT_THEME_ID,
    restaurantBackgroundId: DEFAULT_RESTAURANT_BACKGROUND_ID,
    restaurantLogoDataUrl: '',
    restaurantLogoName: '',
    restaurantBackgroundDataUrl: '',
    restaurantBackgroundName: ''
  };
}

function renderNotice(message, tone) {
  const toneClass = tone === 'error' ? 'alert-error' : tone === 'success' ? 'alert-success' : 'alert-warning';
  return `<div class="alert ${toneClass} mb-4"><span>${escapeHtml(message)}</span></div>`;
}

function renderResetTotalsDialog(settingsState = {}) {
  if (!settingsState.confirmResetTotals) return '';
  const resetMode = typeof settingsState.confirmResetTotals === 'object'
    ? settingsState.confirmResetTotals.mode
    : 'reporting_stock';
  const includesStock = resetMode === 'reporting_stock' || resetMode === 'dashboard_stock';
  const title = includesStock ? 'Reset Reporting + Stock On Hand' : 'Reset Reporting';
  const copy = includesStock
    ? 'This clears reporting ledger/history data and sets stock on hand to zero for every selling location in this profile. Products, recipes, stock item master data, and stock item costings are kept.'
    : 'This clears reporting ledger/history data, movement history, sales signatures, and operational reporting documents for this profile. Stock on hand, products, recipes, stock item master data, and costings are kept.';
  const confirmLabel = includesStock ? 'Reset Reporting and Stock Values' : 'Reset Reporting';
  const typedValue = String(settingsState.confirmResetTotals.confirmText || '');
  const canProceed = typedValue === confirmLabel && settingsState.actionStatus !== 'resetting';
  return `
    <div class="settingsModalBackdrop" role="presentation">
      <section class="settingsModal" role="dialog" aria-modal="true" aria-labelledby="settings-reset-title">
        <header>
          <div>
            <p>Super User Action</p>
            <h2 id="settings-reset-title">${escapeHtml(title)}</h2>
          </div>
          <button type="button" class="settingsIconButton" data-settings-cancel-reset-totals aria-label="Close">${icon('x')}</button>
        </header>
        <p class="settingsConfirmText">
          ${escapeHtml(copy)}
        </p>
        <label class="settingsConfirmInput">
          <span>Type <strong>${escapeHtml(confirmLabel)}</strong> to proceed</span>
          <input
            type="text"
            value="${escapeAttribute(typedValue)}"
            placeholder="${escapeAttribute(confirmLabel)}"
            data-settings-reset-confirm-text
            data-focus-key="settings-reset-confirm-text"
          />
        </label>
        <div class="settingsModalActions">
          <button type="button" class="settingsSecondaryButton" data-settings-cancel-reset-totals>Cancel</button>
          <button type="button" class="settingsDangerButton" data-settings-confirm-reset-totals ${canProceed ? '' : 'disabled'}>
            ${icon('trash')}
            <span>${settingsState.actionStatus === 'resetting' ? 'Resetting...' : escapeHtml(confirmLabel)}</span>
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderToast(toast) {
  if (!toast?.message) return '';
  return `
    <div class="settingsToast settingsToast--${escapeAttribute(toast.type || 'success')}" role="status">
      <span>${escapeHtml(toast.message)}</span>
      <button type="button" data-settings-toast-close aria-label="Dismiss">${icon('x')}</button>
    </div>
  `;
}

// Raw icon() SVGs carry no explicit width/height, so inside a flex/badge container they stretch
// to fill the cross-axis instead of rendering at a sane icon size. This forces a fixed box.
function smallIcon(name, cls = 'w-4 h-4') {
  return `<span class="${cls} inline-flex shrink-0 [&>svg]:w-full [&>svg]:h-full">${icon(name)}</span>`;
}

function icon(name) {
  const icons = {
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    graduation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/><path d="M22 10v6"/></svg>',
    percent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M19 5 5 19"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/></svg>',
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
    network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="m8.7 10.7 6.6-3.4M8.7 13.3l6.6 3.4"/></svg>',
    truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11v10H3z"/><path d="M14 10h4l3 3v4h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-4.2-4.2a2 2 0 0 0-2.8 0L6 19"/></svg>',
    palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 0 0 0 18h1.5a2.5 2.5 0 0 0 0-5H13a1.5 1.5 0 0 1 0-3h1a7 7 0 0 0-2-10z"/><circle cx="7.5" cy="10" r=".7"/><circle cx="9.5" cy="6.8" r=".7"/><circle cx="14" cy="7" r=".7"/><circle cx="16.5" cy="10.5" r=".7"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4 10-10"/></svg>',
    receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h4"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 10v6"/><path d="M12 7h.01"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
  };
  return icons[name] || icons.info;
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
  return escapeHtml(value);
}
