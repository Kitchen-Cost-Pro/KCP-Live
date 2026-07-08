# KCP v2 — per-workspace Durable Objects (SQLite) worker

**Isolated rebuild for a BRAND-NEW Cloudflare account.** The live worker in `../cloudflare/` (account
`kcp-api`) is untouched and must stay running. This project has **no `account_id`** and placeholder
database ids in `wrangler.toml`, so `wrangler deploy` will refuse to run until it is pointed at the
new account — it can never overwrite the current deployment.

## Architecture
- **Front Worker** (`src/index.ts`) — CORS, health, auth against the **central D1** (`CENTRAL_DB`:
  users/sessions/members/registry/coordination), resolves `workspaceId` from
  `/api/workspaces/:id/...`, then forwards the request to that workspace's Durable Object.
- **`WorkspaceDO`** (`src/workspace-do.ts`) — one SQLite database **per workspace**
  (`idFromName(workspaceId)`). Self-migrates its schema on first access. Runs the tenant route
  handlers with `env.DB` = a **D1-compatible facade** (`src/d1-facade.ts`) over its own SQLite, so
  existing `env.DB.prepare(...)` code runs almost unchanged.

## Why DO SQLite (not D1-per-tenant)
- D1 free plan caps at 10 databases; D1 can't be bound dynamically at runtime.
- SQLite DOs are on the Workers Free plan, runtime-dynamic (no redeploy per client), 10 GB each on
  paid, ~5 TB aggregate. Free for 5 users; ~$20–60/mo for 500.

## Status
Phase 1 (foundation) — facade + DO + front router + central schema, proven with a sample domain
slice. Remaining phases (port all domains, external-transfer/org-report re-architecture, data
migration tool) tracked in `../.claude/plans/`.

## Local dev / deploy
- `npm install`
- `npm run typecheck`
- `npm run dev` — local only (`wrangler dev`), does not touch any account.
- Deploy ONLY after creating the new account and setting `account_id` + real `database_id`.
