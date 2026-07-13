import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localDateRangeToUtcBounds,
  normalizeTradingDayStartMinutes,
  zonedTradingDateTimeStrings,
} from './modules/reporting/engine/timezone.js';
import { resolveDateRangePreset } from './modules/reporting/scheduling/dateRangePresets.js';
import { resolveScheduledRelativeRange } from './modules/reporting/scheduling/scheduleTiming.js';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 56 notification bubble can email its location-scoped stock data to the signed-in user', () => {
  const dashboard = read('src/dashboard.js');
  const service = read('src/services/notificationService.js');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const dispatcher = read('cloudflare-v2/src/legacy/index.ts');
  assert.match(dashboard, /data-dashboard-notification-email/);
  assert.match(dashboard, /Email this list/);
  assert.match(service, /notifications\/low-stock-email/);
  assert.match(routes, /sendWorkspaceLowStockToUser\(env, workspaceId, auth\.email, locationId\)/);
  assert.match(routes, /assertLocationAccess\(env, auth, workspaceId, locationId/);
  assert.match(dispatcher, /resource === 'notifications\/low-stock-email'/);
});

test('Phase 56 Yoco recovery retries the oldest errored period automatically and from the admin console', () => {
  const yoco = read('cloudflare-v2/src/legacy/yoco-service.ts');
  const routes = read('cloudflare-v2/src/legacy/routes.ts');
  const worker = read('cloudflare-v2/src/index.ts');
  const admin = read('public/KCP Admin ConsoleByYOCO.html');
  assert.match(yoco, /MIN\(created_at\) AS earliest_error_at/);
  assert.match(yoco, /status IN \('failed', 'rejected'\)/);
  assert.match(yoco, /syncYocoSales\(env, workspaceId, \{ sinceIso \}\)/);
  assert.match(yoco, /SET status = 'processed'/);
  assert.match(routes, /automatic: true/);
  assert.match(routes, /action === "retry-failed-orders"/);
  assert.match(worker, /'retry-failed-orders'/);
  assert.match(admin, /Resync Errored Orders/);
  assert.match(admin, /retryAllErroredYocoOrders/);
});

test('Phase 56 trading time treats 04:59 as a 05:00 rollover and 23:59 as midnight', () => {
  assert.equal(normalizeTradingDayStartMinutes({ tradingTime: '04:59' }), 300);
  assert.equal(normalizeTradingDayStartMinutes({ tradingTime: '23:59' }), 0);
  const bounds = localDateRangeToUtcBounds({
    from: '2026-07-10',
    to: '2026-07-10',
    timeZone: 'Africa/Johannesburg',
    tradingDayStartMinutes: 300,
  });
  assert.equal(bounds.fromUtc, '2026-07-10T03:00:00.000Z');
  assert.equal(bounds.toExclusiveUtc, '2026-07-11T03:00:00.000Z');
  assert.equal(
    zonedTradingDateTimeStrings('2026-07-11T02:30:00.000Z', 'Africa/Johannesburg', 300).date,
    '2026-07-10',
  );
});

test('Phase 56 interactive and scheduled Today presets use the current trading date before 05:00', () => {
  const now = new Date('2026-07-11T02:30:00.000Z'); // 04:30 in Johannesburg.
  assert.deepEqual(
    resolveDateRangePreset('today', {
      now,
      timeZone: 'Africa/Johannesburg',
      tradingDayStartMinutes: 300,
    }),
    { dateRangeType: 'today', startDate: '2026-07-10', endDate: '2026-07-10' },
  );
  assert.deepEqual(
    resolveScheduledRelativeRange('today', {}, 'Africa/Johannesburg', now, 300),
    { from: '2026-07-10', to: '2026-07-10', startDate: '2026-07-10', endDate: '2026-07-10' },
  );
});

test('Phase 56 applies the trading boundary to core, purchasing and scheduled report sources', () => {
  const core = read('cloudflare-v2/src/legacy/reporting-routes.ts');
  const phase21 = read('cloudflare-v2/src/legacy/reporting-phase21-routes.ts');
  const scheduling = read('cloudflare-v2/src/legacy/report-scheduling-routes.ts');
  assert.match(core, /getWorkspaceReportingContext/);
  assert.match(core, /tradingDayStartMinutes: reportingContext\.tradingDayStartMinutes/);
  assert.match(phase21, /workspaceReportingContext/);
  assert.match(phase21, /tradingDayStartMinutes: number\(filters\.tradingDayStartMinutes\)/);
  assert.match(scheduling, /getScheduleTradingDayStartMinutes/);
  assert.match(scheduling, /resolveScheduledRelativeRange[\s\S]*tradingDayStartMinutes/);
});
