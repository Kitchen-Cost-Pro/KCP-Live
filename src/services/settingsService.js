import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { downloadFileBlob } from './dataService.js';
import { buildExportFilename } from './exportService.js';
import { isStockRoutingEligibleItem } from './stockCountEligibility.js';
import { fetchSuppliers } from './supplierService.js';
import { fetchStock } from './stockService.js';
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

const PERSONAL_SETTING_KEYS = new Set([
  'uiScale',
  'restaurantThemeId',
  'restaurantBackgroundId',
  'restaurantBackgroundDataUrl',
  'restaurantBackgroundName'
]);


export async function getWorkspaceSettingsSnapshot(workspaceId) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const [workspaceResponse, personalResponse] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'settings'),
    callCloudflareWorkspaceRoute(workspaceKey, 'user-preferences').catch(() => ({ preferences: {} }))
  ]);
  return normalizeSettings({
    ...(workspaceResponse.settings || {}),
    ...(personalResponse.preferences || {})
  });
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

export async function getGoLiveReadiness(workspaceId) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const [productResponse, locationResponse] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'products', { query: { limit: 500 } }),
    callCloudflareWorkspaceRoute(workspaceKey, 'locations')
  ]);
  const products = productResponse.products || productResponse.items || [];
  const locations = locationResponse.locations || [];
  const recipeCount = products.filter((product = {}) => {
    const recipe = product.recipe || product.recipeLines || product.recipe_lines;
    if (Array.isArray(recipe) && recipe.length > 0) return true;
    if (product.missingRecipe === false || product.missing_recipe === 0) return true;
    const status = String(product.recipeStatus || product.recipe_status || '').toLowerCase();
    return status === 'complete' || status === 'complete_via_linked_stock_item';
  }).length;
  return {
    productCount: products.length,
    recipeCount,
    locationCount: locations.filter((location = {}) => location.active !== false && Number(location.active ?? 1) !== 0).length
  };
}

// Drives the onboarding wizard's first-run trigger and its Finish-step summary. Kept separate
// from getGoLiveReadiness (which only counts products/recipes/locations for the Yoco stock
// depletion gate) since onboarding also cares about suppliers and stock items.
export async function getOnboardingReadiness(workspaceId) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const [productResponse, suppliers, stock] = await Promise.all([
    callCloudflareWorkspaceRoute(workspaceKey, 'products', { query: { limit: 500 } }),
    fetchSuppliers(workspaceKey).catch(() => []),
    fetchStock(workspaceKey).catch(() => ({ items: [] }))
  ]);
  const products = productResponse.products || productResponse.items || [];
  // Same "does this product have a usable recipe" check as getGoLiveReadiness's recipeCount
  // above, inverted — this is the raw products API response, not recipeService.js's
  // frontend-normalized `status` field, so it must check the same raw field names.
  const hasUsableRecipe = (product = {}) => {
    const recipe = product.recipe || product.recipeLines || product.recipe_lines;
    if (Array.isArray(recipe) && recipe.length > 0) return true;
    if (product.missingRecipe === false || product.missing_recipe === 0) return true;
    const status = String(product.recipeStatus || product.recipe_status || '').toLowerCase();
    return status === 'complete' || status === 'complete_via_linked_stock_item';
  };
  const missingRecipeCount = products.filter((product) => !hasUsableRecipe(product)).length;
  return {
    productCount: products.length,
    missingRecipeCount,
    supplierCount: (suppliers || []).length,
    stockItemCount: (stock.items || []).length
  };
}

// Silent, background-only save — bypasses saveSettingsDraft()/saveWorkspaceSettings() in main.js,
// which run VAT-number validation and show the global "Saving Settings" toast. Dismissing or
// stepping through the onboarding wizard must never surface that UI.
export async function saveOnboardingState(workspaceId, patch = {}) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  await callCloudflareWorkspaceRoute(workspaceKey, 'settings', {
    method: 'PATCH',
    payload: { settings: { onboarding: patch } }
  });
}

