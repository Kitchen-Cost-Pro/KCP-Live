import type { AuthContext, Env } from "./types";

function text(value: unknown, fallback = "") {
  return String(value ?? fallback).trim();
}

// Manager-tier roles that are never location-restricted. Mirrors PERMISSION_MANAGER_ROLE_KEYS in
// routes.ts (kept local to avoid an import cycle). Compared against a normalized role key
// (lowercased, spaces/underscores → hyphens).
const FULL_PERMISSION_ROLE_KEYS = new Set([
  "owner",
  "admin",
  "super",
  "super-user",
  "superuser",
  "root",
  "kcp-superuser",
  "kcp-super-user",
]);

const MANAGER_ROLE_KEYS = new Set([
  ...FULL_PERMISSION_ROLE_KEYS,
  "manager",
]);

const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  manager: [
    "nav-dashboard", "nav-products", "nav-recipes", "nav-ingredients",
    "nav-grv", "nav-credit-note", "nav-suppliers", "nav-purchase-orders",
    "nav-adjustments", "nav-transfers", "nav-stock-count", "nav-locations",
    "nav-mfg-products", "nav-reporting", "nav-integrations",
    "action-edit-stock-take-7-days", "action-edit-stock-take-30-days",
    "action-save-workspace-report-views", "action-schedule-reports",
    "action-email-reports", "action-manage-report-schedules",
    "action-delete-report-schedules",
  ],
  member: [
    "nav-dashboard", "nav-products", "nav-recipes", "nav-ingredients",
    "nav-grv", "nav-credit-note", "nav-suppliers", "nav-purchase-orders",
    "nav-adjustments", "nav-transfers", "nav-stock-count", "nav-locations",
    "nav-mfg-products", "nav-integrations",
  ],
  storeman: ["nav-dashboard", "nav-grv", "nav-credit-note", "nav-suppliers", "nav-purchase-orders", "nav-transfers"],
  prep: ["nav-dashboard", "nav-mfg-products"],
  stocktaker: ["nav-dashboard", "nav-ingredients", "nav-transfers", "nav-stock-count"],
  stocktracker: ["nav-dashboard", "nav-ingredients", "nav-transfers", "nav-stock-count"],
  "transfer-agent": ["nav-dashboard", "nav-ingredients", "nav-transfers"],
  "corporate-viewer": ["nav-dashboard"],
};

function normalizeRoleKey(value: unknown) {
  return text(value).toLowerCase().replace(/[_\s]+/g, "-");
}

function isSuperRole(value: unknown) {
  const role = normalizeRoleKey(value);
  return ["super", "super-user", "superuser", "root", "kcp-superuser", "kcp-super-user"].includes(role);
}

