import type { Env } from '../../legacy/types';
import { encryptTextWithSecret, decryptTextWithSecret } from '../../legacy/crypto';
import { text, nowIso, xeroTokenSecret } from './config';
import { refreshXeroAccessToken } from './oauth';

export interface XeroConnectionRow {
  workspace_id: string;
  xero_tenant_id?: string | null;
  tenant_name?: string | null;
  access_token_encrypted?: string | null;
  refresh_token_encrypted?: string | null;
  token_expires_at?: string | null;
  scope?: string | null;
  status: string;
  last_error?: string | null;
}

export async function getXeroConnection(env: Env, workspaceId: string): Promise<XeroConnectionRow | null> {
  return env.DB.prepare(`SELECT * FROM xero_connections WHERE workspace_id = ?1 LIMIT 1`)
    .bind(workspaceId)
    .first<XeroConnectionRow>();
}

export async function saveXeroConnection(
  env: Env,
  workspaceId: string,
  input: {
    xeroTenantId: string;
    tenantName: string;
    accessToken: string;
    refreshToken: string;
    expiresInSeconds: number;
    scope: string;
    connectedByUid: string;
    connectedByEmail: string;
  }
): Promise<void> {
  const secret = xeroTokenSecret(env);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO xero_connections
      (workspace_id, xero_tenant_id, tenant_name, access_token_encrypted, refresh_token_encrypted,
       token_expires_at, scope, status, connected_at, connected_by_uid, connected_by_email,
       last_error, disconnected_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'connected', ?8, ?9, ?10, '', NULL, ?8, ?8)
     ON CONFLICT(workspace_id) DO UPDATE SET
       xero_tenant_id = excluded.xero_tenant_id,
       tenant_name = excluded.tenant_name,
       access_token_encrypted = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       token_expires_at = excluded.token_expires_at,
       scope = excluded.scope,
       status = 'connected',
       connected_at = excluded.connected_at,
       connected_by_uid = excluded.connected_by_uid,
       connected_by_email = excluded.connected_by_email,
       last_error = '',
       disconnected_at = NULL,
       updated_at = excluded.updated_at`
  )
    .bind(
      workspaceId,
      input.xeroTenantId,
      input.tenantName,
      await encryptTextWithSecret(secret, input.accessToken),
      await encryptTextWithSecret(secret, input.refreshToken),
      expiresAt,
      input.scope,
      now,
      input.connectedByUid,
      input.connectedByEmail
    )
    .run();
}

export async function disconnectXero(env: Env, workspaceId: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE xero_connections SET status = 'disconnected', disconnected_at = ?2, updated_at = ?2 WHERE workspace_id = ?1`
  ).bind(workspaceId, now).run();
}

async function markConnectionError(env: Env, workspaceId: string, message: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE xero_connections SET status = 'error', last_error = ?2, updated_at = ?3 WHERE workspace_id = ?1`
  ).bind(workspaceId, message.slice(0, 500), now).run();
}

/**
 * Returns a valid (non-expired) access token + tenant id for this workspace's Xero connection,
 * refreshing it first if it's within 2 minutes of expiry. Xero access tokens last ~30 minutes;
 * refresh tokens rotate on every use, so the new refresh token is persisted immediately.
 */
export async function loadValidXeroAccessToken(
  env: Env,
  workspaceId: string
): Promise<{ accessToken: string; xeroTenantId: string }> {
  const row = await getXeroConnection(env, workspaceId);
  if (!row || row.status !== 'connected' || !row.access_token_encrypted || !row.refresh_token_encrypted) {
    throw new Error('This workspace is not connected to Xero.');
  }
  const secret = xeroTokenSecret(env);
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  const needsRefresh = !expiresAt || expiresAt - Date.now() < 2 * 60 * 1000;
  if (!needsRefresh) {
    return { accessToken: await decryptTextWithSecret(secret, row.access_token_encrypted), xeroTenantId: text(row.xero_tenant_id) };
  }
  try {
    const refreshToken = await decryptTextWithSecret(secret, row.refresh_token_encrypted);
    const refreshed = await refreshXeroAccessToken(env, refreshToken);
    const accessToken = text(refreshed.access_token);
    const newRefreshToken = text(refreshed.refresh_token) || refreshToken;
    if (!accessToken) throw new Error('Xero did not return a refreshed access token.');
    const expiresInSeconds = Number(refreshed.expires_in) || 1800;
    const now = nowIso();
    await env.DB.prepare(
      `UPDATE xero_connections SET
         access_token_encrypted = ?2, refresh_token_encrypted = ?3, token_expires_at = ?4,
         status = 'connected', last_error = '', updated_at = ?5
       WHERE workspace_id = ?1`
    )
      .bind(
        workspaceId,
        await encryptTextWithSecret(secret, accessToken),
        await encryptTextWithSecret(secret, newRefreshToken),
        new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
        now
      )
      .run();
    return { accessToken, xeroTenantId: text(row.xero_tenant_id) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Xero token refresh failed.';
    // A refresh failure almost always means the connection needs to be re-authorized (revoked
    // access, expired refresh token past its ~60-day inactivity window) — surface that as a clear
    // 'error' status rather than retrying forever against a connection that can't recover itself.
    await markConnectionError(env, workspaceId, message);
    throw new Error(`${message} Reconnect this workspace to Xero.`);
  }
}
