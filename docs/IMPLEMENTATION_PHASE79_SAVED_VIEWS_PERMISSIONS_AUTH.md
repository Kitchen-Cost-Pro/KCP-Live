# Phase 79 - Saved Views, Permissions, Location Scope, and Auth Status Fix

## Fixed

- Saved report views now auto-load when marked as the default.
- Defaults are scoped to the exact canonical report instead of every report in the same group.
- Grouped reports preserve saved-view filters, sort, columns, and active saved-view state.
- Scheduled reports execute from the stored saved-view snapshot and preserve array filters.
- Schedule location selection replaces all legacy location filter aliases to prevent conflicting filters.
- Built-in role overrides are returned by access management instead of being discarded after save.
- Explicit empty role-location selections remain empty rather than becoming `all`.
- Member location assignments can be replaced or cleared reliably.
- Managers now respect assigned location scope; owners, admins, and KCP superusers remain unrestricted.
- Authenticated permission failures return HTTP 403 instead of being misreported as HTTP 401.
- Dashboard low-stock email reads delivery settings from the central database and upserts workspace result state.
- Dashboard low-stock email returns explicit 403/502 responses instead of an unhandled 500.

## Verification

- Frontend tests: 443 passed.
- Frontend production build: passed.
- Worker TypeScript check: passed.
- Yoco V2 Worker tests: 45 passed.
- Wrangler deploy dry run: passed.
