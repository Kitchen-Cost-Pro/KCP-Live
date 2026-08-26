import './styles/tailwind.css';
import './styles/main.css';
import './styles/chat.css';
import './styles/reporting.css';
import { mountChatWidget, unmountChatWidget } from './components/Chat.js';
import { renderAuthenticatedApp } from './appShell.js';
import { renderLogin } from './auth.js';
import {
  claimInvitationForUser,
  getInvitationForEmail,
  getUserProfile,
  listenToAuthChanges,
  secureSignOut
} from './services/authService.js';
import {
  createWorkspaceMember,
  deleteWorkspaceRole,
  removeWorkspaceMember,
  resendWorkspaceMemberInvite,
  saveWorkspaceRole,
  subscribeWorkspaceAccess,
  updateWorkspaceMember
} from './services/userManagementService.js';
import {
  getTradeDateKey,
  getWorkspaceSettings,
  resolveActiveWorkspaceOptions
} from './services/database.js';
import {
  exportWorkspaceSnapshot,
  getGoLiveReadiness,
  getOnboardingReadiness,
  getStockCategoryOptions,
  getYocoCategoryOptions,
  getWorkspaceSettingsSnapshot,
  importWorkspaceSnapshot,
  normalizeSettings,
  savePersonalSettings,
  saveOnboardingState,
  saveWorkspaceSettings
} from './services/settingsService.js';
import {
  bindOnboardingResumeButtonEvents,
  bindOnboardingWizardShellEvents,
  firstIncompleteOnboardingStep,
  getOnboardingProgress,
  getWizardStep,
  isOnboardingStepComplete,
  renderOnboardingResumeButton,
  renderOnboardingWizardShell,
  updateOnboardingWizardContent
} from './components/OnboardingWizard.js';
import { ACTION_PERMISSION_MAP, canManagePermissionSets, ensureExplicitDataPermissionSchema, getAccessRenderRevision, hasPermission, hasSectionAccess, normalizeRoleName, resolveRoleDefinition, toRoleLabel } from './services/roleService.js';
import { buildSupplierPurchaseOrderPdfFile as buildSupplierPurchaseOrderPdfDocument, buildManufacturingBuilderXlsx, downloadFileBlob, downloadStyledRecipeTemplateXlsx, downloadStyledStockTemplateXlsx, parseDataFile } from './services/dataService.js';
import { KCP_PDF_THEME } from './utils/pdfTheme.js';
import {
  buildExportFilename,
  buildMenuCatalogueRows,
  buildGoodsReceiptDocumentRows,
  buildManufacturingRows,
  buildPurchaseOrderDocumentRows,
  buildRecipeRows,
  buildStockRows,
  buildSupplierRows,
  buildTemplateRows,
  exportAoaRows,
  exportObjectRows,
  exportSchemas,
} from './services/exportService.js';
import { callCloudflareWorkspaceRoute, clearApiCache } from './services/cloudflareApi.js';
import { sendSupplierEmailWithGmail, subscribeYocoIntegration, syncYocoCatalogue, syncYocoCatalogueIfDue, syncYocoSales } from './services/integrationService.js';
import { fetchSystemBroadcast } from './services/systemBroadcastService.js';
import { DEFAULT_STOCK_LOCATION_ID, DEFAULT_STOCK_LOCATION_NAME } from './services/locationModel.js';
import {
  DEFAULT_RESTAURANT_BACKGROUND_ID,
  DEFAULT_RESTAURANT_THEME_ID,
  getRestaurantBackgroundPreset,
  getRestaurantThemePreset,
  getRestaurantThemeVariableNames
} from './themePresets.js';
import { matchesBarcodeQuery, parseBarcodeValues } from './utils/barcodes.js';
import { todayLocal } from './utils/date.js';
import {
  cleanupAppDropdownPortal,
  installAppDropdownPortalSystem,
  scheduleAppDropdownPortalRefresh
} from './utils/appDropdownPortal.js';
import { isStockCountableItem, isTransferEligibleStockItem } from './services/stockCountEligibility.js';
import { deriveStockItemType } from './utils/stockItemType.js';
// Canonical per-location balance resolver (same one the Transfers UI uses to show before/after),
// so the transfer insufficient-stock validation resolves the source balance identically.
import { getLocationStock as resolveLocationStock } from './utils/stockBalances.js';

const app = document.querySelector('#app');
const THEME_STORAGE_KEY = 'kcp-live-theme';
const ROUTE_STORAGE_KEY = 'kcp-live-route';
const AUTO_LOGIN_STORAGE_PREFIX = 'kcp:auto-login-workspace:v1';
const DRAFT_STORAGE_PREFIX = 'kcp:drafts:v1';
const ADJUSTMENT_PAGE_SIZE = 25;
const PERSISTED_ROUTES = ['dashboard', 'products', 'recipes', 'ingredients', 'suppliers', 'purchase-orders', 'grv', 'credit-note', 'adjustments', 'transfers', 'stock-count', 'locations', 'mfg-products', 'reporting', 'reporting-scheduling', 'integrations', 'user-management', 'custom-roles', 'settings', 'settings-business', 'settings-customization'];
const SETTINGS_ROUTES = ['settings', 'settings-business', 'settings-customization'];

installAppDropdownPortalSystem();
mountCookiePolicyNotice();

function mountCookiePolicyNotice() {
  const storageKey = 'kcp:cookie-consent:v1';
  if (localStorage.getItem(storageKey)) return;

  const overlay = document.createElement('div');
  overlay.className = 'cookiePolicy';
  overlay.setAttribute('role', 'presentation');
  overlay.innerHTML = `
    <section class="cookiePolicy__card" role="region" aria-labelledby="cookie-policy-title">
      <div class="cookiePolicy__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M20.8 13.1A8.8 8.8 0 1 1 10.9 3.2a4.7 4.7 0 0 0 6 6 4.7 4.7 0 0 0 3.9 3.9Z"/>
          <circle cx="8.5" cy="12.2" r=".7" fill="currentColor" stroke="none"/>
          <circle cx="12.2" cy="16" r=".7" fill="currentColor" stroke="none"/>
          <circle cx="7.5" cy="17.2" r=".7" fill="currentColor" stroke="none"/>
        </svg>
      </div>
      <div class="cookiePolicy__copy">
        <p>Privacy at KCP</p>
        <h2 id="cookie-policy-title">A quick note about cookies</h2>
        <span>We use essential cookies to keep you signed in, remember your workspace settings, and keep Kitchen Cost Pro secure.</span>
        <a href="/privacy.html" target="_blank" rel="noopener">Read our cookie and privacy policy</a>
      </div>
      <div class="cookiePolicy__actions">
        <button type="button" class="cookiePolicy__secondary" data-cookie-essential>Essential only</button>
        <button type="button" class="cookiePolicy__primary" data-cookie-accept>Accept</button>
      </div>
    </section>
  `;

  const close = (choice) => {
    localStorage.setItem(storageKey, JSON.stringify({
      choice,
      savedAt: new Date().toISOString(),
    }));
    overlay.classList.add('is-closing');
    window.setTimeout(() => overlay.remove(), 180);
  };
  overlay.querySelector('[data-cookie-essential]')?.addEventListener('click', () => close('essential'));
  overlay.querySelector('[data-cookie-accept]')?.addEventListener('click', () => close('accepted'));
  document.body.appendChild(overlay);
}

function showBrandConfirmDialog({
  eyebrow = 'Confirm Action',
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger'
} = {}) {
  return new Promise((resolve) => {
    const escape = (value = '') => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
    const overlay = document.createElement('div');
    overlay.className = 'brandConfirm';
    overlay.innerHTML = `
      <section class="brandConfirm__card brandConfirm__card--${tone}" role="dialog" aria-modal="true" aria-labelledby="brand-confirm-title">
        <div class="brandConfirm__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>
          </svg>
        </div>
        <p>${escape(eyebrow)}</p>
        <h2 id="brand-confirm-title">${escape(title)}</h2>
        <span>${escape(message)}</span>
        <div class="brandConfirm__actions">
          <button type="button" class="brandConfirm__secondary" data-brand-confirm-cancel>${escape(cancelLabel)}</button>
          <button type="button" class="brandConfirm__primary" data-brand-confirm-ok>${escape(confirmLabel)}</button>
        </div>
      </section>
    `;

    const cleanup = (result) => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      scheduleDeferredRealtimeSnapshotFlush();
      resolve(result);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') cleanup(false);
    };

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(false);
    });
    overlay.querySelector('[data-brand-confirm-cancel]')?.addEventListener('click', () => cleanup(false));
    overlay.querySelector('[data-brand-confirm-ok]')?.addEventListener('click', () => cleanup(true));
    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-brand-confirm-cancel]')?.focus();
  });
}

export const appState = {
  auth: {
    status: 'checking',
    error: ''
  },
  user: null,
  profile: null,
  workspaceOptions: [],
  workspace: null,
  autoLoginPreference: null,
  workspaceError: '',
  systemBroadcast: null,
  importNotification: null,
  onboarding: null,
  access: createAccessState('idle'),
  route: {
    active: getInitialRoute()
  },
  theme: getInitialTheme(),
  source: null,
  menu: createMenuState('idle'),
  recipes: createRecipeState('idle'),
  stock: createStockState('idle'),
  suppliers: createSupplierState('idle'),
  purchaseOrders: createPurchaseOrderState('idle'),
  grv: createGrvState('idle'),
  creditNotes: createCreditNoteState('idle'),
  adjustments: createAdjustmentState('idle'),
  transfers: createTransferState('idle'),
  stockTake: createStockTakeState('idle'),
  locations: createLocationState('idle'),
  manufacturing: createManufacturingState('idle'),
  userManagement: createUserManagementState('idle'),
  roleManagement: createRoleManagementState('idle'),
  settings: createSettingsState('idle')
};

window.__KCP_LIVE_STATE__ = appState;

window.addEventListener('kcp:integrations-sync-complete', () => {
  // Integration actions update their own drawer/status UI. Do not remount the active module
  // after a background sync: that looked like a random page reload and reset report/table state.
  // Fresh data is loaded by the module's explicit Refresh action or the next navigation.
});

let unsubscribeAccess = null;
let systemBroadcastRefreshTimer = null;
let integrationAutoSyncTimer = null;
let catalogueAutoSyncTimer = null;
let dataVersionPollTimer = null;
// Consecutive data-version poll failures. Used to back off the poll interval so a struggling or
// backed-off backend (e.g. a Durable Object waiting out a migration circuit-breaker) isn't
// hammered at full 15-second cadence forever, from every open browser tab, on every workspace —
// that amplification is exactly what turned one backend issue into a much bigger one previously.
let dataVersionPollFailures = 0;
let dataVersionPollVisibilityHandler = null;
let lastSeenDataVersion = null;
// Monotonic guard against out-of-order background stock refreshes. Any in-flight
// stock fetch that was started BEFORE the most recent local mutation (delete/save)
// is stale by the time it resolves and must never be allowed to overwrite state —
// this is what caused deleted items to silently reappear after a live poll landed late.
let stockMutationToken = 0;
let _integrationVisibilityHandler = null;
let _globalSavingOverlay = null;
let accessSubscriptionToken = 0;
let unsubscribeMenu = null;
let menuSubscriptionToken = 0;
let unsubscribeRecipes = null;
let recipeSubscriptionToken = 0;
let lastRecipeViewportFocusRequest = '';
let unsubscribeStock = null;
let stockSubscriptionToken = 0;
let unsubscribeSuppliers = null;
let supplierSubscriptionToken = 0;
let unsubscribePurchaseOrders = null;
let purchaseOrderSubscriptionToken = 0;
let pendingReportingPurchaseOrderSeed = null;
let unsubscribeGrv = null;
let grvSubscriptionToken = 0;
let unsubscribeCreditNotes = null;
let creditNoteSubscriptionToken = 0;
let unsubscribeAdjustments = null;
let adjustmentSubscriptionToken = 0;
let unsubscribeTransfers = null;
let transferSubscriptionToken = 0;
let unsubscribeStockTake = null;
let stockTakeSubscriptionToken = 0;
let unsubscribeLocations = null;
let locationSubscriptionToken = 0;
let unsubscribeManufacturing = null;
let manufacturingSubscriptionToken = 0;

let settingsLoadToken = 0;
let clockTimer = null;
let menuToastTimer = null;
let recipeToastTimer = null;
let stockToastTimer = null;
let supplierToastTimer = null;
let purchaseOrderToastTimer = null;
let grvToastTimer = null;
let creditNoteToastTimer = null;
let adjustmentToastTimer = null;
let settingsToastTimer = null;
let userManagementToastTimer = null;
let roleManagementToastTimer = null;
let autoLogoutTimer = null;
let autoLogoutResetHandler = null;
let pendingFocusField = null;
let focusRestoreToken = 0;
let settingsDraftRenderTimer = null;
let supplierDraftRenderTimer = null;
let purchaseOrderLineRenderTimer = null;
const deferredRealtimeSnapshots = new Map();
let deferredRealtimeSnapshotFlushTimer = null;
let modalScrollLockSyncQueued = false;

applyTheme(appState.theme);
document.addEventListener('keydown', handleGlobalModalTabTrap, true);
if (document.body) {
  new MutationObserver(scheduleAppModalScrollLockSync).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'aria-hidden']
  });
}
renderBoot('Checking secure session...');

if (!appState.user && !appState.workspace) {
  appState.auth = { status: 'idle', error: '', mode: 'login' };
  renderApp();
}

listenToAuthChanges(async (user) => {
  cleanupAccessSubscription();
  cleanupMenuSubscription();
  cleanupRecipeSubscription();
  cleanupStockSubscription();
  cleanupSupplierSubscription();
  cleanupPurchaseOrderSubscription();
  cleanupGrvSubscription();
  cleanupCreditNoteSubscription();
  cleanupAdjustmentSubscription();
  cleanupTransferSubscription();
  cleanupStockTakeSubscription();
  cleanupLocationSubscription();
  cleanupManufacturingSubscription();
  cleanupLocationSubscription();
  cleanupManufacturingSubscription();


  if (!user) {
    stopAutoLogout();
    Object.assign(appState, {
      user: null,
      profile: null,
      workspaceOptions: [],
      workspace: null,
      workspaceError: '',
      access: createAccessState('idle'),
      route: { active: getInitialRoute() },
      theme: appState.theme,
      source: null,
          menu: createMenuState('idle'),
      recipes: createRecipeState('idle'),
      stock: createStockState('idle'),
      suppliers: createSupplierState('idle'),
      purchaseOrders: createPurchaseOrderState('idle'),
      grv: createGrvState('idle'),
      creditNotes: createCreditNoteState('idle'),
      adjustments: createAdjustmentState('idle'),
      transfers: createTransferState('idle'),
      stockTake: createStockTakeState('idle'),
      locations: createLocationState('idle'),
      manufacturing: createManufacturingState('idle'),
          userManagement: createUserManagementState('idle'),
      roleManagement: createRoleManagementState('idle'),
      settings: createSettingsState('idle')
    });
    // Handle password reset link: /?resetToken=...
    const resetToken = new URLSearchParams(window.location.search).get('resetToken');
    if (resetToken) {
      appState.auth = { status: 'idle', error: '', mode: 'reset-token', resetToken };
    } else {
      appState.auth = { status: 'idle', error: '' };
    }
    appState.autoLoginPreference = null;
    stopLiveClock();
    renderApp();
    return;
  }

  await loadAuthenticatedUser(user);
});

async function loadAuthenticatedUser(user) {
  appState.user = user;
  appState.autoLoginPreference = readAutoLoginPreference(user);
  appState.auth = { status: 'loading', error: '' };
  appState.recipes = createRecipeState('idle', appState.recipes.filters);
  appState.stock = createStockState('idle', appState.stock.filters);
  appState.suppliers = createSupplierState('idle', appState.suppliers.filters);
  appState.purchaseOrders = createPurchaseOrderState('idle', appState.purchaseOrders.filters);
  appState.grv = createGrvState('idle', appState.grv.filters, appState.grv.pendingSourcePoId);
  appState.creditNotes = createCreditNoteState('idle', appState.creditNotes.filters);
  appState.adjustments = createAdjustmentState('idle', appState.adjustments.filters);
  appState.transfers = createTransferState('idle', appState.transfers.filters);
  appState.stockTake = createStockTakeState('idle', appState.stockTake.filters, appState.stockTake.sessionActive);
  appState.locations = createLocationState('idle', appState.locations.filters);
  appState.manufacturing = createManufacturingState('idle', appState.manufacturing.filters);
  appState.userManagement = createUserManagementState('idle', appState.userManagement.filters);
  appState.roleManagement = createRoleManagementState('idle');
  appState.settings = createSettingsState('idle', appState.settings?.draft);
  renderBoot('Loading your workspace profile...');

  try {
    let invite = null;
    try {
      invite = await getInvitationForEmail(user.email);
    } catch (error) {
      console.warn('[Auth] Invitation lookup skipped:', error);
    }

    if (invite?.wsId || invite?.workspaceId) {
      await claimInvitationForUser(user, invite);
    }

    const profile = await getUserProfile(user.uid);
    appState.profile = profile;

    if (!profile) {
      routeToWorkspaceRegistration(user);
      renderApp();
      return;
    }

    if (profile?.mustChangePassword || profile?.firstLoginRequired) {
      appState.workspace = null;
      appState.workspaceOptions = [];
      appState.workspaceError = '';
      appState.auth = { status: 'force-password-reset', error: '', mode: 'set-password' };
      renderApp();
      return;
    }

    appState.workspaceOptions = await resolveActiveWorkspaceOptions(profile || {});
    appState.autoLoginPreference = readAutoLoginPreference(user);

    if (!appState.workspaceOptions.length) {
      const pendingSite = profile?.requestedWorkspace?.siteName || profile?.siteName || 'your workspace';
      if (profile?.status === 'pending') {
        appState.workspaceError = '';
        appState.auth = {
          status: 'registration-pending',
          error: '',
          mode: 'register',
          provider: userUsesGoogleProvider(user) ? 'google' : 'email',
          message: `Your request for ${pendingSite} is still pending admin approval.`
        };
      } else {
        routeToWorkspaceRegistration(user);
      }
      renderApp();
      return;
    }

    const autoLoginWorkspace = getAutoLoginWorkspace(appState.workspaceOptions, user);
    if (autoLoginWorkspace) {
      appState.workspaceError = '';
      appState.auth = { status: 'ready', error: '' };
      renderBoot('Opening your saved workspace...');
      await selectWorkspace(autoLoginWorkspace);
      return;
    }

    if (appState.workspaceOptions.length === 1) {
      appState.workspaceError = '';
      appState.auth = { status: 'ready', error: '' };
      await selectWorkspace(appState.workspaceOptions[0]);
      return;
    }

    appState.workspace = null;
    appState.workspaceError = '';
    appState.auth = { status: 'workspace-select', error: '' };
    renderApp();
  } catch (error) {
    if (userUsesGoogleProvider(user)) {
      console.warn('[Auth] Workspace lookup failed for Google user; opening approval request form:', error);
      routeToWorkspaceRegistration(user, error.message || '');
      renderApp();
      return;
    }
    appState.auth = { status: 'idle', error: error.message || 'Could not load your user profile.' };
    appState.workspaceError = error.message || 'Could not load your workspace.';
    renderApp();
  }
}

function routeToWorkspaceRegistration(user, error = '') {
  appState.user = user || appState.user;
  appState.workspace = null;
    appState.workspaceOptions = [];
  appState.autoLoginPreference = readAutoLoginPreference(user);
  appState.workspaceError = '';
  appState.auth = {
    status: 'idle',
    error,
    mode: 'register',
    provider: userUsesGoogleProvider(user) ? 'google' : 'email'
  };
}

async function handlePostPasswordChange() {
  const user = appState.user;
  if (!user?.uid) {
    appState.auth = { status: 'idle', error: 'Your session expired. Please sign in again.' };
    renderApp();
    return;
  }

  try {
    let invite = null;
    try {
      invite = await getInvitationForEmail(user.email);
    } catch (error) {
      console.warn('[Auth] Invitation lookup skipped after password change:', error);
    }

    if (invite?.wsId || invite?.workspaceId) {
      await claimInvitationForUser(user, invite);
    }

    const profile = await getUserProfile(user.uid);
    appState.profile = profile;
    appState.workspaceOptions = await resolveActiveWorkspaceOptions(profile || {});
    appState.autoLoginPreference = readAutoLoginPreference(user);

    if (!appState.workspaceOptions.length) {
      appState.workspaceError = 'Your profile is authenticated, but it is not assigned to any active workspace yet.';
      appState.auth = { status: 'workspace-select', error: '' };
      renderApp();
      return;
    }

    const autoLoginWorkspace = getAutoLoginWorkspace(appState.workspaceOptions, user);
    if (autoLoginWorkspace) {
      appState.workspaceError = '';
      appState.auth = { status: 'ready', error: '' };
      renderBoot('Opening your saved workspace...');
      await selectWorkspace(autoLoginWorkspace);
      return;
    }

    if (appState.workspaceOptions.length === 1) {
      appState.workspaceError = '';
      appState.auth = { status: 'ready', error: '' };
      await selectWorkspace(appState.workspaceOptions[0]);
      return;
    }

    appState.workspace = null;
    appState.workspaceError = '';
    appState.auth = { status: 'workspace-select', error: '' };
    renderApp();
  } catch (error) {
    appState.auth = { status: 'force-password-reset', error: error.message || 'Could not load your approved workspace.', mode: 'set-password' };
    renderApp();
  }
}

async function loadSystemBroadcast({ render = true } = {}) {
  try {
    const broadcast = await fetchSystemBroadcast();
    // Keep an existing broadcast visible until the user explicitly dismisses it;
    // server-side expiry should not auto-hide notices the user hasn't seen yet.
    if (broadcast !== null) {
      appState.systemBroadcast = broadcast;
    }
    // If broadcast is null and nothing is currently showing, ensure state is cleared.
    if (broadcast === null && !appState.systemBroadcast) {
      appState.systemBroadcast = null;
    }
  } catch (error) {
    console.warn('[System broadcast] Load failed:', error);
  }
  if (render) renderApp();
}

function isUserBusy() {
  // Any modal backdrop is visible — user is in a modal flow
  if (shouldLockAppModalScroll()) return true;
  // User is actively typing in a form field
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return true;
  return false;
}

function showGlobalSaving(message = 'Saving') {
  if (_globalSavingOverlay) return;
  const el = document.createElement('div');
  el.id = 'kcp-global-saving-overlay';
  el.innerHTML = `
    <div class="kcpGlobalSavingCard">
      <span class="kcpGlobalSavingSpinner" aria-hidden="true"></span>
      <strong>${message}</strong>
    </div>
  `;
  document.body.appendChild(el);
  _globalSavingOverlay = el;
}

function hideGlobalSaving() {
  if (_globalSavingOverlay) {
    _globalSavingOverlay.remove();
    _globalSavingOverlay = null;
  }
}

// Called once per login/workspace-open (see selectWorkspace). The backend only actually reaches
// out to Yoco when the catalogue is stale — see postSyncCatalogueIfDue — so this is cheap to call
// on every login: most of the time it costs one D1 read on the worker and nothing else, and it's
// what keeps the menu up to date for someone opening the app after being away, without needing the
// (currently disabled) cron trigger.
function requestCatalogueSyncIfDue(workspaceId) {
  if (!workspaceId) return;
  syncYocoCatalogueIfDue(workspaceId).catch(() => { /* best-effort, silent */ });
}

// Onboarding wizard: sequences the EXISTING supplier/stock/recipe bulk-import tools and the Yoco
// connect/sync flow for a brand-new, fully-empty workspace. No new import/sync logic lives here —
// every action below delegates straight to the same functions the standalone Suppliers/StockItems/
// Recipes/Integrations screens already use.

// One-shot promise wrapper around subscribeYocoIntegration (which is subscribe-shaped for
// consistency with the other integration status feeds, but only ever calls back once — there is
// no ongoing polling underneath it).
function fetchYocoStatusOnce(workspaceId) {
  return new Promise((resolve) => {
    const unsubscribe = subscribeYocoIntegration(workspaceId, (status) => {
      unsubscribe();
      resolve(status);
    });
  });
}

async function maybeOpenOnboardingWizard(workspaceId, settings) {
  if (!workspaceId || settings?.onboarding?.dismissed) return;
  try {
    const [readiness, yoco] = await Promise.all([
      getOnboardingReadiness(workspaceId),
      fetchYocoStatusOnce(workspaceId)
    ]);
    if (readiness.productCount > 0 || readiness.supplierCount > 0 || readiness.stockItemCount > 0) return;
    if (appState.workspace?.id !== workspaceId) return; // workspace changed while this was in flight
    appState.onboarding = {
      open: true,
      welcome: true,
      // Feature: skip straight past whichever steps are already done (e.g. Yoco was connected in
      // a previous session) instead of always starting at step 1.
      wizardStep: firstIncompleteOnboardingStep({ counts: readiness, yoco }),
      actionStatus: '',
      actionError: '',
      counts: readiness,
      yoco,
      pendingImport: null,
      quickAdd: null,
      recipeBuilder: null,
      // Admin-console-only flag (workspace_settings.raw_json.ai_onboarding_enabled) — workspace
      // users can't turn this on themselves. See postWorkspaceAiExtract in the worker.
      aiOnboardingEnabled: settings?.ai_onboarding_enabled === true
    };
    renderApp();
  } catch {
    /* best-effort — never block login on this */
  }
}

async function refreshOnboardingYocoStatus(workspaceId) {
  const status = await fetchYocoStatusOnce(workspaceId);
  if (!appState.onboarding || appState.workspace?.id !== workspaceId) return;
  appState.onboarding = { ...appState.onboarding, yoco: status };
  renderApp();
}

async function refreshOnboardingCounts() {
  const workspaceId = appState.workspace?.id;
  if (!workspaceId || !appState.onboarding) return;
  try {
    const counts = await getOnboardingReadiness(workspaceId);
    if (!appState.onboarding || appState.workspace?.id !== workspaceId) return;
    appState.onboarding = { ...appState.onboarding, counts };
    renderApp();
  } catch {
    /* live counts are a nice-to-have; leave the previous values on failure */
  }
}

// Direct jump — used by clicking a step number in the steps nav. Always honors exactly what was
// clicked, no skipping: an explicit choice overrides the "skip completed steps" behavior below.
function setOnboardingStep(step) {
  if (!appState.onboarding) return;
  appState.onboarding = { ...appState.onboarding, wizardStep: Math.min(5, Math.max(1, Number(step) || 1)), pendingImport: null };
  renderApp();
}

// Next/Back — skip forward past any step that's already done (feature: don't make someone click
// through an import step for data that's already there). Only Next skips; Back always goes to the
// immediately previous step, since landing on a completed step to review it is reasonable, but
// skipping past one on the way back isn't.
function onboardingGoNext() {
  if (!appState.onboarding) return;
  let next = getWizardStep(appState.onboarding) + 1;
  while (next < 5 && isOnboardingStepComplete(next, appState.onboarding)) next += 1;
  setOnboardingStep(Math.min(5, next));
}

function onboardingGoBack() {
  if (!appState.onboarding) return;
  setOnboardingStep(Math.max(1, getWizardStep(appState.onboarding) - 1));
}

// Closing via X, clicking the backdrop, or "Skip for now" — none of these mean "done", just "not
// right now". They must NOT persist a dismissed flag: the whole point of this wizard is that it
// keeps coming back on every login while the workspace is still genuinely empty (see
// maybeOpenOnboardingWizard's zero-counts check), so a closed tab or a skipped session doesn't
// lose the nudge. Only finishOnboardingWizard (the actual "Finish" button on step 5) persists.
function closeOnboardingWizard() {
  appState.onboarding = null;
  renderApp();
}

// Brings the wizard back after it was minimized (not dismissed) — e.g. via "Resume Setup" after
// navigating away for "Add one manually instead". Refreshes counts/connection status so anything
// just added by hand is reflected immediately, on the same step it was left on.
async function reopenOnboardingWizard() {
  if (!appState.onboarding) return;
  appState.onboarding = { ...appState.onboarding, open: true };
  renderApp();
  const workspaceId = appState.workspace?.id;
  if (workspaceId) refreshOnboardingYocoStatus(workspaceId);
  await refreshOnboardingCounts();
}

async function finishOnboardingWizard() {
  const workspaceId = appState.workspace?.id;
  const lastStep = appState.onboarding?.wizardStep || 1;
  appState.onboarding = null;
  renderApp();
  if (!workspaceId) return;
  try {
    await saveOnboardingState(workspaceId, { dismissed: true, completedAt: new Date().toISOString(), lastStep: String(lastStep) });
  } catch {
    /* if this write fails, the wizard simply reopens on the next login — acceptable */
  }
}

async function onboardingSyncNow() {
  const workspaceId = appState.workspace?.id;
  if (!workspaceId || !appState.onboarding) return;
  appState.onboarding = { ...appState.onboarding, actionStatus: 'syncing', actionError: '' };
  renderApp();
  try {
    await syncYocoCatalogue(workspaceId, { resetWebhook: false });
    appState.onboarding = { ...appState.onboarding, actionStatus: '' };
    refreshOnboardingYocoStatus(workspaceId);
    await refreshOnboardingCounts();
  } catch (error) {
    appState.onboarding = { ...appState.onboarding, actionStatus: '', actionError: error.message || 'Catalogue sync failed.' };
  }
  renderApp();
}

function startOnboardingWizard() {
  if (!appState.onboarding) return;
  appState.onboarding = { ...appState.onboarding, welcome: false };
  renderApp();
}

// Yoco connect is a plain API call (no OAuth redirect — see connectYocoIntegration), so it can
// happen right here inline instead of sending the user to Settings > Integrations.
async function onboardingConnectYoco(apiKey) {
  const workspaceId = appState.workspace?.id;
  if (!workspaceId || !appState.onboarding) return;
  if (!apiKey) {
    appState.onboarding = { ...appState.onboarding, actionError: 'Enter your Yoco API key first.' };
    renderApp();
    return;
  }
  appState.onboarding = { ...appState.onboarding, actionStatus: 'connecting', actionError: '' };
  renderApp();
  try {
    const { connectYocoIntegration } = await import('./services/integrationService.js');
    await connectYocoIntegration(workspaceId, apiKey);
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '' } : null;
    refreshOnboardingYocoStatus(workspaceId);
    await refreshOnboardingCounts();
  } catch (error) {
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '', actionError: error.message || 'Could not connect Yoco.' } : null;
  }
  renderApp();
}

// "Add one manually instead" for Suppliers/Stock Items used to navigate to the real screen and
// open its full editor. Only `name` is required by upsertSupplier/upsertStockItem — everything
// else on the real editors is optional/defaulted — so a small inline quick-add form here, calling
// the same service functions those editors use, covers onboarding without leaving the modal.
function onboardingToggleQuickAdd(kind) {
  if (!appState.onboarding) return;
  appState.onboarding = { ...appState.onboarding, quickAdd: { kind }, actionError: '' };
  renderApp();
}

function onboardingCancelQuickAdd() {
  if (!appState.onboarding) return;
  appState.onboarding = { ...appState.onboarding, quickAdd: null };
  renderApp();
}

async function onboardingSubmitQuickAddSupplier(fields) {
  const workspaceId = appState.workspace?.id;
  if (!workspaceId || !appState.onboarding) return;
  const name = String(fields.name || '').trim();
  if (!name) {
    appState.onboarding = { ...appState.onboarding, actionError: 'Enter a supplier name.' };
    renderApp();
    return;
  }
  appState.onboarding = { ...appState.onboarding, actionStatus: 'importing', actionError: '' };
  renderApp();
  try {
    const { upsertSupplier } = await import('./services/supplierService.js');
    await upsertSupplier(workspaceId, { name, contactPerson: fields.contactPerson || '', phone: fields.phone || '' });
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '', quickAdd: null } : null;
    await refreshOnboardingCounts();
    showOnboardingToast(`✅ "${name}" added.`, 'success');
  } catch (error) {
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '', actionError: error.message || 'Could not add supplier.' } : null;
  }
  renderApp();
}

async function onboardingSubmitQuickAddStock(fields) {
  const workspaceId = appState.workspace?.id;
  if (!workspaceId || !appState.onboarding) return;
  const name = String(fields.name || '').trim();
  if (!name) {
    appState.onboarding = { ...appState.onboarding, actionError: 'Enter a stock item name.' };
    renderApp();
    return;
  }
  appState.onboarding = { ...appState.onboarding, actionStatus: 'importing', actionError: '' };
  renderApp();
  try {
    const { upsertStockItem } = await import('./services/stockService.js');
    await upsertStockItem(workspaceId, { name, cost: fields.cost || 0 });
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '', quickAdd: null } : null;
    await refreshOnboardingCounts();
    showOnboardingToast(`✅ "${name}" added.`, 'success');
  } catch (error) {
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '', actionError: error.message || 'Could not add stock item.' } : null;
  }
  renderApp();
}

// "Build recipes one at a time in Recipes" used to navigate to the real Recipes screen and open
// its full recipe editor. This builds a recipe for an EXISTING product (already synced from
// Yoco, just missing a recipe) via updateRecipe — no new product is created — capped at a fixed
// 4 ingredient rows rather than reproducing the real editor's dynamic row table.
async function onboardingToggleRecipeBuilder() {
  if (!appState.onboarding) return;
  const workspaceId = appState.workspace?.id;
  if (!workspaceId) return;
  appState.onboarding = { ...appState.onboarding, recipeBuilder: { loading: true, products: [], stockItems: [] }, actionError: '' };
  renderApp();
  try {
    const { fetchRecipeItems } = await import('./services/recipeService.js');
    const { items, ingredients } = await fetchRecipeItems(workspaceId);
    const products = (items || [])
      .filter((item) => item.id && item.name && String(item.status || '').toLowerCase() === 'missing')
      .map((item) => ({ id: item.id, name: item.name }));
    const stockItems = (ingredients || [])
      .filter((ing) => ing.id && ing.name)
      .map((ing) => ({ id: ing.id, name: ing.name }));
    if (!appState.onboarding) return;
    appState.onboarding = { ...appState.onboarding, recipeBuilder: { loading: false, products, stockItems, itemsById: Object.fromEntries((items || []).map((item) => [item.id, item])) } };
  } catch (error) {
    if (!appState.onboarding) return;
    appState.onboarding = { ...appState.onboarding, recipeBuilder: null, actionError: error.message || 'Could not load products.' };
  }
  renderApp();
}

function onboardingCancelRecipeBuilder() {
  if (!appState.onboarding) return;
  appState.onboarding = { ...appState.onboarding, recipeBuilder: null };
  renderApp();
}

async function onboardingSubmitQuickRecipe({ productId, ingredients }) {
  const workspaceId = appState.workspace?.id;
  if (!workspaceId || !appState.onboarding?.recipeBuilder) return;
  const product = appState.onboarding.recipeBuilder.itemsById?.[productId];
  if (!product) {
    appState.onboarding = { ...appState.onboarding, actionError: 'Select a product first.' };
    renderApp();
    return;
  }
  if (!ingredients.length) {
    appState.onboarding = { ...appState.onboarding, actionError: 'Add at least one ingredient with a quantity.' };
    renderApp();
    return;
  }
  appState.onboarding = { ...appState.onboarding, actionStatus: 'savingRecipe', actionError: '' };
  renderApp();
  try {
    const { updateRecipe } = await import('./services/recipeService.js');
    const recipeLines = ingredients.map((row) => ({ stockItemId: row.stockItemId, qty: Number(row.qty) || 0 }));
    await updateRecipe(workspaceId, product, recipeLines);
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '', recipeBuilder: null } : null;
    await refreshOnboardingCounts();
    showOnboardingToast(`✅ Recipe saved for "${product.name}".`, 'success');
  } catch (error) {
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '', actionError: error.message || 'Could not save recipe.' } : null;
  }
  renderApp();
}

let onboardingToastTimer = null;
function showOnboardingToast(message, type = 'success') {
  if (!appState.onboarding) return;
  if (onboardingToastTimer) window.clearTimeout(onboardingToastTimer);
  appState.onboarding = { ...appState.onboarding, toast: { message, type } };
  renderApp();
  onboardingToastTimer = window.setTimeout(() => {
    onboardingToastTimer = null;
    if (!appState.onboarding?.toast || appState.onboarding.toast.message !== message) return;
    appState.onboarding = { ...appState.onboarding, toast: null };
    renderApp();
  }, 4200);
}

const ONBOARDING_IMPORT_NOUNS = { suppliers: 'supplier', stock: 'stock item', recipes: 'recipe' };

async function onboardingRunImport(importFn, { kind, count } = {}) {
  if (!appState.onboarding) return;
  appState.onboarding = { ...appState.onboarding, actionStatus: 'importing', actionError: '' };
  renderApp();
  try {
    await importFn();
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '' } : null;
    await refreshOnboardingCounts();
    const noun = ONBOARDING_IMPORT_NOUNS[kind] || 'item';
    const n = Number(count) || 0;
    showOnboardingToast(n > 0 ? `✅ ${n} ${noun}${n === 1 ? '' : 's'} imported.` : 'Import complete.', 'success');
  } catch (error) {
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '', actionError: error.message || 'Import failed.' } : null;
    renderApp();
  }
}

// Feature: preview before committing. A selected file is parsed and mapped/validated FIRST
// (reusing the exact same mapping functions the real import already calls internally — no
// duplicated validation logic), and shown as "N ready, M will be skipped" before anything is
// written. Only onboardingConfirmImportPreview actually calls the real import function.
let onboardingPendingImportFile = null;
// Set only when the current pendingImport preview came from an AI scan rather than a spreadsheet
// (see onboardingScanWithAi below) — holds the already-mapped rows ready to commit directly,
// since there's no file to re-parse the way onboardingConfirmImportPreview normally does.
let onboardingAiScannedRows = null;

const ONBOARDING_AI_MAX_FILE_BYTES = 8 * 1024 * 1024; // generous for a compressed phone photo

async function buildOnboardingImportPreview(kind, file) {
  if (kind === 'suppliers') {
    const rows = await parseDataFile(file, { preferredSheetNames: ['Supplier_Import'] });
    const { rows: mapped, review } = mapSupplierImportRows(rows);
    return {
      readyCount: mapped.length,
      skippedCount: Number(review.skippedCount || review.errors?.length || 0),
      errorSummary: formatImportErrors(review.errors || [], 5)
    };
  }
  if (kind === 'stock') {
    const rows = await parseDataFile(file, { preferredSheetNames: ['Stock_Import'] });
    const { items, review } = mapLegacyStockRows(rows);
    return {
      readyCount: items.length,
      skippedCount: Number(review.skippedCount || review.errors?.length || 0),
      errorSummary: formatImportErrors(review.errors || [], 5)
    };
  }
  const rows = await parseDataFile(file, { preferredSheetNames: ['Recipe_Import'] });
  const { recipes, review } = mapLegacyRecipeRows(rows);
  return {
    readyCount: recipes.length,
    skippedCount: Number(review.skippedCount || review.errors?.length || 0),
    errorSummary: formatImportErrors(review.errors || [], 5)
  };
}

async function onboardingPreviewImport(kind, file) {
  if (!appState.onboarding || !file) return;
  appState.onboarding = { ...appState.onboarding, actionStatus: 'importing', actionError: '', pendingImport: null };
  renderApp();
  try {
    const preview = await buildOnboardingImportPreview(kind, file);
    onboardingPendingImportFile = file;
    appState.onboarding = appState.onboarding
      ? { ...appState.onboarding, actionStatus: '', pendingImport: { kind, fileName: file.name, ...preview } }
      : null;
  } catch (error) {
    appState.onboarding = appState.onboarding
      ? { ...appState.onboarding, actionStatus: '', actionError: error.message || 'Could not read that file.' }
      : null;
  }
  renderApp();
}

// mapLegacyStockRows rejects a whole row if a UOM_1/UOM_2 pack tier has a name but no valid
// matching Qty_In_Base (or vice versa) — correct behavior for a human-filled template, since that
// combination can only mean a typo. But an AI extraction can legitimately be confident about a
// pack name while unsure of its quantity (or the model just didn't follow instructions), and in
// that case we still want the rest of the row (name, category, base UOM, other pack tier) — so
// drop any incomplete pack tier here rather than let it reject the whole item.
function sanitizeAiStockPackRows(rows) {
  return (rows || []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const clean = { ...row };
    [1, 2, 3].forEach((slot) => {
      const nameKey = `UOM_${slot}_Name`;
      const qtyKey = `UOM_${slot}_Qty_In_Base`;
      const name = String(clean[nameKey] ?? '').trim();
      const qty = Number(String(clean[qtyKey] ?? '').trim());
      if (!name || !Number.isFinite(qty) || qty <= 0) {
        delete clean[nameKey];
        delete clean[qtyKey];
      }
    });
    return clean;
  });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Gemini's free tier returns 429/503 under load, which the Worker route re-tags with an
// "AI_BUSY:" marker (see postWorkspaceAiExtract) rather than treating it as a real failure. This
// retries automatically with backoff, updating actionNote so the wizard shows "queued, retrying
// in Xs…" instead of the user seeing a raw server-busy error and having to manually try again.
const AI_BUSY_MARKER = 'AI_BUSY:';
const AI_BUSY_RETRY_DELAYS_MS = [4000, 8000, 15000, 25000];

async function extractDataWithAiRetrying(workspaceId, kind, file, options) {
  const { extractDataWithAi } = await import('./services/aiExtractionService.js');
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await extractDataWithAi(workspaceId, kind, file, options);
    } catch (error) {
      const isBusy = String(error?.message || '').includes(AI_BUSY_MARKER);
      if (!isBusy || attempt >= AI_BUSY_RETRY_DELAYS_MS.length) {
        if (isBusy) throw new Error('The AI service is still busy after several retries — please try again in a minute.');
        throw error;
      }
      const waitMs = AI_BUSY_RETRY_DELAYS_MS[attempt];
      if (appState.onboarding) {
        appState.onboarding = {
          ...appState.onboarding,
          actionNote: `AI is busy — queued, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 2} of ${AI_BUSY_RETRY_DELAYS_MS.length + 1})…`
        };
        renderApp();
      }
      await sleep(waitMs);
    }
  }
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const curr = [i];
    for (let j = 1; j <= n; j += 1) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

function normalizeMatchKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stringSimilarity(a, b) {
  const normA = normalizeMatchKey(a);
  const normB = normalizeMatchKey(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  return 1 - levenshteinDistance(normA, normB) / Math.max(normA.length, normB.length);
}

// Keeps an AI-guessed category from fragmenting an already-existing category list (e.g. landing a
// new "Dairy Products" next to an existing "Dairy") — snaps it to the closest existing category
// when they're clearly the same thing, otherwise leaves the AI's guess as a legitimate new one.
function reconcileCategory(rawCategory, existingCategories) {
  const normRaw = normalizeMatchKey(rawCategory);
  if (!normRaw || !existingCategories?.length) return rawCategory;
  let best = null;
  let bestScore = 0;
  existingCategories.forEach((existing) => {
    const normExisting = normalizeMatchKey(existing);
    if (!normExisting) return;
    if (normExisting === normRaw) { best = existing; bestScore = 1; return; }
    const substringMatch = normExisting.includes(normRaw) || normRaw.includes(normExisting);
    const score = substringMatch ? Math.max(stringSimilarity(rawCategory, existing), 0.85) : stringSimilarity(rawCategory, existing);
    if (score > bestScore) { bestScore = score; best = existing; }
  });
  return bestScore >= 0.84 ? best : rawCategory;
}

// Flags (never blocks) a row whose name closely matches something already in the workspace, so
// the HITL preview can surface "you might already have this" instead of silently letting a
// near-duplicate get created. Purely a preview-time annotation — stripped before the row is
// actually imported (see onboardingConfirmImportPreview).
function flagPossibleDuplicates(rows, existingNames, nameKey) {
  rows.forEach((row) => {
    const rowName = row[nameKey];
    if (!rowName) return;
    let bestMatch = null;
    let bestScore = 0;
    (existingNames || []).forEach((existingName) => {
      const score = stringSimilarity(rowName, existingName);
      if (score > bestScore) { bestScore = score; bestMatch = existingName; }
    });
    if (bestScore >= 0.86 && bestMatch) {
      row._dupWarning = `Possible duplicate of existing "${bestMatch}"`;
    }
  });
}

// Safety net for AI-scanned recipe rows: mapLegacyRecipeRows does a strict lookup of Product_Name
// against real menu items and rejects any row that doesn't match with an "Import the menu item
// first" error — correct for a human-typed template, but an AI extraction can go wrong in a way
// that repeats across every row (e.g. it grabs a generic page heading like "Ingredients List" as
// Product_Name for every ingredient line), which would otherwise surface as dozens of duplicate
// error lines instead of one clear one. This pre-filters against the real known-product list
// (rescuing near-matches — case/spacing/minor typos — the strict lookup would also have accepted)
// and reports anything left over as a single summarized skip reason.
function reconcileAiRecipeProductNames(rows, knownProductNames) {
  if (!knownProductNames?.length) return { rows, unmatchedCount: 0, unmatchedSample: [] };
  const knownByNorm = new Map(knownProductNames.map((n) => [normalizeMatchKey(n), n]));
  const kept = [];
  const unmatchedSample = [];
  let unmatchedCount = 0;
  rows.forEach((row) => {
    const rawName = String(row?.Product_Name || '').trim();
    let matched = knownByNorm.get(normalizeMatchKey(rawName));
    if (!matched && rawName) {
      let best = null;
      let bestScore = 0;
      knownProductNames.forEach((known) => {
        const score = stringSimilarity(rawName, known);
        if (score > bestScore) { bestScore = score; best = known; }
      });
      if (bestScore >= 0.88) matched = best;
    }
    if (matched) {
      kept.push({ ...row, Product_Name: matched });
    } else {
      unmatchedCount += 1;
      if (rawName && unmatchedSample.length < 5 && !unmatchedSample.includes(rawName)) unmatchedSample.push(rawName);
    }
  });
  return { rows: kept, unmatchedCount, unmatchedSample };
}

// AI-onboarding counterpart to onboardingPreviewImport — same "preview before committing"
// pattern, just with Gemini as the row source instead of a parsed spreadsheet. The Worker route
// (postWorkspaceAiExtract) already returns rows shaped like the bulk-import template columns, so
// they run through the exact same mapper functions a CSV import uses; only the already-mapped
// result is kept (onboardingAiScannedRows) since there's no file to re-parse on confirm.
async function onboardingScanWithAi(kind, file) {
  if (!appState.onboarding || !file) return;
  if (file.size > ONBOARDING_AI_MAX_FILE_BYTES) {
    appState.onboarding = { ...appState.onboarding, actionError: 'That photo is too large — please use one under 8MB.' };
    renderApp();
    return;
  }
  appState.onboarding = { ...appState.onboarding, actionStatus: 'scanningAi', actionError: '', actionNote: '', pendingImport: null };
  renderApp();
  try {
    const workspaceId = appState.workspace?.id;
    let knownProductNames = [];
    let recipeIngredients = appState.recipes?.ingredients || [];
    if (kind === 'recipes') {
      const { fetchRecipeItems } = await import('./services/recipeService.js');
      const { items, ingredients } = await fetchRecipeItems(workspaceId);
      knownProductNames = (items || [])
        .filter((item) => item.name && String(item.status || '').toLowerCase() === 'missing')
        .map((item) => item.name);
      recipeIngredients = ingredients || recipeIngredients;
    }

    const { rows } = await extractDataWithAiRetrying(workspaceId, kind, file, { knownProductNames });

    let preview;
    let data;
    let previewRows;
    if (kind === 'suppliers') {
      const { rows: mapped, review } = mapSupplierImportRows(rows);
      data = mapped;
      previewRows = mapped;
      preview = { readyCount: mapped.length, skippedCount: Number(review.skippedCount || review.errors?.length || 0), errorSummary: formatImportErrors(review.errors || [], 5) };
      try {
        const { fetchSuppliers } = await import('./services/supplierService.js');
        const { items: existingSuppliers } = await fetchSuppliers(workspaceId);
        const existingCategories = [...new Set((existingSuppliers || []).map((s) => s.category).filter(Boolean))];
        const existingNames = (existingSuppliers || []).map((s) => s.name).filter(Boolean);
        mapped.forEach((row) => { row.Category = reconcileCategory(row.Category, existingCategories); });
        flagPossibleDuplicates(mapped, existingNames, 'Name');
      } catch {
        /* category/duplicate reconciliation is a nice-to-have; leave the AI's raw guesses on failure */
      }
    } else if (kind === 'stock') {
      const { items, review } = mapLegacyStockRows(sanitizeAiStockPackRows(rows));
      data = items;
      previewRows = items;
      preview = { readyCount: items.length, skippedCount: Number(review.skippedCount || review.errors?.length || 0), errorSummary: formatImportErrors(review.errors || [], 5) };
      try {
        const { fetchStock } = await import('./services/stockService.js');
        const { items: existingStock, categories: existingCategoryUsage } = await fetchStock(workspaceId);
        const existingCategories = (existingCategoryUsage || []).map((c) => c.name).filter(Boolean);
        const existingNames = (existingStock || []).map((s) => s.name).filter(Boolean);
        items.forEach((row) => { row.category = reconcileCategory(row.category, existingCategories); });
        flagPossibleDuplicates(items, existingNames, 'name');
      } catch {
        /* category/duplicate reconciliation is a nice-to-have; leave the AI's raw guesses on failure */
      }
    } else {
      const { rows: matchedRows, unmatchedCount, unmatchedSample } = reconcileAiRecipeProductNames(rows, knownProductNames);
      const { recipes, review } = mapLegacyRecipeRows(matchedRows);
      data = recipes;
      const ingredientById = new Map((recipeIngredients || []).map((ing) => [String(ing.id || '').trim(), ing]));
      previewRows = recipes.map((recipe) => ({
        ...recipe,
        ingredientsText: (recipe.recipe || [])
          .map((line) => `${line.qty} ${line.unit} ${ingredientById.get(String(line.ingId))?.name || line.ingId}`)
          .join(', ')
      }));
      const unmatchedSummary = unmatchedCount
        ? `${unmatchedCount} row${unmatchedCount === 1 ? '' : 's'} skipped — could not confidently match a known menu item${unmatchedSample.length ? ` (e.g. "${unmatchedSample.join('", "')}")` : ''}. Try a clearer photo of the product name, or add the recipe manually.`
        : '';
      preview = {
        readyCount: recipes.length,
        skippedCount: Number(review.skippedCount || review.errors?.length || 0) + unmatchedCount,
        errorSummary: [unmatchedSummary, formatImportErrors(review.errors || [], 5)].filter(Boolean).join(' ')
      };
    }

    onboardingAiScannedRows = { kind, data };
    appState.onboarding = appState.onboarding
      ? { ...appState.onboarding, actionStatus: '', actionNote: '', pendingImport: { kind, source: 'ai', fileName: `AI Scan (${file.name})`, rows: previewRows, ...preview } }
      : null;
  } catch (error) {
    appState.onboarding = appState.onboarding
      ? { ...appState.onboarding, actionStatus: '', actionNote: '', actionError: error.message || 'Could not scan that photo.' }
      : null;
  }
  renderApp();
}

// Writes DOM-collected preview-table edits (see readPreviewFieldEdits in OnboardingWizard.js)
// back onto both the displayed rows and the actual data that will be imported. For
// suppliers/stock these are literally the same array (onboardingScanWithAi sets pendingImport.rows
// to the exact same array as onboardingAiScannedRows.data), so this is belt-and-braces rather
// than strictly required — but written generically so it stays correct if that ever changes.
function applyPreviewFieldEdits(fieldUpdates) {
  const rows = appState.onboarding?.pendingImport?.rows;
  const data = onboardingAiScannedRows?.data;
  (fieldUpdates || []).forEach(({ index, key, value }) => {
    if (!key || !Number.isInteger(index)) return;
    if (rows?.[index]) rows[index][key] = value;
    if (data?.[index] && data[index] !== rows[index]) data[index][key] = value;
  });
}

function onboardingEditPreviewRow(index, fieldUpdates) {
  if (!appState.onboarding?.pendingImport) return;
  applyPreviewFieldEdits(fieldUpdates);
  appState.onboarding = { ...appState.onboarding, pendingImport: { ...appState.onboarding.pendingImport, editingIndex: index >= 0 ? index : null } };
  renderApp();
}

function onboardingSavePreviewRow(index, fieldUpdates) {
  if (!appState.onboarding?.pendingImport) return;
  applyPreviewFieldEdits(fieldUpdates);
  appState.onboarding = { ...appState.onboarding, pendingImport: { ...appState.onboarding.pendingImport, editingIndex: null } };
  renderApp();
}

function onboardingDeletePreviewRow(index, fieldUpdates) {
  const pending = appState.onboarding?.pendingImport;
  if (!pending || !Number.isInteger(index)) return;
  applyPreviewFieldEdits(fieldUpdates);
  const rows = (pending.rows || []).filter((_, i) => i !== index);
  if (onboardingAiScannedRows) onboardingAiScannedRows.data = (onboardingAiScannedRows.data || []).filter((_, i) => i !== index);
  appState.onboarding = {
    ...appState.onboarding,
    pendingImport: { ...pending, rows, readyCount: rows.length, editingIndex: null }
  };
  renderApp();
}

function onboardingCancelImportPreview() {
  onboardingPendingImportFile = null;
  onboardingAiScannedRows = null;
  if (!appState.onboarding) return;
  appState.onboarding = { ...appState.onboarding, pendingImport: null };
  renderApp();
}

async function onboardingConfirmImportPreview(fieldUpdates) {
  const pending = appState.onboarding?.pendingImport;
  if (!pending || !appState.onboarding) return;
  applyPreviewFieldEdits(fieldUpdates);

  if (pending.source === 'ai') {
    const scanned = onboardingAiScannedRows;
    onboardingAiScannedRows = null;
    if (!scanned) return;
    appState.onboarding = { ...appState.onboarding, pendingImport: null };
    const workspaceId = appState.workspace?.id;
    // _dupWarning is a preview-only annotation (see flagPossibleDuplicates) — never send it through
    // to the real import payload.
    const cleanData = (scanned.data || []).map(({ _dupWarning, ...rest }) => rest);
    await onboardingRunImport(async () => {
      if (scanned.kind === 'suppliers') {
        const { importSuppliers } = await import('./services/supplierService.js');
        await importSuppliers(workspaceId, cleanData);
      } else if (scanned.kind === 'stock') {
        const { importStockItems } = await import('./services/stockService.js');
        await importStockItems(workspaceId, cleanData);
      } else {
        const { importRecipes } = await import('./services/recipeService.js');
        await importRecipes(workspaceId, cleanData);
      }
    }, { kind: scanned.kind, count: pending.readyCount });
    return;
  }

  const file = onboardingPendingImportFile;
  onboardingPendingImportFile = null;
  if (!file) return;
  appState.onboarding = { ...appState.onboarding, pendingImport: null };
  const importFn = pending.kind === 'suppliers' ? importSupplierFile
    : pending.kind === 'stock' ? importStockFile
    : importRecipeFile;
  await onboardingRunImport(() => importFn(file), { kind: pending.kind, count: pending.readyCount });
}

async function onboardingDownloadRecipeTemplate() {
  const workspaceId = appState.workspace?.id;
  if (!workspaceId || !appState.onboarding) return;
  appState.onboarding = { ...appState.onboarding, actionStatus: 'exporting', actionError: '' };
  renderApp();
  try {
    const { fetchRecipeItems } = await import('./services/recipeService.js');
    const { items, ingredients } = await fetchRecipeItems(workspaceId);
    const { products, prefillProducts, ingredientObjects } = buildRecipeTemplateExportOptions(items, ingredients);
    const filename = buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Recipe Template Export' });
    await downloadStyledRecipeTemplateXlsx(filename, { products, ingredientObjects, platform: 'excel', prefillProducts });
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '' } : null;
    showRecipeToast(
      `Recipe template exported${prefillProducts.length ? ` — pre-filled with ${prefillProducts.length} product${prefillProducts.length === 1 ? '' : 's'} missing a recipe` : ''}.`,
      'success'
    );
  } catch (error) {
    appState.onboarding = appState.onboarding ? { ...appState.onboarding, actionStatus: '', actionError: error.message || 'Could not export recipe template.' } : null;
  }
  renderApp();
}

const onOnboardingAction = {
  onStepChange: setOnboardingStep,
  onGoNext: onboardingGoNext,
  onGoBack: onboardingGoBack,
  onResume: reopenOnboardingWizard,
  onDismiss: closeOnboardingWizard,
  onFinish: finishOnboardingWizard,
  onStartWizard: startOnboardingWizard,
  onSyncNow: onboardingSyncNow,
  onConnectYoco: onboardingConnectYoco,
  onDownloadRecipeTemplate: onboardingDownloadRecipeTemplate,
  onDownloadSupplierTemplate: () => exportSupplierTemplate('xlsx'),
  onDownloadStockTemplate: () => exportStockTemplate('xlsx'),
  onToggleQuickAdd: onboardingToggleQuickAdd,
  onCancelQuickAdd: onboardingCancelQuickAdd,
  onSubmitQuickAddSupplier: onboardingSubmitQuickAddSupplier,
  onSubmitQuickAddStock: onboardingSubmitQuickAddStock,
  onToggleRecipeBuilder: onboardingToggleRecipeBuilder,
  onCancelRecipeBuilder: onboardingCancelRecipeBuilder,
  onSubmitQuickRecipe: onboardingSubmitQuickRecipe,
  onImportSuppliers: (file) => onboardingPreviewImport('suppliers', file),
  onImportStock: (file) => onboardingPreviewImport('stock', file),
  onImportRecipes: (file) => onboardingPreviewImport('recipes', file),
  onScanSuppliersWithAi: (file) => onboardingScanWithAi('suppliers', file),
  onScanStockWithAi: (file) => onboardingScanWithAi('stock', file),
  onScanRecipesWithAi: (file) => onboardingScanWithAi('recipes', file),
  onCancelImportPreview: onboardingCancelImportPreview,
  onConfirmImportPreview: onboardingConfirmImportPreview,
  onEditPreviewRow: onboardingEditPreviewRow,
  onSavePreviewRow: onboardingSavePreviewRow,
  onDeletePreviewRow: onboardingDeletePreviewRow
};

async function relaunchOnboardingWizard() {
  const workspaceId = appState.workspace?.id;
  if (!workspaceId) return;
  appState.onboarding = {
    open: true, welcome: true, wizardStep: 1, actionStatus: '', actionError: '',
    counts: null, yoco: null, pendingImport: null, quickAdd: null, recipeBuilder: null,
    aiOnboardingEnabled: appState.settings?.values?.ai_onboarding_enabled === true
  };
  renderApp();
  const [yoco, counts] = await Promise.all([
    fetchYocoStatusOnce(workspaceId),
    getOnboardingReadiness(workspaceId).catch(() => null)
  ]);
  if (!appState.onboarding || appState.workspace?.id !== workspaceId) return;
  // Skip straight to the first incomplete step here too, same as the auto-open path.
  appState.onboarding = { ...appState.onboarding, yoco, counts, wizardStep: firstIncompleteOnboardingStep({ counts, yoco }) };
  renderApp();
}

function mountOnboardingWizard() {
  // Mounted on document.body, a SIBLING of #app — never inside it. replaceApp() does
  // `app.replaceChildren(...)` on every single render, which would destroy this container (and
  // any "reuse the existing shell" logic below) every time if it lived inside #app, since it'd
  // already be gone by the time this function runs. That's what was actually still causing the
  // modal to flicker closed-then-open after the first fix attempt: the shell/content-patch split
  // never got a chance to run because there was never an "existing" node to find.
  const existingModal = document.body.querySelector('[data-onboarding-wizard-mount]');
  const existingResume = document.body.querySelector('[data-onboarding-resume-mount]');

  if (!appState.onboarding) {
    existingModal?.remove();
    existingResume?.remove();
    return;
  }

  if (!appState.onboarding.open) {
    // Minimized (e.g. "Add one manually instead" navigated away) rather than dismissed — show a
    // way back instead of just vanishing, since the whole point is to stay reachable until the
    // workspace is actually set up.
    existingModal?.remove();
    if (!existingResume) {
      const resumeButton = document.createElement('div');
      resumeButton.dataset.onboardingResumeMount = 'true';
      resumeButton.innerHTML = renderOnboardingResumeButton();
      bindOnboardingResumeButtonEvents(resumeButton.firstElementChild, onOnboardingAction);
      document.body.appendChild(resumeButton);
    }
    return;
  }

  existingResume?.remove();

  if (existingModal) {
    updateOnboardingWizardContent(existingModal, appState.onboarding, onOnboardingAction);
    return;
  }

  const container = document.createElement('div');
  container.dataset.onboardingWizardMount = 'true';
  container.innerHTML = renderOnboardingWizardShell();
  bindOnboardingWizardShellEvents(container, onOnboardingAction);
  updateOnboardingWizardContent(container, appState.onboarding, onOnboardingAction);
  document.body.appendChild(container);
}

function startIntegrationAutoSync() {
  // NOTE: this client-side timer is now a convenience/fast-path only, for whoever currently has
  // the app open — it is no longer the sole mechanism for menu/catalogue sync. The cron path
  // (`*/45 * * * *` in wrangler.toml, dispatched to `admin-action/catalogue-sync-due`) is
  // currently disabled account-wide; `requestCatalogueSyncIfDue` (called from `selectWorkspace` on
  // every login/workspace-open) is the real guarantee today that the catalogue doesn't go stale
  // for longer than one login cycle.
  const runSync = async () => {
    if (!appState.user || !appState.workspace) return;
    if (isUserBusy()) return;
    const workspaceId = appState.workspace?.id;
    if (!workspaceId) return;
    try {
      await Promise.all([
        syncYocoSales(workspaceId, { resetWebhook: false }),
        syncYocoCatalogue(workspaceId, { resetWebhook: false })
      ]);
      // Background integration work must never remount the user's active screen. The user can
      // explicitly refresh the current module when they are ready to consume newly synced data.
    } catch { /* silent */ }
  };

  const startTimer = () => {
    if (integrationAutoSyncTimer) window.clearInterval(integrationAutoSyncTimer);
    // Background sync is intentionally infrequent and silent. It must not repaint the current
    // module or create a delayed four-second refresh after every workspace bootstrap.
    integrationAutoSyncTimer = window.setInterval(runSync, 900000);
  };

  const stopTimer = () => {
    if (integrationAutoSyncTimer) { window.clearInterval(integrationAutoSyncTimer); integrationAutoSyncTimer = null; }
  };

  const isActive = () => document.visibilityState === 'visible' && document.hasFocus();

  // Clean up any previous listeners
  if (_integrationVisibilityHandler) {
    document.removeEventListener('visibilitychange', _integrationVisibilityHandler.visibility);
    window.removeEventListener('focus', _integrationVisibilityHandler.focus);
    window.removeEventListener('blur', _integrationVisibilityHandler.blur);
  }

  const onActive = () => { if (isActive()) startTimer(); };
  const onInactive = () => stopTimer();

  _integrationVisibilityHandler = { visibility: onActive, focus: onActive, blur: onInactive };
  document.addEventListener('visibilitychange', onActive);
  window.addEventListener('focus', onActive);
  window.addEventListener('blur', onInactive);

  // Only start the silent 15-minute timer when the tab is already in focus. Do not run a
  // delayed startup sync because its completion used to remount the page a few seconds after login.
  if (isActive()) startTimer();
}

function stopIntegrationAutoSync() {
  if (integrationAutoSyncTimer) { window.clearInterval(integrationAutoSyncTimer); integrationAutoSyncTimer = null; }
  if (catalogueAutoSyncTimer) { window.clearInterval(catalogueAutoSyncTimer); catalogueAutoSyncTimer = null; }
  if (_integrationVisibilityHandler) {
    document.removeEventListener('visibilitychange', _integrationVisibilityHandler.visibility);
    window.removeEventListener('focus', _integrationVisibilityHandler.focus);
    window.removeEventListener('blur', _integrationVisibilityHandler.blur);
    _integrationVisibilityHandler = null;
  }
}

function startSystemBroadcastRefresh() {
  if (systemBroadcastRefreshTimer) window.clearInterval(systemBroadcastRefreshTimer);
  // The initial broadcast request is also silent. Permission, route, or settings hydration will
  // naturally display it on the next normal render without an unrelated full-page remount.
  loadSystemBroadcast({ render: false });
  systemBroadcastRefreshTimer = window.setInterval(() => {
    // Store the latest broadcast silently. The next normal render can display it without
    // replacing the active module while the user is working.
    if (appState.user && appState.workspace) loadSystemBroadcast({ render: false });
  }, 900000);
}

function stopSystemBroadcastRefresh() {
  if (systemBroadcastRefreshTimer) window.clearInterval(systemBroadcastRefreshTimer);
  systemBroadcastRefreshTimer = null;
  appState.systemBroadcast = null;
}

// Cross-user change detection: poll a tiny "data-version" signal without remounting the active
// screen. A changed version emits a passive event; users consume fresh data through explicit
// Refresh actions or normal navigation, so forms, drawers, filters, and scroll never reset.
const DATA_VERSION_POLL_INTERVAL_MS = 120000; // 2 min on normal modules
const STOCK_DATA_VERSION_POLL_INTERVAL_MS = 15000; // near-live stock-tab refresh for POS/Yoco webhooks
let stockLiveRefreshInstalled = false;

// When the data-version poll detects a change (a Yoco/POS webhook bumped stock_movements), silently
// re-fetch stock while the Stock Items tab is open. Uses applyRealtimeSnapshot so the update is
// deferred while the user is editing and never remounts the page (no "refresh" flicker).
async function refreshStockFromDataVersion(workspaceId) {
  if (appState.route.active !== 'ingredients') return;
  if (!workspaceId || appState.workspace?.id !== workspaceId) return;
  const requestToken = stockMutationToken;
  try {
    clearApiCache();
    const { fetchStock } = await import('./services/stockService.js');
    const stock = await fetchStock(workspaceId);
    if (appState.route.active !== 'ingredients' || appState.workspace?.id !== workspaceId) return;
    // A delete/save that started AFTER this fetch began bumps the token. If that
    // happened, this response is stale (it was captured before that mutation) and
    // must be dropped instead of overwriting the now-correct local state.
    if (requestToken !== stockMutationToken) return;
    applyRealtimeSnapshot('stock', () => {
      appState.stock = {
        ...appState.stock,
        status: 'ready',
        items: stock.items || appState.stock.items || [],
        locations: stock.locations || appState.stock.locations || [],
        categories: stock.categories || appState.stock.categories || [],
        uoms: stock.uoms || appState.stock.uoms || [],
        updatedAt: stock.updatedAt || new Date().toISOString(),
        error: ''
      };
    });
  } catch { /* silent — a failed live refresh must never disrupt the app */ }
}

function installStockLiveRefresh() {
  if (stockLiveRefreshInstalled) return;
  stockLiveRefreshInstalled = true;
  window.addEventListener('kcp:data-version-changed', (event) => {
    refreshStockFromDataVersion(event?.detail?.workspaceId || appState.workspace?.id);
  });
}

function startDataVersionPoll() {
  installStockLiveRefresh();
  // Re-establish the baseline on (re)start so a workspace switch doesn't fire a spurious refetch.
  lastSeenDataVersion = null;
  const pollOnce = async () => {
    if (!appState.user || !appState.workspace) return;
    if (document.visibilityState !== 'visible') return;
    const workspaceId = appState.workspace?.id;
    if (!workspaceId) return;
    try {
      const response = await callCloudflareWorkspaceRoute(workspaceId, 'data-version', { query: { t: Date.now() } });
      dataVersionPollFailures = 0;
      const version = String(response?.version ?? '');
      // First observation establishes the baseline without refetching.
      if (lastSeenDataVersion === null) {
        lastSeenDataVersion = version;
        return;
      }
      if (version && version !== lastSeenDataVersion) {
        lastSeenDataVersion = version;
        // Record the change without remounting the active module. Automatic DOM replacement here
        // caused the recurring 'page refresh' effect and could close drawers or reset filters.
        window.dispatchEvent(new CustomEvent('kcp:data-version-changed', {
          detail: { workspaceId, version }
        }));
      }
    } catch {
      // Back off on repeated failures rather than retrying at full cadence indefinitely — see
      // currentPollInterval() below.
      dataVersionPollFailures = Math.min(dataVersionPollFailures + 1, 8);
    }
  };

  const currentPollInterval = () => {
    const base = appState.route.active === 'ingredients'
      ? STOCK_DATA_VERSION_POLL_INTERVAL_MS
      : DATA_VERSION_POLL_INTERVAL_MS;
    if (!dataVersionPollFailures) return base;
    // Exponential backoff, capped at 5 minutes: 1 failure -> 2x, 2 -> 4x, ... so a struggling
    // backend gets breathing room instead of being retried every 15 seconds from every open tab.
    return Math.min(base * (2 ** dataVersionPollFailures), 5 * 60 * 1000);
  };
  const startTimer = () => {
    if (dataVersionPollTimer) window.clearTimeout(dataVersionPollTimer);
    const scheduleNext = () => {
      if (dataVersionPollTimer) window.clearTimeout(dataVersionPollTimer);
      dataVersionPollTimer = window.setTimeout(async () => {
        dataVersionPollTimer = null;
        await pollOnce();
        if (document.visibilityState === 'visible') scheduleNext();
      }, currentPollInterval());
    };
    pollOnce().catch(() => {});
    scheduleNext();
  };
  const stopTimer = () => {
    if (dataVersionPollTimer) { window.clearTimeout(dataVersionPollTimer); dataVersionPollTimer = null; }
  };

  if (dataVersionPollVisibilityHandler) {
    document.removeEventListener('visibilitychange', dataVersionPollVisibilityHandler);
  }
  dataVersionPollVisibilityHandler = () => {
    if (document.visibilityState === 'visible') { startTimer(); } else { stopTimer(); }
  };
  document.addEventListener('visibilitychange', dataVersionPollVisibilityHandler);

  if (document.visibilityState === 'visible') startTimer();
}

function stopDataVersionPoll() {
  if (dataVersionPollTimer) { window.clearTimeout(dataVersionPollTimer); dataVersionPollTimer = null; }
  if (dataVersionPollVisibilityHandler) {
    document.removeEventListener('visibilitychange', dataVersionPollVisibilityHandler);
    dataVersionPollVisibilityHandler = null;
  }
  lastSeenDataVersion = null;
}

async function signOutAndStop() {
  stopSystemBroadcastRefresh();
  stopIntegrationAutoSync();
  stopDataVersionPoll();
  unmountChatWidget();
  await secureSignOut();
}

function getAutoLoginStorageKey(user = appState.user) {
  const userKey = String(user?.uid || user?.email || 'anonymous').trim() || 'anonymous';
  return `${AUTO_LOGIN_STORAGE_PREFIX}:${userKey}`;
}

function readAutoLoginPreference(user = appState.user) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(getAutoLoginStorageKey(user));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.enabled || !parsed.workspaceId) return null;
    return {
      enabled: true,
      workspaceId: String(parsed.workspaceId),
      workspaceName: String(parsed.workspaceName || ''),
      updatedAt: parsed.updatedAt || ''
    };
  } catch (error) {
    console.warn('[Auth] Auto login preference could not be read:', error);
    return null;
  }
}

function saveAutoLoginPreference(workspace, user = appState.user) {
  if (typeof localStorage === 'undefined' || !workspace?.id) return null;
  const preference = {
    enabled: true,
    workspaceId: String(workspace.id),
    workspaceName: String(workspace.siteName || workspace.id || ''),
    updatedAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(getAutoLoginStorageKey(user), JSON.stringify(preference));
    appState.autoLoginPreference = preference;
    return preference;
  } catch (error) {
    console.warn('[Auth] Auto login preference could not be saved:', error);
    return null;
  }
}

function clearAutoLoginPreference(user = appState.user) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(getAutoLoginStorageKey(user));
  } catch (error) {
    console.warn('[Auth] Auto login preference could not be cleared:', error);
  }
  appState.autoLoginPreference = null;
}

function getAutoLoginWorkspace(workspaceOptions = [], user = appState.user) {
  const preference = readAutoLoginPreference(user);
  appState.autoLoginPreference = preference;
  if (!preference?.enabled || !preference.workspaceId) return null;
  const workspace = (workspaceOptions || []).find((option) => String(option.id) === String(preference.workspaceId));
  if (!workspace) {
    clearAutoLoginPreference(user);
    return null;
  }
  return workspace;
}

function syncAutoLoginPreferenceForWorkspace(workspace, options = {}) {
  if (options.autoLoginPreference === true) {
    saveAutoLoginPreference(workspace);
    return;
  }

  if (options.autoLoginPreference === false) {
    clearAutoLoginPreference();
    return;
  }

  if (appState.autoLoginPreference?.enabled) {
    saveAutoLoginPreference(workspace);
  }
}

function toggleAutoLoginPreference(enabled) {
  if (!appState.workspace?.id) return;
  if (enabled) {
    saveAutoLoginPreference(appState.workspace);
  } else {
    clearAutoLoginPreference();
  }
  renderApp();
}

async function selectWorkspace(workspace, options = {}) {
  cleanupMenuSubscription();
  cleanupRecipeSubscription();
  cleanupStockSubscription();
  cleanupSupplierSubscription();
  cleanupPurchaseOrderSubscription();
  cleanupGrvSubscription();
  cleanupCreditNoteSubscription();
  cleanupAdjustmentSubscription();
  cleanupTransferSubscription();
  cleanupStockTakeSubscription();
  cleanupLocationSubscription();
  cleanupManufacturingSubscription();

  cleanupAccessSubscription();
  syncAutoLoginPreferenceForWorkspace(workspace, options);
  // A workspace switch mid-session must close any onboarding wizard opened for the PREVIOUS
  // workspace — otherwise it keeps showing stale counts/Yoco status and its actions (import,
  // sync) would run against the wrong workspace's data. maybeOpenOnboardingWizard re-decides
  // fresh for the new workspace once its settings load below.
  appState.onboarding = null;
  appState.workspace = { ...workspace };
  appState.workspaceError = '';
  appState.access = createAccessState('loading');
  appState.source = null;
  appState.menu = createMenuState(appState.route.active === 'products' ? 'loading' : 'idle', appState.menu.filters);
  appState.recipes = createRecipeState(appState.route.active === 'recipes' ? 'loading' : 'idle', appState.recipes.filters);
  appState.stock = createStockState(appState.route.active === 'ingredients' ? 'loading' : 'idle', appState.stock.filters);
  appState.suppliers = createSupplierState(appState.route.active === 'suppliers' ? 'loading' : 'idle', appState.suppliers.filters);
  appState.purchaseOrders = createPurchaseOrderState(appState.route.active === 'purchase-orders' ? 'loading' : 'idle', appState.purchaseOrders.filters);
  appState.grv = createGrvState(appState.route.active === 'grv' ? 'loading' : 'idle', appState.grv.filters, appState.grv.pendingSourcePoId);
  appState.creditNotes = createCreditNoteState(appState.route.active === 'credit-note' ? 'loading' : 'idle', appState.creditNotes.filters);
  appState.adjustments = createAdjustmentState(appState.route.active === 'adjustments' ? 'loading' : 'idle', appState.adjustments.filters);
  appState.transfers = createTransferState(appState.route.active === 'transfers' ? 'loading' : 'idle', appState.transfers.filters);
  appState.stockTake = createStockTakeState(appState.route.active === 'stock-count' ? 'loading' : 'idle', appState.stockTake.filters, appState.stockTake.sessionActive);
  appState.locations = createLocationState(appState.route.active === 'locations' ? 'loading' : 'idle', appState.locations.filters);
  appState.manufacturing = createManufacturingState(appState.route.active === 'mfg-products' ? 'loading' : 'idle', appState.manufacturing.filters);
  appState.userManagement = createUserManagementState(appState.route.active === 'user-management' ? 'loading' : 'idle', appState.userManagement.filters);
  appState.roleManagement = createRoleManagementState(appState.route.active === 'custom-roles' ? 'loading' : 'idle');
  appState.settings = createSettingsState(isSettingsRoute(appState.route.active) ? 'loading' : 'idle', appState.settings?.draft);
  appState.auth = { status: 'ready', error: '' };
  renderApp();
  // Chat widget mounted later, after workspace settings load (chat_enabled must be true)
  startSystemBroadcastRefresh();
  startIntegrationAutoSync();
  requestCatalogueSyncIfDue(workspace.id);
  startDataVersionPoll();
  startAccessSubscription(workspace.id);
  bootstrapActiveRouteForWorkspace(workspace.id);

  try {
    const settings = normalizeSettings(await getWorkspaceSettings(workspace.id));
    applyWorkspaceSettingsEffects(settings);
    appState.settings = {
      ...appState.settings,
      status: isSettingsRoute(appState.route.active) ? 'ready' : appState.settings.status,
      values: settings,
      draft: settings,
      error: ''
    };
    if (settings?.chat_enabled === true) {
      try { mountChatWidget(workspace.id); } catch (e) { console.warn('[Chat] Widget failed to mount:', e); }
    }
    if (settings?.siteName) {
      appState.workspace = {
        ...appState.workspace,
        siteName: settings.siteName
      };
      appState.workspaceOptions = appState.workspaceOptions.map((option) => (
        option.id === workspace.id ? { ...option, siteName: settings.siteName } : option
      ));
      renderApp();
    }
    maybeOpenOnboardingWizard(workspace.id, settings);
  } catch (error) {
    console.warn('[Workspace] Settings prefetch failed:', error);
  }
}

function navigateTo(sectionId) {
  if (String(sectionId || '').trim() === 'low-stock-alerts') {
    openLowStockAlerts();
    return;
  }

  const nextSection = resolveAccessibleRoute(sectionId || 'dashboard');

  if (nextSection === 'reporting') {
    clearReportingNavigationParameters();
  } else {
    // clearReportingNavigationParameters() stamps `?route=reporting` into the URL on every visit
    // to Reporting, but nothing ever removed it again on navigating elsewhere — so once a user
    // visited Reporting even once, the URL stayed pinned to `?route=reporting` forever, and
    // getInitialRoute() (URL always wins over the persisted localStorage route) forced every
    // later page refresh straight back to Reporting regardless of what the user was actually on.
    clearStaleReportingRouteParam();
  }
  if (appState.route.active === nextSection) {
    if (nextSection === 'reporting') renderApp();
    return;
  }

  appState.route = { active: nextSection };
  persistRoute(nextSection);

  if (nextSection === 'dashboard') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    renderApp();
    return;
  }

  if (nextSection === 'products') {
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.menu = createMenuState('loading', appState.menu.filters);
    renderApp();
    startMenuSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'recipes') {
    cleanupMenuSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.recipes = {
      ...createRecipeState('loading', appState.recipes.filters),
      pendingOpenItemId: appState.recipes.pendingOpenItemId || '',
      pendingOpenItemName: appState.recipes.pendingOpenItemName || '',
      pendingFocus: appState.recipes.pendingFocus || null
    };
    renderApp();
    startRecipeSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'ingredients') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.stock = createStockState('loading', appState.stock.filters);
    renderApp();
    startStockSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'suppliers') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.suppliers = createSupplierState('loading', appState.suppliers.filters);
    renderApp();
    startSupplierSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'purchase-orders') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.purchaseOrders = createPurchaseOrderState('loading', appState.purchaseOrders.filters);
    renderApp();
    startPurchaseOrderSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'grv') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.grv = createGrvState('loading', appState.grv.filters, appState.grv.pendingSourcePoId);
    renderApp();
    startGrvSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'credit-note') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.creditNotes = createCreditNoteState('loading', appState.creditNotes.filters);
    renderApp();
    startCreditNoteSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'adjustments') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.adjustments = createAdjustmentState('loading', appState.adjustments.filters);
    renderApp();
    startAdjustmentSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'transfers') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.transfers = createTransferState('loading', appState.transfers.filters);
    renderApp();
    startTransferSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'stock-count') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.stockTake = createStockTakeState('loading', appState.stockTake.filters, appState.stockTake.sessionActive);
    renderApp();
    startStockTakeSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'locations') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupManufacturingSubscription();
    appState.locations = createLocationState('loading', appState.locations.filters);
    renderApp();
    startLocationSubscription(appState.workspace?.id);
    return;
  }

  if (nextSection === 'mfg-products') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    appState.manufacturing = createManufacturingState('loading', appState.manufacturing.filters);
    renderApp();
    startManufacturingSubscription(appState.workspace?.id);
    return;
  }



  if (nextSection === 'user-management') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.userManagement = createUserManagementState('ready', appState.userManagement.filters);
    appState.roleManagement = createRoleManagementState('idle');
    renderApp();
    return;
  }

  if (nextSection === 'custom-roles') {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.userManagement = createUserManagementState('idle', appState.userManagement.filters);
    appState.roleManagement = createRoleManagementState('ready');
    renderApp();
    return;
  }

  if (isSettingsRoute(nextSection)) {
    cleanupMenuSubscription();
    cleanupRecipeSubscription();
    cleanupStockSubscription();
    cleanupSupplierSubscription();
    cleanupPurchaseOrderSubscription();
    cleanupGrvSubscription();
    cleanupCreditNoteSubscription();
    cleanupAdjustmentSubscription();
    cleanupTransferSubscription();
    cleanupStockTakeSubscription();
    cleanupLocationSubscription();
    cleanupManufacturingSubscription();
    appState.settings = createSettingsState('loading', appState.settings?.draft || appState.settings?.values);
    renderApp();
    loadSettings(appState.workspace?.id);
    return;
  }

  cleanupMenuSubscription();
  cleanupRecipeSubscription();
  cleanupStockSubscription();
  cleanupSupplierSubscription();
  cleanupPurchaseOrderSubscription();
  cleanupGrvSubscription();
  cleanupCreditNoteSubscription();
  cleanupAdjustmentSubscription();
  cleanupTransferSubscription();
  cleanupStockTakeSubscription();
  cleanupLocationSubscription();
  cleanupManufacturingSubscription();

  appState.menu = createMenuState('idle', appState.menu.filters);
  appState.recipes = createRecipeState('idle', appState.recipes.filters);
  appState.stock = createStockState('idle', appState.stock.filters);
  appState.suppliers = createSupplierState('idle', appState.suppliers.filters);
  appState.purchaseOrders = createPurchaseOrderState('idle', appState.purchaseOrders.filters);
  appState.grv = createGrvState('idle', appState.grv.filters, appState.grv.pendingSourcePoId);
  appState.creditNotes = createCreditNoteState('idle', appState.creditNotes.filters);
  appState.adjustments = createAdjustmentState('idle', appState.adjustments.filters);
  appState.transfers = createTransferState('idle', appState.transfers.filters);
  appState.stockTake = createStockTakeState('idle', appState.stockTake.filters, appState.stockTake.sessionActive);
  appState.locations = createLocationState('idle', appState.locations.filters);
  appState.manufacturing = createManufacturingState('idle', appState.manufacturing.filters);
  appState.userManagement = createUserManagementState('idle', appState.userManagement.filters);
  appState.roleManagement = createRoleManagementState('idle');
  renderApp();
}

function resolveAccessibleRoute(sectionId = 'dashboard') {
  const normalized = normalizeRouteId(sectionId);
  const allowedSections = appState.access?.allowedSections || [];
  if (!allowedSections.length) return normalized;
  return allowedSections.includes(normalized) ? normalized : (allowedSections[0] || 'dashboard');
}

function normalizeRouteId(sectionId = 'dashboard') {
  const normalized = String(sectionId || 'dashboard').trim() || 'dashboard';
  return normalized === 'settings' ? 'settings-business' : normalized;
}

function isSettingsRoute(sectionId = '') {
  return SETTINGS_ROUTES.includes(String(sectionId || '').trim());
}

function bootstrapActiveRouteForWorkspace(workspaceId) {
  if (!workspaceId) return;
  const nextSection = resolveAccessibleRoute(appState.route.active || 'dashboard');
  if (nextSection !== appState.route.active) {
    navigateTo(nextSection);
    return;
  }

  if (nextSection === 'dashboard') {
    renderApp();
    return;
  }
  if (nextSection === 'products') {
    startMenuSubscription(workspaceId);
    return;
  }
  if (nextSection === 'recipes') {
    startRecipeSubscription(workspaceId);
    return;
  }
  if (nextSection === 'ingredients') {
    startStockSubscription(workspaceId);
    return;
  }
  if (nextSection === 'suppliers') {
    startSupplierSubscription(workspaceId);
    return;
  }
  if (nextSection === 'purchase-orders') {
    startPurchaseOrderSubscription(workspaceId);
    return;
  }
  if (nextSection === 'grv') {
    startGrvSubscription(workspaceId);
    return;
  }
  if (nextSection === 'credit-note') {
    startCreditNoteSubscription(workspaceId);
    return;
  }
  if (nextSection === 'adjustments') {
    startAdjustmentSubscription(workspaceId);
    return;
  }
  if (nextSection === 'transfers') {
    startTransferSubscription(workspaceId);
    return;
  }
  if (nextSection === 'stock-count') {
    startStockTakeSubscription(workspaceId);
    return;
  }
  if (nextSection === 'locations') {
    startLocationSubscription(workspaceId);
    return;
  }
  if (nextSection === 'mfg-products') {
    startManufacturingSubscription(workspaceId);
    return;
  }

  if (isSettingsRoute(nextSection)) {
    loadSettings(workspaceId);
    return;
  }
  renderApp();
}

function forceRefreshActiveTab() {
  const workspaceId = appState.workspace?.id;
  if (!workspaceId) {
    renderApp();
    return;
  }
  if (appState.route.active === 'user-management' || appState.route.active === 'custom-roles') {
    startAccessSubscription(workspaceId);
    return;
  }
  bootstrapActiveRouteForWorkspace(workspaceId);
}

async function refreshActiveTabFromApi() {
  // Dashboard and Reporting own their internal filters and async report runs.
  // Background data-version/Yoco syncs must not replace or silently refresh them;
  // both surfaces expose explicit refresh controls.
  if (['dashboard', 'reporting', 'reporting-scheduling'].includes(appState.route.active)) return;

  const workspaceId = appState.workspace?.id;
  // Drop focus + clear any pending focus restore so the post-save render actually paints
  // (renderApp() suppresses DOM updates while a text field is focused). This makes saves
  // reflect immediately without a manual reload or tab switch.
  pendingFocusField = null;
  if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
  if (!workspaceId) {
    renderApp();
    return;
  }

  // An explicit refresh (post-save, data-version poll on a real change, Yoco sync-complete) must
  // fetch fresh — drop the short-lived GET cache so navigation stays fast but refreshes are live.
  try {
    clearApiCache();
  } catch { /* cache clear is best-effort */ }

  try {
    if (appState.route.active === 'products') {
      const [{ fetchMenuItems, fetchMenuModifiers }, { fetchStock }, { fetchModifierNoteSuggestions }] = await Promise.all([
        import('./services/menuService.js'),
        import('./services/stockService.js'),
        import('./services/recipeService.js')
      ]);
      const [refreshedItems, refreshedModifiers, stockSnapshot, noteSnapshot] = await Promise.all([
        fetchMenuItems(workspaceId, { cacheBust: true }),
        fetchMenuModifiers(workspaceId, { cacheBust: true }),
        fetchStock(workspaceId),
        fetchModifierNoteSuggestions(workspaceId, {
          includeIgnored: appState.menu.noteSuggestions?.includeIgnored,
          cacheBust: true
        }).catch(() => ({ suggestions: appState.menu.noteSuggestions?.items || [] }))
      ]);
      appState.menu = {
        ...appState.menu,
        status: 'ready',
        items: refreshedItems,
        modifierItems: refreshedModifiers,
        ingredients: stockSnapshot.items || appState.menu.ingredients || [],
        locations: stockSnapshot.locations || appState.menu.locations || [],
        noteSuggestions: {
          ...(appState.menu.noteSuggestions || {}),
          status: 'ready',
          items: noteSnapshot.suggestions || [],
          error: ''
        },
        source: 'Live catalogue',
        updatedAt: new Date().toISOString(),
        error: ''
      };
      renderApp();
      return;
    }

    if (appState.route.active === 'ingredients') {
      const { fetchStock } = await import('./services/stockService.js');
      // A delete that completes AFTER this fetch started already bumped stockMutationToken and
      // pruned appState.stock locally (see confirmStockDelete). If this fetch's snapshot predates
      // that delete, applying it here would resurrect the just-deleted row — drop it instead,
      // mirroring the same guard refreshStockFromDataVersion already uses.
      const requestToken = stockMutationToken;
      const stock = await fetchStock(workspaceId);
      if (requestToken !== stockMutationToken) return;
      appState.stock = {
        ...appState.stock,
        status: 'ready',
        items: stock.items || [],
        locations: stock.locations || appState.stock.locations || [],
        categories: stock.categories || appState.stock.categories || [],
        uoms: stock.uoms || appState.stock.uoms || [],
        updatedAt: stock.updatedAt || new Date().toISOString(),
        error: ''
      };
      renderApp();
      return;
    }

    if (appState.route.active === 'suppliers') {
      const { fetchSuppliers } = await import('./services/supplierService.js');
      const suppliers = await fetchSuppliers(workspaceId);
      appState.suppliers = {
        ...appState.suppliers,
        status: 'ready',
        items: suppliers.items || [],
        source: suppliers.source || 'Live suppliers',
        updatedAt: suppliers.updatedAt || new Date().toISOString(),
        error: ''
      };
      renderApp();
      return;
    }

    if (appState.route.active === 'purchase-orders') {
      const { fetchPurchaseOrdersWorkspace } = await import('./services/purchaseOrderService.js');
      const snapshot = await fetchPurchaseOrdersWorkspace(workspaceId);
      appState.purchaseOrders = {
        ...appState.purchaseOrders,
        ...snapshot,
        draftOrder: reconcilePurchaseOrderDraft(appState.purchaseOrders.draftOrder, snapshot)
      };
      renderApp();
      return;
    }

    if (appState.route.active === 'transfers') {
      const { fetchTransfersWorkspace } = await import('./services/transferService.js');
      const snapshot = await fetchTransfersWorkspace(workspaceId);
      appState.transfers = {
        ...appState.transfers,
        ...snapshot,
        draftTransfer: hydrateTransferDraft(appState.transfers.draftTransfer, snapshot.locations || [], snapshot.sites || [])
      };
      renderApp();
      return;
    }

    if (appState.route.active === 'stock-count') {
      const { fetchStockTakeWorkspace } = await import('./services/stockTakeService.js');
      const snapshot = await fetchStockTakeWorkspace(workspaceId, {
        draftUserId: appState.user?.uid || appState.user?.id || ''
      });
      appState.stockTake = {
        ...appState.stockTake,
        ...snapshot,
        draftSession: hydrateStockTakeDraft(appState.stockTake.draftSession, snapshot.locations || [])
      };
      renderApp();
      return;
    }

    if (appState.route.active === 'mfg-products') {
      const { fetchManufacturingWorkspace } = await import('./services/manufacturingService.js');
      const snapshot = await fetchManufacturingWorkspace(workspaceId);
      appState.manufacturing = {
        ...appState.manufacturing,
        ...snapshot,
        blueprintDraft: reconcileManufacturingBlueprintDraft(appState.manufacturing.blueprintDraft, snapshot.manufacturedItems || []),
        batchDraft: reconcileManufacturingBatchDraft(appState.manufacturing.batchDraft, snapshot.manufacturedItems || [], snapshot.locations || [])
      };
      renderApp();
      return;
    }

    if (appState.route.active === 'locations') {
      const { fetchLocationsWorkspace } = await import('./services/locationService.js');
      const snapshot = await fetchLocationsWorkspace(workspaceId);
      appState.locations = {
        ...appState.locations,
        status: snapshot.status || 'ready',
        settings: snapshot.settings || appState.locations.settings,
        sites: snapshot.sites || appState.locations.sites || [],
        items: snapshot.locations || appState.locations.items || [],
        stockItems: snapshot.stockItems || appState.locations.stockItems || [],
        loaded: snapshot.loaded || appState.locations.loaded,
        updatedAt: snapshot.updatedAt || new Date().toISOString(),
        error: ''
      };
      renderApp();
      return;
    }

    if (appState.route.active === 'user-management' || appState.route.active === 'custom-roles') {
      // Re-fetch workspace access (team + roles) so member/role edits reflect without a reload.
      startAccessSubscription(workspaceId);
      return;
    }



    forceRefreshActiveTab();
  } catch (error) {
    console.warn('[Refresh] Active tab API refresh failed:', error);
    forceRefreshActiveTab();
  }
}

async function loadSettings(workspaceId) {
  const loadToken = ++settingsLoadToken;

  if (!workspaceId) {
    appState.settings = createSettingsState('idle');
    return;
  }

  appState.settings = {
    ...appState.settings,
    status: 'loading',
    error: '',
    actionError: ''
  };

  try {
    const [settingsSnapshot, siteConfig, yocoCategories, stockCategories, goLiveReadiness, onboardingCounts, onboardingYoco] = await Promise.all([
      getWorkspaceSettingsSnapshot(workspaceId),
      import('./services/orgTransferService.js')
        .then(({ getSiteConfiguration }) => getSiteConfiguration(workspaceId))
        .catch(() => null),
      getYocoCategoryOptions(workspaceId).catch(() => []),
      getStockCategoryOptions(workspaceId).catch(() => []),
      getGoLiveReadiness(workspaceId).catch(() => ({ productCount: 0, recipeCount: 0, locationCount: 0 })),
      // Feature: show setup progress outside the wizard too, in Settings' Go-Live panel —
      // reuses the exact same readiness/status calls the wizard itself uses.
      getOnboardingReadiness(workspaceId).catch(() => null),
      fetchYocoStatusOnce(workspaceId).catch(() => null)
    ]);
    const onboardingProgress = getOnboardingProgress({ counts: onboardingCounts, yoco: onboardingYoco });
    const settings = normalizeSettings({
      ...settingsSnapshot,
      orgId: siteConfig?.orgId || settingsSnapshot.orgId || '',
      corpId: siteConfig?.corpId || settingsSnapshot.corpId || '',
      viewingOnly: siteConfig?.viewingOnly === true || settingsSnapshot.viewingOnly === true,
      linkedSiteCount: siteConfig?.linkedSiteCount ?? settingsSnapshot.linkedSiteCount ?? 0
    });
    if (
      loadToken !== settingsLoadToken ||
      !isSettingsRoute(appState.route.active) ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.settings = {
      ...appState.settings,
      status: 'ready',
      values: settings,
      draft: settings,
      yocoCategories,
      stockCategories,
      goLiveReadiness,
      onboardingProgress,
      error: ''
    };
    applyWorkspaceSettingsEffects(settings);
    renderApp();
  } catch (error) {
    if (
      loadToken !== settingsLoadToken ||
      !isSettingsRoute(appState.route.active) ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.settings = {
      ...appState.settings,
      status: 'error',
      error: error.message || 'Could not load settings.'
    };
    renderApp();
  }
}

async function startMenuSubscription(workspaceId) {
  cleanupMenuSubscription();
  const subscriptionToken = ++menuSubscriptionToken;

  if (!workspaceId) {
    appState.menu = createMenuState('idle', appState.menu.filters);
    return;
  }

  appState.menu = createMenuState('loading', appState.menu.filters);

  try {
    const { subscribeMenuCatalogue } = await import('./services/menuService.js');

    if (
      subscriptionToken !== menuSubscriptionToken ||
      appState.route.active !== 'products' ||
      appState.workspace?.id !== workspaceId
    ) return;

    unsubscribeMenu = subscribeMenuCatalogue(workspaceId, {
      onSnapshot: ({ status, items, modifierItems, locations, ingredients, noteSuggestions, posIntegration, source, updatedAt, error }) => {
        if (
          subscriptionToken !== menuSubscriptionToken ||
          appState.route.active !== 'products' ||
          appState.workspace?.id !== workspaceId
      ) return;

        const liveIds = new Set((items || []).map((item) => String(item.id)));
        applyRealtimeSnapshot('menu', () => {
          const nextStatus = status === 'ready' || !(appState.menu.items || []).length
            ? status
            : appState.menu.status;
          const nextLocations = locations || appState.menu.locations || [];
          const allowedLocationIds = new Set(getLocationsAllowedForCurrentRole(nextLocations).map((location) => String(location.id || location.locationId || '')).filter(Boolean));
          const defaultLocationId = getDefaultSellingLocationId(nextLocations);
          const currentLocationId = String(appState.menu.filters?.locationId || '');
          const nextFilters = {
            ...appState.menu.filters,
            locationId: currentLocationId && (!allowedLocationIds.size || allowedLocationIds.has(currentLocationId)) ? currentLocationId : defaultLocationId
          };
          appState.menu = {
            ...appState.menu,
            status: nextStatus,
            items,
            modifierItems: modifierItems || [],
            locations: nextLocations,
            ingredients: ingredients || appState.menu.ingredients || [],
            noteSuggestions: {
              ...(appState.menu.noteSuggestions || {}),
              status: 'ready',
              items: noteSuggestions || [],
              error: ''
            },
            posIntegration: posIntegration || { active: false, provider: '', label: '' },
            source,
            updatedAt,
            error: error?.message || '',
            selectedIds: posIntegration?.active ? [] : (appState.menu.selectedIds || []).filter((id) => liveIds.has(String(id))),
            filters: nextFilters
          };
        });
      },
      onError: (error) => {
        if (
          subscriptionToken !== menuSubscriptionToken ||
          appState.route.active !== 'products' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.menu = {
          ...appState.menu,
          status: 'error',
          error: error.message || 'Could not load menu catalogue.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== menuSubscriptionToken ||
      appState.route.active !== 'products' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.menu = {
      ...appState.menu,
      status: 'error',
      error: error.message || 'Could not initialize menu catalogue.'
    };
    renderApp();
  }
}

async function startRecipeSubscription(workspaceId) {
  cleanupRecipeSubscription();
  const subscriptionToken = ++recipeSubscriptionToken;

  if (!workspaceId) {
    appState.recipes = createRecipeState('idle', appState.recipes.filters);
    return;
  }

  appState.recipes = {
    ...createRecipeState('loading', appState.recipes.filters),
    pendingOpenItemId: appState.recipes.pendingOpenItemId || '',
    pendingOpenItemName: appState.recipes.pendingOpenItemName || '',
    pendingFocus: appState.recipes.pendingFocus || null
  };

  try {
    const { subscribeRecipeWorkspace } = await import('./services/recipeService.js');

    if (
      subscriptionToken !== recipeSubscriptionToken ||
      appState.route.active !== 'recipes' ||
      appState.workspace?.id !== workspaceId
    ) return;

    unsubscribeRecipes = subscribeRecipeWorkspace(workspaceId, {
      onSnapshot: ({ status, items, ingredients, locations, noteSuggestions, source, updatedAt, loaded }) => {
        if (
          subscriptionToken !== recipeSubscriptionToken ||
          appState.route.active !== 'recipes' ||
          appState.workspace?.id !== workspaceId
        ) return;

	        const liveIds = new Set((items || []).map((item) => String(item.id)));

        applyRealtimeSnapshot('recipes', () => {
	        const pendingOpenItemId = String(appState.recipes.pendingOpenItemId || '');
	        const pendingOpenItemName = String(appState.recipes.pendingOpenItemName || '');
	        const pendingOpenItem = findRecipeItemForTarget(items, {
            id: pendingOpenItemId,
            name: pendingOpenItemName
          });
	        const editingItem = pendingOpenItem
	          ? pendingOpenItem
	          : appState.recipes.editingItem
	            ? items.find((item) => String(item.id) === String(appState.recipes.editingItem.id)) || appState.recipes.editingItem
	            : null;
	        const draftRecipe = pendingOpenItem
	          ? structuredCloneSafe(pendingOpenItem.recipe || [])
	          : appState.recipes.draftRecipe;
	        appState.recipes = {
	          ...appState.recipes,
            status,
            items,
            ingredients,
            locations: locations || appState.recipes.locations || [],
	          source,
	          updatedAt,
	          loaded,
	          editingItem,
	          draftRecipe,
            noteSuggestions: {
              ...(appState.recipes.noteSuggestions || {}),
              status: 'ready',
              items: noteSuggestions || [],
              error: ''
            },
            modalFocusRequest: pendingOpenItem ? `${String(pendingOpenItem.id || pendingOpenItemName || pendingOpenItemId)}:${Date.now()}` : appState.recipes.modalFocusRequest,
	          pendingOpenItemId: pendingOpenItem ? '' : pendingOpenItemId,
	          pendingOpenItemName: pendingOpenItem ? '' : pendingOpenItemName,
	          pendingFocus: pendingOpenItem ? null : appState.recipes.pendingFocus,
	          selectedIds: (appState.recipes.selectedIds || []).filter((id) => liveIds.has(String(id)))
	        };
        });
      },
      onError: (error) => {
        if (
          subscriptionToken !== recipeSubscriptionToken ||
          appState.route.active !== 'recipes' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.recipes = {
          ...appState.recipes,
          status: 'error',
          error: error.message || 'Could not load recipes.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== recipeSubscriptionToken ||
      appState.route.active !== 'recipes' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.recipes = {
      ...appState.recipes,
      status: 'error',
      error: error.message || 'Could not initialize recipes.'
    };
    renderApp();
  }
}

async function startStockSubscription(workspaceId) {
  cleanupStockSubscription();
  const subscriptionToken = ++stockSubscriptionToken;

  if (!workspaceId) {
    appState.stock = createStockState('idle', appState.stock.filters);
    return;
  }

  appState.stock = createStockState('loading', appState.stock.filters);

  try {
    const { subscribeStockItems } = await import('./services/stockService.js');

    if (
      subscriptionToken !== stockSubscriptionToken ||
      appState.route.active !== 'ingredients' ||
      appState.workspace?.id !== workspaceId
    ) return;

    // subscribeStockItems fires exactly one fetch on subscribe (load-on-open, no background
    // polling). If a delete completes and bumps stockMutationToken while that fetch is still in
    // flight, this snapshot predates the delete and would resurrect the just-deleted row.
    const requestToken = stockMutationToken;
    unsubscribeStock = subscribeStockItems(workspaceId, {
      onSnapshot: ({ status, items, sites, locations, categories, uoms, loaded, updatedAt }) => {
        if (
          subscriptionToken !== stockSubscriptionToken ||
          requestToken !== stockMutationToken ||
          appState.route.active !== 'ingredients' ||
          appState.workspace?.id !== workspaceId
        ) return;

        const liveIds = new Set((items || []).map((item) => String(item.id)));

        applyRealtimeSnapshot('stock', () => {
          const nextStatus = status === 'ready' || !(appState.stock.items || []).length
            ? status
            : appState.stock.status;
          const editingItem = appState.stock.editingItem || null;
          const nextLocations = locations || appState.stock.locations || [];
          const allowedLocationIds = new Set(getLocationsAllowedForCurrentRole(nextLocations).map((location) => String(location.id || location.locationId || '')).filter(Boolean));
          const defaultLocationId = getDefaultSellingLocationId(nextLocations);
          const currentLocationId = String(appState.stock.filters?.locationId || '');
          const nextFilters = {
            ...appState.stock.filters,
            locationId: currentLocationId && (!allowedLocationIds.size || allowedLocationIds.has(currentLocationId)) ? currentLocationId : defaultLocationId
          };
          appState.stock = {
            ...appState.stock,
            status: nextStatus,
            items,
            sites,
            locations: nextLocations,
            categories,
            uoms,
            loaded,
            updatedAt,
            editingItem,
            selectedIds: (appState.stock.selectedIds || []).filter((id) => liveIds.has(String(id))),
            filters: nextFilters
          };
        });
      },
      onError: (error) => {
        if (
          subscriptionToken !== stockSubscriptionToken ||
          appState.route.active !== 'ingredients' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.stock = {
          ...appState.stock,
          status: 'error',
          error: error.message || 'Could not load stock items.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== stockSubscriptionToken ||
      appState.route.active !== 'ingredients' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.stock = {
      ...appState.stock,
      status: 'error',
      error: error.message || 'Could not initialize stock items.'
    };
    renderApp();
  }
}

async function startSupplierSubscription(workspaceId) {
  cleanupSupplierSubscription();
  const subscriptionToken = ++supplierSubscriptionToken;

  if (!workspaceId) {
    appState.suppliers = createSupplierState('idle', appState.suppliers.filters);
    return;
  }

  appState.suppliers = createSupplierState('loading', appState.suppliers.filters);

  try {
    const { subscribeSuppliers } = await import('./services/supplierService.js');

    if (
      subscriptionToken !== supplierSubscriptionToken ||
      appState.route.active !== 'suppliers' ||
      appState.workspace?.id !== workspaceId
    ) return;

    unsubscribeSuppliers = subscribeSuppliers(workspaceId, {
      onSnapshot: ({ status, items, source, updatedAt, error }) => {
        if (
          subscriptionToken !== supplierSubscriptionToken ||
          appState.route.active !== 'suppliers' ||
          appState.workspace?.id !== workspaceId
        ) return;

        const liveIds = new Set((items || []).map((item) => String(item.id)));
        appState.suppliers = {
          ...appState.suppliers,
          status,
          items,
          source,
          updatedAt,
          error: error?.message || '',
          selectedIds: (appState.suppliers.selectedIds || []).filter((id) => liveIds.has(String(id)))
        };
        renderApp();
      },
      onError: (error) => {
        if (
          subscriptionToken !== supplierSubscriptionToken ||
          appState.route.active !== 'suppliers' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.suppliers = {
          ...appState.suppliers,
          status: 'error',
          error: error.message || 'Could not load suppliers.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== supplierSubscriptionToken ||
      appState.route.active !== 'suppliers' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.suppliers = {
      ...appState.suppliers,
      status: 'error',
      error: error.message || 'Could not initialize suppliers.'
    };
    renderApp();
  }
}

async function startPurchaseOrderSubscription(workspaceId) {
  cleanupPurchaseOrderSubscription();
  const subscriptionToken = ++purchaseOrderSubscriptionToken;

  if (!workspaceId) {
    appState.purchaseOrders = createPurchaseOrderState('idle', appState.purchaseOrders.filters);
    return;
  }

  appState.purchaseOrders = createPurchaseOrderState('loading', appState.purchaseOrders.filters);

  try {
    const { subscribePurchaseOrders } = await import('./services/purchaseOrderService.js');

    if (
      subscriptionToken !== purchaseOrderSubscriptionToken ||
      appState.route.active !== 'purchase-orders' ||
      appState.workspace?.id !== workspaceId
    ) return;

    unsubscribePurchaseOrders = subscribePurchaseOrders(workspaceId, {
      onSnapshot: ({ status, orders, suppliers, stockItems, sites, locations, source, updatedAt, loaded }) => {
        if (
          subscriptionToken !== purchaseOrderSubscriptionToken ||
          appState.route.active !== 'purchase-orders' ||
          appState.workspace?.id !== workspaceId
        ) return;

        const draftOrder = reconcilePurchaseOrderDraft(appState.purchaseOrders.draftOrder, { orders, suppliers, stockItems });
        const liveIds = new Set((orders || []).map((order) => String(order.id)));

        appState.purchaseOrders = {
          ...appState.purchaseOrders,
          status,
          orders,
            suppliers,
            stockItems,
            sites,
            locations,
          source,
          updatedAt,
          loaded,
          draftOrder,
          selectedIds: (appState.purchaseOrders.selectedIds || []).filter((id) => liveIds.has(String(id)))
        };
        applyPendingReportingPurchaseOrderSeed();
        renderApp();
      },
      onError: (error) => {
        if (
          subscriptionToken !== purchaseOrderSubscriptionToken ||
          appState.route.active !== 'purchase-orders' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.purchaseOrders = {
          ...appState.purchaseOrders,
          status: 'error',
          error: error.message || 'Could not load purchase orders.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== purchaseOrderSubscriptionToken ||
      appState.route.active !== 'purchase-orders' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      status: 'error',
      error: error.message || 'Could not initialize purchase orders.'
    };
    renderApp();
  }
}

async function startGrvSubscription(workspaceId) {
  cleanupGrvSubscription();
  const subscriptionToken = ++grvSubscriptionToken;

  if (!workspaceId) {
    appState.grv = createGrvState('idle', appState.grv.filters, appState.grv.pendingSourcePoId);
    return;
  }

  appState.grv = createGrvState('loading', appState.grv.filters, appState.grv.pendingSourcePoId);

  try {
    const { subscribeGrvWorkspace } = await import('./services/grvService.js');

    if (
      subscriptionToken !== grvSubscriptionToken ||
      appState.route.active !== 'grv' ||
      appState.workspace?.id !== workspaceId
    ) return;

    unsubscribeGrv = subscribeGrvWorkspace(workspaceId, {
      onSnapshot: ({ status, receipts, orders, suppliers, stockItems, sites, locations, source, updatedAt, loaded }) => {
        if (
          subscriptionToken !== grvSubscriptionToken ||
          appState.route.active !== 'grv' ||
          appState.workspace?.id !== workspaceId
        ) return;

        const currentDraft = isGrvDraftDirty(appState.grv.draftReceipt)
          ? appState.grv.draftReceipt
          : loadPersistedDraft('grv', createEmptyGrvDraft);
        const draftReceipt = reconcileGrvDraft(currentDraft, { orders, stockItems, locations });
        appState.grv = {
          ...appState.grv,
          status,
          receipts,
          orders,
          suppliers,
          stockItems,
          sites,
          locations,
          source,
          updatedAt,
          loaded,
          draftReceipt
        };
        renderApp();
        if (appState.grv.pendingSourcePoId && !appState.grv.actionStatus && loaded?.orders) {
          queueMicrotask(() => {
            if (appState.route.active !== 'grv' || !appState.grv.pendingSourcePoId) return;
            openGrvFromPurchaseOrder(appState.grv.pendingSourcePoId);
          });
        }
      },
      onError: (error) => {
        if (
          subscriptionToken !== grvSubscriptionToken ||
          appState.route.active !== 'grv' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.grv = {
          ...appState.grv,
          status: 'error',
          error: error.message || 'Could not load goods received entries.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== grvSubscriptionToken ||
      appState.route.active !== 'grv' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.grv = {
      ...appState.grv,
      status: 'error',
      error: error.message || 'Could not initialize goods received entries.'
    };
    renderApp();
  }
}

async function startCreditNoteSubscription(workspaceId) {
  cleanupCreditNoteSubscription();
  const subscriptionToken = ++creditNoteSubscriptionToken;

  if (!workspaceId) {
    appState.creditNotes = createCreditNoteState('idle', appState.creditNotes.filters);
    return;
  }

  appState.creditNotes = createCreditNoteState('loading', appState.creditNotes.filters);

  try {
    const { subscribeCreditNotesWorkspace } = await import('./services/creditNoteService.js');

    if (
      subscriptionToken !== creditNoteSubscriptionToken ||
      appState.route.active !== 'credit-note' ||
      appState.workspace?.id !== workspaceId
    ) return;

    unsubscribeCreditNotes = subscribeCreditNotesWorkspace(workspaceId, {
      onSnapshot: ({ status, creditNotes, processedGrvs, stockItems, sites, locations, suppliers, source, updatedAt, loaded }) => {
        if (
          subscriptionToken !== creditNoteSubscriptionToken ||
          appState.route.active !== 'credit-note' ||
          appState.workspace?.id !== workspaceId
        ) return;

        const currentDraft = isCreditNoteDraftDirty(appState.creditNotes.draftNote)
          ? appState.creditNotes.draftNote
          : loadPersistedDraft('credit-note', createEmptyCreditNoteDraft);
        appState.creditNotes = {
          ...appState.creditNotes,
          status,
          creditNotes,
          processedGrvs,
          stockItems,
          sites,
          locations,
          suppliers,
          source,
          updatedAt,
          loaded,
          draftNote: reconcileCreditNoteDraft(currentDraft, { stockItems, locations, suppliers })
        };
        renderApp();
      },
      onError: (error) => {
        if (
          subscriptionToken !== creditNoteSubscriptionToken ||
          appState.route.active !== 'credit-note' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.creditNotes = {
          ...appState.creditNotes,
          status: 'error',
          error: error.message || 'Could not load credit notes.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== creditNoteSubscriptionToken ||
      appState.route.active !== 'credit-note' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.creditNotes = {
      ...appState.creditNotes,
      status: 'error',
      error: error.message || 'Could not initialize credit notes.'
    };
    renderApp();
  }
}

async function startAdjustmentSubscription(workspaceId) {
  cleanupAdjustmentSubscription();
  const subscriptionToken = ++adjustmentSubscriptionToken;

  if (!workspaceId) {
    appState.adjustments = createAdjustmentState('idle', appState.adjustments.filters);
    return;
  }

  appState.adjustments = createAdjustmentState('loading', appState.adjustments.filters);

  try {
    const { subscribeAdjustmentsWorkspace } = await import('./services/adjustmentService.js');

    if (
      subscriptionToken !== adjustmentSubscriptionToken ||
      appState.route.active !== 'adjustments' ||
      appState.workspace?.id !== workspaceId
    ) return;

    unsubscribeAdjustments = subscribeAdjustmentsWorkspace(workspaceId, {
      onSnapshot: ({ status, adjustments, stockItems, products, sites, locations, source, updatedAt, loaded }) => {
        if (
          subscriptionToken !== adjustmentSubscriptionToken ||
          appState.route.active !== 'adjustments' ||
          appState.workspace?.id !== workspaceId
        ) return;

        applyRealtimeSnapshot('adjustments', () => {
          const currentDraft = appState.adjustments.draftAdjustment || createEmptyAdjustmentDraft();
          const draftLocation = getLocationById(locations || [], currentDraft.locationId) || getDefaultLocation(locations || []);
          const draftLocationId = draftLocation?.id || currentDraft.locationId || '';
          const draftSiteId = draftLocationId ? getSiteIdForLocation(locations || [], draftLocationId) || currentDraft.siteId || '' : currentDraft.siteId || '';
          const draftLocationName = draftLocationId
            ? getLocationNameById(locations || [], draftLocationId, currentDraft.locationName || 'Main Store')
            : (currentDraft.locationName || 'Main Store');
          appState.adjustments = {
            ...appState.adjustments,
            status,
            adjustments,
            stockItems,
            products: products || appState.adjustments.products || [],
            sites,
            locations,
            source,
            updatedAt,
            loaded,
            draftAdjustment: {
              ...currentDraft,
              siteId: draftSiteId,
              siteName: getSiteNameById(sites || [], draftSiteId, currentDraft.siteName || ''),
              locationId: draftLocationId,
              locationName: draftLocationName,
              items: (currentDraft.items || []).map((item) => {
                const itemLocation = getLocationById(locations || [], item.locationId) || draftLocation;
                const itemLocationId = itemLocation?.id || draftLocationId;
                return {
                  ...item,
                  siteId: itemLocationId ? getSiteIdForLocation(locations || [], itemLocationId) || draftSiteId : draftSiteId,
                  locationId: itemLocationId,
                  locationName: itemLocationId
                    ? getLocationNameById(locations || [], itemLocationId, item.locationName || draftLocationName)
                    : draftLocationName
                };
              })
            }
          };
        });
      },
      onError: (error) => {
        if (
          subscriptionToken !== adjustmentSubscriptionToken ||
          appState.route.active !== 'adjustments' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.adjustments = {
          ...appState.adjustments,
          status: 'error',
          error: error.message || 'Could not load adjustments.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== adjustmentSubscriptionToken ||
      appState.route.active !== 'adjustments' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.adjustments = {
      ...appState.adjustments,
      status: 'error',
      error: error.message || 'Could not initialize adjustments.'
    };
    renderApp();
  }
}

async function startTransferSubscription(workspaceId) {
  cleanupTransferSubscription();
  const subscriptionToken = ++transferSubscriptionToken;

  if (!workspaceId) {
    appState.transfers = createTransferState('idle', appState.transfers.filters);
    return;
  }

  appState.transfers = createTransferState('loading', appState.transfers.filters);

  try {
    const [{ subscribeTransfersWorkspace }, { getSiteConfiguration, getLinkedTransferProfiles, createFallbackSiteConfiguration }] = await Promise.all([
      import('./services/transferService.js'),
      import('./services/orgTransferService.js')
    ]);
    // Await siteConfig BEFORE starting the subscription so the first snapshot
    // always sees the correct showExternalTransfer value.
    const [config, linkedProfiles] = await Promise.all([
      getSiteConfiguration(workspaceId),
      getLinkedTransferProfiles(workspaceId).catch((error) => {
        console.warn('[Transfers] Could not load linked receiving profiles:', error?.message || error);
        return [];
      })
    ]);

    if (
      subscriptionToken !== transferSubscriptionToken ||
      appState.route.active !== 'transfers' ||
      appState.workspace?.id !== workspaceId
    ) return;

    let siteConfig = {
      ...config,
      locationCount: appState.transfers.locations?.length || config.locationCount,
      linkedSiteCount: Math.max(Number(config.linkedSiteCount || 0), linkedProfiles.length),
      showExternalTransfer: config.showExternalTransfer === true || linkedProfiles.length > 0
    };

    appState.transfers = {
      ...appState.transfers,
      siteConfig,
      linkedProfiles
    };
    renderApp();

    unsubscribeTransfers = subscribeTransfersWorkspace(workspaceId, {
      onSnapshot: ({ status, transfers, externalTransfers, templates, stockItems, sites, locations, source, updatedAt, loaded }) => {
        if (
          subscriptionToken !== transferSubscriptionToken ||
          appState.route.active !== 'transfers' ||
          appState.workspace?.id !== workspaceId
        ) return;

        applyRealtimeSnapshot('transfers', () => {
          const nextDraft = hydrateTransferDraft(appState.transfers.draftTransfer, locations, sites);
          appState.transfers = {
            ...appState.transfers,
            status,
            transfers,
            externalTransfers,
            templates,
            stockItems,
            sites,
            locations,
            source,
            updatedAt,
            loaded,
            siteConfig: {
              ...siteConfig,
              locationCount: Array.isArray(locations) ? locations.length : siteConfig.locationCount,
              linkedSiteCount: Math.max(Number(siteConfig.linkedSiteCount || 0), appState.transfers.linkedProfiles?.length || 0),
              showExternalTransfer: siteConfig.showExternalTransfer === true || (appState.transfers.linkedProfiles?.length || 0) > 0
            },
            draftTransfer: nextDraft
          };
        });
      },
      onError: (error) => {
        if (
          subscriptionToken !== transferSubscriptionToken ||
          appState.route.active !== 'transfers' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.transfers = {
          ...appState.transfers,
          status: 'error',
          error: error.message || 'Could not load transfers.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== transferSubscriptionToken ||
      appState.route.active !== 'transfers' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.transfers = {
      ...appState.transfers,
      status: 'error',
      error: error.message || 'Could not initialize transfers.'
    };
    renderApp();
  }
}

async function startStockTakeSubscription(workspaceId) {
  cleanupStockTakeSubscription();
  const subscriptionToken = ++stockTakeSubscriptionToken;

  if (!workspaceId) {
    appState.stockTake = createStockTakeState('idle', appState.stockTake.filters, appState.stockTake.sessionActive);
    return;
  }

  appState.stockTake = createStockTakeState('loading', appState.stockTake.filters, appState.stockTake.sessionActive);

  try {
    const { subscribeStockTakeWorkspace } = await import('./services/stockTakeService.js');

    if (
      subscriptionToken !== stockTakeSubscriptionToken ||
      appState.route.active !== 'stock-count' ||
      appState.workspace?.id !== workspaceId
    ) return;

    unsubscribeStockTake = subscribeStockTakeWorkspace(workspaceId, {
      draftUserId: appState.user?.uid || appState.user?.id || '',
      onSnapshot: ({ status, stockTakes, stockItems, templates, savedDrafts, sites, locations, source, updatedAt, loaded }) => {
        if (
          subscriptionToken !== stockTakeSubscriptionToken ||
          appState.route.active !== 'stock-count' ||
          appState.workspace?.id !== workspaceId
        ) return;

        applyRealtimeSnapshot('stockTake', () => {
          const nextDraft = hydrateStockTakeDraft(appState.stockTake.draftSession, locations);
          appState.stockTake = {
            ...appState.stockTake,
            status,
            stockTakes,
            stockItems,
            templates,
            savedDrafts,
            sites,
            locations,
            source,
            updatedAt,
            loaded,
            draftSession: nextDraft
          };
        });
      },
      onError: (error) => {
        if (
          subscriptionToken !== stockTakeSubscriptionToken ||
          appState.route.active !== 'stock-count' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.stockTake = {
          ...appState.stockTake,
          status: 'error',
          error: error.message || 'Could not load stock take.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== stockTakeSubscriptionToken ||
      appState.route.active !== 'stock-count' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.stockTake = {
      ...appState.stockTake,
      status: 'error',
      error: error.message || 'Could not initialize stock take.'
    };
    renderApp();
  }
}

function startAccessSubscription(workspaceId) {
  cleanupAccessSubscription();
  const subscriptionToken = ++accessSubscriptionToken;

  if (!workspaceId) {
    appState.access = createAccessState('idle');
    return;
  }

  appState.access = createAccessState('loading');

  try {
    unsubscribeAccess = subscribeWorkspaceAccess(workspaceId, appState.user, {
      onSnapshot: ({ status, team, customRoles, superUsers, currentIsSuperUser, currentIsKcpSuperUser, roleCatalog, roleOptions, locations, currentRole, currentUserLocations, currentUserCanAccessExternalTransfers, roleDefinition, allowedSections, updatedAt }) => {
        if (subscriptionToken !== accessSubscriptionToken || appState.workspace?.id !== workspaceId) return;

        const normalizedSections = allowedSections.length ? allowedSections : ['dashboard'];
        appState.access = {
          status,
          team,
          customRoles,
          superUsers,
          currentIsSuperUser,
          currentIsKcpSuperUser,
          roleCatalog,
          roleOptions,
          locations,
          currentRole,
          currentUserLocations: currentUserLocations || [],
          currentUserCanAccessExternalTransfers: currentUserCanAccessExternalTransfers !== false,
          roleDefinition,
          allowedSections: normalizedSections,
          updatedAt,
          error: ''
        };

        appState.userManagement.status = status;
        appState.roleManagement.status = status;

        if (!normalizedSections.includes(appState.route.active)) {
          appState.route = { active: normalizedSections[0] || 'dashboard' };
          persistRoute(appState.route.active);
          bootstrapActiveRouteForWorkspace(appState.workspace?.id);
          return;
        }

        renderApp();
      },
      onError: (error) => {
        if (subscriptionToken !== accessSubscriptionToken || appState.workspace?.id !== workspaceId) return;
        appState.access = {
          ...appState.access,
          status: 'error',
          error: error.message || 'Could not load workspace access.'
        };
        renderApp();
      }
    });
  } catch (error) {
    appState.access = {
      ...appState.access,
      status: 'error',
      error: error.message || 'Could not initialize workspace access.'
    };
  }
}

async function startLocationSubscription(workspaceId) {
  cleanupLocationSubscription();
  const subscriptionToken = ++locationSubscriptionToken;

  if (!workspaceId) {
    appState.locations = createLocationState('idle', appState.locations.filters);
    return;
  }

  appState.locations = createLocationState('loading', appState.locations.filters);

  try {
    const { migrateSitesAndStockLocations, subscribeLocationsWorkspace } = await import('./services/locationService.js');

    if (
      subscriptionToken !== locationSubscriptionToken ||
      appState.route.active !== 'locations' ||
      appState.workspace?.id !== workspaceId
    ) return;

    await migrateSitesAndStockLocations(workspaceId);

    if (
      subscriptionToken !== locationSubscriptionToken ||
      appState.route.active !== 'locations' ||
      appState.workspace?.id !== workspaceId
    ) return;

    unsubscribeLocations = subscribeLocationsWorkspace(workspaceId, {
      onSnapshot: ({ status, settings, sites, locations, stockItems, loaded, updatedAt }) => {
        if (
          subscriptionToken !== locationSubscriptionToken ||
          appState.route.active !== 'locations' ||
          appState.workspace?.id !== workspaceId
        ) return;

        applyRealtimeSnapshot('locations', () => {
          const editingLocation = appState.locations.editingLocation
            ? locations.find((item) => String(item.id) === String(appState.locations.editingLocation.id)) || appState.locations.editingLocation
            : null;
          const editingSite = appState.locations.editingSite
            ? sites.find((item) => String(item.id) === String(appState.locations.editingSite.id)) || appState.locations.editingSite
            : null;
          const selectedSiteId = sites.some((item) => String(item.id) === String(appState.locations.selectedSiteId))
            ? appState.locations.selectedSiteId
            : '';

          appState.locations = {
            ...appState.locations,
            status,
            settings,
            sites,
            items: locations,
            stockItems,
            loaded,
            updatedAt,
            editingLocation,
            editingSite,
            selectedSiteId
          };
        });
      },
      onError: (error) => {
        if (
          subscriptionToken !== locationSubscriptionToken ||
          appState.route.active !== 'locations' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.locations = {
          ...appState.locations,
          status: 'error',
          error: error.message || 'Could not load locations.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== locationSubscriptionToken ||
      appState.route.active !== 'locations' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.locations = {
      ...appState.locations,
      status: 'error',
      error: error.message || 'Could not initialize locations.'
    };
    renderApp();
  }
}

async function startManufacturingSubscription(workspaceId) {
  cleanupManufacturingSubscription();
  const subscriptionToken = ++manufacturingSubscriptionToken;

  if (!workspaceId) {
    appState.manufacturing = createManufacturingState('idle', appState.manufacturing.filters);
    return;
  }

  appState.manufacturing = createManufacturingState('loading', appState.manufacturing.filters);

  try {
    const { subscribeManufacturingWorkspace } = await import('./services/manufacturingService.js');

    if (
      subscriptionToken !== manufacturingSubscriptionToken ||
      appState.route.active !== 'mfg-products' ||
      appState.workspace?.id !== workspaceId
    ) return;

    unsubscribeManufacturing = subscribeManufacturingWorkspace(workspaceId, {
      onSnapshot: ({ status, manufacturedItems, stockItems, sites, locations, categories, uoms, logs, loaded, updatedAt }) => {
        if (
          subscriptionToken !== manufacturingSubscriptionToken ||
          appState.route.active !== 'mfg-products' ||
          appState.workspace?.id !== workspaceId
        ) return;

        applyRealtimeSnapshot('manufacturing', () => {
          const blueprintDraft = reconcileManufacturingBlueprintDraft(appState.manufacturing.blueprintDraft, manufacturedItems);
          const batchDraft = reconcileManufacturingBatchDraft(appState.manufacturing.batchDraft, manufacturedItems, locations);

          appState.manufacturing = {
            ...appState.manufacturing,
            status,
            manufacturedItems,
            stockItems,
            sites,
            locations,
            categories,
            uoms,
            logs,
            loaded,
            updatedAt,
            blueprintDraft,
            batchDraft
          };
        });
      },
      onError: (error) => {
        if (
          subscriptionToken !== manufacturingSubscriptionToken ||
          appState.route.active !== 'mfg-products' ||
          appState.workspace?.id !== workspaceId
        ) return;

        appState.manufacturing = {
          ...appState.manufacturing,
          status: 'error',
          error: error.message || 'Could not load manufacturing.'
        };
        renderApp();
      }
    });
  } catch (error) {
    if (
      subscriptionToken !== manufacturingSubscriptionToken ||
      appState.route.active !== 'mfg-products' ||
      appState.workspace?.id !== workspaceId
    ) return;

    appState.manufacturing = {
      ...appState.manufacturing,
      status: 'error',
      error: error.message || 'Could not initialize manufacturing.'
    };
    renderApp();
  }
}







function openLowStockAlerts() {
  navigateTo('ingredients');
}

function updateMenuFilters(nextFilters) {
  appState.menu = {
    ...appState.menu,
    filters: {
      ...appState.menu.filters,
      ...nextFilters
    }
  };
  renderApp();
}


function openMenuModifierEditor(modifierId = '', options = {}) {
  const modifier = (appState.menu.modifierItems || []).find((entry) => String(entry.id) === String(modifierId));
  if (!modifier) {
    showMenuToast('Modifier could not be found. Refresh the catalogue and try again.', 'error');
    return;
  }
  const editingModifier = structuredCloneSafe(modifier);
  editingModifier.stockRule = {
    ...(editingModifier.stockRule || {}),
    locationIds: []
  };
  if (options?.actionType) {
    editingModifier.stockRule = {
      ...(editingModifier.stockRule || {}),
      actionType: String(options.actionType).toUpperCase()
    };
  }
  appState.menu = {
    ...appState.menu,
    editingModifier,
    modifierStockRuleOpen: true,
    modifierStockPicker: null,
    viewingModifierLinks: null,
    modifierLinksOpen: false,
    filters: {
      ...appState.menu.filters,
      openDropdown: ''
    },
    actionError: ''
  };
  renderApp();
}

function openMenuModifierLinks(modifierId = '') {
  const modifier = (appState.menu.modifierItems || []).find((entry) => String(entry.id) === String(modifierId));
  if (!modifier) {
    showMenuToast('Modifier links could not be found. Refresh the catalogue and try again.', 'error');
    return;
  }
  appState.menu = {
    ...appState.menu,
    viewingModifierLinks: structuredCloneSafe(modifier),
    modifierLinksOpen: true,
    editingModifier: null,
    modifierStockRuleOpen: false,
    modifierStockPicker: null,
    filters: {
      ...appState.menu.filters,
      openDropdown: ''
    },
    actionError: ''
  };
  renderApp();
}

function closeMenuModifierLinks() {
  appState.menu = {
    ...appState.menu,
    viewingModifierLinks: null,
    modifierLinksOpen: false
  };
  renderApp();
}

function closeMenuModifierEditor() {
  appState.menu = {
    ...appState.menu,
    editingModifier: null,
    modifierStockRuleOpen: false,
    modifierStockPicker: null,
    viewingModifierLinks: null,
    modifierLinksOpen: false,
    actionStatus: '',
    actionError: ''
  };
  renderApp();
}

function updateMenuModifierStockRule(patch = {}) {
  const current = appState.menu.editingModifier;
  if (!current) return;
  appState.menu = {
    ...appState.menu,
    editingModifier: {
      ...current,
      stockRule: {
        ...(current.stockRule || {}),
        ...patch,
        locationIds: []
      }
    },
    actionError: ''
  };
  renderApp();
}

function openMenuModifierStockPicker(mode = '') {
  if (!appState.menu.editingModifier) return;
  appState.menu = {
    ...appState.menu,
    modifierStockPicker: { open: true, mode: String(mode || ''), query: '' }
  };
  renderApp();
}

function closeMenuModifierStockPicker() {
  appState.menu = { ...appState.menu, modifierStockPicker: null };
  renderApp();
}

function searchMenuModifierStockPicker(query = '') {
  appState.menu = {
    ...appState.menu,
    modifierStockPicker: {
      ...(appState.menu.modifierStockPicker || {}),
      open: true,
      query: String(query || '')
    }
  };
  renderApp();
}

function selectMenuModifierStockPicker(value = '') {
  const mode = String(appState.menu.modifierStockPicker?.mode || '');
  const raw = String(value || '');
  if (!mode || !raw) return;
  if (mode === 'recipeTarget') {
    const separator = raw.indexOf('|');
    updateMenuModifierStockRule({
      targetOwnerType: separator >= 0 ? raw.slice(0, separator) : '',
      targetOwnerId: separator >= 0 ? raw.slice(separator + 1) : raw
    });
  } else if (mode === 'stockTarget') {
    const selected = (appState.menu.ingredients || []).find((entry) => String(entry.id) === raw);
    updateMenuModifierStockRule({ targetOwnerType: 'stock_item', targetOwnerId: raw, unit: String(selected?.unit || 'ea') });
  } else if (mode === 'source') {
    updateMenuModifierStockRule({ sourceStockItemId: raw, replacementStockItemId: '', quantity: 1 });
  } else if (mode === 'replacement') {
    updateMenuModifierStockRule({ replacementStockItemId: raw });
  }
  appState.menu = { ...appState.menu, modifierStockPicker: null };
  renderApp();
}

async function saveMenuModifierRule() {
  const modifier = appState.menu.editingModifier;
  if (!modifier) return;
  appState.menu = {
    ...appState.menu,
    actionStatus: 'saving-modifier',
    actionError: ''
  };
  renderApp();
  try {
    const { updateRecipe } = await import('./services/recipeService.js');
    await updateRecipe(appState.workspace?.id, modifier, modifier.recipe || []);
    const { fetchMenuModifiers } = await import('./services/menuService.js');
    const modifierItems = await fetchMenuModifiers(appState.workspace?.id, { cacheBust: true });
    appState.menu = {
      ...appState.menu,
      modifierItems,
      editingModifier: null,
      modifierStockRuleOpen: false,
      modifierStockPicker: null,
      actionStatus: '',
      actionError: '',
      updatedAt: new Date().toISOString()
    };
    showMenuToast('Modifier stock action saved.', 'success');
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      actionStatus: '',
      actionError: error.message || 'Could not save the modifier stock action.'
    };
    showMenuToast(error.message || 'Could not save the modifier stock action.', 'error');
  }
  renderApp();
}

async function refreshMenuNoteSuggestions(options = {}) {
  const includeIgnored = options.includeIgnored ?? appState.menu.noteSuggestions?.includeIgnored ?? false;
  appState.menu = {
    ...appState.menu,
    noteSuggestions: {
      ...(appState.menu.noteSuggestions || {}),
      status: 'loading',
      includeIgnored,
      error: ''
    }
  };
  renderApp();
  try {
    const { fetchModifierNoteSuggestions } = await import('./services/recipeService.js');
    const response = await fetchModifierNoteSuggestions(appState.workspace?.id, {
      includeIgnored,
      cacheBust: true
    });
    appState.menu = {
      ...appState.menu,
      noteSuggestions: {
        ...(appState.menu.noteSuggestions || {}),
        status: 'ready',
        includeIgnored,
        items: response.suggestions || [],
        error: ''
      }
    };
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      noteSuggestions: {
        ...(appState.menu.noteSuggestions || {}),
        status: 'error',
        includeIgnored,
        error: error.message || 'Could not load suggestions from orders.'
      }
    };
  }
  renderApp();
}

function openMenuNoteSuggestions() {
  appState.menu = {
    ...appState.menu,
    filters: { ...appState.menu.filters, openDropdown: '' },
    noteSuggestions: {
      ...(appState.menu.noteSuggestions || {}),
      open: true,
      error: ''
    }
  };
  renderApp();
  if (!['ready', 'loading'].includes(appState.menu.noteSuggestions?.status)) {
    refreshMenuNoteSuggestions();
  }
}

function closeMenuNoteSuggestions() {
  appState.menu = {
    ...appState.menu,
    noteSuggestions: {
      ...(appState.menu.noteSuggestions || {}),
      open: false,
      editingId: '',
      draft: null,
      error: ''
    }
  };
  renderApp();
}

function startMenuNoteRuleSetup(suggestionId = '') {
  const suggestion = (appState.menu.noteSuggestions?.items || [])
    .find((entry) => String(entry.id) === String(suggestionId));
  if (!suggestion) return;
  const existing = suggestion.rule || {};
  const actionType = String(existing.actionType || 'NO_STOCK_CHANGE').toUpperCase();
  appState.menu = {
    ...appState.menu,
    noteSuggestions: {
      ...(appState.menu.noteSuggestions || {}),
      editingId: suggestion.id,
      error: '',
      draft: {
        noteText: suggestion.notePhrase || suggestion.normalizedText || '',
        normalizedText: suggestion.normalizedText || '',
        actionType,
        targetOwnerType: String(existing.targetOwnerType || (actionType === 'ADD_RECIPE' ? 'product' : actionType === 'ADD_STOCK_ITEM' ? 'stock_item' : '')),
        targetOwnerId: String(existing.targetOwnerId || ''),
        sourceStockItemId: String(existing.sourceStockItemId || ''),
        replacementStockItemId: String(existing.replacementStockItemId || ''),
        quantity: Number(existing.quantity || 1) || 1,
        unit: String(existing.unit || ''),
        menuItemIds: Array.isArray(existing.menuItemIds) && existing.menuItemIds.length
          ? existing.menuItemIds.map(String)
          : (suggestion.menuItemIds || []).map(String),
        locationIds: Array.isArray(existing.locationIds) && existing.locationIds.length
          ? existing.locationIds.map(String)
          : (suggestion.locationIds || []).map(String)
      }
    }
  };
  renderApp();
}

function cancelMenuNoteRuleSetup() {
  appState.menu = {
    ...appState.menu,
    noteSuggestions: {
      ...(appState.menu.noteSuggestions || {}),
      editingId: '',
      draft: null,
      error: ''
    }
  };
  renderApp();
}

function updateMenuNoteRuleDraft(patch = {}) {
  const current = appState.menu.noteSuggestions?.draft;
  if (!current) return;
  const next = { ...current, ...patch };
  if (patch.actionType) {
    const actionType = String(patch.actionType).toUpperCase();
    next.actionType = actionType;
    next.targetOwnerType = actionType === 'ADD_RECIPE'
      ? 'product'
      : actionType === 'ADD_STOCK_ITEM'
        ? 'stock_item'
        : '';
    next.targetOwnerId = '';
    next.sourceStockItemId = '';
    next.replacementStockItemId = '';
  }
  appState.menu = {
    ...appState.menu,
    noteSuggestions: {
      ...(appState.menu.noteSuggestions || {}),
      draft: next,
      error: ''
    }
  };
  renderApp();
}

async function saveMenuNoteRule() {
  const noteState = appState.menu.noteSuggestions || {};
  const draft = noteState.draft;
  if (!draft?.noteText) return;
  const actionType = String(draft.actionType || '').toUpperCase();
  const targetRequired = ['ADD_RECIPE', 'ADD_STOCK_ITEM'].includes(actionType);
  const sourceRequired = ['REMOVE_INGREDIENT', 'REPLACE_INGREDIENT'].includes(actionType);
  const replacementRequired = actionType === 'REPLACE_INGREDIENT';
  if (!actionType || (targetRequired && !draft.targetOwnerId) || (sourceRequired && !draft.sourceStockItemId) || (replacementRequired && !draft.replacementStockItemId)) {
    appState.menu = {
      ...appState.menu,
      noteSuggestions: { ...noteState, error: 'Complete the stock action before saving.' }
    };
    renderApp();
    return;
  }
  appState.menu = {
    ...appState.menu,
    noteSuggestions: { ...noteState, status: 'saving', error: '' }
  };
  renderApp();
  try {
    const { saveModifierNoteRule } = await import('./services/recipeService.js');
    await saveModifierNoteRule(appState.workspace?.id, draft.noteText, {
      actionType,
      targetOwnerType: draft.targetOwnerType || '',
      targetOwnerId: draft.targetOwnerId || '',
      sourceStockItemId: draft.sourceStockItemId || '',
      replacementStockItemId: draft.replacementStockItemId || '',
      quantity: Math.max(0.000001, Number(draft.quantity || 1) || 1),
      unit: draft.unit || '',
      menuItemIds: Array.isArray(draft.menuItemIds) ? draft.menuItemIds : [],
      locationIds: Array.isArray(draft.locationIds) ? draft.locationIds : [],
      applyAllMatchingProducts: !Array.isArray(draft.menuItemIds) || draft.menuItemIds.length === 0,
      active: true
    });
    appState.menu = {
      ...appState.menu,
      noteSuggestions: {
        ...(appState.menu.noteSuggestions || {}),
        editingId: '',
        draft: null,
        status: 'ready',
        error: ''
      }
    };
    await refreshMenuNoteSuggestions();
    showMenuToast('Note rule approved. Exact matching notes can now affect stock.', 'success');
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      noteSuggestions: {
        ...(appState.menu.noteSuggestions || {}),
        status: 'error',
        error: error.message || 'Could not save the note rule.'
      }
    };
    renderApp();
  }
}

async function setMenuNoteSuggestionDisposition(noteText = '', disposition = 'IGNORED') {
  const noteState = appState.menu.noteSuggestions || {};
  appState.menu = {
    ...appState.menu,
    noteSuggestions: { ...noteState, status: 'saving', error: '' }
  };
  renderApp();
  try {
    const service = await import('./services/recipeService.js');
    if (disposition === 'SUGGESTED') {
      await service.restoreModifierNoteSuggestion(appState.workspace?.id, noteText);
    } else {
      await service.ignoreModifierNoteSuggestion(appState.workspace?.id, noteText);
    }
    await refreshMenuNoteSuggestions();
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      noteSuggestions: {
        ...(appState.menu.noteSuggestions || {}),
        status: 'error',
        error: error.message || 'Could not update the note suggestion.'
      }
    };
    renderApp();
  }
}

function toggleMenuIgnoredNoteSuggestions(includeIgnored = false) {
  refreshMenuNoteSuggestions({ includeIgnored: Boolean(includeIgnored) });
}

async function scanMenuBarcode() {
  try {
    const { openBarcodeScanner } = await import('./services/barcodeScanner.js');
    await openBarcodeScanner({
      title: 'Scan Menu Barcode',
      helper: 'Scan a menu item barcode to filter the catalogue.',
      onScan: (code) => {
        const barcode = String(code || '').trim();
        if (!barcode) return;
        appState.menu = {
          ...appState.menu,
          filters: {
            ...appState.menu.filters,
            query: barcode
          }
        };
        showMenuToast(`Barcode ${barcode} loaded into menu search.`, 'success');
      }
    });
  } catch (error) {
    showMenuToast(error.message || 'Could not start the barcode scanner.', 'error');
  }
}

function updateMenuSelection(itemId, selected) {
  if (isMenuCataloguePosLocked()) return;
  const id = String(itemId || '');
  if (!id) return;
  const selectedIds = new Set(appState.menu.selectedIds || []);

  if (selected) selectedIds.add(id);
  else selectedIds.delete(id);

  appState.menu = {
    ...appState.menu,
    selectedIds: [...selectedIds]
  };
  renderApp();
}

function updateAllMenuSelection(itemIds = [], selected) {
  if (isMenuCataloguePosLocked()) return;
  const nextIds = new Set(appState.menu.selectedIds || []);
  itemIds.forEach((id) => {
    if (!id) return;
    if (selected) nextIds.add(String(id));
    else nextIds.delete(String(id));
  });

  appState.menu = {
    ...appState.menu,
    selectedIds: [...nextIds]
  };
  renderApp();
}

function openMenuEditor(itemId) {
  if (isMenuCataloguePosLocked()) return showMenuPosLockToast();
  const item = getMenuItemById(itemId);
  if (!item) {
    showMenuToast('Menu item could not be found.', 'error');
    return;
  }

  appState.menu = {
    ...appState.menu,
    editingItem: {
      ...item,
      __priceLocationId: '',
      __globalSellingPrice: Number(item.sellingPrice || 0) || 0
    },
    actionError: ''
  };
  renderApp();
}

function updateMenuPriceLocation(locationId = '') {
  if (!appState.menu.editingItem) return;
  const current = appState.menu.editingItem;
  const selectedLocationId = String(locationId || '').trim();
  const globalPrice = Number(current.__globalSellingPrice ?? current.sellingPrice ?? 0) || 0;
  const locationPrice = selectedLocationId
    ? Number(current.locationPrices?.[selectedLocationId]?.sellingPrice ?? globalPrice) || 0
    : globalPrice;
  appState.menu = {
    ...appState.menu,
    editingItem: {
      ...current,
      __priceLocationId: selectedLocationId,
      __priceDropdownOpen: false,
      sellingPrice: locationPrice
    }
  };
  renderApp();
}

function toggleMenuPriceLocationDropdown() {
  if (!appState.menu.editingItem) return;
  appState.menu = {
    ...appState.menu,
    editingItem: {
      ...appState.menu.editingItem,
      __priceDropdownOpen: !appState.menu.editingItem.__priceDropdownOpen
    }
  };
  renderApp();
}

function closeMenuEditor() {
  appState.menu = {
    ...appState.menu,
    editingItem: null,
    actionStatus: '',
    actionError: ''
  };
  renderApp();
}

function isMenuCataloguePosLocked() {
  return appState.menu?.posIntegration?.active === true;
}

function showMenuPosLockToast(message = '') {
  const label = String(appState.menu?.posIntegration?.label || 'POS').trim() || 'POS';
  showMenuToast(message || `${label} is connected, so menu catalogue items must be managed in the POS.`, 'warning');
}

async function openMenuCategoryManager() {
  if (isMenuCataloguePosLocked()) return showMenuPosLockToast('Menu categories are managed in the POS while the integration is active.');
  appState.menu = {
    ...appState.menu,
    categoryManager: {
      ...(appState.menu.categoryManager || {}),
      open: true,
      status: 'loading',
      error: ''
    }
  };
  renderApp();

  try {
    const { fetchStock } = await import('./services/stockService.js');
    const stock = await fetchStock(appState.workspace?.id);
    appState.menu = {
      ...appState.menu,
      categoryManager: {
        ...(appState.menu.categoryManager || {}),
        open: true,
        status: 'ready',
        items: stock.categories || [],
        draftName: '',
        editingName: '',
        editingValue: '',
        error: ''
      }
    };
    renderApp();
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      categoryManager: {
        ...(appState.menu.categoryManager || {}),
        open: true,
        status: 'error',
        error: error.message || 'Could not load stock categories.'
      }
    };
    renderApp();
  }
}

function closeMenuCategoryManager() {
  appState.menu = {
    ...appState.menu,
    categoryManager: {
      open: false,
      status: 'idle',
      items: [],
      draftName: '',
      editingName: '',
      editingValue: '',
      error: ''
    }
  };
  renderApp();
}

function updateMenuCategoryDraft(value) {
  appState.menu = {
    ...appState.menu,
    categoryManager: {
      ...(appState.menu.categoryManager || {}),
      draftName: String(value || ''),
      error: ''
    }
  };
  renderApp();
}

function startMenuCategoryRename(name) {
  appState.menu = {
    ...appState.menu,
    categoryManager: {
      ...(appState.menu.categoryManager || {}),
      editingName: String(name || ''),
      editingValue: String(name || ''),
      error: ''
    }
  };
  renderApp();
}

function updateMenuCategoryEditing(value) {
  appState.menu = {
    ...appState.menu,
    categoryManager: {
      ...(appState.menu.categoryManager || {}),
      editingValue: String(value || ''),
      error: ''
    }
  };
  renderApp();
}

function cancelMenuCategoryRename() {
  appState.menu = {
    ...appState.menu,
    categoryManager: {
      ...(appState.menu.categoryManager || {}),
      editingName: '',
      editingValue: '',
      error: ''
    }
  };
  renderApp();
}

async function createMenuCategory() {
  if (isMenuCataloguePosLocked()) return showMenuPosLockToast('Menu categories are managed in the POS while the integration is active.');
  const name = String(appState.menu.categoryManager?.draftName || '').trim();
  if (!name) {
    appState.menu = {
      ...appState.menu,
      categoryManager: {
        ...(appState.menu.categoryManager || {}),
        error: 'Enter a category name first.'
      }
    };
    renderApp();
    return;
  }

  appState.menu = {
    ...appState.menu,
    categoryManager: {
      ...(appState.menu.categoryManager || {}),
      status: 'saving',
      error: ''
    }
  };
  renderApp();

  try {
    const { createStockCategory } = await import('./services/stockService.js');
    await createStockCategory(appState.workspace?.id, name);
    await openMenuCategoryManager();
    showMenuToast(`Category ${name} created.`, 'success');
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      categoryManager: {
        ...(appState.menu.categoryManager || {}),
        status: 'ready',
        error: error.message || 'Could not create category.'
      }
    };
    renderApp();
  }
}

async function saveMenuCategoryRename() {
  if (isMenuCataloguePosLocked()) return showMenuPosLockToast('Menu categories are managed in the POS while the integration is active.');
  const currentName = String(appState.menu.categoryManager?.editingName || '').trim();
  const nextName = String(appState.menu.categoryManager?.editingValue || '').trim();
  if (!currentName || !nextName) return;

  appState.menu = {
    ...appState.menu,
    categoryManager: {
      ...(appState.menu.categoryManager || {}),
      status: 'saving',
      error: ''
    }
  };
  renderApp();

  try {
    const { renameStockCategory } = await import('./services/stockService.js');
    await renameStockCategory(appState.workspace?.id, currentName, nextName);
    await openMenuCategoryManager();
    showMenuToast(`Category renamed to ${nextName}.`, 'success');
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      categoryManager: {
        ...(appState.menu.categoryManager || {}),
        status: 'ready',
        error: error.message || 'Could not rename category.'
      }
    };
    renderApp();
  }
}

async function deleteMenuCategory(name) {
  if (isMenuCataloguePosLocked()) return showMenuPosLockToast('Menu categories are managed in the POS while the integration is active.');
  const category = String(name || '').trim();
  if (!category) return;

  appState.menu = {
    ...appState.menu,
    categoryManager: {
      ...(appState.menu.categoryManager || {}),
      status: 'saving',
      error: ''
    }
  };
  renderApp();

  try {
    const { deleteStockCategory } = await import('./services/stockService.js');
    await deleteStockCategory(appState.workspace?.id, category);
    await openMenuCategoryManager();
    showMenuToast(`Category ${category} deleted.`, 'success');
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      categoryManager: {
        ...(appState.menu.categoryManager || {}),
        status: 'ready',
        error: error.message || 'Could not delete category.'
      }
    };
    renderApp();
  }
}

async function saveMenuItem(itemId, updates) {
  if (isMenuCataloguePosLocked()) return showMenuPosLockToast();
  const item = appState.menu.editingItem || getMenuItemById(itemId);
  if (!item) {
    showMenuToast('Menu item could not be found.', 'error');
    return;
  }

  appState.menu = {
    ...appState.menu,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { updateMenuItem } = await import('./services/menuService.js');
    const priceLocationId = String(updates.priceLocationId || '').trim();
    const locationPrices = updates.locationPrices && typeof updates.locationPrices === 'object'
      ? updates.locationPrices
      : (item.locationPrices || {});
    await updateMenuItem(item.id, {
      name: String(updates.name || '').trim(),
      category: String(updates.category || 'General').trim() || 'General',
      sellingPrice: priceLocationId ? Number(item.__globalSellingPrice ?? item.sellingPrice ?? 0) || 0 : Number(updates.sellingPrice || 0),
      locationPrices,
      barcodes: parseBarcodeInput(updates.barcodes),
      workspaceId: appState.workspace?.id
    }, {
      workspaceId: appState.workspace?.id,
      source: item.source
    });

    appState.menu = {
      ...appState.menu,
      editingItem: null,
      actionStatus: '',
      actionError: ''
    };
    showMenuToast('Menu item updated.', 'success');
    await refreshActiveTabFromApi();
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      actionStatus: '',
      actionError: error.message || 'Could not update menu item.'
    };
    renderApp();
  }
}

function requestMenuDelete(payload = {}) {
  if (isMenuCataloguePosLocked()) return showMenuPosLockToast();
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return;

  appState.menu = {
    ...appState.menu,
    confirmDelete: {
      ids,
      mode: payload.mode || (ids.length > 1 ? 'bulk' : 'single')
    }
  };
  renderApp();
}

function cancelMenuDelete() {
  appState.menu = {
    ...appState.menu,
    confirmDelete: null,
    actionStatus: '',
    actionError: ''
  };
  renderApp();
}

async function confirmMenuDelete() {
  if (isMenuCataloguePosLocked()) return showMenuPosLockToast();
  const confirmDelete = appState.menu.confirmDelete;
  const ids = confirmDelete?.ids || [];
  if (!ids.length) return;

  const items = ids.map((id) => getMenuItemById(id)).filter(Boolean);
  if (!items.length) {
    cancelMenuDelete();
    showMenuToast('Selected menu items could not be found.', 'error');
    return;
  }

  const deletedIds = new Set(items.map((item) => String(item.id)));
  const previousMenuItems = appState.menu.items || [];
  const previousRecipeDeleteState = {
    items: appState.recipes.items || [],
    selectedIds: appState.recipes.selectedIds || [],
    editingItem: appState.recipes.editingItem,
    draftRecipe: appState.recipes.draftRecipe
  };
  appState.menu = {
    ...appState.menu,
    items: removeMenuRowsByIdentity(removeRowsByIds(appState.menu.items, deletedIds), items),
    selectedIds: (appState.menu.selectedIds || []).filter((id) => !deletedIds.has(String(id))),
    actionStatus: 'deleting',
    actionError: ''
  };
  appState.recipes = {
    ...appState.recipes,
    items: removeMenuRowsByIdentity(removeRowsByIds(appState.recipes.items, deletedIds), items),
    selectedIds: (appState.recipes.selectedIds || []).filter((id) => !deletedIds.has(String(id))),
    editingItem: deletedIds.has(String(appState.recipes.editingItem?.id || '')) ? null : appState.recipes.editingItem,
    draftRecipe: deletedIds.has(String(appState.recipes.editingItem?.id || '')) ? [] : appState.recipes.draftRecipe
  };
  renderApp();

  try {
    const { deleteMenuItem, deleteMultipleMenuItems, fetchMenuItems } = await import('./services/menuService.js');
    let deleteResult = null;
    let deleteError = null;
    if (items.length === 1) {
      try {
        deleteResult = await deleteMenuItem(items[0].id, {
          workspaceId: appState.workspace?.id,
          source: items[0].source,
          item: items[0]
        });
      } catch (error) {
        deleteError = error;
      }
    } else {
      try {
        deleteResult = await deleteMultipleMenuItems(items, {
          workspaceId: appState.workspace?.id
        });
      } catch (error) {
        deleteError = error;
      }
    }

    let refreshedItems = null;
    let remainingDeletedIds = [];
    try {
      refreshedItems = await fetchMenuItems(appState.workspace?.id, { cacheBust: true });
      const stillVisibleIds = new Set(refreshedItems.map((item) => String(item.id)));
      remainingDeletedIds = [...deletedIds].filter((id) => stillVisibleIds.has(id));
    } catch (refreshError) {
      console.warn('[MenuDelete] Delete succeeded but refresh failed', refreshError);
    }

    if (deleteError && remainingDeletedIds.length) {
      appState.menu = {
        ...appState.menu,
        items: refreshedItems || previousMenuItems,
        confirmDelete: null,
        actionStatus: '',
        actionError: deleteError.message || 'Could not delete menu items.'
      };
      appState.recipes = {
        ...appState.recipes,
        ...previousRecipeDeleteState
      };
      renderApp();
      showMenuToast(deleteError.message || 'Could not delete menu items.', 'error');
      return;
    }

    appState.menu = {
      ...appState.menu,
      items: refreshedItems
        ? removeMenuRowsByIdentity(removeRowsByIds(refreshedItems, deletedIds), items)
        : removeMenuRowsByIdentity(removeRowsByIds(appState.menu.items, deletedIds), items),
      selectedIds: (appState.menu.selectedIds || []).filter((id) => !deletedIds.has(String(id))),
      confirmDelete: null,
      actionStatus: '',
      actionError: '',
      source: refreshedItems ? 'Live catalogue' : appState.menu.source,
      updatedAt: refreshedItems ? new Date().toISOString() : appState.menu.updatedAt
    };
    if (deleteError) {
      console.warn('[MenuDelete] Delete request failed, but API refresh no longer returns the item ids', deleteError);
    }
    if (remainingDeletedIds.length) {
      console.warn('[MenuDelete] API refresh still returned deleted item ids', {
        workspaceId: appState.workspace?.id,
        deletedIds: [...deletedIds],
        remainingDeletedIds,
        deletedCount: Number(deleteResult?.deletedCount ?? items.length)
      });
    }
    const deletedCount = Number(deleteResult?.deletedCount || items.length);
    const toastMessage = items.length === 1
      ? `Menu item deleted${deletedCount > 1 ? ` (${deletedCount} duplicate rows cleared)` : ''}.`
      : `${items.length} menu items deleted${deletedCount > items.length ? ` (${deletedCount} duplicate rows cleared)` : ''}.`;
    showMenuToast(toastMessage, 'success');
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      items: previousMenuItems,
      actionStatus: '',
      actionError: error.message || 'Could not delete menu items.'
    };
    appState.recipes = {
      ...appState.recipes,
      ...previousRecipeDeleteState
    };
    renderApp();
  }
}

async function importMenuFile(file) {
  if (isMenuCataloguePosLocked()) return showMenuPosLockToast();
  if (!file) return;

  appState.menu = {
    ...appState.menu,
    actionStatus: 'importing',
    actionError: ''
  };
  renderApp();

  try {
    const rows = await parseDataFile(file, { preferredSheetNames: ['Menu_Import'] });
    const { items, review } = mapLegacyMenuRows(rows);

    if (!items.length) {
      throw new Error(formatImportFailure('No valid menu catalogue rows were found in this file.', review.errors));
    }

    const { importMenuItems } = await import('./services/menuService.js');
    const result = await importMenuItems(appState.workspace?.id, items);

    appState.menu = {
      ...appState.menu,
      actionStatus: '',
      actionError: ''
    };
    const skippedCount = Number(review.errors.length || result.skippedCount || 0);
    if (skippedCount) {
      showImportNotification({
        moduleLabel: 'Menu Import',
        title: 'Menu Import Needs Attention',
        message: `${result.importedCount || 0} item${Number(result.importedCount || 0) === 1 ? '' : 's'} imported, but ${skippedCount} row${skippedCount === 1 ? '' : 's'} need fixing. Confirm this message, fix the errors, and try again.`,
        errors: review.errors,
        importedCount: result.importedCount || 0,
        skippedCount,
        totalRows: review.totalRows,
        tone: 'warning',
        confirmLabel: 'Confirm & Fix Errors'
      });
    } else {
      showMenuToast(`Menu Catalogue imported (${result.importedCount} item${result.importedCount === 1 ? '' : 's'} syncing to cloud).`, 'success');
    }
  } catch (error) {
    appState.menu = {
      ...appState.menu,
      actionStatus: '',
      actionError: ''
    };
    showImportNotification({
      moduleLabel: 'Menu Import',
      title: 'Menu Import Failed',
      message: `${error.message || 'Menu import failed.'} Confirm this message, fix the file, and try again.`,
      errors: [error.message || 'Menu import failed.'],
      tone: 'error',
      confirmLabel: 'Confirm & Try Again'
    });
  }
}

async function exportMenuCatalogue(format = 'csv') {
  if (String(format || '').startsWith('template-')) {
    await exportMenuTemplate(String(format).replace('template-', '') || 'csv');
    return;
  }

  const items = getFilteredMenuItems(appState.menu.items || [], appState.menu.filters || {});

  if (!items.length) {
    showMenuToast('No filtered menu items are available to export.', 'warning');
    return;
  }

  const rows = buildMenuCatalogueRows(items);

  try {
    await exportObjectRows({
      format,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Menu Catalogue Export' }),
      sheetName: 'Menu Catalogue',
      title: 'Menu Catalogue',
      subtitle: `${appState.workspace?.siteName || 'KCP'} · ${items.length} filtered item${items.length === 1 ? '' : 's'}`,
      rows,
      columns: exportSchemas.menu,
      branding: getPdfBranding()
    });
    showMenuToast(`${items.length} filtered menu items exported as ${format.toUpperCase()}.`, 'success');
  } catch (error) {
    showMenuToast(error.message || 'Menu export failed.', 'error');
  }
}

async function exportMenuTemplate(format = 'csv') {
  const normalizedFormat = ['csv', 'xlsx', 'pdf'].includes(format) ? format : 'csv';

  try {
    await exportObjectRows({
      format: normalizedFormat,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Menu Catalogue Template Export' }),
      sheetName: 'Menu_Import',
      title: 'Menu Catalogue Import Template',
      subtitle: 'Use these columns for menu product import and export parity.',
      rows: buildTemplateRows(exportSchemas.menu),
      columns: exportSchemas.menu,
      branding: getPdfBranding()
    });
    showMenuToast(`Menu template exported as ${normalizedFormat.toUpperCase()}.`, 'success');
  } catch (error) {
    showMenuToast(error.message || 'Menu template export failed.', 'error');
  }
}

function dismissMenuToast() {
  if (menuToastTimer) {
    window.clearTimeout(menuToastTimer);
    menuToastTimer = null;
  }

  appState.menu = {
    ...appState.menu,
    toast: null
  };
  renderApp();
}

function updateRecipeFilters(nextFilters) {
  appState.recipes = {
    ...appState.recipes,
    filters: {
      ...appState.recipes.filters,
      ...nextFilters
    },
    pendingFocus: nextFilters?.ingredientQuery !== undefined ? { type: 'search' } : appState.recipes.pendingFocus
  };
  renderApp();
}

async function refreshRecipeNoteSuggestions(options = {}) {
  const includeIgnored = options.includeIgnored ?? appState.recipes.noteSuggestions?.includeIgnored ?? false;
  appState.recipes = {
    ...appState.recipes,
    noteSuggestions: {
      ...(appState.recipes.noteSuggestions || {}),
      status: 'loading',
      includeIgnored,
      error: ''
    }
  };
  renderApp();
  try {
    const { fetchModifierNoteSuggestions } = await import('./services/recipeService.js');
    const response = await fetchModifierNoteSuggestions(appState.workspace?.id, {
      includeIgnored,
      cacheBust: true
    });
    appState.recipes = {
      ...appState.recipes,
      noteSuggestions: {
        ...(appState.recipes.noteSuggestions || {}),
        status: 'ready',
        includeIgnored,
        items: response.suggestions || [],
        error: ''
      }
    };
  } catch (error) {
    appState.recipes = {
      ...appState.recipes,
      noteSuggestions: {
        ...(appState.recipes.noteSuggestions || {}),
        status: 'error',
        includeIgnored,
        error: error.message || 'Could not load suggestions from orders.'
      }
    };
  }
  renderApp();
}

function openRecipeNoteSuggestions() {
  appState.recipes = {
    ...appState.recipes,
    filters: { ...appState.recipes.filters, openDropdown: '' },
    noteSuggestions: {
      ...(appState.recipes.noteSuggestions || {}),
      open: true,
      error: ''
    }
  };
  renderApp();
  if (!['ready', 'loading'].includes(appState.recipes.noteSuggestions?.status)) {
    refreshRecipeNoteSuggestions();
  }
}

function closeRecipeNoteSuggestions() {
  appState.recipes = {
    ...appState.recipes,
    noteSuggestions: {
      ...(appState.recipes.noteSuggestions || {}),
      open: false,
      editingId: '',
      draft: null,
      error: ''
    }
  };
  renderApp();
}

function startRecipeNoteRuleSetup(suggestionId = '') {
  const suggestion = (appState.recipes.noteSuggestions?.items || [])
    .find((entry) => String(entry.id) === String(suggestionId));
  if (!suggestion) return;
  const existing = suggestion.rule || {};
  const actionType = String(existing.actionType || 'NO_STOCK_CHANGE').toUpperCase();
  appState.recipes = {
    ...appState.recipes,
    noteSuggestions: {
      ...(appState.recipes.noteSuggestions || {}),
      editingId: suggestion.id,
      error: '',
      draft: {
        noteText: suggestion.notePhrase || suggestion.normalizedText || '',
        normalizedText: suggestion.normalizedText || '',
        actionType,
        targetOwnerType: String(existing.targetOwnerType || (actionType === 'ADD_RECIPE' ? 'product' : actionType === 'ADD_STOCK_ITEM' ? 'stock_item' : '')),
        targetOwnerId: String(existing.targetOwnerId || ''),
        sourceStockItemId: String(existing.sourceStockItemId || ''),
        replacementStockItemId: String(existing.replacementStockItemId || ''),
        quantity: Number(existing.quantity || 1) || 1,
        unit: String(existing.unit || ''),
        menuItemIds: Array.isArray(existing.menuItemIds) && existing.menuItemIds.length
          ? existing.menuItemIds.map(String)
          : (suggestion.menuItemIds || []).map(String),
        locationIds: Array.isArray(existing.locationIds) && existing.locationIds.length
          ? existing.locationIds.map(String)
          : (suggestion.locationIds || []).map(String)
      }
    }
  };
  renderApp();
}

function cancelRecipeNoteRuleSetup() {
  appState.recipes = {
    ...appState.recipes,
    noteSuggestions: {
      ...(appState.recipes.noteSuggestions || {}),
      editingId: '',
      draft: null,
      error: ''
    }
  };
  renderApp();
}

function updateRecipeNoteRuleDraft(patch = {}) {
  const current = appState.recipes.noteSuggestions?.draft;
  if (!current) return;
  const next = { ...current, ...patch };
  if (patch.actionType) {
    const actionType = String(patch.actionType).toUpperCase();
    next.actionType = actionType;
    next.targetOwnerType = actionType === 'ADD_RECIPE'
      ? 'product'
      : actionType === 'ADD_STOCK_ITEM'
        ? 'stock_item'
        : '';
    next.targetOwnerId = '';
    next.sourceStockItemId = '';
    next.replacementStockItemId = '';
  }
  appState.recipes = {
    ...appState.recipes,
    noteSuggestions: {
      ...(appState.recipes.noteSuggestions || {}),
      draft: next,
      error: ''
    }
  };
  renderApp();
}

async function saveRecipeNoteRule() {
  const noteState = appState.recipes.noteSuggestions || {};
  const draft = noteState.draft;
  if (!draft?.noteText) return;
  const actionType = String(draft.actionType || '').toUpperCase();
  const targetRequired = ['ADD_RECIPE', 'ADD_STOCK_ITEM'].includes(actionType);
  const sourceRequired = ['REMOVE_INGREDIENT', 'REPLACE_INGREDIENT'].includes(actionType);
  const replacementRequired = actionType === 'REPLACE_INGREDIENT';
  if (!actionType || (targetRequired && !draft.targetOwnerId) || (sourceRequired && !draft.sourceStockItemId) || (replacementRequired && !draft.replacementStockItemId)) {
    appState.recipes = {
      ...appState.recipes,
      noteSuggestions: {
        ...noteState,
        error: 'Complete the stock action before saving.'
      }
    };
    renderApp();
    return;
  }

  appState.recipes = {
    ...appState.recipes,
    noteSuggestions: { ...noteState, status: 'saving', error: '' }
  };
  renderApp();
  try {
    const { saveModifierNoteRule } = await import('./services/recipeService.js');
    await saveModifierNoteRule(appState.workspace?.id, draft.noteText, {
      actionType,
      targetOwnerType: draft.targetOwnerType || '',
      targetOwnerId: draft.targetOwnerId || '',
      sourceStockItemId: draft.sourceStockItemId || '',
      replacementStockItemId: draft.replacementStockItemId || '',
      quantity: Math.max(0.000001, Number(draft.quantity || 1) || 1),
      unit: draft.unit || '',
      menuItemIds: Array.isArray(draft.menuItemIds) ? draft.menuItemIds : [],
      locationIds: Array.isArray(draft.locationIds) ? draft.locationIds : [],
      applyAllMatchingProducts: !Array.isArray(draft.menuItemIds) || draft.menuItemIds.length === 0,
      active: true
    });
    appState.recipes = {
      ...appState.recipes,
      noteSuggestions: {
        ...(appState.recipes.noteSuggestions || {}),
        editingId: '',
        draft: null,
        status: 'ready',
        error: ''
      }
    };
    await refreshRecipeNoteSuggestions();
    showRecipeToast('Note rule approved. Exact matching notes can now affect stock.', 'success');
  } catch (error) {
    appState.recipes = {
      ...appState.recipes,
      noteSuggestions: {
        ...(appState.recipes.noteSuggestions || {}),
        status: 'error',
        error: error.message || 'Could not save the note rule.'
      }
    };
    renderApp();
  }
}

async function setRecipeNoteSuggestionDisposition(noteText = '', disposition = 'IGNORED') {
  const noteState = appState.recipes.noteSuggestions || {};
  appState.recipes = {
    ...appState.recipes,
    noteSuggestions: { ...noteState, status: 'saving', error: '' }
  };
  renderApp();
  try {
    const service = await import('./services/recipeService.js');
    if (disposition === 'SUGGESTED') {
      await service.restoreModifierNoteSuggestion(appState.workspace?.id, noteText);
    } else {
      await service.ignoreModifierNoteSuggestion(appState.workspace?.id, noteText);
    }
    await refreshRecipeNoteSuggestions();
  } catch (error) {
    appState.recipes = {
      ...appState.recipes,
      noteSuggestions: {
        ...(appState.recipes.noteSuggestions || {}),
        status: 'error',
        error: error.message || 'Could not update the note suggestion.'
      }
    };
    renderApp();
  }
}

function toggleRecipeIgnoredNoteSuggestions(includeIgnored = false) {
  refreshRecipeNoteSuggestions({ includeIgnored: Boolean(includeIgnored) });
}

async function scanRecipeIngredientBarcode(target = 'ingredient') {
  const isRecipeSearch = target === 'recipe';

  try {
    const { openBarcodeScanner } = await import('./services/barcodeScanner.js');
    await openBarcodeScanner({
      title: isRecipeSearch ? 'Scan Recipe Barcode' : 'Scan Stock Item Barcode',
      helper: isRecipeSearch
        ? 'Scan a menu item barcode to filter the recipe list.'
        : 'Scan a stock item barcode to find the ingredient.',
      onScan: (code) => {
        const barcode = String(code || '').trim();
        if (!barcode) return;
        appState.recipes = {
          ...appState.recipes,
          filters: {
            ...appState.recipes.filters,
            ...(isRecipeSearch
              ? { query: barcode, openDropdown: '' }
                : {
                  ingredientQuery: barcode,
                  ingredientCategory: '',
                  ingredientType: '',
                  ingredientCategoryDropdownSearch: '',
                  openDropdown: ''
                })
          },
          pendingFocus: isRecipeSearch ? null : { type: 'search' }
        };
        showRecipeToast(`Barcode ${barcode} loaded into ${isRecipeSearch ? 'recipe' : 'ingredient'} search.`, 'success');
      }
    });
  } catch (error) {
    showRecipeToast(error.message || 'Could not start the barcode scanner.', 'error');
  }
}

async function scanPurchaseOrderBarcode() {
  try {
    const { openBarcodeScanner } = await import('./services/barcodeScanner.js');
    await openBarcodeScanner({
      title: 'Scan Purchase Order Barcode',
      helper: 'Scan a stock item barcode to filter the purchase order stock picker.',
      onScan: (code) => {
        const barcode = String(code || '').trim();
        if (!barcode) return;
        appState.purchaseOrders = {
          ...appState.purchaseOrders,
          filters: {
            ...appState.purchaseOrders.filters,
            lineQuery: barcode,
            openDropdown: ''
          }
        };
        renderApp();
        showPurchaseOrderToast(`Barcode ${barcode} loaded into purchase order stock search.`, 'success');
      }
    });
  } catch (error) {
    showPurchaseOrderToast(error.message || 'Could not start the purchase order barcode scanner.', 'error');
  }
}

async function scanAdjustmentBarcode() {
  try {
    const { openBarcodeScanner } = await import('./services/barcodeScanner.js');
    await openBarcodeScanner({
      title: 'Scan Adjustment Barcode',
      helper: 'Scan a stock item barcode to filter the adjustment stock picker.',
      onScan: (code) => {
        const barcode = String(code || '').trim();
        if (!barcode) return;
        appState.adjustments = {
          ...appState.adjustments,
          filters: {
            ...appState.adjustments.filters,
            adjustmentWorkflow: 'bulk',
            overlay: 'stock',
            stockSearch: barcode,
            stockPage: 1,
            selectedStockIds: [],
            openDropdown: ''
          }
        };
        renderApp();
        showAdjustmentToast(`Barcode ${barcode} loaded into adjustment stock search.`, 'success');
      }
    });
  } catch (error) {
    showAdjustmentToast(error.message || 'Could not start the adjustment barcode scanner.', 'error');
  }
}

async function scanGrvBarcode() {
  try {
    const { openBarcodeScanner } = await import('./services/barcodeScanner.js');
    await openBarcodeScanner({
      title: 'Scan GRV Stock Barcode',
      helper: 'Scan a stock barcode to filter the GRV stock picker.',
      onScan: (code) => {
        const barcode = String(code || '').trim();
        if (!barcode) return;
        ensureGrvDraft();
        appState.grv = {
          ...appState.grv,
          filters: {
            ...appState.grv.filters,
            overlay: 'stock',
            lineQuery: barcode,
            selectedStockIds: [],
            calendarCursor: '',
            openDropdown: ''
          }
        };
        renderApp();
        showGrvToast(`Barcode ${barcode} loaded into GRV stock search.`, 'success');
      }
    });
  } catch (error) {
    showGrvToast(error.message || 'Could not start the GRV barcode scanner.', 'error');
  }
}

function updateRecipeSelection(itemId, selected) {
  const id = String(itemId || '');
  if (!id) return;
  const selectedIds = new Set(appState.recipes.selectedIds || []);

  if (selected) selectedIds.add(id);
  else selectedIds.delete(id);

  appState.recipes = {
    ...appState.recipes,
    selectedIds: [...selectedIds]
  };
  renderApp();
}

function updateAllRecipeSelection(itemIds = [], selected) {
  const selectedIds = new Set(appState.recipes.selectedIds || []);
  itemIds.forEach((id) => {
    if (!id) return;
    if (selected) selectedIds.add(String(id));
    else selectedIds.delete(String(id));
  });

  appState.recipes = {
    ...appState.recipes,
    selectedIds: [...selectedIds]
  };
  renderApp();
}

function openRecipeEditor(itemId) {
  const item = getRecipeItemById(itemId);
  if (!item) {
    showRecipeToast('Recipe item could not be found.', 'error');
    return;
  }

  appState.recipes = {
    ...appState.recipes,
    editingItem: item,
    draftRecipe: structuredCloneSafe(item.recipe || []),
    pickerOpen: false,
    pickerStep: 'select',
    pickerSelectedIds: [],
    pickerQuantities: {},
    modifierStockPicker: null,
    confirmLineRemoval: null,
    filters: {
      ...appState.recipes.filters,
      ingredientQuery: '',
      ingredientCategory: '',
      ingredientType: '',
      ingredientCategoryDropdownSearch: '',
      modifierStockRuleOpen: false,
      openDropdown: ''
    },
    pendingFocus: null,
    modalFocusRequest: `${String(item.id || itemId)}:${Date.now()}`,
    pendingOpenItemId: '',
    pendingOpenItemName: '',
    actionError: ''
  };
  renderApp();
  focusRecipeModalViewport();
}

function openRecipeSetupFromMenu(itemId) {
  const target = normalizeRecipeOpenTarget(itemId);
  if (!target.id && !target.name) return;
  // Prefer a match in the already-loaded recipes list so we can open the editor
  // immediately. Previously this only set pendingOpenItemId and relied on the NEXT
  // recipes snapshot to open the modal — if no snapshot fired (recipes already
  // loaded), the "Add Recipe" action appeared to do nothing.
  const recipeItem = findRecipeItemForTarget(appState.recipes.items || [], target);
  const fallbackItem = recipeItem
    || findRecipeItemForTarget(appState.menu.items || [], target);
  const id = String(recipeItem?.id || fallbackItem?.id || target.id || '').trim();
  const name = String(recipeItem?.name || fallbackItem?.name || target.name || '').trim();

  if (recipeItem) {
    // Open the editor now (mirrors openRecipeEditor). The next recipes snapshot
    // preserves editingItem by matching its id in the items list.
    appState.recipes = {
      ...appState.recipes,
      editingItem: recipeItem,
      draftRecipe: structuredCloneSafe(recipeItem.recipe || []),
      pickerOpen: false,
      pickerStep: 'select',
      pickerSelectedIds: [],
      pickerQuantities: {},
      modifierStockPicker: null,
      confirmLineRemoval: null,
      pendingOpenItemId: '',
      pendingOpenItemName: '',
      pendingFocus: null,
      modalFocusRequest: `${id || name}:${Date.now()}`,
      actionError: ''
    };
    navigateTo('recipes');
    focusRecipeModalViewport();
    return;
  }

  // Not in the recipes list yet (e.g. a menu-only product) — set the pending target
  // so the recipes subscription opens the editor once its data arrives.
  appState.recipes = {
    ...appState.recipes,
    pendingOpenItemId: id,
    pendingOpenItemName: name,
    pendingFocus: null,
    actionError: ''
  };
  navigateTo('recipes');
}

function closeRecipeEditor() {
  appState.recipes = {
    ...appState.recipes,
    editingItem: null,
    draftRecipe: [],
    pickerOpen: false,
    pickerStep: 'select',
    pickerSelectedIds: [],
    pickerQuantities: {},
    modifierStockPicker: null,
    confirmLineRemoval: null,
    pendingFocus: null,
    modalFocusRequest: '',
    actionStatus: '',
    actionError: '',
    filters: {
      ...appState.recipes.filters,
      modifierStockRuleOpen: false,
      openDropdown: ''
    }
  };
  renderApp();
}

function updateRecipeLine(index, qty) {
  const nextRecipe = [...(appState.recipes.draftRecipe || [])];
  if (!nextRecipe[index]) return;
  const normalizedQuantity = normalizeRecipeQtyInput(qty);
  nextRecipe[index] = {
    ...nextRecipe[index],
    // Keep both legacy and canonical fields in lockstep. Existing recipe rows
    // can contain both keys, and a stale `quantity` used to override an edited
    // `qty` when the payload reached the Worker.
    qty: normalizedQuantity,
    quantity: normalizedQuantity
  };
  appState.recipes = {
    ...appState.recipes,
    draftRecipe: nextRecipe,
    pendingFocus: null
  };
  renderApp();
}

function updatePickerUom(ingId, unit) {
  appState.recipes = {
    ...appState.recipes,
    pickerUoms: { ...(appState.recipes.pickerUoms || {}), [String(ingId)]: String(unit || '') }
  };
  renderApp();
}

function updateRecipeLineUom(index, unit) {
  const nextRecipe = [...(appState.recipes.draftRecipe || [])];
  if (!nextRecipe[index]) return;
  nextRecipe[index] = { ...nextRecipe[index], unit: String(unit || '').trim() };
  appState.recipes = { ...appState.recipes, draftRecipe: nextRecipe, pendingFocus: null };
  renderApp();
}

function removeRecipeLine(index) {
  const line = appState.recipes.draftRecipe?.[index];
  if (!line) return;
  const targetId = String(line.ingId || '').trim();
  const ingredient = (appState.recipes.ingredients || []).find((item) => {
    if (String(item.id) === targetId) return true;
    const mergedIds = String(item.mergedIds || '').split(',').map((v) => v.trim()).filter(Boolean);
    return mergedIds.includes(targetId);
  });

  appState.recipes = {
    ...appState.recipes,
    confirmLineRemoval: {
      index,
      name: ingredient?.name || line.ingId || 'this ingredient'
    },
    actionError: '',
    pendingFocus: null
  };
  renderApp();
}

function cancelRecipeLineRemoval() {
  appState.recipes = {
    ...appState.recipes,
    confirmLineRemoval: null,
    actionError: ''
  };
  renderApp();
}

function confirmRecipeLineRemoval() {
  const index = Number(appState.recipes.confirmLineRemoval?.index);
  if (!Number.isInteger(index)) {
    cancelRecipeLineRemoval();
    return;
  }

  appState.recipes = {
    ...appState.recipes,
    draftRecipe: (appState.recipes.draftRecipe || []).filter((_, lineIndex) => lineIndex !== index),
    confirmLineRemoval: null,
    pendingFocus: null,
    actionError: ''
  };
  renderApp();
}

function normalizeRecipeQtyInput(value) {
  const raw = String(value ?? '');
  const cleaned = raw
    .replace(/[^\d,.]/g, '')
    .replace(/([,.].*)[,.]/g, '$1');
  return cleaned;
}

function parseDecimalInputValue(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const normalized = raw
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Module-level alias used by GRV, purchase order, and pack-size helpers
const parseDecimal = parseDecimalInputValue;

function formatNumber(value) {
  const number = Number(value || 0) || 0;
  return new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: Number.isInteger(number) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(number);
}

// ZAR currency formatter used by the live DOM writes (stock-take impact/total,
// wastage cost cell). Mirrors the component-local formatCurrency so the values
// written while a text input is focused (renderApp suppressed) match what the
// full re-render produces on blur. Was previously referenced but never defined,
// which threw a ReferenceError and blocked stock-take Impact/Commit updates.
function formatCurrency(value) {
  const amount = Number(value || 0) || 0;
  return `R ${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function focusRecipeSearch() {
  appState.recipes = {
    ...appState.recipes,
    pendingFocus: { type: 'search' }
  };
  renderApp();
}

function addRecipeIngredient(ingredientId, qty = 0) {
  const id = String(ingredientId || '');
  const quantity = parseDecimalInputValue(qty, 0);
  if (!id) {
    appState.recipes = {
      ...appState.recipes,
      actionError: 'Select a stock item to add to this recipe.'
    };
    renderApp();
    return;
  }

  const draft = [...(appState.recipes.draftRecipe || [])];
  const existingIndex = draft.findIndex((line) => String(line.ingId) === id);
  let focusIndex = existingIndex;
  if (existingIndex >= 0) {
    const nextQuantity = parseDecimalInputValue(
      draft[existingIndex].qty ?? draft[existingIndex].quantity,
      0
    ) + quantity;
    draft[existingIndex] = {
      ...draft[existingIndex],
      qty: nextQuantity,
      quantity: nextQuantity
    };
  } else {
    draft.push({ ingId: id, stockItemId: id, qty: quantity, quantity });
    focusIndex = draft.length - 1;
  }

  appState.recipes = {
    ...appState.recipes,
    draftRecipe: draft,
    filters: {
      ...appState.recipes.filters,
      ingredientQuery: '',
      ingredientCategory: '',
      ingredientType: '',
      ingredientCategoryDropdownSearch: ''
    },
    pendingFocus: { type: 'quantity', index: focusIndex },
    actionError: ''
  };
  renderApp();
}

function openRecipeIngredientPicker() {
  if (!appState.recipes.editingItem) return;

  appState.recipes = {
    ...appState.recipes,
    pickerOpen: true,
    pickerStep: 'select',
    pickerSelectedIds: [],
    pickerQuantities: {},
    filters: {
      ...appState.recipes.filters,
      ingredientQuery: '',
      ingredientCategory: '',
      ingredientType: '',
      ingredientCategoryDropdownSearch: '',
      openDropdown: ''
    },
    pendingFocus: { type: 'search' },
    actionError: ''
  };
  renderApp();
}

function closeRecipeIngredientPicker() {
  appState.recipes = {
    ...appState.recipes,
    pickerOpen: false,
    pickerStep: 'select',
    pickerSelectedIds: [],
    pickerQuantities: {},
    filters: {
      ...appState.recipes.filters,
      ingredientQuery: '',
      ingredientCategory: '',
      ingredientType: '',
      ingredientCategoryDropdownSearch: '',
      openDropdown: ''
    },
    pendingFocus: null,
    actionError: ''
  };
  renderApp();
}

function toggleRecipePickerItem(ingredientId, selected) {
  const id = String(ingredientId || '');
  if (!id) return;
  const selectedIds = new Set(appState.recipes.pickerSelectedIds || []);
  const quantities = { ...(appState.recipes.pickerQuantities || {}) };

  if (selected) {
    selectedIds.add(id);
    if (quantities[id] === undefined) quantities[id] = 0;
  } else {
    selectedIds.delete(id);
    delete quantities[id];
  }

  appState.recipes = {
    ...appState.recipes,
    pickerSelectedIds: [...selectedIds],
    pickerQuantities: quantities,
    actionError: ''
  };
  renderApp();
}

function selectAllVisibleRecipePickerItems(ingredientIds = []) {
  const selectedIds = new Set(appState.recipes.pickerSelectedIds || []);
  const quantities = { ...(appState.recipes.pickerQuantities || {}) };
  ingredientIds.filter(Boolean).forEach((id) => {
    const key = String(id);
    selectedIds.add(key);
    if (quantities[key] === undefined) quantities[key] = 0;
  });

  appState.recipes = {
    ...appState.recipes,
    pickerSelectedIds: [...selectedIds],
    pickerQuantities: quantities,
    actionError: ''
  };
  renderApp();
}

function clearRecipePickerSelection() {
  appState.recipes = {
    ...appState.recipes,
    pickerSelectedIds: [],
    pickerQuantities: {},
    actionError: ''
  };
  renderApp();
}

function confirmRecipePickerSelection() {
  const selectedIds = appState.recipes.pickerSelectedIds || [];
  if (!selectedIds.length) {
    appState.recipes = {
      ...appState.recipes,
      actionError: 'Select at least one stock item before confirming.'
    };
    renderApp();
    return;
  }

  const firstId = String(selectedIds[0] || '');
  const quantities = { ...(appState.recipes.pickerQuantities || {}) };
  selectedIds.forEach((id) => {
    const key = String(id);
    if (quantities[key] === undefined) quantities[key] = 0;
  });

  appState.recipes = {
    ...appState.recipes,
    pickerStep: 'quantity',
    pickerQuantities: quantities,
    pendingFocus: firstId ? { type: 'pickerQuantity', id: firstId } : null,
    actionError: ''
  };
  renderApp();
}

function backToRecipePickerSelection() {
  appState.recipes = {
    ...appState.recipes,
    pickerStep: 'select',
    pendingFocus: { type: 'search' },
    actionError: ''
  };
  renderApp();
}

function updateRecipePickerQuantity(ingredientId, qty) {
  const id = String(ingredientId || '');
  if (!id) return;
  const normalizedQty = normalizeRecipeQtyInput(qty);

  appState.recipes = {
    ...appState.recipes,
    pickerQuantities: {
      ...(appState.recipes.pickerQuantities || {}),
      [id]: normalizedQty
    },
    pendingFocus: { type: 'pickerQuantity', id },
    actionError: ''
  };
  renderApp();
}

function linkedProductIdsFromRecipeItem(item = {}) {
  if (Array.isArray(item.linkedProductIds)) return item.linkedProductIds.map(String).filter(Boolean);
  const raw = String(item.linkedProductId || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {}
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function mergeRecipeLinesByIngredient(recipeSets = []) {
  const linesByIngredient = new Map();
  recipeSets.flat().forEach((line) => {
    const ingId = String(line.ingId || line.stockItemId || '').trim();
    if (!ingId) return;
    const current = linesByIngredient.get(ingId);
    const qty = parseDecimalInputValue(line.qty ?? line.quantity, 0);
    if (current) {
      current.qty = parseDecimalInputValue(current.qty, 0) + qty;
      current.quantity = parseDecimalInputValue(current.quantity ?? current.qty, 0) + qty;
      return;
    }
    linesByIngredient.set(ingId, {
      ...line,
      ingId,
      qty,
      quantity: qty
    });
  });
  return [...linesByIngredient.values()];
}

function isRecipeModifierItem(item = {}) {
  return item.recipeOwnerType === 'yoco_modifier' || String(item.id || '').startsWith('modifier:');
}

function updateRecipeModifierProductLink(productIds = []) {
  const item = appState.recipes.editingItem;
  if (!item || item.recipeOwnerType !== 'yoco_modifier') return;
  const requestedIds = Array.isArray(productIds) ? productIds : [productIds];
  const linkedProductIds = [...new Set(requestedIds.map((entry) => String(entry || '').trim()).filter(Boolean))];
  const products = linkedProductIds
    .map((linkedProductId) => (appState.recipes.items || []).find((entry) => String(entry.id) === linkedProductId && entry.recipeOwnerType !== 'yoco_modifier'))
    .filter(Boolean);
  const productRecipe = products.length
    ? mergeRecipeLinesByIngredient(products.map((product) => structuredCloneSafe(product.recipe || [])))
    : null;
  const nextDraftRecipe = productRecipe || [];
  const linkedProductName = products.map((product) => product.name || '').filter(Boolean).join(', ');

  appState.recipes = {
    ...appState.recipes,
    editingItem: {
      ...item,
      linkedProductId: linkedProductIds.length === 1 ? linkedProductIds[0] : linkedProductIds.join(','),
      linkedProductIds,
      linkedProductName,
      linkedProductNames: products.map((product) => product.name || '').filter(Boolean),
      linkedProductRecipeCount: productRecipe ? productRecipe.length : 0,
      recipeSource: linkedProductIds.length && productRecipe?.length ? 'linked_product' : nextDraftRecipe.length ? 'manual_modifier' : 'missing',
      recipe: nextDraftRecipe,
      recipeCount: nextDraftRecipe.length,
      status: nextDraftRecipe.length ? 'complete' : 'missing'
    },
    draftRecipe: nextDraftRecipe,
    pendingFocus: null,
    actionError: ''
  };
	  renderApp();
}


function updateRecipeModifierStockRule(patch = {}) {
  const item = appState.recipes.editingItem;
  if (!item || item.recipeOwnerType !== 'yoco_modifier') return;
  const ownerId = String(item.recipeOwnerId || item.id || '').replace(/^modifier:/, '');
  const fallbackAction = item.recipeCount || linkedProductIdsFromRecipeItem(item).length ? 'ADD_RECIPE' : 'NO_STOCK_CHANGE';
  const current = item.stockRule && typeof item.stockRule === 'object' ? item.stockRule : {};
  const actionType = String(patch.actionType || current.actionType || fallbackAction).toUpperCase();
  const next = {
    ...current,
    actionType,
    targetOwnerType: String(current.targetOwnerType || (actionType === 'ADD_RECIPE' ? 'yoco_modifier' : actionType === 'ADD_STOCK_ITEM' ? 'stock_item' : '')),
    targetOwnerId: String(current.targetOwnerId || (actionType === 'ADD_RECIPE' ? ownerId : '')),
    sourceStockItemId: String(current.sourceStockItemId || ''),
    replacementStockItemId: String(current.replacementStockItemId || ''),
    quantity: Number(current.quantity || 1) || 1,
    unit: String(current.unit || ''),
    menuItemIds: Array.isArray(current.menuItemIds) ? current.menuItemIds.map(String).filter(Boolean) : [],
    locationIds: [],
    applyAllMatchingProducts: current.applyAllMatchingProducts !== false,
    active: current.active !== false,
    sourceModifierId: String(current.sourceModifierId || item.yocoModifierId || ''),
    sourceModifierGroupId: String(current.sourceModifierGroupId || item.yocoModifierGroupId || ''),
    sourceModifierVariantId: String(current.sourceModifierVariantId || item.yocoModifierVariantId || ''),
    sourceName: String(current.sourceName || item.name || ''),
    ...patch
  };

  next.locationIds = [];

  if (actionType === 'ADD_RECIPE') {
    next.targetOwnerType ||= 'yoco_modifier';
    next.targetOwnerId ||= ownerId;
  }
  if (actionType === 'ADD_STOCK_ITEM') next.targetOwnerType = 'stock_item';
  if (next.applyAllMatchingProducts) next.menuItemIds = [];

  appState.recipes = {
    ...appState.recipes,
    editingItem: {
      ...item,
      stockRule: next
    },
    actionError: ''
  };
  renderApp();
}

function openRecipeModifierStockPicker(mode = '') {
  if (!appState.recipes.editingItem) return;
  appState.recipes = {
    ...appState.recipes,
    modifierStockPicker: { open: true, mode: String(mode || ''), query: '' }
  };
  renderApp();
}

function closeRecipeModifierStockPicker() {
  appState.recipes = { ...appState.recipes, modifierStockPicker: null };
  renderApp();
}

function searchRecipeModifierStockPicker(query = '') {
  appState.recipes = {
    ...appState.recipes,
    modifierStockPicker: {
      ...(appState.recipes.modifierStockPicker || {}),
      open: true,
      query: String(query || '')
    }
  };
  renderApp();
}

function selectRecipeModifierStockPicker(value = '') {
  const mode = String(appState.recipes.modifierStockPicker?.mode || '');
  const raw = String(value || '');
  if (!mode || !raw) return;
  if (mode === 'recipeTarget') {
    const separator = raw.indexOf('|');
    updateRecipeModifierStockRule({
      targetOwnerType: separator >= 0 ? raw.slice(0, separator) : '',
      targetOwnerId: separator >= 0 ? raw.slice(separator + 1) : raw
    });
  } else if (mode === 'stockTarget') {
    const selected = (appState.recipes.ingredients || []).find((entry) => String(entry.id) === raw);
    updateRecipeModifierStockRule({ targetOwnerType: 'stock_item', targetOwnerId: raw, unit: String(selected?.unit || 'ea') });
  } else if (mode === 'source') {
    updateRecipeModifierStockRule({ sourceStockItemId: raw, replacementStockItemId: '', quantity: 1 });
  } else if (mode === 'replacement') {
    updateRecipeModifierStockRule({ replacementStockItemId: raw });
  }
  appState.recipes = { ...appState.recipes, modifierStockPicker: null };
  renderApp();
}

function updateRecipeSourceStockItem(stockItemId = '') {
  const item = appState.recipes.editingItem;
  if (!item || item.recipeOwnerType === 'yoco_modifier') return;
  const id = String(stockItemId || '').trim();
  const stockItem = id
    ? (appState.recipes.ingredients || []).find((entry) => String(entry.id) === id)
    : null;
  const recipeSourceRecipeLines = stockItem ? structuredCloneSafe(stockItem.recipe || stockItem.recipeLines || []) : [];
  const directRecipe = structuredCloneSafe(appState.recipes.draftRecipe || item.recipe || []);
  const hasDirectRecipe = directRecipe.some((line) => String(line.ingId || line.stockItemId || '').trim() && parseDecimalInputValue(line.qty ?? line.quantity, 0) > 0);
  // Only sub-recipe/manufactured stock items build their cost from their OWN recipe lines. A
  // standard, recipe-source, or virtual (non-stock) item's cost comes straight from its unit_cost
  // (see stockCostResolver.js) — it has no BOM of its own by design, so an empty
  // recipeSourceRecipeLines here is expected, not a "missing recipe" error.
  const linkedItemNeedsOwnRecipe = stockItem && ['sub_recipe', 'manufactured'].includes(deriveStockItemType(stockItem));
  const nextStatus = hasDirectRecipe
    ? 'COMPLETE'
    : !stockItem
      ? 'MISSING_RECIPE'
      : (recipeSourceRecipeLines.length || !linkedItemNeedsOwnRecipe)
        ? 'COMPLETE_VIA_LINKED_STOCK_ITEM'
        : 'MISSING_RECIPE';

  appState.recipes = {
    ...appState.recipes,
    editingItem: {
      ...item,
      recipeSourceStockItemId: id,
      recipeSourceStockItem: stockItem ? {
        ...stockItem,
        recipe: recipeSourceRecipeLines,
        recipeLines: recipeSourceRecipeLines,
        recipeCount: recipeSourceRecipeLines.length
      } : null,
      recipeSourceStockItemName: stockItem?.name || '',
      recipeSourceStockItemRecipeCount: recipeSourceRecipeLines.length,
      recipeSourceRecipeLines,
      effectiveRecipe: hasDirectRecipe ? directRecipe : recipeSourceRecipeLines,
      effectiveRecipeLines: hasDirectRecipe ? directRecipe : recipeSourceRecipeLines,
      recipeCount: hasDirectRecipe ? directRecipe.length : recipeSourceRecipeLines.length,
      recipeStatus: nextStatus,
      recipeSource: nextStatus === 'COMPLETE_VIA_LINKED_STOCK_ITEM' ? 'linked_stock_item' : hasDirectRecipe ? 'direct' : 'missing',
      status: nextStatus === 'MISSING_RECIPE' ? 'missing' : 'complete'
    },
    filters: {
      ...appState.recipes.filters,
      recipeSourceStockSearch: '',
      openDropdown: ''
    },
    pendingFocus: null,
    actionError: stockItem && !recipeSourceRecipeLines.length ? 'Linked stock item has no recipe lines.' : ''
  };
  renderApp();
}

function toggleRecipeModifierProductLink(productId = '') {
  const id = String(productId || '').trim();
  if (!id || !appState.recipes.editingItem) return;
  const current = new Set(linkedProductIdsFromRecipeItem(appState.recipes.editingItem));
  if (current.has(id)) current.delete(id);
  else current.add(id);
  updateRecipeModifierProductLink([...current]);
}

function applyRecipePickerSelection() {
  const selectedIds = (appState.recipes.pickerSelectedIds || []).map(String).filter(Boolean);
  if (!selectedIds.length) {
    appState.recipes = {
      ...appState.recipes,
      actionError: 'Select at least one stock item before adding ingredients.'
    };
    renderApp();
    return;
  }

  const quantities = appState.recipes.pickerQuantities || {};
  const invalidIds = selectedIds.filter((id) => parseDecimalInputValue(quantities[id], 0) <= 0);
  if (invalidIds.length) {
    appState.recipes = {
      ...appState.recipes,
      actionError: 'Enter a quantity greater than zero for every selected stock item.'
    };
    renderApp();
    return;
  }

  const draft = [...(appState.recipes.draftRecipe || [])];
  let addedCount = 0;
  let mergedCount = 0;

  const pickerUoms = appState.recipes.pickerUoms || {};
  selectedIds.forEach((id) => {
    const quantity = parseDecimalInputValue(quantities[id], 0);
    const selectedUnit = pickerUoms[id] || '';
    const existingIndex = draft.findIndex((line) => String(line.ingId) === id);

    if (existingIndex >= 0) {
      draft[existingIndex] = {
        ...draft[existingIndex],
        qty: parseDecimalInputValue(draft[existingIndex].qty, 0) + quantity,
        ...(selectedUnit ? { unit: selectedUnit } : {})
      };
      mergedCount += 1;
      return;
    }

    draft.push({ ingId: id, qty: quantity, ...(selectedUnit ? { unit: selectedUnit } : {}) });
    addedCount += 1;
  });

  appState.recipes = {
    ...appState.recipes,
    draftRecipe: draft,
    pickerOpen: false,
    pickerStep: 'select',
    pickerSelectedIds: [],
    pickerQuantities: {},
    pickerUoms: {},
    filters: {
      ...appState.recipes.filters,
      ingredientQuery: '',
      ingredientType: '',
      openDropdown: ''
    },
    pendingFocus: null,
    actionError: ''
  };

  if (!addedCount && mergedCount) {
    showRecipeToast(
      `${mergedCount} ingredient${mergedCount === 1 ? '' : 's'} updated in the staged recipe. Save the recipe to sync changes.`,
      'success'
    );
    return;
  }

  showRecipeToast(
    `${addedCount} ingredient${addedCount === 1 ? '' : 's'} staged${mergedCount ? `; ${mergedCount} existing line${mergedCount === 1 ? '' : 's'} updated` : ''}. Save the recipe to sync changes.`,
    'success'
  );
}

function requestRecipeDelete(payload = {}) {
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return;

  appState.recipes = {
    ...appState.recipes,
    confirmDelete: {
      ids,
      mode: payload.mode || (ids.length > 1 ? 'bulk' : 'single')
    },
    actionError: ''
  };
  renderApp();
}

function cancelRecipeDelete() {
  appState.recipes = {
    ...appState.recipes,
    confirmDelete: null,
    actionStatus: '',
    actionError: ''
  };
  renderApp();
}

async function confirmRecipeDelete() {
  const ids = appState.recipes.confirmDelete?.ids || [];
  if (!ids.length) return;

  const items = ids.map((id) => getRecipeItemById(id)).filter(Boolean);
  if (!items.length) {
    cancelRecipeDelete();
    showRecipeToast('Selected recipes could not be found.', 'error');
    return;
  }

  const productItems = items.filter((item) => !isRecipeModifierItem(item));
  const modifierItems = items.filter(isRecipeModifierItem);
  const productDeletedIds = new Set(productItems.map((item) => String(item.id)));
  const modifierDeletedIds = new Set(modifierItems.map((item) => String(item.id)));
  const affectedIds = new Set([...productDeletedIds, ...modifierDeletedIds]);
  const previousRecipeItems = appState.recipes.items || [];
  const previousMenuItems = appState.menu.items || [];
  const editingItemId = String(appState.recipes.editingItem?.id || '');

  appState.recipes = {
    ...appState.recipes,
    items: removeModifierRowsByIdentity(removeRowsByIds(appState.recipes.items, affectedIds), modifierItems),
    selectedIds: (appState.recipes.selectedIds || []).filter((id) => !affectedIds.has(String(id))),
    editingItem: affectedIds.has(editingItemId) ? null : appState.recipes.editingItem,
    draftRecipe: affectedIds.has(editingItemId) ? [] : appState.recipes.draftRecipe,
    actionStatus: 'deleting',
    actionError: ''
  };
  appState.menu = {
    ...appState.menu,
    items: removeRowsByIds(appState.menu.items, productDeletedIds),
    selectedIds: (appState.menu.selectedIds || []).filter((id) => !productDeletedIds.has(String(id))),
    editingItem: productDeletedIds.has(String(appState.menu.editingItem?.id || '')) ? null : appState.menu.editingItem
  };
  renderApp();

  try {
    let productDeleteError = null;
    let modifierDeleteError = null;
    if (productItems.length) {
      const { deleteMenuItem, deleteMultipleMenuItems } = await import('./services/menuService.js');
      try {
        if (productItems.length === 1) {
          await deleteMenuItem(productItems[0].id, {
            workspaceId: appState.workspace?.id,
            source: productItems[0].source,
            item: productItems[0]
          });
        } else {
          await deleteMultipleMenuItems(productItems, {
            workspaceId: appState.workspace?.id
          });
        }
      } catch (error) {
        productDeleteError = error;
      }
    }

    if (modifierItems.length) {
      const { deleteModifierRecipes } = await import('./services/recipeService.js');
      try {
        await deleteModifierRecipes(appState.workspace?.id, modifierItems);
      } catch (error) {
        modifierDeleteError = error;
      }
    }

    let refreshedRecipeData = null;
    let remainingDeletedIds = [];
    try {
      const { fetchRecipeItems } = await import('./services/recipeService.js');
      refreshedRecipeData = await fetchRecipeItems(appState.workspace?.id, { cacheBust: true });
      const stillVisibleIds = new Set((refreshedRecipeData.items || []).map((item) => String(item.id)));
      remainingDeletedIds = [...affectedIds].filter((id) => stillVisibleIds.has(id));
    } catch (refreshError) {
      console.warn('[RecipeDelete] Delete succeeded but refresh failed', refreshError);
    }

    const blockingError = (productDeleteError || modifierDeleteError) && (!refreshedRecipeData || remainingDeletedIds.length)
      ? productDeleteError || modifierDeleteError
      : null;
    if (blockingError) {
      appState.recipes = {
        ...appState.recipes,
        items: refreshedRecipeData?.items || previousRecipeItems,
        ingredients: refreshedRecipeData?.ingredients || appState.recipes.ingredients,
        locations: refreshedRecipeData?.locations || appState.recipes.locations || [],
        confirmDelete: null,
        actionStatus: '',
        actionError: blockingError.message || 'Could not delete selected recipes.'
      };
      appState.menu = {
        ...appState.menu,
        items: previousMenuItems
      };
      renderApp();
      showRecipeToast(blockingError.message || 'Could not delete selected recipes.', 'error');
      return;
    }

    const nextRecipeItems = refreshedRecipeData?.items
      ? removeModifierRowsByIdentity(removeRowsByIds(refreshedRecipeData.items, affectedIds), modifierItems)
      : removeModifierRowsByIdentity(removeRowsByIds(appState.recipes.items, affectedIds), modifierItems);

    appState.recipes = {
      ...appState.recipes,
      items: nextRecipeItems,
      ingredients: refreshedRecipeData?.ingredients || appState.recipes.ingredients,
      locations: refreshedRecipeData?.locations || appState.recipes.locations || [],
      selectedIds: (appState.recipes.selectedIds || []).filter((id) => !affectedIds.has(String(id))),
      confirmDelete: null,
      actionStatus: '',
      actionError: '',
      editingItem: affectedIds.has(editingItemId) ? null : appState.recipes.editingItem,
      draftRecipe: affectedIds.has(editingItemId) ? [] : appState.recipes.draftRecipe,
      source: refreshedRecipeData ? 'Live catalogue' : appState.recipes.source,
      updatedAt: refreshedRecipeData ? new Date().toISOString() : appState.recipes.updatedAt
    };
    appState.menu = {
      ...appState.menu,
      items: removeRowsByIds(appState.menu.items, productDeletedIds),
      selectedIds: (appState.menu.selectedIds || []).filter((id) => !productDeletedIds.has(String(id))),
      editingItem: productDeletedIds.has(String(appState.menu.editingItem?.id || '')) ? null : appState.menu.editingItem
    };
    if (productDeleteError || modifierDeleteError) {
      console.warn('[RecipeDelete] Delete request failed, but API refresh no longer returns the deleted rows', {
        productDeleteError,
        modifierDeleteError
      });
    }
    if (remainingDeletedIds.length) {
      console.warn('[RecipeDelete] API refresh still returned deleted recipe ids', {
        workspaceId: appState.workspace?.id,
        deletedIds: [...affectedIds],
        remainingDeletedIds
      });
    }
    renderApp();
    showRecipeToast(getRecipeDeleteToast(productItems.length, modifierItems.length), 'success');
  } catch (error) {
    appState.recipes = {
      ...appState.recipes,
      items: previousRecipeItems,
      actionStatus: '',
      actionError: error.message || 'Could not delete selected recipes.'
    };
    appState.menu = {
      ...appState.menu,
      items: previousMenuItems
    };
    renderApp();
  }
}

function getRecipeDeleteToast(productCount = 0, modifierCount = 0) {
  if (productCount && modifierCount) {
    return `${productCount} recipe product${productCount === 1 ? '' : 's'} deleted; ${modifierCount} modifier${modifierCount === 1 ? '' : 's'} deleted.`;
  }
  if (modifierCount) {
    return modifierCount === 1 ? 'Modifier deleted.' : `${modifierCount} modifiers deleted.`;
  }
  return productCount === 1 ? 'Recipe product deleted.' : `${productCount} recipe products deleted.`;
}

async function saveCurrentRecipe() {
  const item = appState.recipes.editingItem;
  if (!item) return;
  if (appState.recipes.actionStatus === 'saving') return;

  // Recipe quantity fields preserve focus while the user types. Release both the live
  // field and its queued focus snapshot before rendering the saving state; otherwise
  // renderApp() can deliberately suppress the completion render and leave the modal
  // showing "Saving" even though the API update succeeded.
  pendingFocusField = null;
  if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  appState.recipes = {
    ...appState.recipes,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Saving Recipe');

  try {
    const { updateRecipe } = await import('./services/recipeService.js');
    await updateRecipe(appState.workspace?.id, item, appState.recipes.draftRecipe || []);
    // Ensure the success render cannot be skipped if focus changed while the request
    // was pending. This render closes the editor and clears its saving state.
    pendingFocusField = null;
    if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    appState.recipes = {
      ...appState.recipes,
      editingItem: null,
      draftRecipe: [],
      pickerOpen: false,
      pickerStep: 'select',
      pickerSelectedIds: [],
      pickerQuantities: {},
      confirmLineRemoval: null,
      actionStatus: '',
      actionError: ''
    };
    showRecipeToast('Recipe Blueprint Saved.', 'success');
    refreshActiveTabFromApi().catch(() => {});
  } catch (error) {
    // Failures must also replace the disabled saving state immediately so the user can
    // correct the recipe and retry without closing or refreshing the module.
    pendingFocusField = null;
    if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    appState.recipes = {
      ...appState.recipes,
      actionStatus: '',
      actionError: error.message || 'Could not save recipe.'
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

async function importRecipeFile(file) {
  if (!file) return;
  appState.recipes = {
    ...appState.recipes,
    actionStatus: 'importing',
    actionError: ''
  };
  renderApp();

  try {
    const rows = await parseDataFile(file, { preferredSheetNames: ['Recipe_Import'] });
    if (!rows.length) {
      throw new Error('The file appears to be empty or could not be read. Make sure you\'re importing a Recipe Import template (.csv or .xlsx) that has been filled out.');
    }
    const { recipes, review, missingIngredients } = mapLegacyRecipeRows(rows);
    if (!recipes.length) {
      const errorDetail = review.errors.length
        ? formatImportErrors(review.errors, 8)
        : 'Make sure the file uses the Recipe Import template with Product_Name, Ingredient_Name, and Quantity_Needed columns. The recipe builder export is not an import template.';
      throw new Error(`No valid recipe rows were found in this file. ${errorDetail}`);
    }

    const { importRecipes } = await import('./services/recipeService.js');
    const result = await importRecipes(appState.workspace?.id, recipes);
    appState.recipes = {
      ...appState.recipes,
      actionStatus: '',
      actionError: ''
    };
    const importErrors = [
      ...(review.errors || []),
      ...((result.errors || []).map((entry) => ({
        code: entry.code || 'ERR_RECIPE_IMPORT',
        row: entry.row || '',
        message: entry.message || 'Recipe row could not be imported.'
      })))
    ];
    const skippedCount = Number(importErrors.length || missingIngredients || result.skippedCount || 0);
    if (skippedCount > 0) {
      showImportNotification({
        moduleLabel: 'Recipe Import',
        title: 'Recipe Import Needs Attention',
        message: `${result.importedCount || 0} recipe${Number(result.importedCount || 0) === 1 ? '' : 's'} imported, but ${skippedCount} row${skippedCount === 1 ? '' : 's'} need fixing. Confirm this message, fix the errors, and try again.`,
        errors: importErrors,
        importedCount: result.importedCount || 0,
        skippedCount,
        totalRows: review.totalRows,
        tone: 'warning',
        confirmLabel: 'Confirm & Fix Errors'
      });
    } else {
      showRecipeToast(`Recipes imported (${result.importedCount} items syncing to cloud).`, 'success');
    }
  } catch (error) {
    appState.recipes = {
      ...appState.recipes,
      actionStatus: '',
      actionError: ''
    };
    showImportNotification({
      moduleLabel: 'Recipe Import',
      title: 'Recipe Import Failed',
      message: `${error.message || 'Recipe import failed.'} Confirm this message, fix the file, and try again.`,
      errors: [error.message || 'Recipe import failed.'],
      tone: 'error',
      confirmLabel: 'Confirm & Try Again'
    });
  }
}

async function exportRecipes(format = 'csv') {
  if (String(format || '').startsWith('template-')) {
    await exportRecipeTemplate(String(format).replace('template-', '') || 'csv');
    return;
  }

  const items = getFilteredRecipeItems(appState.recipes.items || [], appState.recipes.filters || {});
  const ingredients = appState.recipes.ingredients || [];

  if (!items.length) {
    showRecipeToast('No filtered recipes are available to export.', 'warning');
    return;
  }

  const rows = buildRecipeRows(items, ingredients);

  try {
    await exportObjectRows({
      format,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Recipe Export' }),
      sheetName: 'Recipes',
      title: 'Recipes',
      subtitle: `${appState.workspace?.siteName || 'KCP'} · ${items.length} filtered recipe${items.length === 1 ? '' : 's'}`,
      rows,
      columns: exportSchemas.recipes,
      branding: getPdfBranding()
    });
    showRecipeToast(`${items.length} filtered recipes exported as ${format.toUpperCase()}.`, 'success');
  } catch (error) {
    showRecipeToast(error.message || 'Recipe export failed.', 'error');
  }
}

// Shared by exportRecipeTemplate (uses whatever's already loaded in appState.recipes) and the
// onboarding wizard's template download (fetches fresh via recipeService.fetchRecipeItems,
// independent of whether the Recipes tab has ever been opened this session).
//
// Pre-fills Product Name with real, already-synced products that still need a recipe, so the
// import's exact-name-match can't fail on a name the user re-typed from memory. `status ===
// 'missing'` is set by recipeService.js's normalizeRecipeItem for every product with no usable
// recipe yet.
function buildRecipeTemplateExportOptions(items = [], ingredients = []) {
  const products = [...new Set(
    (items || []).map((item) => item.name || '').filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
  const missingRecipeNames = new Set();
  const prefillProducts = (items || [])
    .filter((item) => item.name && String(item.status || '').toLowerCase() === 'missing' && !missingRecipeNames.has(item.name))
    .map((item) => { missingRecipeNames.add(item.name); return { name: item.name, sku: item.sku || '' }; })
    .sort((a, b) => a.name.localeCompare(b.name));
  const ingredientObjects = (ingredients || [])
    .filter((ing) => ing.name)
    .map((ing) => ({
      name: String(ing.name || '').trim(),
      uom: String(ing.uom || ing.unit || '').trim(),
      customUoms: (ing.uomConfigurations || [])
        .map((cfg) => String(cfg.customUom || cfg.custom_uom || '').trim())
        .filter(Boolean)
    }));
  return { products, prefillProducts, ingredientObjects };
}

async function exportRecipeTemplate(format = 'csv') {
  // format may be 'xlsx:sheets', 'xlsx:excel', or just 'xlsx'/'csv'
  const [baseFormat, platform = 'excel'] = String(format || 'csv').split(':');
  const normalizedFormat = ['csv', 'xlsx'].includes(baseFormat) ? baseFormat : 'csv';

  if (normalizedFormat === 'xlsx') {
    try {
      const { products, prefillProducts, ingredientObjects } = buildRecipeTemplateExportOptions(
        appState.recipes.items || [],
        appState.recipes.ingredients || []
      );
      const filename = buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Recipe Template Export' });
      await downloadStyledRecipeTemplateXlsx(filename, { products, ingredientObjects, platform, prefillProducts });
      const prefillNote = prefillProducts.length
        ? ` — pre-filled with ${prefillProducts.length} product${prefillProducts.length === 1 ? '' : 's'} missing a recipe`
        : '';
      showRecipeToast(`Recipe template exported for ${platform === 'sheets' ? 'Google Sheets' : 'Excel'}${prefillNote}.`, 'success');
    } catch (error) {
      showRecipeToast(error.message || 'Recipe template export failed.', 'error');
    }
    return;
  }

  try {
    await exportObjectRows({
      format: normalizedFormat,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Recipe Template Export' }),
      sheetName: 'Recipe_Import',
      title: 'Recipes Import Template',
      subtitle: 'Use Product_Name, Ingredient_Name and Quantity_Needed columns.',
      rows: buildTemplateRows(exportSchemas.recipes),
      columns: exportSchemas.recipes,
      branding: getPdfBranding()
    });
    showRecipeToast(`Recipe template exported as ${normalizedFormat.toUpperCase()}.`, 'success');
  } catch (error) {
    showRecipeToast(error.message || 'Recipe template export failed.', 'error');
  }
}

function dismissRecipeToast() {
  if (recipeToastTimer) {
    window.clearTimeout(recipeToastTimer);
    recipeToastTimer = null;
  }
  appState.recipes = {
    ...appState.recipes,
    toast: null
  };
  renderApp();
}

function updateStockFilters(nextFilters) {
  const normalizedFilters = { ...nextFilters };
  if (Object.prototype.hasOwnProperty.call(normalizedFilters, 'siteId')) {
    normalizedFilters.locationId = '';
  }
  appState.stock = {
    ...appState.stock,
    filters: {
      ...appState.stock.filters,
      ...normalizedFilters
    }
  };
  renderApp();
}

function dismissStockImportReview() {
  appState.stock = {
    ...appState.stock,
    importReview: null
  };
  renderApp();
}

function updateStockSelection(itemId, selected) {
  const id = String(itemId || '');
  if (!id) return;

  const selectedIds = new Set(appState.stock.selectedIds || []);
  if (selected) selectedIds.add(id);
  else selectedIds.delete(id);

  appState.stock = {
    ...appState.stock,
    selectedIds: [...selectedIds]
  };
  renderApp();
}

async function scanStockBarcode() {
  try {
    const { openBarcodeScanner } = await import('./services/barcodeScanner.js');
    await openBarcodeScanner({
      title: 'Scan Stock Barcode',
      helper: 'Scan a stock item barcode to filter the Stock Items list.',
      onScan: (code) => {
        const barcode = String(code || '').trim();
        if (!barcode) return;
        appState.stock = {
          ...appState.stock,
          filters: {
            ...appState.stock.filters,
            query: barcode
          }
        };
        showStockToast(`Barcode ${barcode} loaded into stock search.`, 'success');
      }
    });
  } catch (error) {
    showStockToast(error.message || 'Could not start the barcode scanner.', 'error');
  }
}

function updateAllStockSelection(itemIds = [], selected = false) {
  const selectedIds = new Set(appState.stock.selectedIds || []);
  itemIds.forEach((id) => {
    if (!id) return;
    if (selected) selectedIds.add(String(id));
    else selectedIds.delete(String(id));
  });

  appState.stock = {
    ...appState.stock,
    selectedIds: [...selectedIds]
  };
  renderApp();
}

function openStockEditor(itemId) {
  const item = itemId ? getStockItemById(itemId) : {};
  if (!item) {
    showStockToast('Stock item could not be found.', 'error');
    return;
  }
  const editableItem = {
    ...item,
    barcodes: parseBarcodeValues(item.barcodes ?? item.barcode ?? item.Barcodes ?? item.Barcode),
    __openStockSections: itemId ? [] : ['details']
  };

  appState.stock = {
    ...appState.stock,
    editingItem: editableItem,
    actionError: ''
  };
  renderApp();
}

function normalizeStockDraftRecipe(recipe = []) {
  const lines = Array.isArray(recipe)
    ? recipe
    : Object.values(recipe && typeof recipe === 'object' ? recipe : {});

  return lines
    .map((line = {}) => ({
      ingId: String(line.ingId || line.ingredientId || line.stockItemId || line.id || '').trim(),
      qty: Number(String(line.qty ?? line.quantity ?? 0).replace(',', '.')) || 0,
      name: String(line.name || line.ingredientName || '').trim(),
      unit: String(line.unit || line.uom || '').trim()
    }))
    .filter((line) => line.ingId);
}

function openStockRecipeScreen() {
  if (!appState.stock.editingItem) return;
  appState.stock = {
    ...appState.stock,
    editingItem: {
      ...appState.stock.editingItem,
      __dirty: true,
      __priceModalOpen: false,
      __recipeScreenOpen: true,
      __recipeSearch: appState.stock.editingItem.__recipeSearch || ''
    }
  };
  renderApp();
}

function closeStockRecipeScreen() {
  if (!appState.stock.editingItem) return;
  appState.stock = {
    ...appState.stock,
    editingItem: {
      ...appState.stock.editingItem,
      __recipeScreenOpen: false
    }
  };
  renderApp();
}

function updateStockRecipeSearch(value) {
  if (!appState.stock.editingItem) return;
  appState.stock = {
    ...appState.stock,
    editingItem: {
      ...appState.stock.editingItem,
      __recipeSearch: String(value || '')
    }
  };
}

function addStockRecipeLine(itemId) {
  if (!appState.stock.editingItem) return;
  const ingredientId = String(itemId || '').trim();
  const current = appState.stock.editingItem;
  if (!ingredientId || ingredientId === String(current.id || '')) return;

  const ingredient = (appState.stock.items || []).find((item) => String(item?.id || '') === ingredientId);
  if (!ingredient) {
    showStockToast('Stock item could not be found.', 'error');
    return;
  }
  if (isNonStockRecipeIngredient(ingredient)) {
    showStockToast('Non-stock items can be counted, but they cannot be assigned as recipe ingredients.', 'warning');
    return;
  }

  const recipe = normalizeStockDraftRecipe(current.recipe);
  if (recipe.some((line) => String(line.ingId) === ingredientId)) return;

  appState.stock = {
    ...appState.stock,
    editingItem: {
      ...current,
      __dirty: true,
      __recipeSearch: '',
      recipe: [
        ...recipe,
        {
          ingId: ingredientId,
          qty: 0,
          name: ingredient.name || '',
          unit: ingredient.unit || ''
        }
      ]
    }
  };
  renderApp();
}

function isNonStockRecipeIngredient(item = {}) {
  const type = String(item.itemType || item.stockItemType || item.specificationType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['recipe_source', 'non_stock', 'virtual'].includes(type)) return true;
  const category = String(item.category || '').toLowerCase();
  return category.includes('recipe source') || category.includes('non-stock') || category.includes('non stock') || category.includes('virtual');
}

function removeStockRecipeLine(index) {
  if (!appState.stock.editingItem) return;
  const recipe = normalizeStockDraftRecipe(appState.stock.editingItem.recipe);
  const targetIndex = Number(index);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= recipe.length) return;

  appState.stock = {
    ...appState.stock,
    editingItem: {
      ...appState.stock.editingItem,
      __dirty: true,
      recipe: recipe.filter((_, lineIndex) => lineIndex !== targetIndex)
    }
  };
  renderApp();
}

function updateStockRecipeLineQty(index, value) {
  if (!appState.stock.editingItem) return;
  const recipe = normalizeStockDraftRecipe(appState.stock.editingItem.recipe);
  const targetIndex = Number(index);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= recipe.length) return;

  const qty = Number(String(value || 0).replace(',', '.')) || 0;
  appState.stock = {
    ...appState.stock,
    editingItem: {
      ...appState.stock.editingItem,
      __dirty: true,
      recipe: recipe.map((line, lineIndex) => (
        lineIndex === targetIndex ? { ...line, qty } : line
      ))
    }
  };
}

function closeStockEditor() {
  appState.stock = {
    ...appState.stock,
    editingItem: null,
    lookupPicker: createStockLookupPickerState(),
    actionStatus: '',
    actionError: ''
  };
  renderApp();
}

function openStockLookupPicker(field) {
  if (!isSupportedStockLookupField(field) || !appState.stock.editingItem) return;
  appState.stock = {
    ...appState.stock,
    lookupPicker: {
      open: true,
      field,
      query: ''
    }
  };
  renderApp();
}

function updateStockLookupField(field, value) {
  if (!isSupportedStockLookupField(field) || !appState.stock.editingItem) return;
  const nextValue = String(value || '');
  const currentConfirmed = appState.stock.editingItem.__confirmedLookups || {};
  const nextConfirmed = { ...currentConfirmed };
  if (normalizeStockLookupValue(nextConfirmed[field]) !== normalizeStockLookupValue(nextValue)) {
    delete nextConfirmed[field];
  }

  appState.stock = {
    ...appState.stock,
    actionError: '',
    editingItem: {
      ...appState.stock.editingItem,
      [field]: nextValue,
      __dirty: true,
      __confirmedLookups: nextConfirmed,
      __activeLookupField: field
    }
  };
}

function closeStockLookupPicker() {
  appState.stock = {
    ...appState.stock,
    lookupPicker: createStockLookupPickerState()
  };
  renderApp();
}

function updateStockLookupPickerQuery(value) {
  appState.stock = {
    ...appState.stock,
    lookupPicker: {
      ...(appState.stock.lookupPicker || createStockLookupPickerState()),
      query: String(value || '')
    }
  };
  renderApp();
}

function useStockLookupPickerValue(field, value) {
  if (!isSupportedStockLookupField(field) || !appState.stock.editingItem) return;
  const nextValue = String(value || '').trim();
  appState.stock = {
    ...appState.stock,
    editingItem: {
      ...appState.stock.editingItem,
      [field]: nextValue,
      __dirty: true,
      __activeLookupField: '',
      __confirmedLookups: {
        ...(appState.stock.editingItem.__confirmedLookups || {}),
        [field]: nextValue
      }
    },
    lookupPicker: createStockLookupPickerState()
  };
  renderApp();
}

function updateStockDraftField(field, value) {
  if (!appState.stock.editingItem) return;
  const key = String(field || '').trim();
  if (!key) return;

  const current = appState.stock.editingItem;
  const nextItem = {
    ...current,
    __dirty: true,
    [key]: key === 'barcodes' ? parseBarcodeValues(value) : value
  };

  if (key === 'itemType') {
    const nextType = String(value || 'standard').trim() || 'standard';
    nextItem.itemType = nextType;
    nextItem.isManufactured = nextType === 'manufactured';
    if (nextType !== 'sub_recipe') nextItem.isSubRecipe = false;
    if (nextType === 'sub_recipe') nextItem.isSubRecipe = true;
    nextItem.isStocked = nextType !== 'sub_recipe';
  }

  if (key === 'cost') {
    nextItem.cost = value;
  }

  appState.stock = {
    ...appState.stock,
    actionError: '',
    editingItem: nextItem
  };
}

function toggleStockEditorSection(sectionId) {
  if (!appState.stock.editingItem) return;
  const current = appState.stock.editingItem;
  const fallbackOpenSections = current.id ? [] : ['details'];
  const openSections = new Set((Array.isArray(current.__openStockSections)
    ? current.__openStockSections
    : fallbackOpenSections).map(String));
  const normalizedSectionId = String(sectionId || '').trim();
  if (!normalizedSectionId) return;
  if (openSections.has(normalizedSectionId)) openSections.delete(normalizedSectionId);
  else openSections.add(normalizedSectionId);
  appState.stock = {
    ...appState.stock,
    editingItem: {
      ...current,
      __openStockSections: [...openSections]
    }
  };
  renderApp();
}

function openStockTaxonomyManager() {
  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      open: true,
      status: '',
      error: ''
    }
  };
  renderApp();
}

function closeStockTaxonomyManager() {
  appState.stock = {
    ...appState.stock,
    manager: createStockManagerState()
  };
  renderApp();
}

function updateStockTaxonomyDraft(type, value) {
  if (!isSupportedStockTaxonomyType(type)) return;
  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      error: '',
      [type]: {
        ...(appState.stock.manager?.[type] || createStockManagerPanelState()),
        draftValue: String(value || '')
      }
    }
  };
  renderApp();
}

function updateStockTaxonomySearch(type, value) {
  if (!isSupportedStockTaxonomyType(type)) return;
  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      error: '',
      [type]: {
        ...(appState.stock.manager?.[type] || createStockManagerPanelState()),
        searchValue: String(value || '')
      }
    }
  };
  renderApp();
}

function startStockTaxonomyRename(type, name) {
  if (!isSupportedStockTaxonomyType(type)) return;
  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      error: '',
      [type]: {
        ...(appState.stock.manager?.[type] || createStockManagerPanelState()),
        editingName: String(name || ''),
        editingValue: String(name || '')
      }
    }
  };
  renderApp();
}

function updateStockTaxonomyEditing(type, value) {
  if (!isSupportedStockTaxonomyType(type)) return;
  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      error: '',
      [type]: {
        ...(appState.stock.manager?.[type] || createStockManagerPanelState()),
        editingValue: String(value || '')
      }
    }
  };
  renderApp();
}

function cancelStockTaxonomyRename(type) {
  if (!isSupportedStockTaxonomyType(type)) return;
  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      error: '',
      [type]: {
        ...(appState.stock.manager?.[type] || createStockManagerPanelState()),
        editingName: '',
        editingValue: ''
      }
    }
  };
  renderApp();
}

function openStockTaxonomyPicker(type) {
  if (!isSupportedStockTaxonomyType(type)) return;
  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      picker: {
        open: true,
        type,
        query: ''
      }
    }
  };
  renderApp();
}

function closeStockTaxonomyPicker() {
  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      picker: {
        ...(appState.stock.manager?.picker || {}),
        open: false,
        query: ''
      }
    }
  };
  renderApp();
}

function updateStockTaxonomyPickerQuery(value) {
  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      picker: {
        ...(appState.stock.manager?.picker || {}),
        query: String(value || '')
      }
    }
  };
  renderApp();
}

function useStockTaxonomyPickerValue(type, value) {
  if (!isSupportedStockTaxonomyType(type)) return;
  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      picker: {
        ...(appState.stock.manager?.picker || {}),
        open: false,
        query: ''
      },
      [type]: {
        ...(appState.stock.manager?.[type] || createStockManagerPanelState()),
        draftValue: String(value || '')
      }
    }
  };
  renderApp();
}

async function saveStockItem(item) {
  const uomConfigError = getStockUomConfigurationError(item.uomConfigurations || []);
  if (uomConfigError) {
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: uomConfigError
    };
    renderApp();
    return;
  }

  const duplicateNameError = getDuplicateStockItemNameError(item, appState.stock.items || []);
  if (duplicateNameError) {
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: duplicateNameError
    };
    renderApp();
    return;
  }

  appState.stock = {
    ...appState.stock,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Saving Stock Item');

  try {
    const { upsertStockItem } = await import('./services/stockService.js');
    await upsertStockItem(appState.workspace?.id, {
      ...item,
      cost: Number(item.cost || 0) || 0,
      id: item.id || undefined
    });
    // Same staleness guard as delete — a save must invalidate any in-flight background
    // stock fetch so it can't overwrite the freshly-saved state with pre-save data.
    stockMutationToken += 1;
    appState.stock = {
      ...appState.stock,
      editingItem: null,
      actionStatus: '',
      actionError: ''
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showStockToast('Stock item saved.', 'success');
  } catch (error) {
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: error.message || 'Could not save stock item.'
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

function getDuplicateStockItemNameError(item = {}, stockItems = []) {
  const nextName = String(item.name || '').trim();
  const nextKey = normalizeStockItemDuplicateName(nextName);
  if (!nextKey) return '';

  const currentIds = new Set(
    String(item.id || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );

  // Only block the save if the NAME is actually changing. Some workspaces already have
  // pre-existing items that share a name but differ by UOM (e.g. imported from a POS
  // catalogue). Re-checking uniqueness on every save — including saves that only touch
  // UOM, cost, category, etc. — would permanently block editing those items. Comparing
  // against the item's own currently-saved name lets those records keep being edited.
  if (currentIds.size) {
    const original = (stockItems || []).find((entry = {}) => {
      const entryIds = String(entry.mergedIds || entry.id || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      return entryIds.some((id) => currentIds.has(id));
    });
    if (original && normalizeStockItemDuplicateName(original.name) === nextKey) return '';
  }

  const duplicate = (stockItems || []).find((entry = {}) => {
    if (normalizeStockItemDuplicateName(entry.name) !== nextKey) return false;
    const entryIds = String(entry.mergedIds || entry.id || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (!currentIds.size) return true;
    return !entryIds.some((id) => currentIds.has(id));
  });

  return duplicate
    ? `A stock item named "${nextName}" already exists. Stock item names must be unique.`
    : '';
}

function normalizeStockItemDuplicateName(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getStockUomConfigurationError(configurations = []) {
  const rows = Array.isArray(configurations) ? configurations : [];
  const invalid = rows.find((entry) => {
    const customUom = String(entry?.customUom || entry?.custom_uom || '').trim();
    const barcode = String(entry?.barcode || '').trim();
    const ratio = Number(entry?.ratio || 0);
    return (customUom || ratio || barcode) && (!customUom || !Number.isFinite(ratio) || ratio <= 0);
  });
  return invalid ? 'Enter a custom UOM and a ratio greater than zero before saving a UOM barcode, or leave UOM Configuration blank.' : '';
}

async function deleteStockCategory(categoryName) {
  const category = String(categoryName || '').trim();
  if (!category) return;

  appState.stock = {
    ...appState.stock,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { deleteStockCategory: removeStockCategory } = await import('./services/stockService.js');
    await removeStockCategory(appState.workspace?.id, category);
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: ''
    };
    showStockToast(`Category ${category} deleted.`, 'success');
  } catch (error) {
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: error.message || 'Could not delete stock category.'
    };
    renderApp();
  }
}

async function createStockTaxonomyEntry(type) {
  if (!isSupportedStockTaxonomyType(type)) return;
  const config = getStockTaxonomyConfig(type);
  const name = String(appState.stock.manager?.[type]?.draftValue || '').trim();
  if (!name) {
    appState.stock = {
      ...appState.stock,
      manager: {
        ...appState.stock.manager,
        error: `Enter a ${config.label.toLowerCase()} name first.`
      }
    };
    renderApp();
    return;
  }

  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      status: 'saving',
      error: ''
    }
  };
  renderApp();

  try {
    const service = await import('./services/stockService.js');
    await service[config.createMethod](appState.workspace?.id, name);
    appState.stock = {
      ...appState.stock,
      manager: {
        ...appState.stock.manager,
        status: '',
        error: '',
        [type]: {
          ...(appState.stock.manager?.[type] || createStockManagerPanelState()),
          draftValue: ''
        }
      }
    };
    renderApp();
    showStockToast(`${config.label} ${name} created.`, 'success');
  } catch (error) {
    appState.stock = {
      ...appState.stock,
      manager: {
        ...appState.stock.manager,
        status: '',
        error: error.message || `Could not create ${config.label.toLowerCase()}.`
      }
    };
    renderApp();
  }
}

async function saveStockTaxonomyRename(type) {
  if (!isSupportedStockTaxonomyType(type)) return;
  const config = getStockTaxonomyConfig(type);
  const currentName = String(appState.stock.manager?.[type]?.editingName || '').trim();
  const nextName = String(appState.stock.manager?.[type]?.editingValue || '').trim();
  if (!currentName || !nextName) return;

  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      status: 'saving',
      error: ''
    }
  };
  renderApp();

  try {
    const service = await import('./services/stockService.js');
    await service[config.renameMethod](appState.workspace?.id, currentName, nextName);
    appState.stock = {
      ...appState.stock,
      manager: {
        ...appState.stock.manager,
        status: '',
        error: '',
        [type]: {
          ...(appState.stock.manager?.[type] || createStockManagerPanelState()),
          editingName: '',
          editingValue: ''
        }
      }
    };
    renderApp();
    showStockToast(`${config.label} renamed to ${nextName}.`, 'success');
  } catch (error) {
    appState.stock = {
      ...appState.stock,
      manager: {
        ...appState.stock.manager,
        status: '',
        error: error.message || `Could not rename ${config.label.toLowerCase()}.`
      }
    };
    renderApp();
  }
}

async function deleteStockTaxonomyEntry(type, name) {
  if (!isSupportedStockTaxonomyType(type)) return;
  const config = getStockTaxonomyConfig(type);
  const target = String(name || '').trim();
  if (!target) return;

  appState.stock = {
    ...appState.stock,
    manager: {
      ...appState.stock.manager,
      status: 'saving',
      error: ''
    }
  };
  renderApp();

  try {
    const service = await import('./services/stockService.js');
    await service[config.deleteMethod](appState.workspace?.id, target);
    appState.stock = {
      ...appState.stock,
      manager: {
        ...appState.stock.manager,
        status: '',
        error: ''
      }
    };
    renderApp();
    showStockToast(`${config.label} ${target} deleted.`, 'success');
  } catch (error) {
    const message = error.message || `Could not delete ${config.label.toLowerCase()}.`;
    appState.stock = {
      ...appState.stock,
      manager: {
        ...appState.stock.manager,
        status: '',
        error: message
      }
    };
    renderApp();
    showStockToast(message, 'warning');
  }
}

async function requestStockDelete(payload) {
  const ids = Array.isArray(payload?.ids)
    ? payload.ids.map(String).filter(Boolean)
    : [String(payload || '')].filter(Boolean);
  const items = ids.map((id) => getStockItemById(id)).filter(Boolean);
  if (!items.length) {
    showStockToast('Stock item could not be found.', 'error');
    return;
  }

  const count = items.length;
  const title = count === 1
    ? `Delete ${items[0].name || 'stock item'}?`
    : `Delete ${count} stock items?`;
  const confirmed = await showBrandConfirmDialog({
    eyebrow: count === 1 ? 'Delete Stock Item' : 'Delete Selected Stock Items',
    title,
    message: `This removes ${count === 1 ? 'the stock item' : `${count} stock items`}. Existing historical logs remain untouched.`,
    confirmLabel: count === 1 ? 'Delete Item' : 'Delete Items',
    tone: 'danger'
  });
  if (!confirmed) return;

  appState.stock = {
    ...appState.stock,
    confirmDelete: {
      ids: items.map((item) => item.id),
      items,
      mode: payload?.mode || (items.length > 1 ? 'bulk' : 'single'),
      handledByBrandDialog: true
    },
    actionError: ''
  };
  await confirmStockDelete();
}

function cancelStockDelete() {
  appState.stock = {
    ...appState.stock,
    confirmDelete: null,
    actionStatus: '',
    actionError: ''
  };
  renderApp();
}

async function confirmStockDelete() {
  const ids = appState.stock.confirmDelete?.ids || [];
  if (!ids.length) return;
  const items = ids.map((id) => getStockItemById(id)).filter(Boolean);
  if (!items.length) {
    cancelStockDelete();
    showStockToast('Selected stock items could not be found.', 'error');
    return;
  }

  appState.stock = {
    ...appState.stock,
    actionStatus: 'deleting',
    actionError: ''
  };
  renderApp();

  try {
    const { deleteStockItem, deleteMultipleStockItems, resolveStockItemPersistedIds } = await import('./services/stockService.js');
    // A displayed row can stand for several database rows: dedupeStockItems merges items sharing
    // name+category+unit and keeps the group in `mergedIds`. Deleting only the primary id left the
    // siblings active, so the next refresh rebuilt the merged row and the item reappeared. Delete
    // every id the row represents.
    const targetIds = [...new Set(items.flatMap((item) => resolveStockItemPersistedIds(item)))];
    if (!targetIds.length) {
      appState.stock = { ...appState.stock, confirmDelete: null, actionStatus: '', actionError: '' };
      renderApp();
      showStockToast('Selected stock items could not be found.', 'error');
      return;
    }
    if (targetIds.length === 1) {
      await deleteStockItem(appState.workspace?.id, targetIds[0]);
    } else {
      await deleteMultipleStockItems(appState.workspace?.id, targetIds);
    }
    // Invalidate any stock fetch that was already in flight before this delete completed —
    // it captured pre-delete data and would otherwise reintroduce the deleted item when it
    // resolves (see refreshStockFromDataVersion / applyRealtimeSnapshot).
    stockMutationToken += 1;
    // Prune local state by every deleted id AND by the visible row ids, since merged rows are keyed
    // in state by their primary id.
    const deletedIds = new Set([...targetIds, ...items.map((item) => String(item.id))].map(String));
    appState.stock = {
      ...appState.stock,
      items: removeRowsByIds(appState.stock.items, deletedIds),
      selectedIds: (appState.stock.selectedIds || []).filter((id) => !deletedIds.has(String(id))),
      confirmDelete: null,
      actionStatus: '',
      actionError: '',
      editingItem: deletedIds.has(String(appState.stock.editingItem?.id || '')) ? null : appState.stock.editingItem
    };
    appState.manufacturing = {
      ...appState.manufacturing,
      manufacturedItems: removeRowsByIds(appState.manufacturing.manufacturedItems, deletedIds),
      stockItems: removeRowsByIds(appState.manufacturing.stockItems, deletedIds),
      blueprintDraft: deletedIds.has(String(appState.manufacturing.blueprintDraft?.id || '')) ? null : appState.manufacturing.blueprintDraft
    };
    appState.recipes = {
      ...appState.recipes,
      ingredients: removeRowsByIds(appState.recipes.ingredients, deletedIds)
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showStockToast(items.length === 1 ? 'Stock item deleted.' : `${items.length} stock items deleted.`, 'success');
  } catch (error) {
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: error.message || 'Could not delete stock item.'
    };
    renderApp();
  }
}

function requestResetStockTotals(mode = 'reporting_stock') {
  if (!isCurrentSuperUser()) {
    appState.settings = {
      ...appState.settings,
      actionError: 'Only super users can reset reporting or stock totals.'
    };
    renderApp();
    return;
  }
  const resetMode = mode === 'reporting' || mode === 'dashboard' ? 'reporting' : 'reporting_stock';
  appState.settings = {
    ...appState.settings,
    confirmResetTotals: { mode: resetMode, confirmText: '' },
    actionError: ''
  };
  renderApp();
}

function updateResetTotalsConfirmText(value = '') {
  if (!appState.settings.confirmResetTotals) return;
  const confirmText = String(value || '');
  appState.settings = {
    ...appState.settings,
    confirmResetTotals: {
      ...appState.settings.confirmResetTotals,
      confirmText
    }
  };
  // Update the confirm button's disabled state directly — calling renderApp() here
  // destroys and recreates the DOM, collapsing the input and losing focus on every keystroke.
  const resetMode = appState.settings.confirmResetTotals?.mode === 'reporting' || appState.settings.confirmResetTotals?.mode === 'dashboard' ? 'reporting' : 'reporting_stock';
  const requiredText = resetMode === 'reporting' ? 'Reset Reporting' : 'Reset Reporting and Stock Values';
  const btn = document.querySelector('[data-settings-confirm-reset-totals]');
  if (btn) btn.disabled = confirmText !== requiredText || appState.settings.actionStatus === 'resetting';
}

function cancelResetStockTotals() {
  appState.settings = {
    ...appState.settings,
    confirmResetTotals: null,
    actionStatus: '',
    actionError: ''
  };
  renderApp();
}

async function confirmResetStockTotals() {
  if (!isCurrentSuperUser()) {
    appState.settings = {
      ...appState.settings,
      confirmResetTotals: null,
      actionError: 'Only super users can reset reporting or stock totals.'
    };
    renderApp();
    return;
  }
  const resetMode = appState.settings.confirmResetTotals?.mode === 'reporting' || appState.settings.confirmResetTotals?.mode === 'dashboard'
    ? 'reporting'
    : 'reporting_stock';
  const requiredText = resetMode === 'reporting'
    ? 'Reset Reporting'
    : 'Reset Reporting and Stock Values';
  if (String(appState.settings.confirmResetTotals?.confirmText || '') !== requiredText) {
    appState.settings = {
      ...appState.settings,
      actionError: `Type "${requiredText}" to confirm this reset.`
    };
    renderApp();
    return;
  }
  appState.settings = {
    ...appState.settings,
    actionStatus: 'resetting',
    actionError: ''
  };
  renderApp();

  try {
    const { resetWorkspaceReportingHistory } = await import('./services/stockService.js');
    const result = await resetWorkspaceReportingHistory(appState.workspace?.id, {
      includeStockOnHand: resetMode === 'reporting_stock'
    });
    appState.settings = {
      ...appState.settings,
      confirmResetTotals: null,
      actionStatus: '',
      actionError: ''
    };
    const toastMessage = resetMode === 'reporting_stock'
      ? `Reporting data reset and ${result.stockResetCount || 0} stock item${Number(result.stockResetCount || 0) === 1 ? '' : 's'} zeroed.`
      : 'Reporting data reset.';
    showSettingsToast(toastMessage, 'success');
    await selectWorkspace(appState.workspace);
  } catch (error) {
    appState.settings = {
      ...appState.settings,
      actionStatus: '',
      actionError: error.message || 'Could not reset reporting data.'
    };
    renderApp();
  }
}

async function importStockFile(file) {
  if (!file) return;
  appState.stock = {
    ...appState.stock,
    actionStatus: 'importing',
    actionError: '',
    importReview: null
  };
  renderApp();

  try {
    const { detectImportFileType, IMPORT_TYPES } = await import('./services/locationCostingService.js');
    const fileType = await detectImportFileType(file);
    if (fileType === IMPORT_TYPES.LOCATION_COSTING_IMPORT) {
      throw new Error('This file looks like a Location Costing Import. Please upload it in the Location Costing Import section.');
    }
    const rows = await parseDataFile(file, { preferredSheetNames: ['Stock_Import'] });
    const { items, review } = mapLegacyStockRows(rows);
    if (!items.length && !review.errors.length && !review.skippedCount) throw new Error('No valid stock item rows were found in this file.');
    const ignoredAdjustmentCount = (review.errors || []).filter((entry) => entry.code === 'WARN_STOCK_ADJUSTMENT_IGNORED').length;

    let result = { importedCount: 0 };
    if (items.length) {
      const { importStockItems } = await import('./services/stockService.js');
      result = await importStockItems(appState.workspace?.id, items, {
        siteId: appState.stock.filters?.siteId || '',
        locationId: appState.stock.filters?.locationId || ''
      });
    }
    const nextReport = {
      ...review,
      importedCount: result.importedCount || 0,
      skippedCount: review.skippedCount || 0
    };
    const skippedCount = Number(nextReport.skippedCount || 0);
    const hasReportEntries = skippedCount > 0 || ignoredAdjustmentCount > 0 || (review.errors || []).length > 0;
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: '',
      importReview: hasReportEntries ? nextReport : null
    };
    if (hasReportEntries) {
      renderApp();
    } else {
      showStockToast(`Ingredients imported (${result.importedCount} items syncing to cloud).`, 'success');
    }
  } catch (error) {
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: '',
      importReview: null
    };
    showImportNotification({
      moduleLabel: 'Stock Import',
      title: 'Stock Import Failed',
      message: `${error.message || 'Stock import failed.'} Confirm this message, fix the file, and try again.`,
      errors: [error.message || 'Stock import failed.'],
      tone: 'error',
      confirmLabel: 'Confirm & Try Again'
    });
  }
}


async function exportLocationCostingSheet(format = 'xlsx') {
  const normalizedFormat = String(format || 'xlsx').toLowerCase() === 'pdf' ? 'pdf' : 'xlsx';
  const locationId = String(appState.stock.filters?.locationCostingLocationId || '').trim();
  if (!locationId) {
    showStockToast('Please select a location before exporting or importing location costs.', 'warning');
    return;
  }
  appState.stock = { ...appState.stock, actionStatus: 'exporting-location-costing', actionError: '' };
  renderApp();
  try {
    const locations = appState.stock.locations || appState.locations?.items || [];
    if (normalizedFormat === 'pdf') {
      const result = await exportLocationCostingPdf({
        stockItems: appState.stock.items || [],
        locations,
        locationId,
        workspaceName: appState.workspace?.siteName || appState.workspace?.name || 'KCP'
      });
      appState.stock = {
        ...appState.stock,
        actionStatus: '',
        actionError: '',
        filters: {
          ...appState.stock.filters,
          locationCostingPickerKind: '',
          locationCostingLocationIdDropdownSearch: '',
          openDropdown: ''
        }
      };
      showStockToast(`Location cost PDF exported for ${result.locationName}.`, 'success');
      return;
    }

    const { exportLocationCostingTemplate } = await import('./services/locationCostingService.js');
    const result = await exportLocationCostingTemplate({
      stockItems: appState.stock.items || [],
      locations,
      locationId,
      workspaceName: appState.workspace?.siteName || appState.workspace?.name || 'KCP'
    });
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: '',
      filters: {
        ...appState.stock.filters,
        locationCostingPickerKind: '',
        locationCostingLocationIdDropdownSearch: '',
        openDropdown: ''
      }
    };
    showStockToast(`Location cost sheet exported for ${result.locationName}.`, 'success');
  } catch (error) {
    appState.stock = { ...appState.stock, actionStatus: '', actionError: error.message || 'Could not export location costs.' };
    showStockToast(error.message || 'Could not export location costs.', 'error');
  }
}

async function exportLocationCostingPdf({ stockItems = [], locations = [], locationId = '', workspaceName = 'KCP' } = {}) {
  const selectedLocation = (locations || []).find((location) => String(location.id || location.locationId || '') === String(locationId || ''));
  if (!selectedLocation) throw new Error('Please select a location before exporting or importing location costs.');
  const locationName = getLocationNameForCostingExport(selectedLocation);
  const columns = ['Item Name', 'SKU / Barcode', 'Category', 'UOM', 'Cost Ex VAT'];
  const rows = (stockItems || [])
    .filter((item) => item && typeof item === 'object' && item.id)
    .slice()
    .sort((left, right) => {
      const categoryCompare = String(left.category || '').localeCompare(String(right.category || ''));
      if (categoryCompare !== 0) return categoryCompare;
      return String(left.name || '').localeCompare(String(right.name || ''));
    })
    .map((item) => ({
      'Item Name': item.name || '',
      'SKU / Barcode': getStockCostingSkuBarcode(item),
      Category: item.category || item.inventoryCategory || 'General',
      UOM: item.unit || item.uom || 'ea',
      'Cost Ex VAT': formatCurrency(resolveStockLocationCostForExport(item, locationId))
    }));

  await exportObjectRows({
    format: 'pdf',
    filename: buildExportFilename({ workspaceName, reportType: 'Location Costing Report', suffix: locationName }),
    sheetName: 'Location Costing',
    title: 'Location Costing Report',
    subtitle: `${workspaceName || 'KCP'} | ${locationName} | ${new Date().toLocaleString('en-ZA')}`,
    rows,
    columns,
    summaryRows: [
      { label: 'Report', value: 'Location Costing' },
      { label: 'Location', value: locationName },
      { label: 'Items', value: rows.length },
      { label: 'Generated', value: new Date().toLocaleString('en-ZA') }
    ],
    branding: getPdfBranding()
  });
  return { rowCount: rows.length, locationName };
}

function resolveStockLocationCostForExport(item = {}, locationId = '') {
  const costs = item.locationCosts || item.locationPrices || item.locationPricing || item.pricesByLocation || {};
  const entry = costs[String(locationId || '')];
  if (entry && typeof entry === 'object') return Number(entry.cost ?? entry.unitCost ?? entry.price ?? item.cost ?? 0) || 0;
  if (entry !== undefined && entry !== null && entry !== '') return Number(entry) || 0;
  return Number(item.cost ?? item.unitCost ?? 0) || 0;
}

function getStockCostingSkuBarcode(item = {}) {
  return [item.sku || item.SKU || item.stockCode || item.itemCode || '', parseBarcodeValues(item)[0] || '']
    .filter(Boolean)
    .join(' / ');
}

function getLocationNameForCostingExport(location = {}) {
  return String(location.displayName || location.name || location.locationName || location.id || 'Location').trim();
}

async function importLocationCostingFile(file) {
  if (!file) return;
  const selectedLocationId = String(appState.stock.filters?.locationCostingLocationId || '').trim();
  appState.stock = { ...appState.stock, actionStatus: 'importing-location-costing', actionError: '', locationCostingPreview: null };
  renderApp();
  try {
    const {
      detectImportFileType,
      IMPORT_TYPES,
      parseLocationCostingImport,
      applyLocationCostingImport,
      applyLocationCostPreviewToItems
    } = await import('./services/locationCostingService.js');
    const fileType = await detectImportFileType(file);
    if (fileType === IMPORT_TYPES.STOCK_ITEM_IMPORT) {
      throw new Error('This file looks like a Stock Item Import. Please upload it in the Stock Item Import section.');
    }
    if (fileType !== IMPORT_TYPES.LOCATION_COSTING_IMPORT) {
      throw new Error('We could not identify this import file. Please download a fresh template from the correct section and try again.');
    }
    const preview = await parseLocationCostingImport(file, {
      selectedLocationId,
      requireFileLocationMetadata: !selectedLocationId,
      stockItems: appState.stock.items || [],
      locations: appState.stock.locations || appState.locations?.items || []
    });
    if (preview.summary?.errors) {
      throw new Error('Some rows have invalid costs. Fix the highlighted rows and upload again.');
    }
    if (!preview.summary?.toUpdate) {
      appState.stock = {
        ...appState.stock,
        actionStatus: '',
        actionError: '',
        locationCostingPreview: null,
        filters: {
          ...appState.stock.filters,
          locationCostingLocationId: preview.locationId || appState.stock.filters?.locationCostingLocationId || '',
          locationCostingPickerKind: '',
          locationCostingLocationIdDropdownSearch: '',
          openDropdown: ''
        }
      };
      renderApp();
      showStockToast('No changes found.', 'info');
      return;
    }
    appState.stock = { ...appState.stock, actionStatus: 'saving-location-costing', actionError: '', locationCostingPreview: null };
    renderApp();
    const result = await applyLocationCostingImport(appState.workspace?.id, preview);
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: '',
      locationCostingPreview: null,
      items: applyLocationCostPreviewToItems(appState.stock.items || [], preview),
      filters: {
        ...appState.stock.filters,
        locationCostingLocationId: preview.locationId || appState.stock.filters?.locationCostingLocationId || '',
        locationCostingPickerKind: '',
        locationCostingLocationIdDropdownSearch: '',
        openDropdown: ''
      }
    };
    showStockToast(`Location costs updated successfully for ${preview.locationName}.`, 'success');
    refreshActiveTabFromApi().catch((error) => console.warn('[Stock] Location cost refresh failed:', error));
    return result;
  } catch (error) {
    appState.stock = { ...appState.stock, actionStatus: '', actionError: error.message || 'This file is not a Location Costing Import file. Please upload the correct template.', locationCostingPreview: null };
    showStockToast(error.message || 'This file is not a Location Costing Import file. Please upload the correct template.', 'error');
  }
}

async function confirmLocationCostingImport() {
  const preview = appState.stock.locationCostingPreview;
  if (!preview) return;
  if (preview.summary?.errors) {
    showStockToast('Some rows have invalid costs. Fix the highlighted rows and upload again.', 'warning');
    return;
  }
  if (!preview.summary?.toUpdate) {
    showStockToast('No changes found.', 'info');
    return;
  }
  appState.stock = { ...appState.stock, actionStatus: 'saving-location-costing', actionError: '' };
  renderApp();
  try {
    const { applyLocationCostingImport, applyLocationCostPreviewToItems } = await import('./services/locationCostingService.js');
    const result = await applyLocationCostingImport(appState.workspace?.id, preview);
    appState.stock = {
      ...appState.stock,
      actionStatus: '',
      actionError: '',
      locationCostingPreview: null,
      items: applyLocationCostPreviewToItems(appState.stock.items || [], preview),
      filters: {
        ...appState.stock.filters,
        locationCostingPickerKind: '',
        locationCostingLocationIdDropdownSearch: '',
        openDropdown: ''
      }
    };
    showStockToast(`Location costs updated successfully for ${preview.locationName}.`, 'success');
    refreshActiveTabFromApi().catch((error) => console.warn('[Stock] Location cost refresh failed:', error));
    return result;
  } catch (error) {
    appState.stock = { ...appState.stock, actionStatus: '', actionError: error.message || 'We could not update location costs right now. No changes were applied. Please try again.' };
    showStockToast(error.message || 'We could not update location costs right now. No changes were applied. Please try again.', 'error');
  }
}

function cancelLocationCostingImport() {
  appState.stock = { ...appState.stock, locationCostingPreview: null, actionStatus: '', actionError: '' };
  renderApp();
}

async function exportStockItems(format = 'csv') {
  if (String(format || '').startsWith('template-')) {
    await exportStockTemplate(String(format).replace('template-', '') || 'csv');
    return;
  }

  const selectedIds = new Set((appState.stock.selectedIds || []).map(String));
  const visibleItems = getFilteredStockItems(appState.stock.items || [], appState.stock.filters || {});
  const items = selectedIds.size
    ? visibleItems.filter((item) => selectedIds.has(String(item.id)))
    : visibleItems;

  if (!items.length) {
    showStockToast(selectedIds.size ? 'No selected stock items are available to export.' : 'No visible stock items are available to export.', 'warning');
    return;
  }

  const locationId = String(appState.stock.filters?.locationId || '');
  const exportItems = buildLocationAwareStockExportItems(items, {
    locationId,
    locations: appState.stock.locations || appState.locations?.items || []
  });
  const rows = buildStockRows(exportItems, {
    getOnHand: (item) => Number(item.stock || 0) || 0
  });

  try {
    await exportObjectRows({
      format,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Stock Item Export' }),
      sheetName: 'Stock Items',
      title: 'Stock Items',
      subtitle: `${appState.workspace?.siteName || 'KCP'} · ${exportItems.length} item/location row${exportItems.length === 1 ? '' : 's'}`,
      rows,
      columns: exportSchemas.stock,
      branding: getPdfBranding()
    });
    showStockToast(`${exportItems.length} item/location row${exportItems.length === 1 ? '' : 's'} exported as ${format.toUpperCase()}.`, 'success');
  } catch (error) {
    showStockToast(error.message || 'Stock export failed.', 'error');
  }
}

function buildLocationAwareStockExportItems(items = [], { locationId = '', locations = [] } = {}) {
  const normalizedLocationId = String(locationId || '').trim();
  const activeLocations = (locations || []).filter((location) => String(location.id || '').trim());
  const locationMap = new Map(activeLocations.map((location) => [String(location.id), location]));
  const fallbackLocation = activeLocations.find((location) => location.isDefault) || activeLocations[0] || { id: 'main', name: 'Main Store' };

  return (items || []).flatMap((item) => {
    const balances = item?.balances && typeof item.balances === 'object' ? item.balances : {};
    const balanceLocationIds = Object.keys(balances).filter(Boolean);
    const rowLocationIds = normalizedLocationId
      ? [normalizedLocationId]
      : (balanceLocationIds.length ? balanceLocationIds : [String(fallbackLocation.id || 'main')]);

    return rowLocationIds.map((rowLocationId) => {
      const location = locationMap.get(String(rowLocationId));
      const qty = Object.prototype.hasOwnProperty.call(balances, rowLocationId)
        ? Number(balances[rowLocationId] || 0) || 0
        : (normalizedLocationId ? getLocationStock(item, rowLocationId, activeLocations) : Number(item.stock || 0) || 0);
      return {
        ...item,
        stock: qty,
        locationId: rowLocationId,
        locationName: location?.displayName || location?.name || activeLocations.find((l) => String(l.id || '').includes(rowLocationId.slice(-8)))?.name || (rowLocationId === 'main' ? 'Main Store' : 'Unknown Location')
      };
    });
  });
}

async function exportStockTemplate(format = 'csv') {
  const normalizedFormat = ['csv', 'xlsx', 'pdf'].includes(format) ? format : 'csv';
  const filename = buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Stock Item Template Export' });

  try {
    if (normalizedFormat === 'xlsx') {
      await downloadStyledStockTemplateXlsx(filename, {
        columns: exportSchemas.stock,
        rows: buildTemplateRows(exportSchemas.stock),
        columnWidths: getStockImportTemplateColumnWidths(),
        maxRows: 250
      });
      showStockToast('Stock template exported as XLSX.', 'success');
      return;
    }
    await exportObjectRows({
      format: normalizedFormat,
      filename,
      sheetName: 'Stock_Import',
      title: 'Stock Items Import Template',
      subtitle: 'Client-friendly stock import with base UOM, opening stock, and up to three alternate UOMs per item.',
      rows: buildTemplateRows(exportSchemas.stock),
      columns: exportSchemas.stock,
      xlsxOptions: {
        mainSheet: {
          freezeHeader: true,
          autoFilter: true,
          columnWidths: getStockImportTemplateColumnWidths()
        }
      },
      branding: getPdfBranding()
    });
    showStockToast(`Stock template exported as ${normalizedFormat.toUpperCase()}.`, 'success');
  } catch (error) {
    showStockToast(error.message || 'Stock template export failed.', 'error');
  }
}

function getStockImportTemplateColumnWidths() {
  const widths = {
    Item_Name: 28,
    SKU: 18,
    Category: 18,
    Base_UOM: 12,
    Default_Ordering_UOM: 22,
    Cost_Ex_VAT: 14,
    VAT_Enabled: 14,
    Barcode: 18,
    Is_Manufactured: 16,
    Yield_Percentage: 18,
    Batch_Yield: 14,
    Default_Location: 20,
    Opening_Stock: 15,
    Low_Stock_Threshold: 20,
    Par_Level: 12,
    Notes: 34,
    UOM_1_Name: 16,
    UOM_1_Qty_In_Base: 18,
    UOM_1_Barcode: 18,
    UOM_2_Name: 16,
    UOM_2_Qty_In_Base: 18,
    UOM_2_Barcode: 18,
    UOM_3_Name: 16,
    UOM_3_Qty_In_Base: 18,
    UOM_3_Barcode: 18
  };
  return exportSchemas.stock.map((column) => widths[column] || 14);
}

function dismissStockToast() {
  if (stockToastTimer) {
    window.clearTimeout(stockToastTimer);
    stockToastTimer = null;
  }
  appState.stock = {
    ...appState.stock,
    toast: null
  };
  renderApp();
}

function updateSupplierFilters(nextFilters) {
  appState.suppliers = {
    ...appState.suppliers,
    filters: {
      ...appState.suppliers.filters,
      ...nextFilters
    }
  };
  renderApp();
}

function updateSupplierSelection(itemId, selected) {
  const id = String(itemId || '');
  if (!id) return;
  const selectedIds = new Set(appState.suppliers.selectedIds || []);
  if (selected) selectedIds.add(id);
  else selectedIds.delete(id);
  appState.suppliers = {
    ...appState.suppliers,
    selectedIds: [...selectedIds]
  };
  renderApp();
}

function updateAllSupplierSelection(itemIds = [], selected) {
  const selectedIds = new Set(appState.suppliers.selectedIds || []);
  itemIds.forEach((id) => {
    if (selected) selectedIds.add(String(id));
    else selectedIds.delete(String(id));
  });
  appState.suppliers = {
    ...appState.suppliers,
    selectedIds: [...selectedIds]
  };
  renderApp();
}

function openSupplierEditor(itemId) {
  const item = itemId ? structuredCloneSafe(getSupplierById(itemId)) : { id: '__new__', category: 'General', leadTime: 0, paymentTerms: 'COD' };
  if (!item) {
    showSupplierToast('Supplier could not be found.', 'error');
    return;
  }

  appState.suppliers = {
    ...appState.suppliers,
    editingItem: item,
    actionError: '',
    validationErrors: {}
  };
  renderApp();
}

function closeSupplierEditor() {
  appState.suppliers = {
    ...appState.suppliers,
    editingItem: null,
    actionStatus: '',
    actionError: '',
    validationErrors: {}
  };
  renderApp();
}

function validateSupplierPayload(item = {}) {
  const errors = {};
  if (!String(item.name || '').trim()) errors.name = 'Supplier name is required.';
  if (!String(item.contactPerson || '').trim()) errors.contactPerson = 'Contact person is required.';
  if (!String(item.category || '').trim()) errors.category = 'Category is required.';
  if (!String(item.paymentTerms || '').trim()) errors.paymentTerms = 'Payment terms are required.';
  const leadTimeRaw = String(item.leadTime ?? '').trim();
  if (leadTimeRaw === '' || Number(leadTimeRaw) < 0 || Number.isNaN(Number(leadTimeRaw))) {
    errors.leadTime = 'Lead time must be zero or greater.';
  }
  if (!String(item.phone || '').trim() && !String(item.email || '').trim()) {
    const message = 'Enter at least a phone number or an email address.';
    errors.phone = message;
    errors.email = message;
  }
  return errors;
}

function getSupplierValidationMessage(errors = {}) {
  const messages = [...new Set(Object.values(errors).filter(Boolean))];
  return messages.length ? messages.join(' ') : '';
}

function updateSupplierDraft(updates = {}) {
  if (!appState.suppliers.editingItem) return;

  const nextPhone = String(updates.phone ?? appState.suppliers.editingItem.phone ?? '').trim();
  const nextEmail = String(updates.email ?? appState.suppliers.editingItem.email ?? '').trim();
  const nextValidationErrors = { ...(appState.suppliers.validationErrors || {}) };
  Object.keys(updates).forEach((key) => {
    delete nextValidationErrors[key];
    if ((key === 'phone' || key === 'email') && (nextPhone || nextEmail)) {
      delete nextValidationErrors.phone;
      delete nextValidationErrors.email;
    }
  });

  appState.suppliers = {
    ...appState.suppliers,
    editingItem: {
      ...appState.suppliers.editingItem,
      ...updates
    },
    validationErrors: nextValidationErrors,
    actionError: ''
  };
  clearTimeout(supplierDraftRenderTimer);
  supplierDraftRenderTimer = setTimeout(renderApp, 80);
}

function updateSupplierDraftSilent(updates = {}) {
  if (!appState.suppliers.editingItem) return;
  appState.suppliers = {
    ...appState.suppliers,
    editingItem: { ...appState.suppliers.editingItem, ...updates }
  };
}

function updateSettingsDraftSilent(updates = {}) {
  const draft = appState.settings.draft || {};
  appState.settings = { ...appState.settings, draft: { ...draft, ...updates } };
}

function updateSettingsTaxFieldSilent(key = '', value = '') {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;
  const draft = appState.settings.draft || createDefaultSettingsDraft();
  appState.settings = {
    ...appState.settings,
    actionError: '',
    draft: {
      ...draft,
      companyTaxInfo: {
        ...(draft.companyTaxInfo && typeof draft.companyTaxInfo === 'object' ? draft.companyTaxInfo : {}),
        [normalizedKey]: value
      }
    }
  };
}

async function saveSupplier(item) {
  const validationErrors = validateSupplierPayload(item);
  const validationError = getSupplierValidationMessage(validationErrors);
  if (validationError) {
    appState.suppliers = {
      ...appState.suppliers,
      editingItem: {
        ...(appState.suppliers.editingItem || {}),
        ...item
      },
      actionStatus: '',
      actionError: validationError,
      validationErrors
    };
    renderApp();
    return;
  }

  appState.suppliers = {
    ...appState.suppliers,
    actionStatus: 'saving',
    actionError: '',
    validationErrors: {}
  };
  renderApp();
  showGlobalSaving('Saving Supplier');

  try {
    const { upsertSupplier } = await import('./services/supplierService.js');
    await upsertSupplier(appState.workspace?.id, {
      ...item,
      id: item.id || undefined
    });
    appState.suppliers = {
      ...appState.suppliers,
      editingItem: null,
      actionStatus: '',
      actionError: '',
      validationErrors: {}
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showSupplierToast('Supplier saved.', 'success');
  } catch (error) {
    appState.suppliers = {
      ...appState.suppliers,
      actionStatus: '',
      actionError: error.message || 'Could not save supplier.',
      validationErrors: {}
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

function requestSupplierDelete(payload = {}) {
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return;
  appState.suppliers = {
    ...appState.suppliers,
    confirmDelete: {
      ids,
      mode: payload.mode || (ids.length > 1 ? 'bulk' : 'single')
    },
    actionError: ''
  };
  renderApp();
}

function cancelSupplierDelete() {
  appState.suppliers = {
    ...appState.suppliers,
    confirmDelete: null,
    actionStatus: '',
    actionError: ''
  };
  renderApp();
}

async function confirmSupplierDelete() {
  const ids = appState.suppliers.confirmDelete?.ids || [];
  if (!ids.length) return;
  const items = ids.map((id) => getSupplierById(id) || { id }).filter((item) => String(item.id || '').trim());

  appState.suppliers = {
    ...appState.suppliers,
    actionStatus: 'deleting',
    actionError: ''
  };
  renderApp();

  try {
    const { deleteSupplier, deleteMultipleSuppliers } = await import('./services/supplierService.js');
    if (items.length === 1) {
      await deleteSupplier(items[0].id, {
        workspaceId: appState.workspace?.id,
        source: items[0].source,
        firestoreDocId: items[0].firestoreDocId,
        realtimeKey: items[0].realtimeKey,
        name: items[0].name
      });
    } else {
      await deleteMultipleSuppliers(items, { workspaceId: appState.workspace?.id });
    }

    const deletedIds = new Set(ids.map(String));
    appState.suppliers = {
      ...appState.suppliers,
      items: removeRowsByIds(appState.suppliers.items, deletedIds),
      selectedIds: (appState.suppliers.selectedIds || []).filter((id) => !deletedIds.has(String(id))),
      confirmDelete: null,
      actionStatus: '',
      actionError: '',
      editingItem: deletedIds.has(String(appState.suppliers.editingItem?.id || '')) ? null : appState.suppliers.editingItem
    };
    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      suppliers: removeRowsByIds(appState.purchaseOrders.suppliers, deletedIds)
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showSupplierToast(items.length === 1 ? 'Supplier deleted.' : `${items.length} suppliers deleted.`, 'success');
  } catch (error) {
    appState.suppliers = {
      ...appState.suppliers,
      actionStatus: '',
      actionError: error.message || 'Could not delete suppliers.'
    };
    renderApp();
  }
}

async function exportSuppliers(format = 'csv') {
  if (String(format || '').startsWith('template-')) {
    await exportSupplierTemplate(String(format).replace('template-', '') || 'csv');
    return;
  }

  const items = getFilteredSuppliers(appState.suppliers.items || [], appState.suppliers.filters || {});

  if (!items.length) {
    showSupplierToast('No filtered suppliers are available to export.', 'warning');
    return;
  }

  const rows = buildSupplierRows(items);

  try {
    await exportObjectRows({
      format,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Supplier Export' }),
      sheetName: 'Suppliers',
      title: 'Suppliers',
      subtitle: `${appState.workspace?.siteName || 'KCP'} · ${items.length} supplier${items.length === 1 ? '' : 's'}`,
      rows,
      columns: exportSchemas.suppliers,
      branding: getPdfBranding()
    });
    showSupplierToast(`${items.length} suppliers exported as ${format.toUpperCase()}.`, 'success');
  } catch (error) {
    showSupplierToast(error.message || 'Supplier export failed.', 'error');
  }
}

async function importSupplierFile(file) {
  if (!file) return;
  appState.suppliers = {
    ...appState.suppliers,
    actionStatus: 'importing',
    actionError: ''
  };
  renderApp();

  try {
    const rows = await parseDataFile(file, { preferredSheetNames: ['Supplier_Import'] });
    const { rows: supplierRows, review } = mapSupplierImportRows(rows);
    if (!supplierRows.length) throw new Error(formatImportFailure('No valid supplier rows were found in this file.', review.errors));

    const { importSuppliers } = await import('./services/supplierService.js');
    const result = await importSuppliers(appState.workspace?.id, supplierRows);
    if (!result.importedCount) {
      const detail = result.errors?.[0]?.message || 'No valid supplier rows were found.';
      throw new Error(`Supplier import finished with 0 suppliers imported. ${detail}`);
    }
    appState.suppliers = {
      ...appState.suppliers,
      actionStatus: '',
      actionError: ''
    };
    const skippedCount = Number(review.errors.length || result.skippedCount || 0);
    if (skippedCount) {
      showImportNotification({
        moduleLabel: 'Supplier Import',
        title: 'Supplier Import Needs Attention',
        message: `${result.importedCount || 0} supplier${Number(result.importedCount || 0) === 1 ? '' : 's'} imported, but ${skippedCount} row${skippedCount === 1 ? '' : 's'} need fixing. Confirm this message, fix the errors, and try again.`,
        errors: review.errors,
        importedCount: result.importedCount || 0,
        skippedCount,
        totalRows: review.totalRows,
        tone: 'warning',
        confirmLabel: 'Confirm & Fix Errors'
      });
    } else {
      showSupplierToast(`Suppliers imported (${result.importedCount} supplier${result.importedCount === 1 ? '' : 's'} syncing to cloud).`, 'success');
    }
  } catch (error) {
    appState.suppliers = {
      ...appState.suppliers,
      actionStatus: '',
      actionError: ''
    };
    showImportNotification({
      moduleLabel: 'Supplier Import',
      title: 'Supplier Import Failed',
      message: `${error.message || 'Supplier import failed.'} Confirm this message, fix the file, and try again.`,
      errors: [error.message || 'Supplier import failed.'],
      tone: 'error',
      confirmLabel: 'Confirm & Try Again'
    });
  }
}

async function exportSupplierTemplate(format = 'csv') {
  const normalizedFormat = ['csv', 'xlsx', 'pdf'].includes(format) ? format : 'csv';

  try {
    await exportObjectRows({
      format: normalizedFormat,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Supplier Template Export' }),
      sheetName: 'Supplier_Import',
      title: 'Supplier Import Template',
      subtitle: 'Simple supplier import form. Only Supplier_Name is required; contact, terms, address, and notes are optional.',
      rows: buildTemplateRows(exportSchemas.suppliers),
      columns: exportSchemas.suppliers,
      xlsxOptions: {
        mainSheet: {
          freezeHeader: true,
          autoFilter: true,
          columnWidths: getSupplierImportTemplateColumnWidths(),
          validations: [
            {
              column: 'E',
              values: ['Fresh Produce', 'Meat', 'Dairy', 'Dry Goods', 'Beverages', 'Packaging', 'Cleaning', 'Other']
            },
            {
              column: 'G',
              values: ['COD', '7 Days', '14 Days', '30 Days', '60 Days', 'Custom']
            }
          ]
        }
      },
      branding: getPdfBranding()
    });
    showSupplierToast(`Supplier template exported as ${normalizedFormat.toUpperCase()}.`, 'success');
  } catch (error) {
    showSupplierToast(error.message || 'Supplier template export failed.', 'error');
  }
}

function getSupplierImportTemplateColumnWidths() {
  const widths = {
    Supplier_Name: 28,
    Contact_Person: 22,
    Email: 28,
    Phone: 18,
    Category: 18,
    Lead_Time_Days: 16,
    Payment_Terms: 16,
    Account_Number: 18,
    Address_Line_1: 28,
    Address_Line_2: 22,
    City: 18,
    Province: 18,
    Postal_Code: 14,
    Country: 18,
    Notes: 34,
    Supplier_ID: 22
  };
  return exportSchemas.suppliers.map((column) => widths[column] || 14);
}

function dismissSupplierToast() {
  if (supplierToastTimer) {
    window.clearTimeout(supplierToastTimer);
    supplierToastTimer = null;
  }
  appState.suppliers = {
    ...appState.suppliers,
    toast: null
  };
  renderApp();
}

function updatePurchaseOrderFilters(nextFilters) {
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    filters: {
      ...appState.purchaseOrders.filters,
      ...nextFilters
    }
  };
  renderApp();
}

function updatePurchaseOrderSelection(orderId, selected) {
  const id = String(orderId || '');
  if (!id) return;
  const selectedIds = new Set(appState.purchaseOrders.selectedIds || []);
  if (selected) selectedIds.add(id);
  else selectedIds.delete(id);
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    selectedIds: [...selectedIds]
  };
  renderApp();
}

function updateAllPurchaseOrderSelection(orderIds = [], selected) {
  const selectedIds = new Set(appState.purchaseOrders.selectedIds || []);
  orderIds.forEach((id) => {
    if (selected) selectedIds.add(String(id));
    else selectedIds.delete(String(id));
  });
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    selectedIds: [...selectedIds]
  };
  renderApp();
}


function openPurchaseOrderFromReportingLowStock(payload = {}) {
  const rawItems = Array.isArray(payload.items) && payload.items.length ? payload.items : [payload];
  pendingReportingPurchaseOrderSeed = {
    source: payload.source || 'stock_control',
    supplierId: String(payload.supplierId || '').trim(),
    supplierName: String(payload.supplierName || '').trim(),
    items: rawItems.map(normalizeReportingLowStockSeedItem).filter((item) => item.itemId || item.itemName)
  };
  if (!pendingReportingPurchaseOrderSeed.items.length) {
    pendingReportingPurchaseOrderSeed = null;
    return;
  }
  navigateTo('purchase-orders');
}

function normalizeReportingLowStockSeedItem(payload = {}) {
  return {
    itemId: String(payload.itemId || payload.stockItemId || '').trim(),
    itemName: String(payload.itemName || payload.stockItemName || '').trim(),
    locationId: String(payload.locationId || '').trim(),
    locationName: String(payload.locationName || '').trim(),
    supplierId: String(payload.supplierId || '').trim(),
    supplierName: String(payload.supplierName || '').trim(),
    requiredQty: Number(payload.requiredQty || 0) || 0,
    purchaseUom: String(payload.purchaseUom || '').trim(),
    purchaseUomQty: Number(payload.purchaseUomQty || payload.requiredQty || 0) || 0,
    unitCostExVat: Number(payload.unitCostExVat || payload.lastPurchaseCost || 0) || 0,
    parLevel: Number(payload.parLevel || 0) || 0,
    currentStock: Number(payload.currentStock || 0) || 0,
    lowStockThreshold: Number(payload.lowStockThreshold || payload.threshold || 0) || 0
  };
}

function applyPendingReportingPurchaseOrderSeed() {
  const seed = pendingReportingPurchaseOrderSeed;
  if (!seed) return false;
  const stockItems = appState.purchaseOrders.stockItems || [];
  const locations = appState.purchaseOrders.locations || [];
  if (!stockItems.length || !locations.length) return false;

  const seedItems = Array.isArray(seed.items) && seed.items.length ? seed.items : [normalizeReportingLowStockSeedItem(seed)];
  const orderLines = [];
  const skipped = [];

  seedItems.forEach((itemSeed) => {
    const stockItem = findPurchaseOrderStockItemForSeed(itemSeed, stockItems);
    if (!stockItem) {
      skipped.push(itemSeed.itemName || 'Unknown item');
      return;
    }
    if (!isOrderableStockItem(stockItem)) {
      skipped.push(`${stockItem.name} cannot be ordered`);
      return;
    }
    orderLines.push(buildPurchaseOrderLineFromReportingSeed(itemSeed, stockItem, locations));
  });

  if (!orderLines.length) {
    showPurchaseOrderToast(skipped.length ? `No orderable selected items were found. ${skipped.slice(0, 3).join(', ')}` : 'No orderable selected items were found.', 'error');
    pendingReportingPurchaseOrderSeed = null;
    return false;
  }

  const firstLine = orderLines[0] || {};
  const forcedSupplierId = String(seed.supplierId || '').trim();
  const forcedSupplierName = String(seed.supplierName || '').trim();
  const inferredSupplierId = forcedSupplierId || firstLine.supplierId || '';
  const inferredSupplierName = forcedSupplierName || firstLine.supplierName || '';
  const locationId = firstLine.locationId || getDefaultPurchaseOrderLocationId(null);
  const locationName = firstLine.locationName || getPurchaseOrderLocationName(locationId, '');
  const siteId = getSiteIdForLocation(locations, locationId);
  const siteName = getSiteNameById(appState.purchaseOrders.sites || [], siteId, '');
  const uniqueLocations = new Set(orderLines.map((line) => String(line.locationId || '')).filter(Boolean));

  pendingReportingPurchaseOrderSeed = null;
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    draftOrder: {
      id: '',
      poNumber: '',
      reference: orderLines.length > 1 ? 'Created from Stock Control selection' : 'Created from Stock Control report',
      date: todayLocal(),
      supplierId: inferredSupplierId,
      supplierName: inferredSupplierName,
      supplierQuery: inferredSupplierName,
      siteId,
      siteName,
      locationId,
      targetLocation: locationId,
      targetLocationName: locationName,
      inputMode: 'input',
      supplierPickerOpen: !inferredSupplierId && !inferredSupplierName,
      status: 'draft',
      items: orderLines.map((line) => ({
        ...line,
        supplierId: forcedSupplierId || line.supplierId || '',
        supplierName: forcedSupplierName || line.supplierName || ''
      })),
      notes: buildReportingLowStockPurchaseOrderNotes({ orderLines, skipped, uniqueLocations })
    },
    actionError: '',
    toast: {
      tone: skipped.length ? 'warning' : 'success',
      message: `${orderLines.length} selected item${orderLines.length === 1 ? '' : 's'} added to a purchase order draft.${skipped.length ? ` ${skipped.length} item${skipped.length === 1 ? '' : 's'} skipped.` : ''}`
    },
    filters: {
      ...appState.purchaseOrders.filters,
      supplierQuery: inferredSupplierName,
      lineQuery: '',
      overlay: '',
      calendarCursor: '',
      openDropdown: ''
    }
  };
  return true;
}

function buildPurchaseOrderLineFromReportingSeed(seed = {}, stockItem = {}, locations = []) {
  const locationId = seed.locationId || getDefaultPurchaseOrderLocationId(null);
  const locationName = seed.locationName || getPurchaseOrderLocationName(locationId, '');
  const defaultSelection = getDefaultLineUomSelection(stockItem);
  const selectedUom = seed.purchaseUom || defaultSelection.selectedUom || stockItem.unit || 'ea';
  const uomSelection = seed.purchaseUom ? getLineUomSelection(stockItem, selectedUom) : defaultSelection;
  const qty = Number(seed.purchaseUomQty || 0) > 0
    ? Number(seed.purchaseUomQty)
    : (uomSelection.ratio ? Number(seed.requiredQty || 0) / uomSelection.ratio : Number(seed.requiredQty || 0));
  const cleanQty = Number.isFinite(qty) && qty > 0 ? Number(qty.toFixed(3)) : 0;
  const suggestedQty = cleanQty || Math.max(Number(seed.parLevel || 0) - Number(seed.currentStock || 0), 0) || 1;
  return {
    id: stockItem.id,
    stockItemId: stockItem.id,
    stockItemName: stockItem.name,
    qty: Number.isFinite(suggestedQty) && suggestedQty > 0 ? Number(suggestedQty.toFixed(3)) : 0,
    packSize: uomSelection.ratio || 1,
    unitCost: Number(seed.unitCostExVat || stockItem.lastPurchasePrice || stockItem.lastPurchaseCost || stockItem.latestPurchasePrice || stockItem.cost || 0) || 0,
    unit: stockItem.unit || uomSelection.baseUom || 'ea',
    selectedUom: uomSelection.selectedUom || selectedUom,
    uomConfigurations: normalizeLineUomConfigurations(stockItem.uomConfigurations || stockItem.uomConfig || stockItem.uomConversions),
    locationId,
    targetLocation: locationId,
    locationName,
    targetLocationName: locationName,
    supplierId: seed.supplierId || '',
    supplierName: seed.supplierName || '',
    reportingContext: {
      parLevel: seed.parLevel,
      currentStock: seed.currentStock,
      requiredQty: seed.requiredQty,
      lowStockThreshold: seed.lowStockThreshold
    }
  };
}

function buildReportingLowStockPurchaseOrderNotes({ orderLines = [], skipped = [], uniqueLocations = new Set() } = {}) {
  const locationsText = [...uniqueLocations].map((id) => getPurchaseOrderLocationName(id, id)).filter(Boolean).join(', ');
  const base = `Pre-created from selected Stock Control items${locationsText ? ` for ${locationsText}` : ''}. Items are included because they were explicitly selected, even when current stock is above par. Review supplier, quantity, location and cost before saving.`;
  const skippedText = skipped.length ? ` Skipped: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}.` : '';
  return `${base}${skippedText}`;
}

function findPurchaseOrderStockItemForSeed(seed = {}, stockItems = []) {
  const itemId = String(seed.itemId || '').trim();
  const itemName = String(seed.itemName || '').trim().toLowerCase();
  return (stockItems || []).find((item) => itemId && String(item.id) === itemId)
    || (stockItems || []).find((item) => itemId && String(item.stockItemId || item.itemId || item.sourceId || '') === itemId)
    || (stockItems || []).find((item) => itemName && String(item.name || '').trim().toLowerCase() === itemName)
    || null;
}

function openPurchaseOrderDraft(orderId) {
  const order = orderId ? getPurchaseOrderById(orderId) : null;
  if (orderId && !order) {
    showPurchaseOrderToast('Purchase order could not be found.', 'error');
    return;
  }
  const defaultLocationId = getDefaultPurchaseOrderLocationId(order);
  const defaultLocationName = getPurchaseOrderLocationName(defaultLocationId, '');
  const defaultSiteId = getSiteIdForLocation(appState.purchaseOrders.locations || [], defaultLocationId);
  const defaultSiteName = getSiteNameById(appState.purchaseOrders.sites || [], defaultSiteId, '');

  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    draftOrder: order
      ? {
          ...structuredCloneSafe(order),
          inputMode: 'selection',
          supplierPickerOpen: false
        }
      : {
          id: '',
          poNumber: '',
          reference: '',
          date: todayLocal(),
          supplierId: '',
          supplierName: '',
          supplierQuery: '',
          siteId: defaultSiteId,
          siteName: defaultSiteName,
          locationId: defaultLocationId,
          targetLocation: defaultLocationId,
          targetLocationName: defaultLocationName,
          inputMode: 'selection',
          supplierPickerOpen: false,
          status: 'draft',
          items: [],
          notes: ''
        },
    actionError: '',
    filters: {
      ...appState.purchaseOrders.filters,
      supplierQuery: '',
      lineQuery: '',
      overlay: '',
      calendarCursor: ''
    }
  };
  renderApp();
}

function closePurchaseOrderDraft() {
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    draftOrder: null,
    actionStatus: '',
    actionError: '',
    filters: {
      ...appState.purchaseOrders.filters,
      supplierQuery: '',
      lineQuery: '',
      openDropdown: '',
      overlay: '',
      calendarCursor: ''
    }
  };
  renderApp();
}

function updatePurchaseOrderDraft(updates = {}) {
  if (!appState.purchaseOrders.draftOrder) return;
  const draft = appState.purchaseOrders.draftOrder;
  const normalizedUpdates = { ...updates };
  let missingSiteInfoWarning = false;

  if (Object.hasOwn(normalizedUpdates, 'siteId')) {
    const nextSiteId = String(normalizedUpdates.siteId || '');
    const nextLocationId = getFirstLocationIdForSite(appState.purchaseOrders.locations || [], nextSiteId);
    normalizedUpdates.locationId = nextLocationId;
    normalizedUpdates.siteName = getSiteNameById(appState.purchaseOrders.sites || [], nextSiteId, '');
  }

  if (Object.hasOwn(normalizedUpdates, 'locationId')) {
    const nextLocationId = String(normalizedUpdates.locationId || '');
    const previousLocationId = String(draft.locationId || draft.targetLocation || '');
    const nextLocationName = getPurchaseOrderLocationName(nextLocationId, '');
    normalizedUpdates.siteId = getSiteIdForLocation(appState.purchaseOrders.locations || [], nextLocationId) || normalizedUpdates.siteId || '';
    normalizedUpdates.siteName = getSiteNameById(appState.purchaseOrders.sites || [], normalizedUpdates.siteId, normalizedUpdates.siteName || '');
    normalizedUpdates.targetLocation = nextLocationId;
    normalizedUpdates.targetLocationName = nextLocationName;
    const nextLocation = getPurchaseOrderLocationById(nextLocationId);
    missingSiteInfoWarning = isSellingLocationMissingSiteInfo(nextLocation);
    normalizedUpdates.items = (draft.items || []).map((line) => {
      const lineLocationId = String(line.locationId || line.targetLocation || '');
      const followsDefaultLocation = !lineLocationId || lineLocationId === previousLocationId;
      if (!followsDefaultLocation) return line;
      return {
        ...line,
        locationId: nextLocationId,
        targetLocation: nextLocationId,
        locationName: nextLocationName,
        targetLocationName: nextLocationName
      };
    });
  }

  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    draftOrder: {
      ...draft,
      ...normalizedUpdates
    }
  };
  if (missingSiteInfoWarning) {
    showPurchaseOrderToast('This location does not have supplier-facing site information. The purchase order will use the location name only.', 'warning');
    return;
  }
  renderApp();
}

function updatePurchaseOrderDraftSilent(updates = {}) {
  if (!appState.purchaseOrders.draftOrder) return;
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    draftOrder: { ...appState.purchaseOrders.draftOrder, ...updates }
  };
}

function addPurchaseOrderLine(stockItemId) {
  const draft = appState.purchaseOrders.draftOrder;
  const stockItem = getPoStockItemById(stockItemId);
  if (!draft || !stockItem || String(draft.status || '').toLowerCase() === 'completed') return;
  if (!isOrderableStockItem(stockItem)) {
    showPurchaseOrderToast('Only Standard and Non Stock items can be added to purchase orders.', 'warning');
    return;
  }

  const items = [...(draft.items || [])];
  const index = items.findIndex((line) => String(line.stockItemId) === String(stockItem.id));

	  if (index >= 0) {
	    const locationId = items[index].locationId || draft.locationId || '';
	    const locationName = items[index].locationName || getPurchaseOrderLocationName(locationId, '');
	    items[index] = {
	      ...items[index],
	      qty: Number(items[index].qty || 0),
	      locationId,
	      targetLocation: items[index].targetLocation || locationId,
	      locationName,
	      targetLocationName: items[index].targetLocationName || locationName
	    };
	  } else {
	    const locationId = draft.locationId || '';
	    const locationName = getPurchaseOrderLocationName(locationId, '');
	    const uomSelection = getDefaultLineUomSelection(stockItem, appState.purchaseOrders.filters?.lineQuery || '');
	    items.push({
	      id: stockItem.id,
	      stockItemId: stockItem.id,
	      stockItemName: stockItem.name,
	      qty: 0,
	      packSize: uomSelection.ratio,
	      unitCost: Number(stockItem.lastPurchasePrice ?? stockItem.lastPurchaseCost ?? stockItem.latestPurchasePrice ?? stockItem.cost ?? 0),
	      unit: stockItem.unit || 'ea',
	      selectedUom: uomSelection.selectedUom,
	      uomConfigurations: normalizeLineUomConfigurations(stockItem.uomConfigurations || stockItem.uomConfig || stockItem.uomConversions),
	      locationId,
	      targetLocation: locationId,
	      locationName,
	      targetLocationName: locationName
	    });
	  }

  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    draftOrder: {
      ...draft,
      items
    },
    filters: {
      ...appState.purchaseOrders.filters,
      lineQuery: ''
    }
  };
  renderApp();
}

function updatePurchaseOrderLine(index, updates = {}) {
  const draft = appState.purchaseOrders.draftOrder;
  if (!draft?.items?.[index]) return;
  if (String(draft.status || '').toLowerCase() === 'completed' || Number(draft.items[index].receivedQty || 0) > 0) return;
  const items = [...draft.items];
  const normalizedUpdates = { ...updates };
  if (Object.hasOwn(normalizedUpdates, 'locationId')) {
    const locationId = String(normalizedUpdates.locationId || '');
    const locationName = normalizedUpdates.locationName || normalizedUpdates.targetLocationName || getPurchaseOrderLocationName(locationId, '');
    normalizedUpdates.targetLocation = locationId;
    normalizedUpdates.locationName = locationName;
    normalizedUpdates.targetLocationName = locationName;
  }
  if (Object.hasOwn(normalizedUpdates, 'selectedUom')) {
    const selection = getLineUomSelection(items[index], normalizedUpdates.selectedUom);
    normalizedUpdates.selectedUom = selection.selectedUom;
    normalizedUpdates.packSize = selection.ratio;
  }
  items[index] = {
    ...items[index],
    ...Object.fromEntries(Object.entries(normalizedUpdates).map(([key, value]) => [
      key,
      ['qty', 'packSize', 'unitCost'].includes(key) ? parseLocaleDecimal(value) : value
    ]))
  };
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    draftOrder: {
      ...draft,
      items
    }
  };
  clearTimeout(purchaseOrderLineRenderTimer);
  purchaseOrderLineRenderTimer = setTimeout(renderApp, 80);
}

function updatePurchaseOrderLineSilent(index, updates = {}) {
  const draft = appState.purchaseOrders.draftOrder;
  if (!draft?.items?.[index]) return;
  const items = [...draft.items];
  items[index] = {
    ...items[index],
    ...Object.fromEntries(Object.entries(updates).map(([key, value]) => [
      key,
      ['qty', 'packSize', 'unitCost'].includes(key) ? parseLocaleDecimal(value) : value
    ]))
  };
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    draftOrder: { ...draft, items }
  };
}

function parseLocaleDecimal(value, fallback = 0) {
  const parsed = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function removePurchaseOrderLine(index) {
  const draft = appState.purchaseOrders.draftOrder;
  if (!draft) return;
  if (String(draft.status || '').toLowerCase() === 'completed' || Number(draft.items?.[index]?.receivedQty || 0) > 0) return;
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    draftOrder: {
      ...draft,
      items: (draft.items || []).filter((_, lineIndex) => lineIndex !== index)
    }
  };
  renderApp();
}

async function savePurchaseOrder(updates = {}) {
  const draft = appState.purchaseOrders.draftOrder;
  if (!draft) return;
  const items = draft.items || [];

  if (!items.length) {
    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      actionError: 'Add at least one stock item before confirming the purchase order.'
    };
    renderApp();
    return;
  }

  const invalidQuantity = items.find((line) => Number(line.qty || 0) <= 0);
  if (invalidQuantity) {
    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      actionError: `${invalidQuantity.stockItemName || 'A stock item'} needs a quantity greater than zero.`
    };
    renderApp();
    return;
  }

  // A destination location is required for incoming stock. "Select your location"
  // (blank) is not a valid selection.
  if (!String(draft.locationId || '').trim() && !items.some((line) => String(line.locationId || line.targetLocation || '').trim())) {
    showPurchaseOrderToast('Select a destination location before confirming the purchase order.', 'error');
    return;
  }

  const hydratedItems = items.map((line) => {
    const locationId = String(line.locationId || line.targetLocation || draft.locationId || '');
    const locationName = line.locationName || line.targetLocationName || getPurchaseOrderLocationName(locationId, '');
    return {
      ...line,
      locationId,
      targetLocation: locationId,
      locationName,
      targetLocationName: locationName
    };
  });

  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Saving Purchase Order');

  try {
    const { upsertPurchaseOrder } = await import('./services/purchaseOrderService.js');
	    await upsertPurchaseOrder(appState.workspace?.id, {
	      ...draft,
	      ...updates,
	      items: hydratedItems,
	      supplierName: draft.supplierName || getSupplierNameForPo(draft.supplierId),
	      targetLocation: draft.locationId,
	      targetLocationName: getPurchaseOrderLocationName(draft.locationId),
      status: draft.status || 'draft'
    });
    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      draftOrder: null,
      actionStatus: '',
      actionError: '',
      filters: {
        ...appState.purchaseOrders.filters,
        supplierQuery: '',
        lineQuery: '',
        openDropdown: ''
      }
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showPurchaseOrderToast('Purchase order saved.', 'success');
  } catch (error) {
    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      actionStatus: '',
      actionError: error.message || 'Could not save purchase order.'
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

async function updatePurchaseOrderStatus(orderId, status) {
  if (String(status || '').toLowerCase() === 'received') {
    redirectPurchaseOrderToGrv(orderId);
    return;
  }

  await sendPurchaseOrder(orderId);
}

function isGmailConnected() {
  try {
    const workspaceId = appState.workspace?.id || 'default';
    const cached = JSON.parse(window.localStorage.getItem(`kcp-gmail-status:${workspaceId}`) || 'null');
    return cached?.connectionActive === true;
  } catch {
    return false;
  }
}

async function sendPurchaseOrder(orderId) {
  const order = getPurchaseOrderById(orderId);
  if (!order) {
    showPurchaseOrderToast('Purchase order could not be found.', 'error');
    return;
  }

  if (!isGmailConnected()) {
    appState.purchaseOrders = { ...appState.purchaseOrders, gmailPrompt: true };
    renderApp();
    return;
  }

  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    if (String(order.status || '').toLowerCase() === 'draft') {
      const { updatePurchaseOrderStatus: updateStatus } = await import('./services/purchaseOrderService.js');
      await updateStatus(appState.workspace?.id, orderId, 'sent');
    }
    let emailWarning = '';
    try {
      await sendPurchaseOrderEmail(orderId);
    } catch (emailError) {
      emailWarning = emailError.message || 'Purchase order was sent, but the email draft could not be prepared automatically.';
    }
    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      actionStatus: '',
      actionError: ''
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showPurchaseOrderToast(emailWarning || 'Purchase order sent and email draft prepared.', emailWarning ? 'warning' : 'success');
  } catch (error) {
    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      actionStatus: '',
      actionError: error.message || 'Could not send purchase order.'
    };
    renderApp();
  }
}

function redirectPurchaseOrderToGrv(orderId) {
  const id = String(orderId || '').trim();
  if (!id) return;

  appState.grv = {
    ...appState.grv,
    pendingSourcePoId: id,
    actionError: '',
    filters: {
      ...appState.grv.filters,
      overlay: '',
      poQuery: '',
      lineQuery: '',
      selectedStockIds: [],
      calendarCursor: '',
      openDropdown: ''
    }
  };

  navigateTo('grv');
  showPurchaseOrderToast('Purchase order opened in GRV for receiving.', 'success');
}

async function sendPurchaseOrderEmail(orderId) {
  const order = getPurchaseOrderById(orderId);
  if (!order) return;

  const supplier = (appState.purchaseOrders.suppliers || []).find((item) => String(item.id) === String(order.supplierId));
  const documentContext = getPurchaseOrderDocumentContext(order, supplier);
  const documentOrder = enrichPurchaseOrderForDocument(order, supplier, documentContext);
  const filename = `PO_${order.reference || order.poNumber || order.id}`;
  const recipient = String(supplier?.email || '').trim();
  const poReference = order.poNumber || order.reference || order.id;
  const subject = `Purchase Order ${poReference} - ${documentContext.companyName}`;
  const bodyText = buildPurchaseOrderEmailBody(documentOrder, documentContext);

  // CC the logged-in KCP user so they stay on the supplier email chain.
  // Skip when the user's own address is already the recipient (no self-CC).
  const currentUserEmail = String(appState.user?.email || appState.profile?.email || '').trim();
  const ccList = (currentUserEmail && currentUserEmail.toLowerCase() !== recipient.toLowerCase())
    ? currentUserEmail
    : '';

  const pdfFile = await buildSupplierPurchaseOrderPdfFile(filename, documentOrder, documentContext);

  try {
    await sendSupplierEmailWithGmail(appState.workspace?.id, {
      to: recipient,
      cc: ccList,
      subject,
      body: bodyText,
      attachments: [{
        filename: pdfFile.name,
        contentType: pdfFile.type || 'application/pdf',
        base64: await fileToBase64(pdfFile)
      }]
    });
    return;
  } catch (gmailError) {
    if (!isRecoverablePurchaseOrderEmailError(gmailError)) {
      throw gmailError;
    }
  }

  let openedMailClient = false;
  if (navigator.share && navigator.canShare?.({ files: [pdfFile] })) {
    try {
      await navigator.share({
        title: subject,
        text: bodyText,
        files: [pdfFile]
      });
      openedMailClient = true;
    } catch {
      // Fall back to browser download + mailto compose.
    }
  }

  if (!openedMailClient) {
    downloadFileBlob(pdfFile, pdfFile.name);
    const mailto = new URL(`mailto:${recipient}`);
    if (ccList) mailto.searchParams.set('cc', ccList);
    mailto.searchParams.set('subject', subject);
    mailto.searchParams.set('body', `${bodyText}\n\nA PDF copy has been downloaded for attachment.`);
    window.location.href = mailto.toString();
  }
}

async function buildSupplierPurchaseOrderPdfFile(filename, order = {}, context = {}) {
  const poReference = order.poNumber || order.reference || order.id || 'Purchase Order';
  const targetLocation = getPurchaseOrderLocationName(order.targetLocation || order.locationId, order.targetLocationName || 'Main Store');
  const deliveryNotes = firstText(order.deliveryNotes, order.notes, order.deliveryInstructions);
  const siteInfo = normalizeDocumentSiteInfo(context.siteInfo || {});
  const siteDeliveryName = firstText(siteInfo.supplierFacingDeliveryName, siteInfo.siteTradingName, targetLocation);
  const siteAddress = buildDocumentSiteAddress(siteInfo);
  return buildSupplierPurchaseOrderPdfDocument(filename, {
    branding: getPdfBranding(),
    business: {
      name: context.companyName || 'Kitchen Cost Pro',
      address: context.companyAddress || '',
      email: context.companyEmail || '',
      phone: context.companyPhone || '',
      taxInfo: context.taxInfo || {}
    },
    order: {
      poNumber: poReference,
      reference: order.reference || poReference,
      status: normalizePurchaseOrderStatusForDocument(order.status)
    },
    supplier: {
      name: order.supplierName || 'Unassigned Supplier',
      contact: order.supplierContact || '',
      accountNumber: order.supplierAccountNumber || '',
      vatNumber: order.supplierVatNumber || ''
    },
    delivery: {
      location: targetLocation,
      name: siteDeliveryName,
      address: siteAddress,
      contact: firstText(siteInfo.receivingContactName, context.receivingContact),
      phone: siteInfo.receivingContactPhone,
      email: siteInfo.receivingContactEmail,
      receivingHours: siteInfo.receivingHours,
      notes: firstText(siteInfo.deliveryInstructions, deliveryNotes),
      supplierNotes: siteInfo.supplierNotes
    },
    items: (order.items || []).map((item) => {
      return {
        description: item.name || item.stockItemName || '',
        unit: item.selectedUom || item.purchaseUom || item.orderUom || item.unit || 'EA',
        quantity: formatDocumentQuantity(item.qty ?? item.quantity ?? ''),
        notes: item.notes || item.note || 'Confirm availability'
      };
    }),
    instruction: 'Please confirm receipt of this purchase order. Items must be supplied according to the listed UOM and quantity. Any unavailable items, substitutions, UOM changes, or quantity changes must be confirmed before delivery.'
  });
}

function buildPurchaseOrderEmailBody(order = {}, context = {}) {
  const poReference = order.poNumber || order.reference || order.id || 'Purchase Order';
  const targetLocation = getPurchaseOrderLocationName(order.targetLocation || order.locationId, order.targetLocationName || 'Main Store');
  const siteInfo = normalizeDocumentSiteInfo(context.siteInfo || {});
  const deliveryLocation = firstText(siteInfo.supplierFacingDeliveryName, siteInfo.siteTradingName, targetLocation);
  const deliveryAddress = buildDocumentSiteAddress(siteInfo);
  const contactName = String(order.supplierContact || '').trim();
  const greeting = contactName ? `Hello ${contactName},` : 'Hello,';
  return [
    greeting,
    '',
    `Please find attached Purchase Order ${poReference} for ${context.companyName || 'Kitchen Cost Pro'}.`,
    '',
    'Kindly review the attached purchase order and confirm receipt. Please advise as soon as possible if any items are unavailable, require substitution, or cannot be supplied as requested.',
    '',
    'Delivery location:',
    deliveryLocation,
    deliveryAddress ? `Address: ${deliveryAddress}` : '',
    siteInfo.receivingContactName ? `Receiving contact: ${siteInfo.receivingContactName}` : '',
    siteInfo.receivingContactPhone ? `Receiving phone: ${siteInfo.receivingContactPhone}` : '',
    siteInfo.receivingHours ? `Receiving hours: ${siteInfo.receivingHours}` : '',
    siteInfo.deliveryInstructions ? `Delivery instructions: ${siteInfo.deliveryInstructions}` : '',
    '',
    'Thank you.',
    '',
    'Kind regards,',
    context.companyName || 'Kitchen Cost Pro'
  ].join('\n');
}

function getPurchaseOrderDocumentContext(order = {}, supplier = null) {
  const settings = appState.settings?.draft || appState.settings?.values || appState.source?.settings || {};
  const selectedLocation = getDocumentLocationForOrder(order);
  const taxInfo = resolveDocumentTaxInfo(selectedLocation, settings);
  const siteInfo = resolveDocumentSiteInfo(selectedLocation);
  const taxTradingName = firstText(taxInfo.tradingName, taxInfo.registeredCompanyName);
  const companyName = firstText(
    taxTradingName,
    settings.siteName,
    settings.companyName,
    settings.tradingName,
    appState.workspace?.siteName,
    'Kitchen Cost Pro'
  );
  return {
    companyName,
    companyAddress: firstText(
      settings.companyAddress,
      settings.businessAddress,
      settings.address,
      settings.physicalAddress,
      settings.storeAddress
    ),
    companyEmail: firstText(
      settings.companyEmail,
      settings.businessEmail,
      settings.email,
      settings.orderEmail,
      settings.ordersEmail
    ),
    companyPhone: firstText(
      settings.companyPhone,
      settings.businessPhone,
      settings.phone,
      settings.contactPhone
    ),
    taxInfo,
    siteInfo,
    receivingContact: firstText(
      settings.receivingContact,
      settings.storeManager,
      settings.managerName
    ),
    vatRate: getVatRate(),
    companyVatNumber: firstText(
      settings.vatNumber,
      settings.companyVatNumber,
      settings.companyVATNumber,
      settings.vatRegistrationNumber,
      settings.taxNumber,
      settings.taxRegistrationNumber
    ),
    supplierVatNumber: firstText(
      supplier?.vatNumber,
      supplier?.supplierVatNumber,
      supplier?.supplierVATNumber,
      supplier?.vatRegistrationNumber,
      order.supplierVatNumber
    )
  };
}

function getDocumentLocationForOrder(order = {}) {
  const locationId = String(order.targetLocation || order.locationId || order.targetLocationId || '').trim();
  const locationName = String(order.targetLocationName || order.locationName || '').trim().toLowerCase();
  return getPurchaseOrderLocationById(locationId) ||
    getPurchaseOrderDocumentLocations().find((location) => locationName && String(location.displayName || location.name || '').trim().toLowerCase() === locationName) ||
    null;
}

function getPurchaseOrderLocationById(locationId = '') {
  const id = String(locationId || '').trim();
  if (!id) return null;
  const matches = getPurchaseOrderDocumentLocations().filter((location) => String(location.id || location.locationId || '') === id);
  return matches.find((location) => hasDocumentSiteInfo(normalizeDocumentSiteInfo(location.siteInfo || {}))) ||
    matches.find((location) => hasDocumentTaxInfo(normalizeDocumentTaxInfo(location.taxInfo || {}))) ||
    matches[0] ||
    null;
}

function getPurchaseOrderDocumentLocations() {
  return [
    ...(appState.purchaseOrders?.locations || []),
    ...(appState.locations?.items || []),
    ...(appState.grv?.locations || [])
  ];
}

function resolveDocumentTaxInfo(location = null, settings = {}) {
  const companyTaxInfo = normalizeDocumentTaxInfo(settings.companyTaxInfo || settings.taxInfo || {});
  const locationTaxInfo = normalizeDocumentTaxInfo(location?.taxInfo || {});
  const locationType = String(location?.type || location?.kind || '').toLowerCase();
  const isSellingLocation = location && locationType !== 'storage' && String(location?.id || '') !== 'main';
  if (isSellingLocation && locationTaxInfo.useDifferentTaxInfo && hasDocumentTaxInfo(locationTaxInfo)) {
    return locationTaxInfo;
  }
  return companyTaxInfo;
}

function resolveDocumentSiteInfo(location = null) {
  const locationType = String(location?.type || location?.kind || '').toLowerCase();
  const isSellingLocation = location && locationType !== 'storage' && String(location?.id || '') !== 'main';
  const siteInfo = normalizeDocumentSiteInfo(location?.siteInfo || {});
  return isSellingLocation && hasDocumentSiteInfo(siteInfo) ? siteInfo : {};
}

function normalizeDocumentSiteInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    siteTradingName: String(source.siteTradingName || '').trim(),
    supplierFacingDeliveryName: String(source.supplierFacingDeliveryName || '').trim(),
    deliveryAddressLine1: String(source.deliveryAddressLine1 || '').trim(),
    deliveryAddressLine2: String(source.deliveryAddressLine2 || '').trim(),
    suburb: String(source.suburb || '').trim(),
    city: String(source.city || '').trim(),
    province: String(source.province || '').trim(),
    postalCode: String(source.postalCode || '').trim(),
    country: String(source.country || '').trim(),
    receivingContactName: String(source.receivingContactName || '').trim(),
    receivingContactPhone: String(source.receivingContactPhone || '').trim(),
    receivingContactEmail: String(source.receivingContactEmail || '').trim(),
    deliveryInstructions: String(source.deliveryInstructions || '').trim(),
    receivingHours: String(source.receivingHours || '').trim(),
    supplierNotes: String(source.supplierNotes || '').trim()
  };
}

function hasDocumentSiteInfo(siteInfo = {}) {
  return Boolean(firstText(
    siteInfo.supplierFacingDeliveryName,
    siteInfo.siteTradingName,
    siteInfo.deliveryAddressLine1,
    siteInfo.receivingContactName,
    siteInfo.receivingContactPhone,
    siteInfo.receivingContactEmail,
    siteInfo.deliveryInstructions
  ));
}

function isDocumentSiteInfoComplete(siteInfo = {}) {
  const info = normalizeDocumentSiteInfo(siteInfo);
  return Boolean(info.supplierFacingDeliveryName && info.deliveryAddressLine1 && info.city && firstText(info.receivingContactName, info.receivingContactPhone, info.receivingContactEmail));
}

function isSellingLocationMissingSiteInfo(location = null) {
  if (!location) return false;
  const locationType = String(location.type || location.kind || '').toLowerCase();
  if (locationType === 'storage' || String(location.id || '') === 'main') return false;
  return !isDocumentSiteInfoComplete(location.siteInfo || {});
}

function buildDocumentSiteAddress(siteInfo = {}) {
  return [
    siteInfo.deliveryAddressLine1,
    siteInfo.deliveryAddressLine2,
    siteInfo.suburb,
    siteInfo.city,
    siteInfo.province,
    siteInfo.postalCode,
    siteInfo.country
  ].map((part) => String(part || '').trim()).filter(Boolean).join(', ');
}

function normalizeDocumentTaxInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    useDifferentTaxInfo: source.useDifferentTaxInfo === true || String(source.useDifferentTaxInfo || '').toLowerCase() === 'true',
    registeredCompanyName: String(source.registeredCompanyName || '').trim(),
    tradingName: String(source.tradingName || '').trim(),
    companyRegistrationNumber: String(source.companyRegistrationNumber || '').trim(),
    vatNumber: String(source.vatNumber || '').trim(),
    taxNumber: String(source.taxNumber || '').trim(),
    registeredAddress: String(source.registeredAddress || '').trim(),
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

function hasDocumentTaxInfo(taxInfo = {}) {
  return Boolean(firstText(
    taxInfo.registeredCompanyName,
    taxInfo.tradingName,
    taxInfo.companyRegistrationNumber,
    taxInfo.vatNumber,
    taxInfo.taxNumber,
    taxInfo.registeredAddress,
    taxInfo.registeredAddressLine1,
    taxInfo.accountsContactEmail
  ));
}

function enrichPurchaseOrderForDocument(order = {}, supplier = null, context = getPurchaseOrderDocumentContext(order, supplier)) {
  const supplierName = firstText(order.supplierName, supplier?.name, 'Unassigned Supplier');
  return {
    ...order,
    supplyForName: context.companyName,
    companyVatNumber: context.companyVatNumber,
    supplierName,
    supplierVatNumber: firstText(context.supplierVatNumber, order.supplierVatNumber),
    supplierAccountNumber: firstText(supplier?.accountNumber, order.supplierAccountNumber),
    supplierContact: firstText(supplier?.contactPerson, supplier?.contact, order.supplierContact, supplierName)
  };
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function formatDocumentQuantity(value) {
  if (value === '' || value === null || value === undefined) return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toLocaleString('en-ZA', { maximumFractionDigits: 4 });
}

function getPurchaseOrderLinePackSize(item = {}) {
  const candidates = [
    item.packSize,
    item.pack_size,
    item.pack,
    item.packQty,
    item.packQuantity,
    item.caseSize,
    item.case_size,
    item.unitsPerPack,
    item.units_per_pack,
    item.unitPackSize
  ];
  const value = candidates.find((candidate) => {
    const number = Number(candidate);
    return Number.isFinite(number) && number > 0;
  });
  return Number(value || 1) || 1;
}

function normalizePurchaseOrderStatusForDocument(status = '') {
  const value = String(status || 'draft').toLowerCase();
  if (value === 'sent' || value === 'submitted') return 'Sent';
  if (value === 'partially_received' || value === 'partial' || value === 'partially received') return 'Partially Received';
  if (value === 'completed' || value === 'received') return 'Completed';
  return 'Draft';
}

function isRecoverablePurchaseOrderEmailError(error) {
  const message = String(error?.message || '').toLowerCase();
  return /connect gmail|gmail oauth|not configured|not connected|sign in|gmail api|api has not been used|service_disabled|accessnotconfigured|disabled|permission is missing|reconnect gmail/.test(message);
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function requestPurchaseOrderDelete(payload = {}) {
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return;
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    confirmDelete: {
      ids,
      mode: payload.mode || (ids.length > 1 ? 'bulk' : 'single')
    },
    actionError: ''
  };
  renderApp();
}

function cancelPurchaseOrderDelete() {
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    confirmDelete: null,
    actionStatus: '',
    actionError: ''
  };
  renderApp();
}

async function confirmPurchaseOrderDelete() {
  const ids = appState.purchaseOrders.confirmDelete?.ids || [];
  if (!ids.length) return;

  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    actionStatus: 'deleting',
    actionError: ''
  };
  renderApp();

  try {
    const { deletePurchaseOrder, deleteMultiplePurchaseOrders } = await import('./services/purchaseOrderService.js');
    if (ids.length === 1) await deletePurchaseOrder(appState.workspace?.id, ids[0]);
    else await deleteMultiplePurchaseOrders(appState.workspace?.id, ids);

    const deletedIds = new Set(ids.map(String));
    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      orders: removeRowsByIds(appState.purchaseOrders.orders, deletedIds),
      selectedIds: (appState.purchaseOrders.selectedIds || []).filter((id) => !deletedIds.has(String(id))),
      confirmDelete: null,
      actionStatus: '',
      actionError: '',
      draftOrder: deletedIds.has(String(appState.purchaseOrders.draftOrder?.id || '')) ? null : appState.purchaseOrders.draftOrder
    };
    renderApp();
    showPurchaseOrderToast(ids.length === 1 ? 'Purchase order deleted.' : `${ids.length} purchase orders deleted.`, 'success');
    refreshActiveTabFromApi().catch(() => {});
  } catch (error) {
    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      actionStatus: '',
      actionError: error.message || 'Could not delete purchase orders.'
    };
    renderApp();
  }
}

function exportPurchaseOrdersCsv() {
  exportPurchaseOrdersFixed('csv');
}

function exportPurchaseOrdersXlsx() {
  exportPurchaseOrdersFixed('xlsx');
}

function exportPurchaseOrderPdf(orderId) {
  exportPurchaseOrdersFixed('pdf', orderId);
}

async function exportPurchaseOrdersFixed(format = 'csv', orderId = '') {
  const orders = orderId ? [getPurchaseOrderById(orderId)].filter(Boolean) : getPurchaseOrderExportData().orders;

  if (!orders.length) {
    showPurchaseOrderToast(orderId ? 'Purchase order could not be found.' : 'No purchase orders are available to export.', 'warning');
    return;
  }

  const supplierMap = new Map((appState.purchaseOrders.suppliers || []).map((supplier) => [String(supplier.id), supplier]));
  const baseContext = getPurchaseOrderDocumentContext();
  const documentOrders = orders.map((order) => {
    const supplier = supplierMap.get(String(order?.supplierId || '')) || null;
    return enrichPurchaseOrderForDocument(order, supplier, getPurchaseOrderDocumentContext(order, supplier));
  });

  if (format === 'pdf' && orderId && documentOrders[0]) {
    try {
      const context = getPurchaseOrderDocumentContext(orders[0], supplierMap.get(String(orders[0]?.supplierId || '')) || null);
      const pdfFile = await buildSupplierPurchaseOrderPdfFile(
        buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Purchase Order Export', suffix: orders[0].reference || orders[0].poNumber }),
        documentOrders[0],
        context
      );
      downloadFileBlob(pdfFile, pdfFile.name);
      showPurchaseOrderToast('Purchase order exported as PDF.', 'success');
    } catch (error) {
      showPurchaseOrderToast(error.message || 'Purchase order export failed.', 'error');
    }
    return;
  }

  const rows = buildPurchaseOrderDocumentRows(documentOrders, {
    siteName: baseContext.companyName,
    getLocationName: getPurchaseOrderLocationName
  });

  try {
    await exportAoaRows({
      format,
      filename: buildExportFilename({
        workspaceName: appState.workspace?.siteName,
        reportType: 'Purchase Order Export',
        suffix: orderId ? (orders[0].reference || orders[0].poNumber) : ''
      }),
      sheetName: 'Purchase Order',
      title: orderId ? orders[0].poNumber : 'Purchase Orders',
      subtitle: `${baseContext.companyName} · ${orders.length} order${orders.length === 1 ? '' : 's'}`,
      rows,
      headerRowIndex: 11,
      branding: getPdfBranding()
    });
    showPurchaseOrderToast(`${orders.length} purchase order${orders.length === 1 ? '' : 's'} exported as ${format.toUpperCase()}.`, 'success');
  } catch (error) {
    showPurchaseOrderToast(error.message || 'Purchase order export failed.', 'error');
  }
}

function dismissPurchaseOrderToast() {
  if (purchaseOrderToastTimer) {
    window.clearTimeout(purchaseOrderToastTimer);
    purchaseOrderToastTimer = null;
  }
  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    toast: null
  };
  renderApp();
}

function updateGrvFilters(nextFilters) {
  const nextMerged = {
    ...appState.grv.filters,
    ...nextFilters
  };
  const currentEntries = Object.entries(appState.grv.filters || {});
  const changed = currentEntries.some(([key, value]) => nextMerged[key] !== value)
    || Object.keys(nextMerged).some((key) => !(key in (appState.grv.filters || {})));
  if (!changed) return;

  appState.grv = {
    ...appState.grv,
    filters: nextMerged
  };
  renderApp();
}

function createEmptyGrvDraft(seed = {}) {
  const locationId = String(seed.locationId || '');
  const locationName = seed.locationName || (locationId ? getGrvLocationName(locationId, '') : '');
  const siteId = seed.siteId || getSiteIdForLocation(appState.grv?.locations || [], locationId);
  return {
    id: '',
    grvNumber: '',
    sourcePoId: '',
    poNumber: '',
    supplierId: '',
    supplierName: '',
    date: todayLocal(),
    siteId,
    siteName: seed.siteName || getSiteNameById(appState.grv?.sites || [], siteId, ''),
    locationId,
    locationName,
    notes: '',
    pricesIncludeVat: false,
    overrideCostPrice: true,
    transportEx: '',
    invoiceDiscountEx: '',
    invoiceTotalEx: '',
    splitByLocation: false,
    items: [],
    ...seed
  };
}

function ensureGrvDraft() {
  if (appState.grv.draftReceipt) return;
  appState.grv = {
    ...appState.grv,
    draftReceipt: createEmptyGrvDraft(),
    actionError: ''
  };
  renderApp();
}

function openManualGrvDraft() {
  appState.grv = {
    ...appState.grv,
    pendingSourcePoId: '',
    lineDetailDraft: null,
    missingSupplierPrompt: null,
    draftReceipt: createEmptyGrvDraft(),
    actionError: '',
    filters: {
      ...appState.grv.filters,
      lineQuery: '',
      poQuery: '',
      selectedStockIds: [],
      selectedLineIndexes: [],
      calendarCursor: '',
      openDropdown: '',
      overlay: ''
    }
  };
  clearPersistedDraft('grv');
  renderApp();
}


function normalizeSupplierLookupName(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getInMemorySupplierMatch({ supplierId = '', supplierName = '' } = {}) {
  const trimmedId = String(supplierId || '').trim();
  const lookupName = normalizeSupplierLookupName(supplierName);

  return (appState.suppliers.items || []).find((supplier) => {
    if (trimmedId && String(supplier.id || '').trim() === trimmedId) return true;
    return lookupName && normalizeSupplierLookupName(supplier.name) === lookupName;
  }) || null;
}

function setDraftSupplierIdIfCurrentNameMatches(supplier = {}, expectedName = '') {
  const supplierId = String(supplier.id || '').trim();
  const currentDraft = appState.grv.draftReceipt || createEmptyGrvDraft();
  if (!supplierId) return;
  if (normalizeSupplierLookupName(currentDraft.supplierName) !== normalizeSupplierLookupName(expectedName || supplier.name)) return;
  if (String(currentDraft.supplierId || '').trim() === supplierId) return;

  appState.grv = {
    ...appState.grv,
    draftReceipt: {
      ...currentDraft,
      supplierId
    }
  };
  renderApp();
}

async function resolveWorkspaceSupplier(candidate = {}) {
  const inMemory = getInMemorySupplierMatch(candidate);
  if (inMemory) return inMemory;

  const workspaceId = appState.workspace?.id;
  if (!workspaceId) return null;

  const { fetchSuppliers } = await import('./services/supplierService.js');
  const snapshot = await fetchSuppliers(workspaceId);
  const trimmedId = String(candidate.supplierId || '').trim();
  const lookupName = normalizeSupplierLookupName(candidate.supplierName || candidate.name);

  return (snapshot.items || []).find((supplier) => {
    if (trimmedId && String(supplier.id || '').trim() === trimmedId) return true;
    return lookupName && normalizeSupplierLookupName(supplier.name) === lookupName;
  }) || null;
}

function queueMissingGrvSupplierPrompt(candidate = {}) {
  const supplierName = String(candidate.supplierName || candidate.name || '').trim();
  if (!supplierName) return;

  const currentPrompt = appState.grv.missingSupplierPrompt;
  if (
    currentPrompt &&
    normalizeSupplierLookupName(currentPrompt.supplierName) === normalizeSupplierLookupName(supplierName)
  ) {
    return;
  }

  appState.grv = {
    ...appState.grv,
    actionError: '',
    missingSupplierPrompt: {
      supplierId: String(candidate.supplierId || '').trim(),
      supplierName,
      sourceLabel: candidate.sourceLabel || 'GRV',
      referenceLabel: candidate.referenceLabel || '',
      mode: 'confirm',
      formValues: createGrvSupplierFormValues(supplierName),
      error: ''
    }
  };
  renderApp();
}

async function maybePromptToCreateGrvSupplier(candidate = {}) {
  const supplierName = String(candidate.supplierName || candidate.name || '').trim();
  if (!supplierName || normalizeSupplierLookupName(supplierName) === 'manual receipt') return;

  try {
    const existingSupplier = await resolveWorkspaceSupplier(candidate);
    if (existingSupplier) {
      setDraftSupplierIdIfCurrentNameMatches(existingSupplier, supplierName);
      return;
    }
  } catch (error) {
    showGrvToast(error.message || 'Could not verify the supplier list.', 'warning');
    return;
  }

  queueMissingGrvSupplierPrompt(candidate);
}

function dismissGrvMissingSupplierPrompt() {
  const prompt = appState.grv.missingSupplierPrompt;
  if (!prompt) return;
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  const shouldClearSupplier = normalizeSupplierLookupName(draft.supplierName) === normalizeSupplierLookupName(prompt.supplierName);
  appState.grv = {
    ...appState.grv,
    missingSupplierPrompt: null,
    draftReceipt: shouldClearSupplier
      ? {
          ...draft,
          supplierId: '',
          supplierName: ''
        }
      : draft
  };
  renderApp();
}

async function continueGrvWithoutSupplier() {
  if (!appState.grv.missingSupplierPrompt) return;
  appState.grv = {
    ...appState.grv,
    missingSupplierPrompt: null,
    actionError: ''
  };
  renderApp();
  await saveGrvReceipt({ skipSupplierValidation: true });
}

function openGrvMissingSupplierForm() {
  const prompt = appState.grv.missingSupplierPrompt;
  if (!prompt) return;
  appState.grv = {
    ...appState.grv,
    missingSupplierPrompt: {
      ...prompt,
      mode: 'form',
      error: '',
      formValues: {
        ...createGrvSupplierFormValues(prompt.supplierName),
        ...(prompt.formValues || {})
      }
    }
  };
  renderApp();
}

function updateGrvMissingSupplierField(updates = {}) {
  const prompt = appState.grv.missingSupplierPrompt;
  if (!prompt) return;
  appState.grv = {
    ...appState.grv,
    missingSupplierPrompt: {
      ...prompt,
      error: '',
      formValues: {
        ...(prompt.formValues || createGrvSupplierFormValues(prompt.supplierName)),
        ...updates
      }
    }
  };
  renderApp();
}

async function saveGrvMissingSupplier() {
  const prompt = appState.grv.missingSupplierPrompt;
  const workspaceId = appState.workspace?.id;
  if (!prompt || !workspaceId) return;

  const formValues = {
    ...createGrvSupplierFormValues(prompt.supplierName),
    ...(prompt.formValues || {})
  };
  const validationErrors = validateSupplierPayload(formValues);
  const validationError = getSupplierValidationMessage(validationErrors);
  if (validationError) {
    appState.grv = {
      ...appState.grv,
      missingSupplierPrompt: {
        ...prompt,
        mode: 'form',
        formValues,
        error: validationError
      }
    };
    renderApp();
    return;
  }

  appState.grv = {
    ...appState.grv,
    actionStatus: 'adding-supplier',
    actionError: ''
  };
  renderApp();

  try {
    const { normalizeSupplier, upsertSupplier } = await import('./services/supplierService.js');
    const result = await upsertSupplier(workspaceId, {
      ...formValues,
      id: prompt.supplierId || ''
    });
    const nextSupplier = normalizeSupplier(result.id, {
      id: result.id,
      workspaceId,
      ...formValues
    }, 'local', workspaceId);
    const existingIds = new Set((appState.suppliers.items || []).map((supplier) => String(supplier.id)));

    appState.grv = {
      ...appState.grv,
      actionStatus: '',
      missingSupplierPrompt: null,
      draftReceipt: {
        ...(appState.grv.draftReceipt || createEmptyGrvDraft()),
        supplierId: result.id
      }
    };
    appState.suppliers = {
      ...appState.suppliers,
      items: existingIds.has(String(nextSupplier.id))
        ? appState.suppliers.items
        : [...(appState.suppliers.items || []), nextSupplier]
    };
    renderApp();
    // Continue the GRV commit in the SAME action so the user never commits twice. Skip supplier
    // re-validation (the new supplier may not be in the re-fetch cache yet) — the commit reads the
    // draft.supplierId we just set. A single success toast is fired by the commit itself.
    await saveGrvReceipt({ skipSupplierValidation: true });
  } catch (error) {
    appState.grv = {
      ...appState.grv,
      actionStatus: '',
      actionError: error.message || 'Could not add the supplier.',
      missingSupplierPrompt: {
        ...prompt,
        mode: 'form',
        formValues,
        error: error.message || 'Could not add the supplier.'
      }
    };
    renderApp();
  }
}

function createGrvSupplierFormValues(name = '') {
  return {
    name: String(name || '').trim(),
    contactPerson: '',
    email: '',
    phone: '',
    category: 'General',
    leadTime: '0',
    paymentTerms: 'COD',
    accountNumber: '',
    address: ''
  };
}

async function loadLastGrvInvoice() {
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  const supplierName = String(draft.supplierName || '').trim().toLowerCase();
  if (!supplierName) {
    showGrvToast('Enter a supplier name first.', 'warning');
    return;
  }

  const draftSupplierId = String(draft.supplierId || '').trim();
  const receipts = (appState.grv.receipts || [])
    // Match by supplierId first (robust), then fall back to a normalized name compare.
    .filter((receipt) => {
      if (draftSupplierId && String(receipt.supplierId || '').trim() === draftSupplierId) return true;
      return String(receipt.supplierName || receipt.supplier || '').trim().toLowerCase() === supplierName;
    })
    .sort((left, right) => new Date(right.timestamp || right.date || 0) - new Date(left.timestamp || left.date || 0));

  if (!receipts.length) {
    const stillLoading = appState.grv.status === 'loading' || !(appState.grv.receipts || []).length && appState.grv.loaded === false;
    showGrvToast(stillLoading
      ? 'Invoice history is still loading — try again in a moment.'
      : 'No previous invoices were found for this supplier.', 'warning');
    return;
  }

  if ((draft.items || []).length) {
    const confirmed = await showBrandConfirmDialog({
      eyebrow: 'Load Last Invoice',
      title: 'Replace current GRV draft?',
      message: `This will replace the current ${draft.items.length}-line draft with the latest invoice found for ${draft.supplierName}.`,
      confirmLabel: 'Replace Draft',
      cancelLabel: 'Keep Current Draft',
      tone: 'warning'
    });
    if (!confirmed) return;
  }

  const latest = receipts[0];
  const items = (latest.items || []).map((line) => {
    const stockItem = getGrvStockItemById(line.stockItemId || line.ingId || line.id);
    const locationId = String(line.locationId || line.targetLocation || draft.locationId || getDefaultGrvLocationId() || 'main');
    const locationName = line.locationName || line.targetLocationName || getGrvLocationName(locationId, 'Main Store');
    return {
      id: stockItem?.id || line.id || line.stockItemId || line.ingId,
      stockItemId: stockItem?.id || line.stockItemId || line.ingId || line.id,
      stockItemName: stockItem?.name || line.stockItemName || line.name || 'Unnamed Stock Item',
      unit: line.unit || stockItem?.unit || 'ea',
      selectedUom: line.selectedUom || line.receivingUom || line.purchaseUom || line.unit || stockItem?.unit || 'ea',
      uomConfigurations: normalizeLineUomConfigurations(line.uomConfigurations || stockItem?.uomConfigurations || stockItem?.uomConfig || stockItem?.uomConversions),
      orderedQty: Number(line.orderedQty ?? line.receivedQty ?? line.qty ?? 0),
      receivedQty: Number(line.receivedQty ?? line.qty ?? 0),
      packSize: Number(line.packSize || 1),
      unitCost: Number(line.unitCost ?? line.costEx ?? line.price ?? stockItem?.lastPurchasePrice ?? stockItem?.cost ?? 0),
      vatEnabled: line.vatEnabled !== false && stockItem?.vatEnabled !== false,
      locationId,
      targetLocation: locationId,
      locationName,
      targetLocationName: locationName
    };
  }).filter((line) => line.stockItemId);

  appState.grv = {
    ...appState.grv,
    missingSupplierPrompt: null,
    draftReceipt: {
      ...draft,
      supplierId: latest.supplierId || draft.supplierId || '',
      supplierName: latest.supplierName || latest.supplier || draft.supplierName,
      items
    },
    actionError: ''
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
  showGrvToast(`Loaded ${items.length} ${items.length === 1 ? 'item' : 'items'} from the latest ${latest.invoice || latest.grvNumber || 'invoice'}.`, 'success');
  await maybePromptToCreateGrvSupplier({
    supplierId: latest.supplierId || draft.supplierId || '',
    supplierName: latest.supplierName || latest.supplier || draft.supplierName,
    sourceLabel: 'Loaded invoice',
    referenceLabel: latest.invoice || latest.grvNumber || ''
  });
}

async function openGrvFromPurchaseOrder(orderId) {
  const order = getGrvPurchaseOrderById(orderId);
  if (!order) {
    if (!appState.grv.loaded?.orders || appState.grv.status === 'loading') {
      appState.grv = {
        ...appState.grv,
        pendingSourcePoId: String(orderId || '').trim()
      };
      return;
    }
    showGrvToast('Purchase order could not be found.', 'error');
    return;
  }

  const orderLineLocationIds = (order.items || [])
    .map((line) => String(line.locationId || line.targetLocation || '').trim())
    .filter(Boolean);
  const locationId = String(order.locationId || order.targetLocation || orderLineLocationIds[0] || '');
  const locationName = locationId ? getGrvLocationName(locationId, '') : '';
  const receiptItems = (order.items || []).flatMap((line) => {
    const orderedQty = Number(line.qty || 0);
    const alreadyReceivedQty = Number(line.receivedQty || 0);
    const outstandingQty = Math.max(orderedQty - alreadyReceivedQty, 0);
    if (outstandingQty <= 0) return [];
    const lineLocationId = String(line.locationId || line.targetLocation || locationId || fallbackLocationId);
    const lineLocationName = line.locationName || line.targetLocationName || getGrvLocationName(lineLocationId, locationName);
    const stockItem = getGrvStockItemById(line.stockItemId);
    if (stockItem && !isOrderableStockItem(stockItem)) return [];
    return [{
      id: line.id || line.stockItemId,
      purchaseOrderLineId: line.id || '',
      stockItemId: line.stockItemId,
      stockItemName: line.stockItemName,
      unit: line.unit || stockItem?.unit || 'ea',
      selectedUom: line.selectedUom || line.purchaseUom || line.orderUom || line.unit || stockItem?.unit || 'ea',
      uomConfigurations: normalizeLineUomConfigurations(line.uomConfigurations || stockItem?.uomConfigurations || stockItem?.uomConfig || stockItem?.uomConversions),
      orderedQty: outstandingQty,
      receivedQty: outstandingQty,
      packSize: Number(line.packSize || 1),
      unitCost: Number(line.unitCost || 0),
      vatEnabled: line.vatEnabled !== false && stockItem?.vatEnabled !== false,
      locationId: lineLocationId,
      targetLocation: lineLocationId,
      locationName: lineLocationName,
      targetLocationName: lineLocationName
    }];
  });
  const uniqueReceiptLocations = new Set(receiptItems.map((line) => String(line.locationId || line.targetLocation || '')).filter(Boolean));
  appState.grv = {
    ...appState.grv,
    pendingSourcePoId: '',
    lineDetailDraft: null,
    missingSupplierPrompt: null,
    draftReceipt: createEmptyGrvDraft({
      sourcePoId: order.id,
      poNumber: order.poNumber || order.reference || '',
      grvNumber: order.reference || order.poNumber || '',
      supplierId: order.supplierId || '',
      supplierName: order.supplierName || 'Unassigned Supplier',
      date: todayLocal(),
      locationId,
      locationName,
      splitByLocation: uniqueReceiptLocations.size > 1,
      items: receiptItems
    }),
    actionError: '',
    filters: {
      ...appState.grv.filters,
      lineQuery: '',
      poQuery: '',
      selectedStockIds: [],
      selectedLineIndexes: [],
      calendarCursor: '',
      openDropdown: '',
      overlay: ''
    }
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
  await maybePromptToCreateGrvSupplier({
    supplierId: order.supplierId || '',
    supplierName: order.supplierName || '',
    sourceLabel: 'Purchase order',
    referenceLabel: order.poNumber || order.reference || ''
  });
}

function closeGrvDraft() {
  appState.grv = {
    ...appState.grv,
    pendingSourcePoId: '',
    lineDetailDraft: null,
    missingSupplierPrompt: null,
    draftReceipt: createEmptyGrvDraft(),
    actionStatus: '',
    actionError: '',
    filters: {
      ...appState.grv.filters,
      lineQuery: '',
      poQuery: '',
      selectedStockIds: [],
      selectedLineIndexes: [],
      calendarCursor: '',
      openDropdown: '',
      overlay: ''
    }
  };
  clearPersistedDraft('grv');
  renderApp();
}

function updateGrvDraft(updates = {}) {
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();

  const normalizedUpdates = { ...updates };
  const isPoLinkedDraft = Boolean(String(draft.sourcePoId || '').trim());
  if (Object.hasOwn(normalizedUpdates, 'siteId')) {
    const nextSiteId = String(normalizedUpdates.siteId || '');
    normalizedUpdates.locationId = getFirstLocationIdForSite(appState.grv.locations || [], nextSiteId);
    normalizedUpdates.siteName = getSiteNameById(appState.grv.sites || [], nextSiteId, '');
  }
  if (Object.hasOwn(normalizedUpdates, 'locationId')) {
    const nextLocationId = String(normalizedUpdates.locationId || '');
    const previousLocationId = String(draft.locationId || '');
    const nextLocationName = normalizedUpdates.locationName || getGrvLocationName(nextLocationId, '');
    normalizedUpdates.siteId = getSiteIdForLocation(appState.grv.locations || [], nextLocationId) || normalizedUpdates.siteId || '';
    normalizedUpdates.siteName = getSiteNameById(appState.grv.sites || [], normalizedUpdates.siteId, normalizedUpdates.siteName || '');
    normalizedUpdates.locationName = nextLocationName;
    normalizedUpdates.items = (draft.items || []).map((line) => {
      const lineLocationId = String(line.locationId || '');
      const followsDefaultLocation = !lineLocationId || lineLocationId === previousLocationId;
      if (!followsDefaultLocation) return line;
      return {
        ...line,
        locationId: nextLocationId,
        targetLocation: nextLocationId,
        locationName: nextLocationName,
        targetLocationName: nextLocationName
      };
    });
  }

  if (Object.hasOwn(normalizedUpdates, 'pricesIncludeVat')) {
    normalizedUpdates.items = (normalizedUpdates.items || draft.items || []).map((line) => {
      const nextLine = { ...line };
      delete nextLine.unitCostDisplay;
      return nextLine;
    });
  }

  if (Object.hasOwn(normalizedUpdates, 'splitByLocation') && normalizedUpdates.splitByLocation !== true && isPoLinkedDraft) {
    const lines = normalizedUpdates.items || draft.items || [];
    normalizedUpdates.splitByLocation = hasMultipleGrvLineLocations(lines);
  } else if (Object.hasOwn(normalizedUpdates, 'splitByLocation') && normalizedUpdates.splitByLocation !== true) {
    const defaultLocationId = getDefaultGrvLocationId();
    const defaultLocationName = getGrvLocationName(defaultLocationId, 'Main Store');
    normalizedUpdates.locationId = defaultLocationId;
    normalizedUpdates.locationName = defaultLocationName;
    normalizedUpdates.siteId = getSiteIdForLocation(appState.grv.locations || [], defaultLocationId) || '';
    normalizedUpdates.siteName = getSiteNameById(appState.grv.sites || [], normalizedUpdates.siteId, '');
    normalizedUpdates.items = (normalizedUpdates.items || draft.items || []).map((line) => ({
      ...line,
      splitGroupId: '',
      splitExpectedQty: '',
      locationId: defaultLocationId,
      targetLocation: defaultLocationId,
      locationName: defaultLocationName,
      targetLocationName: defaultLocationName
    }));
  }

  appState.grv = {
    ...appState.grv,
    draftReceipt: {
      ...draft,
      ...normalizedUpdates
    },
    actionError: ''
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function hasMultipleGrvLineLocations(lines = []) {
  return new Set((lines || [])
    .map((line) => String(line.locationId || line.targetLocation || '').trim())
    .filter(Boolean)).size > 1;
}

function buildGrvDraftLine(stockItem, draft) {
  // Do not auto-fill a default (Main Store) location — a new GRV line inherits the
  // header destination if one is set, otherwise stays blank so the user must choose.
  const locationId = draft.locationId || '';
  const locationName = locationId ? getGrvLocationName(locationId, '') : '';
  const uomSelection = getDefaultLineUomSelection(stockItem, appState.grv.filters?.lineQuery || '');
  return {
    id: stockItem.id,
    stockItemId: stockItem.id,
    stockItemName: stockItem.name,
    category: stockItem.category || '',
    unit: stockItem.unit || 'ea',
    selectedUom: uomSelection.selectedUom,
    uomConfigurations: normalizeLineUomConfigurations(stockItem.uomConfigurations || stockItem.uomConfig || stockItem.uomConversions),
    orderedQty: 0,
    receivedQty: '',
    packSize: uomSelection.ratio,
    unitCost: Number(stockItem.lastPurchasePrice ?? stockItem.lastPurchaseCost ?? stockItem.latestPurchasePrice ?? stockItem.cost ?? 0),
    vatEnabled: stockItem.vatEnabled !== false,
    locationId,
    targetLocation: locationId,
    locationName,
    targetLocationName: locationName
  };
}

function createGrvLineDetailEntry(line, index) {
  const packSize = Number(line.packSize || 1) > 0 ? Number(line.packSize || 1) : 1;
  const packQty = Number(line.receivedQty ?? line.packQty ?? 0) || 0;
  const unitCost = Number(line.unitCost || 0) || 0;
  const packPriceEx = Number(line.packPriceEx ?? (unitCost * packSize)) || 0;
  const pricesIncludeVat = appState.grv.draftReceipt?.pricesIncludeVat;
  const vatRateFactor = pricesIncludeVat ? (1 + (getVatRate() / 100)) : 1;
  return {
    index,
    stockItemId: line.stockItemId || line.id || '',
    stockItemName: line.stockItemName || 'Unnamed Stock Item',
    category: line.category || '',
    unit: line.unit || 'ea',
    selectedUom: line.selectedUom || line.receivingUom || line.purchaseUom || line.unit || 'ea',
    uomConfigurations: normalizeLineUomConfigurations(line.uomConfigurations || line.uomConfig || line.uomConversions),
    receivedQty: String(packQty || ''),
    packSize: String(packSize),
    unitCost: String(unitCost || ''),
    packPriceEx: String(packPriceEx || ''),
    packPriceDisplay: String(Number((packPriceEx * vatRateFactor).toFixed(2))),
    vatEnabled: line.vatEnabled !== false,
    locationId: String(line.locationId || line.targetLocation || appState.grv.draftReceipt?.locationId || ''),
    locationName: String(line.locationName || line.targetLocationName || '')
  };
}

function createGrvLineDetailDraft(entries = []) {
  return {
    entries: entries.map((entry) => ({ ...entry }))
  };
}

function openGrvLineDetail(index) {
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  const line = draft.items?.[index];
  if (!line) return;
  appState.grv = {
    ...appState.grv,
    lineDetailDraft: createGrvLineDetailDraft([createGrvLineDetailEntry(line, index)]),
    actionError: ''
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function updateGrvLineDetailDraft(entryIndex, updates = {}) {
  const current = appState.grv.lineDetailDraft;
  if (!current?.entries?.[entryIndex]) return;
  const currentEntry = current.entries[entryIndex];
  const next = {
    ...currentEntry,
    ...updates
  };
  const changedKeys = new Set(Object.keys(updates));
  const pricesIncludeVat = appState.grv.draftReceipt?.pricesIncludeVat;
  const vatRateFactor = pricesIncludeVat ? (1 + (getVatRate() / 100)) : 1;
  const parseDecimal = (value, fallback = 0) => {
    const numeric = Number.parseFloat(String(value ?? '').replace(',', '.'));
    return Number.isFinite(numeric) ? numeric : fallback;
  };
  const packQty = Math.max(parseDecimal(next.receivedQty, 0), 0);
  const packSize = getPositivePackSizeValue(next.packSize);
  let unitCost = Math.max(parseDecimal(next.unitCost, 0), 0);
  let packPriceEx = Math.max(parseDecimal(next.packPriceEx, unitCost * packSize), 0);

  if (changedKeys.has('packPriceEx')) {
    unitCost = packSize > 0 ? packPriceEx / packSize : 0;
  } else if (changedKeys.has('unitCost')) {
    packPriceEx = unitCost * packSize;
  } else if (changedKeys.has('packSize')) {
    const lockedUnitCost = Math.max(parseDecimal(current.unitCost, unitCost), 0);
    unitCost = lockedUnitCost;
    packPriceEx = lockedUnitCost * packSize;
  }

  const entries = [...current.entries];
  const nextPackPriceDisplay = changedKeys.has('packPriceEx')
    ? String(updates.packPriceDisplay ?? next.packPriceDisplay ?? next.packPriceEx ?? '')
    : stringifyDecimalField(next.packPriceDisplay, packPriceEx * vatRateFactor);
  entries[entryIndex] = {
    ...next,
    receivedQty: stringifyDecimalField(next.receivedQty, packQty),
    packSize: stringifyDecimalField(next.packSize, packSize),
    unitCost: stringifyDecimalField(next.unitCost, unitCost),
    packPriceEx: stringifyDecimalField(next.packPriceEx, packPriceEx),
    packPriceDisplay: nextPackPriceDisplay
  };

  appState.grv = {
    ...appState.grv,
    lineDetailDraft: createGrvLineDetailDraft(entries)
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function cancelGrvLineDetail() {
  if (!appState.grv.lineDetailDraft) return;
  appState.grv = {
    ...appState.grv,
    lineDetailDraft: null
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function updateGrvLineDetailLocationAll(locationId = '', locationName = '') {
  const current = appState.grv.lineDetailDraft;
  if (!current?.entries?.length) return;
  const nextLocationId = String(locationId || '');
  const nextLocationName = locationName || getGrvLocationName(nextLocationId, '');
  appState.grv = {
    ...appState.grv,
    lineDetailDraft: createGrvLineDetailDraft(
      current.entries.map((entry) => ({
        ...entry,
        locationId: nextLocationId,
        locationName: nextLocationName
      }))
    )
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function applyGrvLineDetail() {
  const detail = appState.grv.lineDetailDraft;
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  if (!detail?.entries?.length) return;

  const items = [...draft.items];
  detail.entries.forEach((entry) => {
    if (!draft.items?.[entry.index]) return;
    const locationId = String(entry.locationId || draft.locationId || '');
    const locationName = entry.locationName || getGrvLocationName(locationId, '');
    const packQty = Number(entry.receivedQty || 0) || 0;
    const packSize = getPositivePackSizeValue(entry.packSize);
    const packPriceEx = Number(entry.packPriceEx || 0) || 0;
    const unitCost = packSize > 0 ? packPriceEx / packSize : Number(entry.unitCost || 0) || 0;
    items[entry.index] = {
      ...items[entry.index],
      receivedQty: String(packQty),
      packQty,
      packSize: String(packSize),
      unitCost: String(unitCost),
      packPriceEx,
      vatEnabled: entry.vatEnabled !== false,
      locationId,
      targetLocation: locationId,
      locationName,
      targetLocationName: locationName
    };
  });

  appState.grv = {
    ...appState.grv,
    lineDetailDraft: null,
    draftReceipt: {
      ...draft,
      items
    },
    actionError: ''
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function addGrvLine(stockItemId) {
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  const stockItem = getGrvStockItemById(stockItemId);
  if (!draft || !stockItem) return;
  if (!isOrderableStockItem(stockItem)) {
    showGrvToast('Only Standard and Non Stock items can be added to GRV.', 'warning');
    return;
  }

  const items = [...(draft.items || [])];
  if (items.some((line) => String(line.stockItemId) === String(stockItem.id))) return;
  items.push(buildGrvDraftLine(stockItem, draft));

  appState.grv = {
    ...appState.grv,
    lineDetailDraft: null,
    draftReceipt: {
      ...draft,
      items
    },
    filters: {
      ...appState.grv.filters,
      overlay: 'draft',
      lineQuery: '',
      selectedStockIds: [],
      selectedLineIndexes: [],
      calendarCursor: ''
    },
    actionError: ''
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function addMultipleGrvLines(stockItemIds = []) {
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  const nextItems = [...(draft.items || [])];
  const existingIds = new Set(nextItems.map((line) => String(line.stockItemId)));

  [...new Set((stockItemIds || []).map(String).filter(Boolean))].forEach((stockItemId) => {
    if (existingIds.has(stockItemId)) return;
    const stockItem = getGrvStockItemById(stockItemId);
    if (!stockItem || !isOrderableStockItem(stockItem)) return;
    nextItems.push(buildGrvDraftLine(stockItem, draft));
    existingIds.add(stockItemId);
  });

  appState.grv = {
    ...appState.grv,
    lineDetailDraft: null,
    draftReceipt: {
      ...draft,
      items: nextItems
    },
    filters: {
      ...appState.grv.filters,
      overlay: 'draft',
      lineQuery: '',
      selectedStockIds: [],
      selectedLineIndexes: [],
      calendarCursor: ''
    },
    actionError: ''
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function updateGrvLine(index, updates = {}) {
  const draft = appState.grv.draftReceipt;
  if (!draft?.items?.[index]) return;

  const items = [...draft.items];
  const normalizedUpdates = { ...updates };
  if (Object.hasOwn(normalizedUpdates, 'locationId')) {
    const locationId = String(normalizedUpdates.locationId || '');
    const locationName = normalizedUpdates.locationName || normalizedUpdates.targetLocationName || getGrvLocationName(locationId, '');
    normalizedUpdates.targetLocation = locationId;
    normalizedUpdates.locationName = locationName;
    normalizedUpdates.targetLocationName = locationName;
  }
  if (Object.hasOwn(normalizedUpdates, 'selectedUom')) {
    const selection = getLineUomSelection(items[index], normalizedUpdates.selectedUom);
    normalizedUpdates.selectedUom = selection.selectedUom;
    normalizedUpdates.packSize = String(selection.ratio);
  }

  items[index] = {
    ...items[index],
    ...Object.fromEntries(Object.entries(normalizedUpdates).map(([key, value]) => [
      key,
      ['receivedQty', 'orderedQty', 'packSize', 'unitCost'].includes(key) ? String(value ?? '') : value
    ]))
  };

  appState.grv = {
    ...appState.grv,
    draftReceipt: {
      ...draft,
      items
    }
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function removeGrvLine(index) {
  const draft = appState.grv.draftReceipt;
  if (!draft) return;

  appState.grv = {
    ...appState.grv,
    draftReceipt: {
      ...draft,
      items: (draft.items || []).filter((_, lineIndex) => lineIndex !== index)
    },
    filters: {
      ...appState.grv.filters,
      selectedLineIndexes: []
    }
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function splitGrvLine(index) {
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  const line = draft.items?.[index];
  if (!line) return;

  const expectedQty = Number(line.splitExpectedQty || line.receivedQty || line.orderedQty || 0) || 0;
  if (!(expectedQty > 0)) {
    appState.grv = {
      ...appState.grv,
      actionError: 'Enter the total received quantity before splitting this line.'
    };
    renderApp();
    return;
  }

  const splitGroupId = line.splitGroupId || createGrvSplitGroupId();
  const nextLocationId = getNextGrvSplitLocationId(line.locationId || line.targetLocation || draft.locationId);
  const nextLocationName = getGrvLocationName(nextLocationId, 'Main Store');
  const items = [...(draft.items || [])];
  items[index] = {
    ...line,
    splitGroupId,
    splitExpectedQty: expectedQty
  };
  items.splice(index + 1, 0, {
    ...line,
    id: `${line.id || line.stockItemId || 'grv-line'}-${splitGroupId}-${items.length}`,
    splitGroupId,
    splitExpectedQty: expectedQty,
    receivedQty: '',
    packQty: '',
    locationId: nextLocationId,
    targetLocation: nextLocationId,
    locationName: nextLocationName,
    targetLocationName: nextLocationName
  });

  appState.grv = {
    ...appState.grv,
    draftReceipt: {
      ...draft,
      splitByLocation: true,
      items
    },
    actionError: ''
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function createGrvSplitGroupId() {
  return `split_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}

function getNextGrvSplitLocationId(currentLocationId = '') {
  const locations = appState.grv.locations || [];
  const current = String(currentLocationId || '');
  return String(
    locations.find((location) => String(location.id || '') && String(location.id) !== current)?.id ||
    current ||
    getDefaultGrvLocationId()
  );
}

function validateGrvSplitGroups(items = []) {
  const groups = new Map();
  (items || []).forEach((line) => {
    const groupId = String(line.splitGroupId || '').trim();
    if (!groupId) return;
    const expectedQty = Number(line.splitExpectedQty || 0) || 0;
    if (!groups.has(groupId)) {
      groups.set(groupId, {
        name: line.stockItemName || 'A split item',
        expectedQty,
        totalQty: 0,
        lineCount: 0
      });
    }
    const group = groups.get(groupId);
    group.expectedQty = group.expectedQty || expectedQty;
    group.totalQty += Number(line.receivedQty || 0) || 0;
    group.lineCount += 1;
  });

  for (const group of groups.values()) {
    if (group.lineCount < 2 || !(group.expectedQty > 0)) continue;
    if (Math.abs(group.totalQty - group.expectedQty) > 0.0001) {
      return `${group.name} split quantities must total ${formatNumber(group.expectedQty)} before posting. Current split total is ${formatNumber(group.totalQty)}.`;
    }
  }

  return '';
}

function toggleGrvLineSelection(index, checked) {
  const selections = new Set((appState.grv.filters?.selectedLineIndexes || []).map(String));
  if (checked) selections.add(String(index));
  else selections.delete(String(index));
  updateGrvFilters({ selectedLineIndexes: [...selections] });
}

function selectAllGrvLines() {
  const count = (appState.grv.draftReceipt?.items || []).length;
  updateGrvFilters({
    selectedLineIndexes: Array.from({ length: count }, (_, index) => String(index))
  });
}

function removeSelectedGrvLines() {
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  const selections = new Set((appState.grv.filters?.selectedLineIndexes || []).map(String));
  if (!selections.size) return;

  appState.grv = {
    ...appState.grv,
    draftReceipt: {
      ...draft,
      items: (draft.items || []).filter((_, index) => !selections.has(String(index)))
    },
    filters: {
      ...appState.grv.filters,
      selectedLineIndexes: []
    }
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

function requestClearGrvLines() {
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  if (!(draft.items || []).length) return;
  appState.grv = {
    ...appState.grv,
    filters: {
      ...appState.grv.filters,
      overlay: 'clear-confirm',
      selectedLineIndexes: []
    }
  };
  renderApp();
}

function cancelClearGrvLines() {
  if (appState.grv.filters?.overlay !== 'clear-confirm') return;
  appState.grv = {
    ...appState.grv,
    filters: {
      ...appState.grv.filters,
      overlay: ''
    }
  };
  renderApp();
}

function confirmClearGrvLines() {
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  appState.grv = {
    ...appState.grv,
    draftReceipt: {
      ...draft,
      items: []
    },
    filters: {
      ...appState.grv.filters,
      overlay: '',
      selectedLineIndexes: [],
      selectedStockIds: [],
      lineQuery: ''
    }
  };
  persistGrvDraftSnapshot(appState.grv.draftReceipt);
  renderApp();
}

let grvCommitInProgress = false;
async function saveGrvReceipt(options = {}) {
  const draft = appState.grv.draftReceipt || createEmptyGrvDraft();
  if (!draft) return;
  // In-flight guard: block a second concurrent commit (double-click, or a click during the
  // supplier-validation await). Reset in the outer finally so every return path clears it.
  if (grvCommitInProgress) return;
  grvCommitInProgress = true;
  try {
  const isAutoGenerated = Boolean(draft.sourceReport);
  const { skipSupplierValidation = isAutoGenerated } = options;

  const supplierName = String(draft.supplierName || '').trim();
  if (!supplierName) {
    appState.grv = {
      ...appState.grv,
      actionError: 'Select or enter a supplier before saving the GRV.'
    };
    renderApp();
    return;
  }

  let resolvedSupplier = null;
  if (!skipSupplierValidation) {
    try {
      resolvedSupplier = await resolveWorkspaceSupplier({
        supplierId: draft.supplierId || '',
        supplierName
      });
    } catch (error) {
      appState.grv = {
        ...appState.grv,
        actionError: error.message || 'Could not validate the supplier before saving.'
      };
      renderApp();
      return;
    }

    if (!resolvedSupplier) {
      queueMissingGrvSupplierPrompt({
        supplierId: draft.supplierId || '',
        supplierName,
        sourceLabel: 'This GRV',
        referenceLabel: draft.grvNumber || draft.poNumber || ''
      });
      return;
    }
  }

  const items = draft.items || [];
  if (!items.length) {
    appState.grv = {
      ...appState.grv,
      actionError: 'Add at least one stock item before saving the GRV.'
    };
    renderApp();
    return;
  }

  const isPoReceiving = Boolean(String(draft.sourcePoId || draft.poNumber || '').trim());
  const invalidLine = items.find((line) => {
    const receivedQty = Number(line.receivedQty || 0);
    return isPoReceiving ? receivedQty < 0 : receivedQty <= 0;
  });
  if (invalidLine) {
    appState.grv = {
      ...appState.grv,
      actionError: isPoReceiving
        ? `${invalidLine.stockItemName || 'A stock item'} cannot have a negative received quantity.`
        : `${invalidLine.stockItemName || 'A stock item'} needs a received quantity greater than zero.`
    };
    renderApp();
    return;
  }

  if (isPoReceiving && !items.some((line) => Number(line.receivedQty || 0) > 0)) {
    appState.grv = {
      ...appState.grv,
      actionError: 'Enter a received quantity greater than zero on at least one PO line before saving the GRV.'
    };
    renderApp();
    return;
  }

  const splitValidation = validateGrvSplitGroups(items);
  if (splitValidation) {
    appState.grv = {
      ...appState.grv,
      actionError: splitValidation
    };
    renderApp();
    return;
  }

  // A destination location is required. When splitting by location every line must
  // have one; otherwise the header destination must be set. "Select your location"
  // (blank) is not a valid selection.
  if (draft.splitByLocation === true) {
    const lineMissingLocation = items.some((line) => !String(line.locationId || line.targetLocation || '').trim());
    if (lineMissingLocation) {
      showGrvToast('Select a destination location for every line before saving the GRV.', 'error');
      return;
    }
  } else if (!String(draft.locationId || '').trim()) {
    showGrvToast('Select a destination location before saving the GRV.', 'error');
    return;
  }

  const hydratedItems = items.map((line) => {
    const { unitCostDisplay, ...lineWithoutDisplay } = line;
    const locationId = String(line.locationId || line.targetLocation || draft.locationId || '');
    const locationName = line.locationName || line.targetLocationName || getGrvLocationName(locationId, '');
    const receivedQty = Number(line.receivedQty || 0);
    const orderedQty = Number(line.orderedQty || 0);
    const packSize = getPositivePackSizeValue(line.packSize);
    return {
      ...lineWithoutDisplay,
      locationId,
      targetLocation: locationId,
      locationName,
      targetLocationName: locationName,
      receivedQty,
      orderedQty,
      varianceQty: receivedQty - orderedQty,
      packSize,
      lineTotalEx: receivedQty * packSize * Number(line.unitCost || 0)
    };
  });

  appState.grv = {
    ...appState.grv,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Saving GRV');

  try {
    const { saveGoodsReceipt } = await import('./services/grvService.js');
    const receiptPayload = {
      ...draft,
      supplierId: resolvedSupplier?.id || draft.supplierId || '',
      supplierName: resolvedSupplier?.name || supplierName,
      submittedByUserId: appState.user?.uid || appState.user?.id || '',
      submittedByName: appState.user?.displayName || appState.user?.email || '',
      overrideCostPrice: draft.overrideCostPrice !== false,
      costingMethod: String(appState.source?.settings?.costingMethod || appState.settings?.business?.costingMethod || 'last'),
      items: hydratedItems
    };
    const savedReceipt = await saveGoodsReceipt(appState.workspace?.id, receiptPayload);

    appState.grv = {
      ...appState.grv,
      missingSupplierPrompt: null,
      lineDetailDraft: null,
      draftReceipt: createEmptyGrvDraft(),
      actionStatus: '',
      actionError: '',
      filters: {
        ...appState.grv.filters,
        lineQuery: '',
        poQuery: '',
        selectedStockIds: [],
        selectedLineIndexes: [],
        calendarCursor: '',
        openDropdown: '',
        headerLocationQuery: '',
        overlay: ''
      }
    };
    clearPersistedDraft('grv');
    showGrvToast('GRV saved and stock incremented.', 'success');
  } catch (error) {
    appState.grv = {
      ...appState.grv,
      actionStatus: '',
      actionError: error.message || 'Could not save GRV.'
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
  } finally {
    grvCommitInProgress = false;
  }
}

async function exportGrvReceipts(format = 'csv') {
  const receipts = getFilteredGrvReceipts(appState.grv.receipts || [], appState.grv.filters || {});

  if (!receipts.length) {
    showGrvToast('No GRV entries are available to export.', 'warning');
    return;
  }

  const rows = buildGoodsReceiptDocumentRows(receipts, {
    siteName: appState.workspace?.siteName || 'KCP',
    getLocationName: getGrvLocationName,
    vatRate: getVatRate()
  });

  try {
    await exportAoaRows({
      format,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'GRV Export' }),
      sheetName: 'GRV',
      title: 'Goods Received Vouchers',
      subtitle: `${appState.workspace?.siteName || 'KCP'} · ${receipts.length} GRV entr${receipts.length === 1 ? 'y' : 'ies'}`,
      rows,
      headerRowIndex: 0,
      branding: getPdfBranding()
    });
    showGrvToast(`${receipts.length} GRV entr${receipts.length === 1 ? 'y' : 'ies'} exported as ${format.toUpperCase()}.`, 'success');
  } catch (error) {
    showGrvToast(error.message || 'GRV export failed.', 'error');
  }
}

function dismissGrvToast() {
  if (grvToastTimer) {
    window.clearTimeout(grvToastTimer);
    grvToastTimer = null;
  }
  appState.grv = {
    ...appState.grv,
    toast: null
  };
  renderApp();
}

function updateCreditNoteFilters(nextFilters) {
  appState.creditNotes = {
    ...appState.creditNotes,
    filters: {
      ...appState.creditNotes.filters,
      ...nextFilters
    }
  };
  renderApp();
}

function updateCreditNoteDraft(updates = {}) {
  const draft = appState.creditNotes.draftNote || createEmptyCreditNoteDraft();
  const normalizedUpdates = { ...updates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'siteId')) {
    normalizedUpdates.locationId = getFirstLocationIdForSite(appState.creditNotes.locations || [], normalizedUpdates.siteId);
    normalizedUpdates.siteName = getSiteNameById(appState.creditNotes.sites || [], normalizedUpdates.siteId, '');
  }
  const nextDraft = { ...draft, ...normalizedUpdates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'locationId')) {
    nextDraft.siteId = getSiteIdForLocation(appState.creditNotes.locations || [], normalizedUpdates.locationId) || nextDraft.siteId || '';
    nextDraft.siteName = getSiteNameById(appState.creditNotes.sites || [], nextDraft.siteId, nextDraft.siteName || '');
    nextDraft.locationName = getLocationNameById(appState.creditNotes.locations || [], normalizedUpdates.locationId, draft.locationName || 'Main Store');
  }
  appState.creditNotes = {
    ...appState.creditNotes,
    actionError: '',
    draftNote: nextDraft
  };
  persistCreditNoteDraftSnapshot(nextDraft);
  renderApp();
}

function hydrateCreditNoteFromGrv(receiptId) {
  const receipt = (appState.creditNotes.processedGrvs || []).find((entry) => String(entry.id) === String(receiptId));
  if (!receipt) {
    showCreditNoteToast('Processed GRV could not be found.', 'error');
    return;
  }

  const existingDraft = appState.creditNotes.draftNote || createEmptyCreditNoteDraft();
  const defaultLocationId = String(receipt.locationId || receipt.targetLocation || existingDraft.locationId || 'main');
  const defaultLocationName = receipt.locationName
    || receipt.targetLocationName
    || getLocationNameById(appState.creditNotes.locations || [], defaultLocationId, existingDraft.locationName || 'Main Store');

  const items = (receipt.items || []).flatMap((line) => {
    const stockItemId = resolveStockItemIdFromLine(line);
    const stockItem = getCreditNoteStockItemById(stockItemId);
    if (stockItem && !isOrderableStockItem(stockItem)) return [];
    return [{
      stockItemId,
      id: line.id || '',
      stockItemName: line.stockItemName || line.name || '',
      unit: line.unit || stockItem?.unit || 'ea',
      selectedUom: line.selectedUom || line.receivingUom || line.purchaseUom || line.unit || stockItem?.unit || 'ea',
      returnUom: line.selectedUom || line.receivingUom || line.purchaseUom || line.unit || stockItem?.unit || 'ea',
      uomConfigurations: normalizeLineUomConfigurations(line.uomConfigurations || stockItem?.uomConfigurations || stockItem?.uomConfig || stockItem?.uomConversions),
      returnedQty: Number(line.receivedQty ?? line.packQty ?? line.orderedQty ?? 0) || 0,
      packQty: Number(line.receivedQty ?? line.packQty ?? line.orderedQty ?? 0) || 0,
      originalOrderQty: Number(line.orderedQty ?? line.qty ?? line.quantity ?? line.receivedQty ?? line.packQty ?? 0) || 0,
      maxReturnQty: Number(line.orderedQty ?? line.qty ?? line.quantity ?? line.receivedQty ?? line.packQty ?? 0) || 0,
      packSize: getPositivePackSizeValue(line.packSize),
      unitCost: Number(line.unitCost || 0) || 0,
      vatEnabled: line.vatEnabled !== false && stockItem?.vatEnabled !== false,
      locationId: String(line.locationId || line.targetLocation || defaultLocationId),
      locationName: line.locationName || line.targetLocationName || defaultLocationName
    }];
  });

  appState.creditNotes = {
    ...appState.creditNotes,
    actionError: '',
    lineDetailDraft: null,
    draftNote: {
      ...existingDraft,
      supplierId: receipt.supplierId || existingDraft.supplierId || '',
      supplierName: receipt.supplierName || existingDraft.supplierName || '',
      date: receipt.date || existingDraft.date || todayLocal(),
      locationId: defaultLocationId,
      locationName: defaultLocationName,
      sourceType: receipt.type || '',
      sourceGrvId: receipt.id || '',
      sourceGrvNumber: receipt.grvNumber || '',
      sourcePoId: receipt.sourcePoId || '',
      poNumber: receipt.poNumber || '',
      sourceInvoice: receipt.invoice || '',
      sourceReceiptIds: Array.isArray(receipt.sourceReceiptIds) ? receipt.sourceReceiptIds : [],
      sourceReceiptNumbers: Array.isArray(receipt.sourceReceiptNumbers) ? receipt.sourceReceiptNumbers : [],
      notes: existingDraft.notes || buildCreditNoteSourceNote(receipt),
      items
    },
    filters: {
      ...appState.creditNotes.filters,
      overlay: '',
      grvQuery: '',
      selectedLineIndexes: []
    }
  };
  persistCreditNoteDraftSnapshot(appState.creditNotes.draftNote);
  renderApp();
}

function buildCreditNoteSourceNote(receipt = {}) {
  if (receipt.type === 'PO_RECEIVED_GROUP') {
    const reference = receipt.poNumber || receipt.grvNumber || receipt.id || 'purchase order';
    const receiptCount = Array.isArray(receipt.sourceReceiptIds) ? receipt.sourceReceiptIds.length : 0;
    return `Processed from received PO ${reference}${receiptCount > 1 ? ` across ${receiptCount} receipts` : ''}`;
  }
  return receipt.grvNumber ? `Processed from GRV ${receipt.grvNumber}` : '';
}

function toggleCreditNoteStockSelection(stockItemId, checked) {
  const ids = new Set((appState.creditNotes.filters?.selectedStockIds || []).map(String));
  if (checked) ids.add(String(stockItemId));
  else ids.delete(String(stockItemId));
  updateCreditNoteFilters({ selectedStockIds: [...ids] });
}

function selectAllVisibleCreditNoteStock() {
  const filters = appState.creditNotes.filters || {};
  const query = String(filters.stockSearch || '').trim().toLowerCase();
  const category = String(filters.stockCategory || '').trim();
  const selected = (appState.creditNotes.stockItems || [])
    .filter((item) => {
      if (category && String(item.category || '') !== category) return false;
      if (!query) return true;
      return (
        String(item.name || '').toLowerCase().includes(query) ||
        String(item.category || '').toLowerCase().includes(query) ||
        (item.barcodes || []).some((barcode) => String(barcode).toLowerCase().includes(query))
      );
    })
    .map((item) => String(item.id))
    .filter(Boolean);

  const merged = new Set((appState.creditNotes.filters?.selectedStockIds || []).map(String));
  selected.forEach((id) => merged.add(id));
  updateCreditNoteFilters({ selectedStockIds: [...merged] });
}

function clearCreditNoteStockSelection() {
  updateCreditNoteFilters({ selectedStockIds: [] });
}

function toggleCreditNoteLineSelection(index, checked) {
  const selections = new Set((appState.creditNotes.filters?.selectedLineIndexes || []).map(String));
  if (checked) selections.add(String(index));
  else selections.delete(String(index));
  updateCreditNoteFilters({ selectedLineIndexes: [...selections] });
}

function selectAllCreditNoteLines() {
  const count = (appState.creditNotes.draftNote?.items || []).length;
  updateCreditNoteFilters({
    selectedLineIndexes: Array.from({ length: count }, (_, index) => String(index))
  });
}

function removeSelectedCreditNoteLines() {
  const draft = appState.creditNotes.draftNote || createEmptyCreditNoteDraft();
  const selections = new Set((appState.creditNotes.filters?.selectedLineIndexes || []).map(String));
  if (!selections.size) return;

  const nextDraft = {
    ...draft,
    items: (draft.items || []).filter((_, index) => !selections.has(String(index)))
  };

  appState.creditNotes = {
    ...appState.creditNotes,
    draftNote: nextDraft,
    filters: {
      ...appState.creditNotes.filters,
      selectedLineIndexes: []
    }
  };
  persistCreditNoteDraftSnapshot(nextDraft);
  renderApp();
}

function requestClearCreditNoteLines() {
  appState.creditNotes = {
    ...appState.creditNotes,
    filters: {
      ...appState.creditNotes.filters,
      overlay: 'clear-confirm'
    }
  };
  renderApp();
}

function cancelClearCreditNoteLines() {
  appState.creditNotes = {
    ...appState.creditNotes,
    filters: {
      ...appState.creditNotes.filters,
      overlay: ''
    }
  };
  renderApp();
}

function confirmClearCreditNoteLines() {
  appState.creditNotes = {
    ...appState.creditNotes,
    lineDetailDraft: null,
    draftNote: createEmptyCreditNoteDraft({
      supplierId: appState.creditNotes.draftNote?.supplierId || '',
      supplierName: appState.creditNotes.draftNote?.supplierName || '',
      cnNumber: appState.creditNotes.draftNote?.cnNumber || '',
      date: appState.creditNotes.draftNote?.date || todayLocal(),
      locationId: appState.creditNotes.draftNote?.locationId || 'main',
      locationName: appState.creditNotes.draftNote?.locationName || 'Main Store',
      pricesIncludeVat: appState.creditNotes.draftNote?.pricesIncludeVat === true,
      notes: appState.creditNotes.draftNote?.notes || ''
    }),
    filters: {
      ...appState.creditNotes.filters,
      overlay: '',
      selectedLineIndexes: [],
      selectedStockIds: []
    }
  };
  persistCreditNoteDraftSnapshot(appState.creditNotes.draftNote);
  renderApp();
}

function openCreditNoteLineDetail(index) {
  const draft = appState.creditNotes.draftNote || createEmptyCreditNoteDraft();
  const line = draft.items?.[index];
  if (!line) return;
  appState.creditNotes = {
    ...appState.creditNotes,
    lineDetailDraft: {
      locationId: line.locationId || draft.locationId || 'main',
      locationName: line.locationName || draft.locationName || 'Main Store',
      entries: [createCreditNoteLineDetailEntry(line, index)]
    }
  };
  renderApp();
}

function addCreditNoteSelectedStock() {
  const ids = new Set((appState.creditNotes.filters?.selectedStockIds || []).map(String));
  if (!ids.size) return;
  const draft = appState.creditNotes.draftNote || createEmptyCreditNoteDraft();
  const items = [...(draft.items || [])];
  const existingKeys = new Set(items.map((line) => `${String(line.stockItemId || '')}::${String(line.locationId || draft.locationId || '')}`));
  (appState.creditNotes.stockItems || [])
    .filter((item) => ids.has(String(item.id)) && isOrderableStockItem(item))
    .forEach((item) => {
      const locationId = draft.locationId || 'main';
      const key = `${String(item.id)}::${String(locationId)}`;
      if (existingKeys.has(key)) return;
      const uomSelection = getDefaultLineUomSelection(item, appState.creditNotes.filters?.stockSearch || '');
      items.push({
        stockItemId: String(item.id),
        id: String(item.id),
        stockItemName: item.name || '',
        category: item.category || '',
        unit: item.unit || 'ea',
        selectedUom: uomSelection.selectedUom,
        returnUom: uomSelection.selectedUom,
        uomConfigurations: normalizeLineUomConfigurations(item.uomConfigurations || item.uomConfig || item.uomConversions),
        returnedQty: '',
        packQty: '',
        packSize: String(uomSelection.ratio || 1),
        unitCost: String(Number(item.lastPurchasePrice ?? item.cost ?? 0) || 0),
        packPriceDisplay: String((Number(item.lastPurchasePrice ?? item.cost ?? 0) || 0) * (uomSelection.ratio || 1)),
        vatEnabled: item.vatEnabled !== false,
        locationId,
        locationName: draft.locationName || 'Main Store',
        sourceIndex: -1
      });
      existingKeys.add(key);
    });

  appState.creditNotes = {
    ...appState.creditNotes,
    lineDetailDraft: null,
    draftNote: {
      ...draft,
      items
    },
    filters: {
      ...appState.creditNotes.filters,
      overlay: '',
      selectedStockIds: [],
      selectedLineIndexes: []
    }
  };
  persistCreditNoteDraftSnapshot(appState.creditNotes.draftNote);
  renderApp();
}

function updateCreditNoteLine(index, updates = {}) {
  const draft = appState.creditNotes.draftNote || createEmptyCreditNoteDraft();
  if (!draft.items?.[index]) return;

  const items = [...draft.items];
  const current = items[index];
  const normalizedUpdates = { ...updates };
  const pricesIncludeVat = draft.pricesIncludeVat === true;
  const vatFactor = current.vatEnabled !== false && pricesIncludeVat ? (1 + (getVatRate() / 100)) : 1;
  const parseDecimal = (value, fallback = 0) => {
    const numeric = Number.parseFloat(String(value ?? '').replace(',', '.'));
    return Number.isFinite(numeric) ? numeric : fallback;
  };

  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'locationId')) {
    const locationId = String(normalizedUpdates.locationId || '');
    const locationName = normalizedUpdates.locationName || getLocationNameById(appState.creditNotes.locations || [], locationId, current.locationName || 'Main Store');
    normalizedUpdates.locationName = locationName;
  }

  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'packPriceDisplay')) {
    const packSize = getPositivePackSizeValue(current.packSize);
    const packPriceDisplay = parseDecimal(normalizedUpdates.packPriceDisplay, 0);
    const packPriceEx = packPriceDisplay / vatFactor;
    normalizedUpdates.unitCost = String(packSize > 0 ? packPriceEx / packSize : 0);
  }

  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'packSize')) {
    const nextPackSize = getPositivePackSizeValue(normalizedUpdates.packSize);
    const displayValue = String(current.packPriceDisplay ?? '').trim()
      ? parseDecimal(current.packPriceDisplay, 0)
      : (parseDecimal(current.unitCost, 0) * getPositivePackSizeValue(current.packSize) * vatFactor);
    const packPriceEx = displayValue / vatFactor;
    normalizedUpdates.packPriceDisplay = String(displayValue);
    normalizedUpdates.unitCost = String(nextPackSize > 0 ? packPriceEx / nextPackSize : 0);
  }

  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'returnedQty')) {
    normalizedUpdates.packQty = normalizedUpdates.returnedQty;
  }

  items[index] = {
    ...current,
    ...normalizedUpdates
  };

  const nextDraft = {
    ...draft,
    items
  };
  appState.creditNotes = {
    ...appState.creditNotes,
    draftNote: nextDraft,
    actionError: ''
  };
  persistCreditNoteDraftSnapshot(nextDraft);
  renderApp();
}

function updateCreditNoteLineDetail(entryIndex, updates = {}) {
  const detail = appState.creditNotes.lineDetailDraft;
  if (!detail?.entries?.[entryIndex]) return;
  const draft = appState.creditNotes.draftNote || createEmptyCreditNoteDraft();
  const vatRate = getVatRate();
  const vatFactor = 1 + (vatRate / 100);
  const current = detail.entries[entryIndex];
  const next = { ...current, ...updates };
  const packQty = Number(next.returnedQty || 0) || 0;
  const packSize = Math.max(Number(next.packSize || 1), 1);

  if (Object.prototype.hasOwnProperty.call(updates, 'packPriceDisplay')) {
    const displayPrice = Number(next.packPriceDisplay || 0) || 0;
    const packPriceEx = current.vatEnabled !== false && draft.pricesIncludeVat ? displayPrice / vatFactor : displayPrice;
    next.unitCost = String(packSize > 0 ? packPriceEx / packSize : 0);
  } else {
    const packPriceEx = (Number(next.unitCost || 0) || 0) * packSize;
    next.packPriceDisplay = String(current.vatEnabled !== false && draft.pricesIncludeVat ? packPriceEx * vatFactor : packPriceEx);
  }

  const entries = detail.entries.map((entry, index) => (index === entryIndex ? next : entry));
  appState.creditNotes = {
    ...appState.creditNotes,
    lineDetailDraft: {
      ...detail,
      entries
    }
  };
  renderApp();
}

function updateCreditNoteLineDetailLocationAll(locationId) {
  const detail = appState.creditNotes.lineDetailDraft;
  if (!detail) return;
  const siteId = getSiteIdForLocation(appState.creditNotes.locations || [], locationId);
  const siteName = getSiteNameById(appState.creditNotes.sites || [], siteId, detail.siteName || '');
  const locationName = getLocationNameById(appState.creditNotes.locations || [], locationId, detail.locationName || 'Main Store');
  appState.creditNotes = {
    ...appState.creditNotes,
    lineDetailDraft: {
      siteId,
      siteName,
      locationId,
      locationName,
      entries: detail.entries.map((entry) => ({
        ...entry,
        siteId,
        siteName,
        locationId,
        locationName
      }))
    }
  };
  renderApp();
}

function applyCreditNoteLineDetail() {
  const detail = appState.creditNotes.lineDetailDraft;
  if (!detail?.entries?.length) return;
  const draft = appState.creditNotes.draftNote || createEmptyCreditNoteDraft();
  const items = [...(draft.items || [])];

  detail.entries.forEach((entry) => {
    const returnedQty = Number(entry.returnedQty || 0) || 0;
    const packSize = getPositivePackSizeValue(entry.packSize);
    const stockItemId = resolveStockItemIdFromLine(entry);
    if (returnedQty <= 0) return;
    if (!stockItemId) return;
    const nextLine = {
      stockItemId,
      id: entry.id || '',
      stockItemName: entry.stockItemName,
      unit: entry.unit || 'ea',
      selectedUom: entry.selectedUom || entry.returnUom || entry.unit || 'ea',
      returnUom: entry.selectedUom || entry.returnUom || entry.unit || 'ea',
      uomConfigurations: normalizeLineUomConfigurations(entry.uomConfigurations || entry.uomConfig || entry.uomConversions),
      returnedQty,
      packQty: returnedQty,
      packSize,
      unitCost: Number(entry.unitCost || 0) || 0,
      vatEnabled: entry.vatEnabled !== false,
      originalOrderQty: Number(entry.originalOrderQty ?? entry.maxReturnQty ?? 0) || 0,
      maxReturnQty: Number(entry.maxReturnQty ?? entry.originalOrderQty ?? 0) || 0,
      locationId: entry.locationId || detail.locationId || draft.locationId || 'main',
      locationName: entry.locationName || detail.locationName || draft.locationName || 'Main Store'
    };
    const sourceIndex = Number(entry.sourceIndex);
    if (Number.isInteger(sourceIndex) && sourceIndex >= 0 && items[sourceIndex]) {
      items[sourceIndex] = nextLine;
      return;
    }
    const existingIndex = items.findIndex((item) => String(item.stockItemId) === String(nextLine.stockItemId) && String(item.locationId || '') === String(nextLine.locationId || ''));
    if (existingIndex >= 0) {
      items[existingIndex] = {
        ...items[existingIndex],
        returnedQty: Number(items[existingIndex].returnedQty || 0) + returnedQty,
        packQty: Number(items[existingIndex].returnedQty || 0) + returnedQty,
        packSize,
        unitCost: nextLine.unitCost,
        locationName: nextLine.locationName
      };
      return;
    }
    items.push(nextLine);
  });

  appState.creditNotes = {
    ...appState.creditNotes,
    lineDetailDraft: null,
    draftNote: {
      ...draft,
      items
    }
  };
  persistCreditNoteDraftSnapshot(appState.creditNotes.draftNote);
  renderApp();
}

function closeCreditNoteLineDetail() {
  appState.creditNotes = {
    ...appState.creditNotes,
    lineDetailDraft: null
  };
  renderApp();
}

function backCreditNoteLineDetail() {
  const detail = appState.creditNotes.lineDetailDraft;
  if (!detail?.entries?.length) {
    closeCreditNoteLineDetail();
    return;
  }

  appState.creditNotes = {
    ...appState.creditNotes,
    lineDetailDraft: null,
    filters: {
      ...appState.creditNotes.filters,
      overlay: 'stock',
      selectedStockIds: detail.entries.map((entry) => String(entry.stockItemId || '')).filter(Boolean),
      selectedLineIndexes: []
    }
  };
  renderApp();
}

function removeCreditNoteLine(index) {
  const draft = appState.creditNotes.draftNote || createEmptyCreditNoteDraft();
  appState.creditNotes = {
    ...appState.creditNotes,
    draftNote: {
      ...draft,
      items: (draft.items || []).filter((_, itemIndex) => itemIndex !== index)
    },
    filters: {
      ...appState.creditNotes.filters,
      selectedLineIndexes: []
    }
  };
  persistCreditNoteDraftSnapshot(appState.creditNotes.draftNote);
  renderApp();
}

function getCreditNotePurchaseOrderQuantityError(draft = {}) {
  if (!String(draft.sourcePoId || '').trim()) return '';
  const totals = new Map();
  for (const line of draft.items || []) {
    const stockItemId = resolveStockItemIdFromLine(line);
    if (!stockItemId) continue;
    const returnedQty = Number(parseDecimalInputValue(line.returnedQty ?? line.packQty ?? 0)) || 0;
    const maxReturnQty = Number(line.maxReturnQty ?? line.originalOrderQty ?? 0) || 0;
    const current = totals.get(stockItemId) || { returnedQty: 0, maxReturnQty: 0, name: line.stockItemName || 'This item' };
    current.returnedQty += returnedQty;
    current.maxReturnQty += maxReturnQty;
    totals.set(stockItemId, current);
  }
  for (const entry of totals.values()) {
    if (entry.maxReturnQty > 0 && entry.returnedQty > entry.maxReturnQty + 0.000001) {
      return `${entry.name} cannot return more than the original purchase order quantity of ${formatDocumentQuantity(entry.maxReturnQty)}.`;
    }
  }
  return '';
}

async function saveCreditNoteDraft() {
  const draft = appState.creditNotes.draftNote || createEmptyCreditNoteDraft();
  if (!String(draft.notes || '').trim()) {
    appState.creditNotes = {
      ...appState.creditNotes,
      actionError: ''
    };
    showCreditNoteToast('Enter the reason for this credit note before saving.', 'error');
    renderApp();
    return;
  }
  // A location is required. "Select your location" (blank) is not a valid selection.
  const creditItems = draft.items || [];
  if (!String(draft.locationId || '').trim() && !creditItems.some((line) => String(line.locationId || '').trim())) {
    showCreditNoteToast('Select a location before committing the credit note.', 'error');
    return;
  }
  const purchaseOrderQtyError = getCreditNotePurchaseOrderQuantityError(draft);
  if (purchaseOrderQtyError) {
    showCreditNoteToast(purchaseOrderQtyError, 'error');
    return;
  }
  // Stable id persisted on the draft so a retry / re-save reuses it and the backend's
  // duplicate-commit guard actually catches it (previously a fresh id was minted each save,
  // defeating the 409 guard and re-deducting stock).
  if (!draft.id) draft.id = makeStableSubmitId('cn');
  appState.creditNotes = {
    ...appState.creditNotes,
    draftNote: draft,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Committing Credit Note');

  try {
    const { saveCreditNote } = await import('./services/creditNoteService.js');
    await saveCreditNote(appState.workspace?.id, draft);
    const processedGrvs = filterProcessedCreditNoteSources(appState.creditNotes.processedGrvs || [], draft);
    appState.creditNotes = {
      ...appState.creditNotes,
      actionStatus: '',
      actionError: '',
      processedGrvs,
      lineDetailDraft: null,
      draftNote: createEmptyCreditNoteDraft(),
      filters: {
        ...appState.creditNotes.filters,
        selectedLineIndexes: [],
        selectedStockIds: [],
        overlay: ''
      }
    };
    clearPersistedDraft('credit-note');
    showCreditNoteToast('Credit note committed.', 'success');
  } catch (error) {
    appState.creditNotes = {
      ...appState.creditNotes,
      actionStatus: '',
      actionError: ''
    };
    showCreditNoteToast(error.message || 'Could not save credit note.', 'error');
  } finally {
    hideGlobalSaving();
  }
}

function filterProcessedCreditNoteSources(receipts = [], creditNote = {}) {
  const creditedKeys = new Set(getCreditNoteDraftSourceKeys(creditNote));
  if (!creditedKeys.size) return receipts;
  return receipts.filter((receipt) => !getProcessedReceiptSourceKeys(receipt).some((key) => creditedKeys.has(key)));
}

function getCreditNoteDraftSourceKeys(note = {}) {
  const keys = [];
  addCreditNoteSourceKey(keys, 'receipt-id', note.sourceGrvId);
  addCreditNoteSourceKey(keys, 'grv-number', note.sourceGrvNumber);
  addCreditNoteSourceKey(keys, 'po-id', note.sourcePoId);
  addCreditNoteSourceKey(keys, 'po-number', note.poNumber);
  addCreditNoteSourceKey(keys, 'invoice', note.sourceInvoice);
  normalizeCreditNoteSourceArray(note.sourceReceiptIds).forEach((id) => addCreditNoteSourceKey(keys, 'receipt-id', id));
  normalizeCreditNoteSourceArray(note.sourceReceiptNumbers).forEach((number) => {
    addCreditNoteSourceKey(keys, 'grv-number', number);
    addCreditNoteSourceKey(keys, 'invoice', number);
  });
  return keys;
}

function getProcessedReceiptSourceKeys(receipt = {}) {
  const keys = [];
  addCreditNoteSourceKey(keys, 'receipt-id', receipt.id);
  addCreditNoteSourceKey(keys, 'receipt-id', receipt.sourceGrvId);
  addCreditNoteSourceKey(keys, 'grv-number', receipt.grvNumber);
  addCreditNoteSourceKey(keys, 'grv-number', receipt.invoice);
  addCreditNoteSourceKey(keys, 'po-id', receipt.sourcePoId);
  addCreditNoteSourceKey(keys, 'po-id', receipt.poId);
  addCreditNoteSourceKey(keys, 'po-number', receipt.poNumber);
  addCreditNoteSourceKey(keys, 'po-number', receipt.purchaseOrderNumber);
  addCreditNoteSourceKey(keys, 'invoice', receipt.invoice);
  normalizeCreditNoteSourceArray(receipt.sourceReceiptIds).forEach((id) => addCreditNoteSourceKey(keys, 'receipt-id', id));
  normalizeCreditNoteSourceArray(receipt.sourceReceiptNumbers).forEach((number) => {
    addCreditNoteSourceKey(keys, 'grv-number', number);
    addCreditNoteSourceKey(keys, 'invoice', number);
  });
  return keys;
}

function addCreditNoteSourceKey(keys, prefix, value) {
  const text = String(value || '').trim().toLowerCase();
  if (text) keys.push(`${prefix}:${text}`);
}

function normalizeCreditNoteSourceArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  const text = String(value || '').trim();
  return text ? text.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function dismissCreditNoteToast() {
  if (creditNoteToastTimer) {
    window.clearTimeout(creditNoteToastTimer);
    creditNoteToastTimer = null;
  }
  appState.creditNotes = {
    ...appState.creditNotes,
    toast: null
  };
  renderApp();
}

function showCreditNoteToast(message, type = 'success') {
  if (creditNoteToastTimer) window.clearTimeout(creditNoteToastTimer);
  appState.creditNotes = {
    ...appState.creditNotes,
    toast: { message, type }
  };
  renderApp();
  creditNoteToastTimer = window.setTimeout(() => {
    if (appState.creditNotes.toast?.message === message) {
      appState.creditNotes = {
        ...appState.creditNotes,
        toast: null
      };
      renderApp();
    }
    creditNoteToastTimer = null;
  }, 2600);
}

function updateAdjustmentFilters(nextFilters) {
  appState.adjustments = {
    ...appState.adjustments,
    filters: {
      ...appState.adjustments.filters,
      ...nextFilters
    }
  };
  renderApp();
}

function updateAdjustmentDraft(updates = {}) {
  const draft = appState.adjustments.draftAdjustment || createEmptyAdjustmentDraft();
  const normalizedUpdates = { ...updates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'siteId')) {
    normalizedUpdates.locationId = getFirstLocationIdForSite(appState.adjustments.locations || [], normalizedUpdates.siteId);
    normalizedUpdates.siteName = getSiteNameById(appState.adjustments.sites || [], normalizedUpdates.siteId, '');
  }
  const nextDraft = { ...draft, ...normalizedUpdates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'locationId')) {
    nextDraft.siteId = getSiteIdForLocation(appState.adjustments.locations || [], normalizedUpdates.locationId) || nextDraft.siteId || '';
    nextDraft.siteName = getSiteNameById(appState.adjustments.sites || [], nextDraft.siteId, nextDraft.siteName || '');
    nextDraft.locationName = getLocationNameById(appState.adjustments.locations || [], normalizedUpdates.locationId, draft.locationName || 'Main Store');
    nextDraft.items = (nextDraft.items || []).map((item) => ({
      ...item,
      siteId: nextDraft.siteId,
      siteName: nextDraft.siteName,
      locationId: normalizedUpdates.locationId,
      locationName: nextDraft.locationName
    }));
  }
  appState.adjustments = {
    ...appState.adjustments,
    actionError: '',
    draftAdjustment: nextDraft
  };
  renderApp();
}

function toggleAdjustmentStockSelection(stockItemId, checked) {
  // Bulk-only: multi-select always.
  const ids = new Set((appState.adjustments.filters?.selectedStockIds || []).map(String));
  if (checked) ids.add(String(stockItemId));
  else ids.delete(String(stockItemId));
  updateAdjustmentFilters({ selectedStockIds: [...ids] });
}

function selectAllVisibleAdjustmentStock() {
  const filters = appState.adjustments.filters || {};
  const query = String(filters.stockSearch || '').trim().toLowerCase();
  const category = String(filters.stockCategory || '').trim();
  const matchedItems = (appState.adjustments.stockItems || [])
    .filter(isAdjustmentStockItem)
    .filter((item) => {
      if (category && String(item.category || '') !== category) return false;
      if (!query) return true;
      return (
        String(item.name || '').toLowerCase().includes(query) ||
        String(item.category || '').toLowerCase().includes(query) ||
        matchesBarcodeQuery(item, query)
      );
    });
  const currentPage = Math.max(Number(filters.stockPage || 1) || 1, 1);
  const start = (currentPage - 1) * ADJUSTMENT_PAGE_SIZE;
  const selected = matchedItems
    .slice(start, start + ADJUSTMENT_PAGE_SIZE)
    .map((item) => String(item.id))
    .filter(Boolean);
  // Bulk-only: merge all visible into the selection.
  const merged = new Set((appState.adjustments.filters?.selectedStockIds || []).map(String));
  selected.forEach((id) => merged.add(id));

  updateAdjustmentFilters({ selectedStockIds: [...merged] });
}

function addAdjustmentSelectedStock() {
  // Bulk-only: add every selected item.
  const selectedIds = (appState.adjustments.filters?.selectedStockIds || []).map(String).filter(Boolean);
  const ids = new Set(selectedIds);
  if (!ids.size) return;
  const draft = normalizeAdjustmentDraftLocation(appState.adjustments.draftAdjustment || createEmptyAdjustmentDraft());
  const entries = (appState.adjustments.stockItems || [])
    .filter((item) => ids.has(String(item.id)) && isAdjustmentStockItem(item))
    .map((item) => ({
      stockItemId: String(item.id),
      stockItemName: item.name || '',
      quantity: '',
      unit: item.unit || 'ea',
      unitCost: Number(item.cost || 0) || 0,
      locationId: draft.locationId || 'main',
      locationName: draft.locationName || 'Main Store',
      sourceIndex: -1
    }));

  appState.adjustments = {
    ...appState.adjustments,
    actionError: '',
    lineDetailDraft: {
      locationId: draft.locationId || 'main',
      locationName: draft.locationName || 'Main Store',
      mode: draft.mode || 'remove',
      note: draft.note || '',
      wasteReason: draft.wasteReason || 'Other',
      entries
    },
    filters: {
      ...appState.adjustments.filters,
      overlay: '',
      detailPage: 1,
      selectedStockIds: []
    }
  };
  renderApp();
}

function openAdjustmentLineDetail(index) {
  const draft = appState.adjustments.draftAdjustment || createEmptyAdjustmentDraft();
  const line = draft.items?.[index];
  if (!line) return;
  appState.adjustments = {
    ...appState.adjustments,
    lineDetailDraft: {
      locationId: line.locationId || draft.locationId || 'main',
      locationName: line.locationName || draft.locationName || 'Main Store',
      mode: draft.mode || 'remove',
      note: draft.note || '',
      wasteReason: draft.wasteReason || 'Other',
      entries: [{
        stockItemId: line.stockItemId,
        stockItemName: line.stockItemName,
        quantity: String(line.quantity ?? ''),
        unit: line.unit || 'ea',
        unitCost: Number(line.unitCost || 0) || 0,
        locationId: line.locationId || draft.locationId || 'main',
        locationName: line.locationName || draft.locationName || 'Main Store',
        sourceIndex: index
      }]
    },
    filters: {
      ...appState.adjustments.filters,
      detailPage: 1
    }
  };
  renderApp();
}

function updateAdjustmentLineDetailMeta(updates = {}) {
  const detail = appState.adjustments.lineDetailDraft;
  if (!detail) return;
  const normalizedUpdates = { ...updates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'siteId')) {
    normalizedUpdates.siteName = getSiteNameById(appState.adjustments.sites || [], normalizedUpdates.siteId, '');
    normalizedUpdates.locationId = getFirstLocationIdForSite(appState.adjustments.locations || [], normalizedUpdates.siteId);
  }
  const next = { ...detail, ...normalizedUpdates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'locationId')) {
    next.siteId = getSiteIdForLocation(appState.adjustments.locations || [], normalizedUpdates.locationId) || next.siteId || '';
    next.siteName = getSiteNameById(appState.adjustments.sites || [], next.siteId, next.siteName || '');
    next.locationName = getLocationNameById(
      appState.adjustments.locations || [],
      normalizedUpdates.locationId,
      detail.locationName || 'Main Store'
    );
    next.entries = (detail.entries || []).map((entry) => ({
      ...entry,
      siteId: next.siteId,
      siteName: next.siteName,
      locationId: normalizedUpdates.locationId,
      locationName: next.locationName
    }));
  }
  appState.adjustments = {
    ...appState.adjustments,
    actionError: '',
    lineDetailDraft: next
  };
  renderApp();
}

function updateAdjustmentLineDetail(entryIndex, updates = {}) {
  const detail = appState.adjustments.lineDetailDraft;
  if (!detail?.entries?.[entryIndex]) return;
  appState.adjustments = {
    ...appState.adjustments,
    actionError: '',
    lineDetailDraft: {
      ...detail,
      entries: detail.entries.map((entry, index) => index === entryIndex ? { ...entry, ...updates } : entry)
    }
  };
  renderApp();
}

function applyAdjustmentLineDetail() {
  const detail = appState.adjustments.lineDetailDraft;
  if (!detail?.entries?.length) return;
  const draft = appState.adjustments.draftAdjustment || createEmptyAdjustmentDraft();
  const items = [...(draft.items || [])];
  const mode = detail.mode || draft.mode || 'remove';
  const stockMap = new Map((appState.adjustments.stockItems || []).map((item) => [String(item.id), item]));
  const hasQuantity = detail.entries.some((entry) => {
    const entered = isAdjustmentQuantityEntered(entry.quantity);
    const quantity = parseAdjustmentQuantity(entry.quantity);
    return mode === 'override'
      ? entered && quantity >= 0
      : quantity > 0;
  });

  if (!hasQuantity) {
    appState.adjustments = {
      ...appState.adjustments,
      actionError: 'Enter a quantity before confirming this adjustment.'
    };
    renderApp();
    return;
  }

  const invalidEntry = detail.entries.find((entry) => {
    const entered = isAdjustmentQuantityEntered(entry.quantity);
    const quantity = parseAdjustmentQuantity(entry.quantity);
    if (mode === 'override') {
      if (!entered) return false;
      return quantity < 0;
    }
    if (quantity <= 0) return false;
    if (mode === 'add') return false;
    const stockItem = stockMap.get(String(entry.stockItemId || ''));
    if (!stockItem) return false;
    const currentStock = getLocationStock(
      stockItem,
      entry.locationId || detail.locationId || draft.locationId || 'main',
      appState.adjustments.locations || []
    );
    return mode === 'remove'
      ? currentStock - quantity < 0
      : quantity < 0;
  });

  if (invalidEntry) {
    appState.adjustments = {
      ...appState.adjustments,
      actionError: `${invalidEntry.stockItemName || 'This item'} cannot go below zero stock at ${invalidEntry.locationName || detail.locationName || draft.locationName || 'that location'}.`
    };
    renderApp();
    return;
  }

  detail.entries.forEach((entry) => {
    const entered = isAdjustmentQuantityEntered(entry.quantity);
    const quantity = parseAdjustmentQuantity(entry.quantity);
    if (mode === 'override') {
      if (!entered || quantity < 0) return;
    } else if (quantity <= 0) {
      return;
    }
    const nextLine = {
      stockItemId: entry.stockItemId,
      stockItemName: entry.stockItemName,
      quantity,
      unit: entry.unit || 'ea',
      unitCost: Number(entry.unitCost || 0) || 0,
      locationId: entry.locationId || detail.locationId || draft.locationId || 'main',
      locationName: entry.locationName || detail.locationName || draft.locationName || 'Main Store'
    };
    nextLine.estimatedImpactEx = estimateAdjustmentImpact(
      nextLine,
      mode,
      appState.adjustments.stockItems || [],
      appState.adjustments.locations || []
    );

    const sourceIndex = Number(entry.sourceIndex);
    if (Number.isInteger(sourceIndex) && sourceIndex >= 0 && items[sourceIndex]) {
      items[sourceIndex] = nextLine;
      return;
    }
    const existingIndex = items.findIndex((item) => String(item.stockItemId) === String(nextLine.stockItemId) && String(item.locationId || '') === String(nextLine.locationId || ''));
    if (existingIndex >= 0) {
      items[existingIndex] = nextLine;
      return;
    }
    items.push(nextLine);
  });

  appState.adjustments = {
    ...appState.adjustments,
    actionError: '',
    lineDetailDraft: null,
    draftAdjustment: {
      ...draft,
      mode,
      locationId: detail.locationId || draft.locationId || 'main',
      locationName: detail.locationName || draft.locationName || 'Main Store',
      note: detail.note || '',
      wasteReason: detail.wasteReason || 'Other',
      items
    }
  };
  renderApp();
}

function backAdjustmentLineDetail() {
  const detail = appState.adjustments.lineDetailDraft;
  if (!detail?.entries?.length) {
    closeAdjustmentLineDetail();
    return;
  }
  appState.adjustments = {
    ...appState.adjustments,
    lineDetailDraft: null,
    filters: {
      ...appState.adjustments.filters,
      overlay: 'stock',
      stockPage: 1,
      selectedStockIds: detail.entries.map((entry) => String(entry.stockItemId || '')).filter(Boolean)
    }
  };
  renderApp();
}

function closeAdjustmentLineDetail() {
  appState.adjustments = {
    ...appState.adjustments,
    lineDetailDraft: null
  };
  renderApp();
}

function removeAdjustmentLine(index) {
  const draft = appState.adjustments.draftAdjustment || createEmptyAdjustmentDraft();
  appState.adjustments = {
    ...appState.adjustments,
    draftAdjustment: {
      ...draft,
      items: (draft.items || []).filter((_, itemIndex) => itemIndex !== index)
    }
  };
  renderApp();
}

// Generate a stable client-side id for a mutation so a retry / double-submit reuses the same id
// and the backend can dedupe it (idempotency). The id lives on the draft in appState until the
// save succeeds and the draft is reset, so retries after a failure keep the same id.
function makeStableSubmitId(prefix = 'op') {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}

async function saveAdjustmentDraft() {
  const draft = normalizeAdjustmentDraftLocation(appState.adjustments.draftAdjustment || createEmptyAdjustmentDraft());
  if (!draft.id) draft.id = makeStableSubmitId('adj');
  appState.adjustments = {
    ...appState.adjustments,
    draftAdjustment: draft,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Applying Adjustment');

  try {
    const { saveManualAdjustments } = await import('./services/adjustmentService.js');
    await saveManualAdjustments(appState.workspace?.id, draft);
    appState.adjustments = {
      ...appState.adjustments,
      actionStatus: '',
      actionError: '',
      lineDetailDraft: null,
      draftAdjustment: createEmptyAdjustmentDraft(),
      filters: {
        ...appState.adjustments.filters,
        adjustmentWorkflow: 'bulk',
        overlay: '',
        selectedStockIds: []
      }
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showAdjustmentToast('Adjustments applied.', 'success');
  } catch (error) {
    appState.adjustments = {
      ...appState.adjustments,
      actionStatus: '',
      actionError: error.message || 'Could not save adjustments.'
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

function updateWastageDraft(updates = {}) {
  const draft = appState.adjustments.wastageDraft || createEmptyWastageDraft();
  appState.adjustments = { ...appState.adjustments, wastageDraft: { ...draft, ...updates } };
  renderApp();
}

function toggleWastageSelection(productId, checked) {
  const ids = new Set((appState.adjustments.filters.wastageSelectedIds || []).map(String));
  checked ? ids.add(String(productId)) : ids.delete(String(productId));
  updateAdjustmentFilters({ wastageSelectedIds: [...ids] });
}

function addWastageSelectedProducts() {
  const ids = new Set((appState.adjustments.filters.wastageSelectedIds || []).map(String));
  if (!ids.size) return;
  const products = appState.adjustments.products || [];
  const draft = appState.adjustments.wastageDraft || createEmptyWastageDraft();
  const existingIds = new Set((draft.items || []).map((i) => String(i.productId)));
  const newItems = [...ids]
    .filter((id) => !existingIds.has(id))
    .map((id) => {
      const product = products.find((p) => String(p.id) === id);
      return product ? { productId: product.id, productName: product.name, category: product.category, quantity: '', unitCost: Number(product.unitCost || 0) || 0, estimatedCost: 0 } : null;
    })
    .filter(Boolean);
  appState.adjustments = {
    ...appState.adjustments,
    wastageDraft: { ...draft, items: [...(draft.items || []), ...newItems] },
    filters: { ...appState.adjustments.filters, overlay: '', wastageSelectedIds: [] }
  };
  renderApp();
}

function removeWastageLine(index) {
  const draft = appState.adjustments.wastageDraft || createEmptyWastageDraft();
  const items = (draft.items || []).filter((_, i) => i !== index);
  appState.adjustments = { ...appState.adjustments, wastageDraft: { ...draft, items } };
  renderApp();
}

function updateWastageQty(index, value) {
  const draft = appState.adjustments.wastageDraft || createEmptyWastageDraft();
  const items = (draft.items || []).map((item, i) => {
    if (i !== index) return item;
    const qty = Number(parseDecimalInputValue(value)) || 0;
    const unitCost = Number(item.unitCost || 0) || 0;
    const estimatedCost = unitCost > 0 ? qty * unitCost : 0;
    return { ...item, quantity: value, estimatedCost };
  });
  appState.adjustments = { ...appState.adjustments, wastageDraft: { ...draft, items } };
  // Live-update the estimated-cost cell + total directly (renderApp is suppressed while the qty
  // input is focused, so a normal re-render wouldn't reflect the new value until blur).
  const row = items[index];
  const costCell = document.querySelector(`[data-wastage-cost="${index}"]`);
  if (costCell && row) {
    costCell.textContent = Number(row.unitCost || 0) > 0 ? formatCurrency(row.estimatedCost || 0) : 'Cost unavailable';
  }
  const totalCell = document.querySelector('[data-wastage-total]');
  if (totalCell) {
    const total = items.reduce((sum, it) => sum + Number(it.estimatedCost || 0), 0);
    totalCell.textContent = formatCurrency(total);
  }
  renderApp();
}

async function saveWastageDraft() {
  const draft = appState.adjustments.wastageDraft || createEmptyWastageDraft();
  const locations = appState.adjustments.locations || [];
  const locationObj = getLocationById(locations, draft.locationId);
  const locationId = String(draft.locationId || '').trim();
  const locationName = locationId ? getLocationNameById(locations, locationId, locationObj?.name || 'Main Store') : '';
  const items = Array.isArray(draft.items) ? draft.items : [];
  let validationError = '';
  if (!items.length) validationError = 'Select at least one menu item to waste.';
  else if (!locationId || !locationObj) validationError = 'Select a valid location before recording wastage.';
  else if (!String(draft.wasteReason || '').trim()) validationError = 'Select a waste reason before recording wastage.';
  else {
    const invalidItem = items.find((item) => !(Number(parseDecimalInputValue(item.quantity)) > 0));
    if (invalidItem) validationError = `Enter a quantity greater than zero for ${invalidItem.productName || 'every menu item'}.`;
  }
  if (validationError) {
    appState.adjustments = { ...appState.adjustments, wastageStatus: '', wastageError: validationError };
    renderApp();
    return;
  }

  if (!draft.id) draft.id = makeStableSubmitId('wst_adj');
  appState.adjustments = { ...appState.adjustments, wastageDraft: draft, wastageStatus: 'saving', wastageError: '' };
  renderApp();
  showGlobalSaving('Recording Wastage');

  try {
    const { saveWastageAdjustment } = await import('./services/adjustmentService.js');
    const result = await saveWastageAdjustment(appState.workspace?.id, {
      ...draft,
      id: draft.id,
      locationId,
      locationName,
      items: (draft.items || []).map((item) => ({
        ...item,
        quantity: parseDecimalInputValue(item.quantity)
      }))
    });
    appState.adjustments = {
      ...appState.adjustments,
      wastageStatus: '',
      wastageError: '',
      wastageDraft: createEmptyWastageDraft(),
      filters: { ...appState.adjustments.filters, overlay: '', wastageSelectedIds: [] }
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    const movCount = result?.movements || 0;
    showAdjustmentToast(`Wastage recorded — ${movCount} stock movement${movCount !== 1 ? 's' : ''} created.`, 'success');
  } catch (error) {
    appState.adjustments = { ...appState.adjustments, wastageStatus: '', wastageError: error.message || 'Could not save wastage.' };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

function normalizeAdjustmentDraftLocation(draft = {}) {
  const locations = appState.adjustments.locations || [];
  const fallback = getDefaultLocation(locations);
  const requestedId = String(draft.locationId || '').trim();
  const hasRequested = requestedId && getLocationById(locations, requestedId);
  const locationId = hasRequested ? requestedId : (fallback?.id || requestedId || '');
  const locationName = locationId
    ? getLocationNameById(locations, locationId, draft.locationName || fallback?.name || 'Main Store')
    : (draft.locationName || fallback?.name || 'Main Store');
  const siteId = locationId
    ? getSiteIdForLocation(locations, locationId) || draft.siteId || ''
    : (draft.siteId || '');
  return {
    ...draft,
    siteId,
    siteName: getSiteNameById(appState.adjustments.sites || [], siteId, draft.siteName || ''),
    locationId,
    locationName,
    items: (draft.items || []).map((item) => {
      const itemLocationId = getLocationById(locations, item.locationId) ? item.locationId : locationId;
      return {
        ...item,
        siteId: itemLocationId ? getSiteIdForLocation(locations, itemLocationId) || siteId : siteId,
        locationId: itemLocationId,
        locationName: itemLocationId ? getLocationNameById(locations, itemLocationId, item.locationName || locationName) : locationName
      };
    })
  };
}

function dismissAdjustmentToast() {
  if (adjustmentToastTimer) {
    window.clearTimeout(adjustmentToastTimer);
    adjustmentToastTimer = null;
  }
  appState.adjustments = {
    ...appState.adjustments,
    toast: null
  };
  renderApp();
}

function showAdjustmentToast(message, type = 'success') {
  if (adjustmentToastTimer) window.clearTimeout(adjustmentToastTimer);
  appState.adjustments = {
    ...appState.adjustments,
    toast: { message, type }
  };
  renderApp();
  adjustmentToastTimer = window.setTimeout(() => {
    if (appState.adjustments.toast?.message === message) {
      appState.adjustments = {
        ...appState.adjustments,
        toast: null
      };
      renderApp();
    }
    adjustmentToastTimer = null;
  }, 2600);
}

function updateSettingsDraft(updates = {}) {
  const draft = appState.settings.draft || createDefaultSettingsDraft();
  const nextDraft = {
    ...draft,
    ...updates
  };
  appState.settings = {
    ...appState.settings,
    actionError: '',
    draft: nextDraft
  };
  if (Object.prototype.hasOwnProperty.call(updates, 'uiScale')) {
    document.documentElement.classList.toggle('ui-scale-large', nextDraft.uiScale === 'large');
  }
  if (
    Object.prototype.hasOwnProperty.call(updates, 'restaurantThemeId') ||
    Object.prototype.hasOwnProperty.call(updates, 'restaurantBackgroundId') ||
    Object.prototype.hasOwnProperty.call(updates, 'restaurantBackgroundDataUrl')
  ) {
    applyRestaurantTheme(nextDraft);
  }
  clearTimeout(settingsDraftRenderTimer);
  settingsDraftRenderTimer = setTimeout(renderApp, 80);
}

function toggleSettingsDropdown(id = '') {
  const current = appState.settings.openDropdown || '';
  const next = id && current !== id ? id : '';
  if (next === current) return;
  appState.settings = { ...appState.settings, openDropdown: next };
  renderApp();
}

function openStockRoutingModal() {
  appState.settings = {
    ...appState.settings,
    routingModalOpen: true
  };
  renderApp();
}

function closeStockRoutingModal() {
  appState.settings = {
    ...appState.settings,
    routingModalOpen: false
  };
  renderApp();
}

function openAppearanceModal(modal = '') {
  const allowedModals = new Set(['backgrounds', 'themes', 'logo']);
  appState.settings = {
    ...appState.settings,
    appearanceModal: allowedModals.has(modal) ? modal : ''
  };
  renderApp();
}

function closeAppearanceModal() {
  appState.settings = {
    ...appState.settings,
    appearanceModal: ''
  };
  renderApp();
}

function updateStockCategoryRouting(categoryId = '', routingLabel = '') {
  const id = String(categoryId || '').trim();
  if (!id) return;
  const draft = appState.settings.draft || createDefaultSettingsDraft();
  const nextMap = {
    ...(draft.stockCategoryRoutingMap && typeof draft.stockCategoryRoutingMap === 'object' ? draft.stockCategoryRoutingMap : {})
  };
  if (String(routingLabel || '').trim()) {
    nextMap[id] = {
      stockCategory: id,
      routingLabel: String(routingLabel || '').trim()
    };
  } else {
    delete nextMap[id];
  }
  updateSettingsDraft({ stockCategoryRoutingMap: nextMap });
}

function toggleSettingsThemeGallery() {
  appState.settings = {
    ...appState.settings,
    themeGalleryOpen: appState.settings.themeGalleryOpen !== true
  };
  renderApp();
}

function updateRestaurantThemePreset(themeId = DEFAULT_RESTAURANT_THEME_ID) {
  const preset = getRestaurantThemePreset(themeId);
  updateSettingsDraft({ restaurantThemeId: preset.id });
}

function updateRestaurantBackgroundPreset(backgroundId = DEFAULT_RESTAURANT_BACKGROUND_ID) {
  const preset = getRestaurantBackgroundPreset(backgroundId);
  updateSettingsDraft({
    restaurantBackgroundId: preset.id,
    restaurantBackgroundDataUrl: '',
    restaurantBackgroundName: ''
  });
}

async function uploadRestaurantLogo(file) {
  if (!file) return;
  const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
  if (!allowedTypes.has(String(file.type || '').toLowerCase())) {
    showSettingsToast('Use a PNG, JPG, WebP, GIF, or SVG logo.', 'error');
    return;
  }
  if (Number(file.size || 0) > 300 * 1024) {
    showSettingsToast('Logo is too large. Please upload an image under 300KB.', 'error');
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const draft = appState.settings.draft || createDefaultSettingsDraft();
    const nextDraft = {
      ...draft,
      restaurantLogoDataUrl: dataUrl,
      restaurantLogoName: file.name || 'Customer logo'
    };
    await saveSettingsDraft({
      draft: nextDraft,
      successMessage: 'Logo saved.',
      keepAppearanceModal: true
    });
  } catch (error) {
    showSettingsToast(error.message || 'Could not read that logo file.', 'error');
  }
}

async function clearRestaurantLogo() {
  const draft = appState.settings.draft || createDefaultSettingsDraft();
  const nextDraft = {
    ...draft,
    restaurantLogoDataUrl: '',
    restaurantLogoName: ''
  };
  await saveSettingsDraft({
    draft: nextDraft,
    successMessage: 'Logo removed.',
    keepAppearanceModal: true
  });
}

async function uploadRestaurantBackground(file) {
  if (!file) return;
  const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
  const type = String(file.type || '').toLowerCase();
  if (!allowedTypes.has(type)) {
    showSettingsToast('Use a PNG, JPG, WebP, GIF, or SVG background.', 'error');
    return;
  }
  if (Number(file.size || 0) > 2.5 * 1024 * 1024) {
    showSettingsToast('Background is too large. Please upload an image under 2.5MB.', 'error');
    return;
  }

  try {
    const dataUrl = type === 'image/svg+xml' || type === 'image/gif'
      ? await readFileAsDataUrl(file)
      : await readBackgroundImageAsDataUrl(file);
    if (String(dataUrl || '').length > 1800000) {
      showSettingsToast('Background is still too large after processing. Try a smaller image.', 'error');
      return;
    }
    updateSettingsDraft({
      restaurantBackgroundDataUrl: dataUrl,
      restaurantBackgroundName: file.name || 'Customer background'
    });
    showSettingsToast('Background ready. Save settings to publish it.', 'success');
  } catch (error) {
    showSettingsToast(error.message || 'Could not read that background file.', 'error');
  }
}

function clearRestaurantBackground() {
  updateSettingsDraft({
    restaurantBackgroundDataUrl: '',
    restaurantBackgroundName: ''
  });
  showSettingsToast('Custom background removed. Save settings to publish it.', 'success');
}

async function requestVatRegisteredToggle(nextValue) {
  const draft = appState.settings.draft || createDefaultSettingsDraft();
  const currentlyRegistered = draft.vatRegistered !== false;
  if (currentlyRegistered === nextValue) return;

  const vatRate = Number(draft.vatRate ?? 15) || 15;
  const message = nextValue
    ? `Switching to VAT Registered will recalculate recipe costs and stock item costs to be ex-VAT (removing ${vatRate}% VAT from currently VAT-inclusive costs). Reports will start showing real VAT values instead of R0.`
    : `Switching to Not VAT Registered will recalculate recipe costs and stock item costs to be VAT-inclusive (adding ${vatRate}% VAT back into currently ex-VAT costs, since it can no longer be reclaimed). Reports will show R0 VAT going forward.`;

  const confirmed = await showBrandConfirmDialog({
    eyebrow: 'VAT Registration',
    title: nextValue ? 'Switch to VAT Registered?' : 'Switch to Not VAT Registered?',
    message: `${message} This applies to all VAT-enabled stock items and cannot be automatically undone by toggling back (it will recalculate again in the opposite direction).`,
    confirmLabel: nextValue ? 'Switch to VAT Registered' : 'Switch to Not VAT Registered',
    cancelLabel: 'Cancel',
    tone: 'danger'
  });
  if (!confirmed) return;

  await saveSettingsDraft({ draftPatch: { vatRegistered: nextValue } });
}

async function saveSettingsDraft(options = {}) {
  if (settingsDraftRenderTimer) {
    clearTimeout(settingsDraftRenderTimer);
    settingsDraftRenderTimer = null;
  }
  const baseDraft = options.draft || appState.settings.draft || createDefaultSettingsDraft();
  const draft = options.draftPatch
    ? {
        ...baseDraft,
        ...options.draftPatch,
        companyTaxInfo: options.draftPatch.companyTaxInfo
          ? {
              ...(baseDraft.companyTaxInfo && typeof baseDraft.companyTaxInfo === 'object' ? baseDraft.companyTaxInfo : {}),
              ...options.draftPatch.companyTaxInfo
            }
          : baseDraft.companyTaxInfo
      }
    : baseDraft;
  if (isClearlyInvalidVatNumber(draft.companyTaxInfo?.vatNumber)) {
    showSettingsToast('VAT number looks invalid. Leave it blank or enter a valid tax identifier.', 'error');
    return false;
  }
  appState.settings = {
    ...appState.settings,
    draft,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Saving Settings');

  try {
    const saved = await saveWorkspaceSettings(appState.workspace?.id, draft, { includePersonal: false });
    const vatRegistrationRecompute = saved.__vatRegistrationRecompute || null;
    delete saved.__vatRegistrationRecompute;
    appState.settings = {
      ...appState.settings,
      status: 'ready',
      values: saved,
      draft: saved,
      actionStatus: '',
      actionError: '',
      appearanceModal: options.closeAppearanceModal ? '' : appState.settings.appearanceModal
    };
    applyWorkspaceSettingsEffects(saved);
    const previousSiteName = String(appState.workspace?.siteName || '').trim();
    updateWorkspaceSiteName(saved.siteName);
    const nextSiteName = String(saved.siteName || '').trim();
    if (options.syncSiteName !== false && nextSiteName && nextSiteName !== previousSiteName) {
      await syncDefaultWorkspaceSiteName(nextSiteName);
    }
    if (vatRegistrationRecompute) {
      const { itemsRescaled = 0, locationPricesRescaled = 0 } = vatRegistrationRecompute;
      showSettingsToast(
        `VAT registration updated. Recalculated costs for ${itemsRescaled} item${itemsRescaled === 1 ? '' : 's'}${locationPricesRescaled ? ` (${locationPricesRescaled} location price${locationPricesRescaled === 1 ? '' : 's'})` : ''}.`,
        'success'
      );
    } else {
      showSettingsToast(options.successMessage || 'Settings saved.', 'success');
    }
    return true;
  } catch (error) {
    appState.settings = {
      ...appState.settings,
      actionStatus: '',
      actionError: error.message || 'Could not save settings.'
    };
    renderApp();
    return false;
  } finally {
    hideGlobalSaving();
  }
}

async function saveAppearanceSettingsDraft() {
  const draft = appState.settings.draft || createDefaultSettingsDraft();
  appState.settings = {
    ...appState.settings,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Saving My Appearance');
  try {
    const saved = await savePersonalSettings(appState.workspace?.id, draft);
    appState.settings = {
      ...appState.settings,
      status: 'ready',
      values: { ...(appState.settings.values || {}), ...saved },
      draft: { ...draft, ...saved },
      actionStatus: '',
      actionError: '',
      appearanceModal: ''
    };
    applyWorkspaceSettingsEffects(appState.settings.values);
    showSettingsToast('Your personal appearance settings were saved.', 'success');
  } catch (error) {
    appState.settings = {
      ...appState.settings,
      actionStatus: '',
      actionError: error.message || 'Could not save your appearance settings.'
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

async function confirmGoLiveStockDepletion() {
  const confirmed = await showBrandConfirmDialog({
    eyebrow: 'Business Settings',
    title: 'Go live with stock depletion?',
    message: 'Once live, completed Yoco sales will start depleting stock automatically.',
    confirmLabel: 'Confirm Go Live',
    cancelLabel: 'Cancel',
    tone: 'info'
  });
  if (!confirmed) return;
  await goLiveStockDepletion();
}

async function goLiveStockDepletion() {
  const draft = appState.settings.draft || createDefaultSettingsDraft();
  const nextDraft = {
    ...draft,
    stockDepletionEnabled: true,
    stockDepletionEnabledAt: new Date().toISOString()
  };
  await saveSettingsDraft({
    draft: nextDraft,
    successMessage: 'You are live. Completed Yoco sales will now deplete stock.'
  });
}

async function exportSettingsSnapshot() {
  appState.settings = {
    ...appState.settings,
    actionStatus: 'exporting',
    actionError: ''
  };
  renderApp();

  try {
    await exportWorkspaceSnapshot(appState.workspace?.id, appState.settings?.draft?.siteName || appState.workspace?.siteName);
    appState.settings = {
      ...appState.settings,
      actionStatus: ''
    };
    showSettingsToast('Snapshot saved.', 'success');
  } catch (error) {
    appState.settings = {
      ...appState.settings,
      actionStatus: '',
      actionError: error.message || 'Could not export snapshot.'
    };
    renderApp();
  }
}

async function importSettingsSnapshot(file) {
  appState.settings = {
    ...appState.settings,
    actionStatus: 'importing',
    actionError: ''
  };
  renderApp();

  try {
    const result = await importWorkspaceSnapshot(appState.workspace?.id, file);
    const settings = normalizeSettings(result.settings || appState.settings.draft);
    appState.settings = {
      ...appState.settings,
      status: 'ready',
      values: settings,
      draft: settings,
      actionStatus: '',
      actionError: ''
    };
    applyWorkspaceSettingsEffects(settings);
    updateWorkspaceSiteName(settings.siteName);
    await syncDefaultWorkspaceSiteName(settings.siteName);
    showSettingsToast(`Snapshot imported (${result.importedKeys.length} sections).`, 'success');
  } catch (error) {
    appState.settings = {
      ...appState.settings,
      actionStatus: '',
      actionError: ''
    };
    showImportNotification({
      moduleLabel: 'Settings Import',
      title: 'Settings Import Failed',
      message: `${error.message || 'Could not import snapshot.'} Confirm this message, fix the file, and try again.`,
      errors: [error.message || 'Could not import snapshot.'],
      tone: 'error',
      confirmLabel: 'Confirm & Try Again'
    });
  }
}

function dismissSettingsToast() {
  if (settingsToastTimer) {
    window.clearTimeout(settingsToastTimer);
    settingsToastTimer = null;
  }
  appState.settings = {
    ...appState.settings,
    toast: null
  };
  renderApp();
}

function showSettingsToast(message, type = 'success') {
  if (settingsToastTimer) window.clearTimeout(settingsToastTimer);
  appState.settings = {
    ...appState.settings,
    toast: { message, type }
  };
  renderApp();
  settingsToastTimer = window.setTimeout(() => {
    if (appState.settings.toast?.message === message) {
      appState.settings = {
        ...appState.settings,
        toast: null
      };
      renderApp();
    }
    settingsToastTimer = null;
  }, 2600);
}

function updateWorkspaceSiteName(siteName = '') {
  const nextSiteName = String(siteName || '').trim();
  if (!nextSiteName || !appState.workspace?.id) return;
  appState.workspace = {
    ...appState.workspace,
    siteName: nextSiteName
  };
  appState.workspaceOptions = (appState.workspaceOptions || []).map((option) => (
    String(option.id) === String(appState.workspace.id) ? { ...option, siteName: nextSiteName } : option
  ));
}

async function syncDefaultWorkspaceSiteName(siteName = '') {
  const nextSiteName = String(siteName || '').trim();
  const workspaceId = appState.workspace?.id;
  if (!workspaceId || !nextSiteName) return;

  const { syncDefaultSiteName } = await import('./services/locationService.js');
  const result = await syncDefaultSiteName(workspaceId, nextSiteName);
  if (!Array.isArray(result?.sites) || !appState.locations?.sites?.length) return;

  appState.locations = {
    ...appState.locations,
    sites: appState.locations.sites.map((site) => {
      const synced = result.sites.find((item) => String(item.id) === String(site.id));
      return synced ? { ...site, ...synced } : site;
    }),
    editingSite: appState.locations.editingSite
      ? {
          ...appState.locations.editingSite,
          ...(result.sites.find((item) => String(item.id) === String(appState.locations.editingSite.id)) || {})
        }
      : appState.locations.editingSite
  };
}

function applyWorkspaceSettingsEffects(settings = {}) {
  const normalized = normalizeSettings(settings);
  document.documentElement.classList.toggle('ui-scale-large', normalized.uiScale === 'large');
  applyRestaurantTheme(normalized);
  configureAutoLogout(normalized);
}

function applyRestaurantTheme(settings = {}) {
  const preset = getRestaurantThemePreset(settings.restaurantThemeId || DEFAULT_RESTAURANT_THEME_ID);
  const backgroundPreset = getRestaurantBackgroundPreset(settings.restaurantBackgroundId || settings.restaurantThemeId || DEFAULT_RESTAURANT_BACKGROUND_ID);
  getRestaurantThemeVariableNames().forEach((name) => {
    document.documentElement.style.removeProperty(name);
  });
  document.documentElement.style.removeProperty('--restaurant-theme-background-image');
  document.documentElement.style.removeProperty('--restaurant-theme-background-position');
  const modeVars = appState.theme === 'dark' ? preset.dark : preset.light;
  Object.entries(modeVars || {}).forEach(([name, value]) => {
    document.documentElement.style.setProperty(name, value);
  });
  const customBackground = String(settings.restaurantBackgroundDataUrl || '').trim();
  if (customBackground) {
    document.documentElement.style.setProperty('--restaurant-theme-background-image', `url("${customBackground}")`);
    document.documentElement.style.setProperty('--restaurant-theme-background-position', 'center');
  } else if (backgroundPreset.backgroundImage) {
    document.documentElement.style.setProperty('--restaurant-theme-background-image', `url("${backgroundPreset.backgroundImage}")`);
    document.documentElement.style.setProperty('--restaurant-theme-background-position', backgroundPreset.backgroundPosition || 'center');
  }
  applyRestaurantGlassSurfaces();
  document.documentElement.dataset.restaurantTheme = preset.id;
}

function applyRestaurantGlassSurfaces() {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const isDark = appState.theme === 'dark';
  const surfaceAlphas = [
    ['--surface-primary', isDark ? 0.92 : 0.92],
    ['--surface-secondary', isDark ? 0.82 : 0.84],
    ['--surface-elevated', isDark ? 0.97 : 0.98]
  ];

  surfaceAlphas.forEach(([name, alpha]) => {
    const baseColor = computed.getPropertyValue(name).trim();
    const glassColor = toAlphaColor(baseColor, alpha);
    if (glassColor) root.style.setProperty(name, glassColor);
  });

  root.style.setProperty('--restaurant-theme-overlay', isDark ? 'rgba(15, 19, 25, 0.12)' : 'rgba(242, 245, 249, 0.08)');
  root.style.setProperty('--restaurant-theme-panel', isDark ? 'rgba(24, 30, 38, 0.58)' : 'rgba(255, 255, 255, 0.62)');
  root.style.setProperty('--restaurant-theme-page-tint', isDark ? 'rgba(15, 19, 25, 0.66)' : 'rgba(242, 245, 249, 0.68)');
  root.style.setProperty('--restaurant-theme-page-tint-soft', isDark ? 'rgba(15, 19, 25, 0.40)' : 'rgba(242, 245, 249, 0.40)');
  root.style.setProperty('--surface-glass-blur', isDark ? '12px' : '10px');
}

function toAlphaColor(colorValue = '', alpha = 1) {
  const color = String(colorValue || '').trim();
  if (!color) return '';
  const clampedAlpha = Math.min(1, Math.max(0, Number(alpha) || 0));
  const hexMatch = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1].length === 3
      ? hexMatch[1].split('').map((char) => `${char}${char}`).join('')
      : hexMatch[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
  }

  const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((part) => part.trim()).slice(0, 3);
    if (parts.length === 3) return `rgba(${parts.join(', ')}, ${clampedAlpha})`;
  }

  return `color-mix(in srgb, ${color} ${Math.round(clampedAlpha * 100)}%, transparent)`;
}

function configureAutoLogout(settings = {}) {
  stopAutoLogout();
  if (!appState.user) return;

  const timeoutMinutes = Number(settings.logoutTimeout || 30);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return;

  const timeoutMs = timeoutMinutes * 60 * 1000;
  autoLogoutResetHandler = () => {
    if (autoLogoutTimer) window.clearTimeout(autoLogoutTimer);
    autoLogoutTimer = window.setTimeout(() => {
      signOutAndStop();
    }, timeoutMs);
  };

  ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'].forEach((eventName) => {
    window.addEventListener(eventName, autoLogoutResetHandler, { passive: true });
  });
  autoLogoutResetHandler();
}

function stopAutoLogout() {
  if (autoLogoutTimer) {
    window.clearTimeout(autoLogoutTimer);
    autoLogoutTimer = null;
  }
  if (autoLogoutResetHandler) {
    ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'].forEach((eventName) => {
      window.removeEventListener(eventName, autoLogoutResetHandler);
    });
    autoLogoutResetHandler = null;
  }
}

function hydrateTransferDraft(draft, locations = [], sites = appState.transfers?.sites || []) {
  const current = draft || createEmptyTransferDraft();
  const defaultSiteId = String((sites || []).find((site) => site.isDefault)?.id || sites?.[0]?.id || getSiteIdForLocation(locations, locations?.[0]?.id || '') || '');
  const preferredFromSiteId = current.fromSiteId || getSiteIdForLocation(locations, current.fromLocationId) || defaultSiteId;
  const fromLocationId = isLocationInSite(locations, current.fromLocationId, preferredFromSiteId)
    ? String(current.fromLocationId)
    : getOnlyLocationIdForSite(locations, preferredFromSiteId);
  const fromSiteId = preferredFromSiteId || getSiteIdForLocation(locations, fromLocationId) || '';
  const preferredToSiteId = current.toSiteId || getSiteIdForLocation(locations, current.toLocationId) || fromSiteId || defaultSiteId;
  const toLocationId = isLocationInSite(locations, current.toLocationId, preferredToSiteId)
    ? String(current.toLocationId)
    : getOnlyLocationIdForSite(locations, preferredToSiteId);
  const toSiteId = preferredToSiteId || getSiteIdForLocation(locations, toLocationId) || '';
  return {
    ...current,
    fromSiteId,
    fromSiteName: getSiteNameById(sites, fromSiteId, current.fromSiteName || ''),
    fromLocationId,
    fromLocationName: fromLocationId ? getLocationNameById(locations, fromLocationId, current.fromLocationName || 'Main Store') : '',
    toSiteId,
    toSiteName: getSiteNameById(sites, toSiteId, current.toSiteName || ''),
    toLocationId,
    toLocationName: toLocationId ? getLocationNameById(locations, toLocationId, current.toLocationName || 'Main Store') : ''
  };
}

function hydrateStockTakeDraft(draft, locations = []) {
  const current = draft || createEmptyStockTakeDraft();
  const fallback = locations[0]?.id ? { id: String(locations[0].id), name: locations[0].name || 'Main Store' } : { id: 'main', name: 'Main Store' };
  const locationId = current.locationId || fallback.id;
  const siteId = getStockTakeSiteIdForLocation(locationId) || current.siteId || '';
  return {
    ...current,
    date: current.date || todayLocal(),
    siteId,
    siteName: getStockTakeSiteName(siteId) || current.siteName || '',
    locationId,
    locationName: getLocationNameById(locations, locationId, current.locationName || fallback.name)
  };
}

function reconcileManufacturingBlueprintDraft(draft, manufacturedItems = []) {
  if (!draft?.id) return draft;
  if (draft.__dirty) return draft;
  const liveItem = (manufacturedItems || []).find((item) => String(item.id) === String(draft.id));
  if (!liveItem) return draft;
  const itemType = getManufacturingItemType(liveItem);
  return createEmptyManufacturingBlueprintDraft({
    id: liveItem.id,
    name: liveItem.name,
    unit: liveItem.unit || '',
    category: itemType === 'sub_recipe'
      ? normalizeSubRecipeDraftCategory(liveItem.category || 'General')
      : normalizeManufacturingDraftCategory(liveItem.category || 'Manufactured', liveItem.name || ''),
    itemType,
    yieldBatch: liveItem.yieldBatch || 1,
    recipe: (liveItem.recipe || []).map((line) => ({
      ingId: line.ingId,
      name: line.name,
      unit: line.unit || '',
      qty: line.qty
    }))
  });
}

function reconcileManufacturingBatchDraft(draft, manufacturedItems = [], locations = []) {
  if (!draft?.manufacturedItemId) return draft;
  const liveItem = (manufacturedItems || []).find((item) => String(item.id) === String(draft.manufacturedItemId));
  if (!liveItem) return draft;
  const fallbackLocationId = draft.siteId
    ? getFirstLocationIdForSite(locations, draft.siteId)
    : locations[0]?.id || '';
  const locationId = draft.locationId || fallbackLocationId || '';
  const siteId = getSiteIdForLocation(locations, locationId) || draft.siteId || '';
  return createEmptyManufacturingBatchDraft({
    ...draft,
    siteId,
    siteName: getSiteNameById(appState.manufacturing?.sites || [], siteId, draft.siteName || ''),
    itemName: liveItem.name || draft.itemName || '',
    batchMultiplier: draft.batchMultiplier || 1,
    unit: liveItem.unit || draft.unit || 'ea',
    unitCost: liveItem.unitCost || liveItem.cost || draft.unitCost || 0,
    locationId,
    locationName: getLocationNameById(locations, locationId, draft.locationName || 'Main Store')
  });
}

function updateTransferFilters(nextFilters) {
  const merged = {
    ...appState.transfers.filters,
    ...nextFilters
  };
  // When switching to external scope, auto-select the only linked profile if none chosen yet
  const draft = appState.transfers.draftTransfer || {};
  if (nextFilters.transferScope === 'external' && !draft.externalSiteId) {
    const profiles = appState.transfers.linkedProfiles || [];
    if (profiles.length === 1) {
      const profile = profiles[0];
      const locations = profile.locations || [];
      const autoLocationId = locations.length === 1 ? locations[0].id : '';
      const autoLocationName = locations.length === 1 ? locations[0].name : '';
      appState.transfers = {
        ...appState.transfers,
        filters: merged,
        draftTransfer: {
          ...draft,
          externalSiteId: profile.id,
          externalSiteName: profile.name || '',
          externalLocationId: autoLocationId,
          externalLocationName: autoLocationName
        }
      };
      renderApp();
      return;
    }
  }
  appState.transfers = {
    ...appState.transfers,
    filters: merged
  };
  renderApp();
}

function updateTransferDraft(updates = {}) {
  const draft = hydrateTransferDraft(appState.transfers.draftTransfer, appState.transfers.locations || [], appState.transfers.sites || []);
  const normalizedUpdates = { ...updates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'fromSiteId')) {
    normalizedUpdates.fromLocationId = getOnlyLocationIdForSite(appState.transfers.locations || [], normalizedUpdates.fromSiteId);
    normalizedUpdates.fromLocationName = normalizedUpdates.fromLocationId
      ? getLocationNameById(appState.transfers.locations || [], normalizedUpdates.fromLocationId, '')
      : '';
    normalizedUpdates.fromSiteName = getSiteNameById(appState.transfers.sites || [], normalizedUpdates.fromSiteId, '');
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'toSiteId')) {
    normalizedUpdates.toLocationId = getOnlyLocationIdForSite(appState.transfers.locations || [], normalizedUpdates.toSiteId);
    normalizedUpdates.toLocationName = normalizedUpdates.toLocationId
      ? getLocationNameById(appState.transfers.locations || [], normalizedUpdates.toLocationId, '')
      : '';
    normalizedUpdates.toSiteName = getSiteNameById(appState.transfers.sites || [], normalizedUpdates.toSiteId, '');
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'fromLocationId')) {
    normalizedUpdates.fromSiteId = getSiteIdForLocation(appState.transfers.locations || [], normalizedUpdates.fromLocationId) || normalizedUpdates.fromSiteId || '';
    normalizedUpdates.fromSiteName = getSiteNameById(appState.transfers.sites || [], normalizedUpdates.fromSiteId, normalizedUpdates.fromSiteName || '');
    normalizedUpdates.fromLocationName = normalizedUpdates.fromLocationId
      ? getLocationNameById(appState.transfers.locations || [], normalizedUpdates.fromLocationId, draft.fromLocationName || 'Main Store')
      : '';
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'toLocationId')) {
    normalizedUpdates.toSiteId = getSiteIdForLocation(appState.transfers.locations || [], normalizedUpdates.toLocationId) || normalizedUpdates.toSiteId || '';
    normalizedUpdates.toSiteName = getSiteNameById(appState.transfers.sites || [], normalizedUpdates.toSiteId, normalizedUpdates.toSiteName || '');
    normalizedUpdates.toLocationName = normalizedUpdates.toLocationId
      ? getLocationNameById(appState.transfers.locations || [], normalizedUpdates.toLocationId, draft.toLocationName || 'Main Store')
      : '';
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'externalSiteId')) {
    const profile = getLinkedTransferProfileById(appState.transfers.linkedProfiles || [], normalizedUpdates.externalSiteId);
    const locations = profile?.locations || [];
    normalizedUpdates.externalSiteName = profile?.name || '';
    // Honour a location supplied in the SAME update (the picker sends site + location
    // together) before falling back to the existing draft value — otherwise selecting a
    // receiving location was immediately wiped.
    const incomingLocationId = Object.prototype.hasOwnProperty.call(normalizedUpdates, 'externalLocationId')
      ? normalizedUpdates.externalLocationId
      : draft.externalLocationId;
    if (incomingLocationId && locations.some((location) => String(location.id) === String(incomingLocationId))) {
      normalizedUpdates.externalLocationId = incomingLocationId;
    } else if (locations.length === 1) {
      normalizedUpdates.externalLocationId = locations[0].id;
      normalizedUpdates.externalLocationName = locations[0].name;
    } else {
      normalizedUpdates.externalLocationId = '';
      normalizedUpdates.externalLocationName = '';
    }
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'externalLocationId')) {
    const profile = getLinkedTransferProfileById(
      appState.transfers.linkedProfiles || [],
      normalizedUpdates.externalSiteId || draft.externalSiteId
    );
    const location = getLinkedProfileLocationById(profile, normalizedUpdates.externalLocationId);
    normalizedUpdates.externalLocationName = location?.name || '';
  }
  appState.transfers = {
    ...appState.transfers,
    actionError: '',
    validation: null,
    draftTransfer: {
      ...draft,
      ...normalizedUpdates
    }
  };
  renderApp();
}

function updateTransferLocation(side, locationId) {
  const draft = hydrateTransferDraft(appState.transfers.draftTransfer, appState.transfers.locations || [], appState.transfers.sites || []);
  if (side === 'from') {
    updateTransferDraft({
      fromLocationId: locationId,
      fromLocationName: getLocationNameById(appState.transfers.locations || [], locationId, draft.fromLocationName || 'Main Store')
    });
    return;
  }
  updateTransferDraft({
    toLocationId: locationId,
    toLocationName: getLocationNameById(appState.transfers.locations || [], locationId, draft.toLocationName || 'Main Store')
  });
}


async function scanTransferSearch(target = 'stock') {
  const mode = target === 'template' ? 'template' : 'stock';
  try {
    const { openBarcodeScanner } = await import('./services/barcodeScanner.js');
    await openBarcodeScanner({
      title: mode === 'template' ? 'Scan Template Item' : 'Scan Transfer Item',
      helper: mode === 'template'
        ? 'Scan a stock barcode to filter the transfer template picker.'
        : 'Scan a stock barcode to filter transferable stock items.',
      onScan: (barcode) => {
        const value = String(barcode || '').trim();
        if (!value) return;
        appState.transfers = {
          ...appState.transfers,
          filters: {
            ...appState.transfers.filters,
            [mode === 'template' ? 'templateSearch' : 'stockSearch']: value
          }
        };
        renderApp();
        showTransferToast(mode === 'template'
          ? `Barcode ${value} loaded into transfer template search.`
          : `Barcode ${value} loaded into transfer search.`, 'success');
      }
    });
  } catch (error) {
    showTransferToast(error.message || 'Could not start the transfer scanner.', 'error');
  }
}

function toggleTransferStockSelection(stockItemId, checked) {
  const ids = new Set((appState.transfers.filters?.selectedStockIds || []).map(String));
  if (checked) ids.add(String(stockItemId));
  else ids.delete(String(stockItemId));
  updateTransferFilters({ selectedStockIds: [...ids] });
}

function selectAllVisibleTransferStock() {
  const filters = appState.transfers.filters || {};
  const query = String(filters.stockSearch || '').trim().toLowerCase();
  const category = String(filters.stockCategory || '').trim();
  const selected = (appState.transfers.stockItems || [])
    .filter((item) => {
      if (!isTransferEligibleStockItem(item)) return false;
      if (category && String(item.category || '') !== category) return false;
      return transferItemMatchesQuery(item, query);
    })
    .map((item) => String(item.id))
    .filter(Boolean);

  const merged = new Set((appState.transfers.filters?.selectedStockIds || []).map(String));
  selected.forEach((id) => merged.add(id));
  updateTransferFilters({ selectedStockIds: [...merged] });
}

function addTransferSelectedStock() {
  const ids = new Set((appState.transfers.filters?.selectedStockIds || []).map(String));
  if (!ids.size) return;
  const draft = hydrateTransferDraft(appState.transfers.draftTransfer, appState.transfers.locations || [], appState.transfers.sites || []);
  const items = [...(draft.items || [])];

  (appState.transfers.stockItems || [])
    .filter((item) => ids.has(String(item.id)) && isTransferEligibleStockItem(item))
    .forEach((item) => {
      const existingIndex = items.findIndex((line) => String(line.stockItemId) === String(item.id));
      if (existingIndex >= 0) return;
      items.push({
        stockItemId: String(item.id),
        stockItemName: item.name || '',
        quantity: '',
        unit: item.unit || 'ea',
        category: item.category || '',
        sku: item.sku || item.SKU || '',
        code: item.code || item.itemCode || item.stockCode || '',
        barcodes: Array.isArray(item.barcodes) ? item.barcodes : []
      });
    });

  appState.transfers = {
    ...appState.transfers,
    validation: null,
    draftTransfer: {
      ...draft,
      items
    },
    filters: {
      ...appState.transfers.filters,
      overlay: '',
      selectedStockIds: []
    }
  };
  renderApp();
}

function updateTransferLine(index, value) {
  const draft = hydrateTransferDraft(appState.transfers.draftTransfer, appState.transfers.locations || [], appState.transfers.sites || []);
  appState.transfers = {
    ...appState.transfers,
    actionError: '',
    validation: null,
    draftTransfer: {
      ...draft,
      items: (draft.items || []).map((item, itemIndex) => itemIndex === index ? { ...item, quantity: value } : item)
    }
  };
  renderApp();
}

function removeTransferLine(index) {
  const draft = hydrateTransferDraft(appState.transfers.draftTransfer, appState.transfers.locations || [], appState.transfers.sites || []);
  appState.transfers = {
    ...appState.transfers,
    actionError: '',
    validation: null,
    draftTransfer: {
      ...draft,
      items: (draft.items || []).filter((_, itemIndex) => itemIndex !== index)
    }
  };
  renderApp();
}

async function saveTransferDraft() {
  const draft = hydrateTransferDraft(appState.transfers.draftTransfer, appState.transfers.locations || [], appState.transfers.sites || []);
  const transferScope = appState.transfers.filters?.transferScope === 'external' ? 'external' : 'internal';
  const validation = getTransferDraftValidation(draft, transferScope);
  if (validation) {
    appState.transfers = {
      ...appState.transfers,
      actionStatus: '',
      actionError: validation.message,
      validation
    };
    showTransferToast(validation.toast || validation.message || 'Value required.', 'error');
    renderApp();
    return;
  }
  // Drop focus from the qty/other text inputs and clear any pending focus restore.
  // renderApp() is suppressed while a text field is focused, so if the qty input keeps
  // (or is re-given) focus during the save, the render that clears "Saving Transfer…"
  // would be skipped and the button would appear stuck forever.
  pendingFocusField = null;
  if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
  // Stable id so a retry / double-submit reuses it and the backend dedupes the transfer.
  if (!draft.id) draft.id = makeStableSubmitId('tf');
  appState.transfers = {
    ...appState.transfers,
    draftTransfer: draft,
    actionStatus: 'saving',
    actionError: '',
    validation: null
  };
  renderApp();
  showGlobalSaving('Committing Transfer');

  try {
    if (transferScope === 'external') {
      const { postExternalTransfer } = await import('./services/orgTransferService.js');
      await postExternalTransfer({
        id: draft.id,
        from_site_id: appState.workspace?.id,
        from_site_name: appState.workspace?.name || draft.fromSiteName || '',
        to_site_id: draft.externalSiteId,
        to_site_name: draft.externalSiteName || '',
        from_location_id: draft.fromLocationId,
        from_location_name: draft.fromLocationName || '',
        to_location_id: draft.externalLocationId,
        to_location_name: draft.externalLocationName || '',
        note: draft.note,
        items: draft.items
      });
    } else {
      const { saveTransfer } = await import('./services/transferService.js');
      await saveTransfer(appState.workspace?.id, draft);
    }
    appState.transfers = {
      ...appState.transfers,
      actionStatus: '',
      actionError: '',
      validation: null,
      draftTransfer: hydrateTransferDraft(createEmptyTransferDraft(), appState.transfers.locations || [], appState.transfers.sites || []),
      filters: {
        ...appState.transfers.filters,
        bulkTemplateId: ''
      }
    };
    showTransferToast(transferScope === 'external' ? 'External transfer sent. It is now pending receipt.' : 'Transfer committed.', 'success');
    refreshActiveTabFromApi().catch(() => {});
  } catch (error) {
    appState.transfers = {
      ...appState.transfers,
      actionStatus: '',
      actionError: error.message || 'Could not save transfer.',
      validation: null
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

function getTransferDraftValidation(draft = {}, transferScope = 'internal') {
  if (!String(draft.fromLocationId || '').trim()) {
    return {
      field: 'fromLocationId',
      message: 'Select a source location.',
      toast: 'Select a source location.'
    };
  }
  if (transferScope === 'external') {
    if (!String(draft.externalSiteId || '').trim()) {
      return {
        field: 'externalSiteId',
        message: 'Select a receiving profile.',
        toast: 'Select a receiving profile.'
      };
    }
    if (!String(draft.externalLocationId || '').trim()) {
      return {
        field: 'externalLocationId',
        message: 'Select a receiving location at the destination profile.',
        toast: 'Select a receiving location at the destination profile.'
      };
    }
  } else if (!String(draft.toLocationId || '').trim()) {
    return {
      field: 'toLocationId',
      message: 'Select a destination location.',
      toast: 'Select a destination location.'
    };
  } else if (String(draft.fromLocationId || '') === String(draft.toLocationId || '')) {
    return {
      field: 'toLocationId',
      message: 'Choose a different destination location.',
      toast: 'Choose a different destination location.'
    };
  }

  if (!(draft.items || []).length) {
    return {
      field: 'items',
      message: 'Add at least one stock item before saving the transfer.',
      toast: 'Add at least one stock item before saving the transfer.'
    };
  }

  const stockItems = appState.transfers.stockItems || [];
  const invalidItemIndex = (draft.items || []).findIndex((item) => {
    const stockItem = stockItems.find((entry) => String(entry.id) === String(item.stockItemId));
    return stockItem && !isTransferEligibleStockItem(stockItem);
  });
  if (invalidItemIndex >= 0) {
    const line = draft.items[invalidItemIndex] || {};
    const stockItem = stockItems.find((entry) => String(entry.id) === String(line.stockItemId));
    const name = line.stockItemName || stockItem?.name || 'This item';
    const message = `${name} cannot be transferred. Transfers only allow Standard, Non Stock and Manufacturing items.`;
    return {
      field: `lineQty:${invalidItemIndex}`,
      message,
      toast: message
    };
  }

  const missingQuantityIndex = (draft.items || []).findIndex((item) => parseTransferDraftQuantity(item.quantity) <= 0);
  if (missingQuantityIndex >= 0) {
    return {
      field: `lineQty:${missingQuantityIndex}`,
      message: 'Value required.',
      toast: 'Value required.'
    };
  }

  // Block the transfer when any line exceeds the stock available at the source location.
  const locations = appState.transfers.locations || [];
  const insufficientIndex = (draft.items || []).findIndex((item) => {
    const stockItem = stockItems.find((entry) => String(entry.id) === String(item.stockItemId));
    if (!stockItem) return false;
    const available = resolveLocationStock(stockItem, draft.fromLocationId, locations);
    return parseTransferDraftQuantity(item.quantity) > available;
  });
  if (insufficientIndex >= 0) {
    const item = draft.items[insufficientIndex];
    const stockItem = stockItems.find((entry) => String(entry.id) === String(item.stockItemId));
    const available = resolveLocationStock(stockItem, draft.fromLocationId, locations);
    const name = item.stockItemName || stockItem?.name || 'This item';
    const unit = String(item.unit || stockItem?.unit || '').toLowerCase();
    const message = `${name} only has ${formatNumber(available)} ${unit} available at the source location.`;
    return {
      field: `lineQty:${insufficientIndex}`,
      message,
      toast: message
    };
  }

  return null;
}

function parseTransferDraftQuantity(value) {
  const normalized = String(value ?? '').replace(',', '.').trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}


function getTransferItemBarcodeCandidates(item = {}) {
  const uomRows = [
    ...(Array.isArray(item.uomConfigurations) ? item.uomConfigurations : []),
    ...(Array.isArray(item.uomConfig) ? item.uomConfig : []),
    ...(Array.isArray(item.uomConversions) ? item.uomConversions : []),
    ...(Array.isArray(item.customUnits) ? item.customUnits : [])
  ];
  return [
    item.id,
    item.stockItemId,
    item.name,
    item.sku,
    item.SKU,
    item.code,
    item.itemCode,
    item.stockCode,
    item.barcode,
    ...(Array.isArray(item.barcodes) ? item.barcodes : []),
    ...uomRows.flatMap((row = {}) => [row.barcode, row.customBarcode, row.customUomBarcode, row.uomBarcode, row.sku])
  ].filter((value) => String(value || '').trim());
}

function transferItemMatchesQuery(item = {}, query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return getTransferItemBarcodeCandidates(item).some((value) => String(value || '').toLowerCase().includes(q)) ||
    String(item.category || '').toLowerCase().includes(q);
}

async function exportTransferTemplate(format = 'csv', templateId = '') {
  const normalizedFormat = ['csv', 'xlsx'].includes(String(format || '').toLowerCase()) ? String(format).toLowerCase() : 'csv';
  const template = (appState.transfers.templates || []).find((entry) => String(entry.id) === String(templateId || ''));
  const locationHelper = getTransferLocationHelperList();
  const stockById = new Map((appState.transfers.stockItems || []).map((item) => [String(item.id), item]));
  const validTemplateItems = (template?.items || []).filter((item = {}) => {
    const stockItem = stockById.get(String(item.stockItemId || item.id || '')) || item;
    return isTransferEligibleStockItem(stockItem);
  });
  const rows = validTemplateItems.length
    ? validTemplateItems.map((item) => ({
        'Item_ID/SKU': item.sku || item.stockItemId || '',
        Stock_Item: item.stockItemName || '',
        From_Location: '',
        To_Location: '',
        Quantity: '',
        Location_List_Helper: locationHelper
      }))
    : [{
        'Item_ID/SKU': '',
        Stock_Item: '',
        From_Location: '',
        To_Location: '',
        Quantity: '',
        Location_List_Helper: locationHelper
      }];

  try {
    await exportObjectRows({
      format: normalizedFormat,
      filename: buildExportFilename({
        workspaceName: appState.workspace?.siteName,
        reportType: 'Bulk Transfer Template Export',
        suffix: template?.name || ''
      }),
      sheetName: 'Transfer_Import',
      title: template?.name || 'Bulk Transfer Template',
      subtitle: 'Use Item_ID/SKU plus source and destination location IDs or names.',
      rows,
      columns: ['Item_ID/SKU', 'Stock_Item', 'From_Location', 'To_Location', 'Quantity', 'Location_List_Helper'],
      branding: getPdfBranding()
    });
    showTransferToast(`${template?.name || 'Bulk transfer template'} exported as ${normalizedFormat.toUpperCase()}.`, 'success');
  } catch (error) {
    showTransferToast(error.message || 'Could not export bulk transfer template.', 'error');
  }
}

function getTransferLocationHelperList() {
  const names = (appState.transfers.locations || [])
    .map((location) => String(location.displayName || location.name || location.locationName || location.id || '').trim())
    .filter(Boolean);
  return [...new Set(names)].join(' | ');
}

function openTransferTemplateBuilder(templateId = '') {
  const existing = (appState.transfers.templates || []).find((template) => String(template.id) === String(templateId || ''));
  appState.transfers = {
    ...appState.transfers,
    templateDraft: createEmptyTransferTemplateDraft(existing || {}),
    filters: {
      ...appState.transfers.filters,
      transferWorkflow: 'template-builder',
      templateSearch: '',
      overlay: '',
      selectedStockIds: []
    },
    actionError: ''
  };
  renderApp();
}

function updateTransferTemplateDraft(updates = {}) {
  const current = appState.transfers.templateDraft || createEmptyTransferTemplateDraft();
  appState.transfers = {
    ...appState.transfers,
    templateDraft: {
      ...current,
      ...updates
    },
    actionError: ''
  };
  renderApp();
}

function toggleTransferTemplateStockSelection(stockItemId, checked) {
  const current = appState.transfers.templateDraft || createEmptyTransferTemplateDraft();
  const ids = new Set((current.selectedStockIds || []).map(String));
  if (checked) ids.add(String(stockItemId));
  else ids.delete(String(stockItemId));
  updateTransferTemplateDraft({ selectedStockIds: [...ids] });
}

function selectAllVisibleTransferTemplateStock() {
  const current = appState.transfers.templateDraft || createEmptyTransferTemplateDraft();
  const query = String(appState.transfers.filters?.templateSearch || '').trim().toLowerCase();
  const ids = new Set((current.selectedStockIds || []).map(String));
  (appState.transfers.stockItems || [])
    .filter((item) => isTransferEligibleStockItem(item) && transferItemMatchesQuery(item, query))
    .forEach((item) => ids.add(String(item.id)));
  updateTransferTemplateDraft({ selectedStockIds: [...ids] });
}

function clearTransferTemplateStockSelection() {
  updateTransferTemplateDraft({ selectedStockIds: [] });
}

function useTransferTemplateForBulk(templateId = '') {
  const template = (appState.transfers.templates || []).find((entry) => String(entry.id) === String(templateId || ''));
  if (!template) {
    appState.transfers = {
      ...appState.transfers,
      actionError: 'Choose a saved transfer template first.'
    };
    renderApp();
    return;
  }

  const stockById = new Map((appState.transfers.stockItems || []).map((item) => [String(item.id), item]));
  const items = (template.items || [])
    .map((templateItem) => {
      const stockItemId = String(templateItem.stockItemId || templateItem.id || '').trim();
      const stockItem = stockById.get(stockItemId) || {};
      return {
        stockItemId,
        stockItemName: stockItem.name || templateItem.stockItemName || templateItem.name || '',
        quantity: '',
        unit: stockItem.unit || templateItem.unit || 'ea',
        category: stockItem.category || templateItem.category || '',
        sku: stockItem.sku || stockItem.SKU || templateItem.sku || '',
        code: stockItem.code || stockItem.itemCode || stockItem.stockCode || templateItem.code || '',
        barcodes: Array.isArray(stockItem.barcodes) ? stockItem.barcodes : []
      };
    })
    .filter((item) => item.stockItemId && isTransferEligibleStockItem(stockById.get(String(item.stockItemId)) || item));

  const currentDraft = hydrateTransferDraft(appState.transfers.draftTransfer, appState.transfers.locations || [], appState.transfers.sites || []);
  appState.transfers = {
    ...appState.transfers,
    draftTransfer: hydrateTransferDraft({
      ...currentDraft,
      note: currentDraft.note || `Bulk transfer: ${template.name || 'Transfer Template'}`,
      items
    }, appState.transfers.locations || [], appState.transfers.sites || []),
    actionError: '',
    filters: {
      ...appState.transfers.filters,
      transferWorkflow: 'bulk',
      transferScope: 'internal',
      bulkTemplateId: template.id,
      overlay: '',
      openDropdown: '',
      selectedStockIds: []
    }
  };
  renderApp();
}

async function saveTransferTemplateDraft() {
  // renderApp() replaces the button node while a save is in progress. Without a state guard a
  // second click (or rapid double-click) can still start another large write before the disabled
  // replacement is painted, which previously made bulk template saves appear to hang.
  if (appState.transfers.actionStatus === 'saving-template') return;

  const draft = appState.transfers.templateDraft || createEmptyTransferTemplateDraft();
  const selectedIds = new Set((draft.selectedStockIds || []).map(String));
  const invalidSelected = (appState.transfers.stockItems || [])
    .filter((item) => selectedIds.has(String(item.id)) && !isTransferEligibleStockItem(item));
  if (invalidSelected.length) {
    const message = 'Transfer templates only allow Standard, Non Stock and Manufacturing items.';
    appState.transfers = { ...appState.transfers, actionError: message };
    renderApp();
    showTransferToast(message, 'error');
    return;
  }
  const selectedItems = (appState.transfers.stockItems || [])
    .filter((item) => selectedIds.has(String(item.id)) && isTransferEligibleStockItem(item))
    .map((item) => ({
      stockItemId: String(item.id),
      stockItemName: item.name || '',
      sku: item.sku || item.SKU || item.code || '',
      category: item.category || '',
      unit: item.unit || ''
    }));

  // Typing in the template name/notes stores a pending focus snapshot. The first save render can
  // otherwise restore that text-field focus, after which renderApp() intentionally suppresses the
  // success render and leaves the user looking at a permanent "Saving..." button even though the
  // API has committed the template. Release both the live and queued focus before starting.
  pendingFocusField = null;
  if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  appState.transfers = {
    ...appState.transfers,
    actionStatus: 'saving-template',
    actionError: ''
  };
  renderApp();

  try {
    const { saveTransferTemplate } = await import('./services/transferService.js');
    const saved = await saveTransferTemplate(appState.workspace?.id, {
      id: draft.id,
      name: draft.name,
      notes: draft.notes,
      createdAt: draft.createdAt,
      items: selectedItems
    });
    // Upsert the saved template into the in-memory list so it appears immediately (it is already
    // persisted server-side; the list otherwise stayed stale until a full reload).
    const savedTemplate = {
      id: saved.id || draft.id,
      name: saved.name || draft.name,
      notes: saved.notes || draft.notes || '',
      createdAt: saved.createdAt || draft.createdAt || nowIso(),
      items: saved.items || selectedItems
    };
    const withoutOld = (appState.transfers.templates || []).filter((t) => String(t.id) !== String(savedTemplate.id));
    // Force the completion render even if the user clicked back into the name or notes field while
    // the network request was pending. Otherwise renderApp() will intentionally defer the route
    // change and the completed save still looks frozen.
    pendingFocusField = null;
    if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    appState.transfers = {
      ...appState.transfers,
      templates: [...withoutOld, savedTemplate].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
      actionStatus: '',
      actionError: '',
      templateDraft: null,
      filters: {
        ...appState.transfers.filters,
        transferWorkflow: 'templates',
        templateSearch: ''
      }
    };
    renderApp();
    showTransferToast('Transfer template saved.', 'success');
  } catch (error) {
    const message = error.message || 'Could not save transfer template.';
    // Error feedback must also replace the saving state immediately instead of waiting for blur.
    pendingFocusField = null;
    if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    appState.transfers = {
      ...appState.transfers,
      actionStatus: '',
      actionError: message
    };
    renderApp();
    showTransferToast(message, 'error');
  }
}

async function deleteTransferTemplateEntry(templateId = '') {
  try {
    const { deleteTransferTemplate } = await import('./services/transferService.js');
    await deleteTransferTemplate(appState.workspace?.id, templateId);
    appState.transfers = {
      ...appState.transfers,
      templates: removeRowsByIds(appState.transfers.templates, [templateId]),
      templateDraft: String(appState.transfers.templateDraft?.id || '') === String(templateId) ? null : appState.transfers.templateDraft,
      actionError: ''
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showTransferToast('Transfer template deleted.', 'success');
  } catch (error) {
    appState.transfers = {
      ...appState.transfers,
      actionError: error.message || 'Could not delete transfer template.'
    };
    renderApp();
  }
}

async function importTransferTemplate(file) {
  if (!file || !appState.workspace?.id) return;
  appState.transfers = {
    ...appState.transfers,
    actionStatus: 'importing',
    actionError: ''
  };
  renderApp();

  try {
    const rows = await parseDataFile(file, { preferredSheetNames: ['Transfer_Import'] });
    const parsed = parseBulkTransferRows(rows, {
      stockItems: appState.transfers.stockItems || [],
      locations: appState.transfers.locations || []
    });
    if (parsed.errors.length) {
      throw new Error(parsed.errors.slice(0, 8).join(' '));
    }
    if (!parsed.lines.length) {
      throw new Error('No valid transfer rows were found. Use Item_ID/SKU, From_Location, To_Location, and Quantity.');
    }

    const { saveTransfer } = await import('./services/transferService.js');
    const groups = groupTransferLinesByRoute(parsed.lines);
    let skippedGroups = 0;
    for (const group of groups) {
      const result = await saveTransfer(appState.workspace.id, {
        id: getTransferImportGroupId(group),
        date: todayLocal(),
        fromLocationId: group.fromLocationId,
        toLocationId: group.toLocationId,
        note: `Bulk transfer import: ${file.name || 'uploaded file'}`,
        items: group.lines.map((line) => ({
          stockItemId: line.stockItemId,
          quantity: line.quantity,
          unit: line.unit,
          stockItemName: line.stockItemName
        }))
      });
      if (result?.duplicate || result?.skipped) skippedGroups += 1;
    }

    appState.transfers = {
      ...appState.transfers,
      actionStatus: '',
      actionError: ''
    };
    if (skippedGroups) {
      showImportNotification({
        moduleLabel: 'Bulk Transfer Import',
        title: 'Bulk Transfer Import Needs Attention',
        message: `${parsed.lines.length} line${parsed.lines.length === 1 ? '' : 's'} checked, but ${skippedGroups} duplicate group${skippedGroups === 1 ? '' : 's'} were skipped. Confirm this message, review the file, and try again if needed.`,
        errors: [`${skippedGroups} duplicate transfer group${skippedGroups === 1 ? '' : 's'} skipped.`],
        importedCount: Math.max(0, parsed.lines.length - skippedGroups),
        skippedCount: skippedGroups,
        totalRows: parsed.lines.length,
        tone: 'warning',
        confirmLabel: 'Confirm'
      });
    } else {
      showTransferToast(`Bulk transfer imported (${parsed.lines.length} line${parsed.lines.length === 1 ? '' : 's'}).`, 'success');
    }
  } catch (error) {
    appState.transfers = {
      ...appState.transfers,
      actionStatus: '',
      actionError: ''
    };
    showImportNotification({
      moduleLabel: 'Bulk Transfer Import',
      title: 'Bulk Transfer Import Failed',
      message: `${error.message || 'Bulk transfer import failed.'} Confirm this message, fix the file, and try again.`,
      errors: [error.message || 'Bulk transfer import failed.'],
      tone: 'error',
      confirmLabel: 'Confirm & Try Again'
    });
  }
}

function parseBulkTransferRows(rows = [], { stockItems = [], locations = [] } = {}) {
  const errors = [];
  const lines = [];

  (rows || []).forEach((row, index) => {
    const lineNumber = index + 2;
    const rawItem = getImportRowValue(row, ['Item_ID/SKU', 'Item ID/SKU', 'Item_ID', 'Item ID', 'SKU', 'Item', 'Stock Item']);
    const rawFrom = getImportRowValue(row, ['From_Location', 'From Location', 'From', 'Source Location']);
    const rawTo = getImportRowValue(row, ['To_Location', 'To Location', 'To', 'Destination Location']);
    const rawQty = getImportRowValue(row, ['Quantity', 'Qty', 'Transfer Qty']);
    if (![rawItem, rawFrom, rawTo, rawQty].some((value) => String(value || '').trim())) return;

    const item = findStockItemForImport(stockItems, rawItem);
    const fromLocation = findLocationForImport(locations, rawFrom);
    const toLocation = findLocationForImport(locations, rawTo);
    const quantity = Number(String(rawQty || '').replace(',', '.'));

    if (!item) errors.push(`Row ${lineNumber}: stock item "${rawItem}" was not found.`);
    if (item && !isTransferEligibleStockItem(item)) errors.push(`Row ${lineNumber}: "${item.name || rawItem}" cannot be transferred. Transfers only allow Standard, Non Stock and Manufacturing items.`);
    if (!fromLocation) errors.push(`Row ${lineNumber}: from location "${rawFrom}" was not found.`);
    if (!toLocation) errors.push(`Row ${lineNumber}: to location "${rawTo}" was not found.`);
    if (!Number.isFinite(quantity) || quantity <= 0) errors.push(`Row ${lineNumber}: quantity must be greater than zero.`);
    if (fromLocation && toLocation && String(fromLocation.id) === String(toLocation.id)) errors.push(`Row ${lineNumber}: from and to locations must be different.`);
    if (!item || !isTransferEligibleStockItem(item) || !fromLocation || !toLocation || !Number.isFinite(quantity) || quantity <= 0 || String(fromLocation.id) === String(toLocation.id)) return;

    lines.push({
      stockItemId: String(item.id),
      stockItemName: item.name || '',
      unit: item.unit || 'ea',
      fromLocationId: String(fromLocation.id),
      toLocationId: String(toLocation.id),
      quantity
    });
  });

  return { lines, errors };
}

function groupTransferLinesByRoute(lines = []) {
  const map = new Map();
  lines.forEach((line) => {
    const key = `${line.fromLocationId}::${line.toLocationId}`;
    if (!map.has(key)) {
      map.set(key, {
        fromLocationId: line.fromLocationId,
        toLocationId: line.toLocationId,
        lines: []
      });
    }
    map.get(key).lines.push(line);
  });
  return [...map.values()];
}

function getTransferImportGroupId(group = {}) {
  const lines = (group.lines || [])
    .map((line) => [
      String(line.stockItemId || '').trim(),
      Number(line.quantity || 0) || 0,
      String(line.unit || '').trim().toLowerCase()
    ])
    .sort((left, right) => left.join('|').localeCompare(right.join('|')));
  return stableImportId('tfimp', [todayLocal(), group.fromLocationId, group.toLocationId, lines]);
}

function getImportRowValue(row = {}, aliases = []) {
  const entries = Object.entries(row || {});
  for (const alias of aliases) {
    const direct = row?.[alias];
    if (direct !== undefined && direct !== null && String(direct).trim() !== '') return direct;
    const normalizedAlias = normalizeImportLookupKey(alias);
    const match = entries.find(([key]) => normalizeImportLookupKey(key) === normalizedAlias);
    if (match && String(match[1] ?? '').trim() !== '') return match[1];
  }
  return '';
}

function normalizeImportLookupKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findStockItemForImport(stockItems = [], value = '') {
  const needle = String(value || '').trim();
  if (!needle) return null;
  const normalizedNeedle = normalizeImportLookupKey(needle);
  return (stockItems || []).find((item) => {
    const candidates = [
      item.id,
      item.stockItemId,
      item.sku,
      item.SKU,
      item.code,
      item.itemCode,
      item.stockCode,
      item.name,
      ...(Array.isArray(item.barcodes) ? item.barcodes : []),
      ...getTransferItemBarcodeCandidates(item)
    ];
    return candidates.some((candidate) => normalizeImportLookupKey(candidate) === normalizedNeedle);
  }) || null;
}

function findLocationForImport(locations = [], value = '') {
  const needle = String(value || '').trim();
  if (!needle) return null;
  const normalizedNeedle = normalizeImportLookupKey(needle);
  return (locations || []).find((location) => {
    const candidates = [location.id, location.locationId, location.name, location.displayName, location.locationName, location.label];
    return candidates.some((candidate) => normalizeImportLookupKey(candidate) === normalizedNeedle);
  }) || null;
}

function updateExternalTransferReceiveQty(transferId, stockItemId, value) {
  const id = String(transferId || '');
  const itemId = String(stockItemId || '');
  if (!id || !itemId) return;
  appState.transfers = {
    ...appState.transfers,
    receiveDrafts: {
      ...(appState.transfers.receiveDrafts || {}),
      [id]: {
        ...(appState.transfers.receiveDrafts?.[id] || {}),
        [itemId]: value
      }
    }
  };
  renderApp();
}

async function acceptExternalTransferDraft(transferId) {
  const transfer = (appState.transfers.externalTransfers || []).find((entry) => String(entry.transferId || entry.id) === String(transferId));
  if (!transfer) return;
  appState.transfers = {
    ...appState.transfers,
    actionStatus: `accepting:${transferId}`,
    actionError: ''
  };
  renderApp();

  try {
    const draft = appState.transfers.receiveDrafts?.[transferId] || {};
    const items = (transfer.items || []).map((item) => ({
      sourceStockItemId: item.stockItemId,
      stockItemId: item.targetStockItemId || item.stockItemId,
      targetStockItemId: item.targetStockItemId || item.stockItemId,
      receivedQty: draft[item.stockItemId] === undefined || draft[item.stockItemId] === ''
        ? item.shippedQty
        : Number(draft[item.stockItemId] || 0) || 0
    }));
    const { acceptExternalTransfer } = await import('./services/orgTransferService.js');
    await acceptExternalTransfer(appState.workspace?.id, transferId, items);
    const nextDrafts = { ...(appState.transfers.receiveDrafts || {}) };
    delete nextDrafts[transferId];
    appState.transfers = {
      ...appState.transfers,
      actionStatus: '',
      actionError: '',
      receiveDrafts: nextDrafts
    };
    showTransferToast('External transfer accepted into stock.', 'success');
    // Refresh so the pending list clears and received stock reflects immediately (reject/cancel
    // already does this). Without it the change only appears on the next data-version poll.
    refreshActiveTabFromApi().catch(() => {});
  } catch (error) {
    appState.transfers = {
      ...appState.transfers,
      actionStatus: '',
      actionError: error.message || 'Could not accept external transfer.'
    };
    renderApp();
  }
}

async function rejectExternalTransferDraft(transferId, action = 'reject') {
  const id = String(transferId || '');
  if (!id) return;
  const transfer = (appState.transfers.externalTransfers || []).find((entry) => String(entry.transferId || entry.id) === id);
  const isCancel = action === 'cancel' || (transfer && String(transfer.direction || '') === 'outbound');
  const verb = isCancel ? 'cancel' : 'reject';
  const confirmed = await showBrandConfirmDialog({
    eyebrow: 'External Transfer',
    title: isCancel ? 'Cancel transfer request?' : 'Reject transfer request?',
    message: isCancel
      ? 'This cancels the transfer and returns the stock to the sending location.'
      : 'This rejects the incoming transfer and returns the stock to the sending location. It will not be added to your stock.',
    confirmLabel: isCancel ? 'Cancel Transfer' : 'Reject Transfer',
    cancelLabel: 'Keep',
    tone: 'danger'
  });
  if (!confirmed) return;

  appState.transfers = {
    ...appState.transfers,
    actionStatus: `${verb}ing:${id}`,
    actionError: ''
  };
  renderApp();

  try {
    const { rejectExternalTransfer } = await import('./services/orgTransferService.js');
    await rejectExternalTransfer(appState.workspace?.id, id, verb);
    const nextDrafts = { ...(appState.transfers.receiveDrafts || {}) };
    delete nextDrafts[id];
    appState.transfers = {
      ...appState.transfers,
      actionStatus: '',
      actionError: '',
      receiveDrafts: nextDrafts
    };
    showTransferToast(isCancel ? 'Transfer request cancelled. Stock returned to source.' : 'Transfer rejected. Stock returned to sender.', 'success');
    refreshActiveTabFromApi().catch(() => {});
  } catch (error) {
    appState.transfers = {
      ...appState.transfers,
      actionStatus: '',
      actionError: error.message || 'Could not update the transfer.'
    };
    renderApp();
    showTransferToast(error.message || 'Could not update the transfer.', 'error');
  }
}

function dismissTransferToast() {
  if (transferToastTimer) {
    window.clearTimeout(transferToastTimer);
    transferToastTimer = null;
  }
  appState.transfers = {
    ...appState.transfers,
    toast: null
  };
  renderApp();
}

let transferToastTimer = null;
function showTransferToast(message, type = 'success') {
  if (transferToastTimer) window.clearTimeout(transferToastTimer);
  appState.transfers = {
    ...appState.transfers,
    toast: { message, type }
  };
  renderApp();
  transferToastTimer = window.setTimeout(() => {
    if (appState.transfers.toast?.message === message) {
      appState.transfers = {
        ...appState.transfers,
        toast: null
      };
      renderApp();
    }
    transferToastTimer = null;
  }, 2600);
}

function updateLocationFilters(nextFilters) {
  appState.locations = {
    ...appState.locations,
    filters: {
      ...appState.locations.filters,
      ...nextFilters
    }
  };
  renderApp();
}

function updateLocationDraftName(value = '') {
  appState.locations = {
    ...appState.locations,
    draftName: String(value ?? ''),
    draft: {
      ...(appState.locations.draft || {}),
      name: String(value ?? '')
    }
  };
  renderApp();
}

function openLocationCreate() {
  const defaultSiteId = appState.locations.filters?.siteId ||
    appState.locations.sites?.find((site) => site.isDefault)?.id ||
    appState.locations.sites?.[0]?.id ||
    '';
  appState.locations = {
    ...appState.locations,
    createOpen: true,
    selectedSiteId: '',
    actionError: '',
    draft: {
      name: appState.locations.draft?.name || appState.locations.draftName || '',
      siteId: appState.locations.draft?.siteId || defaultSiteId,
      type: appState.locations.draft?.type || 'storage',
      code: appState.locations.draft?.code || '',
      notes: appState.locations.draft?.notes || '',
      stockRouting: appState.locations.draft?.stockRouting || {}
    }
  };
  renderApp();
}

function closeLocationCreate() {
  appState.locations = {
    ...appState.locations,
    createOpen: false,
    routingModal: null,
    actionError: ''
  };
  renderApp();
}

function updateLocationDraft(nextDraft = {}) {
  appState.locations = {
    ...appState.locations,
    draftName: Object.prototype.hasOwnProperty.call(nextDraft, 'name')
      ? String(nextDraft.name ?? '')
      : appState.locations.draftName,
    draft: {
      ...(appState.locations.draft || {}),
      ...normalizeLocationDraftUpdates(nextDraft)
    }
  };
  renderApp();
}

function updateLocationDraftRouting(category = '', target = '') {
  const key = String(category || '').trim();
  if (!key) return;
  const currentRouting = normalizeLocationRouting(appState.locations.draft?.stockRouting);
  currentRouting[key] = String(target || 'self').trim() || 'self';
  updateLocationDraft({ stockRouting: currentRouting });
}

function openLocationRoutingModal(mode = 'draft') {
  const normalizedMode = mode === 'edit' ? 'edit' : 'draft';
  if (normalizedMode === 'edit' && !appState.locations.editingLocation) return;
  appState.locations = {
    ...appState.locations,
    routingModal: {
      open: true,
      mode: normalizedMode
    }
  };
  renderApp();
}

function closeLocationRoutingModal() {
  appState.locations = {
    ...appState.locations,
    routingModal: null
  };
  renderApp();
}

function assignLocationRoutingCategory(mode = 'draft', category = '', target = '') {
  const normalizedMode = mode === 'edit' ? 'edit' : 'draft';
  if (normalizedMode === 'edit') {
    updateLocationEditingRouting(category, target);
    return;
  }
  updateLocationDraftRouting(category, target);
}

function toggleLocationSiteInfoSection(mode = 'draft') {
  const normalizedMode = mode === 'edit' ? 'edit' : 'draft';
  if (normalizedMode === 'edit') {
    if (!appState.locations.editingLocation) return;
    appState.locations = {
      ...appState.locations,
      editingLocation: {
        ...appState.locations.editingLocation,
        __siteInfoOpen: appState.locations.editingLocation.__siteInfoOpen !== true
      }
    };
    renderApp();
    return;
  }

  appState.locations = {
    ...appState.locations,
    draft: {
      ...(appState.locations.draft || {}),
      __siteInfoOpen: appState.locations.draft?.__siteInfoOpen !== true
    }
  };
  renderApp();
}

function openLocationEditor(locationId = '') {
  const item = (appState.locations.items || []).find((entry) => String(entry.id) === String(locationId));
  if (!item) {
    showLocationToast('Location could not be found.', 'error');
    return;
  }
  appState.locations = {
    ...appState.locations,
    editingLocation: {
      id: item.id,
      siteId: item.siteId || '',
      name: item.name || '',
      code: item.code || '',
      type: item.type || 'selling',
      notes: item.notes || '',
      stockRouting: item.stockRouting || {},
      taxInfo: normalizeLocationTaxInfo(item.taxInfo || {}),
      siteInfo: normalizeLocationSiteInfo(item.siteInfo || {})
    }
  };
  renderApp();
}

function closeLocationEditor() {
  appState.locations = {
    ...appState.locations,
    editingLocation: null,
    routingModal: null
  };
  renderApp();
}

function updateLocationEditingName(value = '') {
  if (!appState.locations.editingLocation) return;
  appState.locations = {
    ...appState.locations,
    editingLocation: {
      ...appState.locations.editingLocation,
      name: String(value ?? '')
    }
  };
  renderApp();
}

function updateLocationEditing(nextDraft = {}) {
  if (!appState.locations.editingLocation) return;
  appState.locations = {
    ...appState.locations,
    editingLocation: {
      ...appState.locations.editingLocation,
      ...normalizeLocationDraftUpdates(nextDraft)
    }
  };
  renderApp();
}

function updateLocationEditingRouting(category = '', target = '') {
  const key = String(category || '').trim();
  if (!key || !appState.locations.editingLocation) return;
  const currentRouting = normalizeLocationRouting(appState.locations.editingLocation.stockRouting);
  currentRouting[key] = String(target || 'self').trim() || 'self';
  updateLocationEditing({ stockRouting: currentRouting });
}

function normalizeLocationDraftUpdates(nextDraft = {}) {
  return Object.fromEntries(Object.entries(nextDraft).map(([key, value]) => {
    if (key.startsWith('__')) return null;
    if (key === 'stockRouting') return [key, normalizeLocationRouting(value)];
    if (key === 'taxInfo') return [key, normalizeLocationTaxInfo(value)];
    if (key === 'siteInfo') return [key, normalizeLocationSiteInfo(value)];
    return [key, String(value ?? '')];
  }).filter(Boolean));
}

function normalizeLocationTaxInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    useDifferentTaxInfo: source.useDifferentTaxInfo === true || String(source.useDifferentTaxInfo || '').toLowerCase() === 'true',
    registeredCompanyName: String(source.registeredCompanyName || '').trim(),
    tradingName: String(source.tradingName || '').trim(),
    companyRegistrationNumber: String(source.companyRegistrationNumber || '').trim(),
    vatNumber: String(source.vatNumber || '').trim(),
    taxNumber: String(source.taxNumber || '').trim(),
    registeredAddress: String(source.registeredAddress || '').trim(),
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

function normalizeLocationSiteInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    siteTradingName: String(source.siteTradingName || ''),
    supplierFacingDeliveryName: String(source.supplierFacingDeliveryName || ''),
    deliveryAddressLine1: String(source.deliveryAddressLine1 || ''),
    deliveryAddressLine2: String(source.deliveryAddressLine2 || ''),
    suburb: String(source.suburb || ''),
    city: String(source.city || ''),
    province: String(source.province || ''),
    postalCode: String(source.postalCode || ''),
    country: String(source.country || ''),
    receivingContactName: String(source.receivingContactName || ''),
    receivingContactPhone: String(source.receivingContactPhone || ''),
    receivingContactEmail: String(source.receivingContactEmail || ''),
    deliveryInstructions: String(source.deliveryInstructions || ''),
    receivingHours: String(source.receivingHours || ''),
    supplierNotes: String(source.supplierNotes || '')
  };
}

function normalizeLocationRouting(value = {}) {
  if (typeof value === 'string') {
    return value.split(/[\n,;]+/).reduce((map, pair) => {
      const [label, target] = String(pair || '').split(/[:=]/);
      const key = String(label || '').trim();
      const routeTarget = String(target || '').trim();
      if (key && routeTarget) map[key] = routeTarget;
      return map;
    }, {});
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).reduce((map, [key, target]) => {
    const label = String(key || '').trim();
    const routeTarget = String(target || '').trim();
    if (label && routeTarget) map[label] = routeTarget;
    return map;
  }, {});
}

function openSiteCreate() {
  appState.locations = {
    ...appState.locations,
    siteCreateOpen: true,
    actionError: '',
    siteDraft: {
      name: appState.locations.siteDraft?.name || '',
      code: appState.locations.siteDraft?.code || '',
      address: appState.locations.siteDraft?.address || '',
      notes: appState.locations.siteDraft?.notes || ''
    }
  };
  renderApp();
}

function closeSiteCreate() {
  appState.locations = {
    ...appState.locations,
    siteCreateOpen: false,
    actionError: ''
  };
  renderApp();
}

function updateSiteDraft(nextDraft = {}) {
  appState.locations = {
    ...appState.locations,
    siteDraft: {
      ...(appState.locations.siteDraft || {}),
      ...Object.fromEntries(Object.entries(nextDraft).map(([key, value]) => [key, String(value ?? '')]))
    }
  };
  renderApp();
}

function openSiteEditor(siteId = '') {
  const item = (appState.locations.sites || []).find((entry) => String(entry.id) === String(siteId));
  if (!item) {
    showLocationToast('Site could not be found.', 'error');
    return;
  }
  appState.locations = {
    ...appState.locations,
    editingSite: {
      id: item.id,
      name: item.name || '',
      code: item.code || '',
      address: item.address || '',
      notes: item.notes || ''
    }
  };
  renderApp();
}

function openSiteDetail(siteId = '') {
  const item = (appState.locations.sites || []).find((entry) => String(entry.id) === String(siteId));
  if (!item) {
    showLocationToast('Site could not be found.', 'error');
    return;
  }
  appState.locations = {
    ...appState.locations,
    selectedSiteId: item.id
  };
  renderApp();
}

function closeSiteDetail() {
  appState.locations = {
    ...appState.locations,
    selectedSiteId: ''
  };
  renderApp();
}

function closeSiteEditor() {
  appState.locations = {
    ...appState.locations,
    editingSite: null
  };
  renderApp();
}

function updateSiteEditing(nextDraft = {}) {
  if (!appState.locations.editingSite) return;
  appState.locations = {
    ...appState.locations,
    editingSite: {
      ...appState.locations.editingSite,
      ...Object.fromEntries(Object.entries(nextDraft).map(([key, value]) => [key, String(value ?? '')]))
    }
  };
  renderApp();
}

async function saveNewSiteEntry() {
  const draft = appState.locations.siteDraft || {};
  const name = String(draft.name || '').trim();
  if (!name) {
    showLocationToast('Enter a site name first.', 'warning');
    return;
  }

  appState.locations = {
    ...appState.locations,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Saving Site');

  try {
    const { saveSite } = await import('./services/locationService.js');
    await saveSite(appState.workspace?.id, { ...draft, name });
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: '',
      siteDraft: { name: '', code: '', address: '', notes: '' },
      siteCreateOpen: false
    };
    showLocationToast(`${name} added.`, 'success');
    await refreshActiveTabFromApi();
  } catch (error) {
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: error.message || 'Could not save site.'
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

async function saveSiteEdit() {
  const draft = appState.locations.editingSite;
  if (!draft?.id) return;

  appState.locations = {
    ...appState.locations,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Updating Site');

  try {
    const { saveSite } = await import('./services/locationService.js');
    await saveSite(appState.workspace?.id, draft);
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: '',
      editingSite: null
    };
    showLocationToast('Site updated.', 'success');
    await refreshActiveTabFromApi();
  } catch (error) {
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: error.message || 'Could not update site.'
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

async function deleteSiteEntry(siteId = '') {
  const item = (appState.locations.sites || []).find((entry) => String(entry.id) === String(siteId));
  if (!item) {
    showLocationToast('Site could not be found.', 'error');
    return;
  }

  const confirmed = await showBrandConfirmDialog({
    eyebrow: 'Delete Site',
    title: `Delete ${item.name}?`,
    message: 'Locations are now managed directly. Delete the location card instead.',
    confirmLabel: 'Delete Site'
  });
  if (!confirmed) return;

  appState.locations = {
    ...appState.locations,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { deleteSite } = await import('./services/locationService.js');
    await deleteSite(appState.workspace?.id, siteId);
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: ''
    };
    showLocationToast('Site deleted.', 'success');
    await refreshActiveTabFromApi();
  } catch (error) {
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: error.message || 'Could not delete site.'
    };
    renderApp();
  }
}

async function saveNewLocationEntry() {
  const draft = {
    name: appState.locations.draft?.name ?? appState.locations.draftName ?? '',
    siteId: appState.locations.draft?.siteId || appState.locations.sites?.[0]?.id || '',
    type: appState.locations.draft?.type || 'storage',
    code: appState.locations.draft?.code || '',
    notes: appState.locations.draft?.notes || '',
    stockRouting: normalizeLocationRouting(appState.locations.draft?.stockRouting)
  };
  const name = String(draft.name || '').trim();
  if (!name) {
    showLocationToast('Enter a location name first.', 'warning');
    return;
  }

  appState.locations = {
    ...appState.locations,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Saving Location');

  try {
    const { saveLocation } = await import('./services/locationService.js');
    await saveLocation(appState.workspace?.id, { ...draft, name });
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: '',
      draftName: '',
      draft: { name: '', siteId: draft.siteId, type: 'storage', code: '', notes: '', stockRouting: {} },
      routingModal: null,
      createOpen: false
    };
    showLocationToast(`${name} added.`, 'success');
    await refreshActiveTabFromApi();
  } catch (error) {
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: error.message || 'Could not save location.'
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

async function saveLocationEdit() {
  const draft = appState.locations.editingLocation;
  if (!draft?.id) return;
  if (isClearlyInvalidVatNumber(draft.taxInfo?.vatNumber)) {
    showLocationToast('VAT number looks invalid. Leave it blank or enter a valid tax identifier.', 'error');
    return;
  }

  appState.locations = {
    ...appState.locations,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();
  showGlobalSaving('Updating Location');

  try {
    const { saveLocation } = await import('./services/locationService.js');
    await saveLocation(appState.workspace?.id, stripLocationUiState(draft));
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: '',
      editingLocation: null,
      routingModal: null
    };
    showLocationToast('Location updated.', 'success');
    await refreshActiveTabFromApi();
  } catch (error) {
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: error.message || 'Could not update location.'
    };
    renderApp();
  } finally {
    hideGlobalSaving();
  }
}

function stripLocationUiState(location = {}) {
  return Object.fromEntries(Object.entries(location || {}).filter(([key]) => !String(key || '').startsWith('__')));
}

function isClearlyInvalidVatNumber(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (raw.length > 40) return true;
  if (/[<>]/.test(raw)) return true;
  return !/[A-Za-z0-9]/.test(raw);
}

async function deleteLocationEntry(locationId = '') {
  const item = (appState.locations.items || []).find((entry) => String(entry.id) === String(locationId));
  if (!item) {
    showLocationToast('Location could not be found.', 'error');
    return;
  }
  const isDefaultLocation = isProtectedMainStoreLocation(item);
  const isStorageLocation = isDefaultLocation || String(item.type || item.kind || '').toLowerCase() === 'storage';
  if (isDefaultLocation) {
    showLocationToast('Main Store cannot be deleted. Rename it if needed.', 'warning');
    return;
  }
  if (!isStorageLocation) {
    showLocationToast('Selling locations are managed from the connected POS. Rename or hide them instead.', 'warning');
    return;
  }

  const name = item.displayName || item.name || 'this storage location';
  const confirmed = await showBrandConfirmDialog({
    eyebrow: 'Delete Storage',
    title: `Delete ${name}?`,
    message: 'This removes the storage location from KCP. Historical records may still reference the deleted location name.',
    confirmLabel: 'Delete Storage'
  });
  if (!confirmed) return;

  appState.locations = {
    ...appState.locations,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { deleteLocation } = await import('./services/locationService.js');
    await deleteLocation(appState.workspace?.id, locationId);
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: '',
      editingLocation: null,
      routingModal: null,
      items: (appState.locations.items || []).filter((entry) => String(entry.id) !== String(locationId))
    };
    showLocationToast('Storage location deleted.', 'success');
    await refreshActiveTabFromApi();
  } catch (error) {
    appState.locations = {
      ...appState.locations,
      actionStatus: '',
      actionError: error.message || 'Could not delete storage location.'
    };
    renderApp();
  }
}

function isProtectedMainStoreLocation(location = {}) {
  const normalizedId = normalizeLocationKey(location.id || location.locationId);
  const normalizedName = normalizeLocationKey(location.displayName || location.name || location.locationName);
  return location.isDefault === true ||
    location.systemLocked === true ||
    Number(location.is_default || location.isDefault || 0) === 1 ||
    ['main', 'locmain', 'mainstore', 'mainstorage', 'defaultstock'].includes(normalizedId) ||
    normalizedName === 'mainstore';
}

let locationToastTimer = null;
function dismissLocationToast() {
  if (locationToastTimer) {
    window.clearTimeout(locationToastTimer);
    locationToastTimer = null;
  }
  appState.locations = {
    ...appState.locations,
    toast: null
  };
  renderApp();
}

function showLocationToast(message, type = 'success') {
  if (locationToastTimer) window.clearTimeout(locationToastTimer);
  appState.locations = {
    ...appState.locations,
    toast: { message, type }
  };
  renderApp();
  locationToastTimer = window.setTimeout(() => {
    if (appState.locations.toast?.message === message) {
      appState.locations = {
        ...appState.locations,
        toast: null
      };
      renderApp();
    }
    locationToastTimer = null;
  }, 2800);
}

function updateManufacturingFilters(nextFilters) {
  appState.manufacturing = {
    ...appState.manufacturing,
    filters: {
      ...appState.manufacturing.filters,
      ...nextFilters
    }
  };
  renderApp();
}

function openManufacturingBlueprint(itemId = '') {
  const existing = (appState.manufacturing.manufacturedItems || []).find((entry) => String(entry.id) === String(itemId));
  const itemType = existing ? getManufacturingItemType(existing) : 'manufactured';
  appState.manufacturing = {
    ...appState.manufacturing,
    actionError: '',
    blueprintDraft: createEmptyManufacturingBlueprintDraft(existing ? {
      id: existing.id,
      name: existing.name,
      unit: existing.unit || '',
      category: itemType === 'sub_recipe'
        ? normalizeSubRecipeDraftCategory(existing.category || 'General')
        : normalizeManufacturingDraftCategory(existing.category || 'Manufactured', existing.name || ''),
      itemType,
      yieldBatch: existing.yieldBatch || 1,
      recipe: (existing.recipe || []).map((line) => ({
        ingId: line.ingId,
        name: line.name,
        unit: line.unit || '',
        qty: line.qty
      })),
      __dirty: false
    } : {}),
    filters: {
      ...appState.manufacturing.filters,
      componentQuery: '',
      componentCategory: '',
      componentType: ''
    }
  };
  renderApp();
}

function closeManufacturingBlueprint() {
  appState.manufacturing = {
    ...appState.manufacturing,
    blueprintDraft: null,
    lookupPicker: createManufacturingLookupPickerState(),
    filters: {
      ...appState.manufacturing.filters,
      componentQuery: '',
      componentCategory: '',
      componentType: ''
    }
  };
  renderApp();
}

function updateManufacturingBlueprint(updates = {}) {
  const draft = appState.manufacturing.blueprintDraft || createEmptyManufacturingBlueprintDraft();
  const validationErrors = Object.fromEntries(
    Object.entries(draft.validationErrors || {}).filter(([, value]) => value === true)
  );
  if (Object.prototype.hasOwnProperty.call(updates, 'category') && String(updates.category || '').trim()) {
    delete validationErrors.category;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'unit') && String(updates.unit || '').trim()) {
    delete validationErrors.unit;
  }
  const hasValidationErrors = Object.keys(validationErrors).length > 0;
  appState.manufacturing = {
    ...appState.manufacturing,
    actionError: hasValidationErrors ? appState.manufacturing.actionError : '',
    blueprintDraft: {
      ...draft,
      ...updates,
      validationErrors,
      __dirty: true
    }
  };
  renderApp();
}

function openManufacturingLookupPicker(field) {
  if (!isSupportedManufacturingLookupField(field) || !appState.manufacturing.blueprintDraft) return;
  appState.manufacturing = {
    ...appState.manufacturing,
    lookupPicker: {
      open: true,
      field,
      query: ''
    }
  };
  renderApp();
}

function closeManufacturingLookupPicker() {
  appState.manufacturing = {
    ...appState.manufacturing,
    lookupPicker: createManufacturingLookupPickerState()
  };
  renderApp();
}

function updateManufacturingLookupPickerQuery(value) {
  appState.manufacturing = {
    ...appState.manufacturing,
    lookupPicker: {
      ...(appState.manufacturing.lookupPicker || createManufacturingLookupPickerState()),
      query: String(value || '')
    }
  };
  renderApp();
}

function useManufacturingLookupPickerValue(field, value) {
  if (!isSupportedManufacturingLookupField(field) || !appState.manufacturing.blueprintDraft) return;
  const nextValue = String(value || '').trim();
  appState.manufacturing = {
    ...appState.manufacturing,
    blueprintDraft: {
      ...appState.manufacturing.blueprintDraft,
      [field]: nextValue,
      __dirty: true
    },
    lookupPicker: createManufacturingLookupPickerState()
  };
  renderApp();
}

function addManufacturingComponent(stockItemId = '') {
  const stockItem = (appState.manufacturing.stockItems || []).find((entry) => String(entry.id) === String(stockItemId));
  if (!stockItem) return;
  const draft = appState.manufacturing.blueprintDraft || createEmptyManufacturingBlueprintDraft();
  const recipe = [...(draft.recipe || [])];
  const existingIndex = recipe.findIndex((line) => String(line.ingId) === String(stockItemId));
  if (existingIndex >= 0) {
    recipe[existingIndex] = {
      ...recipe[existingIndex],
      qty: parseDecimalInputValue(recipe[existingIndex].qty, 0) + 1
    };
  } else {
    recipe.push({
      ingId: stockItem.id,
      name: stockItem.name || '',
      unit: stockItem.unit || 'ea',
      qty: 1
    });
  }

  appState.manufacturing = {
    ...appState.manufacturing,
    filters: {
      ...appState.manufacturing.filters,
      componentQuery: '',
      componentType: ''
    },
    blueprintDraft: {
      ...draft,
      recipe,
      componentPickerOpen: false,
      __dirty: true
    }
  };
  renderApp();
}

function toggleManufacturingComponentSelection(stockItemId = '') {
  const id = String(stockItemId || '').trim();
  if (!id) return;
  const draft = appState.manufacturing.blueprintDraft || createEmptyManufacturingBlueprintDraft();
  const current = new Set((draft.componentPickerSelection || []).map((value) => String(value)));
  if (current.has(id)) current.delete(id);
  else current.add(id);
  appState.manufacturing = {
    ...appState.manufacturing,
    blueprintDraft: {
      ...draft,
      componentPickerSelection: [...current],
      __dirty: true
    }
  };
  renderApp();
}

function confirmManufacturingComponentSelection() {
  const draft = appState.manufacturing.blueprintDraft || createEmptyManufacturingBlueprintDraft();
  const selectedIds = [...new Set((draft.componentPickerSelection || []).map((value) => String(value)).filter(Boolean))];
  if (!selectedIds.length) return;
  const stockMap = new Map((appState.manufacturing.stockItems || []).map((entry) => [String(entry.id), entry]));
  const recipe = [...(draft.recipe || [])];
  selectedIds.forEach((stockItemId) => {
    const stockItem = stockMap.get(stockItemId);
    if (!stockItem) return;
    const existingIndex = recipe.findIndex((line) => String(line.ingId) === stockItemId);
    if (existingIndex >= 0) {
      recipe[existingIndex] = {
        ...recipe[existingIndex],
        qty: parseDecimalInputValue(recipe[existingIndex].qty, 0) + 1
      };
    } else {
      recipe.push({
        ingId: stockItem.id,
        name: stockItem.name || '',
        unit: stockItem.unit || 'ea',
        qty: 1
      });
    }
  });
  appState.manufacturing = {
    ...appState.manufacturing,
    filters: {
      ...appState.manufacturing.filters,
      componentQuery: '',
      componentCategory: '',
      componentType: ''
    },
    blueprintDraft: {
      ...draft,
      recipe,
      componentPickerOpen: false,
      componentPickerSelection: [],
      __dirty: true
    }
  };
  renderApp();
}

function updateManufacturingRecipeLine(index, updates = {}) {
  const draft = appState.manufacturing.blueprintDraft || createEmptyManufacturingBlueprintDraft();
  appState.manufacturing = {
    ...appState.manufacturing,
    blueprintDraft: {
      ...draft,
      recipe: (draft.recipe || []).map((line, lineIndex) => (
        lineIndex === index ? { ...line, ...updates } : line
      )),
      __dirty: true
    }
  };
  renderApp();
}

function removeManufacturingRecipeLine(index) {
  const draft = appState.manufacturing.blueprintDraft || createEmptyManufacturingBlueprintDraft();
  appState.manufacturing = {
    ...appState.manufacturing,
    blueprintDraft: {
      ...draft,
      recipe: (draft.recipe || []).filter((_, lineIndex) => lineIndex !== index),
      __dirty: true
    }
  };
  renderApp();
}

async function saveManufacturingBlueprint() {
  const draft = appState.manufacturing.blueprintDraft || createEmptyManufacturingBlueprintDraft();
  const validationErrors = {};
  if (!String(draft.category || '').trim()) validationErrors.category = true;
  if (!String(draft.unit || '').trim()) validationErrors.unit = true;
  const missingFields = [
    validationErrors.category ? 'category' : '',
    validationErrors.unit ? 'UOM' : ''
  ].filter(Boolean);
  if (missingFields.length) {
    const message = missingFields.length === 2
      ? 'Add a category and UOM before saving this blueprint.'
      : `Add a ${missingFields[0]} before saving this blueprint.`;
    appState.manufacturing = {
      ...appState.manufacturing,
      actionStatus: '',
      actionError: message,
      blueprintDraft: {
        ...draft,
        validationErrors
      }
    };
    showManufacturingToast(message, 'error');
    return;
  }
  appState.manufacturing = {
    ...appState.manufacturing,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { fetchManufacturingWorkspace, saveManufacturedItem } = await import('./services/manufacturingService.js');
    const savedDraft = await saveManufacturedItem(appState.workspace?.id, draft);
    const snapshot = await fetchManufacturingWorkspace(appState.workspace?.id);
    const liveDraft = reconcileManufacturingBlueprintDraft(
      createEmptyManufacturingBlueprintDraft({ id: savedDraft.id || draft.id, __dirty: false }),
      snapshot.manufacturedItems || []
    );
    appState.manufacturing = {
      ...appState.manufacturing,
      ...snapshot,
      actionStatus: '',
      actionError: '',
      blueprintDraft: liveDraft?.name ? liveDraft : {
        ...draft,
        ...savedDraft,
        category: getManufacturingItemType(savedDraft || draft) === 'sub_recipe'
          ? normalizeSubRecipeDraftCategory(savedDraft?.category || draft.category || 'General')
          : normalizeManufacturingDraftCategory(savedDraft?.category || draft.category || 'Manufactured', savedDraft?.name || draft.name || ''),
        recipe: (savedDraft.recipe || draft.recipe || []).map((line) => ({ ...line })),
        yieldBatch: savedDraft.yieldBatch || draft.yieldBatch || 1,
        __dirty: false
      },
      filters: {
        ...appState.manufacturing.filters,
        componentQuery: '',
        componentType: ''
      }
    };
    renderApp();
    showManufacturingToast('Manufacturing blueprint saved.', 'success');
    refreshActiveTabFromApi().catch(() => {});
  } catch (error) {
    appState.manufacturing = {
      ...appState.manufacturing,
      actionStatus: '',
      actionError: error.message || 'Could not save manufacturing blueprint.'
    };
    renderApp();
    showManufacturingToast(error.message || 'Could not save manufacturing blueprint.', 'error');
  }
}

async function deleteManufacturingBlueprintEntry(itemId = '') {
  const item = (appState.manufacturing.manufacturedItems || []).find((entry) => String(entry.id) === String(itemId));
  if (!item) {
    showManufacturingToast('Manufactured item could not be found.', 'error');
    return;
  }
  const confirmed = await showBrandConfirmDialog({
    eyebrow: 'Delete Blueprint',
    title: `Delete blueprint ${item.name}?`,
    message: 'This removes the manufacturing blueprint from the active workspace.',
    confirmLabel: 'Delete Blueprint'
  });
  if (!confirmed) return;

  appState.manufacturing = {
    ...appState.manufacturing,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { deleteManufacturedItem } = await import('./services/manufacturingService.js');
    await deleteManufacturedItem(appState.workspace?.id, itemId);
    appState.manufacturing = {
      ...appState.manufacturing,
      manufacturedItems: removeRowsByIds(appState.manufacturing.manufacturedItems, [itemId]),
      stockItems: removeRowsByIds(appState.manufacturing.stockItems, [itemId]),
      blueprintDraft: String(appState.manufacturing.blueprintDraft?.id || '') === String(itemId) ? null : appState.manufacturing.blueprintDraft,
      actionStatus: '',
      actionError: ''
    };
    appState.stock = {
      ...appState.stock,
      items: removeRowsByIds(appState.stock.items, [itemId]),
      selectedIds: (appState.stock.selectedIds || []).filter((id) => String(id) !== String(itemId)),
      editingItem: String(appState.stock.editingItem?.id || '') === String(itemId) ? null : appState.stock.editingItem
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showManufacturingToast('Manufacturing blueprint deleted.', 'success');
  } catch (error) {
    appState.manufacturing = {
      ...appState.manufacturing,
      actionStatus: '',
      actionError: error.message || 'Could not delete manufacturing blueprint.'
    };
    renderApp();
  }
}

function openManufacturingBatch(itemId = '') {
  const item = (appState.manufacturing.manufacturedItems || []).find((entry) => String(entry.id) === String(itemId));
  if (!item) {
    showManufacturingToast('Manufactured item could not be found.', 'error');
    return;
  }
  if (getManufacturingItemType(item) === 'sub_recipe') {
    showManufacturingToast('Sub-recipes do not post production batches. They deplete when used in menu recipes or prep blueprints.', 'warning');
    return;
  }
  const siteId = getDefaultSiteIdForLocations(appState.manufacturing.sites || [], appState.manufacturing.locations || []);
  const locationId = getFirstLocationIdForSite(appState.manufacturing.locations || [], siteId) || appState.manufacturing.locations?.[0]?.id || '';
  appState.manufacturing = {
    ...appState.manufacturing,
    filters: {
      ...appState.manufacturing.filters,
      openDropdown: ''
    },
    batchDraft: createEmptyManufacturingBatchDraft({
      manufacturedItemId: item.id,
      itemName: item.name || '',
      siteId,
      siteName: getSiteNameById(appState.manufacturing.sites || [], siteId, ''),
      locationId,
      locationName: getLocationNameById(appState.manufacturing.locations || [], locationId, 'Main Store'),
      batchMultiplier: 1,
      unit: item.unit || 'ea',
      unitCost: item.unitCost || item.cost || 0,
      expectedQty: item.yieldBatch || 1,
      producedQty: item.yieldBatch || 1
    })
  };
  renderApp();
}

function closeManufacturingBatch() {
  appState.manufacturing = {
    ...appState.manufacturing,
    filters: {
      ...appState.manufacturing.filters,
      openDropdown: ''
    },
    batchDraft: null
  };
  renderApp();
}

function updateManufacturingBatch(updates = {}) {
  const draft = appState.manufacturing.batchDraft || createEmptyManufacturingBatchDraft();
  const normalizedUpdates = { ...updates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'siteId')) {
    normalizedUpdates.locationId = getFirstLocationIdForSite(appState.manufacturing.locations || [], normalizedUpdates.siteId);
    normalizedUpdates.siteName = getSiteNameById(appState.manufacturing.sites || [], normalizedUpdates.siteId, '');
    normalizedUpdates.locationName = normalizedUpdates.locationId
      ? getLocationNameById(appState.manufacturing.locations || [], normalizedUpdates.locationId, '')
      : '';
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'locationId')) {
    normalizedUpdates.siteId = getSiteIdForLocation(appState.manufacturing.locations || [], normalizedUpdates.locationId) || normalizedUpdates.siteId || '';
    normalizedUpdates.siteName = getSiteNameById(appState.manufacturing.sites || [], normalizedUpdates.siteId, normalizedUpdates.siteName || '');
    normalizedUpdates.locationName = getLocationNameById(appState.manufacturing.locations || [], normalizedUpdates.locationId, draft.locationName || 'Main Store');
  }
  appState.manufacturing = {
    ...appState.manufacturing,
    batchDraft: {
      ...draft,
      ...normalizedUpdates
    }
  };
  renderApp();
}

async function saveManufacturingBatch() {
  const draft = appState.manufacturing.batchDraft || createEmptyManufacturingBatchDraft();
  if (!draft.id) draft.id = makeStableSubmitId('mfg');
  const multiplier = Math.max(parseDecimalInputValue(draft.batchMultiplier, 1) || 1, 1);
  const manufacturedItem = (appState.manufacturing.manufacturedItems || [])
    .find((item) => String(item.id) === String(draft.manufacturedItemId || ''));
  const expectedQty = (parseDecimalInputValue(draft.expectedQty, 0) || 0) * multiplier;
  const producedQty = (parseDecimalInputValue(draft.producedQty, 0) || 0) * multiplier;
  const impact = manufacturedItem
    ? getManufacturingProductionImpactForSave(manufacturedItem, multiplier, expectedQty, producedQty, draft.locationId)
    : null;
  const payload = {
    ...draft,
    id: draft.id,
    itemId: draft.manufacturedItemId || draft.itemId || '',
    expectedQty,
    producedQty,
    batchMultiplier: multiplier,
    batchCount: multiplier,
    unit: manufacturedItem?.unit || draft.unit || 'ea',
    itemName: manufacturedItem?.name || draft.itemName || '',
    unitCost: (impact?.expectedUnitCost ?? Number(draft.unitCost || 0)) || 0,
    expectedUnitCost: (impact?.expectedUnitCost ?? Number(draft.unitCost || 0)) || 0,
    actualUnitCost: (impact?.actualUnitCost ?? Number(draft.unitCost || 0)) || 0,
    batchCost: impact?.batchCost ?? 0,
    variance: impact?.variance ?? (expectedQty - producedQty),
    wastageQty: impact?.wastageQty ?? Math.max(expectedQty - producedQty, 0),
    wastageValue: impact?.wastageValue ?? 0,
    components: impact?.components || []
  };
  appState.manufacturing = {
    ...appState.manufacturing,
    batchDraft: draft,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { postManufacturingBatch } = await import('./services/manufacturingService.js');
    await postManufacturingBatch(appState.workspace?.id, payload);
    appState.manufacturing = {
      ...appState.manufacturing,
      actionStatus: '',
      actionError: '',
      batchDraft: null
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showManufacturingToast('Production batch posted.', 'success');
  } catch (error) {
    appState.manufacturing = {
      ...appState.manufacturing,
      actionStatus: '',
      actionError: error.message || 'Could not post manufacturing batch.'
    };
    renderApp();
  }
}

function getManufacturingProductionDraft() {
  const current = appState.manufacturing.productionDraft || createEmptyManufacturingProductionDraft();
  const siteId = current.siteId || getDefaultSiteIdForLocations(appState.manufacturing.sites || [], appState.manufacturing.locations || []);
  const defaultLocation = getDefaultLocation(appState.manufacturing.locations || []);
  const defaultLocationId = defaultLocation?.id || defaultLocation?.locationId || '';
  const locationId = current.locationId || getFirstLocationIdForSite(appState.manufacturing.locations || [], siteId) || defaultLocationId || appState.manufacturing.locations?.[0]?.id || '';
  return createEmptyManufacturingProductionDraft({
    ...current,
    siteId,
    siteName: getSiteNameById(appState.manufacturing.sites || [], siteId, current.siteName || ''),
    locationId,
    locationName: getLocationNameById(appState.manufacturing.locations || [], locationId, current.locationName || 'Main Store')
  });
}

function updateManufacturingProductionDraft(updates = {}) {
  const draft = getManufacturingProductionDraft();
  const normalizedUpdates = { ...updates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'siteId')) {
    normalizedUpdates.locationId = getFirstLocationIdForSite(appState.manufacturing.locations || [], normalizedUpdates.siteId);
    normalizedUpdates.siteName = getSiteNameById(appState.manufacturing.sites || [], normalizedUpdates.siteId, '');
    normalizedUpdates.locationName = normalizedUpdates.locationId
      ? getLocationNameById(appState.manufacturing.locations || [], normalizedUpdates.locationId, '')
      : '';
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'locationId')) {
    normalizedUpdates.siteId = getSiteIdForLocation(appState.manufacturing.locations || [], normalizedUpdates.locationId) || normalizedUpdates.siteId || draft.siteId || '';
    normalizedUpdates.siteName = getSiteNameById(appState.manufacturing.sites || [], normalizedUpdates.siteId, normalizedUpdates.siteName || draft.siteName || '');
    normalizedUpdates.locationName = getLocationNameById(appState.manufacturing.locations || [], normalizedUpdates.locationId, draft.locationName || 'Main Store');
  }
  appState.manufacturing = {
    ...appState.manufacturing,
    productionDraft: {
      ...draft,
      ...normalizedUpdates
    }
  };
  renderApp();
}

function updateManufacturingProductionBatches(itemId = '', value = '') {
  const draft = getManufacturingProductionDraft();
  const id = String(itemId || '').trim();
  if (!id) return;
  appState.manufacturing = {
    ...appState.manufacturing,
    productionDraft: {
      ...draft,
      batchCounts: {
        ...(draft.batchCounts || {}),
        [id]: value
      }
    }
  };
  renderApp();
}

function updateManufacturingProductionActual(itemId = '', value = '') {
  const draft = getManufacturingProductionDraft();
  const id = String(itemId || '').trim();
  if (!id) return;
  appState.manufacturing = {
    ...appState.manufacturing,
    productionDraft: {
      ...draft,
      actuals: {
        ...(draft.actuals || {}),
        [id]: value
      }
    }
  };
  renderApp();
}

async function saveManufacturingProductionEvent() {
  const draft = getManufacturingProductionDraft();
  const actuals = draft.actuals || {};
  const batchCounts = draft.batchCounts || {};
  const items = (appState.manufacturing.manufacturedItems || [])
    .filter((item) => getManufacturingItemType(item) === 'manufactured')
    .map((item) => {
      const batchCount = Math.max(parseDecimalInputValue(batchCounts[item.id], 0) || 0, 0);
      const expected = batchCount * (parseDecimalInputValue(item.yieldBatch, 0) || 0);
      const actualRaw = String(actuals[item.id] ?? '').trim();
      const produced = actualRaw ? Math.max(parseDecimalInputValue(actualRaw, 0) || 0, 0) : expected;
      return { item, batchCount, expected, produced };
    })
    .filter((entry) => entry.batchCount > 0);

  if (!items.length) {
    appState.manufacturing = {
      ...appState.manufacturing,
      actionError: 'Enter the number of batches for at least one prep item.'
    };
    renderApp();
    return;
  }

  if (items.some((entry) => !(entry.expected > 0) || !(entry.produced > 0))) {
    appState.manufacturing = {
      ...appState.manufacturing,
      actionError: 'Production lines need a positive standard yield and produced quantity.'
    };
    renderApp();
    return;
  }

  if (!draft.locationId) {
    appState.manufacturing = {
      ...appState.manufacturing,
      actionError: 'Choose a storage area before posting production.'
    };
    renderApp();
    return;
  }

  const blockingImpact = items
    .map(({ item, batchCount, expected, produced }) => getManufacturingProductionImpactForSave(item, batchCount, expected, produced, draft.locationId))
    .find((impact) => impact.hasMissingRecipe || impact.hasInsufficientStock);
  if (blockingImpact?.hasMissingRecipe) {
    const message = `${blockingImpact.itemName} has no blueprint ingredients. Add ingredients before posting production.`;
    appState.manufacturing = {
      ...appState.manufacturing,
      actionError: message
    };
    renderApp();
    showManufacturingToast(message, 'error');
    return;
  }
  if (blockingImpact?.hasInsufficientStock) {
    const line = blockingImpact.components.find((component) => component.missing || component.insufficient) || {};
    const message = line.missing
      ? `${blockingImpact.itemName} has a missing blueprint ingredient.`
      : `Not enough ${line.name} in ${draft.locationName || 'the selected storage area'}. Available: ${formatNumber(line.before)} ${line.unit}. Required: ${formatNumber(line.usage)} ${line.unit}. After production would be ${formatNumber(line.after)} ${line.unit}.`;
    appState.manufacturing = {
      ...appState.manufacturing,
      actionError: message
    };
    renderApp();
    showManufacturingToast(message, 'error');
    return;
  }

  // Stable per-item ids so a retry of this bulk post reuses them and the backend dedupes any
  // batches that already committed before an earlier failure.
  const existingSubmitIds = (draft.submitIds && typeof draft.submitIds === 'object') ? draft.submitIds : {};
  const submitIds = { ...existingSubmitIds };
  for (const { item } of items) {
    if (!submitIds[item.id]) submitIds[item.id] = makeStableSubmitId('mfg');
  }
  appState.manufacturing = {
    ...appState.manufacturing,
    productionDraft: { ...draft, submitIds },
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { postManufacturingBatch } = await import('./services/manufacturingService.js');
    for (const { item, batchCount, expected, produced } of items) {
      const impact = getManufacturingProductionImpactForSave(item, batchCount, expected, produced, draft.locationId);
      await postManufacturingBatch(appState.workspace?.id, {
        id: submitIds[item.id],
        manufacturedItemId: item.id,
        itemId: item.id,
        itemName: item.name || '',
        siteId: draft.siteId,
        siteName: draft.siteName,
        locationId: draft.locationId,
        locationName: draft.locationName,
        batchMultiplier: 1,
        unit: item.unit || 'ea',
        unitCost: impact.expectedUnitCost,
        expectedUnitCost: impact.expectedUnitCost,
        actualUnitCost: impact.actualUnitCost,
        batchCost: impact.batchCost,
        expectedQty: expected,
        producedQty: produced,
        variance: impact.variance,
        wastageQty: impact.wastageQty,
        wastageValue: impact.wastageValue,
        components: impact.components,
        batchCount,
        date: draft.date,
        note: draft.note
      });
    }
    appState.manufacturing = {
      ...appState.manufacturing,
      actionStatus: '',
      actionError: '',
      productionDraft: createEmptyManufacturingProductionDraft({
        ...draft,
        batchCounts: {},
        actuals: {}
      })
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showManufacturingToast(`${items.length} production batch${items.length === 1 ? '' : 'es'} posted.`, 'success');
  } catch (error) {
    appState.manufacturing = {
      ...appState.manufacturing,
      actionStatus: '',
      actionError: error.message || 'Could not post production event.'
    };
    renderApp();
  }
}

function getManufacturingProductionImpactForSave(item = {}, batchCount = 0, expectedQty = 0, producedQty = 0, locationId = '') {
  const stockItems = appState.manufacturing.stockItems || [];
  const componentMap = new Map(stockItems.map((entry) => [String(entry.id), entry]));
  const recipe = Array.isArray(item.recipe) ? item.recipe : [];
  const fallbackUnitCost = Number(item.unitCost || item.cost || 0) || 0;
  const standardYield = Math.max(parseDecimalInputValue(item.yieldBatch, 0) || 0, 0);
  const recipeBatchCost = Number(item.batchCost || 0) || ((standardYield > 0 ? standardYield : expectedQty) * fallbackUnitCost);
  const batchCost = recipeBatchCost * Math.max(batchCount || 0, 0);
  const expectedUnitCost = expectedQty > 0 ? batchCost / expectedQty : (standardYield > 0 ? recipeBatchCost / standardYield : fallbackUnitCost);
  const actualUnitCost = producedQty > 0 ? batchCost / producedQty : expectedUnitCost;
  const yieldBatch = standardYield;
  const components = recipe.map((line) => {
    const component = componentMap.get(String(line.ingId || line.id || line.stockItemId || ''));
    const componentQty = Math.max(parseDecimalInputValue(line.qty || line.quantity || 0, 0) || 0, 0);
    const usage = yieldBatch > 0 ? (componentQty / yieldBatch) * expectedQty : 0;
    const before = getManufacturingLocationQuantity(component, locationId);
    const after = before - usage;
    const cost = Number(component?.cost || component?.unitCost || component?.lastPurchasePrice || 0) || 0;
    return {
      id: String(component?.id || line.ingId || ''),
      name: component?.name || 'Missing ingredient',
      unit: String(component?.unit || '').toLowerCase(),
      qty: usage,
      cost,
      unitCost: cost,
      before,
      usage,
      after,
      missing: !component,
      insufficient: Boolean(component) && usage > 0 && after < 0
    };
  });
  return {
    itemName: item.name || 'Production item',
    itemId: String(item.id || '').trim(),
    batchCount,
    expectedQty,
    producedQty,
    variance: expectedQty - producedQty,
    wastageQty: Math.max(expectedQty - producedQty, 0),
    wastageValue: Math.max(expectedQty - producedQty, 0) * expectedUnitCost,
    batchCost,
    expectedUnitCost,
    actualUnitCost,
    components,
    hasMissingRecipe: !recipe.length,
    hasInsufficientStock: components.some((line) => line.missing || line.insufficient)
  };
}

function getManufacturingLocationQuantity(item = {}, locationId = '') {
  const balances = item?.balances && typeof item.balances === 'object' ? item.balances : {};
  const key = String(locationId || '').trim();
  if (key && Object.prototype.hasOwnProperty.call(balances, key)) return Number(balances[key] || 0) || 0;
  if (key) return 0;
  return Object.keys(balances).length
    ? Object.values(balances).reduce((sum, value) => sum + (Number(value || 0) || 0), 0)
    : Number(item?.stock || 0) || 0;
}

async function importManufacturingFile(file) {
  if (!file) return;
  appState.manufacturing = {
    ...appState.manufacturing,
    actionStatus: 'importing',
    actionError: ''
  };
  renderApp();

  try {
    const rows = await parseDataFile(file, { preferredSheetNames: ['Manufacturing_Import'] });
    const { items, review } = mapManufacturingImportRows(rows, appState.manufacturing.stockItems || []);
    if (!items.length) throw new Error(formatImportFailure('No valid manufactured item rows were found in this file.', review.errors));

    const { importManufacturedItems } = await import('./services/manufacturingService.js');
    const result = await importManufacturedItems(appState.workspace?.id, items);
    appState.manufacturing = {
      ...appState.manufacturing,
      actionStatus: '',
      actionError: ''
    };
    const skippedCount = Number(review.errors.length || 0);
    if (skippedCount) {
      showImportNotification({
        moduleLabel: 'Manufacturing Import',
        title: 'Manufacturing Import Needs Attention',
        message: `${result.importedCount || 0} blueprint${Number(result.importedCount || 0) === 1 ? '' : 's'} imported, but ${skippedCount} row${skippedCount === 1 ? '' : 's'} need fixing. Confirm this message, fix the errors, and try again.`,
        errors: review.errors,
        importedCount: result.importedCount || 0,
        skippedCount,
        totalRows: review.totalRows,
        tone: 'warning',
        confirmLabel: 'Confirm & Fix Errors'
      });
    } else {
      showManufacturingToast(`Manufactured items imported (${result.importedCount} blueprints syncing to cloud).`, 'success');
    }
  } catch (error) {
    appState.manufacturing = {
      ...appState.manufacturing,
      actionStatus: '',
      actionError: ''
    };
    showImportNotification({
      moduleLabel: 'Manufacturing Import',
      title: 'Manufacturing Import Failed',
      message: `${error.message || 'Manufacturing import failed.'} Confirm this message, fix the file, and try again.`,
      errors: [error.message || 'Manufacturing import failed.'],
      tone: 'error',
      confirmLabel: 'Confirm & Try Again'
    });
  }
}

async function exportManufacturingItems(format = 'csv') {
  const normalizedFormat = String(format || 'csv');
  if (normalizedFormat.startsWith('template-')) {
    await exportManufacturingTemplate(normalizedFormat.replace('template-', '') || 'csv');
    return;
  }

  const items = appState.manufacturing.manufacturedItems || [];
  if (!items.length) {
    showManufacturingToast('No manufactured items are available to export.', 'warning');
    return;
  }

  try {
    await exportObjectRows({
      format: normalizedFormat,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Manufacturing Export' }),
      sheetName: 'Manufacturing',
      title: 'Manufacturing Blueprints',
      subtitle: `${appState.workspace?.siteName || 'KCP'} · ${items.length} manufactured item${items.length === 1 ? '' : 's'}`,
      rows: buildManufacturingRows(items, appState.manufacturing.stockItems || []),
      columns: exportSchemas.manufacturing,
      branding: getPdfBranding()
    });
    showManufacturingToast(`${items.length} manufactured item${items.length === 1 ? '' : 's'} exported as ${normalizedFormat.toUpperCase()}.`, 'success');
  } catch (error) {
    showManufacturingToast(error.message || 'Manufacturing export failed.', 'error');
  }
}

async function exportManufacturingTemplate(format = 'csv') {
  const [baseFormat, platform = 'excel'] = String(format || 'csv').split(':');
  const normalizedFormat = ['csv', 'xlsx', 'pdf'].includes(baseFormat) ? baseFormat : 'csv';

  if (normalizedFormat === 'xlsx') {
    try {
      const stockItems = appState.manufacturing.stockItems || [];
      const manufacturedItems = (appState.manufacturing.stockItems || []).filter((item) => {
        const t = String(item.itemType || item.item_type || item.type || '').toLowerCase();
        return t === 'manufactured' || t === 'sub_recipe' || t === 'sub-recipe';
      });
      await buildManufacturingBuilderXlsx({
        manufacturedItems,
        stockItems,
        filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Manufacturing Builder Export' })
      });
      showManufacturingToast(`Manufacturing builder exported as XLSX.`, 'success');
    } catch (error) {
      showManufacturingToast(error.message || 'Manufacturing builder export failed.', 'error');
    }
    return;
  }

  try {
    await exportObjectRows({
      format: normalizedFormat,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName, reportType: 'Manufacturing Template Export' }),
      sheetName: 'Manufacturing_Import',
      title: 'Manufacturing Import Template',
      subtitle: 'Use one row per component. Leave Component_Name blank to create a blueprint shell.',
      rows: buildTemplateRows(exportSchemas.manufacturing),
      columns: exportSchemas.manufacturing,
      branding: getPdfBranding()
    });
    showManufacturingToast(`Manufacturing template exported as ${normalizedFormat.toUpperCase()}.`, 'success');
  } catch (error) {
    showManufacturingToast(error.message || 'Manufacturing template export failed.', 'error');
  }
}

function mapManufacturingImportRows(rows = [], stockItems = []) {
  const ingredientByName = new Map((stockItems || []).map((item) => [
    normalizeImportKey(item.name),
    item
  ]));
  // Match existing manufactured / sub-recipe items so an import UPDATES them in place
  // rather than creating duplicates (same behaviour as the standard recipe import).
  // Match on the SUFFIX-STRIPPED base name — imported names get a " - Manufactured"
  // suffix added, but existing stored names may or may not carry it, so we compare the
  // base name to avoid missing the match and creating duplicates.
  const baseNameKey = (value = '') => normalizeImportKey(String(value || '')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .replace(/\s+-\s+Sub-?Recipe$/i, '')
    .trim());
  const existingManufacturedByName = new Map();
  (stockItems || []).forEach((item) => {
    const type = String(item.itemType || item.item_type || item.type || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (type === 'manufactured' || type === 'sub_recipe' || item.isManufactured === true || item.isSubRecipe === true) {
      existingManufacturedByName.set(baseNameKey(item.name), item);
    }
  });
  const existingManufacturedById = new Map((stockItems || []).map((item) => [normalizeImportKey(item.id), item]));
  const groups = new Map();
  const review = createImportReview(rows);

  getImportDataRows(rows).forEach(({ row, rowNumber }) => {
    const rawName = norm(getColumn(row, 'Name', 'Manufactured_Item', 'Manufactured Item', 'Item', 'Product'));
    if (!rawName) {
      review.errors.push(createImportError('ERR_MISSING_NAME', rowNumber, 'Name is required.'));
      return;
    }
    const itemType = normalizeManufacturingImportType(getColumn(row, 'Item_Type', 'Item Type', 'Type', 'Specification'));
    const name = normalizeManufacturedItemName(rawName, itemType);
    const category = itemType === 'sub_recipe'
      ? normalizeSubRecipeDraftCategory(norm(getColumn(row, 'Category', 'Manufactured_Category', 'Manufactured Category', 'Group')) || 'General')
      : normalizeManufacturingImportCategory(name, getColumn(row, 'Category', 'Manufactured_Category', 'Manufactured Category', 'Group'));
    const batchYieldRaw = getColumn(row, 'Batch_Yield', 'BatchYield', 'Batch Yield');
    const batchYield = parseImportNumber(batchYieldRaw, 1);
    if (batchYield === null || batchYield <= 0) {
      review.errors.push(createImportError('ERR_BATCH_YIELD', rowNumber, 'Batch_Yield must be a number greater than zero.'));
      return;
    }
    if (!groups.has(name)) {
      const providedId = norm(getColumn(row, 'ID', 'Id', 'Code'));
      const existing = (providedId && existingManufacturedById.get(normalizeImportKey(providedId))) ||
        existingManufacturedByName.get(baseNameKey(name));
      groups.set(name, {
        // Reuse the existing item's id when it already exists so the import updates
        // it instead of creating a duplicate.
        id: existing?.id || providedId || safeMenuId(name),
        name,
        itemType,
        category,
        unit: norm(getColumn(row, 'Unit', 'UOM')),
        yieldBatch: batchYield,
        recipe: []
      });
    }

    const group = groups.get(name);
    if (category) group.category = category;
    const unit = norm(getColumn(row, 'Unit', 'UOM'));
    if (unit) group.unit = unit;
    group.yieldBatch = batchYield;

    const componentName = norm(getColumn(row, 'Component_Name', 'Ingredient_Name', 'Component Name', 'Ingredient', 'Stock Item'));
    if (!componentName) return;
    const component = ingredientByName.get(normalizeImportKey(componentName));
    if (!component) {
      review.errors.push(createImportError('ERR_COMPONENT_LOOKUP', rowNumber, `Component "${componentName}" was not found in stock items.`));
      return;
    }
    const qty = parseImportNumber(getColumn(row, 'Quantity_Needed', 'Quantity', 'Qty', 'Quantity Needed'), null);
    if (qty === null || qty <= 0) {
      review.errors.push(createImportError('ERR_QUANTITY', rowNumber, 'Quantity_Needed must be a number greater than zero.'));
      return;
    }
    group.recipe.push({ ingId: component.id, qty });
  });

  const items = [...groups.values()];
  review.importedCount = items.length;
  review.skippedCount = review.errors.length;
  return { items, review };
}

function normalizeManufacturingImportCategory(itemName = '', value = '') {
  const raw = norm(value)
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .trim();
  const baseName = String(itemName || '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .trim();
  let customerCategory = raw;
  const existingFormatted = raw.match(/\(([^)]+)\)$/);

  if (existingFormatted?.[1] && baseName && raw.toLowerCase().startsWith(`${baseName.toLowerCase()} (`)) {
    customerCategory = existingFormatted[1].trim();
  } else if (baseName && raw.toLowerCase().startsWith(`${baseName.toLowerCase()} - `)) {
    customerCategory = raw.slice(baseName.length + 3).trim();
  }

  if (!customerCategory || customerCategory.toLowerCase() === 'manufactured') return 'Manufactured';
  return `${customerCategory} - Manufactured`;
}

function normalizeManufacturingImportType(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['sub_recipe', 'subrecipe', 'sub', 'sub_recipe_item'].includes(normalized)) return 'sub_recipe';
  return 'manufactured';
}

let manufacturingToastTimer = null;
function dismissManufacturingToast() {
  if (manufacturingToastTimer) {
    window.clearTimeout(manufacturingToastTimer);
    manufacturingToastTimer = null;
  }
  appState.manufacturing = {
    ...appState.manufacturing,
    toast: null
  };
  renderApp();
}

function showManufacturingToast(message, type = 'success') {
  if (manufacturingToastTimer) window.clearTimeout(manufacturingToastTimer);
  appState.manufacturing = {
    ...appState.manufacturing,
    toast: { message, type }
  };
  renderApp();
  manufacturingToastTimer = window.setTimeout(() => {
    if (appState.manufacturing.toast?.message === message) {
      appState.manufacturing = {
        ...appState.manufacturing,
        toast: null
      };
      renderApp();
    }
    manufacturingToastTimer = null;
  }, 2800);
}

function updateStockTakeFilters(nextFilters) {
  appState.stockTake = {
    ...appState.stockTake,
    filters: {
      ...appState.stockTake.filters,
      ...nextFilters
    }
  };
  renderApp();
}

function openStockTakeOverlay(overlay, extraFilters = {}) {
  appState.stockTake = {
    ...appState.stockTake,
    actionError: '',
    filters: {
      ...appState.stockTake.filters,
      overlay,
      openDropdown: '',
      ...extraFilters
    }
  };
  renderApp();
}

function closeStockTakeOverlay() {
  stopStockTakeCameraScanner();
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: createEmptyStockTakeScanCountDraft(),
    filters: {
      ...appState.stockTake.filters,
      overlay: '',
      openDropdown: '',
      templateSelectionQuery: '',
      templateListQuery: '',
      exportTemplateId: '',
      exportLocationId: ''
    }
  };
  renderApp();
}

function openStockTakeStartSession() {
  if (!(appState.stockTake.templates || []).length) {
    showStockTakeToast('Please create a template first.', 'warning');
    openStockTakeTemplateManager();
    return;
  }
  const firstTemplate = appState.stockTake.templates[0] || null;
  const firstTemplateLocations = getAvailableStockTakeTemplateLocationIds(firstTemplate);
  const siteId = firstTemplate ? getStockTakeTemplateSiteId(firstTemplate) : getDefaultStockTakeSiteId();
  const locationId = firstTemplateLocations.length === 1 ? firstTemplateLocations[0] : '';
  appState.stockTake = {
    ...appState.stockTake,
    actionError: '',
    sessionSetup: {
      templateId: firstTemplate?.id || '',
      siteId,
      locationId,
      date: todayLocal()
    },
    filters: {
      ...appState.stockTake.filters,
      overlay: 'start-session',
      openDropdown: ''
    }
  };
  renderApp();
}

function openStockTakeQuickCount() {
  const siteId = getDefaultStockTakeSiteId();
  const siteLocations = getStockTakeLocationsForSite(siteId);
  const locationId = siteLocations.length === 1 ? String(siteLocations[0]?.id || '') : '';
  appState.stockTake = {
    ...appState.stockTake,
    actionError: '',
    sessionSetup: {
      ...appState.stockTake.sessionSetup,
      templateId: '',
      siteId,
      locationId,
      date: todayLocal()
    },
    filters: {
      ...appState.stockTake.filters,
      overlay: 'quick-count',
      openDropdown: ''
    }
  };
  renderApp();
}

function openStockTakeBulkScan() {
  const siteId = getDefaultStockTakeSiteId();
  const siteLocations = getStockTakeLocationsForSite(siteId);
  const locationId = siteLocations.length === 1 ? String(siteLocations[0]?.id || '') : '';
  appState.stockTake = {
    ...appState.stockTake,
    actionError: '',
    scanCount: createEmptyStockTakeScanCountDraft(),
    sessionSetup: {
      ...appState.stockTake.sessionSetup,
      templateId: '',
      siteId,
      locationId,
      date: todayLocal()
    },
    filters: {
      ...appState.stockTake.filters,
      overlay: 'bulk-scan-setup',
      openDropdown: ''
    }
  };
  renderApp();
}

function openStockTakeTemplateManager() {
  appState.stockTake = {
    ...appState.stockTake,
    filters: {
      ...appState.stockTake.filters,
      overlay: 'template-manager',
      openDropdown: '',
      templateListQuery: appState.stockTake.filters?.templateListQuery || ''
    }
  };
  renderApp();
}

function openStockTakeTemplateEditor(templateId = '') {
  const existing = (appState.stockTake.templates || []).find((template) => String(template.id) === String(templateId));
  const existingLocations = getStockTakeTemplateLocationIds(existing);
  const defaultLocation = getDefaultLocation(appState.stockTake.locations || []);
  const fallbackLocationId = defaultLocation?.id || defaultLocation?.locationId || appState.stockTake.locations?.[0]?.id || 'main';
  const siteId = existing ? getStockTakeTemplateSiteId(existing) : getDefaultStockTakeSiteId();
  const scopedLocations = existingLocations.filter((locationId) => !siteId || getStockTakeSiteIdForLocation(locationId) === String(siteId));
  const targetLocations = scopedLocations.length ? scopedLocations : [getFirstStockTakeLocationIdForSite(siteId) || fallbackLocationId].filter(Boolean);
  appState.stockTake = {
    ...appState.stockTake,
    templateDraft: createEmptyStockTakeTemplateDraft({
      ...existing,
      siteId,
      siteName: getStockTakeSiteName(siteId),
      targetLocation: targetLocations[0] || fallbackLocationId,
      targetLocations
    }),
    filters: {
      ...appState.stockTake.filters,
      overlay: 'template-editor',
      openDropdown: '',
      templateSelectionQuery: ''
    }
  };
  renderApp();
}

function updateStockTakeSessionSetup(updates = {}) {
  const nextSetup = {
    ...appState.stockTake.sessionSetup,
    ...updates
  };
  if (Object.prototype.hasOwnProperty.call(updates, 'siteId')) {
    const template = (appState.stockTake.templates || []).find((entry) => String(entry.id) === String(nextSetup.templateId || ''));
    const templateLocationIds = template ? getAvailableStockTakeTemplateLocationIds(template) : null;
    const scopedLocationIds = templateLocationIds
      ? templateLocationIds.filter((locationId) => getStockTakeSiteIdForLocation(locationId) === String(updates.siteId))
      : getStockTakeLocationsForSite(updates.siteId).map((location) => String(location.id || '')).filter(Boolean);
    nextSetup.locationId = scopedLocationIds.length === 1 ? scopedLocationIds[0] : '';
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'templateId')) {
    const template = (appState.stockTake.templates || []).find((entry) => String(entry.id) === String(updates.templateId));
    const templateLocationIds = getAvailableStockTakeTemplateLocationIds(template);
    if (templateLocationIds.length) {
      const nextSiteId = getStockTakeTemplateSiteId(template);
      nextSetup.siteId = nextSiteId;
      if (!templateLocationIds.includes(String(nextSetup.locationId || '')) || getStockTakeSiteIdForLocation(nextSetup.locationId) !== String(nextSiteId)) {
        nextSetup.locationId = templateLocationIds.length === 1 ? templateLocationIds[0] : '';
      }
    } else if (!templateLocationIds.length) {
      nextSetup.locationId = '';
    }
  } else if (Object.prototype.hasOwnProperty.call(updates, 'locationId')) {
    nextSetup.siteId = getStockTakeSiteIdForLocation(updates.locationId) || nextSetup.siteId || '';
  }
  appState.stockTake = {
    ...appState.stockTake,
    sessionSetup: nextSetup
  };
  renderApp();
}

function startStockTakeFromTemplate() {
  const setup = appState.stockTake.sessionSetup || {};
  const template = (appState.stockTake.templates || []).find((entry) => String(entry.id) === String(setup.templateId));
  if (!template) {
    appState.stockTake = {
      ...appState.stockTake,
      actionError: 'Choose a template before starting a session.'
    };
    renderApp();
    return;
  }
  const templateLocationIds = getAvailableStockTakeTemplateLocationIds(template);
  const siteId = setup.siteId || getStockTakeTemplateSiteId(template);
  const locationId = setup.locationId || '';
  if (!templateLocationIds.length) {
    appState.stockTake = {
      ...appState.stockTake,
      actionError: 'This template has no active locations. Edit the template and choose a valid location first.'
    };
    renderApp();
    return;
  }
  if (!locationId) {
    appState.stockTake = {
      ...appState.stockTake,
      actionError: 'Choose the selling location linked to this template before starting.'
    };
    renderApp();
    return;
  }
  if (templateLocationIds.length && !templateLocationIds.includes(String(locationId))) {
    appState.stockTake = {
      ...appState.stockTake,
      actionError: 'Choose a location included in this template before starting.'
    };
    renderApp();
    return;
  }
  appState.stockTake = {
    ...appState.stockTake,
    sessionActive: true,
    actionError: '',
    draftSession: hydrateStockTakeDraft(createEmptyStockTakeDraft({
      date: setup.date || todayLocal(),
      siteId: getStockTakeSiteIdForLocation(locationId) || siteId,
      siteName: getStockTakeSiteName(getStockTakeSiteIdForLocation(locationId) || siteId),
      locationId,
      locationName: getLocationNameById(appState.stockTake.locations || [], locationId, 'Main Store'),
      templateId: template.id,
      templateName: template.name,
      templateScope: template.scope,
      templateSelections: [...(template.selections || [])],
      sessionMode: 'template'
    }), appState.stockTake.locations || []),
    filters: {
      ...appState.stockTake.filters,
      overlay: '',
      openDropdown: '',
      query: ''
    }
  };
  renderApp();
}

function startQuickStockTakeSession() {
  const setup = appState.stockTake.sessionSetup || {};
  const siteId = setup.siteId || getDefaultStockTakeSiteId();
  const locationId = setup.locationId || '';
  if (!locationId) {
    appState.stockTake = {
      ...appState.stockTake,
      actionError: 'Choose a selling location before starting the quick count.'
    };
    renderApp();
    return;
  }
  appState.stockTake = {
    ...appState.stockTake,
    sessionActive: true,
    actionError: '',
    draftSession: hydrateStockTakeDraft(createEmptyStockTakeDraft({
      date: setup.date || todayLocal(),
      siteId: getStockTakeSiteIdForLocation(locationId) || siteId,
      siteName: getStockTakeSiteName(getStockTakeSiteIdForLocation(locationId) || siteId),
      locationId,
      locationName: getLocationNameById(appState.stockTake.locations || [], locationId, 'Main Store'),
      templateId: 'quick',
      templateName: 'Quick Count',
      templateScope: '',
      templateSelections: [],
      sessionMode: 'quick'
    }), appState.stockTake.locations || []),
    filters: {
      ...appState.stockTake.filters,
      overlay: '',
      openDropdown: '',
      query: ''
    }
  };
  renderApp();
}

function confirmStockTakeBulkScanSetup() {
  const setup = appState.stockTake.sessionSetup || {};
  const siteId = setup.siteId || getDefaultStockTakeSiteId();
  const locationId = setup.locationId || '';
  if (!locationId) {
    appState.stockTake = {
      ...appState.stockTake,
      actionError: 'Choose a location before starting bulk scan.'
    };
    renderApp();
    return;
  }
  stockTakeRejectedBarcode = { code: '', at: 0 };
  appState.stockTake = {
    ...appState.stockTake,
    actionError: '',
    sessionSetup: {
      ...setup,
      templateId: '',
      siteId: getStockTakeSiteIdForLocation(locationId) || siteId,
      locationId,
      locationName: getLocationNameById(appState.stockTake.locations || [], locationId, 'Main Store'),
      date: setup.date || todayLocal()
    },
    scanCount: createEmptyStockTakeScanCountDraft({
      cameraOpen: true,
      cameraStatus: 'Point the camera at a barcode to load items.',
      cameraItems: []
    }),
    filters: {
      ...appState.stockTake.filters,
      overlay: 'bulk-scan',
      openDropdown: ''
    }
  };
  renderApp();
}

async function finaliseStockTakeBulkScan() {
  const setup = appState.stockTake.sessionSetup || {};
  const scanCount = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  const scannedItems = getLoadedStockTakeCameraItems(scanCount);
  if (!scannedItems.length) {
    showStockTakeToast('Scan at least one item before finalising.', 'warning');
    return;
  }
  const siteId = setup.siteId || getStockTakeSiteIdForLocation(setup.locationId) || getDefaultStockTakeSiteId();
  const locationId = setup.locationId || '';
  if (!locationId) {
    showStockTakeToast('Choose a location before finalising bulk scan.', 'warning');
    return;
  }

  await stopStockTakeCameraScanner();
  appState.stockTake = {
    ...appState.stockTake,
    sessionActive: true,
    actionError: '',
    draftSession: hydrateStockTakeDraft(createEmptyStockTakeDraft({
      date: setup.date || todayLocal(),
      siteId: getStockTakeSiteIdForLocation(locationId) || siteId,
      siteName: getStockTakeSiteName(getStockTakeSiteIdForLocation(locationId) || siteId),
      locationId,
      locationName: getLocationNameById(appState.stockTake.locations || [], locationId, 'Main Store'),
      templateId: 'bulk-scan',
      templateName: 'Bulk Scan',
      templateScope: '',
      templateSelections: [],
      sessionMode: 'quick'
    }), appState.stockTake.locations || []),
    scanCount: createEmptyStockTakeScanCountDraft(),
    filters: {
      ...appState.stockTake.filters,
      overlay: '',
      openDropdown: '',
      query: ''
    }
  };
  scannedItems.forEach((item) => {
    incrementStockTakeCountWithOptions(item.stockItemId, Number(item.quantity || 0) || 0, {
      focusField: false,
      setQuery: false,
      render: false,
      uomCounts: getStockTakeCameraItemUomCounts(item),
      scanBreakdown: getStockTakeCameraItemUomCounts(item),
      selectedUom: item.selectedUom || item.unit || 'ea'
    });
  });
  renderApp();
  showStockTakeToast(`${scannedItems.length} scanned ${scannedItems.length === 1 ? 'item is' : 'items are'} loaded and ready to review.`, 'success');
}

function cancelStockTakeSession() {
  appState.stockTake = {
    ...appState.stockTake,
    sessionActive: false,
    draftSession: hydrateStockTakeDraft(createEmptyStockTakeDraft(), appState.stockTake.locations || []),
    filters: {
      ...appState.stockTake.filters,
      query: '',
      openDropdown: '',
      overlay: ''
    },
    sessionSetup: createEmptyStockTakeSessionSetup(),
    templateDraft: null
  };
  renderApp();
}

function updateStockTakeDraft(updates = {}) {
  const draft = hydrateStockTakeDraft(appState.stockTake.draftSession, appState.stockTake.locations || []);
  appState.stockTake = {
    ...appState.stockTake,
    actionError: '',
    draftSession: {
      ...draft,
      ...updates
    }
  };
  renderApp();
}

function createEmptyStockTakeScanCountDraft(seed = {}) {
  return {
    barcode: '',
    matchedStockItemId: '',
    itemName: '',
    itemUnit: '',
    selectedUom: '',
    uomRatio: 1,
    uomConfigurations: [],
    quantity: '',
    cameraOpen: false,
    cameraStatus: 'Starting camera...',
    cameraItems: [],
    ...seed
  };
}

function escapeStockTakeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getLoadedStockTakeCameraItems(scanCount = createEmptyStockTakeScanCountDraft()) {
  return (scanCount.cameraItems || [])
    .map((item) => ({
      ...item,
      quantity: getStockTakeCameraItemBaseQuantity(item),
      uomCounts: getStockTakeCameraItemUomCounts(item)
    }))
    .filter((item) => Number(item.quantity || 0) > 0);
}

function renderStockTakeCameraItemsMarkup(scanCount = createEmptyStockTakeScanCountDraft()) {
  const items = getLoadedStockTakeCameraItems(scanCount);
  if (!items.length) {
    return `<div class="stockTakeEmptyState stockTakeEmptyState--camera" data-stocktake-camera-status>${escapeStockTakeHtml(scanCount.cameraStatus || 'Point the camera at a barcode to begin.')}</div>`;
  }
  return items.map((item) => {
    const unit = String(item.unit || 'ea').toUpperCase();
    const uomCounts = getStockTakeCameraItemUomCounts(item);
    const totalQuantity = getStockTakeCameraItemBaseQuantity(item);
    return `
      <div class="stockTakeCameraItem stockTakeCameraItem--uom">
        <div class="stockTakeCameraItemMeta">
          <strong>${escapeStockTakeHtml(item.stockItemName || '')}</strong>
          <span>${escapeStockTakeHtml(`${uomCounts.length} UOM count${uomCounts.length === 1 ? '' : 's'}`)}</span>
        </div>
        <div class="stockTakeCameraUomRows">
          ${uomCounts.map((row) => {
            const controlKey = `${item.stockItemId}::uom::${row.key}`;
            return `
              <div class="stockTakeCameraUomRow">
                <span>${escapeStockTakeHtml(row.uomName || unit)}</span>
                <strong>${escapeStockTakeHtml(formatStockTakeNumber(row.count || 0))}</strong>
                <em>${escapeStockTakeHtml(`${formatStockTakeNumber((Number(row.count || 0) || 0) * (Number(row.ratio || 1) || 1))} ${unit}`)}</em>
                <div class="stockTakeCameraItemControls">
                  <button type="button" data-stocktake-scan-camera-minus="${escapeStockTakeHtml(controlKey)}">-</button>
                  <button type="button" data-stocktake-scan-camera-plus="${escapeStockTakeHtml(controlKey)}">+</button>
                </div>
              </div>
            `;
          }).join('')}
          <div class="stockTakeCameraUomTotal">
            <span>Total ${escapeStockTakeHtml(item.stockItemName || 'item')}</span>
            <strong>${escapeStockTakeHtml(formatStockTakeNumber(totalQuantity))} ${escapeStockTakeHtml(unit)}</strong>
          </div>
        </div>
        <button type="button" class="stockTakeCameraRemove" data-stocktake-scan-camera-remove="${escapeStockTakeHtml(item.stockItemId)}" aria-label="Remove item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>
          </svg>
        </button>
      </div>
    `;
  }).join('');
}

function patchStockTakeCameraDom() {
  const scanCount = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  const loadedItems = getLoadedStockTakeCameraItems(scanCount);
  const totalQuantity = loadedItems.reduce((sum, item) => sum + (Number(item.quantity || 0) || 0), 0);
  const countNode = document.querySelector('[data-stocktake-camera-count]');
  const listNode = document.querySelector('[data-stocktake-camera-list]');
  const statusNode = document.querySelector('[data-stocktake-camera-status]');
  const bulkLoadedNode = document.querySelector('[data-stocktake-bulk-loaded]');
  const bulkTotalNode = document.querySelector('[data-stocktake-bulk-total]');
  const bulkFinaliseButton = document.querySelector('[data-stocktake-bulk-finalise]');
  const bulkClearButton = document.querySelector('[data-stocktake-scan-camera-clear]');
  const barcodeNode = document.querySelector('[data-stocktake-scan-count-barcode]');
  const matchNode = document.querySelector('[data-stocktake-scan-match-card]');
  if (countNode) {
    countNode.textContent = `Scanned Items: ${loadedItems.length}`;
  }
  if (listNode) {
    listNode.innerHTML = renderStockTakeCameraItemsMarkup(scanCount);
  }
  if (bulkLoadedNode) {
    bulkLoadedNode.textContent = formatStockTakeNumber(loadedItems.length);
  }
  if (bulkTotalNode) {
    bulkTotalNode.textContent = formatStockTakeNumber(totalQuantity);
  }
  if (bulkFinaliseButton) {
    bulkFinaliseButton.toggleAttribute('disabled', !loadedItems.length);
  }
  if (bulkClearButton) {
    bulkClearButton.toggleAttribute('disabled', !loadedItems.length);
  }
  if (statusNode) {
    statusNode.textContent = scanCount.cameraStatus || 'Point the camera at a barcode.';
  }
  if (barcodeNode && barcodeNode.value !== scanCount.barcode) {
    barcodeNode.value = scanCount.barcode || '';
  }
  if (matchNode) {
    const scanSummary = getStockTakeScanUomSummaryForState(scanCount);
    matchNode.innerHTML = scanCount.matchedStockItemId
      ? `<strong>${escapeStockTakeHtml(scanCount.itemName || 'Matched item')}</strong><span>${escapeStockTakeHtml(scanSummary)}</span>`
      : '<span>No item matched yet.</span>';
  }
}

function getStockTakeScanUomSummaryForState(scanCount = {}) {
  const selection = getLineUomSelection({ ...scanCount, unit: scanCount.itemUnit || scanCount.unit || 'ea' }, scanCount.selectedUom || scanCount.itemUnit || 'ea');
  return selection.ratio > 1
    ? `${selection.selectedUom} = ${selection.ratio} ${selection.baseUom || scanCount.itemUnit || 'ea'}`
    : `${scanCount.itemUnit || 'ea'} base`;
}

function updateStockTakeScanCountDraft(updates = {}) {
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: {
      ...current,
      ...updates
    }
  };
  renderApp();
}

function updateStockTakeLocation(locationId) {
  const locationName = getLocationNameById(appState.stockTake.locations || [], locationId, 'Main Store');
  const siteId = getStockTakeSiteIdForLocation(locationId);
  appState.stockTake = {
    ...appState.stockTake,
    draftSession: {
      ...hydrateStockTakeDraft(appState.stockTake.draftSession, appState.stockTake.locations || []),
      siteId,
      siteName: getStockTakeSiteName(siteId),
      locationId,
      locationName,
      items: []
    }
  };
  renderApp();
}

function getStockTakeScopedItems() {
  const draft = hydrateStockTakeDraft(appState.stockTake.draftSession, appState.stockTake.locations || []);
  const scope = String(draft.templateScope || '').trim();
  const selections = new Set((draft.templateSelections || []).map(String));
  return (appState.stockTake.stockItems || []).filter(isStockTakeCountableItem).filter((item) => {
    if (draft.sessionMode === 'template' && scope === 'category' && selections.size) {
      return selections.has(String(item.category || '').trim());
    }
    if (draft.sessionMode === 'template' && scope === 'items' && selections.size) {
      return selections.has(String(item.id || '').trim());
    }
    return true;
  });
}

function getStockTakeTemplateItems(template, stockItems = []) {
  if (!template) return [];
  const scope = String(template.scope || '').trim() === 'items' ? 'items' : 'category';
  const selections = new Set((template.selections || []).map(String));
  return (stockItems || [])
    .filter(isStockTakeCountableItem)
    .filter((item) => {
      if (!selections.size) return true;
      if (scope === 'items') return selections.has(String(item.id || ''));
      return selections.has(String(item.category || '').trim());
    })
    .slice()
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function isStockTakeCountableItem(item = {}) {
  return isStockCountableItem(item);
}

function getStockTakeTemplateLocationIds(template = {}) {
  if (!template) return [];
  const values = [
    template.targetLocation,
    ...(Array.isArray(template.targetLocations)
      ? template.targetLocations
      : (template.targetLocations && typeof template.targetLocations === 'object'
        ? Object.values(template.targetLocations)
        : []))
  ];
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function getAvailableStockTakeTemplateLocationIds(template = {}) {
  const activeLocationIds = new Set((appState.stockTake.locations || []).map((location) => String(location.id || '').trim()).filter(Boolean));
  return getStockTakeTemplateLocationIds(template).filter((locationId) => activeLocationIds.has(String(locationId)));
}

function getStockTakeSiteById(siteId = '') {
  return (appState.stockTake.sites || []).find((site) => String(site.id) === String(siteId)) || null;
}

function getStockTakeLocationById(locationId = '') {
  return (appState.stockTake.locations || []).find((location) => String(location.id) === String(locationId)) || null;
}

function getStockTakeSiteIdForLocation(locationId = '') {
  return String(getStockTakeLocationById(locationId)?.siteId || '');
}

function getDefaultStockTakeSiteId() {
  const defaultLocation = getDefaultLocation(appState.stockTake.locations || []);
  const defaultLocationSiteId = getStockTakeSiteIdForLocation(defaultLocation?.id || defaultLocation?.locationId || '');
  const firstLocationSiteId = getStockTakeSiteIdForLocation(appState.stockTake.locations?.[0]?.id || '');
  return String(
    defaultLocationSiteId
    || firstLocationSiteId
    || (appState.stockTake.sites || []).find((site) => site.isDefault)?.id
    || appState.stockTake.sites?.[0]?.id
    || ''
  );
}

function getStockTakeLocationsForSite(siteId = '') {
  return (appState.stockTake.locations || []).filter((location) => !siteId || String(location.siteId || '') === String(siteId));
}

function getFirstStockTakeLocationIdForSite(siteId = '', allowedLocationIds = null) {
  const allowed = allowedLocationIds ? new Set(allowedLocationIds.map(String)) : null;
  const locations = getStockTakeLocationsForSite(siteId).filter((entry) => !allowed || allowed.has(String(entry.id)));
  const location = getDefaultLocation(locations) || locations[0];
  return String(location?.id || '');
}

function getStockTakeTemplateSiteId(template = {}) {
  return String(template?.siteId || getStockTakeSiteIdForLocation(getStockTakeTemplateLocationIds(template)[0] || '') || getDefaultStockTakeSiteId());
}

function getStockTakeSiteName(siteId = '') {
  return getStockTakeSiteById(siteId)?.name || '';
}

function formatStockTakeNumber(value) {
  const amount = Number(value || 0) || 0;
  return amount.toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function findStockTakeBarcodeMatch(barcode = '') {
  const query = String(barcode || '').trim().toLowerCase();
  if (!query) return null;
  for (const item of getStockTakeScopedItems()) {
    const uomConfig = findStockItemUomConfigByBarcode(item, query);
    if (uomConfig) {
      return { item, uomConfig };
    }
    if (
      String(item.name || '').toLowerCase().includes(query) ||
      String(item.id || '').toLowerCase() === query ||
      matchesBarcodeQuery(item.barcodes || item.barcode || '', query)
    ) {
      return { item, uomConfig: null };
    }
  }
  return null;
}

function findStockTakeItemByBarcode(barcode = '') {
  return findStockTakeBarcodeMatch(barcode)?.item || null;
}

function getMatchedStockTakeScanItem() {
  const scanCount = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  return (appState.stockTake.stockItems || []).find((item) => String(item.id) === String(scanCount.matchedStockItemId || '')) || null;
}

function syncStockTakeScanCountMatch(barcode = '') {
  const query = String(barcode || '').trim();
  const match = query ? findStockTakeBarcodeMatch(query) : null;
  const item = match?.item || null;
  const selection = item
    ? (match.uomConfig ? getLineUomSelection(item, match.uomConfig.customUom) : getLineUomSelection(item, item.unit || 'ea'))
    : null;
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  const nextQuantity = item && String(current.matchedStockItemId || '') !== String(item.id) ? '' : current.quantity;
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: {
      ...current,
      barcode: query,
      matchedStockItemId: item?.id || '',
      itemName: item?.name || '',
      itemUnit: item?.unit || '',
      selectedUom: selection?.selectedUom || item?.unit || '',
      uomRatio: selection?.ratio || 1,
      uomConfigurations: normalizeLineUomConfigurations(item?.uomConfigurations || item?.uomConfig || item?.uomConversions),
      quantity: nextQuantity
    }
  };
  renderApp();
}

function openStockTakeScanCountModal() {
  appState.stockTake = {
    ...appState.stockTake,
    actionError: '',
    scanCount: createEmptyStockTakeScanCountDraft(),
    filters: {
      ...appState.stockTake.filters,
      overlay: 'scan-count',
      openDropdown: ''
    }
  };
  renderApp();
}

function updateStockTakeScanCountBarcode(value = '') {
  syncStockTakeScanCountMatch(value);
}

function updateStockTakeScanCountQuantity(value = '') {
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: {
      ...current,
      quantity: String(value ?? '')
    }
  };
  renderApp();
}

function updateStockTakeScanCountUom(value = '') {
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  const matched = getMatchedStockTakeScanItem();
  const selection = getLineUomSelection(matched || current, value);
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: {
      ...current,
      selectedUom: selection.selectedUom,
      uomRatio: selection.ratio
    }
  };
  renderApp();
}

function confirmStockTakeScanCountEntry() {
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  const matched = getMatchedStockTakeScanItem();
  if (!matched) {
    showStockTakeToast('Scan or enter a barcode that matches a stock item.', 'warning');
    return;
  }
  const quantity = Number(String(current.quantity || '').replace(',', '.'));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    showStockTakeToast('Enter a counted quantity greater than zero.', 'warning');
    return;
  }
  const selection = getLineUomSelection(matched, current.selectedUom || matched.unit || 'ea');
  const ratio = Number(selection.ratio || current.uomRatio || 1);
  const baseQuantity = quantity * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
  const countBreakdown = [{
    key: getStockTakeCameraUomKey(selection.selectedUom || matched.unit || 'ea', ratio),
    uomName: selection.selectedUom || matched.unit || 'ea',
    baseUom: selection.baseUom || matched.unit || 'ea',
    ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
    count: quantity,
    scans: quantity,
    lastBarcode: current.barcode || ''
  }];
  incrementStockTakeCountWithOptions(matched.id, baseQuantity, {
    focusField: true,
    setQuery: false,
    selectedUom: selection.selectedUom || matched.unit || 'ea',
    uomCounts: countBreakdown,
    scanBreakdown: countBreakdown
  });
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: createEmptyStockTakeScanCountDraft()
  };
  renderApp();
}

function closeStockTakeScanCountModal() {
  stopStockTakeCameraScanner();
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: createEmptyStockTakeScanCountDraft(),
    filters: {
      ...appState.stockTake.filters,
      overlay: '',
      openDropdown: ''
    }
  };
  renderApp();
}

let stockTakeCameraStopper = null;
let stockTakeRejectedBarcode = { code: '', at: 0 };

function shouldSurfaceStockTakeBarcodeWarning(barcode = '') {
  const code = String(barcode || '').trim().toLowerCase();
  if (!code) return false;
  if (stockTakeRejectedBarcode.code === code) {
    return false;
  }
  stockTakeRejectedBarcode = { code, at: Date.now() };
  return true;
}

function addStockTakeCameraItemFromMatch(stockItem = {}, selection = {}, barcode = '') {
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  const ratio = Number(selection.ratio || 1);
  const baseIncrement = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const selectedUom = String(selection.selectedUom || selection.baseUom || stockItem.unit || 'ea').trim() || 'ea';
  const baseUom = String(selection.baseUom || stockItem.unit || 'ea').trim() || 'ea';
  const uomKey = getStockTakeCameraUomKey(selectedUom, baseIncrement);
  const existing = (current.cameraItems || []).find((item) => String(item.stockItemId) === String(stockItem.id));
  const nextItems = existing
    ? (current.cameraItems || []).map((item) => {
      if (String(item.stockItemId) !== String(stockItem.id)) return item;
      const uomCounts = incrementStockTakeCameraUomCounts(item.uomCounts, {
        key: uomKey,
        uomName: selectedUom,
        baseUom,
        ratio: baseIncrement,
        barcode
      });
      const quantity = getStockTakeCameraItemBaseQuantity({ ...item, uomCounts });
      return {
        ...item,
        unit: baseUom,
        quantity,
        scans: (Number(item.scans || 0) || 0) + 1,
        selectedUom,
        ratio: baseIncrement,
        uomCounts,
        lastBarcode: String(barcode || '')
      };
    })
    : [
        ...(current.cameraItems || []),
        (() => {
          const uomCounts = incrementStockTakeCameraUomCounts([], {
            key: uomKey,
            uomName: selectedUom,
            baseUom,
            ratio: baseIncrement,
            barcode
          });
          return {
          stockItemId: String(stockItem.id),
          stockItemName: stockItem.name || '',
          unit: baseUom,
          quantity: getStockTakeCameraItemBaseQuantity({ uomCounts }),
          scans: 1,
          selectedUom,
          ratio: baseIncrement,
          uomCounts,
          lastBarcode: String(barcode || '')
          };
        })()
      ];
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: {
      ...current,
      barcode: String(barcode || ''),
      matchedStockItemId: String(stockItem.id),
      itemName: stockItem.name || '',
      itemUnit: stockItem.unit || 'ea',
      selectedUom,
      uomRatio: baseIncrement,
      uomConfigurations: normalizeLineUomConfigurations(stockItem.uomConfigurations || stockItem.uomConfig || stockItem.uomConversions),
      cameraItems: nextItems,
      cameraStatus: `Added ${stockItem.name || 'stock item'}: 1 ${selectedUom}.`
    }
  };
  patchStockTakeCameraDom();
}

function getStockTakeCameraUomKey(uomName = 'ea', ratio = 1) {
  return `${String(uomName || 'ea').trim().toLowerCase()}::${Number(ratio || 1) || 1}`;
}

function incrementStockTakeCameraUomCounts(existingCounts = [], uom = {}) {
  const key = String(uom.key || getStockTakeCameraUomKey(uom.uomName, uom.ratio));
  const rows = Array.isArray(existingCounts) ? existingCounts : [];
  const match = rows.find((row) => String(row.key || getStockTakeCameraUomKey(row.uomName, row.ratio)) === key);
  if (match) {
    return rows.map((row) => String(row.key || getStockTakeCameraUomKey(row.uomName, row.ratio)) === key
      ? {
          ...row,
          key,
          uomName: uom.uomName || row.uomName || row.selectedUom || row.unit || 'ea',
          baseUom: uom.baseUom || row.baseUom || row.unit || 'ea',
          ratio: Number(uom.ratio || row.ratio || 1) || 1,
          count: (Number(row.count || 0) || 0) + 1,
          scans: (Number(row.scans || 0) || 0) + 1,
          lastBarcode: String(uom.barcode || row.lastBarcode || '')
        }
      : row);
  }
  return [
    ...rows,
    {
      key,
      uomName: uom.uomName || 'ea',
      baseUom: uom.baseUom || 'ea',
      ratio: Number(uom.ratio || 1) || 1,
      count: 1,
      scans: 1,
      lastBarcode: String(uom.barcode || '')
    }
  ];
}

function getStockTakeCameraItemUomCounts(item = {}) {
  const rows = Array.isArray(item.uomCounts) && item.uomCounts.length
    ? item.uomCounts
    : [{
        key: getStockTakeCameraUomKey(item.selectedUom || item.unit || 'ea', item.ratio || 1),
        uomName: item.selectedUom || item.unit || 'ea',
        baseUom: item.unit || 'ea',
        ratio: Number(item.ratio || 1) || 1,
        count: Number(item.scans || item.quantity || 0) || 0,
        scans: Number(item.scans || 0) || 0
      }];
  return rows
    .map((row) => ({
      ...row,
      key: String(row.key || getStockTakeCameraUomKey(row.uomName, row.ratio)),
      uomName: row.uomName || row.selectedUom || row.unit || 'ea',
      baseUom: row.baseUom || item.unit || 'ea',
      ratio: Number(row.ratio || 1) || 1,
      count: Number(row.count || 0) || 0
    }))
    .filter((row) => row.count > 0);
}

function getStockTakeCameraItemBaseQuantity(item = {}) {
  return getStockTakeCameraItemUomCounts(item)
    .reduce((sum, row) => sum + ((Number(row.count || 0) || 0) * (Number(row.ratio || 1) || 1)), 0);
}

async function initStockTakeCameraScanner() {
  const scanCount = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  const overlay = appState.stockTake.filters?.overlay || '';
  if (!['scan-count', 'bulk-scan'].includes(overlay) || !scanCount.cameraOpen || stockTakeCameraStopper) return;
  try {
    const { mountBarcodeScanner } = await import('./services/barcodeScanner.js');
    const stopper = await mountBarcodeScanner({
      elementId: 'stocktake-camera-reader',
      continuous: true,
      continuousIntervalMs: 1000,
      useQrbox: false,
      onStatus: (message) => {
        const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
        if (
          stockTakeRejectedBarcode.code
          && String(current.cameraStatus || '').toLowerCase().includes('not part of this stock take')
          && !(current.cameraItems || []).length
        ) {
          return;
        }
        appState.stockTake = {
          ...appState.stockTake,
          scanCount: {
            ...current,
            cameraStatus: message
          }
        };
        if (!(current.cameraItems || []).length) {
          const statusNode = document.querySelector('[data-stocktake-camera-status]');
          if (statusNode) statusNode.textContent = message;
        }
      },
      onScan: (code) => {
        const barcodeMatch = findStockTakeBarcodeMatch(code);
        const stockItem = barcodeMatch?.item || null;
        if (!stockItem) {
          if (!shouldSurfaceStockTakeBarcodeWarning(code)) return false;
          const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
          appState.stockTake = {
            ...appState.stockTake,
            scanCount: {
              ...current,
              cameraStatus: 'That barcode is not part of this stock take.'
            }
          };
          patchStockTakeCameraDom();
          showStockTakeToast(`Barcode ${code} is not part of this stock take.`, 'warning');
          return { beep: true };
        }
        stockTakeRejectedBarcode = { code: '', at: 0 };
        const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
        const selection = barcodeMatch?.uomConfig
          ? getLineUomSelection(stockItem, barcodeMatch.uomConfig.customUom)
          : getLineUomSelection(stockItem, stockItem.unit || 'ea');
        if (appState.stockTake.filters?.overlay === 'bulk-scan') {
          addStockTakeCameraItemFromMatch(stockItem, selection, code);
          return { beep: true };
        }
        appState.stockTake = {
          ...appState.stockTake,
          scanCount: {
            ...current,
            matchedStockItemId: String(stockItem.id),
            itemName: stockItem.name || '',
            itemUnit: stockItem.unit || 'ea',
            selectedUom: selection.selectedUom,
            uomRatio: selection.ratio,
            uomConfigurations: normalizeLineUomConfigurations(stockItem.uomConfigurations || stockItem.uomConfig || stockItem.uomConversions),
            barcode: String(code || ''),
            cameraStatus: `Matched ${stockItem.name}. Enter quantity, then add/update.`
          }
        };
        patchStockTakeCameraDom();
        document.querySelector('[data-stocktake-scan-count-qty]')?.focus({ preventScroll: true });
        return { beep: true };
      },
      onError: (error) => {
        const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
        appState.stockTake = {
          ...appState.stockTake,
          scanCount: {
            ...current,
            cameraStatus: 'Camera unavailable. Use a scanner or type the barcode.'
          }
        };
        patchStockTakeCameraDom();
        console.warn('[StockTake camera] init failed:', error);
      }
    });
    if (typeof stopper !== 'function') {
      stockTakeCameraStopper = null;
      const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
      appState.stockTake = {
        ...appState.stockTake,
        scanCount: {
          ...current,
          cameraStatus: 'Camera unavailable. Check browser permission, or type the barcode.'
        }
      };
      patchStockTakeCameraDom();
      return;
    }
    stockTakeCameraStopper = stopper;
  } catch (error) {
    stockTakeCameraStopper = null;
    console.warn('[StockTake camera] mount failed:', error);
  }
}

async function stopStockTakeCameraScanner() {
  if (!stockTakeCameraStopper) return;
  const stop = stockTakeCameraStopper;
  stockTakeCameraStopper = null;
  await stop().catch(() => {});
}

function openStockTakeScanCameraModal() {
  stockTakeRejectedBarcode = { code: '', at: 0 };
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: {
      ...current,
      cameraOpen: true,
      cameraStatus: 'Starting camera...'
    }
  };
  renderApp();
}

function closeStockTakeScanCameraModal() {
  stopStockTakeCameraScanner();
  stockTakeRejectedBarcode = { code: '', at: 0 };
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: {
      ...current,
      cameraOpen: false,
      cameraStatus: 'Starting camera...'
    }
  };
  renderApp();
}

function adjustStockTakeCameraItemQuantity(stockItemId, delta = 0) {
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  const [rawStockItemId, rawUomKey = ''] = String(stockItemId || '').split('::uom::');
  const targetStockItemId = rawStockItemId || stockItemId;
  const targetUomKey = rawUomKey || '';
  const nextItems = (current.cameraItems || [])
    .map((item) => {
      if (String(item.stockItemId) !== String(targetStockItemId)) return item;
      const uomCounts = getStockTakeCameraItemUomCounts(item)
        .map((row) => {
          if (targetUomKey && String(row.key) !== String(targetUomKey)) return row;
          return {
            ...row,
            count: Math.max(0, (Number(row.count || 0) || 0) + Number(delta || 0))
          };
        })
        .filter((row) => Number(row.count || 0) > 0);
      return {
        ...item,
        uomCounts,
        quantity: getStockTakeCameraItemBaseQuantity({ ...item, uomCounts }),
        scans: uomCounts.reduce((sum, row) => sum + (Number(row.count || 0) || 0), 0)
      };
    })
    .filter((item) => Number(item.quantity || 0) > 0);
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: {
      ...current,
      cameraItems: nextItems
    }
  };
  patchStockTakeCameraDom();
}

function removeStockTakeCameraItem(stockItemId) {
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: {
      ...current,
      cameraItems: (current.cameraItems || []).filter((item) => String(item.stockItemId) !== String(stockItemId))
    }
  };
  patchStockTakeCameraDom();
}

function clearStockTakeCameraItems() {
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: {
      ...current,
      cameraItems: []
    }
  };
  patchStockTakeCameraDom();
}

function applyStockTakeCameraItems() {
  const current = appState.stockTake.scanCount || createEmptyStockTakeScanCountDraft();
  if (!(current.cameraItems || []).length) {
    showStockTakeToast('Scan at least one item first.', 'warning');
    return;
  }
  (current.cameraItems || []).forEach((item) => {
    const quantity = getStockTakeCameraItemBaseQuantity(item);
    if (quantity > 0) {
      incrementStockTakeCountWithOptions(item.stockItemId, quantity, {
        focusField: false,
        setQuery: false,
        render: false,
        uomCounts: getStockTakeCameraItemUomCounts(item),
        scanBreakdown: getStockTakeCameraItemUomCounts(item),
        selectedUom: item.selectedUom || item.unit || 'ea'
      });
    }
  });
  void stopStockTakeCameraScanner();
  appState.stockTake = {
    ...appState.stockTake,
    scanCount: createEmptyStockTakeScanCountDraft(),
    filters: {
      ...appState.stockTake.filters,
      overlay: '',
      openDropdown: '',
      query: ''
    }
  };
  renderApp();
  showStockTakeToast(
    `${(current.cameraItems || []).length} scanned ${(current.cameraItems || []).length === 1 ? 'item' : 'items'} added to this count session.`,
    'success'
  );
}

function focusStockTakeCountField(stockItemId) {
  if (!stockItemId) return;
  pendingFocusField = {
    selector: `[data-stocktake-count="${String(stockItemId).replaceAll('"', '\\"')}"]`,
    scrollIntoView: true
  };
}

function incrementStockTakeCount(stockItemId, incrementBy = 1) {
  return incrementStockTakeCountWithOptions(stockItemId, incrementBy);
}

function incrementStockTakeCountWithOptions(stockItemId, incrementBy = 1, options = {}) {
  const { focusField = true, setQuery = true, render = true } = options;
  const draft = hydrateStockTakeDraft(appState.stockTake.draftSession, appState.stockTake.locations || []);
  const items = [...(draft.items || [])];
  const index = items.findIndex((item) => String(item.stockItemId) === String(stockItemId));
  const stockItem = (appState.stockTake.stockItems || []).find((item) => String(item.id) === String(stockItemId));
  if (!stockItem) return false;
  const systemStock = getLocationStock(stockItem, draft.locationId);
  const currentShelfCount = index >= 0 ? Number(items[index].shelfCount || 0) || 0 : 0;
  const nextShelfCount = currentShelfCount + Math.max(Number(incrementBy || 0), 0);
  const variance = nextShelfCount - systemStock;
  const nextEntry = {
    ...(index >= 0 ? items[index] : {}),
    stockItemId: String(stockItem.id),
    stockItemName: stockItem.name || '',
    unit: stockItem.unit || 'ea',
    shelfCount: nextShelfCount,
    systemStock,
    variance,
    varianceImpactEx: variance * (Number(stockItem.cost || 0) || 0),
    selectedUom: options.selectedUom || (index >= 0 ? items[index].selectedUom : '') || stockItem.unit || 'ea',
    uomCounts: mergeStockTakeUomCounts(index >= 0 ? items[index].uomCounts : [], options.uomCounts || options.scanBreakdown || []),
    scanBreakdown: mergeStockTakeUomCounts(index >= 0 ? items[index].scanBreakdown : [], options.scanBreakdown || options.uomCounts || [])
  };

  if (index >= 0) items[index] = nextEntry;
  else items.push(nextEntry);

  appState.stockTake = {
    ...appState.stockTake,
    draftSession: {
      ...draft,
      items
    },
    filters: {
      ...appState.stockTake.filters,
      query: setQuery ? (stockItem.name || String(stockItemId)) : (appState.stockTake.filters?.query || '')
    }
  };
  if (focusField) {
    focusStockTakeCountField(stockItemId);
  }
  if (render) {
    renderApp();
  }
  return true;
}

function mergeStockTakeUomCounts(existingCounts = [], incomingCounts = []) {
  const rows = new Map();
  const normalize = (row = {}) => {
    const ratio = Number(row.ratio || 1) || 1;
    const uomName = String(row.uomName || row.selectedUom || row.unit || 'ea').trim() || 'ea';
    const key = String(row.key || getStockTakeCameraUomKey(uomName, ratio));
    return {
      key,
      uomName,
      baseUom: String(row.baseUom || row.unit || 'ea').trim() || 'ea',
      ratio,
      count: Number(row.count || 0) || 0,
      scans: Number(row.scans ?? row.count ?? 0) || 0,
      lastBarcode: String(row.lastBarcode || row.barcode || '')
    };
  };
  [...(Array.isArray(existingCounts) ? existingCounts : []), ...(Array.isArray(incomingCounts) ? incomingCounts : [])]
    .map(normalize)
    .filter((row) => row.count > 0)
    .forEach((row) => {
      const existing = rows.get(row.key);
      if (!existing) {
        rows.set(row.key, row);
        return;
      }
      rows.set(row.key, {
        ...existing,
        count: existing.count + row.count,
        scans: existing.scans + row.scans,
        lastBarcode: row.lastBarcode || existing.lastBarcode
      });
    });
  return [...rows.values()];
}

async function scanStockTakeBarcode(mode = 'focus') {
  try {
    const { openBarcodeScanner } = await import('./services/barcodeScanner.js');
    const continuous = mode === 'count';
    await openBarcodeScanner({
      title: continuous ? 'Quick Scan Count' : 'Scan Stock Item',
      helper: continuous
        ? 'Keep a barcode in frame to add +1 every second.'
        : 'Scan once to jump to the counted item and enter a quantity.',
      continuous,
      continuousIntervalMs: 1000,
      onScan: (code) => {
        const barcode = String(code || '').trim();
        const barcodeMatch = findStockTakeBarcodeMatch(barcode);
        const stockItem = barcodeMatch?.item || null;
        if (!stockItem) {
          if (shouldSurfaceStockTakeBarcodeWarning(barcode)) {
            showStockTakeToast(`Barcode ${barcode} is not part of this stock take.`, 'warning');
          }
          return;
        }

        if (mode === 'count') {
          const selection = barcodeMatch?.uomConfig
            ? getLineUomSelection(stockItem, barcodeMatch.uomConfig.customUom)
            : getLineUomSelection(stockItem, stockItem.unit || 'ea');
          const ratio = Number(selection.ratio || 1);
          const incrementBy = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
          const countBreakdown = [{
            key: getStockTakeCameraUomKey(selection.selectedUom || stockItem.unit || 'ea', incrementBy),
            uomName: selection.selectedUom || stockItem.unit || 'ea',
            baseUom: selection.baseUom || stockItem.unit || 'ea',
            ratio: incrementBy,
            count: 1,
            scans: 1,
            lastBarcode: barcode
          }];
          incrementStockTakeCountWithOptions(stockItem.id, incrementBy, {
            focusField: false,
            setQuery: false,
            selectedUom: selection.selectedUom || stockItem.unit || 'ea',
            uomCounts: countBreakdown,
            scanBreakdown: countBreakdown
          });
          showStockTakeToast(`${stockItem.name || 'Stock item'} counted +${formatStockTakeNumber(incrementBy)} ${selection.baseUom || stockItem.unit || 'ea'}.`, 'success');
          return;
        }

        appState.stockTake = {
          ...appState.stockTake,
          filters: {
            ...appState.stockTake.filters,
            query: barcode
          }
        };
        focusStockTakeCountField(stockItem.id);
        renderApp();
        showStockTakeToast(`Barcode ${barcode} ready for manual count entry.`, 'success');
      }
    });
  } catch (error) {
    showStockTakeToast(error.message || 'Could not start the stock take scanner.', 'error');
  }
}

function restoreSpecificStockTakeDraft(draftId = '') {
  const savedDraft = (appState.stockTake.savedDrafts || []).find((entry) => String(entry.id) === String(draftId));
  if (!savedDraft) {
    showStockTakeToast('That saved stock take draft is no longer available.', 'warning');
    return;
  }

  appState.stockTake = {
    ...appState.stockTake,
    sessionActive: true,
    actionError: '',
    draftSession: hydrateStockTakeDraft(savedDraft, appState.stockTake.locations || []),
    filters: {
      ...appState.stockTake.filters,
      overlay: '',
      openDropdown: '',
      query: ''
    }
  };
  renderApp();
  showStockTakeToast('Draft restored.', 'success');
}

async function discardSpecificStockTakeDraft(draftId = '') {
  const normalizedDraftId = String(draftId || '').trim();
  if (!normalizedDraftId) return;

  try {
    const { deleteStockTakeDraftSession } = await import('./services/stockTakeService.js');
    await deleteStockTakeDraftSession(
      appState.workspace?.id,
      appState.user?.uid || appState.user?.id || '',
      normalizedDraftId
    );

    const remainingDrafts = (appState.stockTake.savedDrafts || []).filter((entry) => String(entry.id) !== normalizedDraftId);
    appState.stockTake = {
      ...appState.stockTake,
      savedDrafts: remainingDrafts,
      filters: {
        ...appState.stockTake.filters,
        overlay: '',
        openDropdown: ''
      }
    };
    renderApp();
    showStockTakeToast('Draft discarded.', 'success');
    refreshActiveTabFromApi().catch(() => {});
  } catch (error) {
    showStockTakeToast(error.message || 'Could not discard that stock take draft.', 'error');
  }
}

async function saveStockTakeSessionDraft() {
  // A count field can remain the active element after a button click in Safari. renderApp()
  // deliberately skips DOM replacement while a text input is focused, which made a successful
  // draft save look permanently stuck and also hid any API error. Release both live and queued
  // focus before starting, and guard against rapid duplicate submissions.
  if (appState.stockTake.actionStatus === 'saving-draft') return;
  pendingFocusField = null;
  if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  const hydratedDraft = hydrateStockTakeDraft(appState.stockTake.draftSession, appState.stockTake.locations || []);
  const draft = {
    ...hydratedDraft,
    // Keep one stable id across retries so a response timeout cannot create duplicate drafts.
    id: String(hydratedDraft.id || makeStableSubmitId('std'))
  };

  if (!draft.locationId) {
    const message = 'Choose a stock take location before saving a draft.';
    appState.stockTake = { ...appState.stockTake, actionError: message };
    renderApp();
    showStockTakeToast(message, 'error');
    return;
  }

  try {
    appState.stockTake = {
      ...appState.stockTake,
      draftSession: draft,
      actionStatus: 'saving-draft',
      actionError: '',
      filters: {
        ...appState.stockTake.filters,
        openDropdown: ''
      }
    };
    renderApp();

    const { saveStockTakeDraftSession } = await import('./services/stockTakeService.js');
    const savedDraft = await saveStockTakeDraftSession(
      appState.workspace?.id,
      appState.user?.uid || appState.user?.id || '',
      draft
    );
    const nextSavedDrafts = [
      savedDraft,
      ...(appState.stockTake.savedDrafts || []).filter((entry) => String(entry.id) !== String(savedDraft.id))
    ].sort((left, right) => String(right.savedAt || '').localeCompare(String(left.savedAt || '')));

    // The user may have clicked back into a field while the request was in flight. Force the
    // completion render so the active session closes and the Active Sessions table updates now.
    pendingFocusField = null;
    if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    appState.stockTake = {
      ...appState.stockTake,
      actionStatus: '',
      actionError: '',
      sessionActive: false,
      savedDrafts: nextSavedDrafts,
      draftSession: hydrateStockTakeDraft(createEmptyStockTakeDraft(), appState.stockTake.locations || []),
      sessionSetup: createEmptyStockTakeSessionSetup(),
      filters: {
        ...appState.stockTake.filters,
        overlay: '',
        openDropdown: '',
        query: ''
      }
    };
    renderApp();
    showStockTakeToast('Draft saved to Active Sessions.', 'success');
    refreshActiveTabFromApi().catch(() => {});
  } catch (error) {
    const message = error?.message || 'Could not save stock take draft.';
    pendingFocusField = null;
    if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    appState.stockTake = {
      ...appState.stockTake,
      actionStatus: '',
      actionError: message
    };
    renderApp();
    showStockTakeToast(message, 'error');
  }
}

async function exportStockTakeTemplatePdf(templateId, selectedLocationId = '') {
  const template = (appState.stockTake.templates || []).find((entry) => String(entry.id) === String(templateId));
  if (!template) {
    showStockTakeToast('Template could not be found.', 'error');
    return;
  }

  const linkedLocationIds = getStockTakeTemplateLocationIds(template);
  const exportLocationIds = linkedLocationIds.length ? linkedLocationIds : [appState.stockTake.locations?.[0]?.id || 'main'];
  const requestedLocationId = String(selectedLocationId || '').trim();

  if (!requestedLocationId && exportLocationIds.length > 1) {
    openStockTakeTemplateExportLocationPicker(template.id);
    return;
  }

  const locationId = requestedLocationId || exportLocationIds[0] || appState.stockTake.locations?.[0]?.id || 'main';
  if (exportLocationIds.length && !exportLocationIds.map(String).includes(String(locationId))) {
    showStockTakeToast('Choose a location linked to this template first.', 'warning');
    openStockTakeTemplateExportLocationPicker(template.id);
    return;
  }

  const locationName = getLocationNameById(appState.stockTake.locations || [], locationId, 'Main Store');
  const scopedItems = getStockTakeTemplateItems(template, appState.stockTake.stockItems || []);
  const rows = [['Product Name', 'UOM', 'Count', 'UOM', 'Count', 'UOM', 'Count', 'UOM', 'Count']];
  let lastCategory = '';

  scopedItems
    .slice()
    .sort((left, right) => {
      const categoryCompare = String(left.category || '').localeCompare(String(right.category || ''));
      if (categoryCompare !== 0) return categoryCompare;
      return String(left.name || '').localeCompare(String(right.name || ''));
    })
    .forEach((item) => {
      const category = String(item.category || 'General').trim() || 'General';
      if (lastCategory !== category) {
        rows.push([`CATEGORY: ${category}`, '', '', '', '', '', '', '', '']);
        lastCategory = category;
      }
      const uomConfigs = normalizeLineUomConfigurations(item.uomConfigurations || item.uomConfig || item.uomConversions).slice(0, 3);
      const uoms = [
        String(item.unit || item.baseUom || 'ea').toUpperCase(),
        uomConfigs[0]?.customUom || '',
        uomConfigs[1]?.customUom || '',
        uomConfigs[2]?.customUom || ''
      ];
      rows.push([
        item.name || '',
        uoms[0], '',
        uoms[1], '',
        uoms[2], '',
        uoms[3], ''
      ]);
    });

  try {
    await exportAoaRows({
      format: 'pdf',
      filename: buildExportFilename({
        workspaceName: appState.workspace?.siteName || appState.workspace?.name,
        reportType: 'Stock Take Count Sheet',
        suffix: [template.name, locationName].filter(Boolean).join(' - ')
      }),
      sheetName: 'Stock Count Sheet',
      title: 'Stock Count Sheet',
      subtitle: `${template.name || 'Template'} | ${appState.workspace?.siteName || appState.workspace?.name || 'KCP'} | ${locationName} | ${new Date().toLocaleString('en-ZA')}`,
      rows,
      headerRowIndex: 0,
      branding: getPdfBranding(),
      orientation: 'landscape',
      tableOptions: {
        theme: 'grid',
        tableWidth: 'auto',
        horizontalPageBreak: false,
        ruleColor: KCP_PDF_THEME.accent,
        styles: {
          fontSize: 9,
          cellPadding: { top: 8, right: 6, bottom: 8, left: 6 },
          lineWidth: 0.45,
          lineColor: KCP_PDF_THEME.border,
          valign: 'middle',
          minCellHeight: 26,
          textColor: KCP_PDF_THEME.ink,
          overflow: 'linebreak'
        },
        headStyles: {
          fillColor: KCP_PDF_THEME.accentDark,
          textColor: KCP_PDF_THEME.white,
          fontStyle: 'bold',
          lineColor: KCP_PDF_THEME.accentDark,
          minCellHeight: 28
        },
        bodyStyles: { fillColor: KCP_PDF_THEME.white },
        alternateRowStyles: { fillColor: KCP_PDF_THEME.surfaceAlt },
        margin: { left: 28, right: 28 },
        columnStyles: {
          0: { cellWidth: 230, fontStyle: 'bold', halign: 'left' },
          1: { cellWidth: 65, halign: 'center' },
          2: { cellWidth: 70, halign: 'center' },
          3: { cellWidth: 65, halign: 'center' },
          4: { cellWidth: 70, halign: 'center' },
          5: { cellWidth: 65, halign: 'center' },
          6: { cellWidth: 70, halign: 'center' },
          7: { cellWidth: 65, halign: 'center' },
          8: { cellWidth: 70, halign: 'center' }
        },
        didParseCell: (data) => {
          const firstCell = String(data.row.raw?.[0] || '');
          const isCategoryRow = data.section === 'body' && firstCell.startsWith('CATEGORY:');
          if (isCategoryRow) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.fillColor = KCP_PDF_THEME.surfaceStrong;
            data.cell.styles.textColor = KCP_PDF_THEME.navy;
            data.cell.styles.minCellHeight = 24;
            if (data.column.index > 0) data.cell.text = [''];
          }
          if (data.section === 'body' && !isCategoryRow && [2, 4, 6, 8].includes(data.column.index)) {
            data.cell.styles.fillColor = KCP_PDF_THEME.white;
            data.cell.styles.textColor = KCP_PDF_THEME.ink;
            data.cell.styles.lineColor = KCP_PDF_THEME.borderStrong;
            data.cell.styles.minCellHeight = 30;
          }
          if (data.section === 'body' && !isCategoryRow && [1, 3, 5, 7].includes(data.column.index)) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.textColor = KCP_PDF_THEME.navySoft;
            data.cell.styles.fillColor = KCP_PDF_THEME.surface;
          }
        },
        didDrawCell: () => {
          // Keep count cells clean. The grid border provides the writable count area.
        }
      }
    });
    updateStockTakeFilters({ overlay: '', exportTemplateId: '', exportLocationId: '' });
    showStockTakeToast(`${template.name} exported as PDF.`, 'success');
  } catch (error) {
    showStockTakeToast(error.message || 'Could not export the stock take template.', 'error');
  }
}

function openStockTakeTemplateExportLocationPicker(templateId = '') {
  updateStockTakeFilters({
    overlay: 'template-export-location',
    exportTemplateId: String(templateId || ''),
    exportLocationId: '',
    openDropdown: ''
  });
}

function openStockTakeCountTemplateLocationPicker(format = 'xlsx') {
  updateStockTakeFilters({ overlay: 'count-template-location', exportFormat: ['csv', 'xlsx'].includes(String(format || '').toLowerCase()) ? String(format).toLowerCase() : 'xlsx', exportLocationId: '', exportTemplateId: '' });
}

async function exportStockTakeCountTemplate(format = 'csv', locationId = '') {
  const normalizedFormat = ['csv', 'xlsx'].includes(String(format || '').toLowerCase()) ? String(format).toLowerCase() : 'csv';
  const locations = (appState.stockTake.locations || []).length ? appState.stockTake.locations : [{ id: 'main', name: 'Main Store' }];
  if (!String(locationId || '').trim()) {
    openStockTakeCountTemplateLocationPicker(normalizedFormat);
    return;
  }
  const selectedLocation = locations.find((location) => String(location.id) === String(locationId)) || null;
  if (!selectedLocation) {
    showStockTakeToast('Please select a count location first.', 'warning');
    openStockTakeCountTemplateLocationPicker(normalizedFormat);
    return;
  }
  const locationName = selectedLocation.name || selectedLocation.displayName || selectedLocation.locationName || 'Main Store';
  const columns = getStockTakeCountTemplateColumns();
  const rows = [];
  (appState.stockTake.stockItems || []).filter(isStockTakeCountableItem).forEach((item) => {
    rows.push(buildStockTakeCountTemplateRow({
      item,
      location: selectedLocation,
      locations,
      rowNumber: rows.length + 2,
      format: normalizedFormat
    }));
  });

  if (!rows.length) {
    showStockTakeToast('No stock items are available for a count template.', 'warning');
    return;
  }

  try {
    await exportObjectRows({
      format: normalizedFormat,
      filename: buildExportFilename({ workspaceName: appState.workspace?.siteName || appState.workspace?.name, reportType: 'Stock Take Count Template Export', suffix: locationName }),
      sheetName: 'Stock_Take_Import',
      title: `Stock Take Count Template - ${locationName}`,
      subtitle: `Location: ${locationName}. Enter counts only in Base_Count and the custom UOM count columns. Unit columns are labels and should not be edited.`,
      rows,
      columns,
      branding: getPdfBranding()
    });
    updateStockTakeFilters({ overlay: '', exportLocationId: '' });
    showStockTakeToast(`Stock take count template exported as ${normalizedFormat.toUpperCase()}.`, 'success');
  } catch (error) {
    showStockTakeToast(error.message || 'Could not export stock take count template.', 'error');
  }
}

function getStockTakeCountTemplateColumns() {
  return [
    'Item_Name',
    'Location',
    'Category',
    'System',
    'Base_Unit',
    'Base_Count',
    'Custom_UOM_1_Unit',
    'Custom_UOM_1_Count',
    'Custom_UOM_2_Unit',
    'Custom_UOM_2_Count',
    'Custom_UOM_3_Unit',
    'Custom_UOM_3_Count',
    'Variance',
    'Impact_Ex_VAT'
  ];
}

function buildStockTakeCountTemplateRow({ item = {}, location = {}, locations = [], rowNumber = 2, format = 'csv' } = {}) {
  const uomConfigs = normalizeLineUomConfigurations(item.uomConfigurations || item.uomConfig || item.uomConversions).slice(0, 3);
  const systemQty = getLocationStock(item, location.id, locations);
  const ratio1 = Number(uomConfigs[0]?.ratio || 0) > 0 ? Number(uomConfigs[0].ratio) : 0;
  const ratio2 = Number(uomConfigs[1]?.ratio || 0) > 0 ? Number(uomConfigs[1].ratio) : 0;
  const ratio3 = Number(uomConfigs[2]?.ratio || 0) > 0 ? Number(uomConfigs[2].ratio) : 0;
  const unitCost = Number(item.cost || item.unitCost || 0) || 0;
  const varianceFormula = `IFERROR((N(F${rowNumber})+(N(H${rowNumber})*${formatFormulaNumber(ratio1)})+(N(J${rowNumber})*${formatFormulaNumber(ratio2)})+(N(L${rowNumber})*${formatFormulaNumber(ratio3)}))-${formatFormulaNumber(systemQty)},0)`;
  const impactFormula = `IFERROR(M${rowNumber}*${formatFormulaNumber(unitCost)},0)`;
  return {
    Item_Name: item.name || '',
    Location: location.name || location.displayName || 'Main Store',
    Category: item.category || item.inventoryCategory || '',
    System: `${formatStockTakeNumber(systemQty)} ${item.unit || 'ea'}`,
    Base_Unit: item.unit || 'ea',
    Base_Count: '',
    Custom_UOM_1_Unit: uomConfigs[0]?.customUom || '',
    Custom_UOM_1_Count: '',
    Custom_UOM_2_Unit: uomConfigs[1]?.customUom || '',
    Custom_UOM_2_Count: '',
    Custom_UOM_3_Unit: uomConfigs[2]?.customUom || '',
    Custom_UOM_3_Count: '',
    Variance: createStockTakeFormulaValue(format, varianceFormula),
    Impact_Ex_VAT: createStockTakeFormulaValue(format, impactFormula)
  };
}

function formatFormulaNumber(value = 0) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? String(Number(number.toFixed(6))) : '0';
}

function createStockTakeFormulaValue(format = 'csv', formula = '') {
  const safeFormula = String(formula || '').trim().replace(/^=/, '');
  if (!safeFormula) return '';
  return String(format || '').toLowerCase() === 'xlsx'
    ? { formula: safeFormula }
    : `=${safeFormula}`;
}

function formatStockItemUomConfigSummary(item = {}) {
  return normalizeLineUomConfigurations(item.uomConfigurations || item.uomConfig || item.uomConversions)
    .slice(0, 3)
    .map((row) => `${row.customUom} = ${formatStockTakeNumber(row.ratio)} ${row.baseUom || item.unit || 'ea'}`)
    .join('; ');
}

async function importStockTakeCountTemplate(file) {
  if (!file || !appState.workspace?.id) return;
  appState.stockTake = {
    ...appState.stockTake,
    actionStatus: 'importing',
    actionError: ''
  };
  renderApp();

  try {
    const rows = await parseDataFile(file, { preferredSheetNames: ['Stock_Take_Import'] });
    const parsed = parseStockTakeCountRows(rows, {
      stockItems: appState.stockTake.stockItems || [],
      locations: appState.stockTake.locations || []
    });
    if (parsed.errors.length) throw new Error(parsed.errors.slice(0, 8).join(' '));
    if (!parsed.lines.length) throw new Error('No valid count rows were found. Enter Count values before uploading.');

    const { saveStockTake } = await import('./services/stockTakeService.js');
    const groups = groupStockTakeRowsByLocation(parsed.lines);
    const skippedGroups = [];
    let importedLines = 0;
    for (const group of groups) {
      const locationName = getLocationNameById(appState.stockTake.locations || [], group.locationId, 'Main Store');
      const result = await saveStockTake(appState.workspace.id, {
        id: getStockTakeImportGroupId(group),
        date: todayLocal(),
        sessionMode: 'template_import',
        templateName: `Uploaded count: ${file.name || 'stock take file'}`,
        locationId: group.locationId,
        locationName,
        note: `Stock take import: ${file.name || 'uploaded file'}`,
        items: group.lines.map((line) => ({
          stockItemId: line.stockItemId,
          shelfCount: line.shelfCount,
          unit: line.unit,
          uomCounts: line.uomCounts || {}
        }))
      });
      if (result?.duplicate || result?.skipped) {
        skippedGroups.push({
          locationName,
          lineCount: group.lines.length
        });
      } else {
        importedLines += group.lines.length;
      }
    }

    appState.stockTake = {
      ...appState.stockTake,
      actionStatus: '',
      actionError: ''
    };
    if (skippedGroups.length) {
      const skippedLines = skippedGroups.reduce((sum, group) => sum + (Number(group.lineCount || 0) || 0), 0);
      const skippedLocationNames = skippedGroups.map((group) => group.locationName).filter(Boolean);
      const skippedLabel = skippedLocationNames.length <= 3
        ? skippedLocationNames.join(', ')
        : `${skippedLocationNames.slice(0, 3).join(', ')} and ${skippedLocationNames.length - 3} more`;
      const allGroupsSkipped = skippedGroups.length === groups.length;
      showImportNotification({
        moduleLabel: 'Stock Take Import',
        title: allGroupsSkipped ? 'Stock Take Already Imported' : 'Stock Take Partly Imported',
        message: allGroupsSkipped
          ? `Your file is valid, but these ${skippedGroups.length} location count group${skippedGroups.length === 1 ? '' : 's'} (${skippedLabel}) already exist for today. They were skipped so stock is not counted twice.`
          : `${importedLines} count row${importedLines === 1 ? '' : 's'} imported. ${skippedLines} row${skippedLines === 1 ? '' : 's'} from ${skippedLabel} already existed for today and were skipped so stock is not counted twice.`,
        errors: skippedGroups.map((group) => ({
          code: 'ALREADY_IMPORTED',
          message: `${group.locationName} was skipped because this exact stock take import already exists for today (${group.lineCount} row${group.lineCount === 1 ? '' : 's'}).`
        })),
        importedCount: importedLines,
        skippedCount: skippedLines,
        totalRows: parsed.lines.length,
        tone: 'warning',
        confirmLabel: 'Confirm'
      });
    } else {
      showStockTakeToast(`Stock take import committed (${parsed.lines.length} count line${parsed.lines.length === 1 ? '' : 's'}).`, 'success');
    }
  } catch (error) {
    appState.stockTake = {
      ...appState.stockTake,
      actionStatus: '',
      actionError: ''
    };
    showImportNotification({
      moduleLabel: 'Stock Take Import',
      title: 'Stock Take Import Failed',
      message: `${error.message || 'Stock take import failed.'} Confirm this message, fix the file, and try again.`,
      errors: [error.message || 'Stock take import failed.'],
      tone: 'error',
      confirmLabel: 'Confirm & Try Again'
    });
  }
}

function parseStockTakeCountRows(rows = [], { stockItems = [], locations = [] } = {}) {
  const errors = [];
  const lines = [];
  (rows || []).forEach((row, index) => {
    const lineNumber = index + 2;
    const rawItem = getImportRowValue(row, ['Item_ID/SKU', 'Item ID/SKU', 'Item_ID', 'Item ID', 'SKU', 'Item_Name', 'Item Name', 'Item']);
    const rawLocation = getImportRowValue(row, ['Location_ID', 'Location ID', 'Location', 'Location_Name']);
    const rawLegacyCount = getImportRowValue(row, ['Count', 'Shelf_Count', 'Shelf Count', 'Qty', 'Quantity']);
    const rawTotalCount = getImportRowValue(row, ['Total_Count_Base_UOM', 'Total Count Base UOM', 'Total_Count', 'Total Count', 'Final_Count', 'Final Count']);
    const baseCountInput = getImportRowValue(row, ['Base_Count', 'Base Count', 'Base_Units', 'Base Units']);
    const uomInputs = [1, 2, 3].map((slot) => ({
      slot,
      name: getImportRowValue(row, [`UOM${slot}_Name`, `UOM${slot} Name`, `Custom_UOM_${slot}`, `Custom UOM ${slot}`, `Custom_UOM_${slot}_Unit`, `Custom UOM ${slot} Unit`]),
      ratio: getImportRowValue(row, [`UOM${slot}_Qty_Per_Base`, `UOM${slot} Qty Per Base`, `UOM${slot}_Ratio`, `UOM${slot} Ratio`, `Custom_UOM_${slot}_Ratio`, `Custom UOM ${slot} Ratio`]),
      count: getImportRowValue(row, [`UOM${slot}_Count`, `UOM${slot} Count`, `Custom_UOM_${slot}_Count`, `Custom UOM ${slot} Count`])
    }));
    const hasSplitCountInput = [baseCountInput, ...uomInputs.map((entry) => entry.count)].some(isImportCellFilled);
    const hasLegacyCountInput = isImportCellFilled(rawLegacyCount);
    const hasManualTotalInput = isImportCellFilled(rawTotalCount) && !isFormulaLikeImportValue(rawTotalCount);
    if (![rawItem, rawLocation, baseCountInput, rawLegacyCount, rawTotalCount, ...uomInputs.flatMap((entry) => [entry.ratio, entry.count])].some(isImportCellFilled)) return;
    if (!hasSplitCountInput && !hasLegacyCountInput && !hasManualTotalInput) return;

    const item = findStockItemForImport(stockItems, rawItem);
    const countableItem = item && isStockTakeCountableItem(item) ? item : null;
    const location = findLocationForImport(locations, rawLocation) || ((locations || []).length ? null : { id: 'main', name: 'Main Store' });
    const uomConfigs = countableItem
      ? normalizeLineUomConfigurations(countableItem.uomConfigurations || countableItem.uomConfig || countableItem.uomConversions)
      : [];
    let shelfCount = NaN;
    if (hasSplitCountInput) {
      const calculated = calculateStockTakeSplitCount({
        baseCountInput,
        uomInputs,
        uomConfigs,
        lineNumber,
        errors
      });
      shelfCount = calculated;
    } else if (hasManualTotalInput) {
      shelfCount = parseStockTakeImportNumber(rawTotalCount);
    } else {
      shelfCount = parseStockTakeImportNumber(rawLegacyCount);
    }
    if (!item) errors.push(`Row ${lineNumber}: stock item "${rawItem}" was not found.`);
    if (item && !countableItem) errors.push(`Row ${lineNumber}: "${item.name || rawItem}" cannot be counted in stock takes.`);
    if (!location) errors.push(`Row ${lineNumber}: location "${rawLocation}" was not found.`);
    if (!Number.isFinite(shelfCount) || shelfCount < 0) errors.push(`Row ${lineNumber}: count must be zero or greater.`);
    if (!countableItem || !location || !Number.isFinite(shelfCount) || shelfCount < 0) return;
    lines.push({
      stockItemId: String(countableItem.id),
      stockItemName: countableItem.name || '',
      locationId: String(location.id),
      shelfCount,
      unit: countableItem.unit || 'ea',
      uomCounts: buildStockTakeImportUomCounts({ baseCountInput, uomInputs, uomConfigs, baseUom: countableItem.unit || 'ea' })
    });
  });
  return { lines, errors };
}


function buildStockTakeImportUomCounts({ baseCountInput = '', uomInputs = [], uomConfigs = [], baseUom = 'ea' } = {}) {
  const result = {};
  if (isImportCellFilled(baseCountInput)) {
    const baseCount = parseStockTakeImportNumber(baseCountInput);
    if (Number.isFinite(baseCount) && baseCount >= 0) result.base = baseCount;
  }
  (uomInputs || []).forEach((entry = {}) => {
    if (!isImportCellFilled(entry.count)) return;
    const count = parseStockTakeImportNumber(entry.count);
    if (!Number.isFinite(count) || count < 0) return;
    const name = String(entry.name || uomConfigs?.[Number(entry.slot || 0) - 1]?.customUom || `UOM${entry.slot || ''}` || baseUom).trim();
    if (name) result[name] = count;
  });
  return result;
}

function calculateStockTakeSplitCount({ baseCountInput = '', uomInputs = [], uomConfigs = [], lineNumber = 0, errors = [] } = {}) {
  let total = 0;
  if (isImportCellFilled(baseCountInput)) {
    const baseCount = parseStockTakeImportNumber(baseCountInput);
    if (!Number.isFinite(baseCount) || baseCount < 0) {
      errors.push(`Row ${lineNumber}: Base_Count must be zero or greater.`);
      return NaN;
    }
    total += baseCount;
  }

  (uomInputs || []).forEach((entry = {}) => {
    if (!isImportCellFilled(entry.count)) return;
    const count = parseStockTakeImportNumber(entry.count);
    const configuredRatio = Number(uomConfigs?.[Number(entry.slot || 0) - 1]?.ratio || 0);
    const ratio = isImportCellFilled(entry.ratio)
      ? parseStockTakeImportNumber(entry.ratio)
      : configuredRatio;
    if (!Number.isFinite(count) || count < 0) {
      errors.push(`Row ${lineNumber}: UOM${entry.slot}_Count must be zero or greater.`);
      return;
    }
    if (!Number.isFinite(ratio) || ratio <= 0) {
      errors.push(`Row ${lineNumber}: UOM${entry.slot}_Qty_Per_Base must be greater than zero when UOM${entry.slot}_Count is entered.`);
      return;
    }
    total += ratio * count;
  });

  return total;
}

function isImportCellFilled(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function isFormulaLikeImportValue(value) {
  return String(value ?? '').trim().startsWith('=');
}

function parseStockTakeImportNumber(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(',', '.');
  if (!normalized) return NaN;
  return Number(normalized);
}

function groupStockTakeRowsByLocation(lines = []) {
  const map = new Map();
  lines.forEach((line) => {
    if (!map.has(line.locationId)) {
      map.set(line.locationId, { locationId: line.locationId, lines: [] });
    }
    map.get(line.locationId).lines.push(line);
  });
  return [...map.values()];
}

function getStockTakeImportGroupId(group = {}) {
  const lines = (group.lines || [])
    .map((line) => [
      String(line.stockItemId || '').trim(),
      Number(line.shelfCount || 0) || 0,
      String(line.unit || '').trim().toLowerCase()
    ])
    .sort((left, right) => left.join('|').localeCompare(right.join('|')));
  return stableImportId('stimp', [todayLocal(), group.locationId, lines]);
}

function updateStockTakeTemplateDraft(updates = {}, options = {}) {
  const current = appState.stockTake.templateDraft || createEmptyStockTakeTemplateDraft();
  const nextDraft = {
    ...current,
    ...updates
  };
  if (Object.prototype.hasOwnProperty.call(updates, 'siteId')) {
    nextDraft.siteName = getStockTakeSiteName(updates.siteId);
    const scopedLocations = normalizeStockTakeLocationList(current.targetLocations || current.targetLocation)
      .filter((locationId) => getStockTakeSiteIdForLocation(locationId) === String(updates.siteId));
    nextDraft.targetLocations = scopedLocations;
    nextDraft.targetLocation = scopedLocations[0] || '';
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'targetLocations')) {
    const targetLocations = normalizeStockTakeLocationList(updates.targetLocations)
      .filter((locationId) => !nextDraft.siteId || getStockTakeSiteIdForLocation(locationId) === String(nextDraft.siteId));
    nextDraft.targetLocations = targetLocations;
    nextDraft.targetLocation = targetLocations[0] || '';
  } else if (Object.prototype.hasOwnProperty.call(updates, 'targetLocation')) {
    const targetLocations = normalizeStockTakeLocationList([updates.targetLocation, ...(current.targetLocations || [])])
      .filter((locationId) => !nextDraft.siteId || getStockTakeSiteIdForLocation(locationId) === String(nextDraft.siteId));
    nextDraft.targetLocations = targetLocations;
    nextDraft.targetLocation = targetLocations[0] || '';
  }
  appState.stockTake = {
    ...appState.stockTake,
    actionError: '',
    templateDraft: nextDraft
  };
  if (options.render !== false) renderApp();
}

function toggleStockTakeTemplateLocation(locationId, checked) {
  const current = appState.stockTake.templateDraft || createEmptyStockTakeTemplateDraft();
  const siteId = current.siteId || getStockTakeSiteIdForLocation(locationId) || getDefaultStockTakeSiteId();
  if (siteId && getStockTakeSiteIdForLocation(locationId) !== String(siteId)) return;
  const locations = new Set(normalizeStockTakeLocationList(current.targetLocations || current.targetLocation));
  if (checked) locations.add(String(locationId));
  else locations.delete(String(locationId));
  const targetLocations = [...locations].filter((entry) => entry && (!siteId || getStockTakeSiteIdForLocation(entry) === String(siteId)));
  appState.stockTake = {
    ...appState.stockTake,
    templateDraft: {
      ...current,
      siteId,
      siteName: getStockTakeSiteName(siteId),
      targetLocations,
      targetLocation: targetLocations[0] || ''
    }
  };
  renderApp();
}

function normalizeStockTakeLocationList(value = []) {
  const values = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' ? Object.values(value) : [value]);
  return [...new Set(values.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function setStockTakeTemplateScope(scope) {
  const nextScope = scope === 'items' ? 'items' : 'category';
  const current = appState.stockTake.templateDraft || createEmptyStockTakeTemplateDraft();
  appState.stockTake = {
    ...appState.stockTake,
    templateDraft: {
      ...current,
      scope: nextScope,
      selections: []
    },
    filters: {
      ...appState.stockTake.filters,
      templateSelectionQuery: ''
    }
  };
  renderApp();
}

function toggleStockTakeTemplateSelection(value, checked) {
  const current = appState.stockTake.templateDraft || createEmptyStockTakeTemplateDraft();
  const selections = new Set((current.selections || []).map(String));
  if (checked) selections.add(String(value));
  else selections.delete(String(value));
  appState.stockTake = {
    ...appState.stockTake,
    templateDraft: {
      ...current,
      selections: [...selections]
    }
  };
  renderApp();
}

function bulkStockTakeTemplateSelection(selectAll) {
  const current = appState.stockTake.templateDraft || createEmptyStockTakeTemplateDraft();
  const query = String(appState.stockTake.filters?.templateSelectionQuery || '').trim().toLowerCase();
  const scope = current.scope === 'items' ? 'items' : 'category';
  const matches = scope === 'items'
    ? (appState.stockTake.stockItems || [])
      .filter(isStockTakeCountableItem)
      .filter((item) => !query
        || String(item.name || '').toLowerCase().includes(query)
        || String(item.category || '').toLowerCase().includes(query))
      .map((item) => String(item.id))
    : [...new Set((appState.stockTake.stockItems || []).filter(isStockTakeCountableItem).map((item) => String(item.category || '').trim()).filter(Boolean))]
      .filter((category) => !query || category.toLowerCase().includes(query));

  const selections = selectAll ? new Set((current.selections || []).map(String)) : new Set((current.selections || []).map(String));
  matches.forEach((value) => {
    if (selectAll) selections.add(String(value));
    else selections.delete(String(value));
  });

  appState.stockTake = {
    ...appState.stockTake,
    templateDraft: {
      ...current,
      selections: [...selections]
    }
  };
  renderApp();
}

async function saveStockTakeTemplateDraft() {
  const draft = appState.stockTake.templateDraft || createEmptyStockTakeTemplateDraft();
  const siteId = draft.siteId || getStockTakeSiteIdForLocation((draft.targetLocations || [])[0] || draft.targetLocation) || getDefaultStockTakeSiteId();
  const payload = {
    ...draft,
    siteId,
    siteName: getStockTakeSiteName(siteId),
    targetLocations: normalizeStockTakeLocationList(draft.targetLocations || draft.targetLocation)
      .filter((locationId) => !siteId || getStockTakeSiteIdForLocation(locationId) === String(siteId))
  };
  payload.targetLocation = payload.targetLocations[0] || '';
  appState.stockTake = {
    ...appState.stockTake,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { saveStockTakeTemplate } = await import('./services/stockTakeService.js');
    const saved = await saveStockTakeTemplate(appState.workspace?.id, payload);
    // Upsert the saved template into the in-memory list so the manager shows it immediately
    // (it is already persisted server-side; the list otherwise stayed stale until a full reload).
    const withoutOld = (appState.stockTake.templates || []).filter((t) => String(t.id) !== String(saved.id));
    appState.stockTake = {
      ...appState.stockTake,
      templates: [...withoutOld, saved].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
      actionStatus: '',
      actionError: '',
      templateDraft: null,
      filters: {
        ...appState.stockTake.filters,
        overlay: 'template-manager',
        openDropdown: '',
        templateSelectionQuery: ''
      }
    };
    renderApp();
    showStockTakeToast('Template saved.', 'success');
  } catch (error) {
    appState.stockTake = {
      ...appState.stockTake,
      actionStatus: '',
      actionError: error.message || 'Could not save template.'
    };
    renderApp();
  }
}

async function deleteStockTakeTemplateEntry(templateId) {
  appState.stockTake = {
    ...appState.stockTake,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { deleteStockTakeTemplate } = await import('./services/stockTakeService.js');
    await deleteStockTakeTemplate(appState.workspace?.id, templateId);
    appState.stockTake = {
      ...appState.stockTake,
      templates: removeRowsByIds(appState.stockTake.templates, [templateId]),
      templateDraft: String(appState.stockTake.templateDraft?.id || '') === String(templateId) ? null : appState.stockTake.templateDraft,
      actionStatus: '',
      actionError: ''
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showStockTakeToast('Template deleted.', 'success');
  } catch (error) {
    appState.stockTake = {
      ...appState.stockTake,
      actionStatus: '',
      actionError: error.message || 'Could not delete template.'
    };
    renderApp();
  }
}

// Repaint every computed element of the active stock-take session directly from
// the current draft. renderApp() is suppressed while a count input (type=text) is
// focused — to preserve in-progress decimal entry — so this keeps variance,
// impact, the footer totals, and the commit button in sync while typing.
// Iterates ALL rendered cells (not a single row) so nothing can go stale and no
// per-row selector can mismatch.
function refreshStockTakeSessionComputed() {
  const draft = hydrateStockTakeDraft(appState.stockTake.draftSession, appState.stockTake.locations || []);
  const items = draft.items || [];
  const byId = new Map(items.map((item) => [String(item.stockItemId), item]));

  document.querySelectorAll('[data-stocktake-variance]').forEach((cell) => {
    const entry = byId.get(String(cell.getAttribute('data-stocktake-variance')));
    const v = entry ? Number(entry.variance || 0) : 0;
    cell.textContent = entry ? `${v > 0 ? '+' : ''}${formatNumber(v)}` : '-';
    cell.classList.toggle('is-negative', !!entry && v < 0);
    cell.classList.toggle('is-positive', !!entry && v > 0);
  });

  document.querySelectorAll('[data-stocktake-impact]').forEach((cell) => {
    const entry = byId.get(String(cell.getAttribute('data-stocktake-impact')));
    const imp = entry ? Number(entry.varianceImpactEx || 0) : 0;
    cell.textContent = entry ? formatCurrency(imp) : '-';
    cell.classList.toggle('is-negative', !!entry && imp < 0);
    cell.classList.toggle('is-positive', !!entry && imp > 0);
  });

  const totalCell = document.querySelector('[data-stocktake-variance-total]');
  if (totalCell) {
    const total = items.reduce((sum, it) => sum + Number(it.varianceImpactEx || 0), 0);
    totalCell.textContent = formatCurrency(total);
  }
  const countedLinesCell = document.querySelector('[data-stocktake-counted-lines]');
  if (countedLinesCell) countedLinesCell.textContent = String(items.length);
  const commitButton = document.querySelector('[data-stocktake-save]');
  if (commitButton) {
    commitButton.disabled = !(items.length && appState.stockTake.actionStatus !== 'saving');
  }
}

function stockTakeUomCountMap(value = {}, baseUom = 'ea') {
  if (!Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value || {})
        .map(([key, count]) => [String(key || '').trim(), parseDecimalInputValue(count, 0)])
        .filter(([key, count]) => key && Number(count) > 0)
    );
  }

  const normalizedBaseUom = String(baseUom || 'ea').trim().toLowerCase();
  return value.reduce((result, row = {}) => {
    const count = parseDecimalInputValue(row.count ?? row.quantity ?? row.scans, 0);
    if (!(count > 0)) return result;
    const ratio = parseDecimalInputValue(row.ratio ?? row.qtyInBase ?? row.qty_in_base ?? row.packSize, 1) || 1;
    const name = String(row.uomName || row.selectedUom || row.unit || row.key || '').trim();
    const rawKey = String(row.key || '').trim();
    const key = rawKey === 'base' || (ratio === 1 && name.toLowerCase() === normalizedBaseUom)
      ? 'base'
      : (name || rawKey || 'base');
    result[key] = (Number(result[key] || 0) || 0) + count;
    return result;
  }, {});
}

function updateStockTakeCount(stockItemId, value, uomKey = 'base') {
  const draft = hydrateStockTakeDraft(appState.stockTake.draftSession, appState.stockTake.locations || []);
  const raw = String(value ?? '').trim();
  const items = [...(draft.items || [])];
  const index = items.findIndex((item) => String(item.stockItemId) === String(stockItemId));
  
  const stockItem = (appState.stockTake.stockItems || []).find((item) => String(item.id) === String(stockItemId));
  if (!stockItem) return;

  const existingEntry = index >= 0 ? items[index] : {
    stockItemId: String(stockItem.id),
    stockItemName: stockItem.name || '',
    unit: stockItem.unit || 'ea',
    shelfCount: 0,
    uomCounts: {}
  };

  const uomCounts = stockTakeUomCountMap(existingEntry.uomCounts || {}, stockItem.unit || 'ea');
  // Populate 'base' fallback if legacy count exists without detailed breakdown.
  if (existingEntry.shelfCount > 0 && Object.keys(uomCounts).length === 0) {
    uomCounts['base'] = existingEntry.shelfCount;
  }

  if (!raw) {
    delete uomCounts[uomKey];
  } else {
    const val = parseDecimalInputValue(raw, NaN);
    if (!Number.isFinite(val) || val < 0) return;
    uomCounts[uomKey] = val;
  }

  if (Object.keys(uomCounts).length === 0) {
    if (index >= 0) items.splice(index, 1);
  } else {
    const uomConfigs = normalizeLineUomConfigurations(stockItem.uomConfigurations || stockItem.uomConfig || stockItem.uomConversions);
    let shelfCount = Number(uomCounts['base'] || 0);
    uomConfigs.forEach((cfg) => {
      const key = String(cfg.customUom || '').trim();
      if (key && uomCounts[key] !== undefined) {
        shelfCount += Number(uomCounts[key] || 0) * (Number(cfg.ratio || 1) || 1);
      }
    });

    const systemStock = getLocationStock(stockItem, draft.locationId, appState.stockTake.locations || []);
    const variance = shelfCount - systemStock;
    const nextEntry = {
      ...existingEntry,
      shelfCount,
      systemStock,
      variance,
      varianceImpactEx: variance * (Number(stockItem.cost || 0) || 0),
      uomCounts
    };

    if (index >= 0) items[index] = nextEntry;
    else items.push(nextEntry);
  }

  appState.stockTake = {
    ...appState.stockTake,
    draftSession: {
      ...draft,
      items
    }
  };
  refreshStockTakeSessionComputed();
  renderApp();
}

async function saveStockTakeDraft() {
  const activeElement = document.activeElement;
  if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
    activeElement.blur?.();
  }

  const draft = hydrateStockTakeDraft(appState.stockTake.draftSession, appState.stockTake.locations || []);
  const commitDraft = normalizeStockTakeCommitDraft(draft);
  if (!commitDraft.locationId) {
    appState.stockTake = {
      ...appState.stockTake,
      actionError: 'Choose a stock take location before committing.'
    };
    renderApp();
    return;
  }
  if (!(commitDraft.items || []).length) {
    appState.stockTake = {
      ...appState.stockTake,
      actionError: 'Enter at least one shelf count before committing.'
    };
    renderApp();
    return;
  }

  appState.stockTake = {
    ...appState.stockTake,
    draftSession: commitDraft,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const { deleteStockTakeDraftSession, saveStockTake } = await import('./services/stockTakeService.js');
    const result = await saveStockTake(appState.workspace?.id, commitDraft);
    const committedId = result?.id || commitDraft.id || '';
    const committedDraft = {
      ...commitDraft,
      id: committedId || commitDraft.id,
      timestamp: new Date().toISOString(),
      lineCount: (commitDraft.items || []).length
    };
    if ((appState.user?.uid || appState.user?.id) && commitDraft.id) {
      await deleteStockTakeDraftSession(appState.workspace?.id, appState.user?.uid || appState.user?.id || '', commitDraft.id);
    }
    const nextStockItems = applyStockTakeCommitToStockItems(appState.stockTake.stockItems || [], committedDraft);
    appState.stockTake = {
      ...appState.stockTake,
      stockItems: nextStockItems,
      stockTakes: [committedDraft, ...(appState.stockTake.stockTakes || []).filter((entry) => String(entry.id || '') !== String(committedDraft.id || ''))],
      actionStatus: '',
      actionError: '',
      sessionActive: false,
      savedDrafts: (appState.stockTake.savedDrafts || []).filter((entry) => String(entry.id) !== String(commitDraft.id || '')),
      draftSession: hydrateStockTakeDraft(createEmptyStockTakeDraft(), appState.stockTake.locations || []),
      sessionSetup: createEmptyStockTakeSessionSetup(),
      filters: {
        ...appState.stockTake.filters,
        query: '',
        openDropdown: '',
        overlay: ''
      }
    };
    showStockTakeToast(result?.duplicate || result?.skipped ? 'Stock take was already committed.' : 'Stock take committed.', result?.duplicate || result?.skipped ? 'warning' : 'success');
    refreshActiveTabFromApi().catch(() => {});
  } catch (error) {
    appState.stockTake = {
      ...appState.stockTake,
      actionStatus: '',
      actionError: error.message || 'Could not save stock take.'
    };
    renderApp();
  }
}

function normalizeStockTakeCommitDraft(draft = {}) {
  const locationId = String(draft.locationId || '').trim();
  const normalizedItems = (draft.items || [])
    .map((line = {}) => {
      const shelfCount = parseDecimalInputValue(line.shelfCount, NaN);
      return {
        ...line,
        stockItemId: String(line.stockItemId || line.itemId || line.ingId || '').trim(),
        shelfCount,
        unit: String(line.unit || '').trim(),
        uomCounts: normalizeCommitUomCounts(line.uomCounts || line.countBreakdown || line.scanBreakdown),
        scanBreakdown: normalizeCommitUomCounts(line.scanBreakdown || line.countBreakdown || line.uomCounts)
      };
    })
    .filter((line) => line.stockItemId && Number.isFinite(line.shelfCount) && line.shelfCount >= 0);

  return {
    ...draft,
    id: String(draft.id || createStableStockTakeCommitId(draft, normalizedItems)).trim(),
    locationId,
    locationName: draft.locationName || getLocationNameById(appState.stockTake.locations || [], locationId, 'Main Store'),
    date: draft.date || todayLocal(),
    items: normalizedItems
  };
}

function normalizeCommitUomCounts(value = {}) {
  const rows = Array.isArray(value)
    ? value
    : Object.entries(value || {}).map(([key, count]) => ({ key, uomName: key === 'base' ? 'base' : key, count, ratio: key === 'base' ? 1 : undefined }));
  return rows
    .map((row = {}) => ({
      ...row,
      key: String(row.key || row.uomName || row.selectedUom || row.unit || '').trim(),
      uomName: String(row.uomName || row.selectedUom || row.unit || row.key || '').trim(),
      count: parseDecimalInputValue(row.count ?? row.quantity ?? row.scans, 0),
      ratio: parseDecimalInputValue(row.ratio ?? row.qtyInBase ?? row.qty_in_base ?? row.packSize, 1) || 1,
      baseUom: String(row.baseUom || row.baseUnit || '').trim()
    }))
    .filter((row) => row.uomName && Number(row.count || 0) > 0);
}

function createStableStockTakeCommitId() {
  return makeStableSubmitId('st');
}

function applyStockTakeCommitToStockItems(stockItems = [], draft = {}) {
  const locationId = String(draft.locationId || '').trim();
  if (!locationId) return stockItems;
  const countedById = new Map((draft.items || []).map((line) => [String(line.stockItemId), Number(line.shelfCount || 0) || 0]));
  if (!countedById.size) return stockItems;
  return (stockItems || []).map((item) => {
    const itemId = String(item.id || '');
    if (!countedById.has(itemId)) return item;
    const nextBalances = { ...(item.balances && typeof item.balances === 'object' ? item.balances : {}) };
    nextBalances[locationId] = countedById.get(itemId);
    const nextStock = Object.values(nextBalances).reduce((sum, value) => sum + (Number(value || 0) || 0), 0);
    return {
      ...item,
      balances: nextBalances,
      stock: nextStock,
      updatedAt: new Date().toISOString()
    };
  });
}

function dismissStockTakeToast() {
  if (stockTakeToastTimer) {
    window.clearTimeout(stockTakeToastTimer);
    stockTakeToastTimer = null;
  }
  appState.stockTake = {
    ...appState.stockTake,
    toast: null
  };
  renderApp();
}

let stockTakeToastTimer = null;
function showStockTakeToast(message, type = 'success') {
  if (stockTakeToastTimer) window.clearTimeout(stockTakeToastTimer);
  appState.stockTake = {
    ...appState.stockTake,
    toast: { message, type }
  };
  renderApp();
  stockTakeToastTimer = window.setTimeout(() => {
    if (appState.stockTake.toast?.message === message) {
      appState.stockTake = {
        ...appState.stockTake,
        toast: null
      };
      renderApp();
    }
    stockTakeToastTimer = null;
  }, 2600);
}

function updateUserManagementFilters(partial = {}) {
  appState.userManagement = {
    ...appState.userManagement,
    filters: {
      ...appState.userManagement.filters,
      ...partial
    }
  };
  renderApp();
}

function updateUserManagementDraft(partial = {}) {
  appState.userManagement = {
    ...appState.userManagement,
    draftMember: {
      ...appState.userManagement.draftMember,
      ...partial
    }
  };
  if (shouldRenderUserManagementFieldChange(partial)) {
    renderApp();
  }
}

function openUserManagementCreateModal() {
  appState.userManagement = {
    ...appState.userManagement,
    createModalOpen: true,
    createStep: 1,
    actionError: '',
    draftMember: createUserManagementState('idle').draftMember,
    filters: {
      ...appState.userManagement.filters,
      openDropdown: ''
    }
  };
  renderApp();
}

function nextUserManagementCreateStep() {
  const draft = appState.userManagement.draftMember || {};
  const currentStep = appState.userManagement.createStep || 1;
  if (currentStep === 1) {
    if (!String(draft.firstName || '').trim() || !String(draft.email || '').trim()) {
      appState.userManagement = { ...appState.userManagement, actionError: 'First name and email are required before continuing.' };
      renderApp();
      return;
    }
  }
  appState.userManagement = {
    ...appState.userManagement,
    createStep: currentStep + 1,
    actionError: ''
  };
  renderApp();
}

function prevUserManagementCreateStep() {
  const currentStep = appState.userManagement.createStep || 1;
  appState.userManagement = {
    ...appState.userManagement,
    createStep: Math.max(1, currentStep - 1),
    actionError: ''
  };
  renderApp();
}

async function resendUserManagementInvite(memberKey) {
  if (!appState.workspace?.id || !memberKey) return;
  const member = (appState.access.team || []).find((m) => String(m.key) === String(memberKey));
  if (!member) return;
  try {
    showGlobalSaving('Resending invite...');
    await resendWorkspaceMemberInvite(appState.workspace.id, memberKey);
    hideGlobalSaving();
    showUserManagementToast(`Invite resent to ${member.email}.`, 'success');
  } catch (error) {
    hideGlobalSaving();
    showUserManagementToast(error.message || 'Could not resend invite.', 'error');
  }
}

function selectAllUserManagementDraftLocations(checked) {
  const allIds = (appState.access.locations || []).map((loc) => String(loc.id || loc.locationId || '').trim()).filter(Boolean);
  appState.userManagement = {
    ...appState.userManagement,
    draftMember: {
      ...appState.userManagement.draftMember,
      allowedLocations: checked ? allIds : []
    }
  };
  renderApp();
}

function toggleUserManagementDraftLocation(locationId, checked) {
  const id = String(locationId || '').trim();
  if (!id) return;
  const current = Array.isArray(appState.userManagement.draftMember?.allowedLocations)
    ? appState.userManagement.draftMember.allowedLocations
    : [];
  const next = checked ? [...new Set([...current, id])] : current.filter((v) => v !== id);
  appState.userManagement = {
    ...appState.userManagement,
    draftMember: {
      ...appState.userManagement.draftMember,
      allowedLocations: next
    }
  };
  renderApp();
}

function selectAllUserManagementEditLocations(checked) {
  const allIds = (appState.access.locations || []).map((loc) => String(loc.id || loc.locationId || '').trim()).filter(Boolean);
  appState.userManagement = {
    ...appState.userManagement,
    editingMember: {
      ...appState.userManagement.editingMember,
      allowedLocations: checked ? allIds : []
    }
  };
  renderApp();
}

function toggleUserManagementEditLocation(locationId, checked) {
  const id = String(locationId || '').trim();
  if (!id) return;
  const current = Array.isArray(appState.userManagement.editingMember?.allowedLocations)
    ? appState.userManagement.editingMember.allowedLocations
    : [];
  const next = checked ? [...new Set([...current, id])] : current.filter((v) => v !== id);
  appState.userManagement = {
    ...appState.userManagement,
    editingMember: {
      ...appState.userManagement.editingMember,
      allowedLocations: next
    }
  };
  renderApp();
}

function closeUserManagementCreateModal() {
  appState.userManagement = {
    ...appState.userManagement,
    createModalOpen: false,
    actionError: '',
    filters: {
      ...appState.userManagement.filters,
      openDropdown: ''
    }
  };
  renderApp();
}

function openUserManagementEditor(memberKey) {
  const member = (appState.access.team || []).find((entry) => String(entry.key) === String(memberKey));
  if (!member) return;
  appState.userManagement = {
    ...appState.userManagement,
    editingMember: {
      ...member
    },
    editTab: 'details',
    actionStatus: '',
    actionError: '',
    confirmRemove: null,
    filters: {
      ...appState.userManagement.filters,
      openDropdown: ''
    }
  };
  renderApp();
}

function setUserManagementEditTab(tab) {
  const next = ['details', 'role', 'locations'].includes(String(tab)) ? String(tab) : 'details';
  appState.userManagement = {
    ...appState.userManagement,
    editTab: next
  };
  renderApp();
}

function closeUserManagementEditor() {
  appState.userManagement = {
    ...appState.userManagement,
    editingMember: null,
    filters: {
      ...appState.userManagement.filters,
      openDropdown: ''
    }
  };
  renderApp();
}

function updateUserManagementEdit(partial = {}) {
  if (!appState.userManagement.editingMember) return;
  appState.userManagement = {
    ...appState.userManagement,
    editingMember: {
      ...appState.userManagement.editingMember,
      ...partial
    }
  };
  if (shouldRenderUserManagementFieldChange(partial)) {
    renderApp();
  }
}

function shouldRenderUserManagementFieldChange(partial = {}) {
  return Object.keys(partial).some((key) => key === 'role');
}

async function createUserManagementMember() {
  if (!appState.workspace?.id) return;
  if (!hasPermission(ACTION_PERMISSION_MAP.manageUsers, appState.access.currentRole, appState.access.customRoles || [])) {
    denyModuleAction('userManagement', 'You do not have permission to manage workspace employees.');
    return;
  }
  const canAssignLowStockTag = hasPermission(ACTION_PERMISSION_MAP.assignLowStockEmailTag, appState.access.currentRole, appState.access.customRoles || []);
  const baseDraftMember = canCurrentUserManagePermissionSets()
    ? appState.userManagement.draftMember
    : { ...appState.userManagement.draftMember, role: 'member' };
  const draftMember = canAssignLowStockTag
    ? baseDraftMember
    : { ...baseDraftMember, lowStockAlert: false };
  appState.userManagement = {
    ...appState.userManagement,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    const result = await createWorkspaceMember(appState.workspace.id, appState.workspace.siteName, appState.user, draftMember);
    appState.userManagement = {
      ...appState.userManagement,
      actionStatus: 'refreshing',
      actionError: ''
    };
    renderApp();
    await refreshActiveTabFromApi().catch(() => {});
    appState.userManagement = {
      ...appState.userManagement,
      actionStatus: '',
      actionError: '',
      draftMember: createUserManagementState('idle').draftMember,
      createModalOpen: false,
      filters: {
        ...appState.userManagement.filters,
        openDropdown: ''
      }
    };
    const messages = {
      created: 'Employee account created. An invite email has been sent.',
      'linked-existing': 'Existing employee account linked to the workspace.'
    };
    showUserManagementToast(messages[result.mode] || 'Employee saved.', 'success');
  } catch (error) {
    appState.userManagement = {
      ...appState.userManagement,
      actionStatus: '',
      actionError: error.message || 'Could not save the employee.'
    };
    renderApp();
  }
}

async function saveUserManagementEdit() {
  if (!appState.workspace?.id || !appState.userManagement.editingMember) return;
  if (!hasPermission(ACTION_PERMISSION_MAP.manageUsers, appState.access.currentRole, appState.access.customRoles || [])) {
    denyModuleAction('userManagement', 'You do not have permission to manage workspace employees.');
    return;
  }
  const canAssignLowStockTag = hasPermission(ACTION_PERMISSION_MAP.assignLowStockEmailTag, appState.access.currentRole, appState.access.customRoles || []);
  const originalMember = (appState.access.team || []).find((entry) => String(entry.key) === String(appState.userManagement.editingMember.key));
  const baseEditedMember = canCurrentUserManagePermissionSets()
    ? appState.userManagement.editingMember
    : { ...appState.userManagement.editingMember, role: originalMember?.role || appState.userManagement.editingMember.role || 'member' };
  const editedMember = canAssignLowStockTag
    ? baseEditedMember
    : { ...baseEditedMember, lowStockAlert: originalMember?.lowStockAlert === true };
  appState.userManagement = {
    ...appState.userManagement,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    await updateWorkspaceMember(appState.workspace.id, editedMember, {
      ...editedMember,
      workspaceName: appState.workspace.siteName
    });
    appState.userManagement = {
      ...appState.userManagement,
      actionStatus: '',
      actionError: '',
      editingMember: null,
      filters: {
        ...appState.userManagement.filters,
        openDropdown: ''
      }
    };
    showUserManagementToast('Employee access updated.', 'success');
    await refreshActiveTabFromApi();
  } catch (error) {
    appState.userManagement = {
      ...appState.userManagement,
      actionStatus: '',
      actionError: error.message || 'Could not update the employee.'
    };
    renderApp();
  }
}

function requestUserManagementRemove(memberKey) {
  const member = (appState.access.team || []).find((entry) => String(entry.key) === String(memberKey));
  if (!member) return;
  appState.userManagement = {
    ...appState.userManagement,
    confirmRemove: member,
    editingMember: null,
    filters: {
      ...appState.userManagement.filters,
      openDropdown: ''
    }
  };
  renderApp();
}

function cancelUserManagementRemove() {
  appState.userManagement = {
    ...appState.userManagement,
    confirmRemove: null
  };
  renderApp();
}

async function confirmUserManagementRemove() {
  if (!appState.workspace?.id || !appState.userManagement.confirmRemove) return;
  if (!hasPermission(ACTION_PERMISSION_MAP.manageUsers, appState.access.currentRole, appState.access.customRoles || [])) {
    denyModuleAction('userManagement', 'You do not have permission to manage workspace employees.');
    return;
  }
  appState.userManagement = {
    ...appState.userManagement,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    await removeWorkspaceMember(appState.workspace.id, appState.userManagement.confirmRemove);
    const removedMemberId = String(appState.userManagement.confirmRemove?.id || appState.userManagement.confirmRemove?.key || '');
    const removedMemberEmail = String(appState.userManagement.confirmRemove?.email || '').toLowerCase();
    appState.userManagement = {
      ...appState.userManagement,
      actionStatus: '',
      actionError: '',
      confirmRemove: null
    };
    appState.access = {
      ...appState.access,
      team: (appState.access.team || []).filter((member) => (
        String(member.id || member.key || '') !== removedMemberId &&
        String(member.email || '').toLowerCase() !== removedMemberEmail
      ))
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showUserManagementToast('Employee removed from the workspace.', 'success');
  } catch (error) {
    appState.userManagement = {
      ...appState.userManagement,
      actionStatus: '',
      actionError: error.message || 'Could not remove the employee.'
    };
    renderApp();
  }
}

function dismissUserManagementToast() {
  if (userManagementToastTimer) {
    window.clearTimeout(userManagementToastTimer);
    userManagementToastTimer = null;
  }
  appState.userManagement = {
    ...appState.userManagement,
    toast: null
  };
  renderApp();
}

function showUserManagementToast(message, type = 'success') {
  if (userManagementToastTimer) window.clearTimeout(userManagementToastTimer);
  appState.userManagement = {
    ...appState.userManagement,
    toast: { message, type }
  };
  renderApp();
  userManagementToastTimer = window.setTimeout(() => {
    if (appState.userManagement.toast?.message === message) {
      appState.userManagement = {
        ...appState.userManagement,
        toast: null
      };
      renderApp();
    }
    userManagementToastTimer = null;
  }, 2600);
}

function openRoleManagementEditor(roleName) {
  if (!canCurrentUserManagePermissionSets()) {
    denyModuleAction('roleManagement', 'You do not have permission to manage roles and permissions.');
    return;
  }
  const target = String(roleName || '').trim();
  const existing = (appState.access.roleCatalog || []).find((role) => role.name === normalizeRoleName(target));
  appState.roleManagement = {
    ...appState.roleManagement,
    editingRole: existing
      ? {
          ...existing,
          permissions: [...(existing.permissions || [])],
          locations: [...(existing.locations || ['all'])]
        }
      : {
          name: '',
          label: '',
          permissions: ['nav-dashboard'],
          locations: ['all'],
          isPreset: false,
          isModified: false
        },
    confirmDelete: null
  };
  renderApp();
}

function closeRoleManagementEditor() {
  appState.roleManagement = {
    ...appState.roleManagement,
    editingRole: null
  };
  renderApp();
}

function updateRoleManagementEditor(partial = {}) {
  if (!appState.roleManagement.editingRole) return;
  appState.roleManagement = {
    ...appState.roleManagement,
    editingRole: {
      ...appState.roleManagement.editingRole,
      ...partial
    }
  };
  renderApp();
}

function toggleRoleManagementPermission(permissionId, checked) {
  if (!appState.roleManagement.editingRole) return;
  const current = new Set(appState.roleManagement.editingRole.permissions || []);
  if (checked) current.add(permissionId);
  else current.delete(permissionId);
  updateRoleManagementEditor({ permissions: [...current] });
}

function toggleRoleManagementLocation(locationId, checked) {
  if (!appState.roleManagement.editingRole) return;
  const current = new Set((appState.roleManagement.editingRole.locations || []).filter((entry) => entry !== 'all'));
  if (checked) current.add(locationId);
  else current.delete(locationId);
  updateRoleManagementEditor({ locations: current.size ? [...current] : [] });
}

function toggleRoleManagementAllLocations(checked) {
  if (!appState.roleManagement.editingRole) return;
  updateRoleManagementEditor({ locations: checked ? ['all'] : [] });
}

async function saveRoleManagementEditor() {
  if (!appState.workspace?.id || !appState.roleManagement.editingRole) return;
  if (!canCurrentUserManagePermissionSets()) {
    denyModuleAction('roleManagement', 'You do not have permission to manage roles and permissions.');
    return;
  }
  const editor = appState.roleManagement.editingRole;
  const label = String(editor.label || '').trim();
  const roleName = normalizeRoleName(editor.name || label);
  if (!label) {
    appState.roleManagement = {
      ...appState.roleManagement,
      actionError: 'Role name is required.'
    };
    renderApp();
    return;
  }
  if (!roleName) {
    appState.roleManagement = {
      ...appState.roleManagement,
      actionError: 'Role name is required.'
    };
    renderApp();
    return;
  }

  appState.roleManagement = {
    ...appState.roleManagement,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    await saveWorkspaceRole(appState.workspace.id, {
      name: roleName,
      label,
      permissions: ensureExplicitDataPermissionSchema(editor.permissions || []),
      locations: Array.isArray(editor.locations) ? editor.locations : ['all']
    });
    appState.roleManagement = {
      ...appState.roleManagement,
      actionStatus: '',
      actionError: '',
      editingRole: null
    };
    showRoleManagementToast('Role saved.', 'success');
    await refreshActiveTabFromApi();
  } catch (error) {
    appState.roleManagement = {
      ...appState.roleManagement,
      actionStatus: '',
      actionError: error.message || 'Could not save the role.'
    };
    renderApp();
  }
}

function requestRoleManagementDelete(roleName) {
  if (!canCurrentUserManagePermissionSets()) {
    denyModuleAction('roleManagement', 'You do not have permission to manage roles and permissions.');
    return;
  }
  const target = (appState.access.roleCatalog || []).find((role) => role.name === normalizeRoleName(roleName));
  if (!target) return;
  appState.roleManagement = {
    ...appState.roleManagement,
    confirmDelete: target,
    editingRole: null
  };
  renderApp();
}

function cancelRoleManagementDelete() {
  appState.roleManagement = {
    ...appState.roleManagement,
    confirmDelete: null
  };
  renderApp();
}

async function confirmRoleManagementDelete() {
  if (!appState.workspace?.id || !appState.roleManagement.confirmDelete) return;
  if (!canCurrentUserManagePermissionSets()) {
    denyModuleAction('roleManagement', 'You do not have permission to manage roles and permissions.');
    return;
  }
  const targetRole = appState.roleManagement.confirmDelete;
  appState.roleManagement = {
    ...appState.roleManagement,
    actionStatus: 'saving',
    actionError: ''
  };
  renderApp();

  try {
    await deleteWorkspaceRole(appState.workspace.id, appState.roleManagement.confirmDelete.name);
    const roleName = appState.roleManagement.confirmDelete.name;
    appState.roleManagement = {
      ...appState.roleManagement,
      actionStatus: '',
      actionError: '',
      confirmDelete: null
    };
    appState.access = {
      ...appState.access,
      customRoles: removeRowsByNames(appState.access.customRoles, [roleName]),
      roleCatalog: removeRowsByNames(appState.access.roleCatalog, [roleName]),
      roleOptions: (appState.access.roleOptions || []).filter((role) => (
        String(role.value || role.key || role.name || '').trim().toLowerCase() !== String(roleName || '').trim().toLowerCase()
      ))
    };
    renderApp();
    refreshActiveTabFromApi().catch(() => {});
    showRoleManagementToast(targetRole.isModified ? 'Role override reset.' : 'Role deleted.', 'success');
  } catch (error) {
    appState.roleManagement = {
      ...appState.roleManagement,
      actionStatus: '',
      actionError: error.message || 'Could not update the role.'
    };
    renderApp();
  }
}

function dismissRoleManagementToast() {
  if (roleManagementToastTimer) {
    window.clearTimeout(roleManagementToastTimer);
    roleManagementToastTimer = null;
  }
  appState.roleManagement = {
    ...appState.roleManagement,
    toast: null
  };
  renderApp();
}

function showRoleManagementToast(message, type = 'success') {
  if (roleManagementToastTimer) window.clearTimeout(roleManagementToastTimer);
  appState.roleManagement = {
    ...appState.roleManagement,
    toast: { message, type }
  };
  renderApp();
  roleManagementToastTimer = window.setTimeout(() => {
    if (appState.roleManagement.toast?.message === message) {
      appState.roleManagement = {
        ...appState.roleManagement,
        toast: null
      };
      renderApp();
    }
    roleManagementToastTimer = null;
  }, 2600);
}

function denyModuleAction(moduleKey, message) {
  if (!moduleKey || !appState[moduleKey]) return;
  appState[moduleKey] = {
    ...appState[moduleKey],
    actionError: message
  };
  renderApp();
}

function withPermission(moduleKey, permissionId, handler, message = 'You do not have permission to do that.') {
  return (...args) => {
    if (!hasPermission(permissionId, appState.access.currentRole, appState.access.customRoles || [])) {
      denyModuleAction(moduleKey, message);
      return;
    }
    return handler(...args);
  };
}

function isCurrentSuperUser() {
  const role = normalizeRoleName(appState.access?.currentRole || '');
  return appState.access?.currentIsSuperUser === true ||
    ['super', 'super-user', 'superuser', 'root'].includes(role);
}

function canCurrentUserManagePermissionSets() {
  return canManagePermissionSets(appState.access?.currentRole, appState.access?.currentIsSuperUser);
}

function createCreditNoteLineDetailEntry(line, index) {
  const packSize = getPositivePackSizeValue(line.packSize);
  const returnedQty = Number(line.returnedQty ?? line.packQty ?? 0) || 0;
  const unitCost = Number(line.unitCost || 0) || 0;
  const packPriceEx = unitCost * packSize;
  const pricesIncludeVat = appState.creditNotes.draftNote?.pricesIncludeVat;
  const vatFactor = pricesIncludeVat && line.vatEnabled !== false ? (1 + (getVatRate() / 100)) : 1;
  return {
    stockItemId: resolveStockItemIdFromLine(line),
    id: line.id || '',
    stockItemName: line.stockItemName || '',
    category: line.category || '',
    unit: line.unit || 'ea',
    selectedUom: line.selectedUom || line.returnUom || line.receivingUom || line.purchaseUom || line.unit || 'ea',
    returnUom: line.selectedUom || line.returnUom || line.receivingUom || line.purchaseUom || line.unit || 'ea',
    uomConfigurations: normalizeLineUomConfigurations(line.uomConfigurations || line.uomConfig || line.uomConversions),
    returnedQty: String(returnedQty || ''),
    packSize: String(packSize),
    unitCost: String(unitCost || ''),
    packPriceDisplay: String(Number((packPriceEx * vatFactor).toFixed(2))),
    vatEnabled: line.vatEnabled !== false,
    locationId: line.locationId || '',
    locationName: line.locationName || '',
    sourceIndex: index,
    originalOrderQty: Number(line.originalOrderQty ?? line.maxReturnQty ?? 0) || 0,
    maxReturnQty: Number(line.maxReturnQty ?? line.originalOrderQty ?? 0) || 0
  };
}

function resolveStockItemIdFromLine(line = {}) {
  return String(
    line.stockItemId ||
    line.ingredientId ||
    line.ingId ||
    line.itemId ||
    line.stock_item_id ||
    line.id ||
    ''
  ).trim();
}

function createEmptyCreditNoteDraft(seed = {}) {
  return {
    id: '',
    supplierId: '',
    supplierName: '',
    cnNumber: '',
    date: todayLocal(),
    siteId: '',
    siteName: '',
    locationId: 'main',
    locationName: 'Main Store',
    sourceType: '',
    sourceGrvId: '',
    sourceGrvNumber: '',
    sourcePoId: '',
    poNumber: '',
    sourceInvoice: '',
    sourceReceiptIds: [],
    sourceReceiptNumbers: [],
    pricesIncludeVat: false,
    notes: '',
    items: [],
    ...seed
  };
}

function createEmptyAdjustmentDraft(seed = {}) {
  return {
    mode: 'remove',
    siteId: '',
    siteName: '',
    locationId: 'main',
    locationName: 'Main Store',
    note: '',
    wasteReason: '',
    items: [],
    ...seed
  };
}

function createEmptyTransferDraft(seed = {}) {
  return {
    fromSiteId: '',
    fromSiteName: '',
    fromLocationId: '',
    fromLocationName: '',
    toSiteId: '',
    toSiteName: '',
    toLocationId: '',
    toLocationName: '',
    externalSiteId: '',
    externalSiteName: '',
    externalLocationId: '',
    externalLocationName: '',
    note: '',
    items: [],
    ...seed
  };
}

function createEmptyTransferTemplateDraft(seed = {}) {
  const items = Array.isArray(seed.items) ? seed.items : [];
  return {
    id: String(seed.id || '').trim(),
    name: String(seed.name || '').trim(),
    notes: String(seed.notes || '').trim(),
    selectedStockIds: items.map((item) => String(item.stockItemId || item.id || '')).filter(Boolean),
    createdAt: seed.createdAt || '',
    ...seed
  };
}

function createEmptyStockTakeDraft(seed = {}) {
  return {
    id: '',
    siteId: '',
    siteName: '',
    locationId: 'main',
    locationName: 'Main Store',
    date: todayLocal(),
    templateId: '',
    templateName: '',
    templateScope: '',
    templateSelections: [],
    sessionMode: 'quick',
    note: '',
    items: [],
    ...seed
  };
}

function createEmptyManufacturingBlueprintDraft(seed = {}) {
  return {
    id: '',
    name: '',
    unit: '',
    category: '',
    itemType: 'manufactured',
    yieldBatch: 1,
    recipe: [],
    componentPickerOpen: false,
    componentPickerSelection: [],
    ...seed
  };
}

function createEmptyManufacturingBatchDraft(seed = {}) {
  return {
    manufacturedItemId: '',
    itemName: '',
    siteId: '',
    siteName: '',
    locationId: '',
    locationName: '',
    batchMultiplier: 1,
    unit: 'ea',
    unitCost: 0,
    expectedQty: 1,
    producedQty: 1,
    date: todayLocal(),
    note: '',
    ...seed
  };
}

function createEmptyManufacturingProductionDraft(seed = {}) {
  return {
    note: '',
    date: todayLocal(),
    siteId: '',
    siteName: '',
    locationId: '',
    locationName: '',
    batchCounts: {},
    actuals: {},
    ...seed
  };
}

function createDefaultSettingsDraft(seed = {}) {
  return normalizeSettings({
    siteName: '',
    vatRate: 15,
    tradingTime: '23:59',
    reportingDayFromHour: 0,
    reportingDayToHour: 0,
    tradingDayStartHour: 0,
    tradingDayStartMinutes: 0,
    uiScale: 'normal',
    logoutTimeout: 30,
    costingMethod: 'last',
    yocoCategoryMap: {},
    stockCategoryRoutingMap: {},
    restaurantThemeId: DEFAULT_RESTAURANT_THEME_ID,
    restaurantBackgroundId: DEFAULT_RESTAURANT_BACKGROUND_ID,
    restaurantLogoDataUrl: '',
    restaurantLogoName: '',
    restaurantBackgroundDataUrl: '',
    restaurantBackgroundName: '',
    orgId: '',
    corpId: '',
    viewingOnly: false,
    stockDepletionEnabled: false,
    stockDepletionEnabledAt: '',
    ...seed
  });
}

function createEmptyStockTakeSessionSetup(seed = {}) {
  return {
    templateId: '',
    siteId: '',
    locationId: 'main',
    date: todayLocal(),
    ...seed
  };
}

function createEmptyStockTakeTemplateDraft(seed = {}) {
  return {
    id: '',
    name: '',
    siteId: '',
    siteName: '',
    targetLocation: 'main',
    targetLocations: ['main'],
    scope: 'category',
    selections: [],
    ...seed
  };
}

function estimateAdjustmentImpact(line, mode, stockItems = [], locations = []) {
  const item = stockItems.find((stockItem) => String(stockItem.id) === String(line.stockItemId));
  const unitCost = Number(line.unitCost || item?.cost || 0) || 0;
  const quantity = parseAdjustmentQuantity(line.quantity);
  if (mode === 'add') return quantity * unitCost;
  if (mode === 'remove') return -quantity * unitCost;
  const currentLevel = getLocationStock(item, line.locationId, locations);
  return (quantity - currentLevel) * unitCost;
}

function parseAdjustmentQuantity(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isAdjustmentQuantityEntered(value) {
  return String(value ?? '').trim() !== '';
}

function getLocationStock(item, locationId, locations = []) {
  if (!item) return 0;
  const balances = item.balances && typeof item.balances === 'object' ? item.balances : {};
  const key = String(locationId || '').trim();
  if (key && Object.keys(balances).length) {
    if (Object.prototype.hasOwnProperty.call(balances, key)) {
      return Number(balances[key] || 0) || 0;
    }

    const location = getLocationById(locations, key);
    const candidates = [key, location?.id, location?.locationId, location?.name, location?.displayName]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      if (Object.prototype.hasOwnProperty.call(balances, candidate)) {
        return Number(balances[candidate] || 0) || 0;
      }
    }
    const normalizedCandidates = new Set(candidates.map(normalizeLocationKey).filter(Boolean));
    const match = Object.keys(balances).find((balanceKey) => normalizedCandidates.has(normalizeLocationKey(balanceKey)));
    return match ? Number(balances[match] || 0) || 0 : 0;
  }
  return Number(item.stock || 0) || 0;
}

function normalizeLocationKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function getLocationById(locations = [], locationId = '') {
  const id = String(locationId || '').trim();
  const normalizedId = normalizeLocationKey(id);
  const isDefaultAlias = ['main', 'default', 'mainstore', 'mainstorage', 'locmain'].includes(normalizedId);
  return (locations || []).find((entry) => (
    String(entry.id || '') === id ||
    String(entry.locationId || '') === id ||
    String(entry.name || '') === id ||
    String(entry.displayName || '') === id ||
    (isDefaultAlias && (entry.isDefault === true || normalizeLocationKey(entry.id || entry.locationId) === 'locmain'))
  )) || null;
}

function getDefaultLocation(locations = []) {
  return (locations || []).find((location) => location.isDefault === true) ||
    (locations || []).find((location) => ['main', 'locmain', 'mainstore'].includes(normalizeLocationKey(location.id || location.locationId || location.name))) ||
    (locations || [])[0] ||
    null;
}

function getLocationNameById(locations = [], locationId = '', fallback = 'Main Store') {
  const location = getLocationById(locations, locationId);
  return location?.displayName || location?.name || fallback;
}

function getSiteIdForLocation(locations = [], locationId = '') {
  return String(getLocationById(locations, locationId)?.siteId || '');
}

function getSiteNameById(sites = [], siteId = '', fallback = '') {
  return sites.find((site) => String(site.id) === String(siteId))?.name || fallback;
}

function getLinkedTransferProfileById(profiles = [], profileId = '') {
  return (profiles || []).find((profile) => String(profile.id) === String(profileId)) || null;
}

function getLinkedProfileLocationById(profile = null, locationId = '') {
  return (profile?.locations || []).find((location) => String(location.id) === String(locationId)) || null;
}

function getFirstLocationIdForSite(locations = [], siteId = '') {
  const matches = (locations || []).filter((location) => !siteId || String(location.siteId || '') === String(siteId));
  const location = getDefaultLocation(matches) || matches[0];
  return String(location?.id || '');
}

function getOnlyLocationIdForSite(locations = [], siteId = '') {
  const matches = (locations || []).filter((location) => !siteId || String(location.siteId || '') === String(siteId));
  return matches.length === 1 ? String(matches[0]?.id || '') : '';
}

function isLocationInSite(locations = [], locationId = '', siteId = '') {
  const id = String(locationId || '').trim();
  if (!id) return false;
  const location = (locations || []).find((entry) => String(entry.id) === id);
  if (!location) return false;
  return !siteId || String(location.siteId || '') === String(siteId);
}

function getDefaultSiteIdForLocations(sites = [], locations = []) {
  const defaultLocation = getDefaultLocation(locations || []);
  return getSiteIdForLocation(locations, defaultLocation?.id || defaultLocation?.locationId || locations?.[0]?.id || '')
    || String((sites || []).find((site) => site.isDefault)?.id || sites?.[0]?.id || '');
}

function renderApp() {
  if (!app) return;

  // Do not mount protected workspace modules until the authenticated user's workspace
  // role and permissions have resolved. Rendering with the temporary empty access state
  // causes false "no permission" screens and forces users to leave and re-enter tabs.
  if (appState.user && appState.workspace && appState.access?.status === 'loading') {
    const mountedProtectedMain = app.querySelector('[data-app-main]');
    const canPreserveMountedModule = ['dashboard', 'reporting', 'reporting-scheduling'].includes(appState.route.active)
      && mountedProtectedMain?.dataset.activeModule === appState.route.active
      && mountedProtectedMain.dataset.workspaceId === String(appState.workspace.id || '');
    if (canPreserveMountedModule) {
      // Access subscriptions can briefly re-enter loading while refreshing. Keep the already
      // authenticated module mounted instead of replacing the whole app with a boot screen.
      return;
    }
    renderBoot('Loading your workspace permissions...');
    return;
  }
  // Never replace the DOM while the user is actively typing in a text field.
  // The silent-update pattern keeps appState in sync; the next render after blur picks it up.
  const _active = document.activeElement;
  if (_active && _active.tagName === 'SELECT') return;
  if (
    _active &&
    (_active.tagName === 'INPUT' || _active.tagName === 'TEXTAREA') &&
    _active.type !== 'checkbox' &&
    _active.type !== 'radio' &&
    _active.type !== 'range' &&
    _active.type !== 'search'
  ) {
    return;
  }
  if (
    appState.user &&
    appState.workspace &&
    appState.route.active === 'integrations' &&
    window.__KCP_SUPPRESS_INTEGRATIONS_RENDER__ === true
  ) {
    return;
  }
  const mountedMain = app.querySelector('[data-app-main]');
  if (
    appState.user &&
    appState.workspace &&
    ['dashboard', 'reporting', 'reporting-scheduling'].includes(appState.route.active) &&
    mountedMain?.dataset.activeModule === appState.route.active &&
    mountedMain.dataset.workspaceId === String(appState.workspace.id || '') &&
    mountedMain.dataset.accessRevision === getAccessRenderRevision(appState.access)
  ) {
    // Dashboard and Reporting both manage their own async data, filters, charts, and
    // interaction state. Unrelated background snapshots must not replace their DOM.
    mountImportNotificationModal();
    mountOnboardingWizard();
    syncAppModalScrollLock();
    return;
  }
  const activeField = captureActiveField() || pendingFocusField;
  const scrollSnapshots = captureScrollSnapshots();

  if (!appState.user || !appState.workspace) {
    replaceApp(renderLogin({
      authState: appState.auth,
      user: appState.user,
      workspaceOptions: appState.workspaceOptions,
      autoLoginPreference: appState.autoLoginPreference,
      workspaceError: appState.workspaceError,
      onWorkspaceSelect: (workspace, options) => selectWorkspace(workspace, options),
      onSignOut: () => signOutAndStop(),
      onAuthModeChange: (mode = 'login') => {
        appState.auth = { status: 'idle', error: '', mode };
        renderApp();
      },
      onRegistrationPending: (result = {}) => {
        appState.auth = {
          status: 'registration-pending',
          error: '',
          mode: 'register',
          provider: result.provider || '',
          message: `Your request for ${result.siteName || 'this workspace'} has been sent for admin approval.`
        };
        renderApp();
      },
      onPasswordChangeComplete: () => {
        appState.auth = { status: 'loading', error: '' };
        handlePostPasswordChange();
      },
      onResetTokenComplete: () => {
        // Strip the resetToken from the URL so a refresh doesn't re-trigger the form
        const url = new URL(window.location.href);
        url.searchParams.delete('resetToken');
        window.history.replaceState({}, '', url);
        appState.auth = { status: 'idle', error: 'Password updated. Please sign in with your new password.', mode: 'login' };
        renderApp();
      },
      onBusy: (message = '', mode = appState.auth.mode || 'login') => {
        appState.auth = { status: 'loading', error: message, mode };
        renderApp();
      },
      onError: (message, mode = appState.auth.mode || 'login') => {
        appState.auth = {
          status: mode === 'set-password'
            ? 'force-password-reset'
            : mode === 'reset-token'
            ? 'idle'
            : mode === 'register'
              ? 'idle'
              : appState.user && !appState.workspace
              ? 'workspace-select'
              : 'idle',
          error: message,
          mode,
          resetToken: mode === 'reset-token' ? appState.auth.resetToken : undefined
        };
        renderApp();
      }
    }));
    mountImportNotificationModal();
    restoreActiveField(activeField);
    restoreScrollSnapshots(scrollSnapshots);
    syncAppModalScrollLock();
    return;
  }

  replaceApp(renderAuthenticatedApp({
    state: appState,
    onNavigate: navigateTo,
    onSignOut: () => signOutAndStop(),
    onWorkspaceSelect: (workspace) => selectWorkspace(workspace),
    onAutoLoginToggle: toggleAutoLoginPreference,
    onThemeToggle: toggleTheme,
    onMenuFilterChange: updateMenuFilters,
    onMenuAction: {
      onSelect: updateMenuSelection,
      onSelectAll: updateAllMenuSelection,
      onEdit: openMenuEditor,
      onPriceLocationChange: updateMenuPriceLocation,
      onTogglePriceLocationDropdown: toggleMenuPriceLocationDropdown,
      onCloseEdit: closeMenuEditor,
      onSaveEdit: saveMenuItem,
      onRequestDelete: withPermission('menu', ACTION_PERMISSION_MAP.deleteRecords, requestMenuDelete, 'You do not have permission to delete menu items.'),
      onManageCategories: openMenuCategoryManager,
      onCloseCategoryManager: closeMenuCategoryManager,
      onCategoryDraftChange: updateMenuCategoryDraft,
      onCategoryCreate: createMenuCategory,
      onCategoryRenameStart: startMenuCategoryRename,
      onCategoryRenameChange: updateMenuCategoryEditing,
      onCategoryRenameSave: saveMenuCategoryRename,
      onCategoryRenameCancel: cancelMenuCategoryRename,
      onCategoryDelete: deleteMenuCategory,
      onOpenRecipe: openRecipeSetupFromMenu,
      onConfigureModifier: openMenuModifierEditor,
      onOpenModifierLinks: openMenuModifierLinks,
      onCloseModifierLinks: closeMenuModifierLinks,
      onCloseModifier: closeMenuModifierEditor,
      onSaveModifier: saveMenuModifierRule,
      onModifierStockRuleChange: updateMenuModifierStockRule,
      onOpenModifierStockPicker: openMenuModifierStockPicker,
      onCloseModifierStockPicker: closeMenuModifierStockPicker,
      onModifierStockPickerSearch: searchMenuModifierStockPicker,
      onModifierStockPickerSelect: selectMenuModifierStockPicker,
      onOpenNoteSuggestions: openMenuNoteSuggestions,
      onCloseNoteSuggestions: closeMenuNoteSuggestions,
      onRefreshNoteSuggestions: refreshMenuNoteSuggestions,
      onStartNoteRuleSetup: startMenuNoteRuleSetup,
      onCancelNoteRuleSetup: cancelMenuNoteRuleSetup,
      onNoteRuleDraftChange: updateMenuNoteRuleDraft,
      onSaveNoteRule: saveMenuNoteRule,
      onIgnoreNoteSuggestion: (noteText) => setMenuNoteSuggestionDisposition(noteText, 'IGNORED'),
      onRestoreNoteSuggestion: (noteText) => setMenuNoteSuggestionDisposition(noteText, 'SUGGESTED'),
      onToggleIgnoredNoteSuggestions: toggleMenuIgnoredNoteSuggestions,
	      onPreserveFocus: preserveFieldFocus,
	      onConfirmDelete: withPermission('menu', ACTION_PERMISSION_MAP.deleteRecords, confirmMenuDelete, 'You do not have permission to delete menu items.'),
	      onCancelDelete: cancelMenuDelete,
	      onImport: importMenuFile,
	      onExport: exportMenuCatalogue,
	      onScanBarcode: scanMenuBarcode,
	      onDismissToast: dismissMenuToast
	    },
	    onRecipeFilterChange: updateRecipeFilters,
	    onRecipeAction: {
	      onPreserveFocus: preserveFieldFocus,
	      onSelect: updateRecipeSelection,
	      onSelectAll: updateAllRecipeSelection,
	      onOpen: openRecipeEditor,
	      onClose: closeRecipeEditor,
	      onLineChange: updateRecipeLine,
      onLineUomChange: updateRecipeLineUom,
      onPickerUomChange: updatePickerUom,
	      onLineRemove: removeRecipeLine,
	      onLineRemoveConfirm: confirmRecipeLineRemoval,
	      onLineRemoveCancel: cancelRecipeLineRemoval,
	      onAddIngredient: addRecipeIngredient,
	      onFocusSearch: focusRecipeSearch,
	      onOpenPicker: openRecipeIngredientPicker,
	      onClosePicker: closeRecipeIngredientPicker,
	      onPickerToggle: toggleRecipePickerItem,
	      onPickerSelectAll: selectAllVisibleRecipePickerItems,
	      onPickerClear: clearRecipePickerSelection,
	      onPickerConfirm: confirmRecipePickerSelection,
	      onPickerBack: backToRecipePickerSelection,
	      onPickerQtyChange: updateRecipePickerQuantity,
	      onPickerApply: applyRecipePickerSelection,
		      onModifierLinkChange: updateRecipeModifierProductLink,
		      onModifierLinkToggle: toggleRecipeModifierProductLink,
          onModifierStockRuleChange: updateRecipeModifierStockRule,
          onOpenModifierStockPicker: openRecipeModifierStockPicker,
          onCloseModifierStockPicker: closeRecipeModifierStockPicker,
          onModifierStockPickerSearch: searchRecipeModifierStockPicker,
          onModifierStockPickerSelect: selectRecipeModifierStockPicker,
	      onOpenNoteSuggestions: openRecipeNoteSuggestions,
	      onCloseNoteSuggestions: closeRecipeNoteSuggestions,
	      onRefreshNoteSuggestions: refreshRecipeNoteSuggestions,
	      onStartNoteRuleSetup: startRecipeNoteRuleSetup,
	      onCancelNoteRuleSetup: cancelRecipeNoteRuleSetup,
	      onNoteRuleDraftChange: updateRecipeNoteRuleDraft,
	      onSaveNoteRule: saveRecipeNoteRule,
	      onIgnoreNoteSuggestion: (noteText) => setRecipeNoteSuggestionDisposition(noteText, 'IGNORED'),
	      onRestoreNoteSuggestion: (noteText) => setRecipeNoteSuggestionDisposition(noteText, 'SUGGESTED'),
	      onToggleIgnoredNoteSuggestions: toggleRecipeIgnoredNoteSuggestions,
		      onRecipeSourceStockItemChange: updateRecipeSourceStockItem,
		      onScanBarcode: scanRecipeIngredientBarcode,
	      onSave: saveCurrentRecipe,
	      onRequestDelete: withPermission('recipes', ACTION_PERMISSION_MAP.deleteRecords, requestRecipeDelete, 'You do not have permission to delete recipes.'),
	      onConfirmDelete: withPermission('recipes', ACTION_PERMISSION_MAP.deleteRecords, confirmRecipeDelete, 'You do not have permission to delete recipes.'),
	      onCancelDelete: cancelRecipeDelete,
	      onImport: importRecipeFile,
	      onExport: exportRecipes,
	      onDismissToast: dismissRecipeToast
	    },
    onStockFilterChange: updateStockFilters,
    onStockAction: {
      onSelect: updateStockSelection,
      onSelectAll: updateAllStockSelection,
      onEdit: openStockEditor,
      onClose: closeStockEditor,
      onOpenManager: openStockTaxonomyManager,
      onCloseManager: closeStockTaxonomyManager,
      onManagerDraftChange: updateStockTaxonomyDraft,
      onManagerSearchChange: updateStockTaxonomySearch,
      onManagerRenameStart: startStockTaxonomyRename,
      onManagerRenameChange: updateStockTaxonomyEditing,
      onManagerRenameCancel: cancelStockTaxonomyRename,
      onManagerCreate: createStockTaxonomyEntry,
      onManagerRenameSave: saveStockTaxonomyRename,
      onManagerDelete: withPermission('stock', ACTION_PERMISSION_MAP.deleteRecords, deleteStockTaxonomyEntry, 'You do not have permission to delete stock categories or units.'),
      onOpenLookup: openStockLookupPicker,
      onLookupFieldChange: updateStockLookupField,
      onCloseLookup: closeStockLookupPicker,
      onLookupSearch: updateStockLookupPickerQuery,
      onLookupUse: useStockLookupPickerValue,
      onPreserveFocus: preserveFieldFocus,
      onDraftFieldChange: updateStockDraftField,
      onToggleEditorSection: toggleStockEditorSection,
      onOpenRecipeScreen: openStockRecipeScreen,
      onCloseRecipeScreen: closeStockRecipeScreen,
      onRecipeSearchChange: updateStockRecipeSearch,
      onRecipeLineAdd: addStockRecipeLine,
      onRecipeLineRemove: removeStockRecipeLine,
      onRecipeLineQtyChange: updateStockRecipeLineQty,
      onScanBarcode: scanStockBarcode,
      onSave: saveStockItem,
      onDeleteCategory: deleteStockCategory,
      onRequestDelete: withPermission('stock', ACTION_PERMISSION_MAP.deleteRecords, requestStockDelete, 'You do not have permission to delete stock items.'),
      onConfirmDelete: withPermission('stock', ACTION_PERMISSION_MAP.deleteRecords, confirmStockDelete, 'You do not have permission to delete stock items.'),
      onCancelDelete: cancelStockDelete,
      onImport: importStockFile,
      onExport: exportStockItems,
      onLocationCostingExport: exportLocationCostingSheet,
      onLocationCostingImport: importLocationCostingFile,
      onLocationCostingConfirm: confirmLocationCostingImport,
      onLocationCostingCancel: cancelLocationCostingImport,
      onDismissImportReview: dismissStockImportReview,
      onDismissToast: dismissStockToast
    },
    onSupplierFilterChange: updateSupplierFilters,
    onSupplierAction: {
      onSelect: updateSupplierSelection,
      onSelectAll: updateAllSupplierSelection,
      onEdit: openSupplierEditor,
      onPreserveFocus: preserveFieldFocus,
      onDraftChange: updateSupplierDraft,
      onDraftChangeSilent: updateSupplierDraftSilent,
      onClose: closeSupplierEditor,
      onSave: saveSupplier,
      onRequestDelete: withPermission('suppliers', ACTION_PERMISSION_MAP.deleteRecords, requestSupplierDelete, 'You do not have permission to delete suppliers.'),
      onConfirmDelete: withPermission('suppliers', ACTION_PERMISSION_MAP.deleteRecords, confirmSupplierDelete, 'You do not have permission to delete suppliers.'),
      onCancelDelete: cancelSupplierDelete,
      onImport: importSupplierFile,
      onExport: exportSuppliers,
      onDismissToast: dismissSupplierToast
    },
    onPurchaseOrderFilterChange: updatePurchaseOrderFilters,
    onPurchaseOrderAction: {
      onSelect: updatePurchaseOrderSelection,
      onSelectAll: updateAllPurchaseOrderSelection,
      onNew: () => openPurchaseOrderDraft(null),
      onCreateFromLowStock: openPurchaseOrderFromReportingLowStock,
      onEdit: openPurchaseOrderDraft,
      onClose: closePurchaseOrderDraft,
      onPreserveFocus: preserveFieldFocus,
      onDraftChange: updatePurchaseOrderDraft,
      onDraftChangeSilent: updatePurchaseOrderDraftSilent,
      onAddLine: addPurchaseOrderLine,
      onScanBarcode: scanPurchaseOrderBarcode,
      onUpdateLine: updatePurchaseOrderLine,
      onUpdateLineSilent: updatePurchaseOrderLineSilent,
      onRemoveLine: withPermission('purchaseOrders', ACTION_PERMISSION_MAP.deleteRecords, removePurchaseOrderLine, 'You do not have permission to remove purchase order lines.'),
      onSave: savePurchaseOrder,
      onStatus: updatePurchaseOrderStatus,
      onSend: sendPurchaseOrder,
      onRequestDelete: withPermission('purchaseOrders', ACTION_PERMISSION_MAP.deleteRecords, requestPurchaseOrderDelete, 'You do not have permission to delete purchase orders.'),
      onConfirmDelete: withPermission('purchaseOrders', ACTION_PERMISSION_MAP.deleteRecords, confirmPurchaseOrderDelete, 'You do not have permission to delete purchase orders.'),
      onCancelDelete: cancelPurchaseOrderDelete,
      onDismissGmailPrompt: () => {
        appState.purchaseOrders = { ...appState.purchaseOrders, gmailPrompt: false };
        renderApp();
      },
      onNavigateToIntegrations: () => {
        appState.purchaseOrders = { ...appState.purchaseOrders, gmailPrompt: false };
        navigateTo('integrations');
      },
      onExportCsv: exportPurchaseOrdersCsv,
      onExportXlsx: exportPurchaseOrdersXlsx,
      onExportPdf: exportPurchaseOrderPdf,
      onDismissToast: dismissPurchaseOrderToast
    },
    onGrvFilterChange: updateGrvFilters,
    onGrvAction: {
      onManual: openManualGrvDraft,
      onEnsureDraft: ensureGrvDraft,
      onPreserveFocus: preserveFieldFocus,
      onLoadLastInvoice: loadLastGrvInvoice,
      onConvertPo: openGrvFromPurchaseOrder,
      onOpenLineDetail: openGrvLineDetail,
      onUpdateLineDetailDraft: updateGrvLineDetailDraft,
      onUpdateLineDetailLocationAll: updateGrvLineDetailLocationAll,
      onApplyLineDetail: applyGrvLineDetail,
      onCancelLineDetail: cancelGrvLineDetail,
      onClose: closeGrvDraft,
      onDraftChange: updateGrvDraft,
      onAddLine: addGrvLine,
      onAddMultipleLines: addMultipleGrvLines,
      onUpdateLine: updateGrvLine,
      onSplitLine: splitGrvLine,
      onToggleLineSelection: toggleGrvLineSelection,
      onSelectAllLines: selectAllGrvLines,
      onRemoveSelectedLines: withPermission('grv', ACTION_PERMISSION_MAP.deleteRecords, removeSelectedGrvLines, 'You do not have permission to remove GRV lines.'),
      onRequestClearAll: withPermission('grv', ACTION_PERMISSION_MAP.deleteRecords, requestClearGrvLines, 'You do not have permission to clear GRV lines.'),
      onConfirmClearAll: withPermission('grv', ACTION_PERMISSION_MAP.deleteRecords, confirmClearGrvLines, 'You do not have permission to clear GRV lines.'),
      onCancelClearAll: cancelClearGrvLines,
      onRemoveLine: withPermission('grv', ACTION_PERMISSION_MAP.deleteRecords, removeGrvLine, 'You do not have permission to remove GRV lines.'),
      onScanBarcode: scanGrvBarcode,
      onOpenMissingSupplierForm: openGrvMissingSupplierForm,
      onContinueWithoutSupplier: continueGrvWithoutSupplier,
      onUpdateMissingSupplierField: updateGrvMissingSupplierField,
      onSaveMissingSupplier: saveGrvMissingSupplier,
      onDismissMissingSupplier: dismissGrvMissingSupplierPrompt,
      onSave: saveGrvReceipt,
      onExport: exportGrvReceipts,
      onDismissToast: dismissGrvToast
    },
    onCreditNoteFilterChange: updateCreditNoteFilters,
    onCreditNoteAction: {
      onPreserveFocus: preserveFieldFocus,
      onDraftChange: updateCreditNoteDraft,
      onToggleStockSelection: toggleCreditNoteStockSelection,
      onSelectAllShownStock: selectAllVisibleCreditNoteStock,
      onClearStockSelection: clearCreditNoteStockSelection,
      onToggleLineSelection: toggleCreditNoteLineSelection,
      onSelectAllLines: selectAllCreditNoteLines,
      onRemoveSelectedLines: withPermission('creditNotes', ACTION_PERMISSION_MAP.deleteRecords, removeSelectedCreditNoteLines, 'You do not have permission to remove credit note lines.'),
      onRequestClearAll: withPermission('creditNotes', ACTION_PERMISSION_MAP.deleteRecords, requestClearCreditNoteLines, 'You do not have permission to clear credit note lines.'),
      onConfirmClearAll: withPermission('creditNotes', ACTION_PERMISSION_MAP.deleteRecords, confirmClearCreditNoteLines, 'You do not have permission to clear credit note lines.'),
      onCancelClearAll: cancelClearCreditNoteLines,
      onAddSelectedStock: addCreditNoteSelectedStock,
      onHydrateFromGrv: hydrateCreditNoteFromGrv,
      onEditLine: openCreditNoteLineDetail,
      onUpdateLine: updateCreditNoteLine,
      onRemoveLine: withPermission('creditNotes', ACTION_PERMISSION_MAP.deleteRecords, removeCreditNoteLine, 'You do not have permission to remove credit note lines.'),
      onLineDetailChange: updateCreditNoteLineDetail,
      onLineDetailLocationChange: updateCreditNoteLineDetailLocationAll,
      onApplyLineDetail: applyCreditNoteLineDetail,
      onBackLineDetail: backCreditNoteLineDetail,
      onCloseLineDetail: closeCreditNoteLineDetail,
      onSave: saveCreditNoteDraft,
      onDismissToast: dismissCreditNoteToast
    },
    onAdjustmentFilterChange: updateAdjustmentFilters,
    onAdjustmentAction: {
      onPreserveFocus: preserveFieldFocus,
      onDraftChange: updateAdjustmentDraft,
      onToggleStockSelection: toggleAdjustmentStockSelection,
      onSelectAllVisibleStock: selectAllVisibleAdjustmentStock,
      onAddSelectedStock: addAdjustmentSelectedStock,
      onScanBarcode: scanAdjustmentBarcode,
      onEditLine: openAdjustmentLineDetail,
      onLineDetailMetaChange: updateAdjustmentLineDetailMeta,
      onRemoveLine: withPermission('adjustments', ACTION_PERMISSION_MAP.deleteRecords, removeAdjustmentLine, 'You do not have permission to remove adjustment lines.'),
      onLineDetailChange: updateAdjustmentLineDetail,
      onBackLineDetail: backAdjustmentLineDetail,
      onApplyLineDetail: applyAdjustmentLineDetail,
      onCloseLineDetail: closeAdjustmentLineDetail,
      onSave: saveAdjustmentDraft,
      onDismissToast: dismissAdjustmentToast,
      onToggleWastageSelection: toggleWastageSelection,
      onAddWastageSelected: addWastageSelectedProducts,
      onRemoveWastageLine: removeWastageLine,
      onWastageQtyChange: updateWastageQty,
      onWastageDraftChange: updateWastageDraft,
      onWastageSave: saveWastageDraft
    },
    onTransferFilterChange: updateTransferFilters,
    onTransferAction: {
      onPreserveFocus: preserveFieldFocus,
      onDraftChange: updateTransferDraft,
      onDraftLocationChange: updateTransferLocation,
      onToggleStockSelection: toggleTransferStockSelection,
      onScanStockSearch: scanTransferSearch,
      onSelectAllVisibleStock: selectAllVisibleTransferStock,
      onAddSelectedStock: addTransferSelectedStock,
      onLineChange: updateTransferLine,
      onRemoveLine: removeTransferLine,
      onSave: saveTransferDraft,
      onExportTemplate: exportTransferTemplate,
      onImportTemplate: importTransferTemplate,
      onOpenTemplateBuilder: openTransferTemplateBuilder,
      onUseTemplate: useTransferTemplateForBulk,
      onUpdateTemplateDraft: updateTransferTemplateDraft,
      onToggleTemplateStock: toggleTransferTemplateStockSelection,
      onSelectAllTemplateStock: selectAllVisibleTransferTemplateStock,
      onClearTemplateStock: clearTransferTemplateStockSelection,
      onSaveTemplate: saveTransferTemplateDraft,
      onDeleteTemplate: deleteTransferTemplateEntry,
      onReceiveQtyChange: updateExternalTransferReceiveQty,
      onAcceptExternalTransfer: acceptExternalTransferDraft,
      onRejectExternalTransfer: rejectExternalTransferDraft,
      onDismissToast: dismissTransferToast
    },
    onStockTakeFilterChange: updateStockTakeFilters,
    onStockTakeAction: {
      onPreserveFocus: preserveFieldFocus,
      onOpenStartSession: openStockTakeStartSession,
      onOpenQuickCount: openStockTakeQuickCount,
      onOpenBulkScan: openStockTakeBulkScan,
      onOpenTemplateManager: openStockTakeTemplateManager,
      onOpenTemplateEditor: openStockTakeTemplateEditor,
      onDiscardSpecificDraft: discardSpecificStockTakeDraft,
      onCloseOverlay: closeStockTakeOverlay,
      onCloseScanCount: closeStockTakeScanCountModal,
      onUpdateSessionSetup: updateStockTakeSessionSetup,
      onConfirmStartSession: startStockTakeFromTemplate,
      onConfirmQuickCount: startQuickStockTakeSession,
      onConfirmBulkScanSetup: confirmStockTakeBulkScanSetup,
      onFinaliseBulkScan: finaliseStockTakeBulkScan,
      onCancelSession: cancelStockTakeSession,
      onSaveDraftSession: saveStockTakeSessionDraft,
      onExportTemplatePdf: exportStockTakeTemplatePdf,
      onOpenCountTemplateLocationPicker: openStockTakeCountTemplateLocationPicker,
      onExportCountTemplate: exportStockTakeCountTemplate,
      onImportCountTemplate: importStockTakeCountTemplate,
      onRestoreSpecificDraft: restoreSpecificStockTakeDraft,
      onScanEnter: () => scanStockTakeBarcode('focus'),
      onScanCount: () => scanStockTakeBarcode('count'),
      onUpdateScanCountBarcode: updateStockTakeScanCountBarcode,
      onUpdateScanCountQuantity: updateStockTakeScanCountQuantity,
      onUpdateScanCountUom: updateStockTakeScanCountUom,
      onConfirmScanCountEntry: confirmStockTakeScanCountEntry,
      onOpenScanCamera: openStockTakeScanCameraModal,
      onCloseScanCamera: closeStockTakeScanCameraModal,
      onInitScanCamera: initStockTakeCameraScanner,
      onAdjustScanCameraQty: adjustStockTakeCameraItemQuantity,
      onRemoveScanCameraItem: removeStockTakeCameraItem,
      onClearScanCameraItems: clearStockTakeCameraItems,
      onApplyScanCameraItems: applyStockTakeCameraItems,
      onDraftChange: updateStockTakeDraft,
      onDraftLocationChange: updateStockTakeLocation,
      onUpdateTemplateDraft: updateStockTakeTemplateDraft,
      onSetTemplateScope: setStockTakeTemplateScope,
      onToggleTemplateLocation: toggleStockTakeTemplateLocation,
      onToggleTemplateSelection: toggleStockTakeTemplateSelection,
      onBulkTemplateSelection: bulkStockTakeTemplateSelection,
      onSaveTemplate: saveStockTakeTemplateDraft,
      onDeleteTemplate: withPermission('stockTake', ACTION_PERMISSION_MAP.deleteRecords, deleteStockTakeTemplateEntry, 'You do not have permission to delete stock take templates.'),
      onCountChange: updateStockTakeCount,
      onSave: saveStockTakeDraft,
      onDismissToast: dismissStockTakeToast
    },
    onLocationFilterChange: updateLocationFilters,
    onLocationAction: {
      onPreserveFocus: preserveFieldFocus,
      onOpenSiteCreate: openSiteCreate,
      onCloseSiteCreate: closeSiteCreate,
      onUpdateSiteDraft: updateSiteDraft,
      onSaveSite: saveNewSiteEntry,
      onOpenSiteEdit: openSiteEditor,
      onOpenSiteDetail: openSiteDetail,
      onCloseSiteDetail: closeSiteDetail,
      onCloseSiteEdit: closeSiteEditor,
      onUpdateSiteEditing: updateSiteEditing,
      onSaveSiteEdit: saveSiteEdit,
      onDeleteSite: withPermission('locations', ACTION_PERMISSION_MAP.deleteRecords, deleteSiteEntry, 'You do not have permission to delete sites.'),
      onOpenCreate: openLocationCreate,
      onCloseCreate: closeLocationCreate,
      onUpdateDraft: updateLocationDraft,
      onUpdateDraftRouting: updateLocationDraftRouting,
      onOpenRouting: openLocationRoutingModal,
      onCloseRouting: closeLocationRoutingModal,
      onAssignRouting: assignLocationRoutingCategory,
      onToggleSiteInfo: toggleLocationSiteInfoSection,
      onUpdateDraftName: updateLocationDraftName,
      onSaveNew: saveNewLocationEntry,
      onOpenEdit: openLocationEditor,
      onCloseEdit: closeLocationEditor,
      onUpdateEditing: updateLocationEditing,
      onUpdateEditingRouting: updateLocationEditingRouting,
      onUpdateEditingName: updateLocationEditingName,
      onSaveEdit: saveLocationEdit,
      onDelete: withPermission('locations', ACTION_PERMISSION_MAP.deleteRecords, deleteLocationEntry, 'You do not have permission to delete locations.'),
      onDismissToast: dismissLocationToast
    },
    onManufacturingFilterChange: updateManufacturingFilters,
    onManufacturingAction: {
      onPreserveFocus: preserveFieldFocus,
      onOpenBlueprint: openManufacturingBlueprint,
      onCloseBlueprint: closeManufacturingBlueprint,
      onUpdateBlueprint: updateManufacturingBlueprint,
      onOpenLookup: openManufacturingLookupPicker,
      onCloseLookup: closeManufacturingLookupPicker,
      onLookupSearch: updateManufacturingLookupPickerQuery,
      onLookupUse: useManufacturingLookupPickerValue,
      onAddComponent: addManufacturingComponent,
      onToggleComponentSelection: toggleManufacturingComponentSelection,
      onConfirmComponentSelection: confirmManufacturingComponentSelection,
      onUpdateRecipeLine: updateManufacturingRecipeLine,
      onRemoveRecipeLine: withPermission('manufacturing', ACTION_PERMISSION_MAP.deleteRecords, removeManufacturingRecipeLine, 'You do not have permission to remove blueprint ingredients.'),
      onSaveBlueprint: saveManufacturingBlueprint,
      onDeleteBlueprint: withPermission('manufacturing', ACTION_PERMISSION_MAP.deleteRecords, deleteManufacturingBlueprintEntry, 'You do not have permission to delete manufacturing blueprints.'),
      onOpenBatch: openManufacturingBatch,
      onCloseBatch: closeManufacturingBatch,
      onUpdateBatch: updateManufacturingBatch,
      onSaveBatch: saveManufacturingBatch,
      onUpdateProductionDraft: updateManufacturingProductionDraft,
      onUpdateProductionBatches: updateManufacturingProductionBatches,
      onUpdateProductionActual: updateManufacturingProductionActual,
      onSaveProductionEvent: saveManufacturingProductionEvent,
      onImport: importManufacturingFile,
      onExport: exportManufacturingItems,
      onDismissToast: dismissManufacturingToast
    },
    onUserManagementFilterChange: updateUserManagementFilters,
    onUserManagementAction: {
      onPreserveFocus: preserveFieldFocus,
      onOpenCreate: openUserManagementCreateModal,
      onCloseCreate: closeUserManagementCreateModal,
      onNextStep: nextUserManagementCreateStep,
      onPrevStep: prevUserManagementCreateStep,
      onDraftChange: updateUserManagementDraft,
      onLocationToggle: toggleUserManagementDraftLocation,
      onLocationSelectAll: selectAllUserManagementDraftLocations,
      onResendInvite: resendUserManagementInvite,
      onCreate: createUserManagementMember,
      onOpenEdit: openUserManagementEditor,
      onCloseEdit: closeUserManagementEditor,
      onEditTabChange: setUserManagementEditTab,
      onEditChange: updateUserManagementEdit,
      onEditLocationToggle: toggleUserManagementEditLocation,
      onEditLocationSelectAll: selectAllUserManagementEditLocations,
      onSaveEdit: saveUserManagementEdit,
      onRequestRemove: requestUserManagementRemove,
      onConfirmRemove: confirmUserManagementRemove,
      onCancelRemove: cancelUserManagementRemove,
      onDismissToast: dismissUserManagementToast
    },
    onRoleManagementAction: {
      onPreserveFocus: preserveFieldFocus,
      onOpenEditor: openRoleManagementEditor,
      onCloseEditor: closeRoleManagementEditor,
      onUpdateEditor: updateRoleManagementEditor,
      onTogglePermission: toggleRoleManagementPermission,
      onToggleLocation: toggleRoleManagementLocation,
      onToggleAllLocations: toggleRoleManagementAllLocations,
      onSave: saveRoleManagementEditor,
      onRequestDelete: requestRoleManagementDelete,
      onConfirmDelete: confirmRoleManagementDelete,
      onCancelDelete: cancelRoleManagementDelete,
      onDismissToast: dismissRoleManagementToast
    },
    onSettingsAction: {
      onPreserveFocus: preserveFieldFocus,
      onDraftChange: updateSettingsDraft,
      onDraftChangeSilent: updateSettingsDraftSilent,
      onTaxFieldChangeSilent: updateSettingsTaxFieldSilent,
      onDropdownToggle: toggleSettingsDropdown,
      onOpenStockRoutingModal: openStockRoutingModal,
      onCloseStockRoutingModal: closeStockRoutingModal,
      onStockCategoryRoutingChange: updateStockCategoryRouting,
      onOpenAppearanceModal: openAppearanceModal,
      onCloseAppearanceModal: closeAppearanceModal,
      onThemePresetChange: updateRestaurantThemePreset,
      onBackgroundPresetChange: updateRestaurantBackgroundPreset,
      onToggleThemeGallery: toggleSettingsThemeGallery,
      onLogoUpload: uploadRestaurantLogo,
      onLogoClear: clearRestaurantLogo,
      onBackgroundUpload: uploadRestaurantBackground,
      onBackgroundClear: clearRestaurantBackground,
      onSave: saveSettingsDraft,
      onVatRegisteredToggle: requestVatRegisteredToggle,
      onSaveAppearance: saveAppearanceSettingsDraft,
      onGoLive: confirmGoLiveStockDepletion,
      onRelaunchOnboarding: relaunchOnboardingWizard,
      onExportSnapshot: exportSettingsSnapshot,
      onImportSnapshot: importSettingsSnapshot,
      onRequestResetTotals: requestResetStockTotals,
      onResetConfirmTextChange: updateResetTotalsConfirmText,
      onConfirmResetTotals: confirmResetStockTotals,
      onCancelResetTotals: cancelResetStockTotals,
      onDismissToast: dismissSettingsToast
    }
  }));
  mountImportNotificationModal();
  mountOnboardingWizard();
  restoreActiveField(activeField);
  restoreScrollSnapshots(scrollSnapshots);
  syncAppModalScrollLock();
  scheduleAppDropdownPortalRefresh();
  startLiveClock();
  updateLiveClockNodes();
  scheduleDeferredRealtimeSnapshotFlush();
}

function showImportNotification({
  moduleLabel = 'Import',
  title = 'Import Needs Attention',
  message = 'Fix the listed rows and try the import again.',
  errors = [],
  importedCount = 0,
  skippedCount = 0,
  totalRows = 0,
  tone = 'error',
  confirmLabel = 'Confirm & Try Again'
} = {}) {
  appState.importNotification = {
    moduleLabel,
    title,
    message,
    errors: normalizeImportNotificationErrors(errors),
    importedCount: Number(importedCount || 0) || 0,
    skippedCount: Number(skippedCount || 0) || 0,
    totalRows: Number(totalRows || 0) || 0,
    tone: tone === 'warning' ? 'warning' : 'error',
    confirmLabel
  };
  renderApp();
}

function dismissImportNotification() {
  appState.importNotification = null;
  renderApp();
}

function mountImportNotificationModal() {
  app?.querySelector('[data-import-notification-modal]')?.remove();
  const notification = appState.importNotification;
  if (!notification) return;

  const overlay = document.createElement('div');
  overlay.className = `importNotification importNotification--${notification.tone || 'error'}`;
  overlay.dataset.importNotificationModal = 'true';
  overlay.innerHTML = `
    <section class="importNotification__card" role="dialog" aria-modal="true" aria-labelledby="import-notification-title" tabindex="-1">
      <div class="importNotification__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>
        </svg>
      </div>
      <p>${escapeImportNotificationText(notification.moduleLabel || 'Import')}</p>
      <h2 id="import-notification-title">${escapeImportNotificationText(notification.title || 'Import Needs Attention')}</h2>
      <span>${escapeImportNotificationText(notification.message || 'Fix the listed rows and try the import again.')}</span>
      ${renderImportNotificationSummary(notification)}
      ${renderImportNotificationErrors(notification.errors || [])}
      <div class="importNotification__actions">
        <button type="button" class="importNotification__primary" data-import-notification-confirm>${escapeImportNotificationText(notification.confirmLabel || 'Confirm')}</button>
      </div>
    </section>
  `;
  overlay.querySelector('[data-import-notification-confirm]')?.addEventListener('click', dismissImportNotification);
  app?.appendChild(overlay);
  overlay.querySelector('.importNotification__card')?.focus({ preventScroll: true });
}

function getActiveImportLoaderState() {
  const importStates = [
    {
      state: appState.menu,
      title: 'Menu catalogue import',
      message: 'Importing menu items and syncing recipe links.'
    },
    {
      state: appState.recipes,
      title: 'Recipe import',
      message: 'Importing recipe lines and matching ingredients.'
    },
    {
      state: appState.stock,
      title: 'Stock item import',
      message: 'Importing stock items, UOMs, barcodes, and opening stock.'
    },
    {
      state: appState.suppliers,
      title: 'Supplier import',
      message: 'Importing supplier records and contact details.'
    },
    {
      state: appState.settings,
      title: 'Settings import',
      message: 'Importing workspace settings and configuration.'
    },
    {
      state: appState.transfers,
      title: 'Transfer template import',
      message: 'Importing transfer lines and validating locations.'
    },
    {
      state: appState.manufacturing,
      title: 'Manufacturing import',
      message: 'Importing manufactured items and blueprint data.'
    },
    {
      state: appState.stockTake,
      title: 'Stock count import',
      message: 'Importing counted quantities and calculating variances.'
    }
  ];

  return importStates.find((entry) => entry.state?.actionStatus === 'importing') || null;
}

function mountGlobalImportLoader() {
  app?.querySelector('[data-global-import-loader]')?.remove();
  const activeImport = getActiveImportLoaderState();
  if (!activeImport) return;

  const overlay = document.createElement('div');
  overlay.className = 'globalImportLoader';
  overlay.dataset.globalImportLoader = 'true';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-busy', 'true');
  overlay.innerHTML = `
    <section class="globalImportLoader__card">
      <div class="globalImportLoader__spinner" aria-hidden="true"></div>
      <div class="globalImportLoader__copy">
        <span>Import in progress</span>
        <h2>${escapeImportNotificationText(activeImport.title || 'Import in progress')}</h2>
        <p>${escapeImportNotificationText(activeImport.message || 'Please wait while we import this file.')}</p>
      </div>
    </section>
  `;
  app?.appendChild(overlay);
}

function renderImportNotificationSummary(notification = {}) {
  const importedCount = Number(notification.importedCount || 0) || 0;
  const skippedCount = Number(notification.skippedCount || 0) || 0;
  const totalRows = Number(notification.totalRows || 0) || 0;
  if (!importedCount && !skippedCount && !totalRows) return '';
  return `
    <div class="importNotification__summary">
      <strong>${importedCount} imported</strong>
      <span>${skippedCount} skipped${totalRows ? ` · ${totalRows} rows checked` : ''}</span>
    </div>
  `;
}

function renderImportNotificationErrors(errors = []) {
  const visible = normalizeImportNotificationErrors(errors).slice(0, 12);
  if (!visible.length) return '';
  const overflow = errors.length > visible.length ? errors.length - visible.length : 0;
  return `
    <ul class="importNotification__list">
      ${visible.map((entry) => `
        <li>
          <code>${escapeImportNotificationText(entry.code || 'IMPORT')}</code>
          <span>${entry.row ? `Row ${escapeImportNotificationText(entry.row)}: ` : ''}${escapeImportNotificationText(entry.message || 'Import row could not be processed.')}</span>
        </li>
      `).join('')}
      ${overflow ? `<li><code>MORE</code><span>${overflow} more issue${overflow === 1 ? '' : 's'} found. Fix the listed errors and try the import again.</span></li>` : ''}
    </ul>
  `;
}

function normalizeImportNotificationErrors(errors = []) {
  return (Array.isArray(errors) ? errors : [errors])
    .map((entry, index) => {
      if (entry && typeof entry === 'object') {
        return {
          code: String(entry.code || 'IMPORT').trim() || 'IMPORT',
          row: entry.row === undefined || entry.row === null ? '' : String(entry.row),
          message: String(entry.message || entry.error || 'Import row could not be processed.').trim()
        };
      }
      const textValue = String(entry || '').trim();
      const rowMatch = textValue.match(/^Row\s+([^:]+):\s*(.+)$/i);
      return {
        code: `IMPORT_${index + 1}`,
        row: rowMatch?.[1] || '',
        message: rowMatch?.[2] || textValue || 'Import row could not be processed.'
      };
    })
    .filter((entry) => entry.message);
}

function escapeImportNotificationText(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function applyRealtimeSnapshot(key, apply) {
  const snapshotKey = String(key || 'snapshot');
  if (shouldDeferRealtimeSnapshot() && !shouldAllowRealtimeHydration(snapshotKey)) {
    deferredRealtimeSnapshots.set(snapshotKey, apply);
    return;
  }

  apply?.();
  renderApp();
}

function shouldAllowRealtimeHydration(key) {
  switch (key) {
    case 'adjustments':
      return appState.adjustments.status === 'loading' ||
        appState.adjustments.loaded?.stockItems !== true ||
        !(appState.adjustments.stockItems || []).length;
    case 'transfers':
      return appState.transfers.status === 'loading' ||
        appState.transfers.loaded?.stockItems !== true ||
        !(appState.transfers.stockItems || []).length;
    case 'stockTake':
      return appState.stockTake.status === 'loading' ||
        appState.stockTake.loaded?.stockItems !== true ||
        !(appState.stockTake.stockItems || []).length;
    case 'manufacturing':
      return appState.manufacturing.status === 'loading' ||
        appState.manufacturing.loaded?.stockItems !== true ||
        !(appState.manufacturing.stockItems || []).length;
    case 'locations':
      return appState.locations.status === 'loading' ||
        appState.locations.loaded?.stockItems !== true ||
        !(appState.locations.stockItems || []).length;
    default:
      return false;
  }
}

function scheduleDeferredRealtimeSnapshotFlush() {
  if (!deferredRealtimeSnapshots.size || deferredRealtimeSnapshotFlushTimer) return;
  deferredRealtimeSnapshotFlushTimer = window.setTimeout(() => {
    deferredRealtimeSnapshotFlushTimer = null;
    flushDeferredRealtimeSnapshots();
  }, 0);
}

function flushDeferredRealtimeSnapshots() {
  if (!deferredRealtimeSnapshots.size || shouldDeferRealtimeSnapshot()) return;

  const snapshots = [...deferredRealtimeSnapshots.values()];
  deferredRealtimeSnapshots.clear();
  snapshots.forEach((apply) => apply?.());
  renderApp();
}

function shouldDeferRealtimeSnapshot() {
  if (!appState.user || !appState.workspace) return false;

  return Boolean(
    appState.menu.editingItem ||
    appState.menu.confirmDelete ||
    appState.menu.categoryManager?.open ||
    appState.recipes.editingItem ||
    appState.recipes.pickerOpen ||
    appState.recipes.confirmDelete ||
    appState.recipes.confirmLineRemoval ||
    appState.stock.editingItem ||
    appState.stock.manager?.open ||
    appState.stock.lookupPicker?.open ||
    appState.stock.confirmDelete ||
    appState.suppliers.editingItem ||
    appState.suppliers.confirmDelete ||
    appState.purchaseOrders.draftOrder ||
    appState.purchaseOrders.confirmDelete ||
    appState.purchaseOrders.filters?.overlay ||
    appState.grv.filters?.overlay ||
    appState.grv.lineDetailDraft ||
    appState.grv.missingSupplierPrompt ||
    appState.creditNotes.filters?.overlay ||
    appState.creditNotes.lineDetailDraft ||
    appState.adjustments.filters?.overlay ||
    appState.adjustments.lineDetailDraft ||
    appState.transfers.filters?.overlay ||
    appState.stockTake.filters?.overlay ||
    appState.stockTake.sessionActive ||
    appState.locations.createOpen ||
    appState.locations.editingLocation ||
    appState.manufacturing.blueprintDraft ||
    appState.manufacturing.batchDraft ||
    appState.manufacturing.lookupPicker?.open ||
    appState.userManagement.createModalOpen ||
    appState.userManagement.editingMember ||
    appState.userManagement.confirmRemove ||
    appState.roleManagement.editingRole ||
    appState.roleManagement.confirmDelete ||
    document.querySelector('.brandConfirm, [role="dialog"], [data-yoco-modal]:not([hidden])')
  );
}

function renderBoot(message) {
  if (!app) return;
  const normalizedMessage = String(message || 'Loading...');
  const existingMessage = app.querySelector('.kcpBootMessage');
  if (existingMessage?.textContent === normalizedMessage) return;
  app.innerHTML = `
    <main class="app-boot kcpBoot">
      <div class="kcpBootCard">
        <div class="kcpBootStage" aria-hidden="true">
          <span class="kcpBootRing kcpBootRing--1"></span>
          <span class="kcpBootRing kcpBootRing--2"></span>
          <span class="kcpBootRing kcpBootRing--3"></span>
          <span class="kcpBootOrbit"><i class="kcpBootDot"></i></span>
          <span class="kcpBootMark"><span class="kcpBootMarkText">KCP</span></span>
        </div>
        <p class="kcpBootMessage">${normalizedMessage}</p>
      </div>
    </main>
  `;
}

function captureActiveField() {
  return snapshotFocusableField(document.activeElement);
}

function captureScrollSnapshots() {
  const snapshots = [{
    key: '__window__',
    top: window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0,
    left: window.scrollX || document.documentElement?.scrollLeft || document.body?.scrollLeft || 0
  }];

  if (!app) return snapshots;

  const seenKeys = new Set(snapshots.map((entry) => entry.key));
  const scrollNodes = [...app.querySelectorAll('[data-scroll-key], [data-app-main]')];

  snapshots.push(...scrollNodes
    .map((node) => ({
      key: node.dataset.scrollKey || (node.hasAttribute('data-app-main') ? 'app-main' : ''),
      top: node.scrollTop || 0,
      left: node.scrollLeft || 0
    }))
    .filter((entry) => {
      if (!entry.key || seenKeys.has(entry.key)) return false;
      seenKeys.add(entry.key);
      return true;
    }));

  return snapshots;
}

function restoreScrollSnapshots(entries = []) {
  if (!entries.length) return;
  const restore = () => {
    entries.forEach((entry) => {
      if (entry.key === '__window__') {
        window.scrollTo({
          top: entry.top || 0,
          left: entry.left || 0,
          behavior: 'auto'
        });
        return;
      }
      const target = app?.querySelector(`[data-scroll-key="${cssEscape(entry.key)}"]`);
      if (!target) return;
      target.scrollTop = entry.top || 0;
      target.scrollLeft = entry.left || 0;
    });
  };

  queueMicrotask(restore);
  requestAnimationFrame(restore);
}

function shouldLockAppModalScroll() {
  if (!app) return false;
  if (getTopVisibleModal()) return true;

  const modalBackdrops = [
    '[class*="ModalBackdrop"]',
    '[class*="__modalBackdrop"]',
    '.brandConfirm__backdrop'
  ].join(',');

  return [...document.querySelectorAll(modalBackdrops)].some((element) => isVisibleElement(element));
}

function syncAppModalScrollLock() {
  const locked = shouldLockAppModalScroll();
  document.documentElement.classList.toggle('appModalScrollLock', locked);
  document.body?.classList.toggle('appModalScrollLock', locked);
  app?.querySelector('[data-app-main]')?.toggleAttribute('data-app-modal-scroll-lock', locked);

  const focusRequest = locked ? String(appState.recipes.modalFocusRequest || '') : '';
  if (!focusRequest) {
    if (!locked) lastRecipeViewportFocusRequest = '';
    return;
  }
  if (focusRequest === lastRecipeViewportFocusRequest) return;
  lastRecipeViewportFocusRequest = focusRequest;
  focusRecipeModalViewport();
}

function scheduleAppModalScrollLockSync() {
  if (modalScrollLockSyncQueued) return;
  modalScrollLockSyncQueued = true;
  requestAnimationFrame(() => {
    modalScrollLockSyncQueued = false;
    syncAppModalScrollLock();
  });
}

function focusRecipeModalViewport() {
  const focus = () => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    const main = app?.querySelector('[data-app-main]');
    if (main) {
      main.scrollTop = 0;
      main.scrollLeft = 0;
    }
    const modal = app?.querySelector('[data-recipe-modal-dialog]');
    if (modal) {
      modal.scrollTop = 0;
      modal.focus({ preventScroll: true });
    }
  };

  queueMicrotask(focus);
  requestAnimationFrame(focus);
}

function restoreActiveField(activeField) {
  if (!activeField?.selector && !activeField?.fallbackSelectors?.length) return;
  const restoreToken = ++focusRestoreToken;

  const restore = () => {
    if (restoreToken !== focusRestoreToken) return;
    const target = findFocusTarget(activeField);
    if (!target || typeof target.focus !== 'function') return;
    target.focus({ preventScroll: true });
    if (typeof activeField.scrollTop === 'number') target.scrollTop = activeField.scrollTop;
    if (typeof activeField.scrollLeft === 'number') target.scrollLeft = activeField.scrollLeft;
    if (
      supportsTextSelection(target) &&
      typeof target.setSelectionRange === 'function' &&
      activeField.start !== null &&
      activeField.end !== null
    ) {
      try {
        const valueLength = String(target.value || '').length;
        target.setSelectionRange(
          Math.min(activeField.start, valueLength),
          Math.min(activeField.end, valueLength)
        );
      } catch {
        // Number and date inputs can be focused but do not always allow caret restoration.
      }
    }
    if (pendingFocusField?.selector === activeField.selector) {
      pendingFocusField = null;
    }
  };

  queueMicrotask(restore);
  requestAnimationFrame(restore);
}

function preserveFieldFocus(element) {
  pendingFocusField = snapshotFocusableField(element);
}

function handleGlobalModalTabTrap(event) {
  if (event.key !== 'Tab') return;
  const modal = getTopVisibleModal();
  if (!modal) return;
  const focusable = getFocusableElements(modal);
  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (!modal.contains(active)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
    return;
  }

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
    return;
  }

  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function getTopVisibleModal() {
  const modals = [...document.querySelectorAll('[aria-modal="true"], [role="dialog"]')]
    .filter((modal) => isVisibleElement(modal));
  return modals.at(-1) || null;
}

function getFocusableElements(container) {
  return [...container.querySelectorAll([
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(','))]
    .filter((element) => isVisibleElement(element));
}

function isVisibleElement(element) {
  if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  return Boolean(element.offsetParent || element.getClientRects().length);
}

function snapshotFocusableField(element) {
  if (!element || !app?.contains(element)) return null;
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return null;

  const selectors = getFocusSelectors(element);
  const selector = selectors[0] || '';
  if (!selector) return null;

  return {
    selector,
    fallbackSelectors: selectors.slice(1),
    start: supportsTextSelection(element) && typeof element.selectionStart === 'number' ? element.selectionStart : null,
    end: supportsTextSelection(element) && typeof element.selectionEnd === 'number' ? element.selectionEnd : null,
    scrollTop: element.scrollTop || 0,
    scrollLeft: element.scrollLeft || 0
  };
}

function supportsTextSelection(element) {
  if (!element) return false;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  const type = String(element.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'color', 'date', 'datetime-local', 'file', 'hidden', 'image', 'month', 'number', 'radio', 'range', 'reset', 'submit', 'time', 'week'].includes(type);
}

function getFocusSelector(element) {
  return getFocusSelectors(element)[0] || '';
}

function getFocusSelectors(element) {
  const selectors = [];
  const addSelector = (selector) => {
    if (!selector || selectors.includes(selector)) return;
    selectors.push(selector);
  };

  if (element.dataset.focusKey) {
    addSelector(`[data-focus-key="${cssEscape(element.dataset.focusKey)}"]`);
  }

  if (element.id) {
    addSelector(`#${cssEscape(element.id)}`);
  }

  const tag = element.tagName.toLowerCase();
  const type = element.getAttribute('type');
  const tagWithType = type ? `${tag}[type="${cssEscape(type)}"]` : tag;
  const dataAttributes = Object.entries(element.dataset || {})
    .filter(([key]) => key !== 'focusKey')
    .map(([key, value]) => ({
      attribute: datasetKeyToAttribute(key),
      value: String(value ?? '')
    }))
    .filter(({ attribute }) => attribute);

  if (dataAttributes.length > 1) {
    const combined = dataAttributes
      .map(({ attribute, value }) => (value
        ? `[${attribute}="${cssEscape(value)}"]`
        : `[${attribute}]`))
      .join('');
    addSelector(`${tagWithType}${combined}`);
  }

  dataAttributes.forEach(({ attribute, value }) => {
    const selector = value
      ? `${tagWithType}[${attribute}="${cssEscape(value)}"]`
      : `${tagWithType}[${attribute}]`;
    addSelector(selector);
  });

  if (element.name) {
    addSelector(`${tagWithType}[name="${cssEscape(element.name)}"]`);
    addSelector(`${tag}[name="${cssEscape(element.name)}"]`);
  }

  const placeholder = element.getAttribute('placeholder');
  if (placeholder) {
    addSelector(`${tagWithType}[placeholder="${cssEscape(placeholder)}"]`);
    addSelector(`${tag}[placeholder="${cssEscape(placeholder)}"]`);
  }

  return selectors.filter((selector) => {
    try {
      return Boolean(app?.querySelector(selector));
    } catch {
      return false;
    }
  });
}

function findFocusTarget(activeField) {
  const selectors = [activeField?.selector, ...(activeField?.fallbackSelectors || [])].filter(Boolean);
  for (const selector of selectors) {
    try {
      const target = app?.querySelector(selector);
      if (target) return target;
    } catch {
      // Ignore invalid selectors and try the next fallback.
    }
  }
  return null;
}

function datasetKeyToAttribute(key = '') {
  const attribute = String(key)
    .replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)
    .replace(/^-+/, '');
  return attribute ? `data-${attribute}` : '';
}

function cssEscape(value = '') {
  if (globalThis.CSS?.escape) return CSS.escape(String(value));
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function replaceApp(element) {
  if (!app) return;
  cleanupAppDropdownPortal();
  app.replaceChildren(element);
  mountGlobalImportLoader();
}

function cleanupAccessSubscription() {
  accessSubscriptionToken += 1;

  if (unsubscribeAccess) {
    unsubscribeAccess();
    unsubscribeAccess = null;
  }
}

function cleanupMenuSubscription() {
  menuSubscriptionToken += 1;

  if (unsubscribeMenu) {
    unsubscribeMenu();
    unsubscribeMenu = null;
  }
}

function cleanupRecipeSubscription() {
  recipeSubscriptionToken += 1;

  if (unsubscribeRecipes) {
    unsubscribeRecipes();
    unsubscribeRecipes = null;
  }
}

function cleanupStockSubscription() {
  stockSubscriptionToken += 1;

  if (unsubscribeStock) {
    unsubscribeStock();
    unsubscribeStock = null;
  }
}

function cleanupSupplierSubscription() {
  supplierSubscriptionToken += 1;

  if (unsubscribeSuppliers) {
    unsubscribeSuppliers();
    unsubscribeSuppliers = null;
  }
}

function cleanupPurchaseOrderSubscription() {
  purchaseOrderSubscriptionToken += 1;

  if (unsubscribePurchaseOrders) {
    unsubscribePurchaseOrders();
    unsubscribePurchaseOrders = null;
  }
}

function cleanupGrvSubscription() {
  grvSubscriptionToken += 1;

  if (unsubscribeGrv) {
    unsubscribeGrv();
    unsubscribeGrv = null;
  }
}

function cleanupCreditNoteSubscription() {
  creditNoteSubscriptionToken += 1;

  if (unsubscribeCreditNotes) {
    unsubscribeCreditNotes();
    unsubscribeCreditNotes = null;
  }
}

function cleanupAdjustmentSubscription() {
  adjustmentSubscriptionToken += 1;

  if (unsubscribeAdjustments) {
    unsubscribeAdjustments();
    unsubscribeAdjustments = null;
  }
}

function cleanupTransferSubscription() {
  transferSubscriptionToken += 1;

  if (unsubscribeTransfers) {
    unsubscribeTransfers();
    unsubscribeTransfers = null;
  }
}

function cleanupStockTakeSubscription() {
  stockTakeSubscriptionToken += 1;

  if (unsubscribeStockTake) {
    unsubscribeStockTake();
    unsubscribeStockTake = null;
  }
}

function cleanupLocationSubscription() {
  locationSubscriptionToken += 1;

  if (unsubscribeLocations) {
    unsubscribeLocations();
    unsubscribeLocations = null;
  }
}

function cleanupManufacturingSubscription() {
  manufacturingSubscriptionToken += 1;

  if (unsubscribeManufacturing) {
    unsubscribeManufacturing();
    unsubscribeManufacturing = null;
  }
}



function createAccessState(status) {
  return {
    status,
    team: [],
    customRoles: [],
    superUsers: [],
    currentIsSuperUser: false,
    roleCatalog: [],
    roleOptions: [],
    locations: [],
    currentRole: 'member',
    roleDefinition: resolveRoleDefinition('member', []),
    allowedSections: [],
    updatedAt: '',
    error: ''
  };
}

function createMenuState(status, filters = {}) {
  return {
    status,
    items: [],
    modifierItems: [],
    locations: [],
    ingredients: [],
    editingModifier: null,
    modifierStockRuleOpen: false,
    viewingModifierLinks: null,
    modifierLinksOpen: false,
    noteSuggestions: {
      status: 'idle',
      items: [],
      open: false,
      includeIgnored: false,
      editingId: '',
      draft: null,
      error: ''
    },
    posIntegration: { active: false, provider: '', label: '' },
    source: '',
    updatedAt: '',
    siteConfig: null,
    error: '',
    selectedIds: [],
    editingItem: null,
    confirmDelete: null,
    categoryManager: {
      open: false,
      status: 'idle',
      items: [],
      draftName: '',
      editingName: '',
      editingValue: '',
      error: ''
    },
    actionStatus: '',
    actionError: '',
    toast: null,
    filters: {
      query: '',
      catalogueView: 'products',
      category: '',
      status: '',
      locationId: '',
      view: 'list',
      page: 1,
      pageSize: 25,
      openDropdown: '',
      ...filters
    }
  };
}

function createRecipeState(status, filters = {}) {
  return {
    status,
    items: [],
    ingredients: [],
    locations: [],
    source: '',
    loaded: {},
    updatedAt: '',
    error: '',
    editingItem: null,
    draftRecipe: [],
    pickerOpen: false,
    pickerStep: 'select',
    pickerSelectedIds: [],
    pickerQuantities: {},
    pickerUoms: {},
    selectedIds: [],
    confirmDelete: null,
    confirmLineRemoval: null,
    pendingFocus: null,
    pendingOpenItemId: '',
    pendingOpenItemName: '',
    actionStatus: '',
    actionError: '',
    toast: null,
    noteSuggestions: {
      status: 'idle',
      items: [],
      open: false,
      includeIgnored: false,
      editingId: '',
      draft: null,
      error: ''
    },
    filters: {
      query: '',
      category: '',
      ingredientQuery: '',
      ingredientCategory: '',
      ingredientType: '',
      locationId: '',
      openDropdown: '',
      categoryDropdownSearch: '',
      ingredientCategoryDropdownSearch: '',
      ...filters
    }
  };
}

function createStockState(status, filters = {}) {
  return {
    status,
    items: [],
    sites: [],
    locations: [],
    categories: [],
    uoms: [],
    loaded: {},
    updatedAt: '',
    error: '',
    selectedIds: [],
    editingItem: null,
    manager: createStockManagerState(),
    lookupPicker: createStockLookupPickerState(),
    confirmDelete: null,
    actionStatus: '',
    actionError: '',
    importReview: null,
    locationCostingPreview: null,
    toast: null,
    filters: {
      query: '',
      category: '',
      locationId: '',
      locationCostingLocationId: '',
      locationCostingLocationIdDropdownSearch: '',
      locationCostingPickerKind: '',
      itemType: '',
      openDropdown: '',
      categoryDropdownSearch: '',
      locationDropdownSearch: '',
      itemTypeDropdownSearch: '',
      page: 1,
      pageSize: 25,
      ...filters
    }
  };
}

function createStockManagerPanelState() {
  return {
    draftValue: '',
    searchValue: '',
    editingName: '',
    editingValue: ''
  };
}

function createStockManagerState() {
  return {
    open: false,
    status: '',
    error: '',
    picker: {
      open: false,
      type: 'category',
      query: ''
    },
    category: createStockManagerPanelState(),
    uom: createStockManagerPanelState()
  };
}

function createStockLookupPickerState() {
  return {
    open: false,
    field: 'category',
    query: ''
  };
}

function createManufacturingLookupPickerState() {
  return {
    open: false,
    field: 'category',
    query: ''
  };
}

function isSupportedStockTaxonomyType(type) {
  return type === 'category' || type === 'uom';
}

function isSupportedStockLookupField(field) {
  return field === 'category' || field === 'unit';
}

function isSupportedManufacturingLookupField(field) {
  return field === 'category' || field === 'unit';
}

function normalizeStockLookupValue(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getStockTaxonomyConfig(type) {
  return type === 'uom'
    ? {
        label: 'UOM',
        createMethod: 'createStockUom',
        renameMethod: 'renameStockUom',
        deleteMethod: 'deleteStockUom'
      }
    : {
        label: 'Category',
        createMethod: 'createStockCategory',
        renameMethod: 'renameStockCategory',
        deleteMethod: 'deleteStockCategory'
      };
}

function createSupplierState(status, filters = {}) {
  return {
    status,
    items: [],
    source: '',
    updatedAt: '',
    error: '',
    selectedIds: [],
    editingItem: null,
    confirmDelete: null,
    actionStatus: '',
    actionError: '',
    validationErrors: {},
    toast: null,
    filters: {
      query: '',
      category: '',
      view: 'list',
      openDropdown: '',
      ...filters
    }
  };
}

function createPurchaseOrderState(status, filters = {}) {
  return {
    status,
    orders: [],
    suppliers: [],
    stockItems: [],
    sites: [],
    locations: [],
    linkedProfiles: [],
    loaded: {},
    source: '',
    updatedAt: '',
    error: '',
    selectedIds: [],
    draftOrder: null,
    confirmDelete: null,
    actionStatus: '',
    actionError: '',
    toast: null,
    filters: {
      query: '',
      status: '',
      view: 'list',
      openDropdown: '',
      lineQuery: '',
      supplierQuery: '',
      calendarCursor: '',
      overlay: '',
      ...filters
    }
  };
}

function createGrvState(status, filters = {}, pendingSourcePoId = '') {
  return {
    status,
    receipts: [],
    orders: [],
    suppliers: [],
    stockItems: [],
    sites: [],
    locations: [],
    loaded: {},
    source: '',
    updatedAt: '',
    error: '',
    pendingSourcePoId: String(pendingSourcePoId || '').trim(),
    lineDetailDraft: null,
    missingSupplierPrompt: null,
    draftReceipt: {
      id: '',
      grvNumber: '',
      sourcePoId: '',
      poNumber: '',
      supplierId: '',
      supplierName: '',
      date: todayLocal(),
      locationId: 'main',
      locationName: 'Main Store',
      notes: '',
      pricesIncludeVat: false,
      overrideCostPrice: true,
      transportEx: '',
      invoiceDiscountEx: '',
      invoiceTotalEx: '',
      items: []
    },
    actionStatus: '',
    actionError: '',
    toast: null,
    filters: {
      query: '',
      source: '',
      lineQuery: '',
      poQuery: '',
      selectedStockIds: [],
      selectedLineIndexes: [],
      calendarCursor: '',
      overlay: '',
      openDropdown: '',
      headerLocationQuery: '',
      ...filters
    }
  };
}

function createCreditNoteState(status, filters = {}) {
  return {
    status,
    creditNotes: [],
    processedGrvs: [],
    stockItems: [],
    sites: [],
    locations: [],
    suppliers: [],
    loaded: {},
    source: '',
    updatedAt: '',
    error: '',
    lineDetailDraft: null,
    draftNote: createEmptyCreditNoteDraft(),
    actionStatus: '',
    actionError: '',
    toast: null,
    filters: {
      query: '',
      stockSearch: '',
      stockCategory: '',
      grvQuery: '',
      overlay: '',
      openDropdown: '',
      calendarCursor: '',
      selectedStockIds: [],
      selectedLineIndexes: [],
      headerLocationQuery: '',
      ...filters
    }
  };
}

function createAdjustmentState(status, filters = {}) {
  return {
    status,
    adjustments: [],
    stockItems: [],
    products: [],
    sites: [],
    locations: [],
    loaded: {},
    source: '',
    updatedAt: '',
    error: '',
    lineDetailDraft: null,
    draftAdjustment: createEmptyAdjustmentDraft(),
    wastageDraft: createEmptyWastageDraft(),
    wastageStatus: '',
    wastageError: '',
    actionStatus: '',
    actionError: '',
    toast: null,
    filters: {
      stockSearch: '',
      stockCategory: '',
      stockPage: 1,
      detailPage: 1,
      overlay: '',
      openDropdown: '',
      adjustmentWorkflow: 'bulk',
      selectedStockIds: [],
      adjustmentTab: 'stock',
      wastageSearch: '',
      wastageCategory: '',
      wastagePage: 1,
      wastageSelectedIds: [],
      ...filters
    }
  };
}

function createEmptyWastageDraft() {
  return {
    locationId: 'main',
    locationName: 'Main Store',
    wasteReason: '',
    note: '',
    date: '',
    items: []
  };
}

function createTransferState(status, filters = {}) {
  return {
    status,
    transfers: [],
    externalTransfers: [],
    templates: [],
    stockItems: [],
    sites: [],
    locations: [],
    loaded: {},
    source: '',
    updatedAt: '',
    error: '',
    draftTransfer: createEmptyTransferDraft(),
    templateDraft: null,
    receiveDrafts: {},
    actionStatus: '',
    actionError: '',
    validation: null,
    toast: null,
    filters: {
      stockSearch: '',
      stockCategory: '',
      transferScope: 'internal',
      transferWorkflow: '',
      overlay: '',
      openDropdown: '',
      locationPicker: '',
      locationPickerSiteId: '',
      templateSearch: '',
      bulkTemplateId: '',
      selectedStockIds: [],
      ...filters
    }
  };
}

function createStockTakeState(status, filters = {}, sessionActive = false) {
  return {
    status,
    stockTakes: [],
    stockItems: [],
    templates: [],
    savedDrafts: [],
    sites: [],
    locations: [],
    loaded: {},
    source: '',
    updatedAt: '',
    error: '',
    sessionActive: Boolean(sessionActive),
    sessionSetup: createEmptyStockTakeSessionSetup(),
    templateDraft: null,
    scanCount: createEmptyStockTakeScanCountDraft(),
    draftSession: createEmptyStockTakeDraft(),
    actionStatus: '',
    actionError: '',
    toast: null,
    filters: {
      query: '',
      templateListQuery: '',
      templateSelectionQuery: '',
      overlay: '',
      openDropdown: '',
      ...filters
    }
  };
}

function createLocationState(status, filters = {}) {
  return {
    status,
    sites: [],
    items: [],
    stockItems: [],
    loaded: {},
    updatedAt: '',
    error: '',
    draftName: '',
    draft: { name: '', siteId: '', type: 'storage', code: '', notes: '', stockRouting: {} },
    createOpen: false,
    editingLocation: null,
    routingModal: null,
    siteDraft: { name: '', code: '', address: '', notes: '' },
    siteCreateOpen: false,
    editingSite: null,
    selectedSiteId: '',
    actionStatus: '',
    actionError: '',
    toast: null,
    filters: {
      query: '',
      siteId: '',
      ...filters
    }
  };
}

function createManufacturingState(status, filters = {}) {
  return {
    status,
    manufacturedItems: [],
    stockItems: [],
    sites: [],
    locations: [],
    categories: [],
    uoms: [],
    logs: [],
    loaded: {},
    updatedAt: '',
    error: '',
    blueprintDraft: null,
    lookupPicker: createManufacturingLookupPickerState(),
    batchDraft: null,
    productionDraft: null,
    actionStatus: '',
    actionError: '',
    toast: null,
    filters: {
      query: '',
      type: '',
      componentQuery: '',
      componentCategory: '',
      componentType: '',
      productionCategory: '',
      openDropdown: '',
      ...filters
    }
  };
}



function createUserManagementState(status, filters = {}) {
  return {
    status,
    actionStatus: '',
    actionError: '',
    toast: null,
    createModalOpen: false,
    createStep: 1,
    draftMember: {
      firstName: '',
      surname: '',
      email: '',
      password: '',
      role: 'member',
      viewingOnly: false,
      lowStockAlert: false,
      allowedLocations: []
    },
    editingMember: null,
    confirmRemove: null,
    filters: {
      query: '',
      role: '',
      openDropdown: '',
      ...filters
    }
  };
}

function createRoleManagementState(status) {
  return {
    status,
    actionStatus: '',
    actionError: '',
    toast: null,
    editingRole: null,
    confirmDelete: null
  };
}

function createSettingsState(status, seed = {}) {
  const draft = createDefaultSettingsDraft(seed || {});
  return {
    status,
    values: draft,
    draft,
    yocoCategories: [],
    stockCategories: [],
    error: '',
    actionStatus: '',
    actionError: '',
    openDropdown: '',
    routingModalOpen: false,
    appearanceModal: '',
    themeGalleryOpen: false,
    confirmResetTotals: null,
    toast: null
  };
}

function getMenuItemById(itemId) {
  const id = String(itemId || '');
  return (appState.menu.items || []).find((item) => String(item.id) === id) || null;
}

function getRecipeItemById(itemId) {
  const id = String(itemId || '');
  return (appState.recipes.items || []).find((item) => String(item.id) === id) || null;
}

function normalizeRecipeOpenTarget(target = {}) {
  if (target && typeof target === 'object') {
    return {
      id: String(target.id || target.itemId || target.productId || '').trim(),
      name: String(target.name || target.itemName || target.productName || target.title || '').trim()
    };
  }
  return {
    id: String(target || '').trim(),
    name: ''
  };
}

function findRecipeItemForTarget(items = [], target = {}) {
  const id = String(target.id || '').trim();
  const name = normalizeRecipeLookupName(target.name || '');
  if (!id && !name) return null;
  return (items || []).find((item) => {
    const itemId = String(item.id || item.productId || item.yocoVariantId || item.yocoItemId || '').trim();
    if (id && itemId === id) return true;
    if (id && String(item.name || item.productName || item.title || '').trim() === id) return true;
    if (!name) return false;
    return [
      item.name,
      item.productName,
      item.ProductName,
      item.title,
      item.yocoItemName
    ].some((value) => normalizeRecipeLookupName(value || '') === name);
  }) || null;
}

function normalizeRecipeLookupName(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getStockItemById(itemId) {
  const id = String(itemId || '');
  return (appState.stock.items || []).find((item) => String(item.id) === id) || null;
}

function getSupplierById(itemId) {
  const id = String(itemId || '');
  return (appState.suppliers.items || []).find((item) => String(item.id) === id) || null;
}

function getPurchaseOrderById(orderId) {
  const id = String(orderId || '');
  return (appState.purchaseOrders.orders || []).find((order) => String(order.id) === id) || null;
}

function removeRowsByIds(rows = [], ids = []) {
  const idSet = new Set(Array.from(ids || []).map((id) => String(id || '')).filter(Boolean));
  if (!idSet.size) return rows || [];
  return (rows || []).filter((row) => !idSet.has(String(row?.id || '')));
}

function removeRowsByNames(rows = [], names = []) {
  const nameSet = new Set(Array.from(names || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean));
  if (!nameSet.size) return rows || [];
  return (rows || []).filter((row) => !nameSet.has(String(row?.name || row?.roleKey || row?.role_key || '').trim().toLowerCase()));
}

function menuIdentityKey(item = {}) {
  return [
    String(item?.name || '').trim().toLowerCase().replace(/\s+/g, ' '),
    String(item?.category || '').trim().toLowerCase().replace(/\s+/g, ' ')
  ].join('|');
}

function removeMenuRowsByIdentity(rows = [], items = []) {
  const identitySet = new Set(Array.from(items || []).map(menuIdentityKey).filter((key) => key !== '|'));
  if (!identitySet.size) return rows || [];
  return (rows || []).filter((row) => !identitySet.has(menuIdentityKey(row)));
}

function modifierRecipeIdentityKey(item = {}) {
  const ownerId = String(item?.recipeOwnerId || item?.id || '').replace(/^modifier:/, '').trim();
  if (ownerId) return `owner:${ownerId}`;
  return [
    String(item?.yocoModifierGroupId || '').trim().toLowerCase(),
    String(item?.yocoModifierId || item?.yocoModifierVariantId || '').trim().toLowerCase(),
    String(item?.name || '').trim().toLowerCase().replace(/\s+/g, ' ')
  ].join('|');
}

function removeModifierRowsByIdentity(rows = [], items = []) {
  const identitySet = new Set(Array.from(items || []).map(modifierRecipeIdentityKey).filter((key) => key && key !== '||'));
  if (!identitySet.size) return rows || [];
  return (rows || []).filter((row) => !identitySet.has(modifierRecipeIdentityKey(row)));
}

function getPoStockItemById(itemId) {
  const id = String(itemId || '');
  return (appState.purchaseOrders.stockItems || []).find((item) => String(item.id) === id) || null;
}

function getGrvStockItemById(itemId) {
  const id = String(itemId || '');
  return (appState.grv.stockItems || []).find((item) => String(item.id) === id) || null;
}

function getCreditNoteStockItemById(itemId) {
  const id = String(itemId || '');
  return (appState.creditNotes.stockItems || []).find((item) => String(item.id) === id) || null;
}

function isOrderableStockItem(item = {}) {
  const itemType = getStockItemTypeForFilter(item);
  return itemType === 'standard' || itemType === 'recipe_source';
}

function isAdjustmentStockItem(item = {}) {
  const itemType = getStockItemTypeForFilter(item);
  return itemType === 'standard' || itemType === 'recipe_source' || itemType === 'manufactured';
}

function normalizeLineUomConfigurations(value = []) {
  const rows = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' ? [value] : []);
  return rows
    .map((entry = {}) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      return {
        baseUom: String(row.baseUom || row.base_uom || row.baseUnit || row.unit || '').trim(),
        customUom: String(row.customUom || row.custom_uom || row.customUnit || row.orderingUom || '').trim(),
        ratio: parseDecimalInputValue(row.ratio ?? row.conversionRatio ?? row.unitsPerCustomUnit ?? row.units_per_custom_unit, 0),
        barcode: parseBarcodeValues(row.barcode || row.barcodes || row.customBarcode || row.customUomBarcode)[0] || '',
        isDefaultOrdering: ['true', '1', 'yes', 'on'].includes(String(row.isDefaultOrdering ?? row.defaultOrdering ?? row.is_default_ordering ?? row.defaultOrderUom ?? '').toLowerCase()) || row.isDefaultOrdering === true || row.defaultOrdering === true
      };
    })
    .filter((entry) => entry.customUom && entry.ratio > 0);
}

function getLineUomSelection(line = {}, selectedUom = '') {
  const baseUom = String(line.unit || line.baseUom || 'ea').trim() || 'ea';
  const target = String(selectedUom || baseUom).trim();
  const config = normalizeLineUomConfigurations(line.uomConfigurations || line.uomConfig || line.uomConversions)
    .find((entry) => entry.customUom.toLowerCase() === target.toLowerCase());
  if (config) {
    return {
      selectedUom: config.customUom,
      ratio: config.ratio,
      baseUom: config.baseUom || baseUom,
      barcode: config.barcode || ''
    };
  }
  return {
    selectedUom: baseUom,
    ratio: 1,
    baseUom,
    barcode: ''
  };
}

function getDefaultLineUomSelection(stockItem = {}, barcode = '') {
  const barcodeMatch = findStockItemUomConfigByBarcode(stockItem, barcode);
  if (barcodeMatch) {
    return {
      selectedUom: barcodeMatch.customUom,
      ratio: barcodeMatch.ratio,
      baseUom: barcodeMatch.baseUom || stockItem.unit || 'ea',
      barcode: barcodeMatch.barcode || ''
    };
  }
  const defaultOrderingConfig = normalizeLineUomConfigurations(stockItem.uomConfigurations || stockItem.uomConfig || stockItem.uomConversions)
    .find((entry) => entry.isDefaultOrdering);
  if (defaultOrderingConfig) {
    return {
      selectedUom: defaultOrderingConfig.customUom,
      ratio: defaultOrderingConfig.ratio,
      baseUom: defaultOrderingConfig.baseUom || stockItem.unit || 'ea',
      barcode: defaultOrderingConfig.barcode || ''
    };
  }
  return getLineUomSelection(stockItem, stockItem.unit || 'ea');
}

function findStockItemUomConfigByBarcode(stockItem = {}, barcode = '') {
  const query = String(barcode || '').trim().toLowerCase();
  if (!query) return null;
  return normalizeLineUomConfigurations(stockItem.uomConfigurations || stockItem.uomConfig || stockItem.uomConversions)
    .find((entry) => entry.barcode && entry.barcode.toLowerCase() === query) || null;
}

function getGrvPurchaseOrderById(orderId) {
  const id = String(orderId || '');
  return (appState.grv.orders || []).find((order) => String(order.id) === id) || null;
}

function getFilteredMenuItems(items, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  return (items || []).filter((item) => {
    const matchesQuery = !query ||
      String(item.name || '').toLowerCase().includes(query) ||
      String(item.category || '').toLowerCase().includes(query);
    const matchesCategory = !filters.category || item.category === filters.category;
    const matchesStatus = !filters.status || item.status === filters.status;
    return matchesQuery && matchesCategory && matchesStatus;
  });
}

function getFilteredRecipeItems(items, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  return (items || []).filter((item) => {
    const matchesQuery = !query ||
      String(item.name || '').toLowerCase().includes(query) ||
      String(item.category || '').toLowerCase().includes(query) ||
      matchesBarcodeQuery(item, query);
    const matchesCategory = !filters.category || item.category === filters.category;
    const matchesRecipeStatus = !filters.recipeStatus || item.status === filters.recipeStatus;
    return matchesQuery && matchesCategory && matchesRecipeStatus;
  });
}

function getFilteredStockItems(items, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const locationId = String(filters.locationId || '');
  const itemTypeFilter = String(filters.itemType || '').trim();
  return (items || []).filter((item) => {
    const itemType = getStockItemTypeForFilter(item);
    const matchesQuery = !query ||
      String(item.name || '').toLowerCase().includes(query) ||
      String(item.category || '').toLowerCase().includes(query) ||
      matchesBarcodeQuery(item, query);
    const matchesCategory = !filters.category || normalizeStockCategory(item.category) === filters.category;
    const matchesLocation = !locationId || Object.hasOwn(item.balances || {}, locationId);
    const matchesType = !itemTypeFilter || itemType === itemTypeFilter;
    return matchesQuery && matchesCategory && matchesLocation && matchesType;
  });
}

// Shared canonical derivation — see src/utils/stockItemType.js. Filtering has always grouped
// 'virtual' with Non Stock, so the fine-grained type is collapsed here.
function getStockItemTypeForFilter(item = {}) {
  const type = deriveStockItemType(item);
  return type === 'virtual' ? 'recipe_source' : type;
}

function normalizeStockCategory(value = '') {
  const raw = String(value || '');
  const manufacturedCategory = raw.toLowerCase().includes('manufactured')
    ? raw.match(/\(([^)]+)\)\s*-\s*Manufactured$/i)
    : null;
  if (manufacturedCategory?.[1]) return manufacturedCategory[1].trim();
  const stripped = raw
    .replace(' - Raw Materials', '')
    .replace(' - Manufactured', '')
    .trim();
  const hyphenParts = raw.toLowerCase().includes('manufactured')
    ? stripped.split(/\s+-\s+/).filter(Boolean)
    : [];
  if (hyphenParts.length > 1) return hyphenParts.at(-1).trim();
  return stripped;
}

function normalizeManufacturingDraftCategory(category = '', itemName = '') {
  const strippedCategory = normalizeStockCategory(category);
  if (!strippedCategory || strippedCategory.toLowerCase() === 'manufactured') return '';

  const customCategory = strippedCategory.match(/\(([^)]+)\)$/);
  if (customCategory?.[1]) return customCategory[1].trim();

  const strippedName = normalizeStockCategory(itemName);
  if (strippedName && strippedCategory.toLowerCase() === strippedName.toLowerCase()) return '';

  return strippedCategory;
}

function normalizeSubRecipeDraftCategory(category = '') {
  const strippedCategory = normalizeStockCategory(category)
    .replace(/\s+-\s+Sub[-\s]?Recipe$/i, '')
    .replace(/^Sub[-\s]?Recipe$/i, '')
    .trim();
  return `${strippedCategory || 'General'} - Sub Recipe`;
}

function getFilteredSuppliers(items, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  return (items || []).filter((item) => {
    const matchesQuery = !query ||
      String(item.name || '').toLowerCase().includes(query) ||
      String(item.contactPerson || '').toLowerCase().includes(query) ||
      String(item.email || '').toLowerCase().includes(query);
    const matchesCategory = !filters.category || item.category === filters.category;
    return matchesQuery && matchesCategory;
  });
}

function getFilteredPurchaseOrders(items, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  return (items || []).filter((order) => {
    const matchesQuery = !query ||
      String(order.poNumber || '').toLowerCase().includes(query) ||
      String(order.supplierName || '').toLowerCase().includes(query) ||
      String(order.status || '').toLowerCase().includes(query);
    const matchesStatus = !filters.status || order.status === filters.status;
    return matchesQuery && matchesStatus;
  });
}

function getFilteredGrvReceipts(items, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  return (items || []).filter((receipt) => {
    const matchesQuery = !query ||
      String(receipt.grvNumber || '').toLowerCase().includes(query) ||
      String(receipt.poNumber || receipt.sourcePoId || '').toLowerCase().includes(query) ||
      String(receipt.sourceDisplay || receipt.sourceLabel || '').toLowerCase().includes(query) ||
      String(receipt.supplierName || '').toLowerCase().includes(query);
    const source = String(filters.source || '');
    const matchesSource = !source ||
      (source === 'po' && receipt.sourcePoId) ||
      (source === 'manual' && !receipt.sourcePoId);
    return matchesQuery && matchesSource;
  });
}

function getSupplierNameForPo(supplierId) {
  const id = String(supplierId || '');
  return (appState.purchaseOrders.suppliers || []).find((supplier) => String(supplier.id) === id)?.name || '';
}

function getOrderTotal(order) {
  return (order?.items || []).reduce((sum, line) => sum + Number(line.qty || 0) * getPositivePackSizeValue(line.packSize) * Number(line.unitCost || 0), 0);
}

function getPurchaseOrderExportData() {
  const selectedIds = new Set(appState.purchaseOrders.selectedIds || []);
  const filteredOrders = getFilteredPurchaseOrders(appState.purchaseOrders.orders || [], appState.purchaseOrders.filters || {});
  const orders = selectedIds.size
    ? filteredOrders.filter((order) => selectedIds.has(String(order.id)))
    : filteredOrders;

  return {
    orders
  };
}

function getPurchaseOrderLocationName(locationId, fallback = 'Main Store') {
  const id = String(locationId || '');
  if (!id) return fallback || '';
  return (appState.purchaseOrders.locations || []).find((location) => String(location.id) === id)?.name || fallback || id;
}

function getDefaultReceivingLocationId(locations = []) {
  const list = Array.isArray(locations) ? locations : [];
  const active = list.filter((location) => location?.active !== false);
  const isStorageLocation = (location = {}) => String(location.kind || location.type || location.locationType || '').toLowerCase() === 'storage';
  const isYocoLocation = (location = {}) => String(location.externalProvider || location.external_provider || location.source || '').toLowerCase() === 'yoco' ||
    String(location.yocoLocationId || location.yocoStoreLocationId || '').trim();
  const isMainStore = (location = {}) => {
    const id = normalizeLocationKey(location.id || location.locationId || '');
    const name = normalizeLocationKey(location.name || location.displayName || location.locationName || '');
    return ['main', 'locmain'].includes(id) || name === 'mainstore';
  };
  const candidates = getLocationsAllowedForCurrentRole(active.length ? active : list);
  return String(
    candidates.find((location) => isMainStore(location) && isStorageLocation(location))?.id ||
    candidates.find((location) => isMainStore(location) && !isYocoLocation(location))?.id ||
    candidates.find((location) => isStorageLocation(location) && location.isDefault === true)?.id ||
    candidates.find((location) => isStorageLocation(location) && !isYocoLocation(location))?.id ||
    candidates.find((location) => location.isDefault === true && !isYocoLocation(location))?.id ||
    candidates.find((location) => isMainStore(location))?.id ||
    candidates.find((location) => location.isDefault === true)?.id ||
    'main'
  );
}

function getLocationsAllowedForCurrentRole(locations = []) {
  const list = Array.isArray(locations) ? locations : [];
  if (appState.access?.currentIsSuperUser === true) return list;

  // Permission-based filter (role definition)
  const role = resolveRoleDefinition(appState.access?.currentRole || '', appState.access?.customRoles || []);
  const roleLocations = role.locations || [];
  let permFiltered = list;
  if (roleLocations.length && !roleLocations.includes('all')) {
    const permKeys = new Set(roleLocations.map((entry) => normalizeLocationKey(entry)).filter(Boolean));
    permFiltered = list.filter((location) => isLocationAllowedByKeys(location, permKeys));
  }

  // User-based filter (physically assigned locations) — takes priority and is MORE restrictive
  const userLocations = appState.access?.currentUserLocations || [];
  if (!userLocations.length) return permFiltered;
  const userKeys = new Set(userLocations.map((entry) => normalizeLocationKey(entry)).filter(Boolean));
  return permFiltered.filter((location) => isLocationAllowedByKeys(location, userKeys));
}

function getDefaultSellingLocationId(locations = []) {
  const list = Array.isArray(locations) ? locations : [];
  const active = list.filter((location) => location?.active !== false);
  const isSellingLocation = (location = {}) => {
    const type = String(location.kind || location.type || location.locationType || 'selling').trim().toLowerCase();
    return type === 'selling' || type === 'sale' || type === 'sales' || type === '';
  };
  const candidates = getLocationsAllowedForCurrentRole((active.length ? active : list).filter(isSellingLocation));
  const sorted = [...(candidates.length ? candidates : active.length ? active : list)]
    .filter((location) => String(location.id || location.locationId || '').trim())
    .sort((a, b) => String(a.displayName || a.name || a.id || '').localeCompare(String(b.displayName || b.name || b.id || '')));
  return String(sorted[0]?.id || sorted[0]?.locationId || '');
}

function isLocationAllowedByKeys(location = {}, allowedKeys = new Set()) {
  if (!allowedKeys.size) return true;
  const candidates = [
    location.id,
    location.locationId,
    location.name,
    location.displayName,
    location.locationName
  ].map(normalizeLocationKey).filter(Boolean);
  return candidates.some((candidate) => allowedKeys.has(candidate));
}

function getDefaultPurchaseOrderLocationId(order = null) {
  if (order?.targetLocation || order?.locationId) return String(order.targetLocation || order.locationId);
  return '';
}

function getGrvLocationName(locationId, fallback = 'Main Store') {
  const id = String(locationId || '');
  if (!id) return fallback || '';
  return (appState.grv.locations || []).find((location) => String(location.id) === id)?.name || fallback || id;
}

function getDefaultGrvLocationId(order = null) {
  return getDefaultReceivingLocationId(appState.grv.locations || []);
}

function getVatRate() {
  // NOTE: this previously read appState.source?.settings, but appState.source is never assigned
  // anywhere (it stays null for the app's entire lifetime) — so this was silently, permanently
  // hardcoded to 15% regardless of the workspace's actual configured VAT rate. Read the real,
  // live settings instead, and respect VAT-registration status: a non-registered workspace never
  // shows VAT on any live entry-form preview.
  const settings = appState.settings?.draft || appState.settings?.values || {};
  if (settings.vatRegistered === false) return 0;
  return Number(settings.vatRate ?? settings.vatPercentage ?? 15) || 15;
}

function getPdfBranding() {
  const settings = appState.settings?.draft || appState.settings?.values || {};
  return {
    companyName: appState.workspace?.siteName || settings.siteName || settings.workspaceName || 'Kitchen Cost Pro',
    logoDataUrl: settings.restaurantLogoDataUrl || settings.logoDataUrl || ''
  };
}

function stringifyDecimalField(rawValue, numericFallback = 0) {
  const text = String(rawValue ?? '').trim();
  if (text) return text;
  if (!numericFallback) return '';
  return String(Number(numericFallback.toFixed(4)));
}

function getPositivePackSizeValue(value) {
  const parsed = parseDecimal(value, 1);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function reconcilePurchaseOrderDraft(draft, live = {}) {
  if (!draft) return null;
  if (!draft.id) return draft;
  const liveOrder = (live.orders || []).find((order) => String(order.id) === String(draft.id));
  if (!liveOrder) return draft;
  return {
    ...draft,
    items: structuredCloneSafe(liveOrder.items || draft.items || []),
    status: liveOrder.status,
    submittedAt: liveOrder.submittedAt,
    partiallyReceivedAt: liveOrder.partiallyReceivedAt,
    receivedAt: liveOrder.receivedAt,
    updatedAt: liveOrder.updatedAt
  };
}

function reconcileGrvDraft(draft, live = {}) {
  if (!draft) return createEmptyGrvDraft();

  if (draft.sourcePoId) {
    const liveOrder = (live.orders || []).find((order) => String(order.id) === String(draft.sourcePoId));
    if (['completed', 'received'].includes(String(liveOrder?.status || '').toLowerCase())) return draft;
  }

  const stockMap = new Map((live.stockItems || []).map((item) => [String(item.id), item]));
  // A manual GRV (not sourced from a PO) with no items must never show a prefilled
  // destination — it starts blank so the user is forced to pick one. Once items are
  // added, or the GRV came from a PO, we keep whatever location is set.
  const hasItems = (draft.items || []).length > 0;
  const locationId = (!hasItems && !draft.sourcePoId) ? '' : (draft.locationId || '');
  const locationName = locationId ? getLocationNameById(live.locations || [], locationId, draft.locationName || '') : '';
  return {
    ...draft,
    locationId,
    targetLocation: locationId,
    locationName,
    targetLocationName: locationName,
    items: (draft.items || []).map((line) => {
      const stockItem = stockMap.get(String(line.stockItemId));
      if (!stockItem) return line;
      return {
        ...line,
        stockItemName: line.stockItemName || stockItem.name,
        unit: line.unit || stockItem.unit || 'ea',
        selectedUom: line.selectedUom || line.receivingUom || line.purchaseUom || line.unit || stockItem.unit || 'ea',
        uomConfigurations: normalizeLineUomConfigurations(line.uomConfigurations || stockItem.uomConfigurations || stockItem.uomConfig || stockItem.uomConversions),
        unitCost: Number(line.unitCost || stockItem.lastPurchasePrice || stockItem.cost || 0),
        locationName: getLocationNameById(
          live.locations || [],
          line.locationId || line.targetLocation || draft.locationId,
          line.locationName || line.targetLocationName || draft.locationName || ''
        ),
        targetLocationName: getLocationNameById(
          live.locations || [],
          line.locationId || line.targetLocation || draft.locationId,
          line.targetLocationName || line.locationName || draft.locationName || ''
        )
      };
    })
  };
}

function reconcileCreditNoteDraft(draft, live = {}) {
  if (!draft) return createEmptyCreditNoteDraft();
  const stockMap = new Map((live.stockItems || []).map((item) => [String(item.id), item]));
  const supplierById = new Map((live.suppliers || []).map((supplier) => [String(supplier.id), supplier]));

  return {
    ...draft,
    supplierName: supplierById.get(String(draft.supplierId || ''))?.name || draft.supplierName || '',
    locationName: getLocationNameById(live.locations || [], draft.locationId, draft.locationName || 'Main Store'),
    items: (draft.items || []).map((line) => {
      const stockItemId = resolveStockItemIdFromLine(line);
      const stockItem = stockMap.get(stockItemId);
      return {
        ...line,
        stockItemId,
        stockItemName: line.stockItemName || stockItem?.name || '',
        unit: line.unit || stockItem?.unit || 'ea',
        locationName: getLocationNameById(
          live.locations || [],
          line.locationId || draft.locationId,
          line.locationName || draft.locationName || 'Main Store'
        ),
        unitCost: Number(line.unitCost || stockItem?.lastPurchasePrice || stockItem?.cost || 0)
      };
    })
  };
}

function parseBarcodeInput(value) {
  return parseBarcodeValues(value);
}

function showMenuToast(message, type = 'success') {
  if (menuToastTimer) window.clearTimeout(menuToastTimer);

  appState.menu = {
    ...appState.menu,
    toast: { message, type }
  };
  renderApp();

  menuToastTimer = window.setTimeout(() => {
    menuToastTimer = null;
    if (!appState.menu.toast || appState.menu.toast.message !== message) return;
    appState.menu = {
      ...appState.menu,
      toast: null
    };
    renderApp();
  }, 4200);
}

function showRecipeToast(message, type = 'success') {
  if (recipeToastTimer) window.clearTimeout(recipeToastTimer);

  appState.recipes = {
    ...appState.recipes,
    toast: { message, type }
  };
  renderApp();

  recipeToastTimer = window.setTimeout(() => {
    recipeToastTimer = null;
    if (!appState.recipes.toast || appState.recipes.toast.message !== message) return;
    appState.recipes = {
      ...appState.recipes,
      toast: null
    };
    renderApp();
  }, 4200);
}

function showStockToast(message, type = 'success') {
  if (stockToastTimer) window.clearTimeout(stockToastTimer);

  appState.stock = {
    ...appState.stock,
    toast: { message, type }
  };
  renderApp();

  stockToastTimer = window.setTimeout(() => {
    stockToastTimer = null;
    if (!appState.stock.toast || appState.stock.toast.message !== message) return;
    appState.stock = {
      ...appState.stock,
      toast: null
    };
    renderApp();
  }, 4200);
}

function showSupplierToast(message, type = 'success') {
  if (supplierToastTimer) window.clearTimeout(supplierToastTimer);

  appState.suppliers = {
    ...appState.suppliers,
    toast: { message, type }
  };
  renderApp();

  supplierToastTimer = window.setTimeout(() => {
    supplierToastTimer = null;
    if (!appState.suppliers.toast || appState.suppliers.toast.message !== message) return;
    appState.suppliers = {
      ...appState.suppliers,
      toast: null
    };
    renderApp();
  }, 4200);
}

function showPurchaseOrderToast(message, type = 'success') {
  if (purchaseOrderToastTimer) window.clearTimeout(purchaseOrderToastTimer);

  appState.purchaseOrders = {
    ...appState.purchaseOrders,
    toast: { message, type }
  };
  renderApp();

  purchaseOrderToastTimer = window.setTimeout(() => {
    purchaseOrderToastTimer = null;
    if (!appState.purchaseOrders.toast || appState.purchaseOrders.toast.message !== message) return;
    appState.purchaseOrders = {
      ...appState.purchaseOrders,
      toast: null
    };
    renderApp();
  }, 4200);
}

let lastGrvToastKey = '';
let lastGrvToastAt = 0;
function showGrvToast(message, type = 'success') {
  // Dedupe identical toasts fired within a short window (guards against any double-fire).
  const key = `${type}|${message}`;
  const now = Date.now();
  if (key === lastGrvToastKey && (now - lastGrvToastAt) < 1500) return;
  lastGrvToastKey = key;
  lastGrvToastAt = now;

  if (grvToastTimer) window.clearTimeout(grvToastTimer);

  appState.grv = {
    ...appState.grv,
    toast: { message, type }
  };
  renderApp();

  grvToastTimer = window.setTimeout(() => {
    grvToastTimer = null;
    if (!appState.grv.toast || appState.grv.toast.message !== message) return;
    appState.grv = {
      ...appState.grv,
      toast: null
    };
    renderApp();
  }, 4200);
}

function clearReportingNavigationParameters() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    const keys = [
      'report', 'view', 'from', 'to', 'startDate', 'endDate', 'dateRangeType',
      'search', 'time', 'locationId', 'category', 'source', 'sourceType',
      'paymentMethod', 'status', 'receiptNumber', 'menuCategory', 'menuItemId',
      'inventoryCategory', 'inventoryItemId', 'modifierGroupId', 'modifierType',
      'modifierName', 'stockDeductionStatus', 'yocoCategory', 'recipeStatus',
      'riskStatus', 'warningSeverity', 'supplierId', 'itemType', 'onlyCritical',
      'onlyBelowPar', 'missingSupplier', 'missingCost', 'user', 'action',
      'entityType', 'entityName'
    ];
    keys.forEach((key) => url.searchParams.delete(key));
    url.searchParams.set('route', 'reporting');
    window.history.replaceState({}, '', url);
  } catch (error) {
    console.warn('[Reporting] Could not reset stale report navigation state:', error);
  }
}

// Companion to clearReportingNavigationParameters(): removes `route=reporting` (and any leftover
// reporting deep-link filter params) from the URL when navigating to any OTHER section, so a
// later page refresh doesn't re-read a stale reporting URL and get forced back into Reporting.
function clearStaleReportingRouteParam() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('route')) return;
    const keys = [
      'route', 'report', 'view', 'from', 'to', 'startDate', 'endDate', 'dateRangeType',
      'search', 'time', 'locationId', 'category', 'source', 'sourceType',
      'paymentMethod', 'status', 'receiptNumber', 'menuCategory', 'menuItemId',
      'inventoryCategory', 'inventoryItemId', 'modifierGroupId', 'modifierType',
      'modifierName', 'stockDeductionStatus', 'yocoCategory', 'recipeStatus',
      'riskStatus', 'warningSeverity', 'supplierId', 'itemType', 'onlyCritical',
      'onlyBelowPar', 'missingSupplier', 'missingCost', 'user', 'action',
      'entityType', 'entityName'
    ];
    keys.forEach((key) => url.searchParams.delete(key));
    window.history.replaceState({}, '', url);
  } catch (error) {
    console.warn('[Route] Could not clear stale reporting route param:', error);
  }
}

function getInitialRoute() {
  try {
    const requestedRoute = new URLSearchParams(window.location.search).get('route');
    if (PERSISTED_ROUTES.includes(requestedRoute)) return requestedRoute;
  } catch (error) {
    console.warn('[Route] Could not read route from URL:', error);
  }

  try {
    const storedRoute = localStorage.getItem(ROUTE_STORAGE_KEY);
    if (PERSISTED_ROUTES.includes(storedRoute)) return storedRoute;
  } catch (error) {
    console.warn('[Route] Could not read route preference:', error);
  }

  return 'dashboard';
}

function persistRoute(routeId) {
  try {
    if (PERSISTED_ROUTES.includes(routeId)) {
      localStorage.setItem(ROUTE_STORAGE_KEY, routeId);
    }
  } catch (error) {
    console.warn('[Route] Could not persist route preference:', error);
  }
}

function getDraftStorageScope() {
  const workspaceId = String(appState.workspace?.id || '').trim();
  const userId = String(appState.user?.uid || appState.user?.id || '').trim();
  if (!workspaceId || !userId) return null;
  return { workspaceId, userId };
}

function getDraftStorageKey(moduleKey) {
  const scope = getDraftStorageScope();
  if (!scope) return '';
  return `${DRAFT_STORAGE_PREFIX}:${scope.workspaceId}:${scope.userId}:${moduleKey}`;
}

function loadPersistedDraft(moduleKey, createFallback) {
  const storageKey = getDraftStorageKey(moduleKey);
  if (!storageKey) return typeof createFallback === 'function' ? createFallback() : null;

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return typeof createFallback === 'function' ? createFallback() : null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return typeof createFallback === 'function' ? createFallback() : null;
    }
    return parsed.draft || (typeof createFallback === 'function' ? createFallback() : null);
  } catch (error) {
    console.warn(`[Drafts] Could not restore ${moduleKey} draft:`, error);
    return typeof createFallback === 'function' ? createFallback() : null;
  }
}

function persistDraft(moduleKey, draft, isDirty) {
  const storageKey = getDraftStorageKey(moduleKey);
  if (!storageKey) return;

  try {
    if (!isDirty) {
      localStorage.removeItem(storageKey);
      return;
    }

    localStorage.setItem(storageKey, JSON.stringify({
      savedAt: new Date().toISOString(),
      draft: structuredCloneSafe(draft)
    }));
  } catch (error) {
    console.warn(`[Drafts] Could not persist ${moduleKey} draft:`, error);
  }
}

function clearPersistedDraft(moduleKey) {
  const storageKey = getDraftStorageKey(moduleKey);
  if (!storageKey) return;
  try {
    localStorage.removeItem(storageKey);
  } catch (error) {
    console.warn(`[Drafts] Could not clear ${moduleKey} draft:`, error);
  }
}

function isGrvDraftDirty(draft = {}) {
  return Boolean(
    String(draft.grvNumber || '').trim()
    || String(draft.sourcePoId || '').trim()
    || String(draft.supplierName || '').trim()
    || String(draft.notes || '').trim()
    || String(draft.transportEx || '').trim()
    || String(draft.invoiceDiscountEx || '').trim()
    || String(draft.invoiceTotalEx || '').trim()
    || (draft.items || []).length
  );
}

function isCreditNoteDraftDirty(draft = {}) {
  return Boolean(
    String(draft.cnNumber || '').trim()
    || String(draft.supplierName || '').trim()
    || String(draft.sourceGrvId || '').trim()
    || String(draft.sourcePoId || '').trim()
    || String(draft.poNumber || '').trim()
    || (draft.sourceReceiptIds || []).length
    || String(draft.notes || '').trim()
    || (draft.items || []).length
  );
}

function persistGrvDraftSnapshot(draft = appState.grv.draftReceipt) {
  persistDraft('grv', draft, isGrvDraftDirty(draft));
}

function persistCreditNoteDraftSnapshot(draft = appState.creditNotes.draftNote) {
  persistDraft('credit-note', draft, isCreditNoteDraftDirty(draft));
}

function parseMenuImportRows(text, fileName = '') {
  const body = String(text || '').trim();
  if (!body) return [];

  const isJson = /\.json$/i.test(fileName) || body.startsWith('{') || body.startsWith('[');
  if (!isJson) return parseCsvRows(body);

  const parsed = JSON.parse(body);
  if (Array.isArray(parsed)) return parsed;

  const candidates = parsed.menu_items || parsed.menuItems || parsed.items || parsed.products || parsed.data || parsed;
  if (Array.isArray(candidates)) return candidates;
  if (candidates && typeof candidates === 'object') {
    return Object.entries(candidates).map(([id, value]) => ({
      ProductID: id,
      ProductName: value?.name || value?.ProductName || id,
      Category: value?.category || value?.ProductCategory || value?.Group || '',
      SellingPrice: value?.sellingPrice ?? value?.SellingPrice ?? value?.Price ?? value?.price ?? 0,
      ...(value && typeof value === 'object' ? value : {})
    }));
  }

  return [];
}

function parseCsvRows(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      row.push(field);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((value) => String(value).trim())) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => String(header || '').trim());
  return rows.map((values) => Object.fromEntries(
    headers.map((header, index) => [header, values[index] ?? ''])
  ));
}

function mapLegacyMenuRows(rows = []) {
  const groups = {};
  const review = createImportReview(rows);

  getImportDataRows(rows).forEach(({ row, rowNumber }) => {
    const pid = norm(getColumn(row, 'ProductID', 'Product_ID', 'ID', 'Id', 'Code', 'SKU'));
    const name = norm(getColumn(row, 'ProductName', 'Product_Name', 'Product Name', 'Name', 'Product'));
    if (!name) {
      review.errors.push(createImportError('ERR_MISSING_NAME', rowNumber, 'ProductName is required.'));
      return;
    }
    const key = pid || name;
    if (!groups[key]) groups[key] = { pid, name, rows: [] };
    groups[key].name = groups[key].name || name;
    groups[key].rows.push({ row, rowNumber });
  });

  const mapped = Object.values(groups).flatMap((group) => {
    if (!group.name) return [];

    const hasVariants = group.rows.some(({ row }) => (
      norm(getColumn(row, 'Value1', 'Value 1', 'Variant1', 'Value2', 'Value 2', 'Variant2', 'Value3', 'Value 3', 'Variant3', 'Variant'))
    ));

    return group.rows.map(({ row, rowNumber }) => {
      const category = norm(getColumn(row, 'Category', 'ProductCategory', 'Product Category', 'Group')) || 'Imported';
      const v1 = norm(getColumn(row, 'Value1', 'Variant1', 'Value 1'));
      const v2 = norm(getColumn(row, 'Value2', 'Variant2', 'Value 2'));
      const v3 = norm(getColumn(row, 'Value3', 'Variant3', 'Value 3'));
      const variantLabel = [v1, v2, v3].filter(Boolean).join(' / ');

      if (hasVariants && !variantLabel) {
        review.errors.push(createImportError('ERR_VARIANT_VALUE', rowNumber, 'Variant value is required because this product has variant rows.'));
        return null;
      }

      const priceRaw = getColumn(
        row,
        'VariantPrice',
        'Selling_Price',
        'SellingPrice',
        'Selling Price',
        'Price',
        'RetailPrice',
        'DefaultPrice',
        'Retail_Price'
      );
      const sellingPrice = parseImportNumber(priceRaw, 0);
      if (sellingPrice === null || sellingPrice < 0) {
        review.errors.push(createImportError('ERR_PRICE', rowNumber, 'Selling_Price must be a valid number.'));
        return null;
      }
      const name = variantLabel ? `${group.name} (${variantLabel})` : group.name;
      const barcodes = parseBarcodeInput(getColumn(row, 'Barcodes', 'Barcode', 'EAN', 'UPC'));

      return {
        id: safeMenuId(name),
        name,
        category,
        sellingPrice,
        barcodes
      };
    }).filter(Boolean);
  });

  const items = [...new Map(mapped.map((item) => [item.id, item])).values()];
  review.importedCount = items.length;
  review.skippedCount = review.errors.length;
  return { items, review };
}

function mapLegacyRecipeRows(rows = []) {
  const ingredientByName = new Map(
    (appState.recipes.ingredients || []).map((ingredient) => [
      norm(ingredient.name).toLowerCase(),
      ingredient
    ])
  );
  const ingredientById = new Map(
    (appState.recipes.ingredients || []).map((ingredient) => [
      String(ingredient.id || '').trim(),
      ingredient
    ])
  );
  const existingProductItems = (appState.recipes.items || [])
    .filter((item) => item?.recipeOwnerType !== 'yoco_modifier' && !String(item?.id || '').startsWith('modifier:'));
  const existingMenuByName = new Map(existingProductItems.map((item) => [normalizeImportKey(item.name), item]));
  const existingMenuById = new Map(existingProductItems.flatMap((item) => [
    [normalizeImportKey(item.id), item],
    [normalizeImportKey(item.productId), item],
    [normalizeImportKey(item.yocoVariantId), item],
    [normalizeImportKey(item.yocoItemId), item]
  ]).filter(([key]) => key));
  const existingMenuBySku = new Map(existingProductItems.flatMap((item) => [
    [normalizeImportKey(item.sku), item],
    [normalizeImportKey(item.customSku), item]
  ]).filter(([key]) => key));
  const groups = new Map();
  let missingIngredients = 0;
  const review = createImportReview(rows);

  getImportDataRows(rows).forEach(({ row, rowNumber }) => {
    const productName = norm(getColumn(row, 'Product_Name', 'ProductName', 'Product Name', 'Product', 'Name'));
    const productId = norm(getColumn(row, 'Product_ID', 'Product ID', 'ProductId', 'Menu_Item_ID', 'Menu Item ID', 'MenuItemId', 'Item_ID', 'Item ID'));
    const productSku = norm(getColumn(row, 'SKU', 'Product_SKU', 'Product SKU', 'Code'));
    if (!productName) {
      review.errors.push(createImportError('ERR_MISSING_PRODUCT', rowNumber, 'Product_Name is required.'));
      return;
    }

    const category = norm(getColumn(row, 'Category', 'Product_Category', 'ProductCategory', 'Product Category'));
    const ingredientName = norm(getColumn(row, 'Ingredient_Name', 'IngredientName', 'Ingredient Name', 'Ingredient'));
    const ingredientId = norm(getColumn(row, 'Ingredient_ID', 'Ingredient ID', 'Stock_Item_ID', 'StockItemId', 'Stock Item ID', 'Item_ID', 'Item ID', 'ingId'));
    const qtyRaw = getColumn(row, 'Quantity_Needed', 'Quantity', 'Qty', 'Quantity Needed');
    const hasIngredientFields = Boolean(ingredientName || ingredientId || String(qtyRaw ?? '').trim());
    if (!hasIngredientFields) return;

    const existingProduct = existingMenuById.get(normalizeImportKey(productId)) ||
      existingMenuBySku.get(normalizeImportKey(productSku)) ||
      existingMenuByName.get(normalizeImportKey(productName));
    if (!existingProduct) {
      review.errors.push(createImportError('ERR_PRODUCT_LOOKUP', rowNumber, `Menu item "${productName}" was not found. Import the menu item first, then import the recipe.`));
      return;
    }

    const groupKey = String(existingProduct.id || productName);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        existing: existingProduct,
        name: existingProduct.name || productName,
        category: category || existingProduct.category || '',
        recipe: []
      });
    }
    const group = groups.get(groupKey);
    if (category) group.category = category;

    if (!ingredientName && !ingredientId) {
      review.errors.push(createImportError('ERR_MISSING_INGREDIENT', rowNumber, 'Ingredient_Name or Ingredient_ID is required.'));
      return;
    }
    const ingredient = ingredientById.get(ingredientId) || ingredientByName.get(ingredientName.toLowerCase());
    if (!ingredient) {
      missingIngredients += 1;
      review.errors.push(createImportError('ERR_INGREDIENT_LOOKUP', rowNumber, `Ingredient "${ingredientName || ingredientId}" was not found in stock items.`));
      return;
    }

    const qty = parseImportNumber(qtyRaw, null);
    if (qty === null || qty <= 0) {
      review.errors.push(createImportError('ERR_QUANTITY', rowNumber, 'Quantity_Needed must be a number greater than zero.'));
      return;
    }

    // Resolve the unit of measure for this line. Valid options are the ingredient's
    // base unit plus any custom UOMs it defines. If the sheet specifies a UOM we
    // honour it (so the recipe uses the custom unit, not just the base unit).
    const baseUnit = String(ingredient.unit || ingredient.uom || 'ea').trim() || 'ea';
    const customUoms = (Array.isArray(ingredient.uomConfigurations) ? ingredient.uomConfigurations : [])
      .map((cfg) => String(cfg.customUom || cfg.custom_uom || '').trim())
      .filter(Boolean);
    const validUoms = [baseUnit, ...customUoms];
    const uomRaw = norm(getColumn(row, 'UOM', 'Unit', 'Unit_Of_Measure', 'UnitOfMeasure', 'Unit Of Measure', 'Base_UOM', 'Measure'));
    let unit = baseUnit;
    if (uomRaw) {
      const matched = validUoms.find((u) => u.toLowerCase() === uomRaw.toLowerCase());
      if (!matched) {
        review.errors.push(createImportError('ERR_UOM_INVALID', rowNumber, `UOM "${uomRaw}" is not valid for ${ingredient.name || ingredientName}. Allowed: ${validUoms.join(', ')}.`));
        return;
      }
      unit = matched;
    }

    const existingLine = group.recipe.find((line) => String(line.ingId) === String(ingredient.id) && String(line.unit || '') === String(unit));
    if (existingLine) existingLine.qty += qty;
    else group.recipe.push({ ingId: ingredient.id, qty, unit });
  });

  const recipes = [...groups.values()].filter((group) => group.recipe.length).map((group) => {
    const existing = group.existing;
    return {
      id: existing.id,
      name: group.name,
      category: group.category || existing.category || '',
      sellingPrice: Number(existing.sellingPrice ?? existing.price ?? 0) || 0,
      sku: existing.sku || '',
      customSku: existing.customSku || '',
      externalProvider: existing.externalProvider || (existing.yocoItemId || existing.yocoVariantId ? 'yoco' : ''),
      yocoItemId: existing.yocoItemId || '',
      yocoVariantId: existing.yocoVariantId || '',
      yocoCategoryId: existing.yocoCategoryId || '',
      yocoCategoryName: existing.yocoCategoryName || '',
      recipe: group.recipe
    };
  });

  review.importedCount = recipes.length;
  review.skippedCount = review.errors.length;
  return { recipes, review, missingIngredients };
}

function mapLegacyStockRows(rows = []) {
  const existingKeys = new Set((appState.stock.items || []).flatMap((item) => [
    normalizeImportKey(item.id),
    normalizeImportKey(item.sku)
  ]).filter(Boolean));
  const existingNameKeys = new Set((appState.stock.items || [])
    .map((item) => normalizeStockItemDuplicateName(item.name))
    .filter(Boolean));
  const fileKeys = new Set();
  const fileNameKeys = new Set();
  const review = {
    totalRows: rows.length,
    importedCount: 0,
    skippedCount: 0,
    errors: []
  };

  const items = getImportDataRows(rows).map(({ row, rowNumber }) => {
    let name = norm(getColumn(row, 'Item_Name', 'Item Name', 'Name', 'IngredientName', 'Ingredient'));
    if (!name) {
      review.errors.push(createImportError('ERR_MISSING_REQ', rowNumber, 'Item_Name is required.'));
      return null;
    }

    const sku = norm(getColumn(row, 'SKU', 'ID', 'Id', 'Code'));
    const duplicateNameKey = normalizeStockItemDuplicateName(name);
    if (duplicateNameKey && (fileNameKeys.has(duplicateNameKey) || existingNameKeys.has(duplicateNameKey))) {
      review.errors.push(createImportError('ERR_DUPLICATE_NAME', rowNumber, `Stock item "${name}" already exists. Stock item names must be unique.`));
      return null;
    }
    if (duplicateNameKey) fileNameKeys.add(duplicateNameKey);

    const duplicateKey = normalizeImportKey(sku || name);
    if (duplicateKey && (fileKeys.has(duplicateKey) || (sku && existingKeys.has(duplicateKey)))) {
      review.skippedCount += 1;
      return null;
    }
    if (duplicateKey) fileKeys.add(duplicateKey);

    const itemTypeRaw = norm(getColumn(row, 'Item_Type', 'Item Type', 'ItemType', 'Type', 'Specification'));
    // 'Non Stock' is the current label; legacy 'Recipe Source' / 'Non-Stock Item' still accepted.
    const VALID_ITEM_TYPES = ['sub-recipe', 'non stock', 'non-stock', 'recipe source', 'non-stock item', 'non_stock_item', 'non stock item', 'standard', 'manufactured', 'sub_recipe', 'recipe_source'];
    if (itemTypeRaw && !VALID_ITEM_TYPES.includes(itemTypeRaw.toLowerCase())) {
      review.errors.push(createImportError('ERR_ITEM_TYPE', rowNumber, `Invalid Item_Type "${itemTypeRaw}". Allowed values: Sub-Recipe, Non Stock, Standard, Manufactured.`));
      return null;
    }
    const normalizedItemType = (() => {
      const t = (itemTypeRaw || '').toLowerCase().replace(/[\s-]+/g, '_');
      if (['sub_recipe', 'subrecipe'].includes(t)) return 'sub_recipe';
      if (['recipe_source', 'recipe_source_item'].includes(t)) return 'recipe_source';
      if (['non_stock_item', 'non_stock', 'nonstock'].includes(t)) return 'recipe_source';
      if (['manufactured', 'prep', 'prepared'].includes(t)) return 'manufactured';
      return 'standard';
    })();

    let category = norm(getColumn(
      row,
      'Category',
      'Inventory_Category',
      'Inventory Category',
      'Stock_Category',
      'Stock Category',
      'IngredientCategory',
      'Ingredient Category',
      'Group'
    ));
    // Is_Manufactured is legacy — Item_Type takes precedence when both are present.
    // We still read Is_Manufactured for backwards compatibility with old templates.
    const mfgRaw = norm(getColumn(row, 'Is_Manufactured', 'Is Manufactured', 'Manufactured', 'Manufacture', 'Manufacturing', 'MFG')).toLowerCase();
    const legacyIsManufactured = ['yes', '1', 'true', 'mfg', 'manufactured', 'y'].includes(mfgRaw);
    // Item_Type wins: if it says Manufactured, treat as manufactured regardless of Is_Manufactured.
    const isManufactured = normalizedItemType === 'manufactured' || (normalizedItemType === 'standard' && legacyIsManufactured);
    if (isManufactured || normalizedItemType === 'manufactured') {
      name = normalizeManufacturedItemName(name);
      category = category || 'Manufactured';
    } else if (normalizedItemType === 'sub_recipe') {
      category = category || 'Sub-Recipe';
    } else if (normalizedItemType === 'recipe_source') {
      category = category || 'Non Stock';
    } else {
      category = category || 'General';
      if (!category.toLowerCase().includes('raw materials')) category += ' - Raw Materials';
    }

    const vatRaw = norm(getColumn(row, 'VAT_Enabled', 'VAT Enabled', 'VATEnabled', 'Taxable', 'VAT'));
    const vatEnabled = parseStrictBoolean(vatRaw, false);
    if (vatEnabled === null) {
      review.errors.push(createImportError('ERR_VAT_FORMAT', rowNumber, `Invalid VAT value "${vatRaw}". Use Yes, No, Tax Exempt, Y, N, True, False, 1, or 0.`));
      return null;
    }
    if (!category) {
      review.errors.push(createImportError('ERR_CAT_MAPPING', rowNumber, 'Category could not be determined.'));
      return null;
    }
    // Track_Inventory is retained only as legacy input help. Non-stock items can also hold
    // stock on hand, so Recipe Source rows now default to tracked inventory as well.
    const trackInventoryRaw = norm(getColumn(row, 'Track_Inventory', 'Track Inventory', 'TrackInventory', 'Is_Stocked', 'Is Stocked', 'Stocked'));
    const trackInventory = trackInventoryRaw
      ? (parseStrictBoolean(trackInventoryRaw, true) ?? true)
      : true;
    const costRaw = getColumn(row, 'Cost_Ex_VAT', 'Cost Ex VAT', 'Ex_VAT_Cost', 'Cost', 'Price');
    const thresholdRaw = getColumn(row, 'Low_Stock_Threshold', 'Threshold', 'MinStock');
    const openingStockRaw = getColumn(row, 'Opening_Stock', 'Opening Stock');
    const legacyStockRaw = getColumn(
      row,
      'Stock',
      'On_Hand',
      'OnHand',
      'On Hand',
      'On Hand Qty',
      'On_Hand_Qty',
      'Qty On Hand',
      'Quantity On Hand',
      'Current Stock',
      'Current_Stock',
      'Stock On Hand',
      'Stock_On_Hand'
    );
    const parRaw = getColumn(row, 'Par_Level', 'ParLevel', 'Par Level', 'Par');
    const yieldPercentRaw = getColumn(row, 'Yield_Percentage', 'Yield Percentage', 'Yield_Percent', 'YieldPercent', 'Yield %', 'Yield');
    const batchYieldRaw = getColumn(row, 'Batch_Yield', 'BatchYield', 'Batch Yield');
    const barcode = getColumn(row, 'Barcode', 'Barcodes', 'EAN', 'UPC');
    const baseUnit = norm(getColumn(row, 'Base_UOM', 'Base UOM', 'Unit', 'UOM')) || 'ea';
    const defaultOrderingUom = norm(getColumn(
      row,
      'Default_Ordering_UOM',
      'Default Ordering UOM',
      'Default_Order_UOM',
      'Default Order UOM',
      'Ordering_UOM',
      'Ordering UOM',
      'Purchase_UOM',
      'Purchase UOM'
    ));
    const errorCountBeforeUom = review.errors.length;
    const uomConfigurations = parseStockImportUomConfigurations(row, baseUnit, rowNumber, review, defaultOrderingUom);
    if (review.errors.length > errorCountBeforeUom) return null;
    const siteId = norm(getColumn(row, 'Site_ID', 'SiteId', 'siteId'));
    const siteName = norm(getColumn(row, 'Site', 'Site_Name', 'Store', 'Store_Location'));
    const locationId = norm(getColumn(row, 'Location_ID', 'LocationId', 'Stock_Location_ID', 'stockLocationId'));
    const locationName = norm(getColumn(row, 'Default_Location', 'Default Location', 'Location', 'Stock_Location', 'StockLocation', 'Storage_Location', 'StorageLocation'));
    const cost = parseImportNumber(costRaw, 0);
    const openingStockProvided = String(openingStockRaw ?? '').trim() !== '';
    const stockAdjustmentProvided = !openingStockProvided && String(legacyStockRaw ?? '').trim() !== '';
    const lowStockThreshold = parseImportNumber(thresholdRaw, 5);
    const parLevel = parseImportNumber(parRaw, 0);
    const yieldFactor = parseImportNumber(yieldPercentRaw, 100);
    const yieldBatch = parseImportNumber(batchYieldRaw, 1);
    const openingStock = openingStockProvided ? parseImportNumber(openingStockRaw, 0) : 0;
    if ([cost, lowStockThreshold, parLevel, yieldFactor, yieldBatch, openingStock].some((value) => value === null)) {
      review.errors.push(createImportError('ERR_NUMBER_FORMAT', rowNumber, 'Numeric fields must contain valid numbers.'));
      return null;
    }
    if (stockAdjustmentProvided) {
      review.errors.push(createImportError('WARN_STOCK_ADJUSTMENT_IGNORED', rowNumber, 'Adjustment found but not processed. Please use the Adjustments Tab.'));
    }
    if (yieldFactor <= 0 || yieldBatch <= 0) {
      review.errors.push(createImportError('ERR_YIELD_FORMAT', rowNumber, 'Yield_Percent and Batch_Yield must be greater than zero.'));
      return null;
    }

    return {
      id: sku || safeMenuId(name),
      // Persist the SKU as its own field so it shows in the Stock Items SKU column
      // (the id is used for uniqueness; sku is what the table renders).
      sku,
      name,
      category,
      unit: baseUnit,
      cost,
      stockAdjustmentIgnored: stockAdjustmentProvided,
      isManufactured: normalizedItemType === 'manufactured',
      isStocked: normalizedItemType === 'sub_recipe' ? false : trackInventory,
      isSubRecipe: normalizedItemType === 'sub_recipe',
      itemType: normalizedItemType,
      vatEnabled,
      lowStockThreshold,
      parLevel,
      yieldFactor,
      yieldBatch,
      ...(openingStockProvided ? {
        stock: openingStock,
        __openingStockProvided: true
      } : {}),
      barcodes: parseBarcodeInput(barcode),
      uomConfigurations,
      notes: norm(getColumn(row, 'Notes', 'Note', 'Comments', 'Comment')),
      siteId,
      siteName,
      locationId,
      locationName,
      targetLocation: locationId,
      targetLocationName: locationName
    };
  }).filter(Boolean);

  review.importedCount = items.length;
  review.skippedCount += review.errors.filter((entry) => !String(entry.code || '').startsWith('WARN_')).length;
  return { items, review };
}

function parseStockImportUomConfigurations(row = {}, baseUnit = 'ea', rowNumber = 0, review = { errors: [] }, defaultOrderingUom = '') {
  const configurations = [1, 2, 3].map((slot) => {
    const customUom = norm(getColumn(
      row,
      `UOM_${slot}_Name`,
      `UOM ${slot} Name`,
      `UOM_${slot}`,
      `UOM ${slot}`,
      `Custom_UOM_${slot}_Name`,
      `Custom UOM ${slot} Name`,
      `Custom_UOM_${slot}`,
      `Custom UOM ${slot}`,
      `Ordering_UOM_${slot}`,
      `Ordering UOM ${slot}`
    ));
    const ratioRaw = getColumn(
      row,
      `UOM_${slot}_Qty_In_Base`,
      `UOM ${slot} Qty In Base`,
      `UOM_${slot}_Qty`,
      `UOM ${slot} Qty`,
      `Custom_UOM_${slot}_Ratio`,
      `Custom UOM ${slot} Ratio`,
      `Custom_UOM_${slot}_Qty`,
      `Custom UOM ${slot} Qty`,
      `UOM_${slot}_Ratio`,
      `UOM ${slot} Ratio`,
      `Ratio_${slot}`,
      `Ratio ${slot}`
    );
    const barcode = norm(getColumn(
      row,
      `UOM_${slot}_Barcode`,
      `UOM ${slot} Barcode`,
      `Custom_UOM_${slot}_Barcode`,
      `Custom UOM ${slot} Barcode`,
      `UOM_Barcode_${slot}`,
      `UOM Barcode ${slot}`
    ));
    const hasAnyValue = Boolean(customUom || String(ratioRaw ?? '').trim() || barcode);
    if (!hasAnyValue) return null;
    const ratio = parseImportNumber(ratioRaw, null);
    if (!customUom || ratio === null || ratio <= 0) {
      review.errors.push(createImportError('ERR_UOM_CONFIG', rowNumber, `UOM_${slot}_Name needs a matching UOM_${slot}_Qty_In_Base greater than zero.`));
      return null;
    }
    return {
      baseUom: baseUnit || 'ea',
      customUom,
      ratio,
      barcode,
      isDefaultOrdering: false
    };
  }).filter(Boolean);

  const requestedDefault = String(defaultOrderingUom || '').trim();
  if (!requestedDefault || requestedDefault.toLowerCase() === String(baseUnit || 'ea').toLowerCase()) {
    return configurations;
  }
  const matchingConfig = configurations.find((config) => config.customUom.toLowerCase() === requestedDefault.toLowerCase());
  if (!matchingConfig) {
    review.errors.push(createImportError(
      'ERR_DEFAULT_ORDERING_UOM',
      rowNumber,
      'Default_Ordering_UOM must match the Base_UOM or one of the UOM_1, UOM_2, or UOM_3 names on the same row.'
    ));
    return configurations;
  }
  matchingConfig.isDefaultOrdering = true;
  return configurations;
}

function mapSupplierImportRows(rows = []) {
  const review = createImportReview(rows);
  const mappedRows = getImportDataRows(rows).map(({ row, rowNumber }) => {
    const name = norm(getColumn(row, 'Supplier_Name', 'Supplier Name', 'Name', 'SupplierName', 'Supplier'));
    if (!name) {
      review.errors.push(createImportError('ERR_MISSING_NAME', rowNumber, 'Supplier_Name is required.'));
      return null;
    }
    const leadTimeRaw = getColumn(row, 'Lead_Time_Days', 'Lead Time Days', 'Lead_Time', 'Lead Time', 'LeadTime');
    const leadTime = parseImportNumber(leadTimeRaw, 0);
    if (leadTime === null || leadTime < 0) {
      review.errors.push(createImportError('ERR_LEAD_TIME', rowNumber, 'Lead_Time_Days must be zero or greater.'));
      return null;
    }
    const email = norm(getColumn(row, 'Email', 'E-mail', 'Email_Address', 'Email Address'));
    const phone = norm(getColumn(row, 'Phone', 'Phone_Number', 'Phone Number', 'Telephone'));
    const address = buildSupplierImportAddress(row);
    return {
      Supplier_Name: name,
      Name: name,
      Supplier_ID: getColumn(row, 'Supplier_ID', 'Supplier ID', 'SupplierID', 'ID', 'Id'),
      Contact_Person: norm(getColumn(row, 'Contact_Person', 'Contact Person', 'ContactPerson', 'Contact')),
      Email: email,
      Phone: phone,
      Category: norm(getColumn(row, 'Category')) || 'Other',
      Lead_Time_Days: leadTime,
      Lead_Time: leadTime,
      Payment_Terms: norm(getColumn(row, 'Payment_Terms', 'Payment Terms', 'PaymentTerms')) || 'COD',
      Account_Number: norm(getColumn(row, 'Account_Number', 'Account Number', 'AccountNumber')),
      Address_Line_1: address.addressLine1,
      Address_Line_2: address.addressLine2,
      City: address.city,
      Province: address.province,
      Postal_Code: address.postalCode,
      Country: address.country,
      Address: address.fullAddress,
      Notes: norm(getColumn(row, 'Notes', 'Note', 'Comments', 'Comment'))
    };
  }).filter(Boolean);
  review.importedCount = mappedRows.length;
  review.skippedCount = review.errors.length;
  return { rows: mappedRows, review };
}

function buildSupplierImportAddress(row = {}) {
  const addressLine1 = norm(getColumn(row, 'Address_Line_1', 'Address Line 1', 'Address1', 'Address 1'));
  const addressLine2 = norm(getColumn(row, 'Address_Line_2', 'Address Line 2', 'Address2', 'Address 2'));
  const city = norm(getColumn(row, 'City', 'Town'));
  const province = norm(getColumn(row, 'Province', 'State', 'Region'));
  const postalCode = norm(getColumn(row, 'Postal_Code', 'Postal Code', 'Postcode', 'Zip', 'ZIP'));
  const country = norm(getColumn(row, 'Country'));
  const legacyAddress = norm(getColumn(row, 'Address', 'Supplier Address'));
  const fullAddress = [addressLine1, addressLine2, city, province, postalCode, country]
    .filter(Boolean)
    .join(', ') || legacyAddress;
  return {
    addressLine1: addressLine1 || legacyAddress,
    addressLine2,
    city,
    province,
    postalCode,
    country,
    fullAddress
  };
}

function createImportError(code, row, message) {
  return { code, row, message };
}

function createImportReview(rows = []) {
  return {
    totalRows: Array.isArray(rows) ? rows.length : 0,
    importedCount: 0,
    skippedCount: 0,
    errors: []
  };
}

function getImportDataRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, rowNumber: index + 2 }))
    .filter(({ row }) => !isBlankImportRow(row) && !isImportTemplateExampleRow(row));
}

function isBlankImportRow(row = {}) {
  return !Object.values(row || {}).some((value) => String(value ?? '').trim());
}

function formatImportFailure(prefix = 'Import failed.', errors = []) {
  const detail = formatImportErrors(errors, 6);
  return detail ? `${prefix} ${detail}` : prefix;
}

function formatImportErrors(errors = [], limit = 5) {
  const visible = (Array.isArray(errors) ? errors : []).slice(0, limit);
  if (!visible.length) return '';
  const suffix = errors.length > visible.length ? ` +${errors.length - visible.length} more.` : '';
  return `${visible.map((error) => `Row ${error.row}: ${error.message}`).join(' ')}${suffix}`;
}

function parseImportNumber(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const normalized = raw
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(',', '.');
  if (!normalized || normalized === '-' || normalized === '.' || normalized === '-.') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStrictBoolean(value, fallback = false) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['yes', 'y', '1', 'true'].includes(raw)) return true;
  if (['no', 'n', '0', 'false', 'tax exempt', 'tax-exempt', 'exempt'].includes(raw)) return false;
  return null;
}

function normalizeManufacturedItemName(value = '', itemType = 'manufactured') {
  const base = String(value || '')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s+-\s+Manufacturing$/i, '')
    .replace(/\s+-\s+Sub-?Recipe$/i, '')
    .trim();
  if (itemType === 'sub_recipe') return base;
  return base ? `${base} - Manufactured` : '';
}

function getManufacturingItemType(item = {}) {
  const explicit = String(item.itemType || item.stockItemType || item.specificationType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const category = String(item.category || '').toLowerCase();
  if (
    ['sub_recipe', 'subrecipe', 'sub_recipe_item'].includes(explicit) ||
    item.isSubRecipe === true ||
    category.includes('sub recipe') ||
    category.includes('sub-recipe')
  ) return 'sub_recipe';
  if (
    ['manufactured', 'prep', 'prepared', 'manufactured_item'].includes(explicit) ||
    item.isManufactured === true ||
    category.includes('manufactured')
  ) {
    return 'manufactured';
  }
  return 'manufactured';
}

function getColumn(row = {}, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }

  const lowerMap = new Map(Object.keys(row).map((key) => [normalizeColumnKey(key), key]));
  for (const name of names) {
    const key = lowerMap.get(normalizeColumnKey(name));
    if (key) return row[key];
  }

  return '';
}

function isImportTemplateExampleRow(row = {}) {
  return Object.values(row || {}).some((value) => {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ');
    return normalized === 'example only' || normalized.startsWith('example only ') || normalized.includes(' example only ');
  });
}

function normalizeColumnKey(value = '') {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function norm(value) {
  return String(value ?? '').trim();
}

function normalizeImportKey(value = '') {
  return norm(value).toLowerCase().replace(/\s+/g, ' ');
}

function stableImportId(prefix = 'imp', parts = []) {
  return `${prefix}_${stableImportHash(parts)}`;
}

function stableImportHash(value) {
  const input = JSON.stringify(value || '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function safeMenuId(value = '') {
  return String(value || '')
    .trim()
    .replace(/[.#$/[\]]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () => reject(new Error('Could not read the selected file.')));
    reader.readAsDataURL(file);
  });
}

async function readBackgroundImageAsDataUrl(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageForCanvas(objectUrl);
    const maxWidth = 1920;
    const maxHeight = 1080;
    const ratio = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process that image.');
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.84);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImageForCanvas(src = '') {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load that background image.'));
    image.src = src;
  });
}

function toggleTheme() {
  setTheme(appState.theme === 'dark' ? 'light' : 'dark');
}

function setTheme(theme) {
  appState.theme = theme === 'dark' ? 'dark' : 'light';
  applyTheme(appState.theme);
  applyRestaurantTheme(appState.settings?.draft || appState.settings?.values || {});

  try {
    localStorage.setItem(THEME_STORAGE_KEY, appState.theme);
  } catch (error) {
    console.warn('[Theme] Could not persist theme preference:', error);
  }

  renderApp();
}

function getInitialTheme() {
  try {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === 'dark' || storedTheme === 'light') return storedTheme;
  } catch (error) {
    console.warn('[Theme] Could not read theme preference:', error);
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

function userUsesGoogleProvider(user = null) {
  return (user?.providerData || []).some((provider) => provider?.providerId === 'google.com');
}

function startLiveClock() {
  if (clockTimer) return;
  clockTimer = window.setInterval(updateLiveClockNodes, 1000);
}

function stopLiveClock() {
  if (!clockTimer) return;
  window.clearInterval(clockTimer);
  clockTimer = null;
}

function updateLiveClockNodes() {
  const now = new Date();
  const timeText = new Intl.DateTimeFormat('en-ZA', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(now);
  const tradeDateKey = appState.dashboard?.metrics?.today || getTradeDateKey(now, appState.source?.settings);
  const dateText = new Intl.DateTimeFormat('en-ZA', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(new Date(`${tradeDateKey}T12:00:00`));

  document.querySelectorAll('[data-live-clock]').forEach((element) => {
    element.textContent = timeText;
  });

  document.querySelectorAll('[data-trade-date]').forEach((element) => {
    element.textContent = dateText;
  });
}
