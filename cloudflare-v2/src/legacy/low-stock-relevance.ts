/**
 * One shared low-stock relevance rule used by the dashboard and notifications.
 *
 * A balance is relevant when it has physical stock, qualifying activity in the
 * rolling 30-day window, or belongs to an active count template for the same
 * location. Merely having a zero balance row at a shared location is not enough.
 */
export function lowStockRelevanceSql(balanceAlias = 'sb') {
  return `(
    ${balanceAlias}.quantity > 0
    OR EXISTS (
      SELECT 1
        FROM stock_movements lsr_movement
       WHERE lsr_movement.workspace_id = ${balanceAlias}.workspace_id
         AND lsr_movement.stock_item_id = ${balanceAlias}.stock_item_id
         AND lsr_movement.location_id = ${balanceAlias}.location_id
         AND datetime(COALESCE(NULLIF(lsr_movement.occurred_at, ''), lsr_movement.created_at))
             >= datetime('now', '-30 days')
         AND (
           lower(lsr_movement.movement_type) LIKE '%sale%'
           OR lower(lsr_movement.movement_type) LIKE '%grv%'
           OR lower(lsr_movement.movement_type) LIKE '%goods%'
           OR lower(lsr_movement.movement_type) LIKE '%transfer%'
           OR lower(lsr_movement.movement_type) LIKE '%manufact%'
           OR lower(lsr_movement.movement_type) LIKE '%adjust%'
           OR lower(lsr_movement.movement_type) LIKE '%stock_take%'
           OR lower(lsr_movement.movement_type) LIKE '%stocktake%'
         )
    )
    OR EXISTS (
      SELECT 1
        FROM stocktake_count_lines lsr_count
        JOIN stocktake_sessions lsr_session
          ON lsr_session.workspace_id = lsr_count.workspace_id
         AND lsr_session.id = lsr_count.stocktake_session_id
       WHERE lsr_count.workspace_id = ${balanceAlias}.workspace_id
         AND lsr_count.stock_item_id = ${balanceAlias}.stock_item_id
         AND lsr_count.location_id = ${balanceAlias}.location_id
         AND datetime(COALESCE(
               NULLIF(lsr_session.counted_at, ''),
               NULLIF(lsr_session.updated_at, ''),
               lsr_session.created_at
             )) >= datetime('now', '-30 days')
    )
    OR EXISTS (
      SELECT 1
        FROM stocktake_template_lines lsr_template_line
        JOIN stocktake_templates lsr_template
          ON lsr_template.workspace_id = lsr_template_line.workspace_id
         AND lsr_template.id = lsr_template_line.stocktake_template_id
       WHERE lsr_template_line.workspace_id = ${balanceAlias}.workspace_id
         AND lsr_template_line.stock_item_id = ${balanceAlias}.stock_item_id
         AND lsr_template.active = 1
         AND (
           lsr_template.location_id = ${balanceAlias}.location_id
           OR (
             json_valid(lsr_template.raw_json) = 1
             AND (
               COALESCE(json_extract(lsr_template.raw_json, '$.targetLocation'), '') = ${balanceAlias}.location_id
               OR EXISTS (
                 SELECT 1
                   FROM json_each(lsr_template.raw_json, '$.targetLocations') lsr_template_location
                  WHERE lsr_template_location.value = ${balanceAlias}.location_id
               )
             )
           )
         )
    )
  )`;
}
