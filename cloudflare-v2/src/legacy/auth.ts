import type { AuthContext, Env } from './types';

function text(value: unknown, fallback = '') {
  return String(value ?? fallback).trim();
}

// Manager-tier roles that are never location-restricted. Mirrors PERMISSION_MANAGER_ROLE_KEYS in
// routes.ts (kept local to avoid an import cycle). Compared against a normalized role key
// (lowercased, spaces/underscores → hyphens).
const MANAGER_ROLE_KEYS = new Set(['owner', 'admin', 'super', 'super-user', 'superuser', 'root']);

export async function requireAuth(request: Request, env: Env): Promise<AuthContext> {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('Missing bearer token.');

  const row = await env.CENTRAL_DB.prepare(
    `SELECT s.user_id, s.email, s.expires_at, u.display_name, u.status
       FROM auth_sessions s
       JOIN app_users u ON u.id = s.user_id
      WHERE s.token = ?1
      LIMIT 1`
  ).bind(match[1]).first<{
    user_id: string;
    email: string;
    expires_at: string;
    display_name?: string;
    status?: string;
  }>();

  if (!row) throw new Error('Session expired. Please sign in again.');
  if (text(row.status) !== 'active') throw new Error('This user is not active.');
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.CENTRAL_DB.prepare(`DELETE FROM auth_sessions WHERE token = ?1`).bind(match[1]).run();
    throw new Error('Session expired. Please sign in again.');
  }

  return {
    uid: row.user_id,
    email: text(row.email).toLowerCase(),
    token: {
      sub: row.user_id,
      email: text(row.email).toLowerCase(),
      name: text(row.display_name)
    }
  };
}

/**
 * Returns the location IDs this user is allowed to access within a workspace.
 * Returns null when unrestricted (workspace admins / superusers).
 * Returns a string array (possibly empty) when location-scoped.
 */
export async function getUserAllowedLocationIds(
  env: Env,
  auth: AuthContext,
  workspaceId: string
): Promise<string[] | null> {
  // Superusers are never restricted
  const adminRow = await env.CENTRAL_DB.prepare(
    `SELECT role_key FROM admin_users
      WHERE status = 'active'
        AND (auth_uid = ?1 OR lower(email) = lower(?2))
      LIMIT 1`
  ).bind(auth.uid, auth.email).first<{ role_key: string }>();
  if (text(adminRow?.role_key).toLowerCase() === 'superuser') return null;

  // Workspace admins are not restricted
  const memberRow = await env.CENTRAL_DB.prepare(
    `SELECT role_key, allowed_locations_json
       FROM workspace_members
      WHERE workspace_id = ?1
        AND status = 'active'
        AND (auth_uid = ?2 OR lower(email) = lower(?3))
      LIMIT 1`
  ).bind(workspaceId, auth.uid, auth.email).first<{ role_key: string; allowed_locations_json?: string }>();

  if (!memberRow) return [];
  // Manager-tier roles are never location-restricted (mirrors PERMISSION_MANAGER_ROLE_KEYS in
  // routes.ts). Previously only a literal 'admin' was exempt, so a location-scoped OWNER/manager
  // could not see locations they created (a fresh location id isn't in their allowed list yet).
  const normalizedRole = text(memberRow.role_key).toLowerCase().replace(/[_\s]+/g, '-');
  if (MANAGER_ROLE_KEYS.has(normalizedRole)) return null;

  // Workspace owner is always unrestricted, even if their member role_key isn't a manager key.
  const ownerRow = await env.CENTRAL_DB.prepare(
    `SELECT owner_uid FROM workspaces WHERE id = ?1 LIMIT 1`
  ).bind(workspaceId).first<{ owner_uid?: string }>();
  if (ownerRow && text(ownerRow.owner_uid) && text(ownerRow.owner_uid) === text(auth.uid)) return null;

  // Parse JSON location list — null/empty means unrestricted for backward compat
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(memberRow.allowed_locations_json || 'null');
    if (Array.isArray(parsed)) ids = parsed.map((v) => String(v).trim()).filter(Boolean);
  } catch { /* ignore */ }

  return ids.length ? ids : null;
}

export async function assertWorkspaceAccess(env: Env, auth: AuthContext, workspaceId: string) {
  // KCP superusers have implicit access to every active workspace
  const adminRow = await env.CENTRAL_DB.prepare(
    `SELECT role_key FROM admin_users
      WHERE status = 'active'
        AND (auth_uid = ?1 OR lower(email) = lower(?2))
      LIMIT 1`
  ).bind(auth.uid, auth.email).first<{ role_key: string }>();

  if (text(adminRow?.role_key).toLowerCase() === 'superuser') {
    const ws = await env.CENTRAL_DB.prepare(
      `SELECT id FROM workspaces WHERE id = ?1 AND status = 'active' LIMIT 1`
    ).bind(workspaceId).first<{ id: string }>();
    if (!ws) throw new Error('Workspace not found or inactive.');
    return { id: auth.uid, role_key: 'superuser', status: 'active' };
  }

  const row = await env.CENTRAL_DB.prepare(
    `SELECT id, role_key, status
       FROM workspace_members
      WHERE workspace_id = ?1
        AND status = 'active'
        AND (auth_uid = ?2 OR lower(email) = lower(?3))
      LIMIT 1`
  ).bind(workspaceId, auth.uid, auth.email).first<{ id: string; role_key: string; status: string }>();

  if (!row) throw new Error('No active access to this workspace.');
  return row;
}
