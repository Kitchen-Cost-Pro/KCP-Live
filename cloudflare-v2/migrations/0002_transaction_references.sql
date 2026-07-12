-- Phase 35.2: globally sequenced, customer-facing transaction references.
CREATE TABLE IF NOT EXISTS transaction_reference_sequences (
  entity_type TEXT NOT NULL,
  date_key TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity_type, date_key)
);

CREATE TABLE IF NOT EXISTS transaction_references (
  reference TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  prefix TEXT NOT NULL,
  date_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_type, date_key, sequence)
);

CREATE TABLE IF NOT EXISTS transaction_reference_links (
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  reference TEXT NOT NULL REFERENCES transaction_references(reference) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, entity_type, entity_id),
  UNIQUE (workspace_id, entity_type, reference)
);

CREATE INDEX IF NOT EXISTS idx_transaction_reference_links_reference
  ON transaction_reference_links(reference);
