/**
 * ONE-TIME data migration: old single-D1 account  ->  new-account (central D1 + per-workspace DOs).
 *
 * Reads the OLD database with `wrangler d1 execute --remote --json` (run while authenticated to the
 * OLD account) and writes to the NEW deployment over HTTP via the superuser-gated migrate endpoints
 * (POST /api/admin/migrate/central and /api/admin/migrate/workspace/:id). No direct account-to-account
 * connection is needed.
 *
 * Usage (from cloudflare-v2/):
 *   node scripts/migrate.mjs \
 *     --old-db kcp_d1 \
 *     --new-url https://kcp-api-v2.<subdomain>.workers.dev \
 *     --token <SUPERUSER_BEARER_SESSION_TOKEN> \
 *     [--only ws_abc]        # optional: migrate a single workspace \
 *     [--dry-run]            # read + show counts, write nothing
 *
 * Prereq: you are `wrangler login`'d to the OLD account (reads) and the NEW deployment is live with
 * its central schema applied. Idempotent: rows use INSERT OR REPLACE, so re-runs are safe.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Minimal config with NO account_id so wrangler reads the OLD account from env (not cloudflare-v2's
// wrangler.toml, whose account_id points at the NEW account and would otherwise win).
const OLD_CONFIG_PATH = join(tmpdir(), 'kcp-old-read.toml');
writeFileSync(OLD_CONFIG_PATH, 'name = "kcp-old-read"\ncompatibility_date = "2024-01-01"\n');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, [])
);
const OLD_DB = args['old-db'];
const NEW_URL = args['new-url'] && String(args['new-url']).replace(/\/+$/, '');
const TOKEN = args.token;
const ONLY = args.only && args.only !== true ? String(args.only) : null;
const DRY = Boolean(args['dry-run']);
// Central import does INSERT OR REPLACE on app_users, which (via ON DELETE CASCADE on
// auth_sessions.user_id) invalidates the migrating superuser's own bearer mid-run. For a delta re-run
// where central is already migrated, pass --skip-central to import only the tenant plane (DO writes,
// which never touch central), so the bearer survives.
const SKIP_CENTRAL = Boolean(args['skip-central']);
if (!OLD_DB || (!DRY && (!NEW_URL || !TOKEN))) {
  console.error('Required: --old-db, and (unless --dry-run) --new-url + --token. See header.');
  process.exit(1);
}

// Central tables -> CENTRAL_DB. Order matters only for readability; INSERT OR REPLACE ignores FKs off.
// NOTE: admin_system_settings is DELIBERATELY excluded. It holds the NEW account's email_config
// (sender/app-password/appBaseUrl) and system_gmail OAuth — importing the OLD account's row via
// INSERT OR REPLACE clobbers the new identity and makes mail send from the OLD address again.
// The new account owns its own system settings; never source them from the old DB.
const CENTRAL_TABLES = [
  'app_users', 'auth_sessions', 'auth_rate_limits', 'auth_reset_tokens', 'workspaces',
  'workspace_members', 'roles', 'admin_users', 'admin_audit_events',
  'workspace_registration_requests', 'workspace_invitations'
];
// Per-tenant tables -> each workspace's DO (must mirror TENANT_TABLE_ALLOWLIST in routes.ts).
const TENANT_TABLES = [
  'workspace_settings', 'locations', 'stock_items', 'stock_balances', 'stock_item_location_prices',
  'products', 'product_location_prices', 'recipes', 'recipe_lines', 'stock_movements', 'suppliers',
  'purchase_orders', 'purchase_order_lines', 'grvs', 'grv_lines', 'adjustments', 'adjustment_lines',
  'transfers', 'transfer_lines', 'transfer_templates', 'transfer_template_lines', 'stocktake_templates',
  'stocktake_template_lines', 'stocktake_sessions', 'stocktake_count_lines', 'stocktake_drafts',
  'manufacturing_batches', 'manufacturing_batch_lines', 'credit_notes', 'credit_note_lines',
  'user_location_permissions', 'audit_events', 'integration_errors',
  'low_stock_email_settings', 'low_stock_email_runs', 'yoco_connections', 'yoco_categories',
  'yoco_brands', 'yoco_modifier_groups', 'yoco_orders', 'yoco_order_lines', 'yoco_webhook_events',
  'yoco_processed_signatures'
];

// OLD-account creds for the wrangler reads (kept separate from the NEW-account deploy token).
const OLD_TOKEN = process.env.OLD_ACCOUNT_API_TOKEN;
const OLD_ACCT = process.env.OLD_ACCOUNT_ID;
if (!OLD_TOKEN) {
  console.error('Required: OLD_ACCOUNT_API_TOKEN env var (old-account D1 Read token) for reads.');
  process.exit(1);
}

/** Run a read-only query against the OLD D1 and return rows (authenticated to the OLD account).
 *  Retries transient wrangler/D1 API failures (network blips, rate limits) before giving up. */
function queryOld(sql, attempt = 1) {
  const MAX = 4;
  try {
    const out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', OLD_DB, '--config', OLD_CONFIG_PATH, '--remote', '--json', '--command', sql],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 512,
        // Force the OLD-account token + account (the --config has no account_id so env wins).
        env: { ...process.env, CLOUDFLARE_API_TOKEN: OLD_TOKEN, ...(OLD_ACCT ? { CLOUDFLARE_ACCOUNT_ID: OLD_ACCT } : {}) }
      }
    );
    const parsed = JSON.parse(out);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return (first && first.results) || [];
  } catch (e) {
    if (attempt >= MAX) {
      const detail = (e.stderr || e.stdout || e.message || '').toString().slice(0, 500);
      throw new Error(`queryOld failed after ${MAX} attempts: ${sql}\n${detail}`);
    }
    execFileSync('sleep', [String(attempt * 2)]); // simple linear backoff (2s, 4s, 6s)
    return queryOld(sql, attempt + 1);
  }
}

