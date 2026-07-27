# Controls Intentionally Disabled Until Controlled Cutover

The current repository contains Phase 10 and Phase 11 engine foundations, but this admin rewire is explicitly observation/shadow-only. Their live controls are therefore not exposed or enabled by this release.

## Disabled live effect controls

- Enable V2 sale reporting writes
- Enable V2 sale stock writes
- Enable V2 refund reporting writes
- Enable V2 refund stock writes

The Configuration API always presents these as read-only false for this control centre.

## Disabled ownership controls

- Switch `SALE_REPORTING` ownership from LEGACY to V2
- Switch `SALE_STOCK` ownership from LEGACY to V2
- Switch `REFUND_REPORTING` ownership from LEGACY to V2
- Switch `REFUND_STOCK` ownership from LEGACY to V2

## Disabled cutover operations

- Activate sale controlled cutover
- Activate refund controlled cutover
- Resume or pause a live V2 effect from the new control centre
- Roll back ownership from the new control centre
- Approve cutover readiness from the new control centre
- Trigger legacy shutdown or Phase 13 deletion

`yoco_v2.cutover` exists as a permission, but `usable` is always false in this release.

## Enabled safe controls

The following remain available because they are shadow-only and idempotent:

- replay eligible V2 processing
- requeue eligible dead-letter or failed publication events
- refetch source resources for shadow resolution
- re-run resolver
- rebuild shadow proposal
- re-run comparison
- run bounded reconciliation
- send a finding/event to manual review
- approve a validated refund line allocation and rebuild its shadow proposal

Every enabled action requires permission, confirmation, workspace scope, audit, and an idempotency key.
