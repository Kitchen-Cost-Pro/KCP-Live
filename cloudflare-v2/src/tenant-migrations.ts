import { TENANT_SCHEMA_SQL } from './tenant-schema.generated';
import { YOCO_V2_FOUNDATION_MIGRATION, YOCO_V2_SALE_SHADOW_MIGRATION, YOCO_V2_REFUND_RECONCILIATION_MIGRATION, YOCO_V2_CONTROLLED_CUTOVER_MIGRATION, YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION, YOCO_V2_LEGACY_SHUTDOWN_MIGRATION, YOCO_V2_ADMIN_CONTROL_CENTRE_MIGRATION, YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION, YOCO_V2_EFFECT_GATE_MIGRATION } from './modules/yoco-engine-v2/migrations';
import { MODIFIER_ENGINE_CORE_ACTIONS_MIGRATION, MODIFIER_ENGINE_REFUNDS_RELIABILITY_NOTES_MIGRATION } from './modules/modifier-engine/migrations';

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
 WHERE COALESCE(sales_baseline_at, '') = '';`,
  // 19 — use Yoco's stable provider event id as the primary webhook replay key.
  // Payload hashes remain a fallback for older deliveries that omitted an event id.
  `DELETE FROM yoco_webhook_events
 WHERE COALESCE(TRIM(provider_event_id), '') <> ''
   AND rowid NOT IN (
     SELECT MIN(rowid)
       FROM yoco_webhook_events
      WHERE COALESCE(TRIM(provider_event_id), '') <> ''
      GROUP BY workspace_id, provider_event_id
   );
CREATE UNIQUE INDEX IF NOT EXISTS ux_yoco_webhook_events_workspace_provider_event
  ON yoco_webhook_events(workspace_id, provider_event_id)
  WHERE COALESCE(TRIM(provider_event_id), '') <> '';`,
  // 20 — store every provider refund as its own financial transaction while retaining
  // the original receipt reference and the stock-handling decision used by reporting.
  `ALTER TABLE yoco_orders ADD COLUMN parent_yoco_order_id TEXT;
ALTER TABLE yoco_orders ADD COLUMN provider_refund_id TEXT;
ALTER TABLE yoco_orders ADD COLUMN refund_reason TEXT;
ALTER TABLE yoco_orders ADD COLUMN refund_behavior TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_yoco_orders_workspace_provider_refund
  ON yoco_orders(workspace_id, provider_refund_id)
  WHERE COALESCE(TRIM(provider_refund_id), '') <> '';
CREATE INDEX IF NOT EXISTS idx_yoco_orders_workspace_parent_order
  ON yoco_orders(workspace_id, parent_yoco_order_id, occurred_at);`,
  // 21 — persist the signed gross, VAT and ex-VAT values used by sales reporting.
  // `total` remains the backwards-compatible signed customer amount. Refund rows
  // store all three accounting components as negative values.
  `ALTER TABLE yoco_orders ADD COLUMN gross_total REAL;
ALTER TABLE yoco_orders ADD COLUMN vat_total REAL;
ALTER TABLE yoco_orders ADD COLUMN net_total REAL;
UPDATE yoco_orders
   SET gross_total = total
 WHERE gross_total IS NULL;
