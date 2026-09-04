import type { AuthContext, Env } from '../../legacy/types';
import { text, objectValue, nowIso, driveConfigured, driveRedirectUri } from './config';
import { signDriveState, verifyDriveState, buildDriveAuthorizeUrl, exchangeDriveCode, fetchDriveAccountEmail } from './oauth';
import { getDriveConnection, saveDriveConnection, disconnectDrive } from './connection';
import { canManageDrive } from './admin-permissions';
import { syncPendingDriveGrvs } from './grv-drive-sync';
import { syncPendingDriveCreditNotes } from './credit-note-drive-sync';
import { processInvoicePhoto, tagDriveInvoiceWithGrv, GrvExtractResult } from './assistant';
import { listActiveLocations } from './folders';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// Mirrors modules/xero-engine/admin-routes.ts's callbackHtml — the frontend opens Google's consent
// screen in a popup, so this callback page posts a message back to the opener and closes itself.
function callbackHtml(message: string, ok: boolean): Response {
  const safe = text(message).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return html(
    `<!doctype html>
<html><head><meta charset="utf-8"><title>Google Drive ${ok ? 'Connected' : 'Connection Failed'}</title></head>
<body style="font-family:Inter,Arial,sans-serif;background:#08111f;color:#f5f8ff;display:grid;place-items:center;min-height:100vh;margin:0">
  <main style="max-width:520px;padding:28px;border:1px solid #28415f;border-radius:16px;background:#101b2c;text-align:center">
    <h1 style="margin:0 0 12px">${ok ? 'Google Drive connected' : 'Google Drive connection failed'}</h1>
    <p style="color:#aebbd0">${safe}</p>
  </main>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'kcp:drive-oauth', ok: ${ok ? 'true' : 'false'}, message: ${JSON.stringify(message)} }, '*');
      window.setTimeout(() => window.close(), 900);
    }
  </script>
</body></html>`,
    ok ? 200 : 400
  );
}

async function getWorkspaceSettingsJson(env: Env, workspaceId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(`SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`).bind(workspaceId).first<{ raw_json: string }>();
  try {
    return objectValue(JSON.parse(row?.raw_json || '{}'));
  } catch {
    return {};
  }
}

async function mergeWorkspaceSettingsJson(env: Env, workspaceId: string, patch: Record<string, unknown>): Promise<void> {
  const current = await getWorkspaceSettingsJson(env, workspaceId);
  const merged = { ...current, ...patch };
  await env.DB.prepare(
    `INSERT INTO workspace_settings (workspace_id, raw_json, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(workspace_id) DO UPDATE SET raw_json = excluded.raw_json, updated_at = excluded.updated_at`
  ).bind(workspaceId, JSON.stringify(merged), nowIso()).run();
}

async function getStatus(env: Env, workspaceId: string) {
  const [connection, settings] = await Promise.all([getDriveConnection(env, workspaceId), getWorkspaceSettingsJson(env, workspaceId)]);
  return response({
    ok: true,
    configured: driveConfigured(env),
    status: connection?.status || 'disconnected',
    accountEmail: text(connection?.account_email),
    lastError: text(connection?.last_error),
    settings: {
      pushGrvEnabled: settings.drive_push_grv_enabled === true,
      pushCreditNoteEnabled: settings.drive_push_credit_note_enabled === true,
      ocrEnabled: settings.ocr_enabled === true
    }
  });
}

async function postConnectStart(request: Request, env: Env, auth: AuthContext, workspaceId: string) {
  if (!driveConfigured(env)) return response({ ok: false, error: 'Google Drive OAuth is not configured for this environment.' }, 400);
  const state = await signDriveState(env, { workspaceId, uid: auth.uid, email: auth.email, iat: Date.now(), nonce: crypto.randomUUID() });
  return response({ ok: true, authUrl: buildDriveAuthorizeUrl(request, env, state), redirectUri: driveRedirectUri(request, env) });
}

async function getOauthCallback(request: Request, env: Env) {
  const url = new URL(request.url);
  try {
    if (!driveConfigured(env)) throw new Error('Google Drive OAuth is not configured.');
    const driveError = text(url.searchParams.get('error'));
    if (driveError) throw new Error(driveError);
    const code = text(url.searchParams.get('code'));
    if (!code) throw new Error('Google did not return an authorization code.');
    const state = await verifyDriveState(env, text(url.searchParams.get('state')));
    const workspaceId = text(state.workspaceId);
    if (!workspaceId) throw new Error('Workspace is missing from the Google Drive connection state.');

    const token = await exchangeDriveCode(request, env, code);
    const accessToken = text(token.access_token);
    const refreshToken = text(token.refresh_token);
    if (!accessToken || !refreshToken) {
      throw new Error('Google did not return a usable access/refresh token pair. Disconnect and try again — Google only grants a refresh token on first-time consent.');
    }
    const accountEmail = await fetchDriveAccountEmail(accessToken);

    await saveDriveConnection(env, workspaceId, {
      accountEmail,
      accessToken,
      refreshToken,
      expiresInSeconds: Number(token.expires_in) || 3600,
      scope: text(token.scope),
      connectedByUid: text(state.uid),
      connectedByEmail: text(state.email)
    });

    return callbackHtml(`Connected as ${accountEmail || 'your Google account'}. A "KCP Documents" folder will appear in that Drive the first time a GRV or Credit Note is pushed.`, true);
  } catch (cause) {
    return callbackHtml(cause instanceof Error ? cause.message : 'Google Drive connection failed.', false);
  }
}

async function postDisconnect(env: Env, workspaceId: string) {
  await disconnectDrive(env, workspaceId);
  return response({ ok: true });
}