export async function requireAuth(
  request: Request,
  env: Env,
): Promise<AuthContext> {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Missing bearer token.");

  const row = await env.CENTRAL_DB.prepare(
    `SELECT s.user_id, s.email, s.expires_at, u.display_name, u.status
       FROM auth_sessions s
       JOIN app_users u ON u.id = s.user_id
      WHERE s.token = ?1
      LIMIT 1`,
  )
    .bind(match[1])
    .first<{
      user_id: string;
      email: string;
      expires_at: string;
      display_name?: string;
      status?: string;
    }>();

  if (!row) throw new Error("Session expired. Please sign in again.");
  if (text(row.status) !== "active")
    throw new Error("This user is not active.");
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.CENTRAL_DB.prepare(`DELETE FROM auth_sessions WHERE token = ?1`)
      .bind(match[1])
      .run();
    throw new Error("Session expired. Please sign in again.");
  }

  return {
    uid: row.user_id,
    email: text(row.email).toLowerCase(),
    token: {
      sub: row.user_id,
      email: text(row.email).toLowerCase(),
      name: text(row.display_name),
    },
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
  workspaceId: string,
): Promise<string[] | null> {
  // Superusers are never restricted
  const adminRow = await env.CENTRAL_DB.prepare(
    `SELECT role_key FROM admin_users
      WHERE status = 'active'
        AND (auth_uid = ?1 OR lower(email) = lower(?2))
      LIMIT 1`,
  )
    .bind(auth.uid, auth.email)
    .first<{ role_key: string }>();
  if (isSuperRole(adminRow?.role_key)) return null;

  // Workspace admins are not restricted
  const memberRow = await env.CENTRAL_DB.prepare(
    `SELECT role_key, allowed_locations_json
       FROM workspace_members
      WHERE workspace_id = ?1
        AND status = 'active'
        AND (auth_uid = ?2 OR lower(email) = lower(?3))
      LIMIT 1`,
  )
    .bind(workspaceId, auth.uid, auth.email)
    .first<{ role_key: string; allowed_locations_json?: string }>();

  if (!memberRow) return [];
  // Manager-tier roles are never location-restricted (mirrors PERMISSION_MANAGER_ROLE_KEYS in
  // routes.ts). Previously only a literal 'admin' was exempt, so a location-scoped OWNER/manager
  // could not see locations they created (a fresh location id isn't in their allowed list yet).
  const normalizedRole = text(memberRow.role_key)
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (MANAGER_ROLE_KEYS.has(normalizedRole)) return null;

  // Workspace owner is always unrestricted, even if their member role_key isn't a manager key.
  const ownerRow = await env.CENTRAL_DB.prepare(
    `SELECT owner_uid FROM workspaces WHERE id = ?1 LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ owner_uid?: string }>();
  if (
    ownerRow &&
    text(ownerRow.owner_uid) &&
    text(ownerRow.owner_uid) === text(auth.uid)
  )
    return null;

  // Parse JSON location list. Security is fail-closed for non-manager roles:
  // missing, malformed, or empty assignments mean zero accessible locations.
  // Unrestricted access must be explicit via the string/array value 'all'.
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(memberRow.allowed_locations_json || "null");
    if (parsed === "all") return null;
    if (Array.isArray(parsed)) {
      const values = parsed.map((v) => String(v).trim()).filter(Boolean);
      if (values.some((v) => v.toLowerCase() === "all")) return null;
      ids = values;
    } else if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (record.all === true || record.unrestricted === true) return null;
      const values = Array.isArray(record.locations) ? record.locations : [];
      ids = values.map((v) => String(v).trim()).filter(Boolean);
    }
  } catch {
    return [];
  }

  return ids;
}

export async function getWorkspacePermissions(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
): Promise<string[]> {
  const access = await assertWorkspaceAccess(env, auth, workspaceId);
  const normalizedRole = text(access.role_key)
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (FULL_PERMISSION_ROLE_KEYS.has(normalizedRole)) return ["*"];

  const row = await env.CENTRAL_DB.prepare(
    `SELECT permissions_json FROM roles WHERE workspace_id = ?1 AND role_key = ?2 LIMIT 1`,
  )
    .bind(workspaceId, access.role_key)
    .first<{ permissions_json?: string }>();

  try {
    const parsed = JSON.parse(row?.permissions_json || "[]");
    const values = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as Record<string, unknown>).permissions)
        ? ((parsed as Record<string, unknown>).permissions as unknown[])
        : [];
    const explicit = values.map((value) => text(value)).filter(Boolean);
    return explicit.length ? explicit : [...(DEFAULT_ROLE_PERMISSIONS[normalizedRole] || [])];
  } catch {
    return [...(DEFAULT_ROLE_PERMISSIONS[normalizedRole] || [])];
  }
}

async function recordPermissionDenial(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  detail: Record<string, unknown>,
) {
  try {
    const createdAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'permission_denied', 'security', ?4, ?5, ?6)`,
    )
      .bind(
        `audit_${crypto.randomUUID()}`,
        workspaceId,
        auth.uid,
        text(detail.permission || detail.locationId || "access"),
        JSON.stringify(detail),
        createdAt,
      )
      .run();
  } catch {
    // A failed audit write must not convert a denial into access.
  }
}

