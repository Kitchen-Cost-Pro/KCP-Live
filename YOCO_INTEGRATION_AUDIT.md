# Yoco Webhook and Sales Deduction Audit

Date: 14 July 2026
Release: Phase 60 - Yoco Webhook Recovery and Diagnostics

## Scope audited

- Yoco API-key connection and connection-state storage
- Webhook subscription listing, deletion, creation, verification, testing, and signature validation
- Manual catalogue and sales resync flows
- Payment/order ingestion and recipe-based stock deductions
- Duplicate protection, retry handling, and sales cursors
- Admin-console visibility and recovery controls

## Confirmed root causes

1. **Webhook reset failures were hidden.** Catalogue or sales sync could report success after webhook reinitialisation failed, leaving the account dependent on polling without a healthy live subscription.
2. **Local webhook state was trusted without remote verification.** A stored subscription ID could look connected even when Yoco had disabled, deleted, or changed the remote subscription.
3. **Restart Sync did not perform a true webhook restart first.** It synchronised data but did not guarantee delete-then-resubscribe behavior.
4. **Unresolved sales were permanently deduplicated.** A product component could be marked processed even when no stock movement was created because its recipe or ingredient mapping was unavailable. Later resyncs then skipped it.
5. **Sales cursors could move beyond unresolved orders.** This made missed deductions harder to recover after mappings were corrected.
6. **Diagnostics only showed delivery events.** Subscription lifecycle, remote health, sync results, recipe warnings, stock-movement counts, and API errors were not available in one place.
7. **Signature verification had no replay-age limit.** Validly signed but stale deliveries were not rejected by timestamp freshness.

## Corrections implemented

### Webhook lifecycle

- Restart now lists Yoco subscriptions, deletes **KCP-owned subscriptions through Yoco's DELETE API**, creates a fresh subscription, and verifies the new subscription remotely.
- KCP-owned matching uses the stored subscription ID, the KCP callback URL, and the KCP subscription name. Unrelated subscriptions on the same Yoco account are left untouched.
- Connection and reset now fail clearly when subscription creation or verification fails rather than returning a false success.
- Normal sync performs a remote webhook health check. Missing, disabled, URL-mismatched, or event-mismatched subscriptions are repaired automatically.
- A previous webhook secret is retained for a 24-hour grace period during a successful rotation to avoid rejecting an in-flight delivery.
- The admin console includes a **Test Webhook** action.

### Sales deduction recovery

- A sale component is only terminally deduplicated after it creates a stock movement, or when a previous movement already proves that it was processed.
- Missing recipes, missing mappings, and zero-depletion recipes remain retryable.
- Sales resync uses a six-hour cursor overlap for safe reconciliation.
- Order and refund cursors do not advance past processing errors or retryable deductions.
- Yoco order-line writes use a stable business-key upsert to avoid duplicate order-line records while still allowing recovery.
- Retry processing now includes `attention` records and only clears an event when no errors or retryable deductions remain.

### Diagnostics

- Added a provider-neutral `integration_logs` table with operation, status, severity, message, correlation ID, duration, timestamp, and redacted detail data.
- The admin **Yoco Integration Log** combines webhook deliveries with lifecycle, sync, deduction, warning, and error records.
- Sales sync exposes orders and refunds fetched/processed/skipped, duplicates, retryable records, missing recipes, stock movements, order lines, cursor decisions, warnings, and errors.
- Secret, API-key, authorization, and token fields are recursively redacted before diagnostic details are stored or displayed.
- Webhook signatures now enforce a three-minute timestamp freshness window.

## Admin recovery workflow

After deployment:

1. Open the Admin Console and select the workspace.
2. Use **Restart Sync**.
3. Confirm the integration log shows, in order:
   - webhook reset started;
   - KCP subscription deletion succeeded;
   - fresh subscription creation and remote verification succeeded;
   - catalogue sync completed;
   - recent sales reconciliation completed.
4. Use **Test Webhook** and confirm a new delivery appears in the integration log.
5. Review any `attention` entries. Correct the listed menu/recipe mappings, then use **Resync Errored Orders**.
6. Confirm the reconciliation entry reports stock movements greater than zero for the affected orders and no remaining retryable records.

## Validation completed

- Root automated suite: **417 passed, 0 failed**
- Frontend production build: **passed**
- Cloudflare Worker TypeScript check: **passed**
- Wrangler Worker deploy dry run: **passed**

## Deployment note

The source release is repaired and validated, but no live Yoco account or production Cloudflare deployment was available during this audit. The current production subscription and missed sales will be repaired when this release is deployed and **Restart Sync** is run for the affected workspace.
