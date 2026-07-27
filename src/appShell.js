import { renderNavigation, getNavigationItem } from './components/Navigation.js';
import { renderDashboard } from './dashboard.js';
import { renderMenuCatalogue } from './components/MenuCatalogue.js';
import { renderRecipes } from './components/Recipes.js';
import { renderStockItems } from './components/StockItems.js';
import { renderSuppliers } from './components/Suppliers.js';
import { renderPurchaseOrders } from './components/PurchaseOrders.js';
import { renderGRVEntry } from './components/GRVEntry.js';
import { renderCreditNotes } from './components/CreditNotes.js';
import { renderAdjustments } from './components/Adjustments.js';
import { renderTransfers } from './components/Transfers.js';
import { renderStockTake } from './components/StockTake.js';
import { renderLocations } from './components/Locations.js';
import { renderManufacturing } from './components/Manufacturing.js';
import { renderUserManagement } from './components/UserManagement.js';
import { renderCustomRoles } from './components/CustomRoles.js';
import { renderSettings } from './components/Settings.js';
import { renderIntegrations } from './components/Integrations.js';
import styles from './styles/appShell.module.css';

const BROADCAST_DISMISSED_KEY = 'kcp:dismissed-broadcasts:v1';

const moduleContracts = {
  dashboard: {
    title: 'Dashboard',
    datasource: 'workspaces/{workspaceId}/data/dashboardMetrics and live inventory sources',
    logic: 'High-level valuation, catalogue, low-stock, and theoretical GP indicators.'
  },
  products: {
    title: 'Menu Catalogue',
    datasource: 'Firestore `menu_items` with RTDB `products` migration fallback',
    logic: 'POS menu records linked to recipe costing and live selling prices.'
  },
  recipes: {
    title: 'Recipes',
    datasource: 'workspaces/{workspaceId}/data/products and ingredients',
    logic: 'Recipe line quantities mapped to live ingredient unit costs.'
  },
  ingredients: {
    title: 'Stock Items',
    datasource: 'workspaces/{workspaceId}/data/ingredients',
    logic: 'Inventory master records with location-aware balances.'
  },
  suppliers: {
    title: 'Suppliers',
    datasource: 'workspaces/{workspaceId}/data/suppliers',
    logic: 'Supplier records referenced by purchase workflows.'
  },
  'purchase-orders': {
    title: 'Purchase Orders',
    datasource: 'workspaces/{workspaceId}/data/purchaseOrders',
    logic: 'Draft and received purchase documents by workspace.'
  },
  grv: {
    title: 'GRV Entry',
    datasource: 'workspaces/{workspaceId}/data/logs_grv',
    logic: 'Goods received entries that increase stock and purchase totals.'
  },
  'credit-note': {
    title: 'Credit Notes',
    datasource: 'workspaces/{workspaceId}/data/logs_cn',
    logic: 'Supplier credit notes that reverse purchasing and stock value.'
  },
  adjustments: {
    title: 'Adjustments',
    datasource: 'workspaces/{workspaceId}/data/logs_adj',
    logic: 'Manual stock corrections split between control adjustments and wastage.'
  },
  transfers: {
    title: 'Transfers',
    datasource: 'workspaces/{workspaceId}/data/logs_transfers',
    logic: 'Location-to-location stock movement audit trail.'
  },
  'stock-count': {
    title: 'Stock Take',
    datasource: 'workspaces/{workspaceId}/data/logs_stocktakes',
    logic: 'Physical count variance capture per location and session.'
  },
  locations: {
    title: 'Locations',
    datasource: 'workspaces/{workspaceId}/data/locations',
    logic: 'Workspace stock locations used by inventory balances.'
  },
  'mfg-products': {
    title: 'Manufacturing / Sub-Recipe',
    datasource: 'workspaces/{workspaceId}/data/logs_mfg',
    logic: 'Sub-recipe costing and prep batch production with ingredient drawdown and yield loss.'
  },
  'sales-sync': {
    title: 'Sales Sync',
    datasource: 'workspaces/{workspaceId}/data/logs_sales and processedSalesSignatures',
    logic: 'Deduplicated sales import events for stock depletion.'
  },
  integrations: {
    title: 'Integrations',
    datasource: 'workspaces/{workspaceId}/data/settings/integrations',
    logic: 'Workspace integration configuration and channel status.'
  },
  'user-management': {
    title: 'User Management',
    datasource: 'workspaces/{workspaceId}/data/team and users/{uid}/profile',
    logic: 'Workspace membership and user profile assignments.'
  },
  'custom-roles': {
    title: 'Roles',
    datasource: 'workspaces/{workspaceId}/data/customRoles',
    logic: 'Permission presets used to shape section access.'
  },
  settings: {
    title: 'Settings',
    datasource: 'workspaces/{workspaceId}/data/settings',
    logic: 'Workspace-level configuration for costing, VAT, trading day, and display.'
  },
  'settings-business': {
    title: 'Business Settings',
    datasource: 'workspaces/{workspaceId}/data/settings',
    logic: 'Workspace legal, tax, operational, profile, and infrastructure settings.'
  },
  'settings-customization': {
    title: 'Customization',
    datasource: 'workspaces/{workspaceId}/data/settings',
    logic: 'Workspace backgrounds, logos, and visual theme settings.'
  }
};

