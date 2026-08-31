import type { Env } from '../../legacy/types';
import { text, nowIso } from './config';
import { executeXeroApiRequest, XeroApiClientError } from './api-client';
import { claimXeroEffect, markXeroEffectApplied, markXeroEffectFailed } from './outbox';
import { recordXeroDiagnosticIfNotable } from './observability';

interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  updated_at: string;
}

const XERO_CODE_MAX_LENGTH = 30; // Xero's Item.Code field hard limit.

function itemCodeForProduct(product: ProductRow): string {
  const sku = text(product.sku);
  return (sku || product.id).slice(0, XERO_CODE_MAX_LENGTH);
}

/**
 * Pushes every active, changed product as a Xero Item (for invoicing/COGS). "Changed" = its
 * updated_at differs from what was last pushed — the effect_key embeds updated_at, so an
 * unmodified product is a cheap no-op via claimXeroEffect's ON CONFLICT short-circuit rather than
 * a wasted Xero API call.
 */
export async function syncXeroItemsForWorkspace(
  env: Env,
  workspaceId: string,
  settings: { itemAccountCode: string; defaultTaxType: string }
): Promise<{ pushed: number; skipped: number; failed: number }> {
  const products = await env.DB.prepare(
    `SELECT id, name, sku, price, updated_at FROM products WHERE workspace_id = ?1 AND active = 1`
  )
    .bind(workspaceId)
    .all<ProductRow>();

  let pushed = 0;
  let skipped = 0;
  let failed = 0;

  for (const product of products.results || []) {
    const effectKey = `item:${product.id}:${product.updated_at}`;
    const claim = await claimXeroEffect(env, workspaceId, 'ITEM_PUSH', effectKey);
    if (claim.alreadyApplied) {
      skipped += 1;
      continue;
    }
    try {
      const code = itemCodeForProduct(product);
      const payload = {
        Items: [
          {
            Code: code,
            Name: text(product.name).slice(0, 50) || code,
            SalesDetails: {
              UnitPrice: Number(product.price) || 0,
              AccountCode: settings.itemAccountCode,
              TaxType: settings.defaultTaxType
            }
          }
        ]
      };
      const result = await executeXeroApiRequest(env, workspaceId, { method: 'POST', path: 'Items', body: payload });
      const items = (result.Items as Array<{ ItemID?: string }> | undefined) || [];
      await markXeroEffectApplied(env, claim.id, text(items[0]?.ItemID) || code);
      pushed += 1;
    } catch (cause) {
      const message = cause instanceof XeroApiClientError ? cause.message : cause instanceof Error ? cause.message : 'Unknown error pushing item to Xero.';
      await markXeroEffectFailed(env, claim.id, message);
      failed += 1;
      // A single bad product (e.g. a duplicate code) must not abort the rest of the catalogue push.
      await recordXeroDiagnosticIfNotable(env, workspaceId, { operation: 'xero-item-push', status: 'failed', message, details: { productId: product.id } });
    }
  }

  await env.DB.prepare(`UPDATE xero_sync_settings SET last_item_sync_at = ?2, updated_at = ?2 WHERE workspace_id = ?1`)
    .bind(workspaceId, nowIso())
    .run();

  return { pushed, skipped, failed };
}
