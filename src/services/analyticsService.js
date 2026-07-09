import { calculateDashboardMetrics, getDashboardSourceOnce, getTradeDateKey, getStockValuationUnitCost, getIngredientUnitCost } from './database.js';
import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';
import { normalizeAdjustmentLogs } from './adjustmentLog.js';
import { isWastageAdjustment as isWastageAdjustmentLog } from './wastageClassifier.js';
import { getManufacturingComponentTotal, getManufacturingExpectedQty, getManufacturingShortfallQty, getManufacturingVarianceQty, getManufacturingWastageValue, normalizeManufacturingLogs } from './manufacturingLog.js';
import { DEFAULT_STOCK_LOCATION_ID, DEFAULT_STOCK_LOCATION_NAME, normalizeStockLocations } from './locationModel.js';
import { getLocationStock, resolveBalanceKey, sumBalances, normalizeLocationKey } from '../utils/stockBalances.js';

const REPORT_LOG_LIMIT = 5000;

const analyticsNodes = [
  { key: 'settings', path: 'settings', fallback: {} },
  { key: 'sites', path: 'sites', fallback: [] },
  { key: 'locations', path: 'locations', fallback: [] },
  { key: 'ingredients', path: 'ingredients', fallback: [] },
  { key: 'products', path: 'products', fallback: {} },
  { key: 'suppliers', path: 'suppliers', fallback: [] },
  { key: 'purchaseOrders', path: 'purchaseOrders', fallback: [] },
  { key: 'logs_grv', path: 'logs_grv', fallback: [], limit: REPORT_LOG_LIMIT },
  { key: 'logs_cn', path: 'logs_cn', fallback: [], limit: REPORT_LOG_LIMIT },
  { key: 'logs_adj', path: 'logs_adj', fallback: [], limit: REPORT_LOG_LIMIT },
  { key: 'logs_stocktakes', path: 'logs_stocktakes', fallback: [], limit: REPORT_LOG_LIMIT },
  { key: 'logs_inventory_audit', path: 'logs_inventory_audit', fallback: [], limit: REPORT_LOG_LIMIT },
  { key: 'logs_mfg', path: 'logs_mfg', fallback: [], limit: REPORT_LOG_LIMIT },
  { key: 'logs_transfers', path: 'logs_transfers', fallback: [], limit: REPORT_LOG_LIMIT },
  { key: 'logs_sales', path: 'logs_sales', fallback: [], limit: REPORT_LOG_LIMIT },
  { key: 'logs_sales_errors', path: 'logs_sales_errors', fallback: [], limit: REPORT_LOG_LIMIT },
  { key: 'logs_snapshots', path: 'logs_snapshots', fallback: [], limit: REPORT_LOG_LIMIT },
  { key: 'dashboardMetrics', path: 'dashboardMetrics', fallback: {} }
];

export const reportCatalog = [
  { id: 'custom_report', title: 'Custom Report Builder', group: 'Advanced', description: 'Build custom reports from available business datasets.', columns: ['Product Category', 'Region', 'Sales Rep', 'Sum of Sales Amount', 'Sum of Profit', 'Count of Orders'] },
  { id: 'stock', title: 'Stock On Hand', group: 'Inventory', description: 'Current stock balances and ex-VAT value.', columns: ['Item', 'Category', 'Location', 'On Hand', 'Unit', 'UOM Config', 'UOM 1 Name', 'UOM 1 Ratio', 'UOM 1 Barcode', 'UOM 2 Name', 'UOM 2 Ratio', 'UOM 2 Barcode', 'UOM 3 Name', 'UOM 3 Ratio', 'UOM 3 Barcode', 'Unit Cost', 'Stock Value'] },
  { id: 'movement', title: 'Stock Movement', group: 'Inventory', description: 'Purchases, usage, manufacturing output, wastage, adjustments, and transfers by item.', columns: ['Item', 'Category', 'Unit', 'Purchases', 'Sales Usage', 'Manufactured', 'Wastage', 'Adjustments', 'Transfers Net', 'Net Qty'] },
  { id: 'low_stock', title: 'Low Stock Alerts', group: 'Inventory', description: 'Items below low-stock threshold or par.', columns: ['Item', 'Category', 'Unit', 'Low Locations', 'Total Current Stock', 'Total Threshold', 'Total Variance', 'Total Deficit Value'] },
  { id: 'grv', title: 'GRV Log', group: 'Inventory', description: 'Goods received history.', columns: ['Date', 'Time', 'Supplier', 'Invoice', 'Location', 'Items', 'Total Ex', 'User', 'Action'] },
  { id: 'cn', title: 'Credit Notes', group: 'Inventory', description: 'Supplier credit note and return history.', columns: ['Date', 'Time', 'Supplier', 'Reference', 'Location', 'Items', 'Total Ex', 'User', 'Action'] },
  { id: 'purchase_orders', title: 'Purchase Orders', group: 'Inventory', description: 'Purchase order status and value.', columns: ['Date', 'Time', 'Supplier', 'Reference', 'Status', 'Location', 'Items', 'Total Ex', 'User', 'Action'] },
  { id: 'sale_movement', title: 'Sale Stock Movement', group: 'Inventory', description: 'Stock depletion associated with sales imports.', columns: ['Date', 'Time', 'Product', 'Product Status', 'Location', 'Qty Sold', 'Recipe Lines', 'Qty Depleted', 'COGS Ex', 'Action'] },
  { id: 'menu', title: 'Menu Health', group: 'Operations', description: 'Menu pricing, recipe cost, and GP.', columns: ['Menu Item', 'Category', 'Selling Price', 'Recipe Cost', 'GP %', 'Recipe Lines'] },
  { id: 'missing_recipes', title: 'Missing Recipes', group: 'Operations', description: 'Menu items without recipe links.', columns: ['Menu Item', 'Category', 'Selling Price', 'Status'] },
  { id: 'adj', title: 'Adjustments', group: 'Operations', description: 'Manual adjustment audit.', columns: ['Date', 'Time', 'User', 'Item', 'Category', 'Location', 'Mode', 'Quantity', 'Unit', 'Impact Ex', 'Reason'] },
  { id: 'stocktake', title: 'Stock Take Audit', group: 'Operations', description: 'Physical count sessions and variance.', columns: ['Date', 'Time', 'Location', 'User', 'Items Counted', 'Variance Lines', 'Net Impact', 'Action'] },
  { id: 'inventory_audit', title: 'Inventory Change Audit', group: 'Operations', description: 'Stock items created, updated, deleted, imported, or reset.', columns: ['Date', 'Time', 'Area', 'Item', 'Action', 'Location', 'Before', 'After', 'User', 'Source'] },
  { id: 'mfg', title: 'Manufacturing Productions', group: 'Operations', description: 'Production batches, posted output, wastage, and yield variance.', columns: ['Date', 'Time', 'User', 'Item', 'Type', 'Location', 'Expected', 'Produced', 'Wastage Qty', 'Variance', 'Batch Cost Ex', 'Wastage Value Ex', 'Unit'] },
  { id: 'transfers', title: 'Stock Transfers', group: 'Operations', description: 'Location-to-location movement history.', columns: ['Date', 'Time', 'User', 'Item', 'From', 'To', 'Quantity', 'Unit', 'Note'] },
  { id: 'ops_overview', title: 'Ops Overview By Category', group: 'Operations', description: 'Category-level operational summary.', columns: ['Category', 'Location', 'Stock Value', 'Purchases Ex', 'Wastage Ex', 'Manual Adjustments Ex', 'Low Stock Items'] },
  { id: 'ops_category_overview', title: 'Operations Overview By Inventory Category', group: 'Operations', description: 'Opening/closing stock value, purchases and actual vs theoretical cost of sales per inventory category.', columns: ['Inventory Category', 'Locations', 'Opening Stock Value', 'Purchases', 'Closing Stock Value', 'COS Actual', 'COS Theoretical', 'COS Difference'] },
  { id: 'ops_category_detail', title: 'Operations Detail By Inventory Category (Per Item)', group: 'Operations', description: 'Per-item breakdown within each inventory category: opening/closing stock value, purchases and actual vs theoretical cost of sales.', columns: ['Inventory Category', 'Locations', 'Item', 'Unit', 'Opening Stock Value', 'Purchases', 'Closing Stock Value', 'COS Actual', 'COS Theoretical', 'COS Difference'] },
  { id: 'ops_dashboard', title: 'Operations Dashboard', group: 'Operations', description: 'Single-period operational control summary.', columns: ['Location', 'Purchases Ex', 'Opening Stock', 'Closing Stock', 'Cost Of Sales', 'Count Variance', 'Manual Adjustments', 'Wastage'] },
  { id: 'sync_log', title: 'Sales Sync Log', group: 'Operations', description: 'Sales import summaries.', columns: ['Date', 'Time', 'Product', 'Product Status', 'Location', 'Qty Sold', 'COS Impact', 'Source'] },
  { id: 'sales_error_log', title: 'Sales Error Log', group: 'Operations', description: 'Sales import exceptions.', columns: ['Date', 'Time', 'Type', 'Product', 'Location', 'Reason', 'Detail'] },
  { id: 'activity_log', title: 'Detailed Activity Log', group: 'Operations', description: 'Unified inventory activity stream.', columns: ['Date', 'Time', 'Type', 'Location', 'User', 'Action', 'Summary'] },
  { id: 'payments', title: 'Payments Report', group: 'Operations', description: 'Consolidated payment tender summary by POS source. Gross is total takings including tips; Tips remain broken out separately; Net is revenue excluding VAT and tips after refunds.', columns: ['POS Source', 'Tender', 'Location', 'Orders', 'Gross Sales', 'Tips', 'Refunds', 'Tax Amount', 'Orders With Tip', 'Taxed Orders', 'No Tax Orders', 'Net'] },
  { id: 'modifier_gp_detail', title: 'Modifier GP Tracking', group: 'Sales', description: 'Track GP impact of modifier combinations attached to each main product.', columns: ['Date', 'Time', 'Main Product Sold', 'Modifier Item', 'Modifier Combination', 'Qty Sold', 'Main Product Selling', 'Modifier Selling', 'Main Selling Recipe Cost', 'Modifier Cost', 'Total Selling', 'Total Cost', 'GP Main %', 'GP Combined %', 'Additional GP %'] },
  { id: 'modifier_gp_summary', title: 'Modifier Summary Report', group: 'Sales', description: 'Summarise modifier sales, cost, and GP independent of main product GP tracking.', columns: ['Date', 'Time', 'Sale ID / Order ID', 'Main Product Sold', 'Modifier Item', 'Modifier Category', 'Qty Sold', 'Modifier Selling', 'Modifier Cost', 'Modifier GP', 'Modifier GP %', 'Status'] },
  { id: 'forecast', title: 'Stock-Out Forecast', group: 'Advanced', description: 'Predict items likely to run out based on current stock and consumption trends.', columns: ['Item', 'Category', 'Location', 'Unit', 'Current Stock', 'Avg Daily Usage', 'Days of Cover', 'Predicted Stock-out Date', 'Risk Level', 'Suggested Reorder Qty', 'Action'] },
  { id: 'volatility', title: 'Price Volatility Audit', group: 'Advanced', description: 'Monitor price changes and volatility by items vs suppliers.', columns: ['Item', 'Category', 'Supplier', 'Invoice Count', 'Current Unit Cost', 'Prior Unit Cost', '% Change', 'Variance (R)', 'Volatility Score', 'Risk Level', 'Action'] },
  { id: 'variance', title: 'Theoretical vs Actual Usage', group: 'Advanced', description: 'Compares movement-derived usage to recipe theoretical usage.', columns: ['Ingredient', 'Category', 'Unit', 'Actual Usage', 'Theoretical Usage', 'Variance Qty', 'Loss Value'] },
  { id: 'waste_pareto', title: 'Waste Pareto', group: 'Advanced', description: 'Waste loss by reason with cumulative contribution.', columns: ['Waste Reason', 'Location', 'User', 'Incidents', 'Total Loss Value', 'Cumulative %'] },
  { id: 'yoco_sales', title: 'Yoco Sales Report', group: 'Integrations', description: 'Yoco sale and refund lines from imported sales logs.', columns: ['Date', 'Time', 'Sale / Refund', 'Item Name', 'Item Status', 'Qty Sold', 'Total Impact', 'Location', 'Action'] }
];

const customReportDefaultColumns = {
  inventory: ['Item', 'Category', 'Location', 'On Hand', 'Unit', 'UOM Config', 'Stock Value'],
  sales: ['Date', 'Time', 'Sale / Refund', 'Item Name', 'Qty Sold', 'Total Impact', 'Location'],
  invoices: ['Date', 'Time', 'Supplier', 'Invoice', 'Location', 'Items', 'Total Ex'],
  stock: ['Item', 'Category', 'Location', 'On Hand', 'Unit', 'UOM Config', 'Stock Value'],
  menu: ['Menu Item', 'Category', 'Selling Price', 'Recipe Cost', 'GP %'],
  purchase_orders: ['Date', 'Time', 'Supplier', 'Reference', 'Status', 'Location', 'Total Ex', 'User'],
  grv: ['Date', 'Time', 'Supplier', 'Invoice', 'Location', 'Items', 'Total Ex', 'User'],
  cn: ['Date', 'Time', 'Supplier', 'Reference', 'Location', 'Items', 'Total Ex', 'User'],
  adj: ['Date', 'Time', 'User', 'Item', 'Category', 'Location', 'Mode', 'Quantity', 'Impact Ex'],
  transfers: ['Date', 'Time', 'User', 'Item', 'From', 'To', 'Quantity', 'Unit'],
  yoco_sales: ['Date', 'Time', 'Sale / Refund', 'Item Name', 'Qty Sold', 'Total Impact', 'Location'],
  modifier_gp_detail: ['Date', 'Main Product Sold', 'Modifier Combination', 'Qty Sold', 'Main Product Selling', 'Modifier Selling', 'Total Selling', 'Total Cost', 'GP Main %', 'GP Combined %', 'Additional GP %'],
  modifier_gp_summary: ['Date', 'Sale ID / Order ID', 'Main Product Sold', 'Modifier Item', 'Modifier Category', 'Qty Sold', 'Modifier Selling', 'Modifier Cost', 'Modifier GP', 'Modifier GP %', 'Status']
};

export const customReportSources = [
  { id: 'inventory', label: 'Inventory / Stock', reportId: 'stock', group: 'Core Tables', defaultColumns: customReportDefaultColumns.inventory },
  { id: 'sales', label: 'Sales', reportId: 'yoco_sales', group: 'Core Tables', defaultColumns: customReportDefaultColumns.sales },
  { id: 'invoices', label: 'Invoices / GRVs', reportId: 'grv', group: 'Core Tables', defaultColumns: customReportDefaultColumns.invoices },
  ...reportCatalog
    .filter((report) => report.id !== 'custom_report')
    .map((report) => ({
      id: report.id,
      label: report.title,
      reportId: report.id,
      group: report.group,
      defaultColumns: customReportDefaultColumns[report.id] || report.columns.slice(0, 6)
    })),
  { id: 'suppliers', label: 'Suppliers', reportId: 'suppliers', group: 'Operations', defaultColumns: ['Supplier', 'Contact', 'Email', 'Phone', 'GRVs', 'Spend Ex'] }
];

