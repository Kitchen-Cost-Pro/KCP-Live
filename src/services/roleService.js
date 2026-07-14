export const SECTION_PERMISSION_MAP = {
  dashboard: 'nav-dashboard',
  products: 'nav-products',
  recipes: 'nav-recipes',
  ingredients: 'nav-ingredients',
  suppliers: 'nav-suppliers',
  'purchase-orders': 'nav-purchase-orders',
  grv: 'nav-grv',
  'credit-note': 'nav-credit-note',
  adjustments: 'nav-adjustments',
  transfers: 'nav-transfers',
  'stock-count': 'nav-stock-count',
  locations: 'nav-locations',
  'mfg-products': 'nav-mfg-products',
  reporting: 'nav-reporting',
  'reporting-scheduling': 'action-schedule-reports',
  integrations: 'nav-integrations',
  'user-management': 'nav-user-management',
  'custom-roles': 'nav-custom-roles',
  settings: 'nav-settings',
  'settings-business': 'nav-settings',
  'settings-customization': 'nav-settings'
};

export const ACTION_PERMISSION_MAP = {
  deleteRecords: 'action-delete-records',
  bulkDelete: 'action-bulk-delete',
  editStockTake7Days: 'action-edit-stock-take-7-days',
  editStockTake30Days: 'action-edit-stock-take-30-days',
  manageUsers: 'action-manage-users',
  manageRoles: 'action-manage-roles',
  assignLowStockEmailTag: 'action-assign-low-stock-email-tag',
  externalTransfers: 'action-external-transfers',
  saveWorkspaceReportViews: 'action-save-workspace-report-views',
  scheduleReports: 'action-schedule-reports',
  emailReports: 'action-email-reports',
  manageReportSchedules: 'action-manage-report-schedules',
  deleteReportSchedules: 'action-delete-report-schedules'
};

const FULL_ACTION_PERMISSIONS = Object.values(ACTION_PERMISSION_MAP);