export function renderAuthenticatedApp({
  state,
  onNavigate,
  onSignOut,
  onWorkspaceSelect,
  onAutoLoginToggle,
  onThemeToggle,
  onDashboardRangeChange,
  onDashboardRefresh,
  onMenuFilterChange,
  onMenuAction,
  onRecipeFilterChange,
  onRecipeAction,
  onStockFilterChange,
  onStockAction,
  onSupplierFilterChange,
  onSupplierAction,
  onPurchaseOrderFilterChange,
  onPurchaseOrderAction,
  onGrvFilterChange,
  onGrvAction,
  onCreditNoteFilterChange,
  onCreditNoteAction,
  onAdjustmentFilterChange,
  onAdjustmentAction,
  onTransferFilterChange,
  onTransferAction,
  onStockTakeFilterChange,
  onStockTakeAction,
  onLocationFilterChange,
  onLocationAction,
  onManufacturingFilterChange,
  onManufacturingAction,
  onUserManagementFilterChange,
  onUserManagementAction,
  onRoleManagementAction,
  onSettingsAction
} = {}) {
  const shell = document.createElement('div');
  shell.className = styles.appShell;

  const navigation = renderNavigation({
    activeSection: state.route?.active,
    workspace: state.workspace,
    settings: state.settings?.values || state.settings?.draft || {},
    workspaceOptions: state.workspaceOptions || [],
    autoLoginPreference: state.autoLoginPreference || null,
    user: state.user,
    allowedSections: state.access?.allowedSections || [],
    onNavigate,
    onSignOut,
    onWorkspaceSelect,
    onAutoLoginToggle
  });

  const broadcastBanner = renderSystemBroadcastBanner(state.systemBroadcast);
  if (broadcastBanner) shell.appendChild(broadcastBanner);

  const main = document.createElement('main');
  main.className = styles.mainPane;
  main.dataset.appMain = '';
  main.dataset.scrollKey = 'app-main';
  main.appendChild(renderActiveSection({
    state,
    onNavigate,
    onThemeToggle,
    onDashboardRangeChange,
    onDashboardRefresh,
    onMenuFilterChange,
    onMenuAction,
    onRecipeFilterChange,
    onRecipeAction,
    onStockFilterChange,
    onStockAction,
    onSupplierFilterChange,
    onSupplierAction,
    onPurchaseOrderFilterChange,
    onPurchaseOrderAction,
    onGrvFilterChange,
    onGrvAction,
    onCreditNoteFilterChange,
    onCreditNoteAction,
    onAdjustmentFilterChange,
    onAdjustmentAction,
    onTransferFilterChange,
    onTransferAction,
    onStockTakeFilterChange,
    onStockTakeAction,
    onLocationFilterChange,
    onLocationAction,
    onManufacturingFilterChange,
    onManufacturingAction,
    onUserManagementFilterChange,
    onUserManagementAction,
    onRoleManagementAction,
    onSettingsAction
  }));

  const toast = renderShellToast(state);
  shell.append(navigation, main);
  if (toast) shell.appendChild(toast);

  const lockOverlay = renderWorkspaceLockOverlay(state);
  if (lockOverlay) shell.appendChild(lockOverlay);

  return shell;
}

