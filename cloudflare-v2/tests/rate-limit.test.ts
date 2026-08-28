import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { checkRateLimit, clientIp } from '../src/legacy/rate-limit';
import type { DbLike, DbStatementLike, DbResult } from '../src/legacy/types';

// Adapts a real node:sqlite DatabaseSync to DbLike, mirroring the real auth_rate_limits table
// (migrations/0001_central.sql) — same pattern used elsewhere in this test suite for exercising
// production SQL against a real, if in-memory, SQLite engine rather than a hand-rolled mock.
function dbLikeFor(database: DatabaseSync): DbLike {
  function makeStatement(query: string, bound: unknown[] = []): DbStatementLike {
    const statement: DbStatementLike = {
      bind(...values: unknown[]) {
        return makeStatement(query, values);
      },
      async first<T>() {
        return (database.prepare(query).get(...(bound as never[])) ?? null) as T | null;
      },
      async all<T>() {
        const results = database.prepare(query).all(...(bound as never[])) as T[];
        return { results, success: true, meta: {} } as DbResult<T>;
      },
      async run<T>() {
        database.prepare(query).run(...(bound as never[]));
        return { results: [] as T[], success: true, meta: {} } as DbResult<T>;
      },
      async raw<T>() {
        return (database.prepare(query).all(...(bound as never[])) as Record<string, unknown>[]).map((row) => Object.values(row)) as T[];
      },
    };
    return statement;
  }
  return {
    prepare: (query: string) => makeStatement(query),
    batch: async () => [],
  };
}

function freshRateLimitDb(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(
    `CREATE TABLE IF NOT EXISTS auth_rate_limits (
       key TEXT PRIMARY KEY,
       attempts INTEGER NOT NULL DEFAULT 1,
       window_start INTEGER NOT NULL
     )`
  );
  return database;
}

test('checkRateLimit: allows attempts under the limit and blocks at the limit', async () => {
  const db = dbLikeFor(freshRateLimitDb());
  for (let i = 1; i <= 5; i += 1) {
    const result = await checkRateLimit(db, 'test-key', 5, 60);
    assert.equal(result.blocked, false, `attempt ${i} should not be blocked`);
    assert.equal(result.attempts, i);
  }
  const sixth = await checkRateLimit(db, 'test-key', 5, 60);
  assert.equal(sixth.blocked, true);
});

test('checkRateLimit: different keys have independent counters', async () => {
  const db = dbLikeFor(freshRateLimitDb());
  for (let i = 0; i < 5; i += 1) await checkRateLimit(db, 'key-a', 5, 60);
  const blockedA = await checkRateLimit(db, 'key-a', 5, 60);
  assert.equal(blockedA.blocked, true);

  const freshB = await checkRateLimit(db, 'key-b', 5, 60);
  assert.equal(freshB.blocked, false, 'a different key must not be affected by key-a\'s limit');
});

test('checkRateLimit: an expired window resets the counter (sliding window, not a permanent lockout)', async () => {
  const database = freshRateLimitDb();
  const db = dbLikeFor(database);
  for (let i = 0; i < 5; i += 1) await checkRateLimit(db, 'expiring-key', 5, 60);
  const blocked = await checkRateLimit(db, 'expiring-key', 5, 60);
  assert.equal(blocked.blocked, true);

  // Simulate the window having expired by backdating window_start well past the 60s window.
  database.prepare(`UPDATE auth_rate_limits SET window_start = window_start - 3600 WHERE key = 'expiring-key'`).run();

  const afterExpiry = await checkRateLimit(db, 'expiring-key', 5, 60);
  assert.equal(afterExpiry.blocked, false);
  assert.equal(afterExpiry.attempts, 1);
});

test('checkRateLimit: fails open when the underlying table does not exist (never let a rate-limiter outage become a feature outage)', async () => {
  const db = dbLikeFor(new DatabaseSync(':memory:')); // no auth_rate_limits table at all
  const result = await checkRateLimit(db, 'any-key', 1, 60);
  assert.equal(result.blocked, false);
});

test('clientIp: prefers cf-connecting-ip, falls back to x-forwarded-for, then "unknown"', () => {
  assert.equal(
    clientIp(new Request('https://example.com', { headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' } })),
    '1.2.3.4',
  );
  assert.equal(
    clientIp(new Request('https://example.com', { headers: { 'x-forwarded-for': '5.6.7.8' } })),
    '5.6.7.8',
  );
  assert.equal(clientIp(new Request('https://example.com')), 'unknown');
});
