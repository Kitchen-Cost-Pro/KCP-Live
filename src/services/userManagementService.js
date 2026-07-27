import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import {
  buildRoleOptions,
  DEFAULT_ROLES,
  getAllowedSections,
  getRoleCatalog,
  isSuperUserRoleName,
  normalizeCustomRoles,
  resolveRoleDefinition,
  toRoleLabel
} from './roleService.js';

export function subscribeWorkspaceAccess(workspaceId, user, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for access management.');

  let closed = false;

  const load = async () => {
    try {
      const response = await callCloudflareWorkspaceRoute(workspaceKey, 'access-management');
      if (closed) return;
      const team = normalizeTeamMembers(response.team || []);
      const customRoles = sanitizeCloudflareRoles(response.customRoles || []);
      const superUsers = normalizeSuperUsers(response.superUsers || []);
      const currentRole = response.currentRole || resolveCurrentRole(team, user) || 'member';
      const currentIsSuperUser = response.currentIsSuperUser === true || isListedSuperUser(user, superUsers);
      const currentIsKcpSuperUser = response.currentIsKcpSuperUser === true;
      const roleDefinition = resolveRoleDefinition(currentRole, customRoles);
      // User-assigned locations (the physical locations the employee is assigned to work at)
      const currentMember = team.find((m) => m.uid === (user?.uid || user?.id) || m.email === (user?.email || '').toLowerCase());
      const currentUserLocations = currentMember?.allowedLocations || [];
      const currentUserCanAccessExternalTransfers = currentMember ? currentMember.canAccessExternalTransfers !== false : true;
      // The KCP Super User is a hidden role — strip it (and its members) from everything the UI
      // consumes, for every user. resolveRoleDefinition still uses the full catalog above so an
      // actual super user's own permissions continue to resolve.
      const isHiddenSuperUser = (member) => isListedSuperUser(member, superUsers) || isSuperUserRoleName(member?.role);
      onSnapshot?.({
        status: 'ready',
        team: team
          .filter((member) => !isHiddenSuperUser(member))
          .map((member) => ({
            ...member,
            isSuperUser: isListedSuperUser(member, superUsers)
          })),
        customRoles: customRoles.filter((role) => !isSuperUserRoleName(role.name)),
        superUsers,
        currentIsSuperUser,
        currentIsKcpSuperUser,
        roleCatalog: getRoleCatalog(customRoles).filter((role) => !isSuperUserRoleName(role.name)),
        roleOptions: buildRoleOptions(customRoles).filter((option) => !isSuperUserRoleName(option.value)),
        locations: normalizeLocations(response.locations || []),
        currentRole,
        currentUserLocations,
        currentUserCanAccessExternalTransfers,
        roleDefinition,
        allowedSections: getAllowedSections(currentRole, customRoles),
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      if (!closed) onError?.(error, 'live:access-management');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

function sanitizeCloudflareRoles(value = []) {
  const roles = normalizeCustomRoles(value);
  const presetNames = new Set(DEFAULT_ROLES.map((role) => role.name));
  return roles.filter((role) => !presetNames.has(role.name));
}

export async function createWorkspaceMember(workspaceId, workspaceName, actor, payload = {}) {
  const normalized = normalizeMemberPayload(payload);
  const result = await callCloudflareWorkspaceRoute(workspaceId, 'members', {
    method: 'POST',
    payload: {
      ...normalized,
      workspaceName,
      invitedBy: actor?.email || actor?.uid || ''
    }
  });
  return result || { mode: 'saved', email: normalized.email, role: normalized.role };
}

export async function updateWorkspaceMember(workspaceId, member, payload = {}) {
  const current = member && typeof member === 'object' ? member : {};
  const memberId = String(current.id || current.key || '').trim();
  if (!memberId) throw new Error('User record could not be found.');
  await callCloudflareWorkspaceRoute(workspaceId, `members/${encodeURIComponent(memberId)}`, {
    method: 'PATCH',
    payload: normalizeMemberPayload({ ...current, ...payload })
  });
}

export async function removeWorkspaceMember(workspaceId, member) {
  const memberId = String(member?.id || member?.key || '').trim();
  if (!memberId) throw new Error('User record could not be found.');
  await callCloudflareWorkspaceRoute(workspaceId, `members/${encodeURIComponent(memberId)}`, {
    method: 'DELETE'
  });
}

export async function resendWorkspaceMemberInvite(workspaceId, memberId) {
  const mid = String(memberId || '').trim();
  if (!mid) throw new Error('Member id is required.');
  await callCloudflareWorkspaceRoute(workspaceId, `members/${encodeURIComponent(mid)}/resend-invite`, { method: 'POST' });
}

export async function saveWorkspaceRole(workspaceId, payload = {}) {
  const roleName = String(payload.name || '').trim();
  const label = String(payload.label || toRoleLabel(payload.name)).trim();
  if (!roleName) throw new Error('Role name is required.');

  await callCloudflareWorkspaceRoute(workspaceId, 'roles', {
    method: 'POST',
    payload: {
      name: roleName,
      label,
      permissions: Array.isArray(payload.permissions) ? payload.permissions.filter(Boolean) : [],
      locations: Array.isArray(payload.locations) && payload.locations.length ? payload.locations : ['all']
    }
  });
}

export async function deleteWorkspaceRole(workspaceId, roleName) {
  const target = String(roleName || '').trim().toLowerCase();
  if (!target) throw new Error('Role name is required.');
  await callCloudflareWorkspaceRoute(workspaceId, `roles/${encodeURIComponent(target)}`, {
    method: 'DELETE'
  });
}

function normalizeMemberPayload(payload = {}) {
  const email = String(payload.email || '').trim().toLowerCase();
  const firstName = String(payload.firstName || '').trim();
  const surname = String(payload.surname || '').trim();
  const fullName = String(payload.name || `${firstName} ${surname}`.trim() || email.split('@')[0] || 'Workspace User').trim();
  const role = String(payload.role || 'member').trim() || 'member';
  const viewingOnly = payload.viewingOnly === true || String(payload.viewingOnly || '').toLowerCase() === 'true';
  const lowStockAlert = payload.lowStockAlert === true || payload.lowStockAlertTag === true ||
    String(payload.lowStockAlert || payload.lowStockAlertTag || '').toLowerCase() === 'true';

  if (!email) throw new Error('Email is required.');
  if (!fullName) throw new Error('Name is required.');

  const allowedLocations = Array.isArray(payload.allowedLocations)
    ? payload.allowedLocations.map((v) => String(v || '').trim()).filter(Boolean)
    : [];

  return {
    email,
    firstName,
    surname,
    name: fullName,
    role,
    viewingOnly,
    lowStockAlert,
    canAccessExternalTransfers: payload.canAccessExternalTransfers !== false,
    allowedLocations
  };
}

function normalizeTeamMembers(value) {
  const entries = Array.isArray(value) ? value : Object.values(value || {});
  const candidates = entries
    .filter((member) => member && typeof member === 'object')
    .map((member) => {
      const email = String(member.email || '').trim().toLowerCase();
      const firstName = String(member.firstName || '').trim();
      const surname = String(member.surname || '').trim();
      const fullName = String(member.name || `${firstName} ${surname}`.trim() || email.split('@')[0] || 'Workspace User').trim();
      return {
        key: String(member.key || member.id || member.uid || email || '').trim(),
        id: String(member.id || member.key || member.uid || email || '').trim(),
        uid: String(member.uid || '').trim(),
        email,
        role: String(member.role || 'member').trim() || 'member',
        viewingOnly: member.viewingOnly === true || member.viewOnly === true,
        lowStockAlert: isLowStockAlertMember(member),
        allowedLocations: Array.isArray(member.allowedLocations) ? member.allowedLocations.map((v) => String(v || '').trim()).filter(Boolean) : [],
        firstName,
        surname,
        name: fullName,
        joinedAt: member.joinedAt || member.createdAt || '',
        invitedAt: member.invitedAt || '',
        invitedBy: member.invitedBy || '',
        status: String(member.status || (member.uid ? 'active' : 'invited')).trim()
      };
    });

  const deduped = new Map();
  candidates
    .sort((left, right) => {
      if (left.status === right.status) return String(left.name).localeCompare(String(right.name));
      return left.status === 'active' ? -1 : 1;
    })
    .forEach((member) => {
      const key = member.uid || member.email || member.key;
      if (!deduped.has(key)) deduped.set(key, member);
    });

  return [...deduped.values()].sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function normalizeSuperUsers(value) {
  const entries = Array.isArray(value) ? value : Object.entries(value || {}).map(([key, member]) => ({ key, ...member }));
  return entries
    .filter((member) => member && typeof member === 'object')
    .map((member) => ({
      key: String(member.key || member.uid || '').trim(),
      uid: String(member.uid || member.key || '').trim(),
      email: String(member.email || '').trim().toLowerCase(),
      name: String(member.name || '').trim(),
      surname: String(member.surname || '').trim()
    }))
    .filter((member) => member.uid || member.email);
}

function isLowStockAlertMember(member = {}) {
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

function isListedSuperUser(user = {}, superUsers = []) {
  const uid = String(user?.uid || user?.key || '').trim();
  const email = String(user?.email || '').trim().toLowerCase();
  return (superUsers || []).some((superUser) => (
    (uid && (String(superUser.uid || '') === uid || String(superUser.key || '') === uid)) ||
    (email && String(superUser.email || '').toLowerCase() === email)
  ));
}

function normalizeLocations(value) {
  const entries = Array.isArray(value) ? value : Object.values(value || {});
  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: String(entry.id || '').trim(),
      locationId: String(entry.locationId || entry.id || '').trim(),
      name: String(entry.displayName || entry.name || '').trim(),
      displayName: String(entry.displayName || entry.name || '').trim(),
      type: String(entry.type || entry.kind || '').trim(),
      kind: String(entry.kind || entry.type || '').trim(),
      isDefault: entry.isDefault === true || Number(entry.isDefault || entry.is_default || 0) === 1
    }))
    .filter((entry) => entry.id && entry.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function resolveCurrentRole(team, user) {
  const uid = String(user?.uid || '').trim();
  const email = String(user?.email || '').trim().toLowerCase();
  return team.find((member) => member.uid === uid)?.role
    || team.find((member) => member.key === uid)?.role
    || team.find((member) => member.email === email)?.role
    || '';
}
