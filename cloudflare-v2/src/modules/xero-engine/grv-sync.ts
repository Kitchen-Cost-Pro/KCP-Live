import type { Env } from '../../legacy/types';
import { text, objectValue, nowIso } from './config';
import { executeXeroApiRequest, executeXeroBinaryPutRequest, XeroApiClientError } from './api-client';
import { claimXeroEffect, markXeroEffectApplied, markXeroEffectFailed } from './outbox';
import { recordXeroDiagnosticIfNotable } from './observability';
import { yesterdayDateKey } from './invoice-sync';
import { grvToPdfBytes } from '../../../../src/modules/reporting/exports/exportPdf.js';

export { yesterdayDateKey };

// Prefixes a GRV_PUSH outbox failure so postDueCheck/the UI can tell "no supplier mapping yet"
// (expected, self-resolves once the user matches/creates a Xero contact) apart from a genuine Xero
// API failure worth alerting on.
const NEEDS_SUPPLIER_MATCH_PREFIX = 'NEEDS_SUPPLIER_MATCH:';

interface GrvRow {
  id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_xero_contact_id: string | null;
  invoice_number: string | null;
  received_at: string;
  prices_include_vat: number | null;
  total_ex: number | null;
  total_vat: number | null;
  total_inc: number | null;
  raw_json: string | null;
}

interface GrvLineItem {
  stockItemName?: string;
  stockItemId?: string;
  receivedQty?: number;
  qty?: number;
  selectedUom?: string;
  unit?: string;
  unitCost?: number;
  lineTotalEx?: number;
}

function parseGrvRawJson(raw: string | null): { items: GrvLineItem[] } {
  if (!raw) return { items: [] };
  try {
    const parsed = objectValue(JSON.parse(raw));
    const items = Array.isArray(parsed.items) ? (parsed.items as GrvLineItem[]) : [];
    return { items };
  } catch {
    return { items: [] };
  }
}

/**
 * Every GRV that's never successfully pushed, regardless of which business day it fell on — used
 * by both the automatic daily due-check and the manual "Sync GRVs now" button. Deliberately NOT
 * date-bounded to "yesterday": a GRV whose supplier had no Xero contact match yesterday needs to be
 * retried on a LATER day's due-check once the user resolves that match (see resolveSupplierMatch),
 * and a date-bounded scan would only ever look at the one day it was first seen. The per-GRV outbox
 * (GRV_PUSH effect) is what keeps this idempotent, not the date bound.
 */
