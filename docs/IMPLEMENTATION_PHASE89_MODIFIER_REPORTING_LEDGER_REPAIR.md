# Phase 89 — Modifier Reporting Ledger Repair

## Scope

This phase repairs three reporting issues found during beta validation:

1. Linked menu items displayed duplicate records from both modifier-group assignments and product recipe mappings.
2. Valid V2 modifier movements were reported as `Missing Modifier Usage` because the reporting engine only understood legacy metadata fields and identifiers.
3. Sale dates were flagged for missing base UOM values even when the stock item or V2 movement metadata contained a valid UOM.

## Changes

### Linked menu items

- Modifier-group menu-item assignments are now the authoritative linked-item source.
- Product/recipe links are used only as a fallback when no menu-item assignments exist.
- Unknown assignment identifiers are ignored instead of being rendered as raw duplicate rows.

### Modifier usage resolution

- Reporting accepts both legacy camelCase and V2 snake_case movement metadata.
- Modifier movements can be matched through sale-time action snapshots, source modifier IDs, owner IDs, line IDs, source keys and rule IDs.
- Active modifier rules are loaded into the reporting catalogue so product, option and note modifiers use their configured stock action.
- `REMOVE_INGREDIENT` without a separate modifier ledger row reports `Applied to Base Recipe`.
- `NO_STOCK_CHANGE` reports `No Stock Mapping Required`.
- `Missing Modifier Usage` is now reserved for actions that should generate stock movement rows.

### Base UOM resolution

- Reports resolve the base UOM from the stock item first, then legacy or V2 movement metadata.
- Future V2 sale movements now write canonical reporting metadata in both reporting-friendly and existing snake_case fields.

## Verification

- Frontend tests: 475 passed.
- Worker tests: 66 passed.
- Worker TypeScript typecheck: passed.
- Frontend production build: passed.
- Cloudflare Worker dry deployment: passed.
