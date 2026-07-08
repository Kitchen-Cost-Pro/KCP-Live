import type { Env, AuthContext } from './types';
import type { Env as LegacyEnv } from './legacy/types';
import { postAdminApproveRegistration, getAdminOverview, deleteAdminWorkspace, getAdminWorkspaceSettings, patchAdminWorkspaceSettings, getAdminOrgSites, requireAdmin, writeAdminAuditEvent, adminAuditActor } from './legacy/admin-routes';
import type { AdminTenantSummary, AdminOrgFields } from './legacy/admin-routes';
import { dispatchCentralRoute } from './legacy/index';
import { sendDueLowStockEmailSummaries } from './legacy/low-stock-email';

export { WorkspaceDO } from './workspace-do';

/** A legacy Env whose env.DB is the CENTRAL D1 — for central-plane handlers (auth/admin). */
function centralLegacyEnv(env: Env): LegacyEnv {
  return { ...env, DB: env.CENTRAL_DB, CENTRAL_DB: env.CENTRAL_DB } as unknown as LegacyEnv;
}

/**
 * Dispatch ALL central-plane routes (auth + admin + security-config + invitations + ...) against
 * CENTRAL_DB via the shared legacy dispatcher. Returns null if no central route matches.
 * The ONE special case is registration approval = PROVISIONING: after the central rows are created we
 * must also seed the new workspace's DO (default settings + location), which the legacy handler can't
 * do. So we intercept approve here and run the DO seed afterwards.
 */
