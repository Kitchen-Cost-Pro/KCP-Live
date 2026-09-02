import type { Env } from '../../legacy/types';
import { text, nowIso } from './config';
import { executeXeroApiRequest, XeroApiClientError } from './api-client';
import { claimXeroEffect, markXeroEffectApplied, markXeroEffectFailed, getXeroEffect, upsertXeroEffectApplied } from './outbox';
import { recordXeroDiagnosticIfNotable } from './observability';
import { loadLocationTrackingContext, resolveLocationTracking, type LocationTrackingContext } from './tracking';
import { businessDayUtcBounds, todayDateKey, autoSyncDueDateKey } from './invoice-sync';

interface AggregatedWastageRow {
  location_id: string | null;
  location_name: string | null;
  total_value: number;
  // Pre-resolved by syncXeroDailyWastage/upsertXeroTodayWastage (via tracking.ts) before
  // buildWastageJournalPayload is called — same pattern as invoice-sync.ts's AggregatedLineRow.
  tracking?: Array<{ TrackingCategoryID: string; TrackingOptionID: string }>;
}

/**
 * Sums the day's wastage cost per location from stock_movements, the same source table
 * postWastageAdjustment (legacy/routes.ts) writes to at write time — value_delta is already
 * `quantity_delta * unit_cost` there, so no re-join against adjustments/adjustment_lines is
 * needed. document_type is checked against both historical spellings ('wastage_adjustment' and
 * 'wastage-adjustment'), matching IS_PRODUCT_WASTAGE_SQL's existing dual-spelling handling
 * (legacy/routes.ts) — wastage rows have always been written with an underscore, but the
 * reporting code guards both, so this does too. value_delta is negative (removing stock), so ABS()
 * turns it into the positive expense amount a Xero journal debit line needs.
 */
export async function aggregateDailyWastageLines(env: Env, workspaceId: string, dateKey: string, startHour: number): Promise<AggregatedWastageRow[]> {
  const { startIso, endIso } = businessDayUtcBounds(dateKey, startHour);
  const rows = await env.DB.prepare(
    `SELECT
       sm.location_id AS location_id,
       COALESCE(l.display_name, l.name) AS location_name,
       SUM(ABS(sm.value_delta)) AS total_value
     FROM stock_movements sm
     LEFT JOIN locations l ON l.id = sm.location_id AND l.workspace_id = sm.workspace_id
     WHERE sm.workspace_id = ?1
       AND lower(COALESCE(sm.document_type, '')) IN ('wastage_adjustment', 'wastage-adjustment')
       AND datetime(sm.occurred_at) >= datetime(?2) AND datetime(sm.occurred_at) < datetime(?3)
     GROUP BY sm.location_id
     HAVING SUM(ABS(sm.value_delta)) != 0
     ORDER BY location_name ASC`
  )
    .bind(workspaceId, startIso, endIso)
    .all<AggregatedWastageRow>();
  return rows.results || [];
}

async function attachLocationTracking(
  env: Env,
  workspaceId: string,
  lines: AggregatedWastageRow[],
  trackingContext: LocationTrackingContext | null
): Promise<AggregatedWastageRow[]> {
  return Promise.all(
    lines.map(async (line) => ({ ...line, tracking: await resolveLocationTracking(env, workspaceId, trackingContext, line.location_name) }))
  );
}

export interface WastageJournalSettings {
  wastageExpenseAccountCode: string;
  wastageAssetAccountCode: string;
}

/**
 * One Manual Journal per trading day: a debit line per location (so location tracking still
 * applies, same as GRV/Credit Note/Sales), and a single aggregate credit line for the whole day's
 * total — the inventory asset doesn't need a per-location tracking split since it's not being
 * reported on by location, only the expense side is. No TaxType on either line: an internal
 * inventory write-off isn't a supply or purchase, so nothing here is VATable.
 */
export function buildWastageJournalPayload(dateKey: string, lines: AggregatedWastageRow[], settings: WastageJournalSettings, existingJournalId?: string) {
  const total = lines.reduce((sum, line) => sum + (Number(line.total_value) || 0), 0);
  return {
    ManualJournals: [
      {
        ...(existingJournalId ? { ManualJournalID: existingJournalId } : {}),
        Narration: `KCP wastage ${dateKey}`,
        Date: dateKey,
        Status: 'POSTED',
        JournalLines: [
          ...lines.map((line) => ({
            LineAmount: Number(line.total_value) || 0,
            AccountCode: settings.wastageExpenseAccountCode,
            Description: text(line.location_name) || 'Wastage',
            ...(line.tracking ? { Tracking: line.tracking } : {})
          })),
          {
            LineAmount: -total,
            AccountCode: settings.wastageAssetAccountCode,
            Description: `Wastage ${dateKey}`
          }
        ]
      }
    ]
  };
}

async function loadTrackedLines(env: Env, workspaceId: string, dateKey: string, startHour: number, locationTrackingCategoryId?: string) {
  const lines = await aggregateDailyWastageLines(env, workspaceId, dateKey, startHour);
  if (!lines.length) return lines;
  const trackingContext = await loadLocationTrackingContext(env, workspaceId, text(locationTrackingCategoryId));
  return attachLocationTracking(env, workspaceId, lines, trackingContext);
}

/**
 * Automated, strict once-per-trading-day push — mirrors syncXeroDailyInvoice exactly (same
 * claim/skip-if-already-applied shape via the outbox).
 */
