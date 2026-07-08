const { fetchOrder, listOrders, listRefunds } = require('./client');
const { moneyToMajor } = require('./money');
const {
  createId,
  hashSignature,
  normalizeArray,
  normalizeObject,
  normalizeText,
  parseQuantity,
  serverTimestampIso,
  todayFromIso
} = require('./utils');

const DEFAULT_SITE_ID = 'site_main';
const DEFAULT_STOCK_LOCATION_ID = 'main';
const DEFAULT_STOCK_LOCATION_NAME = 'Main Store';

async function syncYocoSalesData(admin, dataPath, apiKey) {
  const now = serverTimestampIso();
  await admin.database().ref(`${dataPath}/integrations/yoco`).update({
    status: 'connected',
    connectionActive: true,
    syncState: 'syncing_sales',
    lastSyncStartedAt: now,
    lastError: ''
  });

  const lowerBound = await resolveLastKnownYocoSaleDate(admin, dataPath);
  const params = {
    status: ['completed'],
    updated_at__lte: now
  };
  if (lowerBound) params.updated_at__gte = lowerBound;

  const orders = await listOrders(apiKey, params);
  const refunds = await listRefunds(apiKey, lowerBound ? {
    status: ['approved'],
    updated_at__gte: lowerBound,
    updated_at__lte: now
  } : { status: ['approved'], updated_at__lte: now });

  const summary = {
    ordersProcessed: 0,
    refundsProcessed: 0,
    skippedDuplicates: 0,
    missingRecipes: 0,
    errors: []
  };

  for (const order of orders) {
    try {
      const result = await processYocoOrder(admin, dataPath, order, { mode: 'sale' });
      summary.ordersProcessed += result.processed ? 1 : 0;
      summary.skippedDuplicates += result.skippedDuplicates || 0;
      summary.missingRecipes += result.missingRecipes || 0;
    } catch (error) {
      summary.errors.push(error.message);
      await writeSalesError(admin, dataPath, 'yoco_sync_failed', error.message, { orderId: order.id });
    }
  }

  for (const refund of refunds) {
    try {
      const orderId = refund.original_order_id || refund.order_id;
      if (!orderId) {
        await writeSalesError(admin, dataPath, 'yoco_refund_order_missing', 'Yoco refund does not include an order id.', { refundId: refund.id });
        continue;
      }
      const order = await fetchOrder(apiKey, orderId);
      const result = await processYocoOrder(admin, dataPath, order, { mode: 'refund', refund });
      summary.refundsProcessed += result.processed ? 1 : 0;
      summary.skippedDuplicates += result.skippedDuplicates || 0;
      summary.missingRecipes += result.missingRecipes || 0;
    } catch (error) {
      summary.errors.push(error.message);
      await writeSalesError(admin, dataPath, 'yoco_sync_failed', error.message, { refundId: refund.id });
    }
  }

  await admin.database().ref(`${dataPath}/integrations/yoco`).update({
    status: 'connected',
    connectionActive: true,
    syncState: 'idle',
    health: summary.errors.length ? 'attention' : 'healthy',
    lastSyncCompletedAt: serverTimestampIso(),
    lastSuccessfulOrderUpdatedAt: maxIso(orders.map((order) => order.updated_at || order.closed_at || order.created_at)) || lowerBound || now,
    lastSuccessfulRefundUpdatedAt: maxIso(refunds.map((refund) => refund.updated_at || refund.processed_at || refund.created_at)) || lowerBound || now,
    lastError: summary.errors[0] || ''
  });

  return summary;
}

