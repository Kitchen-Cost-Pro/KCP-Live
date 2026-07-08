const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

admin.initializeApp();

const db = admin.firestore();
const rtdb = admin.database();
const REGION = 'europe-west1';
const TRANSFER_AGENT_ROLES = new Set(['owner', 'admin', 'transfer_agent', 'transfer-agent', 'transfer agent']);
const gmailUserSecret = defineSecret('KCP_GMAIL_USER');
const gmailAppPasswordSecret = defineSecret('KCP_GMAIL_APP_PASSWORD');
const emailFromSecret = defineSecret('KCP_EMAIL_FROM');

exports.listOrgManagerSites = onCall({
  region: REGION,
  timeoutSeconds: 60,
  memory: '256MiB'
}, async (request) => {
  await requireSuperUser(request.auth);

  const [sitesSnapshot, registrySnapshot] = await Promise.all([
    db.collection('sites').get(),
    rtdb.ref('adminConfig/registry').get()
  ]);
  const registry = registrySnapshot.val() || {};
  const sites = new Map();

  sitesSnapshot.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const siteId = String(data.siteId || data.workspaceId || docSnap.id || '').trim();
    if (!siteId) return;
    const registryEntry = registry[siteId] || {};
    sites.set(siteId, buildSiteRow(siteId, {
      ...registryEntry,
      ...data,
      firestoreId: docSnap.id,
      source: 'firestore'
    }));
  });

  for (const [siteId, entry] of Object.entries(registry)) {
    if (sites.has(siteId)) continue;
    sites.set(siteId, buildSiteRow(siteId, {
      ...entry,
      firestoreId: siteId,
      source: 'registry'
    }));
  }

  return {
    sites: Array.from(sites.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)))
  };
});

exports.saveOrgGroup = onCall({
  region: REGION,
  timeoutSeconds: 120,
  memory: '256MiB'
}, async (request) => {
  const { uid } = await requireSuperUser(request.auth);
  const siteIds = Array.isArray(request.data?.siteIds)
    ? request.data.siteIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const groupName = String(request.data?.groupName || '').trim();
  const linkType = String(request.data?.linkType || 'org').trim().toLowerCase() === 'corp' ? 'corp' : 'org';
  const selectedId = String(request.data?.linkId || '').trim();
  const permissionLevel = String(request.data?.permissionLevel || 'full_transfer').trim();
  const viewingOnly = permissionLevel === 'corporate_view_only';
  const linkId = selectedId || `${linkType}_${crypto.randomUUID()}`;

  if (!siteIds.length) throw new HttpsError('invalid-argument', 'Select at least one site.');
  if (siteIds.length > 450) throw new HttpsError('invalid-argument', 'Select 450 sites or fewer per group save.');
  if (!groupName) throw new HttpsError('invalid-argument', 'Group name is required.');

  const batch = db.batch();
  const linkedAt = admin.firestore.FieldValue.serverTimestamp();
  const metadata = {
    name: groupName,
    linkType,
    permissionLevel,
    linkedBy: uid,
    linkedByEmail: request.auth?.token?.email || '',
    linkedAt
  };

  siteIds.forEach((siteId) => {
    batch.set(db.collection('sites').doc(siteId), {
      siteId,
      workspaceId: siteId,
      [linkType === 'org' ? 'orgId' : 'corpId']: linkId,
      groupMetadata: metadata,
      permissionLevel,
      viewingOnly,
      updatedAt: linkedAt,
      updatedBy: uid
    }, { merge: true });
  });

  await batch.commit();
  await mirrorOrgGroupToRealtime({
    siteIds,
    linkType,
    linkId,
    groupName,
    permissionLevel,
    viewingOnly,
    uid,
    email: request.auth?.token?.email || ''
  });

  return {
    status: 'linked',
    siteIds,
    linkType,
    linkId,
    groupName,
    permissionLevel
  };
});

exports.unlinkOrgSite = onCall({
  region: REGION,
  timeoutSeconds: 60,
  memory: '256MiB'
}, async (request) => {
  const { uid } = await requireSuperUser(request.auth);
  const siteId = String(request.data?.siteId || '').trim();
  const linkType = String(request.data?.linkType || 'org').trim().toLowerCase() === 'corp' ? 'corp' : 'org';
  if (!siteId) throw new HttpsError('invalid-argument', 'siteId is required.');

  const fieldName = linkType === 'org' ? 'orgId' : 'corpId';
  await db.collection('sites').doc(siteId).set({
    [fieldName]: admin.firestore.FieldValue.delete(),
    groupMetadata: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: uid
  }, { merge: true });
  await mirrorOrgUnlinkToRealtime({ siteId, linkType });

  return { status: 'unlinked', siteId, linkType };
});

exports.listLinkedTransferProfiles = onCall({
  region: REGION,
  timeoutSeconds: 60,
  memory: '256MiB'
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before loading linked transfer profiles.');

  const workspaceId = String(request.data?.workspaceId || request.data?.siteId || request.data?.site_id || '').trim();
  if (!workspaceId) throw new HttpsError('invalid-argument', 'workspaceId is required.');

  await requireSiteViewer(request.auth, workspaceId);

  const [sourceProfileSnap, sourceSettingsSnap, registrySnap] = await Promise.all([
    rtdb.ref(`workspaces/${workspaceId}/profile`).get(),
    rtdb.ref(`workspaces/${workspaceId}/data/settings`).get(),
    rtdb.ref('adminConfig/registry').get()
  ]);
  const registry = registrySnap.val() || {};
  const sourceRegistry = registry[workspaceId] || {};
  const sourceProfile = sourceProfileSnap.val() || {};
  const sourceSettings = sourceSettingsSnap.val() || {};
  const orgId = String(sourceProfile.orgId || sourceSettings.orgId || sourceSettings.org_id || sourceRegistry.orgId || sourceRegistry.org_id || '').trim();
  const corpId = String(sourceProfile.corpId || sourceSettings.corpId || sourceSettings.corp_id || sourceRegistry.corpId || sourceRegistry.corp_id || '').trim();
  const linkedSites = {
    ...(sourceSettings.linkedSites || {}),
    ...(sourceProfile.linkedSites || {}),
    ...(sourceRegistry.linkedSites || {})
  };

  const linkedIds = new Set(Object.keys(linkedSites).map((id) => String(id || '').trim()).filter(Boolean));
  Object.entries(registry).forEach(([siteId, entry]) => {
    if (siteId === workspaceId || !entry || typeof entry !== 'object') return;
    const sameOrg = Boolean(orgId && String(entry.orgId || entry.org_id || '').trim() === orgId);
    const sameCorp = Boolean(corpId && String(entry.corpId || entry.corp_id || '').trim() === corpId);
    if (sameOrg || sameCorp) linkedIds.add(siteId);
  });

  const linkedProfiles = await Promise.all([...linkedIds]
    .filter((siteId) => siteId && siteId !== workspaceId)
    .map((siteId) => buildLinkedTransferProfile(siteId, registry[siteId] || {})));

  return {
    status: 'ready',
    workspaceId,
    orgId,
    corpId,
    linkedProfiles: linkedProfiles
      .filter(Boolean)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
  };
});

