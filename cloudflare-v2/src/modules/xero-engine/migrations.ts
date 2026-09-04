export const XERO_V2_FOUNDATION_MIGRATION = `
CREATE TABLE IF NOT EXISTS xero_connections (
  workspace_id TEXT PRIMARY KEY,
  xero_tenant_id TEXT,
  tenant_name TEXT,
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

CREATE TABLE IF NOT EXISTS xero_sync_settings (
  workspace_id TEXT PRIMARY KEY,
  sales_account_code TEXT,
  default_tax_type TEXT,
  item_account_code TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_item_sync_at TEXT,
  last_invoice_sync_date TEXT,
  invoice_sync_claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS xero_v2_effect_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  effect_type TEXT NOT NULL CHECK (effect_type IN ('ITEM_PUSH', 'INVOICE_PUSH')),
  effect_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'APPLIED', 'FAILED')),
  xero_object_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, effect_type, effect_key)
);
CREATE INDEX IF NOT EXISTS idx_xero_v2_effect_outbox_workspace_status
  ON xero_v2_effect_outbox(workspace_id, effect_type, status);

-- Single global row ('global') — the account-wide, in-DO substitute for a dedicated rate-gate
-- Durable Object. Xero's real caps are 60 calls/min and 5,000 calls/day PER TENANT; this counter
-- is deliberately per-workspace-DO (i.e. effectively per-tenant, since each workspace maps to one
-- Xero organisation) rather than account-wide, unlike the Yoco write-budget DO which really is a
-- shared account-wide resource.
CREATE TABLE IF NOT EXISTS xero_v2_rate_state (
  id TEXT PRIMARY KEY DEFAULT 'global',
  date_key TEXT NOT NULL DEFAULT '',
  calls_today INTEGER NOT NULL DEFAULT 0,
  minute_bucket TEXT NOT NULL DEFAULT '',
  calls_this_minute INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * GRV -> Xero Bill (ACCPAY) push + Supplier -> Xero Contact mapping, extending the foundation
 * "lean MVP" migration above. xero_v2_effect_outbox.effect_type has a CHECK constraint SQLite
 * can't widen in place, so this rebuilds the table via the _next-table pattern (drop/create/copy/
 * drop/rename) already established by tenant-migrations.ts's migration 11 for the same reason. See
 * grv-sync.ts.
 */
export const XERO_V2_GRV_PUSH_MIGRATION = `
DROP TABLE IF EXISTS xero_v2_effect_outbox_next;
CREATE TABLE xero_v2_effect_outbox_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  effect_type TEXT NOT NULL CHECK (effect_type IN ('ITEM_PUSH', 'INVOICE_PUSH', 'GRV_PUSH', 'GRV_ATTACHMENT')),
  effect_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'APPLIED', 'FAILED')),
  xero_object_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, effect_type, effect_key)
);
INSERT INTO xero_v2_effect_outbox_next (id, workspace_id, effect_type, effect_key, status, xero_object_id, attempt_count, last_error, created_at, updated_at)
  SELECT id, workspace_id, effect_type, effect_key, status, xero_object_id, attempt_count, last_error, created_at, updated_at
  FROM xero_v2_effect_outbox;
DROP TABLE xero_v2_effect_outbox;
ALTER TABLE xero_v2_effect_outbox_next RENAME TO xero_v2_effect_outbox;
CREATE INDEX IF NOT EXISTS idx_xero_v2_effect_outbox_workspace_status
  ON xero_v2_effect_outbox(workspace_id, effect_type, status);

ALTER TABLE xero_sync_settings ADD COLUMN purchase_account_code TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN purchase_tax_type TEXT;
-- Optional: a GRV line whose stock item is zero-rated/VAT-exempt (grv_lines.total_vat = 0, driven
-- by stock_items.vat_enabled) uses this tax type instead of purchase_tax_type. Left blank, every
-- line keeps using purchase_tax_type exactly as before — this is opt-in, not a behavior change
-- until the workspace fills in their Xero org's actual exempt/zero-rated tax type code.
ALTER TABLE xero_sync_settings ADD COLUMN purchase_exempt_tax_type TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN grv_sync_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE xero_sync_settings ADD COLUMN last_grv_sync_date TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN grv_sync_claimed_at TEXT;

