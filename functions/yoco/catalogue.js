const {
  createId,
  normalizeArray,
  normalizeObject,
  normalizeText,
  serverTimestampIso
} = require('./utils');
const {
  YocoApiError,
  listItemBrands,
  listItemCategories,
  listItems,
  listLocations
} = require('./client');
const { moneyToMajor } = require('./money');

async function syncYocoCatalogueData(admin, dataPath, apiKey) {
  const now = serverTimestampIso();
  const warnings = [];
  const categories = await fetchCatalogueResource('item categories', () => listItemCategories(apiKey), { optional: true, warnings });
  const brands = await fetchCatalogueResource('item brands', () => listItemBrands(apiKey), { optional: true, warnings });
  const yocoLocations = await fetchCatalogueResource('locations', () => listLocations(apiKey));
  const items = await fetchCatalogueResource('items', () => listItems(apiKey, { expand: ['category', 'brand'] }));

  const locationResult = await upsertYocoLocations(admin, dataPath, yocoLocations, now);
  const productResult = await upsertYocoProducts(admin, dataPath, {
    categories,
    brands,
    items,
    now
  });

  await admin.database().ref(`${dataPath}/integrations/yoco`).update({
    status: 'connected',
    connectionActive: true,
    syncState: 'idle',
    'catalogue/lastSyncedAt': now,
    'catalogue/itemsCount': productResult.productsCount,
    'catalogue/categoriesCount': categories.length,
    'catalogue/brandsCount': brands.length,
    'catalogue/missingRecipeCount': productResult.missingRecipeCount,
    'catalogue/warnings': warnings,
    'locations/lastSyncedAt': now,
    'locations/count': locationResult.locationsCount,
    updatedAt: now
  });

  return {
    locationsImported: locationResult.created,
    locationsMatched: locationResult.matched,
    productsImported: productResult.created,
    productsMatched: productResult.matched,
    productsArchived: productResult.archived,
    categoriesImported: categories.length,
    brandsStored: brands.length,
    missingRecipes: productResult.missingRecipeCount,
    warnings
  };
}

async function fetchCatalogueResource(label, loader, options = {}) {
  try {
    const rows = await loader();
    console.info(`[yocoCatalogue] ${label} synced`, { count: rows.length });
    return rows;
  } catch (error) {
    const request = error?.request?.path || error?.request?.url || '';
    console.error(`[yocoCatalogue] ${label} sync failed`, {
      status: error?.status || 0,
      code: error?.code || '',
      message: error?.message || String(error),
      request
    });
    if (options.optional && error instanceof YocoApiError && error.status === 404) {
      const warning = `${label} were not available from Yoco for this account.`;
      options.warnings?.push(warning);
      return [];
    }
    throw error;
  }
}

async function upsertYocoLocations(admin, dataPath, yocoLocations = [], now = serverTimestampIso()) {
  return upsertYocoSellingLocations(admin, dataPath, yocoLocations, now);
}

