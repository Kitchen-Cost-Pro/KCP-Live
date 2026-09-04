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

/** One-shot check for whether "Process GRV with KCP Assistant" should be offered, and whether
 * Drive is connected at all (gates the GRV commit modal's invoice-upload offer) — a plain status
 * read, not a subscription, since GRVEntry only needs this once when the section loads (see
 * startGrvSubscription in main.js), not a live-updating value. */
export async function fetchDriveStatusSummary(workspaceId) {
  try {
    const status = await callCloudflareDriveRoute(workspaceId, 'status', {}, { method: 'GET' });
    return {
      connected: normalizeDriveStatus(status).connectionActive,
      ocrEnabled: status?.settings?.ocrEnabled === true
    };
  } catch {
    return { connected: false, ocrEnabled: false };
  }
}

export async function syncDriveNow(workspaceId, kind) {
  return callCloudflareWorkspaceRoute(workspaceId, `drive/sync-now?kind=${encodeURIComponent(kind)}`, { method: 'POST' });
}

// Vision extraction takes longer than a typical API call — same reasoning/value as
// aiExtractionService.js's EXTRACT_TIMEOUT_MS, plus this call also archives the photo to Drive
// afterward.
const PROCESS_INVOICE_TIMEOUT_MS = 175000;

/** "Process Invoice with KCP": hands a captured/uploaded invoice photo straight to the Worker,
 * which runs it through Gemini extraction and archives the original into that location's Drive
 * "Invoices" folder — Drive is the destination here, not something staff have to interact with
 * themselves. Returns supplier/invoice/line-item fields to pre-fill a GRV draft with (everything
 * stays editable afterwards, same as manual entry) plus the archived file's Drive id. */
export async function processDriveInvoicePhoto(workspaceId, { mimeType, imageBase64, locationId }) {
  const result = await callCloudflareWorkspaceRoute(workspaceId, 'drive/assistant/process', {
    method: 'POST',
    timeoutMs: PROCESS_INVOICE_TIMEOUT_MS,
    payload: { mimeType, imageBase64, locationId }
  });
  return { extract: result?.extract || null, driveFileId: result?.driveFileId || '', locationId: result?.locationId || locationId || '' };
}

/** Tags the archived invoice photo with the GRV it ended up creating — call this once that GRV has
 * actually been saved. Best-effort from the caller's point of view; a failure here should never
 * block or roll back the GRV save itself. */
export async function tagDriveInvoiceWithGrv(workspaceId, { fileId, grvId }) {
  return callCloudflareDriveRoute(workspaceId, 'assistant/tag-grv', { fileId, grvId });
}

/** Archives an invoice photo/PDF to that location's Drive "Invoices" folder without running it
 * through KCP Assistant's extraction — used by the GRV commit modal, where the GRV is already
 * filled in and staff just want a copy of the paper invoice kept alongside it. Reuses the same
 * timeout as processDriveInvoicePhoto since the upload itself is the slow part either way. */
export async function uploadInvoiceToDrive(workspaceId, { mimeType, imageBase64, locationId }) {
  const result = await callCloudflareWorkspaceRoute(workspaceId, 'drive/assistant/upload-invoice', {
    method: 'POST',
    timeoutMs: PROCESS_INVOICE_TIMEOUT_MS,
    payload: { mimeType, imageBase64, locationId }
  });
  return { driveFileId: result?.driveFileId || '' };
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