async function processYocoOrder(admin, dataPath, order = {}, options = {}) {
  const mode = options.mode || 'sale';
  const refund = options.refund || null;
  const now = serverTimestampIso();
  const orderId = String(order.id || refund?.order_id || refund?.original_order_id || '').trim();
  if (!orderId) throw new Error('Yoco order id is missing.');
  if (mode === 'sale' && String(order.status || '').toLowerCase() !== 'completed') {
    return { processed: false, skippedDuplicates: 0, missingRecipes: 0 };
  }

  const lineItems = mode === 'refund'
    ? getRefundLineItems(order, refund)
    : getOrderLineItems(order);
  if (!lineItems.length) {
    if (mode === 'refund') {
      await writeSalesError(admin, dataPath, 'yoco_refund_lines_missing', 'Yoco refund could not be matched to returned line items, so no stock was restored.', {
        orderId,
        refundId: refund?.id || '',
        paymentId: refund?.payment_id || ''
      });
    }
    return { processed: false, skippedDuplicates: 0, missingRecipes: 0 };
  }

  let result = { processed: false, skippedDuplicates: 0, missingRecipes: 0 };
  const dataRef = admin.database().ref(dataPath);
  const [settingsSnapshot, locationsSnapshot, sitesSnapshot, productsSnapshot, logsSalesSnapshot, processedSnapshot] = await Promise.all([
    dataRef.child('settings').get(),
    dataRef.child('locations').get(),
    dataRef.child('sites').get(),
    dataRef.child('products').get(),
    dataRef.child('logs_sales').get(),
    dataRef.child('processedSalesSignatures/yoco').get()
  ]);
  const settings = settingsSnapshot.val() || {};
  const locations = normalizeArray(locationsSnapshot.val());
  const sites = normalizeArray(sitesSnapshot.val());
  const productsObject = normalizeObject(productsSnapshot.val());
  const products = Object.entries(productsObject).map(([key, product]) => ({ id: String(product?.id || key), ...product }));
  const logsSales = normalizeArray(logsSalesSnapshot.val());
  const yocoProcessed = processedSnapshot.val() || {};
  let pendingWrites = {
    logEntry: null,
    errors: [],
    newSignatures: {}
  };

  await dataRef.child('ingredients').transaction((currentIngredients) => {
    const ingredients = normalizeArray(currentIngredients);
    const ingredientMap = new Map(ingredients.map((ingredient, index) => [String(ingredient.id), { ingredient, index }]));
    const details = [];
    const saleLines = [];
    const newSignatures = {};
    const logsSalesErrors = [];
    const orderLocationMap = new Map();
    const orderSourceLocationMap = new Map();
    let skippedDuplicates = 0;
    let missingRecipes = 0;

    lineItems.forEach((line) => {
      const quantity = Math.abs(getLineQuantity(line));
      if (quantity <= 0) return;
      const sellingLocation = resolveLineStockLocation({ locations, sites, settings, logsSales, order, line, refund, mode });
      if (!sellingLocation) {
        logsSalesErrors.push(buildSalesError('yoco_location_missing', 'Yoco order line could not be matched to a KCP location.', {
          orderId,
          productName: getLineName(line),
          lineItemId: getLineId(line, order),
          locationId: getLocationCandidates(order, line).ids[0] || ''
        }));
        return;
      }
      orderLocationMap.set(sellingLocation.id, sellingLocation);

      const product = findProduct(products, line);
      const productName = product?.name || getLineName(line) || 'Yoco Item';
      const reportingRoutingLabel = resolveProductRoutingLabel(product, settings);
      const lineId = getLineId(line, order);
      const yocoVariantId = getLineVariantId(line);
      const paymentOrRefundId = mode === 'refund'
        ? String(refund?.id || refund?.payment_id || '').trim()
        : String(firstApprovedPayment(order)?.id || '').trim();
      const rawSignature = `yoco:${mode}:${orderId}:${paymentOrRefundId}:${lineId}:${sellingLocation.id}:${quantity}`;
      const signatureHash = hashSignature(rawSignature);
      if (yocoProcessed[signatureHash] || newSignatures[signatureHash]) {
        skippedDuplicates += 1;
        return;
      }

      const saleLine = {
        id: lineId,
        productId: product?.id || '',
        productName,
        yocoItemId: getLineItemId(line),
        yocoVariantId,
        routingLabel: reportingRoutingLabel,
        reportingRoutingLabel,
        quantity: mode === 'refund' ? -quantity : quantity,
        totalIncl: moneyToMajor(line.total_price || line.net_amount || 0) * (mode === 'refund' ? -1 : 1),
        locationId: sellingLocation.id,
        locationName: sellingLocation.name,
        sellingLocationId: sellingLocation.id,
        sellingLocationName: sellingLocation.name,
        sourceLocationId: '',
        sourceLocationName: 'Recipe routing',
        siteId: sellingLocation.siteId || '',
        siteName: sellingLocation.siteName || '',
        sourceSiteId: '',
        sourceSiteName: '',
        paymentMethod: getPaymentMethod(order, refund),
        status: mode === 'refund' ? 'refunded' : 'completed',
        orderId,
        orderNumber: order.order_number || order.display_name || '',
        lineItemId: lineId,
        paymentId: firstApprovedPayment(order)?.id || refund?.payment_id || '',
        source: 'yoco'
      };
      saleLines.push(saleLine);

      const recipe = normalizeArray(product?.recipe);
      if (!product || !recipe.length) {
        missingRecipes += 1;
        logsSalesErrors.push(buildSalesError(product ? 'missing_recipe' : 'yoco_product_missing', product ? 'Yoco product has no KCP recipe.' : 'Yoco product could not be matched.', {
          orderId,
          productName,
          lineItemId: lineId,
          locationId: sellingLocation.id,
          sellingLocationId: sellingLocation.id,
          sourceLocationId: '',
          routingLabel: reportingRoutingLabel
        }));
        newSignatures[signatureHash] = buildSignatureMeta(rawSignature, now);
        return;
      }

      const depletionLines = expandRecipeDepletionLines({
        recipe,
        ingredientMap,
        settings,
        context: { orderId, productName, lineItemId: lineId },
        logsSalesErrors
      });

      depletionLines.forEach(({ recipeLine, ingredientRef, ingredientRoutingLabel }) => {
        const recipeQty = parseQuantity(recipeLine.qty || recipeLine.quantity || 0);
        const movementQty = quantity * recipeQty * (mode === 'refund' ? 1 : -1);
        const usageQty = quantity * recipeQty * (mode === 'refund' ? -1 : 1);
        const ingredient = ingredientRef.ingredient;
        const routingDecision = resolveStockDepletionLocation({
          sellingLocation,
          locations,
          sites,
          routingLabel: ingredientRoutingLabel,
          balances: ingredient.balances || {},
          defaultLocation: resolveIngredientDefaultLocation(ingredient, locations, sites)
        });
        const sourceLocation = routingDecision.sourceLocation || sellingLocation;
        const balances = { ...(ingredient.balances || {}) };
        const hasBalances = Object.keys(balances).length > 0;
        const decrementLocation = routingDecision.depletionLocation || sellingLocation;
        orderSourceLocationMap.set(decrementLocation.id, decrementLocation);
        const currentLocationStock = hasBalances
          ? Number(balances[decrementLocation.id] || 0) || 0
          : Number(ingredient.stock || 0) || 0;
        const nextLocationStock = currentLocationStock + movementQty;
        balances[decrementLocation.id] = nextLocationStock;

        const nextStock = Object.keys(balances).length
          ? Object.values(balances).reduce((sum, value) => sum + (Number(value) || 0), 0)
          : (Number(ingredient.stock || 0) || 0) + movementQty;

        ingredients[ingredientRef.index] = {
          ...ingredient,
          stock: nextStock,
          balances,
          updatedAt: now
        };

        assignSaleLineSourceLocation(saleLine, decrementLocation);

        details.push({
          id: createId('sale_detail'),
          source: 'yoco',
          syncMode: mode,
          orderId,
          orderNumber: order.order_number || order.display_name || '',
          paymentId: firstApprovedPayment(order)?.id || '',
          refundId: refund?.id || '',
          refundPaymentId: refund?.payment_id || '',
          lineItemId: lineId,
          originalOrderId: mode === 'refund' ? String(refund?.original_order_id || order.id || '') : '',
          originalOrderNumber: mode === 'refund' ? String(refund?.original_order_number || order.order_number || '') : '',
          originalLineItemId: mode === 'refund' ? String(line.original_line_item_id || line.source_line_item_id || line.line_item_id || line.id || '') : '',
          productId: product.id,
          productName,
          pname: productName,
          stockItemId: ingredient.id,
          stockItemName: ingredient.name,
          ingId: ingredient.id,
          ingName: ingredient.name,
          locationId: decrementLocation.id,
          locationName: decrementLocation.name,
          orderLocationId: sellingLocation.id,
          orderLocationName: sellingLocation.name,
          sellingLocationId: sellingLocation.id,
          sellingLocationName: sellingLocation.name,
          sourceLocationId: decrementLocation.id,
          sourceLocationName: decrementLocation.name,
          routedSourceLocationId: sourceLocation.id,
          routedSourceLocationName: sourceLocation.name,
          routingMode: routingDecision.mode,
          routingTarget: routingDecision.routeTarget,
          routingFallback: routingDecision.fallbackReason || '',
          siteId: decrementLocation.siteId || '',
          siteName: decrementLocation.siteName || '',
          sellingSiteId: sellingLocation.siteId || '',
          sellingSiteName: sellingLocation.siteName || '',
          routingLabel: ingredientRoutingLabel,
          recipeSourceItemId: recipeLine.sourceRecipeItemId || '',
          recipeSourceItemName: recipeLine.sourceRecipeItemName || '',
          recipeSourceType: recipeLine.sourceRecipeType || '',
          reportingRoutingLabel,
          stockCategory: ingredient.category || '',
          locId: decrementLocation.id,
          locName: decrementLocation.name,
          qty: movementQty,
          stockDelta: movementQty,
          qtySold: mode === 'refund' ? -quantity : quantity,
          qtyDepleted: usageQty,
          unit: ingredient.unit || recipeLine.unit || '',
          unitCost: Number(ingredient.lastPurchasePrice ?? ingredient.cost ?? 0) || 0,
          impactEx: movementQty * (Number(ingredient.lastPurchasePrice ?? ingredient.cost ?? 0) || 0),
          impact: movementQty * (Number(ingredient.lastPurchasePrice ?? ingredient.cost ?? 0) || 0),
          salesValue: moneyToMajor(line.total_price || line.net_amount || 0) * (mode === 'refund' ? -1 : 1),
          signature: signatureHash
        });
      });

      newSignatures[signatureHash] = buildSignatureMeta(rawSignature, now);
    });

    if (!details.length && !saleLines.length) {
      result = { processed: false, skippedDuplicates, missingRecipes };
      pendingWrites = {
        logEntry: null,
        errors: logsSalesErrors,
        newSignatures
      };
      return currentIngredients;
    }

    const logId = createId(mode === 'refund' ? 'yoco_refund' : 'yoco_sale');
    const logEntry = {
      id: logId,
      source: 'Yoco',
      sourceProvider: 'yoco',
      syncMode: mode,
      date: todayFromIso(order.closed_at || order.created_at || refund?.processed_at || refund?.created_at || now),
      timestamp: order.closed_at || order.created_at || refund?.processed_at || refund?.created_at || now,
      orderId,
      paymentId: firstApprovedPayment(order)?.id || refund?.payment_id || '',
      refundId: refund?.id || '',
      orderNumber: order.order_number || refund?.order_number || refund?.original_order_number || '',
      locationId: orderLocationMap.size === 1 ? [...orderLocationMap.values()][0].id : '',
      locationName: orderLocationMap.size === 1 ? [...orderLocationMap.values()][0].name : 'Multiple Locations',
      sellingLocationId: orderLocationMap.size === 1 ? [...orderLocationMap.values()][0].id : '',
      sellingLocationName: orderLocationMap.size === 1 ? [...orderLocationMap.values()][0].name : 'Multiple Locations',
      sourceLocationId: orderSourceLocationMap.size === 1 ? [...orderSourceLocationMap.values()][0].id : '',
      sourceLocationName: orderSourceLocationMap.size === 1 ? [...orderSourceLocationMap.values()][0].name : 'Multiple Locations',
      siteId: orderLocationMap.size === 1 ? [...orderLocationMap.values()][0].siteId || '' : '',
      siteName: orderLocationMap.size === 1 ? [...orderLocationMap.values()][0].siteName || '' : '',
      totalIncl: moneyToMajor(order.amounts?.net_amount || refund?.total_amount || 0) * (mode === 'refund' ? -1 : 1),
      saleLines,
      details,
      createdAt: now
    };

    result = {
      processed: true,
      skippedDuplicates,
      missingRecipes
    };
    pendingWrites = {
      logEntry,
      errors: logsSalesErrors,
      newSignatures
    };

    return details.length ? serializeNormalizedListLike(currentIngredients, ingredients) : currentIngredients;
  });

  const updates = {};
  pendingWrites.errors.forEach((error) => {
    updates[`logs_sales_errors/${error.id || createId('sales_error')}`] = error;
  });
  if (pendingWrites.logEntry) {
    updates[`logs_sales/${pendingWrites.logEntry.id}`] = pendingWrites.logEntry;
  }
  Object.entries(pendingWrites.newSignatures || {}).forEach(([signature, meta]) => {
    updates[`processedSalesSignatures/yoco/${signature}`] = meta;
  });
  if (Object.keys(updates).length) {
    await dataRef.update(updates);
  }

  return result;
}

