import type { Env } from '../../legacy/types';
import { text, nowIso } from './config';
import { executeXeroApiRequest, XeroApiClientError } from './api-client';
import { claimXeroEffect, markXeroEffectApplied, markXeroEffectFailed } from './outbox';
import { recordXeroDiagnosticIfNotable } from './observability';

interface AggregatedLineRow {
  label: string;
  product_id: string | null;
  sku: string | null;
  quantity: number;
  total: number;
}

// SAST is a fixed UTC+2 offset (no DST) — same hardcoded assumption the Yoco engine already makes
// (see johannesburgIso in live-sale.ts/live-refund.ts) for turning a UTC instant into the
// merchant's local business day.
function businessDayUtcBounds(dateKey: string): { startIso: string; endIso: string } {
  const start = new Date(`${dateKey}T00:00:00+02:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function aggregateDailySalesLines(env: Env, workspaceId: string, dateKey: string): Promise<AggregatedLineRow[]> {
  const { startIso, endIso } = businessDayUtcBounds(dateKey);
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
       AND o.status = 'completed'
       AND o.occurred_at >= ?2 AND o.occurred_at < ?3
     GROUP BY COALESCE(ol.product_id, ol.name)
     ORDER BY label ASC`
  )
    .bind(workspaceId, startIso, endIso)
    .all<AggregatedLineRow>();
  return rows.results || [];
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
  settings: { salesAccountCode: string; defaultTaxType: string }
): Promise<{ status: 'applied' | 'duplicate' | 'skipped_no_sales' | 'failed'; xeroInvoiceId?: string; error?: string }> {
  const effectKey = `invoice:${workspaceId}:${dateKey}`;
  const claim = await claimXeroEffect(env, workspaceId, 'INVOICE_PUSH', effectKey);
  if (claim.alreadyApplied) return { status: 'duplicate' };

  const lines = await aggregateDailySalesLines(env, workspaceId, dateKey);
  if (!lines.length) {
    // Not a failure — a quiet day has no invoice to push. Mark applied so this date is never
    // re-attempted once the due-check has genuinely looked at it.
    await markXeroEffectApplied(env, claim.id, '');
    return { status: 'skipped_no_sales' };
  }

  try {
    const payload = {
      Invoices: [
        {
          Type: 'ACCREC',
          Contact: { Name: 'POS Daily Sales' },
          Date: dateKey,
          DueDate: dateKey,
          Reference: `KCP daily sales ${dateKey}`,
          Status: 'AUTHORISED',
          LineAmountTypes: 'Exclusive',
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

/** "Yesterday" in SAST — the last fully-closed business day, safe to invoice without risking a
 * partial day (a sale still being rung up when the cron fires). */
export function yesterdayDateKey(): string {
  const now = new Date();
  const sast = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  sast.setUTCDate(sast.getUTCDate() - 1);
  return sast.toISOString().slice(0, 10);
}

export async function claimDailyInvoiceSyncIfDue(env: Env, workspaceId: string): Promise<{ due: boolean; dateKey?: string }> {
  const dateKey = yesterdayDateKey();
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