exports.sendLowStockSummaryNow = onCall({
  region: REGION,
  timeoutSeconds: 120,
  memory: '512MiB',
  secrets: [
    gmailUserSecret,
    gmailAppPasswordSecret,
    emailFromSecret
  ]
}, async (request) => {
  const { uid } = await requireSuperUser(request.auth);
  const workspaceId = String(request.data?.workspaceId || '').trim();
  if (!workspaceId) throw new HttpsError('invalid-argument', 'workspaceId is required.');

  const dataPath = getWorkspaceDataPath(workspaceId);
  const rootSnapshot = await rtdb.ref(dataPath).get();
  if (!rootSnapshot.exists()) throw new HttpsError('not-found', 'Workspace data was not found.');

  const root = rootSnapshot.val() || {};
  const settings = root.settings || {};
  const workspaceName = String(settings.siteName || request.data?.workspaceName || workspaceId).trim();
  const recipients = getLowStockEmailRecipients(root.team || {});
  const rows = buildWorkspaceLowStockRows(root);
  const checkedAt = new Date().toISOString();

  if (!recipients.length) {
    await rtdb.ref(`${dataPath}/settings`).update({
      lowStockEmailLastCheckedAt: checkedAt,
      lowStockEmailLastResult: 'manual-no-tagged-recipients',
      lowStockEmailLastTriggeredBy: uid
    });
    return { workspaceId, status: 'no_recipients', recipients: 0, lowStockCount: rows.length };
  }

  if (!rows.length) {
    await rtdb.ref(`${dataPath}/settings`).update({
      lowStockEmailLastSentAt: checkedAt,
      lowStockEmailLastCheckedAt: checkedAt,
      lowStockEmailLastResult: 'manual-no-low-stock',
      lowStockEmailLastRecipientCount: recipients.length,
      lowStockEmailLastLowStockCount: 0,
      lowStockEmailLastTriggeredBy: uid
    });
    return { workspaceId, status: 'no_low_stock', recipients: recipients.length, lowStockCount: 0 };
  }

  const transporter = createGmailTransporter();
  const frequencyLabel = 'Manual test';
  const pdfBuffer = buildLowStockSummaryPdf({
    workspaceName,
    frequencyLabel,
    generatedAt: checkedAt,
    rows
  });
  const message = buildLowStockSummaryEmailMessage({
    workspaceName,
    frequencyLabel,
    generatedAt: checkedAt,
    recipients,
    rows,
    pdfBuffer
  });
  const result = await transporter.sendMail(message);
  const logKey = rtdb.ref().push().key;

  await rtdb.ref().update({
    [`${dataPath}/settings/lowStockEmailLastSentAt`]: checkedAt,
    [`${dataPath}/settings/lowStockEmailLastCheckedAt`]: checkedAt,
    [`${dataPath}/settings/lowStockEmailLastResult`]: 'manual-sent',
    [`${dataPath}/settings/lowStockEmailLastRecipientCount`]: recipients.length,
    [`${dataPath}/settings/lowStockEmailLastLowStockCount`]: rows.length,
    [`${dataPath}/settings/lowStockEmailLastTriggeredBy`]: uid,
    [`${dataPath}/logs_low_stock_emails/${logKey}`]: {
      sentAt: checkedAt,
      frequency: 'manual',
      recipientCount: recipients.length,
      lowStockCount: rows.length,
      messageId: result.messageId || '',
      source: 'admin-manual-low-stock-summary',
      triggeredBy: uid,
      triggeredByEmail: request.auth?.token?.email || ''
    }
  });

  return {
    workspaceId,
    status: 'sent',
    recipients: recipients.length,
    lowStockCount: rows.length,
    messageId: result.messageId || ''
  };
});

exports.createExternalTransfer = onCall({
  region: REGION,
  timeoutSeconds: 120,
  memory: '512MiB'
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before creating an external transfer.');

  const payload = normalizeExternalTransferPayload(request.data || {});
  const fromSiteId = requireText(payload.fromSiteId, 'from_site_id is required.');
  const toSiteId = requireText(payload.toSiteId, 'to_site_id is required.');
  if (fromSiteId === toSiteId) throw new HttpsError('invalid-argument', 'External transfers require two different site profiles.');
  if (!payload.fromLocationId || !payload.toLocationId) throw new HttpsError('invalid-argument', 'Choose source and receiving locations.');
  if (!payload.items.length) throw new HttpsError('invalid-argument', 'Add at least one transfer item.');

  await requireTransferAgent(uid, fromSiteId);

  const [fromProfile, toProfile, fromData, toData] = await Promise.all([
    loadTransferSiteProfile(fromSiteId),
    loadTransferSiteProfile(toSiteId),
    loadTransferSiteData(fromSiteId),
    loadTransferSiteData(toSiteId)
  ]);

  validateExternalTransferLink(fromSiteId, toSiteId, fromProfile.profile, toProfile.profile);
  const fromLocation = findTransferLocation(fromData.locations, payload.fromLocationId);
  const toLocation = findTransferLocation(toData.locations, payload.toLocationId);
  if (!fromLocation) throw new HttpsError('failed-precondition', 'Source location does not exist on the source site.');
  if (!toLocation) throw new HttpsError('failed-precondition', 'Receiving location does not exist on the receiving site.');

  const now = new Date().toISOString();
  const transferId = createId('xtf');
  const outboundItems = [];
  let stockValidationError = '';

  try {
    const transactionResult = await rtdb.ref(fromData.ingredientsPath).transaction((current) => {
      const items = normalizeList(current);
      const itemMap = new Map(items.map((item, index) => [String(item.id || ''), index]));
      const nextOutbound = [];

      for (const line of payload.items) {
        const index = itemMap.get(String(line.stockItemId || ''));
        if (index === undefined) continue;
        const item = items[index];
        const qty = Number(line.quantity || 0) || 0;
        if (!(qty > 0)) continue;
        const balances = normalizeBalances(item.balances);
        const fromBalanceKey = seedBalanceFromStockIfNeeded(balances, item, payload.fromLocationId, fromData.locations);
        const fromBefore = Number(balances[fromBalanceKey] || 0) || 0;
        if (fromBefore < qty && payload.allowNegative !== true) {
          stockValidationError = `Insufficient stock for ${item.name || line.stockItemId}. Available ${fromBefore}, requested ${qty}.`;
          return undefined;
        }
        balances[fromBalanceKey] = fromBefore - qty;
        items[index] = {
          ...item,
          balances,
          stock: sumBalances(balances),
          updatedAt: now
        };
        const receivingItem = findReceivingStockItem(toData.ingredients, {
          ...line,
          ...item,
          name: item.name || line.stockItemName || line.stockItemId,
          unit: item.unit || line.unit || ''
        }, line.targetStockItemId || line.stockItemId);
        const receivingBalances = normalizeBalances(receivingItem?.balances);
        nextOutbound.push({
          stockItemId: String(item.id || line.stockItemId),
          targetStockItemId: String(receivingItem?.id || line.targetStockItemId || item.id || line.stockItemId),
          name: item.name || line.stockItemName || line.stockItemId,
          unit: item.unit || line.unit || '',
          category: item.category || line.category || '',
          sku: item.sku || item.SKU || line.sku || '',
          code: item.code || item.itemCode || item.stockCode || line.code || '',
          barcodes: normalizeStringList(item.barcodes || item.barcode || item.Barcode || line.barcodes || line.barcode),
          cost: Number(item.cost || item.price || 0) || 0,
          shippedQty: qty,
          requestedQty: qty,
          receivedQty: null,
          fromBalanceBefore: fromBefore,
          toBalanceBefore: Number(receivingBalances[payload.toLocationId] || 0) || 0
        });
      }

      outboundItems.splice(0, outboundItems.length, ...nextOutbound);
      return items;
    });
    if (stockValidationError) throw new HttpsError('failed-precondition', stockValidationError);
    if (!transactionResult.committed) throw new HttpsError('aborted', 'External transfer was not committed. Please refresh stock and try again.');
  } catch (error) {
    throw toTransferHttpsError(error);
  }

  if (!outboundItems.length) throw new HttpsError('failed-precondition', 'No matching stock items were found on the source site.');

  const transfer = {
    id: transferId,
    transferId,
    status: 'pending_receipt',
    transferType: 'external',
    createdAt: now,
    updatedAt: now,
    createdBy: uid,
    fromSiteId,
    fromSiteName: fromProfile.name,
    toSiteId,
    toSiteName: toProfile.name,
    fromLocationId: fromLocation.id,
    fromLocationName: fromLocation.name,
    toLocationId: toLocation.id,
    toLocationName: toLocation.name,
    note: payload.note || '',
    lineCount: outboundItems.length,
    items: outboundItems
  };

  const updates = {
    [`workspaces/${fromSiteId}/data/externalTransfers/${transferId}`]: { ...transfer, direction: 'outbound' },
    [`workspaces/${toSiteId}/data/externalTransfers/${transferId}`]: { ...transfer, direction: 'inbound' },
    [`workspaces/${fromSiteId}/data/inTransitStock/${transferId}`]: transfer
  };
  await rtdb.ref().update(updates);
  await Promise.all([
    appendExternalTransferLog(fromSiteId, { ...transfer, transferType: 'external_out_pending', direction: 'outbound' }),
    appendExternalTransferLog(toSiteId, { ...transfer, transferType: 'external_in_pending', direction: 'inbound' })
  ]);

  return { status: 'pending_receipt', transferId, transfer_id: transferId, items_moved: outboundItems.length };
});

