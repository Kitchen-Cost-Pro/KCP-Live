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
CREATE INDEX IF NOT EXISTS idx_yoco_v2_api_requests_integration_date ON yoco_v2_api_requests(workspace_id, integration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_api_requests_trace ON yoco_v2_api_requests(workspace_id, trace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_api_requests_event ON yoco_v2_api_requests(raw_event_id, created_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_yoco_v2_domain_events_order ON yoco_v2_domain_events(workspace_id, source_entity_id, event_type);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_domain_events_raw ON yoco_v2_domain_events(raw_event_id);

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
CREATE INDEX IF NOT EXISTS idx_yoco_v2_proposals_domain ON yoco_v2_proposed_stock_movements(domain_event_id, source_line_id);
CREATE INDEX IF NOT EXISTS idx_yoco_v2_proposals_order ON yoco_v2_proposed_stock_movements(workspace_id, source_order_id);

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
CREATE INDEX IF NOT EXISTS idx_yoco_v2_sale_comparisons_status ON yoco_v2_sale_comparisons(workspace_id, comparison_status, compared_at DESC);