function renderWorkspaceLockOverlay(state = {}) {
  const settings = state.settings?.values || {};
  if (!settings.is_locked) return null;

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(5,8,18,0.92)', 'backdrop-filter:blur(12px)',
    '-webkit-backdrop-filter:blur(12px)', 'padding:24px'
  ].join(';');

  overlay.innerHTML = `
    <div style="max-width:480px;width:100%;background:linear-gradient(180deg,rgba(30,41,59,0.98),rgba(15,23,42,0.98));border:1px solid rgba(239,68,68,0.25);border-radius:2rem;padding:48px 40px;text-align:center;box-shadow:0 40px 80px rgba(0,0,0,0.6);">
      <div style="width:72px;height:72px;margin:0 auto 24px;border-radius:50%;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.25);display:flex;align-items:center;justify-content:center;">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(239,68,68,0.9)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <p style="font-size:10px;font-weight:900;letter-spacing:0.18em;text-transform:uppercase;color:rgba(239,68,68,0.7);margin:0 0 12px;">Workspace Locked</p>
      <h2 style="font-size:1.6rem;font-weight:950;color:#fff;margin:0 0 16px;line-height:1.2;">Payment Not Made</h2>
      <p style="font-size:0.875rem;color:rgba(255,255,255,0.55);line-height:1.6;margin:0 0 32px;">Your workspace has been locked due to an outstanding payment. Please complete your payment to continue using Kitchen Cost Pro.</p>
      <button disabled style="width:100%;padding:16px 24px;border-radius:0.875rem;border:none;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;font-size:0.8rem;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;cursor:not-allowed;opacity:0.7;">
        Make Payment — Coming Soon
      </button>
      <p style="font-size:0.75rem;color:rgba(255,255,255,0.3);margin:16px 0 0;">Contact support if you believe this is an error.</p>
    </div>
  `;

  return overlay;
}

function renderShellToast(state = {}) {
  const toast = getActiveSectionToast(state);
  if (!toast?.message) return null;
  const type = ['success', 'error', 'warning'].includes(toast.type) ? toast.type : 'success';
  const node = document.createElement('div');
  node.className = `${styles.appShellToast} ${styles[`appShellToast_${type}`] || ''}`;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  node.textContent = toast.message;
  return node;
}

function getActiveSectionToast(state = {}) {
  switch (state.route?.active) {
    case 'products':
      return state.menu?.toast;
    case 'recipes':
      return state.recipes?.toast;
    case 'ingredients':
      return state.stock?.toast;
    case 'suppliers':
      return state.suppliers?.toast;
    case 'purchase-orders':
      return state.purchaseOrders?.toast;
    case 'grv':
      return state.grv?.toast;
    case 'credit-note':
      return state.creditNotes?.toast;
    case 'adjustments':
      return state.adjustments?.toast;
    case 'transfers':
      return state.transfers?.toast;
    case 'stock-count':
      return state.stockTake?.toast;
    case 'locations':
      return state.locations?.toast;
    case 'mfg-products':
      return state.manufacturing?.toast;
    case 'user-management':
      return state.userManagement?.toast;
    case 'custom-roles':
      return state.roleManagement?.toast;
    // NOTE: settings routes are intentionally NOT handled here. The Settings view renders its own
    // toast via a body portal (#kcp-settings-toast-portal in Settings.js). Returning the settings
    // toast here too caused it to render twice (double toast on save).
    default:
      return null;
  }
}

const BROADCAST_GRADIENTS = {
  blue:    'linear-gradient(90deg, rgba(29,78,216,0.18), rgba(99,102,241,0.22), rgba(29,78,216,0.18))',
  amber:   'linear-gradient(90deg, rgba(180,83,9,0.18), rgba(245,158,11,0.22), rgba(180,83,9,0.18))',
  red:     'linear-gradient(90deg, rgba(153,27,27,0.22), rgba(239,68,68,0.26), rgba(153,27,27,0.22))',
  emerald: 'linear-gradient(90deg, rgba(6,78,59,0.18), rgba(52,211,153,0.22), rgba(6,78,59,0.18))',
  purple:  'linear-gradient(90deg, rgba(88,28,135,0.18), rgba(167,139,250,0.22), rgba(88,28,135,0.18))',
  rose:    'linear-gradient(90deg, rgba(136,19,55,0.18), rgba(251,113,133,0.22), rgba(136,19,55,0.18))',
};

