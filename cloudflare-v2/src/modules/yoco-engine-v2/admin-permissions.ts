export const YOCO_V2_ADMIN_PERMISSIONS = [
  'yoco_v2.view',
  'yoco_v2.view_payload',
  'yoco_v2.replay',
  'yoco_v2.reconcile',
  'yoco_v2.manual_review',
  'yoco_v2.configure',
  'yoco_v2.cutover'
] as const;

export type YocoV2AdminPermission = typeof YOCO_V2_ADMIN_PERMISSIONS[number];

export interface YocoV2AdminPrincipal {
  uid: string;
  email: string;
  systemRole?: 'admin' | 'queue';
  adminRole?: string;
  permissions?: string[];
}

const READ_ONLY_ADMIN_PERMISSIONS: YocoV2AdminPermission[] = ['yoco_v2.view'];

export function permissionsForAdminRole(role: string, isSuper = false): YocoV2AdminPermission[] {
  if (isSuper || String(role || '').toLowerCase() === 'superuser') return [...YOCO_V2_ADMIN_PERMISSIONS];
  return [...READ_ONLY_ADMIN_PERMISSIONS];
}

export function hasYocoV2AdminPermission(
  principal: YocoV2AdminPrincipal,
  permission: YocoV2AdminPermission
): boolean {
  if (principal.systemRole !== 'admin') return false;
  if (String(principal.adminRole || '').toLowerCase() === 'superuser') return true;
  return Array.isArray(principal.permissions) && principal.permissions.includes(permission);
}

export function requireYocoV2AdminPermission(
  principal: YocoV2AdminPrincipal,
  permission: YocoV2AdminPermission
): void {
  if (!hasYocoV2AdminPermission(principal, permission)) {
    throw new YocoV2AdminPermissionError(permission);
  }
}

export class YocoV2AdminPermissionError extends Error {
  readonly permission: YocoV2AdminPermission;

  constructor(permission: YocoV2AdminPermission) {
    super(`Missing required permission: ${permission}`);
    this.name = 'YocoV2AdminPermissionError';
    this.permission = permission;
  }
}
