import type { Env } from '../../legacy/types';

export function text(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value).trim();
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function xeroTokenSecret(env: Env): string {
  return text(env.XERO_TOKEN_ENCRYPTION_SECRET || env.YOCO_KEY_ENCRYPTION_SECRET);
}

export function xeroStateSecret(env: Env): string {
  return text(env.XERO_OAUTH_STATE_SECRET || env.XERO_TOKEN_ENCRYPTION_SECRET || env.YOCO_KEY_ENCRYPTION_SECRET || env.XERO_CLIENT_SECRET);
}

export function xeroConfigured(env: Env): boolean {
  return Boolean(text(env.XERO_CLIENT_ID) && text(env.XERO_CLIENT_SECRET) && xeroTokenSecret(env) && xeroStateSecret(env));
}

export function xeroRedirectUri(request: Request, env: Env): string {
  return text(env.XERO_OAUTH_REDIRECT_URI) || `${new URL(request.url).origin}/api/xero/oauth/callback`;
}

export function xeroApiBaseUrl(env: Env): string {
  return text(env.XERO_API_BASE_URL) || 'https://api.xero.com';
}

// Xero's real caps are 60 calls/min and 5,000 calls/day per tenant connection. These are kept
// deliberately below the real ceiling, mirroring the Yoco write-budget's "never actually reach
// the wall" default — see modules/yoco-engine-v2/config.ts.
export function xeroRateCaps(env: Env): { dailyCap: number; perMinuteCap: number } {
  const dailyCap = Number(env.XERO_DAILY_CALL_CAP) || 4500;
  const perMinuteCap = Number(env.XERO_PER_MINUTE_CALL_CAP) || 55;
  return { dailyCap, perMinuteCap };
}

// Xero split its old blanket 'accounting.transactions' scope into per-endpoint granular scopes
// (see devblog.xero.com "Upcoming changes to Xero Accounting API scopes") — there's no portal-side
// "enable this scope for your app" step for these any more, unlike the old model; whatever's listed
// here is simply what gets requested and granted at OAuth consent. KCP creates Invoices/Bills (see
// invoice-sync.ts, grv-sync.ts) under 'accounting.invoices', and Items (see item-sync.ts) under the
// 'settings' scope group, alongside accounts/tax rates/currencies. 'accounting.attachments' is its
// own separate scope for attaching files (the GRV PDF/invoice photo) to a Bill.
//
// 'accounting.manualjournals' and 'accounting.payments' are the two scopes carved out of that old
// catch-all that KCP actually still needs: wastage-sync.ts posts a Manual Journal for the day's
// wastage, and grv-sync.ts's applyCodPayment posts a Payment against a COD supplier's Bill. Both
// failed with Xero's "AuthorizationUnsuccessful" before these were added. Do NOT reach for the old
// 'accounting.transactions' name if something like this recurs — Xero's OAuth consent screen now
// rejects it outright with "invalid_scope" for an app on the new scope model, which breaks every
// reconnect, not just the one feature that was missing a scope.
const DEFAULT_XERO_SCOPES = [
  'openid',
  'profile',
  'email',
  'accounting.invoices',
  'accounting.manualjournals',
  'accounting.payments',
  'accounting.contacts',
  'accounting.attachments',
  'accounting.settings',
  'offline_access'
];

// Overridable so a scope rejected by Xero (an "invalid_scope" error — usually because the app's
// configuration in the Xero Developer Portal hasn't had that scope's API/product added yet) can be
// narrowed down or adjusted via a Worker var, without a code change + redeploy for every attempt.
// Accepts space- or comma-separated scopes.
export function xeroScopes(env: Env): string[] {
  const override = text(env.XERO_OAUTH_SCOPES);
  if (!override) return DEFAULT_XERO_SCOPES;
  return override.split(/[\s,]+/).filter(Boolean);
}
