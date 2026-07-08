import styles from './styles/dashboard.module.css';
import './styles/yds-tokens.css';
import { calculateDashboardMetrics, getTradeDateKey } from './services/database.js';
import { shiftMonthKey, startOfMonthKey, todayLocal } from './utils/date.js';
import { buildCalendarModel, formatDisplayDate } from './utils/date.js';

export function renderDashboard({
  state,
  onThemeToggle,
  onDashboardRangeChange,
  onDashboardSiteChange,
  onDashboardLocationChange,
  onDashboardRefresh,
  onDashboardChartTab,
  onNavigate
}) {
  const view = document.createElement('section');
  view.className = `${styles.dashboardShell} ydsDashboard`;

  const activeWorkspace = state.workspace || {};
  const selectedSite = getSelectedDashboardSite(state);
  const siteName = selectedSite?.name || state.dashboard?.siteName || state.source?.settings?.siteName || activeWorkspace.siteName || 'Workspace';

  view.innerHTML = `
    <header class="${styles.header}">
      <div>
        <p class="${styles.eyebrow}">Kitchen Cost Pro</p>
        <h1>Dashboard</h1>
        <p class="${styles.subtitle}">${escapeHtml(siteName)} · Live workspace data</p>
      </div>
      <div class="${styles.headerActions}">
        ${renderHeaderUtilities(state)}
      </div>
    </header>

    ${state.workspaceError ? renderWorkspaceError(state.workspaceError) : renderDashboardGrid(state)}
  `;

  const rangeDraft = { ...getRangeInputDates(parseDashboardRange(state.dashboardRange || '7'), state.source?.settings) };
  let rangeCalendar = null;
  const rangeCalendarRoot = document.createElement('div');
  rangeCalendarRoot.dataset.dashboardCalendarRoot = 'true';
  view.append(rangeCalendarRoot);

  const renderRangeCalendar = () => {
    if (!rangeCalendar) {
      rangeCalendarRoot.innerHTML = '';
      return;
    }

    rangeCalendarRoot.innerHTML = renderRangeCalendarOverlay(rangeDraft, rangeCalendar);

    rangeCalendarRoot.querySelectorAll('[data-dashboard-calendar-close]').forEach((button) => {
      button.addEventListener('click', () => {
        rangeCalendar = null;
        renderRangeCalendar();
      });
    });

    rangeCalendarRoot.querySelectorAll('[data-dashboard-calendar-nav]').forEach((button) => {
      button.addEventListener('click', () => {
        rangeCalendar = {
          ...rangeCalendar,
          cursor: shiftMonthKey(rangeCalendar.cursor || rangeDraft.startDate || todayLocal(), Number(button.dataset.dashboardCalendarNav || 0))
        };
        renderRangeCalendar();
      });
    });

    rangeCalendarRoot.querySelectorAll('[data-dashboard-calendar-edge]').forEach((button) => {
      button.addEventListener('click', () => {
        rangeCalendar = {
          ...rangeCalendar,
          activeEdge: button.dataset.dashboardCalendarEdge || 'start'
        };
        renderRangeCalendar();
      });
    });

    rangeCalendarRoot.querySelectorAll('[data-dashboard-calendar-day]').forEach((button) => {
      button.addEventListener('click', () => {
        const date = button.dataset.dashboardCalendarDay || todayLocal();
        if (rangeCalendar.activeEdge === 'end') {
          rangeDraft.endDate = date;
          if (rangeDraft.startDate && date < rangeDraft.startDate) {
            rangeDraft.endDate = rangeDraft.startDate;
            rangeDraft.startDate = date;
          }
          rangeCalendar = { ...rangeCalendar, activeEdge: 'start' };
        } else {
          rangeDraft.startDate = date;
          rangeDraft.endDate = date;
          rangeCalendar = { ...rangeCalendar, activeEdge: 'end' };
        }
        renderRangeCalendar();
      });
    });

    rangeCalendarRoot.querySelectorAll('[data-dashboard-calendar-preset]').forEach((button) => {
      button.addEventListener('click', () => {
        onDashboardRangeChange?.(button.dataset.dashboardCalendarPreset || '7');
        rangeCalendar = null;
        renderRangeCalendar();
      });
    });

    rangeCalendarRoot.querySelector('[data-dashboard-calendar-today]')?.addEventListener('click', () => {
      const date = todayLocal();
      if (rangeCalendar.activeEdge === 'end') {
        rangeDraft.endDate = date;
        if (rangeDraft.startDate && date < rangeDraft.startDate) {
          rangeDraft.endDate = rangeDraft.startDate;
          rangeDraft.startDate = date;
        }
        rangeCalendar = { ...rangeCalendar, activeEdge: 'start' };
      } else {
        rangeDraft.startDate = date;
        rangeDraft.endDate = date;
        rangeCalendar = { ...rangeCalendar, activeEdge: 'end' };
      }
      renderRangeCalendar();
    });

    rangeCalendarRoot.querySelector('[data-dashboard-calendar-apply]')?.addEventListener('click', () => {
      if (rangeDraft.startDate && rangeDraft.endDate) {
        onDashboardRangeChange?.(`custom:${rangeDraft.startDate}:${rangeDraft.endDate}`);
      }
      rangeCalendar = null;
      renderRangeCalendar();
    });

    rangeCalendarRoot.querySelector('[data-dashboard-calendar-overlay]')?.addEventListener('click', (event) => {
      if (event.target !== event.currentTarget) return;
      rangeCalendar = null;
      renderRangeCalendar();
    });
  };

  view.querySelector('[data-theme-toggle]')?.addEventListener('click', () => onThemeToggle?.());
  view.querySelector('[data-dashboard-refresh]')?.addEventListener('click', () => onDashboardRefresh?.());

  // Site / location selector rendered as a fixed-position modal so it is never clipped
  // by the shell's `overflow: hidden` (the old inline dropdown was being cut off).
  let selectorPicker = null;
  const selectorRoot = document.createElement('div');
  selectorRoot.dataset.dashboardSelectorRoot = 'true';
  view.append(selectorRoot);

  const renderSelector = () => {
    if (!selectorPicker) {
      selectorRoot.innerHTML = '';
      return;
    }
    selectorRoot.innerHTML = renderSelectorModal(selectorPicker, state);
    selectorRoot.querySelector('[data-dashboard-selector-overlay]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        selectorPicker = null;
        renderSelector();
      }
    });
    selectorRoot.querySelector('[data-dashboard-selector-close]')?.addEventListener('click', () => {
      selectorPicker = null;
      renderSelector();
    });
    selectorRoot.querySelectorAll('[data-dashboard-selector-option]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.dashboardSelectorOption || '';
        if (selectorPicker.type === 'site') onDashboardSiteChange?.(value);
        else onDashboardLocationChange?.(value);
        selectorPicker = null;
        renderSelector();
      });
    });
  };

  view.querySelector('[data-dashboard-site-trigger]')?.addEventListener('click', () => {
    selectorPicker = { type: 'site' };
    renderSelector();
  });
  view.querySelector('[data-dashboard-location-trigger]')?.addEventListener('click', () => {
    selectorPicker = { type: 'location' };
    renderSelector();
  });

  view.querySelector('[data-dashboard-calendar-open]')?.addEventListener('click', () => {
    rangeCalendar = {
      cursor: startOfMonthKey(rangeDraft.startDate || todayLocal()),
      activeEdge: 'start'
    };
    renderRangeCalendar();
  });
  view.querySelectorAll('[data-dashboard-target]').forEach((button) => {
    button.addEventListener('click', (event) => {
      onNavigate?.(event.currentTarget.dataset.dashboardTarget);
    });
  });

  view.querySelectorAll('[data-dashboard-chart-tab]').forEach((button) => {
    button.addEventListener('click', (event) => {
      onDashboardChartTab?.(event.currentTarget.dataset.dashboardChartTab || 'costOfSales');
    });
  });

  // Initialise the Movement chart (Chart.js canvas) after this dashboard node is mounted.
  requestAnimationFrame(() => { initMovementChart().catch(() => {}); });

  return view;
}

// The dashboard is rebuilt wholesale on every render, so the Chart.js instance is tracked
// module-side and destroyed before each re-create (prevents orphaned instances / leaks).
let movementChart = null;
let movementChartLib = null;

async function loadChartLib() {
  if (movementChartLib) return movementChartLib;
  const mod = await import('chart.js');
  const { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip } = mod;
  Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);
  movementChartLib = Chart;
  return Chart;
}