async function upsertYocoSellingLocations(admin, dataPath, yocoLocations = [], now = serverTimestampIso()) {
  const [locationsSnapshot, ingredientsSnapshot] = await Promise.all([
    admin.database().ref(`${dataPath}/locations`).get(),
    admin.database().ref(`${dataPath}/ingredients`).get()
  ]);
  const locations = normalizeArray(locationsSnapshot.val());
  const ingredients = normalizeArray(ingredientsSnapshot.val());
  const yocoRows = normalizeYocoLocationRows(yocoLocations);

  if (!yocoRows.length) {
    return {
      created: 0,
      matched: 0,
      removed: 0,
      locationsCount: locations.length,
      locations
    };
  }

  const stockByLocationId = calculateStockByLocationId(ingredients);
  const usedLocationIds = new Set();
  const locationRedirects = new Map();
  const nextLocations = [];
  let created = 0;
  let matched = 0;
  const yocoIds = new Set(yocoRows.map((row) => row.yocoId).filter(Boolean));
  const yocoNameKeys = new Set(yocoRows.map((row) => normalizeText(row.name)).filter(Boolean));

  yocoRows.forEach((row, rowIndex) => {
    const candidates = locations.filter((location) => {
      if (usedLocationIds.has(String(location.id || ''))) return false;
      return isLocationMatchForYocoRow(location, row);
    });
    const canonical = chooseCanonicalLocation(candidates, row, stockByLocationId);
    const canonicalId = String(canonical?.id || createStableYocoLocationId(row, rowIndex)).trim();

    if (canonical) {
      matched += 1;
      candidates.forEach((location) => {
        const locationId = String(location.id || '').trim();
        if (!locationId || locationId === canonicalId) return;
        locationRedirects.set(locationId, canonicalId);
      });
    } else {
      created += 1;
    }

    candidates.forEach((location) => {
      const locationId = String(location.id || '').trim();
      if (locationId) usedLocationIds.add(locationId);
    });

    const customName = resolvePreservedLocationCustomName(canonical, row);
    nextLocations.push({
      ...(canonical || {}),
      id: canonicalId,
      locationId: canonicalId,
      siteId: 'site_main',
      name: row.name,
      customName,
      displayName: customName || row.name,
      type: 'selling',
      code: String(canonical?.code || row.code || '').trim(),
      notes: String(canonical?.notes || '').trim(),
      source: 'yoco',
      yocoLocationId: row.yocoId,
      yocoStoreLocationId: row.yocoId,
      yocoLocationName: row.name,
      yocoAliases: mergeYocoAliases(canonical, row, candidates),
      active: row.active,
      archived: row.active ? false : true,
      isDefault: canonical?.isDefault === true || rowIndex === 0,
      createdAt: canonical?.createdAt || now,
      updatedAt: now
    });
  });

  const canonicalIds = new Set(nextLocations.map((location) => String(location.id || '')).filter(Boolean));
  locations.forEach((location) => {
    const locationId = String(location.id || '').trim();
    if (!locationId || usedLocationIds.has(locationId) || canonicalIds.has(locationId)) return;
    if (shouldRemoveLocationDuringYocoSync(location, yocoIds, yocoNameKeys)) {
      const fallbackId = chooseFallbackLocationId(nextLocations, location);
      if (fallbackId) locationRedirects.set(locationId, fallbackId);
    }
  });

  const nextIngredients = locationRedirects.size
    ? remapIngredientBalances(ingredients, locationRedirects)
    : ingredients;

  await admin.database().ref(dataPath).update({
    locations: nextLocations,
    ingredients: nextIngredients,
    'settings/stockLocationsInitialized': true,
    'settings/siteLocationModel': 'selling_locations',
    'settings/yocoStoreLocationsAsStockLocations': false
  });

  return {
    created,
    matched,
    removed: locationRedirects.size,
    locationsCount: nextLocations.length,
    locations: nextLocations
  };
}