ALTER TABLE suppliers ADD COLUMN xero_contact_id TEXT;
ALTER TABLE suppliers ADD COLUMN xero_contact_synced_at TEXT;
`;

/**
 * COD supplier GRVs push as an AUTHORISED (not DRAFT) Bill with a matching Payment applied, instead
 * of sitting as a draft forever — see grv-sync.ts's isCodSupplier/applyCodPayment. Needs the same
 * _next-table CHECK-constraint rebuild as XERO_V2_GRV_PUSH_MIGRATION above, to add the GRV_PAYMENT
 * effect type. cod_payment_account_code is the Xero bank account a COD payment is recorded against;
 * left blank, the Bill still goes out as AUTHORISED but no Payment is created (see
 * applyCodPayment's doc comment) — opt-in, not a behavior change until set.
 */
export const XERO_V2_GRV_COD_PAYMENT_MIGRATION = `
DROP TABLE IF EXISTS xero_v2_effect_outbox_next;
CREATE TABLE xero_v2_effect_outbox_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  effect_type TEXT NOT NULL CHECK (effect_type IN ('ITEM_PUSH', 'INVOICE_PUSH', 'GRV_PUSH', 'GRV_ATTACHMENT', 'GRV_PAYMENT')),
  effect_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'APPLIED', 'FAILED')),
  xero_object_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, effect_type, effect_key)
);
INSERT INTO xero_v2_effect_outbox_next (id, workspace_id, effect_type, effect_key, status, xero_object_id, attempt_count, last_error, created_at, updated_at)
  SELECT id, workspace_id, effect_type, effect_key, status, xero_object_id, attempt_count, last_error, created_at, updated_at
  FROM xero_v2_effect_outbox;
DROP TABLE xero_v2_effect_outbox;
ALTER TABLE xero_v2_effect_outbox_next RENAME TO xero_v2_effect_outbox;
CREATE INDEX IF NOT EXISTS idx_xero_v2_effect_outbox_workspace_status
  ON xero_v2_effect_outbox(workspace_id, effect_type, status);

ALTER TABLE xero_sync_settings ADD COLUMN cod_payment_account_code TEXT;
`;

/**
 * Sales-side mirror of the purchases-side vat_enabled/exempt-tax-type gate. The daily Xero sales
 * invoice previously applied ONE FLAT `default_tax_type` to every product line regardless of
 * whether that specific product is actually VATable — confirmed with David this is a live gap
 * (some menu items genuinely are zero-rated/exempt).
 *
 * `products.vat_enabled` mirrors `stock_items.vat_enabled` exactly (1=VATable, 0=exempt,
 * DEFAULT 1) — populated from Yoco's own Items API `is_taxable` field at catalogue-sync time (see
 * integration-service.ts), which Yoco already exposes as a genuine per-item merchant setting, not
 * something KCP needs its own new UI to capture.
 *
 * `sales_exempt_tax_type` is the sales-side analogue of `purchase_exempt_tax_type`: left blank,
 * every sales line keeps using `default_tax_type` exactly as before — opt-in, not a behavior
 * change until the workspace fills in their Xero org's actual zero-rated sales tax type code.
 */
export const XERO_V2_SALES_VAT_MIGRATION = `
ALTER TABLE products ADD COLUMN vat_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE xero_sync_settings ADD COLUMN sales_exempt_tax_type TEXT;
`;

/**
 * Credit Note -> Xero Credit Note (ACCPAYCREDIT) push, mirroring the GRV -> Bill push. Needs the
 * same _next-table CHECK-constraint rebuild as XERO_V2_GRV_PUSH_MIGRATION/
 * XERO_V2_GRV_COD_PAYMENT_MIGRATION to add the CREDIT_NOTE_PUSH effect type.
 *
 * Reuses the SAME purchase_account_code/purchase_tax_type/purchase_exempt_tax_type settings the
 * GRV push already has — a credit note is still a purchases-side document, no new account/tax
 * mapping needed. Only the sync toggle/claim state is new (own independent daily claim, same
 * pattern as grv_sync_enabled/last_grv_sync_date/grv_sync_claimed_at, so a credit note sync
 * failure never blocks or is blocked by the GRV sync).
 */
export const XERO_V2_CREDIT_NOTE_PUSH_MIGRATION = `
DROP TABLE IF EXISTS xero_v2_effect_outbox_next;
CREATE TABLE xero_v2_effect_outbox_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  effect_type TEXT NOT NULL CHECK (effect_type IN ('ITEM_PUSH', 'INVOICE_PUSH', 'GRV_PUSH', 'GRV_ATTACHMENT', 'GRV_PAYMENT', 'CREDIT_NOTE_PUSH')),
  effect_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'APPLIED', 'FAILED')),
  xero_object_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, effect_type, effect_key)
);
INSERT INTO xero_v2_effect_outbox_next (id, workspace_id, effect_type, effect_key, status, xero_object_id, attempt_count, last_error, created_at, updated_at)
  SELECT id, workspace_id, effect_type, effect_key, status, xero_object_id, attempt_count, last_error, created_at, updated_at
  FROM xero_v2_effect_outbox;
