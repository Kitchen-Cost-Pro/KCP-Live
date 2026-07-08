import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { fetchStock } from './stockService.js';
import { DEFAULT_SITE_ID, normalizeSites, normalizeStockLocations } from './locationModel.js';
import { todayLocal } from '../utils/date.js';

export function subscribeTransfersWorkspace(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for transfers.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchTransfersWorkspace(workspaceKey);
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'live:transfers');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchTransfersWorkspace(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for transfers.');

  const [transferResponse, templateResponse, stockResponse, locationResponse, siteResponse] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'transfers'),
    callCloudflareWorkspaceRoute(workspaceKey, 'transfer-templates'),
    fetchStock(workspaceKey),
    callCloudflareWorkspaceRoute(workspaceKey, 'locations'),
    callCloudflareWorkspaceRoute(workspaceKey, 'site-configuration')
  ]);

  const settings = { siteName: siteResponse.siteConfiguration?.site_name || 'Main Site' };
  const sites = normalizeSites([{ id: DEFAULT_SITE_ID, name: settings.siteName, isDefault: true }], settings);
  const locations = normalizeStockLocations((locationResponse.locations || []).map(normalizeCloudflareLocation), sites, settings);

  return {
    status: 'ready',
    source: 'Live transfers',
    transfers: sortTransfers(normalizeTransferLogs(transferResponse.transfers || [])),
    externalTransfers: sortTransfers(normalizeExternalTransfers(transferResponse.externalTransfers || [])),
    templates: sortByName(normalizeTransferTemplates(templateResponse.templates || [])),
    stockItems: sortByName(stockResponse.items || []),
    sites: sortByName(sites),
    locations: sortByName(locations),
    loaded: {
      transfers: true,
      externalTransfers: true,
      templates: true,
      stockItems: true,
      sites: true,
      locations: true
    },
    updatedAt: new Date().toISOString()
  };
}

export function normalizeExternalTransfers(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => ({
      ...item,
      id: String(item.id || item.transferId || id),
      transferId: String(item.transferId || item.id || id),
      status: String(item.status || '').trim(),
      direction: String(item.direction || '').trim(),
      fromSiteId: String(item.fromSiteId || '').trim(),
      fromSiteName: String(item.fromSiteName || '').trim(),
      toSiteId: String(item.toSiteId || '').trim(),
      toSiteName: String(item.toSiteName || '').trim(),
      fromLocationId: String(item.fromLocationId || '').trim(),
      fromLocationName: String(item.fromLocationName || item.fromName || '').trim(),
      toLocationId: String(item.toLocationId || '').trim(),
      toLocationName: String(item.toLocationName || item.toName || '').trim(),
      note: String(item.note || '').trim(),
      createdAt: item.createdAt || item.timestamp || '',
      updatedAt: item.updatedAt || item.createdAt || item.timestamp || '',
      items: toItemArray(item.items).map((line) => ({
        ...line,
        stockItemId: String(line.stockItemId || line.id || '').trim(),
        targetStockItemId: String(line.targetStockItemId || line.stockItemId || line.id || '').trim(),
        name: String(line.name || line.stockItemName || '').trim(),
        shippedQty: Number(line.shippedQty ?? line.quantity ?? line.qty ?? 0) || 0,
        receivedQty: line.receivedQty == null ? null : Number(line.receivedQty || 0) || 0,
        unit: String(line.unit || '').trim()
      }))
    }));
}

export async function saveTransfer(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save transfers.');

  const draft = normalizeTransferPayload(payload);
  if (!draft.fromLocationId || !draft.toLocationId) throw new Error('Select both transfer locations.');
  if (draft.fromLocationId === draft.toLocationId) throw new Error('Source and destination must be different.');
  if (!draft.items.length) throw new Error('Add at least one stock item to transfer.');

  return callCloudflareWorkspaceRoute(workspaceKey, 'transfers/internal', {
    method: 'POST',
    payload: draft
  });
}

export async function saveTransferTemplate(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save transfer templates.');

  const template = normalizeTransferTemplatePayload(payload);
  if (!template.name) throw new Error('Enter a template name.');
  if (!template.items.length) throw new Error('Select at least one stock item for this template.');

  await callCloudflareWorkspaceRoute(workspaceKey, 'transfer-templates', {
    method: 'POST',
    payload: { template }
  });
  return template;
}

