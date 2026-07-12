const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onValueWritten } = require('firebase-functions/v2/database');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { createWebhookSubscription, listLocations, YocoApiError } = require('./yoco/client');
const { syncYocoCatalogueData } = require('./yoco/catalogue');
const { deleteYocoSecrets, getYocoSecrets, saveYocoSecrets } = require('./yoco/secrets');
const { syncYocoSalesData } = require('./yoco/sales');
const { handleYocoWebhook } = require('./yoco/webhooks');
const { requireWorkspaceAccess } = require('./yoco/workspaceAccess');
const { rebuildDashboardSummary, rebuildDashboardSummaryForWorkspace } = require('./dashboardSummary');
const { createOrgTransferHandlers } = require('./orgTransfers');

admin.initializeApp();

const db = admin.firestore();
const rtdb = admin.database();
const yocoEncryptionSecret = defineSecret('YOCO_SECRET_ENCRYPTION_KEY');
const SKIP_XERO_FUNCTIONS = process.env.KCP_ENABLE_XERO !== 'true';
const xeroClientIdSecret = SKIP_XERO_FUNCTIONS ? null : defineSecret('XERO_CLIENT_ID');
const xeroClientSecretSecret = SKIP_XERO_FUNCTIONS ? null : defineSecret('XERO_CLIENT_SECRET');
const xeroEncryptionSecret = SKIP_XERO_FUNCTIONS ? null : defineSecret('XERO_TOKEN_ENCRYPTION_KEY');
const gmailUserSecret = defineSecret('KCP_GMAIL_USER');
const gmailAppPasswordSecret = defineSecret('KCP_GMAIL_APP_PASSWORD');
const emailFromSecret = defineSecret('KCP_EMAIL_FROM');
const YOCO_FUNCTION_REGION = 'europe-west1';
const XERO_FUNCTION_REGION = YOCO_FUNCTION_REGION;
const KCP_LOGIN_URL = process.env.KCP_LOGIN_URL || 'https://kcp-kitchencostpro.web.app';
const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const XERO_API_BASE_URL = 'https://api.xero.com';
const XERO_DEFAULT_SCOPES = [
  'offline_access',
  'accounting.transactions',
  'accounting.contacts',
  'accounting.settings'
];
const LOW_STOCK_EMAIL_DEFAULT_TIME_ZONE = 'Africa/Johannesburg';
const LOW_STOCK_EMAIL_DEFAULT_DISPATCH_TIME = '08:00';
const YOCO_CATALOGUE_PULSE_INTERVAL_MS = 15 * 1000;
const DASHBOARD_SUMMARY_SOURCE_NODES = new Set([
  'settings',
  'locations',
  'ingredients',
  'products',
  'suppliers',
  'purchaseOrders',
  'dashboardMetrics',
  'logs_grv',
  'logs_cn',
  'logs_stocktakes',
  'logs_adj',
  'logs_transfers',
  'logs_mfg',
  'logs_sales',
  'stockTakes',
  'stocktakeTemplates',
  'sessionOpeningStock',
  'logs_snapshots'
]);
const orgTransferHandlers = createOrgTransferHandlers({ admin, rtdb, requireSuperUser });

async function refreshWorkspaceDashboardLiveState(workspaceId) {
  const id = String(workspaceId || '').trim();
  if (!id) return null;
  return rebuildDashboardSummaryForWorkspace(admin, id);
}

exports.refreshDashboardSummary = onCall({
  region: YOCO_FUNCTION_REGION,
  timeoutSeconds: 120,
  memory: '512MiB',
  minInstances: 1
}, async (request) => {
  const { workspaceId, dataPath } = await requireWorkspaceAccess(admin, request.data?.workspaceId, request.auth);
  const summary = await rebuildDashboardSummary(admin, dataPath);
  return {
    status: 'refreshed',
    workspaceId,
    calculatedAt: summary.calculatedAt,
    liveStatePath: summary.liveStatePath,
    liveStateCalculatedAt: summary.liveStateCalculatedAt,
    today: summary.metrics?.today || ''
  };
});

exports.bootstrapDashboardLiveStates = onCall({
  region: YOCO_FUNCTION_REGION,
  timeoutSeconds: 540,
  memory: '1GiB'
}, async (request) => {
  await requireSuperUser(request.auth);

  const includeLegacy = request.data?.includeLegacy !== false;
  const workspacesSnapshot = await rtdb.ref('workspaces').get();
  const workspaceIds = Object.keys(workspacesSnapshot.val() || {});
  const results = [];

  for (const workspaceId of workspaceIds) {
    try {
      const summary = await rebuildDashboardSummaryForWorkspace(admin, workspaceId);
      results.push({
        workspaceId,
        status: 'populated',
        liveStatePath: summary.liveStatePath,
        calculatedAt: summary.liveStateCalculatedAt || summary.calculatedAt,
        today: summary.metrics?.today || ''
      });
    } catch (error) {
      console.error('[bootstrapDashboardLiveStates] Workspace failed', {
        workspaceId,
        ...serializeError(error)
      });
      results.push({
        workspaceId,
        status: 'failed',
        message: error?.message || String(error)
      });
    }
  }

  if (includeLegacy) {
    const appDataSnapshot = await rtdb.ref('appData').get();
    if (appDataSnapshot.exists()) {
      try {
        const summary = await rebuildDashboardSummaryForWorkspace(admin, 'appData');
        results.push({
          workspaceId: 'appData',
          status: 'populated',
          liveStatePath: summary.liveStatePath,
          calculatedAt: summary.liveStateCalculatedAt || summary.calculatedAt,
          today: summary.metrics?.today || ''
        });
      } catch (error) {
        console.error('[bootstrapDashboardLiveStates] appData failed', serializeError(error));
        results.push({
          workspaceId: 'appData',
          status: 'failed',
          message: error?.message || String(error)
        });
      }
    }
  }

  return {
    status: 'complete',
    attempted: results.length,
    populated: results.filter((result) => result.status === 'populated').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results
  };
});

exports.connectProfiles = onCall({
  region: YOCO_FUNCTION_REGION,
  timeoutSeconds: 60,
  memory: '256MiB'
}, orgTransferHandlers.connectProfilesCallable);

exports.getSiteConfiguration = onCall({
  region: YOCO_FUNCTION_REGION,
  timeoutSeconds: 60,
  memory: '256MiB'
}, orgTransferHandlers.getSiteConfigurationCallable);

exports.orgTransferApi = onRequest({
  region: YOCO_FUNCTION_REGION,
  timeoutSeconds: 120,
  memory: '512MiB'
}, orgTransferHandlers.api);

exports.sendQueuedWelcomeEmail = onValueWritten({
  ref: '/adminNotifications/welcomeEmails/{messageId}',
  region: YOCO_FUNCTION_REGION,
  timeoutSeconds: 60,
  memory: '256MiB',
  secrets: [
    gmailUserSecret,
    gmailAppPasswordSecret,
    emailFromSecret
  ]
}, async (event) => {
  const after = event.data.after.val();
  if (!after) return;

  const status = String(after.status || '').trim();
  const sendableStatuses = new Set(['queued', 'otp-generated', 'approved-existing-user', 'firebase-password-reset-sent']);
  if (!sendableStatuses.has(status)) return;

  const email = String(after.email || '').trim().toLowerCase();
  const siteName = String(after.siteName || 'your KCP workspace').trim();
  const messageId = event.params.messageId;
  const queueRef = event.data.after.ref;

  if (!email || !email.includes('@')) {
    await queueRef.update({
      status: 'error',
      error: 'Missing or invalid recipient email.',
      failedAt: new Date().toISOString()
    });
    return;
  }

  await queueRef.update({
    status: 'sending',
    processingStartedAt: new Date().toISOString()
  });

  try {
    const transporter = createGmailTransporter();
    const emailPayload = { ...after };
    const requiresPasswordChange = Boolean(emailPayload.requiresPasswordChange);
    if (requiresPasswordChange && !String(emailPayload.temporaryPassword || '').trim()) {
      const uid = String(emailPayload.uid || '').trim();
      if (!uid) throw new Error('Cannot generate a temporary password without a Firebase Auth uid.');
      const temporaryPassword = generateTemporaryPassword();
      await admin.auth().updateUser(uid, { password: temporaryPassword });
      emailPayload.temporaryPassword = temporaryPassword;
      emailPayload.temporaryPasswordCreated = true;
    }
    const message = buildWelcomeEmailMessage(emailPayload);
    const result = await transporter.sendMail(message);
    const emailKey = getEmailKey(email);
    const sentAt = new Date().toISOString();

    const updates = {
      [`adminNotifications/welcomeEmails/${messageId}/status`]: 'sent',
      [`adminNotifications/welcomeEmails/${messageId}/sentAt`]: sentAt,
      [`adminNotifications/welcomeEmails/${messageId}/messageId`]: result.messageId || null,
      [`adminNotifications/welcomeEmails/${messageId}/temporaryPassword`]: null
    };
    if (emailKey) {
      updates[`invitations/${emailKey}/welcomeEmailStatus`] = 'sent';
      updates[`invitations/${emailKey}/welcomeEmailSentAt`] = sentAt;
    }

    await rtdb.ref().update(updates);
    console.log('[sendQueuedWelcomeEmail] Sent welcome email', { email, siteName, messageId });
  } catch (error) {
    const serialized = serializeError(error);
    console.error('[sendQueuedWelcomeEmail] Failed', { email, siteName, messageId, ...serialized });
    await queueRef.update({
      status: 'error',
      error: error?.message || String(error),
      failedAt: new Date().toISOString()
    });
  }
});

