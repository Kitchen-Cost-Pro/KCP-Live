import type { Env, AuthContext } from './types';
import type { Env as LegacyEnv } from './legacy/types';
import {
  postAdminApproveRegistration,
  getAdminOverview,
  deleteAdminWorkspace,
  getAdminWorkspaceSettings,
  patchAdminWorkspaceSettings,
  getAdminOrgSites,
  postAdminSaveOrgGroup,
  postAdminUnlinkOrgSite,
  getAdminAuditLogs,
  requireAdmin,
  writeAdminAuditEvent
} from './legacy/admin-routes';
import type { AdminTenantSummary } from './legacy/admin-routes';
import { dispatchCentralRoute } from './legacy/index';
import { checkRateLimit, clientIp } from './legacy/rate-limit';
import { runWithConcurrencyLimit } from './legacy/concurrency';
import { KCP_WORKER_RELEASE, KCP_WORKER_RELEASE_DATE, KCP_REFUND_PIPELINE_VERSION } from './release';
import { consumeYocoV2QueueBatch } from './modules/yoco-engine-v2/queue-consumer';
import type { YocoV2QueueDispatchResult, YocoV2QueueMessage } from './modules/yoco-engine-v2/contracts';
import { permissionsForAdminRole } from './modules/yoco-engine-v2/admin-permissions';
import { normalizeYocoV2AdminActionPath } from './modules/yoco-engine-v2/admin-route-path';

