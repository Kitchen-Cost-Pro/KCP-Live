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

export async function syncYocoCatalogue(workspaceId) {
  return callCloudflareYocoRoute(workspaceId, 'sync-catalogue');
}

export async function syncYocoSales(workspaceId) {
  return callCloudflareYocoRoute(workspaceId, 'sync-sales');
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
