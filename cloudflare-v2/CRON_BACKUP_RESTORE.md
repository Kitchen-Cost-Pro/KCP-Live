# Cron triggers — backup & restore

**Status: DISABLED for testing as of 2026-08-20.**

`kcp-api-v2`'s cron triggers were cleared to `[]` in `wrangler.toml` to confirm whether they're the
cause of Durable Object reads/writes happening with zero real user activity (including overnight).
This doc is the full backup of what was removed, so it can be restored exactly — or restored with
fixes — once that's confirmed.

## What was live

```toml
[triggers]
crons = ["*/15 * * * *", "*/45 * * * *"]
```

Handler: `scheduled()` in `src/index.ts` (around line 1196). On every tick it pulls all
`status = 'active'` workspaces from `CENTRAL_DB` and fans out to each workspace's `WorkspaceDO`:

```js
const isCatalogueSyncTick = _event.cron === '*/45 * * * *';
ids.flatMap((id) => [
  callWorkspaceDO(env, id, 'admin-action/low-stock-due', ...),
  callWorkspaceDO(env, id, 'admin-action/report-schedules-due', ...),
  callWorkspaceDO(env, id, 'yoco-v2/reconciliation/scheduled', ...),
  isCatalogueSyncTick
    ? callWorkspaceDO(env, id, 'admin-action/catalogue-sync-due', ...)
    : Promise.resolve(null)
])
```

## What each task does, and how expensive it is

| Task | Cadence | Gating | Cost when nothing is "due" | Risk |
|---|---|---|---|---|
| `admin-action/low-stock-due` (`legacy/low-stock-email.ts:441`) | 15 min, all active workspaces | Checked against per-workspace dispatch time + frequency (`isSendWindow` / `isDue`) before touching recipients/stock tables | ~4 reads (workspace + settings + email-settings + last-run), no writes | Low — well gated |
| `admin-action/report-schedules-due` (`legacy/report-scheduling-routes.ts:756`) | 15 min, all active workspaces | `ensureReportSchedulingSchema()` runs every tick (schema check), then one SELECT for schedules whose `next_run_at <= now` | 1 schema check + 1 SELECT, no writes if nothing due | Low-medium — the schema-ensure call on every tick is unnecessary overhead but not a writer |
| `yoco-v2/reconciliation/scheduled` (`modules/yoco-engine-v2/reconciliation.ts:355`) | 15 min, all active workspaces | Gated hard: skips workspaces that haven't gone live, respects a paused flag and a failure backoff, only runs hourly/daily reconciliation when actually due. Comment in the code notes this was already patched once for a "write storm" bug (failed runs used to never record their attempt, so `dailyDue` stayed true forever and re-ran the full deep scan every 15 min) | 1-2 reads, no writes | Low — already hardened, but worth confirming the backoff/pause fields are being set correctly in production |
| `admin-action/catalogue-sync-due` (`legacy/routes.ts:15735`) | **45 min**, all workspaces with `connection_active = 1` | **Only checks whether Yoco is connected — no "anything changed" check at all.** Runs a full `syncYocoCatalogue()` (products, categories, modifiers) every single tick regardless of whether the catalogue changed | Full catalogue re-sync + re-upsert, unconditionally, every 45 min, for every connected workspace | **High — prime suspect for the bulk of the write volume.** No dedupe/etag/hash check before writing. |

## Known bug found during this investigation: overlapping schedules

`*/15 * * * *` and `*/45 * * * *` are two **independent** Cloudflare Cron Triggers. `*/45` fires at
minutes `:00` and `:45` of every hour — both of which are also `*/15` minutes. So at `:00` and
`:45`, Cloudflare fires **two separate `scheduled()` invocations** in the same minute, and
`low-stock-due`, `report-schedules-due`, and `yoco-v2/reconciliation/scheduled` each run **twice**
for every workspace during that minute. `catalogue-sync-due` is not affected (it's already gated to
only the `*/45` tick), but the other three effectively get an extra, redundant pass 2x/hour.
**Fix this before restoring** — see "Recommended fixes before restoring" below.

## Related, not part of this restore

`KCP-Live/cloudflare-v2/wrangler.toml` is a **separate, older, non-deployed copy** of this same
worker config (same `account_id`, same worker `name = "kcp-api-v2"`, same `CENTRAL_DB` id) that
still contains a different, since-removed cron fan-out (`workforce/admin/cleanup-idempotency`,
`send-shift-reminders`, `send-break-reminders`). It has no CI workflow and was not touched by this
change. Don't confuse the two — this repo (`KCP-Live-Development`, with `.github/workflows/deploy-worker.yml`
auto-deploying `cloudflare-v2/**` on push to `main`) is the one that's actually live.

## How to restore

1. In `cloudflare-v2/wrangler.toml`, replace:
   ```toml
   [triggers]
   crons = []
   ```
   with:
   ```toml
   [triggers]
   crons = ["*/15 * * * *", "*/45 * * * *"]
   ```
2. Deploy: push to `main` (triggers `deploy-worker.yml`) or run `wrangler deploy` manually from
   `cloudflare-v2/`.
3. Confirm in the Cloudflare dashboard (Workers → `kcp-api-v2` → Triggers) that both cron entries
   show as active.

## Recommended fixes before restoring (don't just restore as-is)

1. **`catalogue-sync-due`**: add a real "due" check — store a content hash/etag or `last_synced_at`
   per workspace and skip the upsert when nothing changed, instead of syncing unconditionally every
   45 min for every connected workspace.
2. **Overlap bug**: collapse to a single cron trigger (`*/15 * * * *`) and gate the 45-min-only work
   with a minute-based check inside `scheduled()` (e.g. `new Date().getUTCMinutes() % 45 === 0`)
   instead of registering two independent Cloudflare Cron Triggers that both fire at `:00`/`:45`.
3. **`report-schedules-due`**: move `ensureReportSchedulingSchema()` out of the per-tick, per-workspace
   hot path (cache a "schema ensured" flag on the DO instance) — same pattern as the `schemaVersion()`
   check in `workspace-do.ts`, which re-reads on every single DO fetch.
4. Consider filtering the initial `CENTRAL_DB` workspace list per task (e.g. only workspaces with an
   active Yoco connection for catalogue sync, only workspaces with report schedules configured for
   that task) instead of fanning every task out to every active workspace and letting each DO call
   self-filter after being woken.

Once 1–4 are done (or you've decided which to defer), restore step 1 above and redeploy.
