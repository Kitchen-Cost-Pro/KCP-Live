import type { Env } from '../../legacy/types';
import { isWorkspaceVatRegistered, isSupplierVatRegistered, getWorkspaceEffectiveVatRate } from '../../legacy/inventory-costing';
import { text, nowIso } from './config';
import { executeXeroApiRequest, XeroApiClientError } from './api-client';
import { claimXeroEffect, markXeroEffectApplied, markXeroEffectFailed } from './outbox';
import { recordXeroDiagnosticIfNotable } from './observability';
import { resolveXeroContactForSupplier } from './grv-sync';
import { loadLocationTrackingContext, resolveLocationTracking } from './tracking';
import { yesterdayDateKey } from './invoice-sync';

// Same prefix grv-sync.ts's NEEDS_SUPPLIER_MATCH_PREFIX uses — deliberately the identical string
// (not re-exported/imported, to keep the two push modules independent) so listPendingSupplierMatches
// in grv-sync.ts can recognise a credit-note-coded "needs a match" failure the same way it already
// recognises a GRV one.
const NEEDS_SUPPLIER_MATCH_PREFIX = 'NEEDS_SUPPLIER_MATCH:';

interface CreditNoteRow {
  id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_xero_contact_id: string | null;
  supplier_raw_json: string | null;
  credit_note_number: string | null;
  credited_at: string;
}

interface CreditNoteLineRow {
  stock_item_id: string | null;
  stock_item_name: string | null;
  vat_enabled: number | null;
  quantity: number | null;
  unit_cost: number | null;
  total_ex: number | null;
  location_id?: string | null;
  location_name?: string | null;
  // Pre-resolved by pushOneCreditNote (via tracking.ts) before buildCreditNoteXeroPayload is
  // called — same reasoning as grv-sync.ts's GrvLineRow.tracking.
  tracking?: Array<{ TrackingCategoryID: string; TrackingOptionID: string }>;
}

/**
 * credit_note_lines never stores its own VAT amount (unlike grv_lines) — see
 * transaction-detail-routes.ts's loadCreditNoteDetail, which recomputes VAT the same way for the
 * drawer. This mirrors that: total_ex is a genuine ex-VAT figure ALWAYS (there is no
 * "prices already inclusive, fold VAT into cost" duality for credit notes the way GRV stock lines
 * have — a credit note's unit_cost is simply whatever the corresponding GRV line's ex-VAT cost
 * was), so VAT is always computed by adding the workspace's rate on top, gated by the item's own
 * vat_enabled AND the supplier's own VAT registration — same two gates as everywhere else.
 */
async function loadCreditNoteLines(env: Env, workspaceId: string, creditNoteId: string): Promise<CreditNoteLineRow[]> {
  const rows = await env.DB.prepare(
    `SELECT cnl.stock_item_id, si.name AS stock_item_name, si.vat_enabled, cnl.quantity, cnl.unit_cost, cnl.total_ex,
            cnl.location_id, COALESCE(l.display_name, l.name) AS location_name
       FROM credit_note_lines cnl
       LEFT JOIN stock_items si ON si.id = cnl.stock_item_id AND si.workspace_id = cnl.workspace_id
       LEFT JOIN locations l ON l.id = cnl.location_id AND l.workspace_id = cnl.workspace_id
      WHERE cnl.credit_note_id = ?1 AND cnl.workspace_id = ?2
      ORDER BY cnl.id ASC`
  )
    .bind(creditNoteId, workspaceId)
    .all<CreditNoteLineRow>();
  return rows.results || [];
}

/** Every Credit Note never successfully pushed, regardless of which day it was credited on — same
 * "not date-bounded, idempotent via the per-document outbox effect" reasoning as
 * grv-sync.ts's loadPendingGrvs (a credit note whose supplier had no Xero match yesterday must
 * still be retried once that's resolved, not just on the day it was first seen), and the same
 * newest-first ordering so a backlog can never starve today's fresh credit notes under a capped
 * LIMIT. */
