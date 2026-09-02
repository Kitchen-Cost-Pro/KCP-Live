import type { Env } from '../../legacy/types';
import { nowIso } from './config';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function stableId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(value)).slice(0, 32)}`;
}

// Deliberately its own table/type union rather than widening modules/xero-engine/outbox.ts's
// xero_v2_effect_outbox — that table's effect_type CHECK constraint makes adding a new type an
// expensive drop/create/copy/rename migration (see XERO_V2_GRV_PUSH_MIGRATION for the pattern this
// avoids), and there's no reason Drive's push tracking should ever be coupled to Xero's.
export type DriveEffectType = 'GRV_PDF_PUSH' | 'CREDIT_NOTE_PDF_PUSH';

/** Idempotent write-tracking, identical shape to modules/xero-engine/outbox.ts's
 * claimXeroEffect/markXeroEffectApplied/markXeroEffectFailed — an effect_key upsert that never
 * regresses an already-APPLIED row back to PROCESSING, so a retried due-check or duplicate
 * sync-now call can never push the same GRV/Credit Note PDF to Drive twice. */
export async function claimDriveEffect(env: Env, workspaceId: string, effectType: DriveEffectType, effectKey: string): Promise<{ id: string; alreadyApplied: boolean }> {
  const id = await stableId('drive_outbox', `${workspaceId}|${effectType}|${effectKey}`);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO drive_effect_outbox (id, workspace_id, effect_type, effect_key, status, attempt_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'PROCESSING', 1, ?5, ?5)
     ON CONFLICT(workspace_id, effect_type, effect_key) DO UPDATE SET
       status = CASE WHEN drive_effect_outbox.status = 'APPLIED' THEN 'APPLIED' ELSE 'PROCESSING' END,
       attempt_count = drive_effect_outbox.attempt_count + 1,
       updated_at = excluded.updated_at`
  )
    .bind(id, workspaceId, effectType, effectKey, now)
    .run();
  const row = await env.DB.prepare(`SELECT status FROM drive_effect_outbox WHERE id = ?1 LIMIT 1`).bind(id).first<{ status: string }>();
  return { id, alreadyApplied: row?.status === 'APPLIED' };
}

export async function markDriveEffectApplied(env: Env, id: string, driveFileId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE drive_effect_outbox SET status = 'APPLIED', drive_file_id = ?2, updated_at = ?3 WHERE id = ?1`
  )
    .bind(id, driveFileId, nowIso())
    .run();
}

export async function markDriveEffectFailed(env: Env, id: string, message: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE drive_effect_outbox SET status = 'FAILED', last_error = ?2, updated_at = ?3 WHERE id = ?1`
  )
    .bind(id, message.slice(0, 500), nowIso())
    .run();
}
