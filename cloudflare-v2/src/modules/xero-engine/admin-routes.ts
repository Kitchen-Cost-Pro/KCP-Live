import type { AuthContext, Env } from '../../legacy/types';
import { text, nowIso, xeroConfigured, xeroRedirectUri } from './config';
import { signXeroState, verifyXeroState, buildXeroAuthorizeUrl, exchangeXeroCode, fetchXeroConnections } from './oauth';
import { getXeroConnection, saveXeroConnection, disconnectXero } from './connection';
import { hasXeroAdminPermission } from './admin-permissions';
import { syncXeroItemsForWorkspace } from './item-sync';
import { syncXeroDailyInvoice, claimDailyInvoiceSyncIfDue, releaseDailyInvoiceSyncClaim, yesterdayDateKey } from './invoice-sync';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// Mirrors gmailCallbackHtml in legacy/routes.ts: the frontend opens the Xero consent screen in a
// popup (window.open), so this callback page posts a message back to the opener and closes itself
// rather than relying on a redirect the popup's own location bar would show.
function callbackHtml(message: string, ok: boolean): Response {
  const safe = text(message).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return html(
    `<!doctype html>
<html><head><meta charset="utf-8"><title>Xero ${ok ? 'Connected' : 'Connection Failed'}</title></head>
<body style="font-family:Inter,Arial,sans-serif;background:#08111f;color:#f5f8ff;display:grid;place-items:center;min-height:100vh;margin:0">
  <main style="max-width:520px;padding:28px;border:1px solid #28415f;border-radius:16px;background:#101b2c;text-align:center">
    <h1 style="margin:0 0 12px">${ok ? 'Xero connected' : 'Xero connection failed'}</h1>
    <p style="color:#aebbd0">${safe}</p>
  </main>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'kcp:xero-oauth', ok: ${ok ? 'true' : 'false'}, message: ${JSON.stringify(message)} }, '*');
      window.setTimeout(() => window.close(), 900);
    }
  </script>
</body></html>`,
    ok ? 200 : 400
  );
}

interface SyncSettingsRow {
  sales_account_code: string | null;
  default_tax_type: string | null;
  item_account_code: string | null;
  enabled: number;
  last_item_sync_at: string | null;
  last_invoice_sync_date: string | null;
}

async function getSyncSettings(env: Env, workspaceId: string): Promise<SyncSettingsRow | null> {
  return env.DB.prepare(`SELECT * FROM xero_sync_settings WHERE workspace_id = ?1 LIMIT 1`).bind(workspaceId).first<SyncSettingsRow>();
}

async function getStatus(env: Env, workspaceId: string) {
  const [connection, settings] = await Promise.all([getXeroConnection(env, workspaceId), getSyncSettings(env, workspaceId)]);
  return response({
    ok: true,
    configured: xeroConfigured(env),
    status: connection?.status || 'disconnected',
    tenantName: text(connection?.tenant_name),
    lastError: text(connection?.last_error),
    settings: settings
      ? {
          salesAccountCode: text(settings.sales_account_code),
          defaultTaxType: text(settings.default_tax_type),
          itemAccountCode: text(settings.item_account_code),
          enabled: Boolean(settings.enabled),
          lastItemSyncAt: text(settings.last_item_sync_at),
          lastInvoiceSyncDate: text(settings.last_invoice_sync_date)
        }
      : null
  });
}

async function postConnectStart(request: Request, env: Env, auth: AuthContext, workspaceId: string) {
  if (!xeroConfigured(env)) return response({ ok: false, error: 'Xero OAuth is not configured for this environment.' }, 400);
  const state = await signXeroState(env, { workspaceId, uid: auth.uid, email: auth.email, iat: Date.now(), nonce: crypto.randomUUID() });
  return response({ ok: true, authUrl: buildXeroAuthorizeUrl(request, env, state), redirectUri: xeroRedirectUri(request, env) });
}

async function getOauthCallback(request: Request, env: Env) {
  const url = new URL(request.url);
  try {
    if (!xeroConfigured(env)) throw new Error('Xero OAuth is not configured.');
    const xeroError = text(url.searchParams.get('error'));
    if (xeroError) throw new Error(xeroError);
    const code = text(url.searchParams.get('code'));
    if (!code) throw new Error('Xero did not return an authorization code.');
    const state = await verifyXeroState(env, text(url.searchParams.get('state')));
    const workspaceId = text(state.workspaceId);
    if (!workspaceId) throw new Error('Workspace is missing from the Xero connection state.');

    const token = await exchangeXeroCode(request, env, code);
    const accessToken = text(token.access_token);
    const refreshToken = text(token.refresh_token);
    if (!accessToken || !refreshToken) throw new Error('Xero did not return a usable access/refresh token pair.');

    const connections = await fetchXeroConnections(accessToken);
    const tenant = connections[0];
    if (!tenant) throw new Error('No Xero organisation is authorized for this connection.');

    await saveXeroConnection(env, workspaceId, {
      xeroTenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      accessToken,
      refreshToken,
      expiresInSeconds: Number(token.expires_in) || 1800,
      scope: text(token.scope),
      connectedByUid: text(state.uid),
      connectedByEmail: text(state.email)
    });
    await env.DB.prepare(
      `INSERT INTO xero_sync_settings (workspace_id, enabled, created_at, updated_at)
       VALUES (?1, 0, ?2, ?2)
       ON CONFLICT(workspace_id) DO NOTHING`
    )
      .bind(workspaceId, nowIso())
      .run();

    return callbackHtml(`Connected to ${tenant.tenantName || 'your Xero organisation'}. Set your sales account code and tax type in Xero settings before enabling sync.`, true);
  } catch (cause) {
    return callbackHtml(cause instanceof Error ? cause.message : 'Xero connection failed.', false);
  }
}

