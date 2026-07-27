import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';

export async function getSiteConfiguration(workspaceId) {
  const siteId = String(workspaceId || '').trim();
  if (!siteId) return createFallbackSiteConfiguration();

  const response = await callCloudflareWorkspaceRoute(siteId, 'site-configuration', { method: 'GET' });
  return normalizeSiteConfiguration(response.siteConfiguration || response.site_configuration || response || {});
}

export async function getLinkedTransferProfiles(workspaceId) {
  const siteId = String(workspaceId || '').trim();
  if (!siteId) return [];

  const response = await callCloudflareWorkspaceRoute(siteId, 'linked-transfer-profiles', { method: 'GET' });
  return normalizeLinkedTransferProfiles(response.linkedProfiles || response.linked_profiles || []);
}

export async function postInternalTransfer(workspaceId, payload = {}) {
  return callCloudflareWorkspaceRoute(workspaceId, 'transfers/internal', {
    method: 'POST',
    payload
  });
}

export async function postExternalTransfer(payload = {}) {
  const workspaceId = String(payload.from_site_id || payload.fromSiteId || payload.workspaceId || '').trim();
  if (!workspaceId) throw new Error('Source workspace is required for external transfers.');
  return callCloudflareWorkspaceRoute(workspaceId, 'transfers/external', {
    method: 'POST',
    payload
  });
}

export async function acceptExternalTransfer(workspaceId, transferId, items = []) {
  const id = String(transferId || '').trim();
  if (!id) throw new Error('Transfer id is required.');
  return callCloudflareWorkspaceRoute(workspaceId, `transfers/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
    payload: { items }
  });
}

export async function rejectExternalTransfer(workspaceId, transferId, action = 'reject') {
  const id = String(transferId || '').trim();
  if (!id) throw new Error('Transfer id is required.');
  const verb = action === 'cancel' ? 'cancel' : 'reject';
  return callCloudflareWorkspaceRoute(workspaceId, `transfers/${encodeURIComponent(id)}/${verb}`, {
    method: 'POST',
    payload: {}
  });
}

export async function getCorporateReport(corpId = '') {
  return callCloudflareWorkspaceRoute('corporate', 'reports/corporate', {
    method: 'GET',
    query: { corp_id: corpId }
  });
}

export function normalizeSiteConfiguration(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    siteId: String(source.site_id || source.siteId || '').trim(),
    orgId: String(source.org_id || source.orgId || '').trim(),
    corpId: String(source.corp_id || source.corpId || '').trim(),
    viewingOnly: source.viewing_only === true || source.viewingOnly === true,
    locationCount: Number(source.location_count ?? source.locationCount ?? 0) || 0,
    linkedSiteCount: Number(source.linked_site_count ?? source.linkedSiteCount ?? 0) || 0,
    showInternalTransfer: source.show_internal_transfer !== false && source.showInternalTransfer !== false,
    showExternalTransfer: source.show_external_transfer === true || source.showExternalTransfer === true,
    status: source.status || 'ready'
  };
}

export function createFallbackSiteConfiguration(seed = {}) {
  return normalizeSiteConfiguration({
    show_internal_transfer: true,
    show_external_transfer: false,
    status: 'local-fallback',
    ...seed
  });
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') return Object.values(value).filter(Boolean);
  return [];
}

function normalizeLinkedTransferProfiles(value = []) {
  return toArray(value)
    .map((profile) => ({
      id: String(profile.id || profile.siteId || profile.workspaceId || '').trim(),
      name: String(profile.name || profile.siteName || profile.workspaceName || profile.id || '').trim(),
      orgId: String(profile.orgId || profile.org_id || '').trim(),
      corpId: String(profile.corpId || profile.corp_id || '').trim(),
      permissionLevel: profile.permissionLevel || 'full_transfer',
      viewingOnly: profile.viewingOnly === true || profile.viewing_only === true,
      locations: toArray(profile.locations).map((location) => ({
        id: String(location.id || location.locationId || '').trim(),
        name: String(location.name || location.displayName || location.locationName || location.label || location.id || '').trim(),
        type: location.type || 'selling',
        active: location.active !== false
      })).filter((location) => location.id && location.name),
      stockItems: toArray(profile.stockItems || profile.ingredients).map((item) => ({
        id: String(item.id || item.stockItemId || '').trim(),
        name: String(item.name || item.stockItemName || item.ingredientName || '').trim(),
        category: String(item.category || '').trim(),
        unit: String(item.unit || item.uom || '').trim(),
        sku: String(item.sku || item.SKU || '').trim(),
        code: String(item.code || item.itemCode || item.stockCode || '').trim(),
        barcodes: toStringList(item.barcodes || item.barcode || item.Barcode),
        stock: Number(item.stock || 0) || 0,
        balances: item.balances && typeof item.balances === 'object' ? item.balances : {}
      })).filter((item) => item.id && item.name)
    }))
    .filter((profile) => profile.id && profile.name);
}

function toStringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  if (typeof value === 'object') return Object.values(value).map((entry) => String(entry || '').trim()).filter(Boolean);
  return String(value).split(/[,;\n]/).map((entry) => entry.trim()).filter(Boolean);
}
