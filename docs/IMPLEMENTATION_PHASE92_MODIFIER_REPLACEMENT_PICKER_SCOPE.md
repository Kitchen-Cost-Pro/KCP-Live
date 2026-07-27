# Phase 92 — Modifier Replacement Picker and Scope Fix

## Problem

Saving a `REPLACE_INGREDIENT` rule could fail with an error such as:

> Cappuccino - CAP001 does not contain the ingredient selected for this modifier action.

The rule editor also used native stock selectors, exposed an unnecessary location scope, and only supported an implicit one-for-one replacement quantity.

## Root cause

The save validator treated an “apply to all matching products” rule as though every currently linked menu item had to contain the selected source ingredient. This blocked valid rules whenever a modifier was shared by products with different recipes.

The runtime also needed an explicit policy for a matched sale whose base recipe does not contain the source ingredient.

## Changes

### Safe menu-item scope

- Explicitly selected menu-item scopes remain strict: every selected item must contain the source ingredient.
- “Apply to all matching products” rules may be saved even when only some linked products contain the ingredient.
- At sale time, a replacement or removal rule safely does nothing for a menu item that does not contain the source ingredient.
- No false warning or artificial stock movement is produced for skipped products.

### Custom stock pickers

Native stock/recipe dropdowns were replaced with KCP buttons that open a custom searchable picker modal for:

- Recipe to add
- Stock item to add
- Base-recipe ingredient to remove or replace
- Replacement stock item

The replacement picker only offers compatible base-UOM items.

### Replacement quantity

- The default replacement amount is the same base-UOM quantity as the removed ingredient.
- The user may enter a larger or smaller amount.
- When linked recipes use one consistent source quantity, the editor displays an absolute replacement quantity and UOM.
- When linked recipes contain different source quantities, the editor displays a multiplier.
- Runtime calculation is `removed base quantity × configured replacement ratio`.

Examples:

- `1` = replace with the same quantity
- `1.25` = replace with 25% more
- `0.5` = replace with half the quantity

### Location behaviour

- The modifier stock-rule location picker was removed.
- New and edited modifier stock rules always apply to all locations.
- Saved payloads normalize `locationIds` to an empty all-location scope.

### Other actions

The action editor was hardened so switching between `ADD_RECIPE`, `ADD_STOCK_ITEM`, `REMOVE_INGREDIENT`, `REPLACE_INGREDIENT`, and `NO_STOCK_CHANGE` clears incompatible stale fields and applies safe defaults.

## Release marker

Worker health release marker:

`phase92-modifier-replacement-picker-and-scope-fix`

## Validation

- Frontend tests: 475 passed
- Worker tests: 70 passed
- Worker TypeScript typecheck: passed
- Frontend production build: passed
- Cloudflare Worker deployment dry run: passed