export function subscribeAnalyticsWorkspace(workspaceId, { onSnapshot, onError } = {}) {
  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace id is required for analytics.');

  let closed = false;

  const load = async () => {
    try {
      // Fetch the reporting source and the workspace team in parallel. The team is
      // used to resolve actor uids → readable names/emails (e.g. Inventory Change
      // Audit). A team-fetch failure must not block the reports, so it defaults to [].
      const [rawSource, accessResponse] = await Promise.all([
        getDashboardSourceOnce(workspaceKey),
        callCloudflareWorkspaceRoute(workspaceKey, 'access-management').catch(() => ({ team: [] }))
      ]);
      const source = normalizeAnalyticsSource({
        ...rawSource,
        team: accessResponse?.team || accessResponse?.members || accessResponse?.users || []
      });
      if (closed) return;
      onSnapshot?.({
        status: 'ready',
        source,
        loaded: Object.fromEntries(analyticsNodes.map((node) => [node.key, true])),
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      if (!closed) onError?.(error, 'live:analytics');
    }
  };

  load();

  return () => {
    closed = true;
  };
}

export function buildAnalyticsReport(source = {}, reportId = 'stock', filters = {}) {
  const normalized = normalizeAnalyticsSource(source);
  const context = buildContext(normalized, filters);
  if (reportId === 'custom_report') {
    return buildCustomAnalyticsReport(normalized, context, filters);
  }
  const rows = sortReportRows(reportId, buildRows(reportId, normalized, context));
  const columns = reportCatalog.find((report) => report.id === reportId)?.columns || [];
  const summary = buildReportSummary(reportId, rows, normalized, context);
  return {
    report: reportCatalog.find((report) => report.id === reportId) || reportCatalog[0],
    columns,
    rows,
    summary
  };
}

export function normalizeAnalyticsSource(source = {}) {
  const ingredients = normalizeIngredients(source.ingredients);
  const settings = source.settings || {};
  const resetAt = getTimestamp(settings.reportingResetAt || settings.reporting_reset_at || '');
  return {
    settings,
    sites: toArray(source.sites),
    locations: normalizeStockLocations(source.locations, source.sites, settings),
    ingredients,
    products: normalizeProducts(source.products),
    suppliers: normalizeSuppliers(source.suppliers),
    purchaseOrders: toArray(source.purchaseOrders),
    logs_grv: filterRowsAfterReset(source.logs_grv, resetAt),
    logs_cn: filterRowsAfterReset(source.logs_cn, resetAt),
    logs_adj: normalizeAdjustmentLogs(filterRowsAfterReset(source.logs_adj, resetAt)),
    logs_stocktakes: filterRowsAfterReset(source.logs_stocktakes, resetAt),
    logs_inventory_audit: filterRowsAfterReset(source.logs_inventory_audit, resetAt),
    logs_mfg: normalizeManufacturingLogs(filterRowsAfterReset(source.logs_mfg, resetAt)),
    logs_transfers: filterRowsAfterReset(source.logs_transfers, resetAt),
    logs_sales: filterRowsAfterReset(source.logs_sales, resetAt),
    logs_sales_errors: filterRowsAfterReset(source.logs_sales_errors, resetAt),
    logs_snapshots: filterRowsAfterReset(source.logs_snapshots, resetAt),
    dashboardMetrics: resetAt ? {} : source.dashboardMetrics || {},
    team: toArray(source.team)
  };
}

function filterRowsAfterReset(value, resetAt = 0) {
  const rows = toArray(value);
  if (!resetAt) return rows;
  // Use createdAt first so backdated entries created after the reset are not excluded
  return rows.filter((row) => getTimestamp(row.createdAt || row.updatedAt || row.modifiedAt || row.timestamp || row.date || row.tradeDate) >= resetAt);
}

function buildRows(reportId, source, context) {
  const builders = {
    stock: buildStockRows,
    movement: buildMovementRows,
    low_stock: buildLowStockRows,
    grv: buildGrvRows,
    cn: buildCreditNoteRows,
    purchase_orders: buildPurchaseOrderRows,
    sale_movement: buildSaleMovementRows,
    menu: buildMenuRows,
    missing_recipes: buildMissingRecipeRows,
    adj: buildAdjustmentRows,
    stocktake: buildStockTakeRows,
    inventory_audit: buildInventoryAuditRows,
    mfg: buildManufacturingRows,
    transfers: buildTransferRows,
    ops_overview: buildOpsOverviewRows,
    ops_category_overview: buildOpsCategoryOverviewRows,
    ops_category_detail: buildOpsCategoryDetailRows,
    ops_dashboard: buildOpsDashboardRows,
    sync_log: buildSyncLogRows,
    sales_error_log: buildSalesErrorRows,
    activity_log: buildActivityRows,
    payments: buildPaymentRows,
    modifier_gp_detail: buildModifierGpDetailRows,
    modifier_gp_summary: buildModifierGpSummaryRows,
    forecast: buildForecastRows,
    volatility: buildVolatilityRows,
    variance: buildVarianceRows,
    waste_pareto: buildWasteParetoRows,
    yoco_sales: buildYocoSalesRows
  };
  return (builders[reportId] || buildStockRows)(source, context);
}

function buildCustomAnalyticsReport(source, context, filters = {}) {
  const sourceConfig = customReportSourceFor(filters.customSource);
  const availableColumns = customReportColumns(sourceConfig);
  const selectedColumns = normalizeCustomColumns(filters.customColumns, availableColumns, sourceConfig.defaultColumns);
  const visualizationType = String(filters.visualizationType || 'table').trim() || 'table';
  const groupBy = String(filters.groupBy || 'none').trim() || 'none';
  const baseReportId = sourceConfig.reportId || sourceConfig.id;
  const rowsBySource = buildCustomReportRowsBySource(source, context);
  const columnsBySource = Object.fromEntries(customReportSources.map((item) => [item.id, customReportColumns(item)]));
  const baseRows = sourceConfig.id === 'suppliers'
    ? rowsBySource.suppliers || []
    : sortReportRows(baseReportId, buildRows(baseReportId, source, context));
  const rows = baseRows.map((row) => {
    const projected = {};
    selectedColumns.forEach((column) => {
      projected[column] = row[column] ?? '';
    });
    return projected;
  });
  const stockValue = calculateDashboardMetrics(source, context.endDate).summary?.stockValue?.value || currency(0);
  const report = reportCatalog.find((item) => item.id === 'custom_report') || reportCatalog[0];

  return {
    report: {
      ...report,
      description: `Custom ${sourceConfig.label.toLowerCase()} report with ${selectedColumns.length} selected column${selectedColumns.length === 1 ? '' : 's'}.`
    },
    columns: selectedColumns,
    rows,
    summary: [
      { label: 'Rows', value: String(rows.length) },
      { label: 'Data Source', value: sourceConfig.label },
      { label: 'Columns', value: String(selectedColumns.length) },
      { label: 'Stock Value', value: stockValue }
    ],
    custom: {
      sourceId: sourceConfig.id,
      sourceLabel: sourceConfig.label,
      sourceOptions: customReportSources,
      availableColumns,
      selectedColumns,
      defaultColumns: sourceConfig.defaultColumns || availableColumns.slice(0, 6),
      rowsBySource,
      columnsBySource,
      visualizationType,
      groupBy
    },
    filters
  };
}

function buildCustomReportRowsBySource(source, context) {
  return Object.fromEntries(customReportSources.map((sourceConfig) => {
    const reportId = sourceConfig.reportId || sourceConfig.id;
    const rows = sourceConfig.id === 'suppliers'
      ? buildSupplierRows(source, context)
      : sortReportRows(reportId, buildRows(reportId, source, context));
    return [sourceConfig.id, rows];
  }));
}

function customReportSourceFor(sourceId = '') {
  return customReportSources.find((item) => item.id === sourceId) || customReportSources[0];
}

function customReportColumns(sourceConfig = {}) {
  if (sourceConfig.id === 'suppliers') {
    return ['Supplier', 'Contact', 'Email', 'Phone', 'Status', 'GRVs', 'Spend Ex', 'Last GRV'];
  }
  return reportCatalog.find((report) => report.id === sourceConfig.reportId)?.columns || [];
}

function normalizeCustomColumns(value, availableColumns = [], defaultColumns = []) {
  const requested = Array.isArray(value)
    ? value
    : String(value || '').split('|');
  const selected = requested
    .map((column) => String(column || '').trim())
    .filter((column) => availableColumns.includes(column));
  if (selected.length) return [...new Set(selected)];

  const defaults = (defaultColumns || []).filter((column) => availableColumns.includes(column));
  return defaults.length ? defaults : availableColumns.slice(0, Math.min(6, availableColumns.length));
}

function buildContext(source, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const today = getTradeDateKey(new Date(), source.settings);
  const endDate = filters.endDate || today;
  // Waste Pareto defaults to a 7-day window to match the Dashboard's default snapshot,
  // so the Wastage report, tile, and graph show the same number out of the box. Other
  // reports keep the 30-day analytical default.
  const defaultWindowDays = String(filters.reportId || '') === 'waste_pareto' ? 6 : 29;
  const startDate = filters.startDate || addDays(endDate, -defaultWindowDays);
  const locations = source.locations || [];
  const locationIds = new Set(locations.map((item) => String(item.id || '').trim()).filter(Boolean));
  const defaultLocation = findDefaultStockLocation(locations);
  const categories = new Set(source.ingredients.map((item) => String(item.category || 'General').trim()).filter(Boolean));
  const requestedCategory = String(filters.category || '').trim();
  const requestedLocationId = String(filters.locationId || '').trim();
  // Resolve the requested location to a canonical id, tolerating name/legacy/normalized
  // matches — an exact-id-only check silently dropped valid location filters.
  const resolvedLocationId = requestedLocationId
    ? (locationIds.has(requestedLocationId)
      ? requestedLocationId
      : (locations.find((loc) => [loc.id, loc.locationId, loc.name, loc.displayName, loc.label, loc.yocoLocationId]
          .some((value) => normalizeLocationKey(value) === normalizeLocationKey(requestedLocationId)))?.id || ''))
    : '';
  return {
    query,
    startDate,
    endDate,
    category: categories.has(requestedCategory) ? requestedCategory : '',
    locationId: resolvedLocationId,
    ingredientMap: new Map(source.ingredients.map((item) => [String(item.id), item])),
    productMap: new Map(source.products.map((item) => [String(item.id), item])),
    productByYocoVariantId: new Map(source.products.filter((item) => item.yocoVariantId).map((item) => [String(item.yocoVariantId), item])),
    productByYocoItemId: new Map(source.products.filter((item) => item.yocoItemId && !item.yocoVariantId).map((item) => [String(item.yocoItemId), item])),
    productByName: new Map(source.products.map((item) => [String(item.name || '').trim().toLowerCase(), item])),
    locations,
    locationIds,
    defaultLocationId: defaultLocation?.id || DEFAULT_STOCK_LOCATION_ID,
    defaultLocationName: defaultLocation?.displayName || defaultLocation?.name || DEFAULT_STOCK_LOCATION_NAME,
    // Key by every id form a movement/transfer/audit row might store, so id→name
    // resolution never misses and leaks a raw id. First writer wins per key.
    locationMap: (() => {
      const map = new Map();
      locations.forEach((item) => {
        [item.id, item.locationId, item.legacySourceId, item.legacy_source_id,
         item.externalLocationId, item.external_location_id, item.yocoLocationId]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .forEach((key) => { if (!map.has(key)) map.set(key, item); });
      });
      return map;
    })(),
    menuGpFilter: String(filters.menuGpFilter || '').trim(),
    forecastHorizon: Math.max(1, Number(filters.forecastHorizon || 14) || 14),
    // Resolve actor uids/emails → readable { name, email } for audit/activity reports.
    userMap: buildUserMap(source.team)
  };
}

// Map every id form a log's actor field might carry (auth uid, member id, email)
// to a readable { name, email } so reports never surface a raw UUID.
function buildUserMap(team = []) {
  const map = new Map();
  toArray(team).forEach((member) => {
    const name = String(member.displayName || member.display_name || member.name || member.fullName || '').trim();
    const email = String(member.email || member.userEmail || '').trim();
    const entry = { name, email };
    [member.authUid, member.auth_uid, member.uid, member.id, member.memberId, member.userId, email]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .forEach((key) => { if (!map.has(key)) map.set(key, entry); });
  });
  return map;
}

// Origin channel of an audit event (Yoco, Import, Manual, …) — never a raw uid.
function auditSourceLabel(log = {}) {
  const raw = String(log.source || '').trim();
  // A uid-looking source (long, no spaces, not a known channel word) is an actor,
  // not a channel → present it as a manual (user) action.
  const looksLikeUid = raw && !raw.includes(' ') && /[_-]/.test(raw) && raw.length > 16;
  if (raw && !looksLikeUid) return titleCase(raw);
  return log.actorUid || log.actor_uid || log.createdBy ? 'Manual' : 'System';
}

// Readable actor label from any id/email a log carries. Prefers name, then email,
// then a generic system label — never a raw uid.
function resolveUserLabel(context, ...candidates) {
  const map = context?.userMap;
  for (const candidate of candidates) {
    const key = String(candidate || '').trim();
    if (!key) continue;
    const hit = map?.get(key);
    if (hit && (hit.name || hit.email)) return hit.name || hit.email;
    if (key.includes('@')) return key;
  }
  return 'System';
}

// Stock On Hand should list only physically stock-tracked inventory. Exclude
// sub-recipes/virtual items. Non-stock items may still carry stock on hand and
// should remain visible in stock/count reporting.
function isStockOnHandItem(item = {}) {
  const explicit = String(item.itemType || item.stockItemType || item.specificationType || '')
    .trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['recipe_source', 'non_stock'].includes(explicit)) return true;
  if (item.isStocked === false || item.is_stocked === false || Number(item.is_stocked) === 0) return false;
  if (['virtual', 'sub_recipe', 'subrecipe'].includes(explicit)) return false;
  if (item.isSubRecipe === true) return false;
  const category = String(item.category || '').toLowerCase();
  if (category.includes('recipe source') || category.includes('non-stock') || category.includes('non stock')) return true;
  if (category.includes('virtual') || category.includes('sub recipe') || category.includes('sub-recipe')) return false;
  return true;
}

function buildStockRows(source, context) {
  return source.ingredients
    .filter(isStockOnHandItem)
    .flatMap((item) => (
      reportLocationBalances(item, context).map(({ locationId, qty }) => {
        const unitCost = Number(item.cost || 0);
        const stockValue = Number(qty || 0) * unitCost;
        return {
          Item: item.name,
          Category: item.category || 'General',
          Location: locationName(context, locationId, context.defaultLocationName || DEFAULT_STOCK_LOCATION_NAME),
          'On Hand': number(qty),
          Unit: item.unit || '',
          'UOM Config': formatReportUomConfigurations(item),
          ...reportUomConfigurationColumns(item),
          'Unit Cost': item.costMissing ? 'Cost unavailable' : currency(unitCost),
          'Stock Value': currency(stockValue),
          _stockItemId: item.id || item.stockItemId || '',
          _locationId: locationId || '',
          _unit: item.unit || '',
          _unitCost: unitCost,
          _num: { onHand: Number(qty || 0), unitCost, stockValue },
          _costMissing: !!item.costMissing,
          _sort: item.name
        };
      })
    ))
    .filter((row) => passesCommon(row, context))
    .sort(sortBy('_sort'));
}

function reportUomConfigurationColumns(item = {}) {
  const configs = normalizeReportUomConfigurationRows(item).slice(0, 3);
  return [0, 1, 2].reduce((columns, index) => {
    const config = configs[index] || {};
    columns[`UOM ${index + 1} Name`] = config.customUom || '';
    columns[`UOM ${index + 1} Ratio`] = config.ratio ? number(config.ratio) : '';
    columns[`UOM ${index + 1} Barcode`] = config.barcode || '';
    return columns;
  }, {});
}

function formatReportUomConfigurations(item = {}) {
  return normalizeReportUomConfigurationRows(item)
    .map((entry) => `${entry.customUom} = ${number(entry.ratio)} ${entry.baseUom}`)
    .filter(Boolean)
    .slice(0, 3)
    .join('; ');
}

function normalizeReportUomConfigurationRows(item = {}) {
  const baseFallback = String(item.unit || item.uom || '').trim();
  const source = item.uomConfigurations || item.uomConfig || item.uomConversions;
  const rows = Array.isArray(source)
    ? source
    : (source && typeof source === 'object' ? [source] : []);
  return rows
    .map((entry = {}) => {
      const row = entry && typeof entry === 'object' ? entry : {};
      const customUom = String(row.customUom || row.custom_uom || row.customUnit || row.orderingUom || '').trim();
      const ratio = Number(row.ratio ?? row.conversionRatio ?? row.unitsPerCustomUnit ?? row.units_per_custom_unit ?? 0) || 0;
      const baseUom = String(row.baseUom || row.base_uom || row.baseUnit || baseFallback).trim();
      const barcode = String(row.barcode || row.barcodes || row.scanCode || '').trim();
      if (!customUom || ratio <= 0) return null;
      return { customUom, ratio, baseUom: baseUom || baseFallback, barcode };
    })
    .filter(Boolean)
    .slice(0, 3);
}

function buildMovementRows(source, context) {
  const map = new Map(source.ingredients.map((item) => [String(item.id), {
    item,
    purchases: 0,
    sales: 0,
    manufactured: 0,
    wastage: 0,
    adjustments: 0,
    transfers: 0
  }]));

  source.logs_grv.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    toArray(log.items).forEach((line) => {
      if (!matchesLocationId(context, lineLocationId(line, log))) return;
      addMovement(map, line.itemId || line.stockItemId || line.id, 'purchases', qty(line));
    });
  });
  source.logs_sales.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    saleMovementLines(log).forEach((line) => {
      if (!matchesLocationId(context, lineLocationId(line, log))) return;
      addMovement(map, stockMovementItemId(line), 'sales', saleUsageQty(line, log));
    });
  });
  source.logs_adj.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    if (!matchesLocationId(context, logLocationId(log))) return;
    const id = log.stockItemId || log.itemId;
    // Wastage vs manual adjustment uses the same classifier as the metrics: a plain
    // 'remove' or a negative delta is a manual adjustment (signed), not wastage.
    if (isWastageAdjustmentLog(log)) addMovement(map, id, 'wastage', Math.abs(Number(log.impactQty || log.qty || 0)));
    else addMovement(map, id, 'adjustments', Number(log.impactQty || log.qty || 0));
  });
  source.logs_mfg.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    if (!matchesLocationId(context, logLocationId(log))) return;
    toArray(log.components || log.recipe || log.items).forEach((line) => addMovement(map, line.ingId || line.itemId || line.stockItemId, 'sales', Math.abs(qty(line))));
    addMovement(map, log.itemId || log.stockItemId || log.manufacturedItemId, 'manufactured', Number(log.producedQty || log.actualQty || log.qty || 0));
    const shortfallQty = getManufacturingShortfallQty(log);
    if (shortfallQty > 0) addMovement(map, log.itemId || log.stockItemId || log.manufacturedItemId, 'wastage', shortfallQty);
  });
  source.logs_transfers.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    const fromId = transferFromId(log);
    const toId = transferToId(log);
    if (!context.locationId) return;
    toArray(log.items).forEach((line) => {
      const id = line.stockItemId || line.itemId || line.id;
      const quantity = Math.abs(qty(line));
      if (matchesLocationId(context, fromId)) addMovement(map, id, 'transfers', -quantity);
      if (matchesLocationId(context, toId)) addMovement(map, id, 'transfers', quantity);
    });
  });

  return [...map.values()]
    // Only physically stock-tracked items move as stock. Sub-recipes/non-stocked
    // items are consumed via their exploded base ingredients (added above), so they
    // must not also appear as their own movement rows (double counting).
    .filter(({ item }) => isStockOnHandItem(item))
    .map(({ item, purchases, sales, manufactured, wastage, adjustments, transfers }) => ({
      Item: item.name,
      Category: item.category || 'General',
      Unit: item.unit || item.uom || '',
      Purchases: number(purchases),
      'Sales Usage': number(sales),
      Manufactured: number(manufactured),
      Wastage: number(wastage),
      Adjustments: number(adjustments),
      'Transfers Net': number(transfers),
      'Net Qty': number(purchases - sales + manufactured - wastage + adjustments + transfers),
      _unit: item.unit || item.uom || '',
      _sort: item.name
    }))
    .filter((row) => passesCommon(row, context))
    .filter((row) => ['Purchases', 'Sales Usage', 'Manufactured', 'Wastage', 'Adjustments', 'Transfers Net'].some((key) => Number(row[key]) !== 0) || context.query)
    .sort(sortBy('_sort'));
}

function buildLowStockRows(source, context) {
  return source.ingredients.flatMap((item) => {
    if (isArchived(item)) return [];
    if (!isLowStockEligibleItem(item)) return [];
    const threshold = resolveLowStockThreshold(item);
    return reportLowStockLocationBalances(item, context).map(({ locationId, qty: stock }) => {
      const variance = Number(stock || 0) - threshold;
      return {
        _id: item.id || item.stockItemId || item.name,
        _locationId: locationId,
        Item: item.name,
        Category: item.category || 'General',
        Unit: item.unit || item.uom || '',
        Location: locationName(context, locationId, DEFAULT_STOCK_LOCATION_NAME || 'Main Store'),
        'Current Stock': number(stock),
        Threshold: number(threshold),
        Variance: number(variance),
        'Deficit Value': currency(Math.max(0, -variance) * Number(item.cost || 0)),
        Unit: item.unit || item.uom || '',
        _unit: item.unit || item.uom || '',
        _low: variance < 0,
        _sort: variance
      };
    });
  }).filter((row) => passesCommon(row, context)).sort((a, b) => a._sort - b._sort);
}

function buildGrvRows(source, context) {
  return source.logs_grv.filter((log) => inDateRange(logDate(log), context)).map((log) => ({
    _detailId: log.id || log.grvNumber || log.invoice,
    _raw: log,
    Date: displayDate(logDate(log)),
    Time: displayTime(reportTimestamp(log)),
    Supplier: log.supplier || log.supplierName || 'Manual Receipt',
    Invoice: log.invoice || log.grvNumber || log.id || '',
    Location: log.locationName || locationName(context, logLocationId(log), 'Multiple'),
    Items: String(toArray(log.items).length),
    'Total Ex': currency(log.totalEx ?? sumItems(log.items, 'lineTotalEx')),
    User: resolveReportActor(context, log),
    Action: 'View',
    _search: `${log.supplier || ''} ${log.invoice || ''}`
  })).filter((row) => passesReportFilters(row, context));
}

function buildCreditNoteRows(source, context) {
  return source.logs_cn.filter((log) => inDateRange(logDate(log), context)).map((log) => ({
    _detailId: log.id || log.cnNumber || log.creditNoteNumber || log.reference || log.number || log.invoice,
    _raw: log,
    Date: displayDate(logDate(log)),
    Time: displayTime(reportTimestamp(log)),
    Supplier: log.supplier || log.supplierName || '',
    Reference: log.reference || log.creditNoteNumber || log.cnNumber || log.number || log.invoice || log.id || '',
    Location: log.locationName || locationName(context, logLocationId(log), 'Multiple'),
    Items: String(toArray(log.items).length),
    'Total Ex': currency(reportTotalEx(log)),
    User: resolveReportActor(context, log),
    Action: 'View',
    _search: `${log.supplier || ''} ${log.reference || ''}`
  })).filter((row) => passesReportFilters(row, context));
}

function buildPurchaseOrderRows(source, context) {
  return source.purchaseOrders.filter((order) => inDateRange(logDate(order), context)).map((order) => {
    const orderId = String(order.id || '').trim();
    const reference = order.reference || order.poNumber || order.id || '';
    const grvsForOrder = source.logs_grv.filter((log) => {
      const sourcePoId = String(log.sourcePoId || log.purchaseOrderId || log.poId || '').trim();
      const poNumber = String(log.poNumber || log.purchaseOrderNumber || '').trim();
      return (orderId && sourcePoId === orderId) || (reference && poNumber === String(reference));
    });
    return {
      _detailId: orderId || reference,
      _raw: order,
      _grvs: grvsForOrder,
      Date: displayDate(logDate(order)),
      Time: displayTime(reportTimestamp(order)),
      Supplier: order.supplierName || order.supplier || '',
      Reference: reference,
      Status: order.status || 'draft',
      Location: order.targetLocationName || locationName(context, order.targetLocation || order.locationId, 'Main Store'),
      Items: String(toArray(order.items).length),
      'Total Ex': currency(order.totalEx ?? sumItems(order.items)),
      User: resolveReportActor(context, order),
      Action: 'View',
      _search: `${order.supplierName || ''} ${reference}`
    };
  }).filter((row) => passesReportFilters(row, context));
}

