# Production Readiness Checklist

Last updated: 2026-05-27

## Purpose

This checklist tracks remaining work required to make `KCP-LIVE-CONVERTED` safe, supportable, and trustworthy for customer-facing production use.

Current overall status: `Late Beta / Production Hardening`

Why:

- The app is live on Cloudflare Pages and usable.
- Core operational modules are implemented.
- Yoco integration, reporting, dashboard summaries, and direct user creation are active.
- Final production confidence still depends on auth hardening, Worker/D1 migration completion, and automated data-integrity checks.

## Status Legend

- `TODO` - not started or not verified
- `IN PROGRESS` - partially implemented, needs completion or verification
- `DONE` - implemented and verified enough for current scope
- `BLOCKED` - waiting on external decision, credentials, or platform state

---

## P0 - Must Be Done Before Broad Customer Rollout

### 1. Worker Auth And Admin Session Hardening

- Priority: `P0`
- Status: `IN PROGRESS`
- Remaining:
  - Replace pasted admin API token bootstrap with Worker-issued admin session bootstrap.
  - Move admin authorization checks fully into Worker/D1 session flow.
  - Complete post-Firebase auth direction and document final login/session model.
- Touchpoints:
  - [cloudflare/src/admin-routes.ts](../cloudflare/src/admin-routes.ts)
  - [public/KCP Admin ConsoleByYOCO.html](./public/KCP%20Admin%20ConsoleByYOCO.html)

### 2. Worker/D1 Data Migration Completion

- Priority: `P0`
- Status: `IN PROGRESS`
- Why it matters:
  - The product still contains migration-era assumptions and some older module paths.
- Required:
  - Finish moving remaining modules to Worker/D1 reads and writes.
  - Remove or retire any remaining legacy direct Firebase operational flows.
  - Verify each major tab reads from the Worker-backed model without fallback duplication.
- Touchpoints:
  - [ARCHITECTURE.md](./ARCHITECTURE.md)
  - [agent.md](./agent.md)

### 3. Dashboard Source of Truth and Accounting

- Priority: `P0`
- Status: `IN PROGRESS`
- Progress:
  - Dashboard summary functions exist.
  - Period logic now follows:
    - Opening Stock = period start value
    - Closing Stock = period end value
    - Activity values sum over the period
    - Theoretical Consumption = Opening Stock + Purchases - Closing Stock
  - `sessionOpeningStock` is no longer blindly trusted when it does not reconcile.
- Remaining:
  - Add regression tests around period calculations.
  - Add integrity comparison between raw movement logs and dashboard summaries.
- Touchpoints:
  - [functions/dashboardSummary.js](./functions/dashboardSummary.js)
  - [src/services/database.js](./src/services/database.js)

### 4. Yoco Integration Integrity

- Priority: `P0`
- Status: `IN PROGRESS`
- Progress:
  - API key stored server-side only.
  - Yoco catalogue, categories, brands, locations, orders, refunds, webhook, and scheduled sync paths exist.
  - Variants import as separate menu items.
  - Sales/refunds are designed to affect stock by location and dedupe via signatures.
- Remaining:
  - End-to-end test real sale and refund through webhook and scheduled sync.
  - Verify recipe deduction per variant and per location across reports.
  - Add operational alerting for webhook failures.
- Touchpoints:
  - [functions/yoco](./functions/yoco)
  - [src/services/integrationService.js](./src/services/integrationService.js)

### 5. Functions Reconciliation

- Priority: `P0`
- Status: `BLOCKED`
- Why it matters:
  - The live Firebase project contains remote/stale functions not fully represented in this repo.
  - Broad deploys can prompt deletion or fail in non-interactive mode.
- Current known friction:
  - `liveconverted:onMenuUpdate(us-central1)` exists remotely but is not part of current local source/region.
- Required:
  - Inventory remote functions.
  - Decide which to preserve, import, or retire.
  - Document final deploy process.
- Touchpoints:
  - [functions/index.js](./functions/index.js)
  - [agent.md](./agent.md)

---

## P1 - Needed for Strong Customer Confidence

### 6. User and Registration Flow Verification

- Priority: `P1`
- Status: `IN PROGRESS`
- Progress:
  - Public registration creates pending signup requests.
  - Admin console approval path exists.
  - Normal Add Employee uses `addWorkspaceUser` and no longer creates invitations.
- Remaining:
  - Verify welcome/password email behavior end-to-end.
  - Decide long-term hosting/deployment path for `public/KCP Admin ConsoleByYOCO.html`.

### 7. Data Integrity Test Coverage

- Priority: `P1`
- Status: `TODO`
- Required tests:
  - GRV stock increment
  - credit note reversal
  - transfer source/destination movement
  - manual adjustment including override-to-zero
  - stocktake variance
  - manufacturing batch output/depletion
  - Yoco sale/refund stock movement
  - dashboard opening/closing/consumption calculations

### 8. Reporting Export Coverage

- Priority: `P1`
- Status: `IN PROGRESS`
- Progress:
  - Reporting UI and pagination are implemented.
  - Export utilities exist.
- Remaining:
  - Verify every report exports PDF/CSV/XLSX as expected.
  - Verify newest-to-oldest ordering.
  - Verify live data source for every report.

### 9. Performance and Scale

- Priority: `P1`
- Status: `IN PROGRESS`
- Progress:
  - Dashboard summaries reduce client-side load.
- Remaining:
  - Benchmark with high-volume logs.
  - Split large Vite chunks or lazy-load heavy report/export libraries.
  - Confirm dashboard first paint under realistic customer data.

---

## P2 - Recommended Hardening

### 10. Audit and Recovery Tooling

- Priority: `P2`
- Status: `TODO`
- Required:
  - Dashboard summary rebuild/repair runbook.
  - Movement log to stock balance reconciliation report.
  - Backup/recovery guidance for RTDB.

### 11. Dependency Hygiene

- Priority: `P2`
- Status: `TODO`
- Required:
  - Upgrade `firebase-functions` carefully.
  - Retest function deployment after upgrade.
  - Review bundle size and code splitting.

### 12. Documentation and Runbooks

- Priority: `P2`
- Status: `IN PROGRESS`
- Progress:
  - README and context files refreshed.
  - Architecture and handoff docs refreshed.
- Remaining:
  - Add customer-support triage runbook for stock discrepancies.
  - Add Yoco failure/retry runbook.
  - Add admin approval runbook.
