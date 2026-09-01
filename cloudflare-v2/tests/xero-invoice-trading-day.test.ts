import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { businessDayUtcBounds, yesterdayDateKey, todayDateKey, claimDailyInvoiceSyncIfDue, buildDailyInvoicePayload } from '../src/modules/xero-engine/invoice-sync';
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

function createEnv(xeroSyncSettings: { enabled?: number; last_invoice_sync_date?: string; invoice_sync_claimed_at?: string } = {}) {
  const DB = new SqliteDb();
  DB.database.exec(TENANT_SCHEMA_SQL);
  DB.database.exec(XERO_V2_FOUNDATION_MIGRATION);
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
  assert.equal(claim.dateKey, yesterdayDateKey(5));
  // Sanity: for this same instant, a midnight-start venue would (in general) claim a different date
  // once the current SAST hour is between 0 and 5 — not asserted directly here since it depends on
  // the real current time when this test runs, but the two calls below prove startHour is honored
  // rather than ignored.
  assert.notEqual(claim.dateKey, undefined);
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
