// Sales Reports — modifier GP tracking + modifier summary report renderers.
// Extracted from Analytics.js. Shared UI/formatting helpers are imported from Analytics.js (the
// analytics core); the two entry renderers are imported back by Analytics.js's renderDetailView.
import {
  arrayValue,
  columnTooltip,
  escapeAttribute,
  escapeHtml,
  formatMoney,
  formatNumber,
  gpMetricTone,
  gpToneClass,
  icon,
  pageSizeOptions,
  parseMoney,
  parseNumber,
  renderDateRangePicker,
  renderDropdown,
  renderReportActionsDropdown,
  renderReportInfo,
  uniqueCount
} from './Analytics.js';

export function renderModifierGpReportDetailView({ filters = {}, reportData = {}, category = {}, locationOptions = [], pageSize = 25 } = {}) {
  const model = buildModifierGpHierarchy(reportData.rows || [], filters);
  const totalRows = model.mainRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = model.mainRows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const summary = modifierGpTotals(model.filteredRows);

  return `
    <div class="analyticsDetailCanvas analyticsTone-${category.tone} analyticsDetailCanvas--modifierGp">
      <header class="analyticsReportMasthead">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsReportTitle">
            <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Track modifier GP impact by product.')}</h1>
            <p>${escapeHtml(reportData.report.description)}</p>
          </div>
        </div>
        <div class="analyticsHeaderActions">
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsFilterDock analyticsModifierGpFilters">
        ${renderDateRangePicker(filters)}
        ${renderDropdown({
          id: 'locationId',
          label: 'Location',
          selectedValue: filters.locationId || '',
          options: locationOptions,
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierGpMainProduct',
          label: 'Main Product',
          selectedValue: filters.modifierGpMainProduct || '',
          options: modifierGpOptions(model.allRows, 'mainProduct'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierGpModifierItem',
          label: 'Modifier Item',
          selectedValue: filters.modifierGpModifierItem || '',
          options: modifierGpOptions(model.allRows, 'modifierItem'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierGpCombination',
          label: 'Combination',
          selectedValue: filters.modifierGpCombination || '',
          options: modifierGpOptions(model.allRows, 'combination'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierGpSort',
          label: 'Sort',
          selectedValue: filters.modifierGpSort || 'totalSales',
          options: modifierGpSortOptions(),
          openDropdown: filters.openDropdown
        })}
        <label class="analyticsHeroSearch">
          <span>Search</span>
          <div>
            ${icon('search')}
            <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="Search products or modifiers..." data-analytics-field="query" data-focus-key="analytics-query" />
          </div>
        </label>
        <button type="button" class="analyticsRefreshButton" data-analytics-refresh>
          ${icon('refresh')}
          <span>Refresh report</span>
        </button>
      </section>

      <div class="analyticsSummaryGrid analyticsKpiGrid">
        <div class="analyticsKpiCard analyticsMetric-blue">
          <span class="analyticsKpiIcon">${icon('menu')}</span>
          <span class="analyticsKpiLabel">Main Products</span>
          <strong>${escapeHtml(formatNumber(totalRows))}</strong>
          <small>Products with matching sales</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-green">
          <span class="analyticsKpiIcon">${icon('cart')}</span>
          <span class="analyticsKpiLabel">Total Sales</span>
          <strong>${escapeHtml(formatMoney(summary.totalSales))}</strong>
          <small>Main plus modifier sales</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-orange">
          <span class="analyticsKpiIcon">${icon('coin')}</span>
          <span class="analyticsKpiLabel">Modifier Sales</span>
          <strong>${escapeHtml(formatMoney(summary.modifierSales))}</strong>
          <small>Attached modifier revenue</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-${summary.additionalGp < 0 ? 'red' : summary.additionalGp > 0 ? 'green' : 'purple'}">
          <span class="analyticsKpiIcon">${icon('chart')}</span>
          <span class="analyticsKpiLabel">Additional GP</span>
          <strong>${escapeHtml(formatSignedPercent(summary.additionalGp))}</strong>
          <small>Combined GP minus main GP</small>
        </div>
      </div>

      <section class="analyticsReportPanel analyticsReportPanel--modifierGp">
        <div class="analyticsTableBlock">
          <header>
            <div>
              <h2>Modifier GP Tracking Details ${renderReportInfo('Expand a main product to compare every modifier combination, then expand a combination to inspect the individual modifiers.')}</h2>
              <span>${totalRows ? `Showing ${firstRowNumber}-${lastRowNumber} of ${totalRows} main products` : 'No matching products'}</span>
            </div>
            <div class="analyticsTableTools">
              ${renderDropdown({
                id: 'pageSize',
                label: 'Rows',
                selectedValue: String(pageSize),
                options: pageSizeOptions(),
                openDropdown: filters.openDropdown
              })}
            </div>
          </header>
          <div class="analyticsTableWrap">
            <table class="analyticsTable analyticsModifierGpTable">
              <thead>
                <tr>
                  ${modifierGpMainColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip(reportData, column))}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${renderModifierGpMainRows(pageRows, filters)}
              </tbody>
            </table>
          </div>
          <footer class="analyticsPagination">
            <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} main products` : '0 rows'}</span>
            <div class="analyticsPageButtons">
              <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
              <strong>Page ${currentPage} of ${totalPages}</strong>
              <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
            </div>
          </footer>
        </div>
        ${totalRows > pageSize ? `<div class="analyticsLimitNote">Export includes the filtered detail rows for all ${escapeHtml(formatNumber(model.filteredRows.length))} sale lines.</div>` : ''}
      </section>
    </div>
  `;
}

function modifierGpMainColumns() {
  return ['Main Product', 'Qty Sold', 'Main Sales', 'Modifier Sales', 'Total Sales', 'Main Cost', 'Modifier Cost', 'Total Cost', 'GP Main %', 'GP Combined %', 'Additional GP %'];
}

function modifierGpCombinationColumns() {
  return ['Main Product', 'Modifier Combination', 'Qty Sold', 'Main Sales', 'Modifier Sales', 'Total Sales', 'Main Cost', 'Modifier Cost', 'Total Cost', 'GP Main %', 'GP Combined %', 'Additional GP %'];
}

function modifierGpItemColumns() {
  return ['Modifier Item', 'Modifier Qty', 'Modifier Selling', 'Modifier Cost', 'Modifier GP %'];
}

function renderModifierGpMainRows(rows = [], filters = {}) {
  if (!rows.length) {
    return `<tr><td colspan="${modifierGpMainColumns().length}">No modifier GP rows match this view.</td></tr>`;
  }
  const expandedProducts = new Set(arrayValue(filters.modifierGpExpandedProducts));
  return rows.map((row) => {
    const expanded = expandedProducts.has(row.key);
    const mainRow = `
      <tr class="analyticsModifierGpMainRow">
        <td>
          <button type="button" class="analyticsTreeToggle" data-analytics-modifier-gp-product="${escapeAttribute(row.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
            ${icon(expanded ? 'chevronDown' : 'chevronRight')}
            <span>${escapeHtml(row.mainProduct)}</span>
          </button>
        </td>
        <td>${escapeHtml(formatNumber(row.qtySold))}</td>
        <td>${escapeHtml(formatMoney(row.mainSales))}</td>
        <td>${escapeHtml(formatMoney(row.modifierSales))}</td>
        <td>${escapeHtml(formatMoney(row.totalSales))}</td>
        <td>${escapeHtml(formatMoney(row.mainCost))}</td>
        <td>${escapeHtml(formatMoney(row.modifierCost))}</td>
        <td>${escapeHtml(formatMoney(row.totalCost))}</td>
        <td>${modifierGpBadge(row.gpMain)}</td>
        <td>${modifierGpBadge(row.gpCombined)}</td>
        <td>${modifierGpImpactBadge(row.additionalGp)}</td>
      </tr>
    `;
    const detailRow = expanded
      ? `<tr class="analyticsModifierGpNestedRow"><td colspan="${modifierGpMainColumns().length}">${renderModifierGpCombinationTable(row, filters)}</td></tr>`
      : '';
    return `${mainRow}${detailRow}`;
  }).join('');
}

function renderModifierGpCombinationTable(row = {}, filters = {}) {
  const expandedCombinations = new Set(arrayValue(filters.modifierGpExpandedCombinations));
  return `
    <div class="analyticsModifierGpNestedPanel">
      <table>
        <thead>
          <tr>${modifierGpCombinationColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${row.combinations.map((combo) => {
            const expanded = expandedCombinations.has(combo.key);
            const canExpand = combo.items.length > 0;
            return `
              <tr class="analyticsModifierGpComboRow">
                <td>${escapeHtml(combo.mainProduct)}</td>
                <td>
                  ${canExpand ? `
                    <button type="button" class="analyticsTreeToggle analyticsTreeToggle--child" data-analytics-modifier-gp-combination="${escapeAttribute(combo.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
                      ${icon(expanded ? 'chevronDown' : 'chevronRight')}
                      <span>${escapeHtml(combo.modifierCombination)}</span>
                    </button>
                  ` : `<span class="analyticsModifierGpNoModifier">${escapeHtml(combo.modifierCombination)}</span>`}
                </td>
                <td>${escapeHtml(formatNumber(combo.qtySold))}</td>
                <td>${escapeHtml(formatMoney(combo.mainSales))}</td>
                <td>${escapeHtml(formatMoney(combo.modifierSales))}</td>
                <td>${escapeHtml(formatMoney(combo.totalSales))}</td>
                <td>${escapeHtml(formatMoney(combo.mainCost))}</td>
                <td>${escapeHtml(formatMoney(combo.modifierCost))}</td>
                <td>${escapeHtml(formatMoney(combo.totalCost))}</td>
                <td>${modifierGpBadge(combo.gpMain)}</td>
                <td>${modifierGpBadge(combo.gpCombined)}</td>
                <td>${modifierGpImpactBadge(combo.additionalGp)}</td>
              </tr>
              ${expanded && canExpand ? `<tr class="analyticsModifierGpItemRow"><td colspan="${modifierGpCombinationColumns().length}">${renderModifierGpItemTable(combo)}</td></tr>` : ''}
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderModifierGpItemTable(combo = {}) {
  return `
    <div class="analyticsModifierGpItemPanel">
      <table>
        <thead>
          <tr>${modifierGpItemColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${combo.items.map((item) => `
            <tr>
              <td>${escapeHtml(item.name)}</td>
              <td>${escapeHtml(formatNumber(item.qty))}</td>
              <td>${escapeHtml(formatMoney(item.selling))}</td>
              <td>${escapeHtml(formatMoney(item.cost))}</td>
              <td>${modifierGpBadge(item.gp)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function buildModifierGpHierarchy(rows = [], filters = {}) {
  const allRows = rows.filter((row) => row && row._mainProduct);
  const filteredRows = allRows.filter((row) => modifierGpRowMatchesFilters(row, filters));
  const productGroups = groupRowsBy(filteredRows, (row) => row._mainProductKey || row._mainProduct || row['Main Product Sold']);
  const mainRows = [...productGroups.entries()].map(([key, productRows]) => {
    const totals = modifierGpTotals(productRows);
    const mainProduct = productRows[0]?._mainProduct || productRows[0]?.['Main Product Sold'] || 'Main Product';
    const comboGroups = groupRowsBy(productRows, (row) => row._modifierCombinationKey || row._modifierCombination || row['Modifier Combination']);
    const combinations = [...comboGroups.entries()].map(([comboKey, comboRows]) => {
      const comboTotals = modifierGpTotals(comboRows);
      const modifierCombination = comboRows[0]?._modifierCombination || comboRows[0]?.['Modifier Combination'] || 'No Modifier';
      return {
        key: `${key}::${comboKey}`,
        mainProduct,
        modifierCombination,
        ...comboTotals,
        items: modifierGpItemTotals(comboRows)
      };
    }).sort((left, right) => right.qtySold - left.qtySold || left.modifierCombination.localeCompare(right.modifierCombination));
    return {
      key,
      mainProduct,
      combinations,
      ...totals
    };
  });

  mainRows.sort(modifierGpSortComparator(filters.modifierGpSort || 'totalSales'));
  return { allRows, filteredRows, mainRows };
}

function modifierGpRowMatchesFilters(row = {}, filters = {}) {
  const mainProduct = String(filters.modifierGpMainProduct || '').trim();
  if (mainProduct && String(row._mainProduct || row['Main Product Sold'] || '') !== mainProduct) return false;
  const combination = String(filters.modifierGpCombination || '').trim();
  if (combination && String(row._modifierCombination || row['Modifier Combination'] || '') !== combination) return false;
  const modifierItem = String(filters.modifierGpModifierItem || '').trim();
  if (modifierItem) {
    const items = arrayValue(row._modifierItems);
    if (!items.some((item) => String(item.name || '') === modifierItem)) return false;
  }
  return true;
}

function modifierGpTotals(rows = []) {
  const mainSales = rows.reduce((sum, row) => sum + Number(row._mainSales || parseMoney(row['Main Product Selling']) || 0), 0);
  const modifierSales = rows.reduce((sum, row) => sum + Number(row._modifierSales || parseMoney(row['Modifier Selling']) || 0), 0);
  const mainCost = rows.reduce((sum, row) => sum + Number(row._mainCost || parseMoney(row['Main Selling Recipe Cost']) || 0), 0);
  const modifierCost = rows.reduce((sum, row) => sum + Number(row._modifierCost || parseMoney(row['Modifier Cost']) || 0), 0);
  const qtySold = rows.reduce((sum, row) => sum + Number(row._qtySold || parseNumber(row['Qty Sold']) || 0), 0);
  const totalSales = mainSales + modifierSales;
  const totalCost = mainCost + modifierCost;
  const gpMain = mainSales > 0 ? ((mainSales - mainCost) / mainSales) * 100 : 0;
  const gpCombined = totalSales > 0 ? ((totalSales - totalCost) / totalSales) * 100 : gpMain;
  return {
    qtySold,
    mainSales,
    modifierSales,
    totalSales,
    mainCost,
    modifierCost,
    totalCost,
    gpMain,
    gpCombined,
    additionalGp: gpCombined - gpMain
  };
}

function modifierGpItemTotals(rows = []) {
  const itemGroups = new Map();
  rows.forEach((row) => {
    arrayValue(row._modifierItems).forEach((item) => {
      const key = String(item.name || '').trim().toLowerCase();
      if (!key) return;
      const current = itemGroups.get(key) || { name: item.name || 'Modifier', qty: 0, selling: 0, cost: 0 };
      current.qty += Number(item.qty || 0);
      current.selling += Number(item.selling || 0);
      current.cost += Number(item.cost || 0);
      itemGroups.set(key, current);
    });
  });
  return [...itemGroups.values()]
    .map((item) => ({
      ...item,
      gp: item.selling > 0 ? ((item.selling - item.cost) / item.selling) * 100 : 0
    }))
    .sort((left, right) => right.selling - left.selling || left.name.localeCompare(right.name));
}

function groupRowsBy(rows = [], keyFn = () => '') {
  return rows.reduce((map, row) => {
    const key = String(keyFn(row) || '').trim() || 'Unspecified';
    const group = map.get(key) || [];
    group.push(row);
    map.set(key, group);
    return map;
  }, new Map());
}

function modifierGpSortComparator(sortKey = 'totalSales') {
  const key = String(sortKey || 'totalSales');
  const metric = key === 'qtySold'
    ? 'qtySold'
    : key === 'gpCombined'
      ? 'gpCombined'
      : key === 'additionalGp'
        ? 'additionalGp'
        : 'totalSales';
  return (left, right) => Number(right[metric] || 0) - Number(left[metric] || 0) || String(left.mainProduct || '').localeCompare(String(right.mainProduct || ''));
}

function modifierGpSortOptions() {
  return [
    { value: 'totalSales', label: 'Total Sales' },
    { value: 'qtySold', label: 'Qty Sold' },
    { value: 'gpCombined', label: 'GP Combined %' },
    { value: 'additionalGp', label: 'Additional GP %' }
  ];
}

function modifierGpOptions(rows = [], type = '') {
  const values = new Set();
  rows.forEach((row) => {
    if (type === 'mainProduct') values.add(String(row._mainProduct || row['Main Product Sold'] || '').trim());
    if (type === 'combination') values.add(String(row._modifierCombination || row['Modifier Combination'] || '').trim());
    if (type === 'modifierItem') {
      arrayValue(row._modifierItems).forEach((item) => values.add(String(item.name || '').trim()));
    }
  });
  const labels = [...values].filter(Boolean).sort((left, right) => left.localeCompare(right));
  const fallback = type === 'mainProduct'
    ? 'All Main Products'
    : type === 'modifierItem'
      ? 'All Modifier Items'
      : 'All Combinations';
  return [{ value: '', label: fallback }, ...labels.map((label) => ({ value: label, label }))];
}

export function buildModifierGpExportRows(rows = [], filters = {}) {
  return rows
    .filter((row) => row && row._mainProduct)
    .filter((row) => modifierGpRowMatchesFilters(row, filters));
}

function modifierGpBadge(value = 0) {
  const numeric = Number(value || 0);
  return `<span class="analyticsGpBadge ${gpToneClass(numeric)}">${escapeHtml(`${formatNumber(numeric)}%`)}</span>`;
}

function modifierGpImpactBadge(value = 0) {
  const numeric = Number(value || 0);
  const tone = numeric > 0.0001 ? 'is-positive' : numeric < -0.0001 ? 'is-negative' : 'is-neutral';
  return `<span class="analyticsModifierGpImpact ${tone}">${escapeHtml(formatSignedPercent(numeric))}</span>`;
}

function formatSignedPercent(value = 0) {
  const numeric = Number(value || 0);
  if (Math.abs(numeric) < 0.0001) return '0%';
  return `${numeric > 0 ? '+' : ''}${formatNumber(numeric)}%`;
}

export function renderModifierSummaryReportDetailView({ filters = {}, reportData = {}, category = {}, locationOptions = [], pageSize = 25 } = {}) {
  const model = buildModifierSummaryHierarchy(reportData.rows || [], filters);
  const totalRows = model.modifierRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = model.modifierRows.slice(startIndex, startIndex + pageSize);
  const firstRowNumber = totalRows ? startIndex + 1 : 0;
  const lastRowNumber = Math.min(startIndex + pageSize, totalRows);
  const totals = modifierSummaryTotals(model.filteredRows);

  return `
    <div class="analyticsDetailCanvas analyticsTone-${category.tone} analyticsDetailCanvas--modifierSummary">
      <header class="analyticsReportMasthead">
        <div>
          <button type="button" class="analyticsBreadcrumb" data-analytics-back>
            ${icon('chevronLeft')}
            <span>Reports</span>
          </button>
          <div class="analyticsReportTitle">
            <h1>${escapeHtml(reportData.report.title)} ${renderReportInfo(reportData.report.description || 'Summarise modifier sales and GP.')}</h1>
            <p>${escapeHtml(reportData.report.description)}</p>
          </div>
        </div>
        <div class="analyticsHeaderActions">
          ${renderReportActionsDropdown(filters.openDropdown)}
        </div>
      </header>

      <section class="analyticsFilterDock analyticsModifierSummaryFilters">
        ${renderDateRangePicker(filters)}
        ${renderDropdown({
          id: 'locationId',
          label: 'Location',
          selectedValue: filters.locationId || '',
          options: locationOptions,
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierSummaryItem',
          label: 'Modifier Item',
          selectedValue: filters.modifierSummaryItem || '',
          options: modifierSummaryOptions(model.allRows, 'item'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierSummaryMainProduct',
          label: 'Main Product',
          selectedValue: filters.modifierSummaryMainProduct || '',
          options: modifierSummaryOptions(model.allRows, 'mainProduct'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierSummaryCategory',
          label: 'Modifier Category',
          selectedValue: filters.modifierSummaryCategory || '',
          options: modifierSummaryOptions(model.allRows, 'category'),
          openDropdown: filters.openDropdown
        })}
        ${renderDropdown({
          id: 'modifierSummarySort',
          label: 'Sort',
          selectedValue: filters.modifierSummarySort || 'modifierSales',
          options: modifierSummarySortOptions(),
          openDropdown: filters.openDropdown
        })}
        <label class="analyticsHeroSearch">
          <span>Search</span>
          <div>
            ${icon('search')}
            <input type="search" value="${escapeAttribute(filters.query || '')}" placeholder="Search modifiers or products..." data-analytics-field="query" data-focus-key="analytics-query" />
          </div>
        </label>
        <button type="button" class="analyticsRefreshButton" data-analytics-refresh>
          ${icon('refresh')}
          <span>Refresh report</span>
        </button>
      </section>

      <div class="analyticsSummaryGrid analyticsKpiGrid">
        <div class="analyticsKpiCard analyticsMetric-blue">
          <span class="analyticsKpiIcon">${icon('menu')}</span>
          <span class="analyticsKpiLabel">Modifiers</span>
          <strong>${escapeHtml(formatNumber(totalRows))}</strong>
          <small>Unique modifier items</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-green">
          <span class="analyticsKpiIcon">${icon('cart')}</span>
          <span class="analyticsKpiLabel">Modifier Sales</span>
          <strong>${escapeHtml(formatMoney(totals.sales))}</strong>
          <small>Total modifier revenue</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-orange">
          <span class="analyticsKpiIcon">${icon('coin')}</span>
          <span class="analyticsKpiLabel">Modifier GP</span>
          <strong>${escapeHtml(formatMoney(totals.gp))}</strong>
          <small>Sales minus modifier cost</small>
        </div>
        <div class="analyticsKpiCard analyticsMetric-${totals.gpPercent === null ? 'purple' : gpMetricTone(totals.gpPercent)}">
          <span class="analyticsKpiIcon">${icon('chart')}</span>
          <span class="analyticsKpiLabel">Modifier GP %</span>
          <strong>${escapeHtml(formatOptionalPercent(totals.gpPercent))}</strong>
          <small>Weighted by total sales</small>
        </div>
      </div>

      <section class="analyticsReportPanel analyticsReportPanel--modifierSummary">
        <div class="analyticsTableBlock">
          <header>
            <div>
              <h2>Modifier Summary Details ${renderReportInfo('Expand a modifier to see which main products it was attached to, then expand a main product for sale/order detail.')}</h2>
              <span>${totalRows ? `Showing ${firstRowNumber}-${lastRowNumber} of ${totalRows} modifiers` : 'No matching modifiers'}</span>
            </div>
            <div class="analyticsTableTools">
              ${renderDropdown({
                id: 'pageSize',
                label: 'Rows',
                selectedValue: String(pageSize),
                options: pageSizeOptions(),
                openDropdown: filters.openDropdown
              })}
            </div>
          </header>
          <div class="analyticsTableWrap">
            <table class="analyticsTable analyticsModifierSummaryTable">
              <thead>
                <tr>${modifierSummaryColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip(reportData, column))}</th>`).join('')}</tr>
              </thead>
              <tbody>
                ${renderModifierSummaryRows(pageRows, filters)}
              </tbody>
              <tfoot>
                ${renderModifierSummaryTotalsRow(totals)}
              </tfoot>
            </table>
          </div>
          <footer class="analyticsPagination">
            <span>${totalRows ? `${firstRowNumber}-${lastRowNumber} of ${totalRows} modifiers` : '0 rows'}</span>
            <div class="analyticsPageButtons">
              <button type="button" data-analytics-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft')}</button>
              <strong>Page ${currentPage} of ${totalPages}</strong>
              <button type="button" data-analytics-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight')}</button>
            </div>
          </footer>
        </div>
      </section>
    </div>
  `;
}

function modifierSummaryColumns() {
  return ['Modifier Item', 'Qty Sold', 'Modifier Sales', 'Modifier Cost', 'Modifier GP', 'Modifier GP %', 'Avg Selling Price', 'Avg Cost', 'Attached Main Products'];
}

function modifierSummaryProductColumns() {
  return ['Modifier Item', 'Main Product Sold', 'Qty Sold', 'Modifier Sales', 'Modifier Cost', 'Modifier GP', 'Modifier GP %'];
}

function modifierSummaryDetailColumns() {
  return ['Date', 'Sale ID / Order ID', 'Main Product Sold', 'Modifier Item', 'Modifier Selling', 'Modifier Cost', 'Modifier GP', 'Modifier GP %'];
}

function renderModifierSummaryRows(rows = [], filters = {}) {
  if (!rows.length) {
    return `<tr><td colspan="${modifierSummaryColumns().length}">No modifier summary rows match this view.</td></tr>`;
  }
  const expandedItems = new Set(arrayValue(filters.modifierSummaryExpandedItems));
  return rows.map((row) => {
    const expanded = expandedItems.has(row.key);
    const statusBadge = row.zeroPriceCount ? `<em class="analyticsModifierSummaryFlag">${escapeHtml(row.zeroPriceCount)} zero-price</em>` : '';
    const mainRow = `
      <tr class="analyticsModifierSummaryMainRow">
        <td>
          <button type="button" class="analyticsTreeToggle" data-analytics-modifier-summary-item="${escapeAttribute(row.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
            ${icon(expanded ? 'chevronDown' : 'chevronRight')}
            <span>${escapeHtml(row.modifierItem)}</span>
          </button>
          ${statusBadge}
        </td>
        <td>${escapeHtml(formatNumber(row.qty))}</td>
        <td>${escapeHtml(formatMoney(row.sales))}</td>
        <td>${escapeHtml(formatMoney(row.cost))}</td>
        <td>${modifierSummaryMoneyBadge(row.gp)}</td>
        <td>${modifierSummaryPercentBadge(row.gpPercent)}</td>
        <td>${escapeHtml(formatMoney(row.avgSelling))}</td>
        <td>${escapeHtml(formatMoney(row.avgCost))}</td>
        <td>${escapeHtml(row.attachedMainProducts.join(', ') || 'None')}</td>
      </tr>
    `;
    const detailRow = expanded
      ? `<tr class="analyticsModifierSummaryNestedRow"><td colspan="${modifierSummaryColumns().length}">${renderModifierSummaryProductTable(row, filters)}</td></tr>`
      : '';
    return `${mainRow}${detailRow}`;
  }).join('');
}

function renderModifierSummaryProductTable(row = {}, filters = {}) {
  const expandedProducts = new Set(arrayValue(filters.modifierSummaryExpandedProducts));
  return `
    <div class="analyticsModifierSummaryNestedPanel">
      <table>
        <thead>
          <tr>${modifierSummaryProductColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${row.products.map((product) => {
            const expanded = expandedProducts.has(product.key);
            return `
              <tr class="analyticsModifierSummaryProductRow">
                <td>${escapeHtml(product.modifierItem)}</td>
                <td>
                  <button type="button" class="analyticsTreeToggle analyticsTreeToggle--child" data-analytics-modifier-summary-product="${escapeAttribute(product.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
                    ${icon(expanded ? 'chevronDown' : 'chevronRight')}
                    <span>${escapeHtml(product.mainProduct)}</span>
                  </button>
                </td>
                <td>${escapeHtml(formatNumber(product.qty))}</td>
                <td>${escapeHtml(formatMoney(product.sales))}</td>
                <td>${escapeHtml(formatMoney(product.cost))}</td>
                <td>${modifierSummaryMoneyBadge(product.gp)}</td>
                <td>${modifierSummaryPercentBadge(product.gpPercent)}</td>
              </tr>
              ${expanded ? `<tr class="analyticsModifierSummaryDetailRow"><td colspan="${modifierSummaryProductColumns().length}">${renderModifierSummaryDetailTable(product)}</td></tr>` : ''}
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderModifierSummaryDetailTable(product = {}) {
  return `
    <div class="analyticsModifierSummaryDetailPanel">
      <table>
        <thead>
          <tr>${modifierSummaryDetailColumns().map((column) => `<th>${escapeHtml(column)} ${renderReportInfo(columnTooltip({}, column))}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${product.details.map((detail) => `
            <tr>
              <td>${escapeHtml(detail.Date || '')}</td>
              <td>${escapeHtml(detail['Sale ID / Order ID'] || '')}</td>
              <td>${escapeHtml(detail['Main Product Sold'] || '')}</td>
              <td>${escapeHtml(detail['Modifier Item'] || '')}</td>
              <td>${escapeHtml(formatMoney(detail._modifierSales))}</td>
              <td>${escapeHtml(formatMoney(detail._modifierCost))}</td>
              <td>${modifierSummaryMoneyBadge(detail._modifierGp)}</td>
              <td>${modifierSummaryPercentBadge(detail._modifierGpPercent)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderModifierSummaryTotalsRow(totals = {}) {
  return `
    <tr class="analyticsModifierSummaryTotalsRow">
      <td>Totals</td>
      <td>${escapeHtml(formatNumber(totals.qty))}</td>
      <td>${escapeHtml(formatMoney(totals.sales))}</td>
      <td>${escapeHtml(formatMoney(totals.cost))}</td>
      <td>${escapeHtml(formatMoney(totals.gp))}</td>
      <td>${escapeHtml(formatOptionalPercent(totals.gpPercent))}</td>
      <td>${escapeHtml(formatMoney(totals.avgSelling))}</td>
      <td>${escapeHtml(formatMoney(totals.avgCost))}</td>
      <td>${escapeHtml(formatNumber(totals.mainProductCount || 0))} main products</td>
    </tr>
  `;
}

function buildModifierSummaryHierarchy(rows = [], filters = {}) {
  const allRows = rows.filter((row) => row && row._modifierItem);
  const filteredRows = allRows.filter((row) => modifierSummaryRowMatchesFilters(row, filters));
  const modifierGroups = groupRowsBy(filteredRows, (row) => row._modifierItemKey || row._modifierItem || row['Modifier Item']);
  const modifierRows = [...modifierGroups.entries()].map(([key, modifierRowsForItem]) => {
    const modifierItem = modifierRowsForItem[0]?._modifierItem || modifierRowsForItem[0]?.['Modifier Item'] || 'Modifier';
    const productGroups = groupRowsBy(modifierRowsForItem, (row) => row._mainProductKey || row._mainProduct || row['Main Product Sold']);
    const products = [...productGroups.entries()].map(([productKey, productRows]) => ({
      key: `${key}::${productKey}`,
      modifierItem,
      mainProduct: productRows[0]?._mainProduct || productRows[0]?.['Main Product Sold'] || 'Main Product',
      details: productRows,
      ...modifierSummaryTotals(productRows)
    })).sort((left, right) => right.sales - left.sales || left.mainProduct.localeCompare(right.mainProduct));
    const totals = modifierSummaryTotals(modifierRowsForItem);
    return {
      key,
      modifierItem,
      products,
      attachedMainProducts: products.map((product) => product.mainProduct).sort((left, right) => left.localeCompare(right)),
      zeroPriceCount: modifierRowsForItem.filter((row) => row._zeroPrice).length,
      ...totals
    };
  });
  modifierRows.sort(modifierSummarySortComparator(filters.modifierSummarySort || 'modifierSales'));
  return { allRows, filteredRows, modifierRows };
}

function modifierSummaryTotals(rows = []) {
  const qty = rows.reduce((sum, row) => sum + Number(row._qtySold || parseNumber(row['Qty Sold']) || 0), 0);
  const sales = rows.reduce((sum, row) => sum + Number(row._modifierSales || parseMoney(row['Modifier Selling']) || 0), 0);
  const cost = rows.reduce((sum, row) => sum + Number(row._modifierCost || parseMoney(row['Modifier Cost']) || 0), 0);
  const gp = sales - cost;
  const gpPercent = sales > 0 ? (gp / sales) * 100 : null;
  return {
    qty,
    sales,
    cost,
    gp,
    gpPercent,
    avgSelling: qty > 0 ? sales / qty : 0,
    avgCost: qty > 0 ? cost / qty : 0,
    mainProductCount: uniqueCount(rows, 'Main Product Sold')
  };
}

function modifierSummaryRowMatchesFilters(row = {}, filters = {}) {
  const item = String(filters.modifierSummaryItem || '').trim();
  if (item && String(row._modifierItem || row['Modifier Item'] || '') !== item) return false;
  const mainProduct = String(filters.modifierSummaryMainProduct || '').trim();
  if (mainProduct && String(row._mainProduct || row['Main Product Sold'] || '') !== mainProduct) return false;
  const category = String(filters.modifierSummaryCategory || '').trim();
  if (category && String(row._modifierCategory || row['Modifier Category'] || '') !== category) return false;
  return true;
}

function modifierSummaryOptions(rows = [], type = '') {
  const values = new Set();
  rows.forEach((row) => {
    if (type === 'item') values.add(String(row._modifierItem || row['Modifier Item'] || '').trim());
    if (type === 'mainProduct') values.add(String(row._mainProduct || row['Main Product Sold'] || '').trim());
    if (type === 'category') values.add(String(row._modifierCategory || row['Modifier Category'] || '').trim());
  });
  const labels = [...values].filter(Boolean).sort((left, right) => left.localeCompare(right));
  const fallback = type === 'item'
    ? 'All Modifier Items'
    : type === 'mainProduct'
      ? 'All Main Products'
      : 'All Categories';
  return [{ value: '', label: fallback }, ...labels.map((label) => ({ value: label, label }))];
}

function modifierSummarySortOptions() {
  return [
    { value: 'modifierSales', label: 'Modifier Sales' },
    { value: 'qtySold', label: 'Qty Sold' },
    { value: 'modifierGp', label: 'Modifier GP' },
    { value: 'modifierGpPercent', label: 'Modifier GP %' }
  ];
}

function modifierSummarySortComparator(sortKey = 'modifierSales') {
  const metric = sortKey === 'qtySold'
    ? 'qty'
    : sortKey === 'modifierGp'
      ? 'gp'
      : sortKey === 'modifierGpPercent'
        ? 'gpPercent'
        : 'sales';
  return (left, right) => {
    const leftValue = left[metric] === null ? Number.NEGATIVE_INFINITY : Number(left[metric] || 0);
    const rightValue = right[metric] === null ? Number.NEGATIVE_INFINITY : Number(right[metric] || 0);
    return rightValue - leftValue || String(left.modifierItem || '').localeCompare(String(right.modifierItem || ''));
  };
}

export function buildModifierSummaryExportRows(rows = [], filters = {}) {
  return rows
    .filter((row) => row && row._modifierItem)
    .filter((row) => modifierSummaryRowMatchesFilters(row, filters));
}

function modifierSummaryMoneyBadge(value = 0) {
  const numeric = Number(value || 0);
  const tone = numeric < 0 ? 'is-negative' : numeric > 0 ? 'is-positive' : 'is-neutral';
  return `<span class="analyticsModifierSummaryMoney ${tone}">${escapeHtml(formatMoney(numeric))}</span>`;
}

function modifierSummaryPercentBadge(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '<span class="analyticsModifierSummaryPercent is-na">N/A</span>';
  }
  return `<span class="analyticsGpBadge ${gpToneClass(Number(value || 0))}">${escapeHtml(`${formatNumber(value)}%`)}</span>`;
}

function formatOptionalPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  return `${formatNumber(value)}%`;
}
