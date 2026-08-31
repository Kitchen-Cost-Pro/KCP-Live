import type { DbStatementLike, Env } from "./types";

function text(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim();
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number(
          String(value ?? "")
            .replace(/\s/g, "")
            .replace(/[^\d,.-]/g, "")
            .replace(",", "."),
        );
  return Number.isFinite(parsed) ? parsed : fallback;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * A deleted stock item left as a dangling recipe_lines.stock_item_id reference — every recipe that
 * used it (a product's recipe, or another stock item's own sub-recipe) rendered a permanent
 * "Missing ingredient" placeholder with no way to clear it. Removing the line here instead, and
 * logging it as a 'recipe_line' audit event, surfaces the change on the Inventory Audit report's
 * Recipe Changes view (classifyAuditEntityType/isRecipeAudit in reporting-routes.ts route entity
 * type 'recipe_line' there) instead of leaving a UI artifact behind.
 *
 * A deleted stock item can ALSO be a sub-recipe's own owner (recipes.owner_type='stock_item',
 * owner_id=<this item>) — with nothing left referencing it, that recipe would otherwise become
 * permanently dangling data with no cleanup path at all (not even a UI artifact to notice it by).
 * It's deactivated the same way saveStockItemRecipe already deactivates recipes it stops using,
 * rather than hard-deleted, consistent with every other read path here filtering on active=1.
 *
 * Extracted into its own module (rather than living directly in routes.ts) so it can be unit
 * tested against an in-memory SQLite DB without pulling in routes.ts's much heavier transitive
 * import graph.
 */
export async function removeStockItemFromRecipeLines(
  env: Env,
  workspaceId: string,
  actorUid: string,
  stockItemId: string,
  stockItemName: string,
  now: string,
): Promise<DbStatementLike[]> {
  const [lines, ownedRecipe] = await Promise.all([
    env.DB.prepare(
      `SELECT rl.id, rl.recipe_id, rl.quantity, rl.unit,
              r.owner_type,
              si_owner.name AS owner_stock_item_name,
              p_owner.name AS owner_product_name
         FROM recipe_lines rl
         JOIN recipes r ON r.id = rl.recipe_id AND r.workspace_id = rl.workspace_id
         LEFT JOIN stock_items si_owner
           ON si_owner.id = r.owner_id AND r.owner_type = 'stock_item' AND si_owner.workspace_id = rl.workspace_id
         LEFT JOIN products p_owner
           ON p_owner.id = COALESCE(r.linked_product_id, r.owner_id) AND r.owner_type != 'stock_item' AND p_owner.workspace_id = rl.workspace_id
        WHERE rl.workspace_id = ?1
          AND rl.stock_item_id = ?2`,
    )
      .bind(workspaceId, stockItemId)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id
         FROM recipes
        WHERE workspace_id = ?1
          AND owner_type = 'stock_item'
          AND owner_id = ?2
          AND active = 1
        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId)
      .first<Record<string, unknown>>(),
  ]);
  const rows = lines.results || [];

  const statements: DbStatementLike[] = [];
  for (const row of rows) {
    const recipeLabel = text(
      row.owner_product_name || row.owner_stock_item_name || row.recipe_id,
    );
    statements.push(
      env.DB.prepare(
        `DELETE FROM recipe_lines WHERE workspace_id = ?1 AND id = ?2`,
      ).bind(workspaceId, row.id),
      env.DB.prepare(
        `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, before_json, after_json, created_at)
         VALUES (?1, ?2, ?3, 'recipe_ingredient_removed', 'recipe_line', ?4, ?5, ?6, ?7)`,
      ).bind(
        id("audit"),
        workspaceId,
        actorUid,
        text(row.recipe_id),
        JSON.stringify({
          ingredientName: stockItemName,
          stockItemName,
          quantity: numberValue(row.quantity, 0),
          unit: text(row.unit),
          recipeName: recipeLabel,
          menuItemName: recipeLabel,
        }),
        JSON.stringify({}),
        now,
      ),
    );
  }

  if (ownedRecipe?.id) {
    const recipeId = text(ownedRecipe.id);
    statements.push(
      env.DB.prepare(
        `UPDATE recipes SET active = 0, updated_at = ?3 WHERE workspace_id = ?1 AND id = ?2`,
      ).bind(workspaceId, recipeId, now),
      env.DB.prepare(
        `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, before_json, after_json, created_at)
         VALUES (?1, ?2, ?3, 'recipe_deactivated', 'recipe', ?4, ?5, ?6, ?7)`,
      ).bind(
        id("audit"),
        workspaceId,
        actorUid,
        recipeId,
        JSON.stringify({ active: true, ownerStockItemName: stockItemName }),
        JSON.stringify({
          active: false,
          reason: "owning stock item was deleted",
        }),
        now,
      ),
    );
  }

  return statements;
}