async function initMovementChart() {
  // Tear down any prior instance first (fresh node every render).
  if (movementChart) { try { movementChart.destroy(); } catch { /* noop */ } movementChart = null; }
  const canvas = document.querySelector('[data-movement-chart]');
  if (!canvas || !document.body.contains(canvas)) return;

  let points = [];
  try { points = JSON.parse(canvas.getAttribute('data-series') || '[]'); } catch { points = []; }
  const tone = canvas.getAttribute('data-tone') || 'blue';
  const format = canvas.getAttribute('data-format') || 'number';

  const Chart = await loadChartLib();
  // A newer render may have replaced the canvas while the lib was loading.
  if (!Chart || !document.body.contains(canvas)) return;

  const cs = getComputedStyle(document.documentElement);
  const accent = resolveToneColor(cs, tone);
  const textColor = (cs.getPropertyValue('--text-soft') || '').trim() || '#94a3b8';
  const gridColor = 'rgba(148, 163, 184, 0.16)';

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 240);
  gradient.addColorStop(0, hexToRgba(accent, 0.28));
  gradient.addColorStop(1, hexToRgba(accent, 0.02));

  movementChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map((point) => point.label),
      datasets: [{
        data: points.map((point) => Number(point.value) || 0),
        borderColor: accent,
        borderWidth: 2.5,
        fill: true,
        backgroundColor: gradient,
        // monotone interpolation is smooth but never overshoots below the baseline (the old bug)
        cubicInterpolationMode: 'monotone',
        tension: 0.35,
        pointRadius: points.length > 40 ? 0 : 3,
        pointHoverRadius: 6,
        pointBackgroundColor: accent,
        pointBorderColor: '#ffffff',
        pointBorderWidth: 1.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: 'rgba(2, 6, 23, 0.92)',
          padding: 10,
          titleColor: '#e2e8f0',
          bodyColor: '#ffffff',
          callbacks: { label: (item) => formatCompactChartValue(item.parsed.y, format) }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: textColor, maxTicksLimit: 6, autoSkip: true, maxRotation: 0, font: { size: 11, weight: '700' } }
        },
        y: {
          grid: { color: gridColor },
          border: { display: false },
          ticks: { color: textColor, maxTicksLimit: 4, font: { size: 11, weight: '700' }, callback: (val) => formatCompactChartValue(val, format) }
        }
      }
    }
  });
}

function resolveToneColor(cs, tone) {
  const map = {
    indigo: '--accent-indigo',
    blue: '--accent-blue',
    amber: '--accent-amber',
    emerald: '--accent-emerald',
    red: '--accent-red',
    orange: '--accent-orange'
  };
  const value = (cs.getPropertyValue(map[tone] || '--accent-blue') || '').trim();
  return value || (cs.getPropertyValue('--accent-blue') || '').trim() || '#0099e0';
}

function hexToRgba(color, alpha) {
  const hex = String(color).trim().replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${alpha})`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `rgba(${parseInt(hex[0] + hex[0], 16)}, ${parseInt(hex[1] + hex[1], 16)}, ${parseInt(hex[2] + hex[2], 16)}, ${alpha})`;
  }
  return String(color).trim(); // rgb()/hsl()/named — use as-is
}

function renderDashboardGrid(state) {
  const summary = getEffectiveDashboardSummary(state);
  const isLiveReady = hasDashboardLiveSummary(state);
  const insights = buildDashboardInsights(state, summary);
  const deltas = state.dashboard?.metrics?.deltas || {};

  return `
    <div class="${styles.dashboardContent} ${styles.ydsContent}">
      ${renderPendingExternalTransferBanner(insights)}

      <section class="${styles.ydsKpiRow}" aria-label="Key metrics">
        ${renderKpiCard({ label: 'Stock on Hand', value: metricDisplay(summary, 'totalStockValue', 'currency'), icon: 'cube', tone: 'blue', deltaPct: deltas.stockValue, sparkKey: 'stockValue', sparkFormat: 'currency', state, target: 'stock' })}
        ${renderKpiCard({ label: 'Cost of Sales', value: metricDisplay(summary, 'costOfSales', 'currency'), icon: 'receipt', tone: 'indigo', deltaPct: deltas.costOfSales, deltaInverse: true, sparkKey: 'costOfSales', sparkFormat: 'currency', state })}
        ${renderKpiCard({ label: 'Low Stock Alerts', value: isLiveReady ? metricDisplay(summary, 'lowStockCount', 'number') : '…', icon: 'bell', tone: 'amber', status: isLiveReady ? (insights.lowStockCount > 0 ? 'Attention' : 'Healthy') : 'Syncing', statusTone: isLiveReady ? (insights.lowStockCount > 0 ? 'attention' : 'good') : 'neutral', target: 'low-stock-alerts' })}
        ${renderKpiCard({ label: 'Suppliers Active', value: isLiveReady ? String(insights.activeSuppliers) : '…', icon: 'team', tone: 'emerald', status: isLiveReady ? 'Healthy' : 'Syncing', statusTone: isLiveReady ? 'good' : 'neutral', target: 'suppliers' })}
      </section>

      <section class="${styles.ydsMainGrid}">
        ${renderMovementChartPanel(state)}
        <article class="${styles.ydsPanel} ${styles.snapshotPanel}">
          <div class="${styles.panelHeader}"><h2>Operational Snapshot</h2></div>
          <div class="${styles.snapshotGrid}">
            ${renderSnapshotCard('POs Open', isLiveReady ? insights.openPurchaseOrders : '…', 'receipt', 'blue')}
            ${renderSnapshotCard('GRVs Pending', isLiveReady ? insights.grvsPending : '…', 'receipt', 'amber')}
            ${renderSnapshotCard('Stock Takes Due', isLiveReady ? insights.stockTakesDue : '…', 'variance', 'indigo')}
            ${renderSnapshotCard('Recipes Active', isLiveReady ? insights.recipesUpdated : '…', 'cube', 'emerald')}
          </div>
        </article>
      </section>

      <section class="${styles.ydsMainGrid}">
        <article class="${styles.ydsPanel}">
          <div class="${styles.panelHeader}"><h2>Operational Values</h2></div>
          <div class="${styles.operationalValueGrid}">
            ${renderOperationalValue('Opening Stock', metricDisplay(summary, 'openingStock', 'currency'), 'cube', 'blue')}
            ${renderOperationalValue('Closing Stock', metricDisplay(summary, 'closingStock', 'currency'), 'cube', 'emerald')}
            ${renderOperationalValue('Cost of Sales', metricDisplay(summary, 'costOfSales', 'currency'), 'receipt', 'red')}
            ${renderOperationalValue('Count Variances', metricDisplay(summary, 'countVariance', 'currency'), 'variance', 'indigo')}
            ${renderOperationalValue('Manual Adjustments', metricDisplay(summary, 'manualAdjustments', 'currency'), 'sliders', 'orange')}
            ${renderOperationalValue('Wastage', metricDisplay(summary, 'wastage', 'currency'), 'trash', 'red')}
            ${renderOperationalValue('Manufacturing Wastage', metricDisplay(summary, 'manufacturingWastage', 'currency'), 'trash', 'red')}
          </div>
        </article>

        <article class="${styles.ydsPanel} ${styles.recentPanel}">
          <div class="${styles.panelHeader}">
            <h2>Recent Activity</h2>
            <button type="button" data-dashboard-target="analytics">View all</button>
          </div>
          ${isLiveReady ? renderRecentActivity(insights.recentActivity) : renderDashboardPendingState()}
        </article>
      </section>

      <section class="${styles.ydsFullRow}">
        <article class="${styles.ydsPanel} ${styles.lowStockPanel}">
          <div class="${styles.panelHeader}">
            <h2>Low Stock Alerts</h2>
            <button type="button" data-dashboard-target="low-stock-alerts">View all</button>
          </div>
          ${isLiveReady ? renderLowStockTable(insights.lowStockRows) : renderDashboardPendingState()}
        </article>
      </section>
    </div>
  `;
}

function renderKpiCard({ label, value, icon, tone, deltaPct, deltaInverse = false, sparkKey, sparkFormat = 'currency', state, status, statusTone, target }) {
  // KPI cards show only the delta badge in the footer; the inline SVG sparkline was removed
  // (it cluttered the layout / clashed with the Movement chart). The Chart.js Movement chart is separate.
  const foot = sparkKey
    ? `${renderDeltaBadge(deltaPct, deltaInverse)}`
    : (status ? statusBadge(status, statusTone) : '');
  return `
    <article class="${styles.ydsKpiCard} ${styles[`stat_${tone}`] || ''}" ${target ? `data-dashboard-target="${escapeAttribute(target)}"` : ''}>
      <div class="${styles.ydsKpiHead}">
        <span class="${styles.ydsKpiLabel}">${escapeHtml(label)}</span>
        <span class="${styles.ydsKpiIcon}">${tileIcon(icon)}</span>
      </div>
      <strong class="${styles.ydsKpiValue}">${escapeHtml(String(value))}</strong>
      <div class="${styles.ydsKpiFoot}">${foot}</div>
    </article>
  `;
}

function renderDeltaBadge(deltaPct, inverse = false) {
  const value = Number(deltaPct);
  if (deltaPct === null || deltaPct === undefined || !Number.isFinite(value)) {
    return `<span class="${styles.ydsDelta} ${styles.ydsDeltaFlat}">—</span>`;
  }
  const up = value >= 0;
  // For metrics where "up is bad" (e.g. cost of sales), invert the good/bad tone.
  const good = inverse ? !up : up;
  const toneClass = good ? styles.ydsDeltaUp : styles.ydsDeltaDown;
  return `<span class="${styles.ydsDelta} ${toneClass}">${up ? '▲' : '▼'} ${Math.abs(value).toFixed(1)}%</span>`;
}

function renderMovementChartPanel(state) {
  const tabs = [
    { key: 'costOfSales', label: 'Cost of Sales', tone: 'blue', format: 'currency' },
    { key: 'stockValue', label: 'Stock Value', tone: 'emerald', format: 'currency' },
    { key: 'wastage', label: 'Wastage', tone: 'red', format: 'currency' },
    { key: 'manufacturingWastage', label: 'Manufacturing Wastage', tone: 'orange', format: 'currency' }
  ];
  const active = tabs.find((tab) => tab.key === (state.dashboardChartTab || 'costOfSales')) || tabs[0];
  return `
    <article class="${styles.ydsPanel} ${styles.ydsChartPanel}">
      <div class="${styles.ydsChartHead}">
        <h2>Movement</h2>
        <div class="${styles.ydsChartTabs}" role="tablist">
          ${tabs.map((tab) => `
            <button type="button" role="tab" aria-selected="${tab.key === active.key}"
              class="${styles.ydsChartTab} ${tab.key === active.key ? styles.ydsChartTabActive : ''}"
              data-dashboard-chart-tab="${escapeAttribute(tab.key)}">${escapeHtml(tab.label)}</button>
          `).join('')}
        </div>
      </div>
      <div class="${styles.ydsChartBody}">
        ${renderDashboardChart(state, active.key, { tone: active.tone, format: active.format })}
      </div>
    </article>
  `;
}

function renderPendingExternalTransferBanner(insights = {}) {
  const count = Number(insights.pendingExternalTransfers || 0) || 0;
  if (!count) return '';
  const first = toArray(insights.pendingExternalTransferRows)[0] || {};
  return `
    <section class="${styles.pendingTransferBanner}" aria-label="Pending external transfer alert">
      <div class="${styles.pendingTransferLabel}">
        <span aria-hidden="true"></span>
        Transfer Alert
      </div>
      <div class="${styles.pendingTransferMarquee}">
        <strong>${count} external transfer${count === 1 ? '' : 's'} awaiting receipt</strong>
        <span>${escapeHtml(first.fromSiteName || 'A linked site')} sent stock${first.lineCount ? ` · ${first.lineCount} item${first.lineCount === 1 ? '' : 's'}` : ''}. Count and accept it before it enters on-hand stock.</span>
      </div>
      <button type="button" data-dashboard-target="transfers">Review Transfers</button>
    </section>
  `;
}

function hasDashboardLiveSummary(state) {
  const summary = state.dashboard?.metrics?.summary;
  return Boolean(summary && Object.keys(summary).length);
}

function renderTopStatCard({ label, value, icon, tone, status, statusTone, target }) {
  return `
    <article class="${styles.topStatCard} ${styles[`stat_${tone}`]}" ${target ? `data-dashboard-target="${escapeAttribute(target)}"` : ''}>
      <div class="${styles.topStatIcon}" aria-hidden="true">${tileIcon(icon)}</div>
      <p>${escapeHtml(label)}</p>
      <strong>${escapeHtml(value)}</strong>
      ${statusBadge(status, statusTone)}
    </article>
  `;
}

function renderOperationalValue(label, value, icon, tone) {
  return `
    <div class="${styles.operationalValue} ${styles[`stat_${tone}`]}">
      <span aria-hidden="true">${tileIcon(icon)}</span>
      <p>${escapeHtml(label)}</p>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderDashboardPendingState() {
  return `
    <div class="${styles.emptyPanelState}">
      <strong>Waiting for live summary</strong>
      <span>Kitchen Cost Pro is loading the current dashboard state.</span>
    </div>
  `;
}