exports.deleteWorkspaceAdmin = onCall({
  region: YOCO_FUNCTION_REGION,
  timeoutSeconds: 120,
  memory: '256MiB'
}, async (request) => {
  const { uid: actorUid } = await requireSuperUser(request.auth);
  const workspaceId = String(request.data?.workspaceId || '').trim();
  if (!workspaceId) throw new HttpsError('invalid-argument', 'workspaceId is required.');

  const workspaceSnap = await rtdb.ref(`workspaces/${workspaceId}`).get();
  const workspace = workspaceSnap.val();
  const siteName = workspace?.data?.settings?.siteName || workspace?.settings?.siteName || workspaceId;
  const updates = {
    [`workspaces/${workspaceId}`]: null,
    [`adminConfig/registry/${workspaceId}`]: null,
    [`adminConfig/yoco/workspaces/${workspaceId}`]: null
  };

  const usersSnap = await rtdb.ref('users').get();
  const users = usersSnap.val() || {};
  let usersTouched = 0;
  let usersRemoved = 0;
  for (const [uid, userData] of Object.entries(users)) {
    const profileWorkspaces = userData?.profile?.workspaces || {};
    const profile = userData?.profile || {};
    let touched = false;
    const remainingWorkspaceIds = Object.keys(profileWorkspaces).filter((id) => id !== workspaceId);

    if (profileWorkspaces[workspaceId]) {
      updates[`users/${uid}/profile/workspaces/${workspaceId}`] = null;
      touched = true;
    }
    if (profile.workspaceId === workspaceId) {
      updates[`users/${uid}/profile/workspaceId`] = null;
      updates[`users/${uid}/profile/siteName`] = null;
      touched = true;
    }
    const requestedWorkspace = profile.requestedWorkspace || {};
    if (requestedWorkspace?.workspaceId === workspaceId || requestedWorkspace?.wsId === workspaceId || requestedWorkspace?.siteName === siteName) {
      updates[`users/${uid}/profile/requestedWorkspace`] = null;
      touched = true;
    }
    if (touched) {
      usersTouched += 1;
      if (!remainingWorkspaceIds.length && (!profile.workspaceId || profile.workspaceId === workspaceId)) {
        updates[`users/${uid}`] = null;
        usersRemoved += 1;
      }
    }
  }

  const invitationsSnap = await rtdb.ref('invitations').get();
  const invitations = invitationsSnap.val() || {};
  let invitationsTouched = 0;
  for (const [inviteKey, invitation] of Object.entries(invitations)) {
    if (invitation?.workspaceId === workspaceId || invitation?.wsId === workspaceId || invitation?.siteName === siteName) {
      updates[`invitations/${inviteKey}`] = null;
      invitationsTouched += 1;
    }
  }

  const welcomeEmailsSnap = await rtdb.ref('adminNotifications/welcomeEmails').get();
  const welcomeEmails = welcomeEmailsSnap.val() || {};
  let welcomeEmailsTouched = 0;
  for (const [messageId, message] of Object.entries(welcomeEmails)) {
    if (message?.workspaceId === workspaceId || message?.wsId === workspaceId || message?.siteName === siteName) {
      updates[`adminNotifications/welcomeEmails/${messageId}`] = null;
      welcomeEmailsTouched += 1;
    }
  }

  const queueSnap = await rtdb.ref('adminConfig/yoco/webhookQueue').get();
  const queue = queueSnap.val() || {};
  let queueTouched = 0;
  for (const [eventId, event] of Object.entries(queue)) {
    if (event?.workspaceId === workspaceId || event?.wsId === workspaceId || event?.businessKey === workspaceId || event?.siteKey === workspaceId) {
      updates[`adminConfig/yoco/webhookQueue/${eventId}`] = null;
      queueTouched += 1;
    }
  }

  await rtdb.ref().update(updates);
  await deleteYocoSecrets(db, workspaceId).catch((error) => {
    console.warn('[Admin] Could not delete Yoco secrets during workspace delete:', error);
  });
  await db.collection('sites').doc(workspaceId).delete().catch((error) => {
    console.warn('[Admin] Could not delete Firestore site document during workspace delete:', error);
  });
  await rtdb.ref('systemLogs').push({
    actionType: 'DELETE_WORKSPACE',
    targetId: workspaceId,
    actorUid,
    actorEmail: request.auth?.token?.email || '',
    details: {
      siteName,
      workspaceExisted: Boolean(workspace),
      usersTouched,
      usersRemoved,
      invitationsTouched,
      welcomeEmailsTouched,
      queueTouched,
      via: 'deleteWorkspaceAdmin'
    },
    timestamp: new Date().toISOString()
  });

  return {
    status: workspace ? 'deleted' : 'cleaned',
    workspaceId,
    siteName,
    usersTouched,
    usersRemoved,
    invitationsTouched,
    welcomeEmailsTouched,
    queueTouched
  };
});

exports.addWorkspaceUser = onCall({ region: YOCO_FUNCTION_REGION, timeoutSeconds: 120, memory: '256MiB' }, async (request) => {
  const { workspaceId, dataPath, uid: actorUid } = await requireWorkspaceAccess(
    admin,
    request.data?.workspaceId,
    request.auth,
    { adminOnly: true }
  );

  const email = String(request.data?.email || '').trim().toLowerCase();
  const password = String(request.data?.password || '');
  const firstName = String(request.data?.firstName || '').trim();
  const surname = String(request.data?.surname || '').trim();
  const role = String(request.data?.role || 'member').trim() || 'member';
  const viewingOnly = request.data?.viewingOnly === true || String(request.data?.viewingOnly || '').toLowerCase() === 'true';
  const lowStockAlert = request.data?.lowStockAlert === true || request.data?.lowStockAlertTag === true ||
    String(request.data?.lowStockAlert || request.data?.lowStockAlertTag || '').toLowerCase() === 'true';
  const workspaceName = String(request.data?.workspaceName || workspaceId).trim() || workspaceId;
  const fullName = `${firstName} ${surname}`.trim();
  const emailKey = getEmailKey(email);

  if (!firstName) throw new HttpsError('invalid-argument', 'First name is required.');
  if (!surname) throw new HttpsError('invalid-argument', 'Surname is required.');
  if (!email || !email.includes('@')) throw new HttpsError('invalid-argument', 'Enter a valid employee email address.');

  let userRecord = null;
  let mode = 'created';

  try {
    userRecord = await admin.auth().getUserByEmail(email);
    mode = 'linked-existing';
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') {
      throw new HttpsError('internal', error?.message || 'Could not check the employee account.');
    }
  }

  if (!userRecord) {
    if (!password) {
      throw new HttpsError('not-found', 'No existing user was found for this email. Enter a temporary password to create the login.');
    }
    if (password.length < 6) {
      throw new HttpsError('invalid-argument', 'Password must be at least 6 characters.');
    }
    try {
      userRecord = await admin.auth().createUser({
        email,
        password,
        displayName: fullName,
        emailVerified: false,
        disabled: false
      });
    } catch (error) {
      throw new HttpsError('invalid-argument', error?.message || 'Could not create the employee login.');
    }
  }

  const memberSnapshot = await rtdb.ref(`${dataPath}/team/${userRecord.uid}`).get();
  if (memberSnapshot.exists()) {
    throw new HttpsError('already-exists', 'This employee already has access to this workspace.');
  }

  const joinedAt = new Date().toISOString();
  const updates = {
    [`users/${userRecord.uid}/profile/email`]: email,
    [`users/${userRecord.uid}/profile/name`]: fullName,
    [`users/${userRecord.uid}/profile/firstName`]: firstName,
    [`users/${userRecord.uid}/profile/surname`]: surname,
    [`users/${userRecord.uid}/profile/status`]: 'approved',
    [`users/${userRecord.uid}/profile/workspaces/${workspaceId}`]: {
      role,
      siteName: workspaceName,
      viewingOnly,
      lowStockAlert,
      joinedAt,
      addedBy: actorUid
    },
    [`${dataPath}/team/${userRecord.uid}`]: {
      uid: userRecord.uid,
      email,
      name: fullName,
      firstName,
      surname,
      role,
      viewingOnly,
      lowStockAlert,
      status: 'active',
      joinedAt,
      addedBy: actorUid
    }
  };

  if (emailKey) {
    updates[`invitations/${emailKey}`] = null;
    updates[`${dataPath}/team/${emailKey}`] = null;
  }

  await rtdb.ref().update(updates);

  return {
    mode,
    uid: userRecord.uid,
    email,
    role,
    viewingOnly,
    lowStockAlert
  };
});

