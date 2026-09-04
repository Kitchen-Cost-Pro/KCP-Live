import type { Env } from '../../legacy/types';
import { hmacSha256Base64 } from '../../legacy/crypto';
import { text, objectValue, driveStateSecret, driveRedirectUri, driveScopes } from './config';

function base64UrlEncodeText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeText(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function signDriveState(env: Env, state: Record<string, unknown>): Promise<string> {
  const secret = driveStateSecret(env);
  if (!secret) throw new Error('Google Drive OAuth state secret is not configured.');
  const payload = base64UrlEncodeText(JSON.stringify(state));
  const signature = (await hmacSha256Base64(secret, payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${payload}.${signature}`;
}

export async function verifyDriveState(env: Env, value: string): Promise<Record<string, unknown>> {
  const [payload, signature] = text(value).split('.');
  if (!payload || !signature) throw new Error('Google Drive connection state is invalid.');
  const secret = driveStateSecret(env);
  if (!secret) throw new Error('Google Drive OAuth state secret is not configured.');
  const expected = (await hmacSha256Base64(secret, payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  if (signature !== expected) throw new Error('Google Drive connection state could not be verified.');
  const parsed = objectValue(JSON.parse(base64UrlDecodeText(payload)));
  const issuedAt = Number(parsed.iat) || 0;
  if (!issuedAt || Date.now() - issuedAt > 10 * 60 * 1000) {
    throw new Error('Google Drive connection link has expired. Start the connection again.');
  }
  return parsed;
}

/** Decode-only (no signature verification) — used by the front Worker purely to route an OAuth
 * redirect to the right workspace DO, which then re-verifies the HMAC itself. Mirrors
 * xeroWorkspaceIdFromOauthState in modules/xero-engine/oauth.ts. */
export function driveWorkspaceIdFromOauthState(stateValue: string): string {
  const raw = text(stateValue);
  if (!raw) return '';
  const payload = raw.split('.')[0];
  if (!payload) return '';
  try {
    const parsed = objectValue(JSON.parse(base64UrlDecodeText(payload)));
    return text(parsed.workspaceId);
  } catch {
    return '';
  }
}

export function buildDriveAuthorizeUrl(request: Request, env: Env, state: string): string {
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', text(env.GDRIVE_CLIENT_ID));
  authUrl.searchParams.set('redirect_uri', driveRedirectUri(request, env));
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', driveScopes(env).join(' '));
  authUrl.searchParams.set('state', state);
  // access_type=offline + prompt=consent guarantee a refresh_token comes back — Google only issues
  // one on the FIRST consent for a given client+account, and silently omits it on every later
  // re-auth unless prompt=consent forces the consent screen again.
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  return authUrl.toString();
}

export async function exchangeDriveCode(request: Request, env: Env, code: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: text(env.GDRIVE_CLIENT_ID),
      client_secret: text(env.GDRIVE_CLIENT_SECRET),
      redirect_uri: driveRedirectUri(request, env),
      grant_type: 'authorization_code'
    })
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(text(result.error_description || result.error || 'Google did not return an access token.'));
  return result;
}

export async function refreshDriveAccessToken(env: Env, refreshToken: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: text(env.GDRIVE_CLIENT_ID),
      client_secret: text(env.GDRIVE_CLIENT_SECRET),
      grant_type: 'refresh_token'
    })
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(text(result.error_description || result.error || 'Google could not refresh access.'));
  return result;
}

/** GET the connected Google account's email — unlike Xero, Google's token response carries
 * everything needed to use the Drive API directly, so this is purely for display in the
 * Integrations UI ("Connected as name@gmail.com"), not for routing/tenant discovery. */
export async function fetchDriveAccountEmail(accessToken: string): Promise<string> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) return '';
  return text(result.email);
}
