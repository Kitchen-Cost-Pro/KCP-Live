const { HttpsError } = require('firebase-functions/v2/https');
const crypto = require('crypto');

const DEFAULT_SITE_PROFILE = {
  orgId: '',
  corpId: '',
  viewingOnly: false,
  linkedSites: {}
};

const TRANSFER_AGENT_ROLES = new Set([
  'owner',
  'admin',
  'transfer_agent',
  'transfer-agent',
  'transfer agent'
]);

function createOrgTransferHandlers({ admin, rtdb, requireSuperUser }) {
  async function connectProfilesCallable(request) {
    await requireSuperUser(request.auth);
    return connectProfiles(request.data || {}, request.auth?.uid || '');
  }

  async function getSiteConfigurationCallable(request) {
    const auth = await requireRequestAuth(request.auth);
    const siteId = requireString(request.data?.site_id || request.data?.siteId || request.data?.workspaceId, 'site_id is required.');
    await requireSiteViewer(auth.uid, siteId);
    return getSiteConfiguration(siteId);
  }

  async function api(request, response) {
    applyCors(response);
    if (request.method === 'OPTIONS') {
      response.status(204).send('');
      return;
    }

    try {
      const auth = await verifyBearerToken(request);
      const path = normalizePath(request.path || request.url || '');
      const method = String(request.method || 'GET').toUpperCase();

      if (method === 'POST' && path === '/profiles/connect') {
        await requireSuperUser({ uid: auth.uid });
        response.json(await connectProfiles(request.body || {}, auth.uid));
        return;
      }

      if (method === 'POST' && path === '/transfers/internal') {
        response.json(await postInternalTransfer(auth.uid, request.body || {}));
        return;
      }

      if (method === 'POST' && path === '/transfers/external') {
        response.json(await postExternalTransfer(auth.uid, request.body || {}));
        return;
      }

      if (method === 'GET' && path === '/reports/corporate') {
        response.json(await getCorporateReport(auth.uid, request.query || {}));
        return;
      }

      if (method === 'GET' && path === '/site/config') {
        const siteId = requireString(request.query?.site_id || request.query?.siteId || request.query?.workspaceId, 'site_id is required.');
        await requireSiteViewer(auth.uid, siteId);
        response.json(await getSiteConfiguration(siteId));
        return;
      }

      response.status(404).json({ error: 'not_found', message: `No route for ${method} ${path}.` });
    } catch (error) {
      sendApiError(response, error);
    }
  }

  async function connectProfiles(payload = {}, actorUid = '') {
    const primarySiteId = requireString(payload.primary_site_id || payload.primarySiteId, 'primary_site_id is required.');
    const targetSiteId = requireString(payload.target_site_id || payload.targetSiteId, 'target_site_id is required.');
    const linkType = normalizeLinkType(payload.link_type || payload.linkType);
    if (primarySiteId === targetSiteId) throw new HttpsError('invalid-argument', 'Choose two different site profiles to link.');

    const [primary, target] = await Promise.all([
      loadSiteProfile(primarySiteId),
      loadSiteProfile(targetSiteId)
    ]);
    if (!primary.exists) throw new HttpsError('not-found', 'Primary site profile was not found.');
    if (!target.exists) throw new HttpsError('not-found', 'Target site profile was not found.');

    const now = new Date().toISOString();
    const updates = {};
    const primaryNext = { ...DEFAULT_SITE_PROFILE, ...primary.profile };
    const targetNext = { ...DEFAULT_SITE_PROFILE, ...target.profile };
    let linkedValue = '';

    if (linkType === 'org') {
      linkedValue = primaryNext.orgId || targetNext.orgId || createId('org');
      primaryNext.orgId = linkedValue;
      targetNext.orgId = linkedValue;
    } else {
      linkedValue = primaryNext.corpId || targetNext.corpId || createId('corp');
      primaryNext.corpId = linkedValue;
      targetNext.corpId = linkedValue;
    }

    const primaryLink = {
      siteId: targetSiteId,
      linkType,
      orgId: targetNext.orgId || '',
      corpId: targetNext.corpId || '',
      linkedAt: now,
      linkedBy: actorUid
    };
    const targetLink = {
      siteId: primarySiteId,
      linkType,
      orgId: primaryNext.orgId || '',
      corpId: primaryNext.corpId || '',
      linkedAt: now,
      linkedBy: actorUid
    };

    assignSiteProfileUpdates(updates, primarySiteId, {
      ...primaryNext,
      siteId: primarySiteId,
      updatedAt: now,
      linkedSites: {
        ...(primaryNext.linkedSites || {}),
        [targetSiteId]: primaryLink
      }
    });
    assignSiteProfileUpdates(updates, targetSiteId, {
      ...targetNext,
      siteId: targetSiteId,
      updatedAt: now,
      linkedSites: {
        ...(targetNext.linkedSites || {}),
        [primarySiteId]: targetLink
      }
    });

    await rtdb.ref().update(updates);

    return {
      status: 'linked',
      primary_site_id: primarySiteId,
      target_site_id: targetSiteId,
      link_type: linkType,
      org_id: primaryNext.orgId || targetNext.orgId || '',
      corp_id: primaryNext.corpId || targetNext.corpId || '',
      linked_value: linkedValue
    };
  }

  async function postInternalTransfer(uid, payload = {}) {
    const siteId = requireString(payload.site_id || payload.siteId || payload.workspaceId, 'site_id is required.');
    await requireTransferAgent(uid, siteId);

    const transfer = normalizeTransferPayload(payload);
    if (!transfer.fromLocationId || !transfer.toLocationId) throw new HttpsError('invalid-argument', 'from_location_id and to_location_id are required.');
    if (transfer.fromLocationId === transfer.toLocationId) throw new HttpsError('invalid-argument', 'Source and destination locations must be different.');
    if (!transfer.items.length) throw new HttpsError('invalid-argument', 'At least one transfer item is required.');

    const siteData = await loadSiteData(siteId);
    const fromLocation = findLocation(siteData.locations, transfer.fromLocationId);
    const toLocation = findLocation(siteData.locations, transfer.toLocationId);
    if (!fromLocation || !toLocation) throw new HttpsError('failed-precondition', 'Both transfer locations must exist on the selected site profile.');

    const now = new Date().toISOString();
    const transferId = createId('tf');
    const movedItems = [];

    try {
      await rtdb.ref(siteData.ingredientsPath).transaction((current) => {
      const list = normalizeList(current);
      const itemMap = new Map(list.map((item, index) => [String(item.id || ''), index]));
      const nextMovedItems = [];

      for (const line of transfer.items) {
        const index = itemMap.get(line.stockItemId);
        if (index === undefined) continue;
        const item = list[index];
        const qty = Number(line.quantity || 0) || 0;
        if (qty <= 0) continue;
        const balances = normalizeBalances(item.balances);
        seedBalanceFromStockIfNeeded(balances, item, transfer.fromLocationId);
        const fromBefore = Number(balances[transfer.fromLocationId] || 0) || 0;
        const toBefore = Number(balances[transfer.toLocationId] || 0) || 0;
        if (fromBefore < qty && payload.allow_negative !== true && payload.allowNegative !== true) {
          throw new Error(`Insufficient stock for ${item.name || line.stockItemId}.`);
        }
        balances[transfer.fromLocationId] = fromBefore - qty;
        balances[transfer.toLocationId] = toBefore + qty;
        list[index] = {
          ...item,
          balances,
          stock: sumBalances(balances),
          updatedAt: now
        };
        nextMovedItems.push(toMovedLine(item, line, qty, fromBefore, toBefore));
      }

      movedItems.splice(0, movedItems.length, ...nextMovedItems);
      return list;
      });
    } catch (error) {
      throw toTransferHttpsError(error);
    }

    if (!movedItems.length) throw new HttpsError('failed-precondition', 'No matching stock items were found for this transfer.');
    const logEntry = buildTransferLog({
      transferId,
      transferType: 'internal',
      createdBy: uid,
      now,
      payload: transfer,
      fromSiteId: siteId,
      toSiteId: siteId,
      fromLocation,
      toLocation,
      items: movedItems
    });

    await appendTransferLog(siteId, logEntry);
    return { status: 'posted', transfer_id: transferId, transfer_type: 'internal', items_moved: movedItems.length };
  }

  async function postExternalTransfer(uid, payload = {}) {
    const fromSiteId = requireString(payload.from_site_id || payload.fromSiteId || payload.primary_site_id || payload.primarySiteId, 'from_site_id is required.');
    const toSiteId = requireString(payload.to_site_id || payload.toSiteId || payload.target_site_id || payload.targetSiteId, 'to_site_id is required.');
    if (fromSiteId === toSiteId) throw new HttpsError('invalid-argument', 'Use the internal transfer endpoint for same-site location transfers.');
    await requireTransferAgent(uid, fromSiteId);

    const transfer = normalizeTransferPayload(payload);
    if (!transfer.fromLocationId || !transfer.toLocationId) throw new HttpsError('invalid-argument', 'from_location_id and to_location_id are required.');
    if (!transfer.items.length) throw new HttpsError('invalid-argument', 'At least one transfer item is required.');

    const [fromProfile, toProfile, fromData, toData] = await Promise.all([
      loadSiteProfile(fromSiteId),
      loadSiteProfile(toSiteId),
      loadSiteData(fromSiteId),
      loadSiteData(toSiteId)
    ]);

    validateExternalLink(fromSiteId, toSiteId, fromProfile.profile, toProfile.profile);
    const fromLocation = findLocation(fromData.locations, transfer.fromLocationId);
    const toLocation = findLocation(toData.locations, transfer.toLocationId);
    if (!fromLocation) throw new HttpsError('failed-precondition', 'Source location does not exist on the source site profile.');
    if (!toLocation) throw new HttpsError('failed-precondition', 'Destination location does not exist on the receiving site profile.');

    const now = new Date().toISOString();
    const transferId = createId('xtf');
    const sourceItems = [];

    try {
      await rtdb.ref(fromData.ingredientsPath).transaction((current) => {
      const list = normalizeList(current);
      const itemMap = new Map(list.map((item, index) => [String(item.id || ''), index]));
      const nextSourceItems = [];

      for (const line of transfer.items) {
        const index = itemMap.get(line.stockItemId);
        if (index === undefined) continue;
        const item = list[index];
        const qty = Number(line.quantity || 0) || 0;
        if (qty <= 0) continue;
        const balances = normalizeBalances(item.balances);
        seedBalanceFromStockIfNeeded(balances, item, transfer.fromLocationId);
        const fromBefore = Number(balances[transfer.fromLocationId] || 0) || 0;
        if (fromBefore < qty && payload.allow_negative !== true && payload.allowNegative !== true) {
          throw new Error(`Insufficient stock for ${item.name || line.stockItemId}.`);
        }
        balances[transfer.fromLocationId] = fromBefore - qty;
        list[index] = {
          ...item,
          balances,
          stock: sumBalances(balances),
          updatedAt: now
        };
        nextSourceItems.push({ sourceItem: item, line, qty, fromBefore });
      }

      sourceItems.splice(0, sourceItems.length, ...nextSourceItems);
      return list;
      });
    } catch (error) {
      throw toTransferHttpsError(error);
    }

    if (!sourceItems.length) throw new HttpsError('failed-precondition', 'No matching stock items were found on the source site profile.');

    const movedItems = [];
    try {
      await rtdb.ref(toData.ingredientsPath).transaction((current) => {
        const list = normalizeList(current);
        const itemMap = new Map(list.map((item, index) => [String(item.id || ''), index]));
        const nextMovedItems = [];

        for (const moved of sourceItems) {
          const targetId = moved.line.targetStockItemId || moved.line.stockItemId;
          let index = itemMap.get(targetId);
          if (index === undefined) {
            index = list.length;
            list.push(createReceivingStockItem(moved.sourceItem, targetId, now));
            itemMap.set(targetId, index);
          }
          const item = list[index];
          const balances = normalizeBalances(item.balances);
          const toBefore = Number(balances[transfer.toLocationId] || 0) || 0;
          balances[transfer.toLocationId] = toBefore + moved.qty;
          list[index] = {
            ...item,
            balances,
            stock: sumBalances(balances),
            updatedAt: now
          };
          nextMovedItems.push(toMovedLine(moved.sourceItem, moved.line, moved.qty, moved.fromBefore, toBefore, targetId));
        }

        movedItems.splice(0, movedItems.length, ...nextMovedItems);
        return list;
      });
    } catch (error) {
      await rollbackSourceTransfer(fromData.ingredientsPath, transfer.fromLocationId, sourceItems, now);
      throw toTransferHttpsError(error);
    }

    const sourceLog = buildTransferLog({
      transferId,
      transferType: 'external_out',
      createdBy: uid,
      now,
      payload: transfer,
      fromSiteId,
      toSiteId,
      fromLocation,
      toLocation,
      items: movedItems
    });
    const receivingLog = {
      ...sourceLog,
      transferType: 'external_in',
      linkedTransferId: transferId
    };

    await Promise.all([
      appendTransferLog(fromSiteId, sourceLog),
      appendTransferLog(toSiteId, receivingLog)
    ]);

    return { status: 'posted', transfer_id: transferId, transfer_type: 'external', items_moved: movedItems.length };
  }

  async function getCorporateReport(uid, query = {}) {
    const corpId = requireString(query.corp_id || query.corpId, 'corp_id is required.');
    const registry = await loadRegistry();
    const siteIds = Object.entries(registry)
      .filter(([, entry]) => String(entry?.corpId || entry?.corp_id || '') === corpId)
      .map(([siteId]) => siteId);
    if (!siteIds.length) return { corp_id: corpId, site_count: 0, totals: emptyCorporateTotals(), sites: [] };

    const superUser = await isSuperUser(uid);
    if (!superUser) {
      const accessChecks = await Promise.all(siteIds.map((siteId) => getSiteAccess(uid, siteId)));
      const canViewCorporate = accessChecks.some((access) => access.exists && (access.viewingOnly || access.role === 'owner' || access.role === 'admin' || access.role === 'corporate_viewer'));
      if (!canViewCorporate) throw new HttpsError('permission-denied', 'You do not have corporate view-only access for this Corp ID.');
    }

    const sites = await Promise.all(siteIds.map(async (siteId) => summarizeCorporateSite(siteId)));
    const totals = sites.reduce((accumulator, site) => ({
      stock_value: accumulator.stock_value + site.stock_value,
      stock_qty: accumulator.stock_qty + site.stock_qty,
      low_stock_count: accumulator.low_stock_count + site.low_stock_count,
      item_count: accumulator.item_count + site.item_count
    }), emptyCorporateTotals());

    return {
      corp_id: corpId,
      generated_at: new Date().toISOString(),
      view_only: true,
      site_count: sites.length,
      totals,
      sites
    };
  }

  async function getSiteConfiguration(siteId) {
    const [profile, data] = await Promise.all([
      loadSiteProfile(siteId),
      loadSiteData(siteId)
    ]);
    const locations = data.locations.filter((location) => location.active !== false);
    const registry = await loadRegistry();
    const relatedSites = Object.entries(registry).filter(([id, entry]) => {
      if (id === siteId) return false;
      return (
        Boolean(profile.profile.orgId && String(entry?.orgId || entry?.org_id || '') === String(profile.profile.orgId)) ||
        Boolean(profile.profile.corpId && String(entry?.corpId || entry?.corp_id || '') === String(profile.profile.corpId))
      );
    });
    return {
      site_id: siteId,
      org_id: profile.profile.orgId || '',
      corp_id: profile.profile.corpId || '',
      viewing_only: profile.profile.viewingOnly === true,
      location_count: locations.length,
      linked_site_count: relatedSites.length,
      show_internal_transfer: locations.length > 1,
      show_external_transfer: Boolean((profile.profile.orgId || profile.profile.corpId) && relatedSites.length)
    };
  }

  async function verifyBearerToken(request) {
    const header = String(request.headers.authorization || request.headers.Authorization || '');
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new HttpsError('unauthenticated', 'Send a Firebase ID token in the Authorization bearer header.');
    return admin.auth().verifyIdToken(token);
  }

  async function requireRequestAuth(auth) {
    const uid = auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
    return { uid };
  }

  async function requireSiteViewer(uid, siteId) {
    if (await isSuperUser(uid)) return true;
    const access = await getSiteAccess(uid, siteId);
    if (!access.exists) throw new HttpsError('permission-denied', 'You do not have access to this site profile.');
    return true;
  }

  async function requireTransferAgent(uid, siteId) {
    if (await isSuperUser(uid)) return true;
    const access = await getSiteAccess(uid, siteId);
    if (!access.exists) throw new HttpsError('permission-denied', 'You do not have access to this site profile.');
    if (access.viewingOnly) throw new HttpsError('permission-denied', 'Viewing-only users cannot post stock transfers.');
    if (!TRANSFER_AGENT_ROLES.has(access.role)) {
      throw new HttpsError('permission-denied', 'Only Transfer Agent users can post external stock transfers.');
    }
    return true;
  }

  async function getSiteAccess(uid, siteId) {
    const [teamSnap, profileSnap] = await Promise.all([
      rtdb.ref(`workspaces/${siteId}/data/team/${uid}`).get(),
      rtdb.ref(`users/${uid}/profile/workspaces/${siteId}`).get()
    ]);
    const team = teamSnap.val() || {};
    const profile = profileSnap.val() || {};
    const role = normalizeRole(team.role || profile.role || '');
    return {
      exists: teamSnap.exists() || profileSnap.exists(),
      role: role || 'member',
      viewingOnly: team.viewingOnly === true || profile.viewingOnly === true || team.viewOnly === true || profile.viewOnly === true
    };
  }

  async function isSuperUser(uid) {
    if (!uid) return false;
    const snapshot = await rtdb.ref(`adminConfig/superusers/${uid}`).get();
    return snapshot.exists();
  }

  async function loadSiteProfile(siteId) {
    const [workspaceSnap, profileSnap, settingsSnap, registrySnap] = await Promise.all([
      rtdb.ref(`workspaces/${siteId}`).get(),
      rtdb.ref(`workspaces/${siteId}/profile`).get(),
      rtdb.ref(`workspaces/${siteId}/data/settings`).get(),
      rtdb.ref(`adminConfig/registry/${siteId}`).get()
    ]);
    const settings = settingsSnap.val() || {};
    const registry = registrySnap.val() || {};
    const profile = {
      ...DEFAULT_SITE_PROFILE,
      ...(profileSnap.val() || {}),
      siteId,
      orgId: String(profileSnap.val()?.orgId || settings.orgId || settings.org_id || registry.orgId || registry.org_id || '').trim(),
      corpId: String(profileSnap.val()?.corpId || settings.corpId || settings.corp_id || registry.corpId || registry.corp_id || '').trim(),
      viewingOnly: profileSnap.val()?.viewingOnly === true || settings.viewingOnly === true || registry.viewingOnly === true,
      linkedSites: {
        ...(settings.linkedSites || {}),
        ...(profileSnap.val()?.linkedSites || {})
      }
    };
    return { exists: workspaceSnap.exists(), profile, settings, registry };
  }

  async function loadSiteData(siteId) {
    const rootPath = `workspaces/${siteId}/data`;
    const [settingsSnap, locationsSnap, ingredientsSnap] = await Promise.all([
      rtdb.ref(`${rootPath}/settings`).get(),
      rtdb.ref(`${rootPath}/locations`).get(),
      rtdb.ref(`${rootPath}/ingredients`).get()
    ]);
    return {
      siteId,
      rootPath,
      ingredientsPath: `${rootPath}/ingredients`,
      settings: settingsSnap.val() || {},
      locations: normalizeLocations(locationsSnap.val()),
      ingredients: normalizeList(ingredientsSnap.val())
    };
  }

  async function loadRegistry() {
    const snapshot = await rtdb.ref('adminConfig/registry').get();
    return snapshot.val() || {};
  }

  async function summarizeCorporateSite(siteId) {
    const data = await loadSiteData(siteId);
    const settings = data.settings || {};
    const locationsById = new Map(data.locations.map((location) => [String(location.id), location]));
    let stockValue = 0;
    let stockQty = 0;
    let lowStockCount = 0;

    for (const item of data.ingredients) {
      const balances = normalizeBalances(item.balances);
      const qty = Object.keys(balances).length ? sumBalances(balances) : Number(item.stock || 0) || 0;
      stockQty += qty;
      stockValue += qty * (Number(item.cost || 0) || 0);
      const threshold = Number(item.lowStockThreshold || item.threshold || 0) || 0;
      if (threshold > 0 && qty < threshold) lowStockCount += 1;
    }

    return {
      site_id: siteId,
      site_name: settings.siteName || settings.workspaceName || siteId,
      location_count: locationsById.size,
      item_count: data.ingredients.length,
      stock_qty: round(stockQty, 3),
      stock_value: round(stockValue, 2),
      low_stock_count: lowStockCount
    };
  }

  function assignSiteProfileUpdates(updates, siteId, profile) {
    const orgId = String(profile.orgId || '').trim();
    const corpId = String(profile.corpId || '').trim();
    const viewingOnly = profile.viewingOnly === true;
    updates[`workspaces/${siteId}/profile`] = profile;
    updates[`workspaces/${siteId}/data/settings/orgId`] = orgId;
    updates[`workspaces/${siteId}/data/settings/corpId`] = corpId;
    updates[`workspaces/${siteId}/data/settings/viewingOnly`] = viewingOnly;
    updates[`adminConfig/registry/${siteId}/orgId`] = orgId;
    updates[`adminConfig/registry/${siteId}/corpId`] = corpId;
    updates[`adminConfig/registry/${siteId}/viewingOnly`] = viewingOnly;
    updates[`adminConfig/registry/${siteId}/updatedAt`] = profile.updatedAt;
  }

  function validateExternalLink(fromSiteId, toSiteId, fromProfile = {}, toProfile = {}) {
    const sharedOrg = Boolean(fromProfile.orgId && toProfile.orgId && String(fromProfile.orgId) === String(toProfile.orgId));
    const sharedCorp = Boolean(fromProfile.corpId && toProfile.corpId && String(fromProfile.corpId) === String(toProfile.corpId));
    if (!sharedOrg && !sharedCorp) {
      throw new HttpsError('failed-precondition', 'External transfers require both site profiles to share an Org ID or Corp ID.');
    }
    const linkedFromPrimary = Boolean(fromProfile.linkedSites?.[toSiteId]);
    const linkedFromTarget = Boolean(toProfile.linkedSites?.[fromSiteId]);
    if (!linkedFromPrimary && !linkedFromTarget) {
      throw new HttpsError('failed-precondition', 'The receiving site is not linked to the source site in the admin profile mapping.');
    }
  }

  async function appendTransferLog(siteId, entry) {
    await rtdb.ref(`workspaces/${siteId}/data/logs_transfers`).transaction((current) => {
      const logs = normalizeList(current);
      logs.push(entry);
      return logs;
    });
  }

  async function rollbackSourceTransfer(ingredientsPath, locationId, sourceItems, now) {
    await rtdb.ref(ingredientsPath).transaction((current) => {
      const list = normalizeList(current);
      const itemMap = new Map(list.map((item, index) => [String(item.id || ''), index]));
      for (const moved of sourceItems) {
        const index = itemMap.get(String(moved.line.stockItemId || ''));
        if (index === undefined) continue;
        const item = list[index];
        const balances = normalizeBalances(item.balances);
        balances[locationId] = (Number(balances[locationId] || 0) || 0) + moved.qty;
        list[index] = {
          ...item,
          balances,
          stock: sumBalances(balances),
          updatedAt: now
        };
      }
      return list;
    });
  }

  return {
    api,
    connectProfilesCallable,
    getSiteConfigurationCallable
  };
}