export async function deleteTransferTemplate(workspaceId, templateId) {
  const workspaceKey = String(workspaceId || '').trim();
  const id = String(templateId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to delete transfer templates.');
  if (!id) throw new Error('Template id is required.');
  await callCloudflareWorkspaceRoute(workspaceKey, `transfer-templates/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

export function normalizeTransferLogs(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => normalizeTransferLog(id, item));
}

export function normalizeTransferTemplates(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => normalizeTransferTemplate(id, item));
}

function normalizeTransferTemplate(id, item = {}) {
  return {
    ...item,
    id: String(item.id || id || createId('tt')),
    name: String(item.name || item.templateName || '').trim(),
    notes: String(item.notes || '').trim(),
    createdAt: item.createdAt || '',
    updatedAt: item.updatedAt || item.createdAt || '',
    items: toItemArray(item.items).map((line) => ({
      stockItemId: String(line.stockItemId || line.itemId || line.id || '').trim(),
      stockItemName: String(line.stockItemName || line.itemName || line.name || '').trim(),
      sku: String(line.sku || line.SKU || line.code || '').trim(),
      category: String(line.category || '').trim(),
      unit: String(line.unit || '').trim()
    })).filter((line) => line.stockItemId)
  };
}

function normalizeTransferTemplatePayload(payload = {}) {
  const now = new Date().toISOString();
  const id = String(payload.id || '').trim() || createId('tt');
  return {
    id,
    name: String(payload.name || '').trim(),
    notes: String(payload.notes || '').trim(),
    items: toItemArray(payload.items).map((line) => ({
      stockItemId: String(line.stockItemId || line.itemId || line.id || '').trim(),
      stockItemName: String(line.stockItemName || line.itemName || line.name || '').trim(),
      sku: String(line.sku || line.SKU || line.code || '').trim(),
      category: String(line.category || '').trim(),
      unit: String(line.unit || '').trim()
    })).filter((line) => line.stockItemId),
    createdAt: payload.createdAt || now,
    updatedAt: now
  };
}

function normalizeTransferLog(id, item = {}) {
  const actionTimestamp = transferActionTimestamp(item);
  return {
    ...item,
    id: String(item.id || id || createId('tf')),
    from: String(item.from || item.fromLocationId || '').trim(),
    to: String(item.to || item.toLocationId || '').trim(),
    fromName: String(item.fromName || item.sourceName || item.fromLocationName || '').trim(),
    toName: String(item.toName || item.destinationName || item.toLocationName || '').trim(),
    note: String(item.note || '').trim(),
    user: String(item.user || item.createdByName || item.createdByEmail || item.createdBy || '').trim(),
    createdBy: String(item.createdBy || '').trim(),
    createdByName: String(item.createdByName || '').trim(),
    createdByEmail: String(item.createdByEmail || '').trim(),
    lineCount: Number(item.lineCount || toItemArray(item.items).length || 0),
    timestamp: actionTimestamp,
    date: String(actionTimestamp || item.date || '').slice(0, 10),
    items: toItemArray(item.items).map((line) => ({
      ...line,
      stockItemId: String(line.stockItemId || line.id || '').trim(),
      name: String(line.name || line.stockItemName || '').trim(),
      qty: Number(line.qty || line.quantity || 0) || 0,
      unit: String(line.unit || '').trim()
    }))
  };
}

function transferActionTimestamp(item = {}) {
  return String(
    item.postedAt ||
    item.acceptedAt ||
    item.completedAt ||
    item.processedAt ||
    item.updatedAt ||
    item.timestamp ||
    item.requestedAt ||
    item.createdAt ||
    item.actionAt ||
    item.date ||
    ''
  ).trim();
}

function normalizeTransferPayload(payload = {}) {
  return {
    id: String(payload.id || '').trim(),
    date: String(payload.date || todayLocal()).trim(),
    fromLocationId: String(payload.fromLocationId || '').trim(),
    fromLocationName: String(payload.fromLocationName || '').trim(),
    toLocationId: String(payload.toLocationId || '').trim(),
    toLocationName: String(payload.toLocationName || '').trim(),
    note: String(payload.note || '').trim(),
    items: (payload.items || []).map((item) => ({
      stockItemId: String(item.stockItemId || item.itemId || item.ingId || '').trim(),
      stockItemName: String(item.stockItemName || item.itemName || item.name || '').trim(),
      quantity: Math.max(Number(item.quantity || item.qty || 0), 0),
      unit: String(item.unit || '').trim()
    })).filter((item) => item.stockItemId && item.quantity > 0)
  };
}

function normalizeCloudflareLocation(row = {}) {
  const id = String(row.id || '').trim();
  const isDefault = Number(row.is_default || row.isDefault || 0) === 1 || id === 'main';
  const kind = String(row.kind || (isDefault ? 'storage' : 'selling')).trim();
  return {
    id,
    locationId: id,
    siteId: DEFAULT_SITE_ID,
    name: row.display_name || row.displayName || row.name || row.external_name || row.externalName || 'Location',
    displayName: row.display_name || row.displayName || row.name || '',
    type: kind,
    kind,
    active: row.active !== false && Number(row.active ?? 1) !== 0,
    isDefault,
    stockRouting: parseJsonObject(row.stock_routing_json || row.stockRoutingJson || row.stockRouting)
  };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toItemArray(value) {
  return Array.isArray(value) ? value : Object.values(value || {});
}

function sortByName(items = []) {
  return [...items].sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function sortTransfers(items = []) {
  return [...items].sort((left, right) => String(right.timestamp || right.date || '').localeCompare(String(left.timestamp || left.date || '')));
}

function createId(prefix) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}
