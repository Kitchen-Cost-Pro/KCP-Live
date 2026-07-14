import { TENANT_SCHEMA_SQL } from './tenant-schema.generated';

/**
 * Ordered per-tenant schema migrations, applied INSIDE each WorkspaceDO's own SQLite on first
 * access (and whenever new migrations are appended). The DO records the last-applied index in a
 * `_kcp_schema` table, so each workspace self-provisions and self-upgrades — no fan-out
 * `wrangler d1 migrations apply` across N databases.
 *
 * Index 0 is the BASELINE: the full domain schema, auto-generated from the current single-D1
 * migrations (../cloudflare/migrations) by scripts/gen-tenant-schema.mjs — central-plane tables
 * removed and central FKs stripped (those live in CENTRAL_DB). Regenerate with:
 *   node scripts/gen-tenant-schema.mjs
 *
 * Because the baseline contains non-idempotent `ALTER TABLE ADD COLUMN` statements, it must run
 * exactly once per DO — which the `_kcp_schema` version tracking guarantees. Any future schema
 * change is APPENDED as a new element here (never edit index 0 for existing tenants).
 */
export const TENANT_MIGRATIONS: string[] = [
  // 0 — baseline domain schema (generated).
  TENANT_SCHEMA_SQL,
  // 1 — distinguish manual per-location price overrides from Yoco-synced ones, so the
  // catalogue sync can populate/refresh 'yoco' rows without ever clobbering a user's
  // manual override ('manual'). Existing rows default to 'manual' (they were all manual).
  `ALTER TABLE product_location_prices ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';`,
  // 2 — value stock-on-hand and later reports from the per-location item cost when available.
  `CREATE TABLE IF NOT EXISTS stock_item_location_prices (
  workspace_id TEXT NOT NULL,
  stock_item_id TEXT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  price REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, stock_item_id, location_id)
);
DROP VIEW IF EXISTS v_stock_on_hand;
CREATE VIEW v_stock_on_hand AS
SELECT
  sb.workspace_id,
  sb.location_id,
  l.name AS location_name,
  sb.stock_item_id,
  si.name AS stock_item_name,
  si.category,
  si.item_type,
  si.unit,
  COALESCE(silp.price, si.unit_cost) AS unit_cost,
  sb.quantity,
  sb.quantity * COALESCE(silp.price, si.unit_cost) AS stock_value,
  CASE WHEN sb.quantity <= si.threshold_qty THEN 1 ELSE 0 END AS is_low_stock
FROM stock_balances sb
JOIN stock_items si ON si.id = sb.stock_item_id AND si.workspace_id = sb.workspace_id
JOIN locations l ON l.id = sb.location_id AND l.workspace_id = sb.workspace_id
LEFT JOIN stock_item_location_prices silp
  ON silp.workspace_id = sb.workspace_id
 AND silp.stock_item_id = sb.stock_item_id
 AND silp.location_id = sb.location_id
WHERE si.active = 1 AND l.active = 1;`,
  // 3 — ensure existing Durable Object tenants created before per-location costing
  // have the location cost table, then re-create the valuation view against it.
  `CREATE TABLE IF NOT EXISTS stock_item_location_prices (
  workspace_id TEXT NOT NULL,
  stock_item_id TEXT NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  price REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, stock_item_id, location_id)
);
DROP VIEW IF EXISTS v_stock_on_hand;
CREATE VIEW v_stock_on_hand AS
SELECT
  sb.workspace_id,
  sb.location_id,
  l.name AS location_name,
  sb.stock_item_id,
  si.name AS stock_item_name,
  si.category,
  si.item_type,
  si.unit,
  COALESCE(silp.price, si.unit_cost) AS unit_cost,
  sb.quantity,
  sb.quantity * COALESCE(silp.price, si.unit_cost) AS stock_value,
  CASE WHEN sb.quantity <= si.threshold_qty THEN 1 ELSE 0 END AS is_low_stock
FROM stock_balances sb
JOIN stock_items si ON si.id = sb.stock_item_id AND si.workspace_id = sb.workspace_id
JOIN locations l ON l.id = sb.location_id AND l.workspace_id = sb.workspace_id
LEFT JOIN stock_item_location_prices silp
  ON silp.workspace_id = sb.workspace_id
 AND silp.stock_item_id = sb.stock_item_id
 AND silp.location_id = sb.location_id
WHERE si.active = 1 AND l.active = 1;`
,
  // 4 — reporting ledger performance and idempotency helpers. Keep as indexes first;
  // do not add strict uniqueness until historical cleanup/backfill has been verified.
  `CREATE INDEX IF NOT EXISTS idx_stock_movements_workspace_source ON stock_movements(workspace_id, document_type, document_id, movement_type);
CREATE INDEX IF NOT EXISTS idx_stock_movements_location_item_date ON stock_movements(workspace_id, location_id, stock_item_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_workspace_item_location_source ON stock_movements(workspace_id, stock_item_id, location_id, document_type, document_id, movement_type);`,
  // 5 — reporting database audit contract: manufacturing reports need explicit actual
  // and wastage quantities, not only raw_json fields, so reporting remains queryable
  // after reset/backfill and does not rely on parsed metadata for core quantities.
  `ALTER TABLE manufacturing_batches ADD COLUMN actual_quantity REAL NOT NULL DEFAULT 0;
ALTER TABLE manufacturing_batches ADD COLUMN wastage_quantity REAL NOT NULL DEFAULT 0;
UPDATE manufacturing_batches
   SET actual_quantity = COALESCE(json_extract(raw_json, '$.producedQty'), quantity_made, 0),
       wastage_quantity = COALESCE(json_extract(raw_json, '$.wastageQty'), 0)
 WHERE COALESCE(actual_quantity, 0) = 0
    OR COALESCE(wastage_quantity, 0) = 0;`,
  // 6 — Yoco webhook reset hardening. Keep the previous subscription secret for a
  // short grace period so retried/in-flight deliveries from the disabled subscription
  // still verify while new sales use the freshly-created subscription.
  `ALTER TABLE yoco_connections ADD COLUMN webhook_previous_id TEXT;
ALTER TABLE yoco_connections ADD COLUMN webhook_previous_secret TEXT;
ALTER TABLE yoco_connections ADD COLUMN webhook_previous_until TEXT;`,
  // 7 — Phase 20 reporting product features: configuration-only saved views, centrally
  // managed schedules/subscriptions, and an immutable run history for operational QA.
  `CREATE TABLE IF NOT EXISTS report_saved_views (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL DEFAULT 'personal',
  report_group_id TEXT,
  report_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  sort_json TEXT,
  visible_columns_json TEXT,
  date_range_type TEXT NOT NULL DEFAULT 'custom',
  location_id TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  name TEXT NOT NULL,
  report_group_id TEXT,
  report_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  saved_view_id TEXT,
  filters_json TEXT NOT NULL DEFAULT '{}',
  date_range_type TEXT NOT NULL DEFAULT 'custom',
  location_id TEXT,
  schedule_frequency TEXT NOT NULL,
  schedule_day INTEGER,
  schedule_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  format TEXT NOT NULL,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  email_subject TEXT,
  email_message TEXT,
  send_condition_json TEXT NOT NULL DEFAULT '{"type":"always"}',
  is_enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(saved_view_id) REFERENCES report_saved_views(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS report_schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'skipped', 'failed')),
  rows_exported INTEGER NOT NULL DEFAULT 0,
  file_url TEXT,
  error_message TEXT,
  email_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(schedule_id) REFERENCES report_schedules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_report_saved_views_workspace ON report_saved_views(workspace_id);
CREATE INDEX IF NOT EXISTS idx_report_saved_views_workspace_user ON report_saved_views(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS idx_report_saved_views_workspace_report ON report_saved_views(workspace_id, report_id);
CREATE INDEX IF NOT EXISTS idx_report_schedules_workspace ON report_schedules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_report_schedules_workspace_enabled ON report_schedules(workspace_id, is_enabled);
CREATE INDEX IF NOT EXISTS idx_report_schedules_next_run ON report_schedules(next_run_at);
CREATE INDEX IF NOT EXISTS idx_report_schedule_runs_schedule_created ON report_schedule_runs(schedule_id, created_at);`,
  // 8 — report packs and location-separated schedule outputs. Legacy single-report
  // fields remain populated for backward compatibility and list/search performance.
  `ALTER TABLE report_schedules ADD COLUMN report_items_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE report_schedules ADD COLUMN location_mode TEXT NOT NULL DEFAULT 'all';
ALTER TABLE report_schedules ADD COLUMN location_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE report_schedule_runs ADD COLUMN reports_generated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_schedule_runs ADD COLUMN files_generated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_schedule_runs ADD COLUMN output_manifest_json TEXT NOT NULL DEFAULT '[]';`,
  // 9 — canonicalize schedule run states. Older builds wrote `success`/`pending`, while
  // production workspaces enforce running/completed/skipped/failed through a CHECK constraint.
  `UPDATE report_schedule_runs SET status='completed' WHERE status='success';
UPDATE report_schedule_runs SET status='running' WHERE status='pending';
UPDATE report_schedule_runs SET status='failed' WHERE status NOT IN ('running', 'completed', 'skipped', 'failed');`,
  // 10 — keep the requested attachment type outside the original format column. Some
  // early production tenant schemas added a CSV/report-link CHECK constraint to `format`;
  // the new column allows XLSX/PDF schedules to save without destructive table rebuilds.
  `ALTER TABLE report_schedules ADD COLUMN attachment_format TEXT;
UPDATE report_schedules
   SET attachment_format = format
 WHERE COALESCE(NULLIF(attachment_format, ''), '') = '';`,
  // 11 — replace the transitional schedule storage with the canonical release schema.
  // Saved views are copied into immutable report item snapshots and every export type is
  // stored directly in the single validated format column. Schedule and run history are kept.
  `DROP TABLE IF EXISTS report_schedule_runs_next;
DROP TABLE IF EXISTS report_schedules_next;
CREATE TABLE report_schedules_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  name TEXT NOT NULL,
  report_group_id TEXT,
  report_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  report_items_json TEXT NOT NULL DEFAULT '[]',
  filters_json TEXT NOT NULL DEFAULT '{}',
  date_range_type TEXT NOT NULL DEFAULT 'custom',
  location_id TEXT,
  location_mode TEXT NOT NULL DEFAULT 'all' CHECK (location_mode IN ('all', 'selected')),
  location_ids_json TEXT NOT NULL DEFAULT '[]',
  schedule_frequency TEXT NOT NULL CHECK (schedule_frequency IN ('daily', 'weekly', 'monthly')),
  schedule_day INTEGER,
  schedule_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'report_link' CHECK (format IN ('csv', 'xlsx', 'pdf', 'report_link')),
  recipients_json TEXT NOT NULL DEFAULT '[]',
  email_subject TEXT,
  email_message TEXT,
  send_condition_json TEXT NOT NULL DEFAULT '{"type":"always"}',
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE report_schedule_runs_next (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'skipped', 'failed')),
  rows_exported INTEGER NOT NULL DEFAULT 0,
  reports_generated INTEGER NOT NULL DEFAULT 0,
  files_generated INTEGER NOT NULL DEFAULT 0,
  output_manifest_json TEXT NOT NULL DEFAULT '[]',
  file_url TEXT,
  error_message TEXT,
  email_sent INTEGER NOT NULL DEFAULT 0 CHECK (email_sent IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(schedule_id) REFERENCES report_schedules_next(id) ON DELETE CASCADE
);
INSERT INTO report_schedules_next (
  id, workspace_id, created_by, name, report_group_id, report_id, view_id,
  report_items_json, filters_json, date_range_type, location_id, location_mode,
  location_ids_json, schedule_frequency, schedule_day, schedule_time, timezone,
  format, recipients_json, email_subject, email_message, send_condition_json,
  is_enabled, last_run_at, next_run_at, created_at, updated_at
)
SELECT
  rs.id,
  rs.workspace_id,
  rs.created_by,
  rs.name,
  COALESCE(NULLIF(sv.report_group_id, ''), rs.report_group_id),
  COALESCE(NULLIF(sv.report_id, ''), rs.report_id),
  COALESCE(NULLIF(sv.view_id, ''), rs.view_id),
  CASE
    WHEN json_valid(rs.report_items_json) = 1
      AND json_type(rs.report_items_json) = 'array'
      AND json_array_length(rs.report_items_json) > 0
      THEN rs.report_items_json
    ELSE json_array(json_object(
      'reportGroupId', COALESCE(NULLIF(sv.report_group_id, ''), NULLIF(rs.report_group_id, ''), ''),
      'reportId', COALESCE(NULLIF(sv.report_id, ''), rs.report_id),
      'viewId', COALESCE(NULLIF(sv.view_id, ''), rs.view_id),
      'filters', json(CASE
        WHEN json_valid(COALESCE(NULLIF(sv.filters_json, ''), NULLIF(rs.filters_json, ''), '{}')) = 1
          THEN COALESCE(NULLIF(sv.filters_json, ''), NULLIF(rs.filters_json, ''), '{}')
        ELSE '{}'
      END),
      'sort', json(CASE
        WHEN json_valid(COALESCE(NULLIF(sv.sort_json, ''), 'null')) = 1
          THEN COALESCE(NULLIF(sv.sort_json, ''), 'null')
        ELSE 'null'
      END),
      'visibleColumns', json(CASE
        WHEN json_valid(COALESCE(NULLIF(sv.visible_columns_json, ''), '[]')) = 1
          THEN COALESCE(NULLIF(sv.visible_columns_json, ''), '[]')
        ELSE '[]'
      END)
    ))
  END,
  CASE WHEN json_valid(rs.filters_json) = 1 THEN rs.filters_json ELSE '{}' END,
  COALESCE(NULLIF(rs.date_range_type, ''), 'custom'),
  CASE WHEN NULLIF(rs.location_id, '') IS NOT NULL THEN rs.location_id ELSE NULL END,
  CASE
    WHEN (json_valid(rs.location_ids_json) = 1 AND json_type(rs.location_ids_json) = 'array' AND json_array_length(rs.location_ids_json) > 0)
      OR NULLIF(rs.location_id, '') IS NOT NULL
      THEN 'selected'
    ELSE 'all'
  END,
  CASE
    WHEN json_valid(rs.location_ids_json) = 1 AND json_type(rs.location_ids_json) = 'array' AND json_array_length(rs.location_ids_json) > 0
      THEN rs.location_ids_json
    WHEN NULLIF(rs.location_id, '') IS NOT NULL THEN json_array(rs.location_id)
    ELSE '[]'
  END,
  CASE lower(COALESCE(NULLIF(rs.schedule_frequency, ''), 'weekly'))
    WHEN 'daily' THEN 'daily'
    WHEN 'monthly' THEN 'monthly'
    ELSE 'weekly'
  END,
  rs.schedule_day,
  COALESCE(NULLIF(rs.schedule_time, ''), '08:00'),
  COALESCE(NULLIF(rs.timezone, ''), 'Africa/Johannesburg'),
  CASE lower(COALESCE(NULLIF(rs.attachment_format, ''), NULLIF(rs.format, ''), 'report_link'))
    WHEN 'csv' THEN 'csv'
    WHEN 'xlsx' THEN 'xlsx'
    WHEN 'pdf' THEN 'pdf'
    WHEN 'report_link' THEN 'report_link'
    ELSE 'report_link'
  END,
  CASE WHEN json_valid(rs.recipients_json) = 1 THEN rs.recipients_json ELSE '[]' END,
  rs.email_subject,
  rs.email_message,
  CASE WHEN json_valid(rs.send_condition_json) = 1 THEN rs.send_condition_json ELSE '{"type":"always"}' END,
  CASE WHEN COALESCE(rs.is_enabled, 1) = 0 THEN 0 ELSE 1 END,
  rs.last_run_at,
  rs.next_run_at,
  COALESCE(NULLIF(rs.created_at, ''), datetime('now')),
  COALESCE(NULLIF(rs.updated_at, ''), NULLIF(rs.created_at, ''), datetime('now'))
FROM report_schedules rs
LEFT JOIN report_saved_views sv
  ON sv.id = rs.saved_view_id
 AND sv.workspace_id = rs.workspace_id;
INSERT INTO report_schedule_runs_next (
  id, schedule_id, workspace_id, started_at, finished_at, status, rows_exported,
  reports_generated, files_generated, output_manifest_json, file_url, error_message,
  email_sent, created_at
)
SELECT
  id,
  schedule_id,
  workspace_id,
  started_at,
  finished_at,
  CASE status
    WHEN 'completed' THEN 'completed'
    WHEN 'skipped' THEN 'skipped'
    WHEN 'failed' THEN 'failed'
    ELSE 'running'
  END,
  COALESCE(rows_exported, 0),
  COALESCE(reports_generated, 0),
  COALESCE(files_generated, 0),
  CASE WHEN json_valid(output_manifest_json) = 1 THEN output_manifest_json ELSE '[]' END,
  file_url,
  error_message,
  CASE WHEN COALESCE(email_sent, 0) = 0 THEN 0 ELSE 1 END,
  COALESCE(NULLIF(created_at, ''), NULLIF(started_at, ''), datetime('now'))
FROM report_schedule_runs;
DROP TABLE report_schedule_runs;
DROP TABLE report_schedules;
ALTER TABLE report_schedules_next RENAME TO report_schedules;
ALTER TABLE report_schedule_runs_next RENAME TO report_schedule_runs;
CREATE INDEX idx_report_schedules_workspace ON report_schedules(workspace_id);
CREATE INDEX idx_report_schedules_workspace_enabled ON report_schedules(workspace_id, is_enabled);
CREATE INDEX idx_report_schedules_next_run ON report_schedules(next_run_at);
CREATE INDEX idx_report_schedule_runs_schedule_created ON report_schedule_runs(schedule_id, created_at);`,
  // 12 — canonical reporting source indexes. Older tenant baselines may not have
  // had the final Yoco business-key indexes, which allowed duplicate provider rows
  // to make a handful of sales look like a 100,000-row report. Reporting reads now
  // canonicalize those rows; these indexes keep that canonical scan fast.
  `CREATE INDEX IF NOT EXISTS idx_yoco_orders_workspace_business_key
  ON yoco_orders(workspace_id, yoco_order_id, order_type, occurred_at, created_at);
CREATE INDEX IF NOT EXISTS idx_yoco_order_lines_workspace_order_line
  ON yoco_order_lines(workspace_id, yoco_order_id, yoco_line_id);
CREATE INDEX IF NOT EXISTS idx_yoco_orders_workspace_location_date
  ON yoco_orders(workspace_id, location_id, occurred_at);`,
  // 13 — repair old Yoco source tables that were created before the provider business-key
  // constraint existed. Repoint order lines to the newest canonical order, remove duplicate
  // source rows once, then enforce the same uniqueness contract used by current ingestion.
  // This turns a tenant with a handful of sales but thousands of repeated sync rows back into
  // a small indexed source before any report query runs.
  `UPDATE yoco_orders
      SET yoco_order_id = id
    WHERE COALESCE(TRIM(yoco_order_id), '') = '';
UPDATE yoco_orders
   SET order_type = 'sale'
 WHERE COALESCE(TRIM(order_type), '') = '';
DROP TABLE IF EXISTS _kcp_yoco_order_dedupe;
CREATE TABLE _kcp_yoco_order_dedupe (
  old_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL
);
INSERT INTO _kcp_yoco_order_dedupe (old_id, canonical_id)
WITH ranked AS (
  SELECT
    id AS old_id,
    FIRST_VALUE(id) OVER (
      PARTITION BY workspace_id, yoco_order_id, order_type
      ORDER BY datetime(COALESCE(NULLIF(occurred_at, ''), created_at)) DESC,
               datetime(created_at) DESC,
               id DESC
    ) AS canonical_id
  FROM yoco_orders
)
SELECT old_id, canonical_id
  FROM ranked
 WHERE old_id <> canonical_id;
UPDATE yoco_order_lines
   SET yoco_order_id = (
     SELECT map.canonical_id
       FROM _kcp_yoco_order_dedupe map
      WHERE map.old_id = yoco_order_lines.yoco_order_id
   )
 WHERE yoco_order_id IN (SELECT old_id FROM _kcp_yoco_order_dedupe);
DELETE FROM yoco_order_lines
 WHERE id IN (
   SELECT id
     FROM (
       SELECT
         id,
         ROW_NUMBER() OVER (
           PARTITION BY workspace_id,
                        yoco_order_id,
                        COALESCE(NULLIF(yoco_line_id, ''), id)
           ORDER BY id DESC
         ) AS duplicate_rank
       FROM yoco_order_lines
     ) ranked_lines
    WHERE duplicate_rank > 1
 );
DELETE FROM yoco_orders
 WHERE id IN (SELECT old_id FROM _kcp_yoco_order_dedupe);
DROP TABLE _kcp_yoco_order_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS ux_yoco_orders_workspace_business_key
  ON yoco_orders(workspace_id, yoco_order_id, order_type);
CREATE INDEX IF NOT EXISTS idx_yoco_order_lines_workspace_order
  ON yoco_order_lines(workspace_id, yoco_order_id);`,
  // 14 — bind the first accepted Yoco personal API key to this workspace. The
  // fingerprint survives disconnects so another workspace key cannot be substituted
  // through the customer UI; KCP admin actions may explicitly replace it.
  `ALTER TABLE yoco_connections ADD COLUMN api_key_fingerprint TEXT;
ALTER TABLE yoco_connections ADD COLUMN api_key_locked_at TEXT;
ALTER TABLE yoco_connections ADD COLUMN api_key_locked_by_uid TEXT;`,
  // 15 — repair existing Durable Object tenants created before resumable stock-take drafts
  // were added to the generated baseline. Editing migration 0 does not upgrade those tenants,
  // so create the draft table and owner lookup explicitly as an append-only migration.
  `CREATE TABLE IF NOT EXISTS stocktake_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  location_id TEXT REFERENCES locations(id),
  raw_json TEXT NOT NULL DEFAULT '{}',
  saved_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stocktake_drafts_workspace_user
  ON stocktake_drafts(workspace_id, user_id, updated_at);`,
  // 16 — provider-neutral operational diagnostics for webhook lifecycle, sync runs,
  // signature verification, order ingestion and stock-deduction outcomes.
  `CREATE TABLE IF NOT EXISTS integration_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'yoco',
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_integration_logs_workspace_provider_date
  ON integration_logs(workspace_id, provider, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_logs_workspace_status_date
  ON integration_logs(workspace_id, status, created_at);`,
  // 17 — make Yoco order-line retries idempotent independently from stock-movement
  // signatures. Migration 13 already removed historical duplicate line keys.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_yoco_order_lines_workspace_order_line
  ON yoco_order_lines(workspace_id, yoco_order_id, yoco_line_id);`,
  // 18 — preserve the initial connection boundary separately from rolling sync cursors.
  // Normal background reconciliation never looks before this boundary; an explicit admin
  // lookback may still inspect older orders and the Go Live timestamp remains the final guard.
  `ALTER TABLE yoco_connections ADD COLUMN sales_baseline_at TEXT;
UPDATE yoco_connections
   SET sales_baseline_at = COALESCE(last_successful_order_updated_at, last_sales_sync_at, created_at)
 WHERE COALESCE(sales_baseline_at, '') = '';`
];