function normalizeTransferPayload(payload = {}) {
  return {
    date: String(payload.date || new Date().toISOString().slice(0, 10)).trim(),
    fromLocationId: String(payload.from_location_id || payload.fromLocationId || '').trim(),
    toLocationId: String(payload.to_location_id || payload.toLocationId || '').trim(),
    note: String(payload.note || '').trim(),
    items: toArray(payload.items).map((item) => ({
      stockItemId: String(item.stock_item_id || item.stockItemId || item.item_id || item.itemId || item.id || '').trim(),
      targetStockItemId: String(item.target_stock_item_id || item.targetStockItemId || item.stock_item_id || item.stockItemId || item.id || '').trim(),
      quantity: Math.max(Number(item.quantity || item.qty || 0), 0),
      unit: String(item.unit || '').trim()
    })).filter((item) => item.stockItemId && item.quantity > 0)
  };
}

function buildTransferLog({ transferId, transferType, createdBy, now, payload, fromSiteId, toSiteId, fromLocation, toLocation, items }) {
  return {
    id: transferId,
    transferId,
    transferType,
    timestamp: now,
    createdAt: now,
    createdBy,
    date: payload.date || now.slice(0, 10),
    from: fromLocation.id,
    to: toLocation.id,
    fromLocationId: fromLocation.id,
    toLocationId: toLocation.id,
    fromName: fromLocation.name,
    toName: toLocation.name,
    fromLocationName: fromLocation.name,
    toLocationName: toLocation.name,
    fromSiteId,
    toSiteId,
    note: payload.note || '',
    lineCount: items.length,
    items
  };
}

