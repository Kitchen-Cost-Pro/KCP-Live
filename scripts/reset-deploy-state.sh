#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

chmod -R u+rwX "$ROOT"
rm -rf \
  "$ROOT/node_modules" \
  "$ROOT/dist" \
  "$ROOT/.wrangler" \
  "$ROOT/cloudflare-v2/node_modules" \
  "$ROOT/cloudflare-v2/.wrangler"

printf '%s\n' 'Local generated state removed. Source files remain intact.'
