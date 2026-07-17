import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const admin = readFileSync(resolve(root, 'src/modules/yoco-engine-v2/admin-routes.ts'), 'utf8');
const dispatch = readFileSync(resolve(root, 'src/modules/yoco-engine-v2/route-dispatch.ts'), 'utf8');
const shutdownPath = resolve(root, 'src/modules/yoco-engine-v2/legacy-shutdown.ts');
const shutdown = existsSync(shutdownPath) ? readFileSync(shutdownPath, 'utf8') : '';
const sources = `${admin}\n${dispatch}`;

const forbiddenImports = [
  '../../legacy/yoco-service',
  '../../legacy/yoco-sales',
  '../../legacy/yoco-webhooks',
  '../../legacy/yoco-refund-context'
];
const forbiddenCalls = [
  'syncYocoSales(',
  'retryFailedYocoOrders(',
  'retryPendingYocoRefundWebhooks(',
  'processYocoOrder(',
  'processYocoOrderReturns('
];
const forbiddenProcessingTables = [
  'yoco_webhook_events'
];
const failures = [];
for (const value of forbiddenImports) if (sources.includes(value)) failures.push(`V2 admin imports ${value}`);
for (const value of forbiddenCalls) if (sources.includes(value)) failures.push(`V2 admin invokes ${value}`);
for (const value of forbiddenProcessingTables) if (admin.includes(value)) failures.push(`V2 admin depends on legacy processing table ${value}`);
if (/DELETE\s+FROM\s+(yoco_webhook_events|yoco_connections|yoco_orders|yoco_order_lines)/i.test(shutdown)) {
  failures.push('Phase 12 shutdown module contains a legacy table deletion.');
}
if (/DROP\s+TABLE/i.test(shutdown)) failures.push('Phase 12 shutdown module contains DROP TABLE.');
if (existsSync(shutdownPath)) failures.push('Retired legacy shutdown runtime is still present.');

const result = {
  ok: failures.length === 0,
  checked: {
    v2_admin_has_no_legacy_processor_imports: true,
    v2_admin_has_no_legacy_processor_calls: true,
    v2_admin_has_no_yoco_webhook_events_dependency: true,
    legacy_shutdown_runtime_removed: !existsSync(shutdownPath),
    phase12_has_no_legacy_table_deletion: true,
    phase13_deletion_executor_absent: !existsSync(shutdownPath)
  },
  allowedHistoricalReads: ['yoco_orders', 'yoco_order_lines', 'stock_movements'],
  failures
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 1;
