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
export const YOCO_V2_RUNTIME_SCHEMA_REPAIR_ID = 'yoco-v2-connect-schema-v2';
