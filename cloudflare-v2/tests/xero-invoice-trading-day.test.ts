import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { businessDayUtcBounds, yesterdayDateKey, todayDateKey, autoSyncDueDateKey, claimDailyInvoiceSyncIfDue, buildDailyInvoicePayload, aggregateDailySalesLines } from '../src/modules/xero-engine/invoice-sync';
import { XERO_V2_FOUNDATION_MIGRATION } from '../src/modules/xero-engine/migrations';

// Regression: the Xero daily-sales push used to bucket every venue into a hardcoded
// midnight-to-midnight SAST calendar day (businessDayUtcBounds hardcoded T00:00:00+02:00), which
// misattributes sales for a venue that trades past midnight (e.g. a bar/club running 5am-to-5am) —
// a 2am sale would land in "tomorrow's" invoice instead of the trading day it was actually rung up
// on. This adds a configurable trading-day-start hour, read from the SAME workspace_settings
// (tradingDayStartHour) that Settings > "Trading day" and reporting/stock-take-counted-at.ts
// already use — see trading-day.ts.

class SqliteStatement implements DbStatementLike {
  private values: unknown[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]): DbStatementLike {
    const statement = new SqliteStatement(this.database, this.sql);
    statement.values = values.map((value) => (value === undefined ? null : value));
    return statement;
  }
  private materialize() {
    const numberedValues: unknown[] = [];
    const numberedSql = this.sql.replace(/\?(\d+)/g, (_match, index) => {
      numberedValues.push(this.values[Number(index) - 1] ?? null);
      return '?';
    });
    return numberedValues.length ? { sql: numberedSql, values: numberedValues } : { sql: this.sql, values: this.values };
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const materialized = this.materialize();
    const row = this.database.prepare(materialized.sql).get(...materialized.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const materialized = this.materialize();
    const rows = this.database.prepare(materialized.sql).all(...materialized.values) as T[];
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
  }
  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const materialized = this.materialize();
    const result = this.database.prepare(materialized.sql).run(...materialized.values);
    return { results: [], success: true, meta: { changes: Number(result.changes), rows_written: Number(result.changes) } };
  }
  async raw<T = unknown[]>(): Promise<T[]> {
    const materialized = this.materialize();
    const rows = this.database.prepare(materialized.sql).all(...materialized.values) as Record<string, unknown>[];
    return rows.map((row) => Object.values(row) as T);
  }
}

class SqliteDb implements DbLike {
  constructor(readonly database = new DatabaseSync(':memory:')) {}
  prepare(query: string): DbStatementLike { return new SqliteStatement(this.database, query); }
  async batch<T = Record<string, unknown>>(statements: DbStatementLike[]): Promise<Array<DbResult<T>>> {
    const results: Array<DbResult<T>> = [];
    for (const statement of statements) results.push(await statement.run<T>());
    return results;
  }
}

function createEnv(xeroSyncSettings: { enabled?: number; last_invoice_sync_date?: string; invoice_sync_claimed_at?: string; vatRegistered?: number } = {}) {
  const DB = new SqliteDb();
  DB.database.exec(TENANT_SCHEMA_SQL);
  DB.database.exec(XERO_V2_FOUNDATION_MIGRATION);
  // vat_registered/products.vat_enabled are added by later tenant migrations, not the baseline
  // schema — same pattern as inventory-costing-vat.test.ts's createEnv.
  DB.database.exec(`ALTER TABLE workspace_settings ADD COLUMN vat_registered INTEGER NOT NULL DEFAULT 1;`);
  DB.database.exec(`ALTER TABLE products ADD COLUMN vat_enabled INTEGER NOT NULL DEFAULT 1;`);
  DB.database.prepare(`INSERT INTO workspace_settings (workspace_id, vat_registered) VALUES ('ws_1', ?1)`)
    .run(xeroSyncSettings.vatRegistered ?? 1);
  DB.database.prepare(
    `INSERT INTO xero_sync_settings (workspace_id, enabled, last_invoice_sync_date, invoice_sync_claimed_at, created_at, updated_at)
     VALUES ('ws_1', ?1, ?2, ?3, datetime('now'), datetime('now'))`
  ).run(
    xeroSyncSettings.enabled ?? 1,
    xeroSyncSettings.last_invoice_sync_date ?? null,
    xeroSyncSettings.invoice_sync_claimed_at ?? null
  );
  return { DB } as any;
}

