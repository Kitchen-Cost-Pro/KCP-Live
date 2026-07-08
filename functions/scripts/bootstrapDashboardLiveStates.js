const admin = require('firebase-admin');
const { rebuildDashboardSummaryForWorkspace } = require('../dashboardSummary');

const databaseURL = process.env.FIREBASE_DATABASE_URL ||
  'https://kcp-kitchencostpro-default-rtdb.europe-west1.firebasedatabase.app';

admin.initializeApp({ databaseURL });

async function main() {
  const rtdb = admin.database();
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
        calculatedAt: summary.liveStateCalculatedAt || summary.calculatedAt
      });
      console.log(`[dashboard_live_state] ${workspaceId} -> ${summary.liveStatePath}`);
    } catch (error) {
      results.push({
        workspaceId,
        status: 'failed',
        message: error?.message || String(error)
      });
      console.error(`[dashboard_live_state] ${workspaceId} failed`, error);
    }
  }

  const appDataSnapshot = await rtdb.ref('appData').get();
  if (appDataSnapshot.exists()) {
    try {
      const summary = await rebuildDashboardSummaryForWorkspace(admin, 'appData');
      results.push({
        workspaceId: 'appData',
        status: 'populated',
        liveStatePath: summary.liveStatePath,
        calculatedAt: summary.liveStateCalculatedAt || summary.calculatedAt
      });
      console.log(`[dashboard_live_state] appData -> ${summary.liveStatePath}`);
    } catch (error) {
      results.push({
        workspaceId: 'appData',
        status: 'failed',
        message: error?.message || String(error)
      });
      console.error('[dashboard_live_state] appData failed', error);
    }
  }

  const failed = results.filter((result) => result.status === 'failed').length;
  console.log(JSON.stringify({
    attempted: results.length,
    populated: results.length - failed,
    failed,
    results
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await admin.app().delete();
  });