exports.acceptExternalTransfer = onCall({
  region: REGION,
  timeoutSeconds: 120,
  memory: '512MiB'
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before accepting an external transfer.');

  const transferId = requireText(request.data?.transferId || request.data?.transfer_id, 'transferId is required.');
  const workspaceId = requireText(request.data?.workspaceId || request.data?.siteId || request.data?.toSiteId, 'workspaceId is required.');
  await requireTransferAgent(uid, workspaceId);

  const transferSnap = await rtdb.ref(`workspaces/${workspaceId}/data/externalTransfers/${transferId}`).get();
  const transfer = transferSnap.val() || {};
  if (!transferSnap.exists()) throw new HttpsError('not-found', 'Pending external transfer was not found.');
  if (String(transfer.toSiteId || '') !== workspaceId) throw new HttpsError('permission-denied', 'Only the receiving site can accept this transfer.');
  if (transfer.status !== 'pending_receipt') throw new HttpsError('failed-precondition', 'This transfer is no longer pending receipt.');

  const receivedByStockId = new Map(normalizeReceivedItems(request.data?.items).map((item) => [String(item.stockItemId), item]));
  const now = new Date().toISOString();
  const acceptedItems = (Array.isArray(transfer.items) ? transfer.items : Object.values(transfer.items || {})).map((item) => {
    const receivedLine = receivedByStockId.get(String(item.stockItemId || item.id || ''));
    const receivedQty = receivedLine ? Math.max(Number(receivedLine.receivedQty || receivedLine.quantity || 0), 0) : Number(item.shippedQty || item.quantity || 0) || 0;
    return {
      ...item,
      receivedQty,
      varianceQty: receivedQty - (Number(item.shippedQty || item.quantity || 0) || 0)
    };
  });

  const toLocationId = String(transfer.toLocationId || '').trim();
  if (!toLocationId) throw new HttpsError('failed-precondition', 'Receiving location is missing from this transfer.');

  await rtdb.ref(`workspaces/${workspaceId}/data/ingredients`).transaction((current) => {
    const items = normalizeList(current);
    const itemMap = new Map(items.map((item, index) => [String(item.id || ''), index]));
    for (const line of acceptedItems) {
      const qty = Number(line.receivedQty || 0) || 0;
      if (!(qty > 0)) continue;
      let targetId = String(line.targetStockItemId || line.stockItemId || '').trim();
      if (!targetId) continue;
      let index = itemMap.get(targetId);
      if (index === undefined) {
        index = findReceivingStockItemIndex(items, line, targetId);
        if (index !== undefined) targetId = String(items[index]?.id || targetId);
      }
      if (index === undefined) {
        index = items.length;
        items.push(createReceivingStockItem(line, targetId, now));
        itemMap.set(targetId, index);
      }
      const item = items[index];
      const balances = normalizeBalances(item.balances);
      seedBalanceFromStockIfNeeded(balances, item, toLocationId);
      balances[toLocationId] = (Number(balances[toLocationId] || 0) || 0) + qty;
      items[index] = {
        ...item,
        balances,
        stock: sumBalances(balances),
        updatedAt: now
      };
    }
    return items;
  });

  const nextTransfer = {
    ...transfer,
    status: 'accepted',
    acceptedAt: now,
    acceptedBy: uid,
    updatedAt: now,
    items: acceptedItems
  };
  const updates = {
    [`workspaces/${transfer.fromSiteId}/data/externalTransfers/${transferId}/status`]: 'accepted',
    [`workspaces/${transfer.fromSiteId}/data/externalTransfers/${transferId}/acceptedAt`]: now,
    [`workspaces/${transfer.fromSiteId}/data/externalTransfers/${transferId}/acceptedBy`]: uid,
    [`workspaces/${transfer.fromSiteId}/data/externalTransfers/${transferId}/updatedAt`]: now,
    [`workspaces/${transfer.fromSiteId}/data/externalTransfers/${transferId}/items`]: acceptedItems,
    [`workspaces/${workspaceId}/data/externalTransfers/${transferId}`]: { ...nextTransfer, direction: 'inbound' },
    [`workspaces/${transfer.fromSiteId}/data/inTransitStock/${transferId}`]: null
  };
  await rtdb.ref().update(updates);
  await Promise.all([
    appendExternalTransferLog(workspaceId, { ...nextTransfer, transferType: 'external_in_accepted', direction: 'inbound' }),
    appendExternalTransferLog(transfer.fromSiteId, { ...nextTransfer, transferType: 'external_out_received', direction: 'outbound' })
  ]);

  return { status: 'accepted', transferId, transfer_id: transferId, items_received: acceptedItems.length };
});

