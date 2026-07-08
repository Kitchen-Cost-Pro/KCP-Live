# KCP Live Converted

Current Kitchen Cost Pro web app during the Cloudflare migration.

## Active Environment

- Hosting: Cloudflare Pages
- API: Cloudflare Workers
- Database: Cloudflare D1
- Auth: temporary Firebase Auth bridge while auth migration is pending

## Run Locally

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Worker / App Build Check

```bash
npm run build
```

## Deploy

Pages deploy is handled from the Cloudflare toolchain in the project workspace.

## Current Architecture

- Cloudflare Pages serves the frontend.
- Cloudflare Workers handle admin routes, Yoco routes, and privileged/server-owned workflows.
- Cloudflare D1 is the active operational database target.
- Firebase Auth remains temporary and should not expand into new data dependencies.

## Target Migration Direction

- Frontend: Cloudflare Pages.
- API/webhooks: Cloudflare Workers.
- Database: Cloudflare D1.
- Files/backups later: optional Cloudflare R2.
- Auth: Worker-backed session flow, with Firebase Auth only as a temporary bridge.

New work should be Worker/D1-native and should avoid introducing any new Firebase operational coupling.

## Current Product Rules

- Registration creates pending signup requests.
- Admin approval is handled in the admin console hosted at `/admin/`.
- Normal Add Employee creates/links users directly and does not create invitations.
- Google login users without an active workspace enter the same approval request flow with name/email prefilled and workspace name entered by the user.
- Yoco webhooks handle live sales/refunds.
- Yoco scheduled sync is a catch-up layer on top of webhooks.
- One workspace profile represents one business site/profile.
- `locations` are selling locations inside that profile, not nested stock rooms under sites.
- A permanent default Main Store/default location must exist, cannot be deleted, and is the fallback for imports/receiving.
- Selling locations can optionally override supplier-facing site/tax/legal details; storage locations remain stock-focused by default.
- Workspace/company tax information is the default legal/tax source for supplier-facing documents.
- Yoco locations import into selling locations and should update/match rather than duplicate.
- Smart stock routing uses internal stock item categories and `locations/{locationId}/stockRouting`, not Yoco menu categories.
- Stock and menu records support global/default pricing plus `locationPrices[locationId]` overrides.
- GRVs can split received quantities across selling locations.
- GRV and credit-note draft flows use inline quantity, pack-size, UOM, and location editing.
- Stock items support up to three custom UOM configurations with ratios back to the base inventory UOM and optional per-UOM barcodes.
- POS menu items can link to non-stock/virtual recipe-source stock items for recipe completion and costing; modifiers do not count for parent recipe completion.
- Supplier-facing PO PDFs exclude pricing, internal status, and "supplier-facing copy" labels while using company/location legal and delivery details where captured.
- Stock exports/templates must preserve item + location granularity.
- Import templates are client-friendly, UOM-aware, and should show loading while processing.
- Custom report Save closes the builder and adds/updates the saved report dashboard. Save & Preview saves and opens read-only preview.
- Custom report builder save controls use real form submit buttons handled at document capture level.
- Low-stock summary emails are scheduled per workspace and sent to tagged members.
- Destructive reset actions require exact typed confirmation.
- Dashboard period logic uses opening/closing anchors and summed activity.
- The admin page currently prompts for an admin API token as a temporary bridge. Replace this with Worker-issued admin sessions/cookies as the next auth milestone.

See:

- [agent.md](./agent.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md)
- [Yoco Integration.md](./Yoco%20Integration.md)
- [../Context/docs/cloudflare-d1-data-migration-audit.md](../Context/docs/cloudflare-d1-data-migration-audit.md)
