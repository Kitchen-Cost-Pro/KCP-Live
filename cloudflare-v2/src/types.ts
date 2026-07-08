import type { FacadeDatabase } from './d1-facade';

/**
 * Front-Worker environment. `CENTRAL_DB` is the shared identity/registry/coordination D1;
 * `WORKSPACE` is the per-tenant Durable Object namespace.
 */
export interface Env {
  CENTRAL_DB: D1Database;
  WORKSPACE: DurableObjectNamespace;

  ENVIRONMENT?: string;
  ALLOWED_ORIGINS?: string;
  APP_BASE_URL?: string;
  ADMIN_BOOTSTRAP_EMAILS?: string;

  // Secrets (set on the new account) — mirror ../cloudflare/src/types.ts as domains are ported.
  YOCO_KEY_ENCRYPTION_SECRET?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_TOKEN_ENCRYPTION_SECRET?: string;
  GMAIL_OAUTH_STATE_SECRET?: string;
  GMAIL_OAUTH_REDIRECT_URI?: string;
  GDRIVE_CLIENT_ID?: string;
  GDRIVE_CLIENT_SECRET?: string;
  GDRIVE_TOKEN_ENCRYPTION_SECRET?: string;
  GDRIVE_OAUTH_STATE_SECRET?: string;
  GDRIVE_OAUTH_REDIRECT_URI?: string;
  TURNSTILE_SECRET_KEY?: string;
}

/**
 * The environment a tenant route handler sees INSIDE a WorkspaceDO: identical to a handler's
 * expectations today, except `DB` is the facade over this workspace's own SQLite (not shared D1).
 */
export interface TenantEnv extends Omit<Env, 'CENTRAL_DB' | 'WORKSPACE'> {
  DB: FacadeDatabase;
  workspaceId: string;
}

/** Authenticated identity resolved by the front Worker against CENTRAL_DB, forwarded to the DO. */
export interface AuthContext {
  uid: string;
  email: string;
}