function renderPriorityAction(title, detail, icon, tone, action, target) {
  return `
    <button type="button" class="${styles.priorityAction} ${styles[`stat_${tone}`]}" data-dashboard-target="${escapeAttribute(target)}">
      <span class="${styles.priorityIcon}" aria-hidden="true">${tileIcon(icon)}</span>
      <span class="${styles.priorityText}">
        <strong>${escapeHtml(title)}</strong>
        <em>${escapeHtml(detail)}</em>
      </span>
      <span class="${styles.priorityButton}">${escapeHtml(action)}</span>
    </button>
  `;
}

function renderLowStockTable(rows = []) {
  if (!rows.length) {
    return `
      <div class="${styles.emptyPanelState}">
        <strong>No low stock items</strong>
        <span>Everything is currently above threshold.</span>
      </div>
    `;
  }

  const alertGlyph = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  const fmtQty = (n) => (Number.isInteger(n) ? String(n) : String(Number(Number(n).toFixed(2))));
  return `
    <div class="${styles.ydsLowStock}">
      <div class="${styles.ydsLowStockHead}">
        <span>Item</span>
        <span>Stock Level</span>
        <span>Severity</span>
        <span>Action</span>
      </div>
      ${rows.slice(0, 6).map((row) => {
        // Tolerate both server rows (locationName/currentStock/severity) and client rows.
        const location = row.location || row.locationName || 'All locations';
        const current = Number(row.currentStock ?? row.stock ?? 0) || 0;
        const par = Number(row.threshold ?? row.par ?? row.parLevel ?? 0) || 0;
        const unit = String(row.unit || '').trim();
        const severityLabel = row.severity || row.severityLabel || 'Low';
        const tone = row.severityTone || String(severityLabel).toLowerCase();
        const sevClass = ['critical', 'medium', 'low'].includes(tone) ? tone : 'low';
        const pct = par > 0 ? Math.max(4, Math.min(100, Math.round((current / par) * 100))) : 100;
        return `
        <div class="${styles.ydsLowStockRow}">
          <div class="${styles.ydsLowStockItem}">
            <strong>${escapeHtml(row.name || row.item || 'Unnamed item')}</strong>
            <span>${escapeHtml(location)}</span>
          </div>
          <div class="${styles.ydsLowStockLevel}">
            <div class="${styles.ydsLowStockLevelTop}">
              <span>${escapeHtml(fmtQty(current))}${unit ? ` ${escapeHtml(unit)}` : ''}</span>
              <span>par ${escapeHtml(fmtQty(par))}</span>
            </div>
            <div class="${styles.ydsLowStockBar}"><div class="${styles.ydsLowStockBarFill} ${styles[`ydsSev_${sevClass}`]}" style="width:${pct}%"></div></div>
          </div>
          <div>
            <span class="${styles.ydsSevPill} ${styles[`ydsSev_${sevClass}`]}">${alertGlyph}${escapeHtml(severityLabel)}</span>
          </div>
          <div class="${styles.ydsLowStockAction}">
            <button type="button" data-dashboard-target="low-stock-alerts">Reorder</button>
          </div>
        </div>
      `;
      }).join('')}
    </div>
  `;
}

function renderRecentActivity(entries = []) {
  if (!entries.length) {
    return `
      <div class="${styles.emptyPanelState}">
        <strong>No recent activity</strong>
        <span>New sales, GRVs, adjustments, and stock takes will appear here.</span>
      </div>
    `;
  }

  return `
    <div class="${styles.activityList}">
      ${entries.slice(0, 5).map((entry) => `
        <div class="${styles.activityRow}">
          <span class="${styles.activityIcon} ${styles[`stat_${entry.tone}`]}" aria-hidden="true">${tileIcon(entry.icon)}</span>
          <time>${escapeHtml(entry.time)}</time>
          <strong>${escapeHtml(entry.title)}</strong>
          <em>${escapeHtml(entry.detail)}</em>
        </div>
      `).join('')}
    </div>
  `;
}

function renderSnapshotCard(label, value, icon, tone) {
  return `
    <button type="button" class="${styles.snapshotCard} ${styles[`stat_${tone}`]}" data-dashboard-target="${snapshotTarget(label)}">
      <span aria-hidden="true">${tileIcon(icon)}</span>
      <strong>${escapeHtml(value)}</strong>
      <em>${escapeHtml(label)}</em>
    </button>
  `;
}

function statusBadge(label, tone) {
  return `<span class="${styles.statusBadge} ${styles[`badge_${tone}`]}"><i></i>${escapeHtml(label)}</span>`;
}

function buildDashboardInsights(state, summary) {
  const liveInsights = state.dashboard?.insights;
  if (liveInsights && Object.keys(liveInsights).length) {
    return {
      lowStockRows: toArray(liveInsights.lowStockRows),
      lowStockCount: Number(liveInsights.lowStockCount ?? summary.lowStockCount?.raw ?? 0) || 0,
      openPurchaseOrders: Number(liveInsights.openPurchaseOrders || 0) || 0,
      activeSuppliers: Number(liveInsights.activeSuppliers || 0) || 0,
      grvsPending: Number(liveInsights.grvsPending || 0) || 0,
      stockTakesDue: Number(liveInsights.stockTakesDue || 0) || 0,
      recipesUpdated: Number(liveInsights.recipesUpdated || 0) || 0,
      pendingExternalTransfers: Number(liveInsights.pendingExternalTransfers || 0) || 0,
      pendingExternalTransferRows: toArray(liveInsights.pendingExternalTransferRows),
      recentActivity: normalizeDashboardActivityRows(liveInsights.recentActivity)
    };
  }

  const source = state.source || {};
  const lowStockRows = buildLowStockRows(source);
  const purchaseOrders = toArray(source.purchaseOrders);
  const suppliers = toArray(source.suppliers);
  const products = Object.values(source.products || {});
  const stockTakes = toArray(source.stockTakes);
  const stockTakeTemplates = toArray(source.stockTakeTemplates);
  const openPurchaseOrders = purchaseOrders.filter(isOpenPurchaseOrder).length;

  return {
    lowStockRows,
    lowStockCount: Number(summary.lowStockCount?.raw ?? lowStockRows.length) || 0,
    openPurchaseOrders,
    activeSuppliers: suppliers.filter((supplier) => !isArchived(supplier)).length,
    grvsPending: purchaseOrders.filter(isPendingGrvPurchaseOrder).length,
    stockTakesDue: stockTakeTemplates.length || stockTakes.filter(isOpenStockTake).length,
    recipesUpdated: products.filter((product) => toArray(product.recipe).length > 0).length,
    pendingExternalTransfers: 0,
    pendingExternalTransferRows: [],
    recentActivity: buildRecentActivity(source)
  };
}

