import { escapeHtml } from '../engine/formatters.js';
import { text, toArray } from '../engine/grouping.js';
import { REPORT_DATE_RANGE_PRESETS, inferDateRangeType } from '../scheduling/dateRangePresets.js';

const DEFAULT_FILTERS = ['search', 'dateRange', 'location', 'category', 'source', 'time'];

export function renderReportFilters({ filters = {}, locations = [], categories = [], sources = [], paymentMethods = [], statuses = [], menuCategories = [], menuItems = [], inventoryCategories = [], inventoryItems = [], modifierGroups = [], modifierTypes = [], modifierNames = [], stockDeductionStatuses = [], yocoCategories = [], recipeStatuses = [], riskStatuses = [], warningSeverities = [], suppliers = [], itemTypes = [], users = [], actions = [], entityTypes = [], entityNames = [], config = null } = {}) {
  const form = document.createElement('form');
  const enabled = resolveEnabledFilters(config);
  const normalizedLocations = normalizeLocationOptions(locations);
  const normalizedCategories = normalizeCategoryOptions(categories);
  const normalizedSources = normalizeSourceOptions(sources);
  const normalizedPaymentMethods = normalizeGenericOptions(paymentMethods);
  const normalizedStatuses = normalizeGenericOptions(statuses);
  const normalizedMenuCategories = normalizeGenericOptions(menuCategories);
  const normalizedMenuItems = normalizeObjectOptions(menuItems);
  const normalizedInventoryCategories = normalizeGenericOptions(inventoryCategories);
  const normalizedInventoryItems = normalizeObjectOptions(inventoryItems);
  const normalizedModifierGroups = normalizeObjectOptions(modifierGroups);
  const normalizedModifierTypes = normalizeGenericOptions(modifierTypes.length ? modifierTypes : ['Product', 'Note']);
  const normalizedModifierNames = normalizeGenericOptions(modifierNames);
  const normalizedStockDeductionStatuses = normalizeGenericOptions(stockDeductionStatuses.length ? stockDeductionStatuses : ['Deducted', 'Missing Modifier Usage', 'No Stock Mapping Required', 'Deducted - Sale Line Missing']);
  const normalizedYocoCategories = normalizeGenericOptions(yocoCategories);
  const normalizedRecipeStatuses = normalizeGenericOptions(recipeStatuses.length ? recipeStatuses : ['Recipe Ready', 'Missing Recipe', 'Recipe Missing Ingredients']);
  const normalizedRiskStatuses = normalizeGenericOptions(riskStatuses.length ? riskStatuses : ['Healthy', 'Warning', 'Critical']);
  const normalizedWarningSeverities = normalizeGenericOptions(warningSeverities.length ? warningSeverities : ['Critical', 'Warning', 'Info']);
  const normalizedSuppliers = normalizeObjectOptions(suppliers);
  const normalizedItemTypes = normalizeGenericOptions(itemTypes.length ? itemTypes : ['raw', 'prep', 'non_stock', 'sub_recipe']);
  const normalizedUsers = normalizeGenericOptions(users);
  const normalizedActions = normalizeGenericOptions(actions);
  const normalizedEntityTypes = normalizeGenericOptions(entityTypes);
  const normalizedEntityNames = normalizeGenericOptions(entityNames);
  const yesNoOptions = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];
  const hasLocation = normalizedLocations.length > 0 || text(filters.locationId);
  const hasCategory = normalizedCategories.length > 0 || text(filters.category);
  const hasSource = normalizedSources.length > 0 || text(filters.source || filters.sourceType);
  const hasPaymentMethod = normalizedPaymentMethods.length > 0 || text(filters.paymentMethod);
  const hasStatus = normalizedStatuses.length > 0 || text(filters.status);
  const hasMenuCategory = normalizedMenuCategories.length > 0 || text(filters.menuCategory);
  const hasMenuItem = normalizedMenuItems.length > 0 || text(filters.menuItemId);
  const hasInventoryCategory = normalizedInventoryCategories.length > 0 || text(filters.inventoryCategory);
  const hasInventoryItem = normalizedInventoryItems.length > 0 || text(filters.inventoryItemId);
  const hasModifierGroup = normalizedModifierGroups.length > 0 || text(filters.modifierGroupId);
  const hasModifierType = normalizedModifierTypes.length > 0 || text(filters.modifierType);
  const hasModifierName = normalizedModifierNames.length > 0 || text(filters.modifierName);
  const hasStockDeductionStatus = normalizedStockDeductionStatuses.length > 0 || text(filters.stockDeductionStatus);
  const hasYocoCategory = normalizedYocoCategories.length > 0 || text(filters.yocoCategory);
  const hasRecipeStatus = normalizedRecipeStatuses.length > 0 || text(filters.recipeStatus);
  const hasRiskStatus = normalizedRiskStatuses.length > 0 || text(filters.riskStatus);
  const hasWarningSeverity = normalizedWarningSeverities.length > 0 || text(filters.warningSeverity);
  const hasSupplier = normalizedSuppliers.length > 0 || text(filters.supplierId || filters.supplier);
  const hasItemType = normalizedItemTypes.length > 0 || text(filters.itemType);
  const hasUser = normalizedUsers.length > 0 || text(filters.user);
  const hasAction = normalizedActions.length > 0 || text(filters.action);
  const hasEntityType = normalizedEntityTypes.length > 0 || text(filters.entityType);
  const hasEntityName = normalizedEntityNames.length > 0 || text(filters.entityName);

  form.className = 'reportFilters';
  form.setAttribute('novalidate', '');
  form.innerHTML = `
    ${enabled.has('search') ? renderTextField({
      label: 'Search',
      name: 'search',
      value: filters.search || '',
      placeholder: 'Item, category, user, note',
      icon: '⌕',
      fieldClass: 'reportFilterField--search'
    }) : ''}
    ${enabled.has('dateRange') ? renderDateRangeField({ filters }) : ''}
    ${enabled.has('time') ? renderTimeField({ value: filters.time || '' }) : ''}
    ${enabled.has('location') && hasLocation ? renderCustomSelect({
      label: 'Location',
      name: 'locationId',
      value: filters.locationId || '',
      placeholder: 'All locations',
      options: normalizedLocations
    }) : ''}
    ${enabled.has('category') && hasCategory ? renderCustomSelect({
      label: 'Category',
      name: 'category',
      value: filters.category || '',
      placeholder: 'All categories',
      options: normalizedCategories
    }) : ''}
    ${enabled.has('paymentMethod') && hasPaymentMethod ? renderCustomSelect({
      label: 'Payment Method',
      name: 'paymentMethod',
      value: filters.paymentMethod || '',
      placeholder: 'All payment methods',
      options: normalizedPaymentMethods
    }) : ''}
    ${enabled.has('status') && hasStatus ? renderCustomSelect({
      label: 'Status',
      name: 'status',
      value: filters.status || '',
      placeholder: 'All statuses',
      options: normalizedStatuses
    }) : ''}
    ${enabled.has('supplier') && hasSupplier ? renderCustomSelect({
      label: 'Supplier',
      name: 'supplierId',
      value: filters.supplierId || '',
      placeholder: 'All suppliers',
      options: normalizedSuppliers
    }) : ''}
    ${enabled.has('itemType') && hasItemType ? renderCustomSelect({
      label: 'Item Type',
      name: 'itemType',
      value: filters.itemType || '',
      placeholder: 'All item types',
      options: normalizedItemTypes
    }) : ''}
    ${enabled.has('user') && hasUser ? renderCustomSelect({
      label: 'User',
      name: 'user',
      value: filters.user || '',
      placeholder: 'All users',
      options: normalizedUsers
    }) : ''}
    ${enabled.has('action') && hasAction ? renderCustomSelect({
      label: 'Action',
      name: 'action',
      value: filters.action || '',
      placeholder: 'All actions',
      options: normalizedActions
    }) : ''}
    ${enabled.has('entityType') && hasEntityType ? renderCustomSelect({
      label: 'Entity Type',
      name: 'entityType',
      value: filters.entityType || '',
      placeholder: 'All entity types',
      options: normalizedEntityTypes
    }) : ''}
    ${enabled.has('entityName') && hasEntityName ? renderCustomSelect({
      label: 'Entity Name',
      name: 'entityName',
      value: filters.entityName || '',
      placeholder: 'All entities',
      options: normalizedEntityNames
    }) : ''}
    ${enabled.has('onlyCritical') ? renderCustomSelect({
      label: 'Only Critical',
      name: 'onlyCritical',
      value: filters.onlyCritical || '',
      placeholder: 'Any',
      options: yesNoOptions
    }) : ''}
    ${enabled.has('onlyBelowPar') ? renderCustomSelect({
      label: 'Only Below Par',
      name: 'onlyBelowPar',
      value: filters.onlyBelowPar || '',
      placeholder: 'Any',
      options: yesNoOptions
    }) : ''}
    ${enabled.has('missingSupplier') ? renderCustomSelect({
      label: 'Missing Supplier',
      name: 'missingSupplier',
      value: filters.missingSupplier || '',
      placeholder: 'Any',
      options: yesNoOptions
    }) : ''}
    ${enabled.has('missingCost') ? renderCustomSelect({
      label: 'Missing Cost',
      name: 'missingCost',
      value: filters.missingCost || '',
      placeholder: 'Any',
      options: yesNoOptions
    }) : ''}
    ${enabled.has('receiptNumber') ? renderTextField({
      label: 'Receipt Number',
      name: 'receiptNumber',
      value: filters.receiptNumber || '',
      placeholder: 'Receipt or transaction ID',
      icon: '#',
      fieldClass: 'reportFilterField--receipt'
    }) : ''}
    ${enabled.has('menuCategory') && hasMenuCategory ? renderCustomSelect({
      label: 'Menu Category',
      name: 'menuCategory',
      value: filters.menuCategory || '',
      placeholder: 'All menu categories',
      options: normalizedMenuCategories
    }) : ''}
    ${enabled.has('menuItem') && hasMenuItem ? renderCustomSelect({
      label: 'Menu Item',
      name: 'menuItemId',
      value: filters.menuItemId || '',
      placeholder: 'All menu items',
      options: normalizedMenuItems
    }) : ''}
    ${enabled.has('inventoryCategory') && hasInventoryCategory ? renderCustomSelect({
      label: 'Inventory Category',
      name: 'inventoryCategory',
      value: filters.inventoryCategory || '',
      placeholder: 'All inventory categories',
      options: normalizedInventoryCategories
    }) : ''}
    ${enabled.has('inventoryItem') && hasInventoryItem ? renderCustomSelect({
      label: 'Inventory Item',
      name: 'inventoryItemId',
      value: filters.inventoryItemId || '',
      placeholder: 'All inventory items',
      options: normalizedInventoryItems
    }) : ''}
    ${enabled.has('yocoCategory') && hasYocoCategory ? renderCustomSelect({
      label: 'YOCO Category',
      name: 'yocoCategory',
      value: filters.yocoCategory || '',
      placeholder: 'All YOCO categories',
      options: normalizedYocoCategories
    }) : ''}
    ${enabled.has('recipeStatus') && hasRecipeStatus ? renderCustomSelect({
      label: 'Recipe Status',
      name: 'recipeStatus',
      value: filters.recipeStatus || '',
      placeholder: 'All recipe statuses',
      options: normalizedRecipeStatuses
    }) : ''}
    ${enabled.has('riskStatus') && hasRiskStatus ? renderCustomSelect({
      label: 'Risk Status',
      name: 'riskStatus',
      value: filters.riskStatus || '',
      placeholder: 'All risk statuses',
      options: normalizedRiskStatuses
    }) : ''}
    ${enabled.has('warningSeverity') && hasWarningSeverity ? renderCustomSelect({
      label: 'Warning Severity',
      name: 'warningSeverity',
      value: filters.warningSeverity || '',
      placeholder: 'All severities',
      options: normalizedWarningSeverities
    }) : ''}
    ${enabled.has('modifierGroup') && hasModifierGroup ? renderCustomSelect({
      label: 'Modifier Group',
      name: 'modifierGroupId',
      value: filters.modifierGroupId || '',
      placeholder: 'All modifier groups',
      options: normalizedModifierGroups
    }) : ''}
    ${enabled.has('modifierType') && hasModifierType ? renderCustomSelect({
      label: 'Modifier Type',
      name: 'modifierType',
      value: filters.modifierType || '',
      placeholder: 'All modifier types',
      options: normalizedModifierTypes
    }) : ''}
    ${enabled.has('modifierName') && hasModifierName ? renderCustomSelect({
      label: 'Modifier Name',
      name: 'modifierName',
      value: filters.modifierName || '',
      placeholder: 'All modifiers',
      options: normalizedModifierNames
    }) : ''}
    ${enabled.has('stockDeductionStatus') && hasStockDeductionStatus ? renderCustomSelect({
      label: 'Stock Deduction Status',
      name: 'stockDeductionStatus',
      value: filters.stockDeductionStatus || '',
      placeholder: 'All stock statuses',
      options: normalizedStockDeductionStatuses
    }) : ''}
    ${enabled.has('source') && hasSource ? renderCustomSelect({
      label: 'Source',
      name: 'source',
      value: filters.source || filters.sourceType || '',
      placeholder: 'All sources',
      options: normalizedSources
    }) : ''}
    ${enabled.has('sourceType') && hasSource ? renderCustomSelect({
      label: 'Source Type',
      name: 'sourceType',
      value: filters.sourceType || filters.source || '',
      placeholder: 'All source types',
      options: normalizedSources
    }) : ''}
    ${enabled.has('lookbackPeriod') ? renderCustomSelect({
      label: 'Lookback Period',
      name: 'lookbackPeriod',
      value: filters.lookbackPeriod || '30',
      placeholder: '30 days',
      options: [7, 14, 30, 60, 90].map((days) => ({ value: String(days), label: `${days} days` }))
    }) : ''}
    ${enabled.has('costChangeThreshold') ? renderTextField({
      label: 'Cost Change Threshold %',
      name: 'costChangeThreshold',
      value: filters.costChangeThreshold || '',
      placeholder: 'Any',
      icon: '%',
      fieldClass: 'reportFilterField--number'
    }) : ''}
    ${enabled.has('volatilityThreshold') ? renderTextField({
      label: 'Volatility Threshold %',
      name: 'volatilityThreshold',
      value: filters.volatilityThreshold || '',
      placeholder: 'Any',
      icon: '%',
      fieldClass: 'reportFilterField--number'
    }) : ''}
    ${enabled.has('varianceThreshold') ? renderTextField({
      label: 'Variance Threshold',
      name: 'varianceThreshold',
      value: filters.varianceThreshold || '',
      placeholder: 'Any value',
      icon: '±',
      fieldClass: 'reportFilterField--number'
    }) : ''}
    ${enabled.has('onlyHighRisk') ? renderCustomSelect({
      label: 'Only High Risk',
      name: 'onlyHighRisk',
      value: filters.onlyHighRisk || '',
      placeholder: 'Any',
      options: yesNoOptions
    }) : ''}
    ${enabled.has('onlyHighVolatility') ? renderCustomSelect({
      label: 'Only High Volatility',
      name: 'onlyHighVolatility',
      value: filters.onlyHighVolatility || '',
      placeholder: 'Any',
      options: yesNoOptions
    }) : ''}
    ${enabled.has('onlyItemsWithStockTake') ? renderCustomSelect({
      label: 'Only With Stock Take',
      name: 'onlyItemsWithStockTake',
      value: filters.onlyItemsWithStockTake || '',
      placeholder: 'Any',
      options: yesNoOptions
    }) : ''}
    ${enabled.has('onlyNegativeVariance') ? renderCustomSelect({
      label: 'Only Negative Variance',
      name: 'onlyNegativeVariance',
      value: filters.onlyNegativeVariance || '',
      placeholder: 'Any',
      options: yesNoOptions
    }) : ''}
    ${enabled.has('onlyPositiveVariance') ? renderCustomSelect({
      label: 'Only Positive Variance',
      name: 'onlyPositiveVariance',
      value: filters.onlyPositiveVariance || '',
      placeholder: 'Any',
      options: yesNoOptions
    }) : ''}
    <div class="reportFilters__actions">
      <button type="submit">Apply</button>
    </div>
  `;
  return form;
}

