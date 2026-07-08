#!/usr/bin/env bash
# Set Worker secrets on the NEW account from cloudflare-v2/.env §2.
# Skips any value still left as a <REPLACE...> placeholder or blank. Idempotent — re-run anytime.
# Usage:  bash scripts/set-secrets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Load deploy creds without sourcing the whole .env (placeholders contain shell metachars).
val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- ; }
export CLOUDFLARE_API_TOKEN="$(val CLOUDFLARE_API_TOKEN)"
export CLOUDFLARE_ACCOUNT_ID="$(val CLOUDFLARE_ACCOUNT_ID)"

SECRETS=(
  YOCO_KEY_ENCRYPTION_SECRET
  GMAIL_CLIENT_ID
  GMAIL_CLIENT_SECRET
  GMAIL_TOKEN_ENCRYPTION_SECRET
  GMAIL_OAUTH_STATE_SECRET
  GDRIVE_CLIENT_ID
  GDRIVE_CLIENT_SECRET
  GDRIVE_TOKEN_ENCRYPTION_SECRET
  GDRIVE_OAUTH_STATE_SECRET
  TURNSTILE_SECRET_KEY
  ADMIN_API_TOKEN
  GEMINI_API_KEY
  GROQ_API_KEY
)

for name in "${SECRETS[@]}"; do
  v="$(val "$name" || true)"
  if [ -z "$v" ] || [[ "$v" == \<*\> ]]; then
    echo "skip   $name (blank/placeholder)"
    continue
  fi
  printf '%s' "$v" | npx wrangler secret put "$name" >/dev/null 2>&1 \
    && echo "set    $name" \
    || echo "FAILED $name"
done
echo "Done. Verify with: npx wrangler secret list"
