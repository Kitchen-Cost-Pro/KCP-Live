/**
 * Generate the CENTRAL-plane D1 schema (migrations/0001_central.sql) from the current single-D1
 * migrations in ../cloudflare/migrations — keeping ONLY the central identity/registry/admin tables
 * (with their real column names + FKs, which all reference other central tables so nothing is
 * stripped). Appends the NEW `external_transfers` outbox (cross-tenant coordination; not in the
 * original migrations).
 *
 * This mirrors gen-tenant-schema.mjs but with the inverse table set. Run: node scripts/gen-central-schema.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', '..', 'cloudflare', 'migrations');
const OUT = join(here, '..', 'migrations', '0001_central.sql');

// Central-plane tables (everything else is per-tenant, lives in the DO).
const CENTRAL_TABLES = new Set([
  'app_users',
  'auth_sessions',
  'auth_rate_limits',
  'auth_reset_tokens',
  'workspaces',
  'workspace_members',
  'roles',
  'admin_users',
  'admin_system_settings',
  'admin_audit_events',
  'workspace_registration_requests',
  'workspace_invitations'
]);

function splitStatements(sql) {
  const out = [];
  let cur = '';
  let inS = false;
  let inD = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    if (ch === ';' && !inS && !inD) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function stripComments(stmt) {
  return stmt
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

function targetTable(stmt) {
  const s = stmt.trim();
  let m;
  if ((m = s.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/i))) return { kind: 'table', name: m[1] };
  if ((m = s.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[^;]*?\bON\s+["`]?(\w+)/i)))
    return { kind: 'index', name: m[1] };
  if ((m = s.match(/^ALTER\s+TABLE\s+["`]?(\w+)/i))) return { kind: 'alter', name: m[1] };
  return { kind: 'other', name: null };
}

/** Column names already present in a CREATE TABLE, to skip redundant ALTER ADD COLUMN. */
function extractColumns(createStmt) {
  const open = createStmt.indexOf('(');
  const close = createStmt.lastIndexOf(')');
  if (open < 0 || close < 0) return [];
  const body = createStmt.slice(open + 1, close);
  const cols = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      cols.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) cols.push(cur);
  const CONSTRAINTS = new Set(['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT']);
  return cols.map((c) => c.trim().split(/\s+/)[0]?.replace(/["`]/g, '')).filter((c) => c && !CONSTRAINTS.has(c.toUpperCase()));
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+.*\.sql$/.test(f))
  .sort();

const kept = [];
const keptTables = new Set();
const tableCols = new Map();

for (const file of files) {
  const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  for (const rawStmt of splitStatements(raw)) {
    const noComments = stripComments(rawStmt);
    if (!noComments.trim()) continue;
    const { kind, name } = targetTable(noComments);
    if (kind === 'other') continue;
    if (!name || !CENTRAL_TABLES.has(name)) continue; // keep ONLY central tables
    const cleaned = noComments.trim();
    if (kind === 'alter') {
      const m = cleaned.match(/ADD\s+COLUMN\s+["`]?(\w+)/i);
      const set = tableCols.get(name);
      if (m && set) {
        if (set.has(m[1])) continue;
        set.add(m[1]);
      }
      kept.push(cleaned + ';');
      continue;
    }
    kept.push(cleaned + ';');
    if (kind === 'table') {
      keptTables.add(name);
      tableCols.set(name, new Set(extractColumns(cleaned)));
    }
  }
}

// Columns the original app adds to workspace_members at RUNTIME via ensureMemberLocationsColumn().
// Included here so read paths that don't call that helper (e.g. getWorkspaceAccessRoute) still work.
const memberRuntimeCols = `-- workspace_members columns added at runtime by ensureMemberLocationsColumn() in the source app.
ALTER TABLE workspace_members ADD COLUMN allowed_locations_json TEXT DEFAULT NULL;
ALTER TABLE workspace_members ADD COLUMN can_access_external_transfers INTEGER NOT NULL DEFAULT 1;`;

// org_id/corp_id are promoted to the central workspaces registry (they live in workspace_settings.raw_json
// per-tenant in the source app). Needed so external-transfer target discovery + org/corp fan-out can be
// a single central query instead of a cross-DO scan. Populated on settings-save + provisioning.
const workspaceGroupCols = `-- Group ids promoted to the central registry for cross-workspace discovery (Phase 3c/3d).
ALTER TABLE workspaces ADD COLUMN org_id TEXT;
ALTER TABLE workspaces ADD COLUMN corp_id TEXT;
CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(org_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_corp ON workspaces(corp_id);`;

const externalTransfers = `-- Cross-tenant coordination for EXTERNAL transfers (the shared source of truth for a transfer's
-- lifecycle; each side's WorkspaceDO holds its own local stock movements). NEW in cloudflare-v2.
CREATE TABLE IF NOT EXISTS external_transfers (
  id TEXT PRIMARY KEY,
  from_workspace_id TEXT NOT NULL,
  to_workspace_id TEXT NOT NULL,
  from_location_id TEXT,
  to_location_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_receipt',
  items_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_by TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_external_transfers_to ON external_transfers(to_workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_external_transfers_from ON external_transfers(from_workspace_id, status);`;

const banner = `-- AUTO-GENERATED by scripts/gen-central-schema.mjs from ../cloudflare/migrations. DO NOT EDIT BY HAND.
-- Regenerate: node scripts/gen-central-schema.mjs
-- Central identity/registry/admin plane (shared D1). Per-tenant tables live in each WorkspaceDO.
`;
writeFileSync(
  OUT,
  banner + '\n' + kept.join('\n\n') + '\n\n' + memberRuntimeCols + '\n\n' + workspaceGroupCols + '\n\n' + externalTransfers + '\n'
);

console.log(`Central schema: ${keptTables.size} tables, ${kept.length} statements + external_transfers.`);
console.log(`Tables: ${[...keptTables].sort().join(', ')}`);
