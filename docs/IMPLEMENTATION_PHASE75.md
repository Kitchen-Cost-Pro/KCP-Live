# Phase 75: Location Permissions, Saved Views, and UI Fixes

## 1. Location-based permission scoping

### Worker authorization
- `cloudflare-v2/src/legacy/auth.ts`
  - Added request-local resolved report scopes using `WeakMap<Request, string[] | null>`.
  - Restricted users no longer need to manually choose one location before a report can load.
  - An unscoped report request now resolves to every explicitly assigned location.
  - Explicit location requests are still validated and fail closed when outside the assigned list.
  - Users with zero assigned locations remain denied.

### Reporting queries
- `cloudflare-v2/src/legacy/reporting-routes.ts`
- `cloudflare-v2/src/legacy/reporting-phase21-routes.ts`
  - Added multi-location `IN (...)` query support.
  - Applied resolved permitted locations to SQL filters and post-query row filtering.
  - Replaced single-location equality checks with reusable location-scope helpers.
  - Dashboard report requests with one or more assigned locations now render instead of returning a global Access Denied response.

### Frontend location filtering
- `src/main.js`
  - Removed both fallback paths that widened a failed role/user location match back to the full location list.
  - Role and user assignment intersections now fail closed.

### Stock data
- `cloudflare-v2/src/legacy/routes.ts`
  - `getStockItems`: aggregates only assigned locations when no single location is selected.
  - Scoped stock balances and location cost JSON to the same permitted location set.
  - `getStockTakes`: filters posted sessions by assigned location IDs.
  - `getStockTakeTemplates`: returns only templates that intersect assigned locations.
  - `getStockTakeDrafts`: returns only drafts in assigned locations.
  - Template and draft writes validate the target location before persistence.

### Legacy dashboard endpoints
- `cloudflare-v2/src/legacy/routes.ts`
  - `getDashboardSource`: filters inventory movement and sales activity by permitted locations.
  - Restricted users do not receive workspace-wide integration error rows that cannot be reliably location-scoped.
  - `getDashboard`: validates explicit locations and aggregates legacy dashboard metrics across the full assigned-location set when no single location is selected.

## 2. Dashboard notification permissions

- `src/dashboard.js`
  - Added a notification-specific inventory scope.
  - When the global dashboard location is All Locations, the bell aggregates all rows returned by the permission-scoped Worker.
  - When a location is selected, notifications show only that location.
  - Notification emails now send the global dashboard location selection, not the stock-table tab selection.

- `cloudflare-v2/src/legacy/routes.ts`
  - Resolves notification email scope to either the selected permitted location or all assigned locations.

- `cloudflare-v2/src/legacy/low-stock-email.ts`
  - Added array-based location filtering with SQL `IN (...)`.
  - Multi-location emails no longer incorrectly label the subject with the first location name.

## 3. User Management cleanup

- `src/components/UserManagement.js`
  - Removed the Low Stock Alert toggle.
  - Removed the Low Stock Email status badge.
  - Removed unused low-stock permission plumbing from create/edit modal rendering.

## 4. Saved Views and scheduling

### Saved-view persistence
- `cloudflare-v2/src/legacy/report-scheduling-routes.ts`
  - Saved-view create and update now use the scheduling schema-repair retry path.
  - Empty/missing filter objects normalize to `{}` instead of rejecting an otherwise valid save.
  - Added clear persistence error messages.
  - Visible columns and date range values are normalized before storage.
  - Saved views are validated against the logged-in user's permitted locations.
  - Restricted unscoped views are snapshotted with the user's assigned location IDs.
  - Saved-view lists omit views containing locations outside the current user's scope.

### Saved views per scheduled report view
- `src/modules/reporting/scheduling/SchedulingPage.js`
  - Added a Saved View selector to every individual report view in the report-pack picker.
  - Selecting a saved view automatically selects its corresponding report/view.
  - Each scheduled report item snapshots its own filters, sort, columns, and saved-view reference for server-side materialization.
  - The existing global saved-view starter remains available as a quick-add shortcut.

- `src/styles/reporting.css`
  - Added selected-state and layout styling for per-view saved-view controls.

## 5. Wastage Actions hover effects

- `src/styles/adjustments.css`
  - Retained the existing transition/background/border/translate hover treatment.
  - Added explicit opacity and `will-change` feedback for all enabled action items.

## 6. Stock Take currency alignment

- `src/styles/stockTake.css`
  - Applied `white-space: nowrap` and tabular numeric rendering to line impacts and session variance totals.
  - Currency now renders inline as `R 150.00`.

## 7. Transparent dashboard background

- `src/styles/dashboard.module.css`
  - Changed the main `.shell` background to `transparent` so the application background wrapper remains visible.

## Regression coverage

- Added `src/phase75LocationScopeSavedViewsUi.test.js`.
- Updated older permission and notification assertions to match the new secure auto-scoping behavior.

## Validation completed

- `npm run build` - passed.
- `npm test` - 431 tests passed.
- `npm --prefix cloudflare-v2 run typecheck` - passed.
- `npm --prefix cloudflare-v2 test` - 39 tests passed.
