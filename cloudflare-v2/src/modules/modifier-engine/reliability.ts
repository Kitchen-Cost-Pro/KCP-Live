import type { Env } from "../../legacy/types";
import { newId, nowIso, type Row } from "../yoco-engine-v2/repository";
import { validateModifierRule, type ModifierRuleInput } from "./rules";

function text(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim();
}
function numberValue(value: unknown, fallback = 0): number {
  const valueNumber = Number(value);
  return Number.isFinite(valueNumber) ? valueNumber : fallback;
}
function objectValue(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}
function parseJson(value: unknown): Row {
  try {
    return objectValue(JSON.parse(text(value, "{}")));
  } catch {
    return {};
  }
}
function parseArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(text(value, "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function unique(values: unknown[]): string[] {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? unique(value) : unique(parseArray(value));
}
function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
function isMissingReliabilityTableError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return (
    /no such table: (modifier_sale_|modifier_engine_|modifier_note_)/i.test(
      message,
    ) || /no column named reversal_metadata_json/i.test(message)
  );
}

/** Exact note normalization only: case, trim, repeated spaces, and harmless punctuation. */
export function normalizeModifierNote(value: unknown): string {
  return text(value)
    .toLowerCase()
    .replace(/[.,;:!?()[\]{}"'`\\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function observeLineNotes(
  env: Env,
  input: {
    workspaceId: string;
    sourceOrderId: string;
    sourceLineId: string;
    menuItemId?: string;
    locationId?: string;
    notes: string[];
    observedAt?: string;
  },
): Promise<void> {
  try {
    const observedAt = text(input.observedAt, nowIso());
    for (const rawValue of unique(input.notes)) {
      const normalized = normalizeModifierNote(rawValue);
      if (!normalized) continue;
      const occurrenceId = newId("modifier_note_occurrence");
      const occurrence = await env.DB.prepare(
        `INSERT OR IGNORE INTO modifier_note_occurrences
        (id, workspace_id, source_order_id, source_line_id, menu_item_id, location_id,
         raw_text, normalized_text, observed_at)
       VALUES (?1, ?2, ?3, ?4, NULLIF(?5, ''), NULLIF(?6, ''), ?7, ?8, ?9)`,
      )
        .bind(
          occurrenceId,
          input.workspaceId,
          input.sourceOrderId,
          input.sourceLineId,
          text(input.menuItemId),
          text(input.locationId),
          rawValue,
          normalized,
          observedAt,
        )
        .run();
      if (numberValue(occurrence.meta?.changes) < 1) continue;

      const existing = await env.DB.prepare(
        `SELECT * FROM modifier_note_observations WHERE workspace_id = ?1 AND normalized_text = ?2 LIMIT 1`,
      )
        .bind(input.workspaceId, normalized)
        .first<Row>();
      const rawVariants = unique([
        ...stringArray(existing?.raw_variants_json),
        rawValue,
      ]);
      const menuItemIds = unique([
        ...stringArray(existing?.menu_item_ids_json),
        text(input.menuItemId),
      ]);
      const locationIds = unique([
        ...stringArray(existing?.location_ids_json),
        text(input.locationId),
      ]);
      const now = nowIso();
      await env.DB.prepare(
        `INSERT INTO modifier_note_observations
        (id, workspace_id, normalized_text, latest_raw_text, raw_variants_json,
         menu_item_ids_json, location_ids_json, times_seen, first_seen_at, last_seen_at,
         disposition, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8, 'SUGGESTED', ?9, ?9)
       ON CONFLICT(workspace_id, normalized_text) DO UPDATE SET
         latest_raw_text = excluded.latest_raw_text,
         raw_variants_json = excluded.raw_variants_json,
         menu_item_ids_json = excluded.menu_item_ids_json,
         location_ids_json = excluded.location_ids_json,
         times_seen = modifier_note_observations.times_seen + 1,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
      )
        .bind(
          text(existing?.id) || newId("modifier_note_observation"),
          input.workspaceId,
          normalized,
          rawValue,
          JSON.stringify(rawVariants),
          JSON.stringify(menuItemIds),
          JSON.stringify(locationIds),
          observedAt,
          now,
        )
        .run();
    }
  } catch (cause) {
    if (!isMissingReliabilityTableError(cause)) throw cause;
  }
}

export async function listModifierNoteSuggestions(
  env: Env,
  workspaceId: string,
  options: {
    includeIgnored?: boolean;
    minimumSeen?: number;
  } = {},
): Promise<Row[]> {
  const minimumSeen = Math.max(
    3,
    Math.floor(numberValue(options.minimumSeen, 3)),
  );
  const rows = await env.DB.prepare(
    `SELECT observation.*, rule.id AS rule_id, rule.action_type, rule.status AS rule_status,
            rule.version AS rule_version, rule.target_owner_type, rule.target_owner_id,
            rule.source_stock_item_id, rule.replacement_stock_item_id, rule.quantity, rule.unit,
            rule.menu_item_scope_json, rule.location_scope_json
       FROM modifier_note_observations observation
       LEFT JOIN modifier_note_rules rule
         ON rule.workspace_id = observation.workspace_id
        AND rule.normalized_text = observation.normalized_text
      WHERE observation.workspace_id = ?1
        AND observation.times_seen >= ?2
        AND (?3 = 1 OR observation.disposition <> 'IGNORED')
      ORDER BY observation.times_seen DESC, observation.last_seen_at DESC`,
  )
    .bind(workspaceId, minimumSeen, options.includeIgnored ? 1 : 0)
    .all<Row>();
  return (rows.results || []).map((row) => ({
    id: text(row.id),
    normalizedText: text(row.normalized_text),
    notePhrase: text(row.latest_raw_text),
    rawVariants: stringArray(row.raw_variants_json),
    menuItemIds: stringArray(row.menu_item_ids_json),
    locationIds: stringArray(row.location_ids_json),
    timesSeen: numberValue(row.times_seen),
    firstSeen: text(row.first_seen_at),
    lastSeen: text(row.last_seen_at),
    disposition: text(row.disposition),
    rule: row.rule_id
      ? {
          id: text(row.rule_id),
          actionType: text(row.action_type),
          status: text(row.rule_status),
          version: numberValue(row.rule_version, 1),
          targetOwnerType: text(row.target_owner_type),
          targetOwnerId: text(row.target_owner_id),
          sourceStockItemId: text(row.source_stock_item_id),
          replacementStockItemId: text(row.replacement_stock_item_id),
          quantity: numberValue(row.quantity, 1),
          unit: text(row.unit, "ea"),
          menuItemIds: stringArray(row.menu_item_scope_json),
          locationIds: stringArray(row.location_scope_json),
        }
      : null,
  }));
}

export async function upsertModifierNoteRule(
  env: Env,
  input: {
    workspaceId: string;
    noteText: string;
    rule: ModifierRuleInput;
    actor?: string;
  },
): Promise<Row> {
  const normalizedText = normalizeModifierNote(input.noteText);
  if (!normalizedText) throw new Error("NOTE_RULE_TEXT_REQUIRED");
  const validated = await validateModifierRule(env, {
    workspaceId: input.workspaceId,
    ownerId: `note:${normalizedText}`,
    rule: { ...input.rule, sourceName: input.noteText },
  });
  const existing = await env.DB.prepare(
    `SELECT id, version, created_at FROM modifier_note_rules WHERE workspace_id = ?1 AND normalized_text = ?2 LIMIT 1`,
  )
    .bind(input.workspaceId, normalizedText)
    .first<Row>();
  const id = text(existing?.id) || newId("modifier_note_rule");
  const version = Math.max(1, numberValue(existing?.version) + 1);
  const now = nowIso();
  const snapshot = {
    normalizedText,
    sourceName: text(input.noteText),
    actionType: validated.actionType,
    targetOwnerType: validated.targetOwnerType,
    targetOwnerId: validated.targetOwnerId,
    sourceStockItemId: validated.sourceStockItemId,
    replacementStockItemId: validated.replacementStockItemId,
    quantity: validated.quantity,
    unit: validated.unit,
    menuItemIds: validated.menuItemIds,
    locationIds: validated.locationIds,
    status: "APPROVED",
    version,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO modifier_note_rules
        (id, workspace_id, normalized_text, source_name, action_type, target_owner_type,
         target_owner_id, source_stock_item_id, replacement_stock_item_id, quantity, unit,
         menu_item_scope_json, location_scope_json, status, version, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), NULLIF(?7, ''), NULLIF(?8, ''),
         NULLIF(?9, ''), ?10, ?11, ?12, ?13, 'APPROVED', ?14, NULLIF(?15, ''), ?16, ?16)
       ON CONFLICT(workspace_id, normalized_text) DO UPDATE SET
         source_name = excluded.source_name,
         action_type = excluded.action_type,
         target_owner_type = excluded.target_owner_type,
         target_owner_id = excluded.target_owner_id,
         source_stock_item_id = excluded.source_stock_item_id,
         replacement_stock_item_id = excluded.replacement_stock_item_id,
         quantity = excluded.quantity,
         unit = excluded.unit,
         menu_item_scope_json = excluded.menu_item_scope_json,
         location_scope_json = excluded.location_scope_json,
         status = 'APPROVED',
         version = excluded.version,
         updated_at = excluded.updated_at`,
    ).bind(
      id,
      input.workspaceId,
      normalizedText,
      text(input.noteText),
      validated.actionType,
      validated.targetOwnerType,
      validated.targetOwnerId,
      validated.sourceStockItemId,
      validated.replacementStockItemId,
      validated.quantity,
      validated.unit,
      JSON.stringify(validated.menuItemIds),
      JSON.stringify(validated.locationIds),
      version,
      text(input.actor),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO modifier_note_rule_versions
        (id, workspace_id, modifier_note_rule_id, version, snapshot_json, changed_by, changed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), ?7)`,
    ).bind(
      newId("modifier_note_rule_version"),
      input.workspaceId,
      id,
      version,
      JSON.stringify(snapshot),
      text(input.actor),
      now,
    ),
    env.DB.prepare(
      `UPDATE modifier_note_observations SET disposition = 'APPROVED', updated_at = ?3
        WHERE workspace_id = ?1 AND normalized_text = ?2`,
    ).bind(input.workspaceId, normalizedText, now),
  ]);
  return { id, ...snapshot };
}

export async function setModifierNoteDisposition(
  env: Env,
  input: {
    workspaceId: string;
    noteText: string;
    disposition: "IGNORED" | "SUGGESTED";
  },
): Promise<void> {
  const normalized = normalizeModifierNote(input.noteText);
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE modifier_note_observations SET disposition = ?3, updated_at = ?4
        WHERE workspace_id = ?1 AND normalized_text = ?2`,
    ).bind(input.workspaceId, normalized, input.disposition, now),
    env.DB.prepare(
      `UPDATE modifier_note_rules SET status = ?3, updated_at = ?4
        WHERE workspace_id = ?1 AND normalized_text = ?2`,
    ).bind(
      input.workspaceId,
      normalized,
      input.disposition === "IGNORED" ? "IGNORED" : "INACTIVE",
      now,
    ),
  ]);
}

export async function getApplicableNoteRules(
  env: Env,
  input: {
    workspaceId: string;
    normalizedNotes: string[];
    menuItemId?: string;
    locationId?: string;
  },
): Promise<Row[]> {
  const notes = unique(input.normalizedNotes.map(normalizeModifierNote));
  if (!notes.length) return [];
  const placeholders = notes.map((_, index) => `?${index + 2}`).join(", ");
  const rows = await env.DB.prepare(
    `SELECT * FROM modifier_note_rules
      WHERE workspace_id = ?1 AND status = 'APPROVED' AND normalized_text IN (${placeholders})`,
  )
    .bind(input.workspaceId, ...notes)
    .all<Row>();
  return (rows.results || []).filter((row) => {
    const menuScope = stringArray(row.menu_item_scope_json);
    const locationScope = stringArray(row.location_scope_json);
    if (menuScope.length && !menuScope.includes(text(input.menuItemId)))
      return false;
    if (locationScope.length && !locationScope.includes(text(input.locationId)))
      return false;
    return true;
  });
}

export async function snapshotSaleAction(
  env: Env,
  input: {
    workspaceId: string;
    domainEventId: string;
    sourceOrderId: string;
    sourceLineId: string;
    menuItemId?: string;
    sourceKind: "MODIFIER" | "NOTE";
    sourceKey: string;
    sourceName?: string;
    rule?: Row | null;
    actionType: string;
    originalLineQuantity: number;
    locationId?: string;
  },
): Promise<void> {
  const now = nowIso();
  const ruleSnapshot = input.rule
    ? {
        id: text(input.rule.id),
        version: numberValue(input.rule.version, 1),
        actionType: text(input.rule.action_type, input.actionType),
        targetOwnerType: text(input.rule.target_owner_type),
        targetOwnerId: text(input.rule.target_owner_id),
        sourceStockItemId: text(input.rule.source_stock_item_id),
        replacementStockItemId: text(input.rule.replacement_stock_item_id),
        quantity: numberValue(input.rule.quantity, 1),
        unit: text(input.rule.unit, "ea"),
        menuItemIds: stringArray(input.rule.menu_item_scope_json),
        locationIds: stringArray(input.rule.location_scope_json),
      }
    : { actionType: input.actionType };
  try {
    await env.DB.prepare(
      `INSERT INTO modifier_sale_action_snapshots
      (id, workspace_id, domain_event_id, source_order_id, source_line_id, menu_item_id,
       source_kind, source_key, source_name, rule_id, rule_version, action_type,
       original_line_quantity, location_id, rule_snapshot_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), ?7, ?8, NULLIF(?9, ''),
       NULLIF(?10, ''), ?11, ?12, ?13, NULLIF(?14, ''), ?15, ?16, ?16)
     ON CONFLICT(workspace_id, source_order_id, source_line_id, source_kind, source_key)
     DO UPDATE SET domain_event_id = excluded.domain_event_id,
       menu_item_id = excluded.menu_item_id,
       source_name = excluded.source_name,
       rule_id = excluded.rule_id,
       rule_version = excluded.rule_version,
       action_type = excluded.action_type,
       original_line_quantity = excluded.original_line_quantity,
       location_id = excluded.location_id,
       rule_snapshot_json = excluded.rule_snapshot_json,
       updated_at = excluded.updated_at`,
    )
      .bind(
        newId("modifier_sale_action"),
        input.workspaceId,
        input.domainEventId,
        input.sourceOrderId,
        input.sourceLineId,
        text(input.menuItemId),
        input.sourceKind,
        input.sourceKey,
        text(input.sourceName),
        text(input.rule?.id),
        numberValue(input.rule?.version, 1),
        input.actionType,
        Math.max(0.000001, Math.abs(input.originalLineQuantity)),
        text(input.locationId),
        JSON.stringify(ruleSnapshot),
        now,
      )
      .run();
  } catch (cause) {
    if (!isMissingReliabilityTableError(cause)) throw cause;
  }
}

export async function snapshotSaleMovement(
  env: Env,
  input: {
    workspaceId: string;
    domainEventId: string;
    sourceOrderId: string;
    sourceLineId: string;
    menuItemId?: string;
    modifierId?: string;
    ingredientItemId: string;
    locationId: string;
    originalLineQuantity: number;
    movementQuantity: number;
    baseUom: string;
    unitCost: number;
    proposalKey: string;
    ruleId?: string;
    ruleVersion?: number;
    actionType?: string;
    ruleSnapshot?: Row;
  },
): Promise<void> {
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO modifier_sale_movement_snapshots
      (id, workspace_id, domain_event_id, source_order_id, source_line_id, menu_item_id,
       modifier_id, ingredient_item_id, location_id, original_line_quantity, movement_quantity,
       base_uom, unit_cost_ex_vat, movement_value, proposal_key, modifier_rule_id,
       modifier_rule_version, modifier_action_type, rule_snapshot_json, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), NULLIF(?7, ''), ?8, ?9, ?10,
       ?11, ?12, ?13, ?14, ?15, NULLIF(?16, ''), ?17, NULLIF(?18, ''), ?19, 'PROPOSED', ?20, ?20)
     ON CONFLICT(workspace_id, proposal_key) DO UPDATE SET
       domain_event_id = excluded.domain_event_id,
       movement_quantity = CASE WHEN modifier_sale_movement_snapshots.status = 'APPLIED'
         THEN modifier_sale_movement_snapshots.movement_quantity ELSE excluded.movement_quantity END,
       unit_cost_ex_vat = CASE WHEN modifier_sale_movement_snapshots.status = 'APPLIED'
         THEN modifier_sale_movement_snapshots.unit_cost_ex_vat ELSE excluded.unit_cost_ex_vat END,
       movement_value = CASE WHEN modifier_sale_movement_snapshots.status = 'APPLIED'
         THEN modifier_sale_movement_snapshots.movement_value ELSE excluded.movement_value END,
       updated_at = excluded.updated_at`,
    )
      .bind(
        newId("modifier_sale_movement"),
        input.workspaceId,
        input.domainEventId,
        input.sourceOrderId,
        input.sourceLineId,
        text(input.menuItemId),
        text(input.modifierId),
        input.ingredientItemId,
        input.locationId,
        Math.max(0.000001, Math.abs(input.originalLineQuantity)),
        input.movementQuantity,
        input.baseUom,
        input.unitCost,
        input.movementQuantity * input.unitCost,
        input.proposalKey,
        text(input.ruleId),
        numberValue(input.ruleVersion, 0) || null,
        text(input.actionType),
        JSON.stringify(input.ruleSnapshot || {}),
        now,
      )
      .run();
  } catch (cause) {
    if (!isMissingReliabilityTableError(cause)) throw cause;
  }
}

export async function markSaleMovementSnapshotApplied(
  env: Env,
  input: {
    workspaceId: string;
    proposalKey: string;
    movementId: string;
    quantity: number;
    unitCost: number;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE modifier_sale_movement_snapshots
        SET original_movement_id = ?3, movement_quantity = ?4, unit_cost_ex_vat = ?5,
            movement_value = ?4 * ?5, status = 'APPLIED', updated_at = ?6
      WHERE workspace_id = ?1 AND proposal_key = ?2`,
    )
      .bind(
        input.workspaceId,
        input.proposalKey,
        input.movementId,
        input.quantity,
        input.unitCost,
        nowIso(),
      )
      .run();
  } catch (cause) {
    if (!isMissingReliabilityTableError(cause)) throw cause;
  }
}