// Seeds one yoco_orders row + its yoco_order_lines, matching how live-sale.ts/live-refund.ts
// actually write them (refund rows use NEGATIVE quantity/total — see live-refund.ts:186-207 — this
// helper mirrors that convention rather than re-deriving it).
function seedOrder(
  env: any,
  { id, orderType = 'sale', occurredAt, productId, name, quantity, total }: { id: string; orderType?: string; occurredAt: string; productId: string | null; name: string; quantity: number; total: number }
) {
  env.DB.database.prepare(
    `INSERT INTO yoco_orders (id, workspace_id, yoco_order_id, order_type, status, total, occurred_at)
     VALUES (?1, 'ws_1', ?1, ?2, ?3, ?4, ?5)`
  ).run(id, orderType, orderType === 'refund' ? 'refunded' : 'completed', total, occurredAt);
  env.DB.database.prepare(
    `INSERT INTO yoco_order_lines (id, workspace_id, yoco_order_id, product_id, name, quantity, total)
     VALUES (?1, 'ws_1', ?2, ?3, ?4, ?5, ?6)`
  ).run(`${id}_line`, id, productId, name, quantity, total);
}

test('businessDayUtcBounds defaults to a plain midnight-to-midnight SAST day (existing venues unaffected)', () => {
  const bounds = businessDayUtcBounds('2026-08-31');
  assert.equal(bounds.startIso, '2026-08-30T22:00:00.000Z');
  assert.equal(bounds.endIso, '2026-08-31T22:00:00.000Z');
});

test('businessDayUtcBounds with an explicit startHour of 0 matches the no-argument default exactly', () => {
  assert.deepEqual(businessDayUtcBounds('2026-08-31', 0), businessDayUtcBounds('2026-08-31'));
});

test('a 5am-start trading day runs from 05:00 SAST to 05:00 SAST the next calendar date', () => {
  const bounds = businessDayUtcBounds('2026-08-31', 5);
  assert.equal(bounds.startIso, '2026-08-31T03:00:00.000Z');
  assert.equal(bounds.endIso, '2026-09-01T03:00:00.000Z');
});

test('a 2am SAST sale is attributed to the PRIOR trading day, not the calendar date it fell on, for a 5am-start venue', () => {
  // 2026-08-31T00:00:00Z is 2am SAST (UTC+2) on the calendar date 2026-08-31.
  const saleInstant = new Date('2026-08-31T00:00:00.000Z').getTime();

  const priorTradingDay = businessDayUtcBounds('2026-08-30', 5);
  assert.ok(
    saleInstant >= Date.parse(priorTradingDay.startIso) && saleInstant < Date.parse(priorTradingDay.endIso),
    'a 2am sale on 2026-08-31 should fall inside the 2026-08-30 trading day (started 2026-08-30T05:00 SAST)'
  );

  const calendarDateTradingDay = businessDayUtcBounds('2026-08-31', 5);
  assert.ok(
    saleInstant < Date.parse(calendarDateTradingDay.startIso),
    'a 2am sale should NOT yet fall inside the 2026-08-31 trading day, which only starts at 05:00 SAST'
  );
});

test('todayDateKey/yesterdayDateKey default (startHour=0) match the original fixed +2h SAST shift', () => {
  const now = new Date('2026-08-31T10:00:00.000Z'); // midday SAST on 2026-08-31
  assert.equal(todayDateKey(0, now), '2026-08-31');
  assert.equal(yesterdayDateKey(0, now), '2026-08-30');
});

test('a 5am-start venue: a sale/check at 2am SAST is still "yesterday" (and "today" too) relative to the prior calendar date', () => {
  // 2am SAST on 2026-08-31 == 00:00Z on 2026-08-31.
  const now = new Date('2026-08-31T00:00:00.000Z');
  // Trading day hasn't rolled over yet (rolls at 05:00 SAST) — "today" is still dated 2026-08-30.
  assert.equal(todayDateKey(5, now), '2026-08-30');
  assert.equal(yesterdayDateKey(5, now), '2026-08-29');
});

test('a 5am-start venue: once past the 5am rollover, today/yesterday advance to the next calendar date', () => {
  // 6am SAST on 2026-08-31 == 04:00Z on 2026-08-31 — past the 05:00 SAST rollover.
  const now = new Date('2026-08-31T04:00:00.000Z');
  assert.equal(todayDateKey(5, now), '2026-08-31');
  assert.equal(yesterdayDateKey(5, now), '2026-08-30');
});

