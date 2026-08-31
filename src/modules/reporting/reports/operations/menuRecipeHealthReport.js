import { fetchMenuRecipeHealthRows } from '../../api/reportingApi.js';
import { calculateFoodCostPercent, calculateGpPercent, calculateGrossProfit, safeNumber } from '../../engine/calculations.js';
import { groupBy, sumBy, text, toArray } from '../../engine/grouping.js';
import { formatMoney } from '../../engine/formatters.js';
import { buildRowFormulaTooltip } from '../../tooltips/tooltipBuilder.js';
import { filterCustomerActionableIssueText, filterCustomerActionableQualityRows } from '../../validators/warningCategories.js';

const money = (value) => formatMoney(value || 0);
const percent = (value) => `${((safeNumber(value) || 0) * 100).toFixed(1)}%`;
const tooltip = (key, values = '') => buildRowFormulaTooltip(key, values);

const sellingPriceExVatTooltip = (row) => tooltip('sellingPriceExVat', `Selling Price Ex VAT = Selling Price Incl VAT - VAT\n${money(row.sellingPriceExVat)} = ${money(row.sellingPriceInclVat)} - ${money(row.vat)}`);
const recipeCostTooltip = (row) => tooltip('recipeCostExVat', `Recipe Cost Ex VAT = Sum of ingredient line costs\n${money(row.recipeCostExVat)}`);
const lineCostTooltip = (row) => tooltip('lineCost', `Line Cost = Qty Required x Unit Cost Ex VAT\n${money(row.lineCost)} = ${safeNumber(row.qtyRequired).toFixed(3)} x ${money(row.unitCostExVat)}`);
const foodCostTooltip = (row) => tooltip('foodCostPercent', `Food Cost % = Recipe Cost Ex VAT / Selling Price Ex VAT\n${percent(row.foodCostPercent)} = ${money(row.recipeCostExVat)} / ${money(row.sellingPriceExVat)}`);
const grossProfitTooltip = (row) => tooltip('grossProfit', `Gross Profit = Selling Price Ex VAT - Recipe Cost Ex VAT\n${money(row.grossProfit)} = ${money(row.sellingPriceExVat)} - ${money(row.recipeCostExVat)}`);
const gpPercentTooltip = (row) => tooltip('menuGpPercent', `GP % = Gross Profit / Selling Price Ex VAT\n${percent(row.gpPercent)} = ${money(row.grossProfit)} / ${money(row.sellingPriceExVat)}`);

const moneyColumn = (key, label, tooltipKey, cellTooltip) => ({ key, label, type: 'money', align: 'right', tooltipKey, cellTooltip, sortable: true });
const numberColumn = (key, label) => ({ key, label, type: 'number', align: 'right', sortable: true });
const qtyColumn = (key, label) => ({ key, label, type: 'qty', align: 'right', sortable: true });
const percentColumn = (key, label, tooltipKey, cellTooltip) => ({ key, label, type: 'percent', align: 'right', tooltipKey, cellTooltip, sortable: true });

const overviewColumns = [
  { key: 'menuCategory', label: 'Menu Category', sortable: true },
  numberColumn('menuItems', 'Menu Items'),
  numberColumn('itemsWithRecipes', 'Items With Recipes'),
  numberColumn('itemsMissingRecipes', 'Items Missing Recipes'),
  numberColumn('itemsMissingCost', 'Items Missing Cost'),
  numberColumn('itemsWithModifierWarnings', 'Items With Modifier Warnings'),
  numberColumn('itemsWithYocoMappingIssues', 'Items With YOCO Mapping Issues'),
  moneyColumn('avgSellingPriceExVat', 'Avg Selling Price Ex VAT', 'sellingPriceExVat'),
  moneyColumn('avgRecipeCostExVat', 'Avg Recipe Cost Ex VAT', 'recipeCostExVat'),
  percentColumn('avgFoodCostPercent', 'Avg Food Cost %', 'foodCostPercent'),
  percentColumn('avgGpPercent', 'Avg GP %', 'menuGpPercent'),
  { key: 'riskStatus', label: 'Risk Status', sortable: true }
];