export interface SaleMovementReversal {
  sourceSnapshotId?: string;
  sourceMovementId?: string;
  sourceProposalKey?: string;
  sourceLineId: string;
  menuItemId?: string;
  modifierId?: string;
  ingredientItemId: string;
  locationId: string;
  quantity: number;
  baseUom: string;
  unitCost: number;
  ruleId?: string;
  ruleVersion?: number;
  actionType?: string;
  metadata: Row;
}

export async function loadSaleMovementReversals(
  env: Env,
  input: {
    workspaceId: string;
    sourceOrderId: string;
    sourceLineId: string;
    refundQuantity: number;
    originalLineQuantity: number;
  },
): Promise<SaleMovementReversal[]> {
  const ratio = Math.min(
    1,
    Math.max(0, Math.abs(input.refundQuantity)) /
      Math.max(0.000001, Math.abs(input.originalLineQuantity)),
  );
  let snapshotRows: Row[] = [];
  try {
    const rows = await env.DB.prepare(
      `SELECT * FROM modifier_sale_movement_snapshots
        WHERE workspace_id = ?1 AND source_order_id = ?2 AND source_line_id = ?3
        ORDER BY CASE status WHEN 'APPLIED' THEN 0 ELSE 1 END, proposal_key`,
    )
      .bind(input.workspaceId, input.sourceOrderId, input.sourceLineId)
      .all<Row>();
    snapshotRows = rows.results || [];
  } catch (cause) {
    if (!isMissingReliabilityTableError(cause)) throw cause;
  }
  const appliedSnapshotRows = snapshotRows.filter(
    (row) =>
      text(row.status).toUpperCase() === "APPLIED" &&
      numberValue(row.movement_quantity) < 0,
  );
  if (appliedSnapshotRows.length) {
    return appliedSnapshotRows
      .map((row) => ({
        sourceSnapshotId: text(row.id),
        sourceMovementId: text(row.original_movement_id) || undefined,
        sourceProposalKey: text(row.proposal_key),
        sourceLineId: text(row.source_line_id),
        menuItemId: text(row.menu_item_id) || undefined,
        modifierId: text(row.modifier_id) || undefined,
        ingredientItemId: text(row.ingredient_item_id),
        locationId: text(row.location_id),
        quantity: Math.abs(numberValue(row.movement_quantity)) * ratio,
        baseUom: text(row.base_uom),
        unitCost: Math.max(0, numberValue(row.unit_cost_ex_vat)),
        ruleId: text(row.modifier_rule_id) || undefined,
        ruleVersion: numberValue(row.modifier_rule_version, 0) || undefined,
        actionType: text(row.modifier_action_type) || undefined,
        metadata: parseJson(row.rule_snapshot_json),
      }));
  }

  // Backwards-compatible fallback for sales committed before snapshot migration: reverse the
  // actual immutable ledger rows. This never expands a current recipe or reads a current rule.
  const orderRow = await env.DB.prepare(
    `SELECT id FROM yoco_orders WHERE workspace_id = ?1 AND yoco_order_id = ?2 AND order_type = 'sale' LIMIT 1`,
  )
    .bind(input.workspaceId, input.sourceOrderId)
    .first<Row>();
  const legacyRows = await env.DB.prepare(
    `SELECT * FROM stock_movements
      WHERE workspace_id = ?1 AND movement_type = 'sale_depletion'
        AND document_type = 'yoco_order'
        AND document_id IN (?2, ?3)
        AND (
          json_extract(metadata_json, '$.source_line_id') = ?4
          OR json_extract(metadata_json, '$.componentLineId') = ?4
          OR json_extract(metadata_json, '$.sourceOriginalLineId') = ?4
        )
      ORDER BY id`,
  )
    .bind(
      input.workspaceId,
      input.sourceOrderId,
      text(orderRow?.id),
      input.sourceLineId,
    )
    .all<Row>();
  return (legacyRows.results || [])
    .filter((row) => numberValue(row.quantity_delta) < 0)
    .map((row) => {
      const metadata = parseJson(row.metadata_json);
      return {
        sourceMovementId: text(row.id),
        sourceLineId: input.sourceLineId,
        menuItemId:
          text(
            metadata.menu_item_id ||
              metadata.productId ||
              metadata.parentProductId,
          ) || undefined,
        modifierId:
          text(metadata.modifier_id || metadata.modifierId) || undefined,
        ingredientItemId: text(row.stock_item_id),
        locationId: text(row.location_id),
        quantity: Math.abs(numberValue(row.quantity_delta)) * ratio,
        baseUom: text(metadata.base_uom || metadata.baseUom),
        unitCost: Math.max(0, numberValue(row.unit_cost)),
        ruleId:
          text(metadata.modifier_rule_id || metadata.note_rule_id) || undefined,
        ruleVersion:
          numberValue(
            metadata.modifier_rule_version || metadata.note_rule_version,
            0,
          ) || undefined,
        actionType:
          text(metadata.modifier_action_type || metadata.note_action_type) ||
          undefined,
        metadata,
      };
    });
}