export function getAccessRenderRevision(access = {}) {
  const stableList = (values = []) => (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .sort()
    .join(',');
  const rolePermissions = stableList(access.roleDefinition?.permissions);
  const roleLocations = stableList(access.roleDefinition?.locations);
  const userLocations = stableList(access.currentUserLocations);
  return [
    String(access.status || 'idle'),
    String(access.currentRole || ''),
    access.currentIsSuperUser === true ? 'super' : 'standard',
    access.currentIsKcpSuperUser === true ? 'kcp-super' : 'workspace-user',
    stableList(access.allowedSections),
    rolePermissions,
    roleLocations,
    userLocations,
    access.currentUserCanAccessExternalTransfers === false ? 'no-external-transfers' : 'external-transfers'
  ].join('|');
}

export const DEFAULT_ROLES = [
  {
    id: 'superuser',
    name: 'superuser',
    label: 'KCP Superuser',
    permissions: [
      'nav-dashboard',
      'nav-products',
      'nav-recipes',
      'nav-ingredients',
      'nav-grv',
      'nav-credit-note',
      'nav-suppliers',
      'nav-purchase-orders',
      'nav-adjustments',
      'nav-transfers',
      'nav-stock-count',
      'nav-locations',
      'nav-mfg-products',
      'nav-reporting',
      'nav-integrations',
      'nav-user-management',
      'nav-custom-roles',
      'nav-settings',
      ...FULL_ACTION_PERMISSIONS
    ],
    locations: ['all']
  },
  {
    id: 'owner',
    name: 'owner',
    label: 'Owner',
    permissions: [
      'nav-dashboard',
      'nav-products',
      'nav-recipes',
      'nav-ingredients',
      'nav-grv',
      'nav-credit-note',
      'nav-suppliers',
      'nav-purchase-orders',
      'nav-adjustments',
      'nav-transfers',
      'nav-stock-count',
      'nav-locations',
      'nav-mfg-products',
      'nav-reporting',
      'nav-integrations',
      'nav-user-management',
      'nav-custom-roles',
      'nav-settings',
      ...FULL_ACTION_PERMISSIONS
    ],
    locations: ['all']
  },
  {
    id: 'admin',
    name: 'admin',
    label: 'Admin',
    permissions: [
      'nav-dashboard',
      'nav-products',
      'nav-recipes',
      'nav-ingredients',
      'nav-grv',
      'nav-credit-note',
      'nav-suppliers',
      'nav-purchase-orders',
      'nav-adjustments',
      'nav-transfers',
      'nav-stock-count',
      'nav-locations',
      'nav-mfg-products',
      'nav-reporting',
      'nav-integrations',
      'nav-user-management',
      'nav-custom-roles',
      'nav-settings',
      ...FULL_ACTION_PERMISSIONS
    ],
    locations: ['all']
  },
  {
    id: 'manager',
    name: 'manager',
    label: 'Manager',
    permissions: [
      'nav-dashboard',
      'nav-products',
      'nav-recipes',
      'nav-ingredients',
      'nav-grv',
      'nav-credit-note',
      'nav-suppliers',
      'nav-purchase-orders',
      'nav-adjustments',
      'nav-transfers',
      'nav-stock-count',
      'nav-locations',
      'nav-mfg-products',
      'nav-reporting',
      'nav-integrations',
      ACTION_PERMISSION_MAP.editStockTake7Days,
      ACTION_PERMISSION_MAP.editStockTake30Days,
      ACTION_PERMISSION_MAP.saveWorkspaceReportViews,
      ACTION_PERMISSION_MAP.scheduleReports,
      ACTION_PERMISSION_MAP.emailReports,
      ACTION_PERMISSION_MAP.manageReportSchedules,
      ACTION_PERMISSION_MAP.deleteReportSchedules
    ],
    locations: ['all']
  },
  {
    id: 'member',
    name: 'member',
    label: 'Member',
    permissions: [
      'nav-dashboard',
      'nav-products',
      'nav-recipes',
      'nav-ingredients',
      'nav-grv',
      'nav-credit-note',
      'nav-suppliers',
      'nav-purchase-orders',
      'nav-adjustments',
      'nav-transfers',
      'nav-stock-count',
      'nav-locations',
      'nav-mfg-products',
      'nav-integrations'
    ],
    locations: ['all']
  },
  {
    id: 'storeman',
    name: 'storeman',
    label: 'Storeman',
    permissions: [
      'nav-dashboard',
      'nav-grv',
      'nav-credit-note',
      'nav-suppliers',
      'nav-purchase-orders',
      'nav-transfers'
    ],
    locations: ['all']
  },
  {
    id: 'prep',
    name: 'prep',
    label: 'Prep',
    permissions: ['nav-dashboard', 'nav-mfg-products'],
    locations: ['all']
  },
  {
    id: 'stocktaker',
    name: 'stocktaker',
    label: 'Stock Taker',
    permissions: ['nav-dashboard', 'nav-ingredients', 'nav-transfers', 'nav-stock-count'],
    locations: ['all']
  },
  {
    id: 'stocktracker',
    name: 'stocktracker',
    label: 'Stock Tracker',
    permissions: ['nav-dashboard', 'nav-ingredients', 'nav-transfers', 'nav-stock-count'],
    locations: ['all']
  },
  {
    id: 'transfer_agent',
    name: 'transfer_agent',
    label: 'Transfer Agent',
    permissions: ['nav-dashboard', 'nav-ingredients', 'nav-transfers'],
    locations: ['all']
  },
  {
    id: 'corporate_viewer',
    name: 'corporate_viewer',
    label: 'Corporate Viewer',
    permissions: ['nav-dashboard'],
    locations: ['all']
  }
];

export function normalizeCustomRoles(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value
    : Object.values(value);

  return entries
    .filter((role) => role && typeof role === 'object')
    .map((role) => ({
      name: normalizeRoleName(role.name),
      label: String(role.label || role.name || '')
        .trim(),
      permissions: normalizePermissions(role.permissions),
      locations: normalizeLocations(role.locations)
    }))
    .filter((role) => role.name);
}

export function getRoleCatalog(customRoles = []) {
  const normalizedCustoms = normalizeCustomRoles(customRoles);
  const defaults = DEFAULT_ROLES.map((role) => {
    const override = normalizedCustoms.find((entry) => entry.name === role.name);
    return override
      ? { ...role, ...override, label: override.label || role.label, isPreset: true, isModified: true }
      : { ...role, isPreset: true, isModified: false };
  });

  const customsOnly = normalizedCustoms
    .filter((role) => !DEFAULT_ROLES.some((preset) => preset.name === role.name))
    .map((role) => ({
      ...role,
      label: role.label || toRoleLabel(role.name),
      isPreset: false,
      isModified: false,
      isCustom: true
    }));

  return [...defaults, ...customsOnly];
}

export function resolveRoleDefinition(roleName, customRoles = []) {
  const normalized = normalizeRoleName(roleName) || 'member';
  return getRoleCatalog(customRoles).find((role) => role.name === normalized) || {
    ...DEFAULT_ROLES.find((role) => role.name === 'member'),
    label: 'Member'
  };
}

export function getAllowedSections(roleName, customRoles = []) {
  if (isSuperUserRoleName(roleName)) return Object.keys(SECTION_PERMISSION_MAP);
  const role = resolveRoleDefinition(roleName, customRoles);
  return Object.entries(SECTION_PERMISSION_MAP)
    .filter(([, permissionId]) => role.permissions.includes(permissionId))
    .map(([sectionId]) => sectionId);
}

export function hasSectionAccess(sectionId, roleName, customRoles = []) {
  if (isSuperUserRoleName(roleName)) return true;
  const permissionId = SECTION_PERMISSION_MAP[String(sectionId || '').trim()];
  if (!permissionId) return true;
  const role = resolveRoleDefinition(roleName, customRoles);
  return role.permissions.includes(permissionId);
}

export function hasLocationAccess(locationId, roleName, customRoles = []) {
  if (isSuperUserRoleName(roleName)) return true;
  const role = resolveRoleDefinition(roleName, customRoles);
  if ((role.locations || []).includes('all')) return true;
  return (role.locations || []).includes(String(locationId || '').trim());
}

export function hasPermission(permissionId, roleName, customRoles = []) {
  if (isSuperUserRoleName(roleName)) return true;
  const cleanPermissionId = String(permissionId || '').trim();
  if (!cleanPermissionId) return true;
  const role = resolveRoleDefinition(roleName, customRoles);
  return role.permissions.includes(cleanPermissionId);
}

// The KCP Super User is a hidden system role: it must never appear in any role list/picker and
// its members must never appear in a workspace team list, for any user (owners/admins included).
export function isSuperUserRoleName(roleName = '') {
  return ['super', 'super-user', 'superuser', 'root', 'kcp-superuser', 'kcp-super-user'].includes(normalizeRoleName(roleName));
}

export function canManagePermissionSets(roleName = '', currentIsSuperUser = false) {
  if (currentIsSuperUser === true) return true;
  const normalized = normalizeRoleName(roleName);
  return ['owner', 'admin', 'super', 'super-user', 'superuser', 'root', 'kcp-superuser', 'kcp-super-user'].includes(normalized);
}

export function buildRoleOptions(customRoles = []) {
  return getRoleCatalog(customRoles).map((role) => ({
    value: role.name,
    label: role.label || toRoleLabel(role.name),
    badge: role.isPreset ? (role.isModified ? 'Modified' : 'System') : 'Custom'
  }));
}

export function toRoleLabel(roleName = '') {
  const normalized = normalizeRoleName(roleName);
  const preset = DEFAULT_ROLES.find((role) => role.name === normalized);
  if (preset?.label) return preset.label;
  return String(roleName || '')
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function normalizeRoleName(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function normalizePermissions(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean))];
}

function normalizeLocations(value) {
  const list = Array.isArray(value) ? value : [];
  if (!list.length) return ['all'];
  const normalized = [...new Set(list.map((entry) => String(entry || '').trim()).filter(Boolean))];
  return normalized.includes('all') ? ['all'] : normalized;
}
