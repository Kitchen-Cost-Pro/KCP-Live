import type { Env } from "../../legacy/types";
import type {
  CanonicalSaleRefundedEvent,
  YocoV2QueueMessage,
} from "./contracts";
import {
  getRefundEffectRuntime,
  type RefundEffectRuntime,
} from "./refund-cutover";
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
async function applyReporting(
  env: Env,
  input: {
    runtime: RefundEffectRuntime;
    domainEvent: Row;
    canonical: CanonicalSaleRefundedEvent;
    rawEvent: Row;
    rawEventId: string;
    processingRunId: string;
  },
): Promise<"APPLIED" | "DUPLICATE" | "SKIPPED" | "BLOCKED"> {
  if (!input.runtime.canConsume) return "SKIPPED";
  if (
    !["RESOLVED", "PARTIALLY_RESOLVED"].includes(
      input.canonical.financial_resolution_status,
    )
  )
    return "BLOCKED";
  const effectKey = `refund-reporting:${input.canonical.refund_id}:${input.canonical.schema_version}`;
  const existing = await env.DB.prepare(
    `SELECT id FROM yoco_v2_live_refund_reporting_effects WHERE workspace_id=?1 AND effect_key=?2`,
  )
    .bind(input.canonical.workspace_id, effectKey)
    .first<Row>();
  if (existing) return "DUPLICATE";
  const reportOrderKey = `${input.canonical.source_order_id}:refund:${input.canonical.refund_id}`;
  const now = nowIso();
  const outboxId = await stableId(
    "yoco_v2_refund_outbox",
    `${input.canonical.workspace_id}|REFUND_REPORTING|${effectKey}`,
  );
  const orderDbId = await stableId(
    "yoco_refund_v2",
    `${input.canonical.workspace_id}|${input.canonical.refund_id}`,
  );
  const effectId = await stableId(
    "yoco_v2_refund_reporting_effect",
    `${input.canonical.workspace_id}|${effectKey}`,
  );
  const occurredAt = johannesburgIso(input.canonical.occurred_at);
  const gross = -Math.abs(input.canonical.gross_amount),
    net = -Math.abs(input.canonical.net_amount),
    tax = -Math.abs(input.canonical.tax_amount);
  const sourceRefund = objectValue(input.canonical.metadata.source_refund);
  const statements = [
    env.DB.prepare(
      `INSERT INTO yoco_v2_live_refund_effect_outbox (id,workspace_id,integration_id,domain_event_id,refund_id,effect_type,effect_key,status,payload_json,cutover_at,attempt_count,created_at,updated_at)
      VALUES (?1,?2,?3,?4,?5,'REFUND_REPORTING',?6,'PROCESSING',?7,?8,1,?9,?9)
      ON CONFLICT(workspace_id,effect_type,effect_key) DO UPDATE SET status=CASE WHEN status='APPLIED' THEN 'APPLIED' ELSE 'PROCESSING' END,attempt_count=attempt_count+1,updated_at=excluded.updated_at`,
    ).bind(
      outboxId,
      input.canonical.workspace_id,
      input.canonical.integration_id,
      text(input.domainEvent.id),
      input.canonical.refund_id,
      effectKey,
      JSON.stringify({
        source_order_id: input.canonical.source_order_id,
        refund_id: input.canonical.refund_id,
      }),
      text(input.runtime.cutoverAt),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO yoco_orders (id,workspace_id,yoco_order_id,yoco_payment_id,location_id,order_type,status,payment_method,total,occurred_at,raw_json,created_at,parent_yoco_order_id,provider_refund_id,refund_reason,refund_behavior,gross_total,vat_total,net_total)
      VALUES (?1,?2,?3,NULLIF(?4,''),NULLIF(?5,''),'refund','refunded',NULLIF(?17,''),?6,?7,?8,?9,?10,?11,NULLIF(?12,''),?13,?14,?15,?16)
      ON CONFLICT(workspace_id,yoco_order_id,order_type) DO UPDATE SET yoco_payment_id=excluded.yoco_payment_id,location_id=excluded.location_id,status=excluded.status,payment_method=excluded.payment_method,total=excluded.total,occurred_at=excluded.occurred_at,raw_json=excluded.raw_json,parent_yoco_order_id=excluded.parent_yoco_order_id,provider_refund_id=excluded.provider_refund_id,refund_reason=excluded.refund_reason,refund_behavior=excluded.refund_behavior,gross_total=excluded.gross_total,vat_total=excluded.vat_total,net_total=excluded.net_total`,
    ).bind(
      orderDbId,
      input.canonical.workspace_id,
      reportOrderKey,
      input.canonical.source_payment_id || "",
      input.canonical.kcp_location_id || "",
      gross,
      occurredAt,
      JSON.stringify({
        ...sourceRefund,
        kcpRefund: {
          originalOrderId: input.canonical.source_order_id,
          refundId: input.canonical.refund_id,
          reason:
            text(sourceRefund.reason || sourceRefund.refund_reason) || null,
          behavior: input.canonical.refund_type,
          amount: input.canonical.gross_amount,
          grossAmount: input.canonical.gross_amount,
          discountAmount: input.canonical.discount_amount,
          vatAmount: input.canonical.tax_amount,
          netAmount: input.canonical.net_amount,
          source: sourceRefund,
        },
        kcp_v2: {
          engine: "V2",
          effect_type: "REFUND_REPORTING",
          domain_event_id: input.domainEvent.id,
          schema_version: input.canonical.schema_version,
          currency: input.canonical.currency,
          refund_id: input.canonical.refund_id,
          source_order_id: input.canonical.source_order_id,
          discount_amount: -Math.abs(input.canonical.discount_amount),
          tip_amount: -Math.abs(input.canonical.tip_amount),
        },
      }),
      now,
      input.canonical.source_order_id,
      input.canonical.refund_id,
      text(sourceRefund.reason || sourceRefund.refund_reason),
      input.canonical.refund_type,
      gross,
      tax,
      net,
      text(input.canonical.payment_method),
    ),
  ];
  for (const [index, line] of input.canonical.lines.entries()) {
    const lineId = await stableId(
      "yoco_refund_line_v2",
      `${input.canonical.workspace_id}|${input.canonical.refund_id}|${line.source_refund_line_id}|${index}`,
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO yoco_order_lines (id,workspace_id,yoco_order_id,product_id,yoco_line_id,name,quantity,total,selling_location_id,source_location_id,raw_json)
      VALUES (?1,?2,?3,NULLIF(?4,''),?5,?6,?7,?8,NULLIF(?9,''),NULLIF(?9,''),?10)
      ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id,name=excluded.name,quantity=excluded.quantity,total=excluded.total,selling_location_id=excluded.selling_location_id,source_location_id=excluded.source_location_id,raw_json=excluded.raw_json`,
      ).bind(
        lineId,
        input.canonical.workspace_id,
        orderDbId,
        line.mapped_menu_item_id || "",
        line.source_refund_line_id,
        line.source_name,
        -Math.abs(line.quantity),
        -Math.abs(line.gross_amount),
        input.canonical.kcp_location_id || "",
        JSON.stringify({
          ...line,
          kcp_v2: {
            engine: "V2",
            domain_event_id: input.domainEvent.id,
            refund_id: input.canonical.refund_id,
          },
        }),
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO yoco_v2_live_refund_reporting_effects (id,workspace_id,domain_event_id,source_order_id,refund_id,report_order_key,effect_key,yoco_order_db_id,gross_amount,discount_amount,net_amount,tax_amount,tip_amount,applied_at,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)`,
    ).bind(
      effectId,
      input.canonical.workspace_id,
      text(input.domainEvent.id),
      input.canonical.source_order_id,
      input.canonical.refund_id,
      reportOrderKey,
      effectKey,
      orderDbId,
      input.canonical.gross_amount,
      input.canonical.discount_amount,
      input.canonical.net_amount,
      input.canonical.tax_amount,
      input.canonical.tip_amount,
      now,
    ),
    env.DB.prepare(
      `UPDATE yoco_v2_live_refund_effect_outbox SET status='APPLIED',applied_at=?3,updated_at=?3,last_error_code=NULL,last_error_message=NULL WHERE workspace_id=?1 AND effect_type='REFUND_REPORTING' AND effect_key=?2`,
    ).bind(input.canonical.workspace_id, effectKey, now),
    env.DB.prepare(
      `UPDATE yoco_v2_refund_workflows SET reporting_status='RESOLVED',updated_at=?3 WHERE workspace_id=?1 AND domain_event_id=?2`,
    ).bind(input.canonical.workspace_id, text(input.domainEvent.id), now),
  );
  await env.DB.batch(statements);
  await appendTimeline(env.DB, {
    rawEventId: input.rawEventId,
    processingRunId: input.processingRunId,
    step: "LIVE_REFUND_REPORTING_APPLIED",
    status: "COMPLETED",
    message: "V2 refund reporting effect was applied transactionally.",
    metadata: {
      effect_key: effectKey,
      yoco_order_db_id: orderDbId,
      currency: "ZAR",
      occurred_at: occurredAt,
    },
  });
  return "APPLIED";
}

async function loadReturnCapacity(
  env: Env,
  workspaceId: string,
  sourceOrderId: string,
): Promise<Map<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT stock_item_id,location_id,
    SUM(CASE WHEN movement_type='sale_depletion' THEN ABS(quantity_delta) ELSE 0 END) AS deducted,
    SUM(CASE WHEN movement_type='sale_refund' THEN ABS(quantity_delta) ELSE 0 END) AS returned
    FROM stock_movements WHERE workspace_id=?1 AND document_type='yoco_order' AND document_id=?2 AND movement_type IN ('sale_depletion','sale_refund') GROUP BY stock_item_id,location_id`,
  )
    .bind(workspaceId, sourceOrderId)
    .all<Row>();
  const map = new Map<string, number>();
  for (const row of rows.results || [])
    map.set(
      `${text(row.stock_item_id)}|${text(row.location_id)}`,
      Math.max(0, numberValue(row.deducted) - numberValue(row.returned)),
    );
  return map;
}

async function applyStock(
  env: Env,
  input: {
    runtime: RefundEffectRuntime;
    domainEvent: Row;
    canonical: CanonicalSaleRefundedEvent;
    rawEvent: Row;
    rawEventId: string;
    processingRunId: string;
  },
): Promise<"APPLIED" | "DUPLICATE" | "SKIPPED" | "BLOCKED"> {
  if (!input.runtime.canConsume) return "SKIPPED";
  if (input.canonical.inventory_resolution_status !== "RESOLVED")
    return "BLOCKED";
  if (!input.canonical.kcp_location_id) return "BLOCKED";
  const reliable = new Set([
    "EXACT_SOURCE_LINE",
    "RETURN_RESOURCE",
    "MANUAL_ALLOCATION",
    "FULL_ORDER_REMAINDER",
  ]);
  if (
    !input.canonical.lines.length ||
    input.canonical.lines.some(
      (line) =>
        !reliable.has(line.resolution_method) ||
        line.mapping_status !== "MAPPED",
    )
  )
    return "BLOCKED";
  const openReview = await env.DB.prepare(
    `SELECT id FROM yoco_v2_manual_reviews WHERE workspace_id=?1 AND domain_event_id=?2 AND status='OPEN' LIMIT 1`,
  )
    .bind(input.canonical.workspace_id, text(input.domainEvent.id))
    .first<Row>();
  if (openReview) return "BLOCKED";
  const all = await env.DB.prepare(
    `SELECT * FROM yoco_v2_proposed_refund_stock_movements WHERE workspace_id=?1 AND domain_event_id=?2 ORDER BY proposal_key`,
  )
    .bind(input.canonical.workspace_id, text(input.domainEvent.id))
    .all<Row>();
  const warnings = (all.results || []).filter(
    (row) =>
      text(row.warning_code) || text(row.resolution_status) !== "RESOLVED",
  );
  if (warnings.length) {
    const blockedAt = nowIso();
    const blockedKey = `refund-stock:${input.canonical.refund_id}:${input.canonical.schema_version}`;
    const blockedId = await stableId(
      "yoco_v2_refund_outbox",
      `${input.canonical.workspace_id}|REFUND_STOCK|${blockedKey}`,
    );
    const warningDetails = warnings.map((row) => ({
      proposal_key: text(row.proposal_key),
      warning_code: text(row.warning_code) || "UNRESOLVED_REFUND_REVERSAL",
      warning_message:
        text(row.warning_message) ||
        "The original sale-time stock movement could not be resolved.",
      source_refund_line_id: text(row.source_refund_line_id) || null,
      source_original_line_id: text(row.source_original_line_id) || null,
    }));
    const errorCode =
      warningDetails.find(
        (warning) =>
          warning.warning_code === "ORIGINAL_SALE_LEDGER_MOVEMENTS_MISSING",
      )?.warning_code || "YOCO_V2_REFUND_REVERSAL_UNRESOLVED";
    const errorMessage = warningDetails
      .map((warning) => warning.warning_message)
      .filter(Boolean)
      .join(" ")
      .slice(0, 1000);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO yoco_v2_live_refund_effect_outbox (id,workspace_id,integration_id,domain_event_id,refund_id,effect_type,effect_key,status,payload_json,cutover_at,attempt_count,last_error_code,last_error_message,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,'REFUND_STOCK',?6,'BLOCKED',?7,?8,1,?9,?10,?11,?11)
         ON CONFLICT(workspace_id,effect_type,effect_key) DO UPDATE SET status='BLOCKED',attempt_count=attempt_count+1,last_error_code=excluded.last_error_code,last_error_message=excluded.last_error_message,payload_json=excluded.payload_json,updated_at=excluded.updated_at`,
      ).bind(
        blockedId,
        input.canonical.workspace_id,
        input.canonical.integration_id,
        text(input.domainEvent.id),
        input.canonical.refund_id,
        blockedKey,
        JSON.stringify({
          source_order_id: input.canonical.source_order_id,
          warnings: warningDetails,
        }),
        text(input.runtime.cutoverAt),
        errorCode,
        errorMessage,
        blockedAt,
      ),
      env.DB.prepare(
        `UPDATE yoco_v2_refund_workflows
         SET inventory_status='MANUAL_REVIEW_REQUIRED',overall_status='MANUAL_REVIEW_REQUIRED',last_error_code=?3,last_error_message=?4,updated_at=?5
         WHERE workspace_id=?1 AND domain_event_id=?2`,
      ).bind(
        input.canonical.workspace_id,
        text(input.domainEvent.id),
        errorCode,
        errorMessage,
        blockedAt,
      ),
    ]);
    await appendTimeline(env.DB, {
      rawEventId: input.rawEventId,
      processingRunId: input.processingRunId,
      step: "LIVE_REFUND_STOCK_BLOCKED_ORIGINAL_MOVEMENTS_MISSING",
      status: "MANUAL_REVIEW_REQUIRED",
      message:
        "V2 blocked the refund stock return because immutable original sale movements were unavailable or unresolved.",
      metadata: {
        source_order_id: input.canonical.source_order_id,
        warnings: warningDetails,
      },
    });
    return "BLOCKED";
  }
  const proposals = (all.results || []).filter(
    (row) =>
      numberValue(row.quantity) > 0 &&
      text(row.location_id) &&
      text(row.ingredient_item_id),
  );
  if (!proposals.length) return "BLOCKED";
  const already = await env.DB.prepare(
    `SELECT COUNT(*) count FROM yoco_v2_live_refund_stock_effects WHERE workspace_id=?1 AND refund_id=?2 AND status='APPLIED'`,
  )
    .bind(input.canonical.workspace_id, input.canonical.refund_id)
    .first<Row>();
  if (numberValue(already?.count) >= proposals.length) return "DUPLICATE";
  const capacity = await loadReturnCapacity(
    env,
    input.canonical.workspace_id,
    input.canonical.source_order_id,
  );
  const needed = new Map<string, number>();
  for (const p of proposals) {
    const key = `${text(p.ingredient_item_id)}|${text(p.location_id)}`;
    needed.set(key, (needed.get(key) || 0) + numberValue(p.quantity));
  }
  for (const [key, qty] of needed) {
    if (qty > (capacity.get(key) || 0) + 0.000001) {
      const blockedAt = nowIso(),
        blockedKey = `refund-stock:${input.canonical.refund_id}:${input.canonical.schema_version}`;
      const blockedId = await stableId(
        "yoco_v2_refund_outbox",
        `${input.canonical.workspace_id}|REFUND_STOCK|${blockedKey}`,
      );
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO yoco_v2_live_refund_effect_outbox (id,workspace_id,integration_id,domain_event_id,refund_id,effect_type,effect_key,status,payload_json,cutover_at,attempt_count,last_error_code,last_error_message,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'REFUND_STOCK',?6,'BLOCKED',?7,?8,1,'YOCO_V2_REFUND_OVER_RETURN_BLOCKED',?9,?10,?10) ON CONFLICT(workspace_id,effect_type,effect_key) DO UPDATE SET status='BLOCKED',last_error_code=excluded.last_error_code,last_error_message=excluded.last_error_message,payload_json=excluded.payload_json,updated_at=excluded.updated_at`,
        ).bind(
          blockedId,
          input.canonical.workspace_id,
          input.canonical.integration_id,
          text(input.domainEvent.id),
          input.canonical.refund_id,
          blockedKey,
          JSON.stringify({
            ingredient_location: key,
            requested_quantity: qty,
            remaining_return_capacity: capacity.get(key) || 0,
          }),
          text(input.runtime.cutoverAt),
          `Requested ${qty} exceeds remaining return capacity ${capacity.get(key) || 0}.`,
          blockedAt,
        ),
        env.DB.prepare(
          `UPDATE yoco_v2_refund_workflows SET inventory_status='MANUAL_REVIEW_REQUIRED',overall_status='MANUAL_REVIEW_REQUIRED',last_error_code='YOCO_V2_REFUND_OVER_RETURN_BLOCKED',last_error_message=?3,updated_at=?4 WHERE workspace_id=?1 AND domain_event_id=?2`,
        ).bind(
          input.canonical.workspace_id,
          text(input.domainEvent.id),
          `Requested ${qty} exceeds remaining return capacity ${capacity.get(key) || 0} for ${key}.`,
          blockedAt,
        ),
      ]);
      await appendTimeline(env.DB, {
        rawEventId: input.rawEventId,
        processingRunId: input.processingRunId,
        step: "LIVE_REFUND_STOCK_BLOCKED_OVER_RETURN",
        status: "MANUAL_REVIEW_REQUIRED",
        message:
          "V2 blocked a refund stock return because cumulative returned quantity would exceed the original sale deduction.",
        metadata: {
          ingredient_location: key,
          requested_quantity: qty,
          remaining_return_capacity: capacity.get(key) || 0,
        },
      });
      return "BLOCKED";
    }
  }
  const now = nowIso(),
    occurredAt = johannesburgIso(input.canonical.occurred_at),
    outboxKey = `refund-stock:${input.canonical.refund_id}:${input.canonical.schema_version}`;
  const outboxId = await stableId(
    "yoco_v2_refund_outbox",
    `${input.canonical.workspace_id}|REFUND_STOCK|${outboxKey}`,
  );
  const statements = [
    env.DB.prepare(
      `INSERT INTO yoco_v2_live_refund_effect_outbox (id,workspace_id,integration_id,domain_event_id,refund_id,effect_type,effect_key,status,payload_json,cutover_at,attempt_count,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,'REFUND_STOCK',?6,'PROCESSING',?7,?8,1,?9,?9) ON CONFLICT(workspace_id,effect_type,effect_key) DO UPDATE SET status=CASE WHEN status='APPLIED' THEN 'APPLIED' ELSE 'PROCESSING' END,attempt_count=attempt_count+1,updated_at=excluded.updated_at`,
    ).bind(
      outboxId,
      input.canonical.workspace_id,
      input.canonical.integration_id,
      text(input.domainEvent.id),
      input.canonical.refund_id,
      outboxKey,
      JSON.stringify({
        source_order_id: input.canonical.source_order_id,
        proposal_count: proposals.length,
      }),
      text(input.runtime.cutoverAt),
      now,
    ),
  ];
  for (const p of proposals) {
    const canonicalLine = input.canonical.lines.find(
      (line) =>
        text(line.source_original_line_id) ===
          text(p.source_original_line_id) ||
        text(line.source_refund_line_id) === text(p.source_refund_line_id),
    );
    const canonicalModifier = (canonicalLine?.modifiers || []).find(
      (modifier) => text(modifier.mapped_modifier_id) === text(p.modifier_id),
    );
    const reversalMetadata = parseJson(p.reversal_metadata_json);
    const isNoteRule = text(p.modifier_id).startsWith("note:");
    const effectKey = `refund-stock:${text(p.proposal_key)}`,
      effectId = await stableId(
        "yoco_v2_refund_stock_effect",
        `${input.canonical.workspace_id}|${effectKey}`,
      ),
      movementId = await stableId(
        "stock_movement_refund_v2",
        `${input.canonical.workspace_id}|${effectKey}`,
      );
    const qty = Math.abs(numberValue(p.quantity)),
      unitCost = Math.max(0, numberValue(p.unit_cost_ex_vat));
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO yoco_v2_live_refund_stock_effects (id,workspace_id,domain_event_id,source_order_id,refund_id,proposal_key,effect_key,movement_id,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'PENDING',?9,?9)`,
      ).bind(
        effectId,
        input.canonical.workspace_id,
        text(input.domainEvent.id),
        input.canonical.source_order_id,
        input.canonical.refund_id,
        text(p.proposal_key),
        effectKey,
        movementId,
        now,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO stock_balances (workspace_id,stock_item_id,location_id,quantity,updated_at) VALUES (?1,?2,?3,0,?4)`,
      ).bind(
        input.canonical.workspace_id,
        text(p.ingredient_item_id),
        text(p.location_id),
        now,
      ),
      env.DB.prepare(
        `UPDATE stock_balances SET quantity=quantity+?4,updated_at=?5 WHERE workspace_id=?1 AND stock_item_id=?2 AND location_id=?3 AND EXISTS (SELECT 1 FROM yoco_v2_live_refund_stock_effects e WHERE e.workspace_id=?1 AND e.effect_key=?6 AND e.status='PENDING')`,
      ).bind(
        input.canonical.workspace_id,
        text(p.ingredient_item_id),
        text(p.location_id),
        qty,
        now,
        effectKey,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO stock_movements (id,workspace_id,stock_item_id,location_id,movement_type,document_type,document_id,source_location_id,destination_location_id,quantity_delta,unit_cost,value_delta,occurred_at,created_by,metadata_json,created_at)
        SELECT ?1,?2,?3,?4,'sale_refund','yoco_order',?5,?4,NULL,?6,?7,?8,?9,'yoco-v2',?10,?11 WHERE EXISTS (SELECT 1 FROM yoco_v2_live_refund_stock_effects e WHERE e.workspace_id=?2 AND e.effect_key=?12 AND e.status='PENDING')`,
      ).bind(
        movementId,
        input.canonical.workspace_id,
        text(p.ingredient_item_id),
        text(p.location_id),
        input.canonical.source_order_id,
        qty,
        unitCost,
        qty * unitCost,
        occurredAt,
        JSON.stringify({
          engine: "V2",
          effect_type: "REFUND_STOCK",
          effect_key: effectKey,
          proposal_key: p.proposal_key,
          domain_event_id: input.domainEvent.id,
          mode: "refund",
          refundId: input.canonical.refund_id,
          sourceOrderId: input.canonical.source_order_id,
          reportOrderKey: `${input.canonical.source_order_id}:refund:${input.canonical.refund_id}`,
          componentType: text(p.modifier_id)
            ? isNoteRule
              ? "note"
              : "modifier"
            : "product",
          componentLineId: p.source_refund_line_id || p.source_original_line_id,
          productId: p.menu_item_id || null,
          productName: canonicalLine?.source_name || null,
          parentProductId: p.menu_item_id || null,
          parentProductName: canonicalLine?.source_name || null,
          modifierId: p.modifier_id || null,
          modifierName: canonicalModifier?.source_name || null,
          sourceRefundLineId: p.source_refund_line_id,
          sourceOriginalLineId: p.source_original_line_id,
          base_uom: p.base_uom,
          cutover_at: input.runtime.cutoverAt,
          reversesMovementId: reversalMetadata.source_movement_id || null,
          sourceSaleSnapshotId: reversalMetadata.source_snapshot_id || null,
          sourceSaleProposalKey: reversalMetadata.source_proposal_key || null,
          modifierRuleId: isNoteRule
            ? null
            : reversalMetadata.source_rule_id || null,
          modifierRuleVersion: isNoteRule
            ? null
            : reversalMetadata.source_rule_version || null,
          modifierActionType: isNoteRule
            ? null
            : reversalMetadata.source_action_type || null,
          noteRuleId: isNoteRule
            ? reversalMetadata.source_rule_id || null
            : null,
          noteRuleVersion: isNoteRule
            ? reversalMetadata.source_rule_version || null
            : null,
          noteActionType: isNoteRule
            ? reversalMetadata.source_action_type || null
            : null,
          sourceRuleSnapshot: reversalMetadata.source_rule_snapshot || {},
        }),
        now,
        effectKey,
      ),
      env.DB.prepare(
        `UPDATE yoco_v2_live_refund_stock_effects SET status='APPLIED',applied_at=?3,updated_at=?3 WHERE workspace_id=?1 AND effect_key=?2 AND status='PENDING' AND EXISTS (SELECT 1 FROM stock_movements WHERE id=movement_id)`,
      ).bind(input.canonical.workspace_id, effectKey, now),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE yoco_v2_live_refund_effect_outbox SET status='APPLIED',applied_at=?3,updated_at=?3,last_error_code=NULL,last_error_message=NULL WHERE workspace_id=?1 AND effect_type='REFUND_STOCK' AND effect_key=?2`,
    ).bind(input.canonical.workspace_id, outboxKey, now),
    env.DB.prepare(
      `UPDATE yoco_v2_refund_workflows SET inventory_status='RESOLVED',updated_at=?3 WHERE workspace_id=?1 AND domain_event_id=?2`,
    ).bind(input.canonical.workspace_id, text(input.domainEvent.id), now),
  );
  await env.DB.batch(statements);
  await appendTimeline(env.DB, {
    rawEventId: input.rawEventId,
    processingRunId: input.processingRunId,
    step: "LIVE_REFUND_STOCK_APPLIED",
    status: "COMPLETED",
    message:
      "Controlled V2 refund stock returns were applied to stock_movements with deterministic keys and return-capacity protection.",
    metadata: {
      effect_key: outboxKey,
      movement_count: proposals.length,
      occurred_at: occurredAt,
    },
  });
  return "APPLIED";
}

