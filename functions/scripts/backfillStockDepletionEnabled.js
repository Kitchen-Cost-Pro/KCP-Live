// One-time backfill: set settings.stockDepletionEnabled = true for every existing workspace.
// The new "Go Live" gate in functions/yoco/sales.js defaults stockDepletionEnabled to false
// for workspaces that have never set it, so existing customers must be marked live BEFORE
// that gate ships — otherwise their Yoco sales would silently stop depleting stock. Only
// brand-new workspaces (created after this backfill runs) should start at false and require
// an explicit "Go Live" click in Business Settings.
const admin = require('firebase-admin');

const databaseURL = process.env.FIREBASE_DATABASE_URL ||
  'https://kcp-kitchencostpro-default-rtdb.europe-west1.firebasedatabase.app';

admin.initializeApp({ databaseURL });

function getWorkspaceDataPath(workspaceId) {
  if (workspaceId === 'appData' || workspaceId === 'appData_legacy' || workspaceId === 'ROOT_WORKSPACE') {
    return 'appData';
  }
  return `workspaces/${workspaceId}/data`;
}

async function main() {
  const rtdb = admin.database();
  const workspacesSnapshot = await rtdb.ref('workspaces').get();
  const workspaceIds = Object.keys(workspacesSnapshot.val() || {});
  const targets = [...workspaceIds, 'appData'];
  const results = [];

  for (const workspaceId of targets) {
    const dataPath = getWorkspaceDataPath(workspaceId);
    try {
      const settingsRef = rtdb.ref(`${dataPath}/settings`);
      const snapshot = await settingsRef.get();
      if (!snapshot.exists()) {
        results.push({ workspaceId, status: 'skipped-no-settings' });
        continue;
      }
      if (snapshot.val()?.stockDepletionEnabled === true) {
        results.push({ workspaceId, status: 'already-set' });
        continue;
      }
      await settingsRef.update({ stockDepletionEnabled: true });
      results.push({ workspaceId, status: 'updated' });
      console.log(`[stock_depletion_backfill] ${workspaceId} -> stockDepletionEnabled=true`);
    } catch (error) {
      results.push({ workspaceId, status: 'failed', message: error?.message || String(error) });
      console.error(`[stock_depletion_backfill] ${workspaceId} failed`, error);
    }
  }

  const failed = results.filter((result) => result.status === 'failed').length;
  console.log(JSON.stringify({
    attempted: results.length,
    updated: results.filter((r) => r.status === 'updated').length,
    alreadySet: results.filter((r) => r.status === 'already-set').length,
    skipped: results.filter((r) => r.status === 'skipped-no-settings').length,
    failed
  }, null, 2));

  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('[stock_depletion_backfill] fatal error', error);
  process.exit(1);
});
