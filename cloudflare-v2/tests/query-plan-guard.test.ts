import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { splitSqlStatements, isRetryableAddColumnError } from '../src/d1-facade';
import { TENANT_MIGRATIONS } from '../src/tenant-migrations';

/**
 * Structural guard against the 2026-08-27 outage class.
 *
 * Every workspace gets its OWN Durable Object with its OWN SQLite database, so
 * `WHERE workspace_id = ?1` selects ~100% of every table. An index whose only usable term is
 * workspace_id therefore reduces nothing — it is a full table scan wearing an index's clothes.
 * That makes the usual review heuristic ("it filters on an indexed column, looks fine") actively
 * misleading here, and it is how several queries came to read the entire stock_movements ledger on
 * every dashboard load until the account's daily row-read quota was exhausted and EVERY route in
 * EVERY workspace started failing.
 *
 * These tests assert on the real SQLite query planner, against a database built from the real
 * migration chain, so a regression fails the build instead of an outage.
 */

const WS = 'WS-guard';

// Tables that grow without bound with trading activity. A full scan of one of these is a latent
// outage: fine at 500 rows in development, quota-exhausting at 200,000 in production. Tables NOT
// listed here (products, stock_items, locations, recipes...) are catalogue-sized — bounded by how
// much a business maintains by hand — so scanning them is wasteful but not dangerous.
const UNBOUNDED_GROWTH_TABLES = [
  'stock_movements',
  'yoco_orders',
  'yoco_order_lines',
  'audit_events',
  'integration_logs',
];

function applyMigration(database: DatabaseSync, script: string): void {
  for (const raw of splitSqlStatements(script)) {
    const statement = raw.trim();
    if (!statement) continue;
    try {
      database.exec(statement);
    } catch (cause) {
      if (isRetryableAddColumnError(statement, cause)) continue;
      throw cause;
    }
  }
}

/** A tenant database with enough rows that the planner makes production-shaped choices. */
function seededTenantDb(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const migration of TENANT_MIGRATIONS) applyMigration(database, migration);

  database.exec('BEGIN');
  database.exec(
    `INSERT INTO locations (id, workspace_id, name, kind, active, is_default)
     VALUES ('loc1', '${WS}', 'Main', 'storage', 1, 1)`,
  );
  const stockItem = database.prepare(
    `INSERT INTO stock_items (id, workspace_id, name, name_key, unit_cost, threshold_qty, active)
     VALUES (?, ?, ?, ?, 10, 5, 1)`,
  );
  const product = database.prepare(
    `INSERT INTO products (id, workspace_id, name, category, price, active) VALUES (?, ?, ?, ?, 50, 1)`,
  );
  for (let i = 0; i < 2000; i += 1) {
    stockItem.run(`si_${i}`, WS, `Item ${i}`, `item ${i}`);
    product.run(`p_${i}`, WS, `Product ${i}`, `Cat ${i % 20}`);
  }
  const movement = database.prepare(
    `INSERT INTO stock_movements
       (id, workspace_id, stock_item_id, location_id, movement_type, quantity_delta, unit_cost,
        value_delta, occurred_at, created_at)
     VALUES (?, ?, ?, 'loc1', 'sale', -1, 10, -10, ?, ?)`,
  );
  for (let i = 0; i < 20000; i += 1) {
    const stamp = new Date(Date.UTC(2026, 7, 27) - i * 60000).toISOString();
    movement.run(`sm_${i}`, WS, `si_${i % 2000}`, stamp, stamp);
  }
  const order = database.prepare(
    `INSERT INTO yoco_orders (id, workspace_id, yoco_order_id, location_id, order_type, total, occurred_at)
     VALUES (?, ?, ?, 'loc1', 'sale', 100, ?)`,
  );
  const line = database.prepare(
    `INSERT INTO yoco_order_lines (id, workspace_id, yoco_order_id, product_id, name, quantity, total)
     VALUES (?, ?, ?, ?, 'line', 1, 50)`,
  );
  for (let i = 0; i < 4000; i += 1) {
    order.run(`yo_${i}`, WS, `yid_${i}`, new Date(Date.UTC(2026, 7, 27) - i * 60000).toISOString());
    line.run(`yl_${i}`, WS, `yo_${i}`, `p_${i % 2000}`);
  }
  database.exec('COMMIT');
  database.exec('ANALYZE');
  return database;
}

