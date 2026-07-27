import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { fetchStock, normalizeIngredients } from './stockService.js';
import { DEFAULT_SITE_ID, normalizeSites, normalizeStockLocations } from './locationModel.js';
import { todayLocal } from '../utils/date.js';

export function subscribeStockTakeWorkspace(workspaceId, { onSnapshot, onError, draftUserId = '' } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for stock take.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchStockTakeWorkspace(workspaceKey, { draftUserId });
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'live:stock-takes');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchStockTakeWorkspace(workspaceId, { draftUserId = '' } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for stock take.');

  const [stockTakeResponse, templateResponse, draftResponse, stockState, locationResponse, siteResponse] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'stock-takes', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceKey, 'stock-take-templates'),
    String(draftUserId || '').trim()
      ? callCloudflareWorkspaceRoute(workspaceKey, 'stock-take-drafts', { query: { userId: String(draftUserId).trim() } })
      : Promise.resolve({ drafts: [] }),
    fetchStock(workspaceKey),
    callCloudflareWorkspaceRoute(workspaceKey, 'locations'),
    callCloudflareWorkspaceRoute(workspaceKey, 'site-configuration')
  ]);

  const settings = { siteName: siteResponse.siteConfiguration?.site_name || 'Main Site' };
  const sites = normalizeSites([{ id: DEFAULT_SITE_ID, name: settings.siteName, isDefault: true }], settings);
  const locations = normalizeStockLocations((locationResponse.locations || []).map(normalizeCloudflareLocation), sites, settings);

  return {
    status: 'ready',
    source: 'Live stock takes',
    stockTakes: sortStockTakes(normalizeStockTakeLogs(stockTakeResponse.stockTakes || [])),
    stockItems: sortByName(normalizeIngredients(stockState.items || [])),
    templates: sortTemplates(normalizeStockTakeTemplates(templateResponse.templates || [])),
    savedDrafts: sortSavedDrafts(normalizeStockTakeSavedDrafts(draftResponse.drafts || [])),
    sites: sortByName(sites),
    locations: sortByName(locations),
    loaded: {
      stockTakes: true,
      stockItems: true,
      templates: true,
      savedDrafts: true,
      sites: true,
      locations: true
    },
    updatedAt: new Date().toISOString()
  };
}

export async function saveStockTake(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save stock take.');

  const draft = normalizeStockTakePayload(payload);
  if (!draft.locationId) throw new Error('Select a stock take location.');
  if (!draft.items.length) throw new Error('Enter at least one shelf count first.');

  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'stock-takes', {
    method: 'POST',
    payload: { stockTake: draft }
  });

  return { id: result.id || draft.id, duplicate: result.duplicate === true, skipped: result.skipped === true };
}

export async function updateStockTake(workspaceId, stockTakeId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  const stockTakeKey = String(stockTakeId || payload.id || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to update stock take.');
  if (!stockTakeKey) throw new Error('Stock take id is required to update stock take.');

  const draft = normalizeStockTakePayload({ ...payload, id: stockTakeKey });
  if (!draft.items.length) throw new Error('Enter at least one corrected shelf count.');

  const result = await callCloudflareWorkspaceRoute(workspaceKey, `stock-takes/${encodeURIComponent(stockTakeKey)}`, {
    method: 'PATCH',
    payload: { stockTake: draft }
  });

  return { id: result.id || stockTakeKey, unchanged: result.unchanged === true };
}

export async function saveStockTakeTemplate(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save stock take templates.');

  const template = normalizeStockTakeTemplatePayload(payload);
  if (!template.name) throw new Error('Enter a template name.');
  if (!template.targetLocations.length) throw new Error('Choose at least one target location.');
  if (!template.selections.length) throw new Error('Select at least one category or stock item.');

  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'stock-take-templates', {
    method: 'POST',
    payload: { template }
  });
  return { ...template, id: result.id || template.id };
}

