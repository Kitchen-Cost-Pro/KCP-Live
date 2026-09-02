import type { Env } from '../../legacy/types';
import { text, objectValue, nowIso } from './config';
import { uploadFile } from './drive-client';
import { ensureLocationFolders } from './folders';
import { claimDriveEffect, markDriveEffectApplied, markDriveEffectFailed } from './outbox';
import { creditNoteToPdfBytes } from '../../../../src/modules/reporting/exports/exportPdf.js';

interface CreditNoteRow {
  id: string;
  credit_note_number: string;
  supplier_name: string | null;
  credited_at: string;
  reason: string | null;
  total_ex: number | null;
  location_id: string | null;
  location_name: string | null;
  raw_json: string | null;
  version: number | null;
}

function parseCreditNoteItems(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = objectValue(JSON.parse(raw));
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function pushOneCreditNotePdfToDrive(env: Env, workspaceId: string, creditNote: CreditNoteRow): Promise<{ status: string; driveFileId?: string; error?: string }> {
  const effectKey = (creditNote.version || 1) > 1
    ? `credit-note:${workspaceId}:${creditNote.id}:v${creditNote.version}`
    : `credit-note:${workspaceId}:${creditNote.id}`;
  const claim = await claimDriveEffect(env, workspaceId, 'CREDIT_NOTE_PDF_PUSH', effectKey);
  if (claim.alreadyApplied) return { status: 'duplicate' };
  try {
    const locationName = text(creditNote.location_name) || 'Default Location';
    const { creditNotesFolderId } = await ensureLocationFolders(env, workspaceId, text(creditNote.location_id), locationName);
    const bytes = await creditNoteToPdfBytes({
      id: creditNote.id,
      creditNoteNumber: creditNote.credit_note_number,
      supplierName: creditNote.supplier_name,
      date: creditNote.credited_at,
      reason: creditNote.reason,
      items: parseCreditNoteItems(creditNote.raw_json),
      totalEx: creditNote.total_ex
    });
    const fileName = `${text(creditNote.credit_note_number) || `CN-${creditNote.id.slice(-6).toUpperCase()}`}.pdf`;
    const uploaded = await uploadFile(env, workspaceId, {
      name: fileName,
      parentId: creditNotesFolderId,
      bytes,
      mimeType: 'application/pdf',
      appProperties: { kcp_entity_type: 'credit_note', kcp_entity_id: creditNote.id }
    });
    await env.DB.prepare(
      `INSERT INTO drive_documents (id, workspace_id, entity_type, entity_id, drive_file_id, drive_folder_id, mime_type, source, uploaded_at)
       VALUES (?1, ?2, 'credit_note', ?3, ?4, ?5, 'application/pdf', 'generated_pdf', ?6)`
    ).bind(crypto.randomUUID(), workspaceId, creditNote.id, uploaded.id, creditNotesFolderId, nowIso()).run();
    await markDriveEffectApplied(env, claim.id, uploaded.id);
    return { status: 'applied', driveFileId: uploaded.id };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Unknown error pushing Credit Note PDF to Drive.';
    await markDriveEffectFailed(env, claim.id, message);
    return { status: 'failed', error: message };
  }
}

/** Same shape/reasoning as syncPendingDriveGrvs — every Credit Note never successfully pushed,
 * newest-first, version-aware effect key so an edit re-uploads. */
export async function syncPendingDriveCreditNotes(env: Env, workspaceId: string, limit = 200): Promise<{ pushed: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT cn.id, cn.credit_note_number, s.name AS supplier_name, cn.credited_at, cn.reason, cn.total_ex,
            cn.location_id, l.name AS location_name, cn.raw_json, cn.version
     FROM credit_notes cn
     LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.workspace_id = cn.workspace_id
     LEFT JOIN locations l ON l.id = cn.location_id AND l.workspace_id = cn.workspace_id
     WHERE cn.workspace_id = ?1
       AND NOT EXISTS (
         SELECT 1 FROM drive_effect_outbox o
          WHERE o.workspace_id = cn.workspace_id AND o.effect_type = 'CREDIT_NOTE_PDF_PUSH'
            AND o.effect_key = (
              CASE WHEN COALESCE(cn.version, 1) > 1
                THEN 'credit-note:' || cn.workspace_id || ':' || cn.id || ':v' || cn.version
                ELSE 'credit-note:' || cn.workspace_id || ':' || cn.id
              END
            )
            AND o.status = 'APPLIED'
       )
     ORDER BY cn.credited_at DESC
     LIMIT ?2`
  ).bind(workspaceId, limit).all<CreditNoteRow>();

  let pushed = 0;
  let failed = 0;
  for (const creditNote of rows.results || []) {
    const result = await pushOneCreditNotePdfToDrive(env, workspaceId, creditNote);
    if (result.status === 'applied') pushed += 1;
    else if (result.status === 'failed') failed += 1;
  }
  return { pushed, failed };
}
