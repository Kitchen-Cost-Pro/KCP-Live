import type { Env } from '../../legacy/types';
import { text, nowIso } from './config';
import { executeXeroApiRequest, XeroApiClientError } from './api-client';
import { claimXeroEffect, markXeroEffectApplied, markXeroEffectFailed, getXeroEffect, upsertXeroEffectApplied } from './outbox';
import { recordXeroDiagnosticIfNotable } from './observability';
import { isWorkspaceVatRegistered } from '../../legacy/inventory-costing';
import { loadLocationTrackingContext, resolveLocationTracking, type LocationTrackingContext } from './tracking';

// Xero's own built-in "no tax at all" code — see grv-sync.ts's identical constant/reasoning. A
// non-VAT-registered business cannot charge real output VAT on anything it sells, so every sales
// line must use this instead of the org-configurable `defaultTaxType` once that's true.
const NO_VAT_TAX_TYPE = 'NONE';

interface AggregatedLineRow {
  label: string;
  product_id: string | null;
  sku: string | null;
  quantity: number;
  total: number;
  vat_enabled: number;
  location_id: string | null;
  location_name: string | null;
  // Pre-resolved by syncXeroDailyInvoice/upsertXeroTodayInvoice (via tracking.ts) before
  // buildDailyInvoicePayload is called — same reasoning as grv-sync.ts's GrvLineRow.tracking.
  tracking?: Array<{ TrackingCategoryID: string; TrackingOptionID: string }>;
}

function clampStartHour(startHour: number): number {
  return Number.isFinite(startHour) ? Math.max(0, Math.min(23, Math.floor(startHour))) : 0;
}

