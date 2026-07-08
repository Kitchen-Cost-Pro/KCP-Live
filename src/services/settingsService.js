import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { downloadFileBlob } from './dataService.js';
import {
  DEFAULT_RESTAURANT_BACKGROUND_ID,
  DEFAULT_RESTAURANT_THEME_ID,
  getRestaurantBackgroundPreset,
  getRestaurantThemePreset
} from '../themePresets.js';

const SNAPSHOT_KEYS = [
  'products',
  'ingredients',
  'locations',
  'settings',
  'suppliers',
  'purchaseOrders',
  'logs_grv',
  'logs_cn',
  'logs_adj',
  'logs_stocktakes',
  'logs_mfg',
  'logs_sales',
  'logs_sales_errors',
  'logs_transfers',
  'logs_snapshots',
  'sessionOpeningStock',
  'processedSalesSignatures',
  'stocktakeTemplates',
  'stocktakeDrafts',
  'dashboardMetrics'
];

const ARRAY_DEFAULT_KEYS = new Set([
  'ingredients',
  'locations',
  'suppliers',
  'logs_grv',
  'logs_cn',
  'logs_adj',
  'logs_stocktakes',
  'logs_mfg',
  'logs_sales',
  'logs_sales_errors',
  'logs_transfers',
  'logs_snapshots'
]);

const LOW_STOCK_EMAIL_FREQUENCIES = new Set(['off', '1_day', '2_day', '1_week', '2_week', '1_month']);

export async function getWorkspaceSettingsSnapshot(workspaceId) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'settings');
  return normalizeSettings(response.settings || {});
}

export async function getYocoCategoryOptions(workspaceId) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'products', {
    query: { limit: 500 }
  });
  const entries = response.products || response.items || [];
  const categories = new Map();

  entries.forEach((product = {}) => {
    if (!product || typeof product !== 'object') return;
    const id = String(product.yocoCategoryId || product.yocoCategoryName || product.category || '').trim();
    const name = String(product.yocoCategoryName || product.category || id || '').trim();
    const isYoco = Boolean(product.yocoItemId || product.yocoVariantId || product.yocoCategoryId || product.yocoCategoryName) ||
      String(product.source || '').toLowerCase() === 'yoco';
    if (!isYoco || !id || !name) return;
    categories.set(id, {
      id,
      name,
      productCount: (categories.get(id)?.productCount || 0) + 1
    });
  });

  return [...categories.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function getStockCategoryOptions(workspaceId) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'stock-items', {
    query: { limit: 500 }
  });
  const entries = response.stockItems || response.items || [];
  const categories = new Map();

  entries.forEach((item = {}) => {
    if (!item || typeof item !== 'object') return;
    const raw = String(item.category || 'General').trim() || 'General';
    const name = normalizeStockCategoryBase(raw);
    const id = name;
    categories.set(id, {
      id,
      name,
      rawCategory: raw,
      itemCount: (categories.get(id)?.itemCount || 0) + 1
    });
  });

  return [...categories.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function saveWorkspaceSettings(workspaceId, draft = {}) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const nextSettings = normalizeSettings(draft);
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'settings', {
    method: 'PATCH',
    payload: { settings: nextSettings }
  });
  return normalizeSettings(response.settings || nextSettings);
}

export async function exportWorkspaceSnapshot(workspaceId, workspaceName = 'workspace') {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const [
    settings,
    locations,
    stockItems,
    products,
    suppliers,
    purchaseOrders,
    grvs,
    creditNotes,
    adjustments,
    transfers,
    stockTakes,
    manufacturingBatches
  ] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'settings').catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'locations').catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'stock-items', { query: { limit: 500 } }).catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'products', { query: { limit: 500 } }).catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'suppliers', { query: { limit: 500 } }).catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'purchase-orders', { query: { limit: 500 } }).catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'grvs', { query: { limit: 500 } }).catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'credit-notes', { query: { limit: 500 } }).catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'adjustments', { query: { limit: 500 } }).catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'transfers', { query: { limit: 500 } }).catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'stock-takes', { query: { limit: 500 } }).catch(() => ({})),
    callCloudflareWorkspaceRoute(workspaceKey, 'manufacturing-batches', { query: { limit: 500 } }).catch(() => ({}))
  ]);
  const data = {
    settings: settings.settings || {},
    locations: locations.locations || [],
    ingredients: stockItems.stockItems || stockItems.items || [],
    products: products.products || products.items || [],
    suppliers: suppliers.suppliers || suppliers.items || [],
    purchaseOrders: purchaseOrders.purchaseOrders || purchaseOrders.items || [],
    logs_grv: grvs.grvs || grvs.goodsReceipts || grvs.items || [],
    logs_cn: creditNotes.creditNotes || creditNotes.items || [],
    logs_adj: adjustments.adjustments || adjustments.items || [],
    logs_transfers: transfers.transfers || transfers.items || [],
    logs_stocktakes: stockTakes.stockTakes || stockTakes.items || [],
    logs_mfg: manufacturingBatches.batches || manufacturingBatches.manufacturingBatches || manufacturingBatches.items || []
  };
  const body = JSON.stringify(data, null, 2);
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = String(workspaceName || workspaceKey || 'workspace').trim().replace(/\s+/g, '_');
  downloadFileBlob(new Blob([body], { type: 'application/json' }), `KCP_${safeName}_Snapshot_${stamp}.json`);
}

