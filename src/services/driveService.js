import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';

export function subscribeDriveIntegration(workspaceId, callback) {
  let cancelled = false;
  const load = async () => {
    try {
      const status = await callCloudflareDriveRoute(workspaceId, 'status', {}, { method: 'GET' });
      if (!cancelled) callback?.(normalizeDriveStatus(status));
    } catch (error) {
      if (!cancelled) {
        callback?.(normalizeDriveStatus({
          status: 'error',
          configured: false,
          lastError: error.message || 'Could not load Google Drive status.'
        }));
      }
    }
  };
  load();
  return () => {
    cancelled = true;
  };
}

export async function startDriveConnection(workspaceId) {
  return callCloudflareDriveRoute(workspaceId, 'connect-start');
}

export async function disconnectDriveIntegration(workspaceId) {
  return callCloudflareDriveRoute(workspaceId, 'disconnect');
}

export async function saveDriveSettings(workspaceId, settings = {}) {
  return callCloudflareDriveRoute(workspaceId, 'settings', settings);
}

/** One-shot check for whether "Process GRV with KCP Assistant" should be offered on the GRV
 * screen — a plain status read, not a subscription, since GRVEntry only needs this once when the
 * section loads (see startGrvSubscription in main.js), not a live-updating value. */
export async function fetchDriveOcrEnabled(workspaceId) {
  try {
    const status = await callCloudflareDriveRoute(workspaceId, 'status', {}, { method: 'GET' });
    return status?.settings?.ocrEnabled === true;
  } catch {
    return false;
  }
}

export async function syncDriveNow(workspaceId, kind) {
  return callCloudflareWorkspaceRoute(workspaceId, `drive/sync-now?kind=${encodeURIComponent(kind)}`, { method: 'POST' });
}

/** Lists whatever's sitting in a location's Drive "Invoices/Inbox" folder — the picker for
 * "Process GRV with KCP Assistant". Staff drop a photo/PDF into that folder from their phone's own
 * Drive app; nothing here uploads anything. */
export async function fetchDriveInboxInvoices(workspaceId, locationId) {
  const query = locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
  const result = await callCloudflareWorkspaceRoute(workspaceId, `drive/assistant/inbox${query}`, { method: 'GET' });
  return {
    locationId: result?.locationId || '',
    locationName: result?.locationName || '',
    invoices: Array.isArray(result?.invoices) ? result.invoices : []
  };
}

/** Runs one Inbox file through Gemini extraction and returns supplier/invoice/line-item fields to
 * pre-fill a GRV draft with — everything stays editable in the form afterwards, same as manual
 * entry. */
export async function extractDriveInvoice(workspaceId, fileId) {
  const result = await callCloudflareDriveRoute(workspaceId, 'assistant/extract', { fileId });
  return result?.extract || null;
}

/** Tags the source Inbox file as processed and moves it into "Invoices/Processed" so it drops out
 * of the picker on next open — call this once the GRV it was used to draft has been saved. */
export async function markDriveInvoiceProcessed(workspaceId, { fileId, grvId, locationId }) {
  return callCloudflareDriveRoute(workspaceId, 'assistant/mark-processed', { fileId, grvId, locationId });
}

async function callCloudflareDriveRoute(workspaceId, action, payload = {}, options = {}) {
  const method = String(options.method || 'POST').toUpperCase();
  return callCloudflareWorkspaceRoute(workspaceId, `drive/${action}`, {
    method,
    payload
  });
}

function normalizeDriveStatus(value = {}) {
  const status = value && typeof value === 'object' ? value : {};
  const rawStatus = String(status.status || '').trim().toLowerCase();
  const settings = status.settings && typeof status.settings === 'object' ? status.settings : {};
  return {
    status: rawStatus || 'disconnected',
    configured: status.configured !== false,
    connectionActive: rawStatus === 'connected',
    accountEmail: status.accountEmail || '',
    lastError: status.lastError || '',
    settings: {
      pushGrvEnabled: settings.pushGrvEnabled === true,
      pushCreditNoteEnabled: settings.pushCreditNoteEnabled === true,
      ocrEnabled: settings.ocrEnabled === true
    }
  };
}