export async function syncXeroDailyWastage(
  env: Env,
  workspaceId: string,
  dateKey: string,
  settings: WastageJournalSettings & { locationTrackingCategoryId?: string },
  startHour = 0
): Promise<{ status: 'applied' | 'duplicate' | 'skipped_no_wastage' | 'failed'; xeroJournalId?: string; error?: string }> {
  const effectKey = `wastage:${workspaceId}:${dateKey}`;
  const claim = await claimXeroEffect(env, workspaceId, 'WASTAGE_PUSH', effectKey);
  if (claim.alreadyApplied) return { status: 'duplicate' };

  const lines = await loadTrackedLines(env, workspaceId, dateKey, startHour, settings.locationTrackingCategoryId);
  if (!lines.length) {
    await markXeroEffectApplied(env, claim.id, '');
    return { status: 'skipped_no_wastage' };
  }

  try {
    const payload = buildWastageJournalPayload(dateKey, lines, settings);
    const result = await executeXeroApiRequest(env, workspaceId, { method: 'POST', path: 'ManualJournals', body: payload });
    const journals = (result.ManualJournals as Array<{ ManualJournalID?: string }> | undefined) || [];
    const xeroJournalId = text(journals[0]?.ManualJournalID);
    await markXeroEffectApplied(env, claim.id, xeroJournalId);
    return { status: 'applied', xeroJournalId };
  } catch (cause) {
    const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error pushing wastage journal to Xero.';
    await markXeroEffectFailed(env, claim.id, message);
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-wastage-push', status: 'failed', message, details: { dateKey } });
    return { status: 'failed', error: message };
  }
}

/**
 * "Push today's wastage" manual button — mirrors upsertXeroTodayInvoice: always re-aggregates the
 * FULL set of today's wastage so far and either creates the day's journal or replaces it, so
 * clicking again later in the day after more wastage is logged sends the corrected total.
 */
export async function upsertXeroTodayWastage(
  env: Env,
  workspaceId: string,
  settings: WastageJournalSettings & { locationTrackingCategoryId?: string },
  startHour = 0
): Promise<{ status: 'applied' | 'updated' | 'skipped_no_wastage' | 'failed'; xeroJournalId?: string; error?: string }> {
  const dateKey = todayDateKey(startHour);
  const effectKey = `wastage:${workspaceId}:${dateKey}`;
  const lines = await loadTrackedLines(env, workspaceId, dateKey, startHour, settings.locationTrackingCategoryId);
  if (!lines.length) return { status: 'skipped_no_wastage' };

  const existing = await getXeroEffect(env, workspaceId, 'WASTAGE_PUSH', effectKey);
  try {
    const payload = buildWastageJournalPayload(dateKey, lines, settings, existing?.xeroObjectId || undefined);
    const result = await executeXeroApiRequest(env, workspaceId, { method: 'POST', path: 'ManualJournals', body: payload });
    const journals = (result.ManualJournals as Array<{ ManualJournalID?: string }> | undefined) || [];
    const xeroJournalId = text(journals[0]?.ManualJournalID) || existing?.xeroObjectId || '';
    await upsertXeroEffectApplied(env, workspaceId, 'WASTAGE_PUSH', effectKey, xeroJournalId);
    return { status: existing?.xeroObjectId ? 'updated' : 'applied', xeroJournalId };
  } catch (cause) {
    const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error pushing wastage journal to Xero.';
    await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-wastage-push-today', status: 'failed', message, details: { dateKey } });
    return { status: 'failed', error: message };
  }
}

/**
 * Own independent daily claim, same pattern as claimDailyCreditNoteSyncIfDue (credit-note-sync.ts)
 * — but trading-day-bound like the sales invoice claim (unlike credit notes, wastage aggregation
 * IS date-bounded, since it sums one specific trading day's stock_movements), so this takes the
 * workspace's actual trading-day start hour rather than assuming midnight.
 */
export async function claimDailyWastageSyncIfDue(env: Env, workspaceId: string, startHour = 0): Promise<{ due: boolean; dateKey?: string }> {
  const dateKey = autoSyncDueDateKey(startHour);
  const now = nowIso();
  const settings = await env.DB.prepare(
    `SELECT last_wastage_sync_date, wastage_sync_claimed_at, wastage_sync_enabled FROM xero_sync_settings WHERE workspace_id = ?1`
  )
    .bind(workspaceId)
    .first<{ last_wastage_sync_date?: string; wastage_sync_claimed_at?: string; wastage_sync_enabled?: number }>();
  if (!settings || !settings.wastage_sync_enabled) return { due: false };
  if (settings.last_wastage_sync_date === dateKey) return { due: false };
  const claimedAt = settings.wastage_sync_claimed_at ? new Date(settings.wastage_sync_claimed_at).getTime() : 0;
  if (claimedAt && Date.now() - claimedAt < 60 * 60 * 1000) return { due: false };
  await env.DB.prepare(`UPDATE xero_sync_settings SET wastage_sync_claimed_at = ?2, updated_at = ?2 WHERE workspace_id = ?1`)
    .bind(workspaceId, now)
    .run();
  return { due: true, dateKey };
}

export async function releaseDailyWastageSyncClaim(env: Env, workspaceId: string, dateKey: string, success: boolean): Promise<void> {
  const now = nowIso();
  if (success) {
    await env.DB.prepare(
      `UPDATE xero_sync_settings SET last_wastage_sync_date = ?2, wastage_sync_claimed_at = NULL, updated_at = ?3 WHERE workspace_id = ?1`
    )
      .bind(workspaceId, dateKey, now)
      .run();
  } else {
    await env.DB.prepare(`UPDATE xero_sync_settings SET wastage_sync_claimed_at = NULL, updated_at = ?2 WHERE workspace_id = ?1`)
      .bind(workspaceId, now)
      .run();
  }
}
