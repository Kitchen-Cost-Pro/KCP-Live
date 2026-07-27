import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

// Regression for "LIKE or GLOB pattern too complex: SQLITE_ERROR" during order.completed
// processing. live-sale.ts matches a modifier action snapshot by whether the modifier id (?4)
// ends with ":<source_key>". The old query concatenated the untrusted `source_key` column into
// a LIKE pattern (`?4 LIKE '%:' || source_key`); when a NOTE rule's source_key held raw note
// text with many `%`/`_` wildcards SQLite rejected the pattern and the whole sale failed.
//
// This mirrors the exact clause from live-sale.ts using a wildcard-free substr/length suffix
// match, and proves it (a) does not throw on wildcard-heavy keys and (b) matches correctly.

const ACTION_SNAPSHOT_LOOKUP = `
  SELECT source_key
    FROM modifier_sale_action_snapshots
   WHERE workspace_id = ?1
     AND source_order_id = ?2
     AND source_line_id = ?3
     AND source_kind = 'MODIFIER'
     AND (
       source_key = ?4
       OR (length(?4) > length(source_key) AND substr(?4, length(?4) - length(source_key)) = ':' || source_key)
       OR (NULLIF(?5, '') IS NOT NULL AND rule_id = ?5)
     )
   ORDER BY CASE
     WHEN source_key = ?4 THEN 0
     WHEN length(?4) > length(source_key) AND substr(?4, length(?4) - length(source_key)) = ':' || source_key THEN 1
     ELSE 2
   END
   LIMIT 1`;

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE modifier_sale_action_snapshots (
      workspace_id TEXT,
      source_order_id TEXT,
      source_line_id TEXT,
      source_kind TEXT,
      source_key TEXT,
      rule_id TEXT
    );`);
  return db;
}

function insert(db: DatabaseSync, sourceKey: string, ruleId = '') {
  db.prepare(
    `INSERT INTO modifier_sale_action_snapshots
      (workspace_id, source_order_id, source_line_id, source_kind, source_key, rule_id)
     VALUES ('ws', 'ord', 'line', 'MODIFIER', ?1, ?2)`,
  ).run(sourceKey, ruleId);
}

function lookup(db: DatabaseSync, modifierId: string, ruleId = '') {
  return db
    .prepare(ACTION_SNAPSHOT_LOOKUP)
    .get('ws', 'ord', 'line', modifierId, ruleId) as { source_key: string } | undefined;
}

test('does not throw and matches a wildcard-heavy source_key by suffix (the crash case)', () => {
  const db = makeDb();
  // A NOTE-derived source_key full of LIKE wildcards that used to blow up the pattern matcher.
  const nastyKey = '100%%% no onion_ %_%_%_%_%_%_%_%';
  insert(db, nastyKey);

  const row = lookup(db, `group-abc:${nastyKey}`);
  assert.equal(row?.source_key, nastyKey);
});

test('exact source_key still matches', () => {
  const db = makeDb();
  insert(db, 'mod-123');
  assert.equal(lookup(db, 'mod-123')?.source_key, 'mod-123');
});

test('suffix after a colon matches literally, not as a wildcard', () => {
  const db = makeDb();
  insert(db, 'abc');
  assert.equal(lookup(db, 'namespace:abc')?.source_key, 'abc');
});

test('a bare "%" source_key does not act as a wildcard against a non-suffix modifier id', () => {
  const db = makeDb();
  insert(db, '%'); // old LIKE would treat this as "match anything ending in ':<anything>'"
  // modifier id ends with ":x", not ":%", so it must NOT match.
  assert.equal(lookup(db, 'group:x'), undefined);
  // but a real suffix of ":%" must still match literally.
  assert.equal(lookup(db, 'group:%')?.source_key, '%');
});

test('non-suffix keys are excluded', () => {
  const db = makeDb();
  insert(db, 'abc');
  assert.equal(lookup(db, 'xyzabc'), undefined); // no colon boundary -> not a match
  assert.equal(lookup(db, 'abc-tail'), undefined);
});

test('rule_id fallback still matches when set', () => {
  const db = makeDb();
  insert(db, 'unrelated-key', 'rule-9');
  assert.equal(lookup(db, 'no-match', 'rule-9')?.source_key, 'unrelated-key');
});
