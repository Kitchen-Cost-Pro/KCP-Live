import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const failures = [];
const check = (name, condition, detail = '') => { if (!condition) failures.push({ name, detail }); };

for (const path of [
  'src/legacy/yoco-sales.ts', 'src/legacy/yoco-webhooks.ts', 'src/legacy/yoco-refund-context.ts',
  'src/legacy/yoco-client.ts', 'src/modules/yoco-engine-v2/sale-shadow.ts',
  'src/modules/yoco-engine-v2/refund-shadow.ts', 'src/modules/yoco-engine-v2/legacy-shutdown.ts',
  'src/modules/yoco-engine-v2/legacy-shadow-observer.ts',
]) check(`removed:${path}`, !existsSync(resolve(root, path)), path);

const release = read('src/release.ts');
const route = read('src/modules/yoco-engine-v2/route-dispatch.ts');
const processor = read('src/modules/yoco-engine-v2/processor.ts');
const reconciliation = read('src/modules/yoco-engine-v2/reconciliation.ts');
const ownership = read('src/modules/yoco-engine-v2/ownership.ts');
const config = read('src/modules/yoco-engine-v2/config.ts');
const wrangler = read('wrangler.toml');

check('release-name', /phase-v2-final-legacy-removal-reporting-audit/.test(release));
check('v2-webhook', /handleYocoV2WebhookIngress/.test(route));
check('sale-live-effects', /buildSaleEffectProposals/.test(processor) && /applyControlledLiveSaleEffects/.test(processor));
check('refund-live-effects', /buildRefundReportingProposal/.test(processor) && /applyControlledLiveRefundEffects/.test(processor));
check('reconciliation-live-effects', /applyControlledLiveSaleEffects/.test(reconciliation) && /applyControlledLiveRefundEffects/.test(reconciliation));
check('ownership-fail-closed', /YOCO_V2_OWNERSHIP_REQUIRES_EXPLICIT_MIGRATION/.test(ownership) && /YOCO_V2_OWNERSHIP_NOT_READY/.test(ownership));
check('no-shadow-flags', !/YOCO_V2_SHADOW|PRELAUNCH|PILOT_WORKSPACE|PHASE13_REMOVAL|LEGACY_SHUTDOWN/.test(`${config}\n${wrangler}`));
check('no-rollback-functions', !/rollbackSaleEffect|rollbackRefundEffect|ROLLED_BACK_TO_LEGACY/.test(`${processor}\n${reconciliation}\n${ownership}`));

const directHits = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.wrangler', 'migrations'].includes(entry)) continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.ts$/.test(entry)) {
      const rel = relative(root, full).replaceAll('\\', '/');
      if (rel === 'src/modules/yoco-engine-v2/api-client.ts') continue;
      const text = readFileSync(full, 'utf8');
      if (/fetch\s*\(\s*(?:`|'|")https:\/\/api\.yoco\.com/i.test(text)) directHits.push(rel);
    }
  }
}
walk(resolve(root, 'src'));
check('no-direct-api-bypass', directHits.length === 0, directHits.join(', '));

console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
if (failures.length) process.exit(1);
