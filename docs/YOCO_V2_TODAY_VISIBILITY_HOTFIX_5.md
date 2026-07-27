# Yoco V2 Today Visibility Hotfix 5

Release: `phase-v2-admin-yoco-engine-control-centre-hotfix-5`
Date: 2026-07-15

## Symptom

A live Yoco sale deducted stock through the legacy engine, but the Yoco V2 Overview, Event Inbox and Processing Runs appeared empty for the selected current date.

## Root cause

The admin UI sends date filters as `YYYY-MM-DD`. The V2 admin API converted the selected `to` date to midnight at the start of that date. For example, `2026-07-15` became `2026-07-15T00:00:00.000Z`, excluding every event created later that day.

This affected date-filtered structured views including Overview, Event Inbox, Processing Runs, API Health and API Requests. The V2 event could exist and process correctly while remaining invisible in the default dashboard range.

## Correction

Date-only values now use South African day boundaries:

- Start: `00:00:00.000+02:00`
- End: `23:59:59.999+02:00`

For 15 July 2026 this produces the UTC query range:

- From: `2026-07-14T22:00:00.000Z`
- To: `2026-07-15T21:59:59.999Z`

Full timestamp filters continue to be accepted unchanged.

## Regression coverage

Automated tests now prove:

1. A V2 event created during the selected South African day appears in Event Inbox.
2. Overview includes the event in KPI totals.
3. A post-commit legacy sale bridge event named `kcp-legacy-sale-committed:<order-id>` appears under the default selected day.
4. The post-commit bridge processes end to end into a canonical sale, proposed stock movement and sale comparison.
5. V2 queue messages remain `live_effects: false`.

## Safety confirmation

- Legacy remains the only owner of live sale reporting and stock effects.
- No V2 live effect flags were enabled.
- No stock or reporting business logic was changed.
- The change is limited to admin date filtering and automated tests.