async function loadPendingGrvs(env: Env, workspaceId: string, limit = 500): Promise<GrvRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       grv.id, grv.supplier_id, s.name AS supplier_name, s.xero_contact_id AS supplier_xero_contact_id,
       grv.invoice_number, grv.received_at, grv.prices_include_vat, grv.total_ex, grv.total_vat, grv.total_inc, grv.raw_json
     FROM grvs grv
     LEFT JOIN suppliers s ON s.id = grv.supplier_id AND s.workspace_id = grv.workspace_id
     WHERE grv.workspace_id = ?1
       AND NOT EXISTS (
         SELECT 1 FROM xero_v2_effect_outbox o
          WHERE o.workspace_id = grv.workspace_id AND o.effect_type = 'GRV_PUSH'
            AND o.effect_key = 'grv:' || grv.workspace_id || ':' || grv.id AND o.status = 'APPLIED'
       )
     ORDER BY grv.received_at ASC
     LIMIT ?2`
  )
    .bind(workspaceId, limit)
    .all<GrvRow>();
  return rows.results || [];
}

/**
 * Resolves a supplier's Xero Contact by exact name match (a read + link, not a write — so it
 * doesn't need the "ask before creating" confirmation). Returns null if the supplier has no name,
 * or Xero has zero/multiple matches — the caller records that as a pending supplier match instead
 * of treating it as an API failure.
 */
export async function resolveXeroContactForSupplier(
  env: Env,
  workspaceId: string,
  supplier: { id: string; name: string | null; xeroContactId: string | null }
): Promise<string | null> {
  if (supplier.xeroContactId) return supplier.xeroContactId;
  const name = text(supplier.name);
  if (!name) return null;
  const escaped = name.replace(/"/g, '\\"');
  const result = await executeXeroApiRequest(env, workspaceId, {
    method: 'GET',
    path: `Contacts?where=${encodeURIComponent(`Name=="${escaped}"`)}`
  });
  const contacts = (result.Contacts as Array<{ ContactID?: string }> | undefined) || [];
  if (contacts.length !== 1) return null;
  const contactId = text(contacts[0]?.ContactID);
  if (!contactId) return null;
  await env.DB.prepare(`UPDATE suppliers SET xero_contact_id = ?3, xero_contact_synced_at = ?4 WHERE id = ?1 AND workspace_id = ?2`)
    .bind(supplier.id, workspaceId, contactId, nowIso())
    .run();
  return contactId;
}

function buildGrvBillPayload(
  grv: GrvRow,
  items: GrvLineItem[],
  contactId: string,
  settings: { purchaseAccountCode: string; purchaseTaxType: string },
  existingBillId?: string
) {
  return {
    Invoices: [
      {
        ...(existingBillId ? { InvoiceID: existingBillId } : {}),
        Type: 'ACCPAY',
        Contact: { ContactID: contactId },
        Date: text(grv.received_at).slice(0, 10),
        Reference: text(grv.invoice_number) || `GRV-${grv.id.slice(-6).toUpperCase()}`,
        Status: 'DRAFT',
        LineAmountTypes: grv.prices_include_vat ? 'Inclusive' : 'Exclusive',
        LineItems: (items.length
          ? items
          : [{ stockItemName: 'Goods received', receivedQty: 1, unitCost: grv.total_ex || 0 }]
        ).map((line) => ({
          Description: text(line.stockItemName) || text(line.stockItemId) || 'Goods received',
          Quantity: Number(line.receivedQty ?? line.qty) || 1,
          UnitAmount: Number(line.unitCost) || 0,
          AccountCode: settings.purchaseAccountCode,
          TaxType: settings.purchaseTaxType
        }))
      }
    ]
  };
}

async function pushGrvAttachment(env: Env, workspaceId: string, grv: GrvRow, billId: string): Promise<void> {
  const effectKey = `grv-attachment:${workspaceId}:${grv.id}`;
  const claim = await claimXeroEffect(env, workspaceId, 'GRV_ATTACHMENT', effectKey);
  if (claim.alreadyApplied) return;
  try {
    const { items } = parseGrvRawJson(grv.raw_json);
    const bytes = await grvToPdfBytes({
      id: grv.id,
      grvNumber: grv.invoice_number,
      invoice: grv.invoice_number,
      supplierName: grv.supplier_name,
      date: grv.received_at,
      items,
      totalEx: grv.total_ex,
      totalVat: grv.total_vat,
      totalInc: grv.total_inc
    });
    const fileName = `${text(grv.invoice_number) || `GRV-${grv.id.slice(-6).toUpperCase()}`}.pdf`;
    await executeXeroBinaryPutRequest(env, workspaceId, { invoiceId: billId, fileName, bytes, contentType: 'application/pdf' });
    await markXeroEffectApplied(env, claim.id, billId);
  } catch (cause) {
    const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error attaching GRV PDF to Xero.';
    await markXeroEffectFailed(env, claim.id, message);
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-grv-attachment', status: 'failed', message, details: { grvId: grv.id, billId } });
  }
}

async function pushOneGrv(
  env: Env,
  workspaceId: string,
  grv: GrvRow,
  settings: { purchaseAccountCode: string; purchaseTaxType: string }
): Promise<'applied' | 'duplicate' | 'needs_supplier_match' | 'failed'> {
  const effectKey = `grv:${workspaceId}:${grv.id}`;
  const claim = await claimXeroEffect(env, workspaceId, 'GRV_PUSH', effectKey);
  if (claim.alreadyApplied) return 'duplicate';

  let contactId: string | null = null;
  try {
    contactId = await resolveXeroContactForSupplier(env, workspaceId, {
      id: text(grv.supplier_id),
      name: grv.supplier_name,
      xeroContactId: grv.supplier_xero_contact_id
    });
  } catch (cause) {
    const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error resolving Xero contact.';
    await markXeroEffectFailed(env, claim.id, message);
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-grv-push', status: 'failed', message, details: { grvId: grv.id } });
    return 'failed';
  }

  if (!contactId) {
    // Not a real failure — surfaced in the "needs attention" list instead of the diagnostic log,
    // and picked up automatically once the user matches/creates the supplier's Xero contact.
    await markXeroEffectFailed(env, claim.id, `${NEEDS_SUPPLIER_MATCH_PREFIX}${text(grv.supplier_id)}`);
    return 'needs_supplier_match';
  }

  try {
    const { items } = parseGrvRawJson(grv.raw_json);
    const payload = buildGrvBillPayload(grv, items, contactId, settings);
    const result = await executeXeroApiRequest(env, workspaceId, { method: 'POST', path: 'Invoices', body: payload });
    const invoices = (result.Invoices as Array<{ InvoiceID?: string }> | undefined) || [];
    const billId = text(invoices[0]?.InvoiceID);
    await markXeroEffectApplied(env, claim.id, billId);
    if (billId) await pushGrvAttachment(env, workspaceId, grv, billId);
    return 'applied';
  } catch (cause) {
    const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error pushing GRV to Xero.';
    await markXeroEffectFailed(env, claim.id, message);
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-grv-push', status: 'failed', message, details: { grvId: grv.id } });
    return 'failed';
  }
}

/** Shared by the automatic daily due-check and the manual "Sync GRVs now" button — see
 * loadPendingGrvs for why this isn't date-bounded. */
export async function syncPendingXeroGrvs(
  env: Env,
  workspaceId: string,
  settings: { purchaseAccountCode: string; purchaseTaxType: string }
): Promise<{ applied: number; duplicate: number; needsSupplierMatch: number; failed: number }> {
  const grvs = await loadPendingGrvs(env, workspaceId);
  const counts = { applied: 0, duplicate: 0, needsSupplierMatch: 0, failed: 0 };
  for (const grv of grvs) {
    const outcome = await pushOneGrv(env, workspaceId, grv, settings);
    if (outcome === 'applied') counts.applied += 1;
    else if (outcome === 'duplicate') counts.duplicate += 1;
    else if (outcome === 'needs_supplier_match') counts.needsSupplierMatch += 1;
    else counts.failed += 1;
  }
  return counts;
}

export async function claimDailyGrvSyncIfDue(env: Env, workspaceId: string): Promise<{ due: boolean; dateKey?: string }> {
  const dateKey = yesterdayDateKey();
  const now = nowIso();
  const settings = await env.DB.prepare(`SELECT last_grv_sync_date, grv_sync_claimed_at, grv_sync_enabled FROM xero_sync_settings WHERE workspace_id = ?1`)
    .bind(workspaceId)
    .first<{ last_grv_sync_date?: string; grv_sync_claimed_at?: string; grv_sync_enabled?: number }>();
  if (!settings || !settings.grv_sync_enabled) return { due: false };
  if (settings.last_grv_sync_date === dateKey) return { due: false };
  const claimedAt = settings.grv_sync_claimed_at ? new Date(settings.grv_sync_claimed_at).getTime() : 0;
  if (claimedAt && Date.now() - claimedAt < 60 * 60 * 1000) return { due: false };
  await env.DB.prepare(`UPDATE xero_sync_settings SET grv_sync_claimed_at = ?2, updated_at = ?2 WHERE workspace_id = ?1`)
    .bind(workspaceId, now)
    .run();
  return { due: true, dateKey };
}

export async function releaseDailyGrvSyncClaim(env: Env, workspaceId: string, dateKey: string, success: boolean): Promise<void> {
  const now = nowIso();
  if (success) {
    await env.DB.prepare(
      `UPDATE xero_sync_settings SET last_grv_sync_date = ?2, grv_sync_claimed_at = NULL, updated_at = ?3 WHERE workspace_id = ?1`
    )
      .bind(workspaceId, dateKey, now)
      .run();
  } else {
    await env.DB.prepare(`UPDATE xero_sync_settings SET grv_sync_claimed_at = NULL, updated_at = ?2 WHERE workspace_id = ?1`)
      .bind(workspaceId, now)
      .run();
  }
}

export interface PendingSupplierMatch {
  supplierId: string;
  supplierName: string;
  grvCount: number;
}

/** Backing query for the "needs attention" UI list — GRV_PUSH failures coded as a pending
 * supplier match, not a real API error. */
export async function listPendingSupplierMatches(env: Env, workspaceId: string): Promise<PendingSupplierMatch[]> {
  const rows = await env.DB.prepare(
    `SELECT
       substr(o.last_error, ${NEEDS_SUPPLIER_MATCH_PREFIX.length + 1}) AS supplier_id,
       COALESCE(s.name, 'Unknown supplier') AS supplier_name,
       COUNT(*) AS grv_count
     FROM xero_v2_effect_outbox o
     LEFT JOIN suppliers s ON s.id = substr(o.last_error, ${NEEDS_SUPPLIER_MATCH_PREFIX.length + 1}) AND s.workspace_id = o.workspace_id
     WHERE o.workspace_id = ?1 AND o.effect_type = 'GRV_PUSH' AND o.status = 'FAILED'
       AND o.last_error LIKE '${NEEDS_SUPPLIER_MATCH_PREFIX}%'
     GROUP BY supplier_id, supplier_name`
  )
    .bind(workspaceId)
    .all<{ supplier_id: string; supplier_name: string; grv_count: number }>();
  return (rows.results || []).map((row) => ({ supplierId: row.supplier_id, supplierName: row.supplier_name, grvCount: Number(row.grv_count) || 0 }));
}

/**
 * Re-claims every GRV_PUSH outbox row that failed against this supplier for the coded
 * "needs a match" reason, so the next due-check (or the caller, immediately) retries them now that
 * the supplier has a Xero contact linked.
 */
async function requeueGrvPushesForSupplier(env: Env, workspaceId: string, supplierId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE xero_v2_effect_outbox SET status = 'PROCESSING', updated_at = ?3
      WHERE workspace_id = ?1 AND effect_type = 'GRV_PUSH' AND status = 'FAILED'
        AND last_error = ?2`
  )
    .bind(workspaceId, `${NEEDS_SUPPLIER_MATCH_PREFIX}${supplierId}`, nowIso())
    .run();
}