export function readReportFilters(form) {
  const data = new FormData(form);
  const parsedRange = parseDateRangeText(String(data.get('dateRangeDisplay') || ''));
  const startDate = String(data.get('startDate') || parsedRange.startDate || '').trim();
  const endDate = String(data.get('endDate') || parsedRange.endDate || '').trim();
  return {
    search: String(data.get('search') || '').trim(),
    dateRangeType: String(data.get('dateRangeType') || 'custom').trim(),
    time: normalizeTime(String(data.get('time') || '').trim()),
    startDate,
    endDate,
    locationId: String(data.get('locationId') || '').trim(),
    category: String(data.get('category') || '').trim(),
    source: String(data.get('source') || '').trim(),
    sourceType: String(data.get('sourceType') || data.get('source') || '').trim(),
    paymentMethod: String(data.get('paymentMethod') || '').trim(),
    status: String(data.get('status') || '').trim(),
    receiptNumber: String(data.get('receiptNumber') || '').trim(),
    menuCategory: String(data.get('menuCategory') || '').trim(),
    menuItemId: String(data.get('menuItemId') || '').trim(),
    inventoryCategory: String(data.get('inventoryCategory') || '').trim(),
    inventoryItemId: String(data.get('inventoryItemId') || '').trim(),
    modifierGroupId: String(data.get('modifierGroupId') || '').trim(),
    modifierType: String(data.get('modifierType') || '').trim(),
    modifierName: String(data.get('modifierName') || '').trim(),
    stockDeductionStatus: String(data.get('stockDeductionStatus') || '').trim(),
    yocoCategory: String(data.get('yocoCategory') || '').trim(),
    recipeStatus: String(data.get('recipeStatus') || '').trim(),
    riskStatus: String(data.get('riskStatus') || '').trim(),
    warningSeverity: String(data.get('warningSeverity') || '').trim(),
    supplierId: String(data.get('supplierId') || '').trim(),
    itemType: String(data.get('itemType') || '').trim(),
    onlyCritical: String(data.get('onlyCritical') || '').trim(),
    onlyHighRisk: String(data.get('onlyHighRisk') || '').trim(),
    onlyHighVolatility: String(data.get('onlyHighVolatility') || '').trim(),
    onlyItemsWithStockTake: String(data.get('onlyItemsWithStockTake') || '').trim(),
    onlyNegativeVariance: String(data.get('onlyNegativeVariance') || '').trim(),
    onlyPositiveVariance: String(data.get('onlyPositiveVariance') || '').trim(),
    lookbackPeriod: String(data.get('lookbackPeriod') || '').trim(),
    costChangeThreshold: String(data.get('costChangeThreshold') || '').trim(),
    volatilityThreshold: String(data.get('volatilityThreshold') || '').trim(),
    varianceThreshold: String(data.get('varianceThreshold') || '').trim(),
    onlyBelowPar: String(data.get('onlyBelowPar') || '').trim(),
    missingSupplier: String(data.get('missingSupplier') || '').trim(),
    missingCost: String(data.get('missingCost') || '').trim(),
    user: String(data.get('user') || '').trim(),
    action: String(data.get('action') || '').trim(),
    entityType: String(data.get('entityType') || '').trim(),
    entityName: String(data.get('entityName') || '').trim()
  };
}