exports.requestWorkspaceRegistration = onCall({ region: YOCO_FUNCTION_REGION, timeoutSeconds: 60, memory: '256MiB' }, async (request) => {
  const email = String(request.data?.email || '').trim().toLowerCase();
  const fullName = String(request.data?.fullName || '').trim();
  const siteName = String(request.data?.siteName || '').trim();
  const requestedAt = new Date().toISOString();

  if (!fullName) throw new HttpsError('invalid-argument', 'Enter your full name.');
  if (!siteName) throw new HttpsError('invalid-argument', 'Enter your workspace or site name.');
  if (!email || !email.includes('@')) throw new HttpsError('invalid-argument', 'Enter a valid email address.');

  const normalizedSiteName = normalizeTextKey(siteName);
  const emailKey = getEmailKey(email);
  const requestKey = `${emailKey}_${slugifyForKey(siteName)}`;
  const { firstName, surname } = splitName(fullName);

  const [existingRequestSnap, registrySnap, workspacesSnap] = await Promise.all([
    rtdb.ref(`signupRequests/${requestKey}`).get(),
    rtdb.ref('adminConfig/registry').get(),
    rtdb.ref('workspaces').get()
  ]);

  if (existingRequestSnap.exists()) {
    throw new HttpsError('already-exists', 'A pending request already exists for this email and workspace name.');
  }

  const registry = registrySnap.val() || {};
  const workspaces = workspacesSnap.val() || {};
  const registryEntries = Object.entries(registry).filter(([, entry]) => {
    return !entry || typeof entry !== 'object' || String(entry.status || 'active').toLowerCase() !== 'deleted';
  });
  const workspacesToCheck = registryEntries.length
    ? registryEntries.map(([workspaceId]) => workspaces[workspaceId]).filter(Boolean)
    : Object.values(workspaces);
  const siteAlreadyExists = workspacesToCheck.some((workspace) => {
    const candidate = workspace?.data?.settings?.siteName || workspace?.settings?.siteName || '';
    return normalizeTextKey(candidate) === normalizedSiteName;
  });

  if (siteAlreadyExists) {
    throw new HttpsError('already-exists', 'A workspace with this site name already exists.');
  }

  let existingUser = null;
  try {
    existingUser = await admin.auth().getUserByEmail(email);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') {
      throw new HttpsError('internal', error?.message || 'Could not check the email address.');
    }
  }

  await rtdb.ref(`signupRequests/${requestKey}`).set({
    email,
    siteName,
    normalizedSiteName,
    uid: existingUser?.uid || null,
    firstName,
    surname,
    name: fullName,
    requestedAt,
    source: 'kcp-live-registration',
    status: 'pending'
  });

  return {
    status: 'pending',
    requestKey,
    email,
    siteName,
    existingUser: Boolean(existingUser?.uid)
  };
});

exports.onDashboardSourceWrite = onValueWritten({
  region: YOCO_FUNCTION_REGION,
  ref: '/workspaces/{workspaceId}/data/{nodeKey}',
  timeoutSeconds: 120,
  memory: '512MiB'
}, async (event) => {
  const nodeKey = String(event.params.nodeKey || '');
  if (!DASHBOARD_SUMMARY_SOURCE_NODES.has(nodeKey)) return;
  await refreshWorkspaceDashboardLiveState(event.params.workspaceId);
});

exports.onDashboardSourceItemWrite = onValueWritten({
  region: YOCO_FUNCTION_REGION,
  ref: '/workspaces/{workspaceId}/data/{nodeKey}/{recordId}',
  timeoutSeconds: 120,
  memory: '512MiB'
}, async (event) => {
  const nodeKey = String(event.params.nodeKey || '');
  if (!DASHBOARD_SUMMARY_SOURCE_NODES.has(nodeKey)) return;
  await refreshWorkspaceDashboardLiveState(event.params.workspaceId);
});

exports.onLegacyDashboardSourceWrite = onValueWritten({
  region: YOCO_FUNCTION_REGION,
  ref: '/appData/{nodeKey}',
  timeoutSeconds: 120,
  memory: '512MiB'
}, async (event) => {
  const nodeKey = String(event.params.nodeKey || '');
  if (!DASHBOARD_SUMMARY_SOURCE_NODES.has(nodeKey)) return;
  await rebuildDashboardSummaryForWorkspace(admin, 'appData');
});

exports.onLegacyDashboardSourceItemWrite = onValueWritten({
  region: YOCO_FUNCTION_REGION,
  ref: '/appData/{nodeKey}/{recordId}',
  timeoutSeconds: 120,
  memory: '512MiB'
}, async (event) => {
  const nodeKey = String(event.params.nodeKey || '');
  if (!DASHBOARD_SUMMARY_SOURCE_NODES.has(nodeKey)) return;
  await rebuildDashboardSummaryForWorkspace(admin, 'appData');
});

exports.refreshDashboardSummaries = onSchedule({
  region: YOCO_FUNCTION_REGION,
  schedule: 'every 15 minutes',
  timeZone: 'Africa/Johannesburg',
  timeoutSeconds: 540,
  memory: '512MiB'
}, async () => {
  const workspacesSnapshot = await rtdb.ref('workspaces').get();
  const workspaceIds = Object.keys(workspacesSnapshot.val() || {});
  const results = [];

  for (const workspaceId of workspaceIds) {
    try {
      await rebuildDashboardSummaryForWorkspace(admin, workspaceId);
      results.push({ workspaceId, status: 'refreshed' });
    } catch (error) {
      console.error('[refreshDashboardSummaries] Workspace failed', {
        workspaceId,
        ...serializeError(error)
      });
      results.push({ workspaceId, status: 'failed' });
    }
  }

  const appDataSnapshot = await rtdb.ref('appData').get();
  if (appDataSnapshot.exists()) {
    try {
      await rebuildDashboardSummaryForWorkspace(admin, 'appData');
      results.push({ workspaceId: 'appData', status: 'refreshed' });
    } catch (error) {
      console.error('[refreshDashboardSummaries] appData failed', serializeError(error));
      results.push({ workspaceId: 'appData', status: 'failed' });
    }
  }

  console.info('[refreshDashboardSummaries] Complete', {
    refreshed: results.filter((result) => result.status === 'refreshed').length,
    failed: results.filter((result) => result.status === 'failed').length
  });
});

// DEPRECATED: superseded by the cloudflare-v2 worker's `sendDueLowStockEmailSummaries`
// cron trigger, which sends via the new Gmail OAuth account (the same one used for
// forgot-password / new-workspace emails) instead of this old Gmail SMTP app-password
// path. Left in place (short-circuited) rather than deleted until the new path has run
// a full send cycle in production. Remove entirely once confirmed.
exports.sendLowStockSummaryEmails = onSchedule({
  region: YOCO_FUNCTION_REGION,
  schedule: 'every 15 minutes',
  timeZone: 'Africa/Johannesburg',
  timeoutSeconds: 540,
  memory: '512MiB',
  secrets: [
    gmailUserSecret,
    gmailAppPasswordSecret,
    emailFromSecret
  ]
}, async () => {
  console.log('sendLowStockSummaryEmails is deprecated and disabled — low-stock emails now send via the cloudflare-v2 worker.');
  return null;
  // eslint-disable-next-line no-unreachable
  const transporter = createGmailTransporter();
  const now = new Date();
  const workspacesSnapshot = await rtdb.ref('workspaces').get();
  const workspaces = workspacesSnapshot.val() || {};
  const results = [];

  for (const [workspaceId, workspace] of Object.entries(workspaces)) {
    const dataPath = getWorkspaceDataPath(workspaceId);
    try {
      const result = await sendLowStockSummaryEmailForWorkspace({
        workspaceId,
        workspaceName: workspace?.siteName || workspace?.name || workspaceId,
        dataPath,
        transporter,
        now
      });
      if (result.status !== 'disabled') results.push(result);
    } catch (error) {
      console.error('[sendLowStockSummaryEmails] Workspace failed', {
        workspaceId,
        ...serializeError(error)
      });
      results.push({ workspaceId, status: 'failed', message: error?.message || String(error) });
    }
  }

  const appDataSnapshot = await rtdb.ref('appData').get();
  if (appDataSnapshot.exists()) {
    try {
      const result = await sendLowStockSummaryEmailForWorkspace({
        workspaceId: 'appData',
        workspaceName: 'Legacy Workspace',
        dataPath: 'appData',
        transporter,
        now
      });
      if (result.status !== 'disabled') results.push(result);
    } catch (error) {
      console.error('[sendLowStockSummaryEmails] appData failed', serializeError(error));
      results.push({ workspaceId: 'appData', status: 'failed', message: error?.message || String(error) });
    }
  }

  console.info('[sendLowStockSummaryEmails] Complete', {
    sent: results.filter((result) => result.status === 'sent').length,
    skipped: results.filter((result) => result.status !== 'sent' && result.status !== 'failed').length,
    failed: results.filter((result) => result.status === 'failed').length
  });
});

