import {
  YOCO_V2_ADMIN_CONTROL_CENTRE_MIGRATION,
  YOCO_V2_CONTROLLED_CUTOVER_MIGRATION,
  YOCO_V2_EFFECT_GATE_MIGRATION,
  YOCO_V2_FOUNDATION_MIGRATION,
  YOCO_V2_LEGACY_SHUTDOWN_MIGRATION,
  YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION,
  YOCO_V2_REFUND_RECONCILIATION_MIGRATION,
  YOCO_V2_SALE_SHADOW_MIGRATION,
} from './migrations';

/**
 * Idempotent repair for production tenants whose `_kcp_schema` version was advanced by an
 * earlier release while one or more Yoco V2 tables/columns were still absent. This can happen
 * when a migration index is reused or a multi-statement deployment is interrupted.
 *
 * `FacadeDatabase.execScript` deliberately ignores only duplicate-column errors for ALTER TABLE
 * ADD COLUMN, so this script can run on every WorkspaceDO startup without hiding real SQL errors.
 */
export const YOCO_V2_RUNTIME_SCHEMA_REPAIR = `
CREATE TABLE IF NOT EXISTS yoco_connections (
  workspace_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'disconnected',
  api_key_encrypted TEXT,
  webhook_id TEXT,
  webhook_secret TEXT,
  webhook_url TEXT,
  webhook_previous_id TEXT,
  webhook_previous_secret TEXT,
  webhook_previous_until TEXT,
  connection_active INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  api_key_fingerprint TEXT,
  api_key_locked_at TEXT,
  api_key_locked_by_uid TEXT,
  last_catalogue_sync_at TEXT,
  last_sales_sync_at TEXT,
  last_successful_order_updated_at TEXT,
  last_successful_refund_updated_at TEXT,
  sales_baseline_at TEXT,
  disconnected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE yoco_connections ADD COLUMN webhook_url TEXT;
ALTER TABLE yoco_connections ADD COLUMN webhook_previous_id TEXT;
ALTER TABLE yoco_connections ADD COLUMN webhook_previous_secret TEXT;
ALTER TABLE yoco_connections ADD COLUMN webhook_previous_until TEXT;
ALTER TABLE yoco_connections ADD COLUMN connection_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE yoco_connections ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE yoco_connections ADD COLUMN api_key_fingerprint TEXT;
ALTER TABLE yoco_connections ADD COLUMN api_key_locked_at TEXT;
ALTER TABLE yoco_connections ADD COLUMN api_key_locked_by_uid TEXT;
ALTER TABLE yoco_connections ADD COLUMN last_catalogue_sync_at TEXT;
ALTER TABLE yoco_connections ADD COLUMN last_sales_sync_at TEXT;
ALTER TABLE yoco_connections ADD COLUMN last_successful_order_updated_at TEXT;
ALTER TABLE yoco_connections ADD COLUMN last_successful_refund_updated_at TEXT;
ALTER TABLE yoco_connections ADD COLUMN sales_baseline_at TEXT;
ALTER TABLE yoco_connections ADD COLUMN disconnected_at TEXT;
ALTER TABLE yoco_connections ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE yoco_connections ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

CREATE TABLE IF NOT EXISTS integration_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'yoco-v2',
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
  ON integration_logs(workspace_id, status, created_at);

${YOCO_V2_FOUNDATION_MIGRATION}
${YOCO_V2_SALE_SHADOW_MIGRATION}
${YOCO_V2_REFUND_RECONCILIATION_MIGRATION}
${YOCO_V2_CONTROLLED_CUTOVER_MIGRATION}
${YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION}
${YOCO_V2_LEGACY_SHUTDOWN_MIGRATION}
${YOCO_V2_ADMIN_CONTROL_CENTRE_MIGRATION}
${YOCO_V2_EFFECT_GATE_MIGRATION}
`;

