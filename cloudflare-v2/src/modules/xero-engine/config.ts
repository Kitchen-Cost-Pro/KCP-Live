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

// Xero deprecated the old blanket 'accounting.transactions' scope in favor of granular per-endpoint
// scopes. KCP creates Invoices/Bills (see invoice-sync.ts, grv-sync.ts) — now covered by its own
// 'accounting.invoices' scope — and Items (see item-sync.ts, which lives under the 'settings' scope
// group in Xero's API, alongside accounts/tax rates/currencies). 'accounting.attachments' is Xero's
// separate granular scope for attaching files (the GRV PDF/invoice photo) to a Bill — it doesn't
// ride along with 'accounting.invoices' the way reading/writing the invoice body does.
//
// 'accounting.transactions' IS still required, though — it's the scope Xero kept for everything
// that wasn't carved out into its own scope, which still includes Manual Journals (wastage-sync.ts's
// daily wastage journal) and Payments (grv-sync.ts's applyCodPayment for a COD supplier's Bill).
// Omitting it doesn't reject the OAuth connect itself; it silently authorizes fine and every
// Invoices/Bills call keeps working, so this only surfaces later as a confusing, unrelated-looking
// "AuthorizationUnsuccessful" from Xero the first time a wastage push or COD payment actually runs.
// A workspace that connected before this scope was added must disconnect and reconnect Xero —
// re-consenting is the only way to add a scope to an existing token; it can't be granted silently.
const DEFAULT_XERO_SCOPES = [
  'openid',
  'profile',
  'email',
  'accounting.invoices',
  'accounting.transactions',
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
