export const YOCO_V2_FOUNDATION_MIGRATION = `
CREATE TABLE IF NOT EXISTS integration_effect_ownership (
  workspace_id TEXT NOT NULL,
  integration_type TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  enabled_at TEXT,
  enabled_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, integration_type, effect_type),
  CHECK (effect_type IN ('SALE_REPORTING', 'SALE_STOCK', 'REFUND_REPORTING', 'REFUND_STOCK')),
  CHECK (engine_version IN ('LEGACY', 'V2'))
);

CREATE TABLE IF NOT EXISTS yoco_v2_raw_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  yoco_event_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  source_ip TEXT,
  headers_json TEXT NOT NULL DEFAULT '{}',
  capture_status TEXT NOT NULL DEFAULT 'CAPTURED',
  queue_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED',
  processing_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  completed_at TEXT,
  duplicate_receipts INTEGER NOT NULL DEFAULT 0,
  last_duplicate_at TEXT,
  trace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, integration_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_raw_events_workspace_received
  ON yoco_v2_raw_events(workspace_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_raw_events_processing
  ON yoco_v2_raw_events(workspace_id, processing_status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_raw_events_trace
  ON yoco_v2_raw_events(workspace_id, trace_id);

CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_raw_events_immutable
BEFORE UPDATE OF workspace_id, integration_id, event_key, yoco_event_id, event_type,
  payload_json, payload_hash, signature_valid, received_at, source_ip, headers_json, trace_id, created_at
ON yoco_v2_raw_events
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_raw_events immutable fields cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_raw_events_no_delete
BEFORE DELETE ON yoco_v2_raw_events
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_raw_events are immutable and cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS yoco_v2_processing_runs (
  id TEXT PRIMARY KEY,
  raw_event_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  next_retry_at TEXT,
  error_category TEXT,
  error_code TEXT,
  error_message TEXT,
  error_details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (raw_event_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_runs_workspace_status
  ON yoco_v2_processing_runs(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_runs_raw_event
  ON yoco_v2_processing_runs(raw_event_id, attempt_number DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_processing_timeline (
  id TEXT PRIMARY KEY,
  raw_event_id TEXT NOT NULL,
  processing_run_id TEXT,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_timeline_event_created
  ON yoco_v2_processing_timeline(raw_event_id, created_at, id);

CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_timeline_no_update
BEFORE UPDATE ON yoco_v2_processing_timeline
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_processing_timeline is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_timeline_no_delete
BEFORE DELETE ON yoco_v2_processing_timeline
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_processing_timeline is append-only');
END;
`;

