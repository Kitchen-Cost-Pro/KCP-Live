# Remaining Legacy Admin Dependencies

The following dependencies intentionally remain because legacy processing is still the active owner during observation/shadow mode.

## Legacy admin UI

- `public/KCP Admin ConsoleByYOCO.html`
- Legacy workspace selector and status cards
- Legacy connection, resync, webhook reset, credential rotation, retry, and recovery controls
- Legacy integration queue snapshot and free-text operational log
- Legacy Worker release/status verification

## Legacy front Worker routes

- `/api/admin/workspaces/:workspaceId/yoco/status`
- existing legacy Yoco admin action routes under `/api/admin/workspaces/:workspaceId/yoco/*`
- legacy central admin audit event writes for those actions

## Legacy webhook and processor paths

- legacy webhook signature verification and dispatch
- legacy webhook subscriptions
- legacy order import and synchronization
- legacy retry/recovery workflows
- legacy stock deduction and stock return processing
- legacy sale/refund reporting writes

## Legacy data used for shadow comparison

The V2 shadow engine deliberately reads legacy outcomes for comparison:

- `yoco_orders`
- `yoco_order_lines`
- `stock_movements`
- legacy reporting records and integration state
- legacy location and mapping data

These reads are comparison inputs. The new control centre does not change their write logic.

## Shared transition controls

- `integration_effect_ownership`
- existing Phase 10 sale cutover tables and readiness evidence
- existing Phase 11 refund cutover tables and readiness evidence
- existing Phase 12 legacy shutdown observation registry

The new control centre shows ownership but does not mutate it.

## Removal gate

Do not remove a legacy dependency until a separately authorized controlled-cutover and shutdown release confirms:

1. all four effects are owned by V2,
2. V2 consumers are active and healthy,
3. reconciliation is clean,
4. observation is approved,
5. rollback evidence exists,
6. exact removal confirmation is recorded.