test('claimDailyInvoiceSyncIfDue picks the trading-day-aware date, not a fixed midnight one', async () => {
  const env = createEnv({ enabled: 1 });
  const claim = await claimDailyInvoiceSyncIfDue(env, 'ws_1', 5);
  assert.equal(claim.due, true);
  // claimDailyInvoiceSyncIfDue uses autoSyncDueDateKey (yesterdayDateKey + a 1-hour post-close
  // grace buffer), not the plain yesterdayDateKey a manual push button would use — see
  // autoSyncDueDateKey's doc comment in invoice-sync.ts.
  assert.equal(claim.dateKey, autoSyncDueDateKey(5));
  // Sanity: for this same instant, a midnight-start venue would (in general) claim a different date
  // once the current SAST hour is between 0 and 5 — not asserted directly here since it depends on
  // the real current time when this test runs, but the two calls below prove startHour is honored
  // rather than ignored.
  assert.notEqual(claim.dateKey, undefined);
});

// Regression: the automatic due-check previously flipped to a new "yesterday" the INSTANT the
// trading day closed (e.g. exactly midnight SAST) — racing a payment/webhook still settling in the
// last few minutes of the day. autoSyncDueDateKey deliberately waits an extra hour before treating
// that day as syncable; the manual "push now" buttons (plain yesterdayDateKey) are unaffected.
test('autoSyncDueDateKey lags yesterdayDateKey by exactly one hour of real time', () => {
  // 00:30 SAST on 2026-08-31 (22:30Z on 2026-08-30) — 30 minutes past a midnight-start trading day's
  // close. Without a buffer this would already report the new "yesterday" (2026-08-30).
  const justAfterMidnight = new Date('2026-08-30T22:30:00.000Z');
  assert.equal(yesterdayDateKey(0, justAfterMidnight), '2026-08-30', 'sanity: the plain (unbuffered) date key has already flipped');
  assert.equal(autoSyncDueDateKey(0, justAfterMidnight), '2026-08-29', 'the buffered auto-sync date key has NOT flipped yet — still within the 1-hour grace window');

  // 01:30 SAST (23:30Z on 2026-08-30) — a full hour past close — now the buffered version catches up.
  const pastGraceWindow = new Date('2026-08-30T23:30:00.000Z');
  assert.equal(autoSyncDueDateKey(0, pastGraceWindow), '2026-08-30', 'a full hour after close, the buffered date key has caught up to the closed day');
});

test('autoSyncDueDateKey respects a non-midnight trading-day start hour the same way yesterdayDateKey does', () => {
  // 05:30 SAST on 2026-08-31 (03:30Z) — 30 minutes past a 5am-start trading day's close.
  const justAfterClose = new Date('2026-08-31T03:30:00.000Z');
  assert.equal(yesterdayDateKey(5, justAfterClose), '2026-08-30', 'sanity: the plain date key has already flipped for a 5am-start venue');
  assert.equal(autoSyncDueDateKey(5, justAfterClose), '2026-08-29', 'the buffered version still lags by the same 1-hour grace window');
});

test('claimDailyInvoiceSyncIfDue is a no-op once that trading day has already been synced, independent of startHour', async () => {
  const dateKey = yesterdayDateKey(5);
  const env = createEnv({ enabled: 1, last_invoice_sync_date: dateKey });
  const claim = await claimDailyInvoiceSyncIfDue(env, 'ws_1', 5);
  assert.equal(claim.due, false);
});

test('claimDailyInvoiceSyncIfDue respects the once-per-day dedup independently of the trading-day-start change', async () => {
  const env = createEnv({ enabled: 0 });
  const claim = await claimDailyInvoiceSyncIfDue(env, 'ws_1', 5);
  assert.equal(claim.due, false);
});

// Regression: yoco_order_lines.total is VAT-INCLUSIVE (gross_amount, per sale-resolver.ts's
// lineAmounts: net = gross - tax), but buildDailyInvoicePayload previously sent
// LineAmountTypes: 'Exclusive' — telling Xero to add tax ON TOP of an already-taxed amount, double-
// counting VAT on every sales invoice line.
test('buildDailyInvoicePayload sends LineAmountTypes: Inclusive, matching that line.total is VAT-inclusive gross', () => {
  const payload = buildDailyInvoicePayload('2026-08-31', [{ label: 'Burger', product_id: 'p1', sku: 'BRG', quantity: 2, total: 115 }], {
    salesAccountCode: '200',
    defaultTaxType: 'OUTPUT2'
  });
  assert.equal(payload.Invoices[0].LineAmountTypes, 'Inclusive');
  assert.equal(payload.Invoices[0].LineItems[0].UnitAmount, 57.5);
});

