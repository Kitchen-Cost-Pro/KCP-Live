import '../styles/integrations.css';
import '../styles/fieldHelp.css';
import gmailLogo from '../assets/integrations/gmail.svg';
import yocoLogo from '../assets/integrations/yoco.svg';
import xeroLogo from '../assets/integrations/xero.png';
import googleDriveLogo from '../assets/integrations/google-drive.svg';
import squareLogo from '../assets/integrations/square.svg';
import quickbooksLogo from '../assets/integrations/quickbooks.svg';
import {
  connectYocoIntegration,
  disconnectGmailIntegration,
  disconnectXeroIntegration,
  disconnectYocoIntegration,
  saveXeroSettings,
  startGmailConnection,
  startXeroConnection,
  subscribeGmailIntegration,
  subscribeXeroIntegration,
  subscribeYocoIntegration,
  syncXeroNow,
  resolveXeroSupplierMatch,
  fetchXeroTaxRates,
  fetchXeroTrackingCategories,
  fetchXeroAccounts,
  syncYocoCatalogue
} from '../services/integrationService.js';
import {
  subscribeDriveIntegration,
  startDriveConnection,
  disconnectDriveIntegration,
  saveDriveSettings,
  syncDriveNow
} from '../services/driveService.js';
import { canManagePermissionSets } from '../services/roleService.js';
import { bindFieldHelpTooltips, renderFieldHelpLabel } from './fieldHelp.js';

const INTEGRATIONS = [
  {
    id: 'yoco',
    name: 'Yoco',
    category: 'POS & Payments',
    status: 'Available',
    stage: 'Primary',
    popular: true,
    description: 'Connect Yoco sales, payments, refunds, and tender data into Kitchen Cost Pro.',
    logo: yocoLogo,
    tone: 'blue',
    action: 'Prepare Setup'
  },
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'Email & Communications',
    status: 'Available',
    stage: 'Live',
    popular: true,
    description: 'Link a Gmail account to send supplier emails and purchase orders from the user account your team trusts.',
    logo: gmailLogo,
    tone: 'red',
    action: 'Connect Gmail'
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'Cloud Storage',
    status: 'Available',
    stage: 'Live',
    popular: false,
    description: 'Push GRV and Credit Note PDFs straight into a connected Google Drive folder, and optionally turn on the KCP Assistant to pre-fill GRVs from photographed supplier invoices.',
    logo: googleDriveLogo,
    tone: 'blue',
    action: 'Connect Google Drive'
  },
  {
    id: 'xero',
    name: 'Xero',
    category: 'Accounting',
    status: 'Available',
    stage: 'Live',
    popular: false,
    description: 'Push daily sales summaries, GRVs as Bills with PDFs, and your product catalogue into your Xero ledger.',
    logo: xeroLogo,
    tone: 'blue',
    action: 'Connect Xero'
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks',
    category: 'Accounting',
    status: 'Coming Soon',
    stage: 'Planned',
    popular: false,
    description: 'Push daily sales summaries, GRVs, and your product catalogue into your QuickBooks ledger.',
    logo: quickbooksLogo,
    tone: 'amber',
    action: 'Coming Soon'
  },
  {
    id: 'square',
    name: 'Square',
    category: 'POS & Payments',
    status: 'Coming Soon',
    stage: 'Planned',
    popular: false,
    description: 'Bring Square sales, payments, and catalogue data into Kitchen Cost Pro.',
    logo: squareLogo,
    tone: 'amber',
    action: 'Coming Soon'
  },
  {
    id: 'stockmate',
    name: 'StockMate',
    category: 'Inventory & Stock',
    status: 'Coming Soon',
    stage: 'Planned',
    popular: false,
    description: 'Keep StockMate inventory counts and Kitchen Cost Pro stock levels in sync.',
    icon: 'boxes',
    tone: 'amber',
    action: 'Coming Soon'
  }
];

const CATEGORY_OPTIONS = [
  { value: 'all', label: 'All Categories' },
  { value: 'POS & Payments', label: 'POS & Payments' },
  { value: 'Email & Communications', label: 'Email & Communications' },
  { value: 'Accounting', label: 'Accounting' },
  { value: 'Cloud Storage', label: 'Cloud Storage' },
  { value: 'Inventory & Stock', label: 'Inventory & Stock' }
];

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'Active', label: 'Active' },
  { value: 'Available', label: 'Available' },
  { value: 'Setup Required', label: 'Setup Required' },
  { value: 'Coming Soon', label: 'Coming Soon' }
];

const yocoDrawerState = {
  open: false,
  busy: false,
  message: 'Sales history starts from the latest saved Yoco sale date. First connection imports all available Yoco sales history.',
  tone: '',
  summary: null
};

const gmailDrawerState = {
  open: false,
  busy: false,
  message: 'Connect Gmail with send-only permission for supplier communication.',
  tone: '',
  status: null
};

const xeroDrawerState = {
  open: false,
  busy: false,
  message: 'Connect Xero, then set your account codes and tax types before turning sync on. KCP pushes one summarized invoice per day for completed sales, your product catalogue as Xero Items, and each GRV as a Draft Bill with its PDF attached (also once daily, alongside sales).',
  tone: '',
  status: null,
  activeTab: 'sales',
  // null = not yet fetched, [] = fetched but empty/failed. Loaded lazily (see
  // loadXeroTaxRatesIfNeeded) rather than on every status poll — it's a real Xero API call, not a
  // free local read, so it should happen once per modal session, not repeatedly. Shared across
  // however many `view` DOM trees get built during that session (see loadXeroTaxRatesIfNeeded's doc
  // comment on why that matters) — in-flight-fetch tracking lives in its own module-level variable,
  // not here, since a shared PROMISE (not just a boolean) is what lets every view join one fetch.
  taxRates: null,
  // Same lazy-load-once-per-modal-session contract as taxRates above, for the Tracking Categories
  // picker (Location tracking category, purchases tab).
  trackingCategories: null,
  // Same lazy-load-once-per-modal-session contract as taxRates above, for every account-code field
  // (sales/item/purchases/COD/wastage) — see loadXeroAccountsIfNeeded.
  accounts: null
};

const driveDrawerState = {
  open: false,
  busy: false,
  message: 'Connect a Google Drive account to receive GRV and Credit Note PDFs. Each connected workspace uses its own Drive — nothing is stored on KCP’s servers.',
  tone: '',
  status: null
};

function closeAllXeroComboboxes(view) {
  view.querySelectorAll('[data-xero-combobox-list]').forEach((list) => { list.hidden = true; });
  view.querySelectorAll('[data-xero-combobox-trigger]').forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
}

// One delegated listener, bound ONCE when the Xero modal's events are wired, rather than
// per-element listeners on each trigger/option — the combobox markup gets swapped in dynamically
// after the tax-rates/tracking-categories fetch resolves, which would destroy any listeners
// attached to the earlier (plain-input-fallback) elements. Delegation survives that swap because it
// re-checks the live event target on every click rather than holding a stale element reference.
function bindXeroComboboxEvents(view) {
  if (view.dataset.xeroComboboxBound === 'true') return;
  view.dataset.xeroComboboxBound = 'true';
  view.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-xero-combobox-trigger]');
    if (trigger) {
      const combobox = trigger.closest('[data-xero-combobox]');
      const list = combobox?.querySelector('[data-xero-combobox-list]');
      const wasOpen = list ? !list.hidden : false;
      closeAllXeroComboboxes(view);
      if (list && !wasOpen) {
        list.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    const option = event.target.closest('[data-xero-combobox-list] .xeroComboboxOption');
    if (option) {
      const combobox = option.closest('[data-xero-combobox]');
      const hiddenInput = combobox?.querySelector('input[type="hidden"]');
      const label = combobox?.querySelector('[data-xero-combobox-label]');
      if (hiddenInput) hiddenInput.value = option.dataset.value || '';
      if (label) label.textContent = option.textContent.trim();
      combobox?.querySelectorAll('.xeroComboboxOption').forEach((candidate) => {
        const isSelected = candidate === option;
        candidate.classList.toggle('is-selected', isSelected);
        candidate.setAttribute('aria-selected', String(isSelected));
      });
      closeAllXeroComboboxes(view);
      return;
    }
    if (!event.target.closest('[data-xero-combobox]')) closeAllXeroComboboxes(view);
  });
  view.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && view.querySelector('[data-xero-combobox-list]:not([hidden])')) {
      closeAllXeroComboboxes(view);
    }
  });
}

// A native <select>'s CLOSED control can be fully CSS-styled, but its OPEN popup list is rendered
// by the OS/browser and can't be restyled in Chrome/Safari (only Firefox partially allows it) — a
// real platform limitation, not a missed CSS rule. This custom combobox sidesteps that entirely by
// never using a real <select>: a styled trigger button opens a styled <ul role="listbox"> instead.
// A hidden <input> carries the actual value under the SAME data-attribute a plain <input>/<select>
// would have used, so every existing read (the settings form's submit handler) and write
// (refreshXeroSettingsFormFields/refreshXeroTaxTypeControls) call site keeps working unchanged.
// Opening/closing/selecting is wired via ONE delegated click listener (see bindXeroComboboxEvents)
// rather than per-element listeners, since this markup gets swapped in dynamically after the tax
// rates/tracking categories fetch resolves — per-element listeners attached before that would be
// destroyed the moment `wrapper.innerHTML` is reassigned.
function renderXeroCombobox({ dataAttr, currentValue, emptyLabel, options }) {
  const known = options.find((option) => option.value === currentValue);
  const displayLabel = known
    ? known.label
    : currentValue
      ? `${currentValue} (currently set — not found in Xero)`
      : emptyLabel;
  const allOptions = [
    { value: '', label: emptyLabel },
    ...(!known && currentValue ? [{ value: currentValue, label: `${currentValue} (currently set — not found in Xero)` }] : []),
    ...options
  ];
  return `
    <div class="xeroCombobox" data-xero-combobox>
      <input type="hidden" value="${escapeAttribute(currentValue || '')}" ${dataAttr} />
      <button type="button" class="xeroComboboxTrigger" data-xero-combobox-trigger aria-haspopup="listbox" aria-expanded="false">
        <span class="xeroComboboxTriggerLabel" data-xero-combobox-label>${escapeHtml(displayLabel)}</span>
        ${icon('chevronDown')}
      </button>
      <ul class="xeroComboboxList" data-xero-combobox-list role="listbox" hidden>
        ${allOptions.map((option) => `<li role="option" class="xeroComboboxOption${option.value === (currentValue || '') ? ' is-selected' : ''}" data-value="${escapeAttribute(option.value)}" aria-selected="${option.value === (currentValue || '')}">${escapeHtml(option.label)}</li>`).join('')}
      </ul>
    </div>
  `;
}

// Builds the {value,label} list a taxType combobox shows, from the raw Xero API summaries —
// shared by the render path and refreshXeroSettingsFormFields's label-sync path so the exact same
// formatting/filtering logic (never duplicated) backs both.
function buildXeroTaxRateOptions(taxRates, applicability) {
  const applicable = taxRates.filter((rate) => (applicability === 'revenue' ? rate.canApplyToRevenue !== false : rate.canApplyToExpenses !== false));
  return [...applicable]
    .sort((a, b) => {
      if (a.status === b.status) return a.name.localeCompare(b.name);
      return a.status === 'ACTIVE' ? -1 : 1;
    })
    .map((rate) => ({
      value: rate.taxType,
      label: `${rate.name} (${rate.taxType})${rate.status !== 'ACTIVE' ? ` — ${rate.status}` : ''}`
    }));
}

// Xero's TaxType codes (e.g. "INPUT2") are never shown in the Chart of Accounts UI, only the
// friendly Name — so a person configuring these fields had no way to see which literal code was
// valid, or whether it was Active in their specific organisation, without leaving KCP. This is
// exactly what caused a real outage: "INPUT2" looked right (it's a standard default) but was
// Archived for this org, and nothing surfaced that until every GRV push failed in production.
// Renders a live combobox once tax rates are loaded; falls back to the original free-text input
// before they're loaded (or if Xero isn't connected/the fetch failed) so the field never breaks.
//
// Regression: the dropdown used to list EVERY tax rate Xero returned in every field, with no
// filtering — so a purchases-only rate (e.g. "Standard Rate Purchases") could be picked for the
// Sales tab's tax type, which Xero itself flatly rejects at push time: "The TaxType code 'X' cannot
// be used with account code 'Y'" (a rate's CanApplyToRevenue/CanApplyToExpenses flags gate which
// account types it's valid for). `applicability` filters the list to only rates Xero would actually
// accept for that field — 'revenue' for Sales-tab fields, 'expenses' for Purchases-tab fields.
function renderXeroTaxTypeControl({ dataAttr, currentValue, placeholder, taxRates, applicability }) {
  if (!Array.isArray(taxRates) || !taxRates.length) {
    return `<input type="text" placeholder="${escapeAttribute(placeholder)}" value="${escapeAttribute(currentValue || '')}" ${dataAttr} />`;
  }
  return renderXeroCombobox({ dataAttr, currentValue, emptyLabel: '— Select a tax rate —', options: buildXeroTaxRateOptions(taxRates, applicability) });
}

// Builds the {value,label} list an account-code combobox shows — same sharing reasoning as
// buildXeroTaxRateOptions. `filterClass` narrows the list to the Xero account Class actually valid
// for that field (e.g. REVENUE for sales/item, EXPENSE for purchases/wastage expense, ASSET for
// the wastage inventory account, BANK for the COD payment account) — Xero itself doesn't reject a
// mismatched class the way it rejects a mismatched tax type, but showing every account regardless
// of class would make the right one much harder to find in a long Chart of Accounts.
function buildXeroAccountOptions(accounts, filterClass) {
  const applicable = filterClass ? accounts.filter((account) => account.class === filterClass) : accounts;
  return [...applicable]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((account) => ({
      value: account.code,
      label: `${account.code} — ${account.name}`
    }));
}

// Same live-picker contract as renderXeroTaxTypeControl: every account-code field used to be a
// free-text input a person had to know the raw Xero GL code for, with no way to tell from inside
// KCP whether that code still exists or is Active in this organisation.
function renderXeroAccountCodeControl({ dataAttr, currentValue, placeholder, accounts, filterClass }) {
  if (!Array.isArray(accounts) || !accounts.length) {
    return `<input type="text" placeholder="${escapeAttribute(placeholder)}" value="${escapeAttribute(currentValue || '')}" ${dataAttr} />`;
  }
  return renderXeroCombobox({ dataAttr, currentValue, emptyLabel: '— Select an account —', options: buildXeroAccountOptions(accounts, filterClass) });
}

// Builds the {value,label} list a location-tracking-category combobox shows — same sharing
// reasoning as buildXeroTaxRateOptions.
function buildXeroTrackingCategoryOptions(trackingCategories) {
  return trackingCategories.map((category) => ({
    value: category.id,
    label: `${category.name}${category.status !== 'ACTIVE' ? ` — ${category.status}` : ''}`
  }));
}

