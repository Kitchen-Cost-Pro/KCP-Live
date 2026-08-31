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
