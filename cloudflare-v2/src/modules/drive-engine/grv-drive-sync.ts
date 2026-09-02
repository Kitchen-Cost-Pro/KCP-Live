import type { Env } from '../../legacy/types';
import { text, objectValue, nowIso } from './config';
import { uploadFile } from './drive-client';
import { ensureLocationFolders } from './folders';
import { claimDriveEffect, markDriveEffectApplied, markDriveEffectFailed } from './outbox';
// Same cross-package import grv-sync.ts uses for the identical reason: this generator already
// works both in-browser (the existing "view PDF" button) and in a Worker (Xero's attachment push),
// so it's reused as-is rather than duplicated.
import { grvToPdfBytes } from '../../../../src/modules/reporting/exports/exportPdf.js';

interface GrvRow {
  id: string;
  invoice_number: string | null;
  supplier_name: string | null;
  received_at: string;
  transport_ex: number | null;
  discount_ex: number | null;
  total_ex: number | null;
  total_vat: number | null;
  total_inc: number | null;
  raw_json: string | null;
  version: number | null;
}

function parseGrvItems(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = objectValue(JSON.parse(raw));
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function firstLocationName(env: Env, workspaceId: string, grvId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT l.name AS name FROM grv_lines gl
     JOIN locations l ON l.id = gl.location_id AND l.workspace_id = gl.workspace_id
     WHERE gl.grv_id = ?1 AND gl.workspace_id = ?2
     ORDER BY gl.id ASC LIMIT 1`
  ).bind(grvId, workspaceId).first<{ name: string }>();
  return text(row?.name) || 'Default Location';
}

async function pushOneGrvPdfToDrive(env: Env, workspaceId: string, grv: GrvRow): Promise<{ status: string; driveFileId?: string; error?: string }> {
  // Version-aware effect key, same convention as Xero's GRV_PUSH: a GRV edited after its first
  // push gets a new key (so the edited version re-uploads) while a never-edited GRV keeps the
  // original bare key forever.
  const effectKey = (grv.version || 1) > 1 ? `grv:${workspaceId}:${grv.id}:v${grv.version}` : `grv:${workspaceId}:${grv.id}`;
  const claim = await claimDriveEffect(env, workspaceId, 'GRV_PDF_PUSH', effectKey);
  if (claim.alreadyApplied) return { status: 'duplicate' };
  try {
    const locationName = await firstLocationName(env, workspaceId, grv.id);
    const { grvsFolderId } = await ensureLocationFolders(env, workspaceId, '', locationName);
    const bytes = await grvToPdfBytes({
      id: grv.id,
      grvNumber: grv.invoice_number,
      invoice: grv.invoice_number,
      supplierName: grv.supplier_name,
      date: grv.received_at,
      items: parseGrvItems(grv.raw_json),
      transportEx: grv.transport_ex,
      discountEx: grv.discount_ex,
      totalEx: grv.total_ex,
      totalVat: grv.total_vat,
      totalInc: grv.total_inc
    });
    const fileName = `${text(grv.invoice_number) || `GRV-${grv.id.slice(-6).toUpperCase()}`}.pdf`;
    const uploaded = await uploadFile(env, workspaceId, {
      name: fileName,
      parentId: grvsFolderId,
      bytes,
      mimeType: 'application/pdf',
      appProperties: { kcp_entity_type: 'grv', kcp_entity_id: grv.id }
    });
    await env.DB.prepare(
      `INSERT INTO drive_documents (id, workspace_id, entity_type, entity_id, drive_file_id, drive_folder_id, mime_type, source, uploaded_at)
       VALUES (?1, ?2, 'grv', ?3, ?4, ?5, 'application/pdf', 'generated_pdf', ?6)`
    ).bind(crypto.randomUUID(), workspaceId, grv.id, uploaded.id, grvsFolderId, nowIso()).run();
    await markDriveEffectApplied(env, claim.id, uploaded.id);
    return { status: 'applied', driveFileId: uploaded.id };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Unknown error pushing GRV PDF to Drive.';
    await markDriveEffectFailed(env, claim.id, message);
    return { status: 'failed', error: message };
  }
}

/**
 * Every GRV never successfully pushed to Drive, newest-first so a backlog can never starve today's
 * GRVs — same reasoning and shape as modules/xero-engine/grv-sync.ts's loadPendingGrvs/
 * syncPendingXeroGrvs. Used by both the Drive due-check and the "Push GRVs now" admin action.
 */
export async function syncPendingDriveGrvs(env: Env, workspaceId: string, limit = 200): Promise<{ pushed: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT grv.id, grv.invoice_number, s.name AS supplier_name, grv.received_at, grv.transport_ex, grv.discount_ex,
            grv.total_ex, grv.total_vat, grv.total_inc, grv.raw_json, grv.version
     FROM grvs grv
     LEFT JOIN suppliers s ON s.id = grv.supplier_id AND s.workspace_id = grv.workspace_id
     WHERE grv.workspace_id = ?1
       AND NOT EXISTS (
         SELECT 1 FROM drive_effect_outbox o
          WHERE o.workspace_id = grv.workspace_id AND o.effect_type = 'GRV_PDF_PUSH'
            AND o.effect_key = (
              CASE WHEN COALESCE(grv.version, 1) > 1
                THEN 'grv:' || grv.workspace_id || ':' || grv.id || ':v' || grv.version
                ELSE 'grv:' || grv.workspace_id || ':' || grv.id
              END
            )
            AND o.status = 'APPLIED'
       )
     ORDER BY grv.received_at DESC
     LIMIT ?2`
  ).bind(workspaceId, limit).all<GrvRow>();

  let pushed = 0;
  let failed = 0;
  for (const grv of rows.results || []) {
    const result = await pushOneGrvPdfToDrive(env, workspaceId, grv);
    if (result.status === 'applied') pushed += 1;
    else if (result.status === 'failed') failed += 1;
  }
  return { pushed, failed };
}