// Xero organisations have at most 2 Tracking Categories, each with a fixed set of Options — a
// KCP location is matched to an Option by name (see tracking.ts), so this settings field only
// needs to pick WHICH category represents "location", not any individual option. Same live-picker
// contract as renderXeroTaxTypeControl: falls back to plain text before the fetch completes.
function renderXeroTrackingCategoryControl({ currentValue, trackingCategories }) {
  if (!Array.isArray(trackingCategories) || !trackingCategories.length) {
    return `<input type="text" placeholder="Loaded once Xero is connected" value="${escapeAttribute(currentValue || '')}" data-xero-location-tracking-category readonly />`;
  }
  return renderXeroCombobox({
    dataAttr: 'data-xero-location-tracking-category',
    currentValue,
    emptyLabel: '— None (don\'t tag with location) —',
    options: buildXeroTrackingCategoryOptions(trackingCategories)
  });
}

// Module-level (not on xeroDrawerState) — holds the SHARED in-flight fetch promise, if any, so
// every caller joins the SAME request rather than each starting its own.
let xeroTrackingCategoriesFetchPromise = null;

// Regression: the Integrations page gets re-rendered (a brand new `view` DOM tree) whenever OTHER
// unrelated app state resolves (Yoco/Gmail status, access permissions, etc. — see
// renderContentForSection in appShell.js), not just once per page load. The old guard
// (`if (trackingCategories !== null) return`) meant that once the FIRST view's fetch succeeded and
// cached the result, every SUBSEQUENT view's call to this function bailed out immediately without
// ever applying the already-fetched data to ITS OWN wrapper — so whichever view the user happened
// to be looking at after a re-render could show the plain fallback input forever, depending purely
// on timing, even though the data had been fetched successfully. Every call now ALWAYS applies
// already-cached data to its own `view`, and concurrent in-flight calls join one shared promise
// instead of each firing a separate request.
async function loadXeroTrackingCategoriesIfNeeded(view) {
  if (xeroDrawerState.status?.connectionActive !== true) return;
  if (xeroDrawerState.trackingCategories?.length) {
    refreshXeroTrackingCategoryControl(view);
    return;
  }
  if (!xeroTrackingCategoriesFetchPromise) {
    xeroTrackingCategoriesFetchPromise = fetchXeroTrackingCategories(view.dataset.workspaceId || '')
      .then((categories) => {
        xeroDrawerState.trackingCategories = categories;
        return categories;
      })
      .catch(() => {
        // Left as null (not []) on failure — a genuinely empty successful fetch is cached as [] and
        // won't retry, but a FAILED fetch (e.g. hit before this route was deployed, or a transient
        // network error) must not be cached as "confirmed empty" forever for the rest of this
        // browser session.
        xeroDrawerState.trackingCategories = null;
        return null;
      })
      .finally(() => {
        xeroTrackingCategoriesFetchPromise = null;
      });
  }
  // Captured into a local before awaiting — the shared module variable gets reset to null in
  // `.finally` above the moment the fetch settles, so re-reading it after the await (instead of
  // using this local reference) would risk picking up null or a newer, unrelated promise.
  const promise = xeroTrackingCategoriesFetchPromise;
  const categories = await promise;
  if (categories?.length) refreshXeroTrackingCategoryControl(view);
}

function refreshXeroTrackingCategoryControl(view) {
  const wrapper = view.querySelector('[data-xero-tax-control="locationTrackingCategoryId"]');
  if (!wrapper) return;
  const settings = xeroDrawerState.status?.settings || {};
  wrapper.innerHTML = renderXeroTrackingCategoryControl({
    currentValue: wrapper.querySelector('input,select')?.value || settings.locationTrackingCategoryId,
    trackingCategories: xeroDrawerState.trackingCategories
  });
}

// Module-level (not on xeroDrawerState) — holds the SHARED in-flight fetch promise, if any.
let xeroTaxRatesFetchPromise = null;

// Same re-render race as loadXeroTrackingCategoriesIfNeeded (see its doc comment): the Integrations
// page can be rebuilt into a brand new `view` DOM tree at any point (whenever unrelated app state
// resolves elsewhere), so this must ALWAYS apply already-cached tax rates to whichever `view` it's
// called with, not just the one that originally fetched them — otherwise whichever view the user
// happens to be looking at after a re-render can be stuck showing the plain fallback input
// indefinitely, purely depending on timing, even though the data was fetched successfully earlier.
async function loadXeroTaxRatesIfNeeded(view) {
  if (xeroDrawerState.status?.connectionActive !== true) return;
  if (xeroDrawerState.taxRates?.length) {
    refreshXeroTaxTypeControls(view);
    return;
  }
  if (!xeroTaxRatesFetchPromise) {
    xeroTaxRatesFetchPromise = fetchXeroTaxRates(view.dataset.workspaceId || '')
      .then((rates) => {
        xeroDrawerState.taxRates = rates;
        return rates;
      })
      .catch(() => {
        // Left as null (not []) on failure — see loadXeroTrackingCategoriesIfNeeded's identical
        // comment: a genuinely empty successful fetch is cached as [] and won't retry, but a FAILED
        // fetch must not be cached as "confirmed empty" forever for the rest of this browser session.
        xeroDrawerState.taxRates = null;
        return null;
      })
      .finally(() => {
        xeroTaxRatesFetchPromise = null;
      });
  }
  const promise = xeroTaxRatesFetchPromise;
  const rates = await promise;
  if (rates?.length) refreshXeroTaxTypeControls(view);
}

// Runs once, right after the fetch resolves — swaps the three plain text inputs for the live
// dropdown in place, without a full modal re-render that would lose any in-progress edits
// elsewhere in the form.
function refreshXeroTaxTypeControls(view) {
  const settings = xeroDrawerState.status?.settings || {};
  const fields = [
    { wrapper: 'defaultTaxType', dataAttr: 'data-xero-tax-type', currentValue: settings.defaultTaxType, placeholder: 'e.g. OUTPUT2', applicability: 'revenue' },
    { wrapper: 'salesExemptTaxType', dataAttr: 'data-xero-sales-exempt-tax-type', currentValue: settings.salesExemptTaxType, placeholder: 'e.g. EXEMPTOUTPUT', applicability: 'revenue' },
    { wrapper: 'purchaseTaxType', dataAttr: 'data-xero-purchase-tax-type', currentValue: settings.purchaseTaxType, placeholder: 'e.g. INPUT2', applicability: 'expenses' },
    { wrapper: 'purchaseExemptTaxType', dataAttr: 'data-xero-purchase-exempt-tax-type', currentValue: settings.purchaseExemptTaxType, placeholder: 'e.g. EXEMPTINPUT', applicability: 'expenses' }
  ];
  fields.forEach((field) => {
    const wrapper = view.querySelector(`[data-xero-tax-control="${field.wrapper}"]`);
    if (!wrapper) return;
    wrapper.innerHTML = renderXeroTaxTypeControl({
      dataAttr: field.dataAttr,
      currentValue: wrapper.querySelector('input,select')?.value || field.currentValue,
      placeholder: field.placeholder,
      taxRates: xeroDrawerState.taxRates,
      applicability: field.applicability
    });
  });
}

// Module-level (not on xeroDrawerState) — holds the SHARED in-flight fetch promise, if any.
let xeroAccountsFetchPromise = null;

// Same re-render race as loadXeroTaxRatesIfNeeded/loadXeroTrackingCategoriesIfNeeded (see their doc
// comments) — always applies already-cached accounts to whichever `view` it's called with.
async function loadXeroAccountsIfNeeded(view) {
  if (xeroDrawerState.status?.connectionActive !== true) return;
  if (xeroDrawerState.accounts?.length) {
    refreshXeroAccountCodeControls(view);
    return;
  }
  if (!xeroAccountsFetchPromise) {
    xeroAccountsFetchPromise = fetchXeroAccounts(view.dataset.workspaceId || '')
      .then((accounts) => {
        xeroDrawerState.accounts = accounts;
        return accounts;
      })
      .catch(() => {
        // Left as null (not []) on failure — same reasoning as the tax-rates/tracking-categories
        // fetches: a genuinely empty successful fetch is cached as [] and won't retry, but a FAILED
        // fetch must not be cached as "confirmed empty" forever for the rest of this browser session.
        xeroDrawerState.accounts = null;
        return null;
      })
      .finally(() => {
        xeroAccountsFetchPromise = null;
      });
  }
  const promise = xeroAccountsFetchPromise;
  const accounts = await promise;
  if (accounts?.length) refreshXeroAccountCodeControls(view);
}

// Runs once, right after the fetch resolves — swaps every plain text account-code input for the
// live dropdown in place, same pattern as refreshXeroTaxTypeControls.
function refreshXeroAccountCodeControls(view) {
  const settings = xeroDrawerState.status?.settings || {};
  const fields = [
    { wrapper: 'salesAccountCode', dataAttr: 'data-xero-sales-account', currentValue: settings.salesAccountCode, placeholder: 'e.g. 200', filterClass: 'REVENUE' },
    { wrapper: 'itemAccountCode', dataAttr: 'data-xero-item-account', currentValue: settings.itemAccountCode, placeholder: 'Defaults to sales account', filterClass: 'REVENUE' },
    { wrapper: 'purchaseAccountCode', dataAttr: 'data-xero-purchase-account', currentValue: settings.purchaseAccountCode, placeholder: 'e.g. 300', filterClass: 'EXPENSE' },
    { wrapper: 'codPaymentAccountCode', dataAttr: 'data-xero-cod-payment-account', currentValue: settings.codPaymentAccountCode, placeholder: 'e.g. 090', filterClass: 'BANK' },
    { wrapper: 'wastageExpenseAccountCode', dataAttr: 'data-xero-wastage-expense-account', currentValue: settings.wastageExpenseAccountCode, placeholder: 'e.g. 310', filterClass: 'EXPENSE' },
    { wrapper: 'wastageAssetAccountCode', dataAttr: 'data-xero-wastage-asset-account', currentValue: settings.wastageAssetAccountCode, placeholder: 'e.g. 630', filterClass: 'ASSET' }
  ];
  fields.forEach((field) => {
    const wrapper = view.querySelector(`[data-xero-account-control="${field.wrapper}"]`);
    if (!wrapper) return;
    wrapper.innerHTML = renderXeroAccountCodeControl({
      dataAttr: field.dataAttr,
      currentValue: wrapper.querySelector('input,select')?.value || field.currentValue,
      placeholder: field.placeholder,
      accounts: xeroDrawerState.accounts,
      filterClass: field.filterClass
    });
  });
}

export function renderIntegrations({ state } = {}) {
  const workspaceName = state?.workspace?.siteName || 'Workspace';
  const workspaceId = state?.workspace?.id || '';
  const canDisconnectYoco = state?.access?.currentIsKcpSuperUser === true;
  // Matches the backend's canManageXero gate (modules/xero-engine/admin-permissions.ts): a
  // workspace owner/admin, or a KCP superuser — not the stricter currentIsKcpSuperUser-only bar
  // Yoco disconnect uses, since connecting Xero is meant to be a normal workspace-owner action.
  const canManageXero = canManagePermissionSets(state?.access?.currentRole, state?.access?.currentIsSuperUser === true || state?.access?.currentIsKcpSuperUser === true);
  const cachedYocoStatus = getCachedYocoStatus(workspaceId);
  const cachedGmailStatus = getCachedGmailStatus(workspaceId);
  const cachedXeroStatus = getCachedXeroStatus(workspaceId);
  const cachedDriveStatus = getCachedDriveStatus(workspaceId);
  const integrations = getRenderedIntegrations(cachedYocoStatus, cachedGmailStatus, cachedXeroStatus, cachedDriveStatus);
  const view = document.createElement('section');
  view.className = 'integrationsView';
  view.dataset.workspaceId = workspaceId;
  view.dataset.activeTab = 'all';
  view.dataset.category = 'all';
  view.dataset.status = 'all';
  view.innerHTML = `
    <div class="integrationsShell">
      <header class="integrationsHeader">
        <div>
          <p>Workspace Connections</p>
          <h1>Integrations</h1>
          <span>${escapeHtml(workspaceName)} integrations hub.</span>
        </div>
        <button type="button" class="integrationsDocsButton" data-integration-docs>
          ${icon('book')}
          <span>View API Documentation</span>
          ${icon('external')}
        </button>
      </header>

      <section class="integrationsToolbar" aria-label="Integration filters">
        <div class="integrationsTabs" role="tablist" aria-label="Integration status tabs">
          ${renderTab('all', 'All Integrations', true)}
          ${renderTab('available', 'Available', false)}
          ${renderTab('popular', 'Popular', false)}
        </div>
        <div class="integrationsFilters">
          <label class="integrationsSearch">
            ${icon('search')}
            <input type="search" placeholder="Search integrations..." data-integrations-search data-focus-key="integrations-search" />
          </label>
          ${renderDropdown('category', CATEGORY_OPTIONS, 'all')}
          ${renderDropdown('status', STATUS_OPTIONS, 'all')}
        </div>
      </section>

      <section class="integrationsGrid" data-integrations-grid>
        ${renderIntegrationGroups(integrations)}
      </section>

      <footer class="integrationsFooter">
        <span data-integrations-count>Showing ${integrations.length} of ${integrations.length} integrations</span>
        <div class="integrationsPager" aria-label="Integration pagination">
          <button type="button" disabled>${icon('chevronLeft')}</button>
          <strong>1</strong>
          <button type="button" disabled>${icon('chevronRight')}</button>
        </div>
      </footer>

      <div class="integrationsEmpty" data-integrations-empty hidden>
        <strong>No integrations match those filters.</strong>
        <span>Clear the search or choose a broader category.</span>
      </div>

      ${renderYocoModal({ canDisconnectYoco })}
      ${renderGmailModal()}
      ${renderXeroModal({ canManageXero })}
      ${renderDriveModal({ canManageDrive: canManageXero })}
    </div>
  `;

  bindIntegrationEvents(view);
  bindFieldHelpTooltips(view);
  if (cachedYocoStatus) updateYocoStatus(view, cachedYocoStatus, { skipCache: true });
  if (cachedGmailStatus) updateGmailStatus(view, cachedGmailStatus, { skipCache: true });
  if (cachedXeroStatus) updateXeroStatus(view, cachedXeroStatus, { skipCache: true });
  if (cachedDriveStatus) updateDriveStatus(view, cachedDriveStatus, { skipCache: true });
  bindYocoStatus(view, workspaceId);
  bindGmailStatus(view, workspaceId);
  bindXeroStatus(view, workspaceId);
  bindDriveStatus(view, workspaceId);
  setYocoBusy(view, yocoDrawerState.busy);
  setGmailBusy(view, gmailDrawerState.busy);
  setXeroBusy(view, xeroDrawerState.busy);
  setDriveBusy(view, driveDrawerState.busy);
  applyIntegrationFilters(view);
  return view;
}