async function resolveLastKnownYocoSaleDate(admin, dataPath) {
  const [integrationSnapshot, logsSnapshot] = await Promise.all([
    admin.database().ref(`${dataPath}/integrations/yoco/lastSuccessfulOrderUpdatedAt`).get(),
    admin.database().ref(`${dataPath}/logs_sales`).get()
  ]);
  const cursor = String(integrationSnapshot.val() || '').trim();
  if (cursor) return cursor;

  const yocoLogs = normalizeArray(logsSnapshot.val())
    .filter((log) => String(log.sourceProvider || log.source || '').toLowerCase().includes('yoco'))
    .map((log) => log.timestamp || log.date || '')
    .filter(Boolean);
  return maxIso(yocoLogs);
}

function getRefundLineItems(order = {}, refund = {}) {
  const returns = normalizeArray(order.returns);
  const refundId = String(refund?.id || '').trim();
  const paymentId = String(refund?.payment_id || '').trim();
  const matchedReturn = returns.find((entry) => {
    if (refundId && [entry.refund_id, entry.id].some((value) => String(value || '').trim() === refundId)) return true;
    if (paymentId && [entry.payment_id, entry.refund_payment_id].some((value) => String(value || '').trim() === paymentId)) return true;
    return false;
  }) || (returns.length === 1 ? returns[0] : null);
  const returned = normalizeArray(matchedReturn?.returned_line_items);
  if (returned.length) return returned;
  return [];
}

