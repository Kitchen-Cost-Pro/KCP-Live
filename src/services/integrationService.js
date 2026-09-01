import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';

export function subscribeYocoIntegration(workspaceId, callback) {
  let cancelled = false;
  const load = async () => {
    try {
      const status = await callCloudflareYocoRoute(workspaceId, 'status', {}, { method: 'GET' });
      if (!cancelled) callback?.(normalizeYocoStatus(status));
    } catch (error) {
      if (!cancelled) {
        callback?.(normalizeYocoStatus({
          status: 'error',
          connectionActive: false,
          syncState: 'error',
          health: 'offline',
          lastError: error.message || 'Could not load Yoco status.'
        }));
      }
    }
  };
  load();
  return () => {
    cancelled = true;
  };
}

export async function connectYocoIntegration(workspaceId, apiKey) {
  try {
    const result = await callCloudflareYocoRoute(workspaceId, 'connect', { apiKey });
    return result;
  } catch (error) {
    throw error;
  }
}

export async function syncYocoCatalogue(workspaceId, options = {}) {
  return callCloudflareYocoRoute(workspaceId, 'sync-catalogue', {
    resetWebhook: options.resetWebhook === true
  });
}

// Called once per login/app-load — unlike syncYocoCatalogue above, the backend only actually syncs
// when the catalogue is stale (see postSyncCatalogueIfDue), so this is cheap to call on every
// login: most of the time it costs one D1 read on the worker and nothing else.
export async function syncYocoCatalogueIfDue(workspaceId) {
  return callCloudflareYocoRoute(workspaceId, 'sync-catalogue-if-due', {});
}

export async function syncYocoSales(workspaceId, options = {}) {
  return callCloudflareYocoRoute(workspaceId, 'sync-sales', {
    resetWebhook: options.resetWebhook === true
  });
}

export async function disconnectYocoIntegration(workspaceId) {
  return callCloudflareYocoRoute(workspaceId, 'disconnect');
}

export function subscribeGmailIntegration(workspaceId, callback) {
  let cancelled = false;
  const load = async () => {
    try {
      const status = await callCloudflareGmailRoute(workspaceId, 'status', {}, { method: 'GET' });
      if (!cancelled) callback?.(normalizeGmailStatus(status));
    } catch (error) {
      if (!cancelled) {
        callback?.(normalizeGmailStatus({
          status: 'error',
          configured: false,
          connectionActive: false,
          lastError: error.message || 'Could not load Gmail status.'
        }));
      }
    }
  };
  load();
  return () => {
    cancelled = true;
  };
}

export async function startGmailConnection(workspaceId) {
  return callCloudflareGmailRoute(workspaceId, 'connect-start');
}

export async function disconnectGmailIntegration(workspaceId) {
  return callCloudflareGmailRoute(workspaceId, 'disconnect');
}

export async function sendSupplierEmailWithGmail(workspaceId, payload = {}) {
  return callCloudflareGmailRoute(workspaceId, 'send-supplier-email', payload);
}

export function subscribeXeroIntegration(workspaceId, callback) {
  let cancelled = false;
  const load = async () => {
    try {
      const status = await callCloudflareXeroRoute(workspaceId, 'status', {}, { method: 'GET' });
      if (!cancelled) callback?.(normalizeXeroStatus(status));
    } catch (error) {
      if (!cancelled) {
        callback?.(normalizeXeroStatus({
          status: 'error',
          configured: false,
          lastError: error.message || 'Could not load Xero status.'
        }));
      }
    }
  };
  load();
  return () => {
    cancelled = true;
  };
}

export async function startXeroConnection(workspaceId) {
  return callCloudflareXeroRoute(workspaceId, 'connect-start');
}

export async function disconnectXeroIntegration(workspaceId) {
  return callCloudflareXeroRoute(workspaceId, 'disconnect');
}

export async function saveXeroSettings(workspaceId, settings = {}) {
  return callCloudflareXeroRoute(workspaceId, 'settings', settings);
}

export async function syncXeroNow(workspaceId, kind) {
  return callCloudflareWorkspaceRoute(workspaceId, `xero/sync-now?kind=${encodeURIComponent(kind)}`, { method: 'POST' });
}

