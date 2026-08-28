import type { DbLike } from './types';

/**
 * Generic sliding-window rate limiter, backed by the existing `auth_rate_limits` D1 table
 * (migrations/0001_central.sql) — key/attempts/window_start was already generic enough to reuse
 * for every area that needs "N attempts per M seconds," not just auth. Originally private to
 * auth-routes.ts (login/register/password-reset); extracted so admin actions, webhook ingestion,
 * AI calls, and the global HTTP backstop can all share one mechanism instead of five bespoke ones.
 *
 * Pass `env.CENTRAL_DB` from anywhere reachable — including from inside a WorkspaceDO, whose
 * legacyEnv() already carries CENTRAL_DB alongside its own tenant DB (workspace-do.ts).
 *
 * Fails OPEN on any DB error (never let a rate-limiter outage become a feature outage) — this
 * matches the original auth behavior deliberately, not an oversight.
 */
export async function checkRateLimit(
  db: DbLike,
  key: string,
  maxAttempts: number,
  windowSeconds: number,
): Promise<{ blocked: boolean; attempts: number }> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowSeconds;
    await db.prepare(
      `DELETE FROM auth_rate_limits WHERE key = ?1 AND window_start < ?2`
    ).bind(key, windowStart).run();
    const row = await db.prepare(
      `SELECT attempts FROM auth_rate_limits WHERE key = ?1 LIMIT 1`
    ).bind(key).first<{ attempts: number }>();
    if (row && row.attempts >= maxAttempts) return { blocked: true, attempts: row.attempts };
    if (row) {
      await db.prepare(
        `UPDATE auth_rate_limits SET attempts = attempts + 1 WHERE key = ?1`
      ).bind(key).run();
      return { blocked: false, attempts: row.attempts + 1 };
    }
    await db.prepare(
      `INSERT INTO auth_rate_limits (key, attempts, window_start) VALUES (?1, 1, ?2)`
    ).bind(key, now).run();
    return { blocked: false, attempts: 1 };
  } catch {
    return { blocked: false, attempts: 0 };
  }
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}
