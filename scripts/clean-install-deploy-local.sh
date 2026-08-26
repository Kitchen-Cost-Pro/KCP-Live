#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

printf '%s\n' 'Cleaning dependency folders that can be damaged by cloud-sync symlink conversion...'
rm -rf node_modules cloudflare-v2/node_modules

printf '%s\n' 'Installing locked root dependencies...'
npm ci --no-audit --no-fund

printf '%s\n' 'Installing locked Worker dependencies...'
(
  cd cloudflare-v2
  npm ci --no-audit --no-fund
)

printf '%s\n' 'Running frontend tests and production build...'
npm test
npm run build

printf '%s\n' 'Running Worker type-check, V2 tests, dependency audit, and safety audit...'
(
  cd cloudflare-v2
  npm run typecheck
  npm test
  npm run audit:yoco-v2-admin-dependencies
  npm run audit:yoco-v2-phase12-safety
  npm run deploy:dry
  npm run deploy
)

printf '%s\n' 'Writing local frontend API URL...'
printf '%s\n' 'VITE_CLOUDFLARE_API_URL=https://kcp-api-v2.adminkitchencostpro.workers.dev' > .env

printf '%s\n' 'Stopping any existing local Vite process on port 5173...'
(lsof -ti tcp:5173 | xargs kill -9 2>/dev/null || true)

printf '%s\n' 'Starting KCP at http://localhost:5173 ...'
exec npm run dev -- --port 5173
