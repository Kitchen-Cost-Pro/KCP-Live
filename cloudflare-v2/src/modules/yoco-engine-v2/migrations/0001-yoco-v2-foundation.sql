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
