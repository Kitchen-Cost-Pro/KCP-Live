import type { Env } from '../../legacy/types';
import { isWorkspaceVatRegistered, isSupplierVatRegistered, getWorkspaceEffectiveVatRate, applyGrvTransportAndDiscount } from '../../legacy/inventory-costing';
import { text, objectValue, nowIso } from './config';
import { executeXeroApiRequest, executeXeroBinaryPutRequest, XeroApiClientError } from './api-client';
import { claimXeroEffect, markXeroEffectApplied, markXeroEffectFailed } from './outbox';
import { recordXeroDiagnosticIfNotable } from './observability';
import { loadLocationTrackingContext, resolveLocationTracking } from './tracking';
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
  transport_ex: number | null;
  discount_ex: number | null;
  supplier_raw_json: string | null;
  raw_json: string | null;
}

/**
 * Mirrors Suppliers.js/supplierService.js's own paymentTerms default: it's stored only inside the
 * supplier's raw_json blob (not a queryable column), defaults to 'COD' when unset, and accepts the
 * same handful of key spellings the import/normalize paths already tolerate (PaymentTerms /
 * "Payment Terms" / Payment_Terms).
 */
function resolveSupplierPaymentTerms(rawJson: string | null): string {
  if (!rawJson) return 'COD';
  try {
    const parsed = objectValue(JSON.parse(rawJson));
    const value = parsed.paymentTerms ?? parsed.PaymentTerms ?? parsed['Payment Terms'] ?? parsed['Payment_Terms'];
    return text(value) || 'COD';
  } catch {
    return 'COD';
  }
}

export function isCodSupplier(rawJson: string | null): boolean {
  return resolveSupplierPaymentTerms(rawJson).trim().toUpperCase() === 'COD';
}

/**
 * Xero rejects a Bill with "The document DueDate field must be specified" — it has no concept of
 * "due whenever," so this derives one from the same payment-terms options Suppliers.js already
 * offers (PAYMENT_TERM_OPTIONS: COD, Due on receipt, 7/14/30/45/60 Days, EOM, 30 Days EOM), applied
 * against the GRV's own received date rather than "today" (a backfilled GRV pushed weeks late
 * should still get the due date it actually had, not one measured from the push date).
 */