function reportActor(log = {}) {
  const candidates = [
    log.createdByName,
    log.submittedByName,
    log.savedByName,
    log.userName,
    log.displayName,
    log.createdByEmail,
    log.userEmail,
    log.user
  ];
  const resolved = candidates
    .map((value) => String(value || '').trim())
    .find((value) => value && !['system', 'manual'].includes(value.toLowerCase()));
  return resolved || '';
}

function resolveReportActor(context, log = {}, fallback = '') {
  const explicit = reportActor(log);
  if (explicit) return explicit;
  return resolveUserLabel(
    context,
    log.createdBy,
    log.created_by,
    log.actorUid,
    log.actor_uid,
    log.userId,
    log.savedByUserId,
    log.postedBy,
    log.submittedBy,
    log.userEmail,
    log.createdByEmail
  ) || fallback;
}

function buildSupplierRows(source, context) {
  const supplierStats = new Map();
  source.logs_grv.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    const supplierName = String(log.supplier || log.supplierName || '').trim();
    if (!supplierName) return;
    const key = supplierName.toLowerCase();
    const current = supplierStats.get(key) || { grvs: 0, spend: 0, lastGrv: '' };
    const date = logDate(log);
    const totalEx = log.totalEx ?? sumItems(log.items, 'lineTotalEx');
    current.grvs += 1;
    current.spend += Number(totalEx || 0);
    current.lastGrv = !current.lastGrv || date > current.lastGrv ? date : current.lastGrv;
    supplierStats.set(key, current);
  });

  return source.suppliers.map((supplier) => {
    const name = supplier.name || supplier.supplierName || '';
    const stats = supplierStats.get(String(name).trim().toLowerCase()) || { grvs: 0, spend: 0, lastGrv: '' };
    return {
      Supplier: name,
      Contact: supplier.contact || supplier.contactName || supplier.rep || '',
      Email: supplier.email || supplier.emailAddress || '',
      Phone: supplier.phone || supplier.phoneNumber || supplier.mobile || '',
      Status: supplier.active === false || supplier.archived === true ? 'Inactive' : 'Active',
      GRVs: String(stats.grvs),
      'Spend Ex': currency(stats.spend),
      'Last GRV': stats.lastGrv || '',
      _sort: name
    };
  }).filter((row) => passesSearch(row, context)).sort(sortBy('_sort'));
}

function buildSaleMovementRows(source, context) {
  return source.logs_sales.flatMap((log) => {
    const productName = log.productName || log.itemName || log.name || 'Sale';
    const movementLines = saleMovementLines(log).filter((line) => {
      const date = saleLineDate(line, log);
      return inDateRange(date, context) && matchesLocationId(context, lineLocationId(line, log));
    });
    const allSaleRows = saleLineRows(log).filter((line) => {
      const date = saleLineDate(line, log);
      return inDateRange(date, context) && matchesLocationId(context, lineLocationId(line, log));
    });
    const saleRows = allSaleRows.filter((line) => !isModifierSaleLine(line));
    const displaySaleRows = saleRows.length ? saleRows : allSaleRows;

    if (displaySaleRows.length) {
      return displaySaleRows.map((line, index) => {
        const date = saleLineDate(line, log);
        const matchingMovements = movementLines.filter((movement) => saleMovementMatchesSaleLine(line, movement, log, displaySaleRows));
        return buildSaleMovementSummaryRow({
          log,
          line,
          movements: matchingMovements,
          context,
          productName,
          date,
          index
        });
      });
    }

    const groupedMovements = movementLines.reduce((map, line) => {
      const key = saleProductKey(line, log) || `${line.productName || line.pname || productName}::${lineLocationId(line, log)}`;
      const group = map.get(key) || [];
      group.push(line);
      map.set(key, group);
      return map;
    }, new Map());

    return [...groupedMovements.values()].map((group, index) => {
      const line = group[0] || {};
      const date = saleLineDate(line, log);
      return buildSaleMovementSummaryRow({ log, line, movements: group, context, productName, date, index });
    });
  })
    .filter((row) => passesReportFilters(row, context))
    .sort((a, b) => String(b._sortDate || '').localeCompare(String(a._sortDate || '')));
}

function buildSaleMovementSummaryRow({ log = {}, line = {}, movements = [], context, productName = 'Sale', date = '', index = 0 } = {}) {
  const product = resolveProductForLine(line, log, context);
  const productLabel = line.productName || line.pname || line.name || log.productName || productName;
  const locationId = lineLocationId(line, log);
  const location = line.locationName || log.locationName || locationName(context, locationId, '');
  const soldQty = saleSoldQty(line) || Number(log.qtySold ?? log.quantity ?? log.qty ?? 0) || 0;
  const ingredientLines = movements.map((movement) => saleMovementDetailLine(movement, log, context));
  const totalDepleted = ingredientLines.reduce((sum, detail) => sum + Number(detail._qty || 0), 0);
  const cogs = ingredientLines.reduce((sum, detail) => sum + Number(detail._impact || 0), 0);
  const detailId = [
    log.id || log.orderId || log.yocoOrderId || log.reference || log.timestamp || date,
    saleProductKey(line, log) || productLabel,
    locationId || location,
    index
  ].map((part) => String(part || '').trim()).join('::');

  return {
    Date: displayDate(date || logDate(log)),
    Time: displayTime(line.timestamp || line.saleTimestamp || log.timestamp || log.createdAt || date || logDate(log)),
    Product: productLabel,
    'Product Status': productStatusLabel(product),
    Location: location,
    'Qty Sold': soldQty ? saleSoldLabel({ ...line, qty: soldQty }, log) : number(0),
    'Recipe Lines': String(ingredientLines.length),
    'Qty Depleted': number(totalDepleted),
    'COGS Ex': currency(cogs),
    Action: 'View',
    _detailId: detailId,
    _unit: line.unit || line.uom || 'ea',
    _sortDate: line.timestamp || line.saleTimestamp || log.timestamp || log.createdAt || date,
    _raw: log,
    _saleLine: line,
    _recipeLines: ingredientLines
  };
}

