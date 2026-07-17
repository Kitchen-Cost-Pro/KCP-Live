-- phase-v2-admin-yoco-engine-control-centre
-- Structured admin observability and append-only action auditing. No live effect tables are changed.
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
