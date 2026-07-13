/**
 * Generate the per-tenant SQLite schema (src/tenant-schema.generated.ts) from the CURRENT
 * single-D1 migrations in ../cloudflare/migrations.
 *
 * Transform rules:
 *  - Keep DOMAIN tables only; drop CENTRAL-plane tables (identity/registry/admin) — those live
 *    in CENTRAL_DB (cloudflare-v2/migrations/0001_central.sql).
 *  - Strip FK references to central tables (workspaces/app_users) — those tables don't exist
 *    inside a tenant DO, so the FK would be invalid. Domain->domain FKs are kept.
 *  - Keep the workspace_id columns (harmless in a single-tenant DO) so existing handlers run
 *    unchanged; they can be dropped as later cleanup.
 *
 * Run: node scripts/gen-tenant-schema.mjs   (from cloudflare-v2/)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', '..', 'cloudflare', 'migrations');
const OUT = join(here, '..', 'src', 'tenant-schema.generated.ts');

// Central-plane tables — excluded from the tenant DO (they live in CENTRAL_DB).
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

/** Split a SQL file into top-level statements on `;`, ignoring `;` inside string/identifier quotes. */
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
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Strip line comments so table detection isn't fooled by commented DDL. */
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
  if ((m = s.match(/^CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/i))) return { kind: 'view', name: m[1] };
  if ((m = s.match(/^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?\w+\s+[\s\S]*?\bON\s+["`]?(\w+)/i)))
    return { kind: 'trigger', name: m[1] };
  if ((m = s.match(/^ALTER\s+TABLE\s+["`]?(\w+)/i))) return { kind: 'alter', name: m[1] };
  return { kind: 'other', name: null };
}

/** Remove FK clauses that point at central tables (they don't exist in a tenant DO). */
function stripCentralFks(stmt) {
  let s = stmt;
  // Standalone table constraints FIRST (before the inline pass eats their REFERENCES part):
  //   [,] FOREIGN KEY (...) REFERENCES workspaces(...) [ON DELETE ...]
  s = s.replace(
    /,?\s*FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+(?:workspaces|app_users)\s*\([^)]*\)(\s+ON\s+DELETE\s+\w+)?/gi,
    ''
  );
  // Inline column refs:  ... REFERENCES workspaces(id) ON DELETE CASCADE  (also app_users)
  s = s.replace(/\s+REFERENCES\s+(?:workspaces|app_users)\s*\([^)]*\)(\s+ON\s+DELETE\s+\w+)?/gi, '');
  // Clean any dangling comma left before a closing paren:  ",\n )" -> "\n )"
  s = s.replace(/,(\s*)\)/g, '$1)');
  return s;
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+.*\.sql$/.test(f))
  .sort();

/** Pull column names out of a CREATE TABLE body (skip table-level constraints). */
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
  return cols
    .map((c) => c.trim().split(/\s+/)[0]?.replace(/["`]/g, ''))
    .filter((c) => c && !CONSTRAINTS.has(c.toUpperCase()));
}

const kept = [];
const droppedCentral = new Set();
const keptTables = new Set();
const droppedAlters = [];
const tableCols = new Map(); // table -> Set(columns), to skip redundant ADD COLUMN

for (const file of files) {
  const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  for (const rawStmt of splitStatements(raw)) {
    const noComments = stripComments(rawStmt);
    if (!noComments.trim()) continue;
    const { kind, name } = targetTable(noComments);
    if (kind === 'other') continue; // skip INSERTs/PRAGMAs
    if (name && CENTRAL_TABLES.has(name)) {
      droppedCentral.add(name);
      continue;
    }
    let cleaned = stripCentralFks(noComments).trim();

    // The `transfers` table's to_location_id (and from_location_id) can reference a location in
    // ANOTHER workspace's DO for external transfers, so a local FK to locations(id) can never hold.
    // Strip those FKs specifically (all other tables' location FKs are same-workspace and stay).
    if (kind === 'table' && name === 'transfers') {
      cleaned = cleaned.replace(/\s+REFERENCES\s+locations\s*\([^)]*\)(\s+ON\s+DELETE\s+\w+)?/gi, '');
    }

    if (kind === 'alter') {
      // Only ADD COLUMN is expected; drop it if the column already exists (base migration edited later).
      const m = cleaned.match(/ADD\s+COLUMN\s+["`]?(\w+)/i);
      const set = tableCols.get(name);
      if (m && set) {
        if (set.has(m[1])) {
          droppedAlters.push(`${name}.${m[1]}`);
          continue;
        }
        set.add(m[1]);
      }
      kept.push(cleaned + ';');
      continue;
    }

    kept.push(cleaned + ';');
    if (kind === 'table' && name) {
      keptTables.add(name);
      tableCols.set(name, new Set(extractColumns(cleaned)));
    }
  }
}

// Sanity: no lingering central references should remain.
const leftover = kept.filter((s) => /REFERENCES\s+(workspaces|app_users)\b/i.test(s));
if (leftover.length) {
  console.error('!! Central FK not stripped in:\n' + leftover.join('\n---\n'));
  process.exit(1);
}

const banner = `// AUTO-GENERATED by scripts/gen-tenant-schema.mjs from ../cloudflare/migrations. DO NOT EDIT.
// Regenerate: node scripts/gen-tenant-schema.mjs
// Domain tables only; central-plane tables live in CENTRAL_DB. Central FKs stripped.
`;
const body = `export const TENANT_SCHEMA_SQL = ${JSON.stringify(kept.join('\n\n'))};\n`;
writeFileSync(OUT, banner + body);

console.log(`Kept ${keptTables.size} tables, ${kept.length} statements.`);
console.log(`Dropped central: ${[...droppedCentral].sort().join(', ')}`);
if (droppedAlters.length) console.log(`Dropped redundant ADD COLUMN: ${droppedAlters.join(', ')}`);
console.log(`Tenant tables: ${[...keptTables].sort().join(', ')}`);