export async function importWorkspaceSnapshot(workspaceId, file) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  if (!file) throw new Error('Choose a JSON snapshot first.');

  const parsed = JSON.parse(await file.text());
  const source = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Snapshot must be a JSON object.');
  }

  const payload = normalizeSnapshotPayload(source);
  await callCloudflareWorkspaceRoute(workspaceKey, 'import-preview', {
    method: 'POST',
    payload: {
      locations: payload.locations || [],
      stockItems: payload.ingredients || []
    }
  });
  if (payload.settings) {
    await saveWorkspaceSettings(workspaceKey, payload.settings);
  }
  return {
    importedKeys: Object.keys(payload),
    settings: normalizeSettings(payload.settings)
  };
}

export function normalizeSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const tradingTime = normalizeTime(source.tradingTime || source.tradingEndTime || '23:59');
  const logoutTimeout = Math.max(1, Math.min(1440, parseInt(source.logoutTimeout ?? source.autoLogoutMinutes ?? 30, 10) || 30));
  const vatRate = clampNumber(source.vatRate ?? source.vatPercentage ?? 15, 0, 100, 15);
  const uiScale = String(source.uiScale || 'normal') === 'large' ? 'large' : 'normal';
  const costingMethod = String(source.costingMethod || 'last').toLowerCase() === 'wac' ? 'wac' : 'last';
  const lowStockEmailFrequency = LOW_STOCK_EMAIL_FREQUENCIES.has(String(source.lowStockEmailFrequency || '').trim())
    ? String(source.lowStockEmailFrequency || '').trim()
    : 'off';
  const lowStockEmailDispatchTime = normalizeTime(
    source.lowStockEmailDispatchTime ||
    source.alertDispatchTime ||
    source.Alert_Dispatch_Time ||
    '08:00'
  );
  const yocoStoreLocationsAsStockLocations = source.yocoStoreLocationsAsStockLocations === true ||
    String(source.yocoStoreLocationsAsStockLocations || '').toLowerCase() === 'true';
  const viewingOnly = source.viewingOnly === true || source.viewOnly === true;
  const yocoCategoryMap = normalizeYocoCategoryMap(source.yocoCategoryMap);
  const stockCategoryRoutingMap = normalizeStockCategoryRoutingMap(source.stockCategoryRoutingMap);
  const restaurantThemeId = getRestaurantThemePreset(source.restaurantThemeId || source.themePreset || DEFAULT_RESTAURANT_THEME_ID).id;
  const restaurantBackgroundId = getRestaurantBackgroundPreset(source.restaurantBackgroundId || source.backgroundPreset || source.restaurantThemeId || DEFAULT_RESTAURANT_BACKGROUND_ID).id;
  const restaurantLogoDataUrl = normalizeLogoDataUrl(source.restaurantLogoDataUrl || source.logoDataUrl || source.customerLogoDataUrl || '');
  const restaurantLogoName = String(source.restaurantLogoName || source.logoName || '').trim();
  const restaurantBackgroundDataUrl = normalizeLogoDataUrl(source.restaurantBackgroundDataUrl || source.backgroundDataUrl || source.customerBackgroundDataUrl || '', 1800000);
  const restaurantBackgroundName = String(source.restaurantBackgroundName || source.backgroundName || '').trim();
  const companyTaxInfo = normalizeTaxInfo(source.companyTaxInfo || source.taxInfo || source.company_tax_info || {});

  return {
    ...source,
    vatRate,
    siteName: String(source.siteName || '').trim(),
    orgId: String(source.orgId || source.org_id || '').trim(),
    corpId: String(source.corpId || source.corp_id || '').trim(),
    viewingOnly,
    linkedSiteCount: Number(source.linkedSiteCount ?? source.linked_site_count ?? 0) || 0,
    tradingTime,
    tradingDayStartHour: deriveStartHourFromTradingTime(tradingTime),
    uiScale,
    logoutTimeout,
    costingMethod,
    lowStockEmailFrequency,
    lowStockEmailDispatchTime,
    yocoStoreLocationsAsStockLocations,
    yocoCategoryMap,
    stockCategoryRoutingMap,
    restaurantThemeId,
    restaurantBackgroundId,
    restaurantLogoDataUrl,
    restaurantLogoName,
    restaurantBackgroundDataUrl,
    restaurantBackgroundName,
    companyTaxInfo
  };
}