async function dispatchCentral(request: Request, env: Env, url: URL): Promise<Response | null> {
  const lenv = centralLegacyEnv(env);

  const approveM = url.pathname.match(/^\/api\/admin\/registration-requests\/([^/]+)\/approve$/);
  if (request.method === 'POST' && approveM) {
    const resp = await postAdminApproveRegistration(request, lenv, approveM[1]);
    const data = (await resp.clone().json().catch(() => ({}))) as { ok?: boolean; workspaceId?: string; siteName?: string };
    if (data.ok && data.workspaceId) {
      await provisionWorkspaceTenant(env, String(data.workspaceId), String(data.siteName || ''));
    }
    return resp;
  }

  // Admin overview: central rows come from CENTRAL_DB, but each workspace's settings/metrics/Yoco live
  // in its own DO. Fan out to the DOs (only the front Worker has env.WORKSPACE) and feed the result in.
  if (request.method === 'GET' && url.pathname === '/api/admin') {
    const provider = async (workspaceIds: string[]): Promise<Record<string, AdminTenantSummary>> => {
      const results = await fanOutWorkspaceDOs(env, workspaceIds, 'admin-summary', { uid: 'admin', email: '' });
      const map: Record<string, AdminTenantSummary> = {};
      for (const r of results) {
        const d = r.data as any;
        if (d && d.ok) map[r.workspaceId] = { settings: d.settings, metrics: d.metrics, yoco: d.yoco };
      }
      return map;
    };
    return getAdminOverview(request, lenv, provider);
  }

  // Delete workspace: central rows come out of CENTRAL_DB here, but the tenant tables live in the DO.
  // Supply a purge callback that clears the DO (only the front Worker has env.WORKSPACE).
  const deleteM = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)$/);
  if (request.method === 'DELETE' && deleteM) {
    const wsId = decodeURIComponent(deleteM[1]);
    // Best-effort: strip this workspace from every peer's org/franchise linkedSites (stored in each
    // peer's DO settings) BEFORE deleting, so stale group references can never block deletion.
    // Non-fatal — wrapped so any peer failure can't abort the delete.
    try { await cleanupPeerGroupLinks(env, wsId); } catch { /* stale-link cleanup is best-effort */ }
    const purgeTenant = async (workspaceId: string): Promise<number> => {
      const res = await callWorkspaceDO(env, workspaceId, 'admin-purge', { uid: 'admin', email: '' }, 'POST', {});
      return Number((res as any)?.deletedRows || 0);
    };
    return deleteAdminWorkspace(request, lenv, wsId, purgeTenant);
  }

  // Admin workspace settings (billing lock etc.): workspace_settings lives in the DO, not CENTRAL_DB.
  // Gate via requireAdmin in the central handler, but read/merge through the workspace's DO.
  const settingsM = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)\/settings$/);
  if (settingsM && (request.method === 'GET' || request.method === 'PATCH' || request.method === 'POST')) {
    const wsId = decodeURIComponent(settingsM[1]);
    const adminAuth = { uid: 'admin', email: '' };
    if (request.method === 'GET') {
      return getAdminWorkspaceSettings(request, lenv, wsId, async (id) => {
        const r = await callWorkspaceDO(env, id, 'admin-settings', adminAuth, 'GET');
        return ((r as any)?.settings as Record<string, any>) || {};
      });
    }
    return patchAdminWorkspaceSettings(request, lenv, wsId, async (id, payload) => {
      const r = await callWorkspaceDO(env, id, 'admin-settings', adminAuth, 'PATCH', payload);
      return ((r as any)?.settings as Record<string, any>) || {};
    });
  }

  // --- Workspace-scoped admin actions: these query TENANT tables (yoco_connections, locations,
  // products, this workspace's settings) which live in the DO, not CENTRAL_DB. Gate centrally with
  // requireAdmin (CENTRAL_DB), run the tenant op inside the DO, then write the audit event centrally.
  // Previously these ran in the front Worker against CENTRAL_DB and threw → generic "Something went
  // wrong" for every workspace admin action. ---
  const adminAuth = { uid: 'admin', email: '' };
  const yocoM = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)\/yoco\/([^/]+)$/);
  if (yocoM) {
    const wsId = decodeURIComponent(yocoM[1]);
    const action = yocoM[2];
    if (request.method === 'GET' && action === 'status') {
      await requireAdmin(request, lenv);
      const r = await callWorkspaceDO(env, wsId, 'admin-yoco/status', adminAuth, 'GET');
      return json(request, env, r || { ok: false, error: 'No response from workspace.' }, r ? 200 : 502);
    }
    if (request.method === 'POST') {
      const session = await requireAdmin(request, lenv);
      const body = await request.clone().json().catch(() => ({}));
      const r = await callWorkspaceDO(env, wsId, `admin-yoco/${action}`, adminAuth, 'POST', body);
      if (!r || (r as any).ok === false) {
        return json(request, env, { ok: false, error: (r as any)?.error || `Yoco ${action} failed for this workspace.` }, 502);
      }
      await writeAdminAuditEvent(lenv, adminAuditActor(session), `yoco.${action.replace(/-/g, '_')}`, wsId, {}).catch(() => {});
      return json(request, env, r);
    }
  }

  const actionM = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)\/actions\/([^/]+)$/);
  if (actionM && request.method === 'POST') {
    const wsId = decodeURIComponent(actionM[1]);
    const action = actionM[2];
    const session = await requireAdmin(request, lenv);
    const body = await request.clone().json().catch(() => ({}));
    const r = await callWorkspaceDO(env, wsId, `admin-action/${action}`, adminAuth, 'POST', body);
    if (!r || (r as any).ok === false) {
      return json(request, env, { ok: false, error: (r as any)?.error || `Action ${action} failed for this workspace.` }, 502);
    }
    await writeAdminAuditEvent(lenv, adminAuditActor(session), `action.${action.replace(/-/g, '_')}`, wsId, {}).catch(() => {});
    return json(request, env, r);
  }

  // (email-queue stays central: workspace_invitations lives in CENTRAL_DB, so it already works.)

  // Org manager list: org fields (orgId/corpId/groupMetadata/linkedSites) live in each workspace's DO
  // settings. Gate centrally, then fan out to every workspace DO and feed the org fields in.
  if (request.method === 'GET' && url.pathname === '/api/admin/org-sites') {
    const provider = async (workspaceIds: string[]): Promise<Record<string, AdminOrgFields>> => {
      const results = await fanOutWorkspaceDOs(env, workspaceIds, 'admin-org-fields', adminAuth);
      const map: Record<string, AdminOrgFields> = {};
      for (const r of results) {
        const d = r.data as any;
        if (d && d.ok) map[r.workspaceId] = { orgId: d.orgId, corpId: d.corpId, groupMetadata: d.groupMetadata, linkedSites: d.linkedSites };
      }
      return map;
    };
    return getAdminOrgSites(request, lenv, provider);
  }

  // Unlink a workspace from its org/group: clear the target's OWN org fields in its DO settings
  // (source of truth), then best-effort strip it from every peer's linkedSites.
  const unlinkM = url.pathname.match(/^\/api\/admin\/org-sites\/([^/]+)\/unlink$/);
  if (unlinkM && request.method === 'POST') {
    const wsId = decodeURIComponent(unlinkM[1]);
    await requireAdmin(request, lenv);
    const r = await callWorkspaceDO(env, wsId, 'admin-unlink-org', adminAuth, 'POST', {});
    try { await cleanupPeerGroupLinks(env, wsId); } catch { /* peer cleanup is best-effort */ }
    return json(request, env, r || { ok: true }, r ? 200 : 200);
  }

  return dispatchCentralRoute(request, lenv);
}

