import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { TENANT_SCHEMA_SQL } from '../src/tenant-schema.generated';
import type { DbLike, DbResult, DbStatementLike } from '../src/legacy/types';
import { XERO_V2_FOUNDATION_MIGRATION, XERO_V2_GRV_PUSH_MIGRATION, XERO_V2_CREDIT_NOTE_PUSH_MIGRATION } from '../src/modules/xero-engine/migrations';
import { GRV_TRANSPORT_EX_MIGRATION, GRV_DISCOUNT_EX_MIGRATION, GRV_CREDIT_NOTE_EDIT_MIGRATION } from '../src/tenant-migrations';
import { loadPendingGrvs, findLatestAppliedGrvXeroBillId, buildGrvBillPayload } from '../src/modules/xero-engine/grv-sync';
import { loadPendingCreditNotes, findLatestAppliedCreditNoteXeroId, buildCreditNoteXeroPayload } from '../src/modules/xero-engine/credit-note-sync';

// Phase 3: once a GRV/Credit Note can be edited after posting (Phase 1), the Xero push has to
// become re-sync-aware — an edit must eventually reach an already-created Bill/CreditNote as an
// UPDATE, not be silently ignored forever (the old effect-outbox scheme permanently excluded any
// document whose bare effect_key was already APPLIED, with no way to un-exclude it) and not create
// a duplicate. The fix keys GRV_PUSH/CREDIT_NOTE_PUSH effect_key on `version` — but ONLY once
// version > 1, so every already-pushed, never-edited document (version defaults to 1 for all of
// them, tenant-migrations.ts migration 54) keeps its exact pre-existing bare key and behavior.

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

function createEnv() {
  const DB = new SqliteDb();
  DB.database.exec(TENANT_SCHEMA_SQL);
  DB.database.exec(XERO_V2_FOUNDATION_MIGRATION);
  DB.database.exec(XERO_V2_GRV_PUSH_MIGRATION);
  DB.database.exec(XERO_V2_CREDIT_NOTE_PUSH_MIGRATION);
  DB.database.exec(GRV_TRANSPORT_EX_MIGRATION);
  DB.database.exec(GRV_DISCOUNT_EX_MIGRATION);
  DB.database.exec(GRV_CREDIT_NOTE_EDIT_MIGRATION);
  return { DB } as any;
}

function insertGrv(env: any, id: string, receivedAt: string, version = 1) {
  env.DB.database.prepare(
    `INSERT INTO grvs (id, workspace_id, invoice_number, received_at, total_ex, total_vat, total_inc, raw_json, created_at, version)
     VALUES (?1, 'ws_1', ?1, ?2, 100, 15, 115, '{}', ?2, ?3)`
  ).run(id, receivedAt, version);
}

function insertAppliedOutbox(env: any, effectType: string, effectKey: string, xeroObjectId: string, updatedAt: string) {
  env.DB.database.prepare(
    `INSERT INTO xero_v2_effect_outbox (id, workspace_id, effect_type, effect_key, status, xero_object_id, attempt_count, created_at, updated_at)
     VALUES (?1, 'ws_1', ?2, ?3, 'APPLIED', ?4, 1, ?5, ?5)`
  ).run(`outbox_${effectKey}`, effectType, effectKey, xeroObjectId, updatedAt);
}

test('GRV backward compat: a never-edited GRV (version 1) already applied under the OLD bare key stays excluded', async () => {
  const env = createEnv();
  insertGrv(env, 'grv_a', '2026-08-01T00:00:00.000Z', 1);
  insertAppliedOutbox(env, 'GRV_PUSH', 'grv:ws_1:grv_a', 'xero_bill_1', '2026-08-01T00:00:00.000Z');

  const pending = await loadPendingGrvs(env, 'ws_1', 10);
  assert.deepEqual(pending, []);
});