function queryPlan(database: DatabaseSync, sql: string, binds: unknown[]): string[] {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: unknown }>)
    .map((row) => String(row.detail));
}

/**
 * Flags any access to a guarded table that reads an unbounded number of rows.
 *
 * Catching `SCAN` alone is NOT enough, and assuming otherwise is the whole trap this file exists
 * for. SQLite reports a query that walks an index end-to-end as `SEARCH`, e.g.
 *   SEARCH sm USING COVERING INDEX idx_stock_movements_workspace_date (workspace_id=?)
 * That reads EVERY row — because one Durable Object holds exactly one workspace, `workspace_id=?`
 * matches all of them — yet it reads as "indexed" to a human and to a naive `SCAN` check. The
 * date()-wrapped filter that helped cause the outage plans exactly like that.
 *
 * So the real rule is: an access to a guarded table must be constrained by something MORE than
 * workspace_id. A bare `SCAN`, or a `SEARCH` whose only constraint terms are workspace_id, is a
 * full read either way.
 *
 * The ONE legitimate exception is a query that takes the newest N rows: there the index supplies
 * the ordering, so `LIMIT` stops the walk after N entries even though workspace_id is the only
 * constraint. That is only true while the index actually provides the order — if the planner has
 * to sort first (`USE TEMP B-TREE FOR ORDER BY`) it must materialise every row before LIMIT can
 * apply, and the read is unbounded again. That is precisely the difference between the dashboard's
 * repaired recentActivity branch and its original form, so callers claiming the exception via
 * `orderedLimit` still fail if a temp sort appears.
 */