// ocr_enabled is deliberately NOT settable here — like ai_onboarding_enabled, it's an
// admin-console-only flag a workspace owner can't turn on themselves (see the KCP Admin Console's
// toggleWorkspaceOcrAssistant, which writes it through the separate superuser-gated
// PATCH /api/admin/workspaces/:id/settings route). This route only owns the two push toggles.
async function postSettings(request: Request, env: Env, workspaceId: string) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  await mergeWorkspaceSettingsJson(env, workspaceId, {
    drive_push_grv_enabled: Boolean(body.pushGrvEnabled),
    drive_push_credit_note_enabled: Boolean(body.pushCreditNoteEnabled)
  });
  return response({ ok: true });
}

async function postSyncNow(env: Env, workspaceId: string, kind: string) {
  const settings = await getWorkspaceSettingsJson(env, workspaceId);
  if (kind === 'grv') {
    if (settings.drive_push_grv_enabled !== true) return response({ ok: false, error: 'Enable "Push GRVs to Drive" in Google Drive settings first.' }, 400);
    return response({ ok: true, result: await syncPendingDriveGrvs(env, workspaceId) });
  }
  if (kind === 'credit-notes') {
    if (settings.drive_push_credit_note_enabled !== true) return response({ ok: false, error: 'Enable "Push Credit Notes to Drive" in Google Drive settings first.' }, 400);
    return response({ ok: true, result: await syncPendingDriveCreditNotes(env, workspaceId) });
  }
  return response({ ok: false, error: 'Unknown sync kind. Use "grv" or "credit-notes".' }, 400);
}

async function postDueCheck(env: Env, workspaceId: string) {
  const settings = await getWorkspaceSettingsJson(env, workspaceId);
  const [grv, creditNotes] = await Promise.all([
    settings.drive_push_grv_enabled === true ? syncPendingDriveGrvs(env, workspaceId) : Promise.resolve({ skipped: true } as const),
    settings.drive_push_credit_note_enabled === true ? syncPendingDriveCreditNotes(env, workspaceId) : Promise.resolve({ skipped: true } as const)
  ]);
  return response({ ok: true, grv, creditNotes });
}

async function resolveLocation(env: Env, workspaceId: string, locationId: string) {
  const locations = await listActiveLocations(env, workspaceId);
  return locations.find((l) => l.id === locationId) || locations[0] || null;
}

async function postAssistantProcess(request: Request, env: Env, workspaceId: string) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const mimeType = text(body.mimeType);
  const imageBase64 = text(body.imageBase64);
  if (!imageBase64) return response({ ok: false, error: 'imageBase64 is required.' }, 400);
  const location = await resolveLocation(env, workspaceId, text(body.locationId));
  if (!location) return response({ ok: false, error: 'This workspace has no active locations yet.' }, 400);
  try {
    const result: { extract: GrvExtractResult; driveFileId: string } = await processInvoicePhoto(env, workspaceId, location.id, location.name, { mimeType, imageBase64 });
    return response({ ok: true, extract: result.extract, driveFileId: result.driveFileId, locationId: location.id });
  } catch (cause) {
    return response({ ok: false, error: cause instanceof Error ? cause.message : 'KCP Assistant could not read that invoice.' }, 502);
  }
}

async function postAssistantTagGrv(request: Request, env: Env, workspaceId: string) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const fileId = text(body.fileId);
  const grvId = text(body.grvId);
  if (!fileId || !grvId) return response({ ok: false, error: 'fileId and grvId are required.' }, 400);
  await tagDriveInvoiceWithGrv(env, workspaceId, fileId, grvId);
  return response({ ok: true });
}

export async function handleDriveAdminRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  resource: string
): Promise<Response | null> {
  if (resource === 'drive-oauth-callback') {
    if (auth.uid !== 'drive-oauth-callback') return response({ ok: false, error: 'Invalid Google Drive OAuth callback route.' }, 403);
    return getOauthCallback(request, env);
  }

  if (resource === 'drive/due-check') {
    if (auth.uid !== 'system' && auth.systemRole !== 'queue' && auth.systemRole !== 'admin') {
      return response({ ok: false, error: 'Internal due-check route only.' }, 403);
    }
    return postDueCheck(env, workspaceId);
  }

  if (!resource.startsWith('drive/')) return null;
  if (!auth.uid) return response({ ok: false, error: 'Authentication required.' }, 401);

  // Status/sync-now/assistant routes are open to any workspace member (the front Worker already
  // confirmed workspace access before forwarding here) — same bar as Xero's status/sync-now routes.
  // Only connecting/disconnecting/changing settings is owner-level (canManageDrive, below).
  if (request.method === 'GET' && resource === 'drive/status') {
    return getStatus(env, workspaceId);
  }
  if (request.method === 'POST' && resource.startsWith('drive/sync-now')) {
    const kind = new URL(request.url).searchParams.get('kind') || 'grv';
    return postSyncNow(env, workspaceId, kind);
  }
  if (request.method === 'POST' && resource === 'drive/assistant/process') {
    return postAssistantProcess(request, env, workspaceId);
  }
  if (request.method === 'POST' && resource === 'drive/assistant/tag-grv') {
    return postAssistantTagGrv(request, env, workspaceId);
  }

  if (!(await canManageDrive(env, auth, workspaceId))) {
    return response({ ok: false, error: 'Only workspace owners, admins, and super users can manage the Google Drive connection.' }, 403);
  }

  if (request.method === 'POST' && resource === 'drive/connect-start') {
    return postConnectStart(request, env, auth, workspaceId);
  }
  if (request.method === 'POST' && resource === 'drive/disconnect') {
    return postDisconnect(env, workspaceId);
  }
  if (request.method === 'POST' && resource === 'drive/settings') {
    return postSettings(request, env, workspaceId);
  }

  return null;
}
