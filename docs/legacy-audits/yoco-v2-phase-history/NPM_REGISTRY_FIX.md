# npm Registry Portability Fix

The Phase 12 Worker lockfile previously contained one environment-specific package URL for `tsx@4.23.1`:

`packages.applied-caas-gateway1.internal.api.openai.org`

That host is private to the build environment and is not reachable from normal developer or deployment machines. The lockfile now resolves the same package and integrity hash from the public npm registry:

`https://registry.npmjs.org/tsx/-/tsx-4.23.1.tgz`

Validation completed with a fresh npm cache:

- `npm ci --no-audit --no-fund --progress=false`
- `npm run typecheck`
- `npm run deploy:dry`

The KCP Assistant Groq endpoint is a runtime-only request made after a user submits a chat message. It is not called by `npm install`, TypeScript checking, Wrangler deployment, or Vite startup.