function normalizeDashboardActivityRows(rows = []) {
  return toArray(rows)
    .map((row) => {
      const type = String(row.type || row.activityType || '').toLowerCase();
      const stamp = getActivityStamp(row);
      const defaults = activityDefaults(type);
      return {
        ...row,
        stamp,
        time: row.time || formatActivityTime(stamp),
        title: row.title || defaults.title,
        detail: row.detail || row.location || row.locationName || row.itemName || row.supplierName || row.reference || 'Workspace activity',
        icon: row.icon || defaults.icon,
        tone: row.tone || defaults.tone
      };
    })
    .filter((entry) => entry.stamp > 0 || entry.title)
    .sort((left, right) => Number(right.stamp || 0) - Number(left.stamp || 0))
    .slice(0, 8);
}

function activityDefaults(type = '') {
  if (type.includes('sale')) return { title: 'Sale Synced', icon: 'receipt', tone: 'emerald' };
  if (type.includes('grv')) return { title: 'GRV Received', icon: 'receipt', tone: 'amber' };
  if (type.includes('adjust')) return { title: 'Manual Adjustment Added', icon: 'sliders', tone: 'orange' };
  if (type.includes('stocktake') || type.includes('stock-take')) return { title: 'Stock Count Completed', icon: 'variance', tone: 'blue' };
  if (type.includes('transfer')) return { title: 'Transfer Posted', icon: 'cube', tone: 'indigo' };
  if (type.includes('manufact')) return { title: 'Manufacturing Posted', icon: 'cube', tone: 'emerald' };
  if (type.includes('purchase')) return { title: 'Purchase Order Updated', icon: 'receipt', tone: 'blue' };
  return { title: 'Workspace Activity', icon: 'receipt', tone: 'blue' };
}

function metricDisplay(summary, key, type) {
  const metric = summary?.[key];
  if (!metric) return '...';
  if (metric.value) return metric.value;
  return formatDashboardMetric(0, type);
}

function buildLowStockRows(source = {}) {
  const locations = toArray(source.locations);
  return toArray(source.ingredients)
    .filter((item) => !isArchived(item))
    .map((item) => {
      const threshold = Number(item.lowStockThreshold || item.threshold || 5) || 5;
      const stock = Number(item.stock || 0) || 0;
      const severity = getLowStockSeverity(stock, threshold);
      return {
        id: item.id,
        name: item.name || item.itemName || 'Unnamed item',
        location: resolveLowStockLocation(item, locations),
        stock,
        threshold,
        severity: severity.label,
        severityTone: severity.tone
      };
    })
    .filter((item) => item.stock < item.threshold)
    .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name));
}

function resolveLowStockLocation(item = {}, locations = []) {
  const balances = item.balances && typeof item.balances === 'object' ? item.balances : null;
  if (balances) {
    const lowest = Object.entries(balances)
      .map(([locationId, qty]) => ({ locationId, qty: Number(qty || 0) }))
      .sort((a, b) => a.qty - b.qty)[0];
    if (lowest?.locationId) return getLocationName(locations, lowest.locationId);
  }
  return getLocationName(locations, item.locationId || item.location || item.storeLocationId || '');
}

function getLowStockSeverity(stock, threshold) {
  if (stock <= 0 || stock <= threshold * 0.25) return { label: 'Critical', tone: 'critical' };
  if (stock <= threshold * 0.6) return { label: 'Medium', tone: 'medium' };
  return { label: 'Low', tone: 'low' };
}

function buildRecentActivity(source = {}) {
  const entries = [
    ...toArray(source.logs_stocktakes).map((entry) => activityEntry(entry, 'Stock Count Completed', 'variance', 'blue')),
    ...toArray(source.logs_grv).map((entry) => activityEntry(entry, 'GRV Received', 'receipt', 'amber')),
    ...toArray(source.logs_adj).map((entry) => activityEntry(entry, 'Manual Adjustment Added', 'sliders', 'orange')),
    ...toArray(source.logs_sales).map((entry) => activityEntry(entry, 'Sale Synced', 'receipt', 'emerald')),
    ...toArray(source.logs_transfers).map((entry) => activityEntry(entry, 'Transfer Posted', 'cube', 'indigo'))
  ];

  return entries
    .filter((entry) => entry.stamp > 0)
    .sort((a, b) => b.stamp - a.stamp)
    .slice(0, 8);
}

function activityEntry(entry = {}, fallbackTitle, icon, tone) {
  const stamp = getActivityStamp(entry);
  return {
    stamp,
    time: formatActivityTime(stamp),
    title: entry.title || entry.action || entry.type || fallbackTitle,
    detail: entry.locationName || entry.supplierName || entry.itemName || entry.note || entry.reference || 'Workspace activity',
    icon,
    tone
  };
}

function getActivityStamp(entry = {}) {
  return getTimestamp(entry.timestamp || entry.createdAt || entry.updatedAt || entry.date || entry.tradeDate);
}

