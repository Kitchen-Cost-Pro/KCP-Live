import type { Env } from "../../legacy/types";
import { deriveYocoFinancialAmounts } from "../../../../src/modules/reporting/engine/yocoFinancials.js";
import {
  loadSaleMovementReversals,
  type SaleMovementReversal,
} from "../modifier-engine/reliability";
import type {
  CanonicalRefundLine,
  CanonicalSaleRefundedEvent,
  YocoV2ComparisonStatus,
} from "./contracts";
import { appendTimeline, newId, nowIso, type Row } from "./repository";

function text(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim();
}
function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function parseJson(value: unknown): Row {
  try {
    const parsed = JSON.parse(text(value, "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}
function moneyEqual(left: number, right: number, tolerance = 0.02): boolean {
  return Math.abs(left - right) <= tolerance;
}

interface RefundIngredientProposal {
  sourceRefundLineId: string;
  sourceOriginalLineId: string;
  menuItemId?: string;
  modifierId?: string;
  ingredientItemId: string;
  locationId?: string;
  quantity: number;
  baseUom: string;
  unitCost: number;
  warningCode?: string;
  resolutionStatus: string;
  reversalMetadata?: Row;
}

function originalLineQuantity(line: CanonicalRefundLine): number {
  const original =
    line.metadata &&
    typeof line.metadata.original_line === "object" &&
    line.metadata.original_line
      ? (line.metadata.original_line as Row)
      : {};
  return Math.max(
    0.000001,
    Math.abs(
      numberValue(
        original.quantity ?? original.qty ?? original.count,
        line.quantity,
      ),
    ),
  );
}

function reversalProposal(
  line: CanonicalRefundLine,
  reversal: SaleMovementReversal,
): RefundIngredientProposal {
  return {
    sourceRefundLineId: line.source_refund_line_id,
    sourceOriginalLineId: line.source_original_line_id,
    menuItemId: reversal.menuItemId || line.mapped_menu_item_id,
    modifierId: reversal.modifierId,
    ingredientItemId: reversal.ingredientItemId,
    locationId: reversal.locationId,
    quantity: Math.abs(reversal.quantity),
    baseUom: reversal.baseUom,
    unitCost: reversal.unitCost,
    resolutionStatus: "RESOLVED",
    reversalMetadata: {
      source_snapshot_id: reversal.sourceSnapshotId || null,
      source_movement_id: reversal.sourceMovementId || null,
      source_proposal_key: reversal.sourceProposalKey || null,
      source_rule_id: reversal.ruleId || null,
      source_rule_version: reversal.ruleVersion || null,
      source_action_type: reversal.actionType || null,
      source_rule_snapshot: reversal.metadata || {},
    },
  };
}

function aggregate(
  proposals: RefundIngredientProposal[],
): RefundIngredientProposal[] {
  const rows = new Map<string, RefundIngredientProposal>();
  for (const proposal of proposals) {
    const sourceReference = text(
      proposal.reversalMetadata?.source_snapshot_id ||
        proposal.reversalMetadata?.source_movement_id ||
        proposal.reversalMetadata?.source_proposal_key,
    );
    const key = [
      proposal.sourceRefundLineId,
      proposal.sourceOriginalLineId,
      proposal.menuItemId || "",
      proposal.modifierId || "",
      proposal.ingredientItemId,
      proposal.locationId || "",
      sourceReference,
      proposal.warningCode || "",
    ].join("|");
    const existing = rows.get(key);
    if (existing && !proposal.warningCode)
      existing.quantity += proposal.quantity;
    else rows.set(key, { ...proposal });
  }
  return [...rows.values()];
}

export async function buildRefundReportingProposal(
  env: Env,
  domainEvent: Row,
  canonical: CanonicalSaleRefundedEvent,
  rawEventId: string,
  processingRunId: string,
): Promise<Row> {
  const proposalKey = `refund-reporting:${canonical.refund_id}`;
  const now = nowIso();
  const existing = await env.DB.prepare(
    `SELECT id, created_at FROM yoco_v2_proposed_refund_reporting WHERE workspace_id = ?1 AND proposal_key = ?2 LIMIT 1`,
  )
    .bind(canonical.workspace_id, proposalKey)
    .first<Row>();
  const id = text(existing?.id) || newId("yoco_v2_refund_reporting");
  await env.DB.prepare(
    `INSERT INTO yoco_v2_proposed_refund_reporting
      (id, domain_event_id, workspace_id, source_order_id, refund_id, gross_amount, discount_amount,
       net_amount, tax_amount, tip_amount, proposal_key, resolution_status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
     ON CONFLICT(workspace_id, proposal_key) DO UPDATE SET
       domain_event_id = excluded.domain_event_id,
       source_order_id = excluded.source_order_id,
       gross_amount = excluded.gross_amount,
       discount_amount = excluded.discount_amount,
       net_amount = excluded.net_amount,
       tax_amount = excluded.tax_amount,
       tip_amount = excluded.tip_amount,
       resolution_status = excluded.resolution_status,
       updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      text(domainEvent.id),
      canonical.workspace_id,
      canonical.source_order_id,
      canonical.refund_id,
      canonical.gross_amount,
      canonical.discount_amount,
      canonical.net_amount,
      canonical.tax_amount,
      canonical.tip_amount,
      proposalKey,
      canonical.financial_resolution_status,
      text(existing?.created_at) || now,
    )
    .run();
  await appendTimeline(env.DB, {
    rawEventId,
    processingRunId,
    step: "REPORTING_PROPOSAL_CREATED",
    status: canonical.financial_resolution_status,
    message:
      "Canonical V2 refund reporting proposal stored before controlled live application.",
    metadata: {
      proposal_id: id,
      refund_id: canonical.refund_id,
      gross_amount: canonical.gross_amount,
    },
  });
  return (
    (await env.DB.prepare(
      `SELECT * FROM yoco_v2_proposed_refund_reporting WHERE id = ?1`,
    )
      .bind(id)
      .first<Row>()) || { id }
  );
}

export async function buildRefundStockProposals(
  env: Env,
  domainEvent: Row,
  canonical: CanonicalSaleRefundedEvent,
  rawEventId: string,
  processingRunId: string,
): Promise<Row[]> {
  const proposals: RefundIngredientProposal[] = [];
  if (canonical.inventory_resolution_status === "RESOLVED") {
    for (const line of canonical.lines) {
      const reversals = await loadSaleMovementReversals(env, {
        workspaceId: canonical.workspace_id,
        sourceOrderId: canonical.source_order_id,
        sourceLineId: line.source_original_line_id,
        refundQuantity: Math.abs(line.quantity),
        originalLineQuantity: originalLineQuantity(line),
      });
      if (!reversals.length) {
        proposals.push({
          sourceRefundLineId: line.source_refund_line_id,
          sourceOriginalLineId: line.source_original_line_id,
          menuItemId: line.mapped_menu_item_id,
          ingredientItemId: `unresolved-ledger:${line.source_original_line_id}`,
          locationId: canonical.kcp_location_id,
          quantity: 0,
          baseUom: "",
          unitCost: 0,
          warningCode: "ORIGINAL_SALE_LEDGER_MOVEMENTS_MISSING",
          resolutionStatus: "WARNING",
          reversalMetadata: { reversal_source: "IMMUTABLE_SALE_LEDGER" },
        });
        continue;
      }
      proposals.push(
        ...reversals.map((reversal) => reversalProposal(line, reversal)),
      );
    }
  }
  const aggregated = aggregate(proposals);
  const tableInfo = await env.DB.prepare(
    `PRAGMA table_info(yoco_v2_proposed_refund_stock_movements)`,
  ).all<Row>();
  const supportsReversalMetadata = (tableInfo.results || []).some(
    (column) => text(column.name) === "reversal_metadata_json",
  );
  const activeKeys: string[] = [];
  const now = nowIso();
  for (const proposal of aggregated) {
    const sourceReference = text(
      proposal.reversalMetadata?.source_snapshot_id ||
        proposal.reversalMetadata?.source_movement_id ||
        proposal.reversalMetadata?.source_proposal_key,
      "missing-source",
    );
    const key = [
      canonical.refund_id,
      proposal.sourceRefundLineId,
      proposal.sourceOriginalLineId,
      proposal.menuItemId || "",
      proposal.modifierId || "",
      proposal.ingredientItemId,
      proposal.locationId || "",
      sourceReference,
      proposal.warningCode || "movement",
    ].join("|");
    activeKeys.push(key);
    const existing = await env.DB.prepare(
      `SELECT id, created_at FROM yoco_v2_proposed_refund_stock_movements WHERE workspace_id = ?1 AND proposal_key = ?2 LIMIT 1`,
    )
      .bind(canonical.workspace_id, key)
      .first<Row>();
    const id = text(existing?.id) || newId("yoco_v2_refund_stock");
    const statement = supportsReversalMetadata
      ? env.DB.prepare(
          `INSERT INTO yoco_v2_proposed_refund_stock_movements
          (id, domain_event_id, workspace_id, location_id, source_order_id, refund_id,
           source_refund_line_id, source_original_line_id, menu_item_id, modifier_id,
           ingredient_item_id, movement_type, quantity, base_uom, unit_cost_ex_vat,
           movement_value, proposal_key, resolution_status, warning_code, reversal_metadata_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULLIF(?4, ''), ?5, ?6, ?7, ?8, NULLIF(?9, ''), NULLIF(?10, ''),
           ?11, 'sale_refund_proposal', ?12, ?13, ?14, ?15, ?16, ?17, NULLIF(?18, ''), ?19, ?20, ?20)
         ON CONFLICT(workspace_id, proposal_key) DO UPDATE SET
           domain_event_id = excluded.domain_event_id,
           location_id = excluded.location_id,
           quantity = excluded.quantity,
           base_uom = excluded.base_uom,
           unit_cost_ex_vat = excluded.unit_cost_ex_vat,
           movement_value = excluded.movement_value,
           resolution_status = excluded.resolution_status,
           warning_code = excluded.warning_code,
           reversal_metadata_json = excluded.reversal_metadata_json,
           updated_at = excluded.updated_at`,
        ).bind(
          id,
          text(domainEvent.id),
          canonical.workspace_id,
          proposal.locationId || "",
          canonical.source_order_id,
          canonical.refund_id,
          proposal.sourceRefundLineId,
          proposal.sourceOriginalLineId,
          proposal.menuItemId || "",
          proposal.modifierId || "",
          proposal.ingredientItemId,
          proposal.quantity,
          proposal.baseUom,
          proposal.unitCost,
          proposal.quantity * proposal.unitCost,
          key,
          proposal.resolutionStatus,
          proposal.warningCode || "",
          JSON.stringify(proposal.reversalMetadata || {}),
          text(existing?.created_at) || now,
        )
      : env.DB.prepare(
          `INSERT INTO yoco_v2_proposed_refund_stock_movements
          (id, domain_event_id, workspace_id, location_id, source_order_id, refund_id,
           source_refund_line_id, source_original_line_id, menu_item_id, modifier_id,
           ingredient_item_id, movement_type, quantity, base_uom, unit_cost_ex_vat,
           movement_value, proposal_key, resolution_status, warning_code, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULLIF(?4, ''), ?5, ?6, ?7, ?8, NULLIF(?9, ''), NULLIF(?10, ''),
           ?11, 'sale_refund_proposal', ?12, ?13, ?14, ?15, ?16, ?17, NULLIF(?18, ''), ?19, ?19)
         ON CONFLICT(workspace_id, proposal_key) DO UPDATE SET
           domain_event_id = excluded.domain_event_id,
           location_id = excluded.location_id,
           quantity = excluded.quantity,
           base_uom = excluded.base_uom,
           unit_cost_ex_vat = excluded.unit_cost_ex_vat,
           movement_value = excluded.movement_value,
           resolution_status = excluded.resolution_status,
           warning_code = excluded.warning_code,
           updated_at = excluded.updated_at`,
        ).bind(
          id,
          text(domainEvent.id),
          canonical.workspace_id,
          proposal.locationId || "",
          canonical.source_order_id,
          canonical.refund_id,
          proposal.sourceRefundLineId,
          proposal.sourceOriginalLineId,
          proposal.menuItemId || "",
          proposal.modifierId || "",
          proposal.ingredientItemId,
          proposal.quantity,
          proposal.baseUom,
          proposal.unitCost,
          proposal.quantity * proposal.unitCost,
          key,
          proposal.resolutionStatus,
          proposal.warningCode || "",
          text(existing?.created_at) || now,
        );
    await statement.run();
  }
  if (activeKeys.length) {
    const placeholders = activeKeys
      .map((_, index) => `?${index + 2}`)
      .join(", ");
    await env.DB.prepare(
      `DELETE FROM yoco_v2_proposed_refund_stock_movements WHERE domain_event_id = ?1 AND proposal_key NOT IN (${placeholders})`,
    )
      .bind(text(domainEvent.id), ...activeKeys)
      .run();
  } else {
    await env.DB.prepare(
      `DELETE FROM yoco_v2_proposed_refund_stock_movements WHERE domain_event_id = ?1`,
    )
      .bind(text(domainEvent.id))
      .run();
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM yoco_v2_proposed_refund_stock_movements WHERE domain_event_id = ?1 ORDER BY source_original_line_id, modifier_id, ingredient_item_id`,
  )
    .bind(text(domainEvent.id))
    .all<Row>();
  await appendTimeline(env.DB, {
    rawEventId,
    processingRunId,
    step: "STOCK_PROPOSAL_CREATED",
    status: canonical.inventory_resolution_status,
    message:
      canonical.inventory_resolution_status === "RESOLVED"
        ? "Canonical V2 refund stock return proposals were generated only from immutable sale-time movement snapshots or original ledger rows."
        : "No automatic stock return proposal was created because inventory resolution requires review.",
    metadata: {
      refund_id: canonical.refund_id,
      proposal_count: rows.results.length,
      inventory_status: canonical.inventory_resolution_status,
      reversal_source: "ORIGINAL_SALE_MOVEMENTS",
    },
  });
  return rows.results || [];
}
