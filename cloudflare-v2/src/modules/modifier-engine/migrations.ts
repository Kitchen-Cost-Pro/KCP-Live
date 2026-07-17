export const MODIFIER_ENGINE_CORE_ACTIONS_MIGRATION = `
CREATE TABLE IF NOT EXISTS modifier_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  modifier_owner_id TEXT NOT NULL,
  source_modifier_id TEXT,
  source_modifier_group_id TEXT,
  source_modifier_variant_id TEXT,
  source_name TEXT,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'ADD_RECIPE', 'ADD_STOCK_ITEM', 'REMOVE_INGREDIENT', 'REPLACE_INGREDIENT', 'NO_STOCK_CHANGE'
  )),
  target_owner_type TEXT,
  target_owner_id TEXT,
  source_stock_item_id TEXT,
  replacement_stock_item_id TEXT,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'ea',
  menu_item_scope_json TEXT NOT NULL DEFAULT '[]',
  location_scope_json TEXT NOT NULL DEFAULT '[]',
  apply_all_matching_products INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'inactive')),
  version INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, modifier_owner_id)
);

CREATE INDEX IF NOT EXISTS idx_modifier_rules_workspace_status
  ON modifier_rules(workspace_id, status, action_type);
CREATE INDEX IF NOT EXISTS idx_modifier_rules_source_ids
  ON modifier_rules(workspace_id, source_modifier_group_id, source_modifier_id, source_modifier_variant_id);

CREATE TABLE IF NOT EXISTS modifier_rule_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  modifier_rule_id TEXT NOT NULL REFERENCES modifier_rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, modifier_rule_id, version)
);

CREATE INDEX IF NOT EXISTS idx_modifier_rule_versions_rule
  ON modifier_rule_versions(workspace_id, modifier_rule_id, version DESC);

CREATE TABLE IF NOT EXISTS modifier_observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  source_line_id TEXT NOT NULL,
  source_modifier_id TEXT NOT NULL DEFAULT '',
  source_modifier_group_id TEXT,
  source_modifier_variant_id TEXT NOT NULL DEFAULT '',
  source_name TEXT,
  mapped_modifier_owner_id TEXT,
  mapping_status TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, source_order_id, source_line_id, source_modifier_id, source_modifier_variant_id)
);

CREATE INDEX IF NOT EXISTS idx_modifier_observations_workspace_status
  ON modifier_observations(workspace_id, mapping_status, observed_at);

INSERT INTO modifier_rules (
  id, workspace_id, modifier_owner_id, action_type, target_owner_type, target_owner_id,
  quantity, unit, apply_all_matching_products, status, version, raw_json, created_at, updated_at
)
SELECT
  'modifier_rule_' || lower(hex(randomblob(16))),
  recipe.workspace_id,
  recipe.owner_id,
  'ADD_RECIPE',
  'yoco_modifier',
  recipe.owner_id,
  1,
  'ea',
  1,
  'active',
  1,
  json_object('migrated_from', 'recipes', 'recipe_id', recipe.id),
  datetime('now'),
  datetime('now')
FROM recipes recipe
WHERE recipe.owner_type = 'yoco_modifier'
  AND recipe.active = 1
  AND NOT EXISTS (
    SELECT 1 FROM modifier_rules rule
     WHERE rule.workspace_id = recipe.workspace_id
       AND rule.modifier_owner_id = recipe.owner_id
  );

INSERT OR IGNORE INTO modifier_rule_versions (
  id, workspace_id, modifier_rule_id, version, snapshot_json, changed_by, changed_at
)
SELECT
  'modifier_rule_version_' || lower(hex(randomblob(16))),
  rule.workspace_id,
  rule.id,
  rule.version,
  json_object(
    'modifierOwnerId', rule.modifier_owner_id,
    'actionType', rule.action_type,
    'targetOwnerType', rule.target_owner_type,
    'targetOwnerId', rule.target_owner_id,
    'quantity', rule.quantity,
    'unit', rule.unit,
    'menuItemIds', json(rule.menu_item_scope_json),
    'locationIds', json(rule.location_scope_json),
    'applyAllMatchingProducts', rule.apply_all_matching_products = 1,
    'status', rule.status,
    'version', rule.version,
    'migratedFrom', 'recipes'
  ),
  NULL,
  rule.created_at
FROM modifier_rules rule
WHERE json_extract(rule.raw_json, '$.migrated_from') = 'recipes';
`;