function bindIntegrationEvents(view) {
  view.querySelector('[data-integrations-search]')?.addEventListener('input', () => applyIntegrationFilters(view));

  view.querySelectorAll('[data-integrations-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      view.dataset.activeTab = button.dataset.integrationsTab || 'all';
      view.querySelectorAll('[data-integrations-tab]').forEach((tab) => {
        const isActive = tab === button;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
      });
      applyIntegrationFilters(view);
    });
  });

  view.querySelectorAll('[data-integrations-dropdown]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.integrationsDropdown || '';
      const root = button.closest('[data-integrations-dropdown-root]');
      const isOpen = root?.classList.contains('is-open');
      closeDropdowns(view);
      if (!isOpen) {
        root?.classList.add('is-open');
        button.setAttribute('aria-expanded', 'true');
      }
      view.dataset.openDropdown = id;
    });
  });

  view.querySelectorAll('[data-integrations-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const field = button.dataset.integrationsOptionField || '';
      const value = button.dataset.integrationsOptionValue || 'all';
      view.dataset[field] = value;
      const root = button.closest('[data-integrations-dropdown-root]');
      const label = root?.querySelector('[data-integrations-dropdown-label]');
      if (label) label.textContent = button.textContent.trim();
      root?.querySelectorAll('[data-integrations-option]').forEach((option) => {
        option.classList.toggle('is-active', option === button);
      });
      closeDropdowns(view);
      applyIntegrationFilters(view);
    });
  });

  view.addEventListener('click', (event) => {
    if (event.target.closest('[data-integrations-dropdown-root]')) return;
    closeDropdowns(view);
  });

  view.querySelector('[data-integration-docs]')?.addEventListener('click', () => {
    const button = view.querySelector('[data-integration-docs]');
    if (!button) return;
    button.dataset.pulse = 'true';
    window.setTimeout(() => {
      if (button) button.dataset.pulse = 'false';
    }, 900);
  });

  view.querySelector('[data-yoco-open]')?.addEventListener('click', () => {
    openYocoModal(view);
  });

  view.querySelector('[data-gmail-open]')?.addEventListener('click', () => {
    openGmailModal(view);
  });

  view.querySelector('[data-xero-open]')?.addEventListener('click', () => {
    openXeroModal(view);
  });

  view.querySelector('[data-drive-open]')?.addEventListener('click', () => {
    openDriveModal(view);
  });

  view.querySelectorAll('[data-yoco-close]').forEach((button) => {
    button.addEventListener('click', () => closeYocoModal(view));
  });

  view.querySelectorAll('[data-gmail-close]').forEach((button) => {
    button.addEventListener('click', () => closeGmailModal(view));
  });

  view.querySelectorAll('[data-xero-close]').forEach((button) => {
    button.addEventListener('click', () => closeXeroModal(view));
  });

  view.querySelectorAll('[data-drive-close]').forEach((button) => {
    button.addEventListener('click', () => closeDriveModal(view));
  });

  view.querySelectorAll('[data-xero-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const tabId = button.dataset.xeroTab || 'sales';
      setActiveXeroTab(view, tabId);
      if (tabId === 'sales' || tabId === 'purchases') {
        loadXeroTaxRatesIfNeeded(view);
        loadXeroAccountsIfNeeded(view);
      }
      if (tabId === 'purchases') loadXeroTrackingCategoriesIfNeeded(view);
    });
  });
  if (xeroDrawerState.activeTab === 'sales' || xeroDrawerState.activeTab === 'purchases') {
    loadXeroTaxRatesIfNeeded(view);
    loadXeroAccountsIfNeeded(view);
  }
  if (xeroDrawerState.activeTab === 'purchases') {
    loadXeroTrackingCategoriesIfNeeded(view);
  }
  bindXeroComboboxEvents(view);

  view.querySelector('[data-yoco-connect-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const workspaceId = view.dataset.workspaceId || '';
    const input = view.querySelector('[data-yoco-api-key]');
    const apiKey = String(input?.value || '').trim();
    if (!apiKey) {
      setYocoModalStatus(view, 'Enter your Yoco API key first.', 'error');
      return;
    }
    await runYocoAction(view, 'Connecting Yoco and importing the catalogue...', async () => {
      const result = await connectYocoIntegration(workspaceId, apiKey);
      if (input) input.value = '';
      setYocoSummary(view, result);
      setYocoModalStatus(view, 'Yoco connected. Products and locations were synced; historical sales were not imported. New paid sales will deduct after Go Live.', 'success');
    });
  });

  view.querySelector('[data-yoco-sync-catalogue]')?.addEventListener('click', async () => {
    await runYocoAction(view, 'Syncing Yoco catalogue...', async () => {
      const result = await syncYocoCatalogue(view.dataset.workspaceId || '', { resetWebhook: true });
      setYocoSummary(view, result);
      setYocoModalStatus(view, 'Yoco catalogue sync complete.', 'success');
    });
  });

  view.querySelector('[data-yoco-disconnect]')?.addEventListener('click', async () => {
    await runYocoAction(view, 'Disconnecting Yoco...', async () => {
      await disconnectYocoIntegration(view.dataset.workspaceId || '');
      setYocoModalStatus(view, 'Yoco disconnected. Historical sales logs were kept.', 'success');
    });
  });

  view.querySelector('[data-gmail-connect]')?.addEventListener('click', async () => {
    await runGmailAction(view, 'Opening Google consent...', async () => {
      const result = await startGmailConnection(view.dataset.workspaceId || '');
      if (!result.authUrl) throw new Error('Gmail did not return a connection link.');
      const popup = window.open(result.authUrl, 'kcp-gmail-oauth', 'width=520,height=720,noopener,noreferrer');
      if (!popup) window.location.href = result.authUrl;
      setGmailModalStatus(view, 'Finish the Google consent screen, then this tile will update.', 'busy');
    }, { keepMessage: true });
  });

  view.querySelector('[data-gmail-disconnect]')?.addEventListener('click', async () => {
    await runGmailAction(view, 'Disconnecting Gmail...', async () => {
      await disconnectGmailIntegration(view.dataset.workspaceId || '');
      setGmailModalStatus(view, 'Gmail disconnected for this workspace.', 'success');
      updateGmailStatus(view, { status: 'disconnected', configured: true, connectionActive: false });
    });
  });

  view.querySelector('[data-xero-connect]')?.addEventListener('click', async () => {
    await runXeroAction(view, 'Opening Xero consent...', async () => {
      const result = await startXeroConnection(view.dataset.workspaceId || '');
      if (!result.authUrl) throw new Error('Xero did not return a connection link.');
      // Deliberately no noopener/noreferrer: the callback page (getOauthCallback in
      // admin-routes.ts) posts back via window.opener.postMessage, which noopener would sever —
      // and window.open() itself returns null when noopener is set even though the popup DID
      // open, which previously made the `!popup` fallback below wrongly fire and navigate this
      // tab to the Xero consent URL too, on top of the popup.
      const popup = window.open(result.authUrl, 'kcp-xero-oauth', 'width=520,height=720');
      if (!popup) window.location.href = result.authUrl;
      setXeroModalStatus(view, 'Finish the Xero consent screen, then this tile will update.', 'busy');
    }, { keepMessage: true });
  });

  view.querySelector('[data-xero-disconnect]')?.addEventListener('click', async () => {
    await runXeroAction(view, 'Disconnecting Xero...', async () => {
      await disconnectXeroIntegration(view.dataset.workspaceId || '');
      setXeroModalStatus(view, 'Xero disconnected for this workspace.', 'success');
      updateXeroStatus(view, { status: 'disconnected', configured: true, connectionActive: false, settings: xeroDrawerState.status?.settings });
    });
  });

  view.querySelector('[data-drive-connect]')?.addEventListener('click', async () => {
    await runDriveAction(view, 'Opening Google consent...', async () => {
      const result = await startDriveConnection(view.dataset.workspaceId || '');
      if (!result.authUrl) throw new Error('Google Drive did not return a connection link.');
      // Deliberately no noopener/noreferrer, same reasoning as the Xero connect handler above: the
      // callback page posts back via window.opener.postMessage, which noopener would sever.
      const popup = window.open(result.authUrl, 'kcp-drive-oauth', 'width=520,height=720');
      if (!popup) window.location.href = result.authUrl;
      setDriveModalStatus(view, 'Finish the Google consent screen, then this tile will update.', 'busy');
    }, { keepMessage: true });
  });

  view.querySelector('[data-drive-disconnect]')?.addEventListener('click', async () => {
    await runDriveAction(view, 'Disconnecting Google Drive...', async () => {
      await disconnectDriveIntegration(view.dataset.workspaceId || '');
      setDriveModalStatus(view, 'Google Drive disconnected for this workspace.', 'success');
      updateDriveStatus(view, { status: 'disconnected', configured: true, connectionActive: false, settings: driveDrawerState.status?.settings });
    });
  });

  view.querySelector('[data-drive-settings-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const pushGrvEnabled = view.querySelector('[data-drive-grv-enabled]')?.checked === true;
    const pushCreditNoteEnabled = view.querySelector('[data-drive-credit-note-enabled]')?.checked === true;
    await runDriveAction(view, 'Saving Google Drive settings...', async () => {
      await saveDriveSettings(view.dataset.workspaceId || '', { pushGrvEnabled, pushCreditNoteEnabled });
      setDriveModalStatus(view, 'Google Drive settings saved.', 'success');
      bindDriveStatus(view, view.dataset.workspaceId || '', { once: true });
    });
  });

  view.querySelector('[data-drive-sync-now]')?.addEventListener('click', async () => {
    await runDriveAction(view, 'Pushing pending documents to Drive...', async () => {
      const [grvResult, creditNoteResult] = await Promise.all([
        syncDriveNow(view.dataset.workspaceId || '', 'grv').catch((error) => ({ ok: false, error: error.message })),
        syncDriveNow(view.dataset.workspaceId || '', 'credit-notes').catch((error) => ({ ok: false, error: error.message }))
      ]);
      const pushed = (grvResult?.result?.pushed || 0) + (creditNoteResult?.result?.pushed || 0);
      setDriveModalStatus(view, `Pushed ${pushed} document${pushed === 1 ? '' : 's'} to Drive.`, 'success');
    });
  });

  view.querySelector('[data-xero-settings-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const salesAccountCode = String(view.querySelector('[data-xero-sales-account]')?.value || '').trim();
    const defaultTaxType = String(view.querySelector('[data-xero-tax-type]')?.value || '').trim();
    const salesExemptTaxType = String(view.querySelector('[data-xero-sales-exempt-tax-type]')?.value || '').trim();
    const itemAccountCode = String(view.querySelector('[data-xero-item-account]')?.value || '').trim();
    const enabled = view.querySelector('[data-xero-enabled]')?.checked === true;
    const purchaseAccountCode = String(view.querySelector('[data-xero-purchase-account]')?.value || '').trim();
    const purchaseTaxType = String(view.querySelector('[data-xero-purchase-tax-type]')?.value || '').trim();
    const purchaseExemptTaxType = String(view.querySelector('[data-xero-purchase-exempt-tax-type]')?.value || '').trim();
    const codPaymentAccountCode = String(view.querySelector('[data-xero-cod-payment-account]')?.value || '').trim();
    const locationTrackingCategoryId = String(view.querySelector('[data-xero-location-tracking-category]')?.value || '').trim();
    const wastageExpenseAccountCode = String(view.querySelector('[data-xero-wastage-expense-account]')?.value || '').trim();
    const wastageAssetAccountCode = String(view.querySelector('[data-xero-wastage-asset-account]')?.value || '').trim();
    const grvSyncEnabled = view.querySelector('[data-xero-grv-enabled]')?.checked === true;
    const creditNoteSyncEnabled = view.querySelector('[data-xero-credit-note-enabled]')?.checked === true;
    const wastageSyncEnabled = view.querySelector('[data-xero-wastage-enabled]')?.checked === true;
    await runXeroAction(view, 'Saving Xero settings...', async () => {
      await saveXeroSettings(view.dataset.workspaceId || '', {
        salesAccountCode,
        defaultTaxType,
        salesExemptTaxType,
        itemAccountCode,
        enabled,
        purchaseAccountCode,
        purchaseTaxType,
        purchaseExemptTaxType,
        codPaymentAccountCode,
        locationTrackingCategoryId,
        wastageExpenseAccountCode,
        wastageAssetAccountCode,
        grvSyncEnabled,
        creditNoteSyncEnabled,
        wastageSyncEnabled
      });
      setXeroModalStatus(view, 'Xero settings saved.', 'success');
      bindXeroStatus(view, view.dataset.workspaceId || '', { once: true });
    });
  });

  view.querySelector('[data-xero-sync-items]')?.addEventListener('click', async () => {
    await runXeroAction(view, 'Pushing catalogue to Xero...', async () => {
      const result = await syncXeroNow(view.dataset.workspaceId || '', 'items');
      const pushed = Number(result?.result?.pushed || 0);
      const failed = Number(result?.result?.failed || 0);
      setXeroModalStatus(view, `Pushed ${pushed} item${pushed === 1 ? '' : 's'} to Xero${failed ? ` (${failed} failed)` : ''}.`, failed ? 'error' : 'success');
    });
  });

  const runXeroInvoicePush = async (kind, busyMessage) => {
    await runXeroAction(view, busyMessage, async () => {
      const result = await syncXeroNow(view.dataset.workspaceId || '', kind);
      const status = String(result?.result?.status || '');
      const label = status === 'applied' ? 'Invoice pushed to Xero.'
        : status === 'updated' ? "Today's Xero invoice updated with all sales so far."
        : status === 'duplicate' ? 'Already pushed for that day — skipped.'
        : status === 'skipped_no_sales' ? 'No completed sales found for that day.'
        : result?.result?.error || 'Invoice push failed.';
      setXeroModalStatus(view, label, status === 'failed' ? 'error' : 'success');
    });
  };

  view.querySelector('[data-xero-sync-invoice]')?.addEventListener('click', () => {
    runXeroInvoicePush('invoice', 'Pushing yesterday’s sales to Xero...');
  });

  // Unlike the yesterday push above, this re-sends the FULL set of today's sales on every click —
  // the backend either creates today's invoice or updates the existing one in place (see
  // upsertXeroTodayInvoice in invoice-sync.ts), so clicking it again later in the day after more
  // sales come in sends everything not yet reflected rather than being skipped as a duplicate.
  view.querySelector('[data-xero-sync-invoice-today]')?.addEventListener('click', () => {
    runXeroInvoicePush('invoice-today', "Pushing today's sales to Xero...");
  });

  view.querySelector('[data-xero-sync-grv]')?.addEventListener('click', async () => {
    await runXeroAction(view, 'Pushing GRVs to Xero...', async () => {
      const result = await syncXeroNow(view.dataset.workspaceId || '', 'grv');
      const counts = result?.result || {};
      const applied = Number(counts.applied || 0);
      const needsMatch = Number(counts.needsSupplierMatch || 0);
      const failed = Number(counts.failed || 0);
      const parts = [`${applied} GRV${applied === 1 ? '' : 's'} pushed`];
      if (needsMatch) parts.push(`${needsMatch} waiting on a supplier match`);
      if (failed) parts.push(`${failed} failed`);
      let message = parts.join(', ') + '.';
      const failedDetails = Array.isArray(counts.failedDetails) ? counts.failedDetails : [];
      if (failedDetails.length) {
        const summary = failedDetails
          .slice(0, 3)
          .map((item) => `${item.invoiceNumber || item.supplierName || item.grvId}: ${item.error}`)
          .join(' · ');
        message += ` ${summary}`;
      }
      setXeroModalStatus(view, message, failed ? 'error' : 'success');
      bindXeroStatus(view, view.dataset.workspaceId || '', { once: true });
    });
  });

  view.querySelector('[data-xero-sync-credit-notes]')?.addEventListener('click', async () => {
    await runXeroAction(view, 'Pushing Credit Notes to Xero...', async () => {
      const result = await syncXeroNow(view.dataset.workspaceId || '', 'credit-notes');
      const counts = result?.result || {};
      const applied = Number(counts.applied || 0);
      const needsMatch = Number(counts.needsSupplierMatch || 0);
      const failed = Number(counts.failed || 0);
      const parts = [`${applied} Credit Note${applied === 1 ? '' : 's'} pushed`];
      if (needsMatch) parts.push(`${needsMatch} waiting on a supplier match`);
      if (failed) parts.push(`${failed} failed`);
      let message = parts.join(', ') + '.';
      const failedDetails = Array.isArray(counts.failedDetails) ? counts.failedDetails : [];
      if (failedDetails.length) {
        const summary = failedDetails
          .slice(0, 3)
          .map((item) => `${item.creditNoteNumber || item.supplierName || item.creditNoteId}: ${item.error}`)
          .join(' · ');
        message += ` ${summary}`;
      }
      setXeroModalStatus(view, message, failed ? 'error' : 'success');
      bindXeroStatus(view, view.dataset.workspaceId || '', { once: true });
    });
  });

  const runXeroWastagePush = async (kind, busyMessage) => {
    await runXeroAction(view, busyMessage, async () => {
      const result = await syncXeroNow(view.dataset.workspaceId || '', kind);
      const status = String(result?.result?.status || '');
      const label = status === 'applied' ? 'Wastage journal pushed to Xero.'
        : status === 'updated' ? "Today's Xero wastage journal updated with all wastage so far."
        : status === 'duplicate' ? 'Already pushed for that day — skipped.'
        : status === 'skipped_no_wastage' ? 'No wastage found for that day.'
        : result?.result?.error || 'Wastage push failed.';
      setXeroModalStatus(view, label, status === 'failed' ? 'error' : 'success');
      bindXeroStatus(view, view.dataset.workspaceId || '', { once: true });
    });
  };

  view.querySelector('[data-xero-sync-wastage]')?.addEventListener('click', () => {
    runXeroWastagePush('wastage', 'Pushing yesterday’s wastage to Xero...');
  });

  // Unlike the yesterday push above, this re-sends the FULL set of today's wastage on every click —
  // same "top up" pattern as data-xero-sync-invoice-today (see upsertXeroTodayWastage).
  view.querySelector('[data-xero-sync-wastage-today]')?.addEventListener('click', () => {
    runXeroWastagePush('wastage-today', "Pushing today's wastage to Xero...");
  });

  // Match-only, never creates a Contact (same "ask before creating" policy as the pending-matches
  // list below) — a supplier that can't be auto-matched by name shows up there afterward, ready
  // for a human to map or create one.
  view.querySelector('[data-xero-sync-suppliers]')?.addEventListener('click', async () => {
    await runXeroAction(view, 'Matching suppliers to Xero contacts...', async () => {
      const result = await syncXeroNow(view.dataset.workspaceId || '', 'suppliers');
      const counts = result?.result || {};
      const matched = Number(counts.matched || 0);
      const alreadyLinked = Number(counts.alreadyLinked || 0);
      const needsAttention = Number(counts.needsAttention || 0);
      const parts = [`${matched} newly matched`, `${alreadyLinked} already linked`];
      if (needsAttention) parts.push(`${needsAttention} need${needsAttention === 1 ? 's' : ''} a manual match`);
      setXeroModalStatus(view, parts.join(', ') + '.', 'success');
      bindXeroStatus(view, view.dataset.workspaceId || '', { once: true });
    });
  });

  // Delegated: the pending-matches list is re-rendered wholesale on every status refresh
  // (updateXeroStatus), so listeners are bound on the stable container rather than its rows.
  view.querySelector('[data-xero-pending-matches]')?.addEventListener('click', async (event) => {
    const row = event.target.closest('li[data-supplier-id]');
    if (!row) return;
    const supplierId = row.dataset.supplierId;
    const isCreate = event.target.closest('[data-xero-resolve-create]');
    const isMap = event.target.closest('[data-xero-resolve-map]');
    if (!isCreate && !isMap) return;
    const xeroContactId = isMap ? String(row.querySelector('[data-xero-match-contact-id]')?.value || '').trim() : undefined;
    if (isMap && !xeroContactId) {
      setXeroModalStatus(view, 'Enter an existing Xero Contact ID to map to first.', 'error');
      return;
    }
    await runXeroAction(view, isCreate ? 'Creating Xero contact...' : 'Mapping to Xero contact...', async () => {
      const result = await resolveXeroSupplierMatch(view.dataset.workspaceId || '', supplierId, {
        xeroContactId,
        createNew: isCreate ? true : undefined
      });
      if (result?.ok === false) throw new Error(result.error || 'Could not resolve the supplier match.');
      setXeroModalStatus(view, 'Supplier linked to Xero. Its GRVs will push on the next sync.', 'success');
      bindXeroStatus(view, view.dataset.workspaceId || '', { once: true });
    });
  });

  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'kcp:gmail-oauth') return;
    setGmailModalStatus(view, event.data.message || (event.data.ok ? 'Gmail connected.' : 'Gmail connection failed.'), event.data.ok ? 'success' : 'error');
    if (event.data.ok) {
      bindGmailStatus(view, view.dataset.workspaceId || '', { once: true });
    }
  }, { once: true });

  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'kcp:xero-oauth') return;
    setXeroModalStatus(view, event.data.message || (event.data.ok ? 'Xero connected.' : 'Xero connection failed.'), event.data.ok ? 'success' : 'error');
    if (event.data.ok) {
      bindXeroStatus(view, view.dataset.workspaceId || '', { once: true });
    }
  }, { once: true });

  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'kcp:drive-oauth') return;
    setDriveModalStatus(view, event.data.message || (event.data.ok ? 'Google Drive connected.' : 'Google Drive connection failed.'), event.data.ok ? 'success' : 'error');
    if (event.data.ok) {
      bindDriveStatus(view, view.dataset.workspaceId || '', { once: true });
    }
  }, { once: true });
}