function formatActivityTime(stamp) {
  if (!stamp) return '--:--';
  const now = new Date();
  const date = new Date(stamp);
  const isToday = now.toDateString() === date.toDateString();
  if (isToday) {
    return new Intl.DateTimeFormat('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  return new Intl.DateTimeFormat('en-ZA', { day: '2-digit', month: 'short' }).format(date);
}

function isOpenPurchaseOrder(order = {}) {
  const status = String(order.status || order.state || '').trim().toLowerCase();
  return !['closed', 'complete', 'completed', 'cancelled', 'canceled', 'received', 'deleted', 'archived'].includes(status);
}

function isPendingGrvPurchaseOrder(order = {}) {
  const status = String(order.status || order.state || '').trim().toLowerCase();
  return isOpenPurchaseOrder(order) && !['draft'].includes(status);
}

function isOpenStockTake(entry = {}) {
  const status = String(entry.status || entry.state || '').trim().toLowerCase();
  return !['posted', 'closed', 'complete', 'completed', 'cancelled', 'canceled', 'deleted', 'archived'].includes(status);
}

function isArchived(item = {}) {
  const status = String(item.status || item.state || '').trim().toLowerCase();
  return Boolean(item.archived || item.deleted || item.isDeleted || ['deleted', 'archived', 'inactive'].includes(status));
}

function snapshotTarget(label = '') {
  if (/po/i.test(label)) return 'purchase-orders';
  if (/grv/i.test(label)) return 'grv';
  if (/stock/i.test(label)) return 'stock-count';
  return 'recipes';
}

function getLocationName(locations = [], locationId = '') {
  if (!locationId) return 'Main Kitchen';
  return locations.find((location) => String(location.id) === String(locationId))?.name ||
    locations.find((location) => String(location.name).toLowerCase() === String(locationId).toLowerCase())?.name ||
    locationId ||
    'Main Kitchen';
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') {
    return Object.entries(value).map(([id, entry]) => (
      entry && typeof entry === 'object' ? { id: entry.id || id, ...entry } : { id, value: entry }
    ));
  }
  return [];
}

function getTimestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value < 10000000000 ? value * 1000 : value;
  if (typeof value === 'object' && typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function renderHeaderUtilities(state) {
  const connection = getLiveDataStatus(state);
  const isDark = state.theme === 'dark';
  const receivingClass = connection.isReceiving ? styles.status_receiving : '';
  const tradeDateKey = state.dashboard.metrics?.today || getTradeDateKey(new Date(), state.source?.settings);

  return `
      <div class="${styles.utilityCluster}">
      ${renderSiteControl(state)}
      ${renderLocationControl(state)}
      ${renderRangeControl(state.dashboardRange || '7')}
      <button class="${styles.themeToggle}" type="button" data-dashboard-refresh aria-label="Refresh dashboard data">
        ${tileIcon('refresh')}
        <span>Refresh</span>
      </button>
      <div class="${styles.statusPill} ${styles[`status_${connection.status}`]} ${receivingClass}" title="${escapeHtml(connection.meta)}">
        <span class="${styles.statusPulse}" aria-hidden="true"></span>
        <span>
          <strong>Sync Status</strong>
          <em>${escapeHtml(connection.label)}</em>
        </span>
      </div>
      <div class="${styles.clockPill}">
        <span>Trade Date</span>
        <strong data-trade-date>${escapeHtml(formatTradeDateKey(tradeDateKey))}</strong>
        <em data-live-clock>${escapeHtml(formatTradeTime(new Date()))}</em>
      </div>
      <div class="${styles.profilePill}">
        <span>${escapeHtml(getInitials(state.user?.displayName || state.user?.email || 'KCP'))}</span>
        <strong>${escapeHtml(getDisplayName(state.user))}</strong>
        <em>${escapeHtml(state.access?.role || state.workspace?.role || 'Manager')}</em>
      </div>
      <div class="${styles.workspacePill}">
        ${tileIcon('wallet')}
        <span>
          <em>Workspace</em>
          <strong>${escapeHtml(state.workspace?.siteName || 'Main Kitchen')}</strong>
        </span>
      </div>
      <button class="${styles.themeToggle}" type="button" data-theme-toggle aria-label="Toggle dark and light mode">
        ${themeIcon(isDark)}
        <span>${isDark ? 'Light' : 'Dark'}</span>
      </button>
    </div>
  `;
}

function renderSiteControl(state) {
  const sites = getDashboardSites(state);
  if (!sites.length) return '';
  const selectedId = String(state.dashboardSiteId || '');
  const selectedLabel = sites.find((s) => String(s.id) === selectedId)?.name || 'All Sites';
  return `
    <div class="${styles.siteControl}">
      <span>Site</span>
      <button type="button" class="${styles.dropdownTrigger}" data-dashboard-site-trigger aria-haspopup="dialog">
        <strong>${escapeHtml(selectedLabel)}</strong>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  `;
}

function getDashboardLocationOptions(state) {
  return (state.source?.locations || [])
    .filter((l) => l.kind !== 'storage' && l.active !== false)
    .sort((a, b) => String(a.displayName || a.name || '').localeCompare(String(b.displayName || b.name || '')));
}

function renderLocationControl(state) {
  const locations = getDashboardLocationOptions(state);
  if (!locations.length) return '';
  const selectedId = String(state.dashboardLocationId || '');
  const found = locations.find((l) => String(l.id) === selectedId);
  const selectedLabel = found ? (found.displayName || found.name || 'Location') : 'All Locations';
  return `
    <div class="${styles.siteControl}">
      <span>Location</span>
      <button type="button" class="${styles.dropdownTrigger}" data-dashboard-location-trigger aria-haspopup="dialog">
        <strong>${escapeHtml(selectedLabel)}</strong>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  `;
}

function renderSelectorModal(picker, state) {
  const isSite = picker.type === 'site';
  const title = isSite ? 'Select Site' : 'Select Location';
  const subtitle = isSite
    ? 'Filter the dashboard to a specific site.'
    : 'Filter the dashboard to a specific selling location.';
  const selectedId = String((isSite ? state.dashboardSiteId : state.dashboardLocationId) || '');
  const options = isSite
    ? [{ id: '', name: 'All Sites' }, ...getDashboardSites(state).map((s) => ({ id: String(s.id || ''), name: s.name || s.id }))]
    : [{ id: '', name: 'All Locations' }, ...getDashboardLocationOptions(state).map((l) => ({ id: String(l.id || ''), name: l.displayName || l.name || l.id }))];
  const pin = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  const check = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  return `
    <div class="${styles.selectorOverlay}" data-dashboard-selector-overlay>
      <section class="${styles.selectorModal}" role="dialog" aria-modal="true" aria-label="${escapeAttribute(title)}">
        <header class="${styles.selectorHead}">
          <div>
            <p>${escapeHtml(isSite ? 'Site' : 'Location')}</p>
            <h3>${escapeHtml(title)}</h3>
            <span>${escapeHtml(subtitle)}</span>
          </div>
          <button type="button" class="${styles.selectorClose}" data-dashboard-selector-close aria-label="Close">✕</button>
        </header>
        <div class="${styles.selectorList}">
          ${options.map((option) => {
            const active = String(option.id) === selectedId;
            return `
              <button type="button" class="${styles.selectorOption} ${active ? styles.selectorOptionActive : ''}" data-dashboard-selector-option="${escapeAttribute(option.id)}">
                <span class="${styles.selectorOptionIcon}">${pin}</span>
                <span class="${styles.selectorOptionName}">${escapeHtml(option.name)}</span>
                ${active ? `<span class="${styles.selectorOptionCheck}">${check}</span>` : ''}
              </button>
            `;
          }).join('')}
        </div>
      </section>
    </div>
  `;
}

function getDashboardSites(state) {
  return toArray(state.source?.sites)
    .filter((site) => site && site.active !== false)
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function getSelectedDashboardSite(state) {
  const siteId = String(state.dashboardSiteId || '');
  if (!siteId) return null;
  return getDashboardSites(state).find((site) => String(site.id) === siteId) || null;
}

function getLiveDataStatus(state) {
  const connection = state.dashboard.connection || {};
  const loadedCount = connection.loadedCount ?? Object.values(state.dashboard.loaded || {}).filter(Boolean).length;
  const sourceCount = connection.sourceCount ?? Object.keys(state.dashboard.loaded || {}).length;
  const hasErrors = Object.keys(state.dashboard.errors || {}).length > 0;
  const lastUpdated = Date.parse(connection.lastUpdated || '');
  const isReceiving = Number.isFinite(lastUpdated) && Date.now() - lastUpdated < 3500;

  if (hasErrors || connection.status === 'error') {
    return {
      status: 'error',
      label: 'Attention',
      isReceiving: false,
      meta: `${loadedCount} / ${sourceCount || 0} live sources loaded`
    };
  }

  if (state.dashboard.isReady || connection.status === 'live') {
    return {
      status: 'live',
      label: 'Live',
      isReceiving,
      meta: `${loadedCount} / ${sourceCount || 0} live sources loaded`
    };
  }

  return {
    status: 'syncing',
    label: 'Syncing',
    isReceiving,
    meta: `${loadedCount} / ${sourceCount || 0} live sources loaded`
  };
}

function getDisplayName(user = {}) {
  if (user.displayName) return user.displayName;
  const email = String(user.email || 'Workspace User');
  return email.includes('@') ? email.split('@')[0] : email;
}

function getInitials(value = '') {
  const text = String(value || '').trim();
  const parts = text.includes('@') ? [text[0], text.split('@')[0]?.[1]] : text.split(/\s+/).slice(0, 2).map((part) => part[0]);
  return parts.filter(Boolean).join('').slice(0, 2).toUpperCase() || 'KC';
}

/**
 * @datasource Live stock items and movement snapshots
 * @logic Resolves stock valuation for the selected trade day/range; custom range chart starts at opening and then tracks daily closing value.
 */
function StockValueTile(data, state) {
  return StoryTile({
    ...data,
    title: 'Stock On Hand Value',
    label: 'Portfolio Valuation',
    tone: 'indigo',
    semantic: 'info',
    area: 'stock',
    size: 'hero',
    icon: 'wallet',
    loadingValue: 'R 0,00',
    description: 'Stock value at the selected range end, calculated from trade-day opening, purchases, movements, and closing stock.',
    body: renderDashboardChart(state, 'stockValue', { tone: 'indigo', format: 'currency', hero: true })
  });
}

/**
 * @datasource Live products and recipe links
 * @logic Counts menu records and compares against items created/imported/updated in the last 24 hours.
 */
function CatalogueCountTile(data, state) {
  const newCount = state.dashboard.metrics?.context?.menuItems?.newLast24h || 0;
  return StoryTile({
    ...data,
    title: 'Catalogue Count',
    label: 'Menu Items',
    tone: 'blue',
    semantic: 'info',
    area: 'catalogue',
    icon: 'menu',
    loadingValue: '0',
    description: 'Count of menu catalogue records available for recipe costing and sales mapping.',
    footer: newCount > 0
      ? `<p class="${styles.contextIndicator} ${styles.trend_positive}">▲ ${newCount} new</p>`
      : `<p class="${styles.contextIndicator} ${styles.trend_neutral}">• no new items</p>`
  });
}

/**
 * @datasource Live stock items
 * @logic Counts ingredients where normalized total stock is below `lowStockThreshold`, defaulting to 5.
 */
function LowStockTile(data) {
  return StoryTile({
    ...data,
    title: 'Low Stock Alerts',
    label: 'Reorder Watch',
    tone: 'amber',
    semantic: 'warning',
    area: 'lowStock',
    icon: 'bell',
    loadingValue: '0',
    description: 'Inventory items where current stock is below the configured low-stock threshold.',
    footer: `<button class="${styles.tileCta}" type="button" data-dashboard-target="ingredients">View alerts →</button>`
  });
}

/**
 * @datasource Live products and stock items
 * @logic Calculates recipe cost from ingredient unit costs, then averages GP% across products with selling prices.
 */
function TheoreticalGpTile(data, state) {
  return StoryTile({
    ...data,
    title: 'Theoretical GP%',
    label: 'Recipe Profitability',
    tone: 'emerald',
    semantic: 'positive',
    area: 'gp',
    size: 'wide',
    icon: 'profit',
    loadingValue: '0.0%',
    description: 'Average theoretical gross profit percentage from live selling prices and recipe costs.',
    body: renderDashboardChart(state, 'averageGp', { tone: 'emerald', format: 'percent', compact: true })
  });
}

/**
 * @datasource Live GRV and credit note logs
 * @logic Uses today's GRV total minus today's credit note total.
 */
function PurchasesTile(data) {
  return StoryTile({
    ...data,
    title: 'Purchases Ex VAT',
    label: 'GRV less Credit Notes',
    tone: 'amber',
    semantic: 'warning',
    area: 'purchases',
    icon: 'receipt',
    loadingValue: 'R 0,00',
    description: 'Today’s received purchases excluding VAT, net of supplier credit notes.'
  });
}

/**
 * @datasource Live stock, GRV, credit note, adjustment, count, manufacturing, and snapshot rows
 * @logic Previous trade-day closing stock value, reconstructed from live stock and movement logs when no exact snapshot exists.
 */
function OpeningStockTile(data) {
  return StoryTile({
    ...data,
    title: 'Opening Stock',
    label: 'Daily Anchor',
    tone: 'slate',
    semantic: 'info',
    area: 'opening',
    icon: 'lock',
    loadingValue: 'R 0,00',
    description: 'Opening stock value from the previous trade day close, using live stock and movement history when no exact snapshot exists.'
  });
}

/**
 * @datasource Live snapshot and stock rows
 * @logic Uses the selected trade-day closing snapshot when available, otherwise derives the closing value from current stock and subsequent movements.
 */
function ClosingStockTile(data) {
  return StoryTile({
    ...data,
    title: 'Closing Stock',
    label: 'Current Valuation',
    tone: 'emerald',
    semantic: 'positive',
    area: 'closing',
    icon: 'cube',
    loadingValue: 'R 0,00',
    description: 'Closing stock value based on the selected day snapshot, with next-session and live valuation fallbacks.'
  });
}

/**
 * @datasource Live dashboard metric sources for opening stock, purchases, and closing stock
 * @logic Calculates `opening stock + purchases - closing stock`; chart compares daily COS over the selected period.
 */
function CostOfSalesTile(data, state) {
  return StoryTile({
    ...data,
    title: 'Cost Of Sales',
    label: 'Actual Ex VAT',
    tone: 'emerald',
    semantic: 'positive',
    area: 'cost',
    size: 'hero',
    icon: 'chart',
    loadingValue: 'R 0,00',
    description: 'Actual cost of sales calculated as opening stock plus purchases minus closing stock.',
    body: renderDashboardChart(state, 'costOfSales', { tone: 'emerald', format: 'currency' })
  });
}

/**
 * @datasource Live stock take rows
 * @logic Sums today's stocktake line variances as `variance * cost`.
 */
function CountVarianceTile(data) {
  return StoryTile({
    ...data,
    title: 'Count Variances',
    label: 'Stocktake Impact',
    tone: 'blue',
    semantic: 'info',
    area: 'variance',
    icon: 'variance',
    loadingValue: 'R 0,00',
    description: 'Financial impact of today’s stocktake variances using item unit costs.',
    footer: ratioText(data)
  });
}

/**
 * @datasource Live adjustment rows
 * @logic Sums today's non-wastage adjustment `impactEx` values.
 */
function ManualAdjustmentTile(data) {
  return StoryTile({
    ...data,
    title: 'Manual Adjustments',
    label: 'Controlled Corrections',
    tone: 'orange',
    semantic: 'warning',
    area: 'adjustments',
    icon: 'sliders',
    loadingValue: 'R 0,00',
    description: 'Today’s non-wastage manual stock adjustments and correction impact.',
    footer: ratioText(data)
  });
}

/**
 * @datasource Live adjustment and manufacturing rows
 * @logic Adds wastage removals to manufacturing yield loss for the current trading day.
 */
function WastageTile(data) {
  return StoryTile({
    ...data,
    title: 'Wastages',
    label: 'Loss Tracking',
    tone: 'red',
    semantic: 'loss',
    area: 'wastage',
    icon: 'trash',
    loadingValue: 'R 0,00',
    description: 'Today’s wastage removals plus manufacturing yield loss.',
    footer: `
      ${ratioText(data)}
      <p class="${styles.comparisonText}">${escapeHtml(data.metric?.trend?.comparisonText || '0.00% vs yesterday')}</p>
    `
  });
}

function StoryTile({
  status,
  error,
  title,
  label,
  value,
  metric,
  tone,
  semantic,
  area,
  size = '',
  icon,
  loadingValue = '0',
  description,
  controls = '',
  body = '',
  footer = ''
}) {
  const className = classNames(
    styles.tile,
    styles[`tone_${tone}`],
    styles[`semantic_${semantic}`],
    styles[`area_${area}`],
    size === 'hero' && styles.hero,
    size === 'wide' && styles.wide
  );

  if (status === 'error') {
    return `
      <article class="${className}">
        ${renderInfo(description, title)}
        ${renderTileHead(label, title, icon, controls)}
        <div class="${styles.errorState}">${escapeHtml(error || 'Could not load this metric.')}</div>
      </article>
    `;
  }

  if (status === 'loading') {
    return `
      <article class="${className}">
        ${renderInfo(description, title)}
        ${renderTileHead(label, title, icon, controls)}
        <div class="${styles.metricValue}">${escapeHtml(loadingValue)}</div>
        <p class="${styles.trendLabel} ${styles.trend_neutral}">
          <span>• 0.00%</span>
          <em>waiting for live summary</em>
        </p>
      </article>
    `;
  }

  return `
    <article class="${className}">
      ${renderInfo(description, title)}
      ${renderTileHead(label, title, icon, controls)}
      <div class="${styles.metricValue}">${escapeHtml(value || '0')}</div>
      ${TrendLabel(metric)}
      ${body}
      ${footer ? `<div class="${styles.tileFooter}">${footer}</div>` : ''}
    </article>
  `;
}

function renderTileHead(label, title, iconName, controls = '') {
  return `
    <div class="${styles.tileHead}">
      <div>
        <p class="${styles.tileLabel}">${escapeHtml(label)}</p>
        <h2>${escapeHtml(title)}</h2>
      </div>
      <div class="${styles.tileHeadRight}">
        ${controls}
        <span class="${styles.iconGlow}" aria-hidden="true">${tileIcon(iconName)}</span>
      </div>
    </div>
  `;
}

function TrendLabel(metric) {
  const trend = metric?.trend;
  if (!trend) return '';
  return `
    <p class="${styles.trendLabel} ${styles[`trend_${trend.tone}`] || styles.trend_neutral}">
      <span>${escapeHtml(trend.label || '• 0.00%')}</span>
      <em>${escapeHtml(trend.contextLabel || 'vs yesterday')}</em>
    </p>
  `;
}

function ratioText(data) {
  if (data.ratio === null || data.ratio === undefined) return '';
  return `<p class="${styles.ratio}">${Number(data.ratio || 0).toFixed(2)}% of stock value</p>`;
}

function tileData(state, summary, key, dependencies) {
  const metric = summary[key];
  const errors = dependencies
    .map((dep) => state.dashboard.errors?.[dep])
    .filter(Boolean);
  const isLoading = Boolean(state.dashboard.rangeLoading) ||
    dependencies.some((dep) => state.dashboard.loaded?.[dep] === false || state.dashboard.loaded?.[dep] === undefined);

  if (errors.length) {
    return {
      status: 'error',
      error: errors[0]?.message || String(errors[0])
    };
  }

  if (!metric) return { status: 'loading' };
  if (isLoading && !state.dashboard.metrics) return { status: 'loading' };

  return {
    status: 'ready',
    metric,
    value: metric.value,
    raw: metric.raw,
    ratio: metric.ratio
  };
}

function getEffectiveDashboardSummary(state) {
  return state.dashboard.metrics?.summary || {};
}

function buildRangeDashboardSummary(source, startDate, endDate) {
  const dates = enumerateDates(startDate, endDate).slice(0, 92);
  if (!dates.length) return {};

  const dailySummaries = dates.map((date) => calculateDashboardMetrics(source, date).summary || {});
  const firstSummary = dailySummaries[0] || {};
  const lastSummary = dailySummaries[dailySummaries.length - 1] || {};
  const aggregateKeys = ['purchases', 'costOfSales', 'countVariance', 'manualAdjustments', 'wastage', 'manufacturingWastage'];
  const summary = {
    stockValue: cloneMetric(lastSummary.closingStock || lastSummary.stockValue),
    totalStockValue: cloneMetric(lastSummary.totalStockValue || lastSummary.closingStock || lastSummary.stockValue),
    productCount: cloneMetric(lastSummary.productCount),
    lowStockCount: cloneMetric(lastSummary.lowStockCount),
    averageGp: cloneMetric(lastSummary.averageGp),
    gpPercentage: cloneMetric(lastSummary.gpPercentage || lastSummary.averageGp),
    openingStock: cloneMetric(firstSummary.openingStock),
    closingStock: cloneMetric(lastSummary.closingStock)
  };

  aggregateKeys.forEach((key) => {
    const type = firstSummary[key]?.type || lastSummary[key]?.type || 'currency';
    const raw = dailySummaries.reduce((sum, daySummary) => {
      const metric = daySummary?.[key];
      return sum + Number(metric?.raw || 0);
    }, 0);
    const ratioBase = Number(summary.stockValue?.raw || lastSummary.stockValue?.raw || 0);
    summary[key] = createMetric(raw, type, ratioBase && ['countVariance', 'manualAdjustments', 'wastage'].includes(key)
      ? (raw / ratioBase) * 100
      : null);
  });

  const openingRaw = Number(summary.openingStock?.raw || 0);
  const purchasesRaw = Number(summary.purchases?.raw || 0);
  const closingRaw = Number(summary.closingStock?.raw || 0);
  summary.costOfSales = createMetric(openingRaw + purchasesRaw - closingRaw, 'currency');

  return summary;
}

function enrichRangeSummary(current, previous, fallbackSummary) {
  const summary = {};

  Object.entries(current || {}).forEach(([key, metric]) => {
    if (!metric) return;
    const previousMetric = previous?.[key] || fallbackSummary?.[key] || metric;
    const currentRaw = Number(metric.raw || 0);
    const previousRaw = Number(previousMetric.raw || 0);
    const delta = currentRaw - previousRaw;
    const deltaPercent = previousRaw === 0
      ? (currentRaw === 0 ? 0 : 100)
      : (delta / Math.abs(previousRaw)) * 100;
    summary[key] = {
      ...metric,
      trend: {
        ...(fallbackSummary?.[key]?.trend || {}),
        delta,
        deltaPercent,
        direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
        label: formatDashboardTrend(metric.type, delta, deltaPercent),
        comparisonText: `${Math.abs(deltaPercent).toFixed(2)}% vs prior range`,
        contextLabel: 'vs prior range'
      }
    };
  });

  summary.totalStockValue = summary.totalStockValue || summary.stockValue;
  summary.gpPercentage = summary.gpPercentage || summary.averageGp;
  return summary;
}

function cloneMetric(metric) {
  if (!metric) return null;
  return { ...metric };
}

function createMetric(raw, type, ratio = null) {
  return {
    raw,
    type,
    value: formatDashboardMetric(raw, type),
    ratio
  };
}

function formatDashboardMetric(value, type) {
  const numeric = Number(value || 0);
  if (type === 'currency') {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(numeric);
  }
  if (type === 'percent') return `${numeric.toFixed(1)}%`;
  return new Intl.NumberFormat('en-ZA').format(numeric);
}

function formatDashboardTrend(type, delta, deltaPercent) {
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '•';
  if (type === 'percent') return `${arrow} ${Math.abs(delta).toFixed(1)} pp`;
  return `${arrow} ${Math.abs(deltaPercent).toFixed(2)}%`;
}

function renderInfo(description, title) {
  if (!description) return '';

  return `
    <span class="${styles.infoWrap}" tabindex="0" aria-label="${escapeHtml(`${title}: ${description}`)}">
      <span class="${styles.infoIcon}" aria-hidden="true">i</span>
      <span class="${styles.tooltip}" role="tooltip">${escapeHtml(description)}</span>
    </span>
  `;
}

function renderRangeControl(activeRange) {
  const range = parseDashboardRange(activeRange);
  return `
    <div class="${styles.rangeControl}" data-dashboard-range-control>
      <button type="button" class="${styles.rangeButton}" data-dashboard-calendar-open aria-label="Select dashboard date range">
        <span>${escapeHtml(range.label)}</span>
        ${iconSvg('<path d="m6 9 6 6 6-6"/>')}
      </button>
    </div>
  `;
}

function renderRangeCalendarOverlay(rangeDraft, calendarState) {
  const calendar = buildCalendarModel(calendarState.cursor || rangeDraft.startDate || todayLocal(), calendarState.activeEdge === 'end' ? rangeDraft.endDate : rangeDraft.startDate);
  const startDate = rangeDraft.startDate || todayLocal();
  const endDate = rangeDraft.endDate || startDate;

  return `
    <div class="${styles.rangeOverlay}" data-dashboard-calendar-overlay>
      <div class="${styles.rangeOverlayCard}" role="dialog" aria-modal="true">
        <div class="${styles.rangeOverlayHeader}">
          <div>
            <h3>Select Dashboard Range</h3>
            <p>${escapeHtml(`${formatDisplayDate(startDate)} -> ${formatDisplayDate(endDate)}`)}</p>
          </div>
          <button type="button" class="${styles.rangeOverlayClose}" data-dashboard-calendar-close aria-label="Close range selector">
            ${iconSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')}
          </button>
        </div>

        <div class="${styles.rangePresetRow}">
          <button type="button" data-dashboard-calendar-preset="today">Today</button>
          <button type="button" data-dashboard-calendar-preset="7">Last 7 Days</button>
          <button type="button" data-dashboard-calendar-preset="30">Last 30 Days</button>
        </div>

        <div class="${styles.rangeLegend}">
          <span class="${styles.rangeLegendSwatch}" aria-hidden="true"></span>
          <span>Selected range</span>
        </div>

        <div class="${styles.rangeCalendarNav}">
          <div class="${styles.rangeCalendarNavGroup}">
            <button type="button" data-dashboard-calendar-nav="-12" aria-label="Previous year">${iconSvg('<path d="m17 18-6-6 6-6"/><path d="m11 18-6-6 6-6"/>')}</button>
            <button type="button" data-dashboard-calendar-nav="-1" aria-label="Previous month">${iconSvg('<path d="m15 18-6-6 6-6"/>')}</button>
          </div>
          <strong>${escapeHtml(calendar.label)}</strong>
          <div class="${styles.rangeCalendarNavGroup}">
            <button type="button" data-dashboard-calendar-nav="1" aria-label="Next month">${iconSvg('<path d="m9 18 6-6-6-6"/>')}</button>
            <button type="button" data-dashboard-calendar-nav="12" aria-label="Next year">${iconSvg('<path d="m7 18 6-6-6-6"/><path d="m13 18 6-6-6-6"/>')}</button>
          </div>
        </div>

        <div class="${styles.rangeCalendarGrid}">
          ${calendar.weekdays.map((weekday) => `<span class="${styles.rangeCalendarWeekday}">${weekday}</span>`).join('')}
          ${calendar.days.map((day) => {
            const isStart = day.date === startDate;
            const isEnd = day.date === endDate;
            const isInRange = day.date >= startDate && day.date <= endDate;
            const classes = [
              styles.rangeCalendarDay,
              !day.isCurrentMonth ? styles.rangeCalendarDayOutside : '',
              day.isToday ? styles.rangeCalendarDayToday : '',
              isInRange ? styles.rangeCalendarDayInRange : '',
              isStart ? styles.rangeCalendarDayStart : '',
              isEnd ? styles.rangeCalendarDayEnd : ''
            ].filter(Boolean).join(' ');
            return `
              <button type="button" class="${classes}" data-dashboard-calendar-day="${escapeAttribute(day.date)}">
                ${day.day}
              </button>
            `;
          }).join('')}
        </div>

        <div class="${styles.rangeEdgeRow} ${styles.rangeEdgeRowBottom}">
          <button type="button" class="${calendarState.activeEdge === 'start' ? styles.rangeEdgeActive : ''}" data-dashboard-calendar-edge="start">
            <span>From</span>
            <strong>${escapeHtml(formatRangePickerDate(startDate))}</strong>
          </button>
          <div class="${styles.rangeEdgeConnector}" aria-hidden="true"></div>
          <button type="button" class="${calendarState.activeEdge === 'end' ? styles.rangeEdgeActive : ''}" data-dashboard-calendar-edge="end">
            <span>To</span>
            <strong>${escapeHtml(formatRangePickerDate(endDate))}</strong>
          </button>
        </div>

        <div class="${styles.rangeOverlayFooter}">
          <button type="button" class="${styles.rangeFooterSecondary}" data-dashboard-calendar-today>Today</button>
          <button type="button" class="${styles.rangeFooterPrimary}" data-dashboard-calendar-apply>Apply Range</button>
        </div>
      </div>
    </div>
  `;
}

function renderDashboardChart(state, metricKey, options = {}) {
  if (!state) return '';
  const range = parseDashboardRange(state.dashboardRange || '7');
  const trends = state.dashboard.metrics?.trends || {};
  const series = getDashboardSeries(state, trends, metricKey, range);

  // Compact KPI sparklines stay as the lightweight inline SVG (tiny + static — no glitch there).
  if (options.compact) {
    return `<div class="${styles.sparkFrame}">${renderInlineTrendSvg(series, { ...options, metricKey })}</div>`;
  }

  // Full Movement chart renders on a Chart.js canvas (crisp, animated, DPI-correct). The series +
  // tone + format ride on data-attributes; the canvas is initialised after mount (initMovementChart).
  const points = (series || [])
    .filter((point) => Number.isFinite(Number(point.value)))
    .map((point) => ({ label: String(point.label ?? point.date ?? ''), value: Number(point.value) }));
  return `<div class="${styles.chartFrame}">
    <canvas
      data-movement-chart
      data-tone="${escapeAttribute(options.tone || 'blue')}"
      data-format="${escapeAttribute(options.format || 'number')}"
      data-series="${escapeAttribute(JSON.stringify(points))}"
    ></canvas>
  </div>`;
}

function renderInlineTrendSvg(series = [], options = {}) {
  const points = series.filter((point) => Number.isFinite(Number(point.value)));
  const id = `dashGradient-${escapeAttribute(options.metricKey || 'metric')}-${escapeAttribute(options.tone || 'blue')}`;
  const width = 640;
  const height = options.compact ? 168 : 260;
  const padX = options.compact ? 22 : options.hero ? 42 : 50;
  const padRight = options.compact ? 14 : options.hero ? 10 : 22;
  const padTop = options.compact ? 14 : options.hero ? 12 : 24;
  const padBottom = options.compact ? 20 : options.hero ? 38 : 46;
  const chartHeight = height - padTop - padBottom;
  const chartWidth = width - padX - padRight;
  const color = getToneColorVar(options.tone);

  if (!points.length) {
    const y = padTop + chartHeight * 0.55;
    return `
      <svg class="${styles.inlineChart}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
        <path d="M ${padX} ${y} H ${width - padRight}" stroke="${color}" stroke-width="4" stroke-dasharray="9 12" opacity="0.45" fill="none"/>
      </svg>
    `;
  }

  const values = points.map((point) => Number(point.value || 0));
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const padding = Math.max(1, Math.abs(max) * 0.08);
    min -= padding;
    max += padding;
  }
  const rangePadding = (max - min) * 0.12;
  min -= rangePadding;
  max += rangePadding;

  const coords = points.map((point, index) => {
    const x = padX + (points.length === 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth);
    const y = padTop + chartHeight - ((Number(point.value || 0) - min) / (max - min)) * chartHeight;
    return { x, y, ...point };
  });
  const linePath = buildSmoothPath(coords);
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(2)} ${height - padBottom} L ${coords[0].x.toFixed(2)} ${height - padBottom} Z`;
  const labelIndexes = getChartLabelIndexes(coords.length, options.compact ? 0 : 4);
  const gridTicks = options.compact ? [] : [1, 0.5, 0].map((ratio) => ({
    y: padTop + chartHeight * (1 - ratio),
    value: min + (max - min) * ratio
  }));
  const lastPoint = coords[coords.length - 1];
  const firstPoint = coords[0];
  const directionTone = Number(lastPoint.value || 0) >= Number(firstPoint.value || 0)
    ? styles.chartTrendPositive
    : styles.chartTrendNegative;

  return `
    <svg class="${styles.inlineChart}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(options.format || 'dashboard')} trend">
      <defs>
        <linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.34"/>
          <stop offset="58%" stop-color="${color}" stop-opacity="0.13"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
        </linearGradient>
        <filter id="${id}-glow" x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="5" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      ${gridTicks.map((tick) => `
        <path class="${styles.inlineChartGrid}" d="M ${padX} ${tick.y.toFixed(2)} H ${width - padRight}" />
        <text class="${styles.inlineChartAxis}" x="8" y="${(tick.y + 4).toFixed(2)}">${escapeHtml(formatCompactChartValue(tick.value, options.format))}</text>
      `).join('')}
      <path d="${areaPath}" fill="url(#${id})"/>
      <path class="${styles.inlineChartGlow}" d="${linePath}" fill="none" stroke="${color}" stroke-width="${options.compact ? 6 : 7}" stroke-linecap="round" stroke-linejoin="round" filter="url(#${id}-glow)"/>
      <path class="${styles.inlineChartLine}" d="${linePath}" fill="none" stroke="${color}" stroke-width="${options.compact ? 4 : 4.6}" stroke-linecap="round" stroke-linejoin="round"/>
      ${options.compact ? '' : coords.map((point) => {
        const pointLabel = String(point.label || '');
        const pointValue = formatCompactChartValue(point.value, options.format);
        const tipText = (pointLabel ? `${pointLabel} • ` : '') + pointValue;
        return `<g>
          <title>${escapeHtml(tipText)}</title>
          <circle class="${styles.inlineChartHit}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="14" fill="transparent" data-chart-point data-chart-label="${escapeAttribute(pointLabel)}" data-chart-value="${escapeAttribute(pointValue)}"/>
          <circle class="${styles.inlineChartPoint}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4" stroke="${color}"/>
        </g>`;
      }).join('')}
      ${options.compact ? '' : `
        <g class="${styles.inlineChartBadge} ${directionTone}" transform="translate(${Math.min(width - 142, Math.max(padX, lastPoint.x - 72)).toFixed(2)} ${Math.max(12, lastPoint.y - 34).toFixed(2)})">
          <rect width="128" height="25" rx="12.5"/>
          <text x="64" y="17" text-anchor="middle">${escapeHtml(formatCompactChartValue(lastPoint.value, options.format))}</text>
        </g>
      `}
      ${labelIndexes.map((index) => {
        const point = coords[index];
        return `<text class="${styles.inlineChartDate}" x="${point.x.toFixed(2)}" y="${height - 15}" text-anchor="${index === 0 ? 'start' : index === coords.length - 1 ? 'end' : 'middle'}">${escapeHtml(point.label || '')}</text>`;
      }).join('')}
    </svg>
  `;
}

function buildSmoothPath(coords = []) {
  if (!coords.length) return '';
  if (coords.length === 1) return `M ${coords[0].x.toFixed(2)} ${coords[0].y.toFixed(2)}`;

  return coords.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    const previous = coords[index - 1];
    const next = coords[index + 1] || point;
    const controlDistance = (point.x - previous.x) * 0.36;
    const c1x = previous.x + controlDistance;
    const c1y = previous.y + (point.y - (coords[index - 2]?.y ?? previous.y)) * 0.10;
    const c2x = point.x - controlDistance;
    const c2y = point.y - (next.y - previous.y) * 0.10;
    return `${path} C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }, '');
}