export function normalizeTaxInfo(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    useDifferentTaxInfo: source.useDifferentTaxInfo === true || String(source.useDifferentTaxInfo || '').toLowerCase() === 'true',
    registeredCompanyName: String(source.registeredCompanyName || source.registered_company_name || '').trim(),
    tradingName: String(source.tradingName || source.trading_name || '').trim(),
    companyRegistrationNumber: String(source.companyRegistrationNumber || source.company_registration_number || source.registrationNumber || '').trim(),
    vatNumber: String(source.vatNumber || source.vat_number || source.vatNo || '').trim(),
    taxNumber: String(source.taxNumber || source.tax_number || '').trim(),
    registeredAddressLine1: String(source.registeredAddressLine1 || source.addressLine1 || source.registered_address_line_1 || '').trim(),
    registeredAddressLine2: String(source.registeredAddressLine2 || source.addressLine2 || source.registered_address_line_2 || '').trim(),
    suburb: String(source.suburb || '').trim(),
    city: String(source.city || '').trim(),
    province: String(source.province || source.state || '').trim(),
    postalCode: String(source.postalCode || source.postal_code || source.postcode || '').trim(),
    country: String(source.country || '').trim(),
    registeredAddress: String(source.registeredAddress || source.registered_address || '').trim(),
    accountsContactName: String(source.accountsContactName || source.accounts_contact_name || '').trim(),
    accountsContactEmail: String(source.accountsContactEmail || source.accounts_contact_email || '').trim(),
    accountsContactPhone: String(source.accountsContactPhone || source.accounts_contact_phone || '').trim()
  };
}

function normalizeLogoDataUrl(value = '', maxLength = 450000) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,/i.test(text)) return '';
  return text.length <= maxLength ? text : '';
}

function normalizeStockCategoryRoutingMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).reduce((map, [key, entry]) => {
    const id = normalizeStockCategoryBase(key);
    const routingLabel = String(
      entry && typeof entry === 'object'
        ? entry.routingLabel || entry.label || entry.name || ''
        : entry
    ).trim();
    if (!id || !routingLabel) return map;
    map[id] = entry && typeof entry === 'object'
      ? {
          ...entry,
          stockCategory: id,
          routingLabel
        }
      : routingLabel;
    return map;
  }, {});
}

function normalizeStockCategoryBase(value = '') {
  return String(value || 'General')
    .trim()
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s*\(([^)]+)\)\s*-\s*Manufactured$/i, '$1')
    .trim() || 'General';
}

function normalizeYocoCategoryMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).reduce((map, [key, entry]) => {
    const id = String(key || '').trim();
    const routingLabel = String(
      entry && typeof entry === 'object'
        ? entry.routingLabel || entry.kcpRoutingLabel || entry.label || entry.name || ''
        : entry
    ).trim();
    if (!id || !routingLabel) return map;
    map[id] = entry && typeof entry === 'object'
      ? {
          ...entry,
          routingLabel
        }
      : routingLabel;
    return map;
  }, {});
}

function normalizeSnapshotPayload(source) {
  const payload = {};
  SNAPSHOT_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      payload[key] = key === 'settings' ? normalizeSettings(source[key]) : source[key];
      return;
    }

    if (key === 'settings') payload[key] = normalizeSettings();
    else if (key === 'products' || key === 'purchaseOrders' || key === 'sessionOpeningStock' || key === 'processedSalesSignatures' || key === 'stocktakeTemplates' || key === 'stocktakeDrafts' || key === 'dashboardMetrics') payload[key] = {};
    else if (ARRAY_DEFAULT_KEYS.has(key)) payload[key] = [];
  });
  return payload;
}

function requireWorkspaceId(workspaceId) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for settings.');
  return workspaceKey;
}

function normalizeTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '23:59';
  const hours = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minutes = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function deriveStartHourFromTradingTime(time) {
  const [hours, minutes] = normalizeTime(time).split(':').map(Number);
  return Math.ceil(((hours || 0) * 60 + (minutes || 0)) / 60) % 24;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(String(value ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
