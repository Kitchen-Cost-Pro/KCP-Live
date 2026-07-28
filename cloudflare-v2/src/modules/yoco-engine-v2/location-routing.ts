import type { Env } from "../../legacy/types";
import type { Row } from "./repository";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Resolve a Yoco selling location to KCP. Workspaces that do not use Yoco
 * locations (or receive an unknown provider location) route stock through the
 * canonical Main Storage/default storage location. Historic workspaces do not
 * all use the exact "Main Storage" label, so the final fallback is the first
 * active KCP location rather than returning an empty location and silently
 * dropping reporting/stock effects.
 */
export async function resolveYocoStockLocation(
  env: Env,
  workspaceId: string,
  sourceLocationId = "",
): Promise<string> {
  if (sourceLocationId) {
    const mapped = await env.DB.prepare(
      `SELECT id
         FROM locations
        WHERE workspace_id = ?1
          AND active = 1
          AND lower(COALESCE(external_provider, '')) = 'yoco'
          AND external_location_id = ?2
        LIMIT 1`,
    ).bind(workspaceId, sourceLocationId).first<Row>();
    if (text(mapped?.id)) return text(mapped?.id);
  }

  const fallback = await env.DB.prepare(
    `SELECT id
      FROM locations
      WHERE workspace_id = ?1
        AND active = 1
      ORDER BY CASE
        WHEN lower(trim(COALESCE(name, ''))) IN
               ('main storage', 'main store', 'main storeroom', 'main stockroom')
          OR lower(trim(COALESCE(display_name, ''))) IN
               ('main storage', 'main store', 'main storeroom', 'main stockroom')
          OR lower(trim(COALESCE(external_name, ''))) IN
               ('main storage', 'main store', 'main storeroom', 'main stockroom') THEN 0
        WHEN COALESCE(is_default, 0) = 1 THEN 1
        WHEN lower(trim(COALESCE(kind, ''))) IN
               ('storage', 'store', 'storeroom', 'stockroom', 'warehouse') THEN 2
        ELSE 3
      END, created_at ASC
      LIMIT 1`,
  ).bind(workspaceId).first<Row>();
  return text(fallback?.id);
}
