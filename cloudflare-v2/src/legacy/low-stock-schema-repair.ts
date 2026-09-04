/**
 * Same drift problem as the yoco-engine-v2/xero-engine repairs in their own `schema-repair.ts`
 * files (see those modules' comments for the general mechanism): a tenant whose
 * `_kcp_schema.version` had already drifted ahead of `TENANT_MIGRATIONS.length` by the time
 * migration 31 (`low_stock_alert_state`) was appended skips the indexed migration loop entirely
 * for that table and can never receive it — or any later migration that ALTERs it, like
 * migration 56's `acknowledged`/`acknowledged_at`/`acknowledged_by` columns. Observed live,
 * 2026-09-04: POST notifications/low-stock-ack(-all) failing with
 * "table low_stock_alert_state has no column named is_active: SQLITE_ERROR" on a workspace where
 * `syncLowStockAlertState`'s own read/write path (unchanged since migration 31) should have hit
 * the identical failure already — this repair unconditionally brings every drifted tenant's
 * `low_stock_alert_state` up to the full modern shape in one pass, rather than only patching the
 * columns the current bug report happens to name.
 *
 * `CREATE TABLE IF NOT EXISTS` covers a tenant where migration 31 never created the table at all;
 * `FacadeDatabase.execScript` deliberately ignores only duplicate-column errors for
 * `ALTER TABLE ... ADD COLUMN`, so the ALTERs below are safe to run unconditionally even against
 * a table this CREATE just built with those columns already present.
 */
export const LOW_STOCK_ALERT_STATE_SCHEMA_REPAIR = `
CREATE TABLE IF NOT EXISTS low_stock_alert_state (
  workspace_id TEXT NOT NULL,
  stock_item_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  first_low_at TEXT,
  last_notified_at TEXT,
  cleared_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, stock_item_id, location_id)
);
ALTER TABLE low_stock_alert_state ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE low_stock_alert_state ADD COLUMN first_low_at TEXT;
ALTER TABLE low_stock_alert_state ADD COLUMN last_notified_at TEXT;
ALTER TABLE low_stock_alert_state ADD COLUMN cleared_at TEXT;
ALTER TABLE low_stock_alert_state ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE low_stock_alert_state ADD COLUMN acknowledged_at TEXT;
ALTER TABLE low_stock_alert_state ADD COLUMN acknowledged_by TEXT;
CREATE INDEX IF NOT EXISTS idx_low_stock_alert_state_workspace_active
  ON low_stock_alert_state(workspace_id, is_active, last_notified_at);
`;

export const LOW_STOCK_ALERT_STATE_SCHEMA_REPAIR_ID = 'low-stock-alert-state-columns-v1';