export async function applyControlledLiveRefundEffects(
  env: Env,
  input: {
    domainEvent: Row;
    canonical: CanonicalSaleRefundedEvent;
    rawEvent: Row;
    rawEventId: string;
    processingRunId: string;
    message: YocoV2QueueMessage;
  },
): Promise<Row> {
  if (!input.message.live_effects)
    return { reporting: "DIAGNOSTIC_ONLY", stock: "DIAGNOSTIC_ONLY" };
  if (input.canonical.event_type !== "sale.refunded")
    return { reporting: "NOT_A_REFUND", stock: "NOT_A_REFUND" };
  if (input.canonical.currency.toUpperCase() !== "ZAR")
    throw new Error(
      `YOCO_V2_LIVE_REFUND_CURRENCY_UNSUPPORTED:${input.canonical.currency}`,
    );
  const [reportingRuntime, stockRuntime] = await Promise.all([
    getRefundEffectRuntime(
      env,
      input.canonical.workspace_id,
      input.canonical.integration_id,
      "REFUND_REPORTING",
    ),
    getRefundEffectRuntime(
      env,
      input.canonical.workspace_id,
      input.canonical.integration_id,
      "REFUND_STOCK",
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
    financial_status: input.canonical.financial_resolution_status,
    inventory_status: input.canonical.inventory_resolution_status,
  };
}