function saleMovementMatchesSaleLine(line = {}, movement = {}, log = {}, saleRows = []) {
  const lineIds = [
    line.saleLineKey,
    line.id,
    line.yocoLineId
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const movementParentIds = [
    movement.parentLineId,
    movement.kcpParentLineId
  ].map((value) => String(value || '').trim()).filter(Boolean);
  if (lineIds.some((id) => movementParentIds.includes(id))) return true;

  const lineProductIds = [
    line.productId,
    line.productID,
    line.menuItemId,
    line.itemId
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const movementParentProductIds = [
    movement.parentProductId,
    movement.kcpParentProductId
  ].map((value) => String(value || '').trim()).filter(Boolean);
  if (lineProductIds.some((id) => movementParentProductIds.includes(id))) return true;

  const lineProductName = String(line.productName || line.pname || line.name || '').trim().toLowerCase();
  const movementParentName = String(movement.parentProductName || movement.parentName || '').trim().toLowerCase();
  if (lineProductName && movementParentName && lineProductName === movementParentName) return true;

  const lineKey = saleProductKey(line, log);
  const movementKey = saleProductKey(movement, log);
  if (movementKey && lineKey && movementKey === lineKey) return true;

  return saleRows.length === 1 && !movementParentIds.length && !movementParentProductIds.length && !movementKey;
}

function buildModifierGpDetailRows(source, context) {
  return source.logs_sales.flatMap((log) => buildModifierGpCombinationRows(log, context))
    .filter((row) => passesReportFilters(row, context))
    .sort((a, b) => String(b._sortDate || '').localeCompare(String(a._sortDate || '')));
}

function buildModifierGpCombinationRows(log = {}, context = {}) {
  const saleRows = saleLineRows(log).filter((line) => {
    const date = saleLineDate(line, log);
    return inDateRange(date, context) && matchesLocationId(context, lineLocationId(line, log));
  });
  const mainRows = saleRows.filter((line) => !isModifierSaleLine(line));
  const modifierRows = saleRows.filter(isModifierSaleLine);
  const movementLines = saleMovementLines(log).filter((movement) => {
    const date = saleLineDate(movement, log);
    return inDateRange(date, context) && matchesLocationId(context, lineLocationId(movement, log));
  });

  const usedModifiers = new Set();
  const matchedMainRows = mainRows.map((line, index) => {
    const matchedModifiers = modifierRows.filter((modifier) => modifierLineBelongsToMainLine(modifier, line, log));
    const modifiers = matchedModifiers.length || mainRows.length !== 1 ? matchedModifiers : modifierRows;
    modifiers.forEach((modifier) => usedModifiers.add(modifier));
    return buildModifierGpCombinationRow({ log, line, modifiers, movementLines, context, index });
  }).filter(Boolean);

  const orphanModifierGroups = new Map();
  modifierRows
    .filter((modifier) => !usedModifiers.has(modifier))
    .forEach((modifier, index) => {
      const key = modifierParentLineKey(modifier) || `unmatched-${modifierLineSummaryKey(modifier)}-${index}`;
      const group = orphanModifierGroups.get(key) || [];
      group.push(modifier);
      orphanModifierGroups.set(key, group);
    });
  const orphanRows = [...orphanModifierGroups.values()].map((modifiers, index) => {
    const line = syntheticMainLineForModifiers(modifiers, log);
    return buildModifierGpCombinationRow({
      log,
      line,
      modifiers,
      movementLines,
      context,
      index: matchedMainRows.length + index
    });
  }).filter(Boolean);

  return [...matchedMainRows, ...orphanRows];
}

function buildModifierGpCombinationRow({ log = {}, line = {}, modifiers = [], movementLines = [], context = {}, index = 0 } = {}) {
  const date = saleLineDate(line, log);
  const locationId = lineLocationId(line, log);
  const location = line.locationName || log.locationName || locationName(context, locationId, 'Unassigned Location');
  const product = resolveProductForLine(line, log, context);
  const mainProduct = line.productName || line.pname || line.name || log.productName || product?.name || 'Sale item';
  const qtySold = Math.abs(saleSoldQty(line));
  const mainSales = Math.abs(saleLineSalesValue(line));
  const mainMovements = movementLines.filter((movement) => {
    const componentType = String(movement.componentType || movement.kcpComponentType || '').trim().toLowerCase();
    return componentType !== 'modifier' && saleMovementMatchesSaleLine(line, movement, log, [line]);
  });
  const movementCost = saleMovementCost(mainMovements, context.ingredientMap);
  const mainCost = movementCost || (product ? recipeCost(product, context.ingredientMap) * qtySold : Math.abs(saleLineCostImpact(line, log, context.ingredientMap)));
  const modifierItems = modifiers.map((modifier, modifierIndex) => {
    const modifierMovements = movementLines.filter((movement) => modifierMovementMatches(modifier, movement, log));
    const modifierProduct = resolveProductForLine(modifier, log, context);
    const modifierQty = Math.abs(saleSoldQty(modifier));
    const modifierSales = Math.abs(saleLineSalesValue(modifier));
    const modifierCost = saleMovementCost(modifierMovements, context.ingredientMap) || (modifierProduct ? recipeCost(modifierProduct, context.ingredientMap) * modifierQty : 0);
    const modifierGp = modifierSales > 0 ? ((modifierSales - modifierCost) / modifierSales) * 100 : 0;
    return {
      name: modifierLineName(modifier),
      group: modifierLineGroup(modifier),
      qty: modifierQty,
      selling: modifierSales,
      cost: modifierCost,
      gp: modifierGp,
      key: [
        modifierLineSummaryKey(modifier),
        modifier.saleLineKey || modifier.id || modifier.yocoLineId || modifierIndex
      ].map((part) => String(part || '').trim().toLowerCase()).join('::')
    };
  });
  const modifierSales = modifierItems.reduce((sum, item) => sum + Number(item.selling || 0), 0);
  const modifierCost = modifierItems.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  const totalSales = mainSales + modifierSales;
  const totalCost = mainCost + modifierCost;
  const gpMain = mainSales > 0 ? ((mainSales - mainCost) / mainSales) * 100 : 0;
  const gpCombined = totalSales > 0 ? ((totalSales - totalCost) / totalSales) * 100 : gpMain;
  const additionalGp = gpCombined - gpMain;
  const modifierCombination = modifierItems.length
    ? modifierItems.map((item) => item.name).join(' + ')
    : 'No Modifier';
  const detailId = [
    log.id || log.orderId || log.yocoOrderId || log.reference || log.timestamp || date,
    line.saleLineKey || line.id || line.yocoLineId || saleProductKey(line, log) || mainProduct,
    modifierCombination,
    index
  ].map((part) => String(part || '').trim()).join('::');

  return {
    Date: displayDate(date || logDate(log)),
    Time: displayTime(line.timestamp || line.saleTimestamp || log.timestamp || log.createdAt || date || logDate(log)),
    'Main Product Sold': mainProduct,
    'Modifier Item': modifierItems.length ? modifierItems.map((item) => item.name).join(', ') : 'No Modifier',
    'Modifier Combination': modifierCombination,
    'Qty Sold': qtySold ? number(qtySold) : number(0),
    'Main Product Selling': currency(mainSales),
    'Modifier Selling': currency(modifierSales),
    'Main Selling Recipe Cost': currency(mainCost),
    'Modifier Cost': currency(modifierCost),
    'Total Selling': currency(totalSales),
    'Total Cost': currency(totalCost),
    'GP Main %': percent(gpMain),
    'GP Combined %': percent(gpCombined),
    'Additional GP %': signedPercent(additionalGp),
    Location: location,
    _detailId: detailId,
    _mainProduct: mainProduct,
    _mainProductKey: mainProduct.trim().toLowerCase(),
    _modifierCombination: modifierCombination,
    _modifierCombinationKey: modifierCombination.trim().toLowerCase(),
    _modifierItems: modifierItems,
    _mainSales: mainSales,
    _modifierSales: modifierSales,
    _totalSales: totalSales,
    _mainCost: mainCost,
    _modifierCost: modifierCost,
    _totalCost: totalCost,
    _gpMain: gpMain,
    _gpCombined: gpCombined,
    _additionalGp: additionalGp,
    _qtySold: qtySold,
    _orderId: log.orderId || log.yocoOrderId || log.id || '',
    _sortDate: line.timestamp || line.saleTimestamp || log.timestamp || log.createdAt || date,
    _raw: log,
    _saleLine: line
  };
}

function buildModifierGpSummaryRows(source, context) {
  return source.logs_sales.flatMap((log) => buildModifierGpSummaryDetailRows(log, context))
    .filter((row) => passesSearch(row, context))
    .sort((a, b) => String(b._sortDate || '').localeCompare(String(a._sortDate || '')) || String(a['Modifier Item'] || '').localeCompare(String(b['Modifier Item'] || '')));
}

function buildModifierGpSummaryDetailRows(log = {}, context = {}) {
  const saleRows = saleLineRows(log).filter((line) => {
    const date = saleLineDate(line, log);
    return inDateRange(date, context) && matchesLocationId(context, lineLocationId(line, log));
  });
  const mainRows = saleRows.filter((line) => !isModifierSaleLine(line));
  const modifierRows = saleRows.filter(isModifierSaleLine);
  const movementLines = saleMovementLines(log).filter((movement) => {
    const date = saleLineDate(movement, log);
    return inDateRange(date, context) && matchesLocationId(context, lineLocationId(movement, log));
  });

  return modifierRows.map((modifier, index) => {
    const parentLine = mainRows.find((line) => modifierLineBelongsToMainLine(modifier, line, log)) || {};
    const mainProduct = mainProductNameForModifier(modifier, parentLine, log);
    const locationId = lineLocationId(modifier, log) || lineLocationId(parentLine, log);
    const location = modifier.locationName || parentLine.locationName || log.locationName || locationName(context, locationId, 'Unassigned Location');
    const modifierMovements = movementLines.filter((movement) => modifierMovementMatches(modifier, movement, log));
    const modifierProduct = resolveProductForLine(modifier, log, context);
    const qty = Math.abs(saleSoldQty(modifier));
    const selling = Math.abs(saleLineSalesValue(modifier));
    const cost = saleMovementCost(modifierMovements, context.ingredientMap) || (modifierProduct ? recipeCost(modifierProduct, context.ingredientMap) * qty : 0);
    const gp = selling - cost;
    const gpPercent = selling > 0 ? (gp / selling) * 100 : null;
    const status = selling === 0 ? 'Zero-price modifier' : gp < 0 ? 'Negative GP' : 'Selling';
    const date = saleLineDate(modifier, log) || saleLineDate(parentLine, log) || logDate(log);
    const orderId = log.orderId || log.yocoOrderId || log.id || '';
    const modifierName = modifierLineName(modifier);
    const detailId = [
      orderId || log.reference || log.timestamp || date,
      parentLine.saleLineKey || parentLine.yocoLineId || modifierParentLineKey(modifier) || mainProduct,
      modifier.saleLineKey || modifier.yocoLineId || modifier.id || modifierLineSummaryKey(modifier),
      index
    ].map((part) => String(part || '').trim()).join('::');

    return {
      Date: displayDate(date),
      Time: displayTime(modifier.timestamp || modifier.saleTimestamp || log.timestamp || log.createdAt || date),
      'Sale ID / Order ID': orderId,
      'Main Product Sold': mainProduct,
      'Modifier Item': modifierName,
      'Modifier Category': modifierLineGroup(modifier),
      'Qty Sold': number(qty),
      'Modifier Selling': currency(selling),
      'Modifier Cost': currency(cost),
      'Modifier GP': currency(gp),
      'Modifier GP %': gpPercent === null ? 'N/A' : percent(gpPercent),
      Status: status,
      Location: location,
      _detailId: detailId,
      _orderId: orderId,
      _mainProduct: mainProduct,
      _mainProductKey: String(mainProduct || '').trim().toLowerCase(),
      _modifierItem: modifierName,
      _modifierItemKey: String(modifierName || 'Modifier').trim().toLowerCase(),
      _modifierCategory: modifierLineGroup(modifier),
      _qtySold: qty,
      _modifierSales: selling,
      _modifierCost: cost,
      _modifierGp: gp,
      _modifierGpPercent: gpPercent,
      _zeroPrice: selling === 0,
      _sortDate: modifier.timestamp || modifier.saleTimestamp || log.timestamp || log.createdAt || date,
      _raw: log,
      _saleLine: modifier
    };
  });
}

function isModifierSaleLine(line = {}) {
  const componentType = String(line.componentType || line.kcpComponentType || '').trim().toLowerCase();
  if (componentType === 'modifier') return true;
  if (componentType === 'product' || componentType === 'main') return false;
  return Boolean(
    line.parentLineId ||
    line.kcpParentLineId ||
    line.parentId ||
    line.saleParentLineId ||
    line.modifierId ||
    line.modifierGroupId ||
    line.modifierGroupName ||
    line.modifierVariantId
  );
}

function modifierLineName(line = {}) {
  return String(line.modifierName || line.productName || line.pname || line.name || 'Modifier').trim() || 'Modifier';
}

function modifierLineGroup(line = {}) {
  return String(line.modifierGroupName || line.groupName || line.category || 'Product Modifiers').trim() || 'Product Modifiers';
}

function modifierLineSummaryKey(line = {}) {
  return [
    line.modifierId || line.modifierVariantId || line.productId || modifierLineName(line),
    modifierLineGroup(line)
  ].map((part) => String(part || '').trim().toLowerCase()).join('::');
}

function modifierLineBelongsToMainLine(modifier = {}, line = {}, log = {}) {
  const mainLineIds = saleLineIdentityValues(line);
  const modifierParentIds = modifierParentLineValues(modifier);
  if (mainLineIds.some((id) => modifierParentIds.includes(id))) return true;

  const mainProductIds = [
    line.productId,
    line.productID,
    line.menuItemId,
    line.itemId,
    line.yocoItemId,
    line.yocoVariantId
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const modifierParentProductIds = [
    modifier.parentProductId,
    modifier.kcpParentProductId,
    modifier.parentItemId,
    modifier.parentYocoItemId,
    modifier.parentYocoVariantId
  ].map((value) => String(value || '').trim()).filter(Boolean);
  if (mainProductIds.some((id) => modifierParentProductIds.includes(id))) return true;

  const mainName = String(line.productName || line.pname || line.name || log.productName || '').trim().toLowerCase();
  const parentName = String(modifier.parentProductName || modifier.parentName || modifier.parentItemName || '').trim().toLowerCase();
  return Boolean(mainName && parentName && mainName === parentName);
}

function saleLineIdentityValues(line = {}) {
  return [
    line.saleLineKey,
    line.yocoLineId,
    line.id,
    line.lineId,
    line.sourceLineId,
    line.kcpSourceLineId,
    line.raw?.id,
    line.rawJson?.id,
    line.sourceLine?.id
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function modifierParentLineValues(line = {}) {
  return [
    line.parentLineId,
    line.kcpParentLineId,
    line.parentId,
    line.saleParentLineId,
    line.parentSaleLineKey,
    line.raw?.kcpParentLineId,
    line.rawJson?.kcpParentLineId,
    line.raw?.parentLineId,
    line.rawJson?.parentLineId
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function modifierParentLineKey(line = {}) {
  return modifierParentLineValues(line)[0] || '';
}

function syntheticMainLineForModifiers(modifiers = [], log = {}) {
  const modifier = modifiers[0] || {};
  const name = mainProductNameForModifier(modifier, {}, log);
  return {
    productName: name,
    pname: name,
    name,
    qtySold: Math.max(1, ...modifiers.map((line) => Math.abs(saleSoldQty(line)) || 0)),
    totalEx: 0,
    lineTotalEx: 0,
    totalImpact: 0,
    saleLineKey: modifierParentLineKey(modifier) || `${log.id || log.orderId || log.yocoOrderId || 'sale'}::${name}`,
    yocoLineId: modifierParentLineKey(modifier),
    parentProductName: name,
    locationId: modifier.locationId || log.locationId,
    locationName: modifier.locationName || log.locationName,
    saleDate: saleLineDate(modifier, log),
    timestamp: modifier.timestamp || modifier.saleTimestamp || log.timestamp || log.createdAt
  };
}

function mainProductNameForModifier(modifier = {}, parentLine = {}, log = {}) {
  return String(
    parentLine.productName ||
    parentLine.pname ||
    parentLine.name ||
    modifier.parentProductName ||
    modifier.parentName ||
    modifier.parentItemName ||
    log.productName ||
    log.itemName ||
    'Unassigned main product'
  ).trim() || 'Unassigned main product';
}

function modifierMovementMatches(line = {}, movement = {}, log = {}) {
  const componentType = String(movement.componentType || movement.kcpComponentType || '').trim().toLowerCase();
  if (componentType && componentType !== 'modifier') return false;

  const checks = [
    [line.saleLineKey || line.id || line.yocoLineId, movement.parentLineId || movement.kcpParentLineId || movement.saleLineKey || movement.yocoLineId],
    [modifierParentLineKey(line), movement.parentLineId || movement.kcpParentLineId],
    [line.modifierId, movement.modifierId],
    [line.modifierVariantId, movement.modifierVariantId],
    [line.productId, movement.productId || stockMovementItemId(movement)]
  ];
  if (checks.some(([left, right]) => stringsMatch(left, right))) return true;

  const lineName = modifierLineName(line).toLowerCase();
  const movementName = String(movement.modifierName || movement.productName || movement.stockItemName || movement.ingredientName || '').trim().toLowerCase();
  const parentMatch = !line.parentLineId || !movement.parentLineId || stringsMatch(line.parentLineId, movement.parentLineId);
  return parentMatch && Boolean(lineName && movementName && lineName === movementName);
}

function stringsMatch(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  return Boolean(a && b && a === b);
}

function saleMovementCost(movements = [], ingredientMap = null) {
  return movements.reduce((sum, movement) => {
    // Derive qty × unified last-purchase cost first; stored impact only as fallback.
    const item = ingredientMap ? ingredientMap.get(String(stockMovementItemId(movement))) : null;
    const unitCost = Number(item?.cost ?? movement.unitCost ?? movement.cost ?? 0) || 0;
    const stored = movement.impactEx ?? movement.impact ?? movement.totalImpact ?? movement.valueDelta;
    return sum + deriveCostImpact(saleMovementQty(movement), unitCost, stored);
  }, 0);
}

function weightedModifierGp(rows = []) {
  const withSales = rows.filter((row) => Number(row._salesEx || 0) > 0);
  const sales = withSales.reduce((sum, row) => sum + Number(row._salesEx || 0), 0);
  if (sales > 0) {
    const cogs = withSales.reduce((sum, row) => sum + Number(row._cogsEx || 0), 0);
    return ((sales - cogs) / sales) * 100;
  }
  if (!rows.length) return 0;
  return rows.reduce((sum, row) => sum + Number(row._gp || 0), 0) / rows.length;
}

function modifierGpStatus(variance, salesEx = 0) {
  if (!Number(salesEx || 0)) return 'No Sales';
  if (variance <= -5) return 'Below Average';
  if (variance >= 5) return 'Above Average';
  return 'On Average';
}

function signedPercent(value) {
  const numeric = Number(value || 0);
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(1)}%`;
}

function saleMovementDetailLine(line = {}, log = {}, context = {}) {
  const ing = context.ingredientMap.get(String(stockMovementItemId(line))) || {};
  const quantity = saleUsageQty(line, log);
  // Unified last-purchase cost first; stale line-level cost only as a fallback.
  const unitCost = Number(ing.cost ?? line.unitCost ?? line.cost ?? 0);
  // Derive impact from qty × unit cost first; stored impact only when we can't.
  const impact = deriveCostImpact(quantity, unitCost, line.impactEx ?? line.impact ?? line.totalImpact);
  const unit = line.unit || ing.unit || ing.uom || '';
  const componentType = String(line.componentType || line.kcpComponentType || '').trim().toLowerCase();
  const modifierLabel = line.modifierName || line.productName || line.pname || line.name;
  return {
    Ingredient: line.ingredientName || line.stockItemName || line.ingName || ing.name || 'Recipe ingredient',
    Component: componentType === 'modifier' && modifierLabel ? `Modifier: ${modifierLabel}` : 'Base recipe',
    Location: line.locationName || log.locationName || locationName(context, lineLocationId(line, log), ''),
    'Qty Depleted': `${number(quantity)}${unit ? ` ${unit}` : ''}`,
    'Unit Cost': currency(unitCost),
    'Impact Ex': currency(impact),
    _qty: quantity,
    _impact: impact,
    _unitCost: unitCost,
    _unit: unit
  };
}

function buildMenuRows(source, context) {
  const productSales = buildProductSalesVolume(source, context);
  const activeProducts = source.products.filter(isMainMenuProduct);
  const productSalesValue = new Map(activeProducts.map((product) => {
    const price = Number(product.sellingPrice || product.price || 0);
    const sold = productSoldQty(product, productSales);
    return [String(product.id || product.name || ''), sold * price];
  }));
  const totalSalesValue = [...productSalesValue.values()].reduce((sum, value) => sum + value, 0);
  return activeProducts.map((product) => {
	    const recipeLines = getEffectiveProductRecipe(product);
	    const hasRecipe = recipeLines.length > 0;
    const cost = recipeCost(product, context.ingredientMap);
    const price = Number(product.sellingPrice || product.price || 0);
    const sold = productSoldQty(product, productSales);
    const salesValue = sold * price;
    return {
      'Menu Item': product.name || product.ProductName || '',
      Category: product.category || 'General',
      'Selling Price': currency(price),
      'Recipe Cost': currency(cost),
      'GP %': hasRecipe ? percent(price > 0 ? ((price - cost) / price) * 100 : 0) : 'Missing Recipe',
      'Recipe Lines': String(recipeLines.length),
      'Sales Volume': number(sold),
      'Sales (R)': currency(salesValue),
      'Sales Mix': percent(totalSalesValue ? (salesValue / totalSalesValue) * 100 : 0),
      Recipe: hasRecipe ? 'View Recipe' : 'Missing Recipe',
      _gp: hasRecipe && price > 0 ? ((price - cost) / price) * 100 : null,
      _productId: product.id || '',
      _productName: product.name || product.ProductName || '',
      _missingRecipe: !hasRecipe,
      _salesValue: salesValue,
      _salesVolume: sold,
      _sort: product.name || ''
    };
  })
    .filter((row) => {
      if (context.menuGpFilter !== 'below60') return true;
      return row._missingRecipe || Number(row._gp || 0) < 60;
    })
    .filter((row) => passesCommon(row, context))
    .sort(sortBy('_sort'));
}

function productSoldQty(product = {}, productSales = new Map()) {
  const keys = [
    product.id,
    product.productId,
    product.yocoVariantId,
    product.yocoItemId,
    product.name,
    product.ProductName
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return keys.reduce((sum, key) => sum || Number(productSales.get(key) || productSales.get(key.toLowerCase()) || 0), 0);
}

function buildMissingRecipeRows(source, context) {
	  return source.products.filter((product) => isMainMenuProduct(product) && !getEffectiveProductRecipe(product).length).map((product) => ({
    'Menu Item': product.name || '',
    Category: product.category || 'General',
    'Selling Price': currency(product.sellingPrice || product.price || 0),
    Status: 'Missing',
    Recipe: 'Add Recipe',
    _productId: product.id || '',
    _productName: product.name || product.ProductName || '',
    _missingRecipe: true,
    _sort: product.name || ''
  })).filter((row) => passesCommon(row, context)).sort(sortBy('_sort'));
}

function buildAdjustmentRows(source, context) {
  return source.logs_adj.filter((log) => inDateRange(logDate(log), context)).map((log) => {
    const item = context.ingredientMap.get(String(log.stockItemId || log.itemId)) || {};
    const timestamp = log.createdAt || log.timestamp || log.date || '';
    return {
      Date: displayDate(logDate(log)),
      Time: displayTime(timestamp),
      User: resolveReportActor(context, log),
      Item: log.stockItemName || log.itemName || item.name || '',
      Category: log.category || item.category || 'General',
      Location: log.locationName || locationName(context, logLocationId(log), ''),
      Mode: log.mode || 'remove',
      Quantity: number(log.qty ?? log.quantity ?? Math.abs(Number(log.impactQty || 0))),
      Unit: log.unit || item.unit || item.uom || '',
      'Impact Ex': currency((Number(log.impactQty || 0) !== 0 && Number(item.cost || 0) > 0)
        ? Number(log.impactQty) * Number(item.cost)
        : Number(log.impactEx || 0)),
      Reason: log.wasteReason || log.note || '',
      _unit: log.unit || item.unit || item.uom || ''
    };
  }).filter((row) => passesReportFilters(row, context));
}

function buildStockTakeRows(source, context) {
  return source.logs_stocktakes.filter((log) => inDateRange(logDate(log), context)).map((log) => {
    const items = toArray(log.items);
    const impact = items.reduce((sum, item) => sum + Number(item.variance || 0) * Number(context.ingredientMap.get(String(item.id || item.itemId))?.cost || item.cost || 0), 0);
    return {
      Date: displayDate(logDate(log)),
      Time: displayTime(reportTimestamp(log)),
      Location: log.locationName || locationName(context, logLocationId(log), ''),
      User: resolveReportActor(context, log),
      'Items Counted': String(items.length),
      'Variance Lines': String(items.filter((item) => Number(item.variance || 0) !== 0).length),
      'Net Impact': currency(impact),
      Action: 'View Count',
      _detailId: log.id || log.sessionId || log.stockTakeId || log.timestamp || log.date || '',
      _raw: log
    };
  }).filter((row) => passesReportFilters(row, context));
}

function buildInventoryAuditRows(source, context) {
  return source.logs_inventory_audit
    .filter((log) => inDateRange(logDate(log), context))
    .flatMap((log) => inventoryAuditDisplayLogs(log))
    .map((log) => {
      const before = auditObjectValue(log.before || log.beforeJson || log.before_json || log.beforeValueObject);
      const after = auditObjectValue(log.after || log.afterJson || log.after_json || log.afterValueObject);
      const area = log.area || log.entityType || after.area || before.area || 'workspace';
      const itemId = log.itemId || log.entityId || after.id || before.id || after.stockItemId || before.stockItemId || '';
      const itemName = log.itemName ||
        after.name ||
        before.name ||
        after.itemName ||
        before.itemName ||
        after.stockItemName ||
        before.stockItemName ||
        after.supplierName ||
        before.supplierName ||
        itemId;
      const locationId = log.locationId || after.locationId || before.locationId || after.targetLocation || before.targetLocation || '';
      return {
        Date: displayDate(logDate(log)),
        Time: displayTime(reportTimestamp(log)),
        Area: titleCase(area),
        Item: itemName || 'Workspace',
        Action: auditActionLabel(log.action || log.eventType || log.event_type || 'updated'),
        Location: log.locationName || after.locationName || before.locationName || after.targetLocationName || before.targetLocationName || locationName(context, locationId || '', locationId ? 'Unknown Location' : 'Workspace'),
        Before: log.beforeValue || summarizeAuditValue(before, log.beforeJson || log.before_json),
        After: log.afterValue || summarizeAuditValue(after, log.afterJson || log.after_json),
        User: resolveUserLabel(context, log.actorUid, log.actor_uid, log.createdBy, log.created_by, log.userEmail, log.userId, after.updatedBy, before.updatedBy),
        Source: auditSourceLabel(log),
        _sort: log.timestamp || log.createdAt || log.date || ''
      };
    })
    .filter((row) => passesReportFilters(row, context))
    .sort((a, b) => String(b._sort || '').localeCompare(String(a._sort || '')));
}

function inventoryAuditDisplayLogs(log = {}) {
  const before = auditObjectValue(log.before || log.beforeJson || log.before_json);
  const after = auditObjectValue(log.after || log.afterJson || log.after_json);
  const eventType = log.action || log.eventType || log.event_type || '';
  const bulkItems = toArray(after.items || after.deletedItems || before.items || before.deletedItems);
  if (bulkItems.length && ['products_bulk_deleted', 'stock_items_deleted'].includes(String(eventType).toLowerCase())) {
    return bulkItems.map((item) => ({
      ...log,
      entityId: item.id || item.itemId || item.stockItemId || log.entityId,
      itemId: item.id || item.itemId || item.stockItemId || log.itemId,
      itemName: item.name || item.itemName || item.stockItemName || log.itemName,
      locationId: item.locationId || log.locationId,
      locationName: item.locationName || log.locationName,
      beforeValue: summarizeAuditValue(item),
      afterValue: 'Deleted',
      beforeValueObject: item,
      afterValueObject: { ...item, active: false, deleted: true }
    }));
  }

  const bulkIds = Array.isArray(after.ids) ? after.ids : [];
  if (bulkIds.length && ['products_bulk_deleted', 'stock_items_deleted'].includes(String(eventType).toLowerCase())) {
    return bulkIds.map((id) => ({
      ...log,
      entityId: id,
      itemId: id,
      itemName: id,
      beforeValue: id,
      afterValue: 'Deleted',
      beforeValueObject: { id },
      afterValueObject: { id, active: false, deleted: true }
    }));
  }

  return [log];
}

function auditActionLabel(value = '') {
  const key = String(value || '').trim().toLowerCase();
  const labels = {
    stock_item_saved: 'Stock Item Saved',
    stock_item_deleted: 'Stock Item Deleted',
    stock_items_deleted: 'Stock Items Deleted',
    stock_items_imported: 'Stock Items Imported',
    stock_level_updated: 'Stock Level Updated',
    reporting_reset: 'Reporting Reset',
    products_bulk_deleted: 'Menu Items Deleted',
    products_duplicate_rows_archived: 'Duplicate Menu Rows Archived',
    product_deleted: 'Menu Item Deleted',
    product_saved: 'Menu Item Saved',
    supplier_saved: 'Supplier Saved',
    location_saved: 'Location Saved',
    adjustment_posted: 'Adjustment Posted',
    grv_saved: 'GRV Saved',
    credit_note_saved: 'Credit Note Saved',
    purchase_order_saved: 'Purchase Order Saved',
    manufacturing_batch_posted: 'Manufacturing Batch Posted',
    transfer_posted: 'Transfer Posted'
  };
  return labels[key] || titleCase(key || 'updated');
}

function summarizeAuditValue(value = {}, fallback = '') {
  const data = value && typeof value === 'object' ? value : {};
  if (!Object.keys(data).length) return String(fallback || '').slice(0, 120);
  const name = data.name || data.itemName || data.stockItemName || data.supplierName || data.locationName || data.displayName;
  const quantity = data.quantity ?? data.stock ?? data.qty ?? data.currentStock ?? data.onHand;
  const category = data.category || data.kind || data.type || data.status;
  const parts = [];
  if (name) parts.push(String(name));
  if (category) parts.push(String(category));
  if (quantity !== undefined && quantity !== null && quantity !== '') parts.push(`Qty ${quantity}`);
  if (Array.isArray(data.ids)) parts.push(`${data.ids.length} item${data.ids.length === 1 ? '' : 's'}`);
  if (Array.isArray(data.items)) parts.push(`${data.items.length} line${data.items.length === 1 ? '' : 's'}`);
  if (Array.isArray(data.movedItems)) parts.push(`${data.movedItems.length} moved item${data.movedItems.length === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : JSON.stringify(data).slice(0, 120);
}

function auditObjectValue(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildManufacturingRows(source, context) {
  return source.logs_mfg.filter((log) => inDateRange(logDate(log), context)).map((log) => {
    const expectedQty = getManufacturingExpectedQty(log);
    const producedQty = log.producedQty ?? log.actualQty ?? log.qty ?? 0;
    const wastageQty = getManufacturingShortfallQty(log);
    return {
      Date: displayDate(logDate(log)),
      Time: displayTime(reportTimestamp(log)),
      User: resolveReportActor(context, log, 'Unknown'),
      Item: log.itemName || log.stockItemName || log.manufacturedItemName || context.ingredientMap.get(String(log.itemId || log.manufacturedItemId))?.name || '',
      Type: 'Manufactured / Prep',
      Location: log.locationName || locationName(context, logLocationId(log), ''),
      Expected: number(expectedQty),
      Produced: number(producedQty),
      'Wastage Qty': number(wastageQty),
      Variance: number(getManufacturingVarianceQty(log)),
      'Batch Cost Ex': currency(getManufacturingComponentTotal(log)),
      'Wastage Value Ex': currency(getManufacturingWastageValue(log)),
      Unit: log.unit || context.ingredientMap.get(String(log.itemId || log.manufacturedItemId))?.unit || ''
    };
  }).filter((row) => passesReportFilters(row, context));
}

function buildTransferRows(source, context) {
  return source.logs_transfers.filter((log) => inDateRange(transferActionTimestamp(log) || logDate(log), context)).flatMap((log) => {
    const timestamp = transferActionTimestamp(log);
    return toArray(log.items).map((line) => ({
      Date: displayDate(timestamp || logDate(log)),
      Time: displayTime(timestamp),
      User: resolveReportActor(context, log),
      Item: line.stockItemName || line.itemName || line.name || context.ingredientMap.get(String(line.stockItemId || line.itemId || line.id))?.name || '',
      From: log.fromLocationName || log.fromName || locationName(context, transferFromId(log), ''),
      To: log.toLocationName || log.toName || locationName(context, transferToId(log), ''),
      Quantity: number(line.quantity || line.qty || 0),
      Unit: line.unit || '',
      Note: log.note || '',
      _sortDate: timestamp || logDate(log)
    }));
  }).filter((row) => passesReportFilters(row, context, ['From', 'To']))
    .sort((a, b) => String(b._sortDate || '').localeCompare(String(a._sortDate || '')));
}

function buildCorporateRows(source, context) {
  const settings = source.settings || {};
  const stockValue = source.ingredients.reduce((sum, item) => {
    const qtyTotal = reportLocationBalances(item, { ...context, locationId: '' })
      .reduce((total, balance) => total + Number(balance.qty || 0), 0);
    return sum + qtyTotal * Number(item.cost || 0);
  }, 0);
  const lowStockItems = source.ingredients.filter((item) => {
    if (isArchived(item)) return false;
    const qtyTotal = reportLocationBalances(item, { ...context, locationId: '' })
      .reduce((total, balance) => total + Number(balance.qty || 0), 0);
    return qtyTotal < resolveLowStockThreshold(item);
  }).length;

  return [{
    Profile: settings.siteName || 'Current Workspace',
    'Org ID': settings.orgId || 'Not linked',
    'Corp ID': settings.corpId || 'Not linked',
    'View Mode': settings.viewingOnly ? 'Viewing Only' : 'Full Workspace',
    Locations: String((source.locations || []).length),
    'Stock Value': currency(stockValue),
    'Low Stock Items': String(lowStockItems),
    _search: `${settings.siteName || ''} ${settings.orgId || ''} ${settings.corpId || ''}`
  }].filter((row) => passesReportFilters(row, context));
}

function buildOpsOverviewRows(source, context) {
  const stockRows = buildStockRows(source, { ...context, query: '' });
  const movement = buildMovementRows(source, { ...context, query: '' });
  const lowStockRows = buildLowStockRows(source, { ...context, query: '' }).filter((row) => row._low);
  const locationLabel = context.locationId
    ? locationName(context, context.locationId, 'Unknown Location')
    : 'All Locations';
  const categories = new Map();
  stockRows.forEach((stockRow) => {
    const key = stockRow.Category || 'General';
    if (!categories.has(key)) {
      categories.set(key, { Category: key, Location: locationLabel, stock: 0, purchases: 0, wastage: 0, adj: 0, low: 0 });
    }
    const row = categories.get(key);
    row.stock += parseCurrencyValue(stockRow['Stock Value']);
  });
  movement.forEach((row) => {
    const item = source.ingredients.find((ingredient) => ingredient.name === row.Item);
    const key = row.Category || item?.category || 'General';
    if (!categories.has(key)) {
      categories.set(key, { Category: key, Location: locationLabel, stock: 0, purchases: 0, wastage: 0, adj: 0, low: 0 });
    }
    const target = categories.get(key);
    const cost = Number(item?.cost || 0);
    target.purchases += Number(row.Purchases || 0) * cost;
    target.wastage += Number(row.Wastage || 0) * cost;
    target.adj += Number(row.Adjustments || 0) * cost;
  });
  lowStockRows.forEach((row) => {
    const key = row.Category || 'General';
    if (!categories.has(key)) {
      categories.set(key, { Category: key, Location: locationLabel, stock: 0, purchases: 0, wastage: 0, adj: 0, low: 0 });
    }
    categories.get(key).low += 1;
  });
  return [...categories.values()].map((row) => ({
    Category: row.Category,
    Location: row.Location,
    'Stock Value': currency(row.stock),
    'Purchases Ex': currency(row.purchases),
    'Wastage Ex': currency(row.wastage),
    'Manual Adjustments Ex': currency(row.adj),
    'Low Stock Items': String(row.low),
    _lowStockCount: row.low,
    _lowStockCategory: row.Category,
    _lowStockLocationId: context.locationId || '',
    _lowStockLocationName: locationLabel
  })).filter((row) => passesCommon(row, context));
}

function buildOpsCategoryOverviewRows(source, context) {
  // Per-item building blocks (each already respects the active location/date filters).
  const stockRows = buildStockRows(source, { ...context, query: '' });
  const theoretical = buildTheoreticalUsage(source, context);

  // Show the location (not the site). When a location filter is active, show that location's name;
  // otherwise the figures span every location the user can see, so label it "All Locations".
  const locationLabel = context.locationId
    ? locationName(context, context.locationId, 'All Locations')
    : 'All Locations';

  const byCategory = new Map();
  const ensureCategory = (categoryName) => {
    const key = String(categoryName || 'General').trim() || 'General';
    if (!byCategory.has(key)) {
      byCategory.set(key, { category: key, closing: 0, purchases: 0, cosActual: 0, cosTheoretical: 0, detail: new Map() });
    }
    return byCategory.get(key);
  };
  const ensureDetail = (group, item) => {
    const id = String(item.id || item.stockItemId || item.name || '').trim();
    if (!group.detail.has(id)) {
      group.detail.set(id, {
        name: item.name || 'Unnamed Item',
        unit: item.unit || item.uom || '',
        closing: 0,
        purchases: 0,
        cosActual: 0,
        cosTheoretical: 0,
        countVariance: 0,
        manualAdjustments: 0,
        wastage: 0
      });
    }
    return group.detail.get(id);
  };

  // Closing stock value (current on-hand value) aggregated by category.
  const ingredientByName = new Map(source.ingredients.map((item) => [item.name, item]));
  stockRows.forEach((row) => {
    const group = ensureCategory(row.Category);
    const value = parseCurrencyValue(row['Stock Value']);
    group.closing += value;
    const item = ingredientByName.get(row.Item);
    if (item) ensureDetail(group, item).closing += value;
  });

  const metricsByItemId = buildOpsCategoryItemMetrics(source, context);

  // Purchases, adjustments, wastage, count variance, and actual / theoretical cost of sales
  // per ingredient. Exclude sub-recipes so nested consumption is not double counted.
  source.ingredients.filter(isOpsReportEligibleItem).forEach((item) => {
    const group = ensureCategory(item.category);
    const metrics = metricsByItemId.get(String(item.id)) || {};
    const theoreticalUsage = Number(theoretical.get(String(item.id)) || 0);
    const cosTheoreticalValue = theoreticalUsage * (Number(item.cost || item.unitCost || 0) || 0);
    group.purchases += Number(metrics.purchases || 0);
    group.cosActual += Number(metrics.cosActual || 0);
    group.cosTheoretical += cosTheoreticalValue;
    const detail = ensureDetail(group, item);
    detail.purchases += Number(metrics.purchases || 0);
    detail.cosActual += Number(metrics.cosActual || 0);
    detail.cosTheoretical += cosTheoreticalValue;
    detail.countVariance += Number(metrics.countVariance || 0);
    detail.manualAdjustments += Number(metrics.manualAdjustments || 0);
    detail.wastage += Number(metrics.wastage || 0);
  });

  const query = String(context.query || '').trim().toLowerCase();

  return [...byCategory.values()]
    .filter((group) => !query || group.category.toLowerCase().includes(query))
    .sort((left, right) => left.category.localeCompare(right.category))
    .map((group) => {
      const detailRows = [...group.detail.values()]
        .sort((left, right) => String(left.name).localeCompare(String(right.name)))
        .map((detail) => {
          const opening = detail.closing - detail.purchases - detail.manualAdjustments - detail.countVariance + detail.wastage + detail.cosActual;
          return {
            Item: detail.name,
            Unit: detail.unit,
            'Opening Stock Value': currency(opening),
            Purchases: currency(detail.purchases),
            'Closing Stock Value': currency(detail.closing),
            'COS Actual': currency(detail.cosActual),
            'COS Theoretical': currency(detail.cosTheoretical),
            'COS Difference': currency(detail.cosActual - detail.cosTheoretical)
          };
        });
      const opening = detailRows.reduce((sum, detail) => sum + parseCurrencyValue(detail['Opening Stock Value']), 0);
      return {
        'Inventory Category': group.category,
        Locations: locationLabel,
        'Opening Stock Value': currency(opening),
        Purchases: currency(group.purchases),
        'Closing Stock Value': currency(group.closing),
        'COS Actual': currency(group.cosActual),
        'COS Theoretical': currency(group.cosTheoretical),
        'COS Difference': currency(group.cosActual - group.cosTheoretical),
        _category: group.category,
        _detailRows: detailRows
      };
    });
}

// Detailed variant: one row per stock item within each inventory category. Reuses the overview
// builder's already-computed per-item breakdown (_detailRows) so the numbers stay consistent.
function buildOpsCategoryDetailRows(source, context) {
  const categories = buildOpsCategoryOverviewRows(source, context);
  const rows = [];
  categories.forEach((group) => {
    (group._detailRows || []).forEach((detail) => {
      rows.push({
        'Inventory Category': group['Inventory Category'],
        Locations: group.Locations,
        Item: detail.Item,
        Unit: detail.Unit,
        'Opening Stock Value': detail['Opening Stock Value'],
        Purchases: detail.Purchases,
        'Closing Stock Value': detail['Closing Stock Value'],
        'COS Actual': detail['COS Actual'],
        'COS Theoretical': detail['COS Theoretical'],
        'COS Difference': detail['COS Difference']
      });
    });
  });
  return rows;
}

function buildOpsDashboardRows(source, context) {
  const rows = opsDashboardLocations(context).map((location) => {
    const locationId = String(location.id || '').trim();
    const locationContext = { ...context, locationId };
    const purchases = opsDashboardPurchases(source, context, locationId);
    const closingStock = opsDashboardClosingStock(source, locationContext);
    const costOfSales = opsDashboardCostOfSales(source, context, locationId);
    const countVariance = opsDashboardCountVariance(source, context, locationId);
    const manualAdjustments = opsDashboardManualAdjustments(source, context, locationId);
    const wastage = opsDashboardWastage(source, context, locationId);
    const openingStock = closingStock - purchases - manualAdjustments - countVariance + wastage + costOfSales;

    return {
      Location: location.displayName || location.name || locationName(context, locationId, context.defaultLocationName || DEFAULT_STOCK_LOCATION_NAME),
      'Purchases Ex': currency(purchases),
      'Opening Stock': currency(openingStock),
      'Closing Stock': currency(closingStock),
      'Cost Of Sales': currency(costOfSales),
      'Count Variance': currency(countVariance),
      'Manual Adjustments': currency(manualAdjustments),
      Wastage: currency(wastage),
      _locationId: locationId
    };
  }).filter((row) => passesReportFilters(row, context));

  const combinedMetrics = rows.reduce((totals, row) => ({
    'Purchases Ex': currency(parseCurrencyValue(totals['Purchases Ex']) + parseCurrencyValue(row['Purchases Ex'])),
    'Opening Stock': currency(parseCurrencyValue(totals['Opening Stock']) + parseCurrencyValue(row['Opening Stock'])),
    'Closing Stock': currency(parseCurrencyValue(totals['Closing Stock']) + parseCurrencyValue(row['Closing Stock'])),
    'Cost Of Sales': currency(parseCurrencyValue(totals['Cost Of Sales']) + parseCurrencyValue(row['Cost Of Sales'])),
    'Count Variance': currency(parseCurrencyValue(totals['Count Variance']) + parseCurrencyValue(row['Count Variance'])),
    'Manual Adjustments': currency(parseCurrencyValue(totals['Manual Adjustments']) + parseCurrencyValue(row['Manual Adjustments'])),
    Wastage: currency(parseCurrencyValue(totals.Wastage) + parseCurrencyValue(row.Wastage))
  }), {
    'Purchases Ex': currency(0),
    'Opening Stock': currency(0),
    'Closing Stock': currency(0),
    'Cost Of Sales': currency(0),
    'Count Variance': currency(0),
    'Manual Adjustments': currency(0),
    Wastage: currency(0)
  });

  return rows.map((row) => ({
    ...row,
    _combinedMetrics: combinedMetrics
  }));
}

function opsDashboardLocations(context = {}) {
  const locations = (context.locations || [])
    .map((location) => ({
      ...location,
      id: String(location.id || location.locationId || '').trim()
    }))
    .filter((location) => location.id && !isAggregateLocationId(location.id));

  if (context.locationId) {
    const selected = locations.find((location) => location.id === context.locationId);
    return selected
      ? [selected]
      : [{ id: context.locationId, name: locationName(context, context.locationId, context.defaultLocationName || DEFAULT_STOCK_LOCATION_NAME) }];
  }

  return locations.length
    ? locations
    : [{ id: context.defaultLocationId || DEFAULT_STOCK_LOCATION_ID, name: context.defaultLocationName || DEFAULT_STOCK_LOCATION_NAME }];
}

function opsDashboardClosingStock(source, context) {
  return source.ingredients.reduce((sum, item) => {
    return sum + reportLocationBalances(item, context).reduce((locationSum, balance) => {
      return locationSum + (Number(balance.qty || 0) || 0) * (Number(item.cost || item.unitCost || 0) || 0);
    }, 0);
  }, 0);
}

function opsDashboardPurchases(source, context, locationId) {
  const grvTotal = source.logs_grv
    .filter((log) => inDateRange(logDate(log), context))
    .reduce((sum, log) => sum + opsDashboardDocumentTotalForLocation(log, context, locationId), 0);
  const creditTotal = source.logs_cn
    .filter((log) => inDateRange(logDate(log), context))
    .reduce((sum, log) => sum + opsDashboardDocumentTotalForLocation(log, context, locationId), 0);
  return grvTotal - creditTotal;
}

function opsDashboardCostOfSales(source, context, locationId) {
  return source.logs_sales
    .filter((log) => inDateRange(logDate(log), context))
    .reduce((sum, log) => sum + saleMovementLines(log).reduce((lineSum, line) => {
      if (opsDashboardResolvedLocationId(line, log, context) !== locationId) return lineSum;
      // Derive qty × unified last-purchase cost first; stored impact only as fallback.
      const item = context.ingredientMap.get(String(stockMovementItemId(line))) || {};
      const unitCost = Number(item.cost ?? line.unitCost ?? line.cost ?? 0) || 0;
      const stored = line.impactEx ?? line.impact ?? line.valueDelta ?? line.totalImpact;
      return lineSum + deriveCostImpact(saleMovementQty(line), unitCost, stored);
    }, 0), 0);
}

function opsDashboardCountVariance(source, context, locationId) {
  return source.logs_stocktakes
    .filter((log) => inDateRange(logDate(log), context))
    .reduce((sum, log) => {
      const items = toArray(log.items);
      if (!items.length) {
        return opsDashboardResolvedLocationId({}, log, context) === locationId
          ? sum + Number(log.netImpact ?? log.varianceImpactEx ?? 0)
          : sum;
      }
      return sum + items.reduce((lineSum, item) => {
        if (opsDashboardResolvedLocationId(item, log, context) !== locationId) return lineSum;
        return lineSum + opsDashboardLineImpact(item, context);
      }, 0);
    }, 0);
}

function opsDashboardManualAdjustments(source, context, locationId) {
  return source.logs_adj
    .filter((log) => inDateRange(logDate(log), context))
    .filter((log) => opsDashboardResolvedLocationId({}, log, context) === locationId)
    .filter((log) => !isWastageAdjustmentLog(log))
    .reduce((sum, log) => {
      // Signed value (adjustments can add or remove). Derive qty × unified cost
      // first (preserving sign); stored impactEx only when qty/cost unavailable.
      const item = context.ingredientMap.get(String(log.stockItemId || log.itemId)) || {};
      const qty = Number(log.impactQty ?? log.qty ?? 0);
      const unitCost = Number(item.cost || 0) || 0;
      const derived = (qty !== 0 && unitCost > 0) ? qty * unitCost : Number(log.impactEx || 0);
      return sum + (Number.isFinite(derived) ? derived : 0);
    }, 0);
}

function opsDashboardWastage(source, context, locationId) {
  const adjustmentWastage = source.logs_adj
    .filter((log) => inDateRange(logDate(log), context))
    .filter((log) => opsDashboardResolvedLocationId({}, log, context) === locationId)
    .filter((log) => isWastageAdjustmentLog(log))
    .reduce((sum, log) => {
      // Loss magnitude: derive |qty| × unified cost first; stored impact fallback.
      const item = context.ingredientMap.get(String(log.stockItemId || log.itemId)) || {};
      return sum + deriveCostImpact(log.impactQty ?? log.qty, item.cost, log.impactEx);
    }, 0);

  const manufacturingWastage = source.logs_mfg
    .filter((log) => inDateRange(logDate(log), context))
    .filter((log) => opsDashboardResolvedLocationId({}, log, context) === locationId)
    .reduce((sum, log) => sum + getManufacturingWastageValue(log), 0);

  return adjustmentWastage + manufacturingWastage;
}

function opsDashboardDocumentTotalForLocation(log = {}, context = {}, locationId = '') {
  const items = toArray(log.items);
  if (!items.length) {
    return opsDashboardResolvedLocationId({}, log, context) === locationId ? reportTotalEx(log) : 0;
  }

  const lineTotals = items.filter((item) => opsDashboardResolvedLocationId(item, log, context) === locationId);
  if (!lineTotals.length) return 0;
  return lineTotals.reduce((sum, item) => sum + sumItems([item], 'lineTotalEx'), 0);
}

function opsDashboardLineImpact(item = {}, context = {}) {
  if (Number.isFinite(Number(item.varianceImpactEx))) return Number(item.varianceImpactEx || 0);
  const stockItem = context.ingredientMap.get(String(item.id || item.itemId || item.stockItemId)) || {};
  return (Number(item.variance || 0) || 0) * (Number(item.cost ?? item.unitCost ?? stockItem.cost ?? 0) || 0);
}

function opsDashboardResolvedLocationId(line = {}, log = {}, context = {}) {
  const id = lineLocationId(line, log);
  if (id && !isAggregateLocationId(id)) return id;
  return context.defaultLocationId || DEFAULT_STOCK_LOCATION_ID;
}

function buildSyncLogRows(source, context) {
  const rowsByDayProduct = new Map();

  source.logs_sales.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    saleLineRows(log).forEach((line) => {
      const date = saleLineDate(line, log);
      const locationId = lineLocationId(line, log);
      if (!inDateRange(date, context) || !matchesLocationId(context, locationId)) return;

      const product = resolveProductForLine(line, log, context);
      const productStatus = productStatusLabel(product);
      const productName = line.productName || line.name || log.productName || '';
      const location = line.locationName || log.locationName || locationName(context, locationId, '');
      const sourceLabel = syncSourceLabel(line, log);
      const unit = line.unit || 'ea';
      const key = [
        date,
        saleProductKey(line, log) || productName.trim().toLowerCase(),
        locationId || location.trim().toLowerCase(),
        sourceLabel,
        productStatus,
        unit
      ].join('::');
      const current = rowsByDayProduct.get(key) || {
        date,
        Product: productName,
        'Product Status': productStatus,
        Location: location,
        qty: 0,
        cosImpact: 0,
        Source: sourceLabel,
        _unit: unit,
        _sortDate: ''
      };
      const qty = Math.abs(saleSoldQty(line));
      current.qty += isRefundLine(line, log) ? -qty : qty;
      current.cosImpact += saleLineCostImpact(line, log, context.ingredientMap);
      current._sortDate = [current._sortDate, line.timestamp || log.timestamp || log.createdAt || date]
        .filter(Boolean)
        .sort()
        .pop() || date;
      rowsByDayProduct.set(key, current);
    });
  });

  return [...rowsByDayProduct.values()].map((row) => ({
    Date: displayDate(row.date),
    Time: displayTime(row._sortDate || row.date),
    Product: row.Product,
    'Product Status': row['Product Status'],
    Location: row.Location,
    'Qty Sold': number(row.qty),
    'COS Impact': currency(row.cosImpact),
    Source: row.Source,
    _unit: row._unit,
    _sortDate: row._sortDate || row.date
  })).filter((row) => passesReportFilters(row, context)).sort((a, b) => String(b._sortDate || '').localeCompare(String(a._sortDate || '')));
}

function buildSalesErrorRows(source, context) {
  return source.logs_sales_errors.filter((log) => inDateRange(logDate(log), context)).map((log) => {
    const location = log.locationName || locationName(context, logLocationId(log), '');
    return {
      Date: displayDate(logDate(log)),
      Time: displayTime(reportTimestamp(log)),
      Type: titleCase(log.type || log.errorType || log.status || 'Import Error'),
      Product: log.productName || log.name || log.orderId || 'Yoco order',
      Location: location || 'Unknown Location',
      Reason: log.reason || log.message || log.errorMessage || 'Yoco sync failed',
      Detail: log.detail || log.rawName || log.orderId || log.id || '',
      _sortDate: log.timestamp || log.createdAt || log.date || ''
    };
  }).filter((row) => passesReportFilters(row, context)).sort((a, b) => String(b._sortDate || '').localeCompare(String(a._sortDate || '')));
}

function buildActivityRows(source, context) {
  const rows = [
    ...source.logs_grv.map((log) => activityRow({
      timestamp: activityTimestamp(log),
      type: 'GRV',
      location: log.locationName || locationName(context, logLocationId(log), 'Multiple'),
      user: reportActor(log),
      action: 'Goods Received',
      summary: `${log.supplier || log.supplierName || 'Manual Receipt'} ${log.invoice || log.grvNumber || log.id || ''} ${currency(log.totalEx ?? sumItems(log.items, 'lineTotalEx'))}`
    })),
    ...source.logs_cn.map((log) => activityRow({
      timestamp: activityTimestamp(log),
      type: 'Credit Note',
      location: log.locationName || locationName(context, logLocationId(log), 'Multiple'),
      user: reportActor(log),
      action: 'Supplier Credit',
      summary: `${log.supplier || log.supplierName || 'Supplier'} ${log.reference || log.creditNoteNumber || log.id || ''} ${currency(reportTotalEx(log))}`
    })),
    ...source.purchaseOrders.map((order) => activityRow({
      timestamp: activityTimestamp(order),
      type: 'Purchase Order',
      location: order.targetLocationName || locationName(context, order.targetLocation || order.locationId, 'Main Store'),
      user: reportActor(order),
      action: order.status || 'Created',
      summary: `${order.supplierName || order.supplier || 'Supplier'} ${order.reference || order.poNumber || order.id || ''} ${currency(order.totalEx ?? sumItems(order.items))}`
    })),
    ...source.logs_adj.map((log) => {
      const item = context.ingredientMap.get(String(log.stockItemId || log.itemId)) || {};
      return activityRow({
        timestamp: activityTimestamp(log),
        type: 'Adjustment',
        location: log.locationName || locationName(context, logLocationId(log), ''),
        user: reportActor(log),
        action: log.mode || 'Adjusted',
        summary: `${log.stockItemName || log.itemName || item.name || 'Stock item'} ${number(log.qty ?? log.quantity ?? Math.abs(Number(log.impactQty || 0)))} ${log.wasteReason || log.note || ''}`,
        category: log.category || item.category || ''
      });
    }),
    ...source.logs_transfers.flatMap((log) => toArray(log.items).map((line) => activityRow({
      timestamp: transferActionTimestamp(log),
      type: 'Transfer',
      location: log.toLocationName || log.toName || locationName(context, transferToId(log), ''),
      user: log.user || log.createdByName || log.createdByEmail || log.createdBy || reportActor(log),
      action: `${log.fromLocationName || log.fromName || locationName(context, transferFromId(log), '')} to ${log.toLocationName || log.toName || locationName(context, transferToId(log), '')}`,
      summary: `${line.stockItemName || line.itemName || line.name || context.ingredientMap.get(String(line.stockItemId || line.itemId || line.id))?.name || 'Stock item'} ${number(line.quantity || line.qty || 0)} ${line.unit || ''}`
    }))),
    ...source.logs_stocktakes.map((log) => {
      const items = toArray(log.items);
      const impact = items.reduce((sum, item) => sum + Number(item.variance || 0) * Number(context.ingredientMap.get(String(item.id || item.itemId))?.cost || item.cost || 0), 0);
      return activityRow({
        timestamp: activityTimestamp(log),
        type: 'Stock Take',
        location: log.locationName || locationName(context, logLocationId(log), ''),
        user: reportActor(log),
        action: log.status || 'Count Posted',
        summary: `${items.length} items, ${currency(impact)}`
      });
    }),
    ...source.logs_mfg.map((log) => activityRow({
      timestamp: activityTimestamp(log),
      type: 'Manufacturing',
      location: log.locationName || locationName(context, logLocationId(log), ''),
      user: reportActor(log),
      action: 'Production Posted',
      summary: `${log.itemName || log.stockItemName || log.manufacturedItemName || context.ingredientMap.get(String(log.itemId || log.manufacturedItemId))?.name || 'Production'} produced ${number(log.producedQty ?? log.actualQty ?? log.qty ?? 0)} ${log.unit || ''}`
    })),
    ...source.logs_sales.map((log) => activityRow({
      timestamp: activityTimestamp(log),
      type: 'Sale Sync',
      location: log.locationName || locationName(context, logLocationId(log), ''),
      user: reportActor(log),
      action: String(log.syncMode || log.status || '').toLowerCase().includes('refund') ? 'Refund Synced' : 'Sale Synced',
      summary: `${log.orderId || log.yocoOrderId || log.id || 'Yoco order'} ${currency(log.total || 0)}`
    })),
    ...source.logs_sales_errors.map((log) => activityRow({
      timestamp: activityTimestamp(log),
      type: 'Sales Error',
      location: log.locationName || locationName(context, logLocationId(log), ''),
      user: reportActor(log),
      action: titleCase(log.type || log.errorType || log.status || 'Import Error'),
      summary: `${log.productName || log.orderId || 'Yoco order'} ${log.reason || log.message || log.errorMessage || 'Yoco sync failed'}`
    })),
    ...buildInventoryAuditRows(source, { ...context, query: '', category: '', locationId: '' }).map((row) => activityRow({
      timestamp: row._sort || row.Date,
      type: row.Area || 'Audit',
      location: row.Location || '',
      user: row.Source || '',
      action: row.Action || 'Updated',
      summary: `${row.Item || 'Workspace'} ${row.Before || ''}${row.After ? ` -> ${row.After}` : ''}`
    }))
  ];

  return rows
    .filter((row) => inDateRange(row._sortDate || row.Date, context))
    .filter((row) => passesReportFilters(row, context))
    .sort((a, b) => String(b._sortDate || '').localeCompare(String(a._sortDate || '')));
}

function activityRow({ timestamp = '', type = '', location = '', user = '', action = '', summary = '', category = '' } = {}) {
  const dateKey = displayDate(timestamp);
  return {
    Date: dateKey,
    Time: displayTime(timestamp),
    Type: type,
    Location: location || '',
    User: user || '',
    Action: titleCase(action || ''),
    Summary: summary || '',
    Category: category || '',
    _sortDate: timestamp || dateKey
  };
}

function activityTimestamp(log = {}) {
  return String(log.timestamp || log.createdAt || log.processedAt || log.updatedAt || log.date || '').trim();
}

function transferActionTimestamp(log = {}) {
  return String(
    log.postedAt ||
    log.acceptedAt ||
    log.completedAt ||
    log.processedAt ||
    log.updatedAt ||
    log.timestamp ||
    log.requestedAt ||
    log.createdAt ||
    log.actionAt ||
    log.date ||
    ''
  ).trim();
}

function buildPaymentRows(source, context) {
  const groups = new Map();
  // VAT-inclusive: sale prices already include VAT. When the POS sends no explicit
  // tax field, derive it from the gross: tax = gross * rate / (100 + rate).
  const vatRate = Number(source.settings?.vatRate ?? source.settings?.vatPercentage ?? 15) || 0;
  source.logs_sales.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    if (!paymentLogMatchesLocation(log, context)) return;
    const sourceName = titleCase(log.sourceProvider || log.source || 'Yoco');
    const location = paymentLocationLabel(log, context);
    const refund = isRefundLine({}, log);
    const payments = paymentEntries(log);
    const grossTotal = Math.abs(paymentLogGrossTotal(log));
    const tip = Math.abs(paymentLogTip(log));
    // VAT-inclusive: always derive the VAT component from the gross. The POS tax
    // field (Yoco) is unreliable — it has been observed larger than the gross — so
    // we do NOT trust it. Tip is not a taxable sale, so exclude it from the base.
    const taxableGross = Math.max(0, grossTotal - tip);
    const derivedTax = vatRate > 0 ? (taxableGross * vatRate) / (100 + vatRate) : 0;
    // Only fall back to an explicit field when it is sane (never exceeds the gross).
    const explicitTax = Math.abs(paymentLogTax(log));
    const tax = (explicitTax > 0 && explicitTax <= taxableGross) ? explicitTax : derivedTax;
    const paymentTotal = payments.reduce((sum, payment) => sum + Math.abs(Number(payment.amount || 0)), 0);
    const safePaymentTotal = paymentTotal || grossTotal || 1;

    payments.forEach((payment) => {
      const tender = normalizeTender(payment.tender || log.paymentMethod || log.tender || 'CARD');
      const amount = Math.abs(Number(payment.amount || 0));
      const share = Math.min(1, amount / safePaymentTotal);
      const key = [sourceName, tender, location].join('|');
      const current = groups.get(key) || {
        'POS Source': sourceName,
        Tender: tender,
        Location: location,
        orders: 0,
        gross: 0,
        refunds: 0,
        tips: 0,
        tax: 0,
        withTip: 0,
        taxed: 0,
        noTax: 0,
        net: 0
      };
      const allocatedTip = tip * share;
      const allocatedTax = tax * share;
      current.orders += 1;
      current.gross += refund ? 0 : amount;
      current.refunds += refund ? amount : 0;
      current.tips += refund ? -allocatedTip : allocatedTip;
      current.tax += refund ? -allocatedTax : allocatedTax;
      current.withTip += allocatedTip > 0 ? 1 : 0;
      current.taxed += allocatedTax > 0 ? 1 : 0;
      current.noTax += allocatedTax > 0 ? 0 : 1;
      groups.set(key, current);
    });
  });

  return [...groups.values()].map((row) => {
    // Gross includes tips. Net remains sales ex-VAT, so subtract refunds, tips, and the VAT portion.
    const netAfterRefunds = row.gross - row.refunds;
    const netExVat = netAfterRefunds - row.tips - row.tax;
    return {
      'POS Source': row['POS Source'],
      Tender: row.Tender,
      Location: row.Location,
      Orders: String(row.orders),
      'Gross Sales': currency(row.gross),
      Tips: currency(row.tips),
      Refunds: currency(row.refunds),
      'Tax Amount': currency(row.tax),
      'Orders With Tip': String(row.withTip),
      'Taxed Orders': String(row.taxed),
      'No Tax Orders': String(row.noTax),
      Net: currency(netExVat),
      _sort: `${row['POS Source']} ${row.Tender} ${row.Location}`
    };
  }).filter((row) => passesSearch(row, context)).sort(sortBy('_sort'));
}

function paymentLogMatchesLocation(log = {}, context = {}) {
  if (!context.locationId) return true;
  if (lineLocationId({}, log) === context.locationId) return true;
  return saleLineRows(log).some((line) => lineLocationId(line, log) === context.locationId);
}

function paymentLocationLabel(log = {}, context = {}) {
  if (context.locationId) return locationName(context, context.locationId, 'Unknown Location');
  const locations = new Set(
    saleLineRows(log)
      .map((line) => line.locationName || locationName(context, lineLocationId(line, log), ''))
      .filter(Boolean)
  );
  if (!locations.size && log.locationName) locations.add(log.locationName);
  if (!locations.size) return 'Unassigned';
  return locations.size === 1 ? [...locations][0] : 'Multiple Locations';
}

function paymentLogLineTotal(log = {}) {
  return saleLineRows(log).reduce((sum, line) => sum + Math.abs(Number(line.totalIncl ?? line.totalImpact ?? line.salesValue ?? line.total ?? line.amount ?? line.price ?? 0) || 0), 0);
}

function paymentLogGrossTotal(log = {}) {
  return Number(
    log.total ??
    log.totalIncl ??
    log.totalAmount ??
    log.amount ??
    log.grossTotal ??
    log.grossSales ??
    log.orderTotal ??
    paymentLogLineTotal(log)
  ) || 0;
}

function paymentLogTip(log = {}) {
  const orderTip = Number(log.tipTotal ?? log.tipAmount ?? log.tip ?? log.gratuity ?? log.gratuityAmount ?? log.serviceChargeTip ?? 0) || 0;
  if (orderTip) return orderTip;
  return saleLineRows(log).reduce((sum, line) => sum + (Number(line.tipAmount ?? line.tipTotal ?? line.tip ?? line.gratuity ?? line.gratuityAmount ?? 0) || 0), 0);
}

function paymentLogTax(log = {}) {
  const orderTax = Number(log.taxTotal ?? log.taxAmount ?? log.tax ?? log.vatAmount ?? log.vatTotal ?? log.totalTax ?? log.totalVat ?? 0) || 0;
  if (orderTax) return orderTax;
  return saleLineRows(log).reduce((sum, line) => sum + (Number(line.taxAmount ?? line.taxTotal ?? line.tax ?? line.vatAmount ?? line.vatTotal ?? line.totalTax ?? line.totalVat ?? 0) || 0), 0);
}

function paymentEntries(log = {}) {
  const nested = toArray(log.payments || log.tenders || log.paymentLines || log.paymentDetails)
    .map((payment) => ({
      tender: payment.paymentMethod || payment.method || payment.tender || payment.type || payment.name || log.paymentMethod || log.tender || 'CARD',
      amount: Number(payment.amount ?? payment.total ?? payment.value ?? payment.grossAmount ?? payment.paidAmount ?? 0) || 0
    }))
    .filter((payment) => Math.abs(payment.amount) > 0);
  if (nested.length) return nested;

  const lineTenderTotals = saleLineRows(log).reduce((map, line) => {
    const tender = normalizeTender(line.paymentMethod || line.tender || line.paymentType || log.paymentMethod || log.tender || 'CARD');
    const total = Math.abs(Number(line.totalIncl ?? line.totalImpact ?? line.salesValue ?? line.total ?? line.amount ?? line.price ?? 0) || 0);
    if (total) map.set(tender, (map.get(tender) || 0) + total);
    return map;
  }, new Map());
  if (lineTenderTotals.size) {
    return [...lineTenderTotals.entries()].map(([tender, amount]) => ({ tender, amount }));
  }

  const fallbackTotal = Math.abs(paymentLogGrossTotal(log));
  return [{
    tender: log.paymentMethod || log.tender || log.paymentType || 'CARD',
    amount: fallbackTotal
  }];
}

function buildForecastRows(source, context) {
  const usage = new Map();
  source.logs_adj.filter((log) => inDateRange(logDate(log), { ...context, startDate: addDays(context.endDate, -29) })).forEach((log) => {
    if (!matchesLocationId(context, logLocationId(log))) return;
    if (String(log.mode || '').toLowerCase() === 'remove' || Number(log.impactQty || 0) < 0) {
      const itemId = String(log.stockItemId || log.itemId);
      const locationId = logLocationId(log) || context.defaultLocationId || DEFAULT_STOCK_LOCATION_ID;
      const key = forecastUsageKey(itemId, locationId);
      usage.set(key, (usage.get(key) || 0) + Math.abs(Number(log.qty || log.impactQty || 0)));
    }
  });
  source.logs_sales.filter((log) => inDateRange(logDate(log), { ...context, startDate: addDays(context.endDate, -29) })).forEach((log) => {
    saleMovementLines(log).forEach((line) => {
      if (!matchesLocationId(context, lineLocationId(line, log))) return;
      const id = String(stockMovementItemId(line) || '');
      if (!id) return;
      const locationId = lineLocationId(line, log) || context.defaultLocationId || DEFAULT_STOCK_LOCATION_ID;
      const key = forecastUsageKey(id, locationId);
      usage.set(key, (usage.get(key) || 0) + saleUsageQty(line, log));
    });
  });
  return source.ingredients.flatMap((item) => (
    reportLocationBalances(item, context).map(({ locationId, qty: currentStock }) => {
      const locationUsage = usage.get(forecastUsageKey(item.id, locationId)) || 0;
      const allLocationUsage = [...usage.entries()]
        .filter(([key]) => key.startsWith(`${String(item.id)}::`))
        .reduce((sum, [, value]) => sum + Number(value || 0), 0);
      const avg = ((context.locationId ? locationUsage : locationUsage || (allLocationUsage && !locationId ? allLocationUsage : 0)) || 0) / 30;
      const daysOfCover = avg > 0 ? Number(currentStock || 0) / avg : Number.POSITIVE_INFINITY;
      const suggestedQty = Math.max(0, Math.ceil((avg * context.forecastHorizon) - Number(currentStock || 0)));
      return {
        Item: item.name,
        Category: item.category || 'General',
        Location: locationName(context, locationId, context.defaultLocationName || DEFAULT_STOCK_LOCATION_NAME),
        Unit: item.unit || item.uom || '',
        Supplier: preferredSupplierName(item, source),
        'Avg Daily Usage': number(avg),
        'Current Stock': number(currentStock),
        'Days Remaining': avg > 0 ? number(daysOfCover) : 'No usage',
        'Days of Cover': avg > 0 ? number(daysOfCover) : 'No usage',
        'Predicted Stock-out Date': avg > 0 ? addDays(context.endDate || getTradeDateKey(new Date(), source.settings), Math.ceil(daysOfCover)) : 'No usage',
        'Risk Level': forecastRiskLevel(daysOfCover),
        'Suggested Reorder Qty': number(suggestedQty),
        Action: suggestedQty > 0 ? 'Reorder' : 'Monitor',
        _locationId: locationId,
        _unitCost: Number(item.cost || 0),
        _unit: item.unit || item.uom || ''
      };
    })
  )).filter((row) => passesCommon(row, context)).sort((a, b) => forecastDaysSortValue(a['Days Remaining']) - forecastDaysSortValue(b['Days Remaining']));
}

function preferredSupplierName(item = {}, source = {}) {
  const direct = item.supplierName || item.supplier || item.preferredSupplier || item.preferredSupplierName || item.defaultSupplier || '';
  if (direct) return direct;
  const supplierId = String(item.supplierId || item.preferredSupplierId || item.defaultSupplierId || '').trim();
  if (!supplierId) return 'Unassigned';
  const supplier = source.suppliers.find((entry) => String(entry.id || entry.supplierId || entry.name || '') === supplierId);
  return supplier?.name || supplier?.supplierName || 'Unassigned';
}

function forecastRiskLevel(daysOfCover) {
  if (!Number.isFinite(daysOfCover)) return 'Stable';
  if (daysOfCover <= 7) return 'Critical';
  if (daysOfCover <= 14) return 'High';
  if (daysOfCover <= 30) return 'Medium';
  return 'Stable';
}

function forecastUsageKey(itemId = '', locationId = '') {
  return `${String(itemId || '').trim()}::${String(locationId || '').trim()}`;
}

function forecastDaysSortValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

function buildVolatilityRows(source, context) {
  const rows = source.logs_grv.filter((log) => inDateRange(logDate(log), context)).flatMap((log) => (
    toArray(log.items).filter((line) => matchesLocationId(context, lineLocationId(line, log))).map((line) => {
      const item = context.ingredientMap.get(String(line.itemId || line.stockItemId || line.id)) || {};
      const unitCost = Number(line.unitCost ?? line.costEx ?? line.cost ?? item.cost ?? 0);
      return {
        Date: displayDate(logDate(log)),
        Item: line.name || line.stockItemName || item.name || '',
        Category: item.category || line.category || 'General',
        Location: line.locationName || locationName(context, lineLocationId(line, log), context.defaultLocationName || DEFAULT_STOCK_LOCATION_NAME),
        Supplier: log.supplier || log.supplierName || '',
        Invoice: log.invoice || log.grvNumber || '',
        'Qty Purchased': number(qty(line)),
        'Unit Cost': unitCost,
        _rawDate: logDate(log),
        _unitCost: unitCost
      };
    })
  )).filter((row) => passesCommon(row, context)).sort((a, b) => `${a.Item}${a._rawDate}`.localeCompare(`${b.Item}${b._rawDate}`));
  const previous = new Map();
  return rows.map((row) => {
    const prev = previous.get(row.Item);
    previous.set(row.Item, Number(row['Unit Cost'] || 0));
    return {
      ...row,
      'Unit Cost': currency(row['Unit Cost']),
      'Variance From Previous': prev === undefined ? '-' : currency(Number(row['Unit Cost']) - prev)
    };
  });
}

function buildVarianceRows(source, context) {
  const movement = new Map(buildMovementRows(source, { ...context, query: '' }).map((row) => [row.Item, row]));
  const theoretical = buildTheoreticalUsage(source, context);
  return source.ingredients.map((item) => {
    const move = movement.get(item.name) || {};
    const actual = Number(move['Sales Usage'] || 0) + Number(move.Wastage || 0);
    const theo = theoretical.get(String(item.id)) || 0;
    const variance = actual - theo;
    return {
      Ingredient: item.name,
      Category: item.category || 'General',
      Unit: item.unit || item.uom || '',
      'Actual Usage': number(actual),
      'Theoretical Usage': number(theo),
      'Variance Qty': number(variance),
      'Loss Value': currency(variance * Number(item.cost || 0)),
      _unit: item.unit || item.uom || ''
    };
  }).filter((row) => passesCommon(row, context)).filter((row) => ['Actual Usage', 'Theoretical Usage', 'Variance Qty'].some((key) => Number(row[key]) !== 0));
}

function buildMenuMatrixRows(source, context) {
  const volume = buildProductSalesVolume(source, context);
  const volumes = [...volume.values()].sort((a, b) => a - b);
  const medianVolume = volumes[Math.floor(volumes.length / 2)] || 0;
  return source.products.map((product) => {
    const price = Number(product.sellingPrice || product.price || 0);
    const cost = recipeCost(product, context.ingredientMap);
    const gp = price > 0 ? ((price - cost) / price) * 100 : 0;
    const qtySold = volume.get(String(product.id)) || volume.get(String(product.name)) || 0;
    return {
      'Menu Item': product.name || '',
      Category: product.category || 'General',
      'GP %': percent(gp),
      Volume: number(qtySold),
      Classification: classifyMenuItem(gp, qtySold, medianVolume),
      _gp: gp,
      _volume: qtySold
    };
  }).filter((row) => passesCommon(row, context)).sort((a, b) => b._volume - a._volume);
}

function buildWasteParetoRows(source, context) {
  const reasons = new Map();
  source.logs_adj.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    if (!matchesLocationId(context, logLocationId(log))) return;
    if (!isWastageAdjustmentLog(log)) return;
    const reason = log.wasteReason || log.reason || 'Other';
    const item = context.ingredientMap.get(String(log.stockItemId || log.itemId)) || {};
    // Derive loss = |qty| × unified last-purchase cost first; stored impact fallback.
    const loss = deriveCostImpact(log.qty ?? log.impactQty, item.cost, log.impactEx);
    const category = String(log.category || item.category || 'General').trim() || 'General';
    const locationLabel = locationName(context, logLocationId(log), context.defaultLocationName || DEFAULT_STOCK_LOCATION_NAME);
    const timestamp = log.createdAt || log.timestamp || log.date || '';
    const user = resolveReportActor(context, log, 'Unknown');
    const qtyValue = Math.abs(Number(log.qty ?? log.quantity ?? log.impactQty ?? 0));
    // Distinguish the two adjustment-based wastage sources: the dedicated product/menu-item wastage
    // flow (postWastageAdjustment) always writes adjustment_type='wastage' → mode==='wastage';
    // a manual stock adjustment tagged as wastage (e.g. a 'remove' carrying a wasteReason) is not.
    const source = String(log.mode || '').toLowerCase() === 'wastage' ? 'Product Wastage Adjustment' : 'Manual Adjustment';
    const key = `${source}::${reason}::${user}`;
    const current = reasons.get(key) || { reason, incidents: 0, loss: 0, locations: new Set(), users: new Set(), categoryLoss: new Map(), locationLoss: new Map(), events: [] };
    current.incidents += 1;
    current.loss += loss;
    current.locations.add(locationLabel);
    current.users.add(user);
    current.categoryLoss.set(category, (current.categoryLoss.get(category) || 0) + loss);
    current.locationLoss.set(locationLabel, (current.locationLoss.get(locationLabel) || 0) + loss);
    current.events.push({
      Date: displayDate(logDate(log)),
      Time: displayTime(timestamp),
      Reason: reason,
      User: user,
      Item: log.stockItemName || log.itemName || item.name || 'Stock item',
      Category: category,
      Location: locationLabel,
      Quantity: `${number(qtyValue)}${log.unit || item.unit || item.uom ? ` ${log.unit || item.unit || item.uom}` : ''}`,
      'Loss Value': currency(loss),
      Note: log.note || log.notes || log.reason || '',
      Source: source,
      _ts: timestamp,
      _loss: loss
    });
    reasons.set(key, current);
  });
  source.logs_mfg.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    if (!matchesLocationId(context, logLocationId(log))) return;
    const variance = Math.max(getManufacturingVarianceQty(log), 0);
    if (!(variance > 0)) return;
    const reason = 'Manufacturing Variance';
    const loss = getManufacturingWastageValue(log);
    const category = String(log.category || log.itemCategory || 'Manufacturing').trim() || 'Manufacturing';
    const locationLabel = locationName(context, logLocationId(log), context.defaultLocationName || DEFAULT_STOCK_LOCATION_NAME);
    const timestamp = log.createdAt || log.timestamp || log.postedAt || log.date || '';
    const user = resolveReportActor(context, log, 'Unknown');
    const unit = log.unit || log.uom || '';
    const key = `Manufacture Wastage::${reason}::${user}`;
    const current = reasons.get(key) || { reason, incidents: 0, loss: 0, locations: new Set(), users: new Set(), categoryLoss: new Map(), locationLoss: new Map(), events: [] };
    current.incidents += 1;
    current.loss += loss;
    current.locations.add(locationLabel);
    current.users.add(user);
    current.categoryLoss.set(category, (current.categoryLoss.get(category) || 0) + loss);
    current.locationLoss.set(locationLabel, (current.locationLoss.get(locationLabel) || 0) + loss);
    current.events.push({
      Date: displayDate(logDate(log)),
      Time: displayTime(timestamp),
      Reason: reason,
      User: user,
      Item: log.stockItemName || log.itemName || log.name || 'Manufactured item',
      Category: category,
      Location: locationLabel,
      Quantity: `${number(variance)}${unit ? ` ${unit}` : ''}`,
      'Loss Value': currency(loss),
      Note: log.note || log.notes || 'Actual yield below expected yield',
      Source: 'Manufacture Wastage',
      _ts: timestamp,
      _loss: loss
    });
    reasons.set(key, current);
  });
  const rows = [...reasons.values()].sort((a, b) => b.loss - a.loss);
  const total = rows.reduce((sum, row) => sum + row.loss, 0);
  let cumulative = 0;
  return rows.map((row) => {
    cumulative += row.loss;
    return {
      'Waste Reason': row.reason,
      Location: summarizeSet(row.locations, 'locations'),
      User: summarizeSet(row.users, 'users'),
      Incidents: String(row.incidents),
      'Total Loss Value': currency(row.loss),
      'Cumulative %': percent(total ? (cumulative / total) * 100 : 0),
      'Top Category': topMapLabel(row.categoryLoss, 'General'),
      _share: total ? (row.loss / total) * 100 : 0,
      _loss: row.loss,
      _cumulative: total ? (cumulative / total) * 100 : 0,
      _categoryLoss: Object.fromEntries(row.categoryLoss),
      _locationLoss: Object.fromEntries(row.locationLoss),
      _events: row.events
    };
  }).filter((row) => passesSearch(row, context));
}