const menuItemColumns = [
  { key: 'menuItemName', label: 'Menu Item', sortable: true },
  { key: 'yocoProductVariant', label: 'YOCO Product / Variant', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'locationPriceStatus', label: 'Location Price Status', sortable: true },
  moneyColumn('sellingPriceInclVat', 'Selling Price Incl VAT', 'grossSales'),
  moneyColumn('vat', 'VAT', 'salesVat'),
  moneyColumn('sellingPriceExVat', 'Selling Price Ex VAT', 'sellingPriceExVat', sellingPriceExVatTooltip),
  moneyColumn('recipeCostExVat', 'Recipe Cost Ex VAT', 'recipeCostExVat', recipeCostTooltip),
  { key: 'modifierCostRisk', label: 'Modifier Cost Risk', sortable: true },
  percentColumn('foodCostPercent', 'Food Cost %', 'foodCostPercent', foodCostTooltip),
  moneyColumn('grossProfit', 'Gross Profit', 'grossProfit', grossProfitTooltip),
  percentColumn('gpPercent', 'GP %', 'menuGpPercent', gpPercentTooltip),
  { key: 'recipeStatus', label: 'Recipe Status', sortable: true },
  { key: 'stockDeductionStatus', label: 'Stock Deduction Status', sortable: true },
  { key: 'warningsText', label: 'Warnings', sortable: false }
];

const recipeDetailColumns = [
  { key: 'menuItemName', label: 'Menu Item', sortable: true },
  { key: 'recipeSubRecipe', label: 'Recipe / Sub-Recipe', sortable: true },
  { key: 'recipeLevel', label: 'Recipe Level', sortable: true },
  { key: 'recipeLineType', label: 'Recipe Line Type', sortable: true },
  { key: 'ingredientName', label: 'Ingredient', sortable: true },
  { key: 'inventoryCategory', label: 'Inventory Category', sortable: true },
  qtyColumn('qtyRequired', 'Qty Required'),
  { key: 'baseUom', label: 'Base UOM', sortable: true },
  moneyColumn('unitCostExVat', 'Unit Cost Ex VAT', 'unitCostExVat'),
  moneyColumn('lineCost', 'Line Cost', 'lineCost', lineCostTooltip),
  qtyColumn('inStockQty', 'In Stock Qty'),
  qtyColumn('lowStockThreshold', 'Low Stock Threshold'),
  { key: 'status', label: 'Status', sortable: true },
  { key: 'warning', label: 'Warning', sortable: false }
];

const pricingColumns = [
  { key: 'menuItemName', label: 'Menu Item', sortable: true },
  { key: 'yocoProductName', label: 'YOCO Product', sortable: true },
  { key: 'yocoVariantName', label: 'YOCO Variant', sortable: true },
  { key: 'locationName', label: 'Location', sortable: true },
  moneyColumn('sellingPriceInclVat', 'Selling Price Incl VAT', 'grossSales'),
  percentColumn('vatRate', 'VAT Rate', 'salesVat'),
  moneyColumn('vat', 'VAT', 'salesVat'),
  moneyColumn('sellingPriceExVat', 'Selling Price Ex VAT', 'sellingPriceExVat', sellingPriceExVatTooltip),
  moneyColumn('recipeCostExVat', 'Recipe Cost Ex VAT', 'recipeCostExVat', recipeCostTooltip),
  moneyColumn('grossProfit', 'Gross Profit', 'grossProfit', grossProfitTooltip),
  percentColumn('gpPercent', 'GP %', 'menuGpPercent', gpPercentTooltip),
  percentColumn('foodCostPercent', 'Food Cost %', 'foodCostPercent', foodCostTooltip),
  { key: 'priceStatus', label: 'Price Status', sortable: true },
  { key: 'warning', label: 'Warning', sortable: false }
];

const warningsColumns = [
  { key: 'severity', label: 'Severity', sortable: true },
  { key: 'menuItemName', label: 'Menu Item', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'issueType', label: 'Issue Type', sortable: true },
  { key: 'issue', label: 'Issue', sortable: false },
  { key: 'impact', label: 'Impact', sortable: false },
  { key: 'suggestedFix', label: 'Suggested Fix', sortable: false }
];