export const YOCO_V2_SALE_SHADOW_MIGRATION = `
CREATE TABLE IF NOT EXISTS yoco_v2_api_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  raw_event_id TEXT,
  processing_run_id TEXT,
  trace_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  method TEXT NOT NULL,
  endpoint_name TEXT NOT NULL,
  resource_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  request_started_at TEXT NOT NULL,
  request_completed_at TEXT,
  duration_ms INTEGER,
  response_status INTEGER,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  retry_after_seconds INTEGER NOT NULL DEFAULT 0,
  cache_status TEXT NOT NULL DEFAULT 'MISS',
  error_category TEXT,
  error_code TEXT,
  redacted_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_api_requests_integration_date
  ON yoco_v2_api_requests(workspace_id, integration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_api_requests_trace
  ON yoco_v2_api_requests(workspace_id, trace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_api_requests_event
  ON yoco_v2_api_requests(raw_event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_integration_runtime (
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  paused_until TEXT,
  pause_reason TEXT,
  intervention_required INTEGER NOT NULL DEFAULT 0,
  consecutive_auth_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_rate_limits INTEGER NOT NULL DEFAULT 0,
  last_cache_status TEXT,
  last_response_status INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, integration_id)
);

CREATE TABLE IF NOT EXISTS yoco_v2_domain_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  raw_event_id TEXT NOT NULL,
  processing_run_id TEXT,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  resolution_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, integration_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_domain_events_order
  ON yoco_v2_domain_events(workspace_id, source_entity_id, event_type);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_domain_events_raw
  ON yoco_v2_domain_events(raw_event_id);

CREATE TABLE IF NOT EXISTS yoco_v2_proposed_stock_movements (
  id TEXT PRIMARY KEY,
  domain_event_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  location_id TEXT,
  source_order_id TEXT NOT NULL,
  source_line_id TEXT NOT NULL,
  menu_item_id TEXT,
  modifier_id TEXT,
  ingredient_item_id TEXT NOT NULL,
  movement_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  base_uom TEXT NOT NULL,
  unit_cost_ex_vat REAL NOT NULL DEFAULT 0,
  movement_value REAL NOT NULL DEFAULT 0,
  proposal_key TEXT NOT NULL,
  resolution_status TEXT NOT NULL,
  warning_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, proposal_key)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_proposals_domain
  ON yoco_v2_proposed_stock_movements(domain_event_id, source_line_id);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_proposals_order
  ON yoco_v2_proposed_stock_movements(workspace_id, source_order_id);

CREATE TABLE IF NOT EXISTS yoco_v2_sale_comparisons (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
  legacy_sale_found INTEGER NOT NULL DEFAULT 0,
  legacy_stock_movement_count INTEGER NOT NULL DEFAULT 0,
  v2_stock_proposal_count INTEGER NOT NULL DEFAULT 0,
  financial_match_status TEXT NOT NULL,
  stock_match_status TEXT NOT NULL,
  location_match_status TEXT NOT NULL,
  mapping_match_status TEXT NOT NULL,
  comparison_status TEXT NOT NULL,
  difference_summary_json TEXT NOT NULL DEFAULT '{}',
  compared_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_order_id)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_sale_comparisons_status
  ON yoco_v2_sale_comparisons(workspace_id, comparison_status, compared_at DESC);
`;

