import type { AuthContext, Env } from "./types";

function text(value: unknown, fallback = "") {
  return String(value ?? fallback).trim();
}

// Workspace owners/admins and KCP superusers are never location-restricted. Managers can be
// assigned to one or more locations and must respect that scope like every other operational role.
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

// Request-local resolved location scopes. Report handlers validate and resolve the
// requested scope once, then query builders consume the exact permitted IDs.
const RESOLVED_REPORT_LOCATION_SCOPES = new WeakMap<Request, string[] | null>();

const DATA_PERMISSION_SCHEMA_MARKER = "permission-schema-import-export-v1";
const SECTION_DATA_PERMISSIONS: Record<string, { nav: string; import?: string; export?: string }> = {
  products: { nav: "nav-products", import: "action-import-products", export: "action-export-products" },
  recipes: { nav: "nav-recipes", import: "action-import-recipes", export: "action-export-recipes" },
  ingredients: { nav: "nav-ingredients", import: "action-import-ingredients", export: "action-export-ingredients" },
  suppliers: { nav: "nav-suppliers", import: "action-import-suppliers", export: "action-export-suppliers" },
  "purchase-orders": { nav: "nav-purchase-orders", export: "action-export-purchase-orders" },
  transfers: { nav: "nav-transfers", import: "action-import-transfers", export: "action-export-transfers" },
  "stock-count": { nav: "nav-stock-count", import: "action-import-stock-count", export: "action-export-stock-count" },
  "mfg-products": { nav: "nav-mfg-products", import: "action-import-manufacturing", export: "action-export-manufacturing" },
  reporting: { nav: "nav-reporting", export: "action-export-reporting" },
  settings: { nav: "nav-settings", import: "action-import-settings", export: "action-export-settings" },
};

export function getResolvedReportLocationScope(request: Request): string[] | null | undefined {
  return RESOLVED_REPORT_LOCATION_SCOPES.get(request);
}

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
  // Owners/admins and KCP superusers are unrestricted. Managers are intentionally not included:
  // their member assignment is authoritative for dashboard and report location scope.
  const normalizedRole = text(memberRow.role_key)
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (FULL_PERMISSION_ROLE_KEYS.has(normalizedRole)) return null;

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

  // Role location rules define the maximum scope. A member assignment can narrow that scope.
  // This keeps role-level location permissions and per-user location assignments consistent.
  const roleRow = await env.CENTRAL_DB.prepare(
    `SELECT permissions_json FROM roles WHERE workspace_id = ?1 AND role_key = ?2 LIMIT 1`,
  )
    .bind(workspaceId, memberRow.role_key)
    .first<{ permissions_json?: string }>();

  const roleLocations = parseRoleLocationScope(roleRow?.permissions_json);
  const memberLocations = parseMemberLocationScope(memberRow.allowed_locations_json);

  if (roleLocations === null && memberLocations === null) return null;
  if (roleLocations === null) return memberLocations || [];
  if (memberLocations === null) return roleLocations;
  if (!memberLocations.length || !roleLocations.length) return [];

  const memberSet = new Set(memberLocations);
  return roleLocations.filter((locationId) => memberSet.has(locationId));
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
    return expandLegacyDataPermissions(explicit.length ? explicit : [...(DEFAULT_ROLE_PERMISSIONS[normalizedRole] || [])]);
  } catch {
    return expandLegacyDataPermissions([...(DEFAULT_ROLE_PERMISSIONS[normalizedRole] || [])]);
  }
}

function expandLegacyDataPermissions(permissions: string[]): string[] {
  const normalized = Array.from(new Set(permissions.map((permission) => text(permission)).filter(Boolean)));
  const explicit = normalized.includes(DATA_PERMISSION_SCHEMA_MARKER) || normalized.some((permission) =>
    permission.startsWith("action-import-") || permission.startsWith("action-export-")
  );
  if (explicit) return normalized;

  const migrated = new Set(normalized);
  for (const definition of Object.values(SECTION_DATA_PERMISSIONS)) {
    if (!migrated.has(definition.nav)) continue;
    if (definition.import) migrated.add(definition.import);
    if (definition.export) migrated.add(definition.export);
  }
  migrated.add(DATA_PERMISSION_SCHEMA_MARKER);
  return [...migrated];
}

function parseMemberLocationScope(value: unknown): string[] | null {
  // For restricted users, missing, malformed, or empty assignments mean zero accessible locations.
  try {
    const parsed = JSON.parse(text(value) || "null");
    if (parsed === "all") return null;
    if (Array.isArray(parsed)) {
      const ids = Array.from(new Set(parsed.map((entry) => text(entry)).filter(Boolean)));
      if (ids.some((entry) => entry.toLowerCase() === "all")) return null;
      return ids;
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (record.all === true || record.unrestricted === true) return null;
      const values = Array.isArray(record.locations) ? record.locations : [];
      const ids = Array.from(new Set(values.map((entry) => text(entry)).filter(Boolean)));
      return ids;
    }
  } catch {
    return [];
  }
  return [];
}

function parseRoleLocationScope(value: unknown): string[] | null {
  try {
    const parsed = JSON.parse(text(value) || "{}");
    const values = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).locations
      : null;
    if (!Array.isArray(values)) return null;
    const normalized = Array.from(new Set(values.map((entry) => text(entry)).filter(Boolean)));
    return normalized.some((entry) => entry.toLowerCase() === "all") ? null : normalized;
  } catch {
    return null;
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
  const url = new URL(request.url);
  const requested = Array.from(new Set([
    ...url.searchParams.getAll("locationId"),
    ...url.searchParams.getAll("locationIds"),
    ...url.searchParams.getAll("location"),
  ]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)));

  if (allowed === null) {
    RESOLVED_REPORT_LOCATION_SCOPES.set(request, requested.length ? requested : null);
    return;
  }

  if (!allowed.length) {
    await recordPermissionDenial(env, auth, workspaceId, {
      permission: "nav-reporting",
      reason: "no_assigned_locations",
    });
    throw new Error("Permission denied: no locations are assigned to this user.");
  }

  const resolved = requested.length ? requested : allowed;
  for (const locationId of resolved)
    await assertLocationAccess(env, auth, workspaceId, locationId, "report");
  RESOLVED_REPORT_LOCATION_SCOPES.set(request, resolved);
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