function resolveEnabledFilters(config) {
  const raw = Array.isArray(config) ? config : Array.isArray(config?.enabled) ? config.enabled : DEFAULT_FILTERS;
  return new Set(raw);
}

function renderDateRangeField({ filters = {} }) {
  const startDate = text(filters.startDate || filters.dateFrom || filters.from);
  const endDate = text(filters.endDate || filters.dateTo || filters.to);
  const dateRangeType = inferDateRangeType({ ...filters, startDate, endDate });
  const display = startDate && endDate ? `${startDate} → ${endDate}` : startDate || endDate || '';
  const presetOptions = REPORT_DATE_RANGE_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }));
  return `
    <span class="reportDateRangeFields" data-report-date-range-fields>
      ${renderCustomSelect({
        label: 'Date range',
        name: 'dateRangeType',
        value: dateRangeType,
        placeholder: 'Custom Range',
        options: presetOptions
      })}
      <label class="reportFilterField reportFilterField--dateRange${dateRangeType === 'custom' ? '' : ' is-hidden'}" data-report-date-range>
        <span class="reportFilterField__label">Custom dates</span>
        <span class="reportFilterControl reportDateRangeControl">
          <span class="reportFilterControl__icon" aria-hidden="true">◷</span>
          <input type="hidden" name="startDate" value="${escapeHtml(startDate)}" data-report-start-date />
          <input type="hidden" name="endDate" value="${escapeHtml(endDate)}" data-report-end-date />
          <input type="text" name="dateRangeDisplay" value="${escapeHtml(display)}" placeholder="Select from and to" autocomplete="off" data-report-date-display />
          <button type="button" class="reportPickerButton" data-report-date-button aria-label="Open date range picker">▦</button>
        </span>
        <span class="reportDatePicker" data-report-date-picker></span>
      </label>
    </span>
  `;
}