function renderSystemBroadcastBanner(broadcast) {
  const items = normalizeBroadcastItems(broadcast);
  if (!items.length) return null;
  const banner = document.createElement('section');
  const severity = strongestBroadcastSeverity(items);
  banner.className = `${styles.systemBroadcast} ${styles[`systemBroadcast_${severity}`] || ''}`;
  banner.setAttribute('aria-label', 'System broadcast news ticker');

  // Apply custom gradient if specified
  const gradient = broadcast?.gradient || broadcast?.items?.[0]?.gradient;
  if (gradient && BROADCAST_GRADIENTS[gradient]) {
    banner.style.background = BROADCAST_GRADIENTS[gradient];
  }

  const label = document.createElement('div');
  label.className = styles.systemBroadcastLabel;
  const icon = document.createElement('span');
  icon.className = styles.systemBroadcastIcon;
  icon.textContent = severity === 'critical' ? '!' : severity === 'success' ? '✓' : 'i';
  const labelText = document.createElement('strong');
  labelText.textContent = items.length > 1 ? 'System Feed' : 'System Notice';
  label.append(icon, labelText);

  const viewport = document.createElement('div');
  viewport.className = styles.systemBroadcastViewport;

  // Static preview shown for 5 seconds before scrolling begins
  const staticEl = document.createElement('div');
  staticEl.className = styles.systemBroadcastStatic;
  const firstItem = items[0];
  staticEl.textContent = firstItem.title && firstItem.title !== 'System Notice'
    ? `${firstItem.title}: ${firstItem.message}`
    : firstItem.message;

  const track = document.createElement('div');
  track.className = `${styles.systemBroadcastTrack} ${styles.systemBroadcastTrackPaused}`;
  [...items, ...items].forEach((item) => {
    const entry = document.createElement('span');
    entry.className = `${styles.systemBroadcastItem} ${styles[`systemBroadcastItem_${item.severity}`] || ''}`;
    const title = document.createElement('strong');
    title.textContent = item.title || 'System Notice';
    const message = document.createElement('em');
    message.textContent = item.message;
    entry.append(title, message);
    track.appendChild(entry);
  });

  viewport.append(staticEl, track);
  banner.append(label, viewport);

  // After 5 s transition from static label to scrolling ticker
  setTimeout(() => {
    staticEl.classList.add(styles.systemBroadcastStaticFade);
    setTimeout(() => {
      staticEl.style.display = 'none';
      track.classList.remove(styles.systemBroadcastTrackPaused);
    }, 400);
  }, 5000);

  if (severity !== 'critical') {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = styles.systemBroadcastDismiss;
    dismiss.setAttribute('aria-label', 'Clear notification');
    dismiss.textContent = 'Clear';
    dismiss.addEventListener('click', () => dismissBroadcastItems(items, banner));
    banner.appendChild(dismiss);
  }
  return banner;
}

function normalizeBroadcastItems(broadcast) {
  const rawItems = Array.isArray(broadcast?.items) && broadcast.items.length
    ? broadcast.items
    : broadcast?.message
      ? [broadcast]
      : [];
  return rawItems
    .map((item) => {
      const severity = ['info', 'warning', 'critical', 'success'].includes(item?.severity) ? item.severity : 'info';
      return {
        id: String(item?.id || `${severity}:${item?.title || ''}:${item?.message || ''}`).trim(),
        severity,
        title: String(item?.title || 'System Notice').trim() || 'System Notice',
        message: String(item?.message || '').trim()
      };
    })
    .filter((item) => item.message)
    .filter((item) => item.severity === 'critical' || !dismissedBroadcastIds().has(item.id));
}

function strongestBroadcastSeverity(items = []) {
  const rank = { critical: 4, warning: 3, info: 2, success: 1 };
  return items.reduce((winner, item) => (
    (rank[item.severity] || 0) > (rank[winner] || 0) ? item.severity : winner
  ), 'info');
}