function unboundedAccesses(
  plan: string[],
  guardedAliases: string[],
  options: { orderedLimit?: boolean } = {},
): string[] {
  const sortsInMemory = plan.some((line) => /USE TEMP B-TREE FOR ORDER BY/i.test(line));
  const boundedByOrderedLimit = Boolean(options.orderedLimit) && !sortsInMemory;
  const offenders: string[] = [];

  for (const line of plan) {
    const detail = line.trim();

    const scan = /^SCAN\s+(?:TABLE\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(detail);
    if (scan && guardedAliases.includes(scan[1])) {
      offenders.push(detail);
      continue;
    }

    const search = /^SEARCH\s+(?:TABLE\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/.exec(detail);
    if (!search || !guardedAliases.includes(search[1])) continue;

    const constraints = /\(([^)]*)\)\s*$/.exec(detail);
    const terms = (constraints?.[1] ?? '')
      .split(/\s+AND\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    const selectiveTerms = terms.filter((term) => !/^workspace_id\s*[=<>]/.test(term));
    if (!selectiveTerms.length && !boundedByOrderedLimit) offenders.push(detail);
  }
  return offenders;
}

const database = seededTenantDb();

// --- Indexes the hot paths depend on. Asserted by name so that dropping, renaming or reordering
// --- one fails here rather than silently degrading a query plan in production.
test('the migration chain creates every index the hot read paths depend on', () => {
  const present = new Set(
    (database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const indexName of [
    'idx_stock_movements_workspace_date',
    'idx_products_workspace_active_name_key',
    'idx_products_workspace_active_sort',
    'idx_stock_items_workspace_active_name',
    'idx_stock_items_workspace_active_name_key',
    'idx_yoco_order_lines_workspace_product',
    'idx_stock_movements_workspace_movement_type',
  ]) {
    assert.ok(present.has(indexName), `missing index ${indexName}`);
  }
});

/**
 * Each case is the shape of a query that runs on a normal page load or on every imported row.
 * `sql` mirrors production; if production changes shape, update it here and keep the guard honest.
 */
const HOT_QUERIES: Array<{
  name: string;
  sql: string;
  binds: unknown[];
  guarded: string[];
  // Set only for "newest N rows" queries, where the index supplies the ordering so LIMIT stops the
  // walk early. Still fails if the planner has to sort first — see unboundedAccesses().
  orderedLimit?: boolean;
}> = [
  {
    guarded: ['sm'],
    orderedLimit: true,
    name: 'dashboard recentActivity — movements branch bounded per-branch',
    sql: `SELECT * FROM (
            SELECT sm.id, sm.occurred_at AS timestamp
              FROM stock_movements sm
              LEFT JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
             WHERE sm.workspace_id = ?1
             ORDER BY sm.occurred_at DESC
             LIMIT 8
          ) ORDER BY timestamp DESC LIMIT 8`,
    binds: [WS],
  },
  {
    guarded: ['sm'],
    name: 'dashboard movement aggregate — bare occurred_at range',
    sql: `SELECT COUNT(*) AS c FROM stock_movements sm
           WHERE sm.workspace_id = ?1 AND sm.occurred_at >= ?2 AND sm.occurred_at < ?3`,
    binds: [WS, '2026-08-27', '2026-08-28'],
  },
  {
    guarded: ['sm'],
    name: 'reporting detailed-activity — exact datetime() bounds plus sargable prefilter',
    sql: `SELECT sm.id FROM stock_movements sm
           WHERE sm.workspace_id = ?1
             AND datetime(sm.occurred_at) >= datetime(?2) AND sm.occurred_at >= ?3
             AND datetime(sm.occurred_at) < datetime(?4) AND sm.occurred_at < ?5`,
    binds: [WS, '2026-08-26T22:00:00.000Z', '2026-08-26', '2026-08-27T22:00:00.000Z', '2026-08-28'],
  },
  {
    guarded: ['yoco_order_lines'],
    name: 'menu-health aggregate over order lines',
    sql: `SELECT product_id, SUM(quantity) AS qty FROM yoco_order_lines
           WHERE workspace_id = ?1 AND product_id = ?2 GROUP BY product_id`,
    binds: [WS, 'p_5'],
  },
];

for (const hotQuery of HOT_QUERIES) {
  test(`no unbounded-growth table is fully scanned: ${hotQuery.name}`, () => {
    const plan = queryPlan(database, hotQuery.sql, hotQuery.binds);
    const offenders = unboundedAccesses(plan, hotQuery.guarded, {
      orderedLimit: hotQuery.orderedLimit,
    });
    assert.deepEqual(
      offenders,
      [],
      `this query reads an unbounded-growth table without a selective constraint, so it grows with ` +
        `trading history and will exhaust the Durable Objects row-read quota in production.\n` +
        `Offending step(s):\n  ${offenders.join('\n  ')}\nFull plan:\n  ${plan.join('\n  ')}`,
    );
  });
}

// --- Guard the guard: prove these assertions can actually fail, so a future refactor that breaks
// --- plan parsing cannot silently turn every check above into a no-op that always passes.
test('the scan detector recognises a genuine full scan (negative control)', () => {
  const plan = queryPlan(
    database,
    // date() around the column is exactly the non-sargable mistake this suite exists to catch.
    `SELECT COUNT(*) FROM stock_movements sm
      WHERE sm.workspace_id = ?1 AND date(sm.occurred_at) BETWEEN date(?2) AND date(?3)`,
    [WS, '2026-08-27', '2026-08-27'],
  );
  const offenders = unboundedAccesses(plan, ['sm']);
  assert.equal(
    offenders.length,
    1,
    `expected the date()-wrapped filter to be flagged as an unbounded read, got plan:\n  ${plan.join('\n  ')}`,
  );
});

test('an ordered-LIMIT claim still fails when the planner must sort first (negative control)', () => {
  // unit_cost/quantity_delta are in no index, so SQLite must materialise and sort every movement before
  // LIMIT 8 can apply — the exact shape of the dashboard's ORIGINAL recentActivity branch.
  const plan = queryPlan(
    database,
    `SELECT sm.id FROM stock_movements sm
      WHERE sm.workspace_id = ?1
      ORDER BY sm.unit_cost DESC, sm.quantity_delta DESC
      LIMIT 8`,
    [WS],
  );
  const offenders = unboundedAccesses(plan, ['sm'], { orderedLimit: true });
  assert.equal(
    offenders.length,
    1,
    `expected a temp-sorted LIMIT to still be flagged, got plan:\n  ${plan.join('\n  ')}`,
  );
});
