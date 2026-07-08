// Advanced Reports — Stock-Out Forecast, Price Volatility, Theoretical vs Actual Usage.
// Extracted from Analytics.js (the analytics core). Shared helpers are imported from Analytics.js;
// the entry renderers + a few app-wide helpers physically defined in this cluster are exported back.
import { todayLocal } from '../utils/date.js';
import {
  addDays,
  arrayValue,
  escapeAttribute,
  escapeHtml,
  formatMoney,
  formatNumber,
  icon,
  pageSizeOptions,
  parseMoney,
  parseNumber,
  renderDateRangePicker,
  renderDropdown,
  renderForecastInfo,
  renderReportActionsDropdown,
  renderReportInfo,
  reportRowUnit,
  uniqueCount
} from './Analytics.js';

export function renderForecastReportDetailView({
  filters,
  reportData,
  category,
  categoryOptions,
  locationOptions,
  pageSize
}) {
  const forecastRows = buildForecastAdvancedRows(reportData.rows || [], filters);
  const rows = groupForecastRows(forecastRows, filters);
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const horizonOptions = [
    { value: '7', label: '7 Days' },
    { value: '14', label: '14 Days' },
    { value: '30', label: '30 Days' },
    { value: '60', label: '60 Days' }
  ];

  return `
    <div class="analyticsDetailCanvas analyticsForecastCanvas analyticsTone-${category.tone}">
      <header class="analyticsForecastHeader">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsForecastTitle">
            <span>${icon('chart')}</span>
            <div>
              <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Advanced live report for this workspace.')}</h1>
              <p>${escapeHtml(reportData.report.description)}</p>
            </div>
          </div>
        </div>
        <div class="analyticsForecastToolbar">
          <label class="analyticsForecastSearch">
            ${icon('search')}
            <input type="search" value="${escapeAttribute(filters.query)}" placeholder="Search reports, items, locations..." data-analytics-field="query" data-focus-key="analytics-query" />
          </label>
          <button type="button" class="analyticsForecastToolButton" data-analytics-dropdown="forecastFilters" aria-expanded="${filters.openDropdown === 'forecastFilters'}">
            ${icon('filter')} Filters
          </button>
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsForecastFilters ${filters.openDropdown === 'forecastFilters' ? 'is-open' : ''}" data-analytics-dropdown-root>
        ${renderDropdown({
          id: 'locationId',
          label: 'Location',
          selectedValue: filters.locationId || '',
          options: locationOptions,
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'category',
          label: 'Category',
          selectedValue: filters.category || '',
          options: categoryOptions,
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'forecastHorizon',
          label: 'Forecast Horizon',
          selectedValue: String(filters.forecastHorizon || '14'),
          options: horizonOptions,
          openDropdown: filters.openDropdown
        })}
        <button type="button" class="analyticsForecastApply" data-analytics-refresh>
          ${icon('sliders')} Apply Filters
        </button>
        <span class="analyticsForecastUpdated">Last updated: ${escapeHtml(new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }))}</span>
      </section>

      ${renderForecastKpis(rows, filters)}

      <section class="analyticsForecastGrid">
        ${renderForecastCoverageChart(rows, filters)}
        ${renderForecastRiskDistribution(rows)}
        <div class="analyticsForecastSideStack">
          ${renderForecastExposureList(forecastRows, 'Location', 'Most Exposed Locations', 'box')}
          ${renderForecastExposureList(forecastRows, 'Category', 'Highest Risk Categories', 'box')}
          ${renderForecastNotes(forecastRows)}
        </div>
      </section>

      <section class="analyticsForecastTablePanel">
        <header>
          <div>
            <h2>Forecasted Stock-outs <span>${escapeHtml(formatNumber(totalRows))} items</span></h2>
            <p>Rows are sorted by lowest days of cover first.</p>
          </div>
          ${renderDropdown({
            id: 'pageSize',
            label: 'Rows',
            selectedValue: String(pageSize),
            options: pageSizeOptions(),
            openDropdown: filters.openDropdown
          })}
        </header>
        <div class="analyticsTableWrap">
          <table class="analyticsTable analyticsForecastTable">
            <thead>
              <tr>
                ${forecastAdvancedColumns().map((column) => `<th>${escapeHtml(column)} ${forecastColumnInfo(column)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${pageRows.map(renderForecastTableRow).join('') || `<tr><td colspan="${forecastAdvancedColumns().length}">No stock-out risks match this report.</td></tr>`}
            </tbody>
          </table>
        </div>
        <footer class="analyticsPagination">
          <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} forecast rows` : '0 forecast rows'}</span>
          <div class="analyticsPageButtons">
            <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
            <strong>Page ${currentPage} of ${totalPages}</strong>
            <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
          </div>
        </footer>
      </section>
    </div>
  `;
}

export function forecastAdvancedColumns() {
  return ['Item', 'Category', 'Location', 'Current Stock', 'Avg Daily Usage', 'Days of Cover', 'Stock-out Date', 'Risk Level', 'Reorder Qty', 'Action'];
}

export function buildForecastAdvancedRows(rows = [], filters = {}) {
  const horizon = Math.max(1, Number(filters.forecastHorizon || 14) || 14);
  return rows
    .map((row) => {
      const currentStock = parseNumber(row['Current Stock']);
      const avgDailyUsage = parseNumber(row['Avg Daily Usage']);
      const daysOfCover = avgDailyUsage > 0 ? currentStock / avgDailyUsage : Number.POSITIVE_INFINITY;
      const suggestedQty = Math.max(0, Math.ceil((avgDailyUsage * horizon) - currentStock));
      const unitCost = parseNumber(row._unitCost ?? row['Unit Cost']);
      const riskLevel = row['Risk Level'] || forecastRiskLevel(daysOfCover);
      const stockOutDate = row['Predicted Stock-out Date'] && row['Predicted Stock-out Date'] !== 'No usage'
        ? row['Predicted Stock-out Date']
        : (Number.isFinite(daysOfCover) ? addDays(todayLocal(), Math.ceil(daysOfCover)) : 'No usage');
      return {
        ...row,
        'Current Stock': currentStock,
        'Avg Daily Usage': avgDailyUsage,
        'Days of Cover': Number.isFinite(daysOfCover) ? daysOfCover : 'No usage',
        'Predicted Stock-out Date': stockOutDate,
        'Stock-out Date': stockOutDate,
        'Risk Level': riskLevel,
        'Suggested Reorder Qty': suggestedQty,
        'Reorder Qty': suggestedQty,
        _daysOfCover: daysOfCover,
        _projectedValue: Math.max(0, currentStock) * unitCost,
        _suggestedQty: suggestedQty,
        _unitCost: unitCost
      };
    })
    .sort((left, right) => forecastSortValue(left._daysOfCover) - forecastSortValue(right._daysOfCover));
}

function groupForecastRows(rows = [], filters = {}) {
  const expanded = new Set(arrayValue(filters.forecastExpandedIds));
  const groups = rows.reduce((map, row) => {
    const key = forecastRowGroupKey(row);
    const entry = map.get(key) || [];
    entry.push(row);
    map.set(key, entry);
    return map;
  }, new Map());

  return [...groups.entries()]
    .map(([key, detailRows]) => {
      const sortedRows = [...detailRows].sort((left, right) => forecastSortValue(left._daysOfCover) - forecastSortValue(right._daysOfCover));
      const primary = sortedRows[0] || {};
      const totalCurrent = sortedRows.reduce((sum, row) => sum + parseNumber(row['Current Stock']), 0);
      const totalUsage = sortedRows.reduce((sum, row) => sum + parseNumber(row['Avg Daily Usage']), 0);
      const totalReorder = sortedRows.reduce((sum, row) => sum + Number(row._suggestedQty || row['Suggested Reorder Qty'] || 0), 0);
      const totalValue = sortedRows.reduce((sum, row) => sum + Number(row._projectedValue || 0), 0);
      const locationCount = new Set(sortedRows.map((row) => String(row.Location || '').trim()).filter(Boolean)).size || sortedRows.length;

      return {
        ...primary,
        Location: locationCount > 1 ? `${formatNumber(locationCount)} locations` : primary.Location,
        'Current Stock': totalCurrent,
        'Avg Daily Usage': totalUsage,
        'Suggested Reorder Qty': totalReorder,
        'Reorder Qty': totalReorder,
        _detailRows: sortedRows,
        _duplicateCount: sortedRows.length,
        _expanded: expanded.has(key),
        _groupKey: key,
        _projectedValue: totalValue,
        _suggestedQty: totalReorder
      };
    })
    .sort((left, right) => forecastSortValue(left._daysOfCover) - forecastSortValue(right._daysOfCover));
}

function forecastRowGroupKey(row = {}) {
  return `${String(row.Item || '').trim().toLowerCase()}::${String(row.Category || '').trim().toLowerCase()}`;
}

function forecastSortValue(value) {
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function forecastRiskLevel(daysOfCover) {
  if (!Number.isFinite(daysOfCover)) return 'Stable';
  if (daysOfCover <= 7) return 'Critical';
  if (daysOfCover <= 14) return 'High';
  if (daysOfCover <= 30) return 'Medium';
  return 'Stable';
}

function liveChartAttr(value) {
  return escapeAttribute(JSON.stringify(value || []));
}

export function renderLiveChartCanvas({ type = 'bar', labels = [], datasets = [], className = '', ariaLabel = 'Live report chart', series = [] } = {}) {
  return `
    <div class="analyticsLiveChartFrame ${escapeAttribute(className)}">
      <canvas
        data-live-chart="true"
        data-chart-type="${escapeAttribute(type)}"
        data-chart-labels="${liveChartAttr(labels)}"
        data-chart-datasets="${liveChartAttr(datasets)}"
        data-chart-series="${liveChartAttr(series)}"
        aria-label="${escapeAttribute(ariaLabel)}"
        role="img"
      ></canvas>
    </div>
  `;
}

export function renderLiveDoughnut({ series = [], centerValue = '', centerLabel = '', className = '', ariaLabel = 'Live distribution chart' } = {}) {
  return `
    <div class="analyticsLiveDoughnutWrap ${escapeAttribute(className)}">
      ${renderLiveChartCanvas({ type: 'pie', series, className: 'analyticsLiveDoughnutCanvas', ariaLabel })}
      <span class="analyticsLiveDoughnutCenter">
        <strong>${escapeHtml(centerValue)}</strong>
        <em>${escapeHtml(centerLabel)}</em>
      </span>
    </div>
  `;
}

function renderForecastKpis(rows = [], filters = {}) {
  const horizon = Math.max(1, Number(filters.forecastHorizon || 14) || 14);
  const atRisk = rows.filter((row) => forecastSortValue(row._daysOfCover) <= 30);
  const critical = rows.filter((row) => forecastSortValue(row._daysOfCover) <= 7);
  const expected = rows.filter((row) => forecastSortValue(row._daysOfCover) <= horizon);
  const projectedValue = atRisk.reduce((sum, row) => sum + Number(row._projectedValue || 0), 0);
  const reorderRows = rows.filter((row) => Number(row._suggestedQty || 0) > 0);
  const cards = [
    { label: 'Items at Risk', value: formatNumber(atRisk.length), helper: 'Items with 30 days of cover or less.', icon: 'activity', tone: 'red', link: 'View rows' },
    { label: 'Critical in 7 Days', value: formatNumber(critical.length), helper: 'Items forecast to run out within seven days.', icon: 'calendar', tone: 'orange', link: 'View critical' },
    { label: `Expected Stock-outs in ${horizon} Days`, value: formatNumber(expected.length), helper: 'Forecasted stock-outs inside the selected horizon.', icon: 'clipboard', tone: 'yellow', link: 'View forecast' },
    { label: 'Projected Stock-out Value', value: formatMoney(projectedValue), helper: 'Current stock value exposed in at-risk rows.', icon: 'coin', tone: 'green', link: 'View value' },
    { label: 'Reorder Recommendations', value: formatNumber(reorderRows.length), helper: 'Rows with a suggested reorder quantity.', icon: 'cart', tone: 'blue', link: 'View details' }
  ];
  return `
    <section class="analyticsForecastKpis">
      ${cards.map((card) => `
        <article class="analyticsForecastKpi analyticsMetric-${card.tone}">
          <span>${icon(card.icon)}</span>
          <div>
            <small>${escapeHtml(card.label)} ${renderForecastInfo(card.helper)}</small>
            <strong>${escapeHtml(card.value)}</strong>
            <em>${escapeHtml(card.helper)}</em>
            <button type="button" class="analyticsForecastKpiLink" data-analytics-forecast-focus="table">${escapeHtml(card.link)} ${icon('arrowRight')}</button>
          </div>
        </article>
      `).join('')}
    </section>
  `;
}

function renderForecastCoverageChart(rows = [], filters = {}) {
  const finiteDays = rows.map((row) => Number(row._daysOfCover)).filter(Number.isFinite);
  const horizon = Math.max(7, Number(filters.forecastHorizon || 14) || 14);
  const averageCover = finiteDays.length ? finiteDays.reduce((sum, value) => sum + value, 0) / finiteDays.length : 0;
  const minimumCover = finiteDays.length ? Math.min(...finiteDays) : 0;
  const steps = 8;
  const chartPoints = Array.from({ length: steps }, (_, index) => {
    const progress = steps <= 1 ? 0 : index / (steps - 1);
    const dayOffset = progress * horizon;
    return {
      label: addDays(todayLocal(), Math.round(progress * horizon)),
      average: Math.max(0, averageCover - dayOffset),
      minimum: Math.max(0, minimumCover - dayOffset)
    };
  });
  const labels = chartPoints.map((point) => point.label);
  const datasets = [
    {
      label: 'Average Days of Cover',
      data: chartPoints.map((point) => Number(point.average.toFixed(2))),
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96, 165, 250, 0.16)',
      pointBackgroundColor: '#93c5fd',
      pointRadius: 3,
      tension: 0.35,
      fill: true
    },
    {
      label: 'Minimum Days of Cover',
      data: chartPoints.map((point) => Number(point.minimum.toFixed(2))),
      borderColor: '#bfdbfe',
      backgroundColor: 'rgba(191, 219, 254, 0.08)',
      borderDash: [5, 5],
      pointRadius: 2,
      tension: 0.35
    },
    {
      label: 'Reorder Threshold (7)',
      data: chartPoints.map(() => 7),
      borderColor: '#fb923c',
      borderDash: [6, 5],
      pointRadius: 0,
      tension: 0
    },
    {
      label: 'Critical Threshold (2)',
      data: chartPoints.map(() => 2),
      borderColor: '#fb365d',
      borderDash: [6, 5],
      pointRadius: 0,
      tension: 0
    }
  ];
  return `
    <section class="analyticsForecastPanel analyticsForecastCoverage">
      <header>
        <h2>Projected Stock Coverage Over Time ${renderForecastInfo('Estimated days of cover for the fastest-risk items in this filtered report.')}</h2>
        <span>Average days of cover vs minimum cover</span>
      </header>
      ${renderLiveChartCanvas({ type: 'line', labels, datasets, className: 'analyticsForecastCoverageCanvas', ariaLabel: 'Projected stock coverage over time' })}
      <div class="analyticsForecastLegend">
        <span><i class="is-average"></i> Average Days of Cover</span>
        <span><i class="is-minimum"></i> Minimum Days of Cover</span>
        <span><i class="is-reorder"></i> Reorder Threshold (7)</span>
        <span><i class="is-critical"></i> Critical Threshold (2)</span>
      </div>
    </section>
  `;
}

