import type { Env } from "./types";
// @ts-ignore Shared timezone helpers used by the reporting client and Worker.
import {
  zonedLocalDateTimeToUtc,
  localDateRangeToUtcBounds,
  normalizeReportTimeZone,
  normalizeTradingDayStartMinutes,
} from "../../../src/modules/reporting/engine/timezone.js";

function nowIso(): string {
  return new Date().toISOString();
}

// Resolves the `counted_at` to store for a user-picked stock-take date ("YYYY-MM-DD").
//
// When the picked date is the workspace's current trading day (the common case — counting today),
// the real submission instant is used, so the Stock Take Log shows the actual time it was counted
// AND it naturally falls inside "Today"'s report window (see getStockTakeAuditReport/addZonedDateRange,
// which the report queries against with the same timezone + trading-day-start).
//
// When the picked date is a different day (backdating a count), there is no real "now" to anchor to,
// so the count is stamped to that day's trading-day start instead — still landing inside the correct
// day's window, just without a meaningful clock time.
//
// Extracted to its own module (not inline in routes.ts) so it's testable without pulling in
// routes.ts's heavy transitive imports.
export async function resolveStockTakeCountedAt(
  env: Env,
  workspaceId: string,
  isoDate: string,
): Promise<string> {
  const dateMatch = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return nowIso();
  const [workspaceRow, settingsRow] = await Promise.all([
    env.CENTRAL_DB.prepare(`SELECT timezone FROM workspaces WHERE id = ?1 LIMIT 1`)
      .bind(workspaceId)
      .first<{ timezone?: string }>(),
    env.DB.prepare(`SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`)
      .bind(workspaceId)
      .first<{ raw_json?: string }>(),
  ]);
  const timeZone = normalizeReportTimeZone(workspaceRow?.timezone || "Africa/Johannesburg");
  let settings: Record<string, unknown> = {};
  try {
    settings = settingsRow?.raw_json ? JSON.parse(settingsRow.raw_json) : {};
  } catch {
    settings = {};
  }
  const tradingDayStartMinutes = normalizeTradingDayStartMinutes(settings as any);

  const now = nowIso();
  const bounds = localDateRangeToUtcBounds({
    from: isoDate,
    to: isoDate,
    timeZone,
    tradingDayStartMinutes,
  });
  if (now >= bounds.fromUtc && now < bounds.toExclusiveUtc) return now;

  const startHour = Math.floor(tradingDayStartMinutes / 60);
  const startMinute = tradingDayStartMinutes % 60;
  return zonedLocalDateTimeToUtc(
    Number(dateMatch[1]),
    Number(dateMatch[2]),
    Number(dateMatch[3]),
    startHour,
    startMinute,
    0,
    timeZone,
  ).toISOString();
}