exports.onMenuUpdate = onDocumentWritten({ region: YOCO_FUNCTION_REGION, document: 'menu_items/{itemId}' }, async (event) => {
  const before = event.data?.before?.data() || null;
  const after = event.data?.after?.data() || null;
  const workspaceId = after?.workspaceId || before?.workspaceId;

  if (!workspaceId) {
    console.warn('[onMenuUpdate] Missing workspaceId for menu item', event.params.itemId);
    return;
  }

  const dataPath = getWorkspaceDataPath(workspaceId);
  const snapshot = await db.collection('menu_items')
    .where('workspaceId', '==', workspaceId)
    .get();
  const ingredientSnapshot = await rtdb.ref(`${dataPath}/ingredients`).get();
  const ingredientMap = new Map(normalizeArray(ingredientSnapshot.val()).map((ingredient) => [String(ingredient.id), ingredient]));

  let gpTotal = 0;
  let gpCount = 0;
  let missingRecipeCount = 0;

  snapshot.forEach((doc) => {
    const item = doc.data() || {};
    const sellingPrice = Number(
      item.sellingPrice ??
      item.selling_price ??
      item.price ??
      item.menuPrice ??
      0
    ) || 0;
    const recipe = Array.isArray(item.recipe)
      ? item.recipe
      : Object.values(item.recipe || {});
    const cost = calculateRecipeCost(recipe, ingredientMap);

    if (!recipe.length) missingRecipeCount += 1;

    if (sellingPrice > 0) {
      gpTotal += ((sellingPrice - cost) / sellingPrice) * 100;
      gpCount += 1;
    }
  });

  const valuation = {
    gpPercentage: gpCount ? Number((gpTotal / gpCount).toFixed(2)) : 0,
    menuCount: snapshot.size,
    missingRecipeCount,
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    source: 'functions:onMenuUpdate'
  };

  await Promise.all([
    rtdb.ref(`${dataPath}/dashboardMetrics/valuation`).update(valuation),
    db.collection('dashboard_state').doc(workspaceId).set({
      valuation: {
        ...valuation,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true })
  ]);
});

exports.connectYoco = onCall({ region: YOCO_FUNCTION_REGION, secrets: [yocoEncryptionSecret], timeoutSeconds: 540, memory: '512MiB' }, async (request) => {
  const { workspaceId, dataPath, uid } = await requireWorkspaceAccess(admin, request.data?.workspaceId, request.auth, { adminOnly: true });
  const apiKey = String(request.data?.apiKey || '').trim();
  if (!apiKey) throw new HttpsError('invalid-argument', 'Yoco API key is required.');
  let secretSaved = false;

  try {
    await rtdb.ref(`${dataPath}/integrations/yoco`).update({
      status: 'connecting',
      connectionActive: false,
      syncState: 'validating',
      lastSyncStartedAt: new Date().toISOString(),
      lastError: ''
    });

    console.info('[connectYoco] Validating API key with locations endpoint', { workspaceId });
    await listLocations(apiKey);
    await saveYocoSecrets(db, workspaceId, { apiKey }, yocoEncryptionSecret.value());
    secretSaved = true;
    await rtdb.ref(`${dataPath}/integrations/yoco`).update({
      status: 'connected',
      connectionActive: true,
      syncState: 'initial_syncing',
      connectedAt: new Date().toISOString(),
      connectedBy: uid,
      lastError: ''
    });
    console.info('[connectYoco] Syncing catalogue', { workspaceId });
    const catalogueSummary = await syncYocoCatalogueData(admin, dataPath, apiKey);

    console.info('[connectYoco] Syncing sales history', { workspaceId });
    const salesSummary = await syncYocoSalesData(admin, dataPath, apiKey);
    console.info('[connectYoco] Creating webhook subscription', { workspaceId });
    const webhookSummary = await tryCreateYocoWebhookSubscription(workspaceId, dataPath, apiKey);
    if (webhookSummary.secret) {
      await saveYocoSecrets(db, workspaceId, { webhookSecret: webhookSummary.secret }, yocoEncryptionSecret.value());
    }

    const now = new Date().toISOString();
    const webhookEnabled = webhookSummary.enabled === true;
    await rtdb.ref(`${dataPath}/integrations/yoco`).update({
      status: 'connected',
      connectionActive: true,
      syncState: 'idle',
      health: webhookEnabled ? 'healthy' : 'attention',
      connectedAt: now,
      connectedBy: uid,
      lastSyncCompletedAt: now,
      lastError: webhookSummary.error || '',
      webhook: {
        enabled: webhookEnabled,
        subscriptionId: webhookSummary.id || '',
        notificationUrl: webhookSummary.notificationUrl || '',
        eventTypes: ['payment.created', 'payment.refunded'],
        createdAt: webhookSummary.createdAt || now,
        lastError: webhookSummary.error || ''
      }
    });

    return {
      status: 'connected',
      ...catalogueSummary,
      ...salesSummary,
      webhookEnabled,
      webhookError: webhookSummary.error || ''
    };
  } catch (error) {
    console.error('[connectYoco] Failed', serializeError(error));
    const now = new Date().toISOString();
    await rtdb.ref(`${dataPath}/integrations/yoco`).update(secretSaved ? {
      status: 'connected',
      connectionActive: true,
      syncState: 'error',
      health: 'attention',
      lastError: publicYocoError(error),
      updatedAt: now
    } : {
      status: 'error',
      connectionActive: false,
      syncState: 'error',
      health: 'offline',
      lastError: publicYocoError(error),
      updatedAt: now
    });
    throw toHttpsError(error);
  }
});

exports.syncYocoCatalogue = onCall({ region: YOCO_FUNCTION_REGION, secrets: [yocoEncryptionSecret], timeoutSeconds: 300, memory: '512MiB' }, async (request) => {
  const { workspaceId, dataPath } = await requireWorkspaceAccess(admin, request.data?.workspaceId, request.auth);
  const secrets = await getYocoSecrets(db, workspaceId, yocoEncryptionSecret.value());
  try {
    return await syncYocoCatalogueData(admin, dataPath, secrets.apiKey);
  } catch (error) {
    await rtdb.ref(`${dataPath}/integrations/yoco`).update({
      status: 'connected',
      connectionActive: true,
      syncState: 'error',
      health: 'attention',
      lastError: publicYocoError(error),
      updatedAt: new Date().toISOString()
    });
    throw toHttpsError(error);
  }
});

exports.syncYocoSales = onCall({ region: YOCO_FUNCTION_REGION, secrets: [yocoEncryptionSecret], timeoutSeconds: 540, memory: '512MiB' }, async (request) => {
  const { workspaceId, dataPath } = await requireWorkspaceAccess(admin, request.data?.workspaceId, request.auth);
  const secrets = await getYocoSecrets(db, workspaceId, yocoEncryptionSecret.value());
  try {
    return await syncYocoSalesData(admin, dataPath, secrets.apiKey, {
      startDate: request.data?.startDate,
      endDate: request.data?.endDate
    });
  } catch (error) {
    await rtdb.ref(`${dataPath}/integrations/yoco`).update({
      status: 'connected',
      connectionActive: true,
      syncState: 'error',
      health: 'attention',
      lastError: publicYocoError(error),
      updatedAt: new Date().toISOString()
    });
    throw toHttpsError(error);
  }
});

exports.disconnectYoco = onCall({
  region: YOCO_FUNCTION_REGION,
  cors: true,
  secrets: [yocoEncryptionSecret],
  timeoutSeconds: 120
}, async (request) => {
  const { workspaceId, dataPath } = await requireWorkspaceAccess(admin, request.data?.workspaceId, request.auth, { adminOnly: true });
  await deleteYocoSecrets(db, workspaceId);
  await rtdb.ref(`${dataPath}/integrations/yoco`).update({
    status: 'disconnected',
    connectionActive: false,
    syncState: 'idle',
    health: 'offline',
    disconnectedAt: new Date().toISOString(),
    lastError: '',
    webhook: {
      enabled: false
    }
  });
  return { status: 'disconnected' };
});

if (!SKIP_XERO_FUNCTIONS) {
exports.createXeroAuthUrl = onCall({
  region: XERO_FUNCTION_REGION,
  secrets: [xeroClientIdSecret],
  timeoutSeconds: 60,
  memory: '256MiB'
}, async (request) => {
  const { workspaceId, dataPath, uid } = await requireWorkspaceAccess(admin, request.data?.workspaceId, request.auth, { adminOnly: true });
  const scopes = normalizeXeroScopes(request.data?.scopes);
  const redirectUri = buildXeroRedirectUri();
  const state = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = Date.now() + (10 * 60 * 1000);

  await rtdb.ref(`oauthStates/xero/${state}`).set({
    workspaceId,
    dataPath,
    uid,
    scopes,
    redirectUri,
    createdAt: now.toISOString(),
    expiresAt
  });

  await rtdb.ref(`${dataPath}/integrations/xero`).update({
    status: 'authorizing',
    connectionActive: false,
    health: 'pending',
    redirectUri,
    requestedScopes: scopes,
    authorizationStartedAt: now.toISOString(),
    authorizationStartedBy: uid,
    lastError: ''
  });

  const url = new URL(XERO_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', String(xeroClientIdSecret.value() || '').trim());
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);

  return {
    authUrl: url.toString(),
    redirectUri,
    state,
    scopes
  };
});

exports.xeroOAuthCallback = onRequest({
  region: XERO_FUNCTION_REGION,
  secrets: [xeroClientIdSecret, xeroClientSecretSecret, xeroEncryptionSecret],
  timeoutSeconds: 120,
  memory: '256MiB'
}, async (req, res) => {
  const state = String(req.query.state || '').trim();
  const code = String(req.query.code || '').trim();
  const oauthError = String(req.query.error || '').trim();
  const oauthErrorDescription = String(req.query.error_description || '').trim();

  try {
    if (!state) throw new Error('Missing Xero OAuth state.');
    const stateRef = rtdb.ref(`oauthStates/xero/${state}`);
    const stateSnapshot = await stateRef.get();
    const stateData = stateSnapshot.val();
    if (!stateData) throw new Error('This Xero OAuth state was not found or has already been used.');
    if (Number(stateData.expiresAt || 0) < Date.now()) {
      await stateRef.remove();
      throw new Error('This Xero OAuth state has expired. Please start the connection again.');
    }

    const workspaceId = String(stateData.workspaceId || '').trim();
    const dataPath = String(stateData.dataPath || getWorkspaceDataPath(workspaceId)).trim();
    if (!workspaceId || !dataPath) throw new Error('Xero OAuth state is missing workspace context.');

    if (oauthError) {
      const message = oauthErrorDescription || oauthError;
      await rtdb.ref(`${dataPath}/integrations/xero`).update({
        status: 'error',
        connectionActive: false,
        health: 'offline',
        lastError: message,
        updatedAt: new Date().toISOString()
      });
      await stateRef.remove();
      return sendXeroCallbackHtml(res, {
        ok: false,
        title: 'Xero connection cancelled',
        message
      });
    }

    if (!code) throw new Error('Missing Xero authorization code.');

    await rtdb.ref(`${dataPath}/integrations/xero`).update({
      status: 'connecting',
      connectionActive: false,
      health: 'pending',
      lastError: '',
      updatedAt: new Date().toISOString()
    });

    const tokenPayload = await exchangeXeroAuthorizationCode(code, stateData.redirectUri);
    const tenants = await fetchXeroConnections(tokenPayload.access_token);
    const selectedTenant = tenants[0] || null;
    await saveXeroTokens(workspaceId, tokenPayload, tenants, xeroEncryptionSecret.value());
    await stateRef.remove();

    const now = new Date().toISOString();
    await rtdb.ref(`${dataPath}/integrations/xero`).update({
      status: 'connected',
      connectionActive: true,
      health: tenants.length ? 'healthy' : 'attention',
      connectedAt: now,
      connectedBy: String(stateData.uid || ''),
      updatedAt: now,
      redirectUri: stateData.redirectUri,
      scopes: tokenPayload.scope ? String(tokenPayload.scope).split(/\s+/).filter(Boolean) : stateData.scopes || [],
      expiresAt: new Date(Date.now() + (Number(tokenPayload.expires_in || 1800) * 1000)).toISOString(),
      selectedTenantId: selectedTenant?.tenantId || '',
      selectedTenantName: selectedTenant?.tenantName || '',
      tenants: tenants.reduce((acc, tenant) => {
        acc[tenant.tenantId] = tenant;
        return acc;
      }, {}),
      lastError: tenants.length ? '' : 'Xero authorised, but no tenant connections were returned.'
    });

    return sendXeroCallbackHtml(res, {
      ok: true,
      title: 'Xero connected',
      message: selectedTenant?.tenantName
        ? `Connected to ${selectedTenant.tenantName}. You can return to Kitchen Cost Pro.`
        : 'Xero authorised. No tenant was returned, so choose an organisation in Xero and reconnect if API calls fail.'
    });
  } catch (error) {
    console.error('[xeroOAuthCallback] Failed', serializeError(error));
    return sendXeroCallbackHtml(res, {
      ok: false,
      title: 'Xero connection failed',
      message: error?.message || 'Could not complete the Xero OAuth redirect.'
    });
  }
});

exports.xeroApiRequest = onCall({
  region: XERO_FUNCTION_REGION,
  secrets: [xeroClientIdSecret, xeroClientSecretSecret, xeroEncryptionSecret],
  timeoutSeconds: 120,
  memory: '256MiB'
}, async (request) => {
  const { workspaceId, dataPath } = await requireWorkspaceAccess(admin, request.data?.workspaceId, request.auth);
  const method = String(request.data?.method || 'GET').trim().toUpperCase();
  const resourcePath = normalizeXeroResourcePath(request.data?.path || request.data?.resourcePath || '/api.xro/2.0/Organisation');
  const tenantId = String(request.data?.tenantId || '').trim();

  if (!['GET', 'POST', 'PUT'].includes(method)) {
    throw new HttpsError('invalid-argument', 'Only GET, POST, and PUT Xero API calls are currently enabled.');
  }

  try {
    const tokenState = await getUsableXeroToken(workspaceId);
    const xeroTenantId = tenantId || tokenState.selectedTenantId;
    if (!xeroTenantId) throw new Error('No Xero tenant is selected for this workspace.');

    const response = await fetch(`${XERO_API_BASE_URL}${resourcePath}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokenState.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'xero-tenant-id': xeroTenantId
      },
      body: method === 'GET' ? undefined : JSON.stringify(request.data?.body || {})
    });
    const text = await response.text();
    const parsed = parseJsonMaybe(text);
    if (!response.ok) {
      const message = parsed?.Detail || parsed?.Message || parsed?.error || `Xero API request failed with ${response.status}.`;
      throw new Error(message);
    }
    return {
      status: 'ok',
      tenantId: xeroTenantId,
      path: resourcePath,
      data: parsed ?? text
    };
  } catch (error) {
    await rtdb.ref(`${dataPath}/integrations/xero`).update({
      health: 'attention',
      lastError: error?.message || String(error),
      updatedAt: new Date().toISOString()
    });
    throw toXeroHttpsError(error);
  }
});
}

exports.maintainYocoConnections = onSchedule({
  region: YOCO_FUNCTION_REGION,
  schedule: 'every 5 minutes',
  timeZone: 'Africa/Johannesburg',
  secrets: [yocoEncryptionSecret],
  timeoutSeconds: 540,
  memory: '512MiB'
}, async () => {
  const snapshot = await db.collection('integrationSecrets').where('provider', '==', 'yoco').get();
  const results = [];

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const workspaceId = String(data.workspaceId || doc.id.replace(/_yoco$/, '') || '').trim();
    if (!workspaceId) continue;

    try {
      results.push(await maintainYocoWorkspace(workspaceId));
    } catch (error) {
      console.error('[maintainYocoConnections] Workspace sync failed', {
        workspaceId,
        ...serializeError(error)
      });
      results.push({ workspaceId, status: 'failed', message: publicYocoError(error) });
    }
  }

  console.info('[maintainYocoConnections] Complete', {
    workspaces: results.length,
    synced: results.filter((result) => result.status === 'synced').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length
  });
});

exports.syncYocoCataloguesFrequently = onSchedule({
  region: YOCO_FUNCTION_REGION,
  schedule: 'every 1 minutes',
  timeZone: 'Africa/Johannesburg',
  secrets: [yocoEncryptionSecret],
  timeoutSeconds: 120,
  memory: '512MiB'
}, async () => {
  const snapshot = await db.collection('integrationSecrets').where('provider', '==', 'yoco').get();
  const workspaceIds = snapshot.docs
    .map((doc) => String(doc.data()?.workspaceId || doc.id.replace(/_yoco$/, '') || '').trim())
    .filter(Boolean);
  const results = [];

  for (let tick = 0; tick < 4; tick += 1) {
    if (tick > 0) await sleep(YOCO_CATALOGUE_PULSE_INTERVAL_MS);

    for (const workspaceId of workspaceIds) {
      try {
        results.push(await syncYocoCataloguePulseWorkspace(workspaceId, tick));
      } catch (error) {
        console.error('[syncYocoCataloguesFrequently] Workspace catalogue sync failed', {
          workspaceId,
          tick,
          ...serializeError(error)
        });
        results.push({ workspaceId, tick, status: 'failed', message: publicYocoError(error) });
      }
    }
  }

  console.info('[syncYocoCataloguesFrequently] Complete', {
    workspaces: workspaceIds.length,
    attempts: results.length,
    synced: results.filter((result) => result.status === 'synced').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length
  });
});

exports.yocoWebhook = onRequest({ region: YOCO_FUNCTION_REGION, secrets: [yocoEncryptionSecret], timeoutSeconds: 120, memory: '512MiB' }, async (req, res) => {
  try {
    await handleYocoWebhook({
      admin,
      db,
      req,
      res,
      getSecrets: (firestore, workspaceId) => getYocoSecrets(firestore, workspaceId, yocoEncryptionSecret.value())
    });
  } catch (error) {
    console.error('[yocoWebhook] Unhandled failure', error);
    res.status(500).json({ error: 'webhook failed' });
  }
});

function buildXeroRedirectUri() {
  const configured = String(process.env.XERO_REDIRECT_URI || '').trim();
  if (configured) return configured;
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'kcp-kitchencostpro';
  return `https://${XERO_FUNCTION_REGION}-${projectId}.cloudfunctions.net/xeroOAuthCallback`;
}

function normalizeXeroScopes(value) {
  const requested = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\s]+/);
  return [...new Set([
    ...XERO_DEFAULT_SCOPES,
    ...requested
  ]
    .map((scope) => String(scope || '').trim())
    .filter(Boolean))];
}

async function exchangeXeroAuthorizationCode(code, redirectUri) {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri);
  return requestXeroToken(body);
}

async function refreshXeroToken(refreshToken) {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  return requestXeroToken(body);
}

async function requestXeroToken(body) {
  const clientId = String(xeroClientIdSecret.value() || '').trim();
  const clientSecret = String(xeroClientSecretSecret.value() || '').trim();
  if (!clientId || !clientSecret) throw new Error('Xero client credentials are not configured.');

  const response = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Xero token request failed with ${response.status}.`);
  }
  if (!payload.access_token) throw new Error('Xero did not return an access token.');
  return payload;
}

async function fetchXeroConnections(accessToken) {
  const response = await fetch(XERO_CONNECTIONS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(payload?.Detail || payload?.Message || payload?.error || `Xero connections request failed with ${response.status}.`);
  }
  return (Array.isArray(payload) ? payload : [])
    .map((connection) => ({
      id: String(connection.id || '').trim(),
      tenantId: String(connection.tenantId || '').trim(),
      tenantName: String(connection.tenantName || '').trim(),
      tenantType: String(connection.tenantType || '').trim(),
      createdDateUtc: connection.createdDateUtc || '',
      updatedDateUtc: connection.updatedDateUtc || ''
    }))
    .filter((connection) => connection.tenantId);
}

async function saveXeroTokens(workspaceId, tokenPayload = {}, tenants = [], encryptionSecretValue = '') {
  const now = new Date();
  const expiresAt = new Date(Date.now() + (Number(tokenPayload.expires_in || 1800) * 1000));
  const accessToken = encryptSecretValue(tokenPayload.access_token, encryptionSecretValue, 'XERO_TOKEN_ENCRYPTION_KEY');
  const refreshToken = encryptSecretValue(tokenPayload.refresh_token, encryptionSecretValue, 'XERO_TOKEN_ENCRYPTION_KEY');
  const ref = db.collection('integrationSecrets').doc(`${workspaceId}_xero`);
  const existing = await ref.get();
  await ref.set({
    workspaceId,
    provider: 'xero',
    tokenType: tokenPayload.token_type || 'Bearer',
    scope: tokenPayload.scope || '',
    expiresAt,
    selectedTenantId: tenants[0]?.tenantId || '',
    selectedTenantName: tenants[0]?.tenantName || '',
    tenants,
    accessTokenCiphertext: accessToken.ciphertext,
    accessTokenIv: accessToken.iv,
    accessTokenTag: accessToken.tag,
    refreshTokenCiphertext: refreshToken.ciphertext,
    refreshTokenIv: refreshToken.iv,
    refreshTokenTag: refreshToken.tag,
    updatedAt: now,
    createdAt: existing.exists ? existing.data().createdAt || now : now
  }, { merge: true });
}

async function getUsableXeroToken(workspaceId) {
  const snapshot = await db.collection('integrationSecrets').doc(`${workspaceId}_xero`).get();
  if (!snapshot.exists) throw new Error('Xero is not connected for this workspace.');
  const data = snapshot.data() || {};
  const encryptionSecretValue = xeroEncryptionSecret.value();
  let accessToken = decryptSecretValue({
    ciphertext: data.accessTokenCiphertext,
    iv: data.accessTokenIv,
    tag: data.accessTokenTag
  }, encryptionSecretValue, 'XERO_TOKEN_ENCRYPTION_KEY');
  const refreshToken = decryptSecretValue({
    ciphertext: data.refreshTokenCiphertext,
    iv: data.refreshTokenIv,
    tag: data.refreshTokenTag
  }, encryptionSecretValue, 'XERO_TOKEN_ENCRYPTION_KEY');
  if (!accessToken || !refreshToken) throw new Error('Stored Xero tokens are incomplete. Please reconnect Xero.');

  const expiresAt = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : Date.parse(data.expiresAt || '');
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 60 * 1000) {
    const refreshed = await refreshXeroToken(refreshToken);
    const tenants = Array.isArray(data.tenants) ? data.tenants : [];
    await saveXeroTokens(workspaceId, {
      ...refreshed,
      refresh_token: refreshed.refresh_token || refreshToken
    }, tenants, encryptionSecretValue);
    accessToken = refreshed.access_token;
  }

  return {
    accessToken,
    selectedTenantId: String(data.selectedTenantId || data.tenants?.[0]?.tenantId || '').trim()
  };
}

function normalizeXeroResourcePath(value) {
  const path = String(value || '').trim();
  if (!path.startsWith('/api.xro/2.0/')) {
    throw new HttpsError('invalid-argument', 'Xero API path must start with /api.xro/2.0/.');
  }
  if (/^https?:\/\//i.test(path) || path.includes('..')) {
    throw new HttpsError('invalid-argument', 'Invalid Xero API path.');
  }
  return path;
}

function encryptSecretValue(plainText, secretValue, secretName) {
  const value = String(secretValue || '').trim();
  if (!value) throw new Error(`${secretName} is not configured.`);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(value).digest(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plainText || ''), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decryptSecretValue(payload = {}, secretValue, secretName) {
  const value = String(secretValue || '').trim();
  if (!value) throw new Error(`${secretName} is not configured.`);
  if (!payload.ciphertext || !payload.iv || !payload.tag) return '';
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    crypto.createHash('sha256').update(value).digest(),
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function parseJsonMaybe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sendXeroCallbackHtml(res, { ok, title, message }) {
  res.status(ok ? 200 : 400).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#071221;color:#eaf2ff;font-family:Inter,Arial,sans-serif}
    main{width:min(560px,calc(100vw - 32px));border:1px solid #243449;border-radius:24px;background:#101c2b;padding:32px;box-shadow:0 24px 80px rgba(0,0,0,.35)}
    .badge{display:inline-flex;border-radius:999px;padding:7px 12px;background:${ok ? 'rgba(52,211,153,.12)' : 'rgba(248,113,113,.14)'};color:${ok ? '#34d399' : '#f87171'};font-weight:900;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
    h1{margin:18px 0 10px;font-size:34px;line-height:1}
    p{margin:0 0 22px;color:#a8bad4;line-height:1.55}
    a{display:inline-flex;border-radius:14px;background:#60a5fa;color:#061122;text-decoration:none;padding:12px 16px;font-weight:900}
  </style>
</head>
<body>
  <main>
    <span class="badge">${ok ? 'Connected' : 'Attention'}</span>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <a href="${escapeHtml(KCP_LOGIN_URL)}">Return to Kitchen Cost Pro</a>
  </main>
</body>
</html>`);
}

function toXeroHttpsError(error) {
  if (error instanceof HttpsError) return error;
  const message = error?.message || 'Xero request failed.';
  if (/not connected|reconnect|token/i.test(message)) return new HttpsError('failed-precondition', message);
  if (/tenant|path|method/i.test(message)) return new HttpsError('invalid-argument', message);
  return new HttpsError('internal', message);
}

async function maintainYocoWorkspace(workspaceId) {
  const dataPath = getWorkspaceDataPath(workspaceId);
  const integrationRef = rtdb.ref(`${dataPath}/integrations/yoco`);
  const integrationSnapshot = await integrationRef.get();
  const integration = integrationSnapshot.val() || {};
  const status = String(integration.status || '').toLowerCase();

  if (status === 'disconnected') {
    return { workspaceId, status: 'skipped', reason: 'disconnected' };
  }

  const lock = await acquireYocoMaintenanceLock(dataPath);
  if (!lock.acquired) {
    return { workspaceId, status: 'skipped', reason: 'locked' };
  }

  try {
    const secrets = await getYocoSecrets(db, workspaceId, yocoEncryptionSecret.value());
    const now = new Date().toISOString();
    await integrationRef.update({
      status: 'connected',
      connectionActive: true,
      syncState: 'server_syncing',
      syncSource: 'scheduled',
      lastSyncStartedAt: now,
      updatedAt: now
    });

    if (shouldRepairWebhook(integration)) {
      await integrationRef.update({
        'webhook/lastRepairAttemptAt': now
      });
      const webhookSummary = await tryCreateYocoWebhookSubscription(workspaceId, dataPath, secrets.apiKey);
      if (webhookSummary.secret) {
        await saveYocoSecrets(db, workspaceId, { webhookSecret: webhookSummary.secret }, yocoEncryptionSecret.value());
      }
    }

    let catalogueSummary = null;
    if (shouldRefreshCatalogue(integration)) {
      catalogueSummary = await syncYocoCatalogueData(admin, dataPath, secrets.apiKey);
    }

    const salesSummary = await syncYocoSalesData(admin, dataPath, secrets.apiKey);
    await integrationRef.update({
      status: 'connected',
      connectionActive: true,
      syncState: 'idle',
      health: salesSummary.errors?.length ? 'attention' : 'healthy',
      lastMaintenanceSyncAt: new Date().toISOString(),
      lastError: salesSummary.errors?.[0] || ''
    });

    return {
      workspaceId,
      status: 'synced',
      catalogueSynced: Boolean(catalogueSummary),
      ordersProcessed: salesSummary.ordersProcessed || 0,
      refundsProcessed: salesSummary.refundsProcessed || 0
    };
  } catch (error) {
    await integrationRef.update({
      status: 'connected',
      connectionActive: true,
      syncState: 'error',
      health: 'attention',
      lastMaintenanceFailedAt: new Date().toISOString(),
      lastError: publicYocoError(error)
    });
    throw error;
  } finally {
    await releaseYocoMaintenanceLock(dataPath, lock.token);
  }
}

async function syncYocoCataloguePulseWorkspace(workspaceId, tick = 0) {
  const dataPath = getWorkspaceDataPath(workspaceId);
  const integrationRef = rtdb.ref(`${dataPath}/integrations/yoco`);
  const integrationSnapshot = await integrationRef.get();
  const integration = integrationSnapshot.val() || {};
  const status = String(integration.status || '').toLowerCase();

  if (status === 'disconnected') {
    return { workspaceId, tick, status: 'skipped', reason: 'disconnected' };
  }
  if (!shouldRefreshCatalogue(integration, YOCO_CATALOGUE_PULSE_INTERVAL_MS - 1000)) {
    return { workspaceId, tick, status: 'skipped', reason: 'recent' };
  }

  const lock = await acquireYocoMaintenanceLock(dataPath, 'syncYocoCataloguesFrequently', 55 * 1000);
  if (!lock.acquired) {
    return { workspaceId, tick, status: 'skipped', reason: 'locked' };
  }

  try {
    const secrets = await getYocoSecrets(db, workspaceId, yocoEncryptionSecret.value());
    const summary = await syncYocoCatalogueData(admin, dataPath, secrets.apiKey);
    await integrationRef.update({
      status: 'connected',
      connectionActive: true,
      syncState: 'idle',
      health: 'healthy',
      lastCataloguePulseAt: new Date().toISOString(),
      lastError: ''
    });
    return {
      workspaceId,
      tick,
      status: 'synced',
      productsImported: summary.productsImported || 0,
      productsMatched: summary.productsMatched || 0,
      productsArchived: summary.productsArchived || 0
    };
  } finally {
    await releaseYocoMaintenanceLock(dataPath, lock.token);
  }
}

async function acquireYocoMaintenanceLock(dataPath, owner = 'maintainYocoConnections', ttlMs = 9 * 60 * 1000) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const lockRef = rtdb.ref(`${dataPath}/integrations/yoco/serverSyncLock`);
  let acquired = false;

  await lockRef.transaction((current) => {
    if (current?.expiresAt && Number(current.expiresAt) > now) return current;
    acquired = true;
    return {
      token,
      owner,
      acquiredAt: now,
      expiresAt
    };
  });

  return { acquired, token };
}

