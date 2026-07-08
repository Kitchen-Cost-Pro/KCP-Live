import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { fetchStock } from './stockService.js';
import {
  DEFAULT_SITE_ID,
  DEFAULT_STOCK_LOCATION_ID,
  createDefaultSite,
  normalizeStockRouting
} from './locationModel.js';
import { getLocationStock } from '../utils/stockBalances.js';

export function subscribeLocationsWorkspace(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for locations.');

  let closed = false;

  const load = async () => {
    try {
      const snapshot = await fetchLocationsWorkspace(workspaceKey);
      if (!closed) onSnapshot?.(snapshot);
    } catch (error) {
      if (!closed) onError?.(error, 'live:locations');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export async function fetchLocationsWorkspace(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for locations.');

  const [locationResponse, siteResponse, stockResponse] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'locations'),
    callCloudflareWorkspaceRoute(workspaceKey, 'site-configuration'),
    fetchStock(workspaceKey)
  ]);
  const settings = {
    siteName: siteResponse.siteConfiguration?.site_name || 'Main Site',
    stockLocationsInitialized: true,
    siteLocationModel: 'selling_locations',
    yocoStoreLocationsAsStockLocations: false
  };
  const sites = [createDefaultSite(settings)];
  const locations = (locationResponse.locations || []).map((row) => normalizeCloudflareLocation(row, settings));
  const stockItems = stockResponse.items || [];

  return {
    status: 'ready',
    source: 'Live locations',
    settings,
    sites: decorateSites(sites, locations, stockItems),
    locations: decorateLocations(locations, stockItems),
    stockItems,
    loaded: {
      settings: true,
      sites: true,
      locations: true,
      stockItems: true
    },
    updatedAt: new Date().toISOString()
  };
}

export async function migrateSitesAndStockLocations(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to migrate locations.');

  const snapshot = await fetchLocationsWorkspace(workspaceKey);
  if (snapshot.locations.length) return;

  await callCloudflareWorkspaceRoute(workspaceKey, 'locations', {
    method: 'POST',
    payload: {
      id: DEFAULT_STOCK_LOCATION_ID,
      name: 'Main Store',
      type: 'storage',
      isDefault: true
    }
  });
}