function getOrderLineItems(order = {}) {
  return normalizeArray(order.line_items);
}

function getLineQuantity(line = {}) {
  return parseQuantity(line.quantity ?? line.returned_quantity ?? 0);
}

function getLineName(line = {}) {
  return String(line.name || '').trim();
}

function resolveLineStockLocation({ locations = [], sites = [], settings = {}, logsSales = [], order = {}, line = {}, refund = null, mode = 'sale' } = {}) {
  const location = resolveLineLocation(locations, logsSales, order, line, refund, mode);
  return location ? enrichStockLocationWithSite(location, sites) : null;
}

function resolveLineLocation(locations = [], logsSales = [], order = {}, line = {}, refund = null, mode = 'sale') {
  if (mode === 'refund') {
    const historical = findLoggedSaleLocationForRefund(locations, logsSales, order, line, refund);
    if (historical) return historical;
  }

  const candidates = getLocationCandidates(order, line);
  const byCandidate = findLocationByCandidates(locations, candidates);
  if (byCandidate) return byCandidate;

  if (mode === 'refund') {
    return findLoggedSaleLocationForRefund(locations, logsSales, order, line, refund);
  }
  return findRoutingLocation(locations, DEFAULT_STOCK_LOCATION_ID);
}

function findSiteByCandidates(sites = [], candidates = {}) {
  for (const id of candidates.ids || []) {
    const match = sites.find((site) => getSiteTokens(site).has(normalizeText(id)));
    if (match) return match;
  }

  for (const name of candidates.names || []) {
    const normalizedName = normalizeText(name);
    const match = sites.find((site) => getSiteTokens(site).has(normalizedName));
    if (match) return match;
  }
  return null;
}