/** Seed a newly-approved workspace's DO with its tenant baseline (settings + default location). */
async function provisionWorkspaceTenant(env: Env, workspaceId: string, siteName: string): Promise<void> {
  const now = new Date().toISOString();
  const tables = {
    workspace_settings: [
      { workspace_id: workspaceId, raw_json: JSON.stringify({ siteName, businessName: siteName }), updated_at: now }
    ],
    locations: [
      {
        id: `loc_${workspaceId}_main`,
        workspace_id: workspaceId,
        name: 'Main Storage',
        display_name: 'Main Storage',
        kind: 'storage',
        active: 1,
        is_default: 1,
        created_at: now,
        updated_at: now
      }
    ]
  };
  await callWorkspaceDO(env, workspaceId, 'migrate-import', { uid: 'system', email: '' }, 'POST', { tables });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const ok = allowed.some((a) => a === origin || (a.includes('*') && matchWildcard(a, origin)));
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function matchWildcard(pattern: string, value: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
  return re.test(value);
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function json(request: Request, env: Env, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) }
  });
}

/** Validate the bearer token against the CENTRAL auth plane. */
async function requireAuth(request: Request, env: Env): Promise<AuthContext | null> {
  const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const row = await env.CENTRAL_DB.prepare(
    `SELECT u.id AS uid, u.email AS email, s.expires_at AS expires_at, u.status AS status
       FROM auth_sessions s
       JOIN app_users u ON u.id = s.user_id
      WHERE s.token = ?1
      LIMIT 1`
  )
    .bind(match[1])
    .first<{ uid: string; email: string; expires_at: string; status: string }>();
  if (!row) return null;
  if (row.status && row.status !== 'active') return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
  return { uid: String(row.uid), email: String(row.email || '') };
}

/** Confirm the user may access this workspace (membership OR superuser), via the CENTRAL plane. */
async function assertWorkspaceAccess(env: Env, auth: AuthContext, workspaceId: string): Promise<boolean> {
  const admin = await env.CENTRAL_DB.prepare(
    `SELECT role_key FROM admin_users
      WHERE status = 'active' AND (auth_uid = ?1 OR lower(email) = lower(?2)) LIMIT 1`
  )
    .bind(auth.uid, auth.email)
    .first<{ role_key: string }>();
  if (admin && String(admin.role_key || '').toLowerCase() === 'superuser') return true;

  const member = await env.CENTRAL_DB.prepare(
    `SELECT id FROM workspace_members
      WHERE workspace_id = ?1 AND status = 'active' AND (auth_uid = ?2 OR lower(email) = lower(?3))
      LIMIT 1`
  )
    .bind(workspaceId, auth.uid, auth.email)
    .first<{ id: string }>();
  return Boolean(member);
}

