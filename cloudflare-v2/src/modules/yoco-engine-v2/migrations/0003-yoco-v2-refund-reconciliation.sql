-- Phase V2 07-09: canonical refunds, shadow refund proposals/comparisons, manual reviews and reconciliation.
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
