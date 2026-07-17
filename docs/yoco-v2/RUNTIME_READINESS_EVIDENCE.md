# Runtime readiness evidence

The source archive cannot prove production observation-period results. Export a JSON file to `runtime-evidence/yoco-v2-readiness.json`, or pass another path to:

```bash
npm run audit:yoco-v2-runtime-readiness -- path/to/evidence.json
```

Required shape:

```json
{
  "generatedAt": "2026-07-16T08:00:00.000Z",
  "observationPeriod": {
    "start": "2026-07-15T08:00:00.000Z",
    "end": "2026-07-16T08:00:00.000Z"
  },
  "activeWorkspaces": [
    {
      "workspaceId": "workspace-id",
      "ownership": {
        "SALE_REPORTING": { "engineVersion": "V2", "enabled": true },
        "SALE_STOCK": { "engineVersion": "V2", "enabled": true },
        "REFUND_REPORTING": { "engineVersion": "V2", "enabled": true },
        "REFUND_STOCK": { "engineVersion": "V2", "enabled": true }
      }
    }
  ],
  "health": {
    "webhookCaptureActive": true,
    "queueProcessingActive": true,
    "rawEventsStored": true,
    "canonicalSalesProduced": true,
    "canonicalRefundsProduced": true,
    "saleStockLive": true,
    "refundStockLive": true,
    "manualRefundAllocationAvailable": true,
    "reconciliationRunning": true,
    "deadLetterHandlingAvailable": true,
    "adminDiagnosticsUseV2": true,
    "retryAfterRespected": true
  },
  "legacyExecutionCounts": {
    "legacyWebhookProcessorCalls": 0,
    "legacySaleProcessorCalls": 0,
    "legacyRefundProcessorCalls": 0,
    "legacyStockWriteCalls": 0,
    "legacyReportingWriteCalls": 0,
    "legacySyncOrResyncCalls": 0,
    "legacyRetryEndpointCalls": 0,
    "legacyScheduledJobExecutions": 0,
    "legacyAdminActionCalls": 0
  },
  "unresolvedCriticalFailures": 0
}
```