export const YOCO_V2_REFUND_RECONCILIATION_MIGRATION = `
CREATE TABLE IF NOT EXISTS yoco_v2_refund_workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  raw_event_id TEXT NOT NULL,
  domain_event_id TEXT,
  refund_id TEXT NOT NULL,
  source_order_id TEXT,
  current_step TEXT NOT NULL DEFAULT 'RECEIVED',
  financial_status TEXT NOT NULL DEFAULT 'PENDING',
  inventory_status TEXT NOT NULL DEFAULT 'PENDING',
  reporting_status TEXT NOT NULL DEFAULT 'PENDING',
  reconciliation_status TEXT NOT NULL DEFAULT 'PENDING',
  overall_status TEXT NOT NULL DEFAULT 'RECEIVED',
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, integration_id, refund_id)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_refund_workflows_status
  ON yoco_v2_refund_workflows(workspace_id, overall_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_refund_workflows_order
  ON yoco_v2_refund_workflows(workspace_id, source_order_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_manual_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  domain_event_id TEXT,
  review_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  reason_code TEXT NOT NULL,
  reason_message TEXT NOT NULL,
  available_source_lines_json TEXT NOT NULL DEFAULT '[]',
  refund_financials_json TEXT NOT NULL DEFAULT '{}',
  proposed_allocation_json TEXT NOT NULL DEFAULT '[]',
  resolved_allocation_json TEXT NOT NULL DEFAULT '[]',
  audit_history_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, domain_event_id, review_type, reason_code)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_manual_reviews_open
  ON yoco_v2_manual_reviews(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_proposed_refund_reporting (
  id TEXT PRIMARY KEY,
  domain_event_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  gross_amount REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  tip_amount REAL NOT NULL DEFAULT 0,
  proposal_key TEXT NOT NULL,
  resolution_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, proposal_key)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_refund_reporting_domain
  ON yoco_v2_proposed_refund_reporting(domain_event_id);

CREATE TABLE IF NOT EXISTS yoco_v2_proposed_refund_stock_movements (
  id TEXT PRIMARY KEY,
  domain_event_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  location_id TEXT,
  source_order_id TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  source_refund_line_id TEXT NOT NULL,
  source_original_line_id TEXT NOT NULL,
  menu_item_id TEXT,
  modifier_id TEXT,
  ingredient_item_id TEXT NOT NULL,
  movement_type TEXT NOT NULL DEFAULT 'sale_refund_shadow',
  quantity REAL NOT NULL,
  base_uom TEXT NOT NULL,
  unit_cost_ex_vat REAL NOT NULL DEFAULT 0,
  movement_value REAL NOT NULL DEFAULT 0,
  proposal_key TEXT NOT NULL,
  resolution_status TEXT NOT NULL,
  warning_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, proposal_key)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_refund_stock_domain
  ON yoco_v2_proposed_refund_stock_movements(domain_event_id, source_refund_line_id);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_refund_stock_order
  ON yoco_v2_proposed_refund_stock_movements(workspace_id, source_order_id, refund_id);

CREATE TABLE IF NOT EXISTS yoco_v2_refund_comparisons (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
  legacy_refund_found INTEGER NOT NULL DEFAULT 0,
  legacy_reporting_found INTEGER NOT NULL DEFAULT 0,
  legacy_return_movement_count INTEGER NOT NULL DEFAULT 0,
  v2_reporting_proposal_status TEXT NOT NULL,
  v2_stock_proposal_count INTEGER NOT NULL DEFAULT 0,
  financial_match_status TEXT NOT NULL,
  stock_match_status TEXT NOT NULL,
  comparison_status TEXT NOT NULL,
  difference_summary_json TEXT NOT NULL DEFAULT '{}',
  compared_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, refund_id)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_refund_comparisons_status
  ON yoco_v2_refund_comparisons(workspace_id, comparison_status, compared_at DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_reconciliation_state (
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  schedule_mode TEXT NOT NULL DEFAULT 'HOURLY_AND_DAILY',
  checkpoint_at TEXT,
  overlap_minutes INTEGER NOT NULL DEFAULT 120,
  last_hourly_run_at TEXT,
  last_daily_run_at TEXT,
  pause_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, integration_id)
);

CREATE TABLE IF NOT EXISTS yoco_v2_reconciliation_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  checkpoint_before TEXT,
  checkpoint_after TEXT,
  status TEXT NOT NULL,
  orders_examined INTEGER NOT NULL DEFAULT 0,
  refunds_examined INTEGER NOT NULL DEFAULT 0,
  missing_events_found INTEGER NOT NULL DEFAULT 0,
  mismatches_found INTEGER NOT NULL DEFAULT 0,
  automatic_repairs INTEGER NOT NULL DEFAULT 0,
  manual_reviews_created INTEGER NOT NULL DEFAULT 0,
  error_summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_reconciliation_runs_latest
  ON yoco_v2_reconciliation_runs(workspace_id, integration_id, started_at DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_reconciliation_findings (
  id TEXT PRIMARY KEY,
  reconciliation_run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  source_entity_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  finding_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  details_json TEXT NOT NULL DEFAULT '{}',
  repair_action TEXT,
  repaired_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (reconciliation_run_id, finding_type, source_entity_type, source_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_reconciliation_findings_open
  ON yoco_v2_reconciliation_findings(workspace_id, status, severity, created_at DESC);
`;


