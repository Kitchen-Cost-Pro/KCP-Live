import type { Env } from '../../legacy/types';
import { nowIso, xeroRateCaps } from './config';

// Off-by-one: slice(0, 15) stops BEFORE the minute's ones digit (index 15), so appending '0'
// zeroed the ones digit of MINUTES rather than the seconds — e.g. 12:31 through 12:39 all
// collapsed onto the SAME "12:30" bucket. That silently turned the "per-minute" cap into a
// per-10-minutes cap (~10x stricter than intended), which is exactly what was tripping "Per-minute
// Xero API call cap reached" on an ordinary handful of GRV pushes. slice(0, 16) keeps full
// HH:MM precision and simply drops seconds, giving a genuine one-minute bucket.
function minuteBucket(date: Date): string {
  return date.toISOString().slice(0, 16); // e.g. '2026-08-31T12:37:45.123Z' -> '2026-08-31T12:37'
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Lean, in-tenant-DB substitute for a dedicated rate-gate Durable Object (see the Yoco engine's
 * rate-gate.ts for the full version). No circuit breaker, no request coalescing, no response
 * cache — just a hard stop before the daily/per-minute call budget is exceeded. Appropriate here
 * because this integration is a scheduled daily push, not a high-frequency webhook stream; Xero's
 * real caps (60/min, 5,000/day per tenant) are generous relative to that volume.
 */
export async function reserveXeroApiCall(env: Env, workspaceId: string): Promise<{ allowed: boolean; reason?: string }> {
  const now = new Date();
  const { dailyCap, perMinuteCap } = xeroRateCaps(env);
  const today = dayKey(now);
  const minute = minuteBucket(now);
  const row = await env.DB.prepare(`SELECT * FROM xero_v2_rate_state WHERE id = 'global' LIMIT 1`).first<{
    date_key?: string;
    calls_today?: number;
    minute_bucket?: string;
    calls_this_minute?: number;
  }>();
  const sameDay = row?.date_key === today;
  const sameMinute = row?.minute_bucket === minute;
  const callsToday = sameDay ? Number(row?.calls_today || 0) : 0;
  const callsThisMinute = sameMinute ? Number(row?.calls_this_minute || 0) : 0;
  if (callsToday >= dailyCap) return { allowed: false, reason: `Daily Xero API call cap (${dailyCap}) reached for this workspace.` };
  if (callsThisMinute >= perMinuteCap) return { allowed: false, reason: `Per-minute Xero API call cap (${perMinuteCap}) reached — try again shortly.` };
  await env.DB.prepare(
    `INSERT INTO xero_v2_rate_state (id, date_key, calls_today, minute_bucket, calls_this_minute, updated_at)
     VALUES ('global', ?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET
       date_key = excluded.date_key, calls_today = excluded.calls_today,
       minute_bucket = excluded.minute_bucket, calls_this_minute = excluded.calls_this_minute,
       updated_at = excluded.updated_at`
  )
    .bind(today, callsToday + 1, minute, callsThisMinute + 1, nowIso())
    .run();
  return { allowed: true };
}