export { WorkspaceDO } from './workspace-do';
export { YocoV2RateGateDO } from './yoco-v2-rate-gate-do';
export { YocoV2WriteBudgetDO } from './yoco-v2-write-budget-do';

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

  // Admin workspace actions are mixed-plane: authentication/auditing live in CENTRAL_DB while
  // Yoco, stock, webhook and low-stock data live in the workspace Durable Object. Never allow
  // these routes to fall through to the legacy central dispatcher, where tenant-table queries fail.
  const adminWorkspaceYocoV2M = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)\/yoco-v2\/(.+)$/);
  if (adminWorkspaceYocoV2M && (request.method === 'GET' || request.method === 'POST' || request.method === 'PATCH')) {
    const workspaceId = decodeURIComponent(adminWorkspaceYocoV2M[1]);
    const decodedActionPath = adminWorkspaceYocoV2M[2].split('/').map((segment) => decodeURIComponent(segment)).join('/');
    const actionPath = normalizeYocoV2AdminActionPath(decodedActionPath);
    const adminSession = await requireAdmin(request, lenv);
    const auth = adminAuthContext(adminSession);
    const response = await forwardToWorkspaceDO(request, env, workspaceId, `yoco-v2/admin/${actionPath}`, auth);
    if ((request.method === 'POST' || request.method === 'PATCH') && response.ok) {
      await writeAdminAuditEvent(
        lenv,
        { uid: auth.uid, email: auth.email },
        `yoco-v2.${actionPath.replace(/[^a-z0-9._-]+/gi, '.')}`,
        workspaceId,
        { workspaceId, actionPath }
      );
    }
    return response;
  }

  const adminWorkspaceYocoM = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)\/yoco\/([^/]+)$/);
  if (adminWorkspaceYocoM) {
    const workspaceId = decodeURIComponent(adminWorkspaceYocoM[1]);
    const action = decodeURIComponent(adminWorkspaceYocoM[2]);
    const allowedGetActions = new Set(['status', 'events']);
    const allowedPostActions = new Set(['connect', 'disconnect', 'sync-catalogue']);
    if ((request.method === 'GET' && allowedGetActions.has(action)) || (request.method === 'POST' && allowedPostActions.has(action))) {
      const adminSession = await requireAdmin(request, lenv);
      const auth = adminAuthContext(adminSession);
      const resource = `admin-yoco/${action}`;
      const response = await forwardToWorkspaceDO(request, env, workspaceId, resource, auth);
      if (request.method === 'POST' && response.ok) {
        await writeAdminAuditEvent(
          lenv,
          { uid: auth.uid, email: auth.email },
          `yoco.${action}`,
          workspaceId,
          { workspaceId }
        );
      }
      return response;
    }
  }

  const adminWorkspaceActionM = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)\/actions\/([^/]+)$/);
  if (adminWorkspaceActionM && request.method === 'POST') {
    const workspaceId = decodeURIComponent(adminWorkspaceActionM[1]);
    const action = decodeURIComponent(adminWorkspaceActionM[2]);
    if (action === 'send-low-stock-email') {
      const adminSession = await requireAdmin(request, lenv);
      const auth = adminAuthContext(adminSession);
      const response = await forwardToWorkspaceDO(request, env, workspaceId, `admin-action/${action}`, auth);
      if (response.ok) {
        await writeAdminAuditEvent(
          lenv,
          { uid: auth.uid, email: auth.email },
          `workspace.${action}`,
          workspaceId,
          { workspaceId }
        );
      }
      return response;
    }
  }

  // Audit events are split between CENTRAL_DB (admin actions) and each tenant DO (workspace actions).
  if (request.method === 'GET' && url.pathname === '/api/admin/audit-logs') {
    return getAdminAuditLogs(request, lenv, async (limit) => {
      const workspaceRows = await env.CENTRAL_DB.prepare(
        `SELECT id, name FROM workspaces WHERE status = 'active' ORDER BY id`
      ).all<{ id: string; name: string }>();
      const workspaces = workspaceRows.results || [];
      const results = await fanOutWorkspaceDOs(
        env,
        workspaces.map((row) => String(row.id)),
        'admin-audit-events',
        { uid: 'admin-audit', email: '' }
      );
      const nameMap = new Map(workspaces.map((row) => [String(row.id), String(row.name || row.id)]));
      return results.flatMap((result) => {
        const rows = Array.isArray((result.data as any)?.rows) ? (result.data as any).rows : [];
        return rows.slice(0, limit).map((row: any) => ({
          ...row,
          workspace_id: result.workspaceId,
          workspace_name: nameMap.get(result.workspaceId) || result.workspaceId
        }));
      });
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/maintenance/integrity') {
    return getAdminIntegrityReport(request, env, lenv);
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/maintenance/repair') {
    return postAdminIntegrityRepair(request, env, lenv);
  }

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

  // Webhook & Workspace Health: one row per active workspace with call-rate windows and the
  // live remote subscription count, so support can see subscription drift without opening Yoco.
  if (request.method === 'GET' && url.pathname === '/api/admin/webhook-health') {
    await requireAdmin(request, lenv);
    const workspaceRows = await env.CENTRAL_DB.prepare(
      `SELECT id, name, status FROM workspaces WHERE status = 'active' ORDER BY name COLLATE NOCASE ASC`
    ).all<{ id: string; name: string; status: string }>();
    const workspaces = workspaceRows.results || [];
    const stats = await fanOutWorkspaceDOs(
      env,
      workspaces.map((row) => String(row.id)),
      'yoco-v2/admin/receipt-stats',
      { uid: 'admin', email: '', systemRole: 'admin' }
    );
    const statsByWorkspace = new Map(stats.map((r) => [r.workspaceId, r.data as any]));
    const rows = workspaces.map((row) => {
      const workspaceId = String(row.id);
      const data = statsByWorkspace.get(workspaceId);
      return {
        workspaceId,
        name: String(row.name || workspaceId),
        connectionStatus: data?.ok ? data.connectionStatus : 'unknown',
        connectionActive: Boolean(data?.connectionActive),
        activeSubscriptions: Number(data?.activeSubscriptions || 0),
        subscriptionCheckError: String(data?.subscriptionCheckError || (data?.ok ? '' : 'Could not reach workspace')),
        calls: data?.calls || { last5m: 0, last15m: 0, last30m: 0, last1h: 0, last24h: 0 },
        lastReceivedAt: String(data?.lastReceivedAt || ''),
        lastError: String(data?.lastError || ''),
        total24h: Number(data?.total24h || 0),
        succeeded24h: Number(data?.succeeded24h || 0),
        failed24h: Number(data?.failed24h || 0)
      };
    });
    return json(request, env, { ok: true, workspaces: rows });
  }

  // Webhook & Workspace Health chart: bucketed call counts per workspace over a selectable
  // window, aligned to shared bucket boundaries so every workspace's series shares one x-axis.
  if (request.method === 'GET' && url.pathname === '/api/admin/webhook-health/timeseries') {
    await requireAdmin(request, lenv);
    const rangeParam = String(url.searchParams.get('range') || '24h');
    const RANGE_CONFIG: Record<string, { bucketMinutes: number; bucketCount: number }> = {
      '1h': { bucketMinutes: 5, bucketCount: 12 },
      '24h': { bucketMinutes: 60, bucketCount: 24 },
      '7d': { bucketMinutes: 1440, bucketCount: 7 }
    };
    const { bucketMinutes, bucketCount } = RANGE_CONFIG[rangeParam] || RANGE_CONFIG['24h'];
    const range = RANGE_CONFIG[rangeParam] ? rangeParam : '24h';
    const windowStartMs = Date.now() - bucketCount * bucketMinutes * 60_000;
    const windowStart = new Date(windowStartMs).toISOString();
    const labels: string[] = [];
    for (let i = 0; i < bucketCount; i += 1) {
      labels.push(new Date(windowStartMs + i * bucketMinutes * 60_000).toISOString());
    }

    const workspaceRows = await env.CENTRAL_DB.prepare(
      `SELECT id, name FROM workspaces WHERE status = 'active' ORDER BY name COLLATE NOCASE ASC`
    ).all<{ id: string; name: string }>();
    const workspaces = workspaceRows.results || [];
    const resource = `yoco-v2/admin/receipt-timeseries?windowStart=${encodeURIComponent(windowStart)}&bucketMinutes=${bucketMinutes}&bucketCount=${bucketCount}`;
    const results = await fanOutWorkspaceDOs(env, workspaces.map((row) => String(row.id)), resource, { uid: 'admin', email: '', systemRole: 'admin' });
    const resultsByWorkspace = new Map(results.map((r) => [r.workspaceId, r.data as any]));

    const series = workspaces.map((row) => {
      const workspaceId = String(row.id);
      const data = resultsByWorkspace.get(workspaceId);
      const buckets: number[] = Array.isArray(data?.buckets) ? data.buckets.map((n: unknown) => Number(n) || 0) : new Array(bucketCount).fill(0);
      return {
        workspaceId,
        name: String(row.name || workspaceId),
        data: buckets,
        total: buckets.reduce((sum, n) => sum + n, 0)
      };
    });

    return json(request, env, { ok: true, range, bucketMinutes, bucketCount, windowStart, labels, series });
  }

  // Write-budget observability: the gate is a single global Durable Object (not per-workspace),
  // so this reads its state directly rather than fanning out to workspace DOs.
  if (request.method === 'GET' && url.pathname === '/api/admin/webhook-health/write-budget') {
    await requireAdmin(request, lenv);
    if (!env.YOCO_V2_WRITE_BUDGET) {
      return json(request, env, { ok: true, configured: false });
    }
    const stub = env.YOCO_V2_WRITE_BUDGET.get(env.YOCO_V2_WRITE_BUDGET.idFromName('global'));
    const stateResponse = await stub.fetch('https://write-budget/state');
    const state = await stateResponse.json<{ ok: boolean; state?: { dateKey: string; used: number } }>().catch(() => null);
    const dailyCap = Math.max(1000, Math.min(100_000, Number(env.YOCO_V2_WRITE_BUDGET_DAILY_CAP) || 90_000));
    return json(request, env, { ok: true, configured: true, dailyCap, ...(state?.state || { dateKey: '', used: 0 }) });
  }

  // Diagnostic (2026-08-28): which workspace(s) actually account for the account's total SQL
  // storage. Queries EVERY workspace regardless of status — a workspace marked inactive/deleted
  // in CENTRAL_DB doesn't necessarily mean its Durable Object storage was ever purged (that's a
  // separate explicit 'admin-purge' action), so a stale never-purged workspace is a real
  // candidate for unaccounted-for storage.
  if (request.method === 'GET' && url.pathname === '/api/admin/workspace-storage') {
    await requireAdmin(request, lenv);
    const workspaceRows = await env.CENTRAL_DB.prepare(
      `SELECT id, name, status FROM workspaces ORDER BY name COLLATE NOCASE ASC`
    ).all<{ id: string; name: string; status: string }>();
    const workspaces = workspaceRows.results || [];
    const results = await fanOutWorkspaceDOs(
      env,
      workspaces.map((row) => String(row.id)),
      'admin-database-size',
      { uid: 'admin', email: '', systemRole: 'admin' }
    );
    const sizeByWorkspace = new Map(results.map((r) => [r.workspaceId, r.data as any]));
    const rows = workspaces
      .map((row) => {
        const workspaceId = String(row.id);
        const data = sizeByWorkspace.get(workspaceId);
        const databaseSizeBytes = Number(data?.databaseSizeBytes || 0);
        return {
          workspaceId,
          name: String(row.name || workspaceId),
          status: String(row.status || ''),
          databaseSizeBytes,
          databaseSizeMb: Math.round((databaseSizeBytes / (1024 * 1024)) * 100) / 100
        };
      })
      .sort((a, b) => b.databaseSizeBytes - a.databaseSizeBytes);
    const totalBytes = rows.reduce((sum, row) => sum + row.databaseSizeBytes, 0);
    return json(request, env, {
      ok: true,
      totalBytes,
      totalMb: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
      workspaces: rows
    });
  }

  // Follow-up to /api/admin/workspace-storage: which table(s) inside ONE workspace actually
  // account for its storage. ?workspaceId=WS-... required.
  if (request.method === 'GET' && url.pathname === '/api/admin/workspace-table-sizes') {
    await requireAdmin(request, lenv);
    const workspaceId = String(url.searchParams.get('workspaceId') || '').trim();
    if (!workspaceId) return json(request, env, { ok: false, error: 'workspaceId is required' }, 400);
    const result = await callWorkspaceDO(env, workspaceId, 'admin-table-sizes', { uid: 'admin', email: '', systemRole: 'admin' });
    return json(request, env, result || { ok: false, error: 'Could not reach workspace' });
  }

  // Confirms whether a workspace's yoco_v2_reconciliation_findings dedup migration actually took
  // effect, or whether it's a drifted tenant still on the pre-fix one-row-per-run-forever
  // behavior. ?workspaceId=WS-... required.
  if (request.method === 'GET' && url.pathname === '/api/admin/workspace-findings-dedup-check') {
    await requireAdmin(request, lenv);
    const workspaceId = String(url.searchParams.get('workspaceId') || '').trim();
    if (!workspaceId) return json(request, env, { ok: false, error: 'workspaceId is required' }, 400);
    const result = await callWorkspaceDO(env, workspaceId, 'admin-findings-dedup-check', { uid: 'admin', email: '', systemRole: 'admin' });
    return json(request, env, result || { ok: false, error: 'Could not reach workspace' });
  }

  // Wipes yoco_v2_reconciliation_findings for one workspace — see admin-findings-purge's comment
  // in workspace-do.ts for why this is safe. ?workspaceId=WS-... required.
  if (request.method === 'POST' && url.pathname === '/api/admin/workspace-findings-purge') {
    await requireAdmin(request, lenv);
    const workspaceId = String(url.searchParams.get('workspaceId') || '').trim();
    if (!workspaceId) return json(request, env, { ok: false, error: 'workspaceId is required' }, 400);
    const result = await callWorkspaceDO(env, workspaceId, 'admin-findings-purge', { uid: 'admin', email: '', systemRole: 'admin' }, 'POST', {});
    return json(request, env, result || { ok: false, error: 'Could not reach workspace' });
  }

  // Which specific gate is blocking SALE_STOCK from deducting when SALE_REPORTING works fine —
  // calls the real getEffectRuntime() logic the live-sale path itself uses.
  // ?workspaceId=WS-... required.
  if (request.method === 'GET' && url.pathname === '/api/admin/workspace-effect-runtime-check') {
    await requireAdmin(request, lenv);
    const workspaceId = String(url.searchParams.get('workspaceId') || '').trim();
    if (!workspaceId) return json(request, env, { ok: false, error: 'workspaceId is required' }, 400);
    const result = await callWorkspaceDO(env, workspaceId, 'admin-effect-runtime-check', { uid: 'admin', email: '', systemRole: 'admin' });
    return json(request, env, result || { ok: false, error: 'Could not reach workspace' });
  }

  // Follow-up to workspace-effect-runtime-check: shows recent proposed stock movements and their
  // resolution_status/warning_code, to see whether items are legitimately unresolved (unmapped
  // modifier/item, missing recipe, invalid UOM) rather than the gate being closed.
  // ?workspaceId=WS-... required.
  if (request.method === 'GET' && url.pathname === '/api/admin/workspace-recent-stock-proposals') {
    await requireAdmin(request, lenv);
    const workspaceId = String(url.searchParams.get('workspaceId') || '').trim();
    if (!workspaceId) return json(request, env, { ok: false, error: 'workspaceId is required' }, 400);
    const result = await callWorkspaceDO(env, workspaceId, 'admin-recent-stock-proposals', { uid: 'admin', email: '', systemRole: 'admin' });
    return json(request, env, result || { ok: false, error: 'Could not reach workspace' });
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/org-sites') {
    return getAdminOrgSites(request, lenv, async (workspaceIds) => getAdminWorkspaceSettingsMap(env, workspaceIds));
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/org-groups') {
    return postAdminSaveOrgGroup(request, lenv, async (input) => saveAdminOrgGroupFanOut(env, input));
  }

  const adminOrgSiteMatch = url.pathname.match(/^\/api\/admin\/org-sites\/([^/]+)\/unlink$/);
  if (adminOrgSiteMatch && request.method === 'POST') {
    return postAdminUnlinkOrgSite(
      request,
      lenv,
      decodeURIComponent(adminOrgSiteMatch[1]),
      async (input) => unlinkAdminOrgSiteFanOut(env, input)
    );
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

  // Diagnoses/unblocks a workspace whose tenant schema migration is silently stuck in a backoff
  // window (see workspace-do.ts's migrate()) — the failure mode that produces no error log at all,
  // so it is otherwise invisible from outside the Durable Object. Superuser-only: this reads/clears
  // internal migration bookkeeping, not ordinary workspace data.
  const migrationHealthM = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)\/migration-health$/);
  if (migrationHealthM && request.method === 'GET') {
    const adminSession = await requireAdmin(request, lenv);
    if (!adminSession.admin?.isSuper) return json(request, env, { ok: false, error: 'Superuser only.' }, 403);
    const wsId = decodeURIComponent(migrationHealthM[1]);
    const r = await callWorkspaceDO(env, wsId, 'admin-migration-health', { uid: 'admin', email: '' }, 'GET');
    return json(request, env, r as Record<string, unknown>);
  }
  // Read-only comparison of the two ways of computing opening stock balances — see
  // getAdminWorkspaceOpeningBalanceCheck for why. Superuser-only: it reports per-item stock
  // discrepancies, and it reads the full ledger once, so it is a deliberate diagnostic rather than
  // something routine traffic should be able to trigger.
  const openingBalanceCheckM = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)\/opening-balance-check$/);
  if (openingBalanceCheckM && request.method === 'GET') {
    const adminSession = await requireAdmin(request, lenv);
    if (!adminSession.admin?.isSuper) return json(request, env, { ok: false, error: 'Superuser only.' }, 403);
    const wsId = decodeURIComponent(openingBalanceCheckM[1]);
    const resource = `admin-opening-balance-check${url.search}`;
    const r = await callWorkspaceDO(env, wsId, resource, { uid: 'admin', email: '' }, 'GET');
    return json(request, env, r as Record<string, unknown>);
  }
  const migrationRetryM = url.pathname.match(/^\/api\/admin\/workspaces\/([^/]+)\/migration-retry$/);
  if (migrationRetryM && request.method === 'POST') {
    const adminSession = await requireAdmin(request, lenv);
    if (!adminSession.admin?.isSuper) return json(request, env, { ok: false, error: 'Superuser only.' }, 403);
    const wsId = decodeURIComponent(migrationRetryM[1]);
    const r = await callWorkspaceDO(env, wsId, 'admin-migration-retry', { uid: 'admin', email: '' }, 'POST', {});
    return json(request, env, r as Record<string, unknown>);
  }

  return dispatchCentralRoute(request, lenv);
}

