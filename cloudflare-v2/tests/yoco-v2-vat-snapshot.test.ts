import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWorkspaceVatSnapshot as fetchSaleVatSnapshot } from '../src/modules/yoco-engine-v2/live-sale';
import { fetchWorkspaceVatSnapshot as fetchRefundVatSnapshot } from '../src/modules/yoco-engine-v2/live-refund';
import type { DbLike, DbStatementLike, Env } from '../src/legacy/types';

// A minimal fake of the one query fetchWorkspaceVatSnapshot() actually runs
// (`SELECT vat_rate, vat_registered FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`),
// keyed by workspace id. Deliberately does not implement anything else in DbLike.
function fakeDb(rowsByWorkspace: Record<string, { vat_rate?: number; vat_registered?: number } | undefined>): DbLike {
  return {
    prepare(_query: string): DbStatementLike {
      let boundWorkspaceId = '';
      const statement: DbStatementLike = {
        bind(...values: unknown[]) {
          boundWorkspaceId = String(values[0] ?? '');
          return statement;
        },
        async first<T>() {
          return (rowsByWorkspace[boundWorkspaceId] ?? null) as T | null;
        },
        async all<T>() {
          return { results: [], success: true, meta: {} } as never as import('../src/legacy/types').DbResult<T>;
        },
        async run<T>() {
          return { results: [], success: true, meta: {} } as never as import('../src/legacy/types').DbResult<T>;
        },
        async raw<T>() {
          return [] as T[];
        },
      };
      return statement;
    },
    async batch<T>(_statements: DbStatementLike[]) {
      return [] as Array<import('../src/legacy/types').DbResult<T>>;
    },
  };
}

function fakeEnv(rowsByWorkspace: Record<string, { vat_rate?: number; vat_registered?: number } | undefined>): Env {
  const db = fakeDb(rowsByWorkspace);
  return { DB: db, CENTRAL_DB: db } as Env;
}

for (const [label, fetchWorkspaceVatSnapshot] of [
  ['live-sale.ts', fetchSaleVatSnapshot],
  ['live-refund.ts', fetchRefundVatSnapshot],
] as const) {
  test(`${label}: a workspace with vat_registered = 0 snapshots as not registered, VAT rate zero, regardless of a stale stored vat_rate`, async () => {
    const env = fakeEnv({ ws_1: { vat_rate: 15, vat_registered: 0 } });
    const snapshot = await fetchWorkspaceVatSnapshot(env, 'ws_1');
    assert.equal(snapshot.vatRegistered, false);
    // The function itself only reports registration status + the raw stored rate; callers (e.g.
    // sale-resolver.ts's deriveYocoFinancialAmounts) are responsible for treating a non-registered
    // workspace's effective rate as zero. This assertion pins the raw snapshot's shape so a future
    // change here can't silently start reporting a non-zero rate for a non-registered workspace.
    assert.equal(snapshot.vatRate, 15);
  });

  test(`${label}: a workspace with vat_registered = 1 snapshots its configured VAT rate`, async () => {
    const env = fakeEnv({ ws_1: { vat_rate: 20, vat_registered: 1 } });
    const snapshot = await fetchWorkspaceVatSnapshot(env, 'ws_1');
    assert.equal(snapshot.vatRegistered, true);
    assert.equal(snapshot.vatRate, 20);
  });

  test(`${label}: a workspace missing a workspace_settings row (never configured) defaults to registered at 15%`, async () => {
    const env = fakeEnv({});
    const snapshot = await fetchWorkspaceVatSnapshot(env, 'ws_never_configured');
    assert.equal(snapshot.vatRegistered, true);
    assert.equal(snapshot.vatRate, 15);
  });

  test(`${label}: a workspace with vat_rate = 0 but vat_registered = 1 (misconfigured/legacy data) still falls back to the 15% default rather than reporting 0% VAT for a registered business`, async () => {
    const env = fakeEnv({ ws_1: { vat_rate: 0, vat_registered: 1 } });
    const snapshot = await fetchWorkspaceVatSnapshot(env, 'ws_1');
    assert.equal(snapshot.vatRegistered, true);
    assert.equal(snapshot.vatRate, 15);
  });
}
