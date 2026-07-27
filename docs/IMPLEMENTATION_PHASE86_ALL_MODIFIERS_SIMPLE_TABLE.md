# Phase 86 — Complete Yoco Modifier Import and Simple Modifier Table

## Scope

Phase 86 corrects two gaps reported after Phase 85:

1. Menu Catalogue → Modifiers was more complex than the intended operational table.
2. Catalogue sync could retain only linked-product modifiers while missing add-on/option and note modifiers.

No database migration is required.

## Menu Catalogue → Modifiers

The modifier catalogue now uses five columns:

- Modifier Name
- Group
- Linked Items
- Stock Action
- Setup

The Linked Items column is a button showing the number of menu items assigned to the modifier group. The Stock Action column is a selector for:

- Add recipe
- Add stock item
- Remove ingredient
- Replace ingredient
- No stock change

Product, option/add-on, and structured Yoco note modifiers all use the same versioned modifier-rule setup drawer. The Suggestions from orders button remains on the same screen for free-text line-item notes observed in completed orders.

## Complete Yoco modifier catalogue import

The catalogue client now:

- Always enumerates the full modifier-group catalogue, even when assigned groups were already embedded in item data.
- Requests expanded modifier collections when the API revision supports them.
- Falls back to group detail requests when expansion is rejected.
- Supports detail URLs with and without trailing slashes.
- Probes modifier, option, item, entry, and choice child-resource aliases for groups whose detail payload has no embedded choices.
- Aggregates all modifier collections in a response instead of returning only the first matching array.
- Supports cursor, page-token, nested pagination, and next-link cursor formats.
- Prevents repeated-cursor pagination loops.
- Parses arrays and object maps.
- Recognises product/linked-product, option/add-on, and note/text collection keys.
- Preserves collection type when individual rows omit a `type` field.
- Handles nested modifier, option, choice, product-modifier, and note-modifier objects.
- Retains note-only/free-text groups that legitimately have no option array.
- Preserves cached modifier groups when Yoco enumeration is incomplete.

Sync results now report separate counts for product, option, and note modifiers.

## Note safety

Structured Yoco note modifiers have stable modifier identities and can therefore use normal versioned modifier rules.

Arbitrary free-text order notes remain separate:

- They are observed without changing stock.
- Suggestions appear after three distinct order-line observations.
- Matching remains exact after conservative normalization.
- Stock changes occur only after an exact note rule is approved.

## Validation

- Targeted Phase 85/86 frontend checks: 8/8 passed.
- Worker tests: 64/64 passed.
- Worker TypeScript check: passed.
- Vite production build: passed.
- Wrangler deployment dry-run: passed.
- Final Yoco V2 source audit: 26/26 passed.
- Full historical frontend suite: 463/469 passed.

The six remaining historical frontend failures are unchanged source-pattern assertions covering unrelated admin Durable Object routing, CORS wording, Yoco key controls, Gmail callback routing, low-stock notification wording, and refund-report identity wording.

## Deployment

Deploy both:

1. Cloudflare Worker
2. Frontend

Then run Integrations → Yoco → Sync Catalogue and verify the returned product, option, and note modifier counts before opening Menu Catalogue → Modifiers.
