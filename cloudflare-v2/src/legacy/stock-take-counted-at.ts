import type { Env } from "./types";
// @ts-ignore Shared timezone helpers used by the reporting client and Worker.
import {
  zonedLocalDateTimeToUtc,
  normalizeReportTimeZone,
  normalizeTradingDayStartMinutes,
} from "../../../src/modules/reporting/engine/timezone.js";

function nowIso(): string {
  return new Date().toISOString();
}

// Anchors a user-picked stock-take date ("YYYY-MM-DD") to the workspace's actual trading-day start
// in UTC, matching exactly how getStockTakeAuditReport/addZonedDateRange computes its "Today" /
// "Yesterday" query bounds — otherwise a naive UTC-midnight timestamp can fall on the wrong side of
// the workspace's timezone or configured trading-day-start hour and the count silently disappears
// from those exact-day filters even though it was captured today. Extracted to its own module (not
// inline in routes.ts) so it's testable without pulling in routes.ts's heavy transitive imports.
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