function adminAuthContext(adminSession: Awaited<ReturnType<typeof requireAdmin>>): AuthContext {
  const adminRole = text(adminSession.admin?.role || 'admin');
  return {
    uid: text(adminSession.auth?.uid || adminSession.admin?.id || 'admin'),
    email: text(adminSession.admin?.email || adminSession.auth?.email || ''),
    systemRole: 'admin',
    adminRole,
    permissions: permissionsForAdminRole(adminRole, Boolean(adminSession.admin?.isSuper))
  };
}

async function getAdminIntegrityReport(request: Request, env: Env, lenv: LegacyEnv): Promise<Response> {
  const adminSession = await requireAdmin(request, lenv);
  if (!adminSession.admin?.isSuper) return json(request, env, { ok: false, error: 'Superuser only.' }, 403);

  const [memberLinks, adminLinks, ownerless, workspaceRows] = await Promise.all([
    env.CENTRAL_DB.prepare(
      `SELECT wm.id, wm.workspace_id, wm.email, wm.auth_uid, au.id AS expected_uid
         FROM workspace_members wm
         LEFT JOIN app_users au ON lower(au.email) = lower(wm.email)
        WHERE wm.status = 'active'
          AND (au.id IS NULL OR wm.auth_uid IS NULL OR wm.auth_uid != au.id)`
    ).all<any>(),
    env.CENTRAL_DB.prepare(
      `SELECT ad.id, ad.email, ad.auth_uid, au.id AS expected_uid
         FROM admin_users ad
         LEFT JOIN app_users au ON lower(au.email) = lower(ad.email)
        WHERE ad.status = 'active'
          AND (au.id IS NULL OR ad.auth_uid IS NULL OR ad.auth_uid != au.id)`
    ).all<any>(),
    env.CENTRAL_DB.prepare(
      `SELECT w.id, w.name
         FROM workspaces w
        WHERE w.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM workspace_members wm
             WHERE wm.workspace_id = w.id AND wm.status = 'active' AND wm.role_key = 'owner'
          )`
    ).all<any>(),
    env.CENTRAL_DB.prepare(
      `SELECT id, name FROM workspaces WHERE status = 'active' ORDER BY id`
    ).all<{ id: string; name: string }>()
  ]);

  const workspaces = workspaceRows.results || [];
  const summaries = await fanOutWorkspaceDOs(
    env,
    workspaces.map((row) => String(row.id)),
    'admin-summary',
    adminAuthContext(adminSession)
  );
  const nameMap = new Map(workspaces.map((row) => [String(row.id), String(row.name || row.id)]));
  const issues: Array<Record<string, unknown>> = [];

  for (const row of memberLinks.results || []) {
    issues.push({
      severity: row.expected_uid ? 'warning' : 'error',
      code: row.expected_uid ? 'MEMBER_UID_MISMATCH' : 'MEMBER_USER_MISSING',
      workspaceId: row.workspace_id,
      email: row.email,
      message: row.expected_uid
        ? `Member identity link is stale for ${row.email}.`
        : `Active workspace member ${row.email} has no app_users record.`
    });
  }
  for (const row of adminLinks.results || []) {
    issues.push({
      severity: row.expected_uid ? 'warning' : 'error',
      code: row.expected_uid ? 'ADMIN_UID_MISMATCH' : 'ADMIN_USER_MISSING',
      email: row.email,
      message: row.expected_uid
        ? `Admin identity link is stale for ${row.email}.`
        : `Active admin ${row.email} has no app_users record.`
    });
  }
  for (const row of ownerless.results || []) {
    issues.push({
      severity: 'error',
      code: 'WORKSPACE_OWNER_MISSING',
      workspaceId: row.id,
      message: `${row.name || row.id} has no active owner membership.`
    });
  }
  for (const result of summaries) {
    const data = result.data as any;
    if (!data?.ok) {
      issues.push({
        severity: 'error',
        code: 'TENANT_UNREACHABLE',
        workspaceId: result.workspaceId,
        message: `${nameMap.get(result.workspaceId) || result.workspaceId} tenant database did not respond.`
      });
      continue;
    }
    if (!data.settings?.raw_json) {
      issues.push({
        severity: 'warning',
        code: 'WORKSPACE_SETTINGS_MISSING',
        workspaceId: result.workspaceId,
        message: `${nameMap.get(result.workspaceId) || result.workspaceId} has no workspace settings baseline.`
      });
    }
    if (Number(data.metrics?.locationCount || 0) < 1) {
      issues.push({
        severity: 'error',
        code: 'WORKSPACE_LOCATION_MISSING',
        workspaceId: result.workspaceId,
        message: `${nameMap.get(result.workspaceId) || result.workspaceId} has no active location.`
      });
    }
  }

  return json(request, env, {
    ok: true,
    checkedAt: new Date().toISOString(),
    workspaceCount: workspaces.length,
    issueCount: issues.length,
    issues
  });
}

