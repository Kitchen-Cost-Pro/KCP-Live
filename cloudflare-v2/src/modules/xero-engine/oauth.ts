import type { Env } from '../../legacy/types';
import { hmacSha256Base64 } from '../../legacy/crypto';
import { text, objectValue, xeroStateSecret, xeroRedirectUri, XERO_SCOPES } from './config';

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

export async function signXeroState(env: Env, state: Record<string, unknown>): Promise<string> {
  const secret = xeroStateSecret(env);
  if (!secret) throw new Error('Xero OAuth state secret is not configured.');
  const payload = base64UrlEncodeText(JSON.stringify(state));
  const signature = (await hmacSha256Base64(secret, payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${payload}.${signature}`;
}

export async function verifyXeroState(env: Env, value: string): Promise<Record<string, unknown>> {
  const [payload, signature] = text(value).split('.');
  if (!payload || !signature) throw new Error('Xero connection state is invalid.');
  const secret = xeroStateSecret(env);
  if (!secret) throw new Error('Xero OAuth state secret is not configured.');
  const expected = (await hmacSha256Base64(secret, payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  if (signature !== expected) throw new Error('Xero connection state could not be verified.');
  const parsed = objectValue(JSON.parse(base64UrlDecodeText(payload)));
  const issuedAt = Number(parsed.iat) || 0;
  if (!issuedAt || Date.now() - issuedAt > 10 * 60 * 1000) {
    throw new Error('Xero connection link has expired. Start the connection again.');
  }
  return parsed;
}

/** Decode-only (no signature verification) — used by the front Worker purely to route an OAuth
 * redirect to the right workspace DO, which then re-verifies the HMAC itself. Mirrors
 * gmailWorkspaceIdFromOauthState in src/index.ts. */
export function xeroWorkspaceIdFromOauthState(stateValue: string): string {
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

export function buildXeroAuthorizeUrl(request: Request, env: Env, state: string): string {
  const authUrl = new URL('https://login.xero.com/identity/connect/authorize');
  authUrl.searchParams.set('client_id', text(env.XERO_CLIENT_ID));
  authUrl.searchParams.set('redirect_uri', xeroRedirectUri(request, env));
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', XERO_SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  return authUrl.toString();
}

export async function exchangeXeroCode(request: Request, env: Env, code: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${text(env.XERO_CLIENT_ID)}:${text(env.XERO_CLIENT_SECRET)}`)}`
    },
    body: new URLSearchParams({
      code,
      redirect_uri: xeroRedirectUri(request, env),
      grant_type: 'authorization_code'
    })
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(text(result.error_description || result.error || 'Xero did not return an access token.'));
  return result;
}

export async function refreshXeroAccessToken(env: Env, refreshToken: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${text(env.XERO_CLIENT_ID)}:${text(env.XERO_CLIENT_SECRET)}`)}`
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(text(result.error_description || result.error || 'Xero could not refresh access.'));
  return result;
}

export interface XeroConnectionSummary {
  tenantId: string;
  tenantName: string;
}

/** GET /connections — lists the Xero organisations (tenants) this access token is authorized for.
 * Called right after the initial code exchange to discover the tenant id (Xero's OAuth flow does
 * not return it directly, unlike Google — the tenant is a separate "connections" concept). */
export async function fetchXeroConnections(accessToken: string): Promise<XeroConnectionSummary[]> {
  const response = await fetch('https://api.xero.com/connections', {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const result = (await response.json().catch(() => [])) as Array<Record<string, unknown>>;
  if (!response.ok) throw new Error('Could not list Xero organisations for this connection.');
  return (Array.isArray(result) ? result : []).map((entry) => ({
    tenantId: text(entry.tenantId),
    tenantName: text(entry.tenantName)
  }));
}
