export const LOW_STOCK_RELEVANCE_DAYS = 30;
export const LOW_STOCK_REMINDER_DAYS = 7;

/**
 * SQL predicate for the shared-threshold, automatic-location-relevance policy.
 *
 * A positive physical balance remains relevant indefinitely. Zero/negative
 * balances are relevant only after qualifying activity in the rolling window
 * or when an active stock-count template explicitly includes the item at the
 * location. Merely having a stock_balances row at a shared location is not
 * enough to activate monitoring.
 */
export function lowStockLocationRelevantSql(
  stockItemAlias = "si",
  balanceAlias = "sb",
) {
  return `(
    COALESCE(${balanceAlias}.quantity, 0) > 0
    OR EXISTS (
      SELECT 1
        FROM stock_movements low_stock_activity
       WHERE low_stock_activity.workspace_id = ${stockItemAlias}.workspace_id
         AND low_stock_activity.stock_item_id = ${stockItemAlias}.id
         AND low_stock_activity.location_id = ${balanceAlias}.location_id
         AND datetime(COALESCE(NULLIF(low_stock_activity.occurred_at, ''), low_stock_activity.created_at))
             >= datetime('now', '-${LOW_STOCK_RELEVANCE_DAYS} days')
         AND (
           lower(COALESCE(low_stock_activity.movement_type, '')) LIKE '%sale%'
           OR lower(COALESCE(low_stock_activity.movement_type, '')) LIKE '%grv%'
           OR lower(COALESCE(low_stock_activity.movement_type, '')) LIKE '%transfer%'
           OR lower(COALESCE(low_stock_activity.movement_type, '')) LIKE '%manufact%'
           OR lower(COALESCE(low_stock_activity.movement_type, '')) LIKE '%adjust%'
           OR lower(COALESCE(low_stock_activity.movement_type, '')) LIKE '%stock_take%'
           OR lower(COALESCE(low_stock_activity.movement_type, '')) LIKE '%stocktake%'
           OR lower(COALESCE(low_stock_activity.document_type, '')) IN (
             'sale', 'yoco_order', 'grv', 'transfer', 'manufacturing',
             'manufacturing_batch', 'adjustment', 'stock_take', 'stocktake'
           )
         )
    )
    OR EXISTS (
      SELECT 1
        FROM stocktake_templates relevance_template
        JOIN stocktake_template_lines relevance_line
          ON relevance_line.workspace_id = relevance_template.workspace_id
         AND relevance_line.stocktake_template_id = relevance_template.id
         AND relevance_line.stock_item_id = ${stockItemAlias}.id
       WHERE relevance_template.workspace_id = ${stockItemAlias}.workspace_id
         AND relevance_template.active = 1
         AND relevance_template.location_id = ${balanceAlias}.location_id
    )
  )`;
}
