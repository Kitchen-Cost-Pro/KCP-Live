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
