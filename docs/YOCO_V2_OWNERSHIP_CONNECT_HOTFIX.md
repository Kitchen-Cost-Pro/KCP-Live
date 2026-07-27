# Yoco V2 Ownership Connect Hotfix

## Incident

`POST /api/workspaces/:workspaceId/yoco/connect` returned HTTP 502 with:

`YOCO_V2_OWNERSHIP_REQUIRES_EXPLICIT_MIGRATION:SALE_REPORTING,SALE_STOCK,REFUND_REPORTING,REFUND_STOCK`

The V2-only release had removed the retired Yoco sale and refund processors, but the connection flow still rejected workspaces whose historic ownership rows were marked `LEGACY`. This left those workspaces blocked even though no legacy writer remained available.

## Resolution

The manager-authorized Yoco Connect request is now the explicit one-way migration action.

Connection order:

1. Validate the Yoco API key through the V2 rate-gated client.
2. Verify that the key can be encrypted with the configured production secret.
3. Atomically migrate or initialize all four effect ownership rows to `V2`.
4. Activate sale reporting, sale stock, refund reporting and refund stock controls at one cutover timestamp.
5. Record append-only sale and refund cutover history for historic rows.
6. Create or reuse the live V2 webhook.
7. Save the connection and run the catalogue-only initial synchronization.

No legacy processor, webhook handler, sales writer, refund writer or rollback-to-legacy path was restored.

## Historical duplicate protection

The existing Yoco sales baseline remains unchanged. Initial connection still imports the catalogue only and does not import or deduct historical orders. Live V2 effect writers continue using deterministic effect and stock movement keys.

## Idempotency

The migration is safe to retry:

- Already-owned V2 effects are not migrated again.
- Cutover history IDs are deterministic and use `INSERT OR IGNORE`.
- Ownership and control changes run in one D1 batch.
- A failed API-key validation or encryption attempt cannot change ownership.

## Successful response additions

The connect response now includes:

- `ownershipCutoverAt`
- `ownershipMigrated`
- `ownershipChangedEffects`

For the first connection after this hotfix, `ownershipChangedEffects` should contain all four V2 effects for a workspace that still had historic ownership rows.