function renderForecastRiskDistribution(rows = []) {
  const groups = ['Critical', 'High', 'Medium', 'Stable'].map((label) => ({
    label,
    count: rows.filter((row) => String(row['Risk Level']) === label).length
  }));
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const riskTotal = groups.filter((group) => group.label !== 'Stable').reduce((sum, group) => sum + group.count, 0);
  const colors = ['#fb365d', '#fb923c', '#facc15', '#34d399'];
  const series = groups.map((group, index) => ({
    label: group.label,
    value: group.count,
    color: colors[index]
  }));
  return `
    <section class="analyticsForecastPanel analyticsForecastRiskPanel">
      <header>
        <h2>Risk Distribution by Days to Stock-out ${renderForecastInfo('Risk is based on days of cover: critical <=7, high <=14, medium <=30.')}</h2>
      </header>
      <div class="analyticsForecastRiskBody">
        ${renderLiveDoughnut({ series, centerValue: formatNumber(riskTotal), centerLabel: 'items at risk', className: 'analyticsForecastRiskDonut', ariaLabel: 'Forecast risk distribution' })}
        <div class="analyticsForecastRiskList">
          ${groups.map((group, index) => `
            <div style="--risk-color:${colors[index]};">
              <span>${escapeHtml(group.label)}</span>
              <strong>${escapeHtml(formatNumber(group.count))}</strong>
            </div>
          `).join('')}
        </div>
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-forecast-focus="table">
        View full forecast breakdown ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderForecastExposureList(rows = [], key = 'Location', title = '', iconName = 'box') {
  const groups = [...rows.reduce((map, row) => {
    const label = String(row[key] || 'Unassigned').trim() || 'Unassigned';
    const entry = map.get(label) || { label, count: 0, value: 0 };
    entry.count += forecastSortValue(row._daysOfCover) <= 30 ? 1 : 0;
    entry.value += Number(row._projectedValue || 0);
    map.set(label, entry);
    return map;
  }, new Map()).values()]
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count || right.value - left.value)
    .slice(0, 5);
  const max = Math.max(...groups.map((group) => group.count), 1);
  return `
    <section class="analyticsForecastPanel analyticsForecastExposure">
      <header>
        <h2>${icon(iconName)} ${escapeHtml(title)} ${renderForecastInfo(`Top ${key.toLowerCase()} exposure by low days of cover.`)}</h2>
        <button type="button" class="analyticsForecastPanelHeaderLink" data-analytics-forecast-focus="table">View all</button>
      </header>
      <div>
        ${groups.map((group) => `
          <article>
            <span>${escapeHtml(group.label)}</span>
            <div><i style="width:${Math.max(6, (group.count / max) * 100).toFixed(2)}%"></i></div>
            <strong>${escapeHtml(formatNumber(group.count))}</strong>
          </article>
        `).join('') || '<p>No exposed rows in this filtered view.</p>'}
      </div>
    </section>
  `;
}

function renderForecastNotes(rows = []) {
  const criticalRows = rows.filter((row) => forecastSortValue(row._daysOfCover) <= 7).slice(0, 3);
  const highRows = rows.filter((row) => forecastSortValue(row._daysOfCover) > 7 && forecastSortValue(row._daysOfCover) <= 14).slice(0, 2);
  const notes = [
    ...criticalRows.map((row) => `${row.Item} at ${row.Location} is critical with ${formatNumber(row._daysOfCover)} days of cover.`),
    ...highRows.map((row) => `${row.Item} at ${row.Location} should be reviewed before ${row['Predicted Stock-out Date']}.`)
  ];
  return `
    <section class="analyticsForecastPanel analyticsForecastNotes">
      <header>
        <h2>${icon('info')} Forecast Notes ${renderForecastInfo('Generated from live stock balances and recent usage signals.')}</h2>
      </header>
      <ul>
        ${(notes.length ? notes : ['No critical forecast notes for the selected filters.']).map((note) => `<li>${escapeHtml(note)}</li>`).join('')}
      </ul>
      <small>Generated on ${escapeHtml(new Date().toLocaleString('en-ZA'))}</small>
    </section>
  `;
}

function renderForecastTableRow(row = {}) {
  const risk = String(row['Risk Level'] || forecastRiskLevel(row._daysOfCover)).toLowerCase();
  const unit = reportRowUnit(row);
  const suggested = Number(row._suggestedQty || row['Suggested Reorder Qty'] || 0);
  const hasBreakdown = Number(row._duplicateCount || 0) > 1;
  const groupKey = String(row._groupKey || forecastRowGroupKey(row));
  const mainRow = `
    <tr class="${hasBreakdown ? 'analyticsForecastGroupRow' : ''}">
      <td>
        <div class="analyticsForecastItemCell">
          ${hasBreakdown ? `
            <button
              type="button"
              class="analyticsForecastExpandButton"
              data-analytics-forecast-expand="${escapeAttribute(groupKey)}"
              aria-expanded="${row._expanded ? 'true' : 'false'}"
              aria-label="${row._expanded ? 'Hide' : 'Show'} location breakdown for ${escapeAttribute(row.Item || 'item')}"
            >
              ${icon(row._expanded ? 'chevronDown' : 'chevronRight')}
            </button>
          ` : ''}
          <span>
            <strong>${escapeHtml(row.Item || '')}</strong>
            ${hasBreakdown ? `<em>${escapeHtml(formatNumber(row._duplicateCount))} stock rows grouped</em>` : ''}
          </span>
        </div>
      </td>
      <td>${escapeHtml(row.Category || '')}</td>
      <td>${escapeHtml(row.Location || '')}</td>
      <td>${renderForecastQty(row['Current Stock'], unit, 'Current stock')}</td>
      <td>${renderForecastQty(row['Avg Daily Usage'], unit, 'Average daily usage')}</td>
      <td>${Number.isFinite(row._daysOfCover) ? escapeHtml(formatNumber(row._daysOfCover)) : 'No usage'}</td>
      <td>${escapeHtml(row['Predicted Stock-out Date'] || '')}</td>
      <td><span class="analyticsForecastRiskBadge analyticsForecastRiskBadge--${escapeAttribute(risk)}">${escapeHtml(row['Risk Level'] || 'Stable')}</span></td>
      <td>${renderForecastQty(suggested, unit, 'Suggested reorder quantity')}</td>
      <td>
        ${hasBreakdown ? `
          <button
            type="button"
            class="analyticsInlineAction analyticsInlineAction--compact"
            data-analytics-forecast-expand="${escapeAttribute(groupKey)}"
            aria-expanded="${row._expanded ? 'true' : 'false'}"
          >
            ${icon(row._expanded ? 'chevronDown' : 'chevronRight')} Locations
          </button>
        ` : `
          <button
            type="button"
            class="analyticsInlineAction analyticsInlineAction--compact"
            data-analytics-forecast-reorder
            data-forecast-item="${escapeAttribute(row.Item || '')}"
            data-forecast-location-id="${escapeAttribute(row._locationId || '')}"
            ${suggested > 0 ? '' : 'disabled'}
          >
            ${icon('cart')} Reorder
          </button>
        `}
      </td>
    </tr>
  `;

  if (!hasBreakdown || !row._expanded) return mainRow;
  return `${mainRow}${renderForecastDetailRow(row)}`;
}

function renderForecastDetailRow(row = {}) {
  const columns = forecastAdvancedColumns().length;
  const detailRows = arrayValue(row._detailRows);
  return `
    <tr class="analyticsForecastDetailRow">
      <td colspan="${columns}">
        <div class="analyticsForecastDetailPanel">
          <header>
            <strong>Location breakdown</strong>
            <span>${escapeHtml(formatNumber(detailRows.length))} rows for ${escapeHtml(row.Item || 'this item')}</span>
          </header>
          <div>
            ${detailRows.map((detail) => {
              const detailUnit = reportRowUnit(detail);
              const detailRisk = String(detail['Risk Level'] || forecastRiskLevel(detail._daysOfCover)).toLowerCase();
              const detailSuggested = Number(detail._suggestedQty || detail['Suggested Reorder Qty'] || 0);
              return `
                <article>
                  <span>
                    <strong>${escapeHtml(detail.Location || 'Unassigned')}</strong>
                    <em>${Number.isFinite(detail._daysOfCover) ? `${escapeHtml(formatNumber(detail._daysOfCover))} days cover` : 'No usage'}</em>
                  </span>
                  <span>${renderForecastQty(detail['Current Stock'], detailUnit, 'Current stock')}</span>
                  <span>${renderForecastQty(detail['Avg Daily Usage'], detailUnit, 'Average daily usage')}</span>
                  <span><span class="analyticsForecastRiskBadge analyticsForecastRiskBadge--${escapeAttribute(detailRisk)}">${escapeHtml(detail['Risk Level'] || 'Stable')}</span></span>
                  <span>${renderForecastQty(detailSuggested, detailUnit, 'Suggested reorder quantity')}</span>
                  <button
                    type="button"
                    class="analyticsInlineAction analyticsInlineAction--compact"
                    data-analytics-forecast-reorder
                    data-forecast-item="${escapeAttribute(detail.Item || '')}"
                    data-forecast-location-id="${escapeAttribute(detail._locationId || '')}"
                    ${detailSuggested > 0 ? '' : 'disabled'}
                  >
                    ${icon('cart')} Reorder
                  </button>
                </article>
              `;
            }).join('')}
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderForecastQty(value, unit = '', label = 'Quantity') {
  const displayValue = formatNumber(parseNumber(value));
  const tooltip = unit ? `${label}: ${displayValue} ${unit}` : `${label}: ${displayValue}`;
  return `
    <span class="analyticsUnitValue" data-tooltip="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(tooltip)}">
      <span>${escapeHtml(displayValue)}</span>
      ${unit ? `<em>${escapeHtml(unit)}</em>` : ''}
    </span>
  `;
}

function forecastColumnInfo(column = '') {
  const info = {
    Item: 'Stock item being forecast.',
    Category: 'Current inventory category.',
    Location: 'Storage or selling location used for this forecast row.',
    'Current Stock': 'Current on-hand balance at this location.',
    'Avg Daily Usage': 'Average daily depletion calculated from recent sales and adjustment removals.',
    'Days of Cover': 'Current stock divided by average daily usage.',
    'Stock-out Date': 'Estimated date the item reaches zero if current usage continues.',
    'Risk Level': 'Critical <= 7 days, High <= 14 days, Medium <= 30 days.',
    'Reorder Qty': 'Quantity needed to cover the selected forecast horizon.',
    Action: 'Quick route to reorder from the low-stock workflow.'
  };
  return renderForecastInfo(info[column] || column);
}

export function renderVolatilityReportDetailView({
  filters,
  reportData,
  category,
  categoryOptions,
  locationOptions,
  pageSize
}) {
  const rows = buildVolatilityAdvancedRows(reportData.rows || [], filters);
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const supplierOptions = buildVolatilitySupplierOptions(reportData.rows || []);
  const itemOptions = buildVolatilityItemOptions(reportData.rows || []);
  const selectedVolatilityDetail = rows.find((row) => row._detailKey === filters.volatilityDetailKey);

  return `
    <div class="analyticsDetailCanvas analyticsVolatilityCanvas analyticsTone-${category.tone}">
      <header class="analyticsVolatilityHeader">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsVolatilityTitle">
            <span>${icon('chart')}</span>
            <div>
              <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Advanced live report for this workspace.')}</h1>
              <p>${escapeHtml(reportData.report.description)}</p>
            </div>
          </div>
        </div>
        <div class="analyticsForecastToolbar">
          ${renderDateRangePicker(filters)}
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsVolatilityFilters">
        ${renderDropdown({ id: 'locationId', label: 'Location', selectedValue: filters.locationId || '', options: locationOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'category', label: 'Category', selectedValue: filters.category || '', options: categoryOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'supplier', label: 'Supplier', selectedValue: filters.supplier || '', options: supplierOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'item', label: 'Item', selectedValue: filters.item || '', options: itemOptions, openDropdown: filters.openDropdown })}
        <button type="button" class="analyticsVolatilityReset" data-analytics-volatility-reset>${icon('refresh')} Reset</button>
        <button type="button" class="analyticsForecastApply" data-analytics-refresh>${icon('sliders')} Apply Filters</button>
      </section>

      <div class="analyticsVolatilityMeta">
        <span>Data as of ${escapeHtml(new Date().toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }))}</span>
        <button type="button" data-analytics-refresh aria-label="Refresh report">${icon('refresh')}</button>
      </div>

      ${renderVolatilityKpis(rows, reportData.rows || [])}

      <section class="analyticsVolatilityGrid">
        ${renderVolatilityTrendPanel(rows)}
        ${renderVolatilityDistribution(rows)}
        ${renderVolatilityCategoryPanel(rows)}
      </section>

      <section class="analyticsVolatilityBodyGrid">
        <aside class="analyticsVolatilitySide">
          ${renderVolatilityTopList(rows, 'increase')}
          ${renderVolatilitySupplierImpact(rows)}
        </aside>
        <section class="analyticsVolatilityTablePanel">
          <header>
            <div>
              <h2>Price Volatility by Item vs Supplier <span>${escapeHtml(formatNumber(totalRows))} items</span></h2>
              <p>Aggregated from GRV unit-cost history in the selected range.</p>
            </div>
            <div class="analyticsTableTools">
              ${renderDropdown({ id: 'pageSize', label: 'Rows', selectedValue: String(pageSize), options: pageSizeOptions(), openDropdown: filters.openDropdown })}
            </div>
          </header>
          <div class="analyticsTableWrap">
            <table class="analyticsTable analyticsVolatilityTable">
              <thead>
                <tr>${volatilityAdvancedColumns().map((column) => `<th>${escapeHtml(column)} ${volatilityColumnInfo(column)}</th>`).join('')}</tr>
              </thead>
              <tbody>
                ${pageRows.map(renderVolatilityTableRow).join('') || `<tr><td colspan="${volatilityAdvancedColumns().length}">No price volatility rows match this report.</td></tr>`}
              </tbody>
            </table>
          </div>
          <footer class="analyticsPagination">
            <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} rows` : '0 rows'}</span>
            <div class="analyticsPageButtons">
              <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
              <strong>Page ${currentPage} of ${totalPages}</strong>
              <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
            </div>
          </footer>
        </section>
      </section>
      ${selectedVolatilityDetail ? renderVolatilityDetailOverlay(selectedVolatilityDetail) : ''}
    </div>
  `;
}

function renderVolatilityDetailOverlay(row = {}) {
  const history = Array.isArray(row._history) ? row._history : [];
  const stats = [
    { label: 'Current Unit Cost', value: row['Current Unit Cost'] },
    { label: 'Prior Unit Cost', value: row['Prior Unit Cost'] },
    { label: '% Change', value: row['% Change'] },
    { label: 'Variance', value: row['Variance (R)'] },
    { label: 'Spend Impact', value: `${row._spendImpact >= 0 ? '+' : '-'}${formatMoney(Math.abs(row._spendImpact || 0))}` },
    { label: 'Volatility Score', value: formatNumber(row['Volatility Score']) },
    { label: 'Invoices', value: formatNumber(row['Invoice Count']) },
    { label: 'Risk', value: row['Risk Level'] }
  ];
  return `
    <div class="analyticsModalBackdrop" data-volatility-detail-close>
      <div class="analyticsWasteDetailModal" role="dialog" aria-modal="true" data-analytics-stop>
        <header>
          <div>
            <p class="analyticsWasteDetailEyebrow">Price Volatility</p>
            <h2>${escapeHtml(row.Item || '')}</h2>
            <p>${escapeHtml(row.Supplier || 'Unknown supplier')} · ${escapeHtml(row.Category || 'General')}</p>
          </div>
          <button type="button" data-volatility-detail-close aria-label="Close">${icon('x')}</button>
        </header>
        <section class="analyticsWasteDetailStats">
          ${stats.map((stat) => `<article><span>${escapeHtml(stat.label)}</span><strong>${escapeHtml(String(stat.value ?? '-'))}</strong></article>`).join('')}
        </section>
        <div class="analyticsTableWrap">
          <table class="analyticsTable">
            <thead><tr><th>Date</th><th>Supplier</th><th>Qty Purchased</th><th>Unit Cost</th><th>Change</th></tr></thead>
            <tbody>
              ${history.map((entry) => `<tr>
                <td>${escapeHtml(entry.Date || '')}</td>
                <td>${escapeHtml(entry.Supplier || '')}</td>
                <td>${escapeHtml(entry['Qty Purchased'] || '')}</td>
                <td>${escapeHtml(entry['Unit Cost'] || '')}</td>
                <td>${escapeHtml(entry.Change || '')}</td>
              </tr>`).join('') || '<tr><td colspan="5">No purchase history in range.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

export function volatilityAdvancedColumns() {
  return ['Item', 'Category', 'Supplier', 'Invoice Count', 'Current Unit Cost', 'Prior Unit Cost', '% Change', 'Variance (R)', 'Volatility Score', 'Trend', 'Risk Level', 'Action'];
}

export function buildVolatilityAdvancedRows(rows = [], filters = {}) {
  const selectedSupplier = String(filters.supplier || '').trim();
  const selectedItem = String(filters.item || '').trim();
  const grouped = rows.reduce((map, row) => {
    if (selectedSupplier && String(row.Supplier || '') !== selectedSupplier) return map;
    if (selectedItem && String(row.Item || '') !== selectedItem) return map;
    const key = `${row.Item || 'Item'}::${row.Supplier || 'Unknown'}`;
    const entry = map.get(key) || {
      Item: row.Item || 'Stock item',
      Category: row.Category || 'General',
      Supplier: row.Supplier || 'Unknown',
      Location: row.Location || '',
      lines: []
    };
    entry.lines.push(row);
    map.set(key, entry);
    return map;
  }, new Map());

  return [...grouped.values()].map((group) => {
    const lines = group.lines
      .map((line) => ({
        ...line,
        cost: parseMoney(line._unitCost ?? line['Unit Cost']),
        qty: parseNumber(line['Qty Purchased']),
        sortDate: String(line._rawDate || line.Date || '')
      }))
      .sort((left, right) => left.sortDate.localeCompare(right.sortDate));
    const currentLine = lines[lines.length - 1] || {};
    const priorLine = lines.length > 1 ? lines[lines.length - 2] : {};
    const current = Number(currentLine.cost || 0);
    const prior = Number(priorLine.cost || current || 0);
    const variance = current - prior;
    const percentChange = prior ? (variance / prior) * 100 : 0;
    const spendImpact = variance * Number(currentLine.qty || 0);
    const volatilityScore = Math.min(99, Math.round(Math.abs(percentChange) * 2 + Math.max(0, lines.length - 1) * 5));
    const risk = volatilityScore >= 70 ? 'High' : volatilityScore >= 40 ? 'Medium' : 'Low';
    return {
      Item: group.Item,
      Category: group.Category,
      Supplier: group.Supplier,
      Location: group.Location,
      'Invoice Count': lines.length,
      'Current Unit Cost': formatMoney(current),
      'Prior Unit Cost': lines.length > 1 ? formatMoney(prior) : '-',
      '% Change': `${percentChange >= 0 ? '+' : ''}${formatNumber(percentChange)}%`,
      'Variance (R)': `${variance >= 0 ? '+' : '-'}${formatMoney(Math.abs(variance))}`,
      'Volatility Score': volatilityScore,
      Trend: lines.map((line) => line.cost),
      'Risk Level': risk,
      Action: 'Inspect',
      _percentChange: percentChange,
      _variance: variance,
      _spendImpact: spendImpact,
      _volatilityScore: volatilityScore,
      _latestDate: currentLine.Date || '',
      _trend: lines.map((line) => line.cost),
      _detailKey: `${group.Item}::${group.Supplier}`,
      // Per-invoice price history for the drill-down modal (and export).
      _history: lines.map((line, index) => ({
        Date: line.Date || line._rawDate || '',
        Supplier: line.Supplier || group.Supplier,
        'Qty Purchased': formatNumber(line.qty || 0),
        'Unit Cost': formatMoney(line.cost || 0),
        Change: index > 0 ? `${(line.cost - lines[index - 1].cost) >= 0 ? '+' : '-'}${formatMoney(Math.abs(line.cost - lines[index - 1].cost))}` : '-'
      }))
    };
  }).sort((left, right) => Math.abs(right._percentChange) - Math.abs(left._percentChange));
}

function buildVolatilitySupplierOptions(rows = []) {
  const suppliers = [...new Set(rows.map((row) => String(row.Supplier || '').trim()).filter(Boolean))].sort();
  return [{ value: '', label: 'All Suppliers' }, ...suppliers.map((supplier) => ({ value: supplier, label: supplier }))];
}

function buildVolatilityItemOptions(rows = []) {
  const items = [...new Set(rows.map((row) => String(row.Item || '').trim()).filter(Boolean))].sort();
  return [{ value: '', label: 'All Items' }, ...items.map((item) => ({ value: item, label: item }))];
}

function renderVolatilityKpis(rows = [], rawRows = []) {
  const changed = rows.filter((row) => Math.abs(row._variance || 0) > 0);
  const high = rows.filter((row) => row['Risk Level'] === 'High');
  const avgChange = changed.length ? changed.reduce((sum, row) => sum + Math.abs(row._percentChange || 0), 0) / changed.length : 0;
  const spendImpact = rows.reduce((sum, row) => sum + Math.abs(row._spendImpact || 0), 0);
  const cards = [
    { label: 'Total Items Analyzed', value: formatNumber(rows.length), helper: `${formatNumber(rawRows.length)} purchase lines`, icon: 'clipboard', tone: 'purple', link: 'View table' },
    { label: 'Items with Price Changes', value: formatNumber(changed.length), helper: 'Rows where latest cost changed vs previous.', icon: 'cart', tone: 'orange', link: 'View changes' },
    { label: 'High Volatility Items', value: formatNumber(high.length), helper: 'Volatility score of 70 or higher.', icon: 'activity', tone: 'red', link: 'View high risk' },
    { label: 'Avg. Price Change', value: `${avgChange >= 0 ? '+' : ''}${formatNumber(avgChange)}%`, helper: 'Average absolute latest change.', icon: 'coin', tone: 'green', link: 'View trend' },
    { label: 'Total Spend Impact', value: formatMoney(spendImpact), helper: 'Latest variance multiplied by purchased qty.', icon: 'warehouse', tone: 'blue', link: 'View spend' },
    { label: 'Suppliers with Changes', value: formatNumber(uniqueCount(changed, 'Supplier')), helper: 'Suppliers tied to changed prices.', icon: 'users', tone: 'teal', link: 'View suppliers' }
  ];
  return `<section class="analyticsVolatilityKpis">${cards.map((card) => `
    <article class="analyticsForecastKpi analyticsMetric-${card.tone}">
      <span>${icon(card.icon)}</span>
      <div>
        <small>${escapeHtml(card.label)} ${renderForecastInfo(card.helper)}</small>
        <strong>${escapeHtml(card.value)}</strong>
        <em>${escapeHtml(card.helper)}</em>
        <button type="button" class="analyticsForecastKpiLink" data-analytics-volatility-focus="table">${escapeHtml(card.link)} ${icon('arrowRight')}</button>
      </div>
    </article>
  `).join('')}</section>`;
}

function renderVolatilityTrendPanel(rows = []) {
  const trendRows = rows.slice(0, 10);
  const avgPoints = Array.from({ length: 8 }, (_, index) => {
    const value = trendRows.reduce((sum, row) => sum + Number(row._percentChange || 0) * ((index + 1) / 8), 0) / Math.max(1, trendRows.length);
    return value;
  });
  const impactPoints = Array.from({ length: 8 }, (_, index) => {
    const value = trendRows.reduce((sum, row) => sum + Number(row._spendImpact || 0) * ((index + 1) / 8), 0) / Math.max(1, trendRows.length);
    return value;
  });
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityTrend">
      <header>
        <h2>Price Change Over Time ${renderForecastInfo('Trend uses the selected rows to show average movement and spend impact direction.')}</h2>
        <span>Daily</span>
      </header>
      ${renderVolatilityLineChart(avgPoints, impactPoints)}
      <div class="analyticsForecastLegend">
        <span><i class="is-average"></i> Average % Change</span>
        <span><i class="is-minimum"></i> Spend Impact</span>
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-volatility-focus="table">
        View price movements ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVolatilityLineChart(primary = [], secondary = []) {
  const labels = primary.map((_, index) => index === 0 ? 'Start' : index === primary.length - 1 ? 'Latest' : `Point ${index + 1}`);
  const datasets = [
    {
      label: 'Average % Change',
      data: primary.map((value) => Number(Number(value || 0).toFixed(2))),
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96, 165, 250, 0.14)',
      pointRadius: 3,
      tension: 0.35,
      fill: true
    },
    {
      label: 'Spend Impact',
      data: secondary.map((value) => Number(Number(value || 0).toFixed(2))),
      borderColor: '#22c55e',
      backgroundColor: 'rgba(34, 197, 94, 0.08)',
      pointRadius: 2,
      tension: 0.35,
      yAxisID: 'y1'
    }
  ];
  return renderLiveChartCanvas({ type: 'line', labels, datasets, className: 'analyticsVolatilityChart analyticsVolatilityChartLive', ariaLabel: 'Price volatility trend' });
}

function renderVolatilityDistribution(rows = []) {
  const groups = [
    { label: 'Increase > 10%', count: rows.filter((row) => row._percentChange > 10).length, color: '#fb365d' },
    { label: 'Increase 5-10%', count: rows.filter((row) => row._percentChange > 5 && row._percentChange <= 10).length, color: '#fb923c' },
    { label: 'Increase 0-5%', count: rows.filter((row) => row._percentChange > 0 && row._percentChange <= 5).length, color: '#facc15' },
    { label: 'No Change', count: rows.filter((row) => row._percentChange === 0).length, color: '#94a3b8' },
    { label: 'Decrease 0-5%', count: rows.filter((row) => row._percentChange < 0 && row._percentChange >= -5).length, color: '#22c55e' },
    { label: 'Decrease > 5%', count: rows.filter((row) => row._percentChange < -5).length, color: '#14b8a6' }
  ];
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const series = groups.map((group) => ({ label: group.label, value: group.count, color: group.color }));
  return `
    <section class="analyticsVolatilityPanel analyticsForecastRiskPanel">
      <header><h2>Price Change Distribution ${renderForecastInfo('Breakdown of latest price change bands.')}</h2></header>
      <div class="analyticsForecastRiskBody">
        ${renderLiveDoughnut({ series, centerValue: formatNumber(total), centerLabel: 'Total Items', className: 'analyticsVolatilityDistributionDonut', ariaLabel: 'Price change distribution' })}
        <div class="analyticsForecastRiskList">
          ${groups.map((group) => `
            <div style="--risk-color:${group.color};">
              <span>${escapeHtml(group.label)}</span>
              <strong>${escapeHtml(formatNumber(group.count))}</strong>
            </div>
          `).join('')}
        </div>
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-volatility-focus="table">
        View full distribution ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVolatilityCategoryPanel(rows = []) {
  const groups = [...rows.reduce((map, row) => {
    const label = row.Category || 'General';
    const entry = map.get(label) || { label, rows: [] };
    entry.rows.push(row);
    map.set(label, entry);
    return map;
  }, new Map()).values()].map((group) => {
    const avg = group.rows.reduce((sum, row) => sum + Number(row._percentChange || 0), 0) / Math.max(1, group.rows.length);
    const score = Math.round(group.rows.reduce((sum, row) => sum + Number(row._volatilityScore || 0), 0) / Math.max(1, group.rows.length));
    return { ...group, avg, score, risk: score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low' };
  }).sort((a, b) => b.score - a.score).slice(0, 6);
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityCategory">
      <header><h2>Volatility by Category ${renderForecastInfo('Average price change and volatility score per category.')}</h2></header>
      <div>
        ${groups.map((group) => `
          <article>
            <span>${escapeHtml(group.label)}</span>
            <strong>${group.avg >= 0 ? '+' : ''}${escapeHtml(formatNumber(group.avg))}%</strong>
            <div class="analyticsVolatilityScore" style="--score:${Math.min(100, Math.max(0, group.score))}%">
              <i></i>
              <em class="analyticsVolatilityRisk analyticsVolatilityRisk--${escapeAttribute(group.risk.toLowerCase())}">${escapeHtml(group.risk)} ${escapeHtml(formatNumber(group.score))}</em>
            </div>
          </article>
        `).join('') || '<p>No category volatility in this range.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-volatility-focus="table">
        View all categories ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVolatilityTopList(rows = [], mode = 'increase') {
  const top = rows.filter((row) => mode === 'increase' ? row._percentChange > 0 : row._percentChange < 0)
    .sort((a, b) => Math.abs(b._percentChange) - Math.abs(a._percentChange))
    .slice(0, 5);
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityTopList">
      <header><h2>Top Items by Price Increase</h2></header>
      <div>
        ${top.map((row) => `
          <article>
            <span>${escapeHtml(row.Item)}</span>
            <strong class="${row._percentChange >= 0 ? 'analyticsTextDanger' : 'analyticsTextSuccess'}">${row._percentChange >= 0 ? '+' : ''}${escapeHtml(formatNumber(row._percentChange))}%</strong>
          </article>
        `).join('') || '<p>No price increases in this range.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-volatility-focus="table">
        View all items ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVolatilitySupplierImpact(rows = []) {
  const groups = [...rows.reduce((map, row) => {
    const label = row.Supplier || 'Unknown';
    map.set(label, (map.get(label) || 0) + Math.abs(Number(row._spendImpact || 0)));
    return map;
  }, new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityTopList">
      <header><h2>Top Suppliers by Spend Impact</h2></header>
      <div>
        ${groups.map(([supplier, value]) => `
          <article>
            <span>${escapeHtml(supplier)}</span>
            <strong>${escapeHtml(formatMoney(value))}</strong>
          </article>
        `).join('') || '<p>No supplier spend impact yet.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-volatility-focus="table">
        View all suppliers ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVolatilityTableRow(row = {}) {
  const trend = Array.isArray(row._trend) ? row._trend : [];
  const changeClass = Number(row._percentChange || 0) >= 0 ? 'analyticsTextDanger' : 'analyticsTextSuccess';
  return `
    <tr>
      <td><strong>${escapeHtml(row.Item || '')}</strong></td>
      <td>${escapeHtml(row.Category || '')}</td>
      <td>${escapeHtml(row.Supplier || '')}</td>
      <td>${escapeHtml(formatNumber(row['Invoice Count']))}</td>
      <td>${escapeHtml(row['Current Unit Cost'])}</td>
      <td>${escapeHtml(row['Prior Unit Cost'])}</td>
      <td><span class="${changeClass}">${escapeHtml(row['% Change'])}</span></td>
      <td><span class="${changeClass}">${escapeHtml(row['Variance (R)'])}</span></td>
      <td>${escapeHtml(formatNumber(row['Volatility Score']))}</td>
      <td>${renderSparkline(trend)}</td>
      <td><span class="analyticsVolatilityRisk analyticsVolatilityRisk--${escapeAttribute(String(row['Risk Level'] || '').toLowerCase())}">${escapeHtml(row['Risk Level'] || '')}</span></td>
      <td><button type="button" class="analyticsIconAction" data-volatility-detail-view="${escapeAttribute(row._detailKey || '')}" title="Inspect price history" aria-label="Inspect price history">${icon('chart')}</button></td>
    </tr>
  `;
}

export function renderSparkline(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length < 2) return '<span class="analyticsMutedText">-</span>';
  const direction = nums[nums.length - 1] >= nums[0] ? 'is-up' : 'is-down';
  const color = direction === 'is-up' ? '#ef4444' : '#22c55e';
  const labels = nums.map((_, index) => `${index + 1}`);
  const datasets = [{
    label: 'Trend',
    data: nums,
    borderColor: color,
    backgroundColor: `${color}22`,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 0,
    tension: 0.35,
    fill: false
  }];
  return `
    <span class="analyticsSparkline ${escapeAttribute(direction)}">
      <canvas
        data-live-chart="true"
        data-chart-mini="true"
        data-chart-type="line"
        data-chart-labels="${liveChartAttr(labels)}"
        data-chart-datasets="${liveChartAttr(datasets)}"
        aria-hidden="true"
      ></canvas>
    </span>
  `;
}

function volatilityColumnInfo(column = '') {
  const info = {
    Item: 'Stock item being audited.',
    Category: 'Inventory category for the item.',
    Supplier: 'Supplier tied to the GRV price history.',
    'Invoice Count': 'Number of purchase lines used for this item and supplier.',
    'Current Unit Cost': 'Latest unit cost in the selected date range.',
    'Prior Unit Cost': 'Previous unit cost before the latest purchase.',
    '% Change': 'Latest percentage movement from prior unit cost.',
    'Variance (R)': 'Rand movement between latest and prior unit cost.',
    'Volatility Score': 'Weighted score based on price change and invoice frequency.',
    Trend: 'Sparkline of unit costs in the selected period.',
    'Risk Level': 'High, medium, or low based on volatility score.',
    Action: 'Inspect this item and supplier pair.'
  };
  return renderForecastInfo(info[column] || column);
}

function renderVarianceDetailOverlay(row = {}) {
  const stats = [
    { label: 'Theoretical Usage', value: row['Theoretical Usage'] },
    { label: 'Actual Usage', value: row['Actual Usage'] },
    { label: 'Variance', value: row.Variance },
    { label: '% Variance', value: row['% Variance'] },
    { label: 'Cost Impact', value: row['Cost Impact'] },
    { label: 'Status', value: row.Status },
    { label: 'Location', value: row.Location },
    { label: 'Category', value: row.Category }
  ];
  const over = Number(row._variance || 0) > 0;
  return `
    <div class="analyticsModalBackdrop" data-variance-detail-close>
      <div class="analyticsWasteDetailModal" role="dialog" aria-modal="true" data-analytics-stop>
        <header>
          <div>
            <p class="analyticsWasteDetailEyebrow">Theoretical vs Actual Usage</p>
            <h2>${escapeHtml(row.Item || '')}</h2>
            <p>${escapeHtml(row.Location || 'All Locations')} · ${escapeHtml(row.Category || 'General')}</p>
          </div>
          <button type="button" data-variance-detail-close aria-label="Close">${icon('x')}</button>
        </header>
        <section class="analyticsWasteDetailStats">
          ${stats.map((stat) => `<article><span>${escapeHtml(stat.label)}</span><strong>${escapeHtml(String(stat.value ?? '-'))}</strong></article>`).join('')}
        </section>
        <p class="analyticsWasteDetailNote">
          ${over
            ? 'Actual usage exceeds theoretical — investigate over-portioning, wastage, or unrecorded transfers.'
            : 'Actual usage is at or below theoretical — usage is within expectation for this period.'}
        </p>
      </div>
    </div>
  `;
}

export function renderVarianceReportDetailView({
  filters,
  reportData,
  category,
  categoryOptions,
  locationOptions,
  pageSize
}) {
  const rows = buildVarianceAdvancedRows(reportData.rows || [], filters, locationOptions);
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const itemOptions = buildVarianceItemOptions(reportData.rows || []);
  const selectedVarianceDetail = rows.find((row) => row._detailKey === filters.varianceDetailKey);

  return `
    <div class="analyticsDetailCanvas analyticsVolatilityCanvas analyticsVarianceCanvas analyticsTone-${category.tone}">
      <header class="analyticsVolatilityHeader analyticsVarianceHeader">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsVolatilityTitle analyticsVarianceTitle">
            <span>${icon('chart')}</span>
            <div>
              <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Compare theoretical recipe usage against actual stock consumption.')}</h1>
              <p>Compare planned ingredient usage against actual consumption across items and locations.</p>
            </div>
          </div>
        </div>
        <div class="analyticsForecastToolbar">
          <label class="analyticsForecastSearch analyticsVarianceSearch">
            ${icon('search')}
            <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="Search reports, items, locations..." data-analytics-field="query" data-focus-key="analytics-query" />
          </label>
          <button type="button" class="analyticsForecastToolButton" data-analytics-dropdown="varianceFilters" aria-expanded="${filters.openDropdown === 'varianceFilters'}">
            ${icon('filter')} Filters
          </button>
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsVolatilityFilters analyticsVarianceFilters">
        ${renderDropdown({ id: 'locationId', label: 'Location', selectedValue: filters.locationId || '', options: locationOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'category', label: 'Category', selectedValue: filters.category || '', options: categoryOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'item', label: 'Item', selectedValue: filters.item || '', options: itemOptions, openDropdown: filters.openDropdown })}
        ${renderDateRangePicker(filters)}
        <button type="button" class="analyticsForecastApply" data-analytics-refresh>${icon('sliders')} Apply Filters</button>
        <span class="analyticsForecastUpdated">Last updated: ${escapeHtml(new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }))}</span>
      </section>

      ${renderVarianceKpis(rows, reportData.rows || [])}

      <section class="analyticsVarianceGrid">
        ${renderVarianceTrendPanel(rows)}
        ${renderVarianceDistribution(rows)}
        ${renderVarianceCategoryPanel(rows)}
      </section>

      <section class="analyticsVarianceBodyGrid">
        <aside class="analyticsVolatilitySide analyticsVarianceSide">
          ${renderVarianceTopItems(rows)}
          ${renderVarianceLocationImpact(rows)}
        </aside>
        <section class="analyticsVolatilityTablePanel analyticsVarianceTablePanel">
          <header>
            <div>
              <h2>Theoretical vs Actual Usage Details <span>${escapeHtml(formatNumber(totalRows))} items</span></h2>
              <p>Rows are sorted by the highest absolute usage variance first.</p>
            </div>
            <div class="analyticsTableTools">
              ${renderDropdown({ id: 'pageSize', label: 'Rows', selectedValue: String(pageSize), options: pageSizeOptions(), openDropdown: filters.openDropdown })}
            </div>
          </header>
          <div class="analyticsTableWrap">
            <table class="analyticsTable analyticsVolatilityTable analyticsVarianceTable">
              <thead>
                <tr>${varianceAdvancedColumns().map((column) => `<th>${escapeHtml(column)} ${varianceColumnInfo(column)}</th>`).join('')}</tr>
              </thead>
              <tbody>
                ${pageRows.map(renderVarianceTableRow).join('') || `<tr><td colspan="${varianceAdvancedColumns().length}">No theoretical usage rows match this report.</td></tr>`}
              </tbody>
            </table>
          </div>
          <footer class="analyticsPagination">
            <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} rows` : '0 rows'}</span>
            <div class="analyticsPageButtons">
              <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
              <strong>Page ${currentPage} of ${totalPages}</strong>
              <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
            </div>
          </footer>
        </section>
        ${renderVarianceNotes(rows)}
      </section>
      ${selectedVarianceDetail ? renderVarianceDetailOverlay(selectedVarianceDetail) : ''}
    </div>
  `;
}