test('GRV re-sync: editing a GRV (version bumped to 2) makes it pending again, even though version 1 already applied', async () => {
  const env = createEnv();
  insertGrv(env, 'grv_a', '2026-08-01T00:00:00.000Z', 2);
  // The original push, before the edit, applied under the bare (v1) key.
  insertAppliedOutbox(env, 'GRV_PUSH', 'grv:ws_1:grv_a', 'xero_bill_1', '2026-08-01T00:00:00.000Z');

  const pending = await loadPendingGrvs(env, 'ws_1', 10);
  assert.deepEqual(pending.map((grv) => grv.id), ['grv_a']);
});

test('GRV re-sync: once the v2 push itself applies, it is excluded again — no infinite re-push loop', async () => {
  const env = createEnv();
  insertGrv(env, 'grv_a', '2026-08-01T00:00:00.000Z', 2);
  insertAppliedOutbox(env, 'GRV_PUSH', 'grv:ws_1:grv_a', 'xero_bill_1', '2026-08-01T00:00:00.000Z');
  insertAppliedOutbox(env, 'GRV_PUSH', 'grv:ws_1:grv_a:v2', 'xero_bill_1', '2026-08-02T00:00:00.000Z');

  const pending = await loadPendingGrvs(env, 'ws_1', 10);
  assert.deepEqual(pending, []);
});

test('findLatestAppliedGrvXeroBillId: returns the bare-key Bill ID when the GRV was never edited', async () => {
  const env = createEnv();
  insertAppliedOutbox(env, 'GRV_PUSH', 'grv:ws_1:grv_a', 'xero_bill_1', '2026-08-01T00:00:00.000Z');

  const billId = await findLatestAppliedGrvXeroBillId(env, 'ws_1', 'grv_a');
  assert.equal(billId, 'xero_bill_1');
});

test('findLatestAppliedGrvXeroBillId: after an edit, returns the ORIGINAL Bill ID (found via the old bare key) so the re-push updates the same Bill', async () => {
  const env = createEnv();
  insertAppliedOutbox(env, 'GRV_PUSH', 'grv:ws_1:grv_a', 'xero_bill_1', '2026-08-01T00:00:00.000Z');
  // Not applied yet — the v2 push hasn't run. The lookup must still find the v1 Bill ID.
  const billId = await findLatestAppliedGrvXeroBillId(env, 'ws_1', 'grv_a');
  assert.equal(billId, 'xero_bill_1');
});

test('findLatestAppliedGrvXeroBillId: across several edits, returns the MOST RECENT applied Bill ID', async () => {
  const env = createEnv();
  insertAppliedOutbox(env, 'GRV_PUSH', 'grv:ws_1:grv_a', 'xero_bill_1', '2026-08-01T00:00:00.000Z');
  insertAppliedOutbox(env, 'GRV_PUSH', 'grv:ws_1:grv_a:v2', 'xero_bill_1', '2026-08-02T00:00:00.000Z');
  insertAppliedOutbox(env, 'GRV_PUSH', 'grv:ws_1:grv_a:v3', 'xero_bill_1', '2026-08-03T00:00:00.000Z');

  const billId = await findLatestAppliedGrvXeroBillId(env, 'ws_1', 'grv_a');
  assert.equal(billId, 'xero_bill_1');
});

test('findLatestAppliedGrvXeroBillId: a GRV never pushed returns null (a genuine first push, not an update)', async () => {
  const env = createEnv();
  const billId = await findLatestAppliedGrvXeroBillId(env, 'ws_1', 'grv_never_pushed');
  assert.equal(billId, null);
});

const RATE = 0.15;

function grv(overrides: Partial<Parameters<typeof buildGrvBillPayload>[0]> = {}) {
  return {
    id: 'grv_123456',
    supplier_id: 'sup_1',
    supplier_name: 'Test Supplier',
    supplier_xero_contact_id: null,
    invoice_number: 'INV-001',
    received_at: '2026-08-31T00:00:00.000Z',
    prices_include_vat: 0,
    total_ex: 100,
    total_vat: 15,
    total_inc: 115,
    raw_json: null,
    ...overrides
  };
}