export async function getModifierEngineControl(
  env: Env,
  workspaceId: string,
): Promise<Row> {
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM modifier_engine_workspace_controls WHERE workspace_id = ?1 LIMIT 1`,
    )
      .bind(workspaceId)
      .first<Row>();
    if (row) return row;
    const ownership = await env.DB.prepare(
      `SELECT engine_version, enabled FROM integration_effect_ownership
        WHERE workspace_id = ?1 AND integration_type = 'YOCO' AND effect_type = 'SALE_STOCK'
        LIMIT 1`,
    )
      .bind(workspaceId)
      .first<Row>();
    const inferredLive = !ownership || (
      text(ownership.engine_version).toUpperCase() === "V2" &&
      numberValue(ownership.enabled) === 1
    );
    return {
      workspace_id: workspaceId,
      mode: inferredLive ? "LIVE" : "LEGACY_WRITE",
      inferred_from_effect_ownership: 1,
    };
  } catch (cause) {
    if (!isMissingReliabilityTableError(cause)) throw cause;
    return { workspace_id: workspaceId, mode: "LEGACY_WRITE" };
  }
}

export async function setModifierEngineMode(
  env: Env,
  input: {
    workspaceId: string;
    mode: "LEGACY_WRITE" | "OBSERVE" | "LIVE" | "ROLLED_BACK";
    actor?: string;
    reason?: string;
    rollbackHours?: number;
  },
): Promise<Row> {
  const now = nowIso();
  const rollbackHours = Math.max(1, numberValue(input.rollbackHours, 72));
  const rollbackUntil =
    input.mode === "LIVE"
      ? new Date(Date.now() + rollbackHours * 3_600_000).toISOString()
      : "";
  await env.DB.prepare(
    `INSERT INTO modifier_engine_workspace_controls
      (workspace_id, mode, observation_started_at, cutover_at, rollback_available_until,
       changed_by, change_reason, created_at, updated_at)
     VALUES (?1, ?2, CASE WHEN ?2 = 'OBSERVE' THEN ?3 ELSE NULL END,
       CASE WHEN ?2 = 'LIVE' THEN ?3 ELSE NULL END, NULLIF(?4, ''), NULLIF(?5, ''),
       NULLIF(?6, ''), ?3, ?3)
     ON CONFLICT(workspace_id) DO UPDATE SET
       mode = excluded.mode,
       observation_started_at = CASE
         WHEN excluded.mode = 'OBSERVE' AND modifier_engine_workspace_controls.mode <> 'OBSERVE'
           THEN excluded.updated_at
         WHEN excluded.mode = 'OBSERVE'
           THEN COALESCE(modifier_engine_workspace_controls.observation_started_at, excluded.updated_at)
         ELSE modifier_engine_workspace_controls.observation_started_at
       END,
       cutover_at = CASE WHEN excluded.mode = 'LIVE' THEN excluded.updated_at ELSE modifier_engine_workspace_controls.cutover_at END,
       rollback_available_until = CASE WHEN excluded.mode = 'LIVE' THEN excluded.rollback_available_until ELSE modifier_engine_workspace_controls.rollback_available_until END,
       changed_by = excluded.changed_by,
       change_reason = excluded.change_reason,
       updated_at = excluded.updated_at`,
  )
    .bind(
      input.workspaceId,
      input.mode,
      now,
      rollbackUntil,
      text(input.actor),
      text(input.reason),
    )
    .run();
  return getModifierEngineControl(env, input.workspaceId);
}

function usageRows(
  rows: Row[],
  quantityField: string,
  costField: string,
): Row[] {
  const grouped = new Map<string, Row>();
  for (const row of rows) {
    const metadata = parseJson(row.metadata_json);
    const ingredientItemId = text(row.ingredient_item_id || row.stock_item_id);
    const locationId = text(row.location_id);
    if (!ingredientItemId || !locationId) continue;
    const key = `${ingredientItemId}|${locationId}`;
    const quantity = numberValue(row[quantityField]);
    const unitCost = Math.max(0, numberValue(row[costField]));
    const existing = grouped.get(key) || {
      ingredientItemId,
      locationId,
      quantity: 0,
      value: 0,
      modifierId: text(row.modifier_id || metadata.modifierId),
    };
    existing.quantity = numberValue(existing.quantity) + quantity;
    existing.value = numberValue(existing.value) + quantity * unitCost;
    grouped.set(key, existing);
  }
  return [...grouped.values()].sort((left, right) =>
    `${left.ingredientItemId}|${left.locationId}`.localeCompare(
      `${right.ingredientItemId}|${right.locationId}`,
    ),
  );
}

export async function recordModifierEngineComparison(
  env: Env,
  input: {
    workspaceId: string;
    domainEventId: string;
    sourceOrderId: string;
    sourceLineId: string;
    menuItemId?: string;
    oldRows?: Row[];
    newRows: Row[];
  },
): Promise<void> {
  const control = await getModifierEngineControl(env, input.workspaceId);
  if (!["OBSERVE", "LIVE"].includes(text(control.mode))) return;
  let oldUsage: Row[];
  if (input.oldRows) {
    oldUsage = usageRows(
      input.oldRows.filter((row) => !text(row.warning_code)),
      "quantity",
      "unit_cost_ex_vat",
    );
  } else {
    const orderRow = await env.DB.prepare(
      `SELECT id FROM yoco_orders WHERE workspace_id = ?1 AND yoco_order_id = ?2 AND order_type = 'sale' LIMIT 1`,
    )
      .bind(input.workspaceId, input.sourceOrderId)
      .first<Row>();
    const legacy = await env.DB.prepare(
      `SELECT * FROM stock_movements
        WHERE workspace_id = ?1 AND movement_type = 'sale_depletion' AND document_type = 'yoco_order'
          AND document_id IN (?2, ?3)
          AND COALESCE(json_extract(metadata_json, '$.engine'), '') <> 'V2'
          AND (
            json_extract(metadata_json, '$.source_line_id') = ?4
            OR json_extract(metadata_json, '$.componentLineId') = ?4
            OR json_extract(metadata_json, '$.sourceOriginalLineId') = ?4
          )`,
    )
      .bind(
        input.workspaceId,
        input.sourceOrderId,
        text(orderRow?.id),
        input.sourceLineId,
      )
      .all<Row>();
    oldUsage = usageRows(
      legacy.results || [],
      "quantity_delta",
      "unit_cost",
    );
  }
  const newUsage = usageRows(
    input.newRows.filter((row) => !text(row.warning_code)),
    "quantity",
    "unit_cost_ex_vat",
  );
  const keys = unique(
    [...oldUsage, ...newUsage].map(
      (row) => `${text(row.ingredientItemId)}|${text(row.locationId)}`,
    ),
  );
  const oldMap = new Map(
    oldUsage.map((row) => [`${row.ingredientItemId}|${row.locationId}`, row]),
  );
  const newMap = new Map(
    newUsage.map((row) => [`${row.ingredientItemId}|${row.locationId}`, row]),
  );
  let quantityDifference = 0;
  let costDifference = 0;
  let reason = "MATCH";
  if (!oldUsage.length) reason = "LEGACY_MOVEMENTS_NOT_AVAILABLE";
  else if (input.newRows.some((row) => text(row.warning_code)))
    reason = "NEW_ENGINE_WARNING";
  else if (keys.some((key) => !oldMap.has(key) || !newMap.has(key)))
    reason = "INGREDIENT_SET_DIFFERENCE";
  for (const key of keys) {
    const oldRow = oldMap.get(key) || {};
    const newRow = newMap.get(key) || {};
    quantityDifference +=
      numberValue(newRow.quantity) - numberValue(oldRow.quantity);
    costDifference += numberValue(newRow.value) - numberValue(oldRow.value);
  }
  if (reason === "MATCH" && Math.abs(quantityDifference) > 0.000001)
    reason = "QUANTITY_DIFFERENCE";
  if (reason === "MATCH" && Math.abs(costDifference) > 0.01)
    reason = "COST_DIFFERENCE";
  const status =
    reason === "MATCH"
      ? "MATCH"
      : reason === "LEGACY_MOVEMENTS_NOT_AVAILABLE"
        ? "PENDING"
        : "MISMATCH";
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO modifier_engine_comparisons
      (id, workspace_id, domain_event_id, source_order_id, source_line_id, menu_item_id,
       old_resolved_usage_json, new_resolved_usage_json, quantity_difference, cost_difference,
       mismatch_reason, comparison_status, compared_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULLIF(?6, ''), ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?13)
     ON CONFLICT(workspace_id, source_order_id, source_line_id) DO UPDATE SET
       domain_event_id = excluded.domain_event_id,
       old_resolved_usage_json = excluded.old_resolved_usage_json,
       new_resolved_usage_json = excluded.new_resolved_usage_json,
       quantity_difference = excluded.quantity_difference,
       cost_difference = excluded.cost_difference,
       mismatch_reason = excluded.mismatch_reason,
       comparison_status = excluded.comparison_status,
       compared_at = excluded.compared_at,
       updated_at = excluded.updated_at`,
    )
      .bind(
        newId("modifier_engine_comparison"),
        input.workspaceId,
        input.domainEventId,
        input.sourceOrderId,
        input.sourceLineId,
        text(input.menuItemId),
        JSON.stringify(oldUsage),
        JSON.stringify(newUsage),
        rounded(quantityDifference),
        rounded(costDifference),
        reason,
        status,
        now,
      )
      .run();
  } catch (cause) {
    if (!isMissingReliabilityTableError(cause)) throw cause;
  }
}

