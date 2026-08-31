import type { AuthContext, Env } from '../../legacy/types';
import { getWorkspaceActorRole, PERMISSION_MANAGER_ROLE_KEYS } from '../../legacy/routes';

/**
 * "Configuring Xero" is a workspace-owner-level action, same bar as connecting Yoco or managing
 * permission sets (denyUnlessPermissionManager in legacy/routes.ts) — the workspace's own owner,
 * admin, or a KCP superuser. This is deliberately NOT auth.systemRole === 'admin' (that field is
 * the internal KCP admin-portal role used by modules/yoco-engine-v2's diagnostics console, which a
 * normal business owner configuring their own workspace's integrations will never have).
 */
export async function canManageXero(env: Env, auth: AuthContext, workspaceId: string): Promise<boolean> {
  const role = await getWorkspaceActorRole(env, auth, workspaceId);
  return PERMISSION_MANAGER_ROLE_KEYS.has(role);
}
