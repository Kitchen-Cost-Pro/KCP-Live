/**
 * Phase 23 reporting source-of-truth catalog.
 *
 * This catalog intentionally documents the API and tenant tables used by every
 * dashboard report. It is consumed by tests/sign-off tooling only; runtime
 * calculations remain in the existing report modules and shared engines.
 */
export const REPORT_DATA_SOURCE_CATALOG = Object.freeze({
  sales_reports: source({
    kind: 'group',
    children: ['payment_sales_financial', 'sale_stock_movement'],
    endpoints: ['reports/sales-financial', 'reports/sale-stock-usage'],
    tables: ['yoco_orders', 'yoco_order_lines', 'locations', 'products', 'stock_movements', 'stock_items', 'workspace_settings']
  }),
  payment_sales_financial: source({
    endpoints: ['reports/sales-financial'],
    tables: ['yoco_orders', 'yoco_order_lines', 'locations', 'products', 'stock_movements', 'workspace_settings'],
    sourceIds: ['id', 'yoco_order_id', 'yoco_payment_id', 'receiptNumber']
  }),
  sale_stock_movement: source({
    endpoints: ['reports/sale-stock-usage'],
    tables: ['stock_movements', 'stock_items', 'locations', 'yoco_orders', 'yoco_order_lines', 'products', 'workspace_settings'],
    sourceIds: ['sourceId', 'saleId', 'yoco_order_id', 'yoco_line_id']
  }),
  modifier_report: source({
    endpoints: ['reports/modifier-sales', 'reports/modifier-usage'],
    tables: ['yoco_orders', 'yoco_order_lines', 'yoco_modifier_groups', 'products', 'stock_movements', 'stock_items', 'locations', 'workspace_settings'],
    sourceIds: ['sourceId', 'saleId', 'modifierId', 'modifierGroupId']
  }),
  menu_recipe_health: source({
    endpoints: ['reports/menu-recipe-health'],
    tables: ['products', 'recipes', 'recipe_lines', 'stock_items', 'stock_item_location_prices', 'locations', 'yoco_orders', 'yoco_order_lines'],
    sourceIds: ['menuItemId', 'recipeId', 'stockItemId', 'sourceId']
  }),
  stock_control: source({
    endpoints: ['reports/stock-control'],
    tables: ['stock_items', 'stock_balances', 'stock_movements', 'stock_item_location_prices', 'locations', 'suppliers'],
    sourceIds: ['itemId', 'locationId', 'supplierId']
  }),
  inventory_audit: source({
    endpoints: ['reports/inventory-audit'],
    tables: ['audit_events', 'stock_movements', 'stock_items', 'recipes', 'recipe_lines', 'suppliers', 'workspace_members'],
    sourceIds: ['sourceId', 'entityId', 'userId']
  }),
  operations_dashboard: source({
    endpoints: ['reports/detailed-activity'],
    tables: ['stock_movements', 'stock_items', 'stock_item_location_prices', 'locations', 'grvs', 'purchase_orders', 'credit_notes', 'adjustments', 'stocktake_sessions', 'transfers', 'manufacturing_batches', 'yoco_orders'],
    sourceIds: ['sourceId', 'documentNumber']
  }),
  detailed_activity: source({
    endpoints: ['reports/detailed-activity'],
    tables: ['stock_movements', 'stock_items', 'stock_item_location_prices', 'locations', 'grvs', 'suppliers', 'purchase_orders', 'credit_notes', 'adjustments', 'stocktake_sessions', 'transfers', 'manufacturing_batches', 'yoco_orders'],
    sourceIds: ['sourceId', 'documentNumber']
  }),
  wastage: source({
    endpoints: ['reports/detailed-activity'],
    tables: ['stock_movements', 'stock_items', 'locations', 'adjustments', 'stocktake_sessions', 'manufacturing_batches'],
    sourceIds: ['sourceId', 'documentNumber']
  }),
  stock_take_audit: source({
    endpoints: ['reports/stock-take-audit', 'reports/detailed-activity', 'reports/transactions/:transactionReference'],
    tables: ['stocktake_sessions', 'stocktake_count_lines', 'stock_movements', 'stock_items', 'locations'],
    sourceIds: ['sourceId', 'stockTakeId', 'sessionId', 'transactionReference']
  }),
  adjustments: source({
    endpoints: ['reports/detailed-activity'],
    tables: ['stock_movements', 'adjustments', 'stocktake_sessions', 'manufacturing_batches', 'stock_items', 'locations'],
    sourceIds: ['sourceId', 'documentNumber']
  }),
  stock_transfers: source({
    endpoints: ['reports/stock-transfer-transactions', 'reports/detailed-activity', 'reports/transactions/:transactionReference'],
    tables: ['stock_movements', 'transfers', 'transfer_lines', 'external_transfers', 'stock_items', 'locations'],
    sourceIds: ['sourceId', 'transferId', 'documentNumber', 'transactionReference']
  }),
  manufacturing_transactions: source({
    endpoints: ['reports/manufacturing-transactions', 'reports/transactions/:transactionReference'],
    tables: ['manufacturing_batches', 'manufacturing_batch_lines', 'stock_movements', 'stock_items', 'locations'],
    sourceIds: ['sourceId', 'manufacturingBatchId', 'transactionReference']
  }),
  stock_on_hand: source({
    endpoints: ['reports/stock-on-hand'],
    tables: ['stock_items', 'stock_balances', 'stock_movements', 'stock_item_location_prices', 'locations', 'suppliers'],
    sourceIds: ['itemId', 'locationId']
  }),
  purchase_orders_report: source({
    endpoints: ['reports/purchase-orders'],
    tables: ['purchase_orders', 'purchase_order_lines', 'grvs', 'grv_lines', 'stock_items', 'locations', 'suppliers'],
    sourceIds: ['sourceId', 'purchaseOrderId', 'purchaseOrderNumber']
  }),
  grv_log: source({
    endpoints: ['reports/grv-log', 'reports/transactions/:transactionReference'],
    tables: ['grvs', 'grv_lines', 'purchase_orders', 'stock_movements', 'stock_items', 'locations', 'suppliers'],
    sourceIds: ['sourceId', 'grvId', 'grvNumber', 'transactionReference']
  }),
  credit_notes_report: source({
    endpoints: ['reports/credit-notes', 'reports/transactions/:transactionReference'],
    tables: ['credit_notes', 'credit_note_lines', 'stock_movements', 'stock_items', 'locations', 'suppliers', 'workspace_settings'],
    sourceIds: ['sourceId', 'creditNoteId', 'creditNoteNumber', 'transactionReference']
  }),
  stock_out_forecast: source({
    endpoints: ['reports/stock-on-hand', 'reports/detailed-activity'],
    tables: ['stock_balances', 'stock_movements', 'stock_items', 'stock_item_location_prices', 'locations', 'suppliers'],
    sourceIds: ['itemId', 'locationId', 'sourceId']
  }),
  price_volatility_analysis: source({
    endpoints: ['reports/grv-log', 'reports/purchase-orders', 'reports/credit-notes'],
    tables: ['grvs', 'grv_lines', 'purchase_orders', 'purchase_order_lines', 'credit_notes', 'credit_note_lines', 'stock_items', 'suppliers', 'locations'],
    sourceIds: ['sourceId', 'grvId', 'purchaseOrderId', 'creditNoteId']
  }),
  theoretical_vs_actual: source({
    endpoints: ['reports/stock-on-hand', 'reports/detailed-activity', 'reports/stock-take-audit', 'reports/sale-stock-usage'],
    tables: ['stock_balances', 'stock_movements', 'stocktake_sessions', 'stocktake_count_lines', 'recipes', 'recipe_lines', 'yoco_orders', 'yoco_order_lines', 'stock_items', 'locations'],
    sourceIds: ['sourceId', 'stockTakeId', 'saleId', 'itemId', 'locationId']
  })
});

export function getReportDataSource(reportId = '') {
  return REPORT_DATA_SOURCE_CATALOG[String(reportId || '').trim()] || null;
}

export function listReportDataSources() {
  return Object.entries(REPORT_DATA_SOURCE_CATALOG).map(([reportId, definition]) => ({ reportId, ...definition }));
}

function source({ kind = 'single', children = [], endpoints = [], tables = [], sourceIds = ['sourceId'] } = {}) {
  return Object.freeze({
    kind,
    children: Object.freeze([...children]),
    endpoints: Object.freeze([...endpoints]),
    tables: Object.freeze([...tables]),
    sourceIds: Object.freeze([...sourceIds]),
    realDataOnly: true,
    workspaceScoped: true,
    cleanLocationNames: true,
    cleanItemNames: true,
    cleanUserNames: true
  });
}

export default REPORT_DATA_SOURCE_CATALOG;