DROP TABLE xero_v2_effect_outbox;
ALTER TABLE xero_v2_effect_outbox_next RENAME TO xero_v2_effect_outbox;
CREATE INDEX IF NOT EXISTS idx_xero_v2_effect_outbox_workspace_status
  ON xero_v2_effect_outbox(workspace_id, effect_type, status);

ALTER TABLE xero_sync_settings ADD COLUMN credit_note_sync_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE xero_sync_settings ADD COLUMN last_credit_note_sync_date TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN credit_note_sync_claimed_at TEXT;
`;

/**
 * Location Tracking Categories: tags each GRV/Credit Note/Sales Invoice LineItem with a Xero
 * Tracking Option matching the KCP location it belongs to, so Xero's own P&L reporting can be
 * filtered/grouped per location without leaving Xero. Just one settings column — left blank
 * (default), no line carries a Tracking array and every push behaves exactly as before; see
 * tracking.ts for the resolution logic (match-by-name, skip-and-log on no match, since Xero has no
 * create-on-the-fly API for tracking options and silently drops an unmatched Name/Option pair).
 */
export const XERO_V2_LOCATION_TRACKING_MIGRATION = `
ALTER TABLE xero_sync_settings ADD COLUMN location_tracking_category_id TEXT;
`;

/**
 * Wastage -> Xero Manual Journal push. Unlike GRV/Credit Note, wastage has no supplier and isn't a
 * purchase document, so it doesn't fit the Bill/Credit-Note shape — it posts as ONE re-computable
 * daily aggregate Manual Journal (debit wastage_expense_account_code, credit
 * wastage_asset_account_code), mirroring invoice-sync.ts's syncXeroDailyInvoice/
 * upsertXeroTodayInvoice pair rather than the per-document GRV/Credit-Note pattern. No tax type
 * column: an internal inventory write-off isn't a supply or purchase, so its journal lines carry no
 * VAT — same reasoning as why ITEM_PUSH lines don't have one either.
 *
 * Needs the same _next-table CHECK-constraint rebuild as the earlier *_PUSH migrations to add the
 * WASTAGE_PUSH effect type. Own independent daily claim (wastage_sync_enabled/
 * last_wastage_sync_date/wastage_sync_claimed_at), same pattern as grv/credit-note, so a wastage
 * sync failure never blocks or is blocked by any other sync.
 */
export const XERO_V2_WASTAGE_PUSH_MIGRATION = `
DROP TABLE IF EXISTS xero_v2_effect_outbox_next;
CREATE TABLE xero_v2_effect_outbox_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  effect_type TEXT NOT NULL CHECK (effect_type IN ('ITEM_PUSH', 'INVOICE_PUSH', 'GRV_PUSH', 'GRV_ATTACHMENT', 'GRV_PAYMENT', 'CREDIT_NOTE_PUSH', 'WASTAGE_PUSH')),
  effect_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'APPLIED', 'FAILED')),
  xero_object_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, effect_type, effect_key)
);
INSERT INTO xero_v2_effect_outbox_next (id, workspace_id, effect_type, effect_key, status, xero_object_id, attempt_count, last_error, created_at, updated_at)
  SELECT id, workspace_id, effect_type, effect_key, status, xero_object_id, attempt_count, last_error, created_at, updated_at
  FROM xero_v2_effect_outbox;
DROP TABLE xero_v2_effect_outbox;
ALTER TABLE xero_v2_effect_outbox_next RENAME TO xero_v2_effect_outbox;
CREATE INDEX IF NOT EXISTS idx_xero_v2_effect_outbox_workspace_status
  ON xero_v2_effect_outbox(workspace_id, effect_type, status);

ALTER TABLE xero_sync_settings ADD COLUMN wastage_expense_account_code TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN wastage_asset_account_code TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN wastage_sync_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE xero_sync_settings ADD COLUMN last_wastage_sync_date TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN wastage_sync_claimed_at TEXT;
`;