function topMapLabel(map = new Map(), fallback = '') {
  return [...map.entries()].sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0]?.[0] || fallback;
}

function summarizeSet(values = new Set(), label = 'values') {
  const list = [...values].map((value) => String(value || '').trim()).filter(Boolean);
  if (!list.length) return '';
  if (list.length <= 2) return list.join(', ');
  return `${list.length} ${label}`;
}

function buildYocoSalesRows(source, context) {
  const rowsByKey = new Map();

  source.logs_sales.forEach((log) => {
    const details = toArray(log.details);
    const saleLines = toArray(log.saleLines);
    const isYoco = String(log.sourceProvider || log.source || '').toLowerCase().includes('yoco') ||
      details.some((detail) => String(detail.source || '').toLowerCase().includes('yoco')) ||
      saleLines.some((line) => String(line.source || '').toLowerCase().includes('yoco'));
    if (!isYoco) return;

    if (saleLines.length) {
      saleLines.forEach((line) => {
        const locationId = lineLocationId(line, log);
        if (context.locationId && locationId !== context.locationId) return;

        const date = String(line.saleDate || log.date || log.saleDateEnd || logDate(log)).slice(0, 10);
        if (!inDateRange(date, context)) return;

        const typeLabel = isRefundLine(line, log) ? 'Refunded' : 'Sale';
        const qty = Number(line.qtySold ?? line.quantity ?? line.qty ?? 0);
        const totalImpact = Number(line.totalIncl ?? line.totalImpact ?? line.salesValue ?? 0);
        const lineKey = String(line.saleLineKey || line.id || [
          line.orderId || log.orderId || '',
          line.lineItemId || line.id || '',
          line.productId || '',
          line.productName || '',
          locationId,
          line.status || log.syncMode || ''
        ].join('|')).trim();

        rowsByKey.set(lineKey, {
          date,
          timestamp: String(line.timestamp || log.timestamp || log.createdAt || '').trim(),
          type: typeLabel,
          name: String(line.productName || line.pname || line.name || log.productName || 'Yoco Item').trim(),
          status: productStatusLabel(resolveProductForLine(line, log, context)),
          qty,
          totalImpact,
          location: String(line.locationName || log.locationName || '').trim() || locationName(context, locationId, 'Unspecified'),
          orderId: String(line.orderId || log.orderId || '').trim(),
          orderNumber: String(line.orderNumber || log.orderNumber || '').trim()
        });
      });
      return;
    }

    details.forEach((detail) => {
      const detailSource = String(detail.source || log.sourceProvider || log.source || '').toLowerCase();
      if (!detailSource.includes('yoco')) return;

      const itemName = String(detail.pname || detail.product || detail.ingName || detail.productName || '').trim();
      if (!itemName) return;

      const locationId = lineLocationId(detail, log);
      if (context.locationId && locationId !== context.locationId) return;

      const date = String(detail.saleDate || log.date || log.saleDateEnd || logDate(log)).slice(0, 10);
      if (!inDateRange(date, context)) return;

      const lineKey = String(detail.saleLineKey || [
        detail.orderId || '',
        detail.originalOrderId || '',
        detail.lineItemId || detail.originalLineItemId || '',
        itemName,
        locationId,
        detail.syncMode || ''
      ].join('|')).trim();
      const typeLabel = String(detail.saleType || detail.syncMode || detail.status || log.status || '').toLowerCase().includes('refund')
        ? 'Refunded'
        : 'Sale';
      const location = String(detail.locName || detail.locationName || '').trim() || locationName(context, locationId, 'Unspecified');
      const orderId = String(detail.originalOrderId || detail.orderId || log.orderId || log.integrationOrderId || '').trim();
      const orderNumber = String(detail.orderNumber || log.orderNumber || '').trim();
      const existing = rowsByKey.get(lineKey) || {
        date,
        timestamp: String(detail.timestamp || log.timestamp || '').trim(),
        type: typeLabel,
        name: itemName,
        status: productStatusLabel(resolveProductForLine(detail, log, context)),
        qty: Number(detail.qtySold || 0),
        totalImpact: 0,
        location,
        orderId,
        orderNumber
      };

      existing.totalImpact += Number(detail.impact || detail.totalImpact || 0);
      existing.qty = existing.qty || Number(detail.qtySold || 0);
      rowsByKey.set(lineKey, existing);
    });
  });

  return [...rowsByKey.values()]
    .map((row) => {
      const isRefund = /refund/i.test(row.type);
      const impact = Math.abs(Number(row.totalImpact || 0));
      const signedImpact = isRefund ? -impact : impact;
      const qty = Math.abs(Number(row.qty || 0));
      const signedQty = isRefund ? -qty : qty;
      const orderLabel = row.orderId || row.orderNumber || 'N/A';
      return {
        Date: row.date,
        Time: displayTime(row.timestamp || row.date),
        'Sale / Refund': row.type,
        'Item Name': row.name,
        'Item Status': row.status || 'Active',
        'Qty Sold': signedQty >= 0 ? `+${signedQty.toFixed(2)}` : signedQty.toFixed(2),
        'Total Impact': signedImpact >= 0 ? `+${currency(signedImpact)}` : `-${currency(Math.abs(signedImpact))}`,
        Location: row.location || 'Unspecified',
        Action: 'View',
        _orderId: orderLabel,
        _orderKey: orderLabel,
        _rowId: `${orderLabel}:${row.name}:${row.date}:${row.type}`,
        _isRefund: isRefund,
        _impact: signedImpact,
        _qty: signedQty,
        _unit: 'ea',
        _sort: row.timestamp || row.date
      };
    })
    .filter((row) => passesReportFilters(row, context))
    .sort((a, b) => String(b._sort || '').localeCompare(String(a._sort || '')));
}