function dismissedBroadcastIds() {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(BROADCAST_DISMISSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function dismissBroadcastItems(items = [], banner) {
  const next = dismissedBroadcastIds();
  items
    .filter((item) => item.severity !== 'critical')
    .forEach((item) => next.add(item.id));
  try {
    window.localStorage.setItem(BROADCAST_DISMISSED_KEY, JSON.stringify([...next].slice(-100)));
  } catch {
    // Ignore storage failures; the current banner is still hidden for this page view.
  }
  banner?.classList.add(styles.systemBroadcast_hidden);
  window.setTimeout(() => banner?.remove(), 220);
}

function renderActiveSection({
  state,
  onNavigate,
  onThemeToggle,
  onDashboardRangeChange,
  onDashboardRefresh,
  onMenuFilterChange,
  onMenuAction,
  onRecipeFilterChange,
  onRecipeAction,
  onStockFilterChange,
  onStockAction,
  onSupplierFilterChange,
  onSupplierAction,
  onPurchaseOrderFilterChange,
  onPurchaseOrderAction,
  onGrvFilterChange,
  onGrvAction,
  onCreditNoteFilterChange,
  onCreditNoteAction,
  onAdjustmentFilterChange,
  onAdjustmentAction,
  onTransferFilterChange,
  onTransferAction,
  onStockTakeFilterChange,
  onStockTakeAction,
  onLocationFilterChange,
  onLocationAction,
  onManufacturingFilterChange,
  onManufacturingAction,
  onUserManagementFilterChange,
  onUserManagementAction,
  onRoleManagementAction,
  onSettingsAction
}) {
  const activeSection = state.route?.active || 'dashboard';

  if (activeSection === 'dashboard') {
    return renderDashboard({ state, onThemeToggle, onDashboardRangeChange, onDashboardRefresh, onNavigate });
  }

  if (activeSection === 'products') {
    return renderMenuCatalogue({ state, onFilterChange: onMenuFilterChange, onMenuAction });
  }

  if (activeSection === 'recipes') {
    return renderRecipes({ state, onRecipeFilterChange, onRecipeAction });
  }

  if (activeSection === 'ingredients') {
    return renderStockItems({ state, onStockFilterChange, onStockAction });
  }

  if (activeSection === 'suppliers') {
    return renderSuppliers({ state, onSupplierFilterChange, onSupplierAction });
  }

  if (activeSection === 'purchase-orders') {
    return renderPurchaseOrders({ state, onPurchaseOrderFilterChange, onPurchaseOrderAction });
  }

  if (activeSection === 'grv') {
    return renderGRVEntry({ state, onGrvFilterChange, onGrvAction });
  }

  if (activeSection === 'credit-note') {
    return renderCreditNotes({ state, onCreditNoteFilterChange, onCreditNoteAction });
  }

  if (activeSection === 'adjustments') {
    return renderAdjustments({ state, onAdjustmentFilterChange, onAdjustmentAction });
  }

  if (activeSection === 'transfers') {
    return renderTransfers({ state, onTransferFilterChange, onTransferAction });
  }

  if (activeSection === 'stock-count') {
    return renderStockTake({ state, onStockTakeFilterChange, onStockTakeAction });
  }

  if (activeSection === 'locations') {
    return renderLocations({ state, onLocationFilterChange, onLocationAction });
  }

  if (activeSection === 'mfg-products') {
    return renderManufacturing({ state, onManufacturingFilterChange, onManufacturingAction });
  }

  if (activeSection === 'user-management') {
    return renderUserManagement({ state, onUserManagementFilterChange, onUserManagementAction });
  }

  if (activeSection === 'custom-roles') {
    return renderCustomRoles({ state, onRoleManagementAction });
  }

  if (activeSection === 'integrations') {
    return renderIntegrations({ state });
  }

  if (activeSection === 'settings' || activeSection === 'settings-business' || activeSection === 'settings-customization') {
    return renderSettings({ state, onSettingsAction });
  }

  // Clean up portals when navigating away from their sections
  document.getElementById('kcp-settings-toast-portal')?.remove();
  document.getElementById('kcp-reset-dialog-portal')?.remove();
  document.getElementById('kcp-grv-toast-portal')?.remove();

  return renderModuleShell(activeSection, state);
}

function renderModuleShell(sectionId, state) {
  const route = getNavigationItem(sectionId) || { label: titleCase(sectionId) };
  const contract = moduleContracts[sectionId] || {
    title: route.label,
    datasource: 'workspaces/{workspaceId}/data',
    logic: 'Live workspace module boundary.'
  };
  const workspaceName = state.workspace?.siteName || state.source?.settings?.siteName || 'Workspace';

  const view = document.createElement('section');
  view.className = styles.sectionShell;
  view.innerHTML = `
    <header class="${styles.sectionHeader}">
      <p class="${styles.eyebrow}">Kitchen Cost Pro</p>
      <h1>${escapeHtml(contract.title)}</h1>
      <p>${escapeHtml(workspaceName)}</p>
    </header>

    <div class="${styles.placeholderGrid}">
      <article class="${styles.placeholderPanel}">
        <span>Data Path</span>
        <strong>${escapeHtml(contract.datasource)}</strong>
      </article>
      <article class="${styles.placeholderPanel}">
        <span>Logic Contract</span>
        <strong>${escapeHtml(contract.logic)}</strong>
      </article>
      <article class="${styles.placeholderPanel}">
        <span>Module State</span>
        <strong>Ready For Migration</strong>
      </article>
    </div>
  `;

  return view;
}

function titleCase(value = '') {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