export async function loadPendingCreditNotes(env: Env, workspaceId: string, limit = 500): Promise<CreditNoteRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       cn.id, cn.supplier_id, s.name AS supplier_name, s.xero_contact_id AS supplier_xero_contact_id, s.raw_json AS supplier_raw_json,
       cn.credit_note_number, cn.credited_at
     FROM credit_notes cn
     LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.workspace_id = cn.workspace_id
     WHERE cn.workspace_id = ?1
       AND NOT EXISTS (
         SELECT 1 FROM xero_v2_effect_outbox o
          WHERE o.workspace_id = cn.workspace_id AND o.effect_type = 'CREDIT_NOTE_PUSH'
            AND o.effect_key = 'credit-note:' || cn.workspace_id || ':' || cn.id AND o.status = 'APPLIED'
       )
     ORDER BY cn.credited_at DESC
     LIMIT ?2`
  )
    .bind(workspaceId, limit)
    .all<CreditNoteRow>();
  return rows.results || [];
}

// Xero's own built-in "no tax at all" code — same constant/reasoning as grv-sync.ts's
// NO_VAT_TAX_TYPE: a non-VAT-registered business cannot reclaim VAT on anything, including a
// credit received against a purchase, so every line must use this instead of a reclaimable rate.
const NO_VAT_TAX_TYPE = 'NONE';

export function buildCreditNoteXeroPayload(
  creditNote: CreditNoteRow,
  lines: CreditNoteLineRow[],
  contactId: string,
  settings: { purchaseAccountCode: string; purchaseTaxType: string; purchaseExemptTaxType: string; locationTrackingCategoryId?: string },
  workspaceIsVatRegistered: boolean,
  vatRate: number,
  supplierIsVatRegistered: boolean
) {
  return {
    CreditNotes: [
      {
        Type: 'ACCPAYCREDIT',
        Contact: { ContactID: contactId },
        Date: text(creditNote.credited_at).slice(0, 10),
        Reference: text(creditNote.credit_note_number) || `CN-${creditNote.id.slice(-6).toUpperCase()}`,
        // Always Draft for human review before it reduces a real supplier balance — same "review
        // before it hits the ledger" posture as a non-COD GRV Bill (see grv-sync.ts).
        Status: 'DRAFT',
        // total_ex is always a genuine ex-VAT figure (see loadCreditNoteLines's doc comment) — for
        // a non-registered workspace the amount pushed is grossed up to the true, non-reclaimable
        // inclusive figure below instead, so 'Exclusive' is correct in both cases (Xero adds zero
        // tax on top of a 'NONE'-taxed line regardless of this setting).
        LineAmountTypes: 'Exclusive',
        LineItems: lines.map((line) => {
          const ex = Number(line.total_ex) || 0;
          const isTaxable = supplierIsVatRegistered && Number(line.vat_enabled ?? 1) !== 0;
          const vat = isTaxable ? ex * vatRate : 0;
          const taxType = !workspaceIsVatRegistered
            ? NO_VAT_TAX_TYPE
            : isTaxable || !settings.purchaseExemptTaxType
              ? settings.purchaseTaxType
              : settings.purchaseExemptTaxType;
          return {
            Description: text(line.stock_item_name) || text(line.stock_item_id) || 'Credit note',
            Quantity: Number(line.quantity) || 1,
            // A non-registered workspace can't reclaim the VAT a registered supplier genuinely
            // charged on the credited goods — the true credit received back is the full inclusive
            // amount, not just the ex-VAT split (same "always add VAT on top, then fold for a
            // non-registered workspace" treatment as Transport on the GRV push — see
            // applyGrvTransportAndDiscount's doc comment in inventory-costing.ts).
            UnitAmount: workspaceIsVatRegistered ? ex : ex + vat,
            AccountCode: settings.purchaseAccountCode,
            TaxType: taxType,
            // Pre-resolved by pushOneCreditNote (tracking.ts) — omitted when tracking isn't
            // configured or this line's location has no matching Xero option.
            ...(line.tracking ? { Tracking: line.tracking } : {})
          };
        })
      }
    ]
  };
}

export interface FailedCreditNotePush {
  creditNoteId: string;
  creditNoteNumber: string;
  supplierName: string;
  error: string;
}

type PushOneCreditNoteOutcome =
  | { status: 'applied' | 'duplicate' | 'needs_supplier_match' }
  | { status: 'failed'; message: string };

async function pushOneCreditNote(
  env: Env,
  workspaceId: string,
  creditNote: CreditNoteRow,
  settings: { purchaseAccountCode: string; purchaseTaxType: string; purchaseExemptTaxType: string; locationTrackingCategoryId?: string }
): Promise<PushOneCreditNoteOutcome> {
  const effectKey = `credit-note:${workspaceId}:${creditNote.id}`;
  const claim = await claimXeroEffect(env, workspaceId, 'CREDIT_NOTE_PUSH', effectKey);
  if (claim.alreadyApplied) return { status: 'duplicate' };

  let contactId: string | null = null;
  try {
    contactId = await resolveXeroContactForSupplier(env, workspaceId, {
      id: text(creditNote.supplier_id),
      name: creditNote.supplier_name,
      xeroContactId: creditNote.supplier_xero_contact_id
    });
  } catch (cause) {
    const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error resolving Xero contact.';
    await markXeroEffectFailed(env, claim.id, message);
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-credit-note-push', status: 'failed', message, details: { creditNoteId: creditNote.id } });
    return { status: 'failed', message };
  }

  if (!contactId) {
    await markXeroEffectFailed(env, claim.id, `${NEEDS_SUPPLIER_MATCH_PREFIX}${text(creditNote.supplier_id)}`);
    return { status: 'needs_supplier_match' };
  }

  let payload: ReturnType<typeof buildCreditNoteXeroPayload> | undefined;
  try {
    const lines = await loadCreditNoteLines(env, workspaceId, creditNote.id);
    const [workspaceIsVatRegistered, supplierIsVatRegistered, vatRate, trackingContext] = await Promise.all([
      isWorkspaceVatRegistered(env, workspaceId),
      isSupplierVatRegistered(env, workspaceId, text(creditNote.supplier_id)),
      getWorkspaceEffectiveVatRate(env, workspaceId),
      loadLocationTrackingContext(env, workspaceId, text(settings.locationTrackingCategoryId))
    ]);
    const linesWithTracking = await Promise.all(
      lines.map(async (line) => ({ ...line, tracking: await resolveLocationTracking(env, workspaceId, trackingContext, line.location_name) }))
    );
    payload = buildCreditNoteXeroPayload(creditNote, linesWithTracking, contactId, settings, workspaceIsVatRegistered, vatRate, supplierIsVatRegistered);
    const result = await executeXeroApiRequest(env, workspaceId, { method: 'POST', path: 'CreditNotes', body: payload });
    const creditNotes = (result.CreditNotes as Array<{ CreditNoteID?: string }> | undefined) || [];
    const xeroCreditNoteId = text(creditNotes[0]?.CreditNoteID);
    await markXeroEffectApplied(env, claim.id, xeroCreditNoteId);
    return { status: 'applied' };
  } catch (cause) {
    const apiMessage = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error pushing credit note to Xero.';
    // Same reasoning as grv-sync.ts's pushOneGrv: Xero's error alone doesn't say WHICH line/code
    // was rejected — append what KCP actually sent so a settings mismatch is visible without
    // needing to cross-reference the Xero org's Chart of Accounts/Tax Rates by hand.
    const sentLines = payload?.CreditNotes?.[0]?.LineItems as Array<{ Description?: string; AccountCode?: string; TaxType?: string }> | undefined;
    const lineSummary = sentLines?.length
      ? ` Sent: ${sentLines.map((line) => `${line.Description || '?'} [account=${line.AccountCode || '?'}, tax=${line.TaxType || '?'}]`).join(', ')}`
      : '';
    const message = `${apiMessage}${lineSummary}`;
    await markXeroEffectFailed(env, claim.id, message);
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-credit-note-push', status: 'failed', message, details: { creditNoteId: creditNote.id } });
    return { status: 'failed', message };
  }
}

/** Shared by the automatic daily due-check and the manual "Sync Credit Notes now" button. */
export async function syncPendingXeroCreditNotes(
  env: Env,
  workspaceId: string,
  settings: { purchaseAccountCode: string; purchaseTaxType: string; purchaseExemptTaxType: string; locationTrackingCategoryId?: string }
): Promise<{ applied: number; duplicate: number; needsSupplierMatch: number; failed: number; failedDetails?: FailedCreditNotePush[] }> {
  const creditNotes = await loadPendingCreditNotes(env, workspaceId);
  const counts = { applied: 0, duplicate: 0, needsSupplierMatch: 0, failed: 0 };
  const failedDetails: FailedCreditNotePush[] = [];
  for (const creditNote of creditNotes) {
    const outcome = await pushOneCreditNote(env, workspaceId, creditNote, settings);
    if (outcome.status === 'applied') counts.applied += 1;
    else if (outcome.status === 'duplicate') counts.duplicate += 1;
    else if (outcome.status === 'needs_supplier_match') counts.needsSupplierMatch += 1;
    else if (outcome.status === 'failed') {
      counts.failed += 1;
      failedDetails.push({
        creditNoteId: creditNote.id,
        creditNoteNumber: text(creditNote.credit_note_number),
        supplierName: text(creditNote.supplier_name) || 'Unknown supplier',
        error: outcome.message
      });
    }
  }
  return failedDetails.length ? { ...counts, failedDetails } : counts;
}

// Independent daily claim from the GRV sync's (own enabled flag/last-synced date/claim timestamp)
// so a credit note sync failure never blocks or is blocked by the GRV sync — same reasoning as the
// GRV sync being independent from the sales invoice sync.
export async function claimDailyCreditNoteSyncIfDue(env: Env, workspaceId: string): Promise<{ due: boolean; dateKey?: string }> {
  // Not tied to trading-day-start-hour the way the sales invoice/GRV claims are — this is purely
  // a "run at most once per calendar day" lock (loadPendingCreditNotes isn't date-bounded either,
  // matching loadPendingGrvs), so the plain default (midnight SAST) shift is enough here.
  const dateKey = yesterdayDateKey();
  const now = nowIso();
  const settings = await env.DB.prepare(`SELECT last_credit_note_sync_date, credit_note_sync_claimed_at, credit_note_sync_enabled FROM xero_sync_settings WHERE workspace_id = ?1`)
    .bind(workspaceId)
    .first<{ last_credit_note_sync_date?: string; credit_note_sync_claimed_at?: string; credit_note_sync_enabled?: number }>();
  if (!settings || !settings.credit_note_sync_enabled) return { due: false };
  if (settings.last_credit_note_sync_date === dateKey) return { due: false };
  const claimedAt = settings.credit_note_sync_claimed_at ? new Date(settings.credit_note_sync_claimed_at).getTime() : 0;
  if (claimedAt && Date.now() - claimedAt < 60 * 60 * 1000) return { due: false };
  await env.DB.prepare(`UPDATE xero_sync_settings SET credit_note_sync_claimed_at = ?2, updated_at = ?2 WHERE workspace_id = ?1`)
    .bind(workspaceId, now)
    .run();
  return { due: true, dateKey };
}

export async function releaseDailyCreditNoteSyncClaim(env: Env, workspaceId: string, dateKey: string, success: boolean): Promise<void> {
  const now = nowIso();
  if (success) {
    await env.DB.prepare(
      `UPDATE xero_sync_settings SET last_credit_note_sync_date = ?2, credit_note_sync_claimed_at = NULL, updated_at = ?3 WHERE workspace_id = ?1`
    )
      .bind(workspaceId, dateKey, now)
      .run();
  } else {
    await env.DB.prepare(`UPDATE xero_sync_settings SET credit_note_sync_claimed_at = NULL, updated_at = ?2 WHERE workspace_id = ?1`)
      .bind(workspaceId, now)
      .run();
  }
}