exports.mirrorSiteOrgLinks = onDocumentWritten({
  region: REGION,
  document: 'sites/{siteId}'
}, async (event) => {
  const siteId = String(event.params.siteId || '').trim();
  if (!siteId) return;
  if (!event.data?.after.exists) {
    await Promise.all([
      mirrorOrgUnlinkToRealtime({ siteId, linkType: 'org' }),
      mirrorOrgUnlinkToRealtime({ siteId, linkType: 'corp' })
    ]);
    return;
  }

  const before = event.data?.before?.exists ? (event.data.before.data() || {}) : {};
  const data = event.data.after.data() || {};
  const basePayload = {
    siteIds: [siteId],
    groupName: data.groupMetadata?.name || '',
    permissionLevel: data.permissionLevel || 'full_transfer',
    viewingOnly: data.viewingOnly === true,
    uid: data.updatedBy || data.groupMetadata?.linkedBy || 'firestore-sync',
    email: data.groupMetadata?.linkedByEmail || ''
  };
  const mirrorJobs = [];
  const beforeOrgId = String(before.orgId || '').trim();
  const beforeCorpId = String(before.corpId || '').trim();
  const afterOrgId = String(data.orgId || '').trim();
  const afterCorpId = String(data.corpId || '').trim();

  if (afterOrgId) {
    mirrorJobs.push(mirrorOrgGroupToRealtime({ ...basePayload, linkType: 'org', linkId: afterOrgId }));
  } else if (beforeOrgId) {
    mirrorJobs.push(mirrorOrgUnlinkToRealtime({ siteId, linkType: 'org' }));
  }

  if (afterCorpId) {
    mirrorJobs.push(mirrorOrgGroupToRealtime({ ...basePayload, linkType: 'corp', linkId: afterCorpId }));
  } else if (beforeCorpId) {
    mirrorJobs.push(mirrorOrgUnlinkToRealtime({ siteId, linkType: 'corp' }));
  }

  await Promise.all(mirrorJobs);
});

function buildSiteRow(siteId, data) {
  return {
    id: siteId,
    firestoreId: data.firestoreId || siteId,
    name: data.name || data.siteName || data.workspaceName || siteId,
    orgId: String(data.orgId || data.org_id || '').trim(),
    corpId: String(data.corpId || data.corp_id || '').trim(),
    permissionLevel: data.permissionLevel || (data.viewingOnly ? 'corporate_view_only' : 'full_transfer'),
    viewingOnly: data.viewingOnly === true,
    groupMetadata: data.groupMetadata || null,
    source: data.source || 'registry'
  };
}

async function requireSuperUser(auth) {
  const uid = auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before running organization admin actions.');

  const snapshot = await rtdb.ref(`adminConfig/superusers/${uid}`).get();
  if (!snapshot.exists()) {
    throw new HttpsError('permission-denied', 'Only configured superusers can manage organization links.');
  }

  return { uid };
}

async function requireSiteViewer(auth, siteId) {
  const uid = auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before loading organization data.');

  const [superUserSnap, teamSnap, profileSnap] = await Promise.all([
    rtdb.ref(`adminConfig/superusers/${uid}`).get(),
    rtdb.ref(`workspaces/${siteId}/data/team/${uid}`).get(),
    rtdb.ref(`users/${uid}/profile/workspaces/${siteId}`).get()
  ]);

  if (superUserSnap.exists() || teamSnap.exists() || profileSnap.exists()) return { uid };
  throw new HttpsError('permission-denied', 'You do not have access to this site profile.');
}

async function buildLinkedTransferProfile(siteId, registryEntry = {}) {
  const [settingsSnap, locationsSnap, ingredientsSnap, workspaceSnap] = await Promise.all([
    rtdb.ref(`workspaces/${siteId}/data/settings`).get(),
    rtdb.ref(`workspaces/${siteId}/data/locations`).get(),
    rtdb.ref(`workspaces/${siteId}/data/ingredients`).get(),
    rtdb.ref(`workspaces/${siteId}`).get()
  ]);
  if (!workspaceSnap.exists()) return null;

  const settings = settingsSnap.val() || {};
  const workspace = workspaceSnap.val() || {};
  const locations = normalizeSellingLocations(locationsSnap.val());
  return {
    id: siteId,
    name: String(settings.siteName || settings.businessName || workspace.siteName || workspace.name || registryEntry.name || registryEntry.siteName || siteId).trim(),
    orgId: String(settings.orgId || settings.org_id || registryEntry.orgId || registryEntry.org_id || '').trim(),
    corpId: String(settings.corpId || settings.corp_id || registryEntry.corpId || registryEntry.corp_id || '').trim(),
    permissionLevel: registryEntry.permissionLevel || settings.permissionLevel || 'full_transfer',
    viewingOnly: registryEntry.viewingOnly === true || settings.viewingOnly === true,
    locations,
    stockItems: normalizeTransferStockItems(ingredientsSnap.val())
  };
}

function normalizeSellingLocations(value) {
  const entries = normalizeList(value)
    .map((location) => {
      const type = String(location.type || location.locationType || '').trim().toLowerCase();
      return {
        id: String(location.id || location.locationId || '').trim(),
        name: String(location.name || location.displayName || location.label || location.locationName || location.id || '').trim(),
        type: type || 'selling',
        active: location.active !== false && location.deleted !== true && location.archived !== true
      };
    })
    .filter((location) => location.id && location.name && location.active)
    .sort((a, b) => a.name.localeCompare(b.name));

  return entries.length ? entries : [{ id: 'main', name: 'Main Store', type: 'selling', active: true }];
}

function normalizeTransferStockItems(value) {
  return normalizeList(value)
    .map((item) => ({
      id: String(item.id || '').trim(),
      name: String(item.name || item.ingredientName || item.itemName || '').trim(),
      category: String(item.category || '').trim(),
      unit: String(item.unit || item.uom || '').trim(),
      sku: String(item.sku || item.SKU || '').trim(),
      code: String(item.code || item.itemCode || item.stockCode || '').trim(),
      barcodes: normalizeStringList(item.barcodes || item.barcode || item.Barcode),
      stock: Number(item.stock || 0) || 0,
      balances: normalizeBalances(item.balances)
    }))
    .filter((item) => item.id && item.name);
}

