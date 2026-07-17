# Yoco V2 architecture and operations

## Production flow

1. The external webhook reaches the single V2 ingress.
2. Signature verification occurs before business processing.
3. The raw event is stored with a deterministic identity.
4. Queue processing resolves a canonical sale or refund event.
5. Deterministic proposals are built for reporting and stock effects.
6. Reporting records are written to canonical Yoco reporting tables.
7. Inventory effects are written to `stock_movements`.
8. Reconciliation discovers missing activity and reuses the same idempotent processors.
9. The admin control centre reads structured V2 event, run, outbox, failure, and reconciliation data.

## Ownership

The four effect types are `SALE_REPORTING`, `SALE_STOCK`, `REFUND_REPORTING`, and `REFUND_STOCK`. Every active Yoco workspace must have enabled V2 ownership for all four. Existing incomplete or non-V2 ownership fails closed with `YOCO_V2_OWNERSHIP_REQUIRES_EXPLICIT_MIGRATION`. The final runtime has no code path that assigns authority back to LEGACY.

## Yoco API access

All remote requests use the V2 API client and per-integration rate gate. The client records requests, deduplicates eligible work, honours `Retry-After`, and supports controlled retries. Production source code must not call `https://api.yoco.com` directly outside the approved V2 API client.

## Refund separation

Financial and inventory completion are independent. An amount-only or unresolved refund can complete financial reporting while stock remains in manual review. Stock is returned only for resolved or manually approved quantities. Cumulative return-capacity checks prevent stock returns from exceeding the original sale deductions.

## Reconciliation

Reconciliation is a recovery path, not an alternative business engine. It creates or enriches canonical events and invokes the same reporting and stock effect writers used by queue processing. Database uniqueness and deterministic effect keys provide idempotency across webhook delivery, queue retries, admin replay, and reconciliation repair.

## Deployment gate

Run the source/build validation suite and then export production runtime evidence using the format in `RUNTIME_READINESS_EVIDENCE.md`. Do not accept deployment while any active workspace lacks V2 ownership, any legacy execution counter is non-zero, or any critical unresolved V2 failure remains.
