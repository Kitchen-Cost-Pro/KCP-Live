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

// Naming (GDRIVE_* rather than GOOGLE_DRIVE_*) and the /api/gdrive/oauth/callback path below match
// pre-existing reservations already sitting in wrangler.toml/wrangler.dev.toml and src/types.ts's
// front-Worker Env (GDRIVE_OAUTH_REDIRECT_URI etc.) from before this integration was built —
// reused as-is rather than introducing a second, conflicting naming scheme.
export function driveTokenSecret(env: Env): string {
  return text(env.GDRIVE_TOKEN_ENCRYPTION_SECRET || env.YOCO_KEY_ENCRYPTION_SECRET);
}

export function driveStateSecret(env: Env): string {
  return text(env.GDRIVE_OAUTH_STATE_SECRET || env.GDRIVE_TOKEN_ENCRYPTION_SECRET || env.YOCO_KEY_ENCRYPTION_SECRET || env.GDRIVE_CLIENT_SECRET);
}

export function driveConfigured(env: Env): boolean {
  return Boolean(text(env.GDRIVE_CLIENT_ID) && text(env.GDRIVE_CLIENT_SECRET) && driveTokenSecret(env) && driveStateSecret(env));
}

export function driveRedirectUri(request: Request, env: Env): string {
  return text(env.GDRIVE_OAUTH_REDIRECT_URI) || `${new URL(request.url).origin}/api/gdrive/oauth/callback`;
}

// drive.file is Google's non-sensitive, per-file scope — the app only ever sees files/folders it
// creates itself, never the rest of the user's Drive. This keeps the OAuth consent screen out of
// Google's stricter "restricted scope" verification tier that the broad 'drive' scope requires.
const DEFAULT_DRIVE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];

export function driveScopes(env: Env): string[] {
  const override = text(env.GDRIVE_OAUTH_SCOPES);
  if (!override) return DEFAULT_DRIVE_SCOPES;
  return override.split(/[\s,]+/).filter(Boolean);
}