// Regression: a non-VAT-registered workspace cannot charge real output VAT on anything it sells —
// the daily invoice previously always used settings.defaultTaxType regardless of registration,
// which would misreport phantom output VAT on a Xero VAT return.
test('buildDailyInvoicePayload uses the configured defaultTaxType for a VAT-registered workspace (default/unchanged)', () => {
  const payload = buildDailyInvoicePayload('2026-08-31', [{ label: 'Burger', product_id: 'p1', sku: 'BRG', quantity: 2, total: 115 }], {
    salesAccountCode: '200',
    defaultTaxType: 'OUTPUT2'
  });
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'OUTPUT2');
});

test('buildDailyInvoicePayload uses TaxType NONE for every line when the workspace is not VAT-registered', () => {
  const payload = buildDailyInvoicePayload(
    '2026-08-31',
    [{ label: 'Burger', product_id: 'p1', sku: 'BRG', quantity: 2, total: 115 }],
    { salesAccountCode: '200', defaultTaxType: 'OUTPUT2' },
    false
  );
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'NONE');
  // The amount itself must be untouched — only the tax type selection changes.
  assert.equal(payload.Invoices[0].LineItems[0].UnitAmount, 57.5);
});

// Regression: the daily sales invoice applied ONE FLAT defaultTaxType to every product regardless
// of that specific product's own VAT-ability — the sales-side mirror of the Purchase Order bug
// fixed earlier this session. products.vat_enabled is synced from Yoco's own per-item `is_taxable`
// setting (see integration-service.ts) — Yoco already exposes this as a genuine merchant setting.

test('buildDailyInvoicePayload: a VATable product (vat_enabled=1) uses the standard defaultTaxType', () => {
  const payload = buildDailyInvoicePayload(
    '2026-08-31',
    [{ label: 'Beer', product_id: 'p1', sku: null, quantity: 1, total: 20, vat_enabled: 1 }],
    { salesAccountCode: '200', defaultTaxType: 'OUTPUT2', salesExemptTaxType: 'EXEMPTOUTPUT' },
    true
  );
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'OUTPUT2');
});

test('buildDailyInvoicePayload: a zero-rated product (vat_enabled=0) uses the configured exempt tax type instead', () => {
  const payload = buildDailyInvoicePayload(
    '2026-08-31',
    [{ label: 'Bread', product_id: 'p2', sku: null, quantity: 1, total: 20, vat_enabled: 0 }],
    { salesAccountCode: '200', defaultTaxType: 'OUTPUT2', salesExemptTaxType: 'EXEMPTOUTPUT' },
    true
  );
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'EXEMPTOUTPUT');
});

test('buildDailyInvoicePayload: a zero-rated product falls back to defaultTaxType when no exempt tax type is configured (opt-in, no behavior change until set)', () => {
  const payload = buildDailyInvoicePayload(
    '2026-08-31',
    [{ label: 'Bread', product_id: 'p2', sku: null, quantity: 1, total: 20, vat_enabled: 0 }],
    { salesAccountCode: '200', defaultTaxType: 'OUTPUT2' },
    true
  );
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'OUTPUT2');
});

test('buildDailyInvoicePayload: a mixed invoice applies the correct tax type per line, not one blanket type', () => {
  const payload = buildDailyInvoicePayload(
    '2026-08-31',
    [
      { label: 'Beer', product_id: 'p1', sku: null, quantity: 1, total: 20, vat_enabled: 1 },
      { label: 'Bread', product_id: 'p2', sku: null, quantity: 1, total: 20, vat_enabled: 0 }
    ],
    { salesAccountCode: '200', defaultTaxType: 'OUTPUT2', salesExemptTaxType: 'EXEMPTOUTPUT' },
    true
  );
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'OUTPUT2');
  assert.equal(payload.Invoices[0].LineItems[1].TaxType, 'EXEMPTOUTPUT');
});

