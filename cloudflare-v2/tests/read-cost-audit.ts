/**
 * READ-COST AUDIT HARNESS
 *
 * Companion to write-cost-audit.ts. Measures ROWS READ (best-effort: rows actually returned by
 * each SELECT) AND, more importantly, whether any executed query does a genuine full-table SCAN
 * rather than an indexed SEARCH — by running EXPLAIN QUERY PLAN on every SELECT the real route
 * handler issues, against a realistically-sized seeded dataset (200 stock items, 100 products,
 * a handful of locations/suppliers/GRVs, and a SMALL amount of sales history — sized to match
 * "a few workspaces, one live client with ~0 sales data", not the large historical volumes
 * write-cost-audit.ts uses to probe backlog/migration scenarios).
 *
 * Run:  node --import tsx --import ./tests/_cf-stub.mjs tests/read-cost-audit.ts
 *
 * Node's :memory: SQLite doesn't expose a real "rows examined" counter the way Cloudflare's
 * Durable Object SqlStorageCursor.rowsRead does (see d1-facade.ts), so "rows returned" alone would
 * UNDERSTATE the cost of exactly the queries we care about (a scan that filters 5000 rows down to
 * 3 still reads 5000). EXPLAIN QUERY PLAN is what actually answers "is this bounded by an index or
 * not" regardless of how few rows come back — that's the primary signal this harness reports.
 */
import { DatabaseSync } from 'node:sqlite';
import { splitSqlStatements, isRetryableAddColumnError } from '../src/d1-facade';
import { TENANT_MIGRATIONS } from '../src/tenant-migrations';
import type { AuthContext, DbLike, DbResult, DbStatementLike, Env } from '../src/legacy/types';
import * as routes from '../src/legacy/routes';
import * as reportingRoutes from '../src/legacy/reporting-routes';

// ---------------------------------------------------------------------------
// Counting adapter — captures every SELECT's plan + returned row count
// ---------------------------------------------------------------------------
type SelectRec = { db: string; sql: string; rowsReturned: number; plan: string; isScan: boolean; scannedTables: string[] };

let LOG: SelectRec[] = [];
let RECORDING = false;

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, ' ').trim();
}

// Tables small enough (or fixed-size enough) that a SCAN on them is not a concern — flagging
// these would just be noise. Everything else that shows up as a bare SCAN is a real finding.
const SCAN_ALLOWLIST = new Set(['locations', 'suppliers', 'workspace_settings', '_kcp_schema']);

function explainPlan(database: DatabaseSync, sql: string, values: unknown[]): { plan: string; isScan: boolean; scannedTables: string[] } {
  try {
    const rows = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(values as any[])) as Array<{ detail?: string }>;
    const plan = rows.map((r) => String(r.detail || '')).join(' | ');
    const scannedTables: string[] = [];
    for (const row of rows) {
      const detail = String(row.detail || '');
      const m = /^SCAN\s+(\w+)/i.exec(detail.trim());
      if (m && !SCAN_ALLOWLIST.has(m[1])) scannedTables.push(m[1]);
    }
    return { plan, isScan: scannedTables.length > 0, scannedTables };
  } catch {
    return { plan: '(not explainable)', isScan: false, scannedTables: [] };
  }
}

class CountingStatement implements DbStatementLike {
  private values: unknown[] = [];
  constructor(
    private readonly database: DatabaseSync,
    private readonly label: string,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): DbStatementLike {
    const next = new CountingStatement(this.database, this.label, this.sql);
    next.values = values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
    return next;
  }

  private materialize(): { sql: string; values: unknown[] } {
    const values: unknown[] = [];
    let used = false;
    const sql = this.sql.replace(/\?(\d+)/g, (_m, idx) => {
      used = true;
      values.push(this.values[Number(idx) - 1] ?? null);
      return '?';
    });
    return { sql, values: used ? values : this.values };
  }