async function releaseYocoMaintenanceLock(dataPath, token) {
  const lockRef = rtdb.ref(`${dataPath}/integrations/yoco/serverSyncLock`);
  await lockRef.transaction((current) => {
    if (!current || current.token !== token) return current || null;
    return null;
  });
}

function shouldRefreshCatalogue(integration = {}, maxAgeMs = 6 * 60 * 60 * 1000) {
  const lastSyncedAt = Date.parse(integration.catalogue?.lastSyncedAt || '');
  if (!Number.isFinite(lastSyncedAt)) return true;
  return Date.now() - lastSyncedAt > maxAgeMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRepairWebhook(integration = {}) {
  if (integration.webhook?.enabled === true) return false;
  const lastAttemptAt = Date.parse(integration.webhook?.lastRepairAttemptAt || '');
  if (!Number.isFinite(lastAttemptAt)) return true;
  return Date.now() - lastAttemptAt > (60 * 60 * 1000);
}

async function createYocoWebhookSubscription(workspaceId, dataPath, apiKey) {
  const notificationUrl = buildYocoWebhookUrl(workspaceId);
  const subscription = await createWebhookSubscription(apiKey, {
    event_types: ['payment.created', 'payment.refunded'],
    name: `Kitchen Cost Pro ${workspaceId}`,
    notification_url: notificationUrl
  });
  await rtdb.ref(`${dataPath}/integrations/yoco/webhook`).update({
    enabled: subscription.enabled !== false,
    subscriptionId: subscription.id || '',
    notificationUrl,
    eventTypes: subscription.event_types || ['payment.created', 'payment.refunded'],
    createdAt: subscription.created_at || new Date().toISOString()
  });
  return {
    id: subscription.id || '',
    secret: subscription.secret || '',
    enabled: subscription.enabled !== false,
    notificationUrl,
    createdAt: subscription.created_at || ''
  };
}

async function tryCreateYocoWebhookSubscription(workspaceId, dataPath, apiKey) {
  try {
    return await createYocoWebhookSubscription(workspaceId, dataPath, apiKey);
  } catch (error) {
    console.error('[connectYoco] Webhook setup failed', serializeError(error));
    const notificationUrl = buildYocoWebhookUrl(workspaceId);
    await rtdb.ref(`${dataPath}/integrations/yoco/webhook`).update({
      enabled: false,
      notificationUrl,
      eventTypes: ['payment.created', 'payment.refunded'],
      lastError: publicYocoError(error),
      updatedAt: new Date().toISOString()
    });
    return {
      enabled: false,
      id: '',
      secret: '',
      notificationUrl,
      createdAt: '',
      error: publicYocoError(error)
    };
  }
}

function buildYocoWebhookUrl(workspaceId) {
  const configured = String(process.env.YOCO_WEBHOOK_BASE_URL || '').trim();
  if (configured) {
    const url = new URL(configured);
    url.searchParams.set('workspaceId', workspaceId);
    return url.toString();
  }
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'kcp-kitchencostpro';
  return `https://${YOCO_FUNCTION_REGION}-${projectId}.cloudfunctions.net/yocoWebhook?workspaceId=${encodeURIComponent(workspaceId)}`;
}

function publicYocoError(error) {
  if (error instanceof YocoApiError) return error.message;
  return error?.message || 'Yoco integration failed.';
}

function toHttpsError(error) {
  if (error instanceof HttpsError) return error;
  if (error instanceof YocoApiError) {
    if (error.status === 401 || error.status === 403) {
      return new HttpsError('permission-denied', 'Yoco rejected this API key or it does not have the required permissions.');
    }
    if (error.status === 400) return new HttpsError('invalid-argument', error.message);
    if (error.status === 404) return new HttpsError('not-found', error.message);
    if (error.status === 409) return new HttpsError('already-exists', error.message);
    if (error.status === 429) return new HttpsError('resource-exhausted', 'Yoco rate limited this request. Try again shortly.');
    if (error.status >= 500) return new HttpsError('unavailable', 'Yoco is currently returning an upstream server error. Try again shortly.');
  }
  return new HttpsError('internal', publicYocoError(error));
}

function serializeError(error) {
  if (error instanceof YocoApiError) {
    return {
      name: error.name,
      message: error.message,
      status: error.status,
      code: error.code,
      details: error.details,
      request: error.request
    };
  }
  if (error instanceof HttpsError) {
    return {
      name: 'HttpsError',
      message: error.message,
      code: error.code,
      details: error.details
    };
  }
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack
  };
}

