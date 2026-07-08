const { HttpsError } = require('firebase-functions/v2/https');
const { getWorkspaceDataPath } = require('./utils');

async function requireWorkspaceAccess(admin, workspaceId, auth, options = {}) {
  const uid = auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before connecting Yoco.');
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new HttpsError('invalid-argument', 'Workspace id is required.');

  const dataPath = getWorkspaceDataPath(workspaceKey);
  const [profileWorkspace, teamMember] = await Promise.all([
    admin.database().ref(`users/${uid}/profile/workspaces/${workspaceKey}`).get(),
    admin.database().ref(`${dataPath}/team/${uid}`).get()
  ]);

  if (!profileWorkspace.exists() && !teamMember.exists()) {
    throw new HttpsError('permission-denied', 'You do not have access to this workspace.');
  }

  const profileRole = String(profileWorkspace.val()?.role || '').toLowerCase();
  const teamRole = String(teamMember.val()?.role || '').toLowerCase();
  const role = teamRole || profileRole || 'member';
  const isAdmin = role === 'owner' || role === 'admin';

  if (options.adminOnly && !isAdmin) {
    throw new HttpsError('permission-denied', 'Only workspace owners or admins can manage Yoco.');
  }

  return {
    uid,
    workspaceId: workspaceKey,
    dataPath,
    role,
    isAdmin
  };
}

module.exports = {
  requireWorkspaceAccess
};
