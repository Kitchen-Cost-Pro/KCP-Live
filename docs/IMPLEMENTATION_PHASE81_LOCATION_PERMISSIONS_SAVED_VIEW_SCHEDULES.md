# Phase 81: Location Access, Data Actions, and Scheduled Saved Views

## Report location access

- Report location selectors now use the permission-filtered workspace location list as the source of truth.
- Duplicate location records are collapsed by normalized ID and display name.
- Role-level location scope and user-level location assignments are combined using the strict intersection.
- Restricted users no longer fall back to all locations when no permitted match exists.
- The same accessible-location helper is used by Menu, Recipes, Stock Items, and Reporting.
- Scheduled report location lists are also deduplicated and invalid selected locations fail closed.

## Import and export permissions

- Added separate Import data and Export data permissions under each applicable section in Roles and Permissions.
- Supported sections include Menu Items, Recipes, Stock Items, Suppliers, Purchase Orders, Transfers, Stock Takes, Manufacturing, Reporting, and Settings.
- Unauthorized import and export callbacks are removed before the module is rendered.
- Unauthorized import and export controls and hidden file inputs are removed from the page.
- Existing roles retain their previous import and export behavior until the role is saved using the new explicit permission schema.

## Scheduled saved-view delivery

- Scheduled execution reloads the current saved view immediately before sending.
- The saved view's current filters, sort, visible columns, report view, and date-range preset are applied.
- Custom saved date ranges are preserved instead of being replaced by the schedule-wide date range.
- Saved location filters are intersected with the schedule location scope and the sender's permitted locations.
- A saved view cannot silently widen a schedule to an unauthorized location.
- The refreshed saved-view snapshot is written back to the schedule as the latest fallback copy.
- Existing schedules repair their saved-view snapshots when they next run.
- Scheduler compatibility version is 33.19.

## Validation

- 453 frontend tests pass.
- Frontend production build passes.
- Worker TypeScript validation passes.
- 45 Yoco V2 Worker tests pass.
- Cloudflare Worker deployment dry run passes.
