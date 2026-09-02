/**
 * Google Drive integration foundation: per-workspace OAuth connection, a local record of every
 * document KCP has written to (or read from) that workspace's Drive, and Drive's own idempotent
 * effect outbox — kept as its own table rather than widening modules/xero-engine's
 * xero_v2_effect_outbox, whose effect_type CHECK constraint makes adding a new type an expensive
 * table-rebuild migration (see XERO_V2_GRV_PUSH_MIGRATION). Drive gets a clean CHECK list from the
 * start so a future effect type never needs that rebuild here.
 *
 * ocr_status/ocr_extract_json on drive_documents are for the "KCP Assistant" invoice-photo ->
 * pre-filled-GRV flow (see assistant.ts): once a workspace has the OCR toggle enabled
 * (workspace_settings.raw_json.ocr_enabled — no new column needed for that, same pattern as the
 * existing ai_onboarding_enabled flag), a Drive Inbox file that's been run through Gemini
 * extraction gets its result recorded here before the GRV draft is created from it.
 */
export const DRIVE_FOUNDATION_MIGRATION = `
CREATE TABLE IF NOT EXISTS drive_connections (
  workspace_id TEXT PRIMARY KEY,
  account_email TEXT,
  root_folder_id TEXT,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TEXT,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  connected_at TEXT,
  connected_by_uid TEXT,
  connected_by_email TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  disconnected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drive_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('grv', 'credit_note', 'invoice_photo')),
  entity_id TEXT,
  drive_file_id TEXT NOT NULL,
  drive_folder_id TEXT,
  mime_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'generated_pdf' CHECK (source IN ('generated_pdf', 'staff_upload')),
  ocr_status TEXT CHECK (ocr_status IS NULL OR ocr_status IN ('pending', 'done', 'failed')),
  ocr_extract_json TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  uploaded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_drive_documents_entity ON drive_documents(workspace_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_drive_documents_drive_file ON drive_documents(workspace_id, drive_file_id);

CREATE TABLE IF NOT EXISTS drive_effect_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  effect_type TEXT NOT NULL CHECK (effect_type IN ('GRV_PDF_PUSH', 'CREDIT_NOTE_PDF_PUSH')),
  effect_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'APPLIED', 'FAILED')),
  drive_file_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, effect_type, effect_key)
);
CREATE INDEX IF NOT EXISTS idx_drive_effect_outbox_workspace_status
  ON drive_effect_outbox(workspace_id, effect_type, status);
`;