/** POST xero/resolve-supplier-match — either maps to an existing Xero Contact the user picked, or
 * creates a new one, per the "match by name, ask before creating" answer: the daily job never
 * creates a Contact on its own, only this explicit, human-confirmed action does. */
export async function resolveSupplierMatch(
  env: Env,
  workspaceId: string,
  input: { supplierId: string; xeroContactId?: string; createNew?: boolean }
): Promise<{ ok: true; contactId: string } | { ok: false; error: string }> {
  const supplier = await env.DB.prepare(`SELECT id, name FROM suppliers WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`)
    .bind(input.supplierId, workspaceId)
    .first<{ id: string; name: string }>();
  if (!supplier) return { ok: false, error: 'Supplier not found.' };

  let contactId = text(input.xeroContactId);
  if (!contactId && input.createNew) {
    try {
      const result = await executeXeroApiRequest(env, workspaceId, {
        method: 'POST',
        path: 'Contacts',
        body: { Contacts: [{ Name: text(supplier.name) }] }
      });
      const contacts = (result.Contacts as Array<{ ContactID?: string }> | undefined) || [];
      contactId = text(contacts[0]?.ContactID);
    } catch (cause) {
      const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error creating the Xero contact.';
      return { ok: false, error: message };
    }
  }
  if (!contactId) return { ok: false, error: 'A Xero contact ID or createNew is required.' };

  await env.DB.prepare(`UPDATE suppliers SET xero_contact_id = ?3, xero_contact_synced_at = ?4 WHERE id = ?1 AND workspace_id = ?2`)
    .bind(supplier.id, workspaceId, contactId, nowIso())
    .run();
  await requeueGrvPushesForSupplier(env, workspaceId, supplier.id);
  return { ok: true, contactId };
}