async function postNew(path, body) {
  if (DRY) return { ok: true, dry: true };
  const payload = JSON.stringify(body);
  const MAX = 4;
  let lastErr;
  for (let attempt = 1; attempt <= MAX; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000); // 120s per request
      const res = await fetch(`${NEW_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: payload,
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
      const json = await res.json().catch(() => ({}));
      // Retry only on 5xx / network; a 4xx (auth/validation) is fatal, don't hammer it.
      if (res.status >= 500) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
      if (!res.ok || json.ok === false) throw Object.assign(new Error(`${path} failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`), { fatal: true });
      return json;
    } catch (e) {
      if (e.fatal || attempt >= MAX) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, attempt * 3000)); // 3s,6s,9s backoff
    }
  }
  throw lastErr;
}

function esc(v) {
  return String(v).replace(/'/g, "''");
}

/**
 * The new account uses FRESH encryption keys, so credentials encrypted on the old account can't be
 * decrypted. Blank them out on the way in so clients get a clean "reconnect" prompt (no broken
 * decrypt): Yoco keys/webhook secrets, and the Gmail integration token in workspace_settings.
 */
function sanitizeTenantRows(table, rows) {
  if (table === 'yoco_connections') {
    return rows.map((r) => ({
      ...r,
      api_key_encrypted: null,
      webhook_secret: null,
      webhook_id: null,
      webhook_url: null,
      connection_active: 0,
      status: 'disconnected',
      last_error: 'Reconnect Yoco after account migration.'
    }));
  }
  if (table === 'workspace_settings') {
    return rows.map((r) => {
      try {
        const raw = JSON.parse(r.raw_json || '{}');
        if (raw && raw.integrations && raw.integrations.gmail) {
          delete raw.integrations.gmail; // encrypted with old key — force reconnect
          return { ...r, raw_json: JSON.stringify(raw) };
        }
      } catch { /* leave as-is */ }
      return r;
    });
  }
  return rows;
}

async function main() {
  console.log(`Reading workspaces from OLD db "${OLD_DB}"${DRY ? ' (DRY RUN)' : ''}...`);
  let workspaces = queryOld('SELECT id, name, owner_uid, status, created_at, updated_at FROM workspaces');
  if (ONLY) workspaces = workspaces.filter((w) => w.id === ONLY);
  console.log(`  ${workspaces.length} workspace(s).`);

  // --- Central plane ---
  if (SKIP_CENTRAL) {
    console.log('  central plane SKIPPED (--skip-central).');
  } else {
    // Promote org_id/corp_id from each workspace's settings.raw_json into the central workspaces rows.
    const settingsRows = queryOld('SELECT workspace_id, raw_json FROM workspace_settings');
    const groupByWs = new Map();
    for (const s of settingsRows) {
      let raw = {};
      try { raw = JSON.parse(s.raw_json || '{}'); } catch { /* ignore */ }
      groupByWs.set(s.workspace_id, { org_id: raw.orgId || raw.org_id || null, corp_id: raw.corpId || raw.corp_id || null });
    }

    const central = {};
    for (const table of CENTRAL_TABLES) {
      let rows = queryOld(`SELECT * FROM ${table}`);
      if (ONLY && table === 'workspaces') rows = rows.filter((r) => r.id === ONLY);
      if (table === 'workspaces') {
        rows = rows.map((r) => ({ ...r, org_id: groupByWs.get(r.id)?.org_id ?? null, corp_id: groupByWs.get(r.id)?.corp_id ?? null }));
      }
      central[table] = rows;
      console.log(`  central ${table}: ${rows.length}`);
    }
    await postNew('/api/admin/migrate/central', { tables: central });
    console.log('  central plane imported.');
  }

  // --- Tenant plane (per workspace) ---
  const migrationSummary = [];
  for (const ws of workspaces) {
    const tables = {};
    for (const table of TENANT_TABLES) {
      const rows = queryOld(`SELECT * FROM ${table} WHERE workspace_id = '${esc(ws.id)}'`);
      if (rows.length) tables[table] = sanitizeTenantRows(table, rows);
    }
    const total = Object.values(tables).reduce((n, r) => n + r.length, 0);
    const result = await postNew(`/api/admin/migrate/workspace/${encodeURIComponent(ws.id)}`, { tables });
    migrationSummary.push({ workspace: ws.id, name: ws.name, sourceRows: total, imported: result.counts || {} });
    console.log(`  workspace ${ws.id} (${ws.name}): ${total} source rows -> imported`);
  }

  // --- Reconcile ---
  console.log('\n=== Reconciliation ===');
  for (const r of migrationSummary) {
    const importedTotal = Object.values(r.imported).reduce((n, c) => n + Number(c || 0), 0);
    const ok = DRY || importedTotal === r.sourceRows;
    console.log(`${ok ? 'OK ' : '!! '} ${r.workspace} ${r.name}: source ${r.sourceRows}, imported ${importedTotal}`);
  }
  console.log(DRY ? '\nDRY RUN complete (nothing written).' : '\nMigration complete.');
}

main().catch((e) => {
  console.error('MIGRATION FAILED:', e.message);
  process.exit(1);
});
