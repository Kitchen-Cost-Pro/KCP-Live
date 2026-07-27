import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const rootDir = process.cwd();
const reporting = fs.readFileSync(path.join(rootDir, 'cloudflare-v2/src/legacy/reporting-routes.ts'), 'utf8');

function functionSource(source, functionName, nextFunctionName) {
  const exportedStart = source.indexOf(`export async function ${functionName}(`);
  const plainStart = source.indexOf(`function ${functionName}(`);
  const actualStart = exportedStart >= 0 ? exportedStart : plainStart;
  assert.notEqual(actualStart, -1, `${functionName} was not found`);
  const nextExported = nextFunctionName ? source.indexOf(`export async function ${nextFunctionName}(`, actualStart + 1) : -1;
  const nextPlain = nextFunctionName ? source.indexOf(`function ${nextFunctionName}(`, actualStart + 1) : -1;
  const candidates = [nextExported, nextPlain].filter((value) => value > actualStart);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(actualStart, end);
}

test('Phase 33.6 Stock Control only declares truncation after proving a real overflow row exists', () => {
  const stockControl = functionSource(reporting, 'getStockControlReport', 'buildStockControlWhere');
  assert.match(stockControl, /LIMIT \$\{MAX_REPORT_ROWS \+ 1\}/);
  assert.match(stockControl, /const sourceTruncated = sourceRows\.length > MAX_REPORT_ROWS/);
  assert.match(stockControl, /truncated:\s*sourceTruncated/);
  assert.match(stockControl, /sourceRowsFetched:\s*sourceRows\.length/);
});

test('Phase 33.6 Stock Control collapses duplicate legacy balance and location-cost rows before reporting', () => {
  const stockControl = functionSource(reporting, 'getStockControlReport', 'buildStockControlWhere');
  assert.match(stockControl, /latest_balance AS/);
  assert.match(stockControl, /PARTITION BY sb\.workspace_id, sb\.stock_item_id, sb\.location_id/);
  assert.match(stockControl, /latest_location_cost AS/);
  assert.match(stockControl, /PARTITION BY silp\.workspace_id, silp\.stock_item_id, silp\.location_id/);
  assert.doesNotMatch(stockControl, /LEFT JOIN stock_balances sb ON/);
  assert.doesNotMatch(stockControl, /LEFT JOIN stock_item_location_prices silp ON/);
});

test('Phase 33.6 explicit source completeness overrides equality-based legacy inference', () => {
  const buildMeta = functionSource(reporting, 'buildMeta', 'getReportFilterOptions');
  assert.match(buildMeta, /hasExplicitTruncationState/);
  assert.match(buildMeta, /Object\.prototype\.hasOwnProperty\.call\(extra, "truncated"\)/);
  assert.match(buildMeta, /\? extra\.truncated === true/);
});