// Bumped to v2 (2026-08-21) after adding YOCO_V2_EFFECT_GATE_MIGRATION to this script: a fixed
// repair id only ever runs once per tenant, so tenants that already ran v1 would silently never
// pick up new content appended to the script later. Root-caused via a workspace whose
// `_kcp_schema.version` (44) had drifted ahead of the current indexed TENANT_MIGRATIONS array
// length (36) from earlier development history — the indexed-migration loop legitimately skipped
// everything (applied > target), so migration 35 (yoco_v2_effect_gate) was never actually applied
// to that tenant's real storage despite _kcp_schema claiming it was long past done. This
// content-addressed repair path is what's supposed to catch exactly that kind of drift, but only
// if its id changes whenever meaningful content is added. Bump this id again whenever a new
// migration is appended here.
//
// Deliberately NOT extended again for the 2026-08-26 vat_rate/vat_registered fix — see
// YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR below instead. Appending more content here and bumping this
// id forces every tenant's DO to re-run the ENTIRE historical blob above (foundation through
// effect-gate) on its next cold start; against a tenant with 5+ days of accumulated data since v2
// first ran, that blew the Durable Object's CPU time limit in production and put it into a
// repeating crash loop (the repair fails mid-transaction, rolls back, never gets recorded as done,
// and so retries — and crashes — again on every subsequent request). A new, tiny,
// independently-tracked repair for just the newly-missing columns avoids re-paying that cost.
export const YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID = 'yoco-v2-connect-schema-v2';

/**
 * Small, standalone companion to YOCO_V2_RUNTIME_SCHEMA_REPAIR — same "tenant's _kcp_schema
 * version drifted ahead of the indexed migration array" failure class, but kept as its own
 * script/id rather than appended to the big one above, specifically so applying it does NOT
 * require re-running that entire historical blob (foundation through effect-gate) again. Live
 * production incident, 2026-08-26: a tenant on _kcp_schema.version 44 (already past the 37-entry
 * TENANT_MIGRATIONS array) was missing workspace_settings.vat_registered (index 32) and
 * yoco_orders.vat_rate/vat_registered (index 36) — every sale write failed outright with
 * "table yoco_orders has no column named vat_rate".
 *
 * Also includes the four ADD COLUMN statements from index 33
 * (YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION) — same missing-column class, and turned out to be
 * more than a "slower-burning" issue: runScheduledYocoV2Reconciliation's very first write on every
 * tick sets `last_attempt_at`, and without that column the whole UPDATE throws before it can record
 * that it ran at all. That is the exact write-storm precondition the migration was built to
 * prevent in the first place (`dailyDue` never advances, so every ~15-minute cron tick retries
 * forever) — confirmed live: this tenant's reconciliation route was erroring on every single tick.
 * Deliberately does NOT include the rest of that migration — the UPDATE queries with correlated
 * subqueries over yoco_v2_reconciliation_findings that dedupe historical rows. Those are a data-
 * cleanliness improvement, not something blocking correctness, and a tenant that never got this
 * migration is exactly the kind likely to have accumulated a large findings table from the very
 * runaway-loop bug being fixed here — a second, independent CPU-cost risk best kept out of the
 * same emergency pass that already caused one CPU-limit incident today.
 */
export const YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR = `
ALTER TABLE workspace_settings ADD COLUMN vat_registered INTEGER NOT NULL DEFAULT 1;
ALTER TABLE yoco_orders ADD COLUMN vat_rate REAL;
ALTER TABLE yoco_orders ADD COLUMN vat_registered INTEGER;
ALTER TABLE yoco_v2_reconciliation_state ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE yoco_v2_reconciliation_state ADD COLUMN next_retry_at TEXT;
ALTER TABLE yoco_v2_reconciliation_state ADD COLUMN last_failure_reason TEXT;
ALTER TABLE yoco_v2_reconciliation_state ADD COLUMN last_attempt_at TEXT;
`;

export const YOCO_V2_VAT_SNAPSHOT_SCHEMA_REPAIR_ID = 'yoco-v2-vat-snapshot-schema-repair-v2';