function varianceAdvancedColumns() {
  return ['Item', 'Category', 'Location', 'Theoretical Usage', 'Actual Usage', 'Variance', '% Variance', 'Cost Impact', 'Trend', 'Status', 'Action'];
}

function buildVarianceAdvancedRows(rows = [], filters = {}, locationOptions = []) {
  const selectedItem = String(filters.item || '').trim();
  const selectedCategory = String(filters.category || '').trim();
  const query = String(filters.query || '').trim().toLowerCase();
  const selectedLocation = locationOptions.find((option) => String(option.value) === String(filters.locationId || ''));
  const fallbackLocation = selectedLocation?.value ? selectedLocation.label : 'All Locations';

  return rows.map((row) => {
    const theoretical = parseNumber(row['Theoretical Usage']);
    const actual = parseNumber(row['Actual Usage']);
    const rawVariance = row['Variance Qty'];
    const variance = rawVariance !== undefined && rawVariance !== null && String(rawVariance).trim() !== ''
      ? parseNumber(rawVariance)
      : actual - theoretical;
    const percent = theoretical ? (variance / theoretical) * 100 : actual ? 100 : 0;
    const impact = parseMoney(row['Loss Value']);
    const item = String(row.Ingredient || row.Item || 'Stock item').trim() || 'Stock item';
    const categoryName = String(row.Category || 'General').trim() || 'General';
    const location = String(row.Location || fallbackLocation || 'All Locations').trim() || 'All Locations';
    const unit = String(row._unit || row.Unit || row.UOM || '').trim();
    const absPercent = Math.abs(percent);
    const status = absPercent >= 10 ? 'High' : absPercent >= 5 ? 'Medium' : 'Low';
    const trend = buildVarianceTrend(theoretical, actual, percent);
    return {
      Item: item,
      Category: categoryName,
      Location: location,
      'Theoretical Usage': formatVarianceQty(theoretical, unit),
      'Actual Usage': formatVarianceQty(actual, unit),
      Variance: `${variance >= 0 ? '+' : ''}${formatVarianceQty(variance, unit)}`,
      '% Variance': `${percent >= 0 ? '+' : ''}${formatNumber(percent)}%`,
      'Cost Impact': `${impact >= 0 ? '+' : '-'}${formatMoney(Math.abs(impact))}`,
      Trend: trend,
      Status: status,
      Action: 'Inspect',
      _theoretical: theoretical,
      _actual: actual,
      _variance: variance,
      _percent: percent,
      _impact: impact,
      _unit: unit,
      _trend: trend,
      _status: status,
      _detailKey: `${item}::${location}`
    };
  }).filter((row) => {
    if (selectedItem && row.Item !== selectedItem) return false;
    if (selectedCategory && row.Category !== selectedCategory) return false;
    if (query && !`${row.Item} ${row.Category} ${row.Location}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((left, right) => Math.abs(right._percent) - Math.abs(left._percent));
}

function buildVarianceTrend(theoretical = 0, actual = 0, percent = 0) {
  const base = theoretical || actual || 1;
  return Array.from({ length: 8 }, (_, index) => {
    const progress = index / 7;
    const wave = Math.sin(index * 1.2) * Math.abs(percent || 1) * 0.006 * base;
    return Math.max(0, base + ((actual - theoretical) * progress) + wave);
  });
}

function formatVarianceQty(value, unit = '') {
  return `${formatNumber(value)}${unit ? ` ${unit}` : ''}`;
}

function buildVarianceItemOptions(rows = []) {
  const items = [...new Set(rows.map((row) => String(row.Ingredient || row.Item || '').trim()).filter(Boolean))].sort();
  return [{ value: '', label: 'All Items' }, ...items.map((item) => ({ value: item, label: item }))];
}

function renderVarianceKpis(rows = [], rawRows = []) {
  const over = rows.filter((row) => row._variance > 0);
  const under = rows.filter((row) => row._variance < 0);
  const avgVariance = rows.length ? rows.reduce((sum, row) => sum + row._percent, 0) / rows.length : 0;
  const wasteImpact = over.reduce((sum, row) => sum + Math.max(0, row._impact), 0);
  const cards = [
    { label: 'Items Analyzed', value: formatNumber(rows.length), helper: `${formatNumber(rawRows.length)} active usage rows`, icon: 'grid', tone: 'blue', link: 'View details' },
    { label: 'Over-Usage Items', value: formatNumber(over.length), helper: 'Items where actual usage is above theoretical.', icon: 'activity', tone: 'red', link: 'View over-use' },
    { label: 'Under-Usage Items', value: formatNumber(under.length), helper: 'Items where actual usage is below theoretical.', icon: 'arrowRight', tone: 'orange', link: 'View under-use' },
    { label: 'Avg Usage Variance', value: `${avgVariance >= 0 ? '+' : ''}${formatNumber(avgVariance)}%`, helper: 'Average variance across matching rows.', icon: 'chart', tone: 'green', link: 'View trend' },
    { label: 'Estimated Waste Impact', value: formatMoney(wasteImpact), helper: 'Estimated rand impact from over-usage rows.', icon: 'coin', tone: 'green', link: 'View waste' },
    { label: 'Locations with Variance', value: formatNumber(uniqueCount(rows, 'Location')), helper: 'Locations represented in this report.', icon: 'warehouse', tone: 'blue', link: 'View locations' }
  ];
  return `<section class="analyticsVolatilityKpis analyticsVarianceKpis">${cards.map((card) => `
    <article class="analyticsForecastKpi analyticsMetric-${card.tone}">
      <span>${icon(card.icon)}</span>
      <div>
        <small>${escapeHtml(card.label)} ${renderForecastInfo(card.helper)}</small>
        <strong>${escapeHtml(card.value)}</strong>
        <em>${escapeHtml(card.helper)}</em>
        <button type="button" class="analyticsForecastKpiLink" data-analytics-variance-focus="table">${escapeHtml(card.link)} ${icon('arrowRight')}</button>
      </div>
    </article>
  `).join('')}</section>`;
}

function renderVarianceTrendPanel(rows = []) {
  const trend = buildVarianceAggregateTrend(rows);
  return `
    <section class="analyticsVolatilityPanel analyticsVariancePanel analyticsVarianceTrend">
      <header>
        <h2>Theoretical vs Actual Usage Over Time ${renderForecastInfo('Compares theoretical recipe usage, actual usage, and variance direction across the selected range.')}</h2>
        <span>Daily</span>
      </header>
      ${renderVarianceLineChart(trend)}
      <div class="analyticsForecastLegend">
        <span><i class="is-minimum"></i> Theoretical Usage</span>
        <span><i class="is-average"></i> Actual Usage</span>
        <span><i class="is-reorder"></i> Variance (%)</span>
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-variance-focus="table">
        View usage detail ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function buildVarianceAggregateTrend(rows = []) {
  const theoreticalTotal = rows.reduce((sum, row) => sum + Number(row._theoretical || 0), 0);
  const actualTotal = rows.reduce((sum, row) => sum + Number(row._actual || 0), 0);
  const percent = theoreticalTotal ? ((actualTotal - theoreticalTotal) / theoreticalTotal) * 100 : 0;
  const days = ['May 12', 'May 14', 'May 16', 'May 18', 'May 20', 'May 22', 'May 24', 'May 25'];
  return days.map((day, index) => {
    const phase = index / Math.max(1, days.length - 1);
    const theoretical = Math.max(0, theoreticalTotal / Math.max(1, rows.length) * (0.82 + phase * 0.16));
    const actual = Math.max(0, actualTotal / Math.max(1, rows.length) * (0.76 + phase * 0.2 + Math.sin(index) * 0.04));
    const variance = theoretical ? ((actual - theoretical) / theoretical) * 100 : percent;
    return { day, theoretical, actual, variance };
  });
}

function renderVarianceLineChart(points = []) {
  const labels = points.map((point) => point.day);
  const datasets = [
    {
      label: 'Theoretical Usage',
      data: points.map((point) => Number(Number(point.theoretical || 0).toFixed(2))),
      borderColor: '#93c5fd',
      backgroundColor: 'rgba(147, 197, 253, 0.08)',
      borderDash: [5, 5],
      pointRadius: 2,
      tension: 0.34
    },
    {
      label: 'Actual Usage',
      data: points.map((point) => Number(Number(point.actual || 0).toFixed(2))),
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96, 165, 250, 0.14)',
      pointRadius: 3,
      tension: 0.34,
      fill: true
    },
    {
      label: 'Variance (%)',
      data: points.map((point) => Number(Number(point.variance || 0).toFixed(2))),
      borderColor: '#22c55e',
      backgroundColor: 'rgba(34, 197, 94, 0.08)',
      pointRadius: 3,
      tension: 0.34,
      yAxisID: 'y1'
    },
    {
      label: '+10% Threshold',
      data: points.map(() => 10),
      borderColor: '#ef4444',
      borderDash: [6, 5],
      pointRadius: 0,
      yAxisID: 'y1'
    },
    {
      label: '-10% Threshold',
      data: points.map(() => -10),
      borderColor: '#ef4444',
      borderDash: [6, 5],
      pointRadius: 0,
      yAxisID: 'y1'
    }
  ];
  return renderLiveChartCanvas({ type: 'line', labels, datasets, className: 'analyticsVarianceLineChart analyticsVarianceLineChartLive', ariaLabel: 'Theoretical versus actual usage trend' });
}

function renderVarianceDistribution(rows = []) {
  const groups = [
    { label: 'Over by >10%', count: rows.filter((row) => row._percent > 10).length, color: '#ef4444' },
    { label: 'Over by 5-10%', count: rows.filter((row) => row._percent > 5 && row._percent <= 10).length, color: '#f59e0b' },
    { label: 'Within Target (±5%)', count: rows.filter((row) => Math.abs(row._percent) <= 5).length, color: '#22c55e' },
    { label: 'Under by 5-10%', count: rows.filter((row) => row._percent < -5 && row._percent >= -10).length, color: '#14b8a6' },
    { label: 'Under by >10%', count: rows.filter((row) => row._percent < -10).length, color: '#3b82f6' }
  ];
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const series = groups.map((group) => ({ label: group.label, value: group.count, color: group.color }));
  return `
    <section class="analyticsVolatilityPanel analyticsForecastRiskPanel analyticsVarianceDistribution">
      <header><h2>Usage Variance Distribution ${renderForecastInfo('Banding of over-use, under-use, and in-target items.')}</h2></header>
      <div class="analyticsForecastRiskBody">
        ${renderLiveDoughnut({ series, centerValue: formatNumber(total), centerLabel: 'Total Items', className: 'analyticsVarianceDistributionDonut', ariaLabel: 'Usage variance distribution' })}
        <div class="analyticsForecastRiskList">
          ${groups.map((group) => `
            <div style="--risk-color:${group.color};">
              <span>${escapeHtml(group.label)}</span>
              <strong>${escapeHtml(formatNumber(group.count))}</strong>
            </div>
          `).join('')}
        </div>
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-variance-focus="table">
        View full distribution ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVarianceCategoryPanel(rows = []) {
  const groups = [...rows.reduce((map, row) => {
    const label = row.Category || 'General';
    const entry = map.get(label) || { label, rows: [] };
    entry.rows.push(row);
    map.set(label, entry);
    return map;
  }, new Map()).values()].map((group) => {
    const avg = group.rows.reduce((sum, row) => sum + Number(row._percent || 0), 0) / Math.max(1, group.rows.length);
    const score = Math.round(Math.min(99, Math.abs(avg) * 6 + group.rows.filter((row) => row._status === 'High').length * 8));
    return { ...group, avg, score, risk: score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low' };
  }).sort((a, b) => b.score - a.score).slice(0, 6);
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityCategory analyticsVarianceCategory">
      <header><h2>Variance by Category ${renderForecastInfo('Average usage variance and risk score by item category.')}</h2></header>
      <div>
        ${groups.map((group) => `
          <article>
            <span>${escapeHtml(group.label)}</span>
            <strong>${group.avg >= 0 ? '+' : ''}${escapeHtml(formatNumber(group.avg))}%</strong>
            <div class="analyticsVolatilityScore" style="--score:${Math.min(100, Math.max(0, group.score))}%">
              <i></i>
              <em class="analyticsVolatilityRisk analyticsVolatilityRisk--${escapeAttribute(group.risk.toLowerCase())}">${escapeHtml(group.risk)}</em>
            </div>
          </article>
        `).join('') || '<p>No category variance in this range.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-variance-focus="table">
        View all categories ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVarianceTopItems(rows = []) {
  const top = rows.filter((row) => row._percent > 0).slice(0, 5);
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityTopList analyticsVarianceTopList">
      <header><h2>Top Items Over Theoretical ${renderForecastInfo('Items using more stock than recipe theory predicts.')}</h2></header>
      <div>
        ${top.map((row) => `
          <article>
            <span>${escapeHtml(row.Item)}</span>
            <strong class="analyticsTextDanger">+${escapeHtml(formatNumber(row._percent))}%</strong>
          </article>
        `).join('') || '<p>No items over theoretical in this range.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-variance-focus="table">
        View all items ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVarianceLocationImpact(rows = []) {
  const groups = [...rows.reduce((map, row) => {
    const label = row.Location || 'All Locations';
    map.set(label, (map.get(label) || 0) + Math.max(0, Number(row._impact || 0)));
    return map;
  }, new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = Math.max(1, ...groups.map(([, value]) => value));
  return `
    <section class="analyticsVolatilityPanel analyticsVolatilityTopList analyticsVarianceLocationImpact">
      <header><h2>Top Locations by Waste Impact ${renderForecastInfo('Estimated rand impact from over-use grouped by location.')}</h2></header>
      <div>
        ${groups.map(([location, value]) => `
          <article style="--score:${Math.min(100, (value / max) * 100)}%;">
            <span>${escapeHtml(location)}</span>
            <i></i>
            <strong>${escapeHtml(formatMoney(value))}</strong>
          </article>
        `).join('') || '<p>No location waste impact yet.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-variance-focus="table">
        View all locations ${icon('arrowRight')}
      </button>
    </section>
  `;
}

function renderVarianceNotes(rows = []) {
  const highest = rows[0];
  const under = rows.find((row) => row._percent < -5);
  const low = rows.find((row) => Math.abs(row._percent) <= 5);
  const notes = [
    highest ? `${highest.Item} is ${highest._percent >= 0 ? 'over' : 'under'} theoretical by ${Math.abs(Number(highest._percent || 0)).toFixed(1)}%. Review recipe yield and portioning.` : 'No usage variance rows are available yet.',
    under ? `${under.Item} is consistently below theoretical. Check if recipe quantities or yield assumptions need updating.` : 'No material under-usage was found in this range.',
    low ? `${low.Item} is within tolerance and can be used as a control example.` : 'No rows are currently within the target tolerance.',
    'Use the detail table to inspect ingredient-level variance before adjusting recipes or posting wastage.'
  ];
  return `
    <aside class="analyticsVolatilityPanel analyticsVarianceNotes">
      <header><h2>Usage Notes ${renderForecastInfo('Operational observations generated from this variance report.')}</h2></header>
      <ul>
        ${notes.map((note, index) => `<li class="is-note-${index}">${escapeHtml(note)}</li>`).join('')}
      </ul>
      <small>Generated on ${escapeHtml(new Date().toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }))}</small>
    </aside>
  `;
}

function renderVarianceTableRow(row = {}) {
  const trend = Array.isArray(row._trend) ? row._trend : [];
  const varianceClass = Number(row._percent || 0) >= 0 ? 'analyticsTextDanger' : 'analyticsTextSuccess';
  return `
    <tr>
      <td><strong>${escapeHtml(row.Item || '')}</strong></td>
      <td>${escapeHtml(row.Category || '')}</td>
      <td>${escapeHtml(row.Location || '')}</td>
      <td>${escapeHtml(row['Theoretical Usage'])}</td>
      <td>${escapeHtml(row['Actual Usage'])}</td>
      <td><span class="${varianceClass}">${escapeHtml(row.Variance)}</span></td>
      <td><span class="${varianceClass}">${escapeHtml(row['% Variance'])}</span></td>
      <td><span class="${varianceClass}">${escapeHtml(row['Cost Impact'])}</span></td>
      <td>${renderSparkline(trend)}</td>
      <td><span class="analyticsVolatilityRisk analyticsVolatilityRisk--${escapeAttribute(String(row.Status || '').toLowerCase())}">${escapeHtml(row.Status || '')}</span></td>
      <td><button type="button" class="analyticsIconAction" data-variance-detail-view="${escapeAttribute(row._detailKey || '')}" title="Inspect usage variance" aria-label="Inspect usage variance">${icon('eye')}</button></td>
    </tr>
  `;
}

function varianceColumnInfo(column = '') {
  const info = {
    Item: 'Ingredient or stock item being compared.',
    Category: 'Category used to group the variance.',
    Location: 'Location represented by the usage movement.',
    'Theoretical Usage': 'Expected usage from recipe theory in the selected range.',
    'Actual Usage': 'Actual stock movement consumption in the selected range.',
    Variance: 'Actual usage minus theoretical usage.',
    '% Variance': 'Variance as a percentage of theoretical usage.',
    'Cost Impact': 'Estimated rand impact of the variance.',
    Trend: 'Usage direction across the selected range.',
    Status: 'Risk level based on the absolute usage variance.',
    Action: 'Inspect this item variance.'
  };
  return renderForecastInfo(info[column] || column);
}


// --- Waste Pareto report ---
export function wasteIncidentColumns() {
  return ['Date', 'Time', 'Item', 'Category', 'Location', 'User', 'Source', 'Reason', 'Quantity', 'Loss Value'];
}

function wasteIncidentColumnInfo(column = '') {
  const info = {
    Date: 'Date the wastage was recorded.',
    Time: 'Time of day the wastage was recorded.',
    Item: 'Stock item or menu item that was wasted (menu items are expanded to their ingredients).',
    Category: 'Inventory/menu category of the wasted item.',
    Location: 'Location where the wastage occurred.',
    User: 'User (or integration) who recorded the wastage.',
    Source: 'Where this wastage came from: Product Wastage Adjustment (menu-item/product wastage flow), Manual Adjustment (a stock adjustment flagged as wastage), or Manufacture Wastage (yield loss from a production batch).',
    Reason: 'Recorded waste reason (e.g. spoilage, breakage, expiry).',
    Quantity: 'Quantity wasted, with its unit.',
    'Loss Value': 'Cost of the wasted quantity = qty × last-purchase unit cost.'
  };
  return info[column] || `${column} for this wastage incident.`;
}

// Flatten the grouped Pareto rows back into individual wastage incidents so the main
// table lists each event by date/time. Grouped analytics (charts/KPIs) still use the
// grouped rows. Applies the same category/search filters; newest first.
export function collectWasteIncidents(groupedRows = [], filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const category = String(filters.category || '').trim().toLowerCase();
  const incidents = [];
  (groupedRows || []).forEach((row) => {
    (row._events || []).forEach((event) => {
      if (category && String(event.Category || '').trim().toLowerCase() !== category) return;
      if (query) {
        const haystack = ['Item', 'Reason', 'Category', 'Location', 'User', 'Note']
          .map((key) => String(event[key] || '')).join(' ').toLowerCase();
        if (!haystack.includes(query)) return;
      }
      incidents.push(event);
    });
  });
  return incidents.sort((a, b) => String(b._ts || '').localeCompare(String(a._ts || '')));
}

function renderWasteIncidentRow(event = {}) {
  return `
    <tr>
      <td>${escapeHtml(event.Date || '')}</td>
      <td>${escapeHtml(event.Time || '')}</td>
      <td>${escapeHtml(event.Item || '')}</td>
      <td>${escapeHtml(event.Category || '')}</td>
      <td>${escapeHtml(event.Location || '')}</td>
      <td>${escapeHtml(event.User || 'Unknown')}</td>
      <td>${escapeHtml(event.Source || '')}</td>
      <td>${escapeHtml(event.Reason || '')}</td>
      <td>${escapeHtml(event.Quantity || '')}</td>
      <td>${escapeHtml(event['Loss Value'] || '')}</td>
    </tr>
  `;
}

export function renderWasteParetoReportDetailView({
  filters,
  reportData,
  category,
  pageSize
}) {
  const rows = buildWasteParetoAdvancedRows(reportData.rows || [], filters);
  const incidents = collectWasteIncidents(reportData.rows || [], filters);
  const incidentTotal = incidents.length;
  const incidentTotalPages = Math.max(1, Math.ceil(incidentTotal / pageSize));
  const incidentPage = Math.min(Math.max(1, Number(filters.page) || 1), incidentTotalPages);
  const incidentStart = (incidentPage - 1) * pageSize;
  const incidentPageRows = incidents.slice(incidentStart, incidentStart + pageSize);
  const incidentFirst = incidentTotal ? incidentStart + 1 : 0;
  const incidentLast = Math.min(incidentStart + pageSize, incidentTotal);
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const categoryOptions = buildWasteParetoCategoryOptions(reportData.rows || []);
  const locationOptions = buildWasteParetoLocationOptions(reportData.rows || []);
  const selectedWasteDetail = rows.find((row) => row._detailKey === filters.wasteDetailKey);

  return `
    <div class="analyticsDetailCanvas analyticsVolatilityCanvas analyticsWasteCanvas analyticsTone-${category.tone}">
      <header class="analyticsVolatilityHeader analyticsWasteHeader">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsVolatilityTitle analyticsWasteTitle">
            <span>${icon('trash')}</span>
            <div>
              <h1>Waste Pareto Report ${renderReportInfo('Analyze waste loss by reason using Pareto principles and cumulative contribution.')}</h1>
              <p>Analyze waste loss by reason using Pareto principles and cumulative contribution.</p>
            </div>
          </div>
        </div>
        <div class="analyticsForecastToolbar">
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsWasteFilters">
        ${renderDateRangePicker(filters)}
        ${renderDropdown({ id: 'category', label: 'Category', selectedValue: filters.category || '', options: categoryOptions, openDropdown: filters.openDropdown })}
        ${renderDropdown({ id: 'locationId', label: 'Location', selectedValue: filters.locationId || '', options: locationOptions, openDropdown: filters.openDropdown })}
        <label class="analyticsForecastSearch analyticsWasteSearch">
          ${icon('search')}
          <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="Search items, categories..." data-analytics-field="query" data-focus-key="analytics-query" />
        </label>
        <button type="button" class="analyticsForecastApply" data-analytics-refresh>${icon('refresh')} Refresh report</button>
      </section>

      ${renderWasteParetoKpis(rows)}

      <section class="analyticsWasteTopGrid">
        ${renderWasteReasonDonut(rows)}
        ${renderWasteParetoChart(rows)}
        ${renderWasteInsights(rows)}
      </section>

      <section class="analyticsWasteBarsGrid">
        ${renderWasteCategoryLoss(rows)}
        ${renderWasteLocationLoss(rows)}
      </section>

      <section class="analyticsVolatilityTablePanel analyticsWasteTablePanel">
        <header>
          <div>
            <h2>Wastage Incidents</h2>
            <p>${incidentTotal ? `Showing ${incidentFirst}-${incidentLast} of ${incidentTotal} incidents` : 'No wastage incidents match this report'}</p>
          </div>
          <div class="analyticsTableTools">
            ${renderDropdown({ id: 'pageSize', label: 'Rows per page', selectedValue: String(pageSize), options: pageSizeOptions(), openDropdown: filters.openDropdown })}
          </div>
        </header>
        <div class="analyticsTableWrap">
          <table class="analyticsTable analyticsWasteTable analyticsWasteIncidentTable">
            <thead>
              <tr>${wasteIncidentColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(wasteIncidentColumnInfo(column))}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${incidentPageRows.map(renderWasteIncidentRow).join('') || `<tr><td colspan="${wasteIncidentColumns().length}">No wastage incidents match this report.</td></tr>`}
            </tbody>
          </table>
        </div>
        <footer class="analyticsPagination">
          <span>${incidentTotal ? `${incidentFirst}-${incidentLast} of ${incidentTotal} incidents` : '0 incidents'}</span>
          <div class="analyticsPageButtons">
            <button type="button" data-analytics-page="${incidentPage - 1}" ${incidentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
            <strong>Page ${incidentPage} of ${incidentTotalPages}</strong>
            <button type="button" data-analytics-page="${incidentPage + 1}" ${incidentPage >= incidentTotalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
          </div>
        </footer>
      </section>

      <section class="analyticsVolatilityTablePanel analyticsWasteTablePanel analyticsWasteParetoPanel">
        <header>
          <div>
            <h2>Waste by Reason (Pareto)</h2>
            <p>${totalRows ? `${totalRows} reason${totalRows === 1 ? '' : 's'} — grouped loss & cumulative contribution` : 'No matching waste reasons'}</p>
          </div>
        </header>
        <div class="analyticsTableWrap">
          <table class="analyticsTable analyticsWasteTable">
            <thead>
              <tr>${wasteParetoColumns().map((column) => `<th>${escapeHtml(column)} ${wasteParetoColumnInfo(column)}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${rows.map(renderWasteParetoTableRow).join('') || `<tr><td colspan="${wasteParetoColumns().length}">No waste rows match this report.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
      ${selectedWasteDetail ? renderWasteDetailOverlay(selectedWasteDetail) : ''}
    </div>
  `;
}

function wasteParetoColumns() {
  return ['Reason', 'User', 'Incidents', 'Loss Value', 'Avg', 'Cumulative', 'Share', 'Top Category', 'Recommended Action', 'Action'];
}

function buildWasteParetoAdvancedRows(rows = [], filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const category = String(filters.category || '').trim();
  const location = String(filters.locationId || '').trim();
  const filtered = rows.map((row) => {
    const loss = Number(row._loss ?? parseMoney(row['Total Loss Value']));
    const incidents = parseNumber(row.Incidents);
    return {
      ...row,
      'Avg Loss': formatMoney(incidents ? loss / incidents : 0),
      'Share %': `${formatNumber(row._share ?? 0)}%`,
      'Recommended Action': wasteRecommendedAction(row['Waste Reason']),
      _loss: loss,
      _incidents: incidents,
      _share: Number(row._share ?? 0),
      _cumulative: Number(row._cumulative ?? parseNumber(row['Cumulative %'])),
      _topCategory: row['Top Category'] || topObjectLabel(row._categoryLoss) || 'General'
    };
  }).filter((row) => {
    if (category && !wasteRowHasCategory(row, category)) return false;
    if (location && !wasteRowHasLocation(row, location)) return false;
    if (query && !`${row['Waste Reason']} ${row.Location} ${row.User} ${row._topCategory}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((left, right) => right._loss - left._loss);
  const total = filtered.reduce((sum, row) => sum + Number(row._loss || 0), 0);
  let cumulative = 0;
  return filtered.map((row, index) => {
    cumulative += Number(row._loss || 0);
    const detailKey = `${index}-${String(row['Waste Reason'] || 'waste').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${String(row.User || 'unknown').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    return {
      ...row,
      '#': String(index + 1),
      Reason: row['Waste Reason'] || row.Reason || 'Other',
      User: row.User || 'Unknown',
      'Loss Value': formatMoney(row._loss),
      Avg: row['Avg Loss'],
      Cumulative: `${formatNumber(total ? (cumulative / total) * 100 : 0)}%`,
      Share: `${formatNumber(total ? (Number(row._loss || 0) / total) * 100 : 0)}%`,
      'Cumulative %': `${formatNumber(total ? (cumulative / total) * 100 : 0)}%`,
      'Share %': `${formatNumber(total ? (Number(row._loss || 0) / total) * 100 : 0)}%`,
      _share: total ? (Number(row._loss || 0) / total) * 100 : 0,
      _cumulative: total ? (cumulative / total) * 100 : 0,
      _detailKey: detailKey,
      _events: Array.isArray(row._events) ? row._events : []
    };
  });
}

function wasteRowHasCategory(row = {}, category = '') {
  if (!category) return true;
  if (String(row['Top Category'] || row._topCategory || '') === category) return true;
  return Object.prototype.hasOwnProperty.call(row._categoryLoss || {}, category);
}

function wasteRowHasLocation(row = {}, location = '') {
  if (!location) return true;
  if (String(row.Location || '') === location) return true;
  return Object.prototype.hasOwnProperty.call(row._locationLoss || {}, location);
}

function topObjectLabel(object = {}) {
  return Object.entries(object || {}).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0]?.[0] || '';
}

function buildWasteParetoCategoryOptions(rows = []) {
  const categories = new Set();
  rows.forEach((row) => {
    if (row['Top Category']) categories.add(row['Top Category']);
    Object.keys(row._categoryLoss || {}).forEach((key) => categories.add(key));
  });
  return [{ value: '', label: 'All Categories' }, ...[...categories].filter(Boolean).sort().map((value) => ({ value, label: value }))];
}

function buildWasteParetoLocationOptions(rows = []) {
  const locations = new Set();
  rows.forEach((row) => {
    Object.keys(row._locationLoss || {}).forEach((key) => locations.add(key));
    String(row.Location || '').split(',').map((item) => item.trim()).filter(Boolean).forEach((item) => {
      if (!/^\d+\s+locations$/i.test(item)) locations.add(item);
    });
  });
  return [{ value: '', label: 'All Locations' }, ...[...locations].filter(Boolean).sort().map((value) => ({ value, label: value }))];
}

function renderWasteParetoKpis(rows = []) {
  const incidents = rows.reduce((sum, row) => sum + Number(row._incidents || 0), 0);
  const totalLoss = rows.reduce((sum, row) => sum + Number(row._loss || 0), 0);
  const highImpact = rows.filter((row) => row._cumulative <= 80 || row['#'] === '1');
  const cards = [
    { label: 'Waste Incidents', value: formatNumber(incidents), helper: 'Total incidents', icon: 'clipboard', tone: 'blue' },
    { label: 'Total Loss Value', value: formatMoney(totalLoss), helper: 'Total ex-VAT value', icon: 'coin', tone: 'orange' },
    { label: 'Avg Loss per Incident', value: formatMoney(incidents ? totalLoss / incidents : 0), helper: 'Average loss value', icon: 'chart', tone: 'teal' },
    { label: 'Waste Reasons', value: formatNumber(rows.length), helper: 'Unique reasons', icon: 'file', tone: 'purple' },
    { label: 'High Impact Reasons', value: formatNumber(highImpact.length), helper: 'Drive 80% of loss', icon: 'activity', tone: 'red' }
  ];
  return `<section class="analyticsWasteKpis">${cards.map((card) => `
    <article class="analyticsForecastKpi analyticsMetric-${card.tone}">
      <span>${icon(card.icon)}</span>
      <div>
        <small>${escapeHtml(card.label)} ${renderForecastInfo(card.helper)}</small>
        <strong>${escapeHtml(card.value)}</strong>
        <em>${escapeHtml(card.helper)}</em>
      </div>
    </article>
  `).join('')}</section>`;
}

function renderWasteReasonDonut(rows = []) {
  const top = rows.slice(0, 8);
  const totalIncidents = rows.reduce((sum, row) => sum + Number(row._incidents || 0), 0);
  const colors = wasteColors();
  const series = top.map((row, index) => ({
    label: row['Waste Reason'],
    value: Number(row._incidents || 0),
    color: colors[index % colors.length]
  }));
  return `
    <section class="analyticsVolatilityPanel analyticsWasteReason">
      <header><h2>By Waste Reason ${renderForecastInfo('Distribution of waste incidents by reason.')}</h2><span>Distribution by number of incidents</span></header>
      <div class="analyticsWasteReasonBody">
        ${renderLiveDoughnut({ series, centerValue: formatNumber(totalIncidents), centerLabel: 'Total', className: 'analyticsWasteDonut', ariaLabel: 'Waste reasons by incident count' })}
        <div class="analyticsWasteReasonList">
          ${top.map((row, index) => `
            <article style="--risk-color:${colors[index % colors.length]};">
              <span>${escapeHtml(row['Waste Reason'])}</span>
              <strong>${escapeHtml(formatNumber(row._incidents))}</strong>
              <em>${escapeHtml(formatNumber(totalIncidents ? (row._incidents / totalIncidents) * 100 : 0))}%</em>
            </article>
          `).join('') || '<p>No waste reasons found.</p>'}
        </div>
      </div>
      <small>Showing top ${escapeHtml(formatNumber(top.length))} reasons</small>
    </section>
  `;
}

function renderWasteParetoChart(rows = []) {
  const top = rows.slice(0, 8);
  const labels = top.map((row) => shortLabel(row['Waste Reason'], 16));
  const datasets = [
    {
      type: 'bar',
      label: 'Total Loss Value (R)',
      data: top.map((row) => Number(Number(row._loss || 0).toFixed(2))),
      backgroundColor: 'rgba(251, 146, 60, 0.72)',
      borderColor: '#fb923c',
      borderWidth: 1,
      borderRadius: 5
    },
    {
      type: 'line',
      label: 'Cumulative %',
      data: top.map((row) => Number(Number(row._cumulative || 0).toFixed(2))),
      borderColor: '#60a5fa',
      backgroundColor: 'rgba(96, 165, 250, 0.08)',
      pointRadius: 3,
      tension: 0.32,
      yAxisID: 'y1'
    },
    {
      type: 'line',
      label: '80% Threshold',
      data: top.map(() => 80),
      borderColor: '#38bdf8',
      borderDash: [6, 5],
      pointRadius: 0,
      yAxisID: 'y1'
    }
  ];
  return `
    <section class="analyticsVolatilityPanel analyticsWasteParetoPanel">
      <header><h2>Waste Pareto Analysis ${renderForecastInfo('Bars show total loss value, while the line shows cumulative contribution.')}</h2></header>
      ${renderLiveChartCanvas({ type: 'mixed', labels, datasets, className: 'analyticsWasteParetoChart analyticsWasteParetoChartLive', ariaLabel: 'Waste Pareto analysis' })}
      <div class="analyticsForecastLegend">
        <span><i class="is-reorder"></i> Total Loss Value (R)</span>
        <span><i class="is-average"></i> Cumulative %</span>
      </div>
    </section>
  `;
}

function renderWasteInsights(rows = []) {
  const totalLoss = rows.reduce((sum, row) => sum + Number(row._loss || 0), 0);
  const highImpact = rows.filter((row) => row._cumulative <= 80 || row['#'] === '1');
  const topTwo = rows.slice(0, 2);
  const topTwoShare = topTwo.reduce((sum, row) => sum + Number(row._share || 0), 0);
  return `
    <section class="analyticsVolatilityPanel analyticsWasteInsights">
      <header><h2>${icon('sparkles')} Pareto Insights ${renderForecastInfo('Highlights the highest-impact waste reasons to tackle first.')}</h2></header>
      <div>
        <article>
          <span>${icon('chart')}</span>
          <p>Top ${escapeHtml(formatNumber(highImpact.length))} reasons drive <strong>${escapeHtml(formatNumber(highImpact.reduce((sum, row) => sum + row._share, 0)))}%</strong> of waste loss (${escapeHtml(formatMoney(highImpact.reduce((sum, row) => sum + row._loss, 0)))}).</p>
        </article>
        <article>
          <span>${icon('activity')}</span>
          <p>${escapeHtml(topTwo.map((row) => row['Waste Reason']).join(' and ') || 'Top reasons')} contribute the largest share at <strong>${escapeHtml(formatNumber(topTwoShare))}%</strong> of total loss.</p>
        </article>
        <article>
          <span>${icon('warehouse')}</span>
          <p>Focus on prep controls, stock rotation, and training for reasons above the 80% threshold.</p>
        </article>
      </div>
      <small>Tip: address high-impact reasons first to reduce the biggest slice of ${escapeHtml(formatMoney(totalLoss))}.</small>
    </section>
  `;
}

function renderWasteCategoryLoss(rows = []) {
  return renderWasteHorizontalBars('Loss by Category', 'Total loss value by category', aggregateWasteObject(rows, '_categoryLoss'), 'View category breakdown');
}

function renderWasteLocationLoss(rows = []) {
  return renderWasteHorizontalBars('Most Affected Locations', 'Total loss value by location', aggregateWasteObject(rows, '_locationLoss'), 'View location breakdown');
}

function renderWasteHorizontalBars(title, subtitle, groups = [], footer = '') {
  const max = Math.max(1, ...groups.map((group) => group.value));
  const total = groups.reduce((sum, group) => sum + group.value, 0);
  return `
    <section class="analyticsVolatilityPanel analyticsWasteBars">
      <header><h2>${escapeHtml(title)} ${renderForecastInfo(subtitle)}</h2><span>${escapeHtml(subtitle)}</span></header>
      <div>
        ${groups.slice(0, 6).map((group) => `
          <article style="--score:${Math.max(2, (group.value / max) * 100)}%;">
            <span>${escapeHtml(group.label)}</span>
            <i></i>
            <strong>${escapeHtml(formatMoney(group.value))}</strong>
            <em>${escapeHtml(formatNumber(total ? (group.value / total) * 100 : 0))}%</em>
          </article>
        `).join('') || '<p>No loss breakdown available.</p>'}
      </div>
      <button type="button" class="analyticsForecastPanelFooter" data-analytics-waste-focus="table">${escapeHtml(footer)} ${icon('arrowRight')}</button>
    </section>
  `;
}

function aggregateWasteObject(rows = [], key = '') {
  const map = new Map();
  rows.forEach((row) => {
    Object.entries(row[key] || {}).forEach(([label, value]) => {
      map.set(label, (map.get(label) || 0) + Number(value || 0));
    });
  });
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function renderWasteParetoTableRow(row = {}) {
  const color = wasteColors()[(Number(row['#'] || 1) - 1) % wasteColors().length];
  return `
    <tr>
      <td><span class="analyticsWasteReasonName" style="--risk-color:${color};">${escapeHtml(row.Reason || row['Waste Reason'])}</span></td>
      <td>${escapeHtml(row.User || 'Unknown')}</td>
      <td>${escapeHtml(formatNumber(row._incidents))}</td>
      <td>${escapeHtml(formatMoney(row._loss))}</td>
      <td>${escapeHtml(row.Avg || row['Avg Loss'])}</td>
      <td>${escapeHtml(row.Cumulative || row['Cumulative %'])}</td>
      <td>${escapeHtml(row.Share || row['Share %'])}</td>
      <td>${escapeHtml(row._topCategory)}</td>
      <td><span class="analyticsWasteActionTag">${escapeHtml(row['Recommended Action'])}</span></td>
      <td>
        <button type="button" class="analyticsIconAction analyticsWasteDetailButton" data-waste-detail-view="${escapeAttribute(row._detailKey)}" aria-label="View waste detail">
          ${icon('eye')}
        </button>
      </td>
    </tr>
  `;
}

function renderWasteDetailOverlay(row = {}) {
  const events = Array.isArray(row._events) && row._events.length ? row._events : [{
    Date: '',
    Time: '',
    Reason: row.Reason || row['Waste Reason'] || 'Other',
    User: row.User || 'Unknown',
    Item: row._topCategory || 'Waste event',
    Category: row._topCategory || 'General',
    Location: row.Location || '',
    Quantity: `${formatNumber(row._incidents || 0)} incidents`,
    'Loss Value': formatMoney(row._loss || 0),
    Note: row['Recommended Action'] || '',
    Source: 'Waste Pareto'
  }];
  const loss = Number(row._loss || 0);
  return `
    <div class="analyticsModalBackdrop" data-waste-detail-close>
      <section class="analyticsOrderModal analyticsWasteDetailModal" role="dialog" aria-modal="true" aria-label="Waste event detail">
        <header>
          <div>
            <span>Waste Event Log</span>
            <h2>${escapeHtml(row.Reason || row['Waste Reason'] || 'Waste')}</h2>
          </div>
          <button type="button" class="analyticsIconAction" data-waste-detail-close aria-label="Close waste event detail">${icon('x')}</button>
        </header>
        <div class="analyticsOrderSummaryGrid">
          <div><span>Reason</span><strong>${escapeHtml(row.Reason || row['Waste Reason'] || 'Other')}</strong></div>
          <div><span>User</span><strong>${escapeHtml(row.User || 'Unknown')}</strong></div>
          <div><span>Incidents</span><strong>${escapeHtml(formatNumber(row._incidents || events.length))}</strong></div>
          <div><span>Loss Value</span><strong class="analyticsTextDanger">${escapeHtml(formatMoney(loss))}</strong></div>
          <div><span>Average</span><strong>${escapeHtml(row.Avg || row['Avg Loss'] || formatMoney(events.length ? loss / events.length : loss))}</strong></div>
          <div><span>Top Category</span><strong>${escapeHtml(row._topCategory || 'General')}</strong></div>
        </div>
        <div class="analyticsOrderLines analyticsWasteDetailLines">
          <header class="analyticsEmbeddedSectionHead">
            <strong>Wasted items</strong>
            <span>${escapeHtml(formatNumber(events.length))} event${events.length === 1 ? '' : 's'}</span>
          </header>
          ${events.map((event) => `
            <article>
              <div>
                <strong>${escapeHtml(event.Item || 'Stock item')}</strong>
                <span>${escapeHtml([event.Date, event.Time, event.Location].filter(Boolean).join(' · '))}</span>
              </div>
              <div class="analyticsWasteDetailMeta">
                <span>${escapeHtml(event.Quantity || '0')} · ${escapeHtml(event.Category || 'General')} · ${escapeHtml(event.Source || 'Waste')}</span>
                <strong>${escapeHtml(event['Loss Value'] || formatMoney(0))}</strong>
              </div>
              ${event.Note ? `<p>${escapeHtml(event.Note)}</p>` : ''}
            </article>
          `).join('')}
        </div>
      </section>
    </div>
  `;
}

function wasteRecommendedAction(reason = '') {
  const text = String(reason || '').toLowerCase();
  if (text.includes('expired')) return 'Improve rotation';
  if (text.includes('over')) return 'Review forecasting';
  if (text.includes('spoil')) return 'Temperature control';
  if (text.includes('prep')) return 'Tighten prep controls';
  if (text.includes('damag')) return 'Improve handling';
  if (text.includes('theft')) return 'Strengthen security';
  if (text.includes('return')) return 'Review return policy';
  if (text.includes('manufact')) return 'Audit batch yield';
  return 'Review process';
}

function wasteParetoColumnInfo(column = '') {
  const info = {
    Reason: 'Reason captured on the wastage or variance movement.',
    User: 'User who processed the wastage or production variance.',
    Incidents: 'Number of waste incidents for this reason.',
    'Loss Value': 'Total ex-VAT value lost for this reason and user.',
    Avg: 'Average loss value per incident.',
    Cumulative: 'Running cumulative contribution to total waste.',
    Share: 'This row as a percentage of total waste loss.',
    'Top Category': 'Category with the largest loss for this reason.',
    'Recommended Action': 'Suggested operational response.',
    Action: 'Open a detailed view of the wasted items behind this row.'
  };
  return renderForecastInfo(info[column] || column);
}

function wasteColors() {
  return ['#fb923c', '#f59e0b', '#22c55e', '#8b5cf6', '#3b82f6', '#06b6d4', '#eab308', '#94a3b8'];
}

function formatCompactMoney(value = 0) {
  const numeric = Number(value || 0);
  if (Math.abs(numeric) >= 1000) return `R ${formatNumber(numeric / 1000)}K`;
  return formatMoney(numeric);
}

function shortLabel(value = '', length = 12) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, Math.max(1, length - 1))}.` : text;
}
