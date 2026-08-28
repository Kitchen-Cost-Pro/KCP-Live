/**
 * WRITE-COST AUDIT HARNESS
 *
 * Measures ROWS WRITTEN (and statement count) for each real user write action, by running the
 * ACTUAL exported route handlers from src/legacy/routes.ts against a real in-memory SQLite
 * database built from the full TENANT_MIGRATIONS chain (same splitter/retry logic as
 * WorkspaceDO.migrate()).
 *
 * Run:  node --import tsx --import ./tests/_cf-stub.mjs tests/write-cost-audit.ts
 *       (_cf-stub.mjs stubs `cloudflare:*` module specifiers so worker source imports under Node)
 *
 * "Rows written" here = SQLite `changes` summed over every statement the action executed.
 * Cloudflare's own rows_written ALSO counts index entries, so the report additionally prints an
 * index-amplified estimate using the real index count per table from the migrated schema.
 */
import { DatabaseSync } from 'node:sqlite';
import { splitSqlStatements, isRetryableAddColumnError } from '../src/d1-facade';
import { TENANT_MIGRATIONS } from '../src/tenant-migrations';
import type { AuthContext, DbLike, DbResult, DbStatementLike, Env } from '../src/legacy/types';
import * as routes from '../src/legacy/routes';

// ---------------------------------------------------------------------------
// Counting adapter
// ---------------------------------------------------------------------------
type Rec = { db: string; sql: string; changes: number; kind: 'read' | 'write' };

let LOG: Rec[] = [];
let RECORDING = false;

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, ' ').trim();
}
function isWriteSql(sql: string) {
  return /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)/i.test(sql);
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

  private record(sql: string, changes: number) {
    if (!RECORDING) return;
    LOG.push({
      db: this.label,
      sql: normalizeSql(sql),
      changes,
      kind: isWriteSql(sql) ? 'write' : 'read',
    });
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const m = this.materialize();
    const row = this.database.prepare(m.sql).get(...(m.values as any[])) as Record<string, unknown> | undefined;
    this.record(m.sql, 0);
    if (!row) return null;
    return (column ? row[column] ?? null : row) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const m = this.materialize();
    const rows = this.database.prepare(m.sql).all(...(m.values as any[])) as T[];
    this.record(m.sql, 0);
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
  }

  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const m = this.materialize();
    const r = this.database.prepare(m.sql).run(...(m.values as any[]));
    const changes = Number(r.changes);
    this.record(m.sql, isWriteSql(m.sql) ? changes : 0);
    return {
      results: [],
      success: true,
      meta: { changes, rows_written: changes, last_row_id: Number(r.lastInsertRowid) },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const m = this.materialize();
    const rows = this.database.prepare(m.sql).all(...(m.values as any[])) as Record<string, unknown>[];
    this.record(m.sql, 0);
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
// Index amplification map (Cloudflare counts index writes as rows written)
// ---------------------------------------------------------------------------
const indexCounts = new Map<string, number>();
{
  const tables = tenant.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
  for (const t of tables) {
    const idx = tenant.prepare(`PRAGMA index_list(${JSON.stringify(t.name)})`).all() as unknown[];
    indexCounts.set(t.name, idx.length);
  }
}
function tableOf(sql: string): string {
  const m =
    /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][\w]*)/i.exec(sql) ||
    /^\s*UPDATE\s+([A-Za-z_][\w]*)/i.exec(sql) ||
    /^\s*DELETE\s+FROM\s+([A-Za-z_][\w]*)/i.exec(sql) ||
    /^\s*REPLACE\s+INTO\s+([A-Za-z_][\w]*)/i.exec(sql);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// Seeding (bypasses the counter — direct SQL)