async function requireSuperUser(auth) {
  const uid = auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before bootstrapping dashboard live state.');

  const snapshot = await rtdb.ref(`adminConfig/superusers/${uid}`).get();
  if (!snapshot.exists()) {
    throw new HttpsError('permission-denied', 'Only configured superusers can bootstrap all dashboard live states.');
  }

  return { uid };
}

function normalizeArray(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.id || String(index), item])
    : Object.entries(value);

  return entries
    .filter(([, item]) => item && typeof item === 'object')
    .map(([id, item]) => ({ id: String(item.id || id), ...item }));
}

async function sendLowStockSummaryEmailForWorkspace({ workspaceId, workspaceName, dataPath, transporter, now }) {
  const rootSnapshot = await rtdb.ref(dataPath).get();
  const root = rootSnapshot.val() || {};
  const settings = root.settings || {};
  const frequency = normalizeLowStockEmailFrequency(settings.lowStockEmailFrequency);
  if (frequency === 'off') return { workspaceId, status: 'disabled' };

  const schedule = getLowStockEmailSchedule(settings, now);
  if (!schedule.isSendHour) {
    return {
      workspaceId,
      status: 'outside_send_window',
      dispatchTime: schedule.dispatchTime,
      localTime: schedule.localTime,
      timeZone: schedule.timeZone
    };
  }

  const intervalMs = getLowStockEmailIntervalMs(frequency);
  const lastSentAt = Date.parse(settings.lowStockEmailLastSentAt || '');
  if (Number.isFinite(lastSentAt) && now.getTime() - lastSentAt < intervalMs) {
    return { workspaceId, status: 'not_due', nextAt: new Date(lastSentAt + intervalMs).toISOString() };
  }

  const recipients = getLowStockEmailRecipients(root.team || {});
  const calculatedWorkspaceName = String(settings.siteName || workspaceName || workspaceId).trim();
  const lowStockRows = buildWorkspaceLowStockRows(root);
  const checkedAt = now.toISOString();

  if (!recipients.length) {
    await rtdb.ref(`${dataPath}/settings`).update({
      lowStockEmailLastCheckedAt: checkedAt,
      lowStockEmailLastResult: 'no-tagged-recipients'
    });
    return { workspaceId, status: 'no_recipients' };
  }

  if (!lowStockRows.length) {
    await rtdb.ref(`${dataPath}/settings`).update({
      lowStockEmailLastSentAt: checkedAt,
      lowStockEmailLastCheckedAt: checkedAt,
      lowStockEmailLastResult: 'no-low-stock',
      lowStockEmailLastRecipientCount: recipients.length,
      lowStockEmailLastLowStockCount: 0
    });
    return { workspaceId, status: 'no_low_stock', recipients: recipients.length };
  }

  const frequencyLabel = getLowStockEmailFrequencyLabel(frequency);
  const pdfBuffer = buildLowStockSummaryPdf({
    workspaceName: calculatedWorkspaceName,
    frequencyLabel,
    generatedAt: checkedAt,
    rows: lowStockRows
  });
  const message = buildLowStockSummaryEmailMessage({
    workspaceName: calculatedWorkspaceName,
    frequencyLabel,
    generatedAt: checkedAt,
    recipients,
    rows: lowStockRows,
    pdfBuffer
  });
  const result = await transporter.sendMail(message);

  await rtdb.ref().update({
    [`${dataPath}/settings/lowStockEmailLastSentAt`]: checkedAt,
    [`${dataPath}/settings/lowStockEmailLastCheckedAt`]: checkedAt,
    [`${dataPath}/settings/lowStockEmailLastResult`]: 'sent',
    [`${dataPath}/settings/lowStockEmailLastRecipientCount`]: recipients.length,
    [`${dataPath}/settings/lowStockEmailLastLowStockCount`]: lowStockRows.length,
    [`${dataPath}/logs_low_stock_emails/${rtdb.ref().push().key}`]: {
      sentAt: checkedAt,
      frequency,
      recipientCount: recipients.length,
      lowStockCount: lowStockRows.length,
      messageId: result.messageId || '',
      source: 'scheduled-low-stock-summary'
    }
  });

  return {
    workspaceId,
    status: 'sent',
    recipients: recipients.length,
    lowStockCount: lowStockRows.length
  };
}