export async function syncDefaultSiteName(workspaceId, siteName) {
  const workspaceKey = String(workspaceId || '').trim();
  const name = String(siteName || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to sync the default site.');
  if (!name) return null;

  return callCloudflareWorkspaceRoute(workspaceKey, 'locations/sync-default-site-name', {
    method: 'POST',
    payload: { siteName: name }
  });
}

export async function saveSite(workspaceId, payload = {}) {
  return saveLocation(workspaceId, payload);
}

export async function deleteSite() {
  throw new Error('Sites are no longer managed separately. Delete the location instead.');
}

export async function saveLocation(workspaceId, payload = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  const id = String(payload.id || '').trim();
  const name = String(payload.name || payload.displayName || '').trim();
  const type = String(payload.type || payload.kind || (id ? 'selling' : 'storage')).trim() || (id ? 'selling' : 'storage');
  if (!workspaceKey) throw new Error('Workspace id is required to save locations.');
  if (!name) throw new Error('Location name is required.');

  const resource = id ? `locations/${encodeURIComponent(id)}` : 'locations';
  const method = id ? 'PATCH' : 'POST';
  await callCloudflareWorkspaceRoute(workspaceKey, resource, {
    method,
    payload: {
      ...payload,
      name,
      type,
      kind: type,
      stockRouting: normalizeStockRouting(payload.stockRouting || payload.routing || {})
    }
  });
}

export async function deleteLocation(workspaceId, locationId) {
  const workspaceKey = String(workspaceId || '').trim();
  const id = String(locationId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required to delete a location.');
  if (!id) throw new Error('Location id is required.');
  if (isProtectedDefaultStockLocationId(id)) {
    throw new Error('Main Store cannot be deleted.');
  }

  await callCloudflareWorkspaceRoute(workspaceKey, `locations/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

function isProtectedDefaultStockLocationId(value = '') {
  const normalizedId = normalizeLocationKey(value);
  return [
    normalizeLocationKey(DEFAULT_STOCK_LOCATION_ID),
    'main',
    'locmain',
    'mainstore',
    'mainstorage',
    'defaultstock'
  ].includes(normalizedId);
}

function normalizeLocationKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeCloudflareLocation(row = {}, settings = {}) {
  const id = String(row.id || row.locationId || '').trim();
  const canonicalName = String(row.name || row.external_name || row.externalName || 'Location').trim();
  const displayName = String(row.display_name || row.displayName || '').trim();
  const externalName = String(row.external_name || row.externalName || '').trim();
  const kind = String(row.kind || row.type || (Number(row.is_default || row.isDefault || 0) === 1 ? 'storage' : 'selling')).trim();
  const stockRouting = parseJsonObject(row.stock_routing_json || row.stockRoutingJson || row.stockRouting);
  const raw = parseJsonObject(row.raw_json || row.rawJson);
  const taxInfo = normalizeLocationTaxInfo(raw.taxInfo || raw.siteTaxInfo || row.taxInfo || {});
  const siteInfo = normalizeLocationSiteInfo(raw.siteInfo || raw.site_info || row.siteInfo || {});

  return {
    ...raw,
    id,
    locationId: id,
    siteId: DEFAULT_SITE_ID,
    siteName: getDefaultFallbackSiteName(settings),
    name: canonicalName,
    customName: displayName && displayName !== canonicalName ? displayName : '',
    displayName: displayName || canonicalName,
    externalName,
    code: String(row.code || '').trim(),
    type: kind,
    kind,
    notes: String(row.notes || '').trim(),
    stockRouting: normalizeStockRouting(stockRouting),
    taxInfo,
    siteInfo,
    source: String(row.external_provider || row.externalProvider || 'Live locations').trim(),
    yocoLocationId: String(row.external_location_id || row.externalLocationId || '').trim(),
    yocoStoreLocationId: String(row.external_location_id || row.externalLocationId || '').trim(),
    active: row.active !== false && Number(row.active ?? 1) !== 0,
    isDefault: Number(row.is_default || row.isDefault || 0) === 1 || id === DEFAULT_STOCK_LOCATION_ID,
    systemLocked: Number(row.is_default || row.isDefault || 0) === 1 || id === DEFAULT_STOCK_LOCATION_ID,
    createdAt: row.created_at || row.createdAt || '',
    updatedAt: row.updated_at || row.updatedAt || ''
  };
}

function normalizeLocationSiteInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    siteTradingName: String(source.siteTradingName || source.site_trading_name || source.tradingName || '').trim(),
    supplierFacingDeliveryName: String(source.supplierFacingDeliveryName || source.supplier_facing_delivery_name || source.deliveryName || '').trim(),
    deliveryAddressLine1: String(source.deliveryAddressLine1 || source.addressLine1 || source.delivery_address_line_1 || '').trim(),
    deliveryAddressLine2: String(source.deliveryAddressLine2 || source.addressLine2 || source.delivery_address_line_2 || '').trim(),
    suburb: String(source.suburb || '').trim(),
    city: String(source.city || '').trim(),
    province: String(source.province || source.state || '').trim(),
    postalCode: String(source.postalCode || source.postal_code || source.postcode || '').trim(),
    country: String(source.country || '').trim(),
    receivingContactName: String(source.receivingContactName || source.receiving_contact_name || '').trim(),
    receivingContactPhone: String(source.receivingContactPhone || source.receiving_contact_phone || '').trim(),
    receivingContactEmail: String(source.receivingContactEmail || source.receiving_contact_email || '').trim(),
    deliveryInstructions: String(source.deliveryInstructions || source.delivery_instructions || '').trim(),
    receivingHours: String(source.receivingHours || source.receiving_hours || '').trim(),
    supplierNotes: String(source.supplierNotes || source.supplier_notes || '').trim()
  };
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
    registeredAddressLine1: String(source.registeredAddressLine1 || source.addressLine1 || '').trim(),
    registeredAddressLine2: String(source.registeredAddressLine2 || source.addressLine2 || '').trim(),
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

function decorateSites(sites = [], locations = [], stockItems = []) {
  return sortByName(sites).map((site) => {
    const siteLocations = locations.filter((location) => String(location.siteId) === String(site.id));
    const metrics = stockItems.reduce((accumulator, item) => {
      const locationQty = siteLocations.reduce((sum, location) => (
        sum + getLocationMetricStock(item, location, locations)
      ), 0);
      if (locationQty > 0) {
        accumulator.stockItems += 1;
        accumulator.onHandQty += locationQty;
        accumulator.stockValue += locationQty * (Number(item.cost || 0) || 0);
      }
      return accumulator;
    }, { stockItems: 0, onHandQty: 0, stockValue: 0 });

    return {
      ...site,
      stockLocationCount: siteLocations.length,
      stockItems: metrics.stockItems,
      onHandQty: metrics.onHandQty,
      stockValue: metrics.stockValue
    };
  });
}

function decorateLocations(locations = [], stockItems = []) {
  return sortByName(locations).map((location) => {
    const metrics = stockItems.reduce((accumulator, item) => {
      const balance = getLocationMetricStock(item, location, locations);
      if (balance <= 0) return accumulator;
      accumulator.stockItems += 1;
      accumulator.onHandQty += balance;
      accumulator.stockValue += balance * (Number(item.cost || 0) || 0);
      return accumulator;
    }, { stockItems: 0, onHandQty: 0, stockValue: 0 });

    return {
      ...location,
      isPrimary: location.isDefault === true || String(location.id) === DEFAULT_STOCK_LOCATION_ID,
      stockItems: metrics.stockItems,
      onHandQty: metrics.onHandQty,
      stockValue: metrics.stockValue
    };
  });
}

function getLocationMetricStock(item = {}, location = {}, locations = []) {
  const locationId = String(location?.id || '').trim();
  const stock = getLocationStock(item, locationId, locations);
  if (stock !== 0) return stock;

  const balances = item?.balances && typeof item.balances === 'object' ? item.balances : {};
  if (Object.keys(balances).length) return 0;
  return isDefaultLocationForStockFallback(location, locations) ? Number(item.stock || 0) || 0 : 0;
}

function isDefaultLocationForStockFallback(location = {}, locations = []) {
  const id = String(location?.id || '').trim();
  if (!id) return false;
  if (location.isDefault === true || id === DEFAULT_STOCK_LOCATION_ID) return true;
  const activeLocations = (locations || []).filter((entry) => entry?.active !== false);
  return activeLocations.length > 0 && String(activeLocations[0]?.id || '') === id;
}

function sortByName(items = []) {
  return [...items].sort((left, right) => getLocationDisplayName(left).localeCompare(getLocationDisplayName(right)));
}

function getLocationDisplayName(location = {}) {
  return String(location.customName || location.displayName || location.name || '').trim();
}

function getDefaultFallbackSiteName(settings = {}) {
  return String(settings.siteName || settings.workspaceName || settings.name || 'Main Site').trim() || 'Main Site';
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
