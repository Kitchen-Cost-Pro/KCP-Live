# Yoco V2 Admin UI and API Route Map

## UI route

```text
/admin
└── Sidebar
    ├── Legacy Yoco Integration       existing page, remains active
    └── Yoco V2 Engine                new structured control centre
        ├── Overview
        ├── Event Inbox
        │   └── Event detail drawer
        ├── Processing Runs
        │   └── Run detail drawer
        ├── Sales Shadow
        │   └── Sale comparison drawer
        ├── Refunds
        │   └── Refund comparison drawer
        ├── Reconciliation
        │   ├── Run detail drawer
        │   └── Findings work queue
        ├── Manual Review
        │   └── Allocation approval drawer
        ├── API Health
        ├── Dead Letter
        │   └── Event timeline drawer
        └── Configuration             read-only shadow state
```

## External admin API

Base:

```text
/api/admin/workspaces/:workspaceId/yoco-v2/control-centre
```

Routes:

```text
GET  /capabilities
GET  /overview
GET  /events
GET  /events/:rawEventId
POST /events/:rawEventId/replay
POST /events/:rawEventId/requeue
POST /events/:rawEventId/manual-review

GET  /processing-runs
GET  /processing-runs/:runId

GET  /sales
GET  /sales/:sourceOrderId
POST /sales/:sourceOrderId/refetch
POST /sales/:sourceOrderId/reresolve
POST /sales/:sourceOrderId/repropose
POST /sales/:sourceOrderId/recompare

GET  /refunds
GET  /refunds/:refundId
POST /refunds/:refundId/refetch
POST /refunds/:refundId/reresolve
POST /refunds/:refundId/repropose
POST /refunds/:refundId/recompare

GET  /manual-reviews
GET  /manual-reviews/:reviewId
POST /manual-reviews/:reviewId/approve

GET  /reconciliation/runs
GET  /reconciliation/runs/:runId
GET  /reconciliation/findings
POST /reconciliation/findings/:findingId/retry
POST /reconciliation/findings/:findingId/refetch
POST /reconciliation/findings/:findingId/rerun-resolver
POST /reconciliation/findings/:findingId/rerun-comparison
POST /reconciliation/findings/:findingId/manual-review
POST /reconciliation/run

GET  /api-health
GET  /api-requests

GET  /dead-letters
POST /dead-letters/:rawEventId/requeue
POST /dead-letters/:rawEventId/manual-review
POST /dead-letters/:rawEventId/close

GET  /configuration
POST /configuration                      always returns locked/read-only
```

## Internal workspace route

The central Worker authenticates and forwards to:

```text
yoco-v2/admin/control-centre/*
```

All tenant data access occurs inside the selected workspace Durable Object. The browser never accesses D1 directly.

## Table/query behaviour

- List endpoints: server-side `LIMIT` and `OFFSET`, page sizes 25/50/100.
- Event list: excludes raw payload and headers.
- Event detail: loads and redacts payload/headers on demand.
- Sort: only allowlisted fields.
- Search: bound SQL parameters with wildcard escaping.
- Actions: `Idempotency-Key`, confirmation, permission check, rate limit, structured audit.
