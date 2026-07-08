import { TENANT_SCHEMA_SQL } from './tenant-schema.generated';

/**
 * Ordered per-tenant schema migrations, applied INSIDE each WorkspaceDO's own SQLite on first
 * access (and whenever new migrations are appended). The DO records the last-applied index in a
 * `_kcp_schema` table, so each workspace self-provisions and self-upgrades — no fan-out
 * `wrangler d1 migrations apply` across N databases.
 *
 * Index 0 is the BASELINE: the full domain schema, auto-generated from the current single-D1
 * migrations (../cloudflare/migrations) by scripts/gen-tenant-schema.mjs — central-plane tables
 * removed and central FKs stripped (those live in CENTRAL_DB). Regenerate with:
 *   node scripts/gen-tenant-schema.mjs
 *
 * Because the baseline contains non-idempotent `ALTER TABLE ADD COLUMN` statements, it must run
 * exactly once per DO — which the `_kcp_schema` version tracking guarantees. Any future schema
 * change is APPENDED as a new element here (never edit index 0 for existing tenants).
 */
export const TENANT_MIGRATIONS: string[] = [
  // 0 — baseline domain schema (generated).
  TENANT_SCHEMA_SQL,
  // 1 — distinguish manual per-location price overrides from Yoco-synced ones, so the
  // catalogue sync can populate/refresh 'yoco' rows without ever clobbering a user's
  // manual override ('manual'). Existing rows default to 'manual' (they were all manual).
  `ALTER TABLE product_location_prices ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';`
];