async function postDisconnect(env: Env, workspaceId: string) {
  await disconnectXero(env, workspaceId);
  return response({ ok: true });
}

async function postSettings(request: Request, env: Env, workspaceId: string) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const salesAccountCode = text(body.salesAccountCode);
  const defaultTaxType = text(body.defaultTaxType);
  const itemAccountCode = text(body.itemAccountCode) || salesAccountCode;
  const enabled = Boolean(body.enabled);
  if (enabled && (!salesAccountCode || !defaultTaxType)) {
    return response({ ok: false, error: 'A sales account code and tax type are required before enabling sync.' }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO xero_sync_settings (workspace_id, sales_account_code, default_tax_type, item_account_code, enabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(workspace_id) DO UPDATE SET
       sales_account_code = excluded.sales_account_code,
       default_tax_type = excluded.default_tax_type,
       item_account_code = excluded.item_account_code,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  )
    .bind(workspaceId, salesAccountCode, defaultTaxType, itemAccountCode, enabled ? 1 : 0, nowIso())
    .run();
  return response({ ok: true });
}

async function postSyncNow(env: Env, workspaceId: string, kind: string) {
  const settings = await getSyncSettings(env, workspaceId);
  if (!settings || !settings.sales_account_code || !settings.default_tax_type) {
    return response({ ok: false, error: 'Set a sales account code and tax type in Xero settings first.' }, 400);
  }
  if (kind === 'items') {
    const result = await syncXeroItemsForWorkspace(env, workspaceId, {
      itemAccountCode: text(settings.item_account_code) || text(settings.sales_account_code),
      defaultTaxType: text(settings.default_tax_type)
    });
    return response({ ok: true, result });
  }
  if (kind === 'invoice') {
    // Manual "sync now" always targets yesterday's business day, same as the automatic due-check —
    // today's day is still open and could double-count a sale rung up moments later.
    const dateKey = yesterdayDateKey();
    const result = await syncXeroDailyInvoice(env, workspaceId, dateKey, {
      salesAccountCode: text(settings.sales_account_code),
      defaultTaxType: text(settings.default_tax_type)
    });
    return response({ ok: true, dateKey, result });
  }
  return response({ ok: false, error: 'Unknown sync kind. Use "items" or "invoice".' }, 400);
}

async function postDueCheck(env: Env, workspaceId: string) {
  const claim = await claimDailyInvoiceSyncIfDue(env, workspaceId);
  if (!claim.due || !claim.dateKey) return response({ ok: true, skipped: true });
  const settings = await getSyncSettings(env, workspaceId);
  if (!settings || !settings.sales_account_code || !settings.default_tax_type) {
    await releaseDailyInvoiceSyncClaim(env, workspaceId, claim.dateKey, false);
    return response({ ok: true, skipped: true, reason: 'Xero sync settings incomplete.' });
  }
  const result = await syncXeroDailyInvoice(env, workspaceId, claim.dateKey, {
    salesAccountCode: text(settings.sales_account_code),
    defaultTaxType: text(settings.default_tax_type)
  });
  const success = result.status === 'applied' || result.status === 'duplicate' || result.status === 'skipped_no_sales';
  await releaseDailyInvoiceSyncClaim(env, workspaceId, claim.dateKey, success);
  return response({ ok: true, dateKey: claim.dateKey, result });
}

export async function handleXeroAdminRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  resource: string
): Promise<Response | null> {
  if (resource === 'xero-oauth-callback') {
    if (auth.uid !== 'xero-oauth-callback') return response({ ok: false, error: 'Invalid Xero OAuth callback route.' }, 403);
    return getOauthCallback(request, env);
  }

  if (resource === 'xero/due-check') {
    if (auth.uid !== 'system' && auth.systemRole !== 'queue' && auth.systemRole !== 'admin') {
      return response({ ok: false, error: 'Internal due-check route only.' }, 403);
    }
    return postDueCheck(env, workspaceId);
  }

  if (!resource.startsWith('xero/')) return null;
  if (!auth.uid) return response({ ok: false, error: 'Authentication required.' }, 401);

  if (request.method === 'GET' && resource === 'xero/status') {
    return getStatus(env, workspaceId);
  }

  // Everything below mutates the connection/config or triggers a push — admin-only.
  if (!hasXeroAdminPermission(auth, 'xero.configure') && resource !== 'xero/sync-now') {
    return response({ ok: false, error: 'Administrator access required.' }, 403);
  }

  if (request.method === 'POST' && resource === 'xero/connect-start') {
    return postConnectStart(request, env, auth, workspaceId);
  }
  if (request.method === 'POST' && resource === 'xero/disconnect') {
    return postDisconnect(env, workspaceId);
  }
  if (request.method === 'POST' && resource === 'xero/settings') {
    return postSettings(request, env, workspaceId);
  }
  if (request.method === 'POST' && resource.startsWith('xero/sync-now')) {
    if (!hasXeroAdminPermission(auth, 'xero.sync') && !hasXeroAdminPermission(auth, 'xero.configure')) {
      return response({ ok: false, error: 'Administrator access required.' }, 403);
    }
    const kind = new URL(request.url).searchParams.get('kind') || 'invoice';
    return postSyncNow(env, workspaceId, kind);
  }

  return null;
}