function chooseStockLocationForSite(locations = [], site = {}) {
  const siteId = String(site.id || site.siteId || '').trim();
  const matches = locations.filter((location) => String(location.siteId || '') === siteId);
  return matches.find((location) => location.salesDefault === true) ||
    matches.find((location) => location.isDefault === true) ||
    matches[0] ||
    null;
}

function enrichStockLocationWithSite(location = {}, sites = [], knownSite = null) {
  const site = knownSite ||
    sites.find((entry) => String(entry.id || entry.siteId || '') === String(location.siteId || '')) ||
    null;
  return {
    ...location,
    siteId: String(location.siteId || site?.id || site?.siteId || '').trim(),
    siteName: String(location.siteName || site?.name || '').trim()
  };
}

function resolveProductRoutingLabel(product = {}, settings = {}) {
  const direct = normalizeRoutingLabel(
    product.routingLabel ||
    product.kcpRoutingLabel ||
    product.stockRoutingLabel ||
    product.routingCategory ||
    ''
  );
  if (direct) return direct;

  const mapped = getMappedRoutingLabel(settings.yocoCategoryMap, [
    product.yocoCategoryId,
    product.yocoCategoryName,
    product.category
  ]);
  if (mapped) return mapped;

  return normalizeRoutingLabel(product.category || product.yocoCategoryName || 'General') || 'General';
}

function resolveIngredientRoutingLabel(ingredient = {}, settings = {}) {
  const category = normalizeStockCategoryBase(ingredient.category || 'General');
  const mapped = getMappedRoutingLabel(settings.stockCategoryRoutingMap, [
    ingredient.category,
    category
  ]);
  return mapped || category || 'General';
}

function expandRecipeDepletionLines({ recipe = [], ingredientMap, settings = {}, context = {}, logsSalesErrors = [] } = {}, multiplier = 1, seen = new Set()) {
  return normalizeArray(recipe).flatMap((recipeLine) => {
    const ingredientId = String(recipeLine.ingId || recipeLine.ingredientId || recipeLine.stockItemId || '').trim();
    const ingredientRef = ingredientMap.get(ingredientId);
    if (!ingredientRef) {
      logsSalesErrors.push(buildSalesError('yoco_product_missing', 'Recipe ingredient could not be found for Yoco sale.', {
        orderId: context.orderId || '',
        productName: context.productName || '',
        lineItemId: context.lineItemId || '',
        missingIngredientId: ingredientId
      }));
      return [];
    }

    const ingredient = ingredientRef.ingredient;
    const recipeQty = parseQuantity(recipeLine.qty || recipeLine.quantity || 0) * multiplier;
    const itemType = getStockItemType(ingredient);
    const nestedRecipe = normalizeArray(ingredient.recipe);
    const seenKey = String(ingredient.id || ingredientId);

    if (itemType === 'sub_recipe' && nestedRecipe.length && !seen.has(seenKey)) {
      const yieldBatch = Math.max(Number(ingredient.yieldBatch || ingredient.yieldQty || 1) || 1, 1);
      const nextSeen = new Set(seen);
      nextSeen.add(seenKey);
      return expandRecipeDepletionLines({
        recipe: nestedRecipe,
        ingredientMap,
        settings,
        context: {
          ...context,
          sourceRecipeItemId: ingredient.id || ingredientId,
          sourceRecipeItemName: ingredient.name || '',
          sourceRecipeType: 'sub_recipe'
        },
        logsSalesErrors
      }, recipeQty / yieldBatch, nextSeen);
    }

    return [{
      ingredientRef,
      ingredientRoutingLabel: resolveIngredientRoutingLabel(ingredient, settings),
      recipeLine: {
        ...recipeLine,
        qty: recipeQty,
        quantity: recipeQty,
        sourceRecipeItemId: context.sourceRecipeItemId || '',
        sourceRecipeItemName: context.sourceRecipeItemName || '',
        sourceRecipeType: context.sourceRecipeType || ''
      }
    }];
  });
}

function getStockItemType(item = {}) {
  const explicit = String(item.itemType || item.stockItemType || item.specificationType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['sub_recipe', 'subrecipe'].includes(explicit) || item.isSubRecipe === true) return 'sub_recipe';
  if (['manufactured', 'prep', 'prepared', 'manufactured_item'].includes(explicit) || item.isManufactured === true) return 'manufactured';
  if (String(item.category || '').toLowerCase().includes('manufactured')) return 'manufactured';
  return 'standard';
}

function normalizeStockCategoryBase(value = '') {
  return normalizeRoutingLabel(String(value || 'General')
    .replace(/\s+-\s+Raw Materials$/i, '')
    .replace(/\s+-\s+Manufactured$/i, '')
    .replace(/\s*\(([^)]+)\)\s*-\s*Manufactured$/i, '$1')) || 'General';
}