export async function getStockCategoryOptions(workspaceId) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'stock-items', {
    query: { limit: 500 }
  });
  const entries = response.stockItems || response.items || [];
  const categories = new Map();

  entries.forEach((item = {}) => {
    if (!isStockRoutingEligibleItem(item)) return;
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

export async function savePersonalSettings(workspaceId, draft = {}) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const normalized = normalizeSettings(draft);
  const preferences = Object.fromEntries(
    Object.entries(normalized).filter(([key]) => PERSONAL_SETTING_KEYS.has(key))
  );
  const response = await callCloudflareWorkspaceRoute(workspaceKey, 'user-preferences', {
    method: 'PATCH',
    payload: { preferences }
  });
  return normalizeSettings({ ...normalized, ...(response.preferences || preferences) });
}

export async function saveWorkspaceSettings(workspaceId, draft = {}, { includePersonal = false } = {}) {
  const workspaceKey = requireWorkspaceId(workspaceId);
  const nextSettings = normalizeSettings(draft);
  const workspaceSettings = {};
  const personalSettings = {};
  Object.entries(nextSettings).forEach(([key, value]) => {
    if (PERSONAL_SETTING_KEYS.has(key)) personalSettings[key] = value;
    else workspaceSettings[key] = value;
  });
  const workspaceResponse = await callCloudflareWorkspaceRoute(workspaceKey, 'settings', {
    method: 'PATCH',
    payload: { settings: workspaceSettings }
  });
  const personalResponse = includePersonal
    ? await callCloudflareWorkspaceRoute(workspaceKey, 'user-preferences', {
        method: 'PATCH',
        payload: { preferences: personalSettings }
      })
    : { preferences: personalSettings };
  const result = normalizeSettings({
    ...(workspaceResponse.settings || workspaceSettings),
    ...(personalResponse.preferences || personalSettings)
  });
  // Ephemeral, not part of the persisted settings shape — read once by the caller (e.g. to show
  // a "N items recalculated" confirmation) and must never be echoed back on a later save.
  if (workspaceResponse.vatRegistrationRecompute) {
    result.__vatRegistrationRecompute = workspaceResponse.vatRegistrationRecompute;
  }
  return result;
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
  const filename = buildExportFilename({ workspaceName: workspaceName || workspaceKey, reportType: 'Workspace Snapshot Export' });
  downloadFileBlob(new Blob([body], { type: 'application/json' }), `${filename}.json`);
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
  const legacyTradingTime = normalizeTime(source.tradingTime || source.tradingEndTime || '23:59');
  const reportingDayFromHour = normalizeHour(
    source.reportingDayFromHour
      ?? source.reportingFromHour
      ?? source.tradingDayStartHour
      ?? source.tradeDayStartHour
      ?? deriveStartHourFromTradingTime(legacyTradingTime),
    0
  );
  // A KCP reporting day is always a complete 24-hour period. Persist both UI values
  // as the same boundary so an invalid partial-day range can never reach reports.
  const reportingDayToHour = reportingDayFromHour;
  const tradingTime = legacyTradingTimeFromStartHour(reportingDayFromHour);
  const logoutTimeout = Math.max(1, Math.min(1440, parseInt(source.logoutTimeout ?? source.autoLogoutMinutes ?? 30, 10) || 30));
  const vatRate = clampNumber(source.vatRate ?? source.vatPercentage ?? 15, 0, 100, 15);
  // Defaults to true (VAT registered) so existing workspaces — which have always had VAT
  // calculated in reports/costing — see no behavior change until they explicitly toggle this off.
  const vatRegistered = !(source.vatRegistered === false || String(source.vatRegistered ?? '').toLowerCase() === 'false');
  const uiScale = String(source.uiScale || 'normal') === 'large' ? 'large' : 'normal';
  const costingMethod = String(source.costingMethod || 'last').toLowerCase() === 'wac' ? 'wac' : 'last';
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
  const stockDepletionEnabled = source.stockDepletionEnabled === true ||
    String(source.stockDepletionEnabled || '').toLowerCase() === 'true';
  const stockDepletionEnabledAtValue = String(source.stockDepletionEnabledAt || source.stock_depletion_enabled_at || '').trim();
  const stockDepletionEnabledAt = stockDepletionEnabled && Number.isFinite(Date.parse(stockDepletionEnabledAtValue))
    ? new Date(stockDepletionEnabledAtValue).toISOString()
    : '';
  const sourceOnboarding = source.onboarding && typeof source.onboarding === 'object' ? source.onboarding : {};
  const onboarding = {
    dismissed: sourceOnboarding.dismissed === true,
    completedAt: String(sourceOnboarding.completedAt || '').trim(),
    lastStep: String(sourceOnboarding.lastStep || '').trim()
  };

  return {
    ...source,
    vatRate,
    vatRegistered,
    siteName: String(source.siteName || '').trim(),
    orgId: String(source.orgId || source.org_id || '').trim(),
    corpId: String(source.corpId || source.corp_id || '').trim(),
    viewingOnly,
    linkedSiteCount: Number(source.linkedSiteCount ?? source.linked_site_count ?? 0) || 0,
    tradingTime,
    reportingDayFromHour,
    reportingDayToHour,
    tradingDayStartHour: reportingDayFromHour,
    tradingDayStartMinutes: reportingDayFromHour * 60,
    uiScale,
    logoutTimeout,
    costingMethod,
    yocoStoreLocationsAsStockLocations,
    yocoCategoryMap,
    stockCategoryRoutingMap,
    restaurantThemeId,
    restaurantBackgroundId,
    restaurantLogoDataUrl,
    restaurantLogoName,
    restaurantBackgroundDataUrl,
    restaurantBackgroundName,
    companyTaxInfo,
    stockDepletionEnabled,
    stockDepletionEnabledAt,
    onboarding
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

function normalizeHour(value, fallback = 0) {
  const match = String(value ?? '').trim().match(/^(\d{1,2})(?::\d{2})?$/);
  const number = match ? Number(match[1]) : Number(value);
  if (!Number.isFinite(number)) return Math.max(0, Math.min(23, Number(fallback) || 0));
  return Math.max(0, Math.min(23, Math.round(number)));
}

function legacyTradingTimeFromStartHour(startHour = 0) {
  const hour = normalizeHour(startHour, 0);
  const previousHour = (hour + 23) % 24;
  return `${String(previousHour).padStart(2, '0')}:59`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(String(value ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
