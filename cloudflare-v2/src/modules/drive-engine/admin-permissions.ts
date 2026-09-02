import type { AuthContext, Env } from '../../legacy/types';
import { getWorkspaceActorRole, PERMISSION_MANAGER_ROLE_KEYS } from '../../legacy/routes';

/**
 * "Configuring Google Drive" (connect/disconnect, push toggles, the OCR Assistant toggle) is a
 * workspace-owner-level action, same bar as modules/xero-engine/admin-permissions.ts's
 * canManageXero — the workspace's own owner, admin, or a KCP superuser. Deliberately NOT
 * auth.systemRole === 'admin' (the separate internal KCP admin-portal role).
 */
export async function canManageDrive(env: Env, auth: AuthContext, workspaceId: string): Promise<boolean> {
  const role = await getWorkspaceActorRole(env, auth, workspaceId);
  return PERMISSION_MANAGER_ROLE_KEYS.has(role);
}