export const YOCO_V2_CONTROLLED_CUTOVER_MIGRATION = `
-- Phase V2 10: controlled sale-only cutover. Refund ownership remains legacy.
CREATE TABLE IF NOT EXISTS yoco_v2_effect_controls (
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
  CHECK (effect_type IN ('SALE_REPORTING', 'SALE_STOCK'))
);

CREATE TABLE IF NOT EXISTS yoco_v2_cutover_readiness (
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'BLOCKED',
  comparison_window_start TEXT,
  comparison_window_end TEXT,
  comparison_count INTEGER NOT NULL DEFAULT 0,
  comparison_matched INTEGER NOT NULL DEFAULT 0,
  comparison_unstable INTEGER NOT NULL DEFAULT 0,
  duplicate_tests_passed INTEGER NOT NULL DEFAULT 0,
  out_of_order_tests_passed INTEGER NOT NULL DEFAULT 0,
  rate_limit_tests_passed INTEGER NOT NULL DEFAULT 0,
  reconciliation_passed INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS yoco_v2_cutover_history (
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
  CHECK (effect_type IN ('SALE_REPORTING', 'SALE_STOCK')),
  CHECK (previous_engine_version IN ('LEGACY', 'V2')),
  CHECK (new_engine_version IN ('LEGACY', 'V2'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_cutover_history_workspace
  ON yoco_v2_cutover_history(workspace_id, cutover_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_cutover_history_no_update
BEFORE UPDATE ON yoco_v2_cutover_history
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_cutover_history is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_cutover_history_no_delete
BEFORE DELETE ON yoco_v2_cutover_history
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_cutover_history is append-only');
END;

CREATE TABLE IF NOT EXISTS yoco_v2_live_effect_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
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
  CHECK (effect_type IN ('SALE_REPORTING', 'SALE_STOCK')),
  CHECK (status IN ('PENDING', 'PROCESSING', 'APPLIED', 'FAILED', 'PAUSED', 'SKIPPED_BEFORE_CUTOVER', 'BLOCKED'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_live_outbox_pending
  ON yoco_v2_live_effect_outbox(workspace_id, status, updated_at);

CREATE TABLE IF NOT EXISTS yoco_v2_live_sale_reporting_effects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  yoco_order_db_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, effect_key),
  UNIQUE (workspace_id, source_order_id)
);

CREATE TABLE IF NOT EXISTS yoco_v2_live_sale_stock_effects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  proposal_key TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  movement_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, effect_key),
  UNIQUE (workspace_id, movement_id),
  CHECK (status IN ('PENDING', 'APPLIED', 'FAILED', 'BLOCKED'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_live_stock_order
  ON yoco_v2_live_sale_stock_effects(workspace_id, source_order_id);

CREATE TABLE IF NOT EXISTS yoco_v2_transition_reconciliations (
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
  CHECK (effect_type IN ('SALE_REPORTING', 'SALE_STOCK')),
  CHECK (status IN ('PENDING', 'COMPLETED', 'UNCERTAIN', 'FAILED'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_transition_latest
  ON yoco_v2_transition_reconciliations(workspace_id, effect_type, created_at DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_transition_findings (
  id TEXT PRIMARY KEY,
  transition_reconciliation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  raw_event_id TEXT,
  expected_engine TEXT NOT NULL,
  legacy_effect_found INTEGER NOT NULL DEFAULT 0,
  v2_effect_found INTEGER NOT NULL DEFAULT 0,
  finding_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (transition_reconciliation_id, effect_type, source_order_id, finding_type)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_transition_findings_workspace
  ON yoco_v2_transition_findings(workspace_id, created_at DESC);
`;


export const YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION = `
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
`;