function buildReportSummary(reportId, rows, source, context) {
  const dashboard = calculateDashboardMetrics(source, context.endDate).summary || {};
  return [
    { label: 'Rows', value: String(rows.length) },
    { label: 'Stock Value', value: dashboard.stockValue?.value || currency(0) },
    { label: 'Purchases', value: dashboard.purchases?.value || currency(0) },
    { label: 'Wastage', value: dashboard.wastage?.value || currency(0) }
  ];
}

function buildTheoreticalUsage(source, context) {
  const usage = new Map();
  const productsByName = new Map(source.products.map((product) => [String(product.name || '').toLowerCase(), product]));
  source.logs_sales.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    toArray(log.details || log.saleLines || log.items || [log]).forEach((line) => {
      if (!matchesLocationId(context, lineLocationId(line, log))) return;
      if (stockMovementItemId(line) && line.qtyDepleted !== undefined) {
        const id = String(stockMovementItemId(line));
        if (!id) return;
        usage.set(id, (usage.get(id) || 0) + saleUsageQty(line, log));
        return;
      }
      const product = context.productMap.get(String(line.productId || line.itemId || '')) || productsByName.get(String(line.productName || line.pname || line.name || '').toLowerCase());
      if (!product) return;
      const sold = saleSoldQty(line);
	      getEffectiveProductRecipe(product).forEach((recipeLine) => {
        const id = String(recipeLine.ingId || recipeLine.itemId || recipeLine.stockItemId || '');
        usage.set(id, (usage.get(id) || 0) + sold * Number(recipeLine.qty || recipeLine.quantity || 0));
      });
    });
  });
  return usage;
}