export async function assertWorkspacePermission(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  permission: string,
): Promise<void> {
  const permissions = await getWorkspacePermissions(env, auth, workspaceId);
  if (permissions.includes("*") || permissions.includes(permission)) return;
  await recordPermissionDenial(env, auth, workspaceId, {
    permission,
    reason: "missing_permission",
  });
  throw new Error(`Permission denied: ${permission}.`);
}

export async function assertLocationAccess(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  locationId: string,
  context = "location",
): Promise<void> {
  const normalizedLocationId = text(locationId);
  if (!normalizedLocationId) {
    await recordPermissionDenial(env, auth, workspaceId, {
      locationId: "",
      context,
      reason: "missing_location",
    });
    throw new Error("Permission denied: a permitted location is required.");
  }
  const allowed = await getUserAllowedLocationIds(env, auth, workspaceId);
  if (allowed === null || allowed.includes(normalizedLocationId)) return;
  await recordPermissionDenial(env, auth, workspaceId, {
    locationId: normalizedLocationId,
    context,
    reason: "location_not_assigned",
  });
  throw new Error(`Permission denied for location ${normalizedLocationId}.`);
}

export async function assertReportLocationScope(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  request: Request,
): Promise<void> {
  await assertWorkspacePermission(env, auth, workspaceId, "nav-reporting");
  const allowed = await getUserAllowedLocationIds(env, auth, workspaceId);
  if (allowed === null) return;
  const url = new URL(request.url);
  const raw = [
    ...url.searchParams.getAll("locationId"),
    ...url.searchParams.getAll("locationIds"),
    ...url.searchParams.getAll("location"),
  ]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (!raw.length) {
    await recordPermissionDenial(env, auth, workspaceId, {
      permission: "nav-reporting",
      reason: "unscoped_report_request",
    });
    throw new Error(
      "Permission denied: restricted users must select an assigned location for reports.",
    );
  }
  for (const locationId of raw)
    await assertLocationAccess(env, auth, workspaceId, locationId, "report");
}

export async function assertWorkspaceAccess(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  // KCP superusers have implicit access to every active workspace
  const adminRow = await env.CENTRAL_DB.prepare(
    `SELECT role_key FROM admin_users
      WHERE status = 'active'
        AND (auth_uid = ?1 OR lower(email) = lower(?2))
      LIMIT 1`,
  )
    .bind(auth.uid, auth.email)
    .first<{ role_key: string }>();

  if (isSuperRole(adminRow?.role_key)) {
    const ws = await env.CENTRAL_DB.prepare(
      `SELECT id FROM workspaces WHERE id = ?1 AND status = 'active' LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ id: string }>();
    if (!ws) throw new Error("Workspace not found or inactive.");
    return { id: auth.uid, role_key: "superuser", status: "active" };
  }

  const ownedWorkspace = await env.CENTRAL_DB.prepare(
    `SELECT id FROM workspaces WHERE id = ?1 AND status = 'active' AND owner_uid = ?2 LIMIT 1`,
  )
    .bind(workspaceId, auth.uid)
    .first<{ id: string }>();
  if (ownedWorkspace?.id) {
    return { id: auth.uid, role_key: "owner", status: "active" };
  }

  const row = await env.CENTRAL_DB.prepare(
    `SELECT id, role_key, status
       FROM workspace_members
      WHERE workspace_id = ?1
        AND status = 'active'
        AND (auth_uid = ?2 OR lower(email) = lower(?3))
      LIMIT 1`,
  )
    .bind(workspaceId, auth.uid, auth.email)
    .first<{ id: string; role_key: string; status: string }>();

  if (!row) throw new Error("No active access to this workspace.");
  return row;
}