export const YOCO_V2_LEGACY_SHUTDOWN_MIGRATION = `
-- Phase V2 12: configuration-and-ownership controlled legacy shutdown observation.
-- Legacy code and historical tables remain present. Phase 13 deletion is intentionally absent.
CREATE TABLE IF NOT EXISTS yoco_v2_legacy_shutdown_state (
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREPARING',
  configuration_enabled INTEGER NOT NULL DEFAULT 0,
  all_effects_v2 INTEGER NOT NULL DEFAULT 0,
  admin_dependency_audit_passed INTEGER NOT NULL DEFAULT 0,
  rollback_documentation_validated INTEGER NOT NULL DEFAULT 0,
  rollback_documentation_validated_at TEXT,
  rollback_documentation_validated_by TEXT,
  readiness_checked_at TEXT,
  observation_started_at TEXT,
  observation_required_until TEXT,
  observation_completed_at TEXT,
  observation_approved_at TEXT,
  observation_approved_by TEXT,
  legacy_execution_disabled_at TEXT,
  legacy_execution_disabled_by TEXT,
  legacy_execution_rollback_at TEXT,
  legacy_execution_rollback_by TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, integration_id),
  CHECK (status IN ('PREPARING','BLOCKED','READY','OBSERVING','OBSERVATION_COMPLETE','APPROVED','ACTIVE','PAUSED','ROLLED_BACK'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_legacy_shutdown_status
  ON yoco_v2_legacy_shutdown_state(status, updated_at);

CREATE TABLE IF NOT EXISTS yoco_v2_legacy_shutdown_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_legacy_shutdown_history_workspace
  ON yoco_v2_legacy_shutdown_history(workspace_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_legacy_shutdown_history_no_update
BEFORE UPDATE ON yoco_v2_legacy_shutdown_history
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_legacy_shutdown_history is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_legacy_shutdown_history_no_delete
BEFORE DELETE ON yoco_v2_legacy_shutdown_history
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_legacy_shutdown_history is append-only');
END;

CREATE TABLE IF NOT EXISTS yoco_v2_legacy_invocation_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  path_type TEXT NOT NULL,
  route TEXT,
  action TEXT,
  effect_type TEXT,
  source TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  alert_id TEXT NOT NULL,
  trace_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_legacy_invocation_workspace
  ON yoco_v2_legacy_invocation_events(workspace_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_legacy_invocation_no_update
BEFORE UPDATE ON yoco_v2_legacy_invocation_events
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_legacy_invocation_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_legacy_invocation_no_delete
BEFORE DELETE ON yoco_v2_legacy_invocation_events
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_legacy_invocation_events is append-only');
END;

CREATE TABLE IF NOT EXISTS yoco_v2_operational_alerts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  source_event_id TEXT,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (severity IN ('INFO','WARNING','HIGH','CRITICAL')),
  CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_operational_alerts_open
  ON yoco_v2_operational_alerts(workspace_id, status, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_observation_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL,
  webhook_events_received INTEGER NOT NULL DEFAULT 0,
  webhook_capture_failures INTEGER NOT NULL DEFAULT 0,
  queue_successes INTEGER NOT NULL DEFAULT 0,
  queue_failures INTEGER NOT NULL DEFAULT 0,
  api_rate_limits INTEGER NOT NULL DEFAULT 0,
  sale_completions INTEGER NOT NULL DEFAULT 0,
  refund_completions INTEGER NOT NULL DEFAULT 0,
  manual_reviews_created INTEGER NOT NULL DEFAULT 0,
  reconciliation_mismatches INTEGER NOT NULL DEFAULT 0,
  duplicate_receipts_prevented INTEGER NOT NULL DEFAULT 0,
  stock_accuracy_mismatches INTEGER NOT NULL DEFAULT 0,
  reporting_accuracy_mismatches INTEGER NOT NULL DEFAULT 0,
  dead_letters INTEGER NOT NULL DEFAULT 0,
  legacy_execution_attempts INTEGER NOT NULL DEFAULT 0,
  open_alerts INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  CHECK (status IN ('CLEAN','ATTENTION','FAILED'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_observation_workspace
  ON yoco_v2_observation_snapshots(workspace_id, window_end DESC);
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_observation_snapshots_no_update
BEFORE UPDATE ON yoco_v2_observation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_observation_snapshots is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_observation_snapshots_no_delete
BEFORE DELETE ON yoco_v2_observation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_observation_snapshots is append-only');
END;

CREATE TABLE IF NOT EXISTS yoco_v2_admin_dependency_audits (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  status TEXT NOT NULL,
  blocking_dependencies INTEGER NOT NULL DEFAULT 0,
  dependencies_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (status IN ('PASSED','FAILED','MANUAL_REVIEW'))
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_admin_dependency_audits_workspace
  ON yoco_v2_admin_dependency_audits(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS yoco_v2_phase13_removal_gate (
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'BLOCKED',
  observation_approved INTEGER NOT NULL DEFAULT 0,
  explicit_confirmation INTEGER NOT NULL DEFAULT 0,
  confirmation_at TEXT,
  confirmation_by TEXT,
  data_retention_reviewed INTEGER NOT NULL DEFAULT 0,
  migration_reviewed INTEGER NOT NULL DEFAULT 0,
  notes_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, integration_id),
  CHECK (status IN ('BLOCKED','CONFIRMED','READY'))
);
`;

