import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const evidencePath = resolve(process.cwd(), process.argv[2] || 'runtime-evidence/yoco-v2-readiness.json');
if (!existsSync(evidencePath)) {
  console.error(JSON.stringify({
    ok: false,
    code: 'YOCO_V2_RUNTIME_EVIDENCE_REQUIRED',
    evidencePath,
    message: 'Export current production ownership, health, legacy-execution counters and critical failure counts to this JSON file, then rerun the audit.',
  }, null, 2));
  process.exit(2);
}

const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const effectTypes = ['SALE_REPORTING', 'SALE_STOCK', 'REFUND_REPORTING', 'REFUND_STOCK'];
const healthKeys = [
  'webhookCaptureActive', 'queueProcessingActive', 'rawEventsStored', 'canonicalSalesProduced',
  'canonicalRefundsProduced', 'saleStockLive', 'refundStockLive', 'manualRefundAllocationAvailable',
  'reconciliationRunning', 'deadLetterHandlingAvailable', 'adminDiagnosticsUseV2', 'retryAfterRespected',
];
const legacyCounterKeys = [
  'legacyWebhookProcessorCalls', 'legacySaleProcessorCalls', 'legacyRefundProcessorCalls',
  'legacyStockWriteCalls', 'legacyReportingWriteCalls', 'legacySyncOrResyncCalls',
  'legacyRetryEndpointCalls', 'legacyScheduledJobExecutions', 'legacyAdminActionCalls',
];
const failures = [];
const workspaces = Array.isArray(evidence.activeWorkspaces) ? evidence.activeWorkspaces : [];
if (!workspaces.length) failures.push('activeWorkspaces is empty');
for (const workspace of workspaces) {
  for (const effectType of effectTypes) {
    const owner = workspace?.ownership?.[effectType];
    if (owner?.engineVersion !== 'V2' || owner?.enabled !== true) failures.push(`${workspace.workspaceId || 'unknown'}:${effectType} is not enabled V2 ownership`);
  }
}
for (const key of healthKeys) if (evidence?.health?.[key] !== true) failures.push(`health.${key} is not true`);
for (const key of legacyCounterKeys) if (Number(evidence?.legacyExecutionCounts?.[key]) !== 0) failures.push(`legacyExecutionCounts.${key} is not zero`);
if (Number(evidence.unresolvedCriticalFailures) !== 0) failures.push('unresolvedCriticalFailures is not zero');
if (!evidence?.observationPeriod?.start || !evidence?.observationPeriod?.end) failures.push('observationPeriod.start/end are required');

console.log(JSON.stringify({
  ok: failures.length === 0,
  generatedAt: evidence.generatedAt || null,
  observationPeriod: evidence.observationPeriod || null,
  workspaceCount: workspaces.length,
  failures,
}, null, 2));
if (failures.length) process.exit(1);