function buildProductSalesVolume(source, context) {
  const volume = new Map();
  source.logs_sales.filter((log) => inDateRange(logDate(log), context)).forEach((log) => {
    toArray(log.saleLines || log.details || log.items || [log]).forEach((line) => {
      if (isModifierSaleLine(line)) return;
      if (!matchesLocationId(context, lineLocationId(line, log))) return;
      const id = String(line.productId || line.productID || line.productName || line.pname || line.name || '');
      if (!id) return;
      volume.set(id, (volume.get(id) || 0) + saleSoldQty(line));
    });
  });
  return volume;
}

function classifyMenuItem(gp, volume, medianVolume) {
  const highGp = gp >= 60;
  const highVolume = volume >= medianVolume && volume > 0;
  if (highGp && highVolume) return 'Star';
  if (highGp && !highVolume) return 'Puzzle';
  if (!highGp && highVolume) return 'Workhorse';
  return 'Dog';
}

function saleMovementLines(log) {
  return toArray(log.stockMovements || log.ingredientMovements || log.movements || log.depletions || log.details || log.items)
    .filter((line) => isSaleStockMovementLine(line) && stockMovementItemId(line) && saleMovementQty(line) !== 0);
}

function isSaleStockMovementLine(line = {}) {
  return [
    line.qtyDepleted,
    line.depletedQty,
    line.impactQty,
    line.ingredientId,
    line.ingId,
    line.stockItemId,
    line.ingredientName,
    line.stockItemName,
    line.ingName
  ].some((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function saleLineRows(log = {}) {
  return toArray(log.saleLines || log.lines || log.items || [log])
    .filter((line) => {
      const name = line.productName || line.pname || line.name || log.productName || log.itemName || log.name;
      return String(name || '').trim() && saleSoldQty(line) !== 0;
    });
}

function saleLineDate(line = {}, log = {}) {
  return String(line.saleDate || line.date || line.timestamp || logDate(log)).slice(0, 10);
}

function saleProductKey(line = {}, log = {}) {
  return String(
    line.productId ||
    line.productID ||
    line.yocoItemId ||
    line.yocoVariantId ||
    line.productName ||
    line.pname ||
    line.name ||
    log.productId ||
    log.productName ||
    ''
  ).trim().toLowerCase();
}

function saleSoldLabel(line = {}, log = {}) {
  const qty = Math.abs(saleSoldQty(line));
  if (!qty) return number(0);
  return isRefundLine(line, log) ? `-${number(qty)}` : number(qty);
}

function saleLineSalesValue(line = {}) {
  const rawFallback = yocoMoneyValue(line.raw || line.rawJson || line.sourceLine || line, [
    'total_price',
    'totalPrice',
    'net_amount',
    'netAmount'
  ]);
  const yocoFallback = Number(line.yocoLineTotal || line.yocoTotal || line.rawTotal || rawFallback || 0) || 0;
  if (isModifierSaleLine(line) && yocoFallback) return yocoFallback;
  const explicit = [
    line.totalEx,
    line.lineTotalEx,
    line.totalImpact,
    line.lineTotal,
    line.total,
    line.subtotal,
    line.amount
  ].find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  if (explicit !== undefined) {
    const numeric = Number(explicit || 0) || 0;
    return numeric || yocoFallback;
  }
  if (yocoFallback) return yocoFallback;

  const unitPrice = [
    line.unitPrice,
    line.sellingPrice,
    line.priceEx,
    line.price
  ].find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  return (Number(unitPrice || 0) || 0) * Math.abs(saleSoldQty(line));
}

function yocoMoneyValue(source = {}, fields = []) {
  if (!source || typeof source !== 'object') return 0;
  for (const field of fields) {
    const value = moneyLikeToNumber(source[field]);
    if (value !== null) return value;
  }
  return 0;
}

function moneyLikeToNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') {
    return moneyLikeToNumber(value.amount ?? value.value ?? value.total);
  }
  const numeric = Number(String(value).replace(/\s/g, '').replace(/[^\d,.-]/g, '').replace(',', '.'));
  if (!Number.isFinite(numeric)) return null;
  return Math.abs(numeric) > 999 ? numeric / 100 : numeric;
}

// Derive a cost/impact value from qty × unit cost FIRST; only fall back to a
// stored impact field when we can't compute one (missing qty or cost). Stored
// impactEx/impact were written at sale/adjustment time with possibly-stale/zero
// costs — the same unreliable class as the corrupt Yoco tax field — so we no
// longer trust them ahead of the unified last-purchase unit cost.
function deriveCostImpact(qty, unitCost, storedImpact) {
  const q = Math.abs(Number(qty || 0));
  const c = Math.abs(Number(unitCost || 0));
  if (q > 0 && c > 0) return q * c;
  const stored = Number(storedImpact);
  return Number.isFinite(stored) ? Math.abs(stored) : 0;
}

function buildOpsCategoryItemMetrics(source, context) {
  const metrics = new Map();
  const ensure = (itemId) => {
    const key = String(itemId || '').trim();
    if (!key) return null;
    if (!metrics.has(key)) {
      metrics.set(key, {
        purchases: 0,
        cosActual: 0,
        countVariance: 0,
        manualAdjustments: 0,
        wastage: 0
      });
    }
    return metrics.get(key);
  };

  source.logs_grv
    .filter((log) => inDateRange(logDate(log), context))
    .forEach((log) => {
      toArray(log.items).forEach((line) => {
        if (!matchesLocationId(context, lineLocationId(line, log))) return;
        const itemId = String(line.itemId || line.stockItemId || line.id || '').trim();
        const target = ensure(itemId);
        if (!target) return;
        target.purchases += sumItems([line], 'lineTotalEx');
      });
    });

  source.logs_cn
    .filter((log) => inDateRange(logDate(log), context))
    .forEach((log) => {
      toArray(log.items).forEach((line) => {
        if (!matchesLocationId(context, lineLocationId(line, log))) return;
        const itemId = String(line.itemId || line.stockItemId || line.id || '').trim();
        const target = ensure(itemId);
        if (!target) return;
        target.purchases -= sumItems([line], 'lineTotalEx');
      });
    });

  source.logs_sales
    .filter((log) => inDateRange(logDate(log), context))
    .forEach((log) => {
      saleMovementLines(log).forEach((line) => {
        if (!matchesLocationId(context, lineLocationId(line, log))) return;
        const target = ensure(stockMovementItemId(line));
        if (!target) return;
        target.cosActual += Math.abs(saleLineCostImpact(line, log, context.ingredientMap));
      });
    });

  source.logs_stocktakes
    .filter((log) => inDateRange(logDate(log), context))
    .forEach((log) => {
      toArray(log.items).forEach((line) => {
        if (!matchesLocationId(context, lineLocationId(line, log))) return;
        const target = ensure(line.id || line.itemId || line.stockItemId);
        if (!target) return;
        target.countVariance += opsDashboardLineImpact(line, context);
      });
    });

  source.logs_adj
    .filter((log) => inDateRange(logDate(log), context))
    .forEach((log) => {
      if (!matchesLocationId(context, logLocationId(log))) return;
      const itemId = String(log.stockItemId || log.itemId || '').trim();
      const target = ensure(itemId);
      if (!target) return;
      const item = context.ingredientMap.get(itemId) || {};
      const qty = Number(log.impactQty ?? log.qty ?? 0);
      const unitCost = Number(item.cost || 0) || 0;
      const derived = (qty !== 0 && unitCost > 0) ? qty * unitCost : Number(log.impactEx || 0);
      if (isWastageAdjustmentLog(log)) target.wastage += Math.abs(Number.isFinite(derived) ? derived : 0);
      else target.manualAdjustments += Number.isFinite(derived) ? derived : 0;
    });

  source.logs_mfg
    .filter((log) => inDateRange(logDate(log), context))
    .forEach((log) => {
      if (!matchesLocationId(context, logLocationId(log))) return;
      const target = ensure(log.itemId || log.manufacturedItemId || log.stockItemId);
      if (!target) return;
      target.wastage += getManufacturingWastageValue(log);
    });

  return metrics;
}

function saleLineCostImpact(line = {}, log = {}, ingredientMap = null) {
  const lineKey = saleProductKey(line, log);
  const movementTotal = saleMovementLines(log)
    .filter((movement) => !lineKey || saleProductKey(movement, log) === lineKey)
    .reduce((sum, movement) => {
      // Prefer qty × unified last-purchase cost; stored impact only as fallback.
      const item = ingredientMap ? ingredientMap.get(String(stockMovementItemId(movement))) : null;
      const unitCost = Number(item?.cost ?? movement.unitCost ?? movement.cost ?? 0) || 0;
      const stored = movement.impactEx ?? movement.impact ?? movement.valueDelta ?? movement.totalImpact;
      return sum + deriveCostImpact(saleMovementQty(movement), unitCost, stored);
    }, 0);
  if (movementTotal > 0) {
    return isRefundLine(line, log) ? -movementTotal : movementTotal;
  }
  // No movement lines resolved a cost — fall back to any stored line-level impact.
  const explicit = line.cosImpact ?? line.costOfSales ?? line.costOfSalesImpact ?? line.impactEx ?? line.impact;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const value = Math.abs(Number(explicit) || 0);
    return isRefundLine(line, log) ? -value : value;
  }
  return 0;
}