export async function deleteStockTakeTemplate(workspaceId, templateId) {
  const workspaceKey = String(workspaceId || '').trim();
  const id = String(templateId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to delete stock take templates.');
  if (!id) throw new Error('Template id is required.');

  await callCloudflareWorkspaceRoute(workspaceKey, `stock-take-templates/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

export async function saveStockTakeDraftSession(workspaceId, userId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  const uid = String(userId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to save stock take drafts.');
  if (!uid) throw new Error('User id is required to save stock take drafts.');

  const draft = normalizeStockTakePayload(payload);
  if (!draft.locationId) throw new Error('Choose a stock take location before saving a draft.');

  const draftId = String(payload.id || createId('std')).trim();
  const savedDraft = {
    ...draft,
    id: draftId,
    savedByUserId: uid,
    savedAt: new Date().toISOString()
  };

  const result = await callCloudflareWorkspaceRoute(workspaceKey, 'stock-take-drafts', {
    method: 'POST',
    payload: { userId: uid, draft: savedDraft }
  });
  return normalizeStockTakeSavedDraft(result.draft || savedDraft);
}

export async function deleteStockTakeDraftSession(workspaceId, userId, draftId = '') {
  const workspaceKey = String(workspaceId || '').trim();
  const uid = String(userId || '').trim();
  const normalizedDraftId = String(draftId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to delete stock take drafts.');
  if (!uid) throw new Error('User id is required to delete stock take drafts.');

  const route = `stock-take-drafts/${encodeURIComponent(uid)}${normalizedDraftId ? `/${encodeURIComponent(normalizedDraftId)}` : ''}`;
  await callCloudflareWorkspaceRoute(workspaceKey, route, { method: 'DELETE' });
}

export function normalizeStockTakeLogs(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => normalizeStockTakeLog(id, item));
}

export function normalizeStockTakeTemplates(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => normalizeStockTakeTemplate(id, item));
}

function normalizeStockTakeLog(id, item = {}) {
  return {
    ...item,
    id: String(item.id || id || createId('st')),
    templateId: String(item.templateId || '').trim(),
    templateName: String(item.templateName || '').trim(),
    sessionMode: String(item.sessionMode || '').trim() || 'quick',
    siteId: String(item.siteId || '').trim(),
    siteName: String(item.siteName || '').trim(),
    locationId: String(item.locationId || '').trim(),
    locationName: String(item.locationName || '').trim(),
    note: String(item.note || '').trim(),
    lineCount: Number(item.lineCount || toItemArray(item.items).length || 0),
    timestamp: item.timestamp || item.createdAt || item.date || '',
    date: String(item.date || item.timestamp || '').slice(0, 10),
    items: toItemArray(item.items).map((line) => ({
      ...line,
      stockItemId: String(line.stockItemId || line.id || '').trim(),
      stockItemName: String(line.stockItemName || line.name || '').trim(),
      systemStock: Number(line.systemStock || 0) || 0,
      shelfCount: Number(line.shelfCount || 0) || 0,
      variance: Number(line.variance || 0) || 0,
      unit: String(line.unit || '').trim(),
      cost: Number(line.cost || 0) || 0,
      varianceImpactEx: Number(line.varianceImpactEx ?? (Number(line.variance || 0) * Number(line.cost || 0))) || 0,
      selectedUom: String(line.selectedUom || '').trim(),
      uomCounts: normalizeStockTakeUomCounts(line.uomCounts || line.countBreakdown || line.scanBreakdown),
      scanBreakdown: normalizeStockTakeUomCounts(line.scanBreakdown || line.countBreakdown || line.uomCounts)
    }))
  };
}

function normalizeStockTakePayload(payload = {}) {
  return {
    id: String(payload.id || createId('st')).trim(),
    date: String(payload.date || todayLocal()).trim(),
    templateId: String(payload.templateId || '').trim(),
    templateName: String(payload.templateName || '').trim(),
    templateScope: String(payload.templateScope || '').trim() === 'items' ? 'items' : (String(payload.templateScope || '').trim() === 'category' ? 'category' : ''),
    templateSelections: toItemArray(payload.templateSelections).map((value) => String(value || '').trim()).filter(Boolean),
    sessionMode: String(payload.sessionMode || '').trim() || 'quick',
    siteId: String(payload.siteId || '').trim(),
    siteName: String(payload.siteName || '').trim(),
    locationId: String(payload.locationId || '').trim(),
    locationName: String(payload.locationName || '').trim(),
    note: String(payload.note || '').trim(),
    items: (payload.items || []).map((item) => ({
      stockItemId: String(item.stockItemId || item.itemId || item.ingId || '').trim(),
      shelfCount: Number(item.shelfCount),
      unit: String(item.unit || '').trim(),
      selectedUom: String(item.selectedUom || '').trim(),
      uomCounts: normalizeStockTakeUomCounts(item.uomCounts || item.countBreakdown || item.scanBreakdown),
      scanBreakdown: normalizeStockTakeUomCounts(item.scanBreakdown || item.countBreakdown || item.uomCounts)
    })).filter((item) => item.stockItemId && Number.isFinite(item.shelfCount) && item.shelfCount >= 0)
  };
}

function normalizeStockTakeUomCounts(value) {
  return toItemArray(value)
    .map((row) => {
      const ratio = Number(row.ratio ?? row.qtyInBase ?? row.qty_in_base ?? row.packSize ?? 1);
      const count = Number(row.count ?? row.scannedCount ?? row.qty ?? 0);
      const uomName = String(row.uomName || row.selectedUom || row.unit || '').trim();
      const baseUom = String(row.baseUom || row.baseUnit || '').trim();
      const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
      return {
        key: String(row.key || `${uomName.toLowerCase()}::${safeRatio}`).trim(),
        uomName,
        baseUom,
        ratio: safeRatio,
        count: Number.isFinite(count) && count > 0 ? count : 0,
        scans: Number(row.scans ?? count ?? 0) || 0,
        lastBarcode: String(row.lastBarcode || row.barcode || '').trim()
      };
    })
    .filter((row) => row.uomName && row.count > 0);
}

function normalizeStockTakeTemplate(id, item = {}) {
  const targetLocations = normalizeTemplateLocations(item);
  return {
    id: String(item.id || id || createId('tmpl')),
    name: String(item.name || '').trim(),
    siteId: String(item.siteId || '').trim(),
    siteName: String(item.siteName || '').trim(),
    targetLocation: targetLocations[0] || '',
    targetLocations,
    scope: String(item.scope || 'category').trim() === 'items' ? 'items' : 'category',
    selections: toItemArray(item.selections).map((value) => String(value || '').trim()).filter(Boolean)
  };
}

function normalizeStockTakeSavedDraft(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ...normalizeStockTakePayload(value),
    id: String(value.id || '').trim(),
    savedByUserId: String(value.savedByUserId || '').trim(),
    savedAt: String(value.savedAt || value.updatedAt || value.timestamp || '').trim()
  };
}

function normalizeStockTakeSavedDrafts(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .map(([, item]) => normalizeStockTakeSavedDraft(item))
    .filter(Boolean);
}

function normalizeStockTakeTemplatePayload(payload = {}) {
  const targetLocations = normalizeTemplateLocations(payload);
  return {
    id: String(payload.id || createId('tmpl')).trim(),
    name: String(payload.name || '').trim(),
    siteId: String(payload.siteId || '').trim(),
    siteName: String(payload.siteName || '').trim(),
    targetLocation: targetLocations[0] || '',
    targetLocations,
    scope: String(payload.scope || 'category').trim() === 'items' ? 'items' : 'category',
    selections: toItemArray(payload.selections).map((value) => String(value || '').trim()).filter(Boolean)
  };
}

function normalizeCloudflareLocation(row = {}) {
  const id = String(row.id || '').trim();
  return {
    ...row,
    id,
    name: String(row.display_name || row.displayName || row.name || row.external_name || id).trim(),
    siteId: DEFAULT_SITE_ID,
    siteName: 'Main Site',
    type: String(row.kind || row.type || 'selling').trim(),
    active: row.active !== false && Number(row.active ?? 1) !== 0,
    isDefault: Number(row.is_default || row.isDefault || 0) === 1 || id === 'main'
  };
}

function toItemArray(value) {
  return Array.isArray(value) ? value : Object.values(value || {});
}

function toTemplateValueArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  const scalar = String(value || '').trim();
  return scalar ? [scalar] : [];
}

function normalizeTemplateLocations(item = {}) {
  const primary = String(item.targetLocation || item.locationId || '').trim();
  return [
    ...new Set([
      primary,
      ...toTemplateValueArray(item.targetLocations || item.locations || item.locationIds)
        .map((value) => String(value || '').trim())
    ].filter(Boolean))
  ];
}

function sortByName(items = []) {
  return [...items].sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function sortStockTakes(items = []) {
  return [...items].sort((left, right) => String(right.timestamp || right.date || '').localeCompare(String(left.timestamp || left.date || '')));
}

function sortTemplates(items = []) {
  return [...items].sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function sortSavedDrafts(items = []) {
  return [...items].sort((left, right) => String(right.savedAt || '').localeCompare(String(left.savedAt || '')));
}

function createId(prefix) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}
