import type { AuthContext } from '../../legacy/types';

export const XERO_ADMIN_PERMISSIONS = ['xero.view', 'xero.configure', 'xero.sync'] as const;
export type XeroAdminPermission = typeof XERO_ADMIN_PERMISSIONS[number];

/** Mirrors modules/yoco-engine-v2/admin-permissions.ts: only workspace admins may touch the Xero
 * connection at all, and only a superuser (or an explicit permission grant) may configure/trigger
 * a sync — a plain admin can view status but not change account-code mappings or push data. */
export function hasXeroAdminPermission(auth: AuthContext, permission: XeroAdminPermission): boolean {
  if (auth.systemRole !== 'admin') return false;
  if (String(auth.adminRole || '').toLowerCase() === 'superuser') return true;
  return Array.isArray(auth.permissions) && auth.permissions.includes(permission);
}
