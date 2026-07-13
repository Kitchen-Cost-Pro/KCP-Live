import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const rootDir = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');

const routes = read('cloudflare-v2/src/legacy/routes.ts');
const yocoSales = read('cloudflare-v2/src/legacy/yoco-sales.ts');
const costing = read('cloudflare-v2/src/legacy/inventory-costing.ts');
const reporting = read('cloudflare-v2/src/legacy/reporting-routes.ts');
const phase21Reporting = read('cloudflare-v2/src/legacy/reporting-phase21-routes.ts');
const scheduling = read('cloudflare-v2/src/legacy/report-scheduling-routes.ts');
const reportingApi = read('src/modules/reporting/api/reportingApi.js');
const reportPageLoader = read('src/modules/reporting/api/reportPageLoader.js');
const workerConfig = read('cloudflare-v2/wrangler.toml');

function functionSource(source, functionName, nextFunctionName) {
  const exportedStart = source.indexOf(`export async function ${functionName}(`);
  const plainStart = source.indexOf(`function ${functionName}(`);
  const actualStart = exportedStart >= 0 ? exportedStart : plainStart;
  assert.notEqual(actualStart, -1, `${functionName} was not found`);
  const end = nextFunctionName
    ? Math.max(source.indexOf(`function ${nextFunctionName}`, actualStart + 1), source.indexOf(`export async function ${nextFunctionName}`, actualStart + 1))
    : source.length;
  return source.slice(actualStart, end > actualStart ? end : source.length);
}

test('Phase 24 Worker owns the inventory costing method instead of trusting request payloads', () => {
  assert.match(costing, /getWorkspaceInventoryCostingMethod/);
  assert.match(costing, /FROM workspace_settings/);
  const grv = functionSource(routes, 'postGoodsReceipt', 'deleteGoodsReceipt');
  assert.match(grv, /await\s+getWorkspaceInventoryCostingMethod\(\s*env,\s*workspaceId,?\s*\)/);
  assert.doesNotMatch(grv, /normalizeInventoryCostingMethod\(payload/);
});

test('Phase 24 inbound location cost supports both weighted average and last received', () => {
  assert.match(costing, /if \(method === 'last'\) return incomingCost/);
  assert.match(costing, /\(previousQuantity \* previousCost\) \+ \(incomingQuantity \* incomingCost\)/);
  assert.match(costing, /upsertLocationCostStatement/);
});

test('Phase 24 explicit zero location costs remain authoritative', () => {
  assert.match(costing, /row\.price !== undefined && row\.price !== null/);
  assert.doesNotMatch(reporting, /NULLIF\(silp\.price,\s*0\)/);
  assert.doesNotMatch(phase21Reporting, /NULLIF\(silp\.price,\s*0\)/);
});

test('Phase 24 all core inventory transaction paths resolve location cost', () => {
  for (const functionName of ['postAdjustment', 'postWastageAdjustment', 'postStockTake', 'patchStockTake', 'postManufacturingBatch', 'postInternalTransfer', 'postExternalTransfer', 'acceptExternalTransfer']) {
    const exportedStart = routes.indexOf(`export async function ${functionName}(`);
    const plainStart = routes.indexOf(`function ${functionName}(`);
    const start = exportedStart >= 0 ? exportedStart : plainStart;
    assert.notEqual(start, -1, `${functionName} was not found`);
    const next = routes.indexOf('\nexport async function ', start + 1);
    const section = routes.slice(start, next > start ? next : routes.length);
    assert.match(section, /resolveLocationUnitCost|getWorkspaceInventoryCostingMethod/, `${functionName} does not use authoritative location costing`);
  }
  assert.match(yocoSales, /stock_item_location_prices/);
  assert.match(yocoSales, /valuationCostSource/);
});

test('Phase 24 manufacturing updates location cost and does not overwrite global master cost', () => {
  const manufacturing = functionSource(routes, 'postManufacturingBatch', 'restoreSenderTransfer');
  assert.match(manufacturing, /upsertLocationCostStatement/);
  assert.doesNotMatch(manufacturing, /UPDATE stock_items SET unit_cost/);
  assert.match(manufacturing, /[\"']manufacturing_wastage[\"'][\s\S]*?batchId,\s*0,\s*expectedUnitCost/);
  assert.match(manufacturing, /accountingOnly:\s*true/);
});

test('Phase 24 historical manufacturing wastage repair removes false physical quantity impact', () => {
  const repair = functionSource(reporting, 'manufacturingWastageRepairSql', 'stockTakeVarianceMissingSql');
  assert.match(repair, /SET quantity_delta = 0/);
  assert.match(repair, /'\$\.accountingOnly', 1/);
  assert.match(reporting, /Manufacturing Wastage Quantity Normalisation/);
});

test('Phase 24 dashboard values use location costs and preserve posted transaction valuation', () => {
  assert.match(routes, /LEFT JOIN stock_item_location_prices silp/);
  assert.match(routes, /WHEN silp\.stock_item_id IS NOT NULL THEN COALESCE\(silp\.price, 0\)/);
  assert.match(routes, /WHEN sm\.unit_cost IS NOT NULL THEN sm\.quantity_delta \* sm\.unit_cost/);
  assert.doesNotMatch(routes, /WHEN \$\{CURRENT_COST_SQL\} > 0 THEN sm\.quantity_delta/);
});

test('Phase 33.16 interactive and scheduled reports paginate beyond the old 100,000-row source ceiling', () => {
  assert.match(reportingApi, /collectCompleteReportPages/);
  assert.match(reportPageLoader, /DEFAULT_PAGE_SIZE = 5000/);
  assert.match(reportPageLoader, /splitByDate/);
  assert.match(reportPageLoader, /filterOptions\?\.locations/);
  assert.match(scheduling, /collectCompleteReportPages/);
  assert.doesNotMatch(scheduling, /incomplete scheduled report will not be sent/);
  assert.match(reporting, /hasMore/);
  assert.match(reporting, /truncated/);
});

test('Phase 26 invalid Yoco webhook signatures are rejected without a processing fallback', () => {
  const webhook = functionSource(routes, 'postYocoWebhook', 'postYocoSalesSync');
  assert.match(webhook, /if \(!verified\)/);
  assert.match(webhook, /return\s+error\(\s*request,\s*env,\s*401/);
  assert.doesNotMatch(webhook, /processed_signature_fallback/);
});

test('Phase 24 local development CORS supports Vite fallback ports', () => {
  assert.match(workerConfig, /http:\/\/localhost:\*/);
  assert.match(workerConfig, /http:\/\/127\.0\.0\.1:\*/);
});

test('Phase 26 adds rolling Yoco signature alerts and authenticated reconciliation', () => {
  assert.match(routes, /YOCO_SIGNATURE_ALERT_THRESHOLD\s*=\s*3/);
  assert.match(routes, /checkYocoWebhookSignatureHealth/);
  assert.match(routes, /action\s*===\s*[\"']reconcile-sales[\"']/);
  assert.match(routes, /syncYocoSales\(env, workspaceId, \{ sinceIso \}\)/);
});