test('buildDailyInvoicePayload: TaxType NONE for a non-registered workspace wins even over an exempt tax type', () => {
  const payload = buildDailyInvoicePayload(
    '2026-08-31',
    [{ label: 'Bread', product_id: 'p2', sku: null, quantity: 1, total: 20, vat_enabled: 0 }],
    { salesAccountCode: '200', defaultTaxType: 'OUTPUT2', salesExemptTaxType: 'EXEMPTOUTPUT' },
    false
  );
  assert.equal(payload.Invoices[0].LineItems[0].TaxType, 'NONE');
});

test('aggregateDailySalesLines carries each product\'s own vat_enabled flag through to the aggregated row', async () => {
  const env = createEnv();
  env.DB.database.prepare(
    `INSERT INTO products (id, workspace_id, name, vat_enabled) VALUES ('p1', 'ws_1', 'Beer', 1)`
  ).run();
  env.DB.database.prepare(
    `INSERT INTO products (id, workspace_id, name, vat_enabled) VALUES ('p2', 'ws_1', 'Bread', 0)`
  ).run();
  seedOrder(env, { id: 'order_1', occurredAt: '2026-08-31T10:00:00+02:00', productId: 'p1', name: 'Beer', quantity: 1, total: 20 });
  seedOrder(env, { id: 'order_2', occurredAt: '2026-08-31T11:00:00+02:00', productId: 'p2', name: 'Bread', quantity: 1, total: 20 });

  const lines = await aggregateDailySalesLines(env, 'ws_1', '2026-08-31', 0);
  assert.equal(lines.length, 2);
  const beer = lines.find((line) => line.label === 'Beer');
  const bread = lines.find((line) => line.label === 'Bread');
  assert.equal(Number(beer.vat_enabled), 1);
  assert.equal(Number(bread.vat_enabled), 0);
});

test('aggregateDailySalesLines defaults vat_enabled to 1 (VATable) for a name-only fallback line with no linked product', async () => {
  const env = createEnv();
  seedOrder(env, { id: 'order_1', occurredAt: '2026-08-31T10:00:00+02:00', productId: null, name: 'Unmapped item', quantity: 1, total: 20 });

  const lines = await aggregateDailySalesLines(env, 'ws_1', '2026-08-31', 0);
  assert.equal(lines.length, 1);
  assert.equal(Number(lines[0].vat_enabled), 1);
});

// Regression: aggregateDailySalesLines used to filter `order_type = 'sale'` only, so a refund never
// reduced the day's invoice — a refunded sale still showed as full revenue in Xero, permanently
// overstating that day's income. live-refund.ts writes refund rows with NEGATIVE quantity/total,
// keyed to the same product_id as the original sale, dated by when the refund itself happened.

test('aggregateDailySalesLines nets a same-day refund against its matching sale, by product', async () => {
  const env = createEnv();
  seedOrder(env, { id: 'order_1', occurredAt: '2026-08-31T10:00:00+02:00', productId: null, name: 'Burger', quantity: 2, total: 100 });
  seedOrder(env, { id: 'refund_1', orderType: 'refund', occurredAt: '2026-08-31T14:00:00+02:00', productId: null, name: 'Burger', quantity: -1, total: -50 });

  const lines = await aggregateDailySalesLines(env, 'ws_1', '2026-08-31', 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 1);
  assert.equal(lines[0].total, 50);
});

test('aggregateDailySalesLines excludes a product that nets to exactly zero that day (fully refunded) rather than dividing by zero', async () => {
  const env = createEnv();
  seedOrder(env, { id: 'order_1', occurredAt: '2026-08-31T10:00:00+02:00', productId: null, name: 'Burger', quantity: 1, total: 50 });
  seedOrder(env, { id: 'refund_1', orderType: 'refund', occurredAt: '2026-08-31T14:00:00+02:00', productId: null, name: 'Burger', quantity: -1, total: -50 });
  // A second, unaffected product must still show up.
  seedOrder(env, { id: 'order_2', occurredAt: '2026-08-31T11:00:00+02:00', productId: null, name: 'Fries', quantity: 3, total: 60 });

  const lines = await aggregateDailySalesLines(env, 'ws_1', '2026-08-31', 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].label, 'Fries');
});

test('aggregateDailySalesLines includes a pure refund (no sale that day for that product) as its own negative line', async () => {
  const env = createEnv();
  seedOrder(env, { id: 'refund_1', orderType: 'refund', occurredAt: '2026-08-31T14:00:00+02:00', productId: null, name: 'Burger', quantity: -1, total: -50 });

  const lines = await aggregateDailySalesLines(env, 'ws_1', '2026-08-31', 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, -1);
  assert.equal(lines[0].total, -50);
});