async function requireTransferAgent(uid, siteId) {
  const [superUserSnap, teamSnap, profileSnap] = await Promise.all([
    rtdb.ref(`adminConfig/superusers/${uid}`).get(),
    rtdb.ref(`workspaces/${siteId}/data/team/${uid}`).get(),
    rtdb.ref(`users/${uid}/profile/workspaces/${siteId}`).get()
  ]);
  if (superUserSnap.exists()) return { uid, role: 'superuser' };
  const team = teamSnap.val() || {};
  const profile = profileSnap.val() || {};
  const role = normalizeRole(team.role || profile.role || '');
  const viewingOnly = team.viewingOnly === true || profile.viewingOnly === true || team.viewOnly === true || profile.viewOnly === true;
  if (!teamSnap.exists() && !profileSnap.exists()) throw new HttpsError('permission-denied', 'You do not have access to this site profile.');
  if (viewingOnly) throw new HttpsError('permission-denied', 'Viewing-only users cannot post stock transfers.');
  if (!TRANSFER_AGENT_ROLES.has(role)) throw new HttpsError('permission-denied', 'Only Transfer Agent users can post external stock transfers.');
  return { uid, role };
}

async function loadTransferSiteProfile(siteId) {
  const [workspaceSnap, profileSnap, settingsSnap, registrySnap] = await Promise.all([
    rtdb.ref(`workspaces/${siteId}`).get(),
    rtdb.ref(`workspaces/${siteId}/profile`).get(),
    rtdb.ref(`workspaces/${siteId}/data/settings`).get(),
    rtdb.ref(`adminConfig/registry/${siteId}`).get()
  ]);
  const workspace = workspaceSnap.val() || {};
  const profile = profileSnap.val() || {};
  const settings = settingsSnap.val() || {};
  const registry = registrySnap.val() || {};
  return {
    exists: workspaceSnap.exists(),
    name: String(settings.siteName || settings.businessName || workspace.siteName || workspace.name || registry.name || registry.siteName || siteId).trim(),
    profile: {
      ...profile,
      orgId: String(profile.orgId || settings.orgId || settings.org_id || registry.orgId || registry.org_id || '').trim(),
      corpId: String(profile.corpId || settings.corpId || settings.corp_id || registry.corpId || registry.corp_id || '').trim(),
      linkedSites: {
        ...(settings.linkedSites || {}),
        ...(profile.linkedSites || {}),
        ...(registry.linkedSites || {})
      }
    }
  };
}

async function loadTransferSiteData(siteId) {
  const rootPath = `workspaces/${siteId}/data`;
  const [settingsSnap, locationsSnap, ingredientsSnap] = await Promise.all([
    rtdb.ref(`${rootPath}/settings`).get(),
    rtdb.ref(`${rootPath}/locations`).get(),
    rtdb.ref(`${rootPath}/ingredients`).get()
  ]);
  return {
    siteId,
    rootPath,
    settings: settingsSnap.val() || {},
    ingredientsPath: `${rootPath}/ingredients`,
    ingredients: normalizeList(ingredientsSnap.val()),
    locations: normalizeSellingLocations(locationsSnap.val())
  };
}

function validateExternalTransferLink(fromSiteId, toSiteId, fromProfile = {}, toProfile = {}) {
  const sharedOrg = Boolean(fromProfile.orgId && toProfile.orgId && String(fromProfile.orgId) === String(toProfile.orgId));
  const sharedCorp = Boolean(fromProfile.corpId && toProfile.corpId && String(fromProfile.corpId) === String(toProfile.corpId));
  const explicitLink = Boolean(fromProfile.linkedSites?.[toSiteId] || toProfile.linkedSites?.[fromSiteId]);
  if (!sharedOrg && !sharedCorp && !explicitLink) {
    throw new HttpsError('failed-precondition', 'External transfers require both site profiles to share an Org ID or Corp ID.');
  }
}

function normalizeExternalTransferPayload(payload = {}) {
  return {
    fromSiteId: String(payload.from_site_id || payload.fromSiteId || '').trim(),
    toSiteId: String(payload.to_site_id || payload.toSiteId || '').trim(),
    fromLocationId: String(payload.from_location_id || payload.fromLocationId || '').trim(),
    toLocationId: String(payload.to_location_id || payload.toLocationId || '').trim(),
    note: String(payload.note || '').trim(),
    allowNegative: payload.allow_negative === true || payload.allowNegative === true,
    items: normalizeList(payload.items).map((item) => ({
      stockItemId: String(item.stock_item_id || item.stockItemId || item.item_id || item.itemId || item.id || '').trim(),
      targetStockItemId: String(item.target_stock_item_id || item.targetStockItemId || item.stock_item_id || item.stockItemId || item.id || '').trim(),
      stockItemName: String(item.stockItemName || item.itemName || item.name || '').trim(),
      quantity: Math.max(Number(item.quantity || item.qty || 0), 0),
      unit: String(item.unit || '').trim()
    })).filter((item) => item.stockItemId && item.quantity > 0)
  };
}

function normalizeReceivedItems(value) {
  return normalizeList(value).map((item) => ({
    stockItemId: String(item.stock_item_id || item.stockItemId || item.id || '').trim(),
    receivedQty: Math.max(Number(item.received_qty ?? item.receivedQty ?? item.quantity ?? item.qty ?? 0), 0)
  })).filter((item) => item.stockItemId);
}

function findTransferLocation(locations = [], locationId = '') {
  return (locations || []).find((location) => String(location.id) === String(locationId)) || null;
}

