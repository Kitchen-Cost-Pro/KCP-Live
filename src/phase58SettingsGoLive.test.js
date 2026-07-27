import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from './services/settingsService.js';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Phase 58 reporting hours use aligned custom whole-hour dropdowns', () => {
  const settings = read('src/components/Settings.js');
  const service = read('src/services/settingsService.js');
  const main = read('src/main.js');
  const css = read('src/styles/settings.css');
  assert.match(settings, /settingsFormField--wide settingsReportingHoursField/);
  assert.match(settings, /settingsReportingHourDropdown/);
  assert.match(settings, /renderSettingsDropdown\(\{/);
  assert.doesNotMatch(settings, /class="settingsTimePart settingsReportingHourSelect"/);
  assert.match(settings, /field === 'reportingDayFromHour' \|\| field === 'reportingDayToHour'/);
  assert.match(service, /getGoLiveReadiness/);
  assert.match(main, /goLiveReadiness/);
  assert.match(css, /grid-template-columns: auto minmax\(120px, 1fr\) auto auto minmax\(120px, 1fr\) auto/);
});

test('Phase 58 normalizes Go Live state and activation timestamp', () => {
  const enabledAt = '2026-07-13T15:30:00.000Z';
  const enabled = normalizeSettings({ stockDepletionEnabled: 'true', stockDepletionEnabledAt: enabledAt });
  const disabled = normalizeSettings({ stockDepletionEnabled: false, stockDepletionEnabledAt: enabledAt });
  assert.equal(enabled.stockDepletionEnabled, true);
  assert.equal(enabled.stockDepletionEnabledAt, enabledAt);
  assert.equal(disabled.stockDepletionEnabled, false);
  assert.equal(disabled.stockDepletionEnabledAt, '');
});

test('Phase 58 Go Live saves an activation instant while V2 effects fail closed on ownership', () => {
  const main = read('src/main.js');
  const ownership = read('cloudflare-v2/src/modules/yoco-engine-v2/ownership.ts');
  const saleRuntime = read('cloudflare-v2/src/modules/yoco-engine-v2/cutover.ts');
  const refundRuntime = read('cloudflare-v2/src/modules/yoco-engine-v2/refund-cutover.ts');
  const settings = read('src/components/Settings.js');
  assert.match(main, /stockDepletionEnabledAt: new Date\(\)\.toISOString\(\)/);
  assert.match(ownership, /assertAllYocoEffectsOwnedByV2/);
  assert.match(ownership, /YOCO_V2_OWNERSHIP_NOT_READY/);
  assert.match(saleRuntime, /engine_version/);
  assert.match(saleRuntime, /ownerIsV2/);
  assert.match(refundRuntime, /engine_version/);
  assert.match(refundRuntime, /ownerIsV2/);
  assert.match(settings, /Complete the checklist before enabling stock depletion/);
  assert.match(settings, /Going Live\.\.\./);
});
