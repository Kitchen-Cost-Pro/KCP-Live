import type { Env } from '../../legacy/types';
import { nowIso } from './config';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function stableId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(value)).slice(0, 32)}`;
}

export type XeroEffectType = 'ITEM_PUSH' | 'INVOICE_PUSH' | 'GRV_PUSH' | 'GRV_ATTACHMENT' | 'GRV_PAYMENT' | 'CREDIT_NOTE_PUSH' | 'WASTAGE_PUSH';

/**
 * Idempotent write-tracking, mirroring modules/yoco-engine-v2/live-sale.ts's effect-outbox
 * pattern: an `effect_key` upsert that never regresses an already-`APPLIED` row back to
 * `PROCESSING`, so a retried cron tick (or a double-fired due-check) can never re-push the same
 * day's invoice or the same item twice.
 */
export async function claimXeroEffect(env: Env, workspaceId: string, effectType: XeroEffectType, effectKey: string): Promise<{ id: string; alreadyApplied: boolean }> {
  const id = await stableId('xero_v2_outbox', `${workspaceId}|${effectType}|${effectKey}`);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO xero_v2_effect_outbox (id, workspace_id, effect_type, effect_key, status, attempt_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'PROCESSING', 1, ?5, ?5)
     ON CONFLICT(workspace_id, effect_type, effect_key) DO UPDATE SET
       status = CASE WHEN xero_v2_effect_outbox.status = 'APPLIED' THEN 'APPLIED' ELSE 'PROCESSING' END,
       attempt_count = xero_v2_effect_outbox.attempt_count + 1,
       updated_at = excluded.updated_at`
  )
    .bind(id, workspaceId, effectType, effectKey, now)
    .run();
  const row = await env.DB.prepare(`SELECT status FROM xero_v2_effect_outbox WHERE id = ?1 LIMIT 1`).bind(id).first<{ status: string }>();
  return { id, alreadyApplied: row?.status === 'APPLIED' };
}

export async function markXeroEffectApplied(env: Env, id: string, xeroObjectId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE xero_v2_effect_outbox SET status = 'APPLIED', xero_object_id = ?2, updated_at = ?3 WHERE id = ?1`
  )
    .bind(id, xeroObjectId, nowIso())
    .run();
}

export async function markXeroEffectFailed(env: Env, id: string, message: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE xero_v2_effect_outbox SET status = 'FAILED', last_error = ?2, updated_at = ?3 WHERE id = ?1`
  )
    .bind(id, message.slice(0, 500), nowIso())
    .run();
}

/** Plain lookup, no locking — used by flows that intentionally re-run every call (the "push
 * today's sales" upsert) rather than skip-if-already-applied like claimXeroEffect. */
export async function getXeroEffect(
  env: Env,
  workspaceId: string,
  effectType: XeroEffectType,
  effectKey: string
): Promise<{ id: string; xeroObjectId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT id, xero_object_id FROM xero_v2_effect_outbox WHERE workspace_id = ?1 AND effect_type = ?2 AND effect_key = ?3 LIMIT 1`
  )
    .bind(workspaceId, effectType, effectKey)
    .first<{ id: string; xero_object_id: string | null }>();
  return row ? { id: row.id, xeroObjectId: row.xero_object_id || '' } : null;
}

/**
 * Always writes/updates 'APPLIED', regardless of the row's current status — the "re-run every
 * call" counterpart to claimXeroEffect's "skip if already APPLIED" lock. Used by the today's-sales
 * upsert flow, where re-processing the same effect_key on every click is the whole point (each
 * call reflects the day's current full total, not a one-shot).
 */
export async function upsertXeroEffectApplied(
  env: Env,
  workspaceId: string,
  effectType: XeroEffectType,
  effectKey: string,
  xeroObjectId: string
): Promise<void> {
  const id = await stableId('xero_v2_outbox', `${workspaceId}|${effectType}|${effectKey}`);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO xero_v2_effect_outbox (id, workspace_id, effect_type, effect_key, status, xero_object_id, attempt_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'APPLIED', ?5, 1, ?6, ?6)
     ON CONFLICT(workspace_id, effect_type, effect_key) DO UPDATE SET
       status = 'APPLIED',
       xero_object_id = excluded.xero_object_id,
       attempt_count = xero_v2_effect_outbox.attempt_count + 1,
       updated_at = excluded.updated_at`
  )
    .bind(id, workspaceId, effectType, effectKey, xeroObjectId, now)
    .run();
}
