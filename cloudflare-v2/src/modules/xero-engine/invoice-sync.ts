import type { Env } from '../../legacy/types';
import { text, nowIso } from './config';
import { executeXeroApiRequest, XeroApiClientError } from './api-client';
import { claimXeroEffect, markXeroEffectApplied, markXeroEffectFailed, getXeroEffect, upsertXeroEffectApplied } from './outbox';
import { recordXeroDiagnosticIfNotable } from './observability';

interface AggregatedLineRow {
  label: string;
  product_id: string | null;
  sku: string | null;
  quantity: number;
  total: number;
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

async function aggregateDailySalesLines(env: Env, workspaceId: string, dateKey: string, startHour: number): Promise<AggregatedLineRow[]> {
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
  const rows = await env.DB.prepare(
    `SELECT
       COALESCE(p.name, ol.name) AS label,
       ol.product_id AS product_id,
       p.sku AS sku,
       SUM(ol.quantity) AS quantity,
       SUM(ol.total) AS total
     FROM yoco_order_lines ol
     JOIN yoco_orders o ON o.id = ol.yoco_order_id AND o.workspace_id = ol.workspace_id
     LEFT JOIN products p ON p.id = ol.product_id AND p.workspace_id = ol.workspace_id
     WHERE ol.workspace_id = ?1
       AND o.order_type = 'sale'
       AND datetime(o.occurred_at) >= datetime(?2) AND datetime(o.occurred_at) < datetime(?3)
     GROUP BY COALESCE(ol.product_id, ol.name)
     ORDER BY label ASC`
  )
    .bind(workspaceId, startIso, endIso)
    .all<AggregatedLineRow>();
  return rows.results || [];
}

export function buildDailyInvoicePayload(
  dateKey: string,
  lines: AggregatedLineRow[],
  settings: { salesAccountCode: string; defaultTaxType: string },
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
        LineAmountTypes: 'Inclusive',
        LineItems: lines.map((line) => ({
          Description: text(line.label) || text(line.sku) || 'POS sale',
          Quantity: Number(line.quantity) || 1,
          UnitAmount: (Number(line.total) || 0) / (Number(line.quantity) || 1),
          AccountCode: settings.salesAccountCode,
          TaxType: settings.defaultTaxType
        }))
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
  settings: { salesAccountCode: string; defaultTaxType: string },
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
    const payload = buildDailyInvoicePayload(dateKey, lines, settings);
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
  settings: { salesAccountCode: string; defaultTaxType: string },
  startHour = 0
): Promise<{ status: 'applied' | 'updated' | 'skipped_no_sales' | 'failed'; xeroInvoiceId?: string; error?: string }> {
  const dateKey = todayDateKey(startHour);
  const effectKey = `invoice:${workspaceId}:${dateKey}`;
  const lines = await aggregateDailySalesLines(env, workspaceId, dateKey, startHour);
  if (!lines.length) return { status: 'skipped_no_sales' };

  const existing = await getXeroEffect(env, workspaceId, 'INVOICE_PUSH', effectKey);
  try {
    const payload = buildDailyInvoicePayload(dateKey, lines, settings, existing?.xeroObjectId || undefined);
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

export async function claimDailyInvoiceSyncIfDue(env: Env, workspaceId: string, startHour = 0): Promise<{ due: boolean; dateKey?: string }> {
  const dateKey = yesterdayDateKey(startHour);
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