/**
 * Hot-path schema added 2026-08-27 (TENANT_MIGRATIONS 37-39), repeated here as a content-addressed
 * repair because the indexed-migration loop CANNOT deliver it to every tenant.
 *
 * `migrate()` only advances while `_kcp_schema.version < TENANT_MIGRATIONS.length`. A workspace whose
 * version drifted AHEAD of the array during earlier development history therefore skips the loop
 * entirely and can never receive a newly appended migration. This is not hypothetical: the live
 * WS-lellos-trattoria-bee300 tenant reports appliedVersion 44 against totalMigrations 40, so
 * migrations 37, 38 and 39 would never have reached it.
 *
 * That matters beyond performance. saveStockItem() resolves duplicate names with
 * `WHERE name_key = ?`, so on a drifted tenant the missing COLUMN — not just a missing index — makes
 * every stock-item save fail outright with "no such column: name_key". Repairs are keyed by id in
 * _kcp_runtime_repairs, independent of the version counter, so they reach drifted tenants too.
 *
 * Deliberately DDL-only: no data backfill. Populating name_key is handled separately by the bounded,
 * resumable batch loop in workspace-do.ts, which is what keeps a large stock_items table from
 * exceeding a Durable Object's per-request CPU limit. Bump the id if statements are added here.
 */
export const HOT_PATH_INDEX_SCHEMA_REPAIR = `
ALTER TABLE stock_items ADD COLUMN name_key TEXT;
CREATE INDEX IF NOT EXISTS idx_products_workspace_active_name_key
  ON products(workspace_id, active, lower(trim(name)));
CREATE INDEX IF NOT EXISTS idx_products_workspace_active_sort
  ON products(workspace_id, active, lower(category), lower(name));
CREATE INDEX IF NOT EXISTS idx_stock_items_workspace_active_name
  ON stock_items(workspace_id, active, name);
CREATE INDEX IF NOT EXISTS idx_stock_items_workspace_active_name_key
  ON stock_items(workspace_id, active, name_key);
CREATE INDEX IF NOT EXISTS idx_yoco_order_lines_workspace_product
  ON yoco_order_lines(workspace_id, product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_workspace_movement_type
  ON stock_movements(workspace_id, movement_type);
`;

export const HOT_PATH_INDEX_SCHEMA_REPAIR_ID = 'hot-path-indexes-and-name-key-v1';

/**
 * Same drift problem as HOT_PATH_INDEX_SCHEMA_REPAIR above, for two fixes added 2026-08-28 as plain
 * TENANT_MIGRATIONS entries (40 and 41): the reconciliation-scan index and the
 * stock_item_latest_purchase table. A NEW repair rather than appending to
 * HOT_PATH_INDEX_SCHEMA_REPAIR's existing content, per that repair's own comment — its id is already
 * recorded as applied for tenants that ran it, so new statements added to old content would never
 * reach them.
 *
 * Without this, WS-lellos-trattoria-bee300 (and any other tenant whose _kcp_schema.version drifted
 * ahead of TENANT_MIGRATIONS.length) would never get either fix: the reconciliation query's
 * `INDEXED BY` would keep hitting its "no such index" fallback to the slow scan forever (not just
 * during a brief catch-up window), and the Stock Control report would keep reading its
 * `stock_item_latest_purchase` JOIN against a table that doesn't exist — silently returning no
 * purchase data rather than erroring, since that JOIN is a LEFT JOIN.
 *
 * Deliberately DDL-only, same as HOT_PATH_INDEX_SCHEMA_REPAIR: the stock_item_latest_purchase
 * backfill is a separate bounded, resumable batch loop in workspace-do.ts.
 */
export const RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR = `
CREATE INDEX IF NOT EXISTS idx_yoco_v2_domain_events_workspace_status
  ON yoco_v2_domain_events(workspace_id, integration_id, event_type, resolution_status);
CREATE TABLE IF NOT EXISTS stock_item_latest_purchase (
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
);
`;

export const RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR_ID = 'reconciliation-index-and-purchase-summary-v1';

/**
 * Same drift problem again, for migration 42 (adjustment_lines/adjustments indexes, 2026-08-28).
 * A new repair rather than appending to RECONCILIATION_AND_PURCHASE_SUMMARY_SCHEMA_REPAIR, so each
 * repair's name stays an honest description of what it contains.
 */
export const ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR = `
CREATE INDEX IF NOT EXISTS idx_adjustment_lines_adjustment
  ON adjustment_lines(adjustment_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_workspace_type
  ON adjustments(workspace_id, adjustment_type, occurred_at);
`;

export const ADJUSTMENT_LINES_INDEX_SCHEMA_REPAIR_ID = 'adjustment-lines-index-v1';