function getMappedRoutingLabel(categoryMap = {}, keys = []) {
  const map = normalizeCategoryRoutingMap(categoryMap);
  for (const key of keys || []) {
    const exact = String(key || '').trim();
    if (exact && map[exact]) return map[exact];
    const normalized = normalizeText(key);
    if (normalized && map[normalized]) return map[normalized];
  }
  return '';
}

function normalizeCategoryRoutingMap(value = {}) {
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

function normalizeRoutingLabel(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function resolveStockDepletionLocation({ sellingLocation = {}, locations = [], sites = [], routingLabel = '', balances = {}, defaultLocation = null } = {}) {
  const normalizedLabel = normalizeText(routingLabel || '');
  const routing = normalizeStockRouting(sellingLocation.stockRouting || sellingLocation.routing || {});
  const routeValue = normalizedLabel
    ? routing[normalizedLabel] || routing.default || routing['*'] || ''
    : routing.default || routing['*'] || '';
  const routeTarget = String(routeValue || '').trim();
  const hasExplicitOverride = Boolean(routeTarget && normalizeText(routeTarget) !== 'self');
  const routedLocation = hasExplicitOverride
    ? findRoutingLocation(locations, routeTarget, { defaultLocation })
    : null;
  const sourceLocation = routedLocation
    ? enrichStockLocationWithSite(routedLocation, sites)
    : sellingLocation;
  const hasBalances = Object.keys(balances || {}).length > 0;
  const depletionLocation = hasExplicitOverride && routedLocation
    ? sourceLocation
    : chooseIngredientDecrementLocation({
      balances,
      hasBalances,
      sourceLocation,
      sellingLocation
    });
  const usedFallback = sourceLocation?.id &&
    depletionLocation?.id &&
    String(sourceLocation.id) !== String(depletionLocation.id);

  return {
    sourceLocation,
    depletionLocation,
    routeTarget: routeTarget || 'self',
    mode: hasExplicitOverride ? 'category_override' : 'order_location',
    fallbackReason: hasExplicitOverride && !routedLocation
      ? 'target_location_unresolved'
      : (usedFallback ? 'target_location_balance_missing' : '')
  };
}

function resolveRoutedSourceLocation({ sellingLocation = {}, locations = [], sites = [], routingLabel = '' } = {}) {
  return resolveStockDepletionLocation({
    sellingLocation,
    locations,
    sites,
    routingLabel,
    balances: {}
  }).sourceLocation;
}

function normalizeStockRouting(value = {}) {
  if (typeof value === 'string') {
    return value.split(/[\n,;]+/).reduce((map, pair) => {
      const [label, target] = String(pair || '').split(/[:=]/);
      const key = normalizeText(label);
      const routeTarget = String(target || '').trim();
      if (key && routeTarget) map[key] = routeTarget;
      return map;
    }, {});
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value).reduce((map, [label, target]) => {
    const key = normalizeText(label);
    const routeTarget = String(target || '').trim();
    if (!key || !routeTarget) return map;
    map[key] = routeTarget;
    return map;
  }, {});
}

function resolveIngredientDefaultLocation(ingredient = {}, locations = [], sites = []) {
  const idCandidates = [
    ingredient.targetLocation,
    ingredient.targetLocationId,
    ingredient.defaultLocationId,
    ingredient.locationId,
    ingredient.stockLocationId
  ].map((value) => String(value || '').trim()).filter(Boolean);

  for (const candidate of idCandidates) {
    const match = findRoutingLocation(locations, candidate);
    if (match) return enrichStockLocationWithSite(match, sites);
  }

  const nameCandidates = [
    ingredient.targetLocationName,
    ingredient.defaultLocationName,
    ingredient.locationName
  ].map((value) => String(value || '').trim()).filter(Boolean);

  for (const candidate of nameCandidates) {
    const match = findRoutingLocation(locations, candidate);
    if (match) return enrichStockLocationWithSite(match, sites);
  }

  if (idCandidates[0]) {
    return enrichStockLocationWithSite({
      id: idCandidates[0],
      name: nameCandidates[0] || idCandidates[0],
      siteId: ingredient.siteId || '',
      siteName: ingredient.siteName || ''
    }, sites);
  }

  return null;
}

function isDefaultRoutingTarget(target = '') {
  const normalized = normalizeText(target);
  return ['main', 'main store', 'default', 'default location', 'storage', 'stock store'].includes(normalized);
}

function createDefaultRoutingLocation() {
  return {
    id: DEFAULT_STOCK_LOCATION_ID,
    locationId: DEFAULT_STOCK_LOCATION_ID,
    siteId: DEFAULT_SITE_ID,
    siteName: '',
    name: DEFAULT_STOCK_LOCATION_NAME,
    displayName: DEFAULT_STOCK_LOCATION_NAME,
    originalName: DEFAULT_STOCK_LOCATION_NAME,
    type: 'selling',
    source: 'system',
    isDefault: true,
    systemLocked: true,
    active: true
  };
}

function findRoutingLocation(locations = [], target = '', options = {}) {
  const id = String(target || '').trim();
  const normalized = normalizeText(id);
  if (!id) return null;
  if (isDefaultRoutingTarget(id)) {
    const preferred = options.defaultLocation || null;
    if (String(preferred?.id || preferred?.locationId || '').trim() === DEFAULT_STOCK_LOCATION_ID) return preferred;
    const persistedMain = locations.find((location) => [
      location.id,
      location.locationId
    ].some((value) => String(value || '').trim() === DEFAULT_STOCK_LOCATION_ID));
    if (persistedMain) return persistedMain;
    return createDefaultRoutingLocation();
  }
  return locations.find((location) => [
    location.id,
    location.locationId,
    location.yocoLocationId,
    location.yocoStoreLocationId,
    location.externalLocationId,
    location.externalId,
    location.name,
    location.displayName,
    location.customName,
    location.originalName,
    location.yocoLocationName,
    ...(Array.isArray(location.yocoAliases) ? location.yocoAliases : [])
  ].some((value) => String(value || '').trim() === id || normalizeText(value) === normalized)) || null;
}

function chooseIngredientDecrementLocation({ balances = {}, hasBalances = false, sourceLocation = {}, sellingLocation = {} } = {}) {
  const sourceId = String(sourceLocation.id || '').trim();
  const sellingId = String(sellingLocation.id || '').trim();
  if (!hasBalances || !sourceId) return sourceLocation || sellingLocation;
  if (Object.prototype.hasOwnProperty.call(balances, sourceId)) return sourceLocation;
  if (sellingId && Object.prototype.hasOwnProperty.call(balances, sellingId)) return sellingLocation;
  return sourceLocation || sellingLocation;
}

function assignSaleLineSourceLocation(saleLine = {}, depletionLocation = {}) {
  const locationId = String(depletionLocation.id || '').trim();
  const locationName = String(depletionLocation.name || '').trim();
  if (!locationId) return;
  if (!saleLine.sourceLocationId) {
    saleLine.sourceLocationId = locationId;
    saleLine.sourceLocationName = locationName;
    return;
  }
  if (String(saleLine.sourceLocationId) !== locationId) {
    saleLine.sourceLocationId = '';
    saleLine.sourceLocationName = 'Multiple Locations';
  }
}

function getLocationCandidates(order = {}, line = {}) {
  return {
    ids: [
      order.location_id
    ].map((value) => String(value || '').trim()).filter(Boolean),
    names: []
  };
}

function findLocationByCandidates(locations = [], candidates = {}) {
  for (const id of candidates.ids || []) {
    const match = locations.find((location) => {
      const tokens = getLocationTokens(location);
      return tokens.has(normalizeText(id));
    });
    if (match) return match;
  }

  for (const name of candidates.names || []) {
    const normalizedName = normalizeText(name);
    const match = locations.find((location) => getLocationTokens(location).has(normalizedName));
    if (match) return match;
  }
  return null;
}

function getLocationTokens(location = {}) {
  return new Set([
    location.id,
    location.locationId,
    location.name,
    location.displayName,
    location.yocoLocationId,
    location.yocoStoreLocationId,
    location.yocoLocationName,
    ...(Array.isArray(location.yocoAliases) ? location.yocoAliases : [])
  ].map((value) => normalizeText(value)).filter(Boolean));
}

function getSiteTokens(site = {}) {
  return new Set([
    site.id,
    site.siteId,
    site.name,
    site.yocoLocationId,
    site.yocoLocationName,
    ...(Array.isArray(site.yocoAliases) ? site.yocoAliases : [])
  ].map((value) => normalizeText(value)).filter(Boolean));
}

function findLoggedSaleLocationForRefund(locations = [], logsSales = [], order = {}, line = {}, refund = {}) {
  const summary = findLoggedSaleLineSummary(logsSales, {
    orderId: order.id,
    orderNumber: order.order_number || order.display_name,
    originalOrderId: refund?.original_order_id || line.original_order_id || line.source_order_id || order.id,
    originalOrderNumber: refund?.original_order_number || line.original_order_number || order.order_number,
    lineItemId: getLineId(line, order),
    originalLineItemId: line.original_line_item_id || line.source_line_item_id || line.line_item_id || line.id,
    paymentIds: [refund?.payment_id, firstApprovedPayment(order)?.id],
    productName: line.name || line.product_name
  });
  if (!summary?.locId && !summary?.locationId) return null;
  const locId = String(summary.locId || summary.locationId || '').trim();
  return locations.find((location) => String(location.id || '') === locId) || null;
}

function findLoggedSaleLineSummary(logsSales = [], desired = {}) {
  const desiredOrderIds = new Set([desired.orderId, desired.originalOrderId].map((value) => String(value || '').trim()).filter(Boolean));
  const desiredOrderNumbers = new Set([desired.orderNumber, desired.originalOrderNumber].map(normalizeOrderReference).filter(Boolean));
  const desiredLineIds = new Set([desired.lineItemId, desired.originalLineItemId].map((value) => String(value || '').trim()).filter(Boolean));
  const desiredPaymentIds = new Set((desired.paymentIds || []).map((value) => String(value || '').trim()).filter(Boolean));
  const desiredProduct = normalizeText(desired.productName);
  const summaries = [];

  logsSales.forEach((log) => {
    normalizeArray(log.details).forEach((detail) => {
      const syncMode = String(detail.syncMode || '').toLowerCase();
      if (syncMode === 'refund' || syncMode === 'refund_sales_only') return;
      const locId = String(detail.locId || detail.locationId || '').trim();
      if (!locId) return;
      summaries.push({
        orderId: String(detail.orderId || log.orderId || '').trim(),
        orderNumber: normalizeOrderReference(detail.orderNumber || log.orderNumber || ''),
        lineItemId: String(detail.lineItemId || '').trim(),
        originalLineItemId: String(detail.originalLineItemId || '').trim(),
        paymentId: String(detail.paymentId || log.paymentId || '').trim(),
        productName: detail.pname || detail.productName || detail.product || '',
        locId,
        timestamp: detail.timestamp || log.timestamp || ''
      });
    });
  });

  const candidates = summaries.map((summary) => {
    let score = 0;
    if (desiredOrderIds.has(summary.orderId)) score += 40;
    if (summary.orderNumber && desiredOrderNumbers.has(summary.orderNumber)) score += 20;
    if (summary.lineItemId && desiredLineIds.has(summary.lineItemId)) score += 45;
    if (summary.originalLineItemId && desiredLineIds.has(summary.originalLineItemId)) score += 30;
    if (summary.paymentId && desiredPaymentIds.has(summary.paymentId)) score += 22;
    if (desiredProduct && desiredProduct === normalizeText(summary.productName)) score += 6;
    return { summary, score };
  }).filter((entry) => entry.score > 0);

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return String(right.summary.timestamp || '').localeCompare(String(left.summary.timestamp || ''));
  });
  return candidates[0]?.summary || null;
}

