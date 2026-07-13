import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeSettings } from './services/settingsService.js';
import {
  localDateRangeToUtcBounds,
  normalizeTradingDayStartMinutes,
  zonedTradingDateTimeStrings
} from './modules/reporting/engine/timezone.js';

test('Phase 57 stores reporting days as aligned whole-hour boundaries', () => {
  const settings = normalizeSettings({
    reportingDayFromHour: 7,
    reportingDayToHour: 18,
    tradingTime: '17:45'
  });

  assert.equal(settings.reportingDayFromHour, 7);
  assert.equal(settings.reportingDayToHour, 7);
  assert.equal(settings.tradingDayStartHour, 7);
  assert.equal(settings.tradingDayStartMinutes, 420);
  assert.equal(settings.tradingTime, '06:59');
});

test('Phase 57 migrates legacy end-of-day settings into whole-hour From and To values', () => {
  const five = normalizeSettings({ tradingTime: '04:59' });
  const midnight = normalizeSettings({ tradingTime: '23:59' });

  assert.equal(five.reportingDayFromHour, 5);
  assert.equal(five.reportingDayToHour, 5);
  assert.equal(midnight.reportingDayFromHour, 0);
  assert.equal(midnight.reportingDayToHour, 0);
});

test('Phase 57 reporting engine supports every whole-hour boundary and only emits whole hours', () => {
  for (let hour = 0; hour < 24; hour += 1) {
    const settings = normalizeSettings({ reportingDayFromHour: hour, reportingDayToHour: hour });
    assert.equal(settings.reportingDayFromHour, hour);
    assert.equal(settings.reportingDayToHour, hour);
    assert.equal(normalizeTradingDayStartMinutes(settings), hour * 60);
  }
  assert.equal(normalizeTradingDayStartMinutes({ tradingDayStartMinutes: 455 }), 480);
});


test('Phase 57 every selectable hour creates one complete reporting day at the exact boundary', () => {
  for (let hour = 0; hour < 24; hour += 1) {
    const tradingDayStartMinutes = hour * 60;
    const bounds = localDateRangeToUtcBounds({
      from: '2026-07-10',
      to: '2026-07-10',
      timeZone: 'Africa/Johannesburg',
      tradingDayStartMinutes
    });
    assert.equal(new Date(bounds.toExclusiveUtc).getTime() - new Date(bounds.fromUtc).getTime(), 24 * 60 * 60 * 1000);
    assert.equal(
      zonedTradingDateTimeStrings(bounds.fromUtc, 'Africa/Johannesburg', tradingDayStartMinutes).date,
      '2026-07-10'
    );
    assert.equal(
      zonedTradingDateTimeStrings(new Date(new Date(bounds.fromUtc).getTime() - 1000), 'Africa/Johannesburg', tradingDayStartMinutes).date,
      '2026-07-09'
    );
  }
});

test('Phase 57 Business Settings exposes From and To hour selectors without minute controls', () => {
  const source = fs.readFileSync(new URL('./components/Settings.js', import.meta.url), 'utf8');
  assert.match(source, /Reporting Day Hours/);
  assert.match(source, /reportingDayFromHour/);
  assert.match(source, /reportingDayToHour/);
  assert.match(source, /Reports always cover a full 24-hour day/);
  assert.doesNotMatch(source, /renderTimeSelector\('tradingTime'/);
});