// SAST is a fixed UTC+2 offset (no DST) — same hardcoded assumption the Yoco engine already makes
// (see johannesburgIso in live-sale.ts/live-refund.ts) for turning a UTC instant into the
// merchant's local business day. That part is intentionally NOT configurable here — only the
// trading day's start-of-day hour is (see trading-day.ts), for venues that trade past midnight
// (e.g. 5am-to-5am) instead of a plain calendar day. Exported for grv-sync.ts, which needs the same
// day-bucketing for GRVs' received_at (a literal UTC-midnight timestamp per migration 43's comment).
export function businessDayUtcBounds(dateKey: string, startHour = 0): { startIso: string; endIso: string } {
  const hour = String(clampStartHour(startHour)).padStart(2, '0');
  const start = new Date(`${dateKey}T${hour}:00:00+02:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export async function aggregateDailySalesLines(env: Env, workspaceId: string, dateKey: string, startHour: number): Promise<AggregatedLineRow[]> {
  const { startIso, endIso } = businessDayUtcBounds(dateKey, startHour);
  // No status filter, matching the Sales Financial report's own query (reporting-routes.ts's
  // buildSalesWhere only adds a status predicate if the user explicitly picks one) — a row only
  // ever exists in yoco_orders because live-sale.ts's applyReporting already only writes on a
  // completed-sale trigger event; the stored `status` itself is Yoco's raw string verbatim
  // ('closed', 'paid', 'successful', ...), never normalized to the literal 'completed', so
  // filtering on that exact string silently excluded every real sale.
  //
  // occurred_at is stored as an ISO instant with a '+02:00' offset suffix, never 'Z' (see
  // johannesburgIso in live-sale.ts) — raw string comparison against 'Z'-suffixed bounds doesn't
  // reliably match, so both sides are wrapped in datetime() here, same as
  // addZonedDateRange in reporting-routes.ts does for exactly this reason.
  //
  // Regression: this used to filter `order_type = 'sale'` only, so a refund never reduced the
  // day's invoice at all — every refunded sale still showed as full revenue in Xero, permanently
  // overstating that day's income until someone manually corrected it. live-refund.ts already
  // writes refund rows with NEGATIVE quantity/total (`-Math.abs(...)`), keyed to the same
  // `product_id` the original sale used (via mapped_menu_item_id, see refund-resolver.ts) and
  // dated by when the REFUND happened, not the original sale — so simply including 'refund' rows
  // here nets them straight into whichever day the refund actually occurred on (never retroactively
  // rewriting an already-pushed prior day's invoice). HAVING excludes a product that net to exactly
  // zero that day (fully refunded) — SUM(quantity)=0 would otherwise divide-by-zero into a NaN
  // UnitAmount below and corrupt the whole day's payload.
  // vat_enabled: a product with no linked `products` row (a name-only fallback — never happened
  // via Yoco sync, but possible for legacy/unmapped lines) defaults to VATable (1), matching
  // stock_items.vat_enabled's own "unknown = VATable" convention (loadVatEnabledByStockItemId in
  // inventory-costing.ts). Wrapped in MAX() only to satisfy SQLite's aggregate-query grouping
  // rules — it's a single constant value per group, since it's a property of the (one) product
  // each group represents, not something that varies across the rows being summed.
  // Grouped by location too (in addition to product) so each aggregated line can carry a single
  // Xero Tracking Option — same "order-level location, not the line's own selling_location_id"
  // convention reporting-routes.ts already uses for sales (e.g. its yo.location_id joins), kept
  // here so this and the existing Sales Financial report attribute a sale to the same location.
  const rows = await env.DB.prepare(
    `SELECT
       COALESCE(p.name, ol.name) AS label,
       ol.product_id AS product_id,
       p.sku AS sku,
       SUM(ol.quantity) AS quantity,
       SUM(ol.total) AS total,
       MAX(COALESCE(p.vat_enabled, 1)) AS vat_enabled,
       o.location_id AS location_id,
       COALESCE(l.display_name, l.name) AS location_name
     FROM yoco_order_lines ol
     JOIN yoco_orders o ON o.id = ol.yoco_order_id AND o.workspace_id = ol.workspace_id
     LEFT JOIN products p ON p.id = ol.product_id AND p.workspace_id = ol.workspace_id
     LEFT JOIN locations l ON l.id = o.location_id AND l.workspace_id = o.workspace_id
     WHERE ol.workspace_id = ?1
       AND o.order_type IN ('sale', 'refund')
       AND datetime(o.occurred_at) >= datetime(?2) AND datetime(o.occurred_at) < datetime(?3)
     GROUP BY COALESCE(ol.product_id, ol.name), o.location_id
     HAVING SUM(ol.quantity) != 0
     ORDER BY label ASC`
  )
    .bind(workspaceId, startIso, endIso)
    .all<AggregatedLineRow>();
  return rows.results || [];
}

// Shared by syncXeroDailyInvoice/upsertXeroTodayInvoice — attaches a resolved Tracking array to
// each already-aggregated line, mirroring pushOneGrv's/pushOneCreditNote's identical pattern.
async function attachLocationTracking(
  env: Env,
  workspaceId: string,
  lines: AggregatedLineRow[],
  trackingContext: LocationTrackingContext | null
): Promise<AggregatedLineRow[]> {
  return Promise.all(
    lines.map(async (line) => ({ ...line, tracking: await resolveLocationTracking(env, workspaceId, trackingContext, line.location_name) }))
  );
}

export function buildDailyInvoicePayload(
  dateKey: string,
  lines: AggregatedLineRow[],
  settings: { salesAccountCode: string; defaultTaxType: string; salesExemptTaxType?: string; locationTrackingCategoryId?: string },
  // A non-VAT-registered business cannot charge real output VAT on anything it sells — the daily
  // invoice previously always used `settings.defaultTaxType` regardless of registration, which
  // would misreport phantom output VAT on a Xero VAT return for a business that legally has none.
  // `yoco_order_lines.total` already reflects the correct real amount charged either way (the
  // per-sale VAT snapshot in live-sale.ts/live-refund.ts already zeroes the rate for a
  // non-registered workspace), so only the TaxType selection needs to change here — never the
  // amount itself.
  workspaceIsVatRegistered = true,
  existingInvoiceId?: string
) {
  return {
    Invoices: [
      {
        ...(existingInvoiceId ? { InvoiceID: existingInvoiceId } : {}),
        Type: 'ACCREC',
        Contact: { Name: 'POS Daily Sales' },
        Date: dateKey,
        DueDate: dateKey,
        Reference: `KCP daily sales ${dateKey}`,
        Status: 'AUTHORISED',
        // ol.total (aggregated into line.total below) is gross_amount — VAT-INCLUSIVE — per
        // sale-resolver.ts's lineAmounts (net = gross - tax). 'Exclusive' here previously told Xero
        // "this is the ex-VAT amount, add tax on top", double-counting VAT on every sales line.
        // 'Inclusive' tells Xero the UnitAmount already includes tax, which is what it actually is.
        // Still correct with TaxType 'NONE' below — Xero adds zero tax on top of a 'NONE' line
        // regardless of this setting, so the already-correct gross amount passes through unchanged.
        LineAmountTypes: 'Inclusive',
        LineItems: lines.map((line) => {
          // A zero-rated/VAT-exempt product (vat_enabled = 0, synced from Yoco's own per-item
          // `is_taxable` setting — see integration-service.ts) uses the exempt tax type if one's
          // configured, instead of blanket-applying the standard sales tax type to every product
          // regardless of its own real taxability — same pattern as purchaseExemptTaxType on the
          // GRV side (grv-sync.ts).
          const taxType = !workspaceIsVatRegistered
            ? NO_VAT_TAX_TYPE
            : Number(line.vat_enabled) === 0 && settings.salesExemptTaxType
              ? settings.salesExemptTaxType
              : settings.defaultTaxType;
          return {
            Description: text(line.label) || text(line.sku) || 'POS sale',
            Quantity: Number(line.quantity) || 1,
            UnitAmount: (Number(line.total) || 0) / (Number(line.quantity) || 1),
            AccountCode: settings.salesAccountCode,
            TaxType: taxType,
            ...(line.tracking ? { Tracking: line.tracking } : {})
          };
        })
      }
    ]
  };
}

/**
 * Pushes ONE Xero Invoice summarizing a single business day's completed POS sales for a
 * workspace — see the plan's rationale: per-transaction invoices would multiply Xero API calls
 * far beyond what's needed and create a lot of Xero-side noise for no benefit here. Idempotent via
 * the outbox: re-running for a day whose invoice already applied is a no-op.
 */
export async function syncXeroDailyInvoice(
  env: Env,
  workspaceId: string,
  dateKey: string,
  settings: { salesAccountCode: string; defaultTaxType: string; salesExemptTaxType?: string; locationTrackingCategoryId?: string },
  startHour = 0
): Promise<{ status: 'applied' | 'duplicate' | 'skipped_no_sales' | 'failed'; xeroInvoiceId?: string; error?: string }> {
  const effectKey = `invoice:${workspaceId}:${dateKey}`;
  const claim = await claimXeroEffect(env, workspaceId, 'INVOICE_PUSH', effectKey);
  if (claim.alreadyApplied) return { status: 'duplicate' };

  const lines = await aggregateDailySalesLines(env, workspaceId, dateKey, startHour);
  if (!lines.length) {
    // Not a failure — a quiet day has no invoice to push. Mark applied so this date is never
    // re-attempted once the due-check has genuinely looked at it.
    await markXeroEffectApplied(env, claim.id, '');
    return { status: 'skipped_no_sales' };
  }

  try {
    const workspaceIsVatRegistered = await isWorkspaceVatRegistered(env, workspaceId);
    const trackingContext = await loadLocationTrackingContext(env, workspaceId, text(settings.locationTrackingCategoryId));
    const linesWithTracking = await attachLocationTracking(env, workspaceId, lines, trackingContext);
    const payload = buildDailyInvoicePayload(dateKey, linesWithTracking, settings, workspaceIsVatRegistered);
    const result = await executeXeroApiRequest(env, workspaceId, { method: 'POST', path: 'Invoices', body: payload });
    const invoices = (result.Invoices as Array<{ InvoiceID?: string }> | undefined) || [];
    const xeroInvoiceId = text(invoices[0]?.InvoiceID);
    await markXeroEffectApplied(env, claim.id, xeroInvoiceId);
    return { status: 'applied', xeroInvoiceId };
  } catch (cause) {
    const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error pushing invoice to Xero.';
    await markXeroEffectFailed(env, claim.id, message);
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-invoice-push', status: 'failed', message, details: { dateKey } });
    return { status: 'failed', error: message };
  }
}

/**
 * "Push today's sales" manual button: unlike syncXeroDailyInvoice's strict once-per-day lock (used
 * by the real automated push, for a day that's already closed and can't gain more sales), this
 * always re-aggregates the FULL set of today's sales so far and either creates the day's invoice or
 * updates the existing one in place — so clicking it again later in the day after more sales come
 * in sends everything not yet reflected, not just what changed since the last click. Xero's
 * Invoices endpoint treats a POST body containing an InvoiceID as an update to that invoice rather
 * than a new one, which is what makes the "top up" behavior possible without tracking a per-sale
 * delta ourselves.
 */
export async function upsertXeroTodayInvoice(
  env: Env,
  workspaceId: string,
  settings: { salesAccountCode: string; defaultTaxType: string; salesExemptTaxType?: string; locationTrackingCategoryId?: string },
  startHour = 0
): Promise<{ status: 'applied' | 'updated' | 'skipped_no_sales' | 'failed'; xeroInvoiceId?: string; error?: string }> {
  const dateKey = todayDateKey(startHour);
  const effectKey = `invoice:${workspaceId}:${dateKey}`;
  const lines = await aggregateDailySalesLines(env, workspaceId, dateKey, startHour);
  if (!lines.length) return { status: 'skipped_no_sales' };

  const existing = await getXeroEffect(env, workspaceId, 'INVOICE_PUSH', effectKey);
  try {
    const workspaceIsVatRegistered = await isWorkspaceVatRegistered(env, workspaceId);
    const trackingContext = await loadLocationTrackingContext(env, workspaceId, text(settings.locationTrackingCategoryId));
    const linesWithTracking = await attachLocationTracking(env, workspaceId, lines, trackingContext);
    const payload = buildDailyInvoicePayload(dateKey, linesWithTracking, settings, workspaceIsVatRegistered, existing?.xeroObjectId || undefined);
    const result = await executeXeroApiRequest(env, workspaceId, { method: 'POST', path: 'Invoices', body: payload });
    const invoices = (result.Invoices as Array<{ InvoiceID?: string }> | undefined) || [];
    const xeroInvoiceId = text(invoices[0]?.InvoiceID) || existing?.xeroObjectId || '';
    await upsertXeroEffectApplied(env, workspaceId, 'INVOICE_PUSH', effectKey, xeroInvoiceId);
    return { status: existing?.xeroObjectId ? 'updated' : 'applied', xeroInvoiceId };
  } catch (cause) {
    const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error pushing invoice to Xero.';
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-invoice-push-today', status: 'failed', message, details: { dateKey } });
    return { status: 'failed', error: message };
  }
}

// Shifting raw UTC "now" by (2 - startHour) hours lands on a synthetic instant whose UTC calendar
// date IS the current trading day: for the default startHour=0 this reduces to the plain
// SAST-wall-clock shift the code always used (+2h), so existing midnight-start venues see no
// change at all. For a 5am-start venue, a sale at 1am SAST is still within YESTERDAY's trading day
// (it hasn't rolled over to today's yet) — shifting by (2 - 5) = -3h moves 1am SAST back onto
// yesterday's calendar date, which is exactly the trading day businessDayUtcBounds(yesterday, 5)
// covers ([yesterday 05:00 SAST, today 05:00 SAST)).
// `now` is injectable (defaults to the real clock) purely so tests can assert the shift formula
// deterministically — every production call site relies on the default.
function currentTradingDayShifted(startHour: number, now: Date = new Date()): Date {
  const hour = clampStartHour(startHour);
  return new Date(now.getTime() + (2 - hour) * 60 * 60 * 1000);
}

/** The last fully-closed trading day (starting at `startHour` SAST, default midnight) — safe to
 * invoice without risking a partial day (a sale still being rung up when the cron fires). */
export function yesterdayDateKey(startHour = 0, now: Date = new Date()): string {
  const shifted = currentTradingDayShifted(startHour, now);
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Today's (still-open) trading day — for the manual "Push today's sales" test/preview button only.
 * The automatic due-check always uses yesterdayDateKey(): pushing a day that's still accumulating
 * sales means a second push later the same day is a same-day duplicate (per the effect-outbox's
 * per-calendar-day key) and will just report 'duplicate' rather than topping up the invoice with
 * sales rung up since the first push — acceptable for a manual preview/test action, but why this is
 * never used for the scheduled push.
 */
export function todayDateKey(startHour = 0, now: Date = new Date()): string {
  return currentTradingDayShifted(startHour, now).toISOString().slice(0, 10);
}

// Automatic daily due-checks (this one, plus GRV/Credit Note's own claim functions in
// grv-sync.ts/credit-note-sync.ts) wait an extra hour past the trading day's exact close before
// treating that day as syncable — a deliberate buffer so a payment/webhook still settling in the
// last few minutes of the day, or a GRV/credit note keyed slightly after midnight, isn't raced past
// by the very first check after the boundary. The manual "push now" buttons (postSyncNow) use the
// plain yesterdayDateKey/no buffer at all — a human clicking the button has already decided the day
// is done, so there's nothing to protect against there.
const AUTO_SYNC_GRACE_HOURS = 1;

export function autoSyncDueDateKey(startHour = 0, now: Date = new Date()): string {
  return yesterdayDateKey(startHour, new Date(now.getTime() - AUTO_SYNC_GRACE_HOURS * 60 * 60 * 1000));
}

export async function claimDailyInvoiceSyncIfDue(env: Env, workspaceId: string, startHour = 0): Promise<{ due: boolean; dateKey?: string }> {
  const dateKey = autoSyncDueDateKey(startHour);
  const now = nowIso();
  const settings = await env.DB.prepare(`SELECT last_invoice_sync_date, invoice_sync_claimed_at, enabled FROM xero_sync_settings WHERE workspace_id = ?1`)
    .bind(workspaceId)
    .first<{ last_invoice_sync_date?: string; invoice_sync_claimed_at?: string; enabled?: number }>();
  if (!settings || !settings.enabled) return { due: false };
  if (settings.last_invoice_sync_date === dateKey) return { due: false };
  // A stale claim (crashed mid-run) doesn't block retries beyond a day — cheap self-heal, mirrors
  // claimCatalogueSyncIfDue's own staleness tolerance in legacy/routes.ts.
  const claimedAt = settings.invoice_sync_claimed_at ? new Date(settings.invoice_sync_claimed_at).getTime() : 0;
  if (claimedAt && Date.now() - claimedAt < 60 * 60 * 1000) return { due: false };
  await env.DB.prepare(`UPDATE xero_sync_settings SET invoice_sync_claimed_at = ?2, updated_at = ?2 WHERE workspace_id = ?1`)
    .bind(workspaceId, now)
    .run();
  return { due: true, dateKey };
}

export async function releaseDailyInvoiceSyncClaim(env: Env, workspaceId: string, dateKey: string, success: boolean): Promise<void> {
  const now = nowIso();
  if (success) {
    await env.DB.prepare(
      `UPDATE xero_sync_settings SET last_invoice_sync_date = ?2, invoice_sync_claimed_at = NULL, updated_at = ?3 WHERE workspace_id = ?1`
    )
      .bind(workspaceId, dateKey, now)
      .run();
  } else {
    await env.DB.prepare(`UPDATE xero_sync_settings SET invoice_sync_claimed_at = NULL, updated_at = ?2 WHERE workspace_id = ?1`)
      .bind(workspaceId, now)
      .run();
  }
}
