export const DEFAULT_SITE_ID = 'site_main';
export const DEFAULT_STOCK_LOCATION_ID = 'main';
export const DEFAULT_STOCK_LOCATION_NAME = 'Main Store';

export function getDefaultSiteName(settings = {}) {
  return String(settings.siteName || settings.workspaceName || settings.name || 'Main Site').trim() || 'Main Site';
}

export function createDefaultSite(settings = {}) {
  const now = new Date().toISOString();
  return {
    id: DEFAULT_SITE_ID,
    siteId: DEFAULT_SITE_ID,
    name: getDefaultSiteName(settings),
    code: 'MAIN',
    address: '',
    notes: '',
    active: true,
    isDefault: true,
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeSites(value, settings = {}) {
  const entries = toEntries(value);
  const defaultSiteName = getDefaultSiteName(settings);
  const defaultEntry = entries
    .filter(([, item]) => item && typeof item === 'object')
    .find(([id, item]) => (
      String(item.siteId || item.id || id || '') === DEFAULT_SITE_ID ||
      item.isDefault === true
    ));
  const defaultSite = defaultEntry?.[1] || {};

  return [{
    ...createDefaultSite(settings),
    ...defaultSite,
    id: DEFAULT_SITE_ID,
    siteId: DEFAULT_SITE_ID,
    name: defaultSiteName,
    code: String(defaultSite.code || 'MAIN').trim() || 'MAIN',
    address: String(defaultSite.address || '').trim(),
    notes: String(defaultSite.notes || defaultSite.description || '').trim(),
    active: true,
    isDefault: true,
    createdAt: defaultSite.createdAt || '',
    updatedAt: defaultSite.updatedAt || ''
  }];
}

export function normalizeStockLocations(value, sites = [], settings = {}) {
  const normalizedSites = normalizeSites(sites, settings);
  const defaultSiteId = DEFAULT_SITE_ID;
  const defaultSite = normalizedSites[0] || createDefaultSite(settings);
  const entries = toEntries(value);
  const locations = entries
    .filter(([id, item]) => id !== '__meta' && item && typeof item === 'object')
    .map(([id, item]) => {
      const locationId = String(item.id || item.locationId || id || DEFAULT_STOCK_LOCATION_ID).trim() || DEFAULT_STOCK_LOCATION_ID;
      const isDefaultLocation = isDefaultStockLocation(item, locationId);
      const name = String(item.name || item.label || item.locationName || (isDefaultLocation ? DEFAULT_STOCK_LOCATION_NAME : locationId)).trim() || locationId;
      const customName = String(item.customName || item.aliasName || '').trim();
      const displayName = customName || String(item.displayName || '').trim() || name;
      const originalName = String(item.originalName || item.initialName || (isDefaultLocation ? DEFAULT_STOCK_LOCATION_NAME : '')).trim();
      return {
        ...item,
        id: locationId,
        locationId,
        siteId: defaultSiteId,
        siteName: defaultSite.name,
        name,
        customName,
        displayName,
        type: String(item.type || item.kind || item.locationType || 'selling').trim() || 'selling',
        kind: String(item.kind || item.type || item.locationType || 'selling').trim() || 'selling',
        notes: String(item.notes || item.description || '').trim(),
        source: String(item.source || '').trim(),
        code: String(item.code || item.shortCode || '').trim(),
        yocoLocationId: String(item.yocoLocationId || item.yocoStoreLocationId || '').trim(),
        yocoStoreLocationId: String(item.yocoStoreLocationId || item.yocoLocationId || '').trim(),
        originalName,
        stockRouting: normalizeStockRouting(item.stockRouting || item.routing || {}),
        active: item.active !== false && item.archived !== true,
        isDefault: isDefaultLocation,
        systemLocked: item.systemLocked === true || isDefaultLocation,
        createdAt: item.createdAt || '',
        updatedAt: item.updatedAt || ''
      };
    });

  if (!locations.length) {
    return [createDefaultStockLocation(defaultSite, settings)];
  }

  // NOTE: We intentionally do NOT inject a synthetic Main Store when the list is
  // non-empty but lacks a default. The backend already returns Main Store for any
  // user permitted to see it (getLocations filters by allowed_locations_json).
  // Injecting one here leaked Main Store to location-restricted users who were
  // never assigned it.

  return sortByName(dedupeStockLocations(locations).map((location) => {
    const isDefaultLocation = isDefaultStockLocation(location, location.id);
    return {
      ...location,
      isDefault: isDefaultLocation,
      systemLocked: location.systemLocked === true || isDefaultLocation
    };
  }));
}

function isDefaultStockLocation(item = {}, locationId = '') {
  const normalizedId = normalizeLocationKey(locationId);
  const normalizedName = normalizeLocationKey(item.name || item.displayName || item.label || item.locationName);
  return item.isDefault === true ||
    item.is_default === true ||
    Number(item.is_default || item.isDefault || 0) === 1 ||
    normalizedId === normalizeLocationKey(DEFAULT_STOCK_LOCATION_ID) ||
    normalizedId === 'locmain' ||
    normalizedName === 'mainstore';
}

function dedupeStockLocations(locations = []) {
  const byKey = new Map();
  locations.forEach((location) => {
    const key = location.isDefault
      ? '__default__'
      : String(location.id || location.locationId || '').trim();
    if (!key) return;
    const previous = byKey.get(key);
    if (!previous || location.isDefault === true || String(location.updatedAt || '').localeCompare(String(previous.updatedAt || '')) > 0) {
      byKey.set(key, location);
    }
  });
  return [...byKey.values()];
}

function createDefaultStockLocation(defaultSite = createDefaultSite(), settings = {}) {
  const now = new Date().toISOString();
  const name = String(settings.defaultLocationName || DEFAULT_STOCK_LOCATION_NAME).trim() || DEFAULT_STOCK_LOCATION_NAME;
  return {
    id: DEFAULT_STOCK_LOCATION_ID,
    locationId: DEFAULT_STOCK_LOCATION_ID,
    siteId: DEFAULT_SITE_ID,
    siteName: defaultSite.name || getDefaultSiteName(settings),
    name,
    customName: '',
    displayName: name,
    type: 'storage',
    notes: '',
    source: 'system',
    code: 'MAIN',
    yocoLocationId: '',
    yocoStoreLocationId: '',
    originalName: DEFAULT_STOCK_LOCATION_NAME,
    stockRouting: {},
    active: true,
    isDefault: true,
    systemLocked: true,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeLocationKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export function normalizeStockRouting(value = {}) {
  if (!value) return {};
  if (typeof value === 'string') {
    return value.split(/[\n,;]+/).reduce((map, pair) => {
      const [label, target] = String(pair || '').split(/[:=]/);
      const key = String(label || '').trim();
      const routeTarget = String(target || '').trim();
      if (key && routeTarget) map[key] = routeTarget;
      return map;
    }, {});
  }
  if (typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).reduce((map, [label, target]) => {
    const key = String(label || '').trim();
    const routeTarget = String(target || '').trim();
    if (key && routeTarget) map[key] = routeTarget;
    return map;
  }, {});
}

export function normalizeSitesAndStockLocations({ sites, locations, settings } = {}) {
  const normalizedSites = normalizeSites(sites, settings);
  const normalizedLocations = normalizeStockLocations(locations, normalizedSites, settings);
  return {
    sites: normalizedSites,
    locations: normalizedLocations
  };
}

export function createLocationLookup(locations = [], sites = []) {
  const normalizedSites = normalizeSites(sites);
  const normalizedLocations = normalizeStockLocations(locations, normalizedSites);
  const siteMap = new Map(normalizedSites.map((site) => [String(site.id), site]));
  const locationMap = new Map(normalizedLocations.map((location) => [String(location.id), location]));
  return {
    sites: normalizedSites,
    locations: normalizedLocations,
    siteMap,
    locationMap,
    getSiteName: (siteId = '') => siteMap.get(String(siteId || ''))?.name || '',
    getStockLocationName: (locationId = '') => {
      const location = locationMap.get(String(locationId || ''));
      return location?.displayName || location?.customName || location?.name || '';
    },
    getStockLocationSiteId: (locationId = '') => locationMap.get(String(locationId || ''))?.siteId || '',
    getStockLocationSiteName: (locationId = '') => {
      const siteId = locationMap.get(String(locationId || ''))?.siteId || '';
      return siteMap.get(siteId)?.name || '';
    }
  };
}

export function resolveLocationContext(locationId = '', locations = [], sites = []) {
  const lookup = createLocationLookup(locations, sites);
  const id = String(locationId || '').trim();
  const location = lookup.locationMap.get(id);
  const site = location ? lookup.siteMap.get(String(location.siteId || '')) : null;
  return {
    locationId: id,
    locationName: location?.displayName || location?.customName || location?.name || id,
    siteId: location?.siteId || '',
    siteName: site?.name || location?.siteName || ''
  };
}

export function enrichLocationFields(record = {}, lookup = createLocationLookup()) {
  const locationId = String(record.locationId || record.targetLocation || record.location || '').trim();
  const location = lookup.locationMap?.get(locationId);
  const siteId = String(record.siteId || location?.siteId || '').trim();
  const site = lookup.siteMap?.get(siteId);
  return {
    ...record,
    siteId,
    siteName: String(record.siteName || site?.name || location?.siteName || '').trim(),
    locationId,
    locationName: String(record.locationName || record.targetLocationName || location?.displayName || location?.customName || location?.name || locationId || '').trim()
  };
}

export function getBalanceForStockLocation(item = {}, locationId = '') {
  const balances = item?.balances && typeof item.balances === 'object' ? item.balances : {};
  const id = String(locationId || '').trim();
  if (!id) return Number(item.stock || 0) || 0;
  return Number(balances[id] || 0) || 0;
}

export function getBalanceForSite(item = {}, siteId = '', locations = []) {
  if (!siteId || String(siteId) === DEFAULT_SITE_ID) {
    const balances = item?.balances && typeof item.balances === 'object' ? item.balances : {};
    const total = Object.values(balances).reduce((sum, qty) => sum + (Number(qty || 0) || 0), 0);
    return total || Number(item.stock || 0) || 0;
  }
  const ids = new Set((locations || [])
    .filter((location) => String(location.siteId || '') === String(siteId || ''))
    .map((location) => String(location.id || ''))
    .filter(Boolean));
  if (!ids.size) return 0;
  const balances = item?.balances && typeof item.balances === 'object' ? item.balances : {};
  return Object.entries(balances).reduce((sum, [locationId, qty]) => (
    ids.has(String(locationId)) ? sum + (Number(qty || 0) || 0) : sum
  ), 0);
}

export function userCanAccessSite(siteId = '', access = {}) {
  if (!siteId || String(siteId) === DEFAULT_SITE_ID) return true;
  const ids = normalizeAccessList(access.siteIds || access.sites);
  return ids.includes('all') || ids.includes(String(siteId || '').trim());
}

export function userCanAccessStockLocation(locationId = '', access = {}) {
  const ids = normalizeAccessList(access.stockLocationIds || access.locations);
  return ids.includes('all') || ids.includes(String(locationId || '').trim());
}

export function normalizeAccessList(value) {
  const list = Array.isArray(value) ? value : [];
  if (!list.length) return ['all'];
  const normalized = [...new Set(list.map((entry) => String(entry || '').trim()).filter(Boolean))];
  return normalized.includes('all') ? ['all'] : normalized;
}

function toEntries(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item, index) => [item?.id || item?.siteId || String(index), item]);
  if (typeof value === 'object') return Object.entries(value);
  return [];
}

function sortByName(items = []) {
  return [...items].sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function sortBySiteThenName(locations = [], sites = []) {
  const siteOrder = new Map((sites || []).map((site, index) => [String(site.id), index]));
  return [...locations].sort((left, right) => {
    const siteDelta = (siteOrder.get(String(left.siteId)) ?? 999) - (siteOrder.get(String(right.siteId)) ?? 999);
    if (siteDelta) return siteDelta;
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
}
