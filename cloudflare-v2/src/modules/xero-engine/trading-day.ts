import type { Env } from '../../legacy/types';
// @ts-ignore Shared timezone/trading-day helpers used by the reporting client and Worker.
import { normalizeTradingDayStartMinutes } from '../../../../src/modules/reporting/engine/timezone.js';

/**
 * The venue's trading-day start hour, read from the SAME workspace_settings.raw_json a business
 * already configures once under Settings ("Trading day starts at...") — see
 * src/components/Settings.js / src/services/settingsService.js's normalizeSettings
 * (tradingDayStartHour/reportingDayFromHour) and src/modules/reporting/engine/timezone.js's
 * normalizeTradingDayStartMinutes, which reporting and stock-take-counted-at.ts already use. Xero's
 * daily sales push reuses it rather than inventing its own per-integration trading-hours setting,
 * so a venue only has to set its trading hours once and every feature buckets sales into the same
 * "day".
 *
 * Deliberately NOT pulling in this module's IANA-timezone-aware zonedLocalDateTimeToUtc/
 * localDateRangeToUtcBounds — invoice-sync.ts's businessDayUtcBounds keeps its existing fixed
 * UTC+2/no-DST assumption (an intentional simplification already noted there); only the hardcoded
 * midnight becomes configurable, not the offset model.
 */
export async function getWorkspaceTradingDayStartHour(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`)
    .bind(workspaceId)
    .first<{ raw_json: string | null }>();
  if (!row?.raw_json) return 0;
  try {
    const parsed = JSON.parse(row.raw_json);
    const minutes = normalizeTradingDayStartMinutes(parsed);
    return Math.floor((Number(minutes) || 0) / 60);
  } catch {
    return 0;
  }
}
