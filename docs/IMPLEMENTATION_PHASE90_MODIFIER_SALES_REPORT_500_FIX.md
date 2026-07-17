# Phase 90 — Modifier Sales Report 500 Fix

## Incident

Opening the Modifier Sales report returned HTTP 500 after Phase 89.

## Root cause

The Phase 89 report enrichment query filtered `modifier_rules` with `active = 1`. The current modifier-rule schema does not have an `active` column; active rules are represented by `status = 'active'`.

Because this optional enrichment query ran while the report was loading, the D1 SQL error prevented the entire Modifier Sales endpoint from returning.

## Fix

- Changed modifier-rule enrichment to use `status = 'active'`.
- Added schema capability checks before querying optional modifier reporting tables.
- The report now uses modifier-rule and sale-action snapshot enrichment only when all required columns exist.
- During a partially migrated tenant schema, the report falls back to sale and ledger metadata instead of returning HTTP 500.
- Added a regression test that fails if the modifier-rule query returns to the obsolete `active = 1` condition.

## Verification

- Frontend tests: 475 passed.
- Worker tests: 67 passed.
- Worker TypeScript typecheck: passed.
- Frontend production build: passed.
- Cloudflare Worker dry deployment: passed.