async function postAdminIntegrityRepair(request: Request, env: Env, lenv: LegacyEnv): Promise<Response> {
  const adminSession = await requireAdmin(request, lenv);
  if (!adminSession.admin?.isSuper) return json(request, env, { ok: false, error: 'Superuser only.' }, 403);
  const now = new Date().toISOString();

  const createdUsers = await env.CENTRAL_DB.prepare(
    `INSERT INTO app_users (id, email, display_name, status, created_at, updated_at)
     SELECT 'user_' || lower(hex(randomblob(16))), source.email, source.display_name, 'active', ?1, ?1
       FROM (
         SELECT lower(email) AS email, COALESCE(NULLIF(display_name, ''), lower(email)) AS display_name
           FROM admin_users
          WHERE status = 'active'
         UNION
         SELECT lower(email) AS email, COALESCE(NULLIF(display_name, ''), lower(email)) AS display_name
           FROM workspace_members
          WHERE status = 'active'
       ) source
      WHERE source.email != ''
        AND NOT EXISTS (SELECT 1 FROM app_users au WHERE lower(au.email) = source.email)`
  ).bind(now).run();

  const members = await env.CENTRAL_DB.prepare(
      `UPDATE workspace_members
          SET auth_uid = (SELECT au.id FROM app_users au WHERE lower(au.email) = lower(workspace_members.email) LIMIT 1),
              updated_at = ?1
        WHERE status = 'active'
          AND EXISTS (SELECT 1 FROM app_users au WHERE lower(au.email) = lower(workspace_members.email))
          AND (auth_uid IS NULL OR auth_uid != (SELECT au.id FROM app_users au WHERE lower(au.email) = lower(workspace_members.email) LIMIT 1))`
    ).bind(now).run();
  const admins = await env.CENTRAL_DB.prepare(
      `UPDATE admin_users
          SET auth_uid = (SELECT au.id FROM app_users au WHERE lower(au.email) = lower(admin_users.email) LIMIT 1),
              updated_at = ?1
        WHERE status = 'active'
          AND EXISTS (SELECT 1 FROM app_users au WHERE lower(au.email) = lower(admin_users.email))
          AND (auth_uid IS NULL OR auth_uid != (SELECT au.id FROM app_users au WHERE lower(au.email) = lower(admin_users.email) LIMIT 1))`
    ).bind(now).run();
  const owners = await env.CENTRAL_DB.prepare(
      `UPDATE workspaces
          SET owner_uid = (
                SELECT COALESCE(wm.auth_uid, au.id)
                  FROM workspace_members wm
                  LEFT JOIN app_users au ON lower(au.email) = lower(wm.email)
                 WHERE wm.workspace_id = workspaces.id
                   AND wm.status = 'active'
                   AND wm.role_key = 'owner'
                 ORDER BY wm.created_at
                 LIMIT 1
              ),
              updated_at = ?1
        WHERE status = 'active'
          AND EXISTS (
                SELECT 1 FROM workspace_members wm
                 WHERE wm.workspace_id = workspaces.id
                   AND wm.status = 'active'
                   AND wm.role_key = 'owner'
              )
          AND COALESCE(owner_uid, '') != COALESCE((
                SELECT COALESCE(wm.auth_uid, au.id, '')
                  FROM workspace_members wm
                  LEFT JOIN app_users au ON lower(au.email) = lower(wm.email)
                 WHERE wm.workspace_id = workspaces.id
                   AND wm.status = 'active'
                   AND wm.role_key = 'owner'
                 ORDER BY wm.created_at
                 LIMIT 1
              ), '')`
    ).bind(now).run();
  const workspaceRows = await env.CENTRAL_DB.prepare(
    `SELECT id FROM workspaces WHERE status = 'active' ORDER BY id`
  ).all<{ id: string }>();

  const auth = adminAuthContext(adminSession);
  const tenantResults = await Promise.all((workspaceRows.results || []).map(async (row) => ({
    workspaceId: String(row.id),
    result: await callWorkspaceDO(env, String(row.id), 'admin-action/repair-baseline', auth, 'POST', {})
  })));
  const tenantChanges = tenantResults.reduce((sum, row) => sum + Number((row.result as any)?.changes || 0), 0);

  const result = {
    appUsersCreated: Number(createdUsers.meta?.changes || 0),
    memberIdentityLinks: Number(members.meta?.changes || 0),
    adminIdentityLinks: Number(admins.meta?.changes || 0),
    workspaceOwnerLinks: Number(owners.meta?.changes || 0),
    tenantBaselines: tenantChanges,
    tenantFailures: tenantResults.filter((row) => !(row.result as any)?.ok).map((row) => row.workspaceId)
  };
  await writeAdminAuditEvent(
    lenv,
    { uid: auth.uid, email: auth.email },
    'maintenance.integrity-repair',
    'central-and-tenants',
    result
  );
  return json(request, env, { ok: true, repairedAt: now, ...result });
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
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
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

function text(value: unknown, fallback = ''): string {
  return String(value ?? fallback).trim();
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function orgGroupField(linkType: 'org' | 'corp') {
  return linkType === 'corp'
    ? { camel: 'corpId', snake: 'corp_id', central: 'corp_id' }
    : { camel: 'orgId', snake: 'org_id', central: 'org_id' };
}

function filterLinkedSitesByType(linkedSites: Record<string, any>, linkType: 'org' | 'corp') {
  const kept: Record<string, any> = {};
  for (const [linkedId, entry] of Object.entries(linkedSites || {})) {
    const link = objectValue(entry);
    if (text(link.linkType || linkType) === linkType) continue;
    kept[linkedId] = entry;
  }
  return kept;
}

/** Validate the bearer token against the CENTRAL auth plane. */
async function requireAuth(request: Request, env: Env): Promise<AuthContext | null> {
  const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const row = await env.CENTRAL_DB.prepare(
    `SELECT u.id AS uid, u.email AS email, s.expires_at AS expires_at, u.status AS status, u.display_name AS display_name
       FROM auth_sessions s
       JOIN app_users u ON u.id = s.user_id
      WHERE s.token = ?1
      LIMIT 1`
  )
    .bind(match[1])
    .first<{ uid: string; email: string; expires_at: string; status: string; display_name?: string }>();
  if (!row) return null;
  if (row.status && row.status !== 'active') return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
  return { uid: String(row.uid), email: String(row.email || ''), name: String(row.display_name || '') };
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
  const headers = new Headers(request.headers);
  headers.set('x-kcp-workspace', workspaceId);
  headers.set('x-kcp-resource', resource);
  headers.set('x-kcp-auth', JSON.stringify(auth));

  // Construct from the Request itself so the runtime tees the body stream. Passing request.body
  // directly transfers the original stream to the Durable Object; Miniflare/Workers then fails while
  // draining the outer request after a JSON-reading action (for example Yoco disconnect/connect).
  const forwarded = new Request(request, { headers });
  return stub.fetch(forwarded);
}

async function dispatchYocoV2QueueMessage(env: Env, message: YocoV2QueueMessage): Promise<YocoV2QueueDispatchResult> {
  const workspaceId = String(message.workspace_id || '');
  if (!workspaceId) return { ok: false, action: 'ack', status: 'FAILED_PERMANENTLY', error: 'Queue message has no workspace_id.' };
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('x-kcp-workspace', workspaceId);
  headers.set('x-kcp-resource', 'yoco-v2/queue/process');
  headers.set('x-kcp-auth', JSON.stringify({ uid: 'yoco-v2-queue', email: '', systemRole: 'queue' }));
  const request = new Request(`https://do/api/workspaces/${encodeURIComponent(workspaceId)}/yoco-v2/queue/process`, {
    method: 'POST',
    headers,
    body: JSON.stringify(message)
  });
  const response = await stub.fetch(request);
  const data = await response.json<YocoV2QueueDispatchResult>().catch(() => ({
    ok: false,
    action: response.status >= 500 ? 'retry' : 'ack',
    error: `V2 queue route returned HTTP ${response.status}.`
  } as YocoV2QueueDispatchResult));
  return data;
}

/**
 * Fan-out primitive: synthesize an internal request to ANY workspace's DO for a given resource and
 * return its parsed JSON. Used by cross-workspace reads (linked-transfer profiles, org/corp
 * consolidated overview data, admin overview) that must run in the front Worker where env.WORKSPACE lives.
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

async function getAdminWorkspaceSettingsMap(
  env: Env,
  workspaceIds: string[]
): Promise<Record<string, Record<string, any>>> {
  if (!workspaceIds.length) return {};
  const adminAuth = { uid: 'admin', email: '' };
  const results = await fanOutWorkspaceDOs(env, workspaceIds, 'admin-settings', adminAuth);
  const map: Record<string, Record<string, any>> = {};
  for (const result of results) {
    map[result.workspaceId] = objectValue((result.data as any)?.settings);
  }
  return map;
}

async function patchWorkspaceAdminSettings(
  env: Env,
  workspaceId: string,
  payload: Record<string, unknown>
): Promise<Record<string, any>> {
  const adminAuth = { uid: 'admin', email: '' };
  const result = await callWorkspaceDO(env, workspaceId, 'admin-settings', adminAuth, 'PATCH', payload);
  return objectValue((result as any)?.settings);
}

async function updateCentralGroupMembership(
  env: Env,
  workspaceIds: string[],
  linkType: 'org' | 'corp',
  linkId: string,
  now: string
): Promise<void> {
  if (!workspaceIds.length) return;
  const field = orgGroupField(linkType);
  await env.CENTRAL_DB.batch(workspaceIds.map((workspaceId) =>
    env.CENTRAL_DB.prepare(
      `UPDATE workspaces
          SET ${field.central} = ?2,
              updated_at = ?3
        WHERE id = ?1
          AND status = 'active'`
    ).bind(workspaceId, linkId, now)
  ));
}

async function clearCentralGroupMembership(
  env: Env,
  workspaceId: string,
  linkType: 'org' | 'corp',
  now: string
): Promise<void> {
  const field = orgGroupField(linkType);
  await env.CENTRAL_DB.prepare(
    `UPDATE workspaces
        SET ${field.central} = NULL,
            updated_at = ?2
      WHERE id = ?1`
  ).bind(workspaceId, now).run();
}

async function listCentralGroupMembers(
  env: Env,
  linkType: 'org' | 'corp',
  linkId: string
): Promise<Array<{ id: string; name: string; org_id?: string; corp_id?: string }>> {
  if (!linkId) return [];
  const field = orgGroupField(linkType);
  const rows = await env.CENTRAL_DB.prepare(
    `SELECT id, name, org_id, corp_id
       FROM workspaces
      WHERE status = 'active'
        AND ${field.central} = ?1
      ORDER BY lower(name)`
  ).bind(linkId).all<{ id: string; name: string; org_id?: string; corp_id?: string }>();
  return rows.results || [];
}

async function syncGroupMembersToWorkspaceSettings(
  env: Env,
  input: {
    memberIds: string[];
    linkType: 'org' | 'corp';
    linkId: string;
    groupName: string;
    permissionLevel: string;
    viewingOnly: boolean;
    now: string;
  }
): Promise<void> {
  const field = orgGroupField(input.linkType);
  const settingsMap = await getAdminWorkspaceSettingsMap(env, input.memberIds);
  await Promise.all(input.memberIds.map(async (workspaceId) => {
    const current = objectValue(settingsMap[workspaceId]);
    const linkedSites = filterLinkedSitesByType(
      objectValue(current.linkedSites || current.linked_sites),
      input.linkType
    );
    for (const peerId of input.memberIds) {
      if (peerId === workspaceId) continue;
      linkedSites[peerId] = {
        siteId: peerId,
        linkType: input.linkType,
        linkId: input.linkId,
        groupName: input.groupName,
        permissionLevel: input.permissionLevel,
        viewingOnly: input.viewingOnly,
        linkedAt: input.now
      };
    }

    await patchWorkspaceAdminSettings(env, workspaceId, {
      [field.camel]: input.linkId,
      [field.snake]: input.linkId,
      permissionLevel: input.permissionLevel,
      viewingOnly: input.viewingOnly,
      groupMetadata: {
        ...objectValue(current.groupMetadata),
        id: input.linkId,
        name: input.groupName,
        type: input.linkType,
        permissionLevel: input.permissionLevel,
        viewingOnly: input.viewingOnly,
        updatedAt: input.now
      },
      linkedSites,
      updatedAt: input.now
    });
  }));
}

async function saveAdminOrgGroupFanOut(
  env: Env,
  input: {
    siteIds: string[];
    linkType: 'org' | 'corp';
    linkId: string;
    groupName: string;
    permissionLevel: string;
    viewingOnly: boolean;
    now: string;
  }
): Promise<{
  siteIds: string[];
  linkType: 'org' | 'corp';
  linkId: string;
  groupName: string;
  permissionLevel: string;
}> {
  const siteIds = [...new Set(input.siteIds.map((value) => text(value)).filter(Boolean))];
  const field = orgGroupField(input.linkType);
  const previousRows = await Promise.all(siteIds.map((workspaceId) =>
    env.CENTRAL_DB.prepare(
      `SELECT ${field.central} AS link_id
         FROM workspaces
        WHERE id = ?1
        LIMIT 1`
    ).bind(workspaceId).first<{ link_id?: string }>()
  ));
  const staleLinkIds = [...new Set(previousRows
    .map((row) => text(row?.link_id))
    .filter((linkId) => linkId && linkId !== input.linkId))];
  await updateCentralGroupMembership(env, siteIds, input.linkType, input.linkId, input.now);

  const groupMembers = await listCentralGroupMembers(env, input.linkType, input.linkId);
  const memberIds = groupMembers.map((row) => text(row.id)).filter(Boolean);
  await syncGroupMembersToWorkspaceSettings(env, {
    memberIds,
    linkType: input.linkType,
    linkId: input.linkId,
    groupName: input.groupName,
    permissionLevel: input.permissionLevel,
    viewingOnly: input.viewingOnly,
    now: input.now
  });

  for (const staleLinkId of staleLinkIds) {
    const remainingMembers = await listCentralGroupMembers(env, input.linkType, staleLinkId);
    const remainingIds = remainingMembers.map((row) => text(row.id)).filter(Boolean);
    if (!remainingIds.length) continue;
    const remainingSettings = await getAdminWorkspaceSettingsMap(env, [remainingIds[0]]);
    const template = objectValue(remainingSettings[remainingIds[0]]);
    await syncGroupMembersToWorkspaceSettings(env, {
      memberIds: remainingIds,
      linkType: input.linkType,
      linkId: staleLinkId,
      groupName: text(objectValue(template.groupMetadata).name || staleLinkId || 'Linked Group'),
      permissionLevel: text(template.permissionLevel || 'full_transfer'),
      viewingOnly: Boolean(template.viewingOnly === true || template.viewing_only === true),
      now: input.now
    });
  }

  return {
    siteIds,
    linkType: input.linkType,
    linkId: input.linkId,
    groupName: input.groupName,
    permissionLevel: input.permissionLevel
  };
}

async function unlinkAdminOrgSiteFanOut(
  env: Env,
  input: {
    siteId: string;
    linkType: 'org' | 'corp';
    now: string;
  }
): Promise<{ siteId: string; linkType: 'org' | 'corp'; oldLinkId?: string }> {
  const field = orgGroupField(input.linkType);
  const currentRow = await env.CENTRAL_DB.prepare(
    `SELECT id, ${field.central} AS link_id
       FROM workspaces
      WHERE id = ?1
      LIMIT 1`
  ).bind(input.siteId).first<{ id: string; link_id?: string }>();
  const oldLinkId = text(currentRow?.link_id);

  await clearCentralGroupMembership(env, input.siteId, input.linkType, input.now);

  const remainingMembers = oldLinkId
    ? await listCentralGroupMembers(env, input.linkType, oldLinkId)
    : [];
  const remainingIds = remainingMembers.map((row) => text(row.id)).filter(Boolean);
  const settingsMap = await getAdminWorkspaceSettingsMap(env, [input.siteId, ...remainingIds]);
  const current = objectValue(settingsMap[input.siteId]);
  const linkedSites = filterLinkedSitesByType(
    objectValue(current.linkedSites || current.linked_sites),
    input.linkType
  );
  const currentMeta = objectValue(current.groupMetadata);
  const keepMetadata = text(currentMeta.type) && text(currentMeta.type) !== input.linkType;
  const nextPermissionLevel = keepMetadata
    ? text(current.permissionLevel || 'full_transfer')
    : remainingIds.length ? text(current.permissionLevel || 'full_transfer') : 'full_transfer';
  const nextViewingOnly = keepMetadata
    ? Boolean(current.viewingOnly === true || current.viewing_only === true)
    : remainingIds.length ? Boolean(current.viewingOnly === true || current.viewing_only === true) : false;

  await patchWorkspaceAdminSettings(env, input.siteId, {
    permissionLevel: nextPermissionLevel,
    viewingOnly: nextViewingOnly,
    groupMetadata: keepMetadata ? currentMeta : null,
    linkedSites,
    updatedAt: input.now,
    __deleteKeys: [field.camel, field.snake]
  });

  if (remainingIds.length) {
    const template = objectValue(settingsMap[remainingIds[0]] || current);
    await syncGroupMembersToWorkspaceSettings(env, {
      memberIds: remainingIds,
      linkType: input.linkType,
      linkId: oldLinkId,
      groupName: text(objectValue(template.groupMetadata).name || oldLinkId || 'Linked Group'),
      permissionLevel: text(template.permissionLevel || current.permissionLevel || 'full_transfer'),
      viewingOnly: Boolean(template.viewingOnly === true || template.viewing_only === true),
      now: input.now
    });
  }

  return { siteId: input.siteId, linkType: input.linkType, oldLinkId };
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

function gmailWorkspaceIdFromOauthState(stateValue: string): string {
  const raw = text(stateValue);
  if (!raw || raw.startsWith('system:')) return '';
  const payload = raw.split('.')[0];
  if (!payload) return '';
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const state = JSON.parse(new TextDecoder().decode(bytes)) as { workspaceId?: unknown };
    return text(state.workspaceId);
  } catch {
    return '';
  }
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return json(request, env, {
      ok: true,
      service: 'kcp-api-v2',
      environment: env.ENVIRONMENT || 'development',
      workerRelease: KCP_WORKER_RELEASE,
      workerReleaseDate: KCP_WORKER_RELEASE_DATE,
      refundPipelineVersion: KCP_REFUND_PIPELINE_VERSION
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/runtime-version') {
    return json(request, env, {
      ok: true,
      service: 'kcp-api-v2',
      workerRelease: KCP_WORKER_RELEASE,
      workerReleaseDate: KCP_WORKER_RELEASE_DATE,
      refundPipelineVersion: KCP_REFUND_PIPELINE_VERSION
    });
  }

  // Backstop only — every route except login/register/reset (which have their own tighter,
  // purpose-specific limits) had NOTHING stopping a client from hammering it as fast as raw HTTP
  // allows: every read endpoint, every write outside auth, everything. This is deliberately
  // generous (a real page load fires many concurrent requests) — it exists to catch a runaway
  // client/script/bot, not to meaningfully throttle normal usage. Cloudflare dashboard-level WAF
  // rate-limit rules are the real first line of defense; this is only a fallback for when those
  // aren't configured or don't cover this specific path.
  // Excludes /webhooks/yoco/*: Yoco's webhook senders may share a small egress IP pool across many
  // merchants, so a global per-IP limit here could throttle legitimate payment webhook delivery for
  // unrelated workspaces. That path already has its own dedicated per-workspace limit instead (see
  // webhook-ingress.ts).
  if (!/^\/webhooks\/yoco\//.test(url.pathname)) {
    const backstopLimited = await checkRateLimit(env.CENTRAL_DB, `http:${clientIp(request)}`, 300, 60);
    if (backstopLimited.blocked) {
      return json(request, env, { ok: false, error: 'Too many requests. Please slow down.' }, 429);
    }
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

  // Sole external Yoco webhook ingress. The tenant DO verifies the signature, captures the immutable
  // V2 raw event, and publishes identifier-only queue work. No sale, refund, reporting, or stock
  // business effect executes in the request path.
  const yocoWebhookM = url.pathname.match(/^\/webhooks\/yoco\/([^/]+)$/);
  if (yocoWebhookM && request.method === 'POST') {
    // Re-enabled 2026-08-21 after the Phase 0 (real subscription-dedup fix), Phase 1 (write-budget
    // gate) and Phase 2 (unified effect gate) rebuild shipped and held clean in production. The DO
    // cold-start migration crash that originally forced this off is already fixed (see
    // WorkspaceDO.migrate()'s backoff handling). No reconciliation backfill was run for the outage
    // window (2026-08-20 → today) — reconciliation's normal scheduled sweep will pick up anything
    // missed on its own lookback window; a dedicated backfill can still be run later if needed.
    const workspaceId = decodeURIComponent(yocoWebhookM[1]);
    const doResponse = await forwardToWorkspaceDO(
      request,
      env,
      workspaceId,
      'yoco-v2/webhook',
      { uid: 'yoco-webhook', email: '' }
    );
    const headers = new Headers(doResponse.headers);
    for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
    return new Response(doResponse.body, { status: doResponse.status, headers });
  }

  // Gmail OAuth returns to a global callback URL, but the connected account is stored in the
  // workspace Durable Object. Decode only the signed state's routing hint here, then let the tenant
  // handler verify the HMAC before reading or writing workspace_settings. This prevents the callback
  // from querying CENTRAL_DB, where tenant tables intentionally do not exist.
  if (request.method === 'GET' && url.pathname === '/api/gmail/oauth/callback') {
    const rawState = text(url.searchParams.get('state'));
    if (!rawState.startsWith('system:')) {
      const workspaceId = gmailWorkspaceIdFromOauthState(rawState);
      if (workspaceId) {
        const response = await forwardToWorkspaceDO(
          request,
          env,
          workspaceId,
          'gmail-oauth-callback',
          { uid: 'gmail-oauth-callback', email: '' }
        );
        const headers = new Headers(response.headers);
        for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
        return new Response(response.body, { status: response.status, headers });
      }
    }
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

    // The Workforce module was removed from this Worker entirely (no route below handles
    // `workforce/*` — grep confirms zero remaining references), but shared-device kiosk terminals
    // running an older mobile app build still poll `workforce/shared/schedule` every 30s forever,
    // waking this workspace's Durable Object for a route that can never succeed. Short-circuit
    // before auth/DO so that dead client-side polling stops costing DO invocations, without
    // needing every kiosk device redeployed first.
    if (resource === 'workforce' || resource.startsWith('workforce/')) {
      return withCors(request, env, json(request, env, { ok: false, error: 'Workforce is not available.' }, 410));
    }

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
      console.error('FETCH ERROR:', cause);
      // Authentication failures are 401. Authenticated users who lack workspace/location access are
      // 403; treating those as 401 caused report and dashboard permission failures to look like an
      // expired login and triggered misleading sign-in errors across the app.
      const raw = cause instanceof Error ? cause.message : 'Internal error.';
      const status = /too many|rate limit/i.test(raw)
        ? 429
        : /permission|denied|no locations are assigned|access to this workspace/i.test(raw)
          ? 403
          : /token|sign in|session|expired|missing bearer|authentication/i.test(raw)
            ? 401
            : 500;
      // Deliberate validation errors thrown by route handlers (e.g. "X cannot be assigned as a
      // recipe ingredient.", "A stock item named X already exists.") are safe and useful to show
      // verbatim. The previous keyword list was too narrow and silently replaced clear, specific
      // validation messages with a useless generic one, hiding the real (and actionable) reason.
      // The denylist guards against ever surfacing a raw runtime/DB exception incidentally.
      const looksLikeInternalException = /sqlite|d1_error|TypeError:|ReferenceError:|SyntaxError:|RangeError:|at Object\.|at async|stack trace|\bundefined is not\b/i.test(raw);
      const message = !looksLikeInternalException && /too many|rate limit|token|session|expired|access|permission|denied|invalid|required|not found|sign in|password|email|already exists|duplicate|unique|cannot be|must be|not allowed|not permitted|is not configured|could not|non-stock item|no longer/i.test(raw)
        ? raw
        : 'Something went wrong. Please try again.';
      return json(request, env, { ok: false, error: message }, status);
    }
  },

  async queue(batch: MessageBatch<YocoV2QueueMessage>, env: Env): Promise<void> {
    await consumeYocoV2QueueBatch(batch, (message) => dispatchYocoV2QueueMessage(env, message));
  },

  // Low-stock email cron. The per-workspace stock/settings/run tables are tenant-only, so we
  // enumerate active workspaces from CENTRAL_DB here (front Worker) and fan out to each workspace's
  // DO, where `sendWorkspaceLowStockDue` reads tenant tables via env.DB and central tables via
  // env.CENTRAL_DB. (Running it centrally would throw "no such table" on the tenant joins.)
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const list = await env.CENTRAL_DB.prepare(
      `SELECT id FROM workspaces WHERE status = 'active' ORDER BY id ASC`
    ).all<{ id: string }>();
    const ids = (list.results || []).map((r) => String(r.id)).filter(Boolean);
    console.log(`[low-stock-cron] evaluating ${ids.length} active workspaces`);
    // Single `*/15 * * * *` trigger now (see wrangler.toml) — catalogue sync stays on its intended
    // 45-minute cadence via a wall-clock check instead of a second, independently-firing cron
    // trigger (the previous `*/45 * * * *` pair double-ran the other three jobs whenever both
    // triggers landed on the same minute; see CRON_BACKUP_RESTORE.md).
    const isCatalogueSyncTick = new Date(_event.scheduledTime).getUTCMinutes() % 45 === 0;
    const jobs = ids.flatMap((id) => [
      () => callWorkspaceDO(env, id, 'admin-action/low-stock-due', { uid: 'system', email: '' }, 'POST', {})
        .catch((cause) => { console.error(`[low-stock-cron] ws=${id} failed: ${cause}`); return null; }),
      () => callWorkspaceDO(env, id, 'admin-action/report-schedules-due', { uid: 'system', email: '' }, 'POST', {})
        .catch((cause) => { console.error(`[report-schedule-cron] ws=${id} failed: ${cause}`); return null; }),
      () => callWorkspaceDO(env, id, 'yoco-v2/reconciliation/scheduled', { uid: 'system', email: '', systemRole: 'queue' }, 'POST', {})
        .catch((cause) => { console.error(`[yoco-v2-reconciliation-cron] ws=${id} failed: ${cause}`); return null; }),
      // Menu/catalogue sync only needs to run on the 45-minute schedule, not every 15 minutes
      // alongside the other jobs above — this guard keeps it from firing 3x as often as intended.
      isCatalogueSyncTick
        ? () => callWorkspaceDO(env, id, 'admin-action/catalogue-sync-due', { uid: 'system', email: '' }, 'POST', {})
            .catch((cause) => { console.error(`[catalogue-sync-cron] ws=${id} failed: ${cause}`); return null; })
        : () => Promise.resolve(null)
    ]);
    // Unbounded Promise.all across every active workspace (each firing up to 4 jobs, including a
    // potentially large report-schedule run) is the exact same "many expensive things at once
    // exhaust a shared account-wide quota" shape as the 2026-08-26 migration incident, just at
    // account scale instead of a single Durable Object. Bounding concurrency keeps total in-flight
    // work roughly constant regardless of how many workspaces exist.
    await runWithConcurrencyLimit(jobs, 5);
  }
};
