import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReportRuntimeIntegrity } from './reportRuntimeIntegrity.js';
import { calculateReportingReadiness } from './reportingReadiness.js';

const baseResult = {
  id: 'demo',
  report: { id: 'demo' },
  view: 'detail',
  columns: [
    { key: 'id', label: 'ID' },
    { key: 'locationName', label: 'Location' },
    { key: 'movementValue', label: 'Movement Value', type: 'money' }
  ],
  exportMapping: { id: 'ID', locationName: 'Location', movementValue: 'Movement Value' },
  rows: [{ id: '1', locationName: 'Bar', movementValue: 12.5 }],
  meta: { total: 1, allPagesLoaded: true }
};

test('complete report passes runtime integrity checks', () => {
  assert.deepEqual(validateReportRuntimeIntegrity(baseResult), []);
});

test('truncated source, duplicate ids and invalid money are critical', () => {
  const warnings = validateReportRuntimeIntegrity({
    ...baseResult,
    rows: [
      { id: '1', locationId: 'A', locationName: '', movementValue: 10 },
      { id: '1', locationId: 'A', locationName: '', movementValue: 'bad' }
    ],
    meta: { total: 4, truncated: true }
  });
  const codes = new Set(warnings.map((warning) => warning.code));
  assert.equal(codes.has('report-source-incomplete'), true);
  assert.equal(codes.has('report-row-count-mismatch'), true);
  assert.equal(codes.has('duplicate-report-rows'), true);
  assert.equal(codes.has('invalid-report-money-values'), true);
  assert.equal(codes.has('report-location-name-missing'), true);
});

test('readiness requires 9.5 or better with no critical blockers', () => {
  const healthy = calculateReportingReadiness([{ ...baseResult, allWarnings: [] }], { expectedReportCount: 1 });
  assert.equal(healthy.score, 10);
  assert.equal(healthy.readyForPilot, true);

  const blocked = calculateReportingReadiness([{ ...baseResult, allWarnings: [{ code: 'report-source-incomplete', level: 'critical', message: 'Incomplete' }] }], { expectedReportCount: 1 });
  assert.equal(blocked.readyForPilot, false);
  assert.ok(blocked.score < 9.5);
});