function normalizeBalances(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function seedBalanceFromStockIfNeeded(balances, item, locationId, locations = []) {
  if (!locationId) return locationId;
  const balanceKey = resolveTransferBalanceKey(balances, locationId, locations);
  const stock = Number(item.stock || 0) || 0;
  const balanceKeys = Object.keys(balances || {});
  const balanceTotal = sumBalances(balances);
  if (
    !Object.prototype.hasOwnProperty.call(balances, balanceKey) &&
    balanceKeys.length === 1 &&
    isDefaultTransferLocation(findTransferLocation(locations, locationId)) &&
    isLegacyDefaultBalanceKey(balanceKeys[0]) &&
    stock &&
    Math.abs(stock - balanceTotal) < 0.0001
  ) {
    const legacyKey = balanceKeys[0];
    balances[balanceKey] = Number(balances[legacyKey] || 0) || 0;
    delete balances[legacyKey];
    return balanceKey;
  }
  if (stock > balanceTotal) {
    balances[balanceKey] = (Number(balances[balanceKey] || 0) || 0) + (stock - balanceTotal);
  }
  return balanceKey;
}

function sumBalances(balances = {}) {
  return Object.values(balances).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function resolveTransferBalanceKey(balances = {}, locationId = '', locations = []) {
  const location = findTransferLocation(locations, locationId);
  const candidates = [
    locationId,
    location?.id,
    location?.locationId,
    location?.name,
    location?.displayName,
    location?.label,
    location?.yocoLocationId,
    location?.yocoStoreLocationId
  ];
  if (isDefaultTransferLocation(location)) {
    candidates.push('main', 'default', 'Main Store', 'Main Storage', 'Main Location');
  }
  const cleanCandidates = [...new Set(candidates.map((value) => String(value || '').trim()).filter(Boolean))];
  for (const candidate of cleanCandidates) {
    if (Object.prototype.hasOwnProperty.call(balances, candidate)) return candidate;
  }
  const normalizedCandidates = new Set(cleanCandidates.map(normalizeTransferLocationKey).filter(Boolean));
  const match = Object.keys(balances || {}).find((balanceKey) => normalizedCandidates.has(normalizeTransferLocationKey(balanceKey)));
  return match || String(locationId || '').trim();
}

function isDefaultTransferLocation(location = {}) {
  if (!location || typeof location !== 'object') return false;
  return location.isDefault === true ||
    location.default === true ||
    normalizeTransferLocationKey(location.id || location.locationId) === 'main' ||
    ['mainstore', 'mainstorage', 'mainlocation'].includes(normalizeTransferLocationKey(location.name || location.displayName || location.label));
}

function isLegacyDefaultBalanceKey(value = '') {
  return ['main', 'default', 'mainstore', 'mainstorage', 'mainlocation'].includes(normalizeTransferLocationKey(value));
}

function normalizeTransferLocationKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function createReceivingStockItem(sourceItem = {}, id = '', now = new Date().toISOString()) {
  return {
    id: id || sourceItem.stockItemId || createId('item'),
    name: sourceItem.name || sourceItem.stockItemName || id,
    unit: sourceItem.unit || '',
    cost: Number(sourceItem.cost || 0) || 0,
    stock: 0,
    balances: {},
    source: 'external_transfer',
    createdAt: now,
    updatedAt: now
  };
}

function findReceivingStockItem(items = [], sourceLine = {}, preferredId = '') {
  const index = findReceivingStockItemIndex(items, sourceLine, preferredId);
  return index === undefined ? null : items[index];
}

function findReceivingStockItemIndex(items = [], sourceLine = {}, preferredId = '') {
  const cleanPreferredId = String(preferredId || '').trim();
  if (cleanPreferredId) {
    const exactIndex = items.findIndex((item) => String(item.id || '') === cleanPreferredId);
    if (exactIndex >= 0) return exactIndex;
  }

  const candidateIds = [
    sourceLine.targetStockItemId,
    sourceLine.stockItemId,
    sourceLine.id
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const idIndex = items.findIndex((item) => candidateIds.includes(String(item.id || '').trim()));
  if (idIndex >= 0) return idIndex;

  const candidateCodes = [
    sourceLine.code,
    sourceLine.itemCode,
    sourceLine.stockCode,
    sourceLine.sku,
    sourceLine.SKU
  ].map(normalizeMatchKey).filter(Boolean);
  if (candidateCodes.length) {
    const codeIndex = items.findIndex((item) => {
      const itemCodes = [item.code, item.itemCode, item.stockCode, item.sku, item.SKU]
        .map(normalizeMatchKey)
        .filter(Boolean);
      return itemCodes.some((code) => candidateCodes.includes(code));
    });
    if (codeIndex >= 0) return codeIndex;
  }

  const candidateBarcodes = new Set(normalizeStringList(sourceLine.barcodes || sourceLine.barcode || sourceLine.Barcode).map(normalizeMatchKey).filter(Boolean));
  if (candidateBarcodes.size) {
    const barcodeIndex = items.findIndex((item) => normalizeStringList(item.barcodes || item.barcode || item.Barcode)
      .map(normalizeMatchKey)
      .some((barcode) => candidateBarcodes.has(barcode)));
    if (barcodeIndex >= 0) return barcodeIndex;
  }

  const sourceName = normalizeMatchKey(sourceLine.name || sourceLine.stockItemName || sourceLine.itemName);
  const sourceUnit = normalizeMatchKey(sourceLine.unit || sourceLine.uom);
  if (!sourceName) return undefined;
  const nameIndex = items.findIndex((item) => (
    normalizeMatchKey(item.name || item.ingredientName || item.itemName) === sourceName &&
    (!sourceUnit || !normalizeMatchKey(item.unit || item.uom) || normalizeMatchKey(item.unit || item.uom) === sourceUnit)
  ));
  return nameIndex >= 0 ? nameIndex : undefined;
}

function normalizeStringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  if (typeof value === 'object') return Object.values(value).map((entry) => String(entry || '').trim()).filter(Boolean);
  return String(value).split(/[,;\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function normalizeMatchKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

async function appendExternalTransferLog(siteId, entry = {}) {
  const id = entry.id || entry.transferId || createId('xtf_log');
  await rtdb.ref(`workspaces/${siteId}/data/logs_transfers/${id}_${Date.now()}`).set({
    ...entry,
    id,
    timestamp: entry.timestamp || entry.updatedAt || new Date().toISOString(),
    date: String(entry.date || entry.createdAt || new Date().toISOString()).slice(0, 10)
  });
}

function toTransferHttpsError(error) {
  if (error instanceof HttpsError) return error;
  const message = error?.message || String(error);
  if (/insufficient stock/i.test(message)) return new HttpsError('failed-precondition', message);
  return new HttpsError('internal', message);
}

function normalizeRole(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function requireText(value, message) {
  const text = String(value || '').trim();
  if (!text) throw new HttpsError('invalid-argument', message);
  return text;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
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

function getWorkspaceDataPath(workspaceId) {
  if (workspaceId === 'appData' || workspaceId === 'appData_legacy' || workspaceId === 'ROOT_WORKSPACE') return 'appData';
  return `workspaces/${workspaceId}/data`;
}

function getLowStockEmailRecipients(team) {
  const recipients = new Map();
  Object.values(team || {}).forEach((member) => {
    if (!member || typeof member !== 'object') return;
    if (!isLowStockTaggedMember(member)) return;
    const email = String(member.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    recipients.set(email, {
      email,
      name: String(member.name || `${member.firstName || ''} ${member.surname || ''}`.trim() || email.split('@')[0]).trim()
    });
  });
  return [...recipients.values()];
}

function isLowStockTaggedMember(member) {
  if (member.lowStockAlert === true || member.lowStockAlertTag === true) return true;
  const tags = member.tags;
  if (Array.isArray(tags)) {
    return tags.some((tag) => ['low stock alert', 'low-stock-alert', 'low_stock_alert', 'lowstockalert'].includes(String(tag || '').trim().toLowerCase()));
  }
  if (tags && typeof tags === 'object') {
    return tags.lowStockAlert === true ||
      tags.lowStockAlertTag === true ||
      tags.low_stock_alert === true ||
      tags['low-stock-alert'] === true;
  }
  return false;
}

function buildWorkspaceLowStockRows(root) {
  const locations = normalizeList(root.locations);
  const locationMap = new Map(locations.map((location) => [String(location.id || '').trim(), String(location.name || location.id || 'Location').trim()]));
  const rows = [];

  normalizeList(root.ingredients).forEach((item) => {
    if (!item || item.deleted === true || item.archived === true || item.active === false) return;
    const name = String(item.name || item.itemName || item.label || '').trim();
    if (!name) return;

    const threshold = Number(item.lowStockThreshold ?? item.threshold ?? item.parLevel ?? 5);
    const par = Number.isFinite(threshold) ? threshold : 5;
    const unit = String(item.unit || item.uom || item.unitOfMeasure || '').trim();
    const category = String(item.category || 'General').trim();
    const unitCost = Number(item.costEx ?? item.unitCost ?? item.cost ?? item.lastPurchasePrice ?? 0) || 0;
    const balances = item.balances && typeof item.balances === 'object' ? item.balances : null;
    const balanceEntries = balances
      ? Object.entries(balances).filter(([locationId]) => !['all', 'total', 'workspace', 'workspace_total'].includes(String(locationId || '').toLowerCase()))
      : [];

    if (balanceEntries.length) {
      balanceEntries.forEach(([locationId, quantity]) => {
        addLowStockRow(rows, {
          item,
          name,
          category,
          unit,
          unitCost,
          locationId,
          locationName: locationMap.get(String(locationId)) || String(locationId || 'Location'),
          currentStock: Number(quantity) || 0,
          threshold: par
        });
      });
      return;
    }

    addLowStockRow(rows, {
      item,
      name,
      category,
      unit,
      unitCost,
      locationId: '',
      locationName: 'Workspace Total',
      currentStock: Number(item.stock ?? item.onHand ?? 0) || 0,
      threshold: par
    });
  });

  return rows.sort((left, right) => {
    const severityOrder = { Critical: 0, Medium: 1, Low: 2 };
    if (severityOrder[left.severity] !== severityOrder[right.severity]) return severityOrder[left.severity] - severityOrder[right.severity];
    if (left.variance !== right.variance) return left.variance - right.variance;
    return left.itemName.localeCompare(right.itemName);
  });
}

function addLowStockRow(rows, data) {
  const threshold = Number(data.threshold) || 0;
  const currentStock = Number(data.currentStock) || 0;
  if (!(currentStock < threshold)) return;
  const deficitQty = Math.max(0, threshold - currentStock);
  const severity = currentStock <= 0 || currentStock <= threshold * 0.25
    ? 'Critical'
    : currentStock <= threshold * 0.6
      ? 'Medium'
      : 'Low';

  rows.push({
    itemId: String(data.item?.id || '').trim(),
    itemName: data.name,
    category: data.category,
    locationId: String(data.locationId || '').trim(),
    locationName: data.locationName,
    currentStock,
    threshold,
    variance: currentStock - threshold,
    deficitQty,
    deficitValue: deficitQty * (Number(data.unitCost) || 0),
    unit: data.unit,
    severity
  });
}

function buildLowStockSummaryEmailMessage({ workspaceName, frequencyLabel, generatedAt, recipients, rows, pdfBuffer }) {
  const from = String(emailFromSecret.value() || gmailUserSecret.value() || '').trim();
  if (!from) throw new Error('KCP_EMAIL_FROM is not configured.');

  const topRows = rows.slice(0, 8);
  const subject = `Low stock summary: ${workspaceName} (${rows.length} item${rows.length === 1 ? '' : 's'})`;
  const text = [
    `Low stock summary for ${workspaceName}`,
    `Run type: ${frequencyLabel}`,
    `Generated: ${generatedAt}`,
    '',
    `${rows.length} low-stock row${rows.length === 1 ? '' : 's'} found.`,
    ...topRows.map((row) => `- ${row.itemName} | ${row.locationName} | ${formatQuantity(row.currentStock)} ${row.unit} on hand | threshold ${formatQuantity(row.threshold)} ${row.unit}`),
    '',
    'See the attached PDF for the full list.'
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;max-width:720px">
      <h2 style="margin:0 0 12px;color:#0f172a">Low stock summary</h2>
      <p><strong>${escapeHtml(workspaceName)}</strong> has <strong>${rows.length}</strong> low-stock row${rows.length === 1 ? '' : 's'}.</p>
      <p style="color:#475569">Run type: ${escapeHtml(frequencyLabel)}<br/>Generated: ${escapeHtml(generatedAt)}</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <thead>
          <tr>
            <th style="text-align:left;border-bottom:1px solid #cbd5e1;padding:8px">Item</th>
            <th style="text-align:left;border-bottom:1px solid #cbd5e1;padding:8px">Location</th>
            <th style="text-align:right;border-bottom:1px solid #cbd5e1;padding:8px">On hand</th>
            <th style="text-align:right;border-bottom:1px solid #cbd5e1;padding:8px">Threshold</th>
          </tr>
        </thead>
        <tbody>
          ${topRows.map((row) => `
            <tr>
              <td style="border-bottom:1px solid #e2e8f0;padding:8px">${escapeHtml(row.itemName)}</td>
              <td style="border-bottom:1px solid #e2e8f0;padding:8px">${escapeHtml(row.locationName)}</td>
              <td style="text-align:right;border-bottom:1px solid #e2e8f0;padding:8px">${escapeHtml(formatQuantity(row.currentStock))} ${escapeHtml(row.unit)}</td>
              <td style="text-align:right;border-bottom:1px solid #e2e8f0;padding:8px">${escapeHtml(formatQuantity(row.threshold))} ${escapeHtml(row.unit)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p style="color:#475569">The attached PDF includes the full low-stock report.</p>
    </div>
  `;

  return {
    from,
    to: recipients.map((recipient) => recipient.email).join(', '),
    subject,
    text,
    html,
    attachments: [
      {
        filename: `KCP_Low_Stock_${slugifyForKey(workspaceName)}_${generatedAt.slice(0, 10)}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      }
    ]
  };
}

function buildLowStockSummaryPdf({ workspaceName, frequencyLabel, generatedAt, rows }) {
  const lines = [
    'Kitchen Cost Pro - Low Stock Summary',
    `Workspace: ${workspaceName}`,
    `Run type: ${frequencyLabel}`,
    `Generated: ${generatedAt}`,
    `Rows: ${rows.length}`,
    '',
    padPdfColumns(['Item', 'Location', 'Stock', 'Threshold', 'Deficit', 'Severity'], [22, 18, 10, 10, 10, 10]),
    ''.padEnd(86, '-')
  ];

  rows.forEach((row) => {
    lines.push(padPdfColumns([
      row.itemName,
      row.locationName,
      `${formatQuantity(row.currentStock)} ${row.unit}`,
      `${formatQuantity(row.threshold)} ${row.unit}`,
      `${formatQuantity(row.deficitQty)} ${row.unit}`,
      row.severity
    ], [22, 18, 10, 10, 10, 10]));
  });

  return buildSimplePdf(lines);
}

function buildSimplePdf(lines) {
  const pageLineLimit = 38;
  const pages = [];
  for (let index = 0; index < lines.length; index += pageLineLimit) pages.push(lines.slice(index, index + pageLineLimit));
  if (!pages.length) pages.push(['Kitchen Cost Pro - Low Stock Summary', 'No low-stock items found.']);

  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = addObject('');
  const pagesId = addObject('');
  const pageIds = [];

  pages.forEach((pageLines, pageIndex) => {
    const body = [
      'BT',
      '/F1 10 Tf',
      '50 800 Td',
      ...pageLines.map((line, lineIndex) => `${lineIndex === 0 ? '' : '0 -18 Td\n'}(${pdfEscape(String(line || '').slice(0, 112))}) Tj`),
      `0 -24 Td\n(Page ${pageIndex + 1} of ${pages.length}) Tj`,
      'ET'
    ].join('\n');
    const contentId = addObject(`<< /Length ${Buffer.byteLength(body, 'utf8')} >>\nstream\n${body}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  });

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

function padPdfColumns(values, widths) {
  return values.map((value, index) => String(value || '').slice(0, widths[index]).padEnd(widths[index], ' ')).join('  ');
}

function pdfEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function formatQuantity(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, '');
}

function createGmailTransporter() {
  const user = String(gmailUserSecret.value() || '').trim();
  const pass = String(gmailAppPasswordSecret.value() || '');
  if (!user || !pass) throw new Error('Gmail SMTP is not configured.');
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugifyForKey(value = '') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug || 'workspace';
}

async function mirrorOrgGroupToRealtime({
  siteIds = [],
  linkType = 'org',
  linkId = '',
  groupName = '',
  permissionLevel = 'full_transfer',
  viewingOnly = false,
  uid = '',
  email = ''
} = {}) {
  const idField = linkType === 'corp' ? 'corpId' : 'orgId';
  const cleanSiteIds = siteIds.map((siteId) => String(siteId || '').trim()).filter(Boolean);
  const cleanLinkId = String(linkId || '').trim();

  if (!cleanSiteIds.length) return;
  if (!cleanLinkId) {
    await Promise.all(cleanSiteIds.map((siteId) => mirrorOrgUnlinkToRealtime({ siteId, linkType })));
    return;
  }

  const linkedAt = new Date().toISOString();
  const updates = {};
  const registrySnap = await rtdb.ref('adminConfig/registry').get();
  const registry = registrySnap.val() || {};
  const existingLinkedSiteIds = Object.entries(registry)
    .filter(([siteId, entry]) => (
      !cleanSiteIds.includes(siteId) &&
      String(entry?.[idField] || '').trim() === cleanLinkId
    ))
    .map(([siteId]) => siteId);
  const groupSiteIds = [...new Set([...cleanSiteIds, ...existingLinkedSiteIds])];

  cleanSiteIds.forEach((siteId) => {
    const groupMetadata = {
      name: groupName,
      linkType,
      linkedAt,
      linkedBy: uid,
      linkedByEmail: email,
      permissionLevel
    };
    const linkedSites = Object.fromEntries(groupSiteIds
      .filter((peerId) => peerId !== siteId)
      .map((peerId) => [peerId, {
        siteId: peerId,
        linkType,
        [idField]: cleanLinkId,
        linkedAt,
        linkedBy: uid
      }]));
    updates[`workspaces/${siteId}/profile/${idField}`] = cleanLinkId;
    updates[`workspaces/${siteId}/profile/viewingOnly`] = viewingOnly;
    updates[`workspaces/${siteId}/profile/permissionLevel`] = permissionLevel;
    updates[`workspaces/${siteId}/profile/groupMetadata`] = groupMetadata;
    updates[`workspaces/${siteId}/profile/linkedSites`] = linkedSites;
    updates[`workspaces/${siteId}/profile/updatedAt`] = linkedAt;
    updates[`workspaces/${siteId}/profile/updatedBy`] = uid;
    updates[`workspaces/${siteId}/data/settings/${idField}`] = cleanLinkId;
    updates[`workspaces/${siteId}/data/settings/viewingOnly`] = viewingOnly;
    updates[`workspaces/${siteId}/data/settings/permissionLevel`] = permissionLevel;
    updates[`workspaces/${siteId}/data/settings/groupMetadata`] = groupMetadata;
    updates[`workspaces/${siteId}/data/settings/linkedSites`] = linkedSites;
    updates[`workspaces/${siteId}/data/settings/linkedSiteCount`] = Object.keys(linkedSites).length;
    updates[`adminConfig/registry/${siteId}/${idField}`] = cleanLinkId;
    updates[`adminConfig/registry/${siteId}/viewingOnly`] = viewingOnly;
    updates[`adminConfig/registry/${siteId}/permissionLevel`] = permissionLevel;
    updates[`adminConfig/registry/${siteId}/groupMetadata`] = groupMetadata;
    updates[`adminConfig/registry/${siteId}/updatedAt`] = linkedAt;
  });

  existingLinkedSiteIds.forEach((siteId) => {
    cleanSiteIds.forEach((linkedSiteId) => {
      updates[`workspaces/${siteId}/profile/linkedSites/${linkedSiteId}`] = {
        siteId: linkedSiteId,
        linkType,
        [idField]: cleanLinkId,
        linkedAt,
        linkedBy: uid
      };
      updates[`workspaces/${siteId}/data/settings/linkedSites/${linkedSiteId}`] = {
        siteId: linkedSiteId,
        linkType,
        [idField]: cleanLinkId,
        linkedAt,
        linkedBy: uid
      };
    });
  });

  await rtdb.ref().update(updates);
}

async function mirrorOrgUnlinkToRealtime({ siteId = '', linkType = 'org' } = {}) {
  const cleanSiteId = String(siteId || '').trim();
  if (!cleanSiteId) return;
  const idField = linkType === 'corp' ? 'corpId' : 'orgId';
  const registrySnap = await rtdb.ref('adminConfig/registry').get();
  const registry = registrySnap.val() || {};
  const currentLinkId = String(registry?.[cleanSiteId]?.[idField] || '').trim();
  const updates = {
    [`workspaces/${cleanSiteId}/profile/${idField}`]: null,
    [`workspaces/${cleanSiteId}/profile/groupMetadata`]: null,
    [`workspaces/${cleanSiteId}/profile/linkedSites`]: null,
    [`workspaces/${cleanSiteId}/data/settings/${idField}`]: null,
    [`workspaces/${cleanSiteId}/data/settings/groupMetadata`]: null,
    [`workspaces/${cleanSiteId}/data/settings/linkedSites`]: null,
    [`workspaces/${cleanSiteId}/data/settings/linkedSiteCount`]: 0,
    [`adminConfig/registry/${cleanSiteId}/${idField}`]: null,
    [`adminConfig/registry/${cleanSiteId}/groupMetadata`]: null,
    [`adminConfig/registry/${cleanSiteId}/updatedAt`]: new Date().toISOString()
  };
  Object.entries(registry).forEach(([peerId, entry]) => {
    if (!currentLinkId || peerId === cleanSiteId || String(entry?.[idField] || '').trim() !== currentLinkId) return;
    updates[`workspaces/${peerId}/profile/linkedSites/${cleanSiteId}`] = null;
    updates[`workspaces/${peerId}/data/settings/linkedSites/${cleanSiteId}`] = null;
  });
  await rtdb.ref().update(updates);
}