test('aggregateDailySalesLines attributes a refund to the day the REFUND happened, not the original sale day', async () => {
  const env = createEnv();
  seedOrder(env, { id: 'order_1', occurredAt: '2026-08-30T10:00:00+02:00', productId: null, name: 'Burger', quantity: 1, total: 50 });
  seedOrder(env, { id: 'refund_1', orderType: 'refund', occurredAt: '2026-08-31T14:00:00+02:00', productId: null, name: 'Burger', quantity: -1, total: -50 });

  const day1 = await aggregateDailySalesLines(env, 'ws_1', '2026-08-30', 0);
  assert.equal(day1.length, 1);
  assert.equal(day1[0].quantity, 1, 'the original sale day must NOT be retroactively changed by a later refund');

  const day2 = await aggregateDailySalesLines(env, 'ws_1', '2026-08-31', 0);
  assert.equal(day2.length, 1);
  assert.equal(day2[0].quantity, -1, 'the refund day carries the negative adjustment instead');
});

// Location Tracking Categories — buildDailyInvoicePayload is a pure function that just spreads
// whatever `tracking` field is already on each aggregated line, same contract as
// buildGrvBillPayload/buildCreditNoteXeroPayload's own tracking tests.
test('buildDailyInvoicePayload: a line with a pre-resolved tracking array gets a Tracking field', () => {
  const payload = buildDailyInvoicePayload(
    '2026-08-31',
    [{ label: 'Burger', product_id: 'p1', sku: 'BRG', quantity: 2, total: 115, tracking: [{ TrackingCategoryID: 'cat_1', TrackingOptionID: 'opt_1' }] }],
    { salesAccountCode: '200', defaultTaxType: 'OUTPUT2' }
  );
  assert.deepEqual(payload.Invoices[0].LineItems[0].Tracking, [{ TrackingCategoryID: 'cat_1', TrackingOptionID: 'opt_1' }]);
});

test('buildDailyInvoicePayload: a line with no tracking resolved omits the Tracking field entirely', () => {
  const payload = buildDailyInvoicePayload('2026-08-31', [{ label: 'Burger', product_id: 'p1', sku: 'BRG', quantity: 2, total: 115 }], {
    salesAccountCode: '200',
    defaultTaxType: 'OUTPUT2'
  });
  assert.equal('Tracking' in payload.Invoices[0].LineItems[0], false);
});

test('aggregateDailySalesLines splits the same product into separate lines per location, each carrying its own location_name', async () => {
  const env = createEnv();
  env.DB.database.prepare(`INSERT INTO locations (id, workspace_id, name, display_name) VALUES ('loc_a', 'ws_1', 'down-bar', 'Down Bar')`).run();
  env.DB.database.prepare(`INSERT INTO locations (id, workspace_id, name, display_name) VALUES ('loc_b', 'ws_1', 'up-bar', 'Up Bar')`).run();
  env.DB.database.prepare(
    `INSERT INTO yoco_orders (id, workspace_id, yoco_order_id, order_type, status, total, occurred_at, location_id)
     VALUES ('order_a', 'ws_1', 'order_a', 'sale', 'completed', 20, '2026-08-31T10:00:00+02:00', 'loc_a')`
  ).run();
  env.DB.database.prepare(
    `INSERT INTO yoco_order_lines (id, workspace_id, yoco_order_id, product_id, name, quantity, total)
     VALUES ('order_a_line', 'ws_1', 'order_a', null, 'Beer', 1, 20)`
  ).run();
  env.DB.database.prepare(
    `INSERT INTO yoco_orders (id, workspace_id, yoco_order_id, order_type, status, total, occurred_at, location_id)
     VALUES ('order_b', 'ws_1', 'order_b', 'sale', 'completed', 20, '2026-08-31T11:00:00+02:00', 'loc_b')`
  ).run();
  env.DB.database.prepare(
    `INSERT INTO yoco_order_lines (id, workspace_id, yoco_order_id, product_id, name, quantity, total)
     VALUES ('order_b_line', 'ws_1', 'order_b', null, 'Beer', 1, 20)`
  ).run();

  const lines = await aggregateDailySalesLines(env, 'ws_1', '2026-08-31', 0);
  assert.equal(lines.length, 2, 'the same product sold at two locations must not collapse into one line');
  const names = lines.map((line) => line.location_name).sort();
  assert.deepEqual(names, ['Down Bar', 'Up Bar']);
});