const menuItemsExportMapping = {
  menuItemName: 'Menu Item',
  yocoProductVariant: 'YOCO Product / Variant',
  category: 'Category',
  locationPriceStatus: 'Location Price Status',
  sellingPriceInclVat: 'Selling Price Incl VAT',
  vat: 'VAT',
  sellingPriceExVat: 'Selling Price Ex VAT',
  recipeCostExVat: 'Recipe Cost Ex VAT',
  modifierCostRisk: 'Modifier Cost Risk',
  foodCostPercent: 'Food Cost %',
  grossProfit: 'Gross Profit',
  gpPercent: 'GP %',
  recipeStatus: 'Recipe Status',
  stockDeductionStatus: 'Stock Deduction Status',
  warningsText: 'Warnings'
};

const recipeDetailExportMapping = {
  menuItemName: 'Menu Item',
  recipeSubRecipe: 'Recipe / Sub-Recipe',
  recipeLevel: 'Recipe Level',
  recipeLineType: 'Recipe Line Type',
  ingredientName: 'Ingredient',
  inventoryCategory: 'Inventory Category',
  qtyRequired: 'Qty Required',
  baseUom: 'UOM',
  unitCostExVat: 'Unit Cost Ex VAT',
  lineCost: 'Line Cost',
  status: 'Status',
  warning: 'Warning'
};

const pricingExportMapping = {
  menuItemName: 'Menu Item',
  yocoProductName: 'YOCO Product',
  yocoVariantName: 'YOCO Variant',
  locationName: 'Location',
  sellingPriceInclVat: 'Selling Price Incl VAT',
  vatRate: 'VAT Rate',
  vat: 'VAT',
  sellingPriceExVat: 'Selling Price Ex VAT',
  recipeCostExVat: 'Recipe Cost Ex VAT',
  grossProfit: 'Gross Profit',
  gpPercent: 'GP %',
  foodCostPercent: 'Food Cost %',
  priceStatus: 'Price Status',
  warning: 'Warning'
};

const warningsExportMapping = {
  severity: 'Severity',
  menuItemName: 'Menu Item',
  category: 'Category',
  issueType: 'Issue Type',
  issue: 'Issue',
  impact: 'Impact',
  suggestedFix: 'Suggested Fix'
};

