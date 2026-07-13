import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./styles/reporting.css', import.meta.url), 'utf8');
const marker = 'Phase 42: Reporting table and filter theme alignment only';
const scopedTheme = css.slice(css.lastIndexOf(marker));

test('phase 42 only themes the report filter bar and main data table', () => {
  assert.match(scopedTheme, /\.reportingDashboard \.reportFilters\s*\{/);
  assert.match(scopedTheme, /\.reportingDashboard \.reportTableWrap\s*\{/);
  assert.match(scopedTheme, /\.reportingDashboard \.reportTable th\s*\{/);
  assert.match(scopedTheme, /\.reportingDashboard \.reportTable td\s*\{/);
});

test('phase 42 does not override reporting page, dashboard, header, tabs, cards, or background', () => {
  assert.doesNotMatch(scopedTheme, /\.reportingDashboard\s*,/);
  assert.doesNotMatch(scopedTheme, /\.reportingDashboard--miniBentoHome/);
  assert.doesNotMatch(scopedTheme, /\.reportHeader/);
  assert.doesNotMatch(scopedTheme, /\.reportViewTabs/);
  assert.doesNotMatch(scopedTheme, /\.reportTile/);
  assert.doesNotMatch(scopedTheme, /restaurant-theme-background-image/);
  assert.doesNotMatch(scopedTheme, /\.reportingDashboard\s*\{[^}]*background/s);
});
