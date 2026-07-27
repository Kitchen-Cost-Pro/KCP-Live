import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const failures = [];
const passed = [];
const check = (name, condition, detail = '') => {
  (condition ? passed : failures).push({ name, detail });
};

const removedRuntimeFiles = [
  'cloudflare-v2/src/legacy/yoco-service.ts',
  'cloudflare-v2/src/legacy/yoco-sales.ts',
  'cloudflare-v2/src/legacy/yoco-webhooks.ts',
  'cloudflare-v2/src/legacy/yoco-refund-context.ts',
  'cloudflare-v2/src/legacy/yoco-client.ts',
  'cloudflare-v2/src/modules/yoco-engine-v2/sale-shadow.ts',
  'cloudflare-v2/src/modules/yoco-engine-v2/refund-shadow.ts',
  'cloudflare-v2/src/modules/yoco-engine-v2/legacy-shutdown.ts',
  'cloudflare-v2/src/modules/yoco-engine-v2/legacy-shadow-observer.ts',
];
removedRuntimeFiles.forEach((path) => check(`removed:${path}`, !existsSync(resolve(root, path)), 'obsolete runtime file still exists'));

const requiredDocs = [
  'docs/LEGACY_YOCO_REMOVAL_AUDIT.md',
  'docs/YOCO_V2_REPORTING_WIRING_AUDIT.md',
  'docs/REPORTING_RECONCILIATION_EVIDENCE.md',
];
requiredDocs.forEach((path) => check(`document:${path}`, existsSync(resolve(root, path)), 'required audit document is missing'));
check('release-name', read('RELEASE.txt').trim() === 'phase-v2-final-legacy-removal-reporting-audit', read('RELEASE.txt').trim());

const webhook = read('cloudflare-v2/src/modules/yoco-engine-v2/webhook-ingress.ts');
const dispatch = read('cloudflare-v2/src/modules/yoco-engine-v2/route-dispatch.ts');
const processor = read('cloudflare-v2/src/modules/yoco-engine-v2/processor.ts');
const reconciliation = read('cloudflare-v2/src/modules/yoco-engine-v2/reconciliation.ts');
const ownership = read('cloudflare-v2/src/modules/yoco-engine-v2/ownership.ts');
const apiClient = read('cloudflare-v2/src/modules/yoco-engine-v2/api-client.ts');
const catalogClient = read('cloudflare-v2/src/modules/yoco-engine-v2/catalog-client.ts');
const rateGate = read('cloudflare-v2/src/modules/yoco-engine-v2/rate-gate.ts');
const reportingCatalog = read('src/modules/reporting/api/reportDataSourceCatalog.js');
const reportingBackend = read('cloudflare-v2/src/legacy/reporting-routes.ts');
const legacyRoutes = [
  read('cloudflare-v2/src/legacy/index.ts'),
  read('cloudflare-v2/src/legacy/routes.ts'),
  read('cloudflare-v2/src/legacy/admin-routes.ts'),
].join('\n');
const v2IntegrationService = read('cloudflare-v2/src/modules/yoco-engine-v2/integration-service.ts');

check('v2-webhook-ingress', /captureVerifiedYocoV2Event/.test(webhook) && /handleYocoV2WebhookIngress/.test(dispatch));
check('canonical-sale-processing', /resolveCanonicalYocoSale/.test(processor) && /buildSaleEffectProposals/.test(processor) && /applyControlledLiveSaleEffects/.test(processor));
check('canonical-refund-processing', /resolveCanonicalYocoRefund/.test(processor) && /buildRefundReportingProposal/.test(processor) && /buildRefundStockProposals/.test(processor) && /applyControlledLiveRefundEffects/.test(processor));
check('reconciliation-applies-v2-effects', /applyControlledLiveSaleEffects/.test(reconciliation) && /applyControlledLiveRefundEffects/.test(reconciliation));
check('ownership-fails-closed', /YOCO_V2_OWNERSHIP_REQUIRES_EXPLICIT_MIGRATION/.test(ownership) && /YOCO_V2_OWNERSHIP_NOT_READY/.test(ownership));
check('no-runtime-legacy-owner-assignment', !/engine_version\s*=\s*['"]LEGACY['"]|VALUES\s*\([^;]*['"]LEGACY['"]/is.test([ownership, processor, reconciliation].join('\n')));
check('rate-gated-client', /retryAfterSeconds/.test(apiClient) && /retry-after/i.test(rateGate) && /executeYocoV2ApiRequest/.test(catalogClient));
check('v2-integration-service', /connectYoco/.test(v2IntegrationService) && !/fetch\s*\(\s*(?:`|'|")https:\/\/api\.yoco\.com/i.test(v2IntegrationService));
check('legacy-business-routes-removed', !/sync-sales|retry-refunds|refund-recovery|legacy\/reconcile|processLegacySale|processLegacyRefund/.test(legacyRoutes));
check('reporting-canonical-sales', /yoco_orders/.test(reportingCatalog) && /yoco_orders/.test(reportingBackend));
check('reporting-ledger-source', /stock_movements/.test(reportingCatalog) && /stock_movements/.test(reportingBackend));

const approvedDirectApiFiles = new Set([
  'cloudflare-v2/src/modules/yoco-engine-v2/api-client.ts',
]);
const directApiHits = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.wrangler', '.git'].includes(entry)) continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.(?:ts|js|mjs|cjs)$/.test(entry)) {
      const rel = relative(root, full).replaceAll('\\', '/');
      if (approvedDirectApiFiles.has(rel)) continue;
      const text = readFileSync(full, 'utf8');
      if (/fetch\s*\(\s*(?:`|'|")https:\/\/api\.yoco\.com/i.test(text)) directApiHits.push(rel);
    }
  }
}
walk(resolve(root, 'cloudflare-v2/src'));
check('no-direct-yoco-api-bypass', directApiHits.length === 0, directApiHits.join(', '));

const prohibitedRuntimeTokens = [
  'YOCO_V2_SHADOW_SALES_ENABLED',
  'YOCO_V2_SHADOW_REFUNDS_ENABLED',
  'YOCO_V2_PRELAUNCH_LIVE',
  'YOCO_V2_PILOT_WORKSPACE_IDS',
  'YOCO_V2_REFUND_PILOT_WORKSPACE_IDS',
  'ROLLED_BACK_TO_LEGACY',
  'rollbackSaleEffect',
  'rollbackRefundEffect',
  'compareSaleShadow',
  'compareRefundShadow',
];
const runtimeFiles = [];
function collectRuntime(dir) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.wrangler', '.git', 'migrations'].includes(entry)) continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectRuntime(full);
    else if (/\.(?:ts|js|toml)$/.test(entry) && !entry.includes('migration')) runtimeFiles.push(full);
  }
}
collectRuntime(resolve(root, 'cloudflare-v2/src'));
runtimeFiles.push(resolve(root, 'cloudflare-v2/wrangler.toml'));
const prohibitedHits = [];
for (const file of runtimeFiles) {
  const text = readFileSync(file, 'utf8');
  for (const token of prohibitedRuntimeTokens) if (text.includes(token)) prohibitedHits.push(`${relative(root, file)}:${token}`);
}
check('no-obsolete-runtime-flags-or-rollback', prohibitedHits.length === 0, prohibitedHits.join(', '));

const result = {
  ok: failures.length === 0,
  release: read('RELEASE.txt').trim(),
  passed: passed.length,
  failed: failures.length,
  failures,
  note: 'This is a source-level release audit. Run audit:yoco-v2-runtime-readiness with exported production evidence before deployment acceptance.',
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