export const YOCO_V2_ADMIN_CONTROL_CENTRE_MIGRATION = `
CREATE TABLE IF NOT EXISTS yoco_v2_webhook_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  raw_event_id TEXT,
  yoco_event_id TEXT,
  event_type TEXT NOT NULL,
  source_reference TEXT,
  payload_hash TEXT NOT NULL,
  signature_status TEXT NOT NULL,
  capture_status TEXT NOT NULL,
  queue_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
  duplicate_identity TEXT,
  trace_id TEXT NOT NULL,
  redacted_headers_json TEXT NOT NULL DEFAULT '{}',
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_receipts_workspace_received
  ON yoco_v2_webhook_receipts(workspace_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_receipts_event
  ON yoco_v2_webhook_receipts(workspace_id, yoco_event_id, payload_hash);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_receipts_raw_event
  ON yoco_v2_webhook_receipts(raw_event_id, received_at);
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_webhook_receipts_no_update
BEFORE UPDATE ON yoco_v2_webhook_receipts
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_webhook_receipts are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_webhook_receipts_no_delete
BEFORE DELETE ON yoco_v2_webhook_receipts
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_webhook_receipts are append-only');
END;
CREATE TABLE IF NOT EXISTS yoco_v2_admin_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  previous_state_json TEXT NOT NULL DEFAULT '{}',
  resulting_state_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT,
  status TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_admin_actions_workspace_created
  ON yoco_v2_admin_actions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_admin_actions_target
  ON yoco_v2_admin_actions(workspace_id, target_type, target_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_admin_actions_no_update_core
BEFORE UPDATE OF workspace_id, integration_id, actor_uid, actor_email, action,
  target_type, target_id, idempotency_key, previous_state_json, reason, trace_id, created_at
ON yoco_v2_admin_actions
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_admin_actions identity fields are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_yoco_v2_admin_actions_no_delete
BEFORE DELETE ON yoco_v2_admin_actions
BEGIN
  SELECT RAISE(ABORT, 'yoco_v2_admin_actions are append-only');
END;
`;