function toMovedLine(item, line, qty, fromBefore, toBefore, targetStockItemId = '') {
  return {
    stockItemId: item.id || line.stockItemId,
    targetStockItemId: targetStockItemId || line.targetStockItemId || line.stockItemId,
    id: item.id || line.stockItemId,
    name: item.name || line.stockItemId,
    qty,
    quantity: qty,
    unit: item.unit || line.unit || '',
    fromBalanceBefore: fromBefore,
    toBalanceBefore: toBefore
  };
}

function createReceivingStockItem(sourceItem = {}, id = '', now = new Date().toISOString()) {
  return {
    ...sourceItem,
    id: id || sourceItem.id || createId('item'),
    stock: 0,
    balances: {},
    source: 'external_transfer',
    createdAt: sourceItem.createdAt || now,
    updatedAt: now
  };
}

function normalizeLocations(value) {
  return normalizeList(value).map((location) => ({
    ...location,
    id: String(location.id || location.locationId || '').trim(),
    name: String(location.name || location.label || location.locationName || location.id || '').trim(),
    active: location.active !== false && location.archived !== true
  })).filter((location) => location.id);
}

function findLocation(locations = [], locationId = '') {
  return locations.find((location) => String(location.id) === String(locationId)) || null;
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, item]) => item && typeof item === 'object')
      .map(([id, item]) => ({ id: String(item.id || id), ...item }));
  }
  return [];
}