function normalizeLowStockEmailFrequency(value) {
  const frequency = String(value || '').trim();
  return ['1_day', '2_day', '1_week', '2_week', '1_month'].includes(frequency) ? frequency : 'off';
}

function getLowStockEmailSchedule(settings, now) {
  const timeZone = normalizeLowStockEmailTimeZone(settings?.lowStockEmailTimeZone || settings?.timeZone || settings?.timezone);
  const dispatchTime = normalizeLowStockEmailDispatchTime(
    settings?.lowStockEmailDispatchTime ||
    settings?.alertDispatchTime ||
    settings?.Alert_Dispatch_Time
  );
  const localTime = getTimePartsInTimeZone(now, timeZone);
  return {
    timeZone,
    dispatchTime,
    localTime: localTime.label,
    isSendHour: isWithinLowStockDispatchWindow(localTime, dispatchTime)
  };
}

function isWithinLowStockDispatchWindow(localTime, dispatchTime) {
  const currentMinutes = (Number(localTime.hour || 0) * 60) + Number(localTime.minute || 0);
  const dispatchMinutes = (Number(dispatchTime.hour || 0) * 60) + Number(dispatchTime.minute || 0);
  const delta = currentMinutes - dispatchMinutes;
  return delta >= 0 && delta < 15;
}

