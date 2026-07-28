import type { Env } from "../../legacy/types";
import type {
  CanonicalSaleCompletedEvent,
  YocoV2QueueMessage,
} from "./contracts";
import { getSaleEffectRuntime, type SaleEffectRuntime } from "./cutover";
import { sha256Hex } from "./identity";
import { appendTimeline, newId, nowIso, type Row } from "./repository";

function text(value: unknown): string {
  return String(value ?? "").trim();
}
function numberValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function objectValue(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}
function parseJson(value: unknown): Row {
  try {
    return objectValue(JSON.parse(text(value) || "{}"));
  } catch {
    return {};
  }
}

function johannesburgIso(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const shifted = new Date(parsed + 2 * 60 * 60_000);
  return `${shifted.toISOString().slice(0, 19)}+02:00`;
}

async function stableId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(value)).slice(0, 32)}`;
}

/**
 * Best-effort partition of proposed stock movements for a sale.
 * `applied` = fully resolved negative movements that should hit the ledger.
 * `skipped` = rows that could not be resolved (unmapped modifier/item, missing recipe, invalid
 * UOM, etc.) — these carry no stock movement and must NOT block the rest of the order; they are
 * surfaced for review instead. Pure and DB-free so the block/apply decision is unit-testable.
 */
export function partitionSaleStockProposals(rows: Row[]): {
  applied: Row[];
  skipped: Row[];
  warningCodeCounts: Record<string, number>;
} {
  const applied: Row[] = [];
  const skipped: Row[] = [];
  const warningCodeCounts: Record<string, number> = {};
  for (const row of rows) {
    const warningCode = text(row.warning_code);
    const unresolved = Boolean(warningCode) || text(row.resolution_status) !== "RESOLVED";
    const isMovement =
      !unresolved &&
      numberValue(row.quantity) < 0 &&
      Boolean(text(row.location_id)) &&
      Boolean(text(row.ingredient_item_id));
    if (isMovement) {
      applied.push(row);
    } else if (unresolved) {
      skipped.push(row);
      const key = warningCode || "UNRESOLVED";
      warningCodeCounts[key] = (warningCodeCounts[key] || 0) + 1;
    }
    // A RESOLVED, non-negative row (e.g. a net-zero line) is neither applied nor a warning.
  }
  return { applied, skipped, warningCodeCounts };
}

async function applyReporting(
  env: Env,
  input: {
    runtime: SaleEffectRuntime;
    domainEvent: Row;
    canonical: CanonicalSaleCompletedEvent;
    rawEvent: Row;
    rawEventId: string;
    processingRunId: string;
  },
): Promise<"APPLIED" | "DUPLICATE" | "SKIPPED"> {
  if (!input.runtime.canConsume) return "SKIPPED";
  const effectKey = `sale-reporting:${input.canonical.source_order_id}:${input.canonical.schema_version}`;
  const existing = await env.DB.prepare(
    `SELECT id FROM yoco_v2_live_sale_reporting_effects WHERE workspace_id = ?1 AND effect_key = ?2 LIMIT 1`,
  )
    .bind(input.canonical.workspace_id, effectKey)
    .first<Row>();
  if (existing) return "DUPLICATE";
  const sourceOrder = objectValue(input.canonical.metadata.source_order);
  const orderDbId = await stableId(
    "yoco_order_v2",
    `${input.canonical.workspace_id}|${input.canonical.source_order_id}|sale`,
  );
  const outboxId = await stableId(
    "yoco_v2_outbox",
    `${input.canonical.workspace_id}|SALE_REPORTING|${effectKey}`,
  );
  const effectId = await stableId(
    "yoco_v2_reporting_effect",
    `${input.canonical.workspace_id}|${effectKey}`,
  );
  const occurredAt = johannesburgIso(input.canonical.occurred_at);
  const now = nowIso();
  const statements = [
    env.DB.prepare(
      `INSERT INTO yoco_v2_live_effect_outbox
        (id, workspace_id, integration_id, domain_event_id, effect_type, effect_key,
         status, payload_json, cutover_at, attempt_count, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'SALE_REPORTING', ?5, 'PROCESSING', ?6, ?7, 1, ?8, ?8)
       ON CONFLICT(workspace_id, effect_type, effect_key) DO UPDATE SET
         status = CASE WHEN yoco_v2_live_effect_outbox.status = 'APPLIED' THEN 'APPLIED' ELSE 'PROCESSING' END,
         attempt_count = yoco_v2_live_effect_outbox.attempt_count + 1,
         updated_at = excluded.updated_at`,
    ).bind(
      outboxId,
      input.canonical.workspace_id,
      input.canonical.integration_id,
      text(input.domainEvent.id),
      effectKey,
      JSON.stringify({
        event_type: input.canonical.event_type,
        source_order_id: input.canonical.source_order_id,
      }),
      text(input.runtime.cutoverAt),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO yoco_orders
        (id, workspace_id, yoco_order_id, yoco_payment_id, location_id, order_type,
         status, payment_method, total, occurred_at, raw_json, created_at,
         gross_total, vat_total, net_total)
       VALUES (?1, ?2, ?3, NULLIF(?4, ''), NULLIF(?5, ''), 'sale', ?6,
         NULLIF(?7, ''), ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT(workspace_id, yoco_order_id, order_type) DO UPDATE SET
         yoco_payment_id = excluded.yoco_payment_id,
         location_id = excluded.location_id,
         status = excluded.status,
         payment_method = excluded.payment_method,
         total = excluded.total,
         occurred_at = excluded.occurred_at,
         raw_json = excluded.raw_json,
         gross_total = excluded.gross_total,
         vat_total = excluded.vat_total,
         net_total = excluded.net_total`,
    ).bind(
      orderDbId,
      input.canonical.workspace_id,
      input.canonical.source_order_id,
      input.canonical.source_payment_id || "",
      input.canonical.kcp_location_id || "",
      input.canonical.status || "completed",
      text(
        input.canonical.payment_method ||
          sourceOrder.payment_method ||
          sourceOrder.paymentMethod ||
          objectValue(sourceOrder.payment).method,
      ),
      input.canonical.gross_amount,
      occurredAt,
      JSON.stringify({
        ...sourceOrder,
        kcp_v2: {
          engine: "V2",
          effect_type: "SALE_REPORTING",
          domain_event_id: input.domainEvent.id,
          schema_version: input.canonical.schema_version,
          currency: input.canonical.currency,
          discount_amount: input.canonical.discount_amount,
          tip_amount: input.canonical.tip_amount,
        },
      }),
      now,
      input.canonical.gross_amount,
      input.canonical.tax_amount,
      input.canonical.net_amount,
    ),
  ];
  for (const [index, line] of input.canonical.lines.entries()) {
    const lineDbId = await stableId(
      "yoco_order_line_v2",
      `${input.canonical.workspace_id}|${input.canonical.source_order_id}|${line.source_line_id}|${index}`,
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO yoco_order_lines
        (id, workspace_id, yoco_order_id, product_id, yoco_line_id, name, quantity,
         total, selling_location_id, source_location_id, raw_json)
       VALUES (?1, ?2, ?3, NULLIF(?4, ''), ?5, ?6, ?7, ?8, NULLIF(?9, ''), NULLIF(?9, ''), ?10)
       ON CONFLICT(id) DO UPDATE SET
         product_id = excluded.product_id,
         name = excluded.name,
         quantity = excluded.quantity,
         total = excluded.total,
         selling_location_id = excluded.selling_location_id,
         source_location_id = excluded.source_location_id,
         raw_json = excluded.raw_json`,
      ).bind(
        lineDbId,
        input.canonical.workspace_id,
        orderDbId,
        line.mapped_menu_item_id || "",
        line.source_line_id,
        line.source_name,
        line.quantity,
        line.gross_amount,
        input.canonical.kcp_location_id || "",
        JSON.stringify({
          ...line,
          kcp_v2: { engine: "V2", domain_event_id: input.domainEvent.id },
        }),
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO yoco_v2_live_sale_reporting_effects
        (id, workspace_id, domain_event_id, source_order_id, effect_key,
         yoco_order_db_id, applied_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(
      effectId,
      input.canonical.workspace_id,
      text(input.domainEvent.id),
      input.canonical.source_order_id,
      effectKey,
      orderDbId,
      now,
    ),
    env.DB.prepare(
      `UPDATE yoco_v2_live_effect_outbox SET status = 'APPLIED', applied_at = ?3, updated_at = ?3,
         last_error_code = NULL, last_error_message = NULL
       WHERE workspace_id = ?1 AND effect_type = 'SALE_REPORTING' AND effect_key = ?2`,
    ).bind(input.canonical.workspace_id, effectKey, now),
  );
  await env.DB.batch(statements);
  await appendTimeline(env.DB, {
    rawEventId: input.rawEventId,
    processingRunId: input.processingRunId,
    step: "LIVE_SALE_REPORTING_APPLIED",
    status: "COMPLETED",
    message:
      "V2 sale reporting effect was applied transactionally after ownership and runtime control checks.",
    metadata: {
      effect_key: effectKey,
      yoco_order_db_id: orderDbId,
      currency: "ZAR",
      occurred_at: occurredAt,
    },
  });
  return "APPLIED";
}

async function applyStock(
  env: Env,
  input: {
    runtime: SaleEffectRuntime;
    domainEvent: Row;
    canonical: CanonicalSaleCompletedEvent;
    rawEvent: Row;
    rawEventId: string;
    processingRunId: string;
  },
): Promise<"APPLIED" | "PARTIAL" | "DUPLICATE" | "SKIPPED"> {
  if (!input.runtime.canConsume) return "SKIPPED";
  const all = await env.DB.prepare(
    `SELECT * FROM yoco_v2_proposed_stock_movements WHERE workspace_id = ?1 AND domain_event_id = ?2 ORDER BY proposal_key`,
  )
    .bind(input.canonical.workspace_id, text(input.domainEvent.id))
    .all<Row>();
  // Best-effort: deduct every resolvable line; unresolved lines (unmapped modifier/item, missing
  // recipe, invalid UOM, …) carry no movement and are skipped + recorded rather than blocking.
  const { applied: proposals, skipped, warningCodeCounts } = partitionSaleStockProposals(
    all.results || [],
  );
  if (!proposals.length) {
    // Nothing resolvable to deduct. Record the skipped lines for review; never throw/block.
    if (skipped.length) {
      await appendTimeline(env.DB, {
        rawEventId: input.rawEventId,
        processingRunId: input.processingRunId,
        step: "LIVE_SALE_STOCK_SKIPPED",
        status: "SKIPPED",
        message:
          "No resolvable stock movements for this sale; every line was unmapped/unresolved and skipped. The order still processed and reporting was posted.",
        metadata: { skipped_count: skipped.length, warning_codes: warningCodeCounts },
      });
    }
    return "SKIPPED";
  }
  const outboxEffectKey = `sale-stock:${input.canonical.source_order_id}:${input.canonical.schema_version}`;
  const existingApplied = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM yoco_v2_live_sale_stock_effects
      WHERE workspace_id = ?1 AND source_order_id = ?2 AND status = 'APPLIED'`,
  )
    .bind(input.canonical.workspace_id, input.canonical.source_order_id)
    .first<Row>();
  if (numberValue(existingApplied?.count) >= proposals.length)
    return "DUPLICATE";
  const now = nowIso();
  const occurredAt = johannesburgIso(input.canonical.occurred_at);
  const outboxId = await stableId(
    "yoco_v2_outbox",
    `${input.canonical.workspace_id}|SALE_STOCK|${outboxEffectKey}`,
  );
  const statements = [
    env.DB.prepare(
      `INSERT INTO yoco_v2_live_effect_outbox
      (id, workspace_id, integration_id, domain_event_id, effect_type, effect_key,
       status, payload_json, cutover_at, attempt_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'SALE_STOCK', ?5, 'PROCESSING', ?6, ?7, 1, ?8, ?8)
     ON CONFLICT(workspace_id, effect_type, effect_key) DO UPDATE SET
       status = CASE WHEN yoco_v2_live_effect_outbox.status = 'APPLIED' THEN 'APPLIED' ELSE 'PROCESSING' END,
       attempt_count = yoco_v2_live_effect_outbox.attempt_count + 1,
       updated_at = excluded.updated_at`,
    ).bind(
      outboxId,
      input.canonical.workspace_id,
      input.canonical.integration_id,
      text(input.domainEvent.id),
      outboxEffectKey,
      JSON.stringify({
        source_order_id: input.canonical.source_order_id,
        proposal_count: proposals.length,
      }),
      text(input.runtime.cutoverAt),
      now,
    ),
  ];

  for (const proposal of proposals) {
    const effectKey = `sale-stock:${text(proposal.proposal_key)}`;
    const effectId = await stableId(
      "yoco_v2_stock_effect",
      `${input.canonical.workspace_id}|${effectKey}`,
    );
    const movementId = await stableId(
      "stock_movement_v2",
      `${input.canonical.workspace_id}|${effectKey}`,
    );
    const quantity = numberValue(proposal.quantity);
    const unitCost = Math.max(0, numberValue(proposal.unit_cost_ex_vat));
    const snapshot = await env.DB.prepare(
      `SELECT * FROM modifier_sale_movement_snapshots WHERE workspace_id = ?1 AND proposal_key = ?2 LIMIT 1`,
    )
      .bind(input.canonical.workspace_id, text(proposal.proposal_key))
      .first<Row>();
    const actionSnapshot = text(proposal.modifier_id)
      ? await env.DB.prepare(
          `SELECT source_key, source_name, action_type
             FROM modifier_sale_action_snapshots
            WHERE workspace_id = ?1
              AND source_order_id = ?2
              AND source_line_id = ?3
              AND source_kind = 'MODIFIER'
              AND (
                source_key = ?4
                OR (length(?4) > length(source_key) AND substr(?4, length(?4) - length(source_key)) = ':' || source_key)
                OR (NULLIF(?5, '') IS NOT NULL AND rule_id = ?5)
              )
            ORDER BY CASE
              WHEN source_key = ?4 THEN 0
              WHEN length(?4) > length(source_key) AND substr(?4, length(?4) - length(source_key)) = ':' || source_key THEN 1
              ELSE 2
            END
            LIMIT 1`,
        )
          .bind(
            input.canonical.workspace_id,
            input.canonical.source_order_id,
            text(proposal.source_line_id),
            text(proposal.modifier_id),
            text(snapshot?.modifier_rule_id),
          )
          .first<Row>()
      : null;
    const ruleSnapshot = parseJson(snapshot?.rule_snapshot_json);
    const isNoteRule = text(proposal.modifier_id).startsWith("note:");
    const ruleMetadata = snapshot
      ? {
          original_line_quantity: numberValue(snapshot.original_line_quantity),
          original_sale_snapshot_id: text(snapshot.id),
          modifier_rule_id: isNoteRule
            ? null
            : text(snapshot.modifier_rule_id) || null,
          modifier_rule_version: isNoteRule
            ? null
            : numberValue(snapshot.modifier_rule_version) || null,
          modifier_action_type: isNoteRule
            ? null
            : text(snapshot.modifier_action_type) || null,
          note_rule_id: isNoteRule
            ? text(snapshot.modifier_rule_id) || null
            : null,
          note_rule_version: isNoteRule
            ? numberValue(snapshot.modifier_rule_version) || null
            : null,
          note_action_type: isNoteRule
            ? text(snapshot.modifier_action_type) || null
            : null,
          rule_snapshot: ruleSnapshot,
        }
      : {};
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO yoco_v2_live_sale_stock_effects
          (id, workspace_id, domain_event_id, source_order_id, proposal_key, effect_key,
           movement_id, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'PENDING', ?8, ?8)`,
      ).bind(
        effectId,
        input.canonical.workspace_id,
        text(input.domainEvent.id),
        input.canonical.source_order_id,
        text(proposal.proposal_key),
        effectKey,
        movementId,
        now,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4)`,
      ).bind(
        input.canonical.workspace_id,
        text(proposal.ingredient_item_id),
        text(proposal.location_id),
        now,
      ),
      env.DB.prepare(
        `UPDATE stock_balances
            SET quantity = quantity + ?4, updated_at = ?5
          WHERE workspace_id = ?1 AND stock_item_id = ?2 AND location_id = ?3
            AND EXISTS (SELECT 1 FROM yoco_v2_live_sale_stock_effects effect
                         WHERE effect.workspace_id = ?1 AND effect.effect_key = ?6 AND effect.status = 'PENDING')`,
      ).bind(
        input.canonical.workspace_id,
        text(proposal.ingredient_item_id),
        text(proposal.location_id),
        quantity,
        now,
        effectKey,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type,
           document_id, source_location_id, destination_location_id, quantity_delta,
           unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         SELECT ?1, ?2, ?3, ?4, 'sale_depletion', 'yoco_order', ?5, ?4, NULL,
                ?6, ?7, ?8, ?9, 'yoco-v2', ?10, ?11
          WHERE EXISTS (SELECT 1 FROM yoco_v2_live_sale_stock_effects effect
                         WHERE effect.workspace_id = ?2 AND effect.effect_key = ?12 AND effect.status = 'PENDING')`,
      ).bind(
        movementId,
        input.canonical.workspace_id,
        text(proposal.ingredient_item_id),
        text(proposal.location_id),
        input.canonical.source_order_id,
        quantity,
        unitCost,
        quantity * unitCost,
        occurredAt,
        JSON.stringify({
          engine: "V2",
          effect_type: "SALE_STOCK",
          effect_key: effectKey,
          proposal_key: proposal.proposal_key,
          domain_event_id: input.domainEvent.id,
          reportOrderKey: input.canonical.source_order_id,
          orderId: input.canonical.source_order_id,
          componentType: text(proposal.modifier_id) ? "modifier" : "product",
          componentLineId: proposal.source_line_id,
          parentLineId: proposal.source_line_id,
          menuItemId: proposal.menu_item_id || null,
          productId: proposal.menu_item_id || null,
          parentProductId: proposal.menu_item_id || null,
          modifierId: proposal.modifier_id || null,
          modifierOwnerId: proposal.modifier_id || null,
          sourceModifierId: text(actionSnapshot?.source_key) || proposal.modifier_id || null,
          modifierName: text(actionSnapshot?.source_name) || null,
          modifierActionType: text(actionSnapshot?.action_type || snapshot?.modifier_action_type) || null,
          saleLocationId: input.canonical.kcp_location_id || null,
          stockRoutingApplied: text(proposal.location_id) !== text(input.canonical.kcp_location_id),
          baseUom: proposal.base_uom,
          source_line_id: proposal.source_line_id,
          menu_item_id: proposal.menu_item_id,
          modifier_id: proposal.modifier_id || null,
          base_uom: proposal.base_uom,
          cutover_at: input.runtime.cutoverAt,
          ...ruleMetadata,
        }),
        now,
        effectKey,
      ),
      env.DB.prepare(
        `UPDATE yoco_v2_live_sale_stock_effects
            SET status = 'APPLIED', applied_at = ?3, updated_at = ?3
          WHERE workspace_id = ?1 AND effect_key = ?2 AND status = 'PENDING'
            AND EXISTS (SELECT 1 FROM stock_movements WHERE id = movement_id)`,
      ).bind(input.canonical.workspace_id, effectKey, now),
      env.DB.prepare(
        `UPDATE modifier_sale_movement_snapshots
            SET original_movement_id = ?3, movement_quantity = ?4, unit_cost_ex_vat = ?5,
                movement_value = ?4 * ?5, status = 'APPLIED', updated_at = ?6
          WHERE workspace_id = ?1 AND proposal_key = ?2
            AND EXISTS (SELECT 1 FROM stock_movements WHERE id = ?3)`,
      ).bind(
        input.canonical.workspace_id,
        text(proposal.proposal_key),
        movementId,
        quantity,
        unitCost,
        now,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE yoco_v2_live_effect_outbox SET status = 'APPLIED', applied_at = ?3, updated_at = ?3,
       last_error_code = NULL, last_error_message = NULL
     WHERE workspace_id = ?1 AND effect_type = 'SALE_STOCK' AND effect_key = ?2`,
    ).bind(input.canonical.workspace_id, outboxEffectKey, now),
  );
  await env.DB.batch(statements);
  await appendTimeline(env.DB, {
    rawEventId: input.rawEventId,
    processingRunId: input.processingRunId,
    step: "LIVE_SALE_STOCK_APPLIED",
    status: skipped.length ? "PARTIAL" : "COMPLETED",
    message: skipped.length
      ? "Controlled V2 sale stock effects were applied for all resolvable lines; unmapped/unresolved lines were skipped and flagged for review."
      : "Controlled V2 sale stock effects were applied to the stock ledger using deterministic movement keys.",
    metadata: {
      effect_key: outboxEffectKey,
      movement_count: proposals.length,
      skipped_count: skipped.length,
      warning_codes: warningCodeCounts,
      occurred_at: occurredAt,
    },
  });
  return skipped.length ? "PARTIAL" : "APPLIED";
}