export const MODIFIER_ENGINE_REFUNDS_RELIABILITY_NOTES_MIGRATION = `
CREATE TABLE IF NOT EXISTS modifier_sale_action_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  source_line_id TEXT NOT NULL,
  menu_item_id TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('MODIFIER', 'NOTE')),
  source_key TEXT NOT NULL,
  source_name TEXT,
  rule_id TEXT,
  rule_version INTEGER,
  action_type TEXT NOT NULL,
  original_line_quantity REAL NOT NULL DEFAULT 1,
  location_id TEXT,
  rule_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, source_order_id, source_line_id, source_kind, source_key)
);
CREATE INDEX IF NOT EXISTS idx_modifier_sale_actions_order
  ON modifier_sale_action_snapshots(workspace_id, source_order_id, source_line_id);

CREATE TABLE IF NOT EXISTS modifier_sale_movement_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  source_line_id TEXT NOT NULL,
  menu_item_id TEXT,
  modifier_id TEXT,
  ingredient_item_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  original_line_quantity REAL NOT NULL DEFAULT 1,
  movement_quantity REAL NOT NULL,
  base_uom TEXT NOT NULL,
  unit_cost_ex_vat REAL NOT NULL DEFAULT 0,
  movement_value REAL NOT NULL DEFAULT 0,
  proposal_key TEXT NOT NULL,
  modifier_rule_id TEXT,
  modifier_rule_version INTEGER,
  modifier_action_type TEXT,
  rule_snapshot_json TEXT NOT NULL DEFAULT '{}',
  original_movement_id TEXT,
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPLIED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, proposal_key)
);
CREATE INDEX IF NOT EXISTS idx_modifier_sale_snapshots_refund
  ON modifier_sale_movement_snapshots(workspace_id, source_order_id, source_line_id, status);
CREATE INDEX IF NOT EXISTS idx_modifier_sale_snapshots_movement
  ON modifier_sale_movement_snapshots(workspace_id, original_movement_id);

ALTER TABLE yoco_v2_proposed_refund_stock_movements ADD COLUMN reversal_metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS modifier_engine_workspace_controls (
  workspace_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'LEGACY_WRITE' CHECK (mode IN ('LEGACY_WRITE', 'OBSERVE', 'LIVE', 'ROLLED_BACK')),
  observation_started_at TEXT,
  cutover_at TEXT,
  rollback_available_until TEXT,
  changed_by TEXT,
  change_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS modifier_engine_comparisons (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  domain_event_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  source_line_id TEXT NOT NULL,
  menu_item_id TEXT,
  old_resolved_usage_json TEXT NOT NULL DEFAULT '[]',
  new_resolved_usage_json TEXT NOT NULL DEFAULT '[]',
  quantity_difference REAL NOT NULL DEFAULT 0,
  cost_difference REAL NOT NULL DEFAULT 0,
  mismatch_reason TEXT NOT NULL,
  comparison_status TEXT NOT NULL CHECK (comparison_status IN ('MATCH', 'MISMATCH', 'PENDING')),
  compared_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, source_order_id, source_line_id)
);
CREATE INDEX IF NOT EXISTS idx_modifier_engine_comparisons_status
  ON modifier_engine_comparisons(workspace_id, comparison_status, compared_at DESC);

CREATE TABLE IF NOT EXISTS modifier_note_occurrences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_order_id TEXT NOT NULL,
  source_line_id TEXT NOT NULL,
  menu_item_id TEXT,
  location_id TEXT,
  raw_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(workspace_id, source_order_id, source_line_id, normalized_text)
);
CREATE INDEX IF NOT EXISTS idx_modifier_note_occurrences_phrase
  ON modifier_note_occurrences(workspace_id, normalized_text, observed_at DESC);

CREATE TABLE IF NOT EXISTS modifier_note_observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  latest_raw_text TEXT NOT NULL,
  raw_variants_json TEXT NOT NULL DEFAULT '[]',
  menu_item_ids_json TEXT NOT NULL DEFAULT '[]',
  location_ids_json TEXT NOT NULL DEFAULT '[]',
  times_seen INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'SUGGESTED' CHECK (disposition IN ('SUGGESTED', 'APPROVED', 'IGNORED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, normalized_text)
);
CREATE INDEX IF NOT EXISTS idx_modifier_note_observations_suggestions
  ON modifier_note_observations(workspace_id, disposition, times_seen DESC, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS modifier_note_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  source_name TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN (
    'ADD_RECIPE', 'ADD_STOCK_ITEM', 'REMOVE_INGREDIENT', 'REPLACE_INGREDIENT', 'NO_STOCK_CHANGE'
  )),
  target_owner_type TEXT,
  target_owner_id TEXT,
  source_stock_item_id TEXT,
  replacement_stock_item_id TEXT,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'ea',
  menu_item_scope_json TEXT NOT NULL DEFAULT '[]',
  location_scope_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('APPROVED', 'IGNORED', 'INACTIVE')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, normalized_text)
);
CREATE INDEX IF NOT EXISTS idx_modifier_note_rules_active
  ON modifier_note_rules(workspace_id, status, normalized_text);

CREATE TABLE IF NOT EXISTS modifier_note_rule_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  modifier_note_rule_id TEXT NOT NULL REFERENCES modifier_note_rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL,
  UNIQUE(workspace_id, modifier_note_rule_id, version)
);
`;