function applyIntegrationFilters(view) {
  const query = String(view.querySelector('[data-integrations-search]')?.value || '').trim().toLowerCase();
  const activeTab = view.dataset.activeTab || 'all';
  const category = view.dataset.category || 'all';
  const status = view.dataset.status || 'all';
  let visibleCount = 0;

  view.querySelectorAll('[data-integration-card]').forEach((card) => {
    const haystack = String(card.dataset.search || '').toLowerCase();
    const matchesSearch = !query || haystack.includes(query);
    const matchesCategory = category === 'all' || card.dataset.category === category;
    const matchesStatus = status === 'all' || card.dataset.status === status;
    const matchesTab = activeTab === 'all' ||
      (activeTab === 'available' && ['Available', 'Active'].includes(card.dataset.status || '')) ||
      (activeTab === 'popular' && card.dataset.popular === 'true');
    const visible = matchesSearch && matchesCategory && matchesStatus && matchesTab;
    card.hidden = !visible;
    if (visible) visibleCount += 1;
  });

  view.querySelectorAll('[data-integrations-category-group]').forEach((group) => {
    const hasVisibleCard = group.querySelector('[data-integration-card]:not([hidden])');
    group.hidden = !hasVisibleCard;
  });

  const count = view.querySelector('[data-integrations-count]');
  if (count) count.textContent = `Showing ${visibleCount} of ${INTEGRATIONS.length} integrations`;
  const empty = view.querySelector('[data-integrations-empty]');
  if (empty) empty.hidden = visibleCount > 0;
}

function closeDropdowns(view) {
  view.querySelectorAll('[data-integrations-dropdown-root]').forEach((root) => {
    root.classList.remove('is-open');
    root.querySelector('[data-integrations-dropdown]')?.setAttribute('aria-expanded', 'false');
  });
}

