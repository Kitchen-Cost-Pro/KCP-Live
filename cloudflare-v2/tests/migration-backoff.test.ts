import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeMigrationBackoffMs,
  evaluateMigrationHealth,
  isResourceExhaustionReason,
  shouldClearMigrationHealth,
  hasExhaustedMigrationAttempts,
  MIGRATION_FAILURE_CEILING,
  type MigrationHealthState,
} from '../src/modules/migration-backoff';

test('evaluateMigrationHealth: clean state (no health row at all) proceeds', () => {
  const decision = evaluateMigrationHealth(undefined, Date.now());
  assert.deepEqual(decision, { action: 'proceed' });
});

test('evaluateMigrationHealth: clean state (row exists, nothing set) proceeds', () => {
  const decision = evaluateMigrationHealth(
    { consecutive_failures: 0, next_retry_at: null, in_progress_since: null },
    Date.now(),
  );
  assert.deepEqual(decision, { action: 'proceed' });
});

test('evaluateMigrationHealth: an active backoff window skips without attempting anything', () => {
  const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
  const decision = evaluateMigrationHealth(
    { consecutive_failures: 1, next_retry_at: nextRetryAt, in_progress_since: null },
    Date.now(),
  );
  assert.deepEqual(decision, { action: 'skip_backoff_active', nextRetryAt });
});

test('evaluateMigrationHealth: an EXPIRED backoff window proceeds (does not skip forever)', () => {
  const nextRetryAt = new Date(Date.now() - 1_000).toISOString();
  const decision = evaluateMigrationHealth(
    { consecutive_failures: 1, next_retry_at: nextRetryAt, in_progress_since: null },
    Date.now(),
  );
  assert.deepEqual(decision, { action: 'proceed' });
});

test('evaluateMigrationHealth: this is the actual crash-loop fix — a stale in_progress_since with no active backoff is treated as an interrupted attempt, not proceeded with', () => {
  // This is exactly the state a Durable Object would be in immediately after a CPU-limit kill: the
  // in-progress marker was written right before the expensive work started, and the kill happened
  // before the code ever reached the point where it would clear it OR record a normal failure.
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  const decision = evaluateMigrationHealth(
    { consecutive_failures: 0, next_retry_at: null, in_progress_since: startedAt },
    Date.now(),
  );
  assert.deepEqual(decision, { action: 'skip_interrupted_attempt', startedAt });
});

test('evaluateMigrationHealth: an active backoff window takes priority over an in-progress marker', () => {
  // Once the interrupted attempt above has been recorded as a failure, both next_retry_at and
  // in_progress_since could theoretically be non-null only transiently — recordFailure() always
  // clears in_progress_since when it writes the backoff. But if that clearing write itself somehow
  // didn't happen, backoff must still win: there is never a reason to re-evaluate "was this
  // interrupted" while we're already deliberately waiting.
  const decision = evaluateMigrationHealth(
    {
      consecutive_failures: 1,
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
      in_progress_since: new Date(Date.now() - 5_000).toISOString(),
    },
    Date.now(),
  );
  assert.equal(decision.action, 'skip_backoff_active');
});

test('computeMigrationBackoffMs: ordinary transient errors back off in seconds, capped at 5 minutes', () => {
  assert.equal(computeMigrationBackoffMs(1, false), 15_000);
  assert.equal(computeMigrationBackoffMs(2, false), 30_000);
  assert.equal(computeMigrationBackoffMs(3, false), 45_000);
  assert.equal(computeMigrationBackoffMs(100, false), 5 * 60_000);
});

test('computeMigrationBackoffMs: resource-exhaustion errors (including interrupted attempts) back off in minutes, capped at 1 hour', () => {
  assert.equal(computeMigrationBackoffMs(1, true), 5 * 60_000);
  assert.equal(computeMigrationBackoffMs(2, true), 10 * 60_000);
  assert.equal(computeMigrationBackoffMs(3, true), 15 * 60_000);
  assert.equal(computeMigrationBackoffMs(100, true), 60 * 60_000);
});

test('isResourceExhaustionReason: recognizes the known quota/rate-limit phrasings', () => {
  assert.equal(isResourceExhaustionReason('Exceeded allowed rows read in Durable Objects free tier.'), true);
  assert.equal(isResourceExhaustionReason('storage quota exceeded'), true);
  assert.equal(isResourceExhaustionReason('rate limit exceeded, try again later'), true);
  assert.equal(isResourceExhaustionReason('table yoco_orders has no column named vat_rate'), false);
  assert.equal(isResourceExhaustionReason('near "COLUM": syntax error'), false);
});

test('the migration health row is only rewritten when it actually needs to change', () => {
  const clean: MigrationHealthState = {
    consecutive_failures: 0,
    next_retry_at: null,
    in_progress_since: null,
  };

  // The steady state for a fully-migrated tenant. migrate() runs on EVERY request, so writing here
  // would cost one row per request forever — the whole point of making the clear conditional.
  assert.equal(shouldClearMigrationHealth(clean, false), false);
  assert.equal(shouldClearMigrationHealth(undefined, false), false);

  // An attempt actually ran this pass: the in-progress marker MUST be cleared, or the next request
  // reads it as an interrupted attempt and forces a long backoff on a healthy tenant.
  assert.equal(shouldClearMigrationHealth(clean, true), true);

  // Genuinely dirty rows still get cleared.
  assert.equal(shouldClearMigrationHealth({ ...clean, consecutive_failures: 3 }, false), true);
  assert.equal(shouldClearMigrationHealth({ ...clean, next_retry_at: '2026-08-27T10:00:00Z' }, false), true);
  assert.equal(shouldClearMigrationHealth({ ...clean, in_progress_since: '2026-08-27T10:00:00Z' }, false), true);
});

test('automatic retrying stops for good once the failure ceiling is reached', () => {
  const at = (consecutive_failures: number): MigrationHealthState => ({
    consecutive_failures,
    next_retry_at: null,
    in_progress_since: null,
  });

  // Below the ceiling a tenant keeps trying — a transient cause (a quota window, a deploy race)
  // must still be able to resolve itself without anyone being paged.
  assert.equal(hasExhaustedMigrationAttempts(at(0)), false);
  assert.equal(hasExhaustedMigrationAttempts(at(4)), false);
  assert.equal(hasExhaustedMigrationAttempts(undefined), false);

  // At and beyond it, retrying stops. Backoff alone would only slow a doomed migration to one
  // attempt an hour — still ~24 attempts a day, forever, silently.
  assert.equal(hasExhaustedMigrationAttempts(at(MIGRATION_FAILURE_CEILING)), true);
  assert.equal(hasExhaustedMigrationAttempts(at(MIGRATION_FAILURE_CEILING + 10)), true);

  // The ceiling is read from the PERSISTED row, which is what makes it survive the failure mode
  // that caused the outage: a CPU-limit kill destroys the isolate and every in-memory guard on it.
  assert.equal(hasExhaustedMigrationAttempts(at(2), 2), true);
});