function computeGrvDueDate(receivedAt: string, paymentTerms: string): string {
  const baseDateStr = text(receivedAt).slice(0, 10);
  const base = new Date(`${baseDateStr}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return baseDateStr || new Date().toISOString().slice(0, 10);

  const terms = text(paymentTerms).trim();
  const eomPlusDaysMatch = terms.match(/^(\d+)\s*Days?\s*EOM$/i);
  if (eomPlusDaysMatch) {
    const eom = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
    eom.setUTCDate(eom.getUTCDate() + Number(eomPlusDaysMatch[1]));
    return eom.toISOString().slice(0, 10);
  }
  if (/^EOM$/i.test(terms)) {
    const eom = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
    return eom.toISOString().slice(0, 10);
  }
  const daysMatch = terms.match(/^(\d+)\s*Days?$/i);
  if (daysMatch) {
    base.setUTCDate(base.getUTCDate() + Number(daysMatch[1]));
    return base.toISOString().slice(0, 10);
  }
  // 'COD', 'Due on receipt', or anything unrecognised: due the same day as the invoice date.
  return baseDateStr;
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

interface GrvLineRow {
  stock_item_id: string | null;
  stock_item_name: string | null;
  quantity: number | null;
  unit_price: number | null;
  total_ex: number | null;
  total_vat: number | null;
  location_id?: string | null;
  location_name?: string | null;
  // Pre-resolved by pushOneGrv (via tracking.ts) BEFORE buildGrvBillPayload is called — kept off
  // this loader/interface's own concerns so buildGrvBillPayload can stay a synchronous, easily
  // unit-tested pure function; resolving a Xero Tracking Option is an async API call this loader
  // has no business making.
  tracking?: Array<{ TrackingCategoryID: string; TrackingOptionID: string }>;
}

/**
 * grv_lines (not raw_json) is the source of truth for what actually goes to Xero: total_ex/
 * total_vat there are the real, already VAT-gated (item/workspace/supplier) figures GRV lines are
 * costed and posted to stock at (see legacy/routes.ts's GRV save path calling computeGrvTotals,
 * and postGoodsReceipt's per-line insert loop for the identical gate applied per row). `unit_price`
 * is NOT always ex-VAT the way this comment used to claim — for a non-VAT-registered workspace
 * it's VAT-INCLUSIVE (finalizeReceivedCost in GRVEntry.js folds the non-reclaimable VAT into it
 * before it's ever submitted) — buildGrvBillPayload accounts for this via its own
 * `workspaceIsVatRegistered` parameter, never by re-deriving direction from this row alone.
 */
async function loadGrvLines(env: Env, workspaceId: string, grvId: string): Promise<GrvLineRow[]> {
  const rows = await env.DB.prepare(
    `SELECT gl.stock_item_id, si.name AS stock_item_name, gl.quantity, gl.unit_price, gl.total_ex, gl.total_vat,
            gl.location_id, COALESCE(l.display_name, l.name) AS location_name
     FROM grv_lines gl
     LEFT JOIN stock_items si ON si.id = gl.stock_item_id AND si.workspace_id = gl.workspace_id
     LEFT JOIN locations l ON l.id = gl.location_id AND l.workspace_id = gl.workspace_id
     WHERE gl.grv_id = ?1 AND gl.workspace_id = ?2
     ORDER BY gl.id ASC`
  )
    .bind(grvId, workspaceId)
    .all<GrvLineRow>();
  return rows.results || [];
}

/**
 * Every GRV that's never successfully pushed, regardless of which business day it fell on — used
 * by both the automatic daily due-check and the manual "Sync GRVs now" button. Deliberately NOT
 * date-bounded to "yesterday": a GRV whose supplier had no Xero contact match yesterday needs to be
 * retried on a LATER day's due-check once the user resolves that match (see resolveSupplierMatch),
 * and a date-bounded scan would only ever look at the one day it was first seen. The per-GRV outbox
 * (GRV_PUSH effect) is what keeps this idempotent, not the date bound.
 *
 * Ordered NEWEST-first (received_at DESC), not oldest-first: with a capped LIMIT, oldest-first
 * means a backlog of older never-pushed GRVs (e.g. everything captured before Xero sync was turned
 * on) permanently fills the cap and today's brand-new GRVs never get reached — they always sort to
 * the back of an ever-growing queue. Newest-first guarantees today's GRVs are never starved by a
 * stale backlog; the backlog still drains over repeated runs, just from the front of the queue
 * inward instead of the back.
 */
export async function loadPendingGrvs(env: Env, workspaceId: string, limit = 500): Promise<GrvRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       grv.id, grv.supplier_id, s.name AS supplier_name, s.xero_contact_id AS supplier_xero_contact_id, s.raw_json AS supplier_raw_json,
       grv.invoice_number, grv.received_at, grv.prices_include_vat, grv.total_ex, grv.total_vat, grv.total_inc, grv.transport_ex, grv.discount_ex, grv.raw_json
     FROM grvs grv
     LEFT JOIN suppliers s ON s.id = grv.supplier_id AND s.workspace_id = grv.workspace_id
     WHERE grv.workspace_id = ?1
       AND NOT EXISTS (
         SELECT 1 FROM xero_v2_effect_outbox o
          WHERE o.workspace_id = grv.workspace_id AND o.effect_type = 'GRV_PUSH'
            AND o.effect_key = 'grv:' || grv.workspace_id || ':' || grv.id AND o.status = 'APPLIED'
       )
     ORDER BY grv.received_at DESC
     LIMIT ?2`
  )
    .bind(workspaceId, limit)
    .all<GrvRow>();
  return rows.results || [];
}

/**
 * True only if this Xero Contact still genuinely exists and is usable — a Bill can't be posted
 * against a Contact that's been deleted, or archived (Xero often archives rather than hard-deletes
 * a contact that has any transaction history, e.g. after a bulk "reset my Contacts" cleanup), even
 * though the GET can still succeed and return a row for an archived one.
 */