export async function listModifierEngineDiagnostics(
  env: Env,
  workspaceId: string,
  options: {
    status?: string;
    limit?: number;
  } = {},
): Promise<Row[]> {
  const limit = Math.min(
    500,
    Math.max(1, Math.floor(numberValue(options.limit, 100))),
  );
  const rows = await env.DB.prepare(
    `SELECT comparison.*, product.name AS menu_item_name
       FROM modifier_engine_comparisons comparison
       LEFT JOIN products product
         ON product.workspace_id = comparison.workspace_id AND product.id = comparison.menu_item_id
      WHERE comparison.workspace_id = ?1
        AND (?2 = '' OR comparison.comparison_status = ?2)
      ORDER BY comparison.compared_at DESC LIMIT ?3`,
  )
    .bind(workspaceId, text(options.status).toUpperCase(), limit)
    .all<Row>();
  return (rows.results || []).map((row) => ({
    id: text(row.id),
    order: text(row.source_order_id),
    lineItem: text(row.menu_item_name || row.source_line_id),
    sourceLineId: text(row.source_line_id),
    oldResolvedUsage: parseArray(row.old_resolved_usage_json),
    newResolvedUsage: parseArray(row.new_resolved_usage_json),
    quantityDifference: numberValue(row.quantity_difference),
    costDifference: numberValue(row.cost_difference),
    reason: text(row.mismatch_reason),
    status: text(row.comparison_status),
    comparedAt: text(row.compared_at),
  }));
}
