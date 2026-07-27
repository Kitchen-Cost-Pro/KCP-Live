# Phase 80: Daily Low-Stock Notifications and Scheduled Saved Views

## Dashboard notifications

- Removed the manual **Email this list** action.
- Added a settings cog inside the stock notification window.
- Low-stock emails run daily by default.
- The delivery time is configurable in Africa/Johannesburg time.
- Owners, admins, and KCP superusers can select active workspace users for the email list.
- Recipient membership is stored on central workspace membership records.

## Scheduled saved views

- Scheduled execution now rehydrates the selected saved view at send time.
- Current saved filters, sorting, and visible columns are applied to the generated output.
- A stored snapshot remains available as a fallback if the saved view is deleted.
- Existing schedules with an empty or stale snapshot are repaired automatically when they run.