export const menuRecipeHealthReport = {
  id: 'menu_recipe_health',
  title: 'Menu & Recipe Health',
  section: 'operations',
  description: 'Checks menu item setup, YOCO product mapping, recipe completeness, recipe cost, selling price, GP, food cost percentage, sub-recipes, modifiers, and setup warnings.',
  emptyState: { title: 'No menu items found', message: 'No menu or recipe items found for the selected filters.' },
  suppressEmptyWarning: true,
  defaultView: 'menu_items',
  availableViews: ['overview', 'menu_items', 'recipe_detail', 'pricing', 'warnings'],
  filterConfig: {
    overview: ['search', 'menuCategory', 'yocoCategory', 'location', 'recipeStatus', 'stockDeductionStatus', 'riskStatus'],
    menu_items: ['search', 'menuCategory', 'menuItem', 'yocoCategory', 'location', 'recipeStatus', 'stockDeductionStatus', 'riskStatus'],
    recipe_detail: ['search', 'menuCategory', 'menuItem', 'inventoryCategory', 'inventoryItem', 'recipeStatus'],
    pricing: ['search', 'menuCategory', 'menuItem', 'yocoCategory', 'location', 'riskStatus'],
    warnings: ['search', 'menuCategory', 'menuItem', 'yocoCategory', 'location', 'warningSeverity', 'riskStatus']
  },
  columns: {
    overview: overviewColumns,
    menu_items: menuItemColumns,
    recipe_detail: recipeDetailColumns,
    pricing: pricingColumns,
    warnings: warningsColumns
  },
  exportMapping: {
    overview: {
      menuCategory: 'Menu Category',
      menuItems: 'Menu Items',
      itemsWithRecipes: 'Items With Recipes',
      itemsMissingRecipes: 'Items Missing Recipes',
      itemsMissingCost: 'Items Missing Cost',
      itemsWithModifierWarnings: 'Items With Modifier Warnings',
      itemsWithYocoMappingIssues: 'Items With YOCO Mapping Issues',
      avgSellingPriceExVat: 'Avg Selling Price Ex VAT',
      avgRecipeCostExVat: 'Avg Recipe Cost Ex VAT',
      avgFoodCostPercent: 'Avg Food Cost %',
      avgGpPercent: 'Avg GP %',
      riskStatus: 'Risk Status'
    },
    menu_items: menuItemsExportMapping,
    recipe_detail: recipeDetailExportMapping,
    pricing: pricingExportMapping,
    warnings: warningsExportMapping
  },
  getRows: async ({ workspaceId, filters, services = {}, view = 'menu_items' }) => {
    const payload = services.reporting?.getMenuRecipeHealthRows
      ? await services.reporting.getMenuRecipeHealthRows({ workspaceId, filters })
      : await fetchMenuRecipeHealthRows({ workspaceId, filters });
    rememberMenuHealthPayload(services, payload);
    const rowsByView = buildMenuRecipeHealthViews(payload);
    return rowsByView[view] || rowsByView.menu_items;
  },
  getTotals: ({ rows, view }) => buildMenuRecipeHealthTotals(rows, view),
  validate: ({ rows, services }) => {
    if (!rows.length) return [];
    return [
      ...toArray(services?.reporting?.__lastMenuRecipeHealthPayload?.warnings),
      ...validateVisibleRows(rows)
    ];
  }
};

export function buildMenuRecipeHealthViews(payload = {}) {
  const menuRows = toArray(payload.rows).map(sanitizeMenuHealthRow);
  const recipeRows = toArray(payload.recipeRows).map(sanitizeMenuHealthRow);
  const pricingRows = toArray(payload.pricingRows).map(sanitizeMenuHealthRow);
  const warningRows = filterCustomerActionableQualityRows(toArray(payload.warningRows));
  return {
    overview: buildOverviewRows(menuRows),
    menu_items: menuRows,
    recipe_detail: recipeRows,
    pricing: pricingRows,
    warnings: warningRows
  };
}

function sanitizeMenuHealthRow(row = {}) {
  return {
    ...row,
    warningsText: filterCustomerActionableIssueText(row.warningsText),
    warning: filterCustomerActionableIssueText(row.warning),
    issue: filterCustomerActionableIssueText(row.issue)
  };
}

function buildOverviewRows(menuRows = []) {
  const groups = groupBy(menuRows, (row) => row.category || row.menuCategory || 'Uncategorised');
  return Array.from(groups.entries()).map(([menuCategory, rows]) => {
    const menuItems = rows.length;
    const withGpRows = rows.filter((row) => safeNumber(row.sellingPriceExVat) > 0);
    const criticalCount = rows.filter((row) => text(row.riskStatus) === 'Critical').length;
    const warningCount = rows.filter((row) => text(row.riskStatus) === 'Warning').length;
    const avg = (key, sourceRows = rows) => sourceRows.length ? sumBy(sourceRows, key) / sourceRows.length : 0;
    return {
      id: `menu-health-overview:${menuCategory}`,
      menuCategory,
      menuItems,
      itemsWithRecipes: rows.filter((row) => text(row.recipeStatus) === 'Recipe Ready').length,
      itemsMissingRecipes: rows.filter((row) => text(row.recipeStatus).includes('Missing')).length,
      itemsMissingCost: rows.filter((row) => safeNumber(row.recipeCostExVat) === 0 && text(row.recipeStatus) !== 'Missing Recipe').length,
      itemsWithModifierWarnings: rows.filter((row) => text(row.modifierCostRisk).toLowerCase().includes('warning') || text(row.modifierCostRisk).toLowerCase().includes('missing')).length,
      itemsWithYocoMappingIssues: rows.filter((row) => text(row.yocoMappingStatus).toLowerCase().includes('missing')).length,
      avgSellingPriceExVat: avg('sellingPriceExVat'),
      avgRecipeCostExVat: avg('recipeCostExVat'),
      avgFoodCostPercent: avg('foodCostPercent', withGpRows),
      avgGpPercent: avg('gpPercent', withGpRows),
      riskStatus: criticalCount ? 'Critical' : warningCount ? 'Warning' : 'Healthy'
    };
  }).sort((a, b) => a.menuCategory.localeCompare(b.menuCategory));
}