function normalizeBalances(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function seedBalanceFromStockIfNeeded(balances, item, locationId) {
  if (Object.keys(balances).length) return;
  const stock = Number(item.stock || 0) || 0;
  if (stock) balances[locationId] = stock;
}

function sumBalances(balances = {}) {
  return Object.values(balances).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function emptyCorporateTotals() {
  return {
    stock_value: 0,
    stock_qty: 0,
    low_stock_count: 0,
    item_count: 0
  };
}

function normalizePath(path = '') {
  const clean = String(path || '').split('?')[0].replace(/^\/orgTransferApi/, '').replace(/^\/api/, '');
  return clean.startsWith('/') ? clean : `/${clean}`;
}

function normalizeLinkType(value = '') {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'org' || type === 'organization') return 'org';
  if (type === 'corp' || type === 'corporate') return 'corp';
  throw new HttpsError('invalid-argument', 'link_type must be Org or Corp.');
}

function normalizeRole(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function requireString(value, message) {
  const text = String(value || '').trim();
  if (!text) throw new HttpsError('invalid-argument', message);
  return text;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : Object.values(value);
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value || 0) + Number.EPSILON) * factor) / factor;
}

function applyCors(response) {
  response.set('Access-Control-Allow-Origin', '*');
  response.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function sendApiError(response, error) {
  const code = error?.code || 'internal';
  const status = {
    unauthenticated: 401,
    'permission-denied': 403,
    'invalid-argument': 400,
    'not-found': 404,
    'already-exists': 409,
    'failed-precondition': 412
  }[code] || 500;
  response.status(status).json({
    error: code,
    message: error?.message || String(error)
  });
}

function toTransferHttpsError(error) {
  if (error instanceof HttpsError) return error;
  const message = error?.message || String(error);
  if (/insufficient stock/i.test(message)) return new HttpsError('failed-precondition', message);
  return error;
}

module.exports = {
  createOrgTransferHandlers
};