function getDashboardSeries(state, trends, metricKey, range) {
  const byMetric = trends?.[metricKey];
  if (!byMetric || typeof byMetric !== 'object') return [];
  if (range.mode !== 'custom' && Array.isArray(byMetric[range.value])) return byMetric[range.value];
  const fallbackKey = estimateRangeDayCount(range) > 7 ? '30' : '7';
  if (Array.isArray(byMetric[fallbackKey])) return byMetric[fallbackKey];
  // The tile service stores the series under whatever range was fetched; fall back to
  // the first available series so the chart always renders the current range.
  const firstAvailable = Object.values(byMetric).find((value) => Array.isArray(value) && value.length);
  return firstAvailable || [];
}

function estimateRangeDayCount(range) {
  if (!range?.startDate || !range?.endDate) return Number(range?.days || 7) || 7;
  return enumerateDates(range.startDate, range.endDate).length || 7;
}

function buildCustomDashboardSeries(source, startDate, endDate, metricKey) {
  const dates = enumerateDates(startDate, endDate).slice(0, 92);
  return dates.map((date) => {
    const summary = calculateDashboardMetrics(source, date).summary || {};
    const metric = metricKey === 'stockValue'
      ? (date === dates[0] ? summary.openingStock : summary.closingStock)
      : summary[metricKey];
    return {
      date,
      label: formatSeriesDateLabel(date, dates.length),
      value: Number(metric?.raw || 0)
    };
  });
}

