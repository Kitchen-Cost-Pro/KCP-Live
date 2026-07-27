-- Phase V2 11: controlled refund reporting and stock cutover for explicitly allowlisted pilots.
-- Sale cutover tables remain unchanged. Refund controls are isolated so Phase 10 rollback stays intact.
CREATE TABLE IF NOT EXISTS yoco_v2_refund_effect_controls (
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  feature_enabled INTEGER NOT NULL DEFAULT 0,
  consumption_paused INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  cutover_at TEXT,
  activated_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (workspace_id, integration_id, effect_type),
  CHECK (effect_type IN ('REFUND_REPORTING', 'REFUND_STOCK'))
);

CREATE TABLE IF NOT EXISTS yoco_v2_refund_cutover_readiness (
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'BLOCKED',
  exact_refund_fixtures_passed INTEGER NOT NULL DEFAULT 0,
  amount_only_manual_review_passed INTEGER NOT NULL DEFAULT 0,
  prior_refund_protection_passed INTEGER NOT NULL DEFAULT 0,
  reconciliation_passed INTEGER NOT NULL DEFAULT 0,
  no_duplicate_sale_effects INTEGER NOT NULL DEFAULT 0,
  staging_rollback_tested INTEGER NOT NULL DEFAULT 0,
  staging_rollback_tested_at TEXT,
  staging_rollback_tested_by TEXT,
  pilot_approved INTEGER NOT NULL DEFAULT 0,
  pilot_approved_at TEXT,
  pilot_approved_by TEXT,
  readiness_checked_at TEXT,
  readiness_details_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, integration_id),
  CHECK (status IN ('BLOCKED', 'READY', 'ACTIVE', 'PAUSED', 'ROLLED_BACK'))
);

CREATE TABLE IF NOT EXISTS yoco_v2_refund_cutover_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  previous_engine_version TEXT NOT NULL,
  new_engine_version TEXT NOT NULL,
  previous_enabled INTEGER NOT NULL,
  new_enabled INTEGER NOT NULL,
  cutover_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  transition_window_start TEXT NOT NULL,
  transition_window_end TEXT NOT NULL,
  reconciliation_status TEXT NOT NULL DEFAULT 'PENDING',
  uncertainty_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  CHECK (effect_type IN ('REFUND_REPORTING', 'REFUND_STOCK')),
  CHECK (previous_engine_version IN ('LEGACY', 'V2')),
  CHECK (new_engine_version IN ('LEGACY', 'V2'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_refund_cutover_history_workspace
  ON yoco_v2_refund_cutover_history(workspace_id, cutover_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_refund_cutover_history_no_update
BEFORE UPDATE ON yoco_v2_refund_cutover_history
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_refund_cutover_history is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_refund_cutover_history_no_delete
BEFORE DELETE ON yoco_v2_refund_cutover_history
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_refund_cutover_history is append-only');
END;

CREATE TABLE IF NOT EXISTS yoco_v2_live_refund_effect_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  payload_json TEXT NOT NULL DEFAULT '{}',
  cutover_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  UNIQUE (workspace_id, effect_type, effect_key),
  CHECK (effect_type IN ('REFUND_REPORTING', 'REFUND_STOCK')),
  CHECK (status IN ('PENDING', 'PROCESSING', 'APPLIED', 'FAILED', 'PAUSED', 'SKIPPED_BEFORE_CUTOVER', 'BLOCKED', 'LEGACY_EFFECT_EXISTS'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_live_refund_outbox_pending
  ON yoco_v2_live_refund_effect_outbox(workspace_id, status, updated_at);

CREATE TABLE IF NOT EXISTS yoco_v2_live_refund_reporting_effects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  report_order_key TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  yoco_order_db_id TEXT NOT NULL,
  gross_amount REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  tip_amount REAL NOT NULL DEFAULT 0,
  applied_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, effect_key),
  UNIQUE (workspace_id, refund_id),
  UNIQUE (workspace_id, report_order_key)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_live_refund_reporting_order
  ON yoco_v2_live_refund_reporting_effects(workspace_id, source_order_id, applied_at DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_live_refund_stock_effects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  proposal_key TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  movement_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, effect_key),
  UNIQUE (workspace_id, movement_id),
  CHECK (status IN ('PENDING', 'APPLIED', 'FAILED', 'BLOCKED', 'LEGACY_EFFECT_EXISTS'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_live_refund_stock_refund
  ON yoco_v2_live_refund_stock_effects(workspace_id, refund_id, status);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_live_refund_stock_order
  ON yoco_v2_live_refund_stock_effects(workspace_id, source_order_id, status);

CREATE TABLE IF NOT EXISTS yoco_v2_refund_transition_reconciliations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  cutover_history_id TEXT NOT NULL,
  cutover_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL,
  events_examined INTEGER NOT NULL DEFAULT 0,
  legacy_expected INTEGER NOT NULL DEFAULT 0,
  v2_expected INTEGER NOT NULL DEFAULT 0,
  duplicate_risk_count INTEGER NOT NULL DEFAULT 0,
  missing_effect_count INTEGER NOT NULL DEFAULT 0,
  uncertain_event_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (cutover_history_id),
  CHECK (effect_type IN ('REFUND_REPORTING', 'REFUND_STOCK')),
  CHECK (status IN ('PENDING', 'COMPLETED', 'UNCERTAIN', 'FAILED'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_refund_transition_latest
  ON yoco_v2_refund_transition_reconciliations(workspace_id, effect_type, created_at DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_refund_transition_findings (
  id TEXT PRIMARY KEY,
  transition_reconciliation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  raw_event_id TEXT,
  expected_engine TEXT NOT NULL,
  legacy_effect_found INTEGER NOT NULL DEFAULT 0,
  v2_effect_found INTEGER NOT NULL DEFAULT 0,
  finding_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (transition_reconciliation_id, effect_type, refund_id, finding_type)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_refund_transition_findings_workspace
  ON yoco_v2_refund_transition_findings(workspace_id, created_at DESC);