function normalizeOrderReference(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^order\s*/i, '')
    .replace(/#/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function findProduct(products = [], line = {}) {
  const variantId = getLineVariantId(line);
  const name = normalizeText(getLineName(line));
  if (variantId) {
    const byVariant = products.find((product) => String(product.yocoVariantId || '') === variantId);
    if (byVariant) return byVariant;
  }
  return variantId ? null : products.find((product) => normalizeText(product.name) === name) || null;
}

function getLineId(line = {}, order = {}) {
  return String(line.id || line.line_item_id || line.lineItemId || line.original_line_item_id || line.originalLineItemId || line.source_line_item_id || line.sourceLineItemId || getLineVariantId(line) || `${order.id || 'order'}-${line.name || 'line'}`).trim();
}

function getLineVariantId(line = {}) {
  return String(
    line.variant_id ||
    line.variantId ||
    line.item_variant_id ||
    line.itemVariantId ||
    line.product_variant_id ||
    line.productVariantId ||
    line.variant?.id ||
    line.item_variant?.id ||
    line.itemVariant?.id ||
    line.product_variant?.id ||
    line.productVariant?.id ||
    line.yocoVariantId ||
    ''
  ).trim();
}

function getLineItemId(line = {}) {
  return String(
    line.item_id ||
    line.itemId ||
    line.product_id ||
    line.productId ||
    line.catalogue_item_id ||
    line.catalogueItemId ||
    line.item?.id ||
    line.product?.id ||
    line.yocoItemId ||
    ''
  ).trim();
}