function renderTab(id, label, active) {
  return `
    <button
      type="button"
      class="${active ? 'is-active' : ''}"
      role="tab"
      aria-selected="${active}"
      data-integrations-tab="${escapeAttribute(id)}"
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function renderDropdown(field, options, selectedValue) {
  const selected = options.find((option) => option.value === selectedValue) || options[0];
  return `
    <div class="integrationsDropdown" data-integrations-dropdown-root>
      <button type="button" data-integrations-dropdown="${escapeAttribute(field)}" aria-expanded="false">
        <span data-integrations-dropdown-label>${escapeHtml(selected.label)}</span>
        ${icon('chevronDown')}
      </button>
      <div class="integrationsDropdownMenu">
        ${options.map((option) => `
          <button
            type="button"
            data-integrations-option
            data-integrations-option-field="${escapeAttribute(field)}"
            data-integrations-option-value="${escapeAttribute(option.value)}"
            class="${option.value === selectedValue ? 'is-active' : ''}"
          >
            ${escapeHtml(option.label)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderIntegrationGroups(integrations) {
  const orderedCategories = CATEGORY_OPTIONS
    .map((option) => option.value)
    .filter((value) => value !== 'all');
  return orderedCategories
    .map((category) => {
      const items = integrations.filter((item) => item.category === category);
      if (!items.length) return '';
      return `
        <div class="integrationsCategoryGroup" data-integrations-category-group="${escapeAttribute(category)}">
          <h3 class="integrationsCategoryTitle">${escapeHtml(category)}</h3>
          <div class="integrationsCategoryCards">
            ${items.map(renderIntegrationCard).join('')}
          </div>
        </div>
      `;
    })
    .join('');
}

function renderIntegrationCard(item) {
  const search = `${item.name} ${item.category} ${item.status} ${item.description}`;
  const statusClass = getIntegrationStatusClass(item.status);
  return `
    <article
      class="integrationCard ${item.id === 'yoco' || item.id === 'gmail' || item.id === 'xero' || item.id === 'google-drive' ? 'integrationCard--featured' : ''}"
      data-integration-card
      data-integration-id="${escapeAttribute(item.id)}"
      data-category="${escapeAttribute(item.category)}"
      data-status="${escapeAttribute(item.status)}"
      data-popular="${item.popular ? 'true' : 'false'}"
      data-search="${escapeAttribute(search)}"
    >
      <div class="integrationCardTop">
        <div class="integrationLogo integrationLogo--${escapeAttribute(item.tone)}">
          ${item.logo
            ? `<img src="${escapeAttribute(item.logo)}" alt="${escapeAttribute(`${item.name} logo`)}" loading="lazy" />`
            : icon(item.icon || 'plug')}
        </div>
        <div>
          <h2>${escapeHtml(item.name)}</h2>
          <span>${escapeHtml(item.category)}</span>
        </div>
        <em class="${statusClass}">${escapeHtml(item.status)}</em>
      </div>
      <p>${escapeHtml(item.description)}</p>
      <div class="integrationMeta">
        <span>${escapeHtml(item.stage)}</span>
        ${item.popular ? '<span>Popular</span>' : '<span>Workspace Tool</span>'}
      </div>
      <div class="integrationActions">
        <button type="button" class="${item.id === 'yoco' || item.id === 'gmail' || item.id === 'xero' || item.id === 'google-drive' ? 'integrationPrimaryAction' : 'integrationGhostAction'}" ${item.id === 'yoco' ? 'data-yoco-open' : ''} ${item.id === 'gmail' ? 'data-gmail-open' : ''} ${item.id === 'xero' ? 'data-xero-open' : ''} ${item.id === 'google-drive' ? 'data-drive-open' : ''}>
          ${item.id === 'yoco' || item.id === 'gmail' || item.id === 'xero' || item.id === 'google-drive' ? icon('link') : icon('clock')}
          <span data-integration-action-label>${escapeHtml(item.action)}</span>
        </button>
      </div>
    </article>
  `;
}

function renderYocoModal({ canDisconnectYoco = false } = {}) {
  const noticeTone = yocoDrawerState.tone ? ` data-tone="${escapeAttribute(yocoDrawerState.tone)}"` : '';
  return `
    <div class="yocoModalBackdrop" data-yoco-modal ${yocoDrawerState.open ? '' : 'hidden'}>
      <section class="yocoModalCard" role="dialog" aria-modal="true" aria-labelledby="yoco-modal-title">
        <header class="yocoModalHead">
          <div>
            <p>POS & Payments</p>
            <h2 id="yoco-modal-title">Connect Yoco</h2>
            <span data-yoco-live-status>Disconnected</span>
          </div>
          <button type="button" class="integrationIconAction" data-yoco-close aria-label="Close Yoco setup">${icon('x')}</button>
        </header>

        <div class="yocoDrawerBody">
          <form class="yocoConnectForm" data-yoco-connect-form>
            <label>
              <span>Personal API Key</span>
              <input type="password" autocomplete="off" placeholder="Paste your Yoco API key" data-yoco-api-key />
            </label>
            <button type="submit" class="integrationPrimaryAction" data-yoco-submit>
              ${icon('shieldCheck')}
              <span>Connect and Sync</span>
            </button>
          </form>

          <aside class="yocoKeyHelper" aria-label="Yoco API key helper">
            <div class="yocoKeyHelperIcon">${icon('keyRound')}</div>
            <div>
              <strong>Need your Yoco API key?</strong>
              <span>Open Yoco, sign in, then paste the key here.</span>
            </div>
            <a
              class="yocoKeyHelperButton"
              href="https://developer-iam.yoco.com/ui/login?flow=c9249270-71ae-46c1-8d7f-9414a0f6c64b"
              target="_blank"
              rel="noopener noreferrer"
            >
              ${icon('external')}
              <span>Get Your Yoco API Key Now</span>
            </a>
          </aside>

          <div class="yocoStatusGrid">
            <article>
              <span>Last Sync</span>
              <strong data-yoco-last-sync>Not synced yet</strong>
            </article>
            <article>
              <span>Catalogue</span>
              <strong data-yoco-catalogue-count>0 items</strong>
            </article>
            <article>
              <span>Product Modifiers</span>
              <strong data-yoco-modifier-count>0 modifier options</strong>
            </article>
            <article>
              <span>Locations</span>
              <strong data-yoco-location-count>0 locations</strong>
            </article>
            <article>
              <span>Webhook</span>
              <strong data-yoco-webhook-status>Not active</strong>
            </article>
          </div>

          <section class="yocoActionPanel" aria-label="Yoco manual controls">
            <div class="yocoActionPanelHead">
              <span>Manual controls</span>
              <strong>Run a focused Yoco sync when required.</strong>
            </div>
            <div class="yocoActionRow">
              <button type="button" class="yocoActionButton" data-yoco-sync-catalogue>
                <span class="yocoActionIcon">${icon('boxes')}</span>
                <span><strong>Sync Catalogue</strong><small>Menu items and locations</small></span>
              </button>
              ${canDisconnectYoco ? `
              <button type="button" class="yocoActionButton yocoActionButton--danger" data-yoco-disconnect>
                <span class="yocoActionIcon">${icon('unlink')}</span>
                <span><strong>Disconnect</strong><small>Super user action</small></span>
              </button>` : `
              <div class="yocoActionLock" title="Only a KCP super user can disconnect this integration.">
                <span class="yocoActionIcon">${icon('lock')}</span>
                <span><strong>Connection locked</strong><small>Contact a KCP super user to disconnect or replace the API key.</small></span>
              </div>`}
            </div>
          </section>

          <div class="yocoModalNotice" data-yoco-modal-status${noticeTone}>
            ${escapeHtml(yocoDrawerState.message)}
          </div>
          <div class="yocoResult" data-yoco-summary ${yocoDrawerState.summary ? '' : 'hidden'}>
            ${renderYocoSummaryEntries(yocoDrawerState.summary)}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderGmailModal() {
  const status = gmailDrawerState.status || {};
  const isConnected = status.connectionActive === true;
  const isConfigured = status.configured !== false;
  const noticeTone = gmailDrawerState.tone ? ` data-tone="${escapeAttribute(gmailDrawerState.tone)}"` : '';
  return `
    <div class="yocoModalBackdrop" data-gmail-modal ${gmailDrawerState.open ? '' : 'hidden'}>
      <section class="yocoModalCard gmailModalCard" role="dialog" aria-modal="true" aria-labelledby="gmail-modal-title">
        <header class="yocoModalHead">
          <div>
            <p>Email & Communications</p>
            <h2 id="gmail-modal-title">Connect Gmail</h2>
            <span data-gmail-live-status>${isConnected ? `Connected as ${escapeHtml(status.accountEmail || 'Gmail')}` : isConfigured ? 'Disconnected' : 'Setup required'}</span>
          </div>
          <button type="button" class="integrationIconAction" data-gmail-close aria-label="Close Gmail setup">${icon('x')}</button>
        </header>

        <div class="yocoDrawerBody">
          <aside class="yocoKeyHelper gmailHelper" aria-label="Gmail permission helper">
            <div class="yocoKeyHelperIcon">${icon('mail')}</div>
            <div>
              <strong>Send-only Gmail access</strong>
              <span>KCP requests permission to send supplier emails. It does not request mailbox read access.</span>
            </div>
          </aside>

          <div class="yocoStatusGrid">
            <article>
              <span>Status</span>
              <strong data-gmail-status>${isConnected ? 'Connected' : isConfigured ? 'Ready' : 'Not configured'}</strong>
            </article>
            <article>
              <span>Account</span>
              <strong data-gmail-account>${escapeHtml(status.accountEmail || 'No account')}</strong>
            </article>
            <article>
              <span>Connected</span>
              <strong data-gmail-connected-at>${formatDateTime(status.connectedAt) || 'Not connected'}</strong>
            </article>
            <article>
              <span>Last Sent</span>
              <strong data-gmail-last-sent>${formatDateTime(status.lastSentAt) || 'No sends yet'}</strong>
            </article>
          </div>

          <section class="yocoActionPanel" aria-label="Gmail controls">
            <div class="yocoActionPanelHead">
              <span>Supplier communication</span>
              <strong>Linked Gmail will be used when sending purchase orders and supplier emails.</strong>
            </div>
            <div class="yocoActionRow">
              <button type="button" class="yocoActionButton" data-gmail-connect ${isConfigured ? '' : 'disabled'}>
                <span class="yocoActionIcon">${icon('link')}</span>
                <span><strong>${isConnected ? 'Reconnect Gmail' : 'Connect Gmail'}</strong><small>Google consent flow</small></span>
              </button>
              <button type="button" class="yocoActionButton yocoActionButton--danger" data-gmail-disconnect ${isConnected ? '' : 'disabled'}>
                <span class="yocoActionIcon">${icon('unlink')}</span>
                <span><strong>Disconnect</strong><small>Remove Gmail token</small></span>
              </button>
            </div>
          </section>

          <div class="yocoModalNotice" data-gmail-modal-status${noticeTone}>
            ${escapeHtml(gmailDrawerState.message)}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderDriveModal({ canManageDrive = false } = {}) {
  driveDrawerState.canManageDrive = canManageDrive;
  const status = driveDrawerState.status || {};
  const isConnected = status.connectionActive === true;
  const isConfigured = status.configured !== false;
  const settings = status.settings || {};
  const noticeTone = driveDrawerState.tone ? ` data-tone="${escapeAttribute(driveDrawerState.tone)}"` : '';
  const lockedNotice = `<div class="yocoActionLock" title="Only a workspace owner, admin, or super user can change Google Drive settings."><span class="yocoActionIcon">${icon('lock')}</span><span><strong>Settings locked</strong><small>Ask a workspace owner or admin to change these.</small></span></div>`;
  return `
    <div class="yocoModalBackdrop" data-drive-modal ${driveDrawerState.open ? '' : 'hidden'}>
      <section class="yocoModalCard" role="dialog" aria-modal="true" aria-labelledby="drive-modal-title">
        <header class="yocoModalHead">
          <div>
            <p>Cloud Storage</p>
            <h2 id="drive-modal-title">Connect Google Drive</h2>
            <span data-drive-live-status>${isConnected ? `Connected as ${escapeHtml(status.accountEmail || 'Google Drive')}` : isConfigured ? 'Disconnected' : 'Setup required'}</span>
          </div>
          <button type="button" class="integrationIconAction" data-drive-close aria-label="Close Google Drive setup">${icon('x')}</button>
        </header>

        <div class="yocoDrawerBody">
          <aside class="yocoKeyHelper" aria-label="Google Drive helper">
            <div class="yocoKeyHelperIcon">${icon('boxes')}</div>
            <div>
              <strong>Your own Drive, not KCP's</strong>
              <span>Files are stored in the connected Google account's own Drive, under a "KCP Documents" folder — nothing is kept on KCP's servers.</span>
            </div>
          </aside>

          <div class="yocoStatusGrid">
            <article>
              <span>Status</span>
              <strong data-drive-status>${isConnected ? 'Connected' : isConfigured ? 'Ready' : 'Not configured'}</strong>
            </article>
            <article>
              <span>Account</span>
              <strong data-drive-account>${escapeHtml(status.accountEmail || 'No account')}</strong>
            </article>
          </div>

          <section class="yocoActionPanel" aria-label="Google Drive controls">
            <div class="yocoActionPanelHead">
              <span>Connection</span>
              <strong>Connect the Google account whose Drive should receive KCP documents.</strong>
            </div>
            <div class="yocoActionRow">
              <button type="button" class="yocoActionButton" data-drive-connect ${isConfigured ? '' : 'disabled'}>
                <span class="yocoActionIcon">${icon('link')}</span>
                <span><strong>${isConnected ? 'Reconnect Google Drive' : 'Connect Google Drive'}</strong><small>Google consent flow</small></span>
              </button>
              <button type="button" class="yocoActionButton yocoActionButton--danger" data-drive-disconnect ${isConnected ? '' : 'disabled'}>
                <span class="yocoActionIcon">${icon('unlink')}</span>
                <span><strong>Disconnect</strong><small>Remove Drive token</small></span>
              </button>
            </div>
          </section>

          <div class="yocoModalNotice" data-tone="">
            <strong>GRV Invoice Assistant (OCR)</strong> is enabled per-workspace by a KCP admin in the Admin Console, not here — currently
            <strong data-drive-ocr-status>${settings.ocrEnabled ? 'enabled' : 'disabled'}</strong> for this workspace.
          </div>

          <form class="xeroSettingsForm" data-drive-settings-form>
            ${canManageDrive ? `
            <label class="xeroToggleRow">
              <span class="xeroToggleCopy"><strong>Push GRVs to Drive</strong><small>Sends each GRV's PDF into that location's "GRVs" folder.</small></span>
              <input type="checkbox" data-drive-grv-enabled ${settings.pushGrvEnabled ? 'checked' : ''} />
            </label>
            <label class="xeroToggleRow">
              <span class="xeroToggleCopy"><strong>Push Credit Notes to Drive</strong><small>Sends each Credit Note's PDF into that location's "Credit Notes" folder.</small></span>
              <input type="checkbox" data-drive-credit-note-enabled ${settings.pushCreditNoteEnabled ? 'checked' : ''} />
            </label>
            <div class="xeroFormActions">
              <button type="submit" class="xeroCompactButton xeroCompactButton--primary" data-drive-settings-submit ${isConnected ? '' : 'disabled'}>
                ${icon('shieldCheck')}
                <span>Save settings</span>
              </button>
              <button type="button" class="xeroCompactButton" data-drive-sync-now ${isConnected ? '' : 'disabled'}>
                ${icon('boxes')}
                <span>Push pending documents now</span>
              </button>
            </div>` : lockedNotice}
          </form>

          <div class="yocoModalNotice" data-drive-modal-status${noticeTone}>
            ${escapeHtml(driveDrawerState.message)}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderPendingSupplierMatchesList(matches = [], canManageXero = false) {
  if (!matches.length) return '<p class="xeroPendingMatchesEmpty">No supplier matches need attention.</p>';
  if (!canManageXero) {
    return `<p class="xeroPendingMatchesEmpty">${matches.length} supplier${matches.length === 1 ? '' : 's'} need a Xero contact match — ask a workspace owner to resolve ${matches.length === 1 ? 'it' : 'them'}.</p>`;
  }
  return `
    <ul class="xeroPendingMatchesList">
      ${matches.map((match) => `
        <li data-supplier-id="${escapeAttribute(match.supplierId)}">
          <div class="xeroPendingMatchInfo">
            <strong>${escapeHtml(match.supplierName)}</strong>
            <span>${match.reason === 'grv_blocked' ? `${match.grvCount} document${match.grvCount === 1 ? '' : 's'} (GRV/Credit Note) waiting to push` : 'No Xero contact match found'}</span>
          </div>
          <div class="xeroPendingMatchActions">
            <input type="text" placeholder="Existing Xero Contact ID" data-xero-match-contact-id />
            <button type="button" class="xeroCompactButton" data-xero-resolve-map>Map to existing</button>
            <button type="button" class="xeroCompactButton xeroCompactButton--primary" data-xero-resolve-create>Create new contact</button>
          </div>
        </li>
      `).join('')}
    </ul>
  `;
}

const XERO_TABS = [
  { id: 'sales', label: 'Sales' },
  { id: 'purchases', label: 'Purchases & COD' },
  { id: 'sync', label: 'Sync & Connection' },
  { id: 'danger', label: 'Danger Zone', managerOnly: true }
];

function renderXeroModal({ canManageXero = false } = {}) {
  xeroDrawerState.canManageXero = canManageXero;
  const status = xeroDrawerState.status || {};
  const isConnected = status.connectionActive === true;
  const isConfigured = status.configured !== false;
  const settings = status.settings || {};
  const syncEnabled = settings.enabled === true;
  const grvSyncEnabled = settings.grvSyncEnabled === true;
  const creditNoteSyncEnabled = settings.creditNoteSyncEnabled === true;
  const wastageSyncEnabled = settings.wastageSyncEnabled === true;
  const pendingSupplierMatches = status.pendingSupplierMatches || [];
  const pendingCount = pendingSupplierMatches.length;
  const noticeTone = xeroDrawerState.tone ? ` data-tone="${escapeAttribute(xeroDrawerState.tone)}"` : '';
  const activeTab = XERO_TABS.some((tab) => tab.id === xeroDrawerState.activeTab && (!tab.managerOnly || canManageXero))
    ? xeroDrawerState.activeTab
    : 'sales';

  const lockedNotice = `
    <div class="yocoActionLock" title="Only a KCP super user can configure Xero account mapping.">
      <span class="yocoActionIcon">${icon('shieldCheck')}</span>
      <span><strong>Configuration locked</strong><small>Contact a KCP super user to map accounts or enable sync.</small></span>
    </div>
  `;

  return `
    <div class="yocoModalBackdrop" data-xero-modal ${xeroDrawerState.open ? '' : 'hidden'}>
      <section class="yocoModalCard gmailModalCard xeroModalCard" role="dialog" aria-modal="true" aria-labelledby="xero-modal-title">
        <header class="yocoModalHead">
          <div>
            <p>Accounting</p>
            <h2 id="xero-modal-title">Connect Xero</h2>
            <span class="xeroOrgChip">
              <span class="xeroOrgDot ${isConnected ? 'is-connected' : ''}" data-xero-connection-dot></span>
              <span data-xero-live-status>${isConnected ? `Connected to ${escapeHtml(status.tenantName || 'Xero')}` : isConfigured ? 'Disconnected' : 'Setup required'}</span>
            </span>
            <span data-xero-status hidden>${isConnected ? 'Connected' : isConfigured ? 'Ready' : 'Not configured'}</span>
            <span data-xero-tenant hidden>${escapeHtml(status.tenantName || 'No organisation')}</span>
          </div>
          <button type="button" class="integrationIconAction" data-xero-close aria-label="Close Xero setup">${icon('x')}</button>
        </header>

        <div class="yocoDrawerBody">
          <div class="yocoStatusGrid xeroStatRail">
            <article>
              <span>Last item sync</span>
              <strong data-xero-item-sync>${formatDateTime(settings.lastItemSyncAt) || 'Not synced yet'}</strong>
            </article>
            <article>
              <span>Last invoice pushed</span>
              <strong data-xero-invoice-sync>${escapeHtml(settings.lastInvoiceSyncDate || 'None yet')}</strong>
            </article>
            <article>
              <span>Last GRVs pushed</span>
              <strong data-xero-grv-sync>${escapeHtml(settings.lastGrvSyncDate || 'None yet')}</strong>
            </article>
            <article>
              <span>Last Credit Notes pushed</span>
              <strong data-xero-credit-note-sync>${escapeHtml(settings.lastCreditNoteSyncDate || 'None yet')}</strong>
            </article>
            <article>
              <span>Last wastage pushed</span>
              <strong data-xero-wastage-sync>${escapeHtml(settings.lastWastageSyncDate || 'None yet')}</strong>
            </article>
            <article class="${pendingCount ? 'xeroStatRail--warning' : ''}">
              <span>Needs attention</span>
              <strong data-xero-pending-count>${pendingCount ? `${pendingCount} supplier${pendingCount === 1 ? '' : 's'}` : 'None'}</strong>
            </article>
          </div>

          <div class="xeroTabs" role="tablist" aria-label="Xero settings sections">
            ${XERO_TABS.filter((tab) => !tab.managerOnly || canManageXero).map((tab) => `
              <button
                type="button"
                class="${tab.id === activeTab ? 'is-active' : ''}"
                data-xero-tab="${escapeAttribute(tab.id)}"
                role="tab"
                aria-selected="${tab.id === activeTab}"
              >
                ${escapeHtml(tab.label)}
                ${tab.id === 'sync' && pendingCount ? `<span class="xeroTabBadge">${pendingCount}</span>` : ''}
              </button>
            `).join('')}
          </div>

          <form data-xero-settings-form>
            <div class="xeroTabPane ${activeTab === 'sales' ? 'is-active' : ''}" data-xero-pane="sales">
              ${canManageXero ? `
              <div class="xeroFieldGrid">
                <label>
                  <span>Sales account code</span>
                  <span data-xero-account-control="salesAccountCode">${renderXeroAccountCodeControl({ dataAttr: 'data-xero-sales-account', currentValue: settings.salesAccountCode, placeholder: 'e.g. 200', accounts: xeroDrawerState.accounts, filterClass: 'REVENUE' })}</span>
                </label>
                <label>
                  <span>Tax type</span>
                  <span data-xero-tax-control="defaultTaxType">${renderXeroTaxTypeControl({ dataAttr: 'data-xero-tax-type', currentValue: settings.defaultTaxType, placeholder: 'e.g. OUTPUT2', taxRates: xeroDrawerState.taxRates, applicability: 'revenue' })}</span>
                </label>
                <label class="xeroFieldGrid--span2">
                  <span>${renderFieldHelpLabel('Exempt/zero-rated tax type (optional)', 'Used for products marked zero-rated/VAT-exempt in Yoco, instead of the tax type above.')}</span>
                  <span data-xero-tax-control="salesExemptTaxType">${renderXeroTaxTypeControl({ dataAttr: 'data-xero-sales-exempt-tax-type', currentValue: settings.salesExemptTaxType, placeholder: 'e.g. EXEMPTOUTPUT', taxRates: xeroDrawerState.taxRates, applicability: 'revenue' })}</span>
                </label>
                <label class="xeroFieldGrid--span2">
                  <span>Item account <em>optional, defaults to sales account</em></span>
                  <span data-xero-account-control="itemAccountCode">${renderXeroAccountCodeControl({ dataAttr: 'data-xero-item-account', currentValue: settings.itemAccountCode, placeholder: 'Defaults to sales account', accounts: xeroDrawerState.accounts, filterClass: 'REVENUE' })}</span>
                </label>
              </div>
              <label class="xeroToggleRow">
                <span class="xeroToggleCopy"><strong>Enable daily sales sync</strong><small>Pushes one summarised invoice per day for completed sales.</small></span>
                <input type="checkbox" data-xero-enabled ${syncEnabled ? 'checked' : ''} />
              </label>
              <div class="xeroFormActions">
                <button type="submit" class="xeroCompactButton xeroCompactButton--primary" data-xero-settings-submit>
                  ${icon('shieldCheck')}
                  <span>Save settings</span>
                </button>
              </div>` : lockedNotice}
            </div>

            <div class="xeroTabPane ${activeTab === 'purchases' ? 'is-active' : ''}" data-xero-pane="purchases">
              ${canManageXero ? `
              <div class="xeroFieldGrid">
                <label>
                  <span>Purchases account code</span>
                  <span data-xero-account-control="purchaseAccountCode">${renderXeroAccountCodeControl({ dataAttr: 'data-xero-purchase-account', currentValue: settings.purchaseAccountCode, placeholder: 'e.g. 300', accounts: xeroDrawerState.accounts, filterClass: 'EXPENSE' })}</span>
                </label>
                <label>
                  <span>Purchases tax type</span>
                  <span data-xero-tax-control="purchaseTaxType">${renderXeroTaxTypeControl({ dataAttr: 'data-xero-purchase-tax-type', currentValue: settings.purchaseTaxType, placeholder: 'e.g. INPUT2', taxRates: xeroDrawerState.taxRates, applicability: 'expenses' })}</span>
                </label>
                <label class="xeroFieldGrid--span2">
                  <span>${renderFieldHelpLabel('Exempt/zero-rated tax type (optional)', 'Used for GRV lines on zero-rated stock items instead of the tax type above.')}</span>
                  <span data-xero-tax-control="purchaseExemptTaxType">${renderXeroTaxTypeControl({ dataAttr: 'data-xero-purchase-exempt-tax-type', currentValue: settings.purchaseExemptTaxType, placeholder: 'e.g. EXEMPTINPUT', taxRates: xeroDrawerState.taxRates, applicability: 'expenses' })}</span>
                </label>
                <label class="xeroFieldGrid--span2">
                  <span>${renderFieldHelpLabel('COD payment account (optional)', 'Bank account COD supplier GRVs are marked paid from. Leave blank to push them Authorised without a payment.')}</span>
                  <span data-xero-account-control="codPaymentAccountCode">${renderXeroAccountCodeControl({ dataAttr: 'data-xero-cod-payment-account', currentValue: settings.codPaymentAccountCode, placeholder: 'e.g. 090', accounts: xeroDrawerState.accounts, filterClass: 'BANK' })}</span>
                </label>
                <label class="xeroFieldGrid--span2">
                  <span>${renderFieldHelpLabel('Location tracking category (optional)', 'Tags GRVs, Credit Notes, and daily sales lines with a Xero Tracking Option matching the KCP location — lets Xero report P&L per location. Matched by name; a location with no matching option is pushed without tracking.')}</span>
                  <span data-xero-tax-control="locationTrackingCategoryId">${renderXeroTrackingCategoryControl({ currentValue: settings.locationTrackingCategoryId, trackingCategories: xeroDrawerState.trackingCategories })}</span>
                </label>
                <label>
                  <span>Wastage expense account</span>
                  <span data-xero-account-control="wastageExpenseAccountCode">${renderXeroAccountCodeControl({ dataAttr: 'data-xero-wastage-expense-account', currentValue: settings.wastageExpenseAccountCode, placeholder: 'e.g. 310', accounts: xeroDrawerState.accounts, filterClass: 'EXPENSE' })}</span>
                </label>
                <label>
                  <span>${renderFieldHelpLabel('Inventory asset account', "Wastage posts as a Manual Journal: debits the expense account above, credits this inventory account, for that day's stock write-offs.")}</span>
                  <span data-xero-account-control="wastageAssetAccountCode">${renderXeroAccountCodeControl({ dataAttr: 'data-xero-wastage-asset-account', currentValue: settings.wastageAssetAccountCode, placeholder: 'e.g. 630', accounts: xeroDrawerState.accounts, filterClass: 'ASSET' })}</span>
                </label>
              </div>
              <label class="xeroToggleRow">
                <span class="xeroToggleCopy"><strong>Push GRVs to Xero daily</strong><small>Sent as Bills alongside sales — COD suppliers push Authorised, every other payment method pushes Draft.</small></span>
                <input type="checkbox" data-xero-grv-enabled ${grvSyncEnabled ? 'checked' : ''} />
              </label>
              <label class="xeroToggleRow">
                <span class="xeroToggleCopy"><strong>Push Credit Notes to Xero daily</strong><small>Sent as Draft Credit Notes against the same supplier — reduces what's owed once a bookkeeper approves it.</small></span>
                <input type="checkbox" data-xero-credit-note-enabled ${creditNoteSyncEnabled ? 'checked' : ''} />
              </label>
              <label class="xeroToggleRow">
                <span class="xeroToggleCopy"><strong>Push wastage to Xero daily</strong><small>Sent as one Manual Journal per day summarising that day's stock write-offs.</small></span>
                <input type="checkbox" data-xero-wastage-enabled ${wastageSyncEnabled ? 'checked' : ''} />
              </label>
              <div class="xeroFormActions">
                <button type="submit" class="xeroCompactButton xeroCompactButton--primary" data-xero-settings-submit>
                  ${icon('shieldCheck')}
                  <span>Save settings</span>
                </button>
              </div>` : lockedNotice}
            </div>
          </form>

          <div class="xeroTabPane ${activeTab === 'sync' ? 'is-active' : ''}" data-xero-pane="sync">
            <div class="xeroActionGrid">
              <button type="button" class="xeroCompactButton" data-xero-connect ${isConfigured ? '' : 'disabled'}>
                ${icon('link')}
                <span>${isConnected ? 'Reconnect Xero' : 'Connect Xero'}</span>
              </button>
              <button type="button" class="xeroCompactButton" data-xero-sync-items ${isConnected ? '' : 'disabled'}>
                ${icon('boxes')}
                <span>Push catalogue now</span>
              </button>
              <button type="button" class="xeroCompactButton" data-xero-sync-invoice-today ${isConnected ? '' : 'disabled'}>
                ${icon('link')}
                <span>Push today's sales</span>
              </button>
              <button type="button" class="xeroCompactButton" data-xero-sync-invoice ${isConnected ? '' : 'disabled'}>
                ${icon('link')}
                <span>Push yesterday's sales</span>
              </button>
              <button type="button" class="xeroCompactButton" data-xero-sync-grv ${isConnected ? '' : 'disabled'}>
                ${icon('link')}
                <span>Sync GRVs now</span>
              </button>
              <button type="button" class="xeroCompactButton" data-xero-sync-credit-notes ${isConnected ? '' : 'disabled'}>
                ${icon('link')}
                <span>Sync Credit Notes now</span>
              </button>
              <button type="button" class="xeroCompactButton" data-xero-sync-wastage-today ${isConnected ? '' : 'disabled'}>
                ${icon('link')}
                <span>Push today's wastage</span>
              </button>
              <button type="button" class="xeroCompactButton" data-xero-sync-wastage ${isConnected ? '' : 'disabled'}>
                ${icon('link')}
                <span>Push yesterday's wastage</span>
              </button>
              <button type="button" class="xeroCompactButton" data-xero-sync-suppliers ${isConnected ? '' : 'disabled'}>
                ${icon('link')}
                <span>Sync suppliers now</span>
              </button>
            </div>

            <section class="yocoActionPanel xeroNeedsAttentionPanel" aria-label="Suppliers needing a Xero contact match">
              <div class="yocoActionPanelHead">
                <span>Needs attention</span>
                <strong>Suppliers Xero couldn't automatically match to a contact by name.</strong>
              </div>
              <div data-xero-pending-matches>${renderPendingSupplierMatchesList(pendingSupplierMatches, canManageXero)}</div>
            </section>
          </div>

          ${canManageXero ? `
          <div class="xeroTabPane ${activeTab === 'danger' ? 'is-active' : ''}" data-xero-pane="danger">
            <div class="xeroDangerCard">
              <div>
                <strong>Disconnect Xero</strong>
                <span>Stops all sync immediately. Historical pushes stay in Xero — this only breaks the live connection for this workspace.</span>
              </div>
              <button type="button" class="xeroCompactButton xeroCompactButton--danger" data-xero-disconnect ${isConnected ? '' : 'disabled'}>
                ${icon('unlink')}
                <span>Disconnect</span>
              </button>
            </div>
          </div>` : ''}

          <div class="yocoModalNotice" data-xero-modal-status${noticeTone}>
            ${escapeHtml(xeroDrawerState.message)}
          </div>
        </div>
      </section>
    </div>
  `;
}

function bindYocoStatus(view, workspaceId) {
  if (!workspaceId) return;
  const unsubscribe = subscribeYocoIntegration(workspaceId, (status) => updateYocoStatus(view, status));
  const observer = new MutationObserver(() => {
    if (document.body.contains(view)) return;
    unsubscribe?.();
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function bindGmailStatus(view, workspaceId, options = {}) {
  if (!workspaceId) return;
  const unsubscribe = subscribeGmailIntegration(workspaceId, (status) => {
    updateGmailStatus(view, status);
    if (options.once) unsubscribe?.();
  });
  if (options.once) return;
  const observer = new MutationObserver(() => {
    if (document.body.contains(view)) return;
    unsubscribe?.();
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function bindXeroStatus(view, workspaceId, options = {}) {
  if (!workspaceId) return;
  const unsubscribe = subscribeXeroIntegration(workspaceId, (status) => {
    updateXeroStatus(view, status);
    if (options.once) unsubscribe?.();
  });
  if (options.once) return;
  const observer = new MutationObserver(() => {
    if (document.body.contains(view)) return;
    unsubscribe?.();
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function bindDriveStatus(view, workspaceId, options = {}) {
  if (!workspaceId) return;
  const unsubscribe = subscribeDriveIntegration(workspaceId, (status) => {
    updateDriveStatus(view, status);
    if (options.once) unsubscribe?.();
  });
  if (options.once) return;
  const observer = new MutationObserver(() => {
    if (document.body.contains(view)) return;
    unsubscribe?.();
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function updateYocoStatus(view, status = {}, options = {}) {
  if (!options.skipCache) cacheYocoStatus(view.dataset.workspaceId || '', status);
  const isActive = isYocoStatusActive(status);
  const isSyncing = String(status.syncState || '').includes('syncing');
  const statusText = isActive ? (isSyncing ? 'Connected - syncing' : 'Connected') : status.status === 'error' ? 'Error' : 'Disconnected';
  setText(view, '[data-yoco-live-status]', statusText);
  setText(view, '[data-yoco-last-sync]', formatDateTime(status.lastSyncCompletedAt) || 'Not synced yet');
  setText(view, '[data-yoco-catalogue-count]', `${Number(status.catalogue?.itemsCount || 0)} items`);
  setText(view, '[data-yoco-modifier-count]', `${Number(status.catalogue?.productModifiersCount || 0)} modifier options`);
  setText(view, '[data-yoco-location-count]', `${Number(status.locations?.count || 0)} locations`);
  setText(view, '[data-yoco-webhook-status]', status.webhook?.enabled ? 'Active' : 'Not active');
  updateYocoCardStatus(view, isActive ? 'Active' : 'Available');
  if (status.lastError) setYocoModalStatus(view, status.lastError, 'error');
}

function updateYocoCardStatus(view, nextStatus) {
  const card = view.querySelector('[data-integration-id="yoco"]');
  if (!card) return;
  const badge = card.querySelector('em');
  const actionLabel = card.querySelector('[data-integration-action-label]');
  card.dataset.status = nextStatus;
  card.dataset.search = `${card.dataset.search || ''} ${nextStatus}`;
  if (badge) {
    badge.textContent = nextStatus;
    badge.className = getIntegrationStatusClass(nextStatus);
  }
  if (actionLabel) actionLabel.textContent = nextStatus === 'Active' ? 'Manage Yoco' : 'Prepare Setup';
  applyIntegrationFilters(view);
}

function updateGmailStatus(view, status = {}, options = {}) {
  gmailDrawerState.status = status;
  if (!options.skipCache) cacheGmailStatus(view.dataset.workspaceId || '', status);
  const nextStatus = status.configured === false
    ? 'Setup Required'
    : status.connectionActive === true
      ? 'Active'
      : 'Available';
  setText(view, '[data-gmail-live-status]', status.connectionActive ? `Connected as ${status.accountEmail || 'Gmail'}` : status.configured === false ? 'Setup required' : 'Disconnected');
  setText(view, '[data-gmail-status]', status.connectionActive ? 'Connected' : status.configured === false ? 'Not configured' : 'Ready');
  setText(view, '[data-gmail-account]', status.accountEmail || 'No account');
  setText(view, '[data-gmail-connected-at]', formatDateTime(status.connectedAt) || 'Not connected');
  setText(view, '[data-gmail-last-sent]', formatDateTime(status.lastSentAt) || 'No sends yet');
  updateIntegrationCardStatus(view, 'gmail', nextStatus, nextStatus === 'Active' ? 'Manage Gmail' : nextStatus === 'Setup Required' ? 'Needs Config' : 'Connect Gmail');
  if (status.lastError) setGmailModalStatus(view, status.lastError, 'error');
  else if (status.message && status.configured === false) setGmailModalStatus(view, status.message, 'error');
}

function updateDriveStatus(view, status = {}, options = {}) {
  driveDrawerState.status = status;
  if (!options.skipCache) cacheDriveStatus(view.dataset.workspaceId || '', status);
  const nextStatus = status.configured === false
    ? 'Setup Required'
    : status.connectionActive === true
      ? 'Active'
      : 'Available';
  setText(view, '[data-drive-live-status]', status.connectionActive ? `Connected as ${status.accountEmail || 'Google Drive'}` : status.configured === false ? 'Setup required' : 'Disconnected');
  setText(view, '[data-drive-status]', status.connectionActive ? 'Connected' : status.configured === false ? 'Not configured' : 'Ready');
  setText(view, '[data-drive-account]', status.accountEmail || 'No account');
  setText(view, '[data-drive-ocr-status]', status.settings?.ocrEnabled ? 'enabled' : 'disabled');
  refreshDriveSettingsFormFields(view, status.settings || {});
  // The connect/disconnect/save/sync buttons' disabled state is JS-driven (see setDriveBusy),
  // computed from driveDrawerState.status — it must be re-run every time fresh status arrives, not
  // just at initial mount, or a button stays stuck at whatever it was when the modal first
  // rendered (e.g. "Disconnect" and the settings toggles remaining permanently disabled after
  // completing the OAuth popup, since nothing else re-evaluates them once connectionActive flips
  // to true).
  setDriveBusy(view, driveDrawerState.busy);
  updateIntegrationCardStatus(view, 'google-drive', nextStatus, nextStatus === 'Active' ? 'Manage Google Drive' : nextStatus === 'Setup Required' ? 'Needs Config' : 'Connect Google Drive');
  if (status.lastError) setDriveModalStatus(view, status.lastError, 'error');
}

function refreshDriveSettingsFormFields(view, settings) {
  const setChecked = (selector, checked) => {
    const el = view.querySelector(selector);
    if (el) el.checked = checked === true;
  };
  setChecked('[data-drive-grv-enabled]', settings.pushGrvEnabled);
  setChecked('[data-drive-credit-note-enabled]', settings.pushCreditNoteEnabled);
}

// The settings form (Sales/Purchases tabs) is rendered ONCE, baked from whatever settings snapshot
// was available at that instant (often the localStorage cache, taken before the live fetch below
// resolves). updateXeroStatus previously only refreshed small text stats/badges from the fresh
// fetch — never the actual form inputs/checkboxes — so a stale or empty initial paint (e.g. first
// load in a fresh browser, or a snapshot cached before a field existed) stayed wrong in the form
// forever, even though the true saved values were sitting right there in the response. This syncs
// every plain (non-live-picker) field to the latest fetched truth. Only fires on the initial
// subscribe and right after an action completes (see bindXeroStatus/its {once:true} call sites) —
// never on a timer — so it never clobbers input the user is actively mid-typing.
function refreshXeroSettingsFormFields(view, settings) {
  const setChecked = (selector, checked) => {
    const el = view.querySelector(selector);
    if (el) el.checked = checked === true;
  };
  setChecked('[data-xero-enabled]', settings.enabled);
  setChecked('[data-xero-grv-enabled]', settings.grvSyncEnabled);
  setChecked('[data-xero-credit-note-enabled]', settings.creditNoteSyncEnabled);
  setChecked('[data-xero-wastage-enabled]', settings.wastageSyncEnabled);
  // The tax-type/location-tracking/account-code controls are live-pickers that manage their own
  // refresh once their fetch resolves (refreshXeroTaxTypeControls/refreshXeroTrackingCategoryControl/
  // refreshXeroAccountCodeControls). Before that fetch completes they're still a plain fallback
  // <input> — setComboboxValue's plain `.value` path covers that case. Once the fetch resolves,
  // renderXeroCombobox has already replaced the fallback with a custom combobox (hidden <input> + a
  // separate visible trigger label) — a plain `.value =` there would silently desync the hidden
  // value from what the user actually SEES, so this also re-derives and updates the visible
  // label/selected option from the same options list the combobox itself was built from.
  setComboboxValue(view, 'data-xero-tax-type', settings.defaultTaxType, xeroDrawerState.taxRates && buildXeroTaxRateOptions(xeroDrawerState.taxRates, 'revenue'));
  setComboboxValue(view, 'data-xero-sales-exempt-tax-type', settings.salesExemptTaxType, xeroDrawerState.taxRates && buildXeroTaxRateOptions(xeroDrawerState.taxRates, 'revenue'));
  setComboboxValue(view, 'data-xero-purchase-tax-type', settings.purchaseTaxType, xeroDrawerState.taxRates && buildXeroTaxRateOptions(xeroDrawerState.taxRates, 'expenses'));
  setComboboxValue(view, 'data-xero-purchase-exempt-tax-type', settings.purchaseExemptTaxType, xeroDrawerState.taxRates && buildXeroTaxRateOptions(xeroDrawerState.taxRates, 'expenses'));
  setComboboxValue(view, 'data-xero-location-tracking-category', settings.locationTrackingCategoryId, xeroDrawerState.trackingCategories && buildXeroTrackingCategoryOptions(xeroDrawerState.trackingCategories));
  setComboboxValue(view, 'data-xero-sales-account', settings.salesAccountCode, xeroDrawerState.accounts && buildXeroAccountOptions(xeroDrawerState.accounts, 'REVENUE'));
  setComboboxValue(view, 'data-xero-item-account', settings.itemAccountCode, xeroDrawerState.accounts && buildXeroAccountOptions(xeroDrawerState.accounts, 'REVENUE'));
  setComboboxValue(view, 'data-xero-purchase-account', settings.purchaseAccountCode, xeroDrawerState.accounts && buildXeroAccountOptions(xeroDrawerState.accounts, 'EXPENSE'));
  setComboboxValue(view, 'data-xero-cod-payment-account', settings.codPaymentAccountCode, xeroDrawerState.accounts && buildXeroAccountOptions(xeroDrawerState.accounts, 'BANK'));
  setComboboxValue(view, 'data-xero-wastage-expense-account', settings.wastageExpenseAccountCode, xeroDrawerState.accounts && buildXeroAccountOptions(xeroDrawerState.accounts, 'EXPENSE'));
  setComboboxValue(view, 'data-xero-wastage-asset-account', settings.wastageAssetAccountCode, xeroDrawerState.accounts && buildXeroAccountOptions(xeroDrawerState.accounts, 'ASSET'));
}

// Syncs a combobox field to a fresh server value on both paths it can currently be in: still the
// plain fallback <input> (before its options fetch resolves — a plain `.value =` is correct there,
// same as any other text field), or already swapped to the rich renderXeroCombobox markup (a hidden
// <input> whose visible trigger label/selected option must be re-derived from `options`, not just
// the raw value, or the label would silently go stale relative to what's actually selected).
function setComboboxValue(view, dataAttr, value, options) {
  const hiddenInput = view.querySelector(`[${dataAttr}]`);
  if (!hiddenInput) return;
  hiddenInput.value = value || '';
  const combobox = hiddenInput.closest('[data-xero-combobox]');
  if (!combobox || !Array.isArray(options)) return;
  const known = options.find((option) => option.value === value);
  const label = combobox.querySelector('[data-xero-combobox-label]');
  if (label) label.textContent = known ? known.label : value ? `${value} (currently set — not found in Xero)` : label.textContent;
  combobox.querySelectorAll('.xeroComboboxOption').forEach((option) => {
    const isSelected = option.dataset.value === (value || '');
    option.classList.toggle('is-selected', isSelected);
    option.setAttribute('aria-selected', String(isSelected));
  });
}

function updateXeroStatus(view, status = {}, options = {}) {
  xeroDrawerState.status = status;
  if (!options.skipCache) cacheXeroStatus(view.dataset.workspaceId || '', status);
  if (status.connectionActive === true && (xeroDrawerState.activeTab === 'sales' || xeroDrawerState.activeTab === 'purchases')) {
    loadXeroTaxRatesIfNeeded(view);
    loadXeroAccountsIfNeeded(view);
  }
  if (status.connectionActive === true && xeroDrawerState.activeTab === 'purchases') {
    loadXeroTrackingCategoriesIfNeeded(view);
  }
  const settings = status.settings || {};
  refreshXeroSettingsFormFields(view, settings);
  const nextStatus = status.configured === false
    ? 'Setup Required'
    : status.connectionActive === true
      ? 'Active'
      : 'Available';
  setText(view, '[data-xero-live-status]', status.connectionActive ? `Connected to ${status.tenantName || 'Xero'}` : status.configured === false ? 'Setup required' : 'Disconnected');
  setText(view, '[data-xero-status]', status.connectionActive ? 'Connected' : status.configured === false ? 'Not configured' : 'Ready');
  setText(view, '[data-xero-tenant]', status.tenantName || 'No organisation');
  setText(view, '[data-xero-item-sync]', formatDateTime(settings.lastItemSyncAt) || 'Not synced yet');
  setText(view, '[data-xero-invoice-sync]', settings.lastInvoiceSyncDate || 'None yet');
  setText(view, '[data-xero-grv-sync]', settings.lastGrvSyncDate || 'None yet');
  setText(view, '[data-xero-credit-note-sync]', settings.lastCreditNoteSyncDate || 'None yet');
  const dot = view.querySelector('[data-xero-connection-dot]');
  if (dot) dot.classList.toggle('is-connected', status.connectionActive === true);
  const pendingCount = (status.pendingSupplierMatches || []).length;
  setText(view, '[data-xero-pending-count]', pendingCount ? `${pendingCount} supplier${pendingCount === 1 ? '' : 's'}` : 'None');
  const pendingStat = view.querySelector('[data-xero-pending-count]')?.closest('article');
  if (pendingStat) pendingStat.classList.toggle('xeroStatRail--warning', pendingCount > 0);
  const syncTabBadge = view.querySelector('[data-xero-tab="sync"] .xeroTabBadge');
  if (syncTabBadge) syncTabBadge.textContent = String(pendingCount);
  const pendingMatchesContainer = view.querySelector('[data-xero-pending-matches]');
  if (pendingMatchesContainer) {
    pendingMatchesContainer.innerHTML = renderPendingSupplierMatchesList(status.pendingSupplierMatches || [], xeroDrawerState.canManageXero === true);
  }
  updateIntegrationCardStatus(view, 'xero', nextStatus, nextStatus === 'Active' ? 'Manage Xero' : nextStatus === 'Setup Required' ? 'Needs Config' : 'Connect Xero');
  if (status.lastError) setXeroModalStatus(view, status.lastError, 'error');
}

function updateIntegrationCardStatus(view, integrationId, nextStatus, nextActionLabel) {
  const card = view.querySelector(`[data-integration-id="${integrationId}"]`);
  if (!card) return;
  const badge = card.querySelector('em');
  const actionLabel = card.querySelector('[data-integration-action-label]');
  card.dataset.status = nextStatus;
  card.dataset.search = `${card.dataset.search || ''} ${nextStatus}`;
  if (badge) {
    badge.textContent = nextStatus;
    badge.className = getIntegrationStatusClass(nextStatus);
  }
  if (actionLabel) actionLabel.textContent = nextActionLabel;
  applyIntegrationFilters(view);
}

function getRenderedIntegrations(yocoStatus, gmailStatus, xeroStatus, driveStatus) {
  const yocoActive = isYocoStatusActive(yocoStatus);
  const gmailCardStatus = gmailStatus?.configured === false
    ? 'Setup Required'
    : gmailStatus?.connectionActive === true
      ? 'Active'
      : 'Available';
  const xeroCardStatus = xeroStatus?.configured === false
    ? 'Setup Required'
    : xeroStatus?.connectionActive === true
      ? 'Active'
      : 'Available';
  const driveCardStatus = driveStatus?.configured === false
    ? 'Setup Required'
    : driveStatus?.connectionActive === true
      ? 'Active'
      : 'Available';
  return INTEGRATIONS.map((item) => {
    if (item.id === 'gmail') {
      return {
        ...item,
        status: gmailCardStatus,
        action: gmailCardStatus === 'Active' ? 'Manage Gmail' : gmailCardStatus === 'Setup Required' ? 'Needs Config' : item.action
      };
    }
    if (item.id === 'xero') {
      return {
        ...item,
        status: xeroCardStatus,
        action: xeroCardStatus === 'Active' ? 'Manage Xero' : xeroCardStatus === 'Setup Required' ? 'Needs Config' : item.action
      };
    }
    if (item.id === 'google-drive') {
      return {
        ...item,
        status: driveCardStatus,
        action: driveCardStatus === 'Active' ? 'Manage Google Drive' : driveCardStatus === 'Setup Required' ? 'Needs Config' : item.action
      };
    }
    if (item.id !== 'yoco') return item;
    return {
      ...item,
      status: yocoActive ? 'Active' : item.status,
      action: yocoActive ? 'Manage Yoco' : item.action
    };
  });
}

function isYocoStatusActive(status = {}) {
  const rawStatus = String(status?.status || '').trim().toLowerCase();
  return status?.connectionActive === true || rawStatus === 'connected' || status?.webhook?.enabled === true;
}

function yocoCacheKey(workspaceId) {
  return `kcp-yoco-status:${String(workspaceId || 'default')}`;
}

function gmailCacheKey(workspaceId) {
  return `kcp-gmail-status:${String(workspaceId || 'default')}`;
}

function getCachedYocoStatus(workspaceId) {
  if (!workspaceId || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(yocoCacheKey(workspaceId));
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[Yoco] Could not read cached integration status:', error);
    return null;
  }
}

function cacheYocoStatus(workspaceId, status = {}) {
  if (!workspaceId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(yocoCacheKey(workspaceId), JSON.stringify({
      status: String(status.status || '').trim().toLowerCase() || 'disconnected',
      connectionActive: status.connectionActive === true,
      syncState: status.syncState || 'idle',
      lastSyncCompletedAt: status.lastSyncCompletedAt || '',
      webhook: status.webhook || {},
      catalogue: status.catalogue || {},
      locations: status.locations || {},
      cachedAt: new Date().toISOString()
    }));
  } catch (error) {
    console.warn('[Yoco] Could not cache integration status:', error);
  }
}

function getCachedGmailStatus(workspaceId) {
  if (!workspaceId || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(gmailCacheKey(workspaceId));
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[Gmail] Could not read cached integration status:', error);
    return null;
  }
}

function cacheGmailStatus(workspaceId, status = {}) {
  if (!workspaceId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(gmailCacheKey(workspaceId), JSON.stringify({
      status: String(status.status || '').trim().toLowerCase() || 'disconnected',
      configured: status.configured !== false,
      connectionActive: status.connectionActive === true,
      accountEmail: status.accountEmail || '',
      accountName: status.accountName || '',
      connectedAt: status.connectedAt || '',
      connectedBy: status.connectedBy || '',
      lastSentAt: status.lastSentAt || '',
      lastError: status.lastError || '',
      message: status.message || '',
      cachedAt: new Date().toISOString()
    }));
  } catch (error) {
    console.warn('[Gmail] Could not cache integration status:', error);
  }
}

function xeroCacheKey(workspaceId) {
  return `kcp-xero-status:${String(workspaceId || 'default')}`;
}

function getCachedXeroStatus(workspaceId) {
  if (!workspaceId || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(xeroCacheKey(workspaceId));
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[Xero] Could not read cached integration status:', error);
    return null;
  }
}

function cacheXeroStatus(workspaceId, status = {}) {
  if (!workspaceId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(xeroCacheKey(workspaceId), JSON.stringify({
      status: String(status.status || '').trim().toLowerCase() || 'disconnected',
      configured: status.configured !== false,
      connectionActive: status.connectionActive === true,
      tenantName: status.tenantName || '',
      lastError: status.lastError || '',
      settings: status.settings || {},
      cachedAt: new Date().toISOString()
    }));
  } catch (error) {
    console.warn('[Xero] Could not cache integration status:', error);
  }
}

function driveCacheKey(workspaceId) {
  return `kcp-drive-status:${String(workspaceId || 'default')}`;
}

function getCachedDriveStatus(workspaceId) {
  if (!workspaceId || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(driveCacheKey(workspaceId));
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[Drive] Could not read cached integration status:', error);
    return null;
  }
}

function cacheDriveStatus(workspaceId, status = {}) {
  if (!workspaceId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(driveCacheKey(workspaceId), JSON.stringify({
      status: String(status.status || '').trim().toLowerCase() || 'disconnected',
      configured: status.configured !== false,
      connectionActive: status.connectionActive === true,
      accountEmail: status.accountEmail || '',
      lastError: status.lastError || '',
      settings: status.settings || {},
      cachedAt: new Date().toISOString()
    }));
  } catch (error) {
    console.warn('[Drive] Could not cache integration status:', error);
  }
}

function getIntegrationStatusClass(status) {
  if (status === 'Active') return 'is-active';
  if (status === 'Available') return 'is-available';
  if (status === 'Setup Required') return 'is-placeholder';
  return 'is-placeholder';
}

function openYocoModal(view) {
  yocoDrawerState.open = true;
  const modal = view.querySelector('[data-yoco-modal]');
  if (modal) modal.hidden = false;
  view.querySelector('[data-yoco-api-key]')?.focus({ preventScroll: true });
}

function closeYocoModal(view) {
  yocoDrawerState.open = false;
  const modal = view.querySelector('[data-yoco-modal]');
  if (modal) modal.hidden = true;
}

function openGmailModal(view) {
  gmailDrawerState.open = true;
  const modal = view.querySelector('[data-gmail-modal]');
  if (modal) modal.hidden = false;
}

function closeGmailModal(view) {
  gmailDrawerState.open = false;
  const modal = view.querySelector('[data-gmail-modal]');
  if (modal) modal.hidden = true;
}

function openXeroModal(view) {
  xeroDrawerState.open = true;
  const modal = view.querySelector('[data-xero-modal]');
  if (modal) modal.hidden = false;
}

function closeXeroModal(view) {
  xeroDrawerState.open = false;
  const modal = view.querySelector('[data-xero-modal]');
  if (modal) modal.hidden = true;
}

function openDriveModal(view) {
  driveDrawerState.open = true;
  const modal = view.querySelector('[data-drive-modal]');
  if (modal) modal.hidden = false;
}

function closeDriveModal(view) {
  driveDrawerState.open = false;
  const modal = view.querySelector('[data-drive-modal]');
  if (modal) modal.hidden = true;
}

// Toggles tab/pane CSS classes directly rather than a full re-render, so in-progress edits in the
// (still-mounted) settings form fields aren't lost when switching tabs.
function setActiveXeroTab(view, tabId) {
  xeroDrawerState.activeTab = tabId;
  view.querySelectorAll('[data-xero-tab]').forEach((button) => {
    const isActive = button.dataset.xeroTab === tabId;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
  view.querySelectorAll('[data-xero-pane]').forEach((pane) => {
    pane.classList.toggle('is-active', pane.dataset.xeroPane === tabId);
  });
}

async function runYocoAction(view, message, task) {
  window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = true;
  setYocoBusy(view, true);
  setYocoModalStatus(view, message, 'busy');
  try {
    await task();
  } catch (error) {
    setYocoModalStatus(view, error.message || 'Yoco action failed.', 'error');
  } finally {
    setYocoBusy(view, false);
    window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = false;
    window.dispatchEvent(new CustomEvent('kcp:integrations-sync-complete'));
  }
}

async function runGmailAction(view, message, task, options = {}) {
  window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = true;
  setGmailBusy(view, true);
  setGmailModalStatus(view, message, 'busy');
  try {
    await task();
  } catch (error) {
    setGmailModalStatus(view, error.message || 'Gmail action failed.', 'error');
  } finally {
    setGmailBusy(view, false);
    window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = false;
    if (!options.keepMessage) window.dispatchEvent(new CustomEvent('kcp:integrations-sync-complete'));
  }
}

async function runXeroAction(view, message, task, options = {}) {
  window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = true;
  setXeroBusy(view, true);
  setXeroModalStatus(view, message, 'busy');
  try {
    await task();
  } catch (error) {
    setXeroModalStatus(view, error.message || 'Xero action failed.', 'error');
  } finally {
    setXeroBusy(view, false);
    window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = false;
    if (!options.keepMessage) window.dispatchEvent(new CustomEvent('kcp:integrations-sync-complete'));
  }
}

async function runDriveAction(view, message, task, options = {}) {
  window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = true;
  setDriveBusy(view, true);
  setDriveModalStatus(view, message, 'busy');
  try {
    await task();
  } catch (error) {
    setDriveModalStatus(view, error.message || 'Google Drive action failed.', 'error');
  } finally {
    setDriveBusy(view, false);
    window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ = false;
    if (!options.keepMessage) window.dispatchEvent(new CustomEvent('kcp:integrations-sync-complete'));
  }
}

function setYocoBusy(view, busy) {
  yocoDrawerState.busy = busy;
  view.querySelectorAll('[data-yoco-submit], [data-yoco-sync-catalogue], [data-yoco-disconnect]').forEach((button) => {
    button.disabled = busy;
  });
}

function setGmailBusy(view, busy) {
  gmailDrawerState.busy = busy;
  view.querySelectorAll('[data-gmail-connect], [data-gmail-disconnect]').forEach((button) => {
    const isDisconnect = button.hasAttribute('data-gmail-disconnect');
    const isConnect = button.hasAttribute('data-gmail-connect');
    button.disabled = busy ||
      (isConnect && gmailDrawerState.status?.configured === false) ||
      (isDisconnect && gmailDrawerState.status?.connectionActive !== true);
  });
}

function setXeroBusy(view, busy) {
  xeroDrawerState.busy = busy;
  view.querySelectorAll('[data-xero-connect], [data-xero-disconnect], [data-xero-sync-items], [data-xero-sync-invoice], [data-xero-sync-invoice-today], [data-xero-sync-grv], [data-xero-sync-credit-notes], [data-xero-sync-wastage], [data-xero-sync-wastage-today], [data-xero-sync-suppliers], [data-xero-settings-submit]').forEach((button) => {
    const isDisconnect = button.hasAttribute('data-xero-disconnect');
    const isConnect = button.hasAttribute('data-xero-connect');
    const isSync = button.hasAttribute('data-xero-sync-items') || button.hasAttribute('data-xero-sync-invoice') || button.hasAttribute('data-xero-sync-invoice-today') || button.hasAttribute('data-xero-sync-grv') || button.hasAttribute('data-xero-sync-credit-notes') || button.hasAttribute('data-xero-sync-wastage') || button.hasAttribute('data-xero-sync-wastage-today') || button.hasAttribute('data-xero-sync-suppliers');
    button.disabled = busy ||
      (isConnect && xeroDrawerState.status?.configured === false) ||
      (isDisconnect && xeroDrawerState.status?.connectionActive !== true) ||
      (isSync && xeroDrawerState.status?.connectionActive !== true);
  });
}

function setDriveBusy(view, busy) {
  driveDrawerState.busy = busy;
  view.querySelectorAll('[data-drive-connect], [data-drive-disconnect], [data-drive-settings-submit], [data-drive-sync-now]').forEach((button) => {
    const isDisconnect = button.hasAttribute('data-drive-disconnect');
    const isConnect = button.hasAttribute('data-drive-connect');
    const needsConnection = button.hasAttribute('data-drive-settings-submit') || button.hasAttribute('data-drive-sync-now');
    button.disabled = busy ||
      (isConnect && driveDrawerState.status?.configured === false) ||
      (isDisconnect && driveDrawerState.status?.connectionActive !== true) ||
      (needsConnection && driveDrawerState.status?.connectionActive !== true);
  });
  // Same "nothing to push to without a connection" reasoning as needsConnection above, but for the
  // toggle checkboxes themselves — re-evaluated here (not baked into the initial render markup) so
  // they correctly unlock the moment a connection completes, instead of staying stuck at whatever
  // they were when the modal first mounted.
  view.querySelectorAll('[data-drive-grv-enabled], [data-drive-credit-note-enabled]').forEach((checkbox) => {
    checkbox.disabled = busy || driveDrawerState.status?.connectionActive !== true;
  });
}

function setYocoModalStatus(view, message, tone = 'busy') {
  yocoDrawerState.message = message;
  yocoDrawerState.tone = tone;
  const target = view.querySelector('[data-yoco-modal-status]');
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function setGmailModalStatus(view, message, tone = 'busy') {
  gmailDrawerState.message = message;
  gmailDrawerState.tone = tone;
  const target = view.querySelector('[data-gmail-modal-status]');
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function setXeroModalStatus(view, message, tone = 'busy') {
  xeroDrawerState.message = message;
  xeroDrawerState.tone = tone;
  const target = view.querySelector('[data-xero-modal-status]');
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function setDriveModalStatus(view, message, tone = 'busy') {
  driveDrawerState.message = message;
  driveDrawerState.tone = tone;
  const target = view.querySelector('[data-drive-modal-status]');
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function setYocoSummary(view, result = {}) {
  yocoDrawerState.summary = result;
  const target = view.querySelector('[data-yoco-summary]');
  if (!target) return;
  const content = renderYocoSummaryEntries(result);
  target.hidden = !content;
  target.innerHTML = content;
}

function renderYocoSummaryEntries(result = {}) {
  if (!result) return '';
  const entries = [
    ['Locations imported', result.locationsImported],
    ['Locations matched', result.locationsMatched],
    ['Products imported', result.productsImported],
    ['Products matched', result.productsMatched],
    ['Modifier groups stored', result.modifierGroupsStored],
    ['Modifier choices stored', result.modifierOptionsStored ?? result.productModifiersStored],
    ['Product modifiers', result.productModifiersStored],
    ['Option modifiers', result.optionModifiersStored],
    ['Note modifiers', result.noteModifiersStored],
    ['Orders', result.ordersProcessed],
    ['Refunds', result.refundsProcessed],
    ['Missing recipes', result.missingRecipes],
    ['Webhook', result.webhookEnabled === true ? 'Active' : result.webhookError ? 'Needs setup' : undefined]
  ].filter(([, value]) => value !== undefined);
  return entries.map(([label, value]) => `<span><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</span>`).join('');
}

function setText(view, selector, value) {
  const target = view.querySelector(selector);
  if (target) target.textContent = value;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function icon(name) {
  const icons = {
    book: '<path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h8"/><path d="M8 11h8"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    boxes: '<path d="M2.5 7.5 12 2l9.5 5.5L12 13z"/><path d="M2.5 7.5V16L12 22l9.5-6V7.5"/><path d="M12 13v9"/><path d="m7 4.8 9.6 5.5"/>',
    drive: '<path d="M7.5 3h9L22 12l-4.5 8h-11L2 12z"/><path d="M8.5 15h7"/><path d="m8.5 15-2-3"/><path d="m15.5 15 2-3"/>',
    square: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6"/>',
    external: '<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M20 14v6H4V4h6"/>',
    keyRound: '<path d="M2 18a6 6 0 1 1 11.2-3H22l-2 2 2 2-2 2h-3l-2-2h-1.8A6 6 0 0 1 2 18z"/><circle cx="8" cy="18" r="1.5"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    plug: '<path d="M9 7V3"/><path d="M15 7V3"/><path d="M7 7h10v5a5 5 0 0 1-10 0z"/><path d="M12 17v4"/>',
    receiptText: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2z"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h4"/><path d="M6 22v-4H2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/>',
    settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.3 3a7 7 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 1.7 1l.3 3h5l.3-3a7 7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5c.1-.3.1-.7.1-1z"/>',
    shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-5"/>',
    unlink: '<path d="M15 7h1a5 5 0 0 1 0 10h-2"/><path d="M9 17H8A5 5 0 0 1 8 7h2"/><path d="m8 12 8 0"/><path d="m3 3 18 18"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${icons[name] || icons.plug}
    </svg>
  `;
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
