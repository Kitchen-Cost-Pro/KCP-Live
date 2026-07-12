import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatReportDateTime,
  formatReportTime,
  localDateRangeToUtcBounds,
  parseReportInstant,
  resolveReportTimestamp,
  zonedDateTimeStrings
} from './timezone.js';

test('report timestamps render in the configured workspace timezone', () => {
  const value = zonedDateTimeStrings('2026-07-10T16:38:00.000Z', 'Africa/Johannesburg');
  assert.equal(value.date, '2026-07-10');
  assert.equal(value.time, '18:38:00');
  assert.match(formatReportDateTime('2026-07-10T16:38:00.000Z', 'Africa/Johannesburg'), /18:38/);
});

test('timezone date filters convert local day boundaries to UTC', () => {
  const bounds = localDateRangeToUtcBounds({ from: '2026-07-10', to: '2026-07-10', timeZone: 'Africa/Johannesburg' });
  assert.equal(bounds.fromUtc, '2026-07-09T22:00:00.000Z');
  assert.equal(bounds.toExclusiveUtc, '2026-07-10T22:00:00.000Z');
});

test('timezone parser treats offset-less tenant timestamps as UTC', () => {
  assert.equal(parseReportInstant('2026-07-10 16:38:00')?.toISOString(), '2026-07-10T16:38:00.000Z');
});


test('report timestamp repair replaces artificial midnight with same-day creation time', () => {
  const repaired = resolveReportTimestamp('2026-07-11T00:00:00Z', '2026-07-11T13:42:00Z', 'Africa/Johannesburg');
  assert.equal(repaired, '2026-07-11T13:42:00Z');
  assert.equal(formatReportTime(repaired, 'Africa/Johannesburg', { includeSeconds: true }), '15:42:00');
});