function buildMenuRecipeHealthTotals(rows = [], view = '') {
  if (!rows.length) return {};
  if (view === 'overview') {
    const menuItems = sumBy(rows, 'menuItems');
    return {
      menuCategory: 'Total',
      menuItems,
      itemsWithRecipes: sumBy(rows, 'itemsWithRecipes'),
      itemsMissingRecipes: sumBy(rows, 'itemsMissingRecipes'),
      itemsMissingCost: sumBy(rows, 'itemsMissingCost'),
      itemsWithModifierWarnings: sumBy(rows, 'itemsWithModifierWarnings'),
      itemsWithYocoMappingIssues: sumBy(rows, 'itemsWithYocoMappingIssues'),
      avgSellingPriceExVat: weightedAverage(rows, 'avgSellingPriceExVat', 'menuItems'),
      avgRecipeCostExVat: weightedAverage(rows, 'avgRecipeCostExVat', 'menuItems'),
      avgFoodCostPercent: weightedAverage(rows, 'avgFoodCostPercent', 'menuItems'),
      avgGpPercent: weightedAverage(rows, 'avgGpPercent', 'menuItems'),
      riskStatus: rows.some((row) => row.riskStatus === 'Critical') ? 'Critical' : rows.some((row) => row.riskStatus === 'Warning') ? 'Warning' : 'Healthy'
    };
  }
  if (view === 'menu_items' || view === 'pricing') {
    const sellingPriceExVat = sumBy(rows, 'sellingPriceExVat');
    const recipeCostExVat = sumBy(rows, 'recipeCostExVat');
    const grossProfit = calculateGrossProfit(sellingPriceExVat, recipeCostExVat);
    return {
      menuItemName: 'Total',
      sellingPriceInclVat: sumBy(rows, 'sellingPriceInclVat'),
      vat: sumBy(rows, 'vat'),
      sellingPriceExVat,
      recipeCostExVat,
      grossProfit,
      gpPercent: calculateGpPercent(grossProfit, sellingPriceExVat),
      foodCostPercent: calculateFoodCostPercent(recipeCostExVat, sellingPriceExVat)
    };
  }
  if (view === 'recipe_detail') {
    return {
      menuItemName: 'Total',
      qtyRequired: sumBy(rows, 'qtyRequired'),
      lineCost: sumBy(rows, 'lineCost'),
      inStockQty: sumBy(rows, 'inStockQty')
    };
  }
  return {};
}

function weightedAverage(rows = [], valueKey, weightKey) {
  const totalWeight = sumBy(rows, weightKey);
  if (!totalWeight) return 0;
  return rows.reduce((sum, row) => sum + safeNumber(row[valueKey]) * safeNumber(row[weightKey]), 0) / totalWeight;
}

function rememberMenuHealthPayload(services = {}, payload = {}) {
  if (!services.reporting) services.reporting = {};
  services.reporting.__lastMenuRecipeHealthPayload = payload;
}

function validateVisibleRows(rows = []) {
  const warnings = [];
  rows.forEach((row) => {
    const severity = text(row.riskStatus || row.severity);
    if (severity === 'Critical') {
      warnings.push(buildMenuSetupIssueWarning(row, 'critical'));
    } else if (severity === 'Warning') {
      warnings.push(buildMenuSetupIssueWarning(row, 'warning'));
    }
  });
  return warnings;
}

