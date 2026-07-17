# Phase 83 — Modifier Core Actions and Sale Mapping

## Outcome

Modifier selections from completed Yoco sales now resolve to the modifier recipe/rule engine before the V2 live-sale gate. The resolver accepts stable provider IDs, assignment/group IDs, product-variant aliases, stored recipe aliases and an ambiguity-safe unique-name fallback. Product-linked and option modifiers are both retained during catalogue sync; free-text/note rules stay outside stock setup.

## Core actions

The modifier rule engine supports:

- `ADD_RECIPE` — expands and deducts an existing product, stock-item or modifier recipe.
- `ADD_STOCK_ITEM` — deducts a stock item in its base UOM or a validated custom UOM.
- `REMOVE_INGREDIENT` — removes the expanded base ingredient from final theoretical usage without creating a positive reversal.
- `REPLACE_INGREDIENT` — removes the original ingredient and deducts the same base-UOM quantity of a compatible replacement.
- `NO_STOCK_CHANGE` — explicitly resolves the modifier without creating an extra stock effect.

## Scope and validation

Rules support selected menu items, all matching products, selected locations and all locations. Remove/replace rules validate the fully expanded recipe, including sub-recipes. Global rules validate every menu item assigned to the modifier group. Invalid menu targets, missing entities, incompatible replacement UOMs and invalid custom UOM conversions are rejected before existing recipe lines are replaced.

At runtime, scoped-out rules fail closed as `NO_STOCK_CHANGE`. A stale invalid replacement rule leaves the original deduction intact and records a warning rather than removing both ingredients.

## Persistence

Tenant migration 29 creates:

- `modifier_rules`
- `modifier_rule_versions`
- `modifier_observations`

Existing active modifier recipes migrate to active, versioned `ADD_RECIPE` rules. Sale observations are idempotent even when the provider payload has no variant ID.

## UI

The modifier recipe editor now includes a stock-action panel and setup drawer headed:

> What should happen to stock when this is selected?

The drawer includes action selection, quantity, recipe/stock targets, original and replacement ingredients, menu-item scope, location scope, “Apply to all matching products”, validation and a plain-language preview.

## Verification

- Frontend tests: 461 passing.
- Worker tests: 57 passing.
- Worker TypeScript check: passing.
- Production frontend build: passing.
- Worker dry-run deployment: passing.