export const YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION = `
-- Stop the scheduled reconciliation write storm.
--
-- Root cause: runScheduledYocoV2Reconciliation only stamped last_hourly_run_at/last_daily_run_at
-- AFTER runYocoV2Reconciliation returned, and that function re-throws on failure. A failing run
-- therefore never recorded that it had run at all, so \`dailyDue = !Number.isFinite(lastDaily)\`
-- stayed true forever and every single 15-minute cron tick re-ran the FULL deep scan (7-day
-- window, up to 25 pages x 100 rows x 2 entity kinds, ~50 live Yoco calls). For a workspace with
-- no live Yoco connection the API call always fails, which guaranteed the state never advanced --
-- a self-sustaining loop that burned the whole daily Durable Object row-write allowance within a
-- few hours of the 00:00 UTC quota reset, with no client traffic at all.
--
-- These columns let the scheduler record an ATTEMPT (not just a success) and back off after
-- consecutive failures, mirroring the _kcp_migration_health pattern already proven in
-- WorkspaceDO.migrate().
ALTER TABLE yoco_v2_reconciliation_state ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE yoco_v2_reconciliation_state ADD COLUMN next_retry_at TEXT;
ALTER TABLE yoco_v2_reconciliation_state ADD COLUMN last_failure_reason TEXT;
ALTER TABLE yoco_v2_reconciliation_state ADD COLUMN last_attempt_at TEXT;

-- Make findings idempotent ACROSS runs. The existing UNIQUE constraint includes
-- reconciliation_run_id, and every run mints a fresh run id, so \`INSERT OR IGNORE\` could only
-- ever dedupe within one run -- the same unresolved entity was re-inserted as a brand-new row on
-- every tick, forever. Collapse the historical duplicates, then key uniqueness on the finding
-- itself so recurrence bumps a counter instead of writing another row.
ALTER TABLE yoco_v2_reconciliation_findings ADD COLUMN last_seen_at TEXT;
ALTER TABLE yoco_v2_reconciliation_findings ADD COLUMN last_run_id TEXT;
ALTER TABLE yoco_v2_reconciliation_findings ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;

UPDATE yoco_v2_reconciliation_findings
   SET last_seen_at = COALESCE(last_seen_at, created_at),
       last_run_id = COALESCE(last_run_id, reconciliation_run_id);

-- Collapse the historical duplicates onto the EARLIEST row per finding (so created_at keeps
-- meaning "first detected"), but carry the rest of the group's information onto the survivor first:
-- how many times it was seen, when it was last seen, and — critically — whether any sighting was
-- already repaired, so the dedupe cannot silently reopen resolved findings.
UPDATE yoco_v2_reconciliation_findings
   SET occurrence_count = MAX(1, (
         SELECT COUNT(*) FROM yoco_v2_reconciliation_findings d
          WHERE d.workspace_id = yoco_v2_reconciliation_findings.workspace_id
            AND d.integration_id = yoco_v2_reconciliation_findings.integration_id
            AND d.finding_type = yoco_v2_reconciliation_findings.finding_type
            AND d.source_entity_type = yoco_v2_reconciliation_findings.source_entity_type
            AND d.source_entity_id = yoco_v2_reconciliation_findings.source_entity_id)),
       last_seen_at = COALESCE((
         SELECT MAX(COALESCE(d.last_seen_at, d.created_at)) FROM yoco_v2_reconciliation_findings d
          WHERE d.workspace_id = yoco_v2_reconciliation_findings.workspace_id
            AND d.integration_id = yoco_v2_reconciliation_findings.integration_id
            AND d.finding_type = yoco_v2_reconciliation_findings.finding_type
            AND d.source_entity_type = yoco_v2_reconciliation_findings.source_entity_type
            AND d.source_entity_id = yoco_v2_reconciliation_findings.source_entity_id), last_seen_at),
       status = CASE WHEN EXISTS (
         SELECT 1 FROM yoco_v2_reconciliation_findings d
          WHERE d.workspace_id = yoco_v2_reconciliation_findings.workspace_id
            AND d.integration_id = yoco_v2_reconciliation_findings.integration_id
            AND d.finding_type = yoco_v2_reconciliation_findings.finding_type
            AND d.source_entity_type = yoco_v2_reconciliation_findings.source_entity_type
            AND d.source_entity_id = yoco_v2_reconciliation_findings.source_entity_id
            AND d.status = 'REPAIRED') THEN 'REPAIRED' ELSE status END,
       repaired_at = COALESCE(repaired_at, (
         SELECT MAX(d.repaired_at) FROM yoco_v2_reconciliation_findings d
          WHERE d.workspace_id = yoco_v2_reconciliation_findings.workspace_id
            AND d.integration_id = yoco_v2_reconciliation_findings.integration_id
            AND d.finding_type = yoco_v2_reconciliation_findings.finding_type
            AND d.source_entity_type = yoco_v2_reconciliation_findings.source_entity_type
            AND d.source_entity_id = yoco_v2_reconciliation_findings.source_entity_id));

DELETE FROM yoco_v2_reconciliation_findings
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM yoco_v2_reconciliation_findings
    GROUP BY workspace_id, integration_id, finding_type, source_entity_type, source_entity_id
 );

CREATE UNIQUE INDEX IF NOT EXISTS ux_yoco_v2_reconciliation_findings_entity
  ON yoco_v2_reconciliation_findings(workspace_id, integration_id, finding_type, source_entity_type, source_entity_id);
`;
