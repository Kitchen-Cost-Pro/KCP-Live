# Yoco V2 Refund Resolution Hotfix 6

Release: `phase-v2-admin-yoco-engine-control-centre-hotfix-6`

## Incident summary

A live `payment.refunded` webhook was captured and published, but its V2 refund workflow remained at `WAITING_FOR_YOCO` and was displayed under the webhook message ID. The refund detail endpoint also returned HTTP 500.

Observed state:

- Event type: `payment.refunded`
- Capture status: `CAPTURED`
- Queue status: `PUBLISHED`
- Processing status: `RETRY_SCHEDULED`
- Attempts: 5
- Refund identity: webhook message ID
- Original order: missing
- Gross refund: zero
- Financial, inventory, and reporting: `WAITING_FOR_YOCO`

This is not a completed V2 refund. Legacy processing may still have completed the real refund effects because ownership remains `LEGACY`.

## Root causes

### 1. Flat payment-refunded webhook was not resolved to a refund resource

The Yoco API `payment.refunded` event contains a flat `order_id` and `payment_id`, but no refund ID. The resolver expected a nested refund object or explicit refund ID, so it used the webhook message ID as a provisional refund identity and could not fetch a canonical refund.

The webhook `order_id` identifies the refund order. The canonical refund resource must be found through the rate-gated Refunds API, then its `id`, `original_order_id`, `payment_id`, amounts, and status can be used.

### 2. Refund detail query used obsolete stock movement column names

The control-centre detail query selected `stock_movements.quantity` and `stock_movements.total_cost`. The deployed tenant schema uses:

- `quantity_delta`
- `value_delta`
- `occurred_at`

The invalid query caused the refund detail endpoint to return HTTP 500.

## Changes

### Refund resolution

- Parse top-level `event_type`, `order_id`, and `payment_id`.
- Treat `payment.refunded.order_id` as the refund-order reference.
- Query the rate-gated `GET /v1/refunds/` endpoint in a bounded time window.
- Match candidates using payment ID, refund-order ID, and original-order ID when available.
- Use the real Yoco refund ID as the canonical identity once found.
- Upgrade an existing provisional domain/workflow identity rather than creating duplicate active records.
- Preserve superseded historical placeholders for audit purposes while excluding them from the active refund list.
- Keep missing, eventually consistent refund resources retryable as `YOCO_V2_REFUND_LOOKUP_WAITING`.
- Keep all V2 refund processing shadow-only.

### Admin detail

- Read legacy refund movements from `quantity_delta AS quantity`.
- Read movement value from `value_delta AS total_cost`.
- Read movement time from `occurred_at AS created_at`.
- Apply the same schema correction to sale detail.

## Existing event recovery

Do not perform another refund.

After deployment, replay the existing `payment.refunded` event from Event Inbox. The replay is idempotent and shadow-only. If the event has reached Dead Letter, move that same event back to the queue instead.

Expected result after successful replay:

- Refund ID changes from the `msg_...` placeholder to the real Yoco refund ID.
- Original order is populated.
- Gross refund is non-zero.
- Financial status is resolved.
- Inventory is resolved or explicitly sent to Manual Review for amount-only allocation.
- The detail drawer opens successfully.
- No V2 stock or reporting write is created.

## Validation

- Worker TypeScript type-check passed.
- 121 Worker and Yoco V2 tests passed.
- 499 frontend/root tests passed.
- Production frontend build passed.
- Wrangler deployment dry run passed.
- Regression coverage added for:
  - flat `payment.refunded` webhook resolution;
  - eventual-consistency retry and later discovery;
  - provisional identity upgrade;
  - real refund-order versus original-order references;
  - no live stock movement creation;
  - refund detail against the deployed stock movement schema.

## Safety confirmation

- Legacy refund processing remains installed and active.
- Effect ownership remains `LEGACY`.
- V2 live sale reporting, sale stock, refund reporting, and refund stock flags remain `false`.
- Existing failed history is preserved.
- Replay remains idempotent.
- No secrets or authorization values are exposed.