function renderTimeField({ value = '' }) {
  const safeValue = normalizeTime(value);
  return `
    <label class="reportFilterField reportFilterField--time" data-report-time-picker>
      <span class="reportFilterField__label">Time</span>
      <span class="reportFilterControl reportTimeControl">
        <span class="reportFilterControl__icon" aria-hidden="true">◴</span>
        <input type="text" name="time" value="${escapeHtml(safeValue)}" placeholder="HH:MM" inputmode="numeric" autocomplete="off" data-report-time-input />
        <button type="button" class="reportPickerButton" data-report-time-button aria-label="Open time picker">⌚</button>
      </span>
      <span class="reportTimePicker" data-report-time-menu>
        ${buildTimeOptions().map((time) => `<button type="button" data-report-time-option="${escapeHtml(time)}">${escapeHtml(time)}</button>`).join('')}
      </span>
    </label>
  `;
}

function renderTextField({ label, name, value = '', placeholder = '', icon = '', fieldClass = '' }) {
  return `
    <label class="reportFilterField ${escapeHtml(fieldClass)}">
      <span class="reportFilterField__label">${escapeHtml(label)}</span>
      <span class="reportFilterControl">
        <span class="reportFilterControl__icon" aria-hidden="true">${escapeHtml(icon)}</span>
        <input type="text" name="${escapeHtml(name)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" />
      </span>
    </label>
  `;
}