async function xeroContactIsUsable(env: Env, workspaceId: string, contactId: string): Promise<boolean> {
  try {
    const result = await executeXeroApiRequest(env, workspaceId, { method: 'GET', path: `Contacts/${encodeURIComponent(contactId)}` });
    const contact = (result.Contacts as Array<{ ContactStatus?: string }> | undefined)?.[0];
    return Boolean(contact) && text(contact?.ContactStatus).toUpperCase() !== 'ARCHIVED';
  } catch {
    // Most commonly a 404 (the contact was permanently deleted) — either way, can't confirm it's
    // still good, so treat it as gone rather than risk repeatedly pushing against a dead reference.
    return false;
  }
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
  if (supplier.xeroContactId) {
    if (await xeroContactIsUsable(env, workspaceId, supplier.xeroContactId)) return supplier.xeroContactId;
    // Stale — the linked Contact was deleted/archived on Xero's own side (e.g. a full-Contacts
    // reset there), and blindly trusting the cached id forever would silently fail every future
    // GRV push for this supplier. Clear it so this falls through to a fresh name-based
    // match/create below, same as a supplier that was never linked at all.
    await env.DB.prepare(`UPDATE suppliers SET xero_contact_id = NULL, xero_contact_synced_at = NULL WHERE id = ?1 AND workspace_id = ?2`)
      .bind(supplier.id, workspaceId)
      .run();
  }
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

/**
 * Splits a header-level discount across the taxable vs non-taxable share of the pre-discount
 * subtotal (lines + transport), mirroring GRVEntry.js's calculateDraftTotals / the backend's
 * applyProRataDiscount (inventory-costing.ts) — a discount on a mixed bread+beer GRV isn't its own
 * flat-rate line, it reduces both taxable and non-taxable spend in proportion to their share.
 * grv_lines are the PRE-discount per-line totals (discount is only ever applied at the header
 * level, never written back into grv_lines), so they're the correct base to pro-rate against here.
 *
 * Pushed to Xero as an explicit negative-UnitAmount LineItem (or two, one per tax share) rather
 * than folded into the other lines' amounts, so the discount stays visible on the Bill — this is
 * Xero's own documented pattern for a Bill discount (ACCPAY doesn't support the native
 * DiscountRate field at all; that's ACCREC/sales-invoice only), and an explicit TaxType on a
 * negative line is meant to compute correctly.
 */
function proRataDiscountShares(lines: GrvLineRow[], transportEx: number, discountEx: number, supplierIsVatRegistered: boolean): { taxableShare: number; nonTaxableShare: number } {
  if (!discountEx) return { taxableShare: 0, nonTaxableShare: 0 };
  // Transport is taxable exactly when the supplier can charge VAT at all — same gate
  // applyGrvTransportAndDiscount (inventory-costing.ts) uses; a non-VAT-registered supplier never
  // charges VAT on anything they sell, transport included. Regression: this used to hardcode
  // transport as unconditionally taxable, disagreeing with that shared source of truth whenever
  // the workspace was registered but the supplier wasn't.
  const transportIsTaxable = supplierIsVatRegistered && transportEx > 0;
  let taxableExBeforeDiscount = transportIsTaxable ? transportEx : 0;
  let subtotalBeforeDiscount = transportEx > 0 ? transportEx : 0;
  for (const line of lines) {
    const lineEx = Number(line.total_ex) || 0;
    subtotalBeforeDiscount += lineEx;
    if (Number(line.total_vat) > 0) taxableExBeforeDiscount += lineEx;
  }
  const taxableShare = subtotalBeforeDiscount > 0 ? discountEx * (taxableExBeforeDiscount / subtotalBeforeDiscount) : 0;
  return { taxableShare, nonTaxableShare: discountEx - taxableShare };
}

// Xero's own built-in "no tax at all" code — unlike every other TaxType this module sends, it is
// NOT an organisation-configurable rate (no Chart of Accounts/Tax Rates lookup needed, never
// Archived, always valid) — the correct code for a line that genuinely carries zero VAT
// information at all, as opposed to purchaseExemptTaxType (a real, org-specific zero-rated/exempt
// VAT category that a VAT-REGISTERED business still reports on its VAT return).
const NO_VAT_TAX_TYPE = 'NONE';

export function buildGrvBillPayload(
  grv: GrvRow,
  lines: GrvLineRow[],
  contactId: string,
  settings: { purchaseAccountCode: string; purchaseTaxType: string; purchaseExemptTaxType: string },
  // A non-VAT-registered business still genuinely PAYS whatever VAT a registered supplier charges
  // — it just can never reclaim it as input VAT credit, so the true, permanent cost already
  // includes that VAT (see GRVEntry.js's finalizeReceivedCost, and inventory-costing.ts's
  // `linesAreAlreadyVatInclusive` for the matching stock-costing side of this same duality).
  // grv_lines.unit_price carries that same duality itself: for a VAT-registered workspace it's
  // ex-VAT, submitted as typed; for a non-registered workspace it's VAT-INCLUSIVE, since that
  // inclusive figure IS the real, final, non-reclaimable cost. Before this parameter existed,
  // every GRV pushed to Xero used the reclaimable `purchaseTaxType` regardless of registration
  // status — for a non-registered workspace this both wrongly claimed input VAT credit the
  // business isn't entitled to AND, because the already-inclusive `unit_price` was declared
  // `LineAmountTypes: 'Exclusive'`, caused Xero to add VAT a SECOND time on top of an amount that
  // already contained it, inflating the Bill total beyond what was actually paid.
  workspaceIsVatRegistered: boolean,
  // Transport ("Transport (Ex)") and Discount ("Discount (Ex)") are, unlike unit costs, ALWAYS
  // genuine ex-VAT figures regardless of registration — confirmed with David 2026-09-01 — so VAT
  // must always be added on top for them, never backed out. For a non-registered workspace that
  // added VAT is real but non-reclaimable, so the TRUE cash amount to push (still under
  // `NO_VAT_TAX_TYPE`, since none of it is reclaimable) is the VAT-INCLUSIVE figure, not the raw
  // ex-VAT amount typed on screen — see `applyGrvTransportAndDiscount` in inventory-costing.ts for
  // the shared math this must match exactly (an earlier version of this function pushed the raw
  // ex-VAT `transport_ex`/`discount_ex` values even for a non-registered workspace, silently
  // understating the Bill by the VAT the transporter/discount's taxable share would have carried).
  vatRate: number,
  supplierIsVatRegistered: boolean,
  existingBillId?: string,
  isCod = false
) {
  const transportEx = Number(grv.transport_ex) || 0;
  const discountEx = Number(grv.discount_ex) || 0;
  const itemTotals = lines.reduce(
    (sum, line) => ({
      totalEx: sum.totalEx + (Number(line.total_ex) || 0),
      totalVat: sum.totalVat + (Number(line.total_vat) || 0),
      taxableEx: sum.taxableEx + (Number(line.total_vat) > 0 ? Number(line.total_ex) || 0 : 0),
      totalInc: sum.totalInc + (Number(line.total_ex) || 0) + (Number(line.total_vat) || 0)
    }),
    { totalEx: 0, totalVat: 0, taxableEx: 0, totalInc: 0 }
  );
  const combined = applyGrvTransportAndDiscount(itemTotals, { vatRate, supplierIsVatRegistered, transportEx, discountEx });
  // A non-registered workspace has nothing to pro-rate between taxable/non-taxable shares — none
  // of it is reclaimable VAT, so the whole discount (its true VAT-inclusive impact) goes under the
  // single no-VAT line below.
  const discountShares = workspaceIsVatRegistered
    ? proRataDiscountShares(lines, transportEx, discountEx, supplierIsVatRegistered)
    : { taxableShare: 0, nonTaxableShare: Math.abs(combined.discountIncImpact) };
  const transportPushAmount = workspaceIsVatRegistered ? transportEx : combined.transportInc;
  // Mirrors the stock-line taxType decision exactly (based on the ALREADY-correct combined.transportVat,
  // which already accounts for supplierIsVatRegistered) — a non-VAT-registered supplier never
  // charges VAT on transport either, so it must fall to the exempt/no-VAT type just like any other
  // non-taxable line, not the reclaimable purchaseTaxType.
  const transportTaxType = !workspaceIsVatRegistered
    ? NO_VAT_TAX_TYPE
    : combined.transportVat > 0 || !settings.purchaseExemptTaxType
      ? settings.purchaseTaxType
      : settings.purchaseExemptTaxType;
  return {
    Invoices: [
      {
        ...(existingBillId ? { InvoiceID: existingBillId } : {}),
        Type: 'ACCPAY',
        Contact: { ContactID: contactId },
        Date: text(grv.received_at).slice(0, 10),
        // Required by Xero — "The document DueDate field must be specified" otherwise — derived
        // from the supplier's own payment terms (see computeGrvDueDate's comment).
        DueDate: computeGrvDueDate(grv.received_at, resolveSupplierPaymentTerms(grv.supplier_raw_json)),
        Reference: text(grv.invoice_number) || `GRV-${grv.id.slice(-6).toUpperCase()}`,
        // A COD supplier is paid at the point of delivery — there's nothing left to approve, so it
        // goes out AUTHORISED (with a matching Payment applied separately, see applyCodPayment)
        // instead of sitting in Draft forever. Every other payment method still needs a human
        // review/approval step before it's a real liability, so it stays DRAFT as before.
        Status: isCod ? 'AUTHORISED' : 'DRAFT',
        // Every UnitAmount below is either a genuine ex-VAT figure (registered workspace) or a
        // genuine VAT-inclusive figure carrying TaxType 'NONE' (non-registered workspace) — in
        // BOTH cases 'Exclusive' is the correct declaration, since Xero adds zero tax on top of a
        // 'NONE'-taxed line regardless of this setting. Never conditional on the GRV's own
        // "prices include VAT" entry-screen toggle, which only affects what price was TYPED, never
        // what ends up stored.
        LineAmountTypes: 'Exclusive',
        LineItems: [
          ...(lines.length
            ? lines
            : [{
              stock_item_id: null,
              stock_item_name: 'Goods received',
              quantity: 1,
              unit_price: (workspaceIsVatRegistered ? grv.total_ex : grv.total_inc) || 0,
              total_ex: grv.total_ex,
              total_vat: grv.total_vat
            }]
          ).map((line) => {
            const taxType = !workspaceIsVatRegistered
              ? NO_VAT_TAX_TYPE
              // A zero-rated/VAT-exempt stock item (total_vat = 0, driven by stock_items.vat_enabled
              // or a non-VAT-registered supplier — see loadGrvLines) uses the exempt tax type if
              // one's configured, instead of blanket-applying the normal purchases tax type.
              : Number(line.total_vat) > 0 || !settings.purchaseExemptTaxType
                ? settings.purchaseTaxType
                : settings.purchaseExemptTaxType;
            return {
              Description: text(line.stock_item_name) || text(line.stock_item_id) || 'Goods received',
              Quantity: Number(line.quantity) || 1,
              UnitAmount: Number(line.unit_price) || 0,
              AccountCode: settings.purchaseAccountCode,
              TaxType: taxType,
              // Pre-resolved by pushOneGrv (tracking.ts) — omitted entirely (not a guessed/empty
              // value) when location tracking isn't configured or this line's location has no
              // matching Xero option, since Xero silently drops an unrecognised Tracking entry
              // anyway rather than erroring on it.
              ...(line.tracking ? { Tracking: line.tracking } : {})
            };
          }),
          // Transport uses the standard purchases tax type for a VAT-registered workspace UNLESS
          // the supplier itself isn't VAT-registered (falls to the exempt type, same as any other
          // non-taxable line) — see transportTaxType above. Carries zero reclaimable VAT at all,
          // like everything else on this Bill, once the workspace itself isn't registered.
          ...(transportEx > 0
            ? [{
              Description: 'Transport',
              Quantity: 1,
              UnitAmount: transportPushAmount,
              AccountCode: settings.purchaseAccountCode,
              TaxType: transportTaxType
            }]
            : []),
          // A negative-UnitAmount line, same account code — Xero's own documented way to model a
          // discount on a Bill (ACCPAY doesn't support the native DiscountRate field at all). Split
          // into up to two lines (taxable / non-taxable share) so Xero computes the same VAT
          // reduction our own totals already reflect, instead of over- or under-taxing the discount
          // at one flat rate — but only for a VAT-registered workspace; see discountShares above.
          ...(discountShares.taxableShare > 0
            ? [{
              Description: 'Discount',
              Quantity: 1,
              UnitAmount: -discountShares.taxableShare,
              AccountCode: settings.purchaseAccountCode,
              TaxType: settings.purchaseTaxType
            }]
            : []),
          ...(discountShares.nonTaxableShare > 0
            ? [{
              // For a non-registered workspace this is the WHOLE discount (nothing is taxable at
              // all), not just the zero-rated/exempt-item share — label it plainly rather than
              // implying only part of the discount landed here.
              Description: workspaceIsVatRegistered ? 'Discount (zero-rated/exempt items)' : 'Discount',
              Quantity: 1,
              UnitAmount: -discountShares.nonTaxableShare,
              AccountCode: settings.purchaseAccountCode,
              TaxType: !workspaceIsVatRegistered ? NO_VAT_TAX_TYPE : settings.purchaseExemptTaxType || settings.purchaseTaxType
            }]
            : [])
        ]
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
      transportEx: grv.transport_ex,
      discountEx: grv.discount_ex,
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

/**
 * Records a full Payment against a COD GRV's Bill, from the configured bank account — the second
 * half of "AUTHORISED, not DRAFT" (see buildGrvBillPayload): an AUTHORISED Bill with no Payment is
 * still an outstanding liability in Xero, not what "COD = already paid" means. Left as its own
 * best-effort step (own outbox effect, own try/catch) rather than folded into pushOneGrv's Bill
 * creation: the Bill itself is the record that matters most and must not be rolled back or retried
 * from scratch just because the payment side failed (e.g. no bank account configured yet) — same
 * reasoning as pushGrvAttachment being separate from the Bill push above it.
 *
 * No-ops (does not fail, does not claim the effect) when codPaymentAccountCode isn't configured —
 * the Bill still goes out AUTHORISED; it just stays unpaid in Xero until the account code is set or
 * someone reconciles it manually there.
 */
async function applyCodPayment(
  env: Env,
  workspaceId: string,
  grv: GrvRow,
  billId: string,
  codPaymentAccountCode: string
): Promise<void> {
  if (!codPaymentAccountCode) return;
  const effectKey = `grv-payment:${workspaceId}:${grv.id}`;
  const claim = await claimXeroEffect(env, workspaceId, 'GRV_PAYMENT', effectKey);
  if (claim.alreadyApplied) return;
  try {
    const payload = {
      Payments: [
        {
          Invoice: { InvoiceID: billId },
          Account: { Code: codPaymentAccountCode },
          Date: text(grv.received_at).slice(0, 10),
          Amount: Number(grv.total_inc) || 0
        }
      ]
    };
    const result = await executeXeroApiRequest(env, workspaceId, { method: 'PUT', path: 'Payments', body: payload });
    const payments = (result.Payments as Array<{ PaymentID?: string }> | undefined) || [];
    const paymentId = text(payments[0]?.PaymentID);
    await markXeroEffectApplied(env, claim.id, paymentId);
  } catch (cause) {
    const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error applying COD payment to Xero bill.';
    await markXeroEffectFailed(env, claim.id, message);
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-grv-cod-payment', status: 'failed', message, details: { grvId: grv.id, billId } });
  }
}

export interface FailedGrvPush {
  grvId: string;
  invoiceNumber: string;
  supplierName: string;
  error: string;
}

type PushOneGrvOutcome =
  | { status: 'applied' | 'duplicate' | 'needs_supplier_match' }
  | { status: 'failed'; message: string };

/**
 * Returns the failure message directly rather than requiring a separate read-back query against
 * `xero_v2_effect_outbox` afterward — a prior version of this diagnostic tried exactly that
 * (matching effect_key by string-slicing) and it's an unnecessary extra place for a bug to hide;
 * the message is right here in the catch block, so just hand it back.
 */
async function pushOneGrv(
  env: Env,
  workspaceId: string,
  grv: GrvRow,
  settings: { purchaseAccountCode: string; purchaseTaxType: string; purchaseExemptTaxType: string; codPaymentAccountCode?: string; locationTrackingCategoryId?: string }
): Promise<PushOneGrvOutcome> {
  const effectKey = `grv:${workspaceId}:${grv.id}`;
  const claim = await claimXeroEffect(env, workspaceId, 'GRV_PUSH', effectKey);
  if (claim.alreadyApplied) return { status: 'duplicate' };

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
    return { status: 'failed', message };
  }

  if (!contactId) {
    // Not a real failure — surfaced in the "needs attention" list instead of the diagnostic log,
    // and picked up automatically once the user matches/creates the supplier's Xero contact.
    await markXeroEffectFailed(env, claim.id, `${NEEDS_SUPPLIER_MATCH_PREFIX}${text(grv.supplier_id)}`);
    return { status: 'needs_supplier_match' };
  }

  let payload: ReturnType<typeof buildGrvBillPayload> | undefined;
  try {
    const lines = await loadGrvLines(env, workspaceId, grv.id);
    const isCod = isCodSupplier(grv.supplier_raw_json);
    const [workspaceIsVatRegistered, supplierIsVatRegistered, vatRate, trackingContext] = await Promise.all([
      isWorkspaceVatRegistered(env, workspaceId),
      isSupplierVatRegistered(env, workspaceId, text(grv.supplier_id)),
      getWorkspaceEffectiveVatRate(env, workspaceId),
      loadLocationTrackingContext(env, workspaceId, text(settings.locationTrackingCategoryId))
    ]);
    const linesWithTracking = await Promise.all(
      lines.map(async (line) => ({ ...line, tracking: await resolveLocationTracking(env, workspaceId, trackingContext, line.location_name) }))
    );
    payload = buildGrvBillPayload(grv, linesWithTracking, contactId, settings, workspaceIsVatRegistered, vatRate, supplierIsVatRegistered, undefined, isCod);
    const result = await executeXeroApiRequest(env, workspaceId, { method: 'POST', path: 'Invoices', body: payload });
    const invoices = (result.Invoices as Array<{ InvoiceID?: string }> | undefined) || [];
    const billId = text(invoices[0]?.InvoiceID);
    await markXeroEffectApplied(env, claim.id, billId);
    if (billId) {
      await pushGrvAttachment(env, workspaceId, grv, billId);
      if (isCod) await applyCodPayment(env, workspaceId, grv, billId, text(settings.codPaymentAccountCode));
    }
    return { status: 'applied' };
  } catch (cause) {
    const apiMessage = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error pushing GRV to Xero.';
    // Xero's error message alone ("Tax rate must be Active") doesn't say WHICH code was rejected —
    // append what KCP actually sent for each line so a settings mismatch (an AccountCode/TaxType
    // that's archived, wrong, or doesn't exist in this Xero org) is visible without needing to
    // inspect the Xero org's Chart of Accounts/Tax Rates to cross-reference it by hand.
    const sentLines = payload?.Invoices?.[0]?.LineItems as Array<{ Description?: string; AccountCode?: string; TaxType?: string }> | undefined;
    const lineSummary = sentLines?.length
      ? ` Sent: ${sentLines.map((line) => `${line.Description || '?'} [account=${line.AccountCode || '?'}, tax=${line.TaxType || '?'}]`).join(', ')}`
      : '';
    const message = `${apiMessage}${lineSummary}`;
    await markXeroEffectFailed(env, claim.id, message);
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-grv-push', status: 'failed', message, details: { grvId: grv.id } });
    return { status: 'failed', message };
  }
}

/** Shared by the automatic daily due-check and the manual "Sync GRVs now" button — see
 * loadPendingGrvs for why this isn't date-bounded. */
export async function syncPendingXeroGrvs(
  env: Env,
  workspaceId: string,
  settings: { purchaseAccountCode: string; purchaseTaxType: string; purchaseExemptTaxType: string; codPaymentAccountCode?: string; locationTrackingCategoryId?: string }
): Promise<{ applied: number; duplicate: number; needsSupplierMatch: number; failed: number; failedDetails?: FailedGrvPush[] }> {
  const grvs = await loadPendingGrvs(env, workspaceId);
  const counts = { applied: 0, duplicate: 0, needsSupplierMatch: 0, failed: 0 };
  const failedDetails: FailedGrvPush[] = [];
  for (const grv of grvs) {
    const outcome = await pushOneGrv(env, workspaceId, grv, settings);
    if (outcome.status === 'applied') counts.applied += 1;
    else if (outcome.status === 'duplicate') counts.duplicate += 1;
    else if (outcome.status === 'needs_supplier_match') counts.needsSupplierMatch += 1;
    else if (outcome.status === 'failed') {
      counts.failed += 1;
      failedDetails.push({
        grvId: grv.id,
        invoiceNumber: text(grv.invoice_number),
        supplierName: text(grv.supplier_name) || 'Unknown supplier',
        error: outcome.message
      });
    }
  }
  return failedDetails.length ? { ...counts, failedDetails } : counts;
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
  // Count of blocked pushes across BOTH GRV Bills and Credit Notes for this supplier — kept as one
  // combined field name (`grvCount`) for frontend/API compatibility rather than renaming it, since
  // it's already just "how many documents are stuck," not something GRV-specific to display.
  grvCount: number;
  // 'grv_blocked': a real GRV_PUSH or CREDIT_NOTE_PUSH failed because this supplier has no linked
  // Contact (kept the original name rather than introducing a third reason value — the UI label
  // for this case is now generic, "N pushes waiting," not GRV-specific).
  // 'manual_sync': surfaced by the standalone "Sync Suppliers" button, no document push involved.
  reason: 'grv_blocked' | 'manual_sync';
}

/** Backing query for the "needs attention" UI list. Unions two independent sources: real
 * GRV_PUSH/CREDIT_NOTE_PUSH failures coded as a pending supplier match (not a real API error), and
 * suppliers flagged by syncAllSuppliersToXero below that couldn't be auto-matched even though no
 * document push has tried them yet. A supplier present in both is deduped, blocked-push taking
 * priority since it's the more urgent of the two (something is actually stuck, not just "not yet
 * linked"). */
export async function listPendingSupplierMatches(env: Env, workspaceId: string): Promise<PendingSupplierMatch[]> {
  const rows = await env.DB.prepare(
    `SELECT
       substr(o.last_error, ${NEEDS_SUPPLIER_MATCH_PREFIX.length + 1}) AS supplier_id,
       COALESCE(s.name, 'Unknown supplier') AS supplier_name,
       COUNT(*) AS grv_count
     FROM xero_v2_effect_outbox o
     LEFT JOIN suppliers s ON s.id = substr(o.last_error, ${NEEDS_SUPPLIER_MATCH_PREFIX.length + 1}) AND s.workspace_id = o.workspace_id
     WHERE o.workspace_id = ?1 AND o.effect_type IN ('GRV_PUSH', 'CREDIT_NOTE_PUSH') AND o.status = 'FAILED'
       AND o.last_error LIKE '${NEEDS_SUPPLIER_MATCH_PREFIX}%'
     GROUP BY supplier_id, supplier_name`
  )
    .bind(workspaceId)
    .all<{ supplier_id: string; supplier_name: string; grv_count: number }>();
  const grvBlocked = (rows.results || []).map((row) => ({
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    grvCount: Number(row.grv_count) || 0,
    reason: 'grv_blocked' as const
  }));
  const seen = new Set(grvBlocked.map((m) => m.supplierId));

  const flaggedRows = await env.DB.prepare(
    `SELECT id, name FROM suppliers
      WHERE workspace_id = ?1 AND xero_contact_id IS NULL
        AND json_extract(raw_json, '$.needsXeroMatch') = 1`
  )
    .bind(workspaceId)
    .all<{ id: string; name: string }>();
  const manualSync = (flaggedRows.results || [])
    .filter((row) => !seen.has(row.id))
    .map((row) => ({ supplierId: row.id, supplierName: row.name || 'Unknown supplier', grvCount: 0, reason: 'manual_sync' as const }));

  return [...grvBlocked, ...manualSync];
}

/** Merge-updates a supplier's raw_json with a single new key, preserving every other field
 * already stored there (category, paymentTerms, vatRegistered, etc.) — same pattern as
 * normalizeSupplierPayload in legacy/routes.ts. */
async function setSupplierRawJsonFlag(env: Env, workspaceId: string, supplierId: string, rawJson: string | null, key: string, value: boolean): Promise<void> {
  let parsed: Record<string, unknown> = {};
  if (rawJson) {
    try {
      parsed = objectValue(JSON.parse(rawJson));
    } catch {
      parsed = {};
    }
  }
  if (value) parsed[key] = true;
  else delete parsed[key];
  await env.DB.prepare(`UPDATE suppliers SET raw_json = ?3 WHERE id = ?1 AND workspace_id = ?2`)
    .bind(supplierId, workspaceId, JSON.stringify(parsed))
    .run();
}

/**
 * Standalone "Sync Suppliers" button — attempts a match-only resolveXeroContactForSupplier for
 * every supplier that doesn't already have a usable linked Contact, independent of any GRV. Never
 * creates a Contact (same "ask before creating" policy as everywhere else in this module) — a
 * supplier that can't be auto-matched is flagged via raw_json.needsXeroMatch so it surfaces in the
 * SAME "needs attention" list a blocked GRV push would produce, ready for the existing
 * map/create-contact UI to resolve.
 */
export async function syncAllSuppliersToXero(env: Env, workspaceId: string): Promise<{ checked: number; matched: number; alreadyLinked: number; needsAttention: number }> {
  const rows = await env.DB.prepare(`SELECT id, name, xero_contact_id, raw_json FROM suppliers WHERE workspace_id = ?1`)
    .bind(workspaceId)
    .all<{ id: string; name: string | null; xero_contact_id: string | null; raw_json: string | null }>();
  const suppliers = rows.results || [];
  let matched = 0;
  let alreadyLinked = 0;
  let needsAttention = 0;
  for (const supplier of suppliers) {
    const hadLink = Boolean(supplier.xero_contact_id);
    const contactId = await resolveXeroContactForSupplier(env, workspaceId, {
      id: supplier.id,
      name: supplier.name,
      xeroContactId: supplier.xero_contact_id
    });
    if (contactId) {
      if (hadLink && supplier.xero_contact_id === contactId) alreadyLinked += 1;
      else matched += 1;
      let wasFlagged = false;
      try {
        wasFlagged = objectValue(JSON.parse(supplier.raw_json || '{}')).needsXeroMatch === true;
      } catch {
        wasFlagged = false;
      }
      if (wasFlagged) await setSupplierRawJsonFlag(env, workspaceId, supplier.id, supplier.raw_json, 'needsXeroMatch', false);
    } else {
      needsAttention += 1;
      await setSupplierRawJsonFlag(env, workspaceId, supplier.id, supplier.raw_json, 'needsXeroMatch', true);
    }
  }
  return { checked: suppliers.length, matched, alreadyLinked, needsAttention };
}

/**
 * Re-claims every GRV_PUSH or CREDIT_NOTE_PUSH outbox row that failed against this supplier for
 * the coded "needs a match" reason, so the next due-check (or the caller, immediately) retries
 * them now that the supplier has a Xero contact linked.
 */
async function requeueGrvPushesForSupplier(env: Env, workspaceId: string, supplierId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE xero_v2_effect_outbox SET status = 'PROCESSING', updated_at = ?3
      WHERE workspace_id = ?1 AND effect_type IN ('GRV_PUSH', 'CREDIT_NOTE_PUSH') AND status = 'FAILED'
        AND last_error = ?2`
  )
    .bind(workspaceId, `${NEEDS_SUPPLIER_MATCH_PREFIX}${supplierId}`, nowIso())
    .run();
}

/**
 * Enriches a NEW Xero Contact with whatever email/phone/address KCP already has for this supplier
 * (`suppliers.raw_json` — same fields `supplierService.js`/`normalizeSupplierPayload` in
 * legacy/routes.ts already read/write) instead of creating a bare, name-only Contact. Only used on
 * the explicit CREATE path — never applied to an existing matched Contact, since matching is a
 * read+link, not a write, and shouldn't silently overwrite details someone may have already edited
 * directly in Xero.
 */
function buildXeroContactFieldsForSupplier(rawJson: string | null): Record<string, unknown> {
  if (!rawJson) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = objectValue(JSON.parse(rawJson));
  } catch {
    return {};
  }
  const email = text(parsed.email);
  const phone = text(parsed.phone);
  const addressLine1 = text(parsed.addressLine1);
  const addressLine2 = text(parsed.addressLine2);
  const city = text(parsed.city);
  const province = text(parsed.province);
  const postalCode = text(parsed.postalCode);
  const country = text(parsed.country);
  const hasAddress = Boolean(addressLine1 || city || postalCode);
  return {
    ...(email ? { EmailAddress: email } : {}),
    ...(phone ? { Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: phone }] } : {}),
    ...(hasAddress
      ? {
        Addresses: [
          {
            AddressType: 'STREET',
            AddressLine1: addressLine1,
            AddressLine2: addressLine2,
            City: city,
            Region: province,
            PostalCode: postalCode,
            Country: country
          }
        ]
      }
      : {})
  };
}

/** POST xero/resolve-supplier-match — either maps to an existing Xero Contact the user picked, or
 * creates a new one, per the "match by name, ask before creating" answer: the daily job never
 * creates a Contact on its own, only this explicit, human-confirmed action does. */
export async function resolveSupplierMatch(
  env: Env,
  workspaceId: string,
  input: { supplierId: string; xeroContactId?: string; createNew?: boolean }
): Promise<{ ok: true; contactId: string } | { ok: false; error: string }> {
  const supplier = await env.DB.prepare(`SELECT id, name, raw_json FROM suppliers WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`)
    .bind(input.supplierId, workspaceId)
    .first<{ id: string; name: string; raw_json: string | null }>();
  if (!supplier) return { ok: false, error: 'Supplier not found.' };

  let contactId = text(input.xeroContactId);
  if (!contactId && input.createNew) {
    try {
      const result = await executeXeroApiRequest(env, workspaceId, {
        method: 'POST',
        path: 'Contacts',
        body: { Contacts: [{ Name: text(supplier.name), ...buildXeroContactFieldsForSupplier(supplier.raw_json) }] }
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
  await setSupplierRawJsonFlag(env, workspaceId, supplier.id, supplier.raw_json, 'needsXeroMatch', false);
  await requeueGrvPushesForSupplier(env, workspaceId, supplier.id);
  return { ok: true, contactId };
}