/** Forward an authenticated, authorized request to the workspace's Durable Object. */
async function forwardToWorkspaceDO(
  request: Request,
  env: Env,
  workspaceId: string,
  resource: string,
  auth: AuthContext
): Promise<Response> {
  const id = env.WORKSPACE.idFromName(workspaceId);
  const stub = env.WORKSPACE.get(id);
  const forwarded = new Request(request.url, {
    method: request.method,
    headers: new Headers(request.headers),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body
  });
  forwarded.headers.set('x-kcp-workspace', workspaceId);
  forwarded.headers.set('x-kcp-resource', resource);
  forwarded.headers.set('x-kcp-auth', JSON.stringify(auth));
  return stub.fetch(forwarded);
}

/**
 * Fan-out primitive: synthesize an internal request to ANY workspace's DO for a given resource and
 * return its parsed JSON. Used by cross-workspace reads (linked-transfer profiles, org/corp
 * consolidated reports, admin overview) that must run in the front Worker where env.WORKSPACE lives.
 */
async function callWorkspaceDO(
  env: Env,
  workspaceId: string,
  resource: string,
  auth: AuthContext,
  method = 'GET',
  bodyObj: unknown = null
): Promise<Record<string, unknown> | null> {
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('x-kcp-workspace', workspaceId);
  headers.set('x-kcp-resource', resource);
  headers.set('x-kcp-auth', JSON.stringify(auth));
  const req = new Request(`https://do/api/workspaces/${encodeURIComponent(workspaceId)}/${resource}`, {
    method,
    headers,
    body: bodyObj == null ? undefined : JSON.stringify(bodyObj)
  });
  try {
    const res = await stub.fetch(req);
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Fan out the same resource to many workspaces concurrently; nulls for any that failed. */
async function fanOutWorkspaceDOs(
  env: Env,
  workspaceIds: string[],
  resource: string,
  auth: AuthContext
): Promise<Array<{ workspaceId: string; data: Record<string, unknown> | null }>> {
  return Promise.all(
    workspaceIds.map(async (workspaceId) => ({
      workspaceId,
      data: await callWorkspaceDO(env, workspaceId, resource, auth)
    }))
  );
}

/** Central-plane tables the data-migration tool may write (into CENTRAL_DB). */
const CENTRAL_TABLE_ALLOWLIST = new Set([
  'app_users', 'auth_sessions', 'auth_rate_limits', 'auth_reset_tokens', 'workspaces',
  'workspace_members', 'roles', 'admin_users', 'admin_system_settings', 'admin_audit_events',
  'workspace_registration_requests', 'workspace_invitations', 'external_transfers'
]);
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

async function isSuperuser(env: Env, auth: AuthContext): Promise<boolean> {
  const row = await env.CENTRAL_DB.prepare(
    `SELECT role_key FROM admin_users WHERE status = 'active' AND (auth_uid = ?1 OR lower(email) = lower(?2)) LIMIT 1`
  ).bind(auth.uid, auth.email).first<{ role_key?: string }>();
  return Boolean(row) && String(row?.role_key || '').toLowerCase() === 'superuser';
}

/** Bulk-import central rows into CENTRAL_DB (data-migration). Identifiers validated; values bound. */
async function migrateCentral(env: Env, body: { tables?: Record<string, unknown> }): Promise<Response> {
  const tables = (body && body.tables) || {};
  const counts: Record<string, number> = {};
  for (const [table, rawRows] of Object.entries(tables)) {
    if (!CENTRAL_TABLE_ALLOWLIST.has(table) || !SQL_IDENTIFIER.test(table)) continue;
    const rows = Array.isArray(rawRows) ? (rawRows as Record<string, unknown>[]) : [];
    let n = 0;
    let batch: D1PreparedStatement[] = [];
    for (const row of rows) {
      const cols = Object.keys(row).filter((c) => SQL_IDENTIFIER.test(c));
      if (!cols.length) continue;
      const ph = cols.map((_, i) => `?${i + 1}`).join(', ');
      batch.push(
        env.CENTRAL_DB.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${ph})`).bind(...cols.map((c) => row[c]))
      );
      n += 1;
      if (batch.length >= 50) {
        await env.CENTRAL_DB.batch(batch);
        batch = [];
      }
    }
    if (batch.length) await env.CENTRAL_DB.batch(batch);
    counts[table] = n;
  }
  return new Response(JSON.stringify({ ok: true, counts }), { headers: { 'content-type': 'application/json' } });
}

/** Re-attach CORS headers onto a response produced outside the normal json() helper. */
function withCors(request: Request, env: Env, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Assemble linked-transfer profiles by fanning out to each org/corp peer's own DO (each DO can only
 * see its own stock). Replaces the old single-DB buildLinkedTransferProfile cross-workspace read.
 */
async function getLinkedTransferProfilesFanOut(env: Env, workspaceId: string, auth: AuthContext): Promise<Response> {
  const reg = await env.CENTRAL_DB.prepare(
    `SELECT org_id, corp_id FROM workspaces WHERE id = ?1 LIMIT 1`
  ).bind(workspaceId).first<{ org_id?: string; corp_id?: string }>();
  const orgId = String(reg?.org_id || '');
  const corpId = String(reg?.corp_id || '');

  let peers: string[] = [];
  if (orgId || corpId) {
    const rows = await env.CENTRAL_DB.prepare(
      `SELECT id FROM workspaces
        WHERE id != ?1 AND status = 'active'
          AND ((org_id = ?2 AND ?2 != '') OR (corp_id = ?3 AND ?3 != ''))`
    ).bind(workspaceId, orgId, corpId).all<{ id: string }>();
    peers = (rows.results || []).map((r) => String(r.id)).filter(Boolean);
  }

  const results = await fanOutWorkspaceDOs(env, peers, 'transfer-profile', auth);
  const linkedProfiles = results.map((r) => r.data && r.data.profile).filter(Boolean);
  return new Response(JSON.stringify({ ok: true, linkedProfiles }), {
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * Remove a workspace id from every peer workspace's org/franchise group links (linkedSites +
 * groupMetadata), which live in each peer's DO settings (workspace_settings.raw_json). Called before
 * deleting a workspace so stale group references can never cause the delete (or later group ops) to
 * fail — even if the workspace was already "removed" from the group but a peer still lists it.
 * Best-effort: peers that error are skipped.
 */
async function cleanupPeerGroupLinks(env: Env, wsId: string): Promise<void> {
  const rows = await env.CENTRAL_DB.prepare(
    `SELECT id FROM workspaces WHERE id != ?1`
  ).bind(wsId).all<{ id: string }>();
  const peers = (rows.results || []).map((r) => String(r.id)).filter(Boolean);
  const adminAuth = { uid: 'admin', email: '' };
  await Promise.all(peers.map(async (peerId) => {
    try {
      const res = await callWorkspaceDO(env, peerId, 'admin-settings', adminAuth, 'GET');
      const settings = ((res as any)?.settings || {}) as Record<string, any>;
      const linkedSites = settings.linkedSites || {};
      const groupMetadata = settings.groupMetadata || {};
      const linksTarget = linkedSites && Object.prototype.hasOwnProperty.call(linkedSites, wsId);
      const metaTarget = groupMetadata && Object.prototype.hasOwnProperty.call(groupMetadata, wsId);
      if (!linksTarget && !metaTarget) return;
      const nextLinked = { ...linkedSites };
      delete nextLinked[wsId];
      const nextMeta = { ...groupMetadata };
      delete nextMeta[wsId];
      await callWorkspaceDO(env, peerId, 'admin-settings', adminAuth, 'PATCH', {
        linkedSites: nextLinked,
        groupMetadata: nextMeta
      });
    } catch { /* skip this peer — best-effort */ }
  }));
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return json(request, env, { ok: true, service: 'kcp-api-v2', environment: env.ENVIRONMENT || 'development' });
  }

  // Data-migration tool (superuser only): import central rows + per-workspace tenant rows.
  if (request.method === 'POST' && url.pathname.startsWith('/api/admin/migrate/')) {
    const auth = await requireAuth(request, env);
    if (!auth) return json(request, env, { ok: false, error: 'Sign in required.' }, 401);
    if (!(await isSuperuser(env, auth))) return json(request, env, { ok: false, error: 'Superuser only.' }, 403);
    const body = (await request.json().catch(() => ({}))) as { tables?: Record<string, unknown> };
    if (url.pathname === '/api/admin/migrate/central') {
      return withCors(request, env, await migrateCentral(env, body));
    }
    const wm = url.pathname.match(/^\/api\/admin\/migrate\/workspace\/([^/]+)$/);
    if (wm) {
      const wsId = decodeURIComponent(wm[1]);
      const result = await callWorkspaceDO(env, wsId, 'migrate-import', auth, 'POST', body);
      return json(request, env, result ?? { ok: false, error: 'workspace import failed' });
    }
    return json(request, env, { ok: false, error: 'Unknown migrate route' }, 404);
  }

  // Central plane — all /api/auth/* + /api/admin/* + security-config etc. run in the front Worker
  // against CENTRAL_DB (via the shared legacy dispatcher).
  const centralResponse = await dispatchCentral(request, env, url);
  if (centralResponse) {
    const headers = new Headers(centralResponse.headers);
    for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
    return new Response(centralResponse.body, { status: centralResponse.status, headers });
  }

  // Tenant-scoped routes → resolve workspace, auth centrally, forward to the workspace DO.
  const apiMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/(.+)$/);
  if (apiMatch) {
    const workspaceId = decodeURIComponent(apiMatch[1]);
    const resource = apiMatch[2];
    const auth = await requireAuth(request, env);
    if (!auth) return json(request, env, { ok: false, error: 'Sign in required.' }, 401);
    const allowed = await assertWorkspaceAccess(env, auth, workspaceId);
    if (!allowed) return json(request, env, { ok: false, error: 'No access to this workspace.' }, 403);

    // Cross-WORKSPACE reads must run HERE (only the front Worker has env.WORKSPACE to reach peer DOs).
    if (request.method === 'GET' && resource === 'linked-transfer-profiles') {
      return withCors(request, env, await getLinkedTransferProfilesFanOut(env, workspaceId, auth));
    }

    // ALL other workspace routes run in the tenant DO, which has both env.DB (this workspace's SQLite
    // facade) and env.CENTRAL_DB (shared central D1). Handlers read tenant tables via env.DB and
    // central tables via env.CENTRAL_DB. Several handlers are mixed-plane (e.g. access-management
    // reads members+roles centrally AND locations locally), so a front-Worker central/tenant split
    // by resource does NOT work — the split is per-QUERY inside the handlers. See PORTING.md.
    const response = await forwardToWorkspaceDO(request, env, workspaceId, resource, auth);
    // Re-attach CORS on the DO's response.
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  }

  return json(request, env, { ok: false, error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (cause) {
      // Map auth/permission errors thrown by handlers (requireAuth/requireAdmin/scoped) to 401 so the
      // frontend treats them as "not signed in" rather than a server error. Mirrors legacy behaviour.
      const raw = cause instanceof Error ? cause.message : 'Internal error.';
      const status = /token|access|permission|denied|sign in|session|expired/i.test(raw) ? 401 : 500;
      const message = /token|session|expired|access|permission|denied|invalid|required|not found|sign in|password|email/i.test(raw)
        ? raw
        : 'Something went wrong. Please try again.';
      return json(request, env, { ok: false, error: message }, status);
    }
  },

  // Supersedes the old Firebase `sendLowStockSummaryEmails` scheduled function — sends via
  // the new Gmail OAuth account instead of the legacy Gmail SMTP app-password account.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await sendDueLowStockEmailSummaries(centralLegacyEnv(env));
  }
};