function renderCustomSelect({ label, name, value = '', placeholder = '', options = [] }) {
  const allOptions = [{ value: '', label: placeholder }, ...toArray(options).filter((option) => option.value || option.label)];
  return `
    <label class="reportFilterField reportFilterField--select">
      <span class="reportFilterField__label">${escapeHtml(label)}</span>
      <select name="${escapeHtml(name)}" data-report-select-min-width="190" aria-label="${escapeHtml(label)}">
        ${allOptions.map((option) => `
          <option value="${escapeHtml(option.value)}" ${String(option.value) === String(value) ? 'selected' : ''}>${escapeHtml(option.label)}</option>
        `).join('')}
      </select>
    </label>
  `;
}

function normalizeLocationOptions(locations = []) {
  const seen = new Set();
  return toArray(locations).map((location) => {
    const id = text(location.id || location.locationId || location.location_id || location.key);
    const label = text(location.displayName || location.display_name || location.name || location.locationName || location.externalName || location.external_name || id);
    return { value: id || label, label: label || id };
  }).filter((option) => {
    const key = `${option.value}::${option.label}`;
    if (!option.value && !option.label) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.label.localeCompare(b.label));
}

function normalizeCategoryOptions(categories = []) {
  return Array.from(new Set(toArray(categories).map((category) => text(category)).filter(Boolean)))
    .sort()
    .map((value) => ({ value, label: value }));
}

function normalizeSourceOptions(sources = []) {
  return Array.from(new Set(toArray(sources).map((source) => text(source)).filter(Boolean)))
    .sort()
    .map((value) => ({ value, label: value }));
}

function buildTimeOptions() {
  const values = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 15, 30, 45]) {
      values.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
  }
  return values;
}

function normalizeTime(value = '') {
  const raw = text(value);
  if (!raw) return '';
  const match = raw.match(/^(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return raw;
  const hour = Math.min(23, Math.max(0, Number(match[1]) || 0));
  const minute = Math.min(59, Math.max(0, Number(match[2] || 0) || 0));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseDateRangeText(value = '') {
  const dates = text(value).match(/\d{4}-\d{2}-\d{2}/g) || [];
  return { startDate: dates[0] || '', endDate: dates[1] || '' };
}

function normalizeGenericOptions(values = []) {
  return Array.from(new Set(toArray(values).map((value) => text(value?.label || value?.value || value)).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, label: value }));
}

function normalizeObjectOptions(values = []) {
  const seen = new Set();
  return toArray(values).map((item) => {
    const value = text(item.value || item.id || item.menuItemId || item.inventoryItemId || item.key || item.label || item.name);
    const label = text(item.label || item.name || item.menuItemName || item.inventoryItemName || item.value || value);
    return { value, label };
  }).filter((option) => {
    const key = `${option.value}::${option.label}`;
    if (!option.value && !option.label) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.label.localeCompare(b.label));
}
