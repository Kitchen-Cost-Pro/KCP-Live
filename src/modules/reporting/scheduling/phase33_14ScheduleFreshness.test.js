import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  addScheduledSourceCacheBuster,
  buildScheduledSourceHeaders,
  normalizeScheduledReportFilters,
  summarizeScheduledReportOutput
} from './scheduleExecutionFreshness.js';

const workerSource = fs.readFileSync(new URL('../../../../cloudflare-v2/src/legacy/report-scheduling-routes.ts', import.meta.url), 'utf8');
const schedulingPageSource = fs.readFileSync(new URL('./SchedulingPage.js', import.meta.url), 'utf8');

test('every scheduled report run replaces stale runtime filters with the current range and location', () => {
  const filters = normalizeScheduledReportFilters({
    reportId: 'wastage',
    scheduleFilters: { from: '2025-01-01', to: '2025-01-02', limit: 25, locationId: 'OLD', category: 'Food' },
    itemFilters: { offset: 500, pageSize: 100, sourceType: 'Adjustment' },
    range: { from: '2026-07-05', to: '2026-07-11', startDate: '2026-07-05', endDate: '2026-07-11' },
    dateRangeType: 'last_7_days',
    location: { id: 'LOC-NEW', name: 'Main Kitchen' }
  });

  assert.deepEqual(filters, {
    category: 'Food',
    sourceType: 'Adjustment',
    from: '2026-07-05',
    to: '2026-07-11',
    startDate: '2026-07-05',
    endDate: '2026-07-11',
    dateRangeType: 'last_7_days',
    locationId: 'LOC-NEW',
    locationName: 'Main Kitchen'
  });
});

test('old contradictory stock filters are repaired at execution for existing schedules', () => {
  const filters = normalizeScheduledReportFilters({
    reportId: 'stock_control',
    scheduleFilters: { onlyCritical: 'true', onlyBelowPar: 'true' },
    range: { from: '2026-07-11', to: '2026-07-11' },
    location: { id: 'LOC-1', name: 'Bar' }
  });
  assert.equal(filters.onlyCritical, undefined);
  assert.equal(filters.onlyBelowPar, 'true');
});

test('low-stock scheduling totals include both Low and Critical without zero short-circuiting', () => {
  const summary = summarizeScheduledReportOutput('stock_control', [], {
    lowStockItems: 0,
    criticalItems: 2
  });
  assert.equal(summary.lowStockCount, 2);

  const detailSummary = summarizeScheduledReportOutput('stock_control', [
    { status: 'Low' },
    { status: 'Critical' },
    { status: 'Healthy' }
  ], {});
  assert.equal(detailSummary.lowStockCount, 2);
});


test('fresh row data overrides stale zero aggregates for sales and wastage conditions', () => {
  const sales = summarizeScheduledReportOutput('payment_sales_financial', [
    { grossSales: 450 }
  ], { grossSales: 0 });
  assert.equal(sales.totalSales, 450);

  const wastage = summarizeScheduledReportOutput('wastage', [
    { wastageValue: 125.5 }
  ], { totalWastage: 0 });
  assert.equal(wastage.totalWastage, 125.5);
});

test('scheduled source requests are explicitly cache-free and unique per run/page', () => {
  const headers = buildScheduledSourceHeaders({ Authorization: 'Bearer token' }, 'rsr-123', 4);
  assert.match(headers.get('Cache-Control'), /no-store/);
  assert.equal(headers.get('Pragma'), 'no-cache');
  assert.equal(headers.get('X-KCP-Schedule-Run-Id'), 'rsr-123');

  const url = addScheduledSourceCacheBuster('https://example.com/reports', 'rsr-123', 4, 2000);
  assert.equal(url.searchParams.get('_scheduleRun'), 'rsr-123');
  assert.equal(url.searchParams.get('_sourceFetch'), '4:2000');
});

test('all run modes share the same fresh canonical execution path', () => {
  assert.match(workerSource, /executeSchedule\(request, env, auth, workspaceId, schedule, true\)/);
  assert.match(workerSource, /executeSchedule\(request, env, auth, workspaceId, temp, true, true\)/);
  assert.match(workerSource, /executeSchedule\(request, env, auth, workspaceId, schedule, false\)/);
  assert.match(workerSource, /normalizeScheduledReportFilters/);
  assert.match(workerSource, /buildScheduledSourceHeaders/);
  assert.match(workerSource, /addScheduledSourceCacheBuster/);
  assert.match(workerSource, /summarizeScheduledReportOutput/);
  assert.match(workerSource, /sourceGeneratedAt/);
  assert.match(workerSource, /Data refreshed:/);
});

test('new Stock Controller templates no longer save contradictory filters', () => {
  assert.doesNotMatch(schedulingPageSource, /filters:\s*\{\s*onlyCritical:\s*'true',\s*onlyBelowPar:\s*'true'\s*\}/);
  assert.match(schedulingPageSource, /filters:\s*\{\s*onlyBelowPar:\s*'true'\s*\}/);
});
