/**
 * Pure decision logic for WorkspaceDO's migration circuit-breaker (workspace-do.ts). Extracted so
 * it can be unit-tested directly — workspace-do.ts itself imports from 'cloudflare:workers' and
 * can't be loaded in a plain Node test, and its `migrate()` method is tightly coupled to the real
 * Durable Object SQL storage cursor API, which is impractical to mock faithfully.
 */

export interface MigrationHealthState {
  consecutive_failures: number;
  next_retry_at: string | null;
  in_progress_since: string | null;
}

export type MigrationHealthDecision =
  | { action: 'skip_backoff_active'; nextRetryAt: string }
  | { action: 'skip_interrupted_attempt'; startedAt: string }
  | { action: 'proceed' };

/**
 * Decides what migrate() should do given the current persisted health row.
 *
 * `in_progress_since` is written as its own standalone, immediately-committed statement right
 * before each expensive migration/repair block starts, and cleared right after it finishes. A
 * Durable Object's hard per-request CPU-time-limit kill is not a catchable JS exception — the
 * platform tears down the isolate mid-flight — so the only way `in_progress_since` can still be
 * set on a LATER invocation is that the previous attempt started and was killed before it could
 * clear it. Treating that as a failure (skip_interrupted_attempt) rather than re-attempting is
 * what makes the 2026-08-26 crash-loop incident (a killed migration retried immediately on every
 * new request, forever) structurally impossible: at most one attempt can ever run per backoff
 * window, even when the platform kills it before our own catch block gets a chance to run.
 */
export function evaluateMigrationHealth(
  health: MigrationHealthState | undefined,
  nowMs: number,
): MigrationHealthDecision {
  const nextRetryAtMs = health?.next_retry_at ? Date.parse(health.next_retry_at) : 0;
  if (nextRetryAtMs && nowMs < nextRetryAtMs) {
    return { action: 'skip_backoff_active', nextRetryAt: health!.next_retry_at as string };
  }
  if (health?.in_progress_since) {
    return { action: 'skip_interrupted_attempt', startedAt: health.in_progress_since };
  }
  return { action: 'proceed' };
}

/**
 * Backoff duration after `failuresAfterThisOne` consecutive failures (including the one just
 * recorded). Resource-exhaustion failures (a quota/rate-limit rejection, OR an interrupted
 * mid-flight attempt inferred via evaluateMigrationHealth above) back off far longer — 5, 10,
 * 15... minutes, capped at 1 hour — than an ordinary transient error — 15, 30, 45... seconds,
 * capped at 5 minutes — because "wait for the quota to reset" and "try again in a few seconds"
 * are very different remedies, and treating the former like the latter is exactly what turned one
 * failing migration into a runaway retry storm in production.
 */
export function computeMigrationBackoffMs(failuresAfterThisOne: number, isResourceExhaustion: boolean): number {
  return isResourceExhaustion
    ? Math.min(60 * 60 * 1000, 5 * 60 * 1000 * failuresAfterThisOne)
    : Math.min(5 * 60 * 1000, 15 * 1000 * failuresAfterThisOne);
}

export function isResourceExhaustionReason(reason: string): boolean {
  return /exceeded allowed|quota|free tier|rate limit/i.test(reason);
}

/**
 * After this many consecutive failures, stop attempting the migration entirely until a human
 * explicitly clears it via the admin migration-retry endpoint.
 *
 * Backoff alone only makes a doomed migration retry SLOWLY — capped at one attempt per hour, it
 * still burns that migration's read cost ~24 times a day, forever, and never surfaces that it is
 * stuck. Worse, the in-memory brake cannot help against the failure mode that actually caused the
 * 2026-08-27 outage: a Durable Object CPU-limit kill destroys the isolate, taking the in-memory
 * state with it, so every fresh isolate starts with a clean slate and tries again.
 *
 * A persisted ceiling converts "grinds on quietly forever" into "stops, and waits for a human".
 * Five attempts is enough to ride out a transient cause (a quota window, a deploy race) and few
 * enough that a genuinely broken migration cannot keep spending the day's budget.
 */
export const MIGRATION_FAILURE_CEILING = 5;

/**
 * Whether this tenant has failed its migration so many times that automatic retrying should stop.
 *
 * Checked BEFORE the backoff window, so an exhausted tenant costs nothing at all on each request.
 * Cleared by postAdminWorkspaceMigrationRetry, which zeroes consecutive_failures — so an operator
 * who has actually fixed the cause can resume it deliberately.
 */
export function hasExhaustedMigrationAttempts(
  health: MigrationHealthState | undefined,
  ceiling: number = MIGRATION_FAILURE_CEILING,
): boolean {
  return Number(health?.consecutive_failures || 0) >= ceiling;
}

/**
 * Whether migrate()'s closing "clear the backoff state" UPDATE actually needs to run.
 *
 * migrate() executes on EVERY request (see WorkspaceDO.ensureMigrated), so an unconditional UPDATE
 * here costs one row written per request forever — on a tenant with nothing left to migrate, that
 * is a write purely to set a row to the values it already holds. At roughly 20 requests per page
 * load it burns ~2% of the entire 100,000/day Durable Objects write allowance per 100 page loads.
 *
 * It is needed in exactly two cases: this pass marked an attempt in progress (so the marker must be
 * cleared), or the persisted row is genuinely dirty from an earlier failure.
 */
export function shouldClearMigrationHealth(
  health: MigrationHealthState | undefined,
  markedInProgress: boolean,
): boolean {
  if (markedInProgress) return true;
  return (
    Number(health?.consecutive_failures || 0) !== 0 ||
    health?.next_retry_at != null ||
    health?.in_progress_since != null
  );
}