function parseDashboardRange(value) {
  const text = String(value || 'today');
  if (text === 'today') {
    const d = todayLocal();
    return { mode: 'today', value: 'today', startDate: d, endDate: d, days: 1, label: 'Today' };
  }

  const customMatch = text.match(/^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
  if (customMatch) {
    const startDate = customMatch[1] <= customMatch[2] ? customMatch[1] : customMatch[2];
    const endDate = customMatch[1] <= customMatch[2] ? customMatch[2] : customMatch[1];
    return {
      mode: 'custom',
      value: text,
      startDate,
      endDate,
      label: `${formatShortDate(startDate)} - ${formatShortDate(endDate)}`
    };
  }

  const valueKey = text === '30' ? '30' : '7';
  return {
    mode: 'preset',
    value: valueKey,
    days: Number(valueKey),
    label: valueKey === '30' ? 'Last 30 Days' : 'Last 7 Days'
  };
}

function getRangeInputDates(range, settings = {}) {
  if (range.mode === 'custom' || range.mode === 'today') {
    return {
      startDate: range.startDate,
      endDate: range.endDate
    };
  }

  const today = getTradeDateKey(new Date(), settings);
  return {
    startDate: addDays(today, -(Number(range.days || 7) - 1)),
    endDate: today
  };
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  let cursor = startDate <= endDate ? startDate : endDate;
  const last = startDate <= endDate ? endDate : startDate;

  while (cursor <= last) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }

  return dates;
}