function firstApprovedPayment(order = {}) {
  return normalizeArray(order.payments).find((payment) => String(payment.status || '').toLowerCase() === 'approved') ||
    normalizeArray(order.payments)[0] ||
    null;
}

function getPaymentMethod(order = {}, refund = null) {
  const payment = refund || firstApprovedPayment(order) || {};
  return String(payment.payment_method || payment.paymentMethod || payment.method || 'card').trim() || 'card';
}

function buildSignatureMeta(rawSignature, now) {
  return {
    signature: rawSignature,
    provider: 'yoco',
    processedAt: now
  };
}

function buildSalesError(type, message, context = {}) {
  return {
    id: createId('sales_error'),
    type,
    sourceProvider: 'yoco',
    message,
    ...context,
    timestamp: serverTimestampIso()
  };
}

function serializeNormalizedListLike(original, items = []) {
  if (Array.isArray(original)) return items;
  if (original && typeof original === 'object') {
    return Object.fromEntries(items.map((item) => [String(item.id), item]));
  }
  return items;
}

async function writeSalesError(admin, dataPath, type, message, context = {}) {
  const error = buildSalesError(type, message, context);
  await admin.database().ref(`${dataPath}/logs_sales_errors/${error.id}`).set(error);
}

function maxIso(values = []) {
  return values
    .filter(Boolean)
    .map(String)
    .sort()
    .at(-1) || '';
}

module.exports = {
  maxIso,
  processYocoOrder,
  resolveLastKnownYocoSaleDate,
  syncYocoSalesData,
  writeSalesError
};