CREATE INDEX IF NOT EXISTS idx_yoco_orders_workspace_refund_financials
  ON yoco_orders(workspace_id, order_type, occurred_at, gross_total);`,
  // 22 — isolated Yoco V2 engine foundation: immutable raw capture, effect ownership,
  // processing runs, append-only timeline, retry/dead-letter observability.
  YOCO_V2_FOUNDATION_MIGRATION,
  // 23 — Phase V2 04-06: controlled API request audit, canonical sale events,
  // shadow-only stock proposals, per-sale comparisons and integration circuit state.
  YOCO_V2_SALE_SHADOW_MIGRATION,
  // 24 — Phase V2 07-09: canonical refunds, manual review, refund shadow proposals and reconciliation.
  YOCO_V2_REFUND_RECONCILIATION_MIGRATION,
  // 25 — Phase V2 10: controlled sale-only live effect cutover, outbox, readiness and rollback history.
  YOCO_V2_CONTROLLED_CUTOVER_MIGRATION,
  // 26 — Phase V2 11: controlled refund reporting/stock cutover with independent readiness and rollback.
  YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION,
  // 27 — Phase V2 12: ownership-gated legacy business shutdown, observation telemetry and Phase 13 gate.
  YOCO_V2_LEGACY_SHUTDOWN_MIGRATION,
  // 28 — Enterprise Yoco V2 admin control centre: webhook receipt observability and append-only action audit.
  YOCO_V2_ADMIN_CONTROL_CENTRE_MIGRATION,
  // 29 — Modifier engine core actions: additive stock, ingredient removal/replacement, scopes, versions and observations.
  MODIFIER_ENGINE_CORE_ACTIONS_MIGRATION,
  // 30 — Modifier refunds, observation/cutover diagnostics, and exact approved note rules.
  MODIFIER_ENGINE_REFUNDS_RELIABILITY_NOTES_MIGRATION,
  // 31 — per-item/location low-stock notification state. Thresholds remain on
  // stock_items; this table stores alert lifecycle only, never a second threshold.
  `CREATE TABLE IF NOT EXISTS low_stock_alert_state (
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
CREATE INDEX IF NOT EXISTS idx_low_stock_alert_state_workspace_active
  ON low_stock_alert_state(workspace_id, is_active, last_notified_at);`,
  // 32 — VAT-registration status. workspace_settings.vat_rate was already a typed column read
  // directly by reporting SQL for performance, but the settings-save route only ever wrote the
  // JSON blob, so a business's configured VAT rate never actually reached reporting (it silently
  // stayed at the schema default of 15%). This migration adds the typed vat_registered column,
  // and the save route is fixed alongside it to keep both typed columns in sync with raw_json
  // going forward, so a business's actual VAT rate and registration status are both honored.
  //
  // Safe to leave in place even while write quota is constrained: WorkspaceDO.migrate() now
  // backs off and keeps serving on the existing schema if this fails, instead of crashing the
  // whole workspace. It will finish applying itself automatically the next time it's attempted
  // after quota headroom returns — no manual re-deploy needed.
  `ALTER TABLE workspace_settings ADD COLUMN vat_registered INTEGER NOT NULL DEFAULT 1;`,
  // 33 — scheduled-reconciliation failure backoff + cross-run finding dedupe. Fixes the runaway
  // 15-minute deep-scan loop that consumed the entire daily Durable Object write allowance on
  // workspaces that had never gone live. See the migration body for the full root cause.
  YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION,
  // 34 — drop the legacy V1 webhook event log. Shadow-mode comparison against yoco-engine-v2
  // is over and the cutover is complete; all webhook capture/observability now lives in
  // yoco_v2_webhook_receipts. No code reads or writes this table anymore (see legacy/routes.ts).
  `DROP TABLE IF EXISTS yoco_webhook_events;`,
  // 35 — Phase V2 14: unify the sale and refund effect-control tables into one yoco_v2_effect_gate
  // table (see migration body). Collapses cutover.ts/refund-cutover.ts's duplicated runtime gate
  // logic into a single effect-gate.ts module.
  YOCO_V2_EFFECT_GATE_MIGRATION,
  // 36 — snapshot vat_rate/vat_registered onto yoco_orders at write time. Reporting previously
  // resolved VAT purely via a live subquery against workspace_settings, so an order's displayed
  // VAT rate (and, for any order missing a persisted vat_total, its computed VAT amount) could
  // silently change after the fact whenever the workspace's VAT rate/registration was edited —
  // today's setting would retroactively apply to old orders. applyReporting (live-sale.ts and
  // live-refund.ts) now stamps the rate/registration in effect at processing time onto each order;
  // reporting reads prefer this stored snapshot and only fall back to the live value for legacy
  // rows written before this migration, since there is no way to recover the rate that was
  // actually in effect for those.
  `ALTER TABLE yoco_orders ADD COLUMN vat_rate REAL;
ALTER TABLE yoco_orders ADD COLUMN vat_registered INTEGER;`,
  // 37 — indexes for the hot lookup/sort paths that were reading whole tables. Because there is one
  // Durable Object (one SQLite database) PER WORKSPACE, `WHERE workspace_id = ?1` selects
  // essentially every row — an index whose only usable term is workspace_id gives no reduction at
  // all, so several queries that looked indexed were full scans. Each index below was added against
  // a specific measured `SCAN`:
  //
  //  * products(workspace_id, active, lower(trim(name))) — saveProductRecord resolves an existing
  //    product by `lower(trim(name))`. An expression index is an EXACT match for that predicate, so
  //    this changes no matching behaviour. Without it, every imported row full-scanned products;
  //    a bulk recipe import is that scan once PER UPLOADED ROW.
  //  * products(workspace_id, active, lower(category), lower(name)) — getProducts sorts by exactly
  //    these expressions, so the whole table was materialised and sorted before LIMIT applied.
  //  * stock_items(workspace_id, active, name) — getStockItems' `ORDER BY si.name ASC` had no index,
  //    so every OFFSET page re-scanned and re-sorted the entire table (10 pages = 10 full sorts),
  //    and its three per-row correlated subqueries ran for every row rather than the page's rows.
  //  * yoco_order_lines(workspace_id, product_id) — the menu-health aggregate groups by product_id
  //    over the full line table with no date filter (measured `SCAN yoco_order_lines`).
  `CREATE INDEX IF NOT EXISTS idx_products_workspace_active_name_key
  ON products(workspace_id, active, lower(trim(name)));
CREATE INDEX IF NOT EXISTS idx_products_workspace_active_sort
  ON products(workspace_id, active, lower(category), lower(name));
CREATE INDEX IF NOT EXISTS idx_stock_items_workspace_active_name
  ON stock_items(workspace_id, active, name);
CREATE INDEX IF NOT EXISTS idx_yoco_order_lines_workspace_product
  ON yoco_order_lines(workspace_id, product_id);`,
  // 38 — persisted normalised name key for the stock-item duplicate-name guard. That guard compares
  // names through normalizeStockItemDuplicateName() in JavaScript (NFKC, zero-width stripping,
  // whitespace collapsing), which cannot be expressed as a SQL expression index — so the only way
  // to run it was to SELECT every active stock item and compare in the Worker, once per save. A
  // bulk stock/recipe import performs one save per uploaded row, making that the whole table read
  // per row. Storing the key lets the guard become a single indexed point lookup.
  //
  // Only the column and index are created here. The actual backfill (approximating the JavaScript
  // normaliser in SQL) originally ran as a single unconditional UPDATE across the whole table in
  // THIS migration — 2026-08-28 incident: for any tenant with a non-trivial stock_items table, that
  // one-request UPDATE (14 nested REPLACE calls per row) could exceed the Durable Object's
  // per-request CPU limit, get killed mid-flight, and retry-loop through the exact
  // interrupted-attempt/backoff path a real migration failure uses — reading and re-failing
  // repeatedly across many tenants for hours with no cron and no user traffic involved. It now runs
  // as a separate, bounded, resumable backfill in WorkspaceDO.migrate() (see
  // STOCK_ITEM_NAME_KEY_BACKFILL_ID there) that processes a capped number of rows per request and
  // simply continues on the tenant's next request instead of ever risking a CPU-limit kill.
  `ALTER TABLE stock_items ADD COLUMN name_key TEXT;
CREATE INDEX IF NOT EXISTS idx_stock_items_workspace_active_name_key
  ON stock_items(workspace_id, active, name_key);`,
  // 39 — make the reporting filter-options dropdown stop reading the whole ledger.
  // getReportFilterOptions runs `SELECT DISTINCT movement_type FROM stock_movements WHERE
  // workspace_id = ?1` on EVERY report route (ten call sites), and movement_type is in practice a
  // fixed enum of about seven values — so it was reading every movement ever recorded to produce
  // seven strings. With this index SQLite applies its DISTINCT skip-scan: it seeks to the next
  // distinct value instead of walking every entry. Measured on a seeded tenant, same seven results:
  //   20,000 movements  3.30ms -> 0.03ms
  //  200,000 movements 49.81ms -> 0.03ms   (flat — no longer grows with trading history)
  // Purely an index, so no query or result changes.
  `CREATE INDEX IF NOT EXISTS idx_stock_movements_workspace_movement_type
  ON stock_movements(workspace_id, movement_type);`,
  // 40 — index the hourly reconciliation sweep's "find unresolved sales" scan. Measured 2026-08-28:
  // runScheduledYocoV2Reconciliation's unresolvedSales query filters yoco_v2_domain_events on
  // workspace_id + integration_id + event_type + resolution_status IN (...), but the only existing
  // index is (workspace_id, source_entity_id, event_type) — resolution_status isn't covered and
  // event_type alone can't use that index as a real prefix, so every hourly tick full-scanned the
  // workspace's ENTIRE sale-event history (measured `SCAN yoco_v2_domain_events`), growing without
  // bound as sales accumulate. A local synthetic benchmark (500k rows, 0.5% unresolved) confirmed
  // this: adding the obvious covering index alone was NOT enough — SQLite's planner still chose a
  // full SCAN over a multi-value `resolution_status IN (...)` predicate against a composite index.
  // Forcing the index (see the `INDEXED BY` added in reconciliation.ts alongside this migration)
  // flips the plan to SEARCH, touching only the matching rows (~2,500 of 500,000 in the benchmark).
  `CREATE INDEX IF NOT EXISTS idx_yoco_v2_domain_events_workspace_status
  ON yoco_v2_domain_events(workspace_id, integration_id, event_type, resolution_status);`,
  // 41 — replace the Stock Control report's "latest purchase price" lookup with a maintained
  // summary table instead of recomputing it from full GRV history on every report load. Measured
  // 2026-08-28: the old `latest_purchase` CTE ran a ROW_NUMBER() window function over the entire
  // grv_lines/grvs join for the workspace to find the single most recent purchase per
  // stock_item+location — a window function must read every row of its partition set regardless of
  // indexing, so this cost grows forever with total purchase history and was measured reading
  // 17,818 rows on one real workspace's report load alone. Same shape as the reconciliation bug:
  // an unbounded read that scales with total history instead of with what's actually needed.
  //
  // stock_balances and stock_item_location_prices already avoid this — they're maintained as one
  // row per (workspace_id, stock_item_id, location_id) at write time, so a report just reads that
  // row directly. This gives grv purchases the same treatment: one current row per key, kept
  // up to date by the GRV write path (see routes.ts's GRV creation), with a bounded, resumable
  // backfill (see workspace-do.ts) populating it from existing history without a single unbounded
  // scan. See reporting-routes.ts for the report query now reading straight from this table.
  `CREATE TABLE IF NOT EXISTS stock_item_latest_purchase (
    workspace_id TEXT NOT NULL,
    stock_item_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    supplier_id TEXT,
    unit TEXT NOT NULL DEFAULT 'ea',
    unit_price REAL NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL,
    grv_line_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, stock_item_id, location_id)
  );`,
  // 42 — index adjustment_lines and adjustments' (workspace_id, adjustment_type) pair. Measured
  // 2026-08-28 (read-cost-audit.ts + a dedicated one-year simulation): the Dashboard's wastage-
  // value aggregate joins adjustment_lines to adjustments and had NO index on adjustment_lines at
  // all (not even on adjustment_id), so it fully scanned every adjustment line ever recorded on
  // every dashboard load — confirmed `SCAN al` in EXPLAIN QUERY PLAN. At a realistic one-year
  // volume (365 daily wastage adjustments x 5 lines = 1,825 rows) this flips cleanly to SEARCH on
  // both sides once indexed, unlike the transfers/stocktake queries also found in that audit —
  // those filter with `<>` and `lower(status) NOT IN (...)`, which can't become a true index
  // lookup no matter what's indexed, so they were deliberately left alone rather than added here
  // as a false "fixed" claim.
  `CREATE INDEX IF NOT EXISTS idx_adjustment_lines_adjustment
  ON adjustment_lines(adjustment_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_workspace_type
  ON adjustments(workspace_id, adjustment_type, occurred_at);`
];
