import type { FacadeDatabase } from './d1-facade';

/**
 * Front-Worker environment. `CENTRAL_DB` is the shared identity/registry/coordination D1;
 * `WORKSPACE` is the per-tenant Durable Object namespace.
 */
export interface Env {
  CENTRAL_DB: D1Database;
  WORKSPACE: DurableObjectNamespace;
  YOCO_V2_RATE_GATE: DurableObjectNamespace;
  YOCO_V2_WRITE_BUDGET?: DurableObjectNamespace;

  ENVIRONMENT?: string;
  // Emergency kill switch: when "true", WorkspaceDO.migrate() skips entirely (no reads, no
  // writes) instead of attempting pending tenant migrations. Safe by design — a workspace with
  // pending migrations already just keeps serving on its existing schema (see workspace-do.ts's
  // own comment) — added 2026-08-27 after a tenant's backlog of pending migrations, run in one
  // shot against months of accumulated Yoco order history, exhausted the account's entire daily
  // Durable Objects free-tier row-read quota within a couple of hours.
  WORKSPACE_MIGRATIONS_DISABLED?: string;
  ALLOWED_ORIGINS?: string;
  APP_BASE_URL?: string;
  YOCO_API_BASE_URL?: string;
  YOCO_V2_WRITE_BUDGET_DAILY_CAP?: string;
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

  YOCO_V2_EVENTS?: Queue<import('./modules/yoco-engine-v2/contracts').YocoV2QueueMessage>;
  YOCO_V2_EVENTS_DLQ?: Queue<import('./modules/yoco-engine-v2/contracts').YocoV2QueueMessage>;

  YOCO_V2_CAPTURE_ENABLED?: string;
  YOCO_V2_QUEUE_ENABLED?: string;
  YOCO_V2_ADMIN_ENABLED?: string;
  YOCO_V2_LIVE_SALE_REPORTING?: string;
  YOCO_V2_LIVE_SALE_STOCK?: string;
  YOCO_V2_LIVE_REFUND_REPORTING?: string;
  YOCO_V2_LIVE_REFUND_STOCK?: string;
  YOCO_V2_MAX_ATTEMPTS?: string;
  YOCO_V2_BASE_RETRY_MS?: string;
  YOCO_V2_MAX_RETRY_MS?: string;
  YOCO_V2_API_TIMEOUT_MS?: string;
  YOCO_V2_REQUEST_SPACING_MS?: string;
  YOCO_V2_ORDER_CACHE_TTL_MS?: string;
  YOCO_V2_REFUND_CACHE_TTL_MS?: string;
  YOCO_V2_METADATA_CACHE_TTL_MS?: string;
  YOCO_V2_AUTH_FAILURE_THRESHOLD?: string;
  YOCO_V2_RATE_LIMIT_PAUSE_FALLBACK_MS?: string;
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
  name?: string;
  systemRole?: 'admin' | 'queue';
  adminRole?: string;
  permissions?: string[];
}
