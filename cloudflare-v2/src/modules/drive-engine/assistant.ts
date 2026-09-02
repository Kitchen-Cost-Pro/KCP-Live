import type { Env } from '../../legacy/types';
import { checkRateLimit } from '../../legacy/rate-limit';
import { callGeminiExtract, GeminiBusyError } from '../../legacy/ai-extract-routes';
import { text, objectValue, nowIso } from './config';
import { getFileBytes, listFolderFiles, updateFile } from './drive-client';
import { ensureLocationFolders } from './folders';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

async function isOcrEnabled(env: Env, workspaceId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`).bind(workspaceId).first<{ raw_json: string }>();
  const settings = (() => { try { return objectValue(JSON.parse(row?.raw_json || '{}')); } catch { return {}; } })();
  return settings.ocr_enabled === true;
}

export interface InboxInvoice {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink: string;
  createdTime: string;
}

/** Lists whatever's sitting in a location's Drive `Invoices/Inbox` folder, for the "Process GRV
 * with KCP Assistant" picker modal. Staff drop a photo/PDF into that folder from their phone's own
 * Drive app — no dedicated upload UI needed for this to work. */
export async function listInboxInvoices(env: Env, workspaceId: string, locationId: string, locationName: string): Promise<InboxInvoice[]> {
  const { inboxFolderId } = await ensureLocationFolders(env, workspaceId, locationId, locationName);
  const files = await listFolderFiles(env, workspaceId, inboxFolderId);
  return files.map((f) => ({
    id: f.id,
    name: text(f.name),
    mimeType: text(f.mimeType),
    thumbnailLink: text(f.thumbnailLink),
    createdTime: text(f.createdTime)
  }));
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
 * Reads a Drive Inbox file's bytes and runs it through the same Gemini vision extraction the
 * onboarding wizard's photo-import already uses (see legacy/ai-extract-routes.ts), with a
 * GRV-shaped schema instead of the suppliers/stock/recipe ones. Gated on the workspace's
 * ocr_enabled flag exactly like ai_onboarding_enabled gates that route — an admin must opt a
 * workspace into this before staff can use it.
 */
export async function extractInvoiceFromDrive(env: Env, workspaceId: string, fileId: string): Promise<GrvExtractResult> {
  if (!env.GEMINI_API_KEY) throw new Error('KCP Assistant is not configured. Please add a GEMINI_API_KEY to the worker secrets.');
  if (!(await isOcrEnabled(env, workspaceId))) throw new Error('KCP Assistant (OCR) is disabled for this workspace.');

  const limited = await checkRateLimit(env.CENTRAL_DB, `drive-assistant-extract:${workspaceId}`, 20, 3600);
  if (limited.blocked) throw new Error('KCP Assistant has reached its hourly usage limit for this workspace. Please try again later.');

  const { bytes, mimeType } = await getFileBytes(env, workspaceId, fileId);
  if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') {
    throw new Error('Only image or PDF invoices can be processed by KCP Assistant.');
  }

  try {
    const rows = await callGeminiExtract(env, mimeType, bytesToBase64(bytes), GRV_EXTRACT_PROMPT, GRV_EXTRACT_SCHEMA as { properties: Record<string, { type: string }>; required: string[] }, 16384);
    const first = objectValue(rows[0]);
    const rawItems = Array.isArray(first.Items) ? first.Items : [];
    return {
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
}

/** Tags a processed Inbox file and moves it into `Invoices/Processed`, so it drops out of future
 * Inbox listings without needing a separate sync/reconciliation pass — the "already handled" state
 * lives on the Drive file itself via appProperties. */
export async function markInvoiceProcessed(env: Env, workspaceId: string, locationId: string, locationName: string, fileId: string, grvId: string): Promise<void> {
  const { inboxFolderId, processedFolderId } = await ensureLocationFolders(env, workspaceId, locationId, locationName);
  await updateFile(env, workspaceId, fileId, {
    appProperties: { kcp_status: 'processed', kcp_grv_id: grvId },
    addParentId: processedFolderId,
    removeParentId: inboxFolderId
  });
  await env.DB.prepare(
    `INSERT INTO drive_documents (id, workspace_id, entity_type, entity_id, drive_file_id, drive_folder_id, mime_type, source, ocr_status, uploaded_at)
     VALUES (?1, ?2, 'invoice_photo', ?3, ?4, ?5, 'application/octet-stream', 'staff_upload', 'done', ?6)`
  ).bind(crypto.randomUUID(), workspaceId, grvId, fileId, processedFolderId, nowIso()).run();
}
