import type { Env } from '../../legacy/types';
import { encryptTextWithSecret, decryptTextWithSecret } from '../../legacy/crypto';
import { text, nowIso, driveTokenSecret } from './config';
import { refreshDriveAccessToken } from './oauth';

export interface DriveConnectionRow {
  workspace_id: string;
  account_email?: string | null;
  root_folder_id?: string | null;
  access_token_encrypted?: string | null;
  refresh_token_encrypted?: string | null;
  token_expires_at?: string | null;
  scope?: string | null;
  status: string;
  last_error?: string | null;
}

export async function getDriveConnection(env: Env, workspaceId: string): Promise<DriveConnectionRow | null> {
  return env.DB.prepare(`SELECT * FROM drive_connections WHERE workspace_id = ?1 LIMIT 1`)
    .bind(workspaceId)
    .first<DriveConnectionRow>();
}

export async function saveDriveConnection(
  env: Env,
  workspaceId: string,
  input: {
    accountEmail: string;
    accessToken: string;
    refreshToken: string;
    expiresInSeconds: number;
    scope: string;
    connectedByUid: string;
    connectedByEmail: string;
  }
): Promise<void> {
  const secret = driveTokenSecret(env);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO drive_connections
      (workspace_id, account_email, access_token_encrypted, refresh_token_encrypted,
       token_expires_at, scope, status, connected_at, connected_by_uid, connected_by_email,
       last_error, disconnected_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'connected', ?7, ?8, ?9, '', NULL, ?7, ?7)
     ON CONFLICT(workspace_id) DO UPDATE SET
       account_email = excluded.account_email,
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
      input.accountEmail,
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

export async function saveDriveRootFolderId(env: Env, workspaceId: string, rootFolderId: string): Promise<void> {
  await env.DB.prepare(`UPDATE drive_connections SET root_folder_id = ?2, updated_at = ?3 WHERE workspace_id = ?1`)
    .bind(workspaceId, rootFolderId, nowIso())
    .run();
}

export async function disconnectDrive(env: Env, workspaceId: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE drive_connections SET status = 'disconnected', disconnected_at = ?2, updated_at = ?2 WHERE workspace_id = ?1`
  ).bind(workspaceId, now).run();
}

async function markConnectionError(env: Env, workspaceId: string, message: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE drive_connections SET status = 'error', last_error = ?2, updated_at = ?3 WHERE workspace_id = ?1`
  ).bind(workspaceId, message.slice(0, 500), now).run();
}

/**
 * Returns a valid (non-expired) access token for this workspace's Drive connection, refreshing it
 * first if it's within 2 minutes of expiry. Google access tokens last ~1 hour; unlike Xero, Google
 * does not rotate the refresh token on use, so only the access token + expiry are re-persisted.
 */
export async function loadValidDriveAccessToken(env: Env, workspaceId: string): Promise<{ accessToken: string; rootFolderId: string }> {
  const row = await getDriveConnection(env, workspaceId);
  if (!row || row.status !== 'connected' || !row.access_token_encrypted || !row.refresh_token_encrypted) {
    throw new Error('This workspace is not connected to Google Drive.');
  }
  const secret = driveTokenSecret(env);
  const rootFolderId = text(row.root_folder_id);
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  const needsRefresh = !expiresAt || expiresAt - Date.now() < 2 * 60 * 1000;
  if (!needsRefresh) {
    return { accessToken: await decryptTextWithSecret(secret, row.access_token_encrypted), rootFolderId };
  }
  try {
    const refreshToken = await decryptTextWithSecret(secret, row.refresh_token_encrypted);
    const refreshed = await refreshDriveAccessToken(env, refreshToken);
    const accessToken = text(refreshed.access_token);
    if (!accessToken) throw new Error('Google did not return a refreshed access token.');
    const expiresInSeconds = Number(refreshed.expires_in) || 3600;
    const now = nowIso();
    await env.DB.prepare(
      `UPDATE drive_connections SET
         access_token_encrypted = ?2, token_expires_at = ?3, status = 'connected', last_error = '', updated_at = ?4
       WHERE workspace_id = ?1`
    )
      .bind(workspaceId, await encryptTextWithSecret(secret, accessToken), new Date(Date.now() + expiresInSeconds * 1000).toISOString(), now)
      .run();
    return { accessToken, rootFolderId };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Google Drive token refresh failed.';
    // A refresh failure almost always means the connection needs to be re-authorized (access
    // revoked from the user's Google Account, refresh token expired from long inactivity) — surface
    // that as a clear 'error' status rather than retrying forever against a dead connection.
    await markConnectionError(env, workspaceId, message);
    throw new Error(`${message} Reconnect this workspace to Google Drive.`);
  }
}
