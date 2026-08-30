// Non-invasive reporting performance guidance.
// These are recommendations for backend migration review, not automatic constraints.
// Do not add risky constraints without checking current production data first.

export const REPORTING_QUERY_PARAMETERS = [
  'workspaceId',
  'from',
  'to',
  'locationId',
  'categoryId',
  'itemId',
  'supplierId',
  'sourceType',
  'movementType',
  'status',
  'search',
  'limit',
  'offset'
];

export const STOCK_MOVEMENT_REPORTING_INDEX_RECOMMENDATIONS = [
  ['workspace_id', 'movement_date'],
  ['workspace_id', 'location_id', 'movement_date'],
  ['workspace_id', 'item_id', 'movement_date'],
  ['workspace_id', 'source_type', 'source_id'],
  ['workspace_id', 'location_id', 'item_id', 'movement_date']
];

export const SALES_REPORTING_INDEX_RECOMMENDATIONS = [
  ['workspace_id', 'sale_date'],
  ['workspace_id', 'location_id', 'sale_date'],
  ['workspace_id', 'receipt_number'],
  ['workspace_id', 'yoco_product_id'],
  ['workspace_id', 'yoco_variant_id']
];

export const AUDIT_REPORTING_INDEX_RECOMMENDATIONS = [
  ['workspace_id', 'created_at'],
  ['workspace_id', 'user_id', 'created_at'],
  ['workspace_id', 'entity_type', 'entity_id']
];

export const PURCHASING_REPORTING_INDEX_RECOMMENDATIONS = [
  ['workspace_id', 'supplier_id'],
  ['workspace_id', 'created_at'],
  ['workspace_id', 'location_id'],
  ['workspace_id', 'status']
];

export const LARGE_REPORT_IDS_REQUIRING_PAGINATION_OR_SAFE_LIMITS = [
  'detailed_activity',
  'sale_stock_movement',
  'modifier_report:sales_log',
  'inventory_audit',
  'grv_log',
  'stock_on_hand',
  'theoretical_vs_actual'
];

export function getReportingPerformanceRecommendations() {
  return {
    queryParameters: REPORTING_QUERY_PARAMETERS,
    largeReports: LARGE_REPORT_IDS_REQUIRING_PAGINATION_OR_SAFE_LIMITS,
    stockMovementIndexes: STOCK_MOVEMENT_REPORTING_INDEX_RECOMMENDATIONS,
    salesIndexes: SALES_REPORTING_INDEX_RECOMMENDATIONS,
    auditIndexes: AUDIT_REPORTING_INDEX_RECOMMENDATIONS,
    purchasingIndexes: PURCHASING_REPORTING_INDEX_RECOMMENDATIONS,
    note: 'Review against current production data before adding indexes or constraints.'
  };
}