test('buildGrvBillPayload: existingBillId sets InvoiceID, turning the push into a Xero update', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };
  const lines = [{ stock_item_id: 'si_1', stock_item_name: 'Flour', quantity: 10, unit_price: 10, total_vat: 15 }];

  const created = buildGrvBillPayload(grv(), lines, 'contact_1', settings, true, RATE, true);
  const updated = buildGrvBillPayload(grv(), lines, 'contact_1', settings, true, RATE, true, 'xero_bill_existing');

  assert.equal((created.Invoices[0] as Record<string, unknown>).InvoiceID, undefined);
  assert.equal((updated.Invoices[0] as Record<string, unknown>).InvoiceID, 'xero_bill_existing');
});

// --- Credit notes: same behavior, mirrored ---

function insertCreditNote(env: any, id: string, creditedAt: string, version = 1) {
  env.DB.database.prepare(
    `INSERT INTO credit_notes (id, workspace_id, credit_note_number, credited_at, total_ex, raw_json, created_at, updated_at, version)
     VALUES (?1, 'ws_1', ?1, ?2, 100, '{}', ?2, ?2, ?3)`
  ).run(id, creditedAt, version);
}

test('Credit note backward compat: a never-edited credit note (version 1) already applied under the OLD bare key stays excluded', async () => {
  const env = createEnv();
  insertCreditNote(env, 'cn_a', '2026-08-01T00:00:00.000Z', 1);
  insertAppliedOutbox(env, 'CREDIT_NOTE_PUSH', 'credit-note:ws_1:cn_a', 'xero_cn_1', '2026-08-01T00:00:00.000Z');

  const pending = await loadPendingCreditNotes(env, 'ws_1', 10);
  assert.deepEqual(pending, []);
});

test('Credit note re-sync: editing (version bumped to 2) makes it pending again', async () => {
  const env = createEnv();
  insertCreditNote(env, 'cn_a', '2026-08-01T00:00:00.000Z', 2);
  insertAppliedOutbox(env, 'CREDIT_NOTE_PUSH', 'credit-note:ws_1:cn_a', 'xero_cn_1', '2026-08-01T00:00:00.000Z');

  const pending = await loadPendingCreditNotes(env, 'ws_1', 10);
  assert.deepEqual(pending.map((cn) => cn.id), ['cn_a']);
});

test('findLatestAppliedCreditNoteXeroId: returns the bare-key CreditNote ID when never edited, and null when never pushed', async () => {
  const env = createEnv();
  insertAppliedOutbox(env, 'CREDIT_NOTE_PUSH', 'credit-note:ws_1:cn_a', 'xero_cn_1', '2026-08-01T00:00:00.000Z');

  assert.equal(await findLatestAppliedCreditNoteXeroId(env, 'ws_1', 'cn_a'), 'xero_cn_1');
  assert.equal(await findLatestAppliedCreditNoteXeroId(env, 'ws_1', 'cn_never_pushed'), null);
});

function creditNote(overrides: Partial<Parameters<typeof buildCreditNoteXeroPayload>[0]> = {}) {
  return {
    id: 'cn_123456',
    supplier_id: 'sup_1',
    supplier_name: 'Test Supplier',
    supplier_xero_contact_id: null,
    supplier_raw_json: null,
    credit_note_number: 'CN-001',
    credited_at: '2026-08-31T00:00:00.000Z',
    ...overrides
  };
}

test('buildCreditNoteXeroPayload: existingCreditNoteId sets CreditNoteID, turning the push into a Xero update', () => {
  const settings = { purchaseAccountCode: '310', purchaseTaxType: 'INPUT2', purchaseExemptTaxType: '' };

  const created = buildCreditNoteXeroPayload(creditNote(), [], 'contact_1', settings, true, RATE, true);
  const updated = buildCreditNoteXeroPayload(creditNote(), [], 'contact_1', settings, true, RATE, true, 'xero_cn_existing');

  assert.equal((created.CreditNotes[0] as Record<string, unknown>).CreditNoteID, undefined);
  assert.equal((updated.CreditNotes[0] as Record<string, unknown>).CreditNoteID, 'xero_cn_existing');
});
