import type { Env } from '../../legacy/types';
import { checkRateLimit } from '../../legacy/rate-limit';
import { callGeminiExtract, GeminiBusyError } from '../../legacy/ai-extract-routes';
import { text, objectValue, nowIso } from './config';
import { uploadFile, updateFile } from './drive-client';
import { ensureLocationFolders } from './folders';

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function isOcrEnabled(env: Env, workspaceId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`).bind(workspaceId).first<{ raw_json: string }>();
  const settings = (() => { try { return objectValue(JSON.parse(row?.raw_json || '{}')); } catch { return {}; } })();
  return settings.ocr_enabled === true;
}

// Gemini's responseSchema supports nested object/array sub-schemas, which callGeminiExtract's
// loosely-typed `{ properties: Record<string, { type: string }>; required: string[] }` signature
// (written for the flat suppliers/stock/recipes schemas) doesn't structurally express — cast at the
// call site below rather than widening that shared signature for one nested schema.
const GRV_EXTRACT_SCHEMA: Record<string, unknown> = {
  properties: {
    Supplier_Name: { type: 'STRING' },
    Invoice_Number: { type: 'STRING' },
    Invoice_Date: { type: 'STRING' },
    Items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          Item_Name: { type: 'STRING' },
          Quantity: { type: 'STRING' },
          Unit: { type: 'STRING' },
          Unit_Cost: { type: 'STRING' }
        },
        required: ['Item_Name']
      }
    }
  },
  required: ['Items']
};

const GRV_EXTRACT_PROMPT = `This image is a supplier delivery invoice or goods received note. Extract the supplier's name, the invoice/reference number, the invoice date (as YYYY-MM-DD if determinable), and every line item with its quantity, unit (e.g. kg, box, each), and unit cost (ex VAT if stated, otherwise as printed). Leave any field blank rather than guessing if it is not legible or not present. Extract every distinct line item as one row each — do not skip or merge rows.`;

export interface GrvExtractResult {
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  items: Array<{ name: string; quantity: string; unit: string; unitCost: string }>;
}

/**
 * "Process Invoice with KCP": staff photograph or upload a supplier invoice directly from the GRV
 * screen (no Google Drive interaction needed on their end). This runs the photo through the same
 * Gemini vision extraction the onboarding wizard's photo-import already uses (see
 * legacy/ai-extract-routes.ts), with a GRV-shaped schema instead of the suppliers/stock/recipe
 * ones, and archives the original photo into that location's Drive "Invoices" folder — Drive is
 * the destination here, not the source (an earlier version of this feature worked the other way:
 * browsing a Drive Inbox folder for photos staff had already dropped there themselves).
 * Gated on the workspace's ocr_enabled flag exactly like ai_onboarding_enabled gates that route —
 * an admin must opt a workspace into this before staff can use it.
 */
export async function processInvoicePhoto(
  env: Env,
  workspaceId: string,
  locationId: string,
  locationName: string,
  input: { mimeType: string; imageBase64: string }
): Promise<{ extract: GrvExtractResult; driveFileId: string }> {
  if (!env.GEMINI_API_KEY) throw new Error('KCP Assistant is not configured. Please add a GEMINI_API_KEY to the worker secrets.');
  if (!(await isOcrEnabled(env, workspaceId))) throw new Error('KCP Assistant (OCR) is disabled for this workspace.');
  if (!input.mimeType.startsWith('image/') && input.mimeType !== 'application/pdf') {
    throw new Error('Only a photo or PDF of the invoice can be processed by KCP Assistant.');
  }

  const limited = await checkRateLimit(env.CENTRAL_DB, `drive-assistant-extract:${workspaceId}`, 20, 3600);
  if (limited.blocked) throw new Error('KCP Assistant has reached its hourly usage limit for this workspace. Please try again later.');

  let extract: GrvExtractResult;
  try {
    const rows = await callGeminiExtract(env, input.mimeType, input.imageBase64, GRV_EXTRACT_PROMPT, GRV_EXTRACT_SCHEMA as { properties: Record<string, { type: string }>; required: string[] }, 16384);
    const first = objectValue(rows[0]);
    const rawItems = Array.isArray(first.Items) ? first.Items : [];
    extract = {
      supplierName: text(first.Supplier_Name),
      invoiceNumber: text(first.Invoice_Number),
      invoiceDate: text(first.Invoice_Date),
      items: rawItems.map((item) => {
        const row = objectValue(item);
        return { name: text(row.Item_Name), quantity: text(row.Quantity), unit: text(row.Unit), unitCost: text(row.Unit_Cost) };
      })
    };
  } catch (cause) {
    if (cause instanceof GeminiBusyError) throw cause;
    throw new Error(cause instanceof Error ? cause.message : 'KCP Assistant could not read that invoice.');
  }

  // Archiving to Drive happens after extraction succeeds, and a failure here never loses the
  // extraction the user is waiting on — it's logged into drive_documents as best-effort, not
  // thrown back to the caller. Without a connected Drive this simply returns an empty file id.
  let driveFileId = '';
  try {
    const { invoicesFolderId } = await ensureLocationFolders(env, workspaceId, locationId, locationName);
    const uploaded = await uploadFile(env, workspaceId, {
      name: `Invoice ${nowIso().slice(0, 19).replace(/[:T]/g, '-')}.${input.mimeType === 'application/pdf' ? 'pdf' : 'jpg'}`,
      parentId: invoicesFolderId,
      bytes: base64ToBytes(input.imageBase64),
      mimeType: input.mimeType,
      appProperties: { kcp_entity_type: 'invoice_photo' }
    });
    driveFileId = uploaded.id;
    await env.DB.prepare(
      `INSERT INTO drive_documents (id, workspace_id, entity_type, drive_file_id, drive_folder_id, mime_type, source, ocr_status, ocr_extract_json, uploaded_at)
       VALUES (?1, ?2, 'invoice_photo', ?3, ?4, ?5, 'staff_upload', 'done', ?6, ?7)`
    ).bind(crypto.randomUUID(), workspaceId, driveFileId, invoicesFolderId, input.mimeType, JSON.stringify(extract), nowIso()).run();
  } catch {
    // Best-effort archive — see comment above.
  }

  return { extract, driveFileId };
}

/** Tags the archived invoice photo with the GRV it ended up creating, once that GRV is actually
 * saved — best-effort, called fire-and-forget from the frontend after a successful save. */
export async function tagDriveInvoiceWithGrv(env: Env, workspaceId: string, fileId: string, grvId: string): Promise<void> {
  if (!fileId) return;
  await updateFile(env, workspaceId, fileId, { appProperties: { kcp_status: 'processed', kcp_grv_id: grvId } });
  await env.DB.prepare(`UPDATE drive_documents SET entity_id = ?3 WHERE workspace_id = ?1 AND drive_file_id = ?2`)
    .bind(workspaceId, fileId, grvId)
    .run();
}
