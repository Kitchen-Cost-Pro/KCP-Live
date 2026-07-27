/**
 * Minimal DB surface the handlers actually use (`prepare().bind().first/all/run/raw` + `batch`).
 * Both a D1Database and the DO's FacadeDatabase satisfy this, so the SAME handler code runs in the
 * front Worker (env.DB = CENTRAL_DB, a real D1) and inside a WorkspaceDO (env.DB = facade over the
 * tenant's own SQLite). See cloudflare-v2/PORTING.md.
 */
export interface DbResultMeta {
  changes?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
  duration?: number;
  [key: string]: unknown;
}
export interface DbResult<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: DbResultMeta;
}
export interface DbStatementLike {
  bind(...values: unknown[]): DbStatementLike;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  run<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}
export interface DbLike {
  prepare(query: string): DbStatementLike;
  batch<T = Record<string, unknown>>(statements: DbStatementLike[]): Promise<Array<DbResult<T>>>;
}

export interface Env {
  // In the DO this is the tenant's SQLite facade; in the front Worker's central handlers it's CENTRAL_DB.
  DB: DbLike;
  // Central plane (identity/registry/members/admin). Available to handlers that read central data
  // (e.g. getUserAllowedLocationIds, getWorkspaceActorRole) even when running inside a tenant DO.
  CENTRAL_DB: DbLike;
  ENVIRONMENT?: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_API_TOKEN?: string;
  ADMIN_BOOTSTRAP_EMAILS?: string;
  YOCO_WEBHOOK_SECRET?: string;
  YOCO_API_BASE_URL?: string;
  YOCO_WEBHOOK_BASE_URL?: string;
  YOCO_KEY_ENCRYPTION_SECRET?: string;
  APP_BASE_URL?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  ADMIN_TURNSTILE_SECRET_KEY?: string;
  ADMIN_TURNSTILE_SITE_KEY?: string;
  ADMIN_TURNSTILE_MODE?: string;
  APP_TURNSTILE_MODE?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_OAUTH_REDIRECT_URI?: string;
  GMAIL_OAUTH_STATE_SECRET?: string;
  GMAIL_TOKEN_ENCRYPTION_SECRET?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  FIREBASE_PROJECT_ID?: string;
  GROQ_API_KEY?: string;
}

export interface AuthContext {
  uid: string;
  email: string;
  token: Record<string, unknown>;
}