/** Resolves one pending "needs a supplier match" entry: pass either { xeroContactId } to map to a
 * Xero contact the user already picked, or { createNew: true } to create a new one — the daily
 * background sync never creates a Xero contact on its own, only this explicit user action does. */
export async function resolveXeroSupplierMatch(workspaceId, supplierId, { xeroContactId, createNew } = {}) {
  return callCloudflareXeroRoute(workspaceId, 'resolve-supplier-match', { supplierId, xeroContactId, createNew });
}

async function callCloudflareXeroRoute(workspaceId, action, payload = {}, options = {}) {
  const method = String(options.method || 'POST').toUpperCase();
  return callCloudflareWorkspaceRoute(workspaceId, `xero/${action}`, {
    method,
    payload
  });
}

function normalizeXeroStatus(value = {}) {
  const status = value && typeof value === 'object' ? value : {};
  const rawStatus = String(status.status || '').trim().toLowerCase();
  const settings = status.settings && typeof status.settings === 'object' ? status.settings : {};
  const pendingSupplierMatches = Array.isArray(status.pendingSupplierMatches) ? status.pendingSupplierMatches : [];
  return {
    status: rawStatus || 'disconnected',
    configured: status.configured !== false,
    connectionActive: rawStatus === 'connected',
    tenantName: status.tenantName || '',
    lastError: status.lastError || '',
    settings: {
      salesAccountCode: settings.salesAccountCode || '',
      defaultTaxType: settings.defaultTaxType || '',
      itemAccountCode: settings.itemAccountCode || '',
      purchaseAccountCode: settings.purchaseAccountCode || '',
      purchaseTaxType: settings.purchaseTaxType || '',
      purchaseExemptTaxType: settings.purchaseExemptTaxType || '',
      enabled: settings.enabled === true,
      grvSyncEnabled: settings.grvSyncEnabled === true,
      lastItemSyncAt: settings.lastItemSyncAt || '',
      lastInvoiceSyncDate: settings.lastInvoiceSyncDate || '',
      lastGrvSyncDate: settings.lastGrvSyncDate || ''
    },
    pendingSupplierMatches: pendingSupplierMatches.map((match) => ({
      supplierId: match.supplierId || '',
      supplierName: match.supplierName || 'Unknown supplier',
      grvCount: Number(match.grvCount) || 0
    }))
  };
}

async function callCloudflareYocoRoute(workspaceId, action, payload = {}, options = {}) {
  const method = String(options.method || 'POST').toUpperCase();
  return callCloudflareWorkspaceRoute(workspaceId, `yoco/${action}`, {
    method,
    payload
  });
}

async function callCloudflareGmailRoute(workspaceId, action, payload = {}, options = {}) {
  const method = String(options.method || 'POST').toUpperCase();
  return callCloudflareWorkspaceRoute(workspaceId, `gmail/${action}`, {
    method,
    payload
  });
}

function normalizeYocoStatus(value = {}) {
  const status = value && typeof value === 'object' ? value : {};
  const rawStatus = String(status.status || '').trim().toLowerCase();
  const webhookEnabled = status.webhook?.enabled === true;
  const connectionActive = status.connectionActive === true || rawStatus === 'connected';
  return {
    status: rawStatus || 'disconnected',
    connectionActive,
    syncState: status.syncState || 'idle',
    health: status.health || '',
    connectedAt: status.connectedAt || '',
    lastSyncCompletedAt: status.lastSyncCompletedAt || '',
    lastError: status.lastError || '',
    webhook: { ...(status.webhook || {}), enabled: webhookEnabled },
    catalogue: status.catalogue || {},
    locations: status.locations || {}
  };
}

function normalizeGmailStatus(value = {}) {
  const status = value && typeof value === 'object' ? value : {};
  const rawStatus = String(status.status || '').trim().toLowerCase();
  return {
    status: rawStatus || 'disconnected',
    configured: status.configured !== false,
    connectionActive: status.connectionActive === true || rawStatus === 'connected',
    accountEmail: status.accountEmail || '',
    accountName: status.accountName || '',
    connectedAt: status.connectedAt || '',
    connectedBy: status.connectedBy || '',
    lastSentAt: status.lastSentAt || '',
    lastError: status.lastError || '',
    message: status.message || ''
  };
}
