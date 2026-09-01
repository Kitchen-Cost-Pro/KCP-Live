/**
 * Same drift problem as the yoco-engine-v2 repairs in
 * `../yoco-engine-v2/schema-repair.ts` (see that file's module comment): a tenant whose
 * `_kcp_schema.version` has drifted ahead of `TENANT_MIGRATIONS.length` skips the indexed
 * migration loop entirely and can never receive a newly appended migration. A tenant on this
 * WorkspaceDO that hadn't yet run migrations 46 ("XERO_V2_GRV_PUSH") and 49
 * ("XERO_V2_GRV_COD_PAYMENT") was missing `purchase_account_code`, `purchase_tax_type`,
 * `purchase_exempt_tax_type`, `grv_sync_enabled`, `last_grv_sync_date`, `grv_sync_claimed_at`, and
 * `cod_payment_account_code` on `xero_sync_settings` — columns `postSettings` in
 * `admin-routes.ts` writes unconditionally in its `INSERT ... ON CONFLICT DO UPDATE`. Every OTHER
 * reader of that table uses `SELECT *`, so a missing column silently read as `undefined`; only
 * the write path threw, producing an uncaught "no such column" 500 with no response body.
 *
 * `FacadeDatabase.execScript` deliberately ignores only duplicate-column errors for
 * `ALTER TABLE ... ADD COLUMN`, so this script is safe to run unconditionally on every
 * WorkspaceDO startup without hiding a real SQL error.
 */
// suppliers.xero_contact_id/xero_contact_synced_at ride along here too — same migration (46)
// added them alongside the xero_sync_settings columns above, and resolveXeroContactForSupplier
// in grv-sync.ts reads/writes them unconditionally, so a drifted tenant would hit the identical
// "no such column" failure there once a GRV push runs. Deliberately NOT included: the
// xero_v2_effect_outbox CHECK-constraint rebuild from migrations 46/49 (DROP/CREATE/INSERT/RENAME)
// — that swap isn't safely re-runnable on every startup the way a plain ALTER ADD COLUMN is, and
// belongs to the normal indexed migration path, not this repair layer.
export const XERO_V2_SETTINGS_SCHEMA_REPAIR = `
ALTER TABLE xero_sync_settings ADD COLUMN purchase_account_code TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN purchase_tax_type TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN purchase_exempt_tax_type TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN grv_sync_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE xero_sync_settings ADD COLUMN last_grv_sync_date TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN grv_sync_claimed_at TEXT;
ALTER TABLE xero_sync_settings ADD COLUMN cod_payment_account_code TEXT;
ALTER TABLE suppliers ADD COLUMN xero_contact_id TEXT;
ALTER TABLE suppliers ADD COLUMN xero_contact_synced_at TEXT;
`;

export const XERO_V2_SETTINGS_SCHEMA_REPAIR_ID = 'xero-v2-settings-columns-v1';
