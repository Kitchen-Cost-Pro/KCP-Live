import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const dashboardSource = fs.readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const dashboardCss = fs.readFileSync(new URL('./styles/dashboard.module.css', import.meta.url), 'utf8');
const mainCss = fs.readFileSync(new URL('./styles/main.css', import.meta.url), 'utf8');
const navigationCss = fs.readFileSync(new URL('./styles/navigation.module.css', import.meta.url), 'utf8');
const appShellCss = fs.readFileSync(new URL('./styles/appShell.module.css', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');

test('dashboard bell opens an accessible stock notification centre', () => {
  assert.match(dashboardSource, /aria-controls="dashboard-stock-notifications"/);
  assert.match(dashboardSource, /ui\.notificationsOpen = !ui\.notificationsOpen/);
  assert.match(dashboardSource, /function renderNotificationCenter\(/);
  assert.match(dashboardSource, /data-dashboard-notification-item/);
  assert.match(dashboardSource, /criticalItems\.length \+ lowItems\.length/);
  assert.match(dashboardSource, /data-dashboard-notification-settings/);
  assert.match(dashboardSource, /saveLowStockNotificationSettings/);
  assert.match(dashboardCss, /\.notificationMenu\s*\{/);
  assert.match(dashboardCss, /\.notificationCount\s*\{/);
});

test('restaurant backgrounds stay visible behind readable glass surfaces in both themes', () => {
  assert.match(mainCss, /--surface-primary: rgba\(255, 255, 255, 0\.92\)/);
  assert.match(mainCss, /--restaurant-theme-page-tint: rgba\(242, 245, 249, 0\.68\)/);
  assert.match(mainCss, /--surface-primary: rgba\(24, 30, 38, 0\.92\)/);
  assert.match(mainCss, /--restaurant-theme-page-tint: rgba\(15, 19, 25, 0\.66\)/);
  assert.match(navigationCss, /var\(--restaurant-theme-panel\) 72%/);
  assert.match(appShellCss, /var\(--restaurant-theme-background-image\)/);
  assert.doesNotMatch(appShellCss, /var\(--restaurant-theme-page-tint\), var\(--restaurant-theme-page-tint-soft\)\),\s*var\(--bg-primary\)/);
  assert.match(mainSource, /\['--surface-primary', isDark \? 0\.92 : 0\.92\]/);
  assert.match(mainSource, /--restaurant-theme-overlay', isDark \? 'rgba\(15, 19, 25, 0\.12\)'/);
});