function buildMenuSetupIssueWarning(row = {}, level = 'warning') {
  const itemName = cleanMenuWarningLabel(row.menuItemName || row.yocoProductVariant || row.yocoProductName || row.menuCategory || 'Menu item');
  const codeSeed = text(row.sku || row.sourceId || row.menuItemId || row.yocoProductId || row.id || itemName);
  const issues = collectMenuSetupIssues(row);
  const message = issues.length
    ? `${itemName} - ${issues.join('; ')}.`
    : `${itemName} - Review the menu setup warning details for this row.`;
  return {
    code: `menu-recipe-health-${level}-${codeSeed || itemName}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    level,
    message,
    entityName: itemName,
    issueCount: issues.length
  };
}

function cleanMenuWarningLabel(value = '') {
  const cleaned = text(value)
    .replace(/\bprod_[a-z0-9-]+\b/gi, '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && !looksLikeMenuTechnicalId(part))
    .join(' / ')
    .replace(/\s+[-–—:]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || 'Menu item';
}

function looksLikeMenuTechnicalId(value = '') {
  const clean = text(value).trim();
  if (!clean) return false;
  if (/^prod_[a-z0-9-]+$/i.test(clean)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) return true;
  if (/^[0-9]{10,}[-:][a-z0-9:-]{8,}$/i.test(clean)) return true;
  if (/^[a-z0-9:-]{24,}$/i.test(clean) && /[0-9]/.test(clean) && /[-:]/.test(clean)) return true;
  return false;
}

function collectMenuSetupIssues(row = {}) {
  const issues = [];
  addIssueList(issues, row.warningsText);
  addIssueList(issues, row.warning);
  addIssueList(issues, row.issue);
  const recipeStatus = text(row.recipeStatus);
  const deductionStatus = text(row.stockDeductionStatus);
  const mappingStatus = text(row.yocoMappingStatus);
  const priceStatus = text(row.priceStatus || row.locationPriceStatus);
  const modifierRisk = text(row.modifierCostRisk);
  const rowStatus = text(row.status);

  if (recipeStatus && !['Recipe Ready', 'Ready', 'No Recipe Required'].includes(recipeStatus)) addIssueList(issues, recipeStatus);
  if (deductionStatus && !['Ready', 'OK', 'Healthy', 'Not Required'].includes(deductionStatus)) addIssueList(issues, deductionStatus);
  if (mappingStatus && !['Mapped', 'OK', 'Healthy'].includes(mappingStatus)) addIssueList(issues, mappingStatus);
  if (priceStatus && /missing|warning|below|zero|invalid/i.test(priceStatus)) addIssueList(issues, priceStatus);
  if (modifierRisk && !/no .*risk|healthy|ok/i.test(modifierRisk)) addIssueList(issues, modifierRisk);
  if (rowStatus && /missing|warning|critical|invalid|not ready|unlinked|unmapped/i.test(rowStatus)) addIssueList(issues, rowStatus);

  if (safeNumber(row.sellingPriceExVat) <= 0 && safeNumber(row.recipeCostExVat) > 0) {
    addIssueList(issues, 'Selling price is zero or missing while recipe cost exists');
  }
  if (safeNumber(row.recipeCostExVat) <= 0 && recipeStatus && recipeStatus !== 'Missing Recipe' && recipeStatus !== 'No Recipe Required') {
    addIssueList(issues, 'Recipe cost is zero or missing');
  }
  if (safeNumber(row.grossProfit) < 0) {
    addIssueList(issues, 'Selling price is below recipe cost');
  }

  return uniqueIssues(issues).slice(0, 5);
}

function addIssueList(target = [], value = '') {
  text(value)
    .split(/;|\n|\|/)
    .map((issue) => issue.trim())
    .filter(Boolean)
    .forEach((issue) => target.push(normalizeIssueText(issue)));
}

function normalizeIssueText(issue = '') {
  const clean = cleanMenuWarningLabel(issue).replace(/\s+/g, ' ').trim();
  if (!clean || clean === 'Menu item') return '';
  const sentence = clean.replace(/\bNot Ready\b/g, 'Not ready');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function uniqueIssues(issues = []) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = issue.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default menuRecipeHealthReport;