export async function applyControlledLiveSaleEffects(
  env: Env,
  input: {
    domainEvent: Row;
    canonical: CanonicalSaleCompletedEvent;
    rawEvent: Row;
    rawEventId: string;
    processingRunId: string;
    message: YocoV2QueueMessage;
  },
): Promise<Row> {
  if (!input.message.live_effects)
    return { reporting: "DIAGNOSTIC_ONLY", stock: "DIAGNOSTIC_ONLY" };
  if (input.canonical.event_type !== "sale.completed")
    return { reporting: "NOT_A_SALE", stock: "NOT_A_SALE" };
  if (input.canonical.currency.toUpperCase() !== "ZAR")
    throw new Error(
      `YOCO_V2_LIVE_SALE_CURRENCY_UNSUPPORTED:${input.canonical.currency}`,
    );
  // Best-effort processing: a completed sale is never blocked by unresolved lines. Reporting
  // always posts and stock is applied for every resolvable line; unmapped/unresolved lines (and
  // a missing location) are skipped + flagged inside applyStock rather than failing the order.
  // Only a genuinely non-completed order is skipped outright.
  if (input.canonical.resolution_status === "UNSUPPORTED_ORDER_STATE")
    return {
      reporting: "SKIPPED_UNSUPPORTED_STATE",
      stock: "SKIPPED_UNSUPPORTED_STATE",
      resolution_status: input.canonical.resolution_status,
    };
  const [reportingRuntime, stockRuntime] = await Promise.all([
    getSaleEffectRuntime(
      env,
      input.canonical.workspace_id,
      input.canonical.integration_id,
      "SALE_REPORTING",
    ),
    getSaleEffectRuntime(
      env,
      input.canonical.workspace_id,
      input.canonical.integration_id,
      "SALE_STOCK",
    ),
  ]);
  const reporting = await applyReporting(env, {
    ...input,
    runtime: reportingRuntime,
  });
  const stock = await applyStock(env, { ...input, runtime: stockRuntime });
  return {
    reporting,
    stock,
    reporting_runtime: reportingRuntime.reason,
    stock_runtime: stockRuntime.reason,
  };
}