function syncSourceLabel(line = {}, log = {}) {
  const source = log.source || log.sourceProvider || line.source || 'Yoco';
  return isRefundLine(line, log) ? `${source} refund` : `${source} sale`;
}

function addMovement(map, id, key, value) {
  const entry = map.get(String(id || ''));
  if (!entry) return;
  entry[key] += Number(value || 0);
}

function stockMovementItemId(line = {}) {
  return line.ingredientId || line.ingId || line.stockItemId || line.itemId || line.id;
}

function saleMovementQty(line = {}) {
  return Number(line.qtyDepleted ?? line.depletedQty ?? line.impactQty ?? line.qty ?? line.quantity ?? 0) || 0;
}

function saleUsageQty(line = {}, log = {}) {
  const raw = saleMovementQty(line);
  if (!raw) return 0;
  return isRefundLine(line, log) ? -Math.abs(raw) : Math.abs(raw);
}

function isRefundLine(line = {}, log = {}) {
  return [
    line.syncMode,
    line.status,
    line.saleType,
    log.syncMode,
    log.status
  ].some((value) => String(value || '').toLowerCase().includes('refund'));
}

function saleSoldQty(line = {}) {
  return Number(line.qtySold ?? line.soldQty ?? line.qty ?? line.quantity ?? 0) || 0;
}

function sumItems(items, field = '') {
  return toArray(items).reduce((sum, item) => {
    const fallback = Number(
      item.totalEx ??
      (Number(item.baseQuantity ?? item.qty ?? item.quantity ?? item.receivedQty ?? item.returnedQty ?? item.packQty ?? 0) * Number(item.unitCost ?? item.cost ?? item.costEx ?? 0))
    ) || 0;
    if (field && item[field] !== undefined) {
      const value = Number(item[field] || 0);
      return sum + (value || fallback);
    }
    return sum + (Number(item.lineTotalEx || 0) || fallback);
  }, 0);
}

function reportTotalEx(log = {}) {
  const itemTotal = sumItems(log.items, 'lineTotalEx');
  const savedTotal = Number(log.totalEx ?? log.total ?? 0) || 0;
  return savedTotal || itemTotal;
}

function recipeCost(product, ingredientMap) {
  return getEffectiveProductRecipe(product).reduce((sum, line) => {
    const id = String(line.ingId || line.itemId || line.stockItemId);
    // Nested, yield-aware unit cost (matches the Dashboard engine): manufactured
    // sub-recipes are costed from their own recipe / yield rather than a (often 0)
    // last-purchase price. Falls back to the ingredient valuation / line cost.
    const ingredient = ingredientMap.get(id);
    const nestedCost = getIngredientUnitCost(id, ingredientMap);
    const unitCost = nestedCost || Number(ingredient?.cost ?? line.cost ?? 0) || 0;
    return sum + Number(line.qty || line.quantity || 0) * unitCost;
  }, 0);
}

function getEffectiveProductRecipe(product = {}) {
  const directRecipe = toArray(product.recipe);
  if (directRecipe.length) return directRecipe;
  return toArray(product.effectiveRecipe || product.effectiveRecipeLines || product.recipeSourceRecipeLines || product.recipeSourceStockItem?.recipe || []);
}

function passesCommon(row, context) {
  if (context.category && String(row.Category || '') !== context.category) return false;
  // Prefer an explicit row location id when present (robust to name-fallback mismatches);
  // otherwise compare display names using the same fallback the row builders use.
  if (context.locationId) {
    if (row._locationId !== undefined) {
      if (String(row._locationId || '') !== String(context.locationId || '')) return false;
    } else if (row.Location && row.Location !== locationName(context, context.locationId, DEFAULT_STOCK_LOCATION_NAME)) {
      return false;
    }
  }
  return passesSearch(row, context);
}

function isLowStockEligibleItem(item = {}) {
  if (item.isSubRecipe === true) return false;
  const explicit = String(item.itemType || item.stockItemType || item.specificationType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['sub_recipe', 'subrecipe'].includes(explicit)) return false;
  const category = String(item.category || '').toLowerCase();
  return !category.includes('sub recipe') && !category.includes('sub-recipe');
}

function isOpsReportEligibleItem(item = {}) {
  return !isArchived(item) && isLowStockEligibleItem(item);
}

function passesReportFilters(row, context, locationKeys = ['Location']) {
  if (!passesLocation(row, context, locationKeys)) return false;
  return passesSearch(row, context);
}

function passesLocation(row, context, locationKeys = ['Location']) {
  if (!context.locationId) return true;
  const selected = locationName(context, context.locationId, '');
  return locationKeys.some((key) => String(row[key] || '') === selected);
}

function passesSearch(row, context) {
  if (!context.query) return true;
  return Object.entries(row)
    .filter(([key]) => !key.startsWith('_'))
    .some(([, value]) => String(value || '').toLowerCase().includes(context.query));
}

function inDateRange(date, context) {
  const key = String(date || '').slice(0, 10);
  if (!key) return true;
  return (!context.startDate || key >= context.startDate) && (!context.endDate || key <= context.endDate);
}

function logDate(log = {}) {
  return String(log.date || log.timestamp || log.createdAt || log.updatedAt || '').slice(0, 10);
}

function getTimestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value < 10000000000 ? value * 1000 : value;
  if (typeof value === 'object' && typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function titleCase(value = '') {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function logLocationId(log = {}) {
  return String(log.locationId || log.locId || log.targetLocation || log.targetLocationId || '').trim();
}

function lineLocationId(line = {}, log = {}) {
  return String(line.locationId || line.locId || line.targetLocation || line.targetLocationId || logLocationId(log)).trim();
}

function transferFromId(log = {}) {
  return String(log.from || log.fromLocationId || log.sourceLocationId || '').trim();
}

function transferToId(log = {}) {
  return String(log.to || log.toLocationId || log.destinationLocationId || '').trim();
}

function matchesLocationId(context, locationId) {
  return !context.locationId || String(locationId || '').trim() === context.locationId;
}

function itemStockForContext(item = {}, context) {
  if (!context.locationId) return Number(item.stock || 0);
  return Number(item.balances?.[context.locationId] || 0);
}

function reportLocationBalances(item = {}, context = {}) {
  const knownLocationIds = context.locationIds || new Set();
  const balances = item.balances && typeof item.balances === 'object' ? item.balances : {};
  const locationRows = Object.entries(balances)
    .map(([locationId, qty]) => ({
      locationId: String(locationId || '').trim(),
      qty: Number(qty || 0) || 0
    }))
    .filter(({ locationId }) => !isAggregateLocationId(locationId))
    .filter(({ locationId }) => !knownLocationIds.size || knownLocationIds.has(locationId));

  if (!context.locationId) {
    const nonZeroRows = locationRows.filter(({ qty }) => qty !== 0);
    if (nonZeroRows.length) return nonZeroRows;

    return [{
      locationId: context.defaultLocationId || DEFAULT_STOCK_LOCATION_ID,
      qty: Number(item.stock || 0) || 0
    }];
  }

  const rowsForSelectedLocation = locationRows.filter(({ locationId }) => locationId === context.locationId);
  if (rowsForSelectedLocation.length) return rowsForSelectedLocation;

  const fallbackLocationId = [
    item.locationId,
    item.defaultLocationId,
    item.targetLocationId,
    item.targetLocation,
    context.defaultLocationId,
    context.locations?.[0]?.id
  ]
    .map((value) => String(value || '').trim())
    .find((locationId) => (
      locationId &&
      !isAggregateLocationId(locationId) &&
      (!knownLocationIds.size || knownLocationIds.has(locationId))
    ));

  return [{
    locationId: fallbackLocationId || context.defaultLocationId || DEFAULT_STOCK_LOCATION_ID,
    qty: Number(item.stock || 0) || 0
  }];
}

function reportLowStockLocationBalances(item = {}, context = {}) {
  const balances = item.balances && typeof item.balances === 'object' ? item.balances : {};
  const locations = context.locations || [];
  const hasBalanceAt = (locationId) => {
    const key = resolveBalanceKey(balances, locationId, locations);
    return Boolean(key && Object.prototype.hasOwnProperty.call(balances, key));
  };

  // Location filter: only surface the item at the selected location if it is actually
  // stocked there (has a resolvable balance entry). This uses the same fuzzy resolver
  // as the rest of the app and stops "every item shows as low at qty 0".
  if (context.locationId) {
    if (!hasBalanceAt(context.locationId)) return [];
    return [{ locationId: context.locationId, qty: getLocationStock(item, context.locationId, locations) }];
  }

  // No filter: one row per workspace location where the item holds a balance
  // (prevents one row per every location — the duplicate-per-location bug).
  const knownLocationIds = context.locationIds || new Set();
  const seen = new Set();
  const rows = [];
  locations.forEach((location) => {
    const locationId = String(location.id || location.locationId || '').trim();
    if (!locationId || isAggregateLocationId(locationId)) return;
    if (knownLocationIds.size && !knownLocationIds.has(locationId)) return;
    if (!hasBalanceAt(locationId) || seen.has(locationId)) return;
    seen.add(locationId);
    rows.push({ locationId, qty: getLocationStock(item, locationId, locations) });
  });

  // Fallback: item has no balance keyed to a known location (legacy/never-stocked) —
  // surface it once at the default location so genuinely-low items aren't hidden.
  if (!rows.length) {
    const total = sumBalances(balances) || Number(item.stock || 0) || 0;
    rows.push({ locationId: context.defaultLocationId || DEFAULT_STOCK_LOCATION_ID, qty: total });
  }
  return rows;
}

function findDefaultStockLocation(locations = []) {
  return locations.find((location) => location?.isDefault === true || String(location?.id || '') === DEFAULT_STOCK_LOCATION_ID) ||
    locations.find((location) => String(location?.type || '').toLowerCase() === 'storage') ||
    locations[0] ||
    null;
}

function isAggregateLocationId(locationId = '') {
  const normalized = String(locationId || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return !normalized || ['all', 'alllocations', 'total', 'aggregate', 'combined'].includes(normalized);
}

function resolveLowStockThreshold(item = {}) {
  const value = Number(item.lowStockThreshold || item.threshold || item.parLevel || 5);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

function isArchived(item = {}) {
  return item.archived === true ||
    item.deleted === true ||
    item.active === false ||
    String(item.status || '').toLowerCase() === 'archived' ||
    String(item.catalogueStatus || '').toLowerCase() === 'archived';
}

function displayDate(date) {
  return String(date || '').slice(0, 10);
}

function displayTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleTimeString('en-ZA', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }
  const match = text.match(/T?(\d{2}:\d{2})/);
  return match?.[1] || '';
}

function reportTimestamp(log = {}) {
  return log.createdAt || log.updatedAt || log.modifiedAt || log.timestamp || log.postedAt || log.date || '';
}

function locationName(context, id, fallback = '') {
  const location = context.locationMap.get(String(id || ''));
  // Never leak a raw location id (e.g. loc_WS-…_main) to the UI/export. If the id
  // isn't in the map, use the caller's fallback, else a generic readable label.
  return location?.displayName || location?.name || fallback || (id ? 'Unknown location' : '');
}

function resolveProductForLine(line = {}, log = {}, context = {}) {
  const id = String(line.productId || line.productID || line.itemId || line.menuItemId || '').trim();
  if (id && context.productMap?.has(id)) return context.productMap.get(id);
  const variantId = String(line.yocoVariantId || line.variantId || line.variant_id || '').trim();
  if (variantId && context.productByYocoVariantId?.has(variantId)) return context.productByYocoVariantId.get(variantId);
  const itemId = String(line.yocoItemId || line.item_id || log.yocoItemId || '').trim();
  if (itemId && context.productByYocoItemId?.has(itemId)) return context.productByYocoItemId.get(itemId);
  const name = String(line.productName || line.pname || line.name || log.productName || '').trim().toLowerCase();
  if (name && context.productByName?.has(name)) return context.productByName.get(name);
  return null;
}

function productStatusLabel(product) {
  if (!product) return 'Active';
  return product.archived || product.deleted || product.active === false || String(product.catalogueStatus || '').toLowerCase() === 'archived'
    ? 'Archived'
    : 'Active';
}

function isMainMenuProduct(product = {}) {
  if (productStatusLabel(product) === 'Archived') return false;
  const id = String(product.id || '').trim().toLowerCase();
  const category = String(product.category || '').trim().toLowerCase();
  const ownerType = String(product.recipeOwnerType || product.ownerType || '').trim().toLowerCase();
  const source = String(product.source || product.recipeSource || '').trim().toLowerCase();
  return !id.startsWith('modifier:') &&
    ownerType !== 'yoco_modifier' &&
    !category.startsWith('modifier -') &&
    !source.includes('yoco modifier');
}

function normalizeIngredients(value) {
  return toArray(value).map((item) => {
    const balances = item?.balances && typeof item.balances === 'object' ? item.balances : {};
    const stock = Object.keys(balances).length
      ? Object.entries(balances)
        .filter(([locationId]) => !isAggregateLocationId(locationId))
        .reduce((sum, [, qty]) => sum + Number(qty || 0), 0)
      : Number(item?.stock || 0);
    // Single unit-cost basis for ALL reports = last purchase price (matches the
    // Dashboard engine): lastPurchasePrice -> lastPurchaseCost -> latestPurchasePrice
    // -> costEx -> cost. The manual/stored cost is only the final fallback. This is
    // the fix for COS/stock-value showing 0 when an item is priced only via
    // purchases. Raw fields survive via the `...item` spread above.
    const valuationCost = getStockValuationUnitCost(item);
    const manualCost = Number(item.cost ?? item.costEx ?? item.Ex_VAT_Cost ?? 0) || 0;
    return {
      ...item,
      id: String(item.id || item.ID || item.name || ''),
      name: item.name || item.Name || item.itemName || '',
      category: item.category || item.Category || 'General',
      unit: item.unit || item.Unit || 'ea',
      cost: valuationCost || manualCost,
      costManual: manualCost,
      costMissing: !(valuationCost || manualCost),
      stock,
      balances
    };
  });
}

function normalizeProducts(value) {
  return toArray(value).map((item) => ({
    ...item,
    id: String(item.id || item.ProductID || item.ID || item.name || ''),
    name: item.name || item.ProductName || item.productName || '',
    category: item.category || item.Category || 'General',
    sellingPrice: Number(item.sellingPrice ?? item.SellingPrice ?? item.price ?? 0),
    yocoItemId: item.yocoItemId || '',
    yocoVariantId: item.yocoVariantId || '',
    archived: item.archived === true || item.deleted === true || item.active === false || String(item.catalogueStatus || '').toLowerCase() === 'archived',
    deleted: item.deleted === true,
    active: item.active !== false,
    catalogueStatus: item.catalogueStatus || (item.archived || item.deleted || item.active === false ? 'archived' : 'active'),
    recipe: toArray(item.recipe)
  }));
}

function normalizeLocations(value) {
  return toArray(value).map((item) => ({
    ...item,
    id: String(item.id || item.ID || item.name || ''),
    name: item.name || item.label || item.id || 'Location'
  }));
}

function normalizeSuppliers(value) {
  return toArray(value).map((item) => ({
    ...item,
    id: String(item.id || item.name || ''),
    name: item.name || item.supplierName || ''
  }));
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, item]) => item && typeof item === 'object')
      .map(([id, item]) => ({ id: item.id || id, ...item }));
  }
  return [];
}

function qty(line = {}) {
  return Number(line.qty ?? line.usage ?? line.quantity ?? line.receivedQty ?? line.purchasedQty ?? line.depletedQty ?? 0) || 0;
}

function normalizeTender(value = '') {
  const text = String(value || '').trim().toUpperCase();
  if (text.includes('CASH')) return 'CASH';
  if (text.includes('EFT')) return 'EFT';
  if (text.includes('OFFLINE')) return 'OFFLINE_CARD';
  if (text.includes('CARD') || text.includes('YOCO')) return 'CARD';
  return text || 'UNKNOWN';
}

function addDays(dateKey, offset) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function number(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toFixed(3).replace(/\.?0+$/, '') : '0';
}

function currency(value) {
  return `R ${Number(value || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseCurrencyValue(value) {
  const normalized = String(value ?? '')
    .replace(/R/gi, '')
    .replace(/\s/g, '')
    .replace(/,/g, '.')
    .replace(/[^\d.-]/g, '');
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : 0;
}

function percent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function sortBy(key) {
  return (left, right) => String(left[key] || '').localeCompare(String(right[key] || ''));
}

function sortReportRows(reportId, rows = []) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  if (['stock', 'movement', 'low_stock', 'menu', 'missing_recipes', 'ops_overview', 'ops_dashboard', 'forecast', 'variance', 'waste_pareto'].includes(reportId)) {
    return rows;
  }

  const hasDate = rows.some((row) => row?._sortDate || row?._sort || row?.Date);
  if (!hasDate) return rows;

  return [...rows].sort((left, right) => {
    const leftDate = String(left._sortDate || left._sort || left.Date || '');
    const rightDate = String(right._sortDate || right._sort || right.Date || '');
    const dateCompare = rightDate.localeCompare(leftDate);
    if (dateCompare) return dateCompare;
    return String(right._orderId || right.Reference || right.Item || '').localeCompare(String(left._orderId || left.Reference || left.Item || ''));
  });
}