function normalizeLowStockEmailDispatchTime(value) {
  const raw = String(value || LOW_STOCK_EMAIL_DEFAULT_DISPATCH_TIME).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { value: LOW_STOCK_EMAIL_DEFAULT_DISPATCH_TIME, hour: 8, minute: 0 };
  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2])));
  return {
    value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hour,
    minute
  };
}

function normalizeLowStockEmailTimeZone(value) {
  const candidate = String(value || LOW_STOCK_EMAIL_DEFAULT_TIME_ZONE).trim() || LOW_STOCK_EMAIL_DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-ZA', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return LOW_STOCK_EMAIL_DEFAULT_TIME_ZONE;
  }
}

function getTimePartsInTimeZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-ZA', {
      timeZone,
      minute: '2-digit',
      hour: '2-digit',
      hour12: false
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      const normalizedHour = hour === 24 ? 0 : hour;
      return {
        hour: normalizedHour,
        minute,
        label: `${String(normalizedHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      };
    }
  } catch (error) {
    console.warn('[sendLowStockSummaryEmails] Failed to resolve local send hour', {
      timeZone,
      ...serializeError(error)
    });
  }
  const fallbackHour = nowFallbackHour(date);
  const fallbackMinute = Number.isFinite(date?.getMinutes?.()) ? date.getMinutes() : new Date().getMinutes();
  return {
    hour: fallbackHour,
    minute: fallbackMinute,
    label: `${String(fallbackHour).padStart(2, '0')}:${String(fallbackMinute).padStart(2, '0')}`
  };
}

function nowFallbackHour(date) {
  return Number.isFinite(date?.getHours?.()) ? date.getHours() : new Date().getHours();
}

function getLowStockEmailIntervalMs(frequency) {
  const dayMs = 24 * 60 * 60 * 1000;
  const intervals = {
    '1_day': dayMs,
    '2_day': dayMs * 2,
    '1_week': dayMs * 7,
    '2_week': dayMs * 14,
    '1_month': dayMs * 30
  };
  return intervals[frequency] || Number.POSITIVE_INFINITY;
}

function getLowStockEmailFrequencyLabel(frequency) {
  const labels = {
    '1_day': 'Every 1 day',
    '2_day': 'Every 2 days',
    '1_week': 'Every 1 week',
    '2_week': 'Every 2 weeks',
    '1_month': 'Every 1 month'
  };
  return labels[frequency] || 'Off';
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
  const locations = normalizeArray(root.locations);
  const locationMap = new Map(locations.map((location) => [String(location.id || '').trim(), String(location.name || location.id || 'Location').trim()]));
  const rows = [];

  normalizeArray(root.ingredients).forEach((item) => {
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

  return rows
    .sort((left, right) => {
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
    `Frequency: ${frequencyLabel}`,
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
      <p style="color:#475569">Frequency: ${escapeHtml(frequencyLabel)}<br/>Generated: ${escapeHtml(generatedAt)}</p>
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
      <p style="color:#475569">The attached PDF includes the full low-stock summary.</p>
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
    `Kitchen Cost Pro - Low Stock Summary`,
    `Workspace: ${workspaceName}`,
    `Frequency: ${frequencyLabel}`,
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
  for (let index = 0; index < lines.length; index += pageLineLimit) {
    pages.push(lines.slice(index, index + pageLineLimit));
  }
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

  if (!user || !pass) {
    throw new Error('Gmail SMTP is not configured. Set KCP_GMAIL_USER, KCP_GMAIL_APP_PASSWORD, and KCP_EMAIL_FROM Firebase secrets.');
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

function generateTemporaryPassword(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from({ length }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
}

function buildWelcomeEmailMessage(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  const siteName = String(payload.siteName || 'your KCP workspace').trim();
  const temporaryPassword = String(payload.temporaryPassword || '').trim();
  const requiresPasswordChange = Boolean(payload.requiresPasswordChange && temporaryPassword);
  const from = String(emailFromSecret.value() || gmailUserSecret.value() || '').trim();

  if (!from) throw new Error('KCP_EMAIL_FROM is not configured.');

  const subject = `Kitchen Cost Pro access for ${siteName}`;
  const intro = `Your Kitchen Cost Pro workspace "${siteName}" has been approved.`;
  const passwordLine = requiresPasswordChange
    ? `Your one-time password is: ${temporaryPassword}`
    : 'You can sign in with your existing Kitchen Cost Pro password.';
  const nextStep = requiresPasswordChange
    ? 'You will be asked to create a permanent password after signing in.'
    : 'If you cannot remember your password, use the password reset link on the sign-in screen.';

  const text = [
    'Hi,',
    '',
    intro,
    '',
    `Sign-in email: ${email}`,
    passwordLine,
    '',
    nextStep,
    '',
    `Open Kitchen Cost Pro: ${KCP_LOGIN_URL}`,
    '',
    'Regards,',
    'Kitchen Cost Pro'
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;max-width:560px">
      <h2 style="margin:0 0 16px;color:#0f172a">Kitchen Cost Pro access approved</h2>
      <p>${escapeHtml(intro)}</p>
      <p><strong>Sign-in email:</strong> ${escapeHtml(email)}</p>
      ${requiresPasswordChange
        ? `<p><strong>One-time password:</strong> <code style="font-size:16px;background:#f1f5f9;padding:4px 8px;border-radius:4px">${escapeHtml(temporaryPassword)}</code></p>`
        : '<p>You can sign in with your existing Kitchen Cost Pro password.</p>'}
      <p>${escapeHtml(nextStep)}</p>
      <p><a href="${escapeHtml(KCP_LOGIN_URL)}" style="display:inline-block;background:#00AEEF;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:bold">Open Kitchen Cost Pro</a></p>
      <p style="font-size:12px;color:#64748b">If the button does not work, open this link: ${escapeHtml(KCP_LOGIN_URL)}</p>
    </div>
  `;

  return { from, to: email, subject, text, html };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function calculateRecipeCost(recipe, ingredientMap, seen = new Set()) {
  return normalizeArray(recipe).reduce((total, line) => {
    return total + getIngredientUnitCost(line.ingId, ingredientMap, new Set(seen)) * (Number(line.qty) || 0);
  }, 0);
}

function getIngredientUnitCost(ingredientId, ingredientMap, seen = new Set()) {
  const ingredient = ingredientMap.get(String(ingredientId));
  if (!ingredient) return 0;

  const key = String(ingredient.id);
  if (seen.has(key)) return 0;
  seen.add(key);

  const recipe = Array.isArray(ingredient.recipe)
    ? ingredient.recipe
    : Object.values(ingredient.recipe || {});
  const isManufactured = ingredient.isManufactured === true ||
    String(ingredient.category || '').toLowerCase().includes('manufactured');

  if (isManufactured && recipe.length) {
    const yieldBatch = Number(ingredient.yieldBatch ?? ingredient.yieldQty ?? 1);
    return calculateRecipeCost(recipe, ingredientMap, seen) / (yieldBatch > 0 ? yieldBatch : 1);
  }

  return Number(
    ingredient.lastPurchasePrice ??
    ingredient.lastPurchaseCost ??
    ingredient.latestPurchasePrice ??
    ingredient.costEx ??
    ingredient.cost ??
    0
  ) || 0;
}

function getWorkspaceDataPath(workspaceId) {
  if (workspaceId === 'appData' || workspaceId === 'appData_legacy' || workspaceId === 'ROOT_WORKSPACE') {
    return 'appData';
  }

  return `workspaces/${workspaceId}/data`;
}

function getEmailKey(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[.#$\[\]/]/g, '_');
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

function normalizeTextKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function splitName(name = '') {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    surname: parts.slice(1).join(' ')
  };
}
