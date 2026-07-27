# Yoco V2 Sale Shadow Observation Hotfix 4

Release: `phase-v2-admin-yoco-engine-control-centre-hotfix-4`

## Problem

A legacy Yoco sale could deduct stock successfully without appearing in the Yoco V2 Event Inbox or Sales Shadow views.

The V2 capture fan-out existed only at verified webhook ingress. Legacy sale processing can also be reached through recovery, sync, and retry paths. Those paths called `processYocoOrder` directly and did not publish a V2 shadow event. Webhook capture also occurred before the legacy stock/reporting transaction completed, so a fast V2 queue consumer could compare against incomplete legacy effects.

## Fix

Added a post-commit observation bridge at the successful legacy sale processing boundary.

After legacy reporting and stock writes have committed, the bridge:

1. Creates a deterministic internal event ID: `kcp-legacy-sale-committed:<order-id>`.
2. Stores a structured `order.completed` V2 raw event containing the source order and a sanitized legacy outcome summary.
3. Publishes one identifier-only V2 queue message.
4. Forces `live_effects: false`.
5. Appends `LEGACY_SALE_EFFECTS_COMMITTED` to the processing timeline.
6. Uses deterministic event identity so repeated legacy sync/retry calls cannot duplicate queue work.

## Safety

- Legacy remains the owner of sale reporting and sale stock effects.
- No V2 live flag is changed.
- No effect ownership is changed.
- No legacy sale, stock, reporting, mapping, or recipe calculation is changed.
- Observation failure is isolated and cannot roll back or block a committed legacy sale.
- The existing verified-webhook capture remains installed.

## Expected test result after deployment

For a completed sale, the V2 control centre should show:

- Event Inbox event ID `kcp-legacy-sale-committed:<order-id>`
- Queue status `PUBLISHED`
- Processing status `COMPLETED`, `WAITING`, or `RETRY_SCHEDULED` with structured detail
- Timeline step `LEGACY_SALE_EFFECTS_COMMITTED`
- Sales Shadow canonical sale
- V2 proposed ingredient movements
- Legacy stock movement count
- Financial and stock comparison status

The real stock deduction must still be created only by the legacy engine.

## Validation

- Worker type-check passed.
- 116 Worker/V2 tests passed.
- 499 frontend tests passed.
- Production frontend build passed.
- Wrangler deployment dry run passed.
- Wrangler confirms all observation/shadow flags are `all`.
- Wrangler confirms all V2 live-effect and legacy-shutdown flags remain `false`.