  private recordSelect(sql: string, values: unknown[], rowsReturned: number) {
    if (!RECORDING) return;
    if (!/^\s*(SELECT|WITH)/i.test(sql)) return;
    const { plan, isScan, scannedTables } = explainPlan(this.database, sql, values);
    LOG.push({ db: this.label, sql: normalizeSql(sql), rowsReturned, plan, isScan, scannedTables });
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const m = this.materialize();
    const row = this.database.prepare(m.sql).get(...(m.values as any[])) as Record<string, unknown> | undefined;
    this.recordSelect(m.sql, m.values, row ? 1 : 0);
    if (!row) return null;
    return (column ? row[column] ?? null : row) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const m = this.materialize();
    const rows = this.database.prepare(m.sql).all(...(m.values as any[])) as T[];
    this.recordSelect(m.sql, m.values, rows.length);
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
  }

  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const m = this.materialize();
    const r = this.database.prepare(m.sql).run(...(m.values as any[]));
    return {
      results: [],
      success: true,
      meta: { changes: Number(r.changes), rows_written: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const m = this.materialize();
    const rows = this.database.prepare(m.sql).all(...(m.values as any[])) as Record<string, unknown>[];
    this.recordSelect(m.sql, m.values, rows.length);
    return rows.map((row) => Object.values(row) as T);
  }
}

class CountingDb implements DbLike {
  constructor(readonly database: DatabaseSync, readonly label: string) {}
  prepare(query: string): DbStatementLike {
    return new CountingStatement(this.database, this.label, query);
  }
  async batch<T = Record<string, unknown>>(statements: DbStatementLike[]): Promise<Array<DbResult<T>>> {
    this.database.exec('BEGIN');
    try {
      const out: Array<DbResult<T>> = [];
      for (const st of statements) out.push(await st.run<T>());
      this.database.exec('COMMIT');
      return out;
    } catch (cause) {
      this.database.exec('ROLLBACK');
      throw cause;
    }
  }
}

// ---------------------------------------------------------------------------
// DB construction
// ---------------------------------------------------------------------------
function applyMigration(database: DatabaseSync, script: string) {
  for (const raw of splitSqlStatements(script)) {
    const s = raw.trim();
    if (!s) continue;
    try {
      database.exec(s);
    } catch (cause) {
      if (isRetryableAddColumnError(s, cause)) continue;
      throw cause;
    }
  }
}

const tenant = new DatabaseSync(':memory:');
for (const m of TENANT_MIGRATIONS) applyMigration(tenant, m);

const central = new DatabaseSync(':memory:');
central.exec(`
  CREATE TABLE admin_users (id TEXT PRIMARY KEY, auth_uid TEXT, email TEXT, role_key TEXT, status TEXT);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_uid TEXT, status TEXT, name TEXT);
  CREATE TABLE workspace_members (id TEXT PRIMARY KEY, workspace_id TEXT, auth_uid TEXT, email TEXT,
    role_key TEXT, status TEXT, allowed_locations_json TEXT);
  CREATE TABLE workspace_roles (id TEXT PRIMARY KEY, workspace_id TEXT, role_key TEXT, permissions_json TEXT);
  CREATE TABLE permission_denials (id TEXT PRIMARY KEY, workspace_id TEXT, auth_uid TEXT, detail_json TEXT, created_at TEXT);
`);
central.exec(`INSERT INTO admin_users VALUES ('a1','uid_super','super@kcp.test','kcp-superuser','active')`);
central.exec(`INSERT INTO workspaces VALUES ('ws_test','uid_super','active','Test WS')`);

const WORKSPACE = 'ws_test';
const AUTH: AuthContext = { uid: 'uid_super', email: 'super@kcp.test', token: {} };

const env = {
  DB: new CountingDb(tenant, 'DB'),
  CENTRAL_DB: new CountingDb(central, 'CENTRAL_DB'),
  ENVIRONMENT: 'test',
  ALLOWED_ORIGINS: 'https://app.test',
} as unknown as Env;

// ---------------------------------------------------------------------------
// Seeding — realistic small-workspace volumes, NOT write-cost-audit's stress volumes.
// ---------------------------------------------------------------------------
const STOCK_ITEM_COUNT = 200;
const PRODUCT_COUNT = 100;
const GRV_COUNT = 15; // a handful of deliveries, ~150 grv_lines total
const SALE_ORDER_COUNT = 0; // "0 sales data", per the actual live client this is modeling

function seed() {
  tenant.exec('BEGIN');
  const now = new Date().toISOString();

  const locIns = tenant.prepare(
    `INSERT INTO locations (id, workspace_id, legacy_source_id, name, kind, active, is_default, created_at, updated_at)
     VALUES (?,?,?,?,?,1,?,?,?)`,
  );
  locIns.run('loc_main', WORKSPACE, 'loc_main', 'Main Store', 'storage', 1, now, now);
  locIns.run('loc_bar', WORKSPACE, 'loc_bar', 'Bar', 'selling', 0, now, now);

  const supIns = tenant.prepare(
    `INSERT INTO suppliers (id, workspace_id, legacy_source_id, name, active, raw_json, created_at, updated_at)
     VALUES (?,?,?,?,1,'{}',?,?)`,
  );
  for (let i = 0; i < 5; i += 1) supIns.run(`sup_${i}`, WORKSPACE, `sup_${i}`, `Seed Supplier ${i}`, now, now);

  const siIns = tenant.prepare(
    `INSERT INTO stock_items (id, workspace_id, legacy_source_id, name, category, item_type, unit, unit_cost,
      vat_enabled, is_stocked, threshold_qty, par_level_qty, yield_pct, batch_yield, active, raw_json,
      created_at, updated_at, name_key)
     VALUES (?,?,?,?,?,?,?,?,1,1,5,0,100,1,1,'{}',?,?,?)`,
  );
  const balIns = tenant.prepare(
    `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at) VALUES (?,?,?,?,?)`,
  );
  for (let i = 0; i < STOCK_ITEM_COUNT; i += 1) {
    const sid = `si_${i}`;
    siIns.run(sid, WORKSPACE, sid, `Seed Ingredient ${i}`, 'General - Raw Materials', 'raw', 'kg', 10 + i, now, now, `seed ingredient ${i}`);
    // roughly half in stock, half out — realistic for testing an in-stock/out-of-stock filter
    balIns.run(WORKSPACE, sid, 'loc_main', i % 2 === 0 ? 50 : 0, now);
  }

  const prodIns = tenant.prepare(
    `INSERT INTO products (id, workspace_id, legacy_source_id, name, category, price, active, raw_json,
      created_at, updated_at, missing_recipe) VALUES (?,?,?,?,?,?,1,'{}',?,?,0)`,
  );
  for (let i = 0; i < PRODUCT_COUNT; i += 1) {
    prodIns.run(`pr_${i}`, WORKSPACE, `pr_${i}`, `Seed Menu Item ${i}`, 'Mains', 50 + i, now, now);
  }

  const recIns = tenant.prepare(
    `INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, yield_unit, active, created_at, updated_at)
     VALUES (?,?,'product',?,1,'ea',1,?,?)`,
  );
  const rlIns = tenant.prepare(
    `INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < PRODUCT_COUNT; i += 1) {
    const rid = `rec_${i}`;
    recIns.run(rid, WORKSPACE, `pr_${i}`, now, now);
    for (let l = 0; l < 4; l += 1) {
      rlIns.run(`rl_${i}_${l}`, WORKSPACE, rid, `si_${(i * 4 + l) % STOCK_ITEM_COUNT}`, 0.25, 'kg', l, now);
    }
  }

  // A handful of GRVs (deliveries) — exercises the just-fixed Stock Control "latest purchase"
  // path with a realistic small-business volume, not a stress-test volume.
  const grvIns = tenant.prepare(
    `INSERT INTO grvs (id, workspace_id, supplier_id, invoice_number, received_at, prices_include_vat,
      split_by_location, total_ex, total_vat, total_inc, created_by, raw_json, created_at)
     VALUES (?,?,?,?,?,0,0,0,0,0,'seed','{}',?)`,
  );
  const grvLineIns = tenant.prepare(
    `INSERT INTO grv_lines (id, workspace_id, grv_id, stock_item_id, location_id, quantity, unit, unit_price, total_ex, total_vat, total_inc)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const purchaseUpsert = tenant.prepare(
    `INSERT INTO stock_item_latest_purchase
      (workspace_id, stock_item_id, location_id, supplier_id, unit, unit_price, received_at, grv_line_id, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
       supplier_id = excluded.supplier_id, unit = excluded.unit, unit_price = excluded.unit_price,
       received_at = excluded.received_at, grv_line_id = excluded.grv_line_id, updated_at = excluded.updated_at
     WHERE excluded.received_at > stock_item_latest_purchase.received_at
        OR (excluded.received_at = stock_item_latest_purchase.received_at AND excluded.grv_line_id > stock_item_latest_purchase.grv_line_id)`,
  );
  for (let g = 0; g < GRV_COUNT; g += 1) {
    const gid = `grv_${g}`;
    const receivedAt = new Date(Date.now() - (GRV_COUNT - g) * 86400_000).toISOString();
    grvIns.run(gid, WORKSPACE, `sup_${g % 5}`, `INV-${g}`, receivedAt, now);
    for (let l = 0; l < 10; l += 1) {
      const sid = `si_${(g * 10 + l) % STOCK_ITEM_COUNT}`;
      const lineId = `grvl_${g}_${l}`;
      grvLineIns.run(lineId, WORKSPACE, gid, sid, 'loc_main', 5, 'kg', 11 + g, 55, 0, 55);
      purchaseUpsert.run(WORKSPACE, sid, 'loc_main', `sup_${g % 5}`, 'kg', 11 + g, receivedAt, lineId, now);
    }
  }

  tenant.exec('COMMIT');
}
seed();

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
interface Measurement {
  name: string;
  handler: string;
  totalRowsReturned: number;
  selectCount: number;
  scans: SelectRec[];
  log: SelectRec[];
  status?: number;
  note?: string;
}

const results: Measurement[] = [];

function req(method: string, body: unknown, url = 'https://api.test/x') {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', origin: 'https://app.test' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

async function measure(name: string, handler: string, fn: () => Promise<Response | unknown>): Promise<Measurement> {
  LOG = [];
  RECORDING = true;
  let status: number | undefined;
  let note: string | undefined;
  try {
    const out = await fn();
    if (out instanceof Response) {
      status = out.status;
      if (out.status >= 400) note = `HANDLER ERROR: ${await out.text()}`;
    }
  } catch (cause) {
    note = `THREW: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  RECORDING = false;
  const log = LOG;
  LOG = [];
  const scans = log.filter((r) => r.isScan);
  const m: Measurement = {
    name,
    handler,
    totalRowsReturned: log.reduce((s, r) => s + r.rowsReturned, 0),
    selectCount: log.length,
    scans,
    log,
    status,
    note,
  };
  results.push(m);
  return m;
}

// ---------------------------------------------------------------------------
// ACTIONS — the exact real-world "200 stock items, 100 menu items" scenario
// ---------------------------------------------------------------------------
async function run() {
  await measure('Load Stock Items list (default page)', 'getStockItems (routes.ts:4997)', () =>
    routes.getStockItems(req('GET', null, 'https://api.test/x?limit=200&offset=0'), env, AUTH, WORKSPACE),
  );

  await measure('Load Products/Menu list (default page)', 'getProducts (routes.ts:5205)', () =>
    routes.getProducts(req('GET', null, 'https://api.test/x?limit=500'), env, AUTH, WORKSPACE),
  );

  await measure('Load Suppliers list', 'getSuppliers (routes.ts:6068)', () =>
    routes.getSuppliers(req('GET', null), env, AUTH, WORKSPACE),
  );

  await measure('Load Locations list', 'getLocations (routes.ts:3651)', () =>
    routes.getLocations(req('GET', null), env, AUTH, WORKSPACE),
  );

  await measure('Load main Dashboard', 'getDashboard (routes.ts:13541)', () =>
    routes.getDashboard(req('GET', null), env, AUTH, WORKSPACE),
  );

  await measure('Load Stock Control report', 'getStockControlReport (reporting-routes.ts:1599)', () =>
    reportingRoutes.getStockControlReport(
      req('GET', null, 'https://api.test/x?limit=5000&offset=0'),
      env, AUTH, WORKSPACE,
    ),
  );

  report();
}

function report() {
  console.log('\n================ READS PER USER ACTION (worst first, by scan count) ================\n');
  const sorted = [...results].sort((a, b) => b.scans.length - a.scans.length || b.totalRowsReturned - a.totalRowsReturned);
  const pad = (s: string, n: number) => s.padEnd(n);
  const padl = (s: string, n: number) => s.padStart(n);
  console.log(pad('ACTION', 42) + padl('SELECTs', 9) + padl('ROWS', 8) + padl('SCANS', 7));
  console.log('-'.repeat(66));
  for (const r of sorted) {
    console.log(
      pad(r.name, 42) + padl(String(r.selectCount), 9) + padl(String(r.totalRowsReturned), 8) + padl(String(r.scans.length), 7) +
        (r.note ? `   << ${r.note.slice(0, 100)}` : ''),
    );
  }

  console.log('\n================ FULL-TABLE SCANS FOUND (the actual problem, if any) ================\n');
  let anyScans = false;
  for (const r of sorted) {
    if (!r.scans.length) continue;
    anyScans = true;
    console.log(`### ${r.name}  (${r.handler})`);
    for (const s of r.scans) {
      console.log(`    SCAN on [${s.scannedTables.join(', ')}] — rows returned by this query: ${s.rowsReturned}`);
      console.log(`    plan: ${s.plan}`);
      console.log(`    sql:  ${s.sql.slice(0, 220)}${s.sql.length > 220 ? '…' : ''}`);
      console.log('');
    }
  }
  if (!anyScans) console.log('  None found at this data volume — every query used an index.\n');

  console.log('================ PER-ACTION DETAIL ================\n');
  for (const r of sorted) {
    console.log(`### ${r.name}`);
    console.log(`    handler: ${r.handler}`);
    if (r.note) console.log(`    NOTE: ${r.note}`);
    console.log(`    SELECT statements: ${r.selectCount}   total rows returned: ${r.totalRowsReturned}   scans: ${r.scans.length}`);
    console.log('');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