// ---------------------------------------------------------------------------
function seed() {
  tenant.exec('BEGIN');
  const now = new Date().toISOString();

  const locIns = tenant.prepare(
    `INSERT INTO locations (id, workspace_id, legacy_source_id, name, kind, active, is_default, created_at, updated_at)
     VALUES (?,?,?,?,?,1,?,?,?)`,
  );
  locIns.run('loc_main', WORKSPACE, 'loc_main', 'Main Store', 'storage', 1, now, now);
  locIns.run('loc_bar', WORKSPACE, 'loc_bar', 'Bar', 'selling', 0, now, now);
  locIns.run('loc_kitchen', WORKSPACE, 'loc_kitchen', 'Kitchen', 'selling', 0, now, now);

  const siIns = tenant.prepare(
    `INSERT INTO stock_items (id, workspace_id, legacy_source_id, name, category, item_type, unit, unit_cost,
      vat_enabled, is_stocked, threshold_qty, par_level_qty, yield_pct, batch_yield, active, raw_json,
      created_at, updated_at, name_key)
     VALUES (?,?,?,?,?,?,?,?,1,1,5,0,100,1,1,'{}',?,?,?)`,
  );
  const balIns = tenant.prepare(
    `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at) VALUES (?,?,?,?,?)`,
  );
  for (let i = 0; i < 500; i += 1) {
    const sid = `si_${i}`;
    siIns.run(sid, WORKSPACE, sid, `Seed Ingredient ${i}`, 'General - Raw Materials', 'raw', 'kg', 10 + i, now, now, `seed ingredient ${i}`);
    for (const loc of ['loc_main', 'loc_bar', 'loc_kitchen']) balIns.run(WORKSPACE, sid, loc, 100, now);
  }

  const prodIns = tenant.prepare(
    `INSERT INTO products (id, workspace_id, legacy_source_id, name, category, price, active, raw_json,
      created_at, updated_at, missing_recipe) VALUES (?,?,?,?,?,?,1,'{}',?,?,0)`,
  );
  for (let i = 0; i < 500; i += 1) {
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
  for (let i = 0; i < 200; i += 1) {
    const rid = `rec_${i}`;
    recIns.run(rid, WORKSPACE, `pr_${i}`, now, now);
    for (let l = 0; l < 5; l += 1) {
      rlIns.run(`rl_${i}_${l}`, WORKSPACE, rid, `si_${(i * 5 + l) % 500}`, 0.25, 'kg', l, now);
    }
  }

  const smIns = tenant.prepare(
    `INSERT INTO stock_movements (id, workspace_id, stock_item_id, location_id, movement_type, document_type,
      document_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
     VALUES (?,?,?,?,'adjustment','adjustment',?,?,?,?,?,'seed','{}',?)`,
  );
  for (let i = 0; i < 20000; i += 1) {
    smIns.run(`mv_${i}`, WORKSPACE, `si_${i % 500}`, 'loc_main', `doc_${i}`, -1, 10, -10, now, now);
  }

  const orderCols = (tenant.prepare(`PRAGMA table_info(yoco_orders)`).all() as any[]);
  const lineCols = (tenant.prepare(`PRAGMA table_info(yoco_order_lines)`).all() as any[]);
  const buildInsert = (table: string, cols: any[], supply: (name: string, i: number) => unknown) => {
    const use = cols.filter((c) => c.notnull === 1 || c.pk === 1 || ['id', 'workspace_id'].includes(c.name));
    const names = use.map((c) => c.name);
    const stmt = tenant.prepare(
      `INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`,
    );
    return (i: number) => stmt.run(...names.map((n) => supply(n, i) as any));
  };
  const insOrder = buildInsert('yoco_orders', orderCols, (name, i) => {
    if (name === 'id') return `yo_${i}`;
    if (name === 'workspace_id') return WORKSPACE;
    const c = orderCols.find((x) => x.name === name);
    if (/INT|REAL|NUM/i.test(String(c?.type))) return 0;
    return `${name}_${i}`;
  });
  for (let i = 0; i < 4000; i += 1) insOrder(i);
  const insLine = buildInsert('yoco_order_lines', lineCols, (name, i) => {
    if (name === 'id') return `yol_${i}`;
    if (name === 'workspace_id') return WORKSPACE;
    if (name === 'order_id' || name === 'yoco_order_id') return `yo_${i % 4000}`;
    const c = lineCols.find((x) => x.name === name);
    if (/INT|REAL|NUM/i.test(String(c?.type))) return 0;
    return `${name}_${i}`;
  });
  for (let i = 0; i < 8000; i += 1) insLine(i);

  tenant.exec('COMMIT');
}
seed();

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------
interface Measurement {
  name: string;
  handler: string;
  totalWrites: number;
  statements: number;
  writeStatements: number;
  reads: number;
  amplified: number;
  perTable: Map<string, number>;
  log: Rec[];
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
  const writes = log.filter((r) => r.kind === 'write');
  const perTable = new Map<string, number>();
  let amplified = 0;
  for (const w of writes) {
    const t = tableOf(w.sql);
    perTable.set(t, (perTable.get(t) || 0) + w.changes);
    const idx = w.db === 'DB' ? indexCounts.get(t) ?? 0 : 1;
    amplified += w.changes * (1 + idx);
  }
  const m: Measurement = {
    name,
    handler,
    totalWrites: writes.reduce((s, w) => s + w.changes, 0),
    statements: log.length,
    writeStatements: writes.length,
    reads: log.filter((r) => r.kind === 'read').length,
    amplified,
    perTable,
    log,
    status,
    note,
  };
  results.push(m);
  return m;
}

// ---------------------------------------------------------------------------
// ACTIONS
// ---------------------------------------------------------------------------
async function run() {
  // 1. Save ONE NEW stock item
  await measure('Save 1 NEW stock item', 'postStockItem (routes.ts:6128)', () =>
    routes.postStockItem(
      req('POST', { item: { name: 'Harness New Ingredient A', unit: 'kg', cost: 12.5, category: 'Dry Goods' } }),
      env, AUTH, WORKSPACE,
    ),
  );

  // 2. Save ONE EXISTING stock item
  await measure('Save 1 EXISTING stock item', 'patchStockItem (routes.ts:6145)', () =>
    routes.patchStockItem(
      req('PATCH', { item: { name: 'Seed Ingredient 7', unit: 'kg', cost: 99.9, category: 'Dry Goods' } }),
      env, AUTH, WORKSPACE, 'si_7',
    ),
  );

  // 2b. Save existing stock item that IS the recipe source of many products (fan-out probe)
  tenant.exec(`UPDATE products SET recipe_source_stock_item_id = 'si_9' WHERE workspace_id = '${WORKSPACE}' AND active = 1 AND id IN (SELECT id FROM products WHERE workspace_id='${WORKSPACE}' LIMIT 120)`);
  await measure(
    'Save 1 EXISTING stock item that 120 products use as recipe source',
    'patchStockItem -> updateProductsUsingRecipeSource (routes.ts:1240)',
    () =>
      routes.patchStockItem(
        req('PATCH', { item: { name: 'Seed Ingredient 9', unit: 'kg', cost: 42 } }),
        env, AUTH, WORKSPACE, 'si_9',
      ),
  );
  tenant.exec(`UPDATE products SET recipe_source_stock_item_id = NULL WHERE workspace_id = '${WORKSPACE}'`);

  // 3. Save ONE new product with a 5-line recipe
  await measure('Save 1 NEW product + 5-line recipe', 'postProduct -> saveProductRecord (routes.ts:5628 / 1487)', () =>
    routes.postProduct(
      req('POST', {
        product: {
          name: 'Harness New Dish A',
          category: 'Mains',
          sellingPrice: 120,
          recipe: [0, 1, 2, 3, 4].map((i) => ({ stockItemId: `si_${i}`, qty: 0.2, unit: 'kg' })),
        },
      }),
      env, AUTH, WORKSPACE,
    ),
  );

  // 3b. Save EXISTING product (patch)
  await measure('Save 1 EXISTING product (no recipe key)', 'patchProduct (routes.ts:5645)', () =>
    routes.patchProduct(
      req('PATCH', { product: { sellingPrice: 155 } }),
      env, AUTH, WORKSPACE, 'pr_3',
    ),
  );

  // 3c. Save EXISTING product WITH recipe re-save (200 seeded recipes have 5 lines)
  await measure('Save 1 EXISTING product + re-save 5-line recipe', 'patchProduct -> saveProductRecipe (routes.ts:1110)', () =>
    routes.patchProduct(
      req('PATCH', { product: { recipe: [0, 1, 2, 3, 4].map((i) => ({ stockItemId: `si_${i}`, qty: 0.3, unit: 'kg' })) } }),
      env, AUTH, WORKSPACE, 'pr_5',
    ),
  );

  // 4. Import 100 products
  await measure('Import 100 products', 'postProductImport (routes.ts:5769)', () =>
    routes.postProductImport(
      req('POST', {
        rows: Array.from({ length: 100 }, (_, i) => ({
          name: `Import Dish ${i}`,
          category: 'Imported',
          sellingPrice: 80 + i,
        })),
      }),
      env, AUTH, WORKSPACE,
    ),
  );

  // 5. Import 100 stock items
  await measure('Import 100 stock items', 'postStockImport (routes.ts:6338)', () =>
    routes.postStockImport(
      req('POST', {
        items: Array.from({ length: 100 }, (_, i) => ({
          name: `Import Ingredient ${i}`,
          unit: 'kg',
          cost: 5 + i,
        })),
        options: { defaultImportLocationId: 'loc_main' },
      }),
      env, AUTH, WORKSPACE,
    ),
  );

  // 6. Delete a stock item
  await measure('Delete 1 stock item', 'deleteStockItemRoute (routes.ts:6162)', () =>
    routes.deleteStockItemRoute(req('DELETE', {}), env, AUTH, WORKSPACE, 'si_400'),
  );

  // 7. Delete a product
  await measure('Delete 1 product', 'deleteProductRoute (routes.ts:5701)', () =>
    routes.deleteProductRoute(req('DELETE', {}), env, AUTH, WORKSPACE, 'pr_400'),
  );

  // 8. Post a GRV (10 lines)
  await measure('Post a GRV (10 lines)', 'postGoodsReceipt (routes.ts:8387)', () =>
    routes.postGoodsReceipt(
      req('POST', {
        receipt: {
          supplierId: '',
          invoiceNumber: 'INV-1',
          locationId: 'loc_main',
          pricesIncludeVat: false,
          overrideCostPrice: true,
          items: Array.from({ length: 10 }, (_, i) => ({
            stockItemId: `si_${i}`,
            receivedQty: 5,
            baseQuantity: 5,
            unitCost: 11,
            unit: 'kg',
          })),
        },
      }),
      env, AUTH, WORKSPACE,
    ),
  );

  // 8b. GRV with 1 line
  await measure('Post a GRV (1 line)', 'postGoodsReceipt (routes.ts:8387)', () =>
    routes.postGoodsReceipt(
      req('POST', {
        receipt: {
          invoiceNumber: 'INV-2',
          locationId: 'loc_main',
          overrideCostPrice: true,
          items: [{ stockItemId: 'si_1', receivedQty: 3, baseQuantity: 3, unitCost: 12, unit: 'kg' }],
        },
      }),
      env, AUTH, WORKSPACE,
    ),
  );

  // 9. Stock adjustment (1 line and 10 lines)
  await measure('Stock adjustment (1 line)', 'postAdjustment (routes.ts:6897)', () =>
    routes.postAdjustment(
      req('POST', { mode: 'add', locationId: 'loc_main', items: [{ stockItemId: 'si_2', quantity: 4 }] }),
      env, AUTH, WORKSPACE,
    ),
  );
  await measure('Stock adjustment (10 lines)', 'postAdjustment (routes.ts:6897)', () =>
    routes.postAdjustment(
      req('POST', {
        mode: 'add',
        locationId: 'loc_main',
        items: Array.from({ length: 10 }, (_, i) => ({ stockItemId: `si_${i}`, quantity: 2 })),
      }),
      env, AUTH, WORKSPACE,
    ),
  );

  // 10. Stock level patch (single item quick edit)
  await measure('Set stock level for 1 item', 'patchStockLevel (routes.ts:6273)', () =>
    routes.patchStockLevel(
      req('PATCH', { stock: 55, locationId: 'loc_main' }),
      env, AUTH, WORKSPACE, 'si_3',
    ),
  );

  // 11. Internal transfer (5 lines)
  await measure('Internal transfer (5 lines)', 'postInternalTransfer (routes.ts:11812)', () =>
    routes.postInternalTransfer(
      req('POST', {
        fromLocationId: 'loc_main',
        toLocationId: 'loc_bar',
        items: Array.from({ length: 5 }, (_, i) => ({ stockItemId: `si_${i + 20}`, quantity: 2 })),
      }),
      env, AUTH, WORKSPACE,
    ),
  );
  await measure('Internal transfer (1 line)', 'postInternalTransfer (routes.ts:11812)', () =>
    routes.postInternalTransfer(
      req('POST', {
        fromLocationId: 'loc_main',
        toLocationId: 'loc_bar',
        items: [{ stockItemId: 'si_30', quantity: 1 }],
      }),
      env, AUTH, WORKSPACE,
    ),
  );

  // 12. Bulk deletes
  await measure('Bulk delete 50 stock items', 'postStockBulkDelete (routes.ts:6207)', () =>
    routes.postStockBulkDelete(
      req('POST', { ids: Array.from({ length: 50 }, (_, i) => `si_${300 + i}`) }),
      env, AUTH, WORKSPACE,
    ),
  );
  await measure('Bulk delete 50 products', 'postProductBulkDelete (routes.ts:5813)', () =>
    routes.postProductBulkDelete(
      req('POST', { ids: Array.from({ length: 50 }, (_, i) => `pr_${300 + i}`) }),
      env, AUTH, WORKSPACE,
    ),
  );

  // 13. RED FLAG: rename a stock CATEGORY -> rewrites every stock item in that category
  await measure('Rename ONE stock category', 'postStockCategoryAction "rename" (routes.ts:7378)', () =>
    routes.postStockCategoryAction(
      req('POST', { currentName: 'General - Raw Materials', nextName: 'Raw Materials 2' }),
      env, AUTH, WORKSPACE, 'rename',
    ),
  );

  // 14. RED FLAG: rename ONE UOM -> rewrites every stock item using that unit
  await measure('Rename ONE unit of measure (kg -> kilogram)', 'postStockUomAction "rename" (routes.ts:7431)', () =>
    routes.postStockUomAction(
      req('POST', { currentName: 'kg', nextName: 'kilogram' }),
      env, AUTH, WORKSPACE, 'rename',
    ),
  );

  // 15. RED FLAG: flip the workspace VAT-registration toggle -> rescales EVERY stock item
  tenant.exec(
    `INSERT INTO workspace_settings (workspace_id, raw_json, updated_at) VALUES ('${WORKSPACE}', '{}', datetime('now'))
     ON CONFLICT(workspace_id) DO UPDATE SET raw_json = '{}'`,
  );
  await measure(
    'Toggle workspace VAT registration OFF',
    'patchWorkspaceSettingsRoute -> rescaleCostsForVatRegistrationChange (routes.ts:3925 / 4119)',
    () => routes.patchWorkspaceSettingsRoute(req('PATCH', { vatRegistered: false }), env, AUTH, WORKSPACE),
  );

  // 16. RED FLAG (run LAST — destroys the seed): reset dashboard history
  await measure(
    'Reset dashboard history (20k movements, 4k orders, 8k lines seeded)',
    'postStockResetDashboardHistory (routes.ts:6519)',
    () => routes.postStockResetDashboardHistory(req('POST', { includeStockOnHand: true }), env, AUTH, WORKSPACE),
  );

  report();
}

function report() {
  const sorted = [...results].sort((a, b) => b.totalWrites - a.totalWrites);
  console.log('\n================ ROWS WRITTEN PER USER ACTION (worst first) ================\n');
  const pad = (s: string, n: number) => s.padEnd(n);
  const padl = (s: string, n: number) => s.padStart(n);
  console.log(
    pad('ACTION', 58) + padl('ROWS', 7) + padl('AMP*', 8) + padl('STMTS', 7) + padl('WSTMT', 7) + padl('READS', 7),
  );
  console.log('-'.repeat(94));
  for (const r of sorted) {
    console.log(
      pad(r.name, 58) +
        padl(String(r.totalWrites), 7) +
        padl(String(r.amplified), 8) +
        padl(String(r.statements), 7) +
        padl(String(r.writeStatements), 7) +
        padl(String(r.reads), 7) +
        (r.note ? `   << ${r.note.slice(0, 120)}` : ''),
    );
  }
  console.log('\n* AMP = Cloudflare-style rows_written estimate (each logical row × (1 + index count on that table)).\n');

  console.log('================ PER-ACTION DETAIL ================\n');
  for (const r of sorted) {
    console.log(`### ${r.name}`);
    console.log(`    handler: ${r.handler}`);
    if (r.note) console.log(`    NOTE: ${r.note}`);
    console.log(`    rows written: ${r.totalWrites}   amplified: ${r.amplified}   statements: ${r.statements} (${r.writeStatements} write / ${r.reads} read)`);
    const tables = [...r.perTable.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`    by table: ${tables.map(([t, c]) => `${t}=${c}`).join(', ') || '(none)'}`);
    // distinct write statement shapes with counts
    const shapes = new Map<string, { n: number; rows: number }>();
    for (const w of r.log.filter((x) => x.kind === 'write')) {
      const key = `${w.db}: ${w.sql.slice(0, 150)}`;
      const cur = shapes.get(key) || { n: 0, rows: 0 };
      cur.n += 1;
      cur.rows += w.changes;
      shapes.set(key, cur);
    }
    for (const [k, v] of [...shapes.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
      console.log(`      x${String(v.n).padStart(4)} rows=${String(v.rows).padStart(4)}  ${k}`);
    }
    console.log('');
  }

  console.log('================ INDEX COUNTS (write amplification) ================\n');
  for (const t of ['stock_items', 'products', 'recipes', 'recipe_lines', 'stock_balances', 'stock_movements', 'audit_events', 'adjustments', 'adjustment_lines', 'grvs', 'grv_lines', 'transfers', 'transfer_lines', 'stock_item_location_prices', 'product_location_prices']) {
    if (indexCounts.has(t)) console.log(`  ${t.padEnd(32)} ${indexCounts.get(t)} indexes -> x${(indexCounts.get(t) || 0) + 1} per row`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
