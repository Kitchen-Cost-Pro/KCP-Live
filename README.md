# Kitchen Cost Pro (KCP Live)

Kitchen Cost Pro is a multi-location stock, purchasing, recipe-costing, manufacturing, sales-integration, and reporting platform for food-service businesses.

This repository is the clean Cloudflare production source. It does not require Firebase at runtime and it does not include the retired Firebase Functions, Firebase rules, phase notes, audit text files, patch files, or generated deployment state from earlier migration builds.

## Active stack

| Layer | Technology |
| --- | --- |
| Frontend | Vite, JavaScript ES modules, HTML, CSS |
| Hosting | Cloudflare Pages |
| API | Cloudflare Worker (`cloudflare-v2`) |
| Shared control plane | Cloudflare D1 (`CENTRAL_DB`) |
| Workspace data | One SQLite-backed Durable Object per workspace (`WorkspaceDO`) |
| Authentication | Worker-issued sessions stored and validated through the central data plane |
| Bot protection | Cloudflare Turnstile |
| Reporting/export | Chart.js, ExcelJS/XLSX, jsPDF, jsPDF-AutoTable |
| POS integration | Yoco API and webhooks |

The frontend must call the Worker API. It must not access D1 or Durable Object storage directly.

## Repository layout

```text
.
├── src/                    Frontend application and reporting module
├── public/                 Static assets, Pages routing, and admin console shell
├── cloudflare-v2/          Active Cloudflare Worker API
│   ├── migrations/         Central D1 migrations
│   ├── src/index.ts        Front Worker and central routing
│   ├── src/workspace-do.ts Per-workspace Durable Object
│   └── src/legacy/         Ported route handlers still used by the active Worker
├── scripts/                Build and local cleanup helpers
├── CONTEXT.md              Product, data, and engineering rules
├── package.json            Frontend commands
└── vite.config.js          Vite configuration
```

`cloudflare-v2/src/legacy/` is an active compatibility layer containing the ported application routes. The directory name describes their origin, not their deployment status. Do not remove it unless the routes have first been migrated and replaced.

## Requirements

- Node.js with npm
- A Cloudflare account with Workers, Pages, D1, Durable Objects, and Turnstile enabled
- Access to the configured KCP Cloudflare resources

Use the committed lockfiles and `npm ci` for reproducible installs.

## Local setup

Install both packages:

```bash
npm ci
npm --prefix cloudflare-v2 ci
```

Create the frontend environment file:

```bash
cp .env.example .env
```

For a completely local stack, set:

```dotenv
VITE_CLOUDFLARE_API_URL=http://127.0.0.1:8787
```

To run the frontend against the deployed API instead, set the deployed Worker URL.

Create local Worker secrets:

```bash
cp cloudflare-v2/.dev.vars.example cloudflare-v2/.dev.vars
```

Never commit `.env`, `.dev.vars`, API keys, OAuth client secrets, encryption secrets, or session tokens.

### Start the Worker

For a new local D1 database, apply the central migrations first:

```bash
cd cloudflare-v2
npx wrangler d1 migrations apply kcp_central --local
npm run dev
```

The Worker normally runs at `http://127.0.0.1:8787`.

Workspace Durable Object databases migrate automatically when their `WorkspaceDO` instance starts.

### Start the frontend

In a second terminal:

```bash
npm run dev
```

The Vite development server normally runs at `http://localhost:5173`.

## Validation

Run the full release check:

```bash
npm run check:hardening
```

That command runs:

1. Frontend and reporting tests
2. Production frontend build
3. Worker TypeScript validation
4. Wrangler deployment dry run

Individual commands:

```bash
npm test
npm run build
npm --prefix cloudflare-v2 run typecheck
npm --prefix cloudflare-v2 run deploy:dry
```

## Deployment

Deploy the API before the Pages frontend so both use the same request and reporting contracts.

### 1. Apply central D1 migrations

Back up production data before schema changes, then run from `cloudflare-v2`:

```bash
npx wrangler d1 migrations apply kcp_central --remote
```

### 2. Deploy the Worker

```bash
npm --prefix cloudflare-v2 run deploy
```

### 3. Build and deploy Pages

```bash
npm run build
```

Deploy `dist/` through the configured Cloudflare Pages project or CI pipeline.

## Configuration

### Frontend variable

| Variable | Purpose |
| --- | --- |
| `VITE_CLOUDFLARE_API_URL` | Base URL of the KCP Worker API |

### Worker bindings

Configured in `cloudflare-v2/wrangler.toml`:

| Binding | Purpose |
| --- | --- |
| `CENTRAL_DB` | Shared D1 database for identities, sessions, workspaces, memberships, admin data, and cross-workspace coordination |
| `WORKSPACE` | Durable Object namespace; one SQLite database is addressed by workspace ID |

### Worker secrets

Set production secrets with `wrangler secret put`. Depending on enabled features, the Worker can use:

- `TURNSTILE_SECRET_KEY`
- `YOCO_KEY_ENCRYPTION_SECRET`
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_TOKEN_ENCRYPTION_SECRET`
- `GMAIL_OAUTH_STATE_SECRET`
- `GDRIVE_CLIENT_ID`
- `GDRIVE_CLIENT_SECRET`
- `GDRIVE_TOKEN_ENCRYPTION_SECRET`
- `GDRIVE_OAUTH_STATE_SECRET`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `GROQ_API_KEY`
- `ADMIN_API_TOKEN` only while the temporary bridge remains enabled

List configured secrets without exposing their values:

```bash
cd cloudflare-v2
npx wrangler secret list
```

## Runtime architecture

```text
Browser
  -> Cloudflare Pages
  -> Cloudflare Worker
       -> CENTRAL_DB (shared identity and registry data)
       -> WorkspaceDO(workspaceId)
            -> isolated SQLite tenant data
       -> Yoco / Gmail / Drive / email providers where configured
```

The front Worker handles central authentication, admin routes, security configuration, webhooks, workspace resolution, and authorization. Authenticated workspace requests are forwarded to the correct `WorkspaceDO` with a server-resolved identity. The Durable Object executes the tenant routes against that workspace's isolated SQLite database.

## Release hygiene

The repository should remain source-only:

- Do not commit `node_modules/`, `dist/`, `.wrangler/`, coverage output, secrets, ZIP files, phase notes, validation dumps, generated patches, or scratch scripts.
- Keep long-lived project guidance in `README.md` and `CONTEXT.md` only.
- Run `scripts/reset-deploy-state.sh` before packaging a source release.

See [CONTEXT.md](./CONTEXT.md) before changing stock, costing, locations, reporting, permissions, integrations, or tenant routing.