function normalizeYocoLocationRows(yocoLocations = []) {
  const seen = new Set();
  return normalizeArray(yocoLocations)
    .map((location) => {
      const yocoId = getYocoLocationId(location);
      const name = String(
        location.name ||
        location.display_name ||
        location.displayName ||
        location.business_name ||
        location.businessName ||
        yocoId ||
        'Yoco Location'
      ).trim();
      return {
        yocoId,
        name,
        code: String(location.code || location.short_code || location.shortCode || '').trim(),
        active: location.active !== false && location.archived !== true && String(location.status || 'active').toLowerCase() !== 'archived'
      };
    })
    .filter((row) => row.yocoId || row.name)
    .filter((row) => {
      const key = row.yocoId ? `id:${row.yocoId}` : `name:${normalizeText(row.name)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getYocoLocationId(location = {}) {
  return String(
    location.id ||
    location.location_id ||
    location.locationId ||
    location.uuid ||
    location.uid ||
    location._id ||
    ''
  ).trim();
}

function isLocationMatchForYocoRow(location = {}, row = {}) {
  const yocoTokens = getLocationYocoTokens(location);
  if (row.yocoId && yocoTokens.has(normalizeText(row.yocoId))) return true;
  return [
    location.name,
    location.displayName,
    location.yocoLocationName
  ].some((value) => normalizeText(value) === normalizeText(row.name));
}

function resolvePreservedLocationCustomName(canonical = {}, row = {}) {
  if (!canonical) return '';
  const yocoNameKey = normalizeText(row.name || canonical.yocoLocationName || '');
  const explicitCustom = String(canonical.customName || canonical.aliasName || '').trim();
  if (explicitCustom && normalizeText(explicitCustom) !== yocoNameKey) return explicitCustom;

  const displayName = String(canonical.displayName || '').trim();
  if (displayName && normalizeText(displayName) !== yocoNameKey) return displayName;

  const name = String(canonical.name || '').trim();
  if (name && normalizeText(name) !== yocoNameKey && getLocationYocoTokens(canonical).size) return name;
  return '';
}

function getLocationYocoTokens(location = {}) {
  return new Set([
    location.yocoLocationId,
    location.yocoStoreLocationId,
    location.yocoLocationName,
    location.externalLocationId,
    location.externalId,
    ...(Array.isArray(location.yocoAliases) ? location.yocoAliases : [])
  ].map((value) => normalizeText(value)).filter(Boolean));
}

function chooseCanonicalLocation(candidates = [], row = {}, stockByLocationId = new Map()) {
  if (!candidates.length) return null;
  return [...candidates].sort((left, right) => {
    const leftScore = getLocationMatchScore(left, row, stockByLocationId);
    const rightScore = getLocationMatchScore(right, row, stockByLocationId);
    return rightScore - leftScore;
  })[0];
}

function getLocationMatchScore(location = {}, row = {}, stockByLocationId = new Map()) {
  const yocoTokens = getLocationYocoTokens(location);
  const locationId = String(location.id || '').trim();
  let score = 0;
  if (row.yocoId && yocoTokens.has(normalizeText(row.yocoId))) score += 100000;
  if (normalizeText(location.name || '') === normalizeText(row.name)) score += 10000;
  if (String(location.source || '').toLowerCase() === 'yoco') score += 1000;
  if (location.isDefault === true) score += 100;
  score += Math.min(99, Math.round(Number(stockByLocationId.get(locationId) || 0) || 0));
  return score;
}

function createStableYocoLocationId(row = {}, index = 0) {
  const seed = normalizeText(row.yocoId || row.name || `location ${index + 1}`).replace(/\s+/g, '_');
  return `loc_yoco_${seed || index + 1}`;
}

function mergeYocoAliases(canonical = {}, row = {}, candidates = []) {
  return [...new Set([
    row.yocoId,
    row.name,
    canonical?.name,
    canonical?.displayName,
    canonical?.yocoLocationId,
    canonical?.yocoStoreLocationId,
    ...(Array.isArray(canonical?.yocoAliases) ? canonical.yocoAliases : []),
    ...candidates.flatMap((candidate) => [
      candidate.name,
      candidate.displayName,
      candidate.yocoLocationId,
      candidate.yocoStoreLocationId,
      ...(Array.isArray(candidate.yocoAliases) ? candidate.yocoAliases : [])
    ])
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

function shouldRemoveLocationDuringYocoSync(location = {}, yocoIds = new Set(), yocoNameKeys = new Set()) {
  const source = String(location.source || '').toLowerCase();
  const yocoTokens = getLocationYocoTokens(location);
  const nameKey = normalizeText(location.name || location.displayName || '');
  if (source === 'yoco') return true;
  if ([...yocoTokens].some((token) => yocoIds.has(token))) return true;
  if (yocoNameKeys.has(nameKey)) return true;
  if (String(location.id || '') === 'main' && source === 'migration') return true;
  return false;
}

function chooseFallbackLocationId(nextLocations = [], removedLocation = {}) {
  const removedNameKey = normalizeText(removedLocation.name || removedLocation.displayName || '');
  return String(
    nextLocations.find((location) => normalizeText(location.name || '') === removedNameKey)?.id ||
    nextLocations.find((location) => location.isDefault === true)?.id ||
    nextLocations[0]?.id ||
    ''
  ).trim();
}

function calculateStockByLocationId(ingredients = []) {
  const totals = new Map();
  ingredients.forEach((ingredient) => {
    const balances = ingredient?.balances && typeof ingredient.balances === 'object' ? ingredient.balances : {};
    Object.entries(balances).forEach(([locationId, qty]) => {
      const id = String(locationId || '').trim();
      if (!id) return;
      totals.set(id, Number(totals.get(id) || 0) + Math.abs(Number(qty || 0) || 0));
    });
  });
  return totals;
}

function remapIngredientBalances(ingredients = [], locationRedirects = new Map()) {
  return ingredients.map((ingredient) => {
    const balances = ingredient?.balances && typeof ingredient.balances === 'object' ? ingredient.balances : {};
    const nextBalances = {};
    Object.entries(balances).forEach(([locationId, qty]) => {
      const sourceId = String(locationId || '').trim();
      const targetId = String(locationRedirects.get(sourceId) || sourceId).trim();
      if (!targetId) return;
      nextBalances[targetId] = Number(nextBalances[targetId] || 0) + (Number(qty || 0) || 0);
    });
    return {
      ...ingredient,
      balances: nextBalances,
      stock: Object.values(nextBalances).reduce((sum, qty) => sum + (Number(qty || 0) || 0), 0)
    };
  });
}

async function upsertYocoSites(admin, dataPath, yocoLocations = [], now = serverTimestampIso()) {
  const [sitesSnapshot, locationsSnapshot] = await Promise.all([
    admin.database().ref(`${dataPath}/sites`).get(),
    admin.database().ref(`${dataPath}/locations`).get()
  ]);
  const sites = normalizeArray(sitesSnapshot.val());
  const nextSites = [...sites];
  const nextLocations = normalizeArray(locationsSnapshot.val());
  let created = 0;
  let matched = 0;

  yocoLocations.forEach((yocoLocation) => {
    const yocoId = String(yocoLocation.id || yocoLocation.location_id || '').trim();
    const name = String(yocoLocation.name || yocoLocation.display_name || yocoId || 'Yoco Store').trim();
    if (!yocoId && !name) return;

    const normalizedName = normalizeText(name);
    let index = nextSites.findIndex((site) => String(site.yocoLocationId || '') === yocoId);
    if (index < 0) {
      index = nextSites.findIndex((site) => normalizeText(site.name) === normalizedName);
    }

    let siteId = '';
    let shouldInitializeStockLocation = false;
    if (index >= 0) {
      matched += 1;
      siteId = String(nextSites[index].id || nextSites[index].siteId || createId('site'));
      shouldInitializeStockLocation = nextSites[index].stockLocationInitialized !== true;
      nextSites[index] = {
        ...nextSites[index],
        id: siteId,
        siteId,
        name: nextSites[index].name || name,
        yocoLocationId: yocoId || nextSites[index].yocoLocationId || '',
        source: nextSites[index].source || 'yoco',
        stockLocationInitialized: true,
        active: nextSites[index].active !== false,
        updatedAt: now
      };
    } else {
      created += 1;
      siteId = createId('site');
      nextSites.push({
        id: siteId,
        siteId,
        name,
        code: '',
        address: '',
        notes: '',
        yocoLocationId: yocoId,
        source: 'yoco',
        stockLocationInitialized: true,
        active: true,
        isDefault: nextSites.length === 0,
        createdAt: now,
        updatedAt: now
      });
      shouldInitializeStockLocation = true;
    }

    const legacyStockIndex = nextLocations.findIndex((location) => (
      String(location.yocoLocationId || location.yocoStoreLocationId || '') === yocoId ||
      (String(location.source || '').toLowerCase() === 'yoco' && normalizeText(location.name) === normalizedName)
    ));
    if (legacyStockIndex >= 0) {
      const stockLocation = nextLocations[legacyStockIndex];
      nextLocations[legacyStockIndex] = {
        ...stockLocation,
        siteId,
        name: normalizeText(stockLocation.name) === normalizedName ? 'Main Stock' : stockLocation.name,
        type: stockLocation.type || 'storage',
        notes: stockLocation.notes || 'Default stock location for this Yoco store.',
        source: stockLocation.source === 'yoco' ? 'system' : stockLocation.source || 'system',
        yocoStoreLocationId: yocoId || stockLocation.yocoStoreLocationId || '',
        active: stockLocation.active !== false,
        updatedAt: now
      };
      return;
    }

    const hasStockLocation = nextLocations.some((location) => String(location.siteId || '') === siteId);
    if (!hasStockLocation && shouldInitializeStockLocation) {
      nextLocations.push({
        id: createId('loc'),
        siteId,
        name: 'Main Stock',
        type: 'storage',
        notes: 'Default stock location for this Yoco store.',
        source: 'system',
        isDefault: true,
        active: true,
        createdAt: now,
        updatedAt: now
      });
    }
  });

  await Promise.all([
    admin.database().ref(`${dataPath}/sites`).set(nextSites),
    admin.database().ref(`${dataPath}/locations`).set(nextLocations)
  ]);
  return {
    created,
    matched,
    locationsCount: nextSites.length,
    locations: nextSites
  };
}

async function upsertYocoProducts(admin, dataPath, { categories = [], brands = [], items = [], now = serverTimestampIso() } = {}) {
  const ref = admin.database().ref(`${dataPath}/products`);
  const [snapshot, settingsSnapshot] = await Promise.all([
    ref.get(),
    admin.database().ref(`${dataPath}/settings`).get()
  ]);
  const settings = settingsSnapshot.val() || {};
  const productObject = normalizeObject(snapshot.val());
  const products = Object.entries(productObject).map(([key, product]) => ({ id: String(product?.id || key), ...product }));
  const categoryMap = buildLookupMap(categories, getCategoryLookupIds);
  const brandMap = buildLookupMap(brands, getBrandLookupIds);
  const rows = flattenYocoItems(items, categoryMap, brandMap, settings.yocoCategoryMap || {});
  let created = 0;
  let matched = 0;
  let archived = 0;

  rows.forEach((row) => {
    const index = findProductIndex(products, row);
    if (index >= 0) {
      matched += 1;
      products[index] = mergeProduct(products[index], row, now);
      return;
    }
    created += 1;
    products.push(createProduct(row, now));
  });

  const currentYocoKeys = new Set(rows.flatMap(getYocoPresenceKeys));
  products.forEach((product, index) => {
    if (!isYocoProduct(product)) return;
    if (isProductPresentInYoco(product, currentYocoKeys)) return;
    if (isArchivedProduct(product)) return;
    archived += 1;
    products[index] = archiveProduct(product, now);
  });

  const nextProducts = {};
  products.forEach((product) => {
    nextProducts[String(product.id || createId('prod'))] = product;
  });
  await ref.set(nextProducts);

  const activeProducts = products.filter((product) => !isArchivedProduct(product));
  const missingRecipeCount = activeProducts.filter((product) => String(product.source || '').toLowerCase() === 'yoco' && !normalizeArray(product.recipe).length).length;
  return {
    created,
    matched,
    archived,
    productsCount: activeProducts.length,
    missingRecipeCount,
    products
  };
}

function flattenYocoItems(items = [], categoryMap = new Map(), brandMap = new Map(), yocoCategoryMap = {}) {
  const routingMap = normalizeYocoCategoryRoutingMap(yocoCategoryMap);
  return items.flatMap((item) => {
    const itemId = String(item.id || item.item_id || '').trim();
    const variants = normalizeVariants(item);
    const itemCategory = resolveCategory(item, {}, categoryMap);
    const itemBrand = resolveBrand(item, {}, brandMap);
    const itemName = String(item.name || item.display_name || 'Yoco Item').trim();
    const realVariantCount = variants.filter((variant) => variant.__kcpSyntheticVariant !== true).length;
    const variantEnabled = item.variant_enabled === true ||
      item.variantEnabled === true ||
      item.has_variants === true ||
      item.hasVariants === true ||
      item.has_multiple_variants === true ||
      item.hasMultipleVariants === true;
    const hasMultipleVariants = realVariantCount > 1;

    return variants.map((variant) => {
      const category = resolveCategory(item, variant, categoryMap) || itemCategory;
      const brand = resolveBrand(item, variant, brandMap) || itemBrand;
      const variantId = String(variant.id || variant.variant_id || '').trim();
      const variantName = variant.__kcpSyntheticVariant ? '' : getVariantDisplayName(variant, item);
      const name = variantName && normalizeText(variantName) !== normalizeText(itemName)
        ? `${itemName} - ${variantName}`
        : itemName;
      return {
        yocoItemId: itemId,
        yocoVariantId: variantId,
        yocoItemName: itemName,
        yocoVariantName: variantName,
        yocoOptionSummary: variantName,
        yocoHasMultipleVariants: hasMultipleVariants,
        yocoVariantEnabled: variantEnabled,
        yocoVariantCount: realVariantCount,
        name,
        category: category.name || 'Uncategorised',
        routingLabel: resolveMappedRoutingLabel(routingMap, category) || category.name || 'Uncategorised',
        kcpRoutingLabel: resolveMappedRoutingLabel(routingMap, category) || category.name || 'Uncategorised',
        yocoCategoryId: category.id || '',
        yocoCategoryName: category.name || '',
        yocoBrandId: brand.id || '',
        yocoBrandName: brand.name || '',
        sellingPrice: getVariantPrice(variant, item),
        sku: variant.sku || item.sku || '',
        barcode: variant.barcode || item.barcode || ''
      };
    });
  });
}

function buildLookupMap(rows = [], idResolver) {
  const map = new Map();
  rows.forEach((row) => {
    idResolver(row).forEach((id) => {
      const key = String(id || '').trim();
      if (key) map.set(key, row);
    });
  });
  return map;
}

function normalizeYocoCategoryRoutingMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).reduce((map, [key, entry]) => {
    const rawKey = String(key || '').trim();
    const label = normalizeRoutingLabel(
      entry && typeof entry === 'object'
        ? entry.routingLabel || entry.kcpRoutingLabel || entry.label || entry.name || ''
        : entry
    );
    if (!rawKey || !label) return map;
    map[rawKey] = label;
    map[normalizeText(rawKey)] = label;
    return map;
  }, {});
}

function resolveMappedRoutingLabel(routingMap = {}, category = {}) {
  const keys = getCategoryLookupIds(category).concat([
    category.id,
    category.name,
    category.display_name,
    category.displayName
  ]);
  for (const key of keys) {
    const raw = String(key || '').trim();
    if (raw && routingMap[raw]) return routingMap[raw];
    const normalized = normalizeText(raw);
    if (normalized && routingMap[normalized]) return routingMap[normalized];
  }
  return '';
}

function normalizeRoutingLabel(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function resolveCategory(item = {}, variant = {}, categoryMap = new Map()) {
  const ids = getCategoryIds(variant).concat(getCategoryIds(item));
  const direct = [
    variant.category,
    variant.item_category,
    variant.itemCategory,
    variant.categories,
    variant.item_categories,
    variant.itemCategories,
    item.category,
    item.item_category,
    item.itemCategory,
    item.categories,
    item.item_categories,
    item.itemCategories
  ].flatMap((entry) => Array.isArray(entry) ? entry : [entry])
    .find((entry) => entry && typeof entry === 'object') || {};
  const matchedCategory = ids.map((id) => categoryMap.get(String(id || '').trim())).find(Boolean);
  const category = matchedCategory || direct;
  return {
    id: String(
      matchedCategory
        ? getCategoryLookupIds(matchedCategory)[0]
        : (ids.find(Boolean) || getCategoryLookupIds(category)[0] || '')
    ).trim(),
    name: normalizeCategoryName(
      category.name ||
      category.display_name ||
      category.displayName ||
      category.title ||
      category.label ||
      (typeof variant.category === 'string' ? variant.category : '') ||
      (typeof variant.item_category === 'string' ? variant.item_category : '') ||
      (typeof variant.itemCategory === 'string' ? variant.itemCategory : '') ||
      variant.category_name ||
      variant.categoryName ||
      variant.item_category_name ||
      variant.itemCategoryName ||
      (typeof item.category === 'string' ? item.category : '') ||
      (typeof item.item_category === 'string' ? item.item_category : '') ||
      (typeof item.itemCategory === 'string' ? item.itemCategory : '') ||
      item.category_name ||
      item.categoryName ||
      item.item_category_name ||
      item.itemCategoryName ||
      ''
    )
  };
}

function resolveBrand(item = {}, variant = {}, brandMap = new Map()) {
  const ids = getBrandIds(variant).concat(getBrandIds(item));
  const direct = [
    variant.brand,
    variant.item_brand,
    variant.itemBrand,
    variant.brands,
    variant.item_brands,
    variant.itemBrands,
    item.brand,
    item.item_brand,
    item.itemBrand,
    item.brands,
    item.item_brands,
    item.itemBrands
  ].flatMap((entry) => Array.isArray(entry) ? entry : [entry])
    .find((entry) => entry && typeof entry === 'object') || {};
  const matchedBrand = ids.map((id) => brandMap.get(String(id || '').trim())).find(Boolean);
  const brand = matchedBrand || direct;
  return {
    id: String(
      matchedBrand
        ? getBrandLookupIds(matchedBrand)[0]
        : (ids.find(Boolean) || getBrandLookupIds(brand)[0] || '')
    ).trim(),
    name: String(
      brand.name ||
      brand.display_name ||
      brand.displayName ||
      brand.title ||
      brand.label ||
      (typeof variant.brand === 'string' ? variant.brand : '') ||
      (typeof variant.item_brand === 'string' ? variant.item_brand : '') ||
      (typeof variant.itemBrand === 'string' ? variant.itemBrand : '') ||
      variant.brand_name ||
      variant.brandName ||
      (typeof item.brand === 'string' ? item.brand : '') ||
      (typeof item.item_brand === 'string' ? item.item_brand : '') ||
      (typeof item.itemBrand === 'string' ? item.itemBrand : '') ||
      item.brand_name ||
      item.brandName ||
      ''
    ).trim()
  };
}

function getCategoryIds(source = {}) {
  return extractIds([
    source.category_id,
    source.categoryId,
    source.category_uuid,
    source.categoryUuid,
    source.item_category_id,
    source.itemCategoryId,
    source.item_category_uuid,
    source.itemCategoryUuid,
    source.category?.id,
    source.category?.uuid,
    source.category?.uid,
    source.item_category?.id,
    source.item_category?.uuid,
    source.item_category?.uid,
    source.itemCategory?.id,
    source.itemCategory?.uuid,
    source.itemCategory?.uid,
    source.categories,
    source.item_categories,
    source.itemCategories,
    ...(Array.isArray(source.category_ids) ? source.category_ids : []),
    ...(Array.isArray(source.categoryIds) ? source.categoryIds : []),
    ...(Array.isArray(source.item_category_ids) ? source.item_category_ids : []),
    ...(Array.isArray(source.itemCategoryIds) ? source.itemCategoryIds : [])
  ]);
}

function getBrandIds(source = {}) {
  return extractIds([
    source.brand_id,
    source.brandId,
    source.brand_uuid,
    source.brandUuid,
    source.item_brand_id,
    source.itemBrandId,
    source.item_brand_uuid,
    source.itemBrandUuid,
    source.brand?.id,
    source.brand?.uuid,
    source.brand?.uid,
    source.item_brand?.id,
    source.item_brand?.uuid,
    source.item_brand?.uid,
    source.itemBrand?.id,
    source.itemBrand?.uuid,
    source.itemBrand?.uid,
    source.brands,
    source.item_brands,
    source.itemBrands
  ]);
}

function getCategoryLookupIds(source = {}) {
  return extractIds([
    source.id,
    source.uuid,
    source.uid,
    source._id,
    ...getCategoryIds(source)
  ]);
}

function getBrandLookupIds(source = {}) {
  return extractIds([
    source.id,
    source.uuid,
    source.uid,
    source._id,
    ...getBrandIds(source)
  ]);
}

function extractIds(values = []) {
  return values.flatMap((value) => {
    if (Array.isArray(value)) return extractIds(value);
    if (value && typeof value === 'object') {
      return [
        value.id,
        value.uuid,
        value.uid,
        value._id,
        value.category_id,
        value.categoryId,
        value.item_category_id,
        value.itemCategoryId,
        value.brand_id,
        value.brandId,
        value.item_brand_id,
        value.itemBrandId
      ];
    }
    return [value];
  }).map((value) => String(value || '').trim()).filter(Boolean);
}

function normalizeCategoryName(value = '') {
  const name = String(value || '').trim();
  return name || 'Uncategorised';
}

function normalizeVariants(item = {}) {
  const variants = item.variants || item.item_variants || item.variations || [];
  if (Array.isArray(variants) && variants.length) {
    return variants.map((variant) => ({
      ...variant,
      __kcpSyntheticVariant: false
    }));
  }
  if (variants && typeof variants === 'object' && Object.keys(variants).length) {
    return Object.values(variants).map((variant) => ({
      ...variant,
      __kcpSyntheticVariant: false
    }));
  }
  return [{
    ...item,
    id: '',
    variant_id: '',
    price: item.default_price || item.price || item.unit_price || item.selling_price || 0,
    selected_options: [],
    __kcpSyntheticVariant: true
  }];
}

function getVariantDisplayName(variant = {}, item = {}) {
  const selectedOptions = normalizeSelectedOptions(variant.selected_options || variant.selectedOptions || variant.options || variant.option_values || variant.optionValues);
  if (selectedOptions.length) {
    return selectedOptions.map((option) => option.value || option.name).filter(Boolean).join(' / ');
  }

  const explicitName = String(
    variant.name ||
    variant.display_name ||
    variant.displayName ||
    variant.variant_name ||
    variant.variantName ||
    variant.option_name ||
    variant.optionName ||
    ''
  ).trim();
  if (explicitName) return explicitName;

  return '';
}

function normalizeSelectedOptions(value = []) {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value).map(([name, optionValue]) => (
        optionValue && typeof optionValue === 'object'
          ? { name, ...optionValue }
          : { name, value: optionValue }
      ))
      : [];

  return rows.map((option) => ({
    name: String(option?.name || option?.option_name || option?.optionName || '').trim(),
    value: String(option?.value || option?.display_value || option?.displayValue || option?.label || option?.name || '').trim()
  })).filter((option) => option.value);
}

function getVariantPrice(variant = {}, item = {}) {
  return moneyToMajor(
    variant.price ||
    variant.unit_price ||
    variant.selling_price ||
    variant.default_price ||
    item.default_price ||
    item.price ||
    item.unit_price ||
    item.selling_price ||
    0
  );
}

function findProductIndex(products = [], row = {}) {
  const variantId = String(row.yocoVariantId || '').trim();
  const itemId = String(row.yocoItemId || '').trim();
  const sku = normalizeText(row.sku || row.barcode || '');
  const name = normalizeText(row.name);

  if (variantId) {
    const byVariant = products.findIndex((product) => String(product.yocoVariantId || '') === variantId);
    if (byVariant >= 0) return byVariant;
  }
  if (itemId) {
    const byItem = products.findIndex((product) => String(product.yocoItemId || '') === itemId && !String(product.yocoVariantId || ''));
    if (byItem >= 0) return byItem;
  }
  if (variantId) return -1;
  if (sku) {
    const bySku = products.findIndex((product) => normalizeText(product.sku || product.barcode || '') === sku);
    if (bySku >= 0) return bySku;
  }
  return products.findIndex((product) => normalizeText(product.name) === name);
}

function mergeProduct(existing = {}, row = {}, now = serverTimestampIso()) {
  const hasRecipe = normalizeArray(existing.recipe).length > 0;
  const nextCategory = isMeaningfulCategory(row.category) ? row.category : existing.category || 'Uncategorised';
  const yocoPrice = Number(row.sellingPrice || 0) || 0;
  const yocoOwned = isYocoProduct(existing) || String(existing.source || '').toLowerCase() === 'yoco';
  const shouldPromoteVariantName = row.yocoVariantId &&
    !existing.yocoVariantId &&
    normalizeText(existing.name) === normalizeText(row.yocoItemName || row.name);
  return {
    ...existing,
    name: shouldPromoteVariantName || yocoOwned ? row.name : existing.name || row.name,
    category: nextCategory,
    routingLabel: row.routingLabel || existing.routingLabel || nextCategory,
    kcpRoutingLabel: row.kcpRoutingLabel || row.routingLabel || existing.kcpRoutingLabel || existing.routingLabel || nextCategory,
    sellingPrice: yocoPrice || Number(existing.sellingPrice ?? existing.price ?? 0) || 0,
    yocoSellingPrice: yocoPrice,
    yocoItemId: row.yocoItemId || existing.yocoItemId || '',
    yocoVariantId: row.yocoVariantId || existing.yocoVariantId || '',
    yocoItemName: row.yocoItemName || existing.yocoItemName || '',
    yocoVariantName: row.yocoVariantName || existing.yocoVariantName || '',
    yocoOptionSummary: row.yocoOptionSummary || existing.yocoOptionSummary || '',
    yocoHasMultipleVariants: row.yocoHasMultipleVariants === true,
    yocoVariantEnabled: row.yocoVariantEnabled === true,
    yocoVariantCount: Number(row.yocoVariantCount || 0) || 0,
    yocoCategoryId: row.yocoCategoryId || existing.yocoCategoryId || '',
    yocoCategoryName: row.yocoCategoryName || existing.yocoCategoryName || '',
    yocoBrandId: row.yocoBrandId || existing.yocoBrandId || '',
    yocoBrandName: row.yocoBrandName || existing.yocoBrandName || '',
    sku: yocoOwned ? row.sku || existing.sku || '' : existing.sku || row.sku || '',
    barcode: yocoOwned ? row.barcode || existing.barcode || '' : existing.barcode || row.barcode || '',
    recipe: hasRecipe ? existing.recipe : existing.recipe || [],
    source: existing.source || 'yoco',
    active: true,
    archived: false,
    deleted: false,
    catalogueStatus: 'active',
    archivedAt: null,
    archiveReason: null,
    updatedAt: now
  };
}

function createProduct(row = {}, now = serverTimestampIso()) {
  const id = createId('prod');
  return {
    id,
    name: row.name || 'Yoco Item',
    category: isMeaningfulCategory(row.category) ? row.category : 'Uncategorised',
    routingLabel: row.routingLabel || row.category || 'Uncategorised',
    kcpRoutingLabel: row.kcpRoutingLabel || row.routingLabel || row.category || 'Uncategorised',
    sellingPrice: Number(row.sellingPrice || 0) || 0,
    yocoSellingPrice: Number(row.sellingPrice || 0) || 0,
    yocoItemId: row.yocoItemId || '',
    yocoVariantId: row.yocoVariantId || '',
    yocoItemName: row.yocoItemName || '',
    yocoVariantName: row.yocoVariantName || '',
    yocoOptionSummary: row.yocoOptionSummary || '',
    yocoHasMultipleVariants: row.yocoHasMultipleVariants === true,
    yocoVariantEnabled: row.yocoVariantEnabled === true,
    yocoVariantCount: Number(row.yocoVariantCount || 0) || 0,
    yocoCategoryId: row.yocoCategoryId || '',
    yocoCategoryName: row.yocoCategoryName || '',
    yocoBrandId: row.yocoBrandId || '',
    yocoBrandName: row.yocoBrandName || '',
    sku: row.sku || '',
    barcode: row.barcode || '',
    source: 'yoco',
    active: true,
    archived: false,
    deleted: false,
    catalogueStatus: 'active',
    recipe: [],
    createdAt: now,
    updatedAt: now
  };
}

function getYocoPresenceKeys(row = {}) {
  const keys = [];
  if (row.yocoItemId) keys.push(`item:${row.yocoItemId}`);
  if (row.yocoVariantId) keys.push(`variant:${row.yocoVariantId}`);
  return keys;
}

function isProductPresentInYoco(product = {}, currentYocoKeys = new Set()) {
  const variantId = String(product.yocoVariantId || '').trim();
  const itemId = String(product.yocoItemId || '').trim();
  if (variantId) return currentYocoKeys.has(`variant:${variantId}`);
  if (itemId) return currentYocoKeys.has(`item:${itemId}`);
  return true;
}

function isYocoProduct(product = {}) {
  return String(product.source || '').toLowerCase() === 'yoco' ||
    Boolean(product.yocoItemId || product.yocoVariantId);
}

function isArchivedProduct(product = {}) {
  return product.archived === true ||
    product.deleted === true ||
    product.active === false ||
    String(product.catalogueStatus || '').toLowerCase() === 'archived';
}

function archiveProduct(product = {}, now = serverTimestampIso()) {
  return {
    ...product,
    active: false,
    archived: true,
    deleted: true,
    catalogueStatus: 'archived',
    archivedAt: product.archivedAt || now,
    archiveReason: product.archiveReason || 'missing_from_yoco_sync',
    updatedAt: now
  };
}

function isMeaningfulCategory(value = '') {
  const category = normalizeText(value);
  return Boolean(category) && category !== 'uncategorised' && category !== 'uncategorized';
}

module.exports = {
  flattenYocoItems,
  syncYocoCatalogueData,
  upsertYocoLocations,
  upsertYocoProducts
};