function addDays(dateKey, offset) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return toIsoDate(date);
}

function toIsoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatSeriesDateLabel(dateKey, length) {
  const date = new Date(`${dateKey}T12:00:00`);
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit',
    month: length > 35 ? 'numeric' : 'short'
  }).format(date);
}

function formatShortDate(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit',
    month: 'short'
  }).format(date);
}

function formatRangePickerDate(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

function getToneColorVar(tone) {
  const map = {
    indigo: 'var(--accent-indigo)',
    blue: 'var(--accent-blue)',
    amber: 'var(--accent-amber)',
    emerald: 'var(--accent-emerald)',
    red: 'var(--accent-red)',
    orange: 'var(--accent-orange)'
  };
  return map[tone] || 'var(--accent-blue)';
}

function getChartLabelIndexes(length, desired) {
  if (!desired || length <= 0) return [];
  if (length <= desired) return Array.from({ length }, (_, index) => index);
  const indexes = new Set([0, length - 1]);
  const step = (length - 1) / (desired - 1);
  for (let index = 1; index < desired - 1; index += 1) {
    indexes.add(Math.round(index * step));
  }
  return [...indexes].sort((a, b) => a - b);
}

function formatCompactChartValue(value, format) {
  const numeric = Number(value || 0);
  if (format === 'percent') return `${numeric.toFixed(Math.abs(numeric) < 10 ? 1 : 0)}%`;
  if (format === 'currency') {
    const absolute = Math.abs(numeric);
    const sign = numeric < 0 ? '-' : '';
    if (absolute >= 1000000) return `${sign}R ${(absolute / 1000000).toFixed(1)}M`;
    if (absolute >= 1000) return `${sign}R ${(absolute / 1000).toFixed(absolute >= 10000 ? 0 : 1)}K`;
    return `${sign}R ${Math.round(absolute)}`;
  }
  return new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 1 }).format(numeric);
}

function renderWorkspaceError(message) {
  return `
    <div class="${styles.workspaceError}">
      <h2>No Workspace Available</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function themeIcon(isDark) {
  const path = isDark
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.93 19.07l1.41-1.41"/><path d="M17.66 6.34l1.41-1.41"/>'
    : '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z"/>';

  return iconSvg(path);
}

function tileIcon(name) {
  const icons = {
    bell: '<path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5"/><path d="M10 21h4"/><path d="M12 3V2"/>',
    chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 15 4-4 3 3 5-7"/>',
    cube: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12 4 7.5"/><path d="M12 12v9"/><path d="m12 12 8-4.5"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    menu: '<path d="M6 11h12"/><path d="M8 6h8a4 4 0 0 1 4 4H4a4 4 0 0 1 4-4z"/><path d="M5 15h14l-1 5H6z"/>',
    profit: '<path d="M4 17 10 9l4 4 6-8"/><path d="M14 5h6v6"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h4"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h-4"/><path d="M6 22v-4h4"/>',
    sliders: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/>',
    team: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    variance: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="m8 15 3-3 3 2 4-6"/><path d="M14 8h4v4"/>',
    wallet: '<path d="M5 7h14a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2V5a2 2 0 0 0 2 2z"/><path d="M16 13h.01"/>'
  };

  return iconSvg(icons[name] || icons.chart);
}

function iconSvg(paths) {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${paths}
    </svg>
  `;
}

function formatTradeDate(date) {
  return new Intl.DateTimeFormat('en-ZA', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

function formatTradeDateKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  return formatTradeDate(date);
}

function formatTradeTime(date) {
  return new Intl.DateTimeFormat('en-ZA', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value = '') {
  return escapeHtml(value).replaceAll('`', '&#096;');
}
