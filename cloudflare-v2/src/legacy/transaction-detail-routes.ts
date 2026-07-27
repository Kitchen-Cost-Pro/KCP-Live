import type { AuthContext, Env } from "./types";
import {
  assertLocationAccess,
  assertWorkspaceAccess,
  assertWorkspacePermission,
  getUserAllowedLocationIds,
} from "./auth";
import { error, json } from "./http";
import {
  getTransactionReference,
  historicalTransactionReference,
  isTransactionReference,
  type TransactionEntityType,
} from "./transaction-references";

type Row = Record<string, unknown>;

type DetailPayload = {
  entityType: TransactionEntityType;
  entityId: string;
  transactionReference: string;
  title: string;
  status: string;
  occurredAt: string;
  createdAt: string;
  createdBy: string;
  createdByName: string;
  createdByEmail: string;
  committedBy: string;
  timeZone?: string;
  locationIds: string[];
  locationNames: string[];
  summaryCards: Array<{ key: string; label: string; value: unknown; type?: string }>;
  lineItemColumns: Array<{ key: string; label: string; type?: string }>;
  lineItems: Row[];
  stockMovements: Row[];
  auditTrail: Row[];
  metadata?: Row;
};

const ENTITY_BY_PREFIX: Record<string, TransactionEntityType> = {
  GRV: "grv",
  CN: "credit_note",
  MFG: "manufacturing_batch",
  TRF: "transfer",
  STK: "stock_take",
};

function text(value: unknown, fallback = ""): string {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function objectValue(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonParse(value: unknown): unknown {
  try {
    return JSON.parse(text(value, "{}"));
  } catch {
    return {};
  }
}

function unique(values: unknown[]): string[] {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function validTimeZone(value: unknown): string {
  const zone = text(value, "Africa/Johannesburg");
  try {
    new Intl.DateTimeFormat("en-ZA", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return "Africa/Johannesburg";
  }
}

async function resolveWorkspaceTimeZone(env: Env, workspaceId: string): Promise<string> {
  const row = await env.CENTRAL_DB.prepare(
    `SELECT timezone FROM workspaces WHERE id = ?1 LIMIT 1`,
  ).bind(workspaceId).first<{ timezone?: string }>();
  return validTimeZone(row?.timezone);
}

function entityTypeFromReference(reference: string): TransactionEntityType | null {
  const prefix = text(reference).toUpperCase().split("-")[0];
  return ENTITY_BY_PREFIX[prefix] || null;
}

async function resolveReferenceLink(
  env: Env,
  workspaceId: string,
  reference: string,
): Promise<{ entityType: TransactionEntityType; entityId: string } | null> {
  const row = await env.CENTRAL_DB.prepare(
    `SELECT entity_type, entity_id
       FROM transaction_reference_links
      WHERE workspace_id = ?1
        AND upper(reference) = upper(?2)
      LIMIT 1`,
  )
    .bind(workspaceId, reference)
    .first<{ entity_type: TransactionEntityType; entity_id: string }>();
  if (!row?.entity_type || !row?.entity_id) return null;
  return { entityType: row.entity_type, entityId: text(row.entity_id) };
}


async function referenceForEntity(
  env: Env,
  workspaceId: string,
  entityType: TransactionEntityType,
  entityId: string,
  occurredAt = "",
): Promise<string> {
  const id = text(entityId);
  if (!id) return "";
  return (await getTransactionReference(env, workspaceId, entityType, id))
    || historicalTransactionReference(entityType, id, occurredAt);
}

function rawNumber(raw: Row, keys: string[], fallback = 0): number {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") {
      return numberValue(raw[key], fallback);
    }
  }
  return fallback;
}

function rawText(raw: Row, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = text(raw[key]);
    if (value) return value;
  }
  return fallback;
}

async function attachActor(
  env: Env,
  workspaceId: string,
  actorId: string,
): Promise<{ id: string; name: string; email: string }> {
  const id = text(actorId);
  if (!id) return { id: "", name: "", email: "" };
  const row = await env.CENTRAL_DB.prepare(
    `SELECT auth_uid AS id, email, display_name
       FROM workspace_members
      WHERE workspace_id = ?1
        AND (auth_uid = ?2 OR lower(email) = lower(?2))
      UNION ALL
     SELECT id, email, display_name
       FROM app_users
      WHERE id = ?2 OR lower(email) = lower(?2)
      LIMIT 1`,
  )
    .bind(workspaceId, id)
    .first<{ id: string; email: string; display_name: string }>();
  return {
    id,
    name: text(row?.display_name || row?.email || id),
    email: text(row?.email),
  };
}

async function loadMovements(
  env: Env,
  workspaceId: string,
  entityType: TransactionEntityType,
  entityId: string,
): Promise<Row[]> {
  const documentType = entityType === "stock_take" ? "stock_take" : entityType;
  const rows = await env.DB.prepare(
    `SELECT
        sm.id,
        sm.movement_type,
        sm.stock_item_id,
        si.name AS item_name,
        si.category,
        sm.location_id,
        COALESCE(l.display_name, l.name) AS location_name,
        sm.source_location_id,
        COALESCE(sl.display_name, sl.name) AS source_location_name,
        sm.destination_location_id,
        COALESCE(dl.display_name, dl.name) AS destination_location_name,
        sm.quantity_delta,
        sm.unit_cost,
        sm.value_delta,
        sm.occurred_at,
        sm.created_by,
        sm.metadata_json,
        sm.created_at
       FROM stock_movements sm
       LEFT JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
       LEFT JOIN locations l ON l.id = sm.location_id AND l.workspace_id = sm.workspace_id
       LEFT JOIN locations sl ON sl.id = sm.source_location_id AND sl.workspace_id = sm.workspace_id
       LEFT JOIN locations dl ON dl.id = sm.destination_location_id AND dl.workspace_id = sm.workspace_id
      WHERE sm.workspace_id = ?1
        AND sm.document_type = ?2
        AND sm.document_id = ?3
      ORDER BY datetime(sm.occurred_at), datetime(sm.created_at), sm.id`,
  )
    .bind(workspaceId, documentType, entityId)
    .all<Row>();
  return (rows.results || []).map((row) => ({
    id: text(row.id),
    movementType: text(row.movement_type),
    itemId: text(row.stock_item_id),
    itemName: text(row.item_name),
    category: text(row.category, "General"),
    locationId: text(row.location_id),
    locationName: text(row.location_name),
    sourceLocationId: text(row.source_location_id),
    sourceLocationName: text(row.source_location_name),
    destinationLocationId: text(row.destination_location_id),
    destinationLocationName: text(row.destination_location_name),
    quantity: numberValue(row.quantity_delta),
    unitCost: numberValue(row.unit_cost),
    value: numberValue(row.value_delta),
    occurredAt: text(row.occurred_at),
    createdBy: text(row.created_by),
    createdAt: text(row.created_at),
    metadata: objectValue(jsonParse(row.metadata_json)),
  }));
}

async function loadAuditTrail(
  env: Env,
  workspaceId: string,
  entityType: TransactionEntityType,
  entityId: string,
): Promise<Row[]> {
  const aliases = entityType === "stock_take"
    ? ["stock_take", "stocktake_session"]
    : entityType === "manufacturing_batch"
      ? ["manufacturing_batch", "manufacturing"]
      : [entityType];
  const placeholders = aliases.map((_, index) => `?${index + 3}`).join(", ");
  const rows = await env.DB.prepare(
    `SELECT id, actor_uid, event_type, entity_type, entity_id, before_json, after_json, created_at
       FROM audit_events
      WHERE workspace_id = ?1
        AND entity_id = ?2
        AND entity_type IN (${placeholders})
      ORDER BY datetime(created_at), id`,
  )
    .bind(workspaceId, entityId, ...aliases)
    .all<Row>();
  const result: Row[] = [];
  for (const row of rows.results || []) {
    const actor = await attachActor(env, workspaceId, text(row.actor_uid));
    result.push({
      id: text(row.id),
      action: text(row.event_type).replace(/_/g, " "),
      actorId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      createdAt: text(row.created_at),
      before: objectValue(jsonParse(row.before_json)),
      after: objectValue(jsonParse(row.after_json)),
    });
  }
  return result;
}

async function loadGrvDetail(env: Env, workspaceId: string, entityId: string): Promise<DetailPayload | null> {
  const row = await env.DB.prepare(
    `SELECT g.*, s.name AS supplier_name, po.po_number
       FROM grvs g
       LEFT JOIN suppliers s ON s.id = g.supplier_id AND s.workspace_id = g.workspace_id
       LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id AND po.workspace_id = g.workspace_id
      WHERE g.workspace_id = ?1 AND g.id = ?2
      LIMIT 1`,
  ).bind(workspaceId, entityId).first<Row>();
  if (!row) return null;
  const raw = objectValue(jsonParse(row.raw_json));
  const rawLines = arrayValue(raw.lines || raw.items).map(objectValue);
  const linesResult = await env.DB.prepare(
    `SELECT gl.id, gl.stock_item_id, si.name AS item_name, si.category, gl.location_id,
            COALESCE(l.display_name, l.name) AS location_name,
            gl.quantity, gl.unit, gl.unit_price, gl.total_ex, gl.total_vat, gl.total_inc
       FROM grv_lines gl
       LEFT JOIN stock_items si ON si.id = gl.stock_item_id AND si.workspace_id = gl.workspace_id
       LEFT JOIN locations l ON l.id = gl.location_id AND l.workspace_id = gl.workspace_id
      WHERE gl.workspace_id = ?1 AND gl.grv_id = ?2
      ORDER BY gl.rowid`,
  ).bind(workspaceId, entityId).all<Row>();
  const lineItems = (linesResult.results || []).map((line) => {
    const rawLine = rawLines.find((entry) => text(entry.id || entry.lineId) === text(line.id)
      || text(entry.stockItemId || entry.itemId) === text(line.stock_item_id)) || {};
    const quantity = numberValue(line.quantity);
    const totalExVat = numberValue(line.total_ex, quantity * numberValue(line.unit_price));
    const vat = numberValue(line.total_vat);
    return {
      id: text(line.id), itemId: text(line.stock_item_id), itemName: text(line.item_name),
      category: text(line.category, "General"), locationId: text(line.location_id), locationName: text(line.location_name),
      receivedUomQuantity: quantity, receivedUom: text(line.unit),
      baseQuantity: rawNumber(rawLine, ["baseQuantity", "baseQty", "quantityInBase"], quantity),
      baseUom: rawText(rawLine, ["baseUom", "baseUnit"], text(line.unit)),
      conversionFactor: rawNumber(rawLine, ["conversionFactor", "qtyInBase", "conversion"], 1),
      unitCostExVat: numberValue(line.unit_price), totalExVat, vat,
      totalInclVat: numberValue(line.total_inc, totalExVat + vat),
    };
  });
  const actor = await attachActor(env, workspaceId, text(row.created_by));
  const purchaseOrderId = text(row.purchase_order_id);
  return {
    entityType: "grv", entityId, transactionReference: "", title: `GRV ${text(raw.grvNumber || row.invoice_number || entityId)}`,
    status: text(raw.status, "Committed"), occurredAt: text(row.received_at), createdAt: text(row.created_at),
    createdBy: actor.id, createdByName: actor.name, createdByEmail: actor.email, committedBy: actor.name,
    locationIds: unique(lineItems.map((line) => line.locationId)), locationNames: unique(lineItems.map((line) => line.locationName)),
    summaryCards: [
      { key: "lineCount", label: "Items Received", value: lineItems.length, type: "number" },
      { key: "totalQuantity", label: "Total Base Quantity", value: lineItems.reduce((sum, line) => sum + numberValue(line.baseQuantity), 0), type: "number" },
      { key: "totalExVat", label: "Total Ex VAT", value: numberValue(row.total_ex, lineItems.reduce((sum, line) => sum + numberValue(line.totalExVat), 0)), type: "money" },
      { key: "vat", label: "VAT", value: numberValue(row.total_vat, lineItems.reduce((sum, line) => sum + numberValue(line.vat), 0)), type: "money" },
      { key: "totalInclVat", label: "Total Incl VAT", value: numberValue(row.total_inc, lineItems.reduce((sum, line) => sum + numberValue(line.totalInclVat), 0)), type: "money" },
    ],
    lineItemColumns: [
      { key: "itemName", label: "Item" }, { key: "category", label: "Category" }, { key: "locationName", label: "Receiving Location" },
      { key: "receivedUomQuantity", label: "Received Qty", type: "number" }, { key: "receivedUom", label: "Received UOM" },
      { key: "baseQuantity", label: "Base Qty", type: "number" }, { key: "baseUom", label: "Base UOM" },
      { key: "unitCostExVat", label: "Unit Cost Ex VAT", type: "money" }, { key: "totalExVat", label: "Ex VAT", type: "money" },
      { key: "vat", label: "VAT", type: "money" }, { key: "totalInclVat", label: "Incl VAT", type: "money" },
    ],
    lineItems, stockMovements: [], auditTrail: [],
    metadata: {
      supplierId: text(row.supplier_id), supplierName: text(row.supplier_name), invoiceNumber: text(row.invoice_number),
      purchaseOrderId, purchaseOrderNumber: text(row.po_number),
      splitByLocation: Number(row.split_by_location) === 1, pricesIncludeVat: Number(row.prices_include_vat) === 1,
      vatMode: Number(row.prices_include_vat) === 1 ? "Prices include VAT" : "Prices exclude VAT",
    },
  };
}

async function loadCreditNoteDetail(env: Env, workspaceId: string, entityId: string): Promise<DetailPayload | null> {
  const row = await env.DB.prepare(
    `SELECT cn.*, s.name AS supplier_name, COALESCE(l.display_name, l.name) AS location_name
       FROM credit_notes cn
       LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.workspace_id = cn.workspace_id
       LEFT JOIN locations l ON l.id = cn.location_id AND l.workspace_id = cn.workspace_id
      WHERE cn.workspace_id = ?1 AND cn.id = ?2 LIMIT 1`,
  ).bind(workspaceId, entityId).first<Row>();
  if (!row) return null;
  const raw = objectValue(jsonParse(row.raw_json));
  const rawLines = arrayValue(raw.lines || raw.items).map(objectValue);
  const vatRate = rawNumber(raw, ["vatRate", "vat_rate"], 15);
  const financialOnly = raw.financialOnly === true || raw.financial_only === true;
  const linesResult = await env.DB.prepare(
    `SELECT cnl.id, cnl.stock_item_id, si.name AS item_name, si.category, cnl.location_id,
            COALESCE(l.display_name, l.name) AS location_name,
            cnl.quantity, cnl.unit, cnl.unit_cost, cnl.total_ex
       FROM credit_note_lines cnl
       LEFT JOIN stock_items si ON si.id = cnl.stock_item_id AND si.workspace_id = cnl.workspace_id
       LEFT JOIN locations l ON l.id = cnl.location_id AND l.workspace_id = cnl.workspace_id
      WHERE cnl.workspace_id = ?1 AND cnl.credit_note_id = ?2 ORDER BY cnl.rowid`,
  ).bind(workspaceId, entityId).all<Row>();
  const lineItems = (linesResult.results || []).map((line) => {
    const rawLine = rawLines.find((entry) => text(entry.id || entry.lineId) === text(line.id)
      || text(entry.stockItemId || entry.itemId) === text(line.stock_item_id)) || {};
    const totalExVat = numberValue(line.total_ex, numberValue(line.quantity) * numberValue(line.unit_cost));
    const vat = rawNumber(rawLine, ["vat", "totalVat", "total_vat"], totalExVat * vatRate / 100);
    const explicitImpact = rawText(rawLine, ["stockImpact", "stock_impact"]);
    const stockImpact = financialOnly ? "Financial Only"
      : explicitImpact.toLowerCase().includes("remove") ? "Stock Removed"
      : "Stock Returned";
    return {
      id: text(line.id), itemId: text(line.stock_item_id), itemName: text(line.item_name), category: text(line.category, "General"),
      locationId: text(line.location_id), locationName: text(line.location_name), quantity: numberValue(line.quantity), unit: text(line.unit),
      unitCostExVat: numberValue(line.unit_cost), totalExVat, vat, totalInclVat: totalExVat + vat, stockImpact,
    };
  });
  const actor = await attachActor(env, workspaceId, text(row.created_by));
  const originalGrvId = rawText(raw, ["originalGrvId", "grvId", "sourceGrvId", "original_grv_id"]);
  const originalTransactionReference = originalGrvId
    ? await referenceForEntity(env, workspaceId, "grv", originalGrvId, text(row.credited_at))
    : rawText(raw, ["originalTransactionReference", "sourceTransactionReference"]);
  const totalExVat = numberValue(row.total_ex, lineItems.reduce((sum, line) => sum + numberValue(line.totalExVat), 0));
  const totalVat = rawNumber(raw, ["totalVat", "total_vat", "vat"], lineItems.reduce((sum, line) => sum + numberValue(line.vat), 0));
  const totalInclVat = rawNumber(raw, ["totalInclVat", "total_incl_vat", "totalInc"], totalExVat + totalVat);
  const impact = [...new Set(lineItems.map((line) => text(line.stockImpact)).filter(Boolean))].join(" / ") || "No Stock Impact";
  return {
    entityType: "credit_note", entityId, transactionReference: "", title: `Credit Note ${text(row.credit_note_number || entityId)}`,
    status: text(raw.status, "Committed"), occurredAt: text(row.credited_at), createdAt: text(row.created_at), createdBy: actor.id,
    createdByName: actor.name, createdByEmail: actor.email, committedBy: actor.name,
    locationIds: unique([row.location_id, ...lineItems.map((line) => line.locationId)]), locationNames: unique([row.location_name, ...lineItems.map((line) => line.locationName)]),
    summaryCards: [
      { key: "lineCount", label: "Items Credited", value: lineItems.length, type: "number" },
      { key: "totalQuantity", label: "Credited Quantity", value: lineItems.reduce((sum, line) => sum + numberValue(line.quantity), 0), type: "number" },
      { key: "totalExVat", label: "Credit Ex VAT", value: totalExVat, type: "money" },
      { key: "vat", label: "VAT", value: totalVat, type: "money" },
      { key: "totalInclVat", label: "Credit Incl VAT", value: totalInclVat, type: "money" },
      { key: "stockImpact", label: "Stock Impact", value: impact },
    ],
    lineItemColumns: [
      { key: "itemName", label: "Item" }, { key: "category", label: "Category" }, { key: "locationName", label: "Location" },
      { key: "quantity", label: "Credited Qty", type: "number" }, { key: "unit", label: "UOM" },
      { key: "unitCostExVat", label: "Unit Cost Ex VAT", type: "money" }, { key: "totalExVat", label: "Credit Ex VAT", type: "money" },
      { key: "vat", label: "VAT", type: "money" }, { key: "totalInclVat", label: "Credit Incl VAT", type: "money" },
      { key: "stockImpact", label: "Stock Impact" },
    ],
    lineItems, stockMovements: [], auditTrail: [],
    metadata: {
      supplierId: text(row.supplier_id), supplierName: text(row.supplier_name), creditNoteNumber: text(row.credit_note_number),
      reason: text(row.reason), originalInvoiceGrv: rawText(raw, ["originalInvoiceGrv", "originalInvoice", "grvNumber"]),
      originalGrvId, originalTransactionReference, financialOnly, pricesIncludeVat: Number(row.prices_include_vat) === 1,
      vatRate, vatMode: Number(row.prices_include_vat) === 1 ? "Prices include VAT" : "Prices exclude VAT",
    },
  };
}

async function loadManufacturingDetail(env: Env, workspaceId: string, entityId: string): Promise<DetailPayload | null> {
  const row = await env.DB.prepare(
    `SELECT mb.*, si.name AS item_name, si.category, si.unit AS item_unit,
            COALESCE(l.display_name, l.name) AS location_name
       FROM manufacturing_batches mb
       LEFT JOIN stock_items si ON si.id = mb.stock_item_id AND si.workspace_id = mb.workspace_id
       LEFT JOIN locations l ON l.id = mb.location_id AND l.workspace_id = mb.workspace_id
      WHERE mb.workspace_id = ?1 AND mb.id = ?2 LIMIT 1`,
  ).bind(workspaceId, entityId).first<Row>();
  if (!row) return null;

  const raw = objectValue(jsonParse(row.raw_json));
  const linesResult = await env.DB.prepare(
    `SELECT mbl.id, mbl.component_stock_item_id, si.name AS item_name, si.category,
            mbl.location_id, COALESCE(l.display_name, l.name) AS location_name,
            mbl.quantity_used, mbl.unit, mbl.unit_cost
       FROM manufacturing_batch_lines mbl
       LEFT JOIN stock_items si ON si.id = mbl.component_stock_item_id AND si.workspace_id = mbl.workspace_id
       LEFT JOIN locations l ON l.id = mbl.location_id AND l.workspace_id = mbl.workspace_id
      WHERE mbl.workspace_id = ?1 AND mbl.manufacturing_batch_id = ?2
      ORDER BY mbl.rowid`,
  ).bind(workspaceId, entityId).all<Row>();

  const lineItems = (linesResult.results || []).map((line) => {
    const quantity = numberValue(line.quantity_used);
    const unitCost = numberValue(line.unit_cost);
    return {
      id: text(line.id),
      itemId: text(line.component_stock_item_id),
      itemName: text(line.item_name),
      category: text(line.category, "General"),
      locationId: text(line.location_id),
      locationName: text(line.location_name),
      quantity,
      unit: text(line.unit),
      unitCostExVat: unitCost,
      totalExVat: quantity * unitCost,
    };
  });

  const actor = await attachActor(env, workspaceId, text(row.created_by));
  const plannedYield = rawNumber(raw, ["expectedQty", "plannedYield", "expectedYield"], numberValue(row.quantity_made));
  const actualYield = rawNumber(raw, ["producedQty", "actualQty"], numberValue(row.actual_quantity ?? row.quantity_made));
  const yieldVariance = actualYield - plannedYield;
  const ingredientCost = rawNumber(raw, ["batchCost", "theoreticalBatchCost"], lineItems.reduce((sum, line) => sum + numberValue(line.totalExVat), 0));
  const expectedUnitCost = rawNumber(raw, ["expectedUnitCost"], plannedYield > 0 ? ingredientCost / plannedYield : 0);
  const actualUnitCost = rawNumber(raw, ["actualUnitCost"], actualYield > 0 ? ingredientCost / actualYield : expectedUnitCost);
  const outputValue = actualYield * actualUnitCost;
  const wastageQty = rawNumber(raw, ["wastageQty", "wastageQuantity"], numberValue(row.wastage_quantity));
  const wastageValue = rawNumber(raw, ["wastageValue"], wastageQty * expectedUnitCost);
  const yieldUom = rawText(raw, ["unit", "yieldUom", "yieldUnit"], text(row.unit || row.item_unit));

  return {
    entityType: "manufacturing_batch",
    entityId,
    transactionReference: "",
    title: `Manufacturing · ${text(row.item_name || entityId)}`,
    status: text(raw.status, "Committed"),
    occurredAt: text(row.posted_at),
    createdAt: text(row.created_at),
    createdBy: actor.id,
    createdByName: actor.name,
    createdByEmail: actor.email,
    committedBy: actor.name,
    locationIds: unique([row.location_id, ...lineItems.map((line) => line.locationId)]),
    locationNames: unique([row.location_name, ...lineItems.map((line) => line.locationName)]),
    summaryCards: [
      { key: "lineCount", label: "Ingredients", value: lineItems.length, type: "number" },
      { key: "plannedYield", label: "Planned Yield", value: plannedYield, type: "number" },
      { key: "actualYield", label: "Actual Yield", value: actualYield, type: "number" },
      { key: "yieldVariance", label: "Yield Variance", value: yieldVariance, type: "number" },
      { key: "ingredientCost", label: "Ingredient Cost", value: ingredientCost, type: "money" },
      { key: "outputValue", label: "Output Value", value: outputValue, type: "money" },
      { key: "wastageQty", label: "Wastage Quantity", value: wastageQty, type: "number" },
      { key: "wastageValue", label: "Wastage Value", value: wastageValue, type: "money" },
    ],
    lineItemColumns: [
      { key: "itemName", label: "Ingredient" },
      { key: "category", label: "Category" },
      { key: "locationName", label: "Location" },
      { key: "quantity", label: "Quantity Used", type: "number" },
      { key: "unit", label: "UOM" },
      { key: "unitCostExVat", label: "Unit Cost Ex VAT", type: "money" },
      { key: "totalExVat", label: "Ingredient Cost", type: "money" },
    ],
    lineItems,
    stockMovements: [],
    auditTrail: [],
    metadata: {
      manufacturedItemId: text(row.stock_item_id),
      manufacturedItemName: text(row.item_name),
      category: text(row.category),
      locationId: text(row.location_id),
      locationName: text(row.location_name),
      batchMultiplier: rawNumber(raw, ["batchCount", "batchMultiplier"], 1),
      plannedYield,
      actualYield,
      yieldVariance,
      yieldVariancePercent: plannedYield > 0 ? (yieldVariance / plannedYield) * 100 : 0,
      yieldUom,
      expectedUnitCost,
      actualUnitCost,
      outputValue,
      wastageQty,
      wastageValue,
      wastageAccountingTreatment: wastageQty > 0 ? "Accounting-only yield loss" : "No yield loss",
      costingMethod: rawText(raw, ["costingMethod"]),
      note: text(raw.note),
    },
  };
}

async function loadTransferDetail(env: Env, workspaceId: string, entityId: string): Promise<DetailPayload | null> {
  const localRow = await env.DB.prepare(
    `SELECT t.*, COALESCE(fl.display_name, fl.name) AS from_location_name, COALESCE(tl.display_name, tl.name) AS to_location_name
       FROM transfers t
       LEFT JOIN locations fl ON fl.id = t.from_location_id AND fl.workspace_id = t.workspace_id
       LEFT JOIN locations tl ON tl.id = t.to_location_id AND tl.workspace_id = t.workspace_id
      WHERE t.workspace_id = ?1 AND t.id = ?2 LIMIT 1`,
  ).bind(workspaceId, entityId).first<Row>();

  let externalRow: Row | null = null;
  try {
    externalRow = await env.CENTRAL_DB.prepare(
      `SELECT id, from_workspace_id, to_workspace_id, from_location_id, to_location_id,
              status, items_json, note, created_by, requested_at, accepted_at, updated_at
         FROM external_transfers
        WHERE id = ?1
          AND (from_workspace_id = ?2 OR to_workspace_id = ?2)
        LIMIT 1`,
    ).bind(entityId, workspaceId).first<Row>();
  } catch {
    externalRow = null;
  }
  if (!localRow && !externalRow) return null;

  const localRaw = objectValue(jsonParse(localRow?.raw_json));
  const localLifecycle = objectValue(localRaw.lifecycle);
  const localMeta = objectValue(localRaw.transferMeta || localRaw.transfer_meta || localRaw);
  const externalEnvelope = parseTransactionExternalTransferEnvelope(externalRow?.items_json);
  const transferMeta = {
    ...localMeta,
    ...externalEnvelope.transferMeta,
  };
  const lifecycle = {
    ...localLifecycle,
    ...externalEnvelope.lifecycle,
  };
  const transferType = externalRow || text(localRow?.transfer_type) === "external" ? "external" : "internal";
  const fromSiteId = text(transferMeta.fromSiteId || externalRow?.from_workspace_id || localRow?.from_workspace_id || workspaceId);
  const toSiteId = text(transferMeta.toSiteId || externalRow?.to_workspace_id || localRow?.to_workspace_id || workspaceId);
  const workspaceNames = await loadWorkspaceDisplayNames(env, [fromSiteId, toSiteId]);
  const fromLocationId = text(transferMeta.fromLocationId || externalRow?.from_location_id || localRow?.from_location_id);
  const toLocationId = text(transferMeta.toLocationId || externalRow?.to_location_id || localRow?.to_location_id);
  const localLocationNames = await loadLocalLocationDisplayNames(env, workspaceId, [fromLocationId, toLocationId]);
  const fromSiteName = text(transferMeta.fromSiteName || workspaceNames.get(fromSiteId), transferType === "external" ? "External Site" : "Current Site");
  const toSiteName = text(transferMeta.toSiteName || workspaceNames.get(toSiteId), transferType === "external" ? "External Site" : "Current Site");
  const fromLocationName = text(
    transferMeta.fromLocationName || localRow?.from_location_name || localLocationNames.get(fromLocationId),
    fromLocationId ? (fromSiteId === workspaceId ? "Source Location" : "External Location") : "",
  );
  const toLocationName = text(
    transferMeta.toLocationName || localRow?.to_location_name || localLocationNames.get(toLocationId),
    toLocationId ? (toSiteId === workspaceId ? "Receiving Location" : "External Location") : "",
  );
  const requestedAt = text(externalRow?.requested_at || transferMeta.requestedAt || localRow?.requested_at);
  const acceptedAt = text(externalRow?.accepted_at || lifecycle.acceptedAt || transferMeta.acceptedAt || localRow?.accepted_at);
  const status = text(externalRow?.status || lifecycle.status || transferMeta.status || localRow?.status, "posted");
  const note = text(externalRow?.note || localRow?.note || localRaw.note);

  const lineRows = await env.DB.prepare(
    `SELECT tl.id, tl.stock_item_id, si.name AS item_name, si.category, tl.quantity, tl.unit, tl.unit_cost
       FROM transfer_lines tl
       LEFT JOIN stock_items si ON si.id = tl.stock_item_id AND si.workspace_id = tl.workspace_id
      WHERE tl.workspace_id = ?1 AND tl.transfer_id = ?2 ORDER BY tl.rowid`,
  ).bind(workspaceId, entityId).all<Row>();
  const localLines: Row[] = (lineRows.results || []).map((line) => ({
    id: text(line.id),
    stockItemId: text(line.stock_item_id),
    name: text(line.item_name),
    category: text(line.category, "General"),
    quantity: numberValue(line.quantity),
    unit: text(line.unit),
    unitCost: numberValue(line.unit_cost),
  }));
  const shippedLines: Row[] = externalEnvelope.shipped.length
    ? externalEnvelope.shipped
    : localLines.map((line) => ({ ...line, stockItemId: line.stockItemId }));
  const receivedLines: Row[] = externalEnvelope.received.length
    ? externalEnvelope.received
    : arrayValue(lifecycle.received).map(objectValue);
  const shortfallLines: Row[] = externalEnvelope.shortfalls.length
    ? externalEnvelope.shortfalls
    : arrayValue(lifecycle.shortfalls).map(objectValue);
  const receivedBySource = new Map<string, Row>();
  for (const entry of receivedLines) {
    const key = text(entry.sourceStockItemId || entry.source_stock_item_id || entry.transferLineStockItemId || entry.sourceItemId || entry.stockItemId || entry.itemId || entry.id);
    if (key) receivedBySource.set(key, entry);
  }
  const shortfallBySource = new Map<string, Row>();
  for (const entry of shortfallLines) {
    const key = text(entry.sourceStockItemId || entry.source_stock_item_id || entry.stockItemId || entry.itemId || entry.id);
    if (key) shortfallBySource.set(key, entry);
  }
  const localBySource = new Map<string, Row>();
  for (const line of localLines) {
    const key = text(line.stockItemId);
    if (key) localBySource.set(key, line);
  }
  const allSourceIds = unique([
    ...shippedLines.map((entry) => entry.stockItemId || entry.stock_item_id || entry.id),
    ...localLines.map((entry) => entry.stockItemId),
    ...receivedLines.map((entry) => entry.sourceStockItemId || entry.source_stock_item_id),
    ...shortfallLines.map((entry) => entry.sourceStockItemId || entry.source_stock_item_id),
  ]);

  const lineItems = allSourceIds.map((sourceStockItemId, index) => {
    const shipped: Row = shippedLines.find((entry) => text(entry.stockItemId || entry.stock_item_id || entry.itemId || entry.id) === sourceStockItemId) || {};
    const local: Row = localBySource.get(sourceStockItemId) || {};
    const received: Row = receivedBySource.get(sourceStockItemId) || {};
    const shortfall: Row = shortfallBySource.get(sourceStockItemId) || {};
    const shippedQty = rawNumber({ ...local, ...shipped }, ["shippedQty", "quantity", "qty"], 0);
    const returnedQty = rawNumber(shortfall, ["returnedQty", "shortfall", "quantity", "qty"], status === "rejected" || status === "cancelled" ? shippedQty : 0);
    let receivedQty = rawNumber(received, ["receivedQty", "quantity", "qty"], 0);
    if (!receivedQty && status === "accepted") receivedQty = Math.max(0, shippedQty - returnedQty);
    if (transferType === "internal" && !receivedQty) receivedQty = shippedQty;
    const destinationStockItemId = text(received.stockItemId || received.targetStockItemId || received.target_stock_item_id || received.receivingStockItemId || (transferType === "internal" ? sourceStockItemId : ""));
    const sourceItemName = text(shipped.name || shipped.stockItemName || local.name, sourceStockItemId || `Item ${index + 1}`);
    const destinationItemName = text(received.name || received.stockItemName || (transferType === "internal" ? sourceItemName : ""), destinationStockItemId);
    const unitCost = rawNumber({ ...local, ...shipped, ...received }, ["unitCost", "unit_cost", "transferredUnitCost"], 0);
    const lineStatus = returnedQty > 0 && receivedQty > 0
      ? "Partially Accepted"
      : returnedQty >= shippedQty && shippedQty > 0
        ? status === "cancelled" ? "Cancelled and Returned" : "Rejected and Returned"
        : receivedQty > 0
          ? "Accepted"
          : titleCaseDetailStatus(status);
    return {
      id: text(local.id || shipped.id, `${entityId}:line:${index + 1}`),
      itemId: sourceStockItemId,
      sourceStockItemId,
      sourceItemName,
      destinationStockItemId,
      destinationItemName,
      itemName: sourceItemName,
      category: text(shipped.category || local.category || received.category, "General"),
      shippedQty,
      receivedQty,
      returnedQty: Math.max(0, returnedQty),
      unit: text(shipped.unit || local.unit || received.unit),
      unitCostExVat: unitCost,
      transferValue: shippedQty * unitCost,
      receivedValue: receivedQty * unitCost,
      returnedValue: Math.max(0, returnedQty) * unitCost,
      status: lineStatus,
      rejectionReason: text(shortfall.reason || received.rejectionReason),
    };
  });

  const createdById = text(localRow?.created_by || externalRow?.created_by);
  const actor = await attachActor(env, workspaceId, createdById);
  const workspaceRole = transferType === "internal"
    ? "Internal"
    : fromSiteId === workspaceId
      ? "Sender"
      : "Receiver";
  const lifecycleAudit: Row[] = [];
  if (requestedAt) lifecycleAudit.push({
    id: `${entityId}:requested`,
    action: transferType === "external" ? "external transfer requested" : "transfer committed",
    actorId: actor.id,
    actorName: actor.name || "System",
    actorEmail: actor.email,
    createdAt: requestedAt,
  });
  if (acceptedAt) lifecycleAudit.push({
    id: `${entityId}:${status}`,
    action: transferType === "external"
      ? status === "accepted" && lineItems.some((line) => numberValue(line.returnedQty) > 0)
        ? "external transfer partially accepted"
        : `external transfer ${status}`
      : `transfer ${status}`,
    actorId: "",
    actorName: transferType === "external" ? "Receiving workspace" : actor.name || "System",
    actorEmail: "",
    createdAt: acceptedAt,
  });

  const transferTransactionReference = text(
    transferMeta.transactionReference || lifecycle.transactionReference,
  );

  return {
    entityType: "transfer",
    entityId,
    transactionReference: transferTransactionReference,
    title: `${transferType === "external" ? "External" : "Internal"} Transfer`,
    status,
    occurredAt: acceptedAt || requestedAt,
    createdAt: requestedAt,
    createdBy: actor.id,
    createdByName: actor.name,
    createdByEmail: actor.email,
    committedBy: actor.name,
    locationIds: unique([fromLocationId, toLocationId]),
    locationNames: unique([fromLocationName, toLocationName]),
    summaryCards: [
      { key: "lineCount", label: "Line Items", value: lineItems.length, type: "number" },
      { key: "shippedQty", label: "Shipped Quantity", value: lineItems.reduce((sum, line) => sum + numberValue(line.shippedQty), 0), type: "number" },
      { key: "receivedQty", label: "Received Quantity", value: lineItems.reduce((sum, line) => sum + numberValue(line.receivedQty), 0), type: "number" },
      { key: "returnedQty", label: "Returned Quantity", value: lineItems.reduce((sum, line) => sum + numberValue(line.returnedQty), 0), type: "number" },
      { key: "transferValue", label: "Transfer Value", value: lineItems.reduce((sum, line) => sum + numberValue(line.transferValue), 0), type: "money" },
    ],
    lineItemColumns: [
      { key: "sourceItemName", label: "Source Item" },
      { key: "destinationItemName", label: "Destination Item" },
      { key: "category", label: "Category" },
      { key: "shippedQty", label: "Shipped Qty", type: "number" },
      { key: "receivedQty", label: "Received Qty", type: "number" },
      { key: "returnedQty", label: "Returned Qty", type: "number" },
      { key: "unit", label: "UOM" },
      { key: "unitCostExVat", label: "Unit Cost Ex VAT", type: "money" },
      { key: "transferValue", label: "Transfer Value", type: "money" },
      { key: "status", label: "Line Status" },
      { key: "rejectionReason", label: "Return / Rejection Detail" },
    ],
    lineItems,
    stockMovements: [],
    auditTrail: lifecycleAudit,
    metadata: {
      transactionReference: transferTransactionReference,
      transferType,
      transferScope: text(transferMeta.transferScope, transferType),
      workspaceRole,
      fromSiteId,
      fromSiteName,
      fromLocationId,
      fromLocationName,
      toSiteId,
      toSiteName,
      toLocationId,
      toLocationName,
      requestedAt,
      acceptedAt,
      partialAcceptance: lineItems.some((line) => numberValue(line.returnedQty) > 0 && numberValue(line.receivedQty) > 0),
      note,
    },
  };
}

function parseTransactionExternalTransferEnvelope(value: unknown): {
  shipped: Row[];
  received: Row[];
  shortfalls: Row[];
  transferMeta: Row;
  lifecycle: Row;
} {
  const parsed = jsonParse(value);
  if (Array.isArray(parsed)) {
    return { shipped: parsed.map(objectValue), received: [], shortfalls: [], transferMeta: {}, lifecycle: {} };
  }
  const envelope = objectValue(parsed);
  return {
    shipped: arrayValue(envelope.shipped || envelope.items).map(objectValue),
    received: arrayValue(envelope.received).map(objectValue),
    shortfalls: arrayValue(envelope.shortfalls).map(objectValue),
    transferMeta: objectValue(envelope.transferMeta || envelope.transfer_meta || envelope.meta),
    lifecycle: objectValue(envelope.lifecycle),
  };
}

async function loadWorkspaceDisplayNames(env: Env, workspaceIds: string[]): Promise<Map<string, string>> {
  const ids = unique(workspaceIds);
  if (!ids.length) return new Map();
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ");
  const rows = await env.CENTRAL_DB.prepare(
    `SELECT id, name FROM workspaces WHERE id IN (${placeholders})`,
  ).bind(...ids).all<{ id: string; name: string }>();
  return new Map((rows.results || []).map((row) => [text(row.id), text(row.name)]));
}

async function loadLocalLocationDisplayNames(env: Env, workspaceId: string, locationIds: string[]): Promise<Map<string, string>> {
  const ids = unique(locationIds);
  if (!ids.length) return new Map();
  const placeholders = ids.map((_, index) => `?${index + 2}`).join(", ");
  const rows = await env.DB.prepare(
    `SELECT id, COALESCE(display_name, name) AS name
       FROM locations
      WHERE workspace_id = ?1 AND id IN (${placeholders})`,
  ).bind(workspaceId, ...ids).all<{ id: string; name: string }>();
  return new Map((rows.results || []).map((row) => [text(row.id), text(row.name)]));
}

function titleCaseDetailStatus(value: unknown): string {
  return text(value, "Pending")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function loadStockTakeDetail(env: Env, workspaceId: string, entityId: string): Promise<DetailPayload | null> {
  const row = await env.DB.prepare(
    `SELECT sts.*, COALESCE(l.display_name, l.name) AS location_name, stt.name AS template_name
       FROM stocktake_sessions sts
       LEFT JOIN locations l ON l.id = sts.location_id AND l.workspace_id = sts.workspace_id
       LEFT JOIN stocktake_templates stt ON stt.id = sts.stocktake_template_id AND stt.workspace_id = sts.workspace_id
      WHERE sts.workspace_id = ?1 AND sts.id = ?2 LIMIT 1`,
  ).bind(workspaceId, entityId).first<Row>();
  if (!row) return null;
  const raw = objectValue(jsonParse(row.raw_json));
  const linesResult = await env.DB.prepare(
    `SELECT stcl.id, stcl.stock_item_id, si.name AS item_name, si.category, stcl.location_id,
            COALESCE(l.display_name, l.name) AS location_name, stcl.expected_qty, stcl.counted_qty,
            stcl.variance_qty, stcl.unit_cost, si.unit
       FROM stocktake_count_lines stcl
       LEFT JOIN stock_items si ON si.id = stcl.stock_item_id AND si.workspace_id = stcl.workspace_id
       LEFT JOIN locations l ON l.id = stcl.location_id AND l.workspace_id = stcl.workspace_id
      WHERE stcl.workspace_id = ?1 AND stcl.stocktake_session_id = ?2 ORDER BY stcl.rowid`,
  ).bind(workspaceId, entityId).all<Row>();
  const rawItems = arrayValue(raw.items).map(objectValue);
  const lineItems = (linesResult.results || []).map((line) => {
    const rawLine = rawItems.find((entry) => text(entry.stockItemId || entry.id) === text(line.stock_item_id)) || {};
    const expectedQty = numberValue(line.expected_qty);
    const countedQty = numberValue(line.counted_qty);
    const varianceQty = numberValue(line.variance_qty, countedQty - expectedQty);
    const unitCost = numberValue(line.unit_cost);
    const uomBreakdown = normaliseStockTakeUomBreakdown(
      rawLine.uomCounts || rawLine.scanBreakdown,
      text(line.unit, "ea"),
    );
    const countedUom = uomBreakdown.length > 1
      ? "Mixed UOMs"
      : text(uomBreakdown[0]?.uomName || rawLine.selectedUom || rawLine.unit || line.unit);
    const enteredQty = uomBreakdown.length
      ? uomBreakdown.reduce((sum, entry) => sum + numberValue(entry.count), 0)
      : numberValue(rawLine.enteredQty ?? rawLine.shelfCount ?? rawLine.countedQty, countedQty);
    const uomBreakdownDisplay = uomBreakdown
      .map((entry) => `${numberValue(entry.count)} ${text(entry.uomName)} × ${numberValue(entry.ratio, 1)}`)
      .join(" + ");
    return {
      id: text(line.id),
      itemId: text(line.stock_item_id),
      itemName: text(line.item_name),
      category: text(line.category, "General"),
      locationId: text(line.location_id),
      locationName: text(line.location_name),
      countedUom,
      enteredQty,
      conversionRatio: uomBreakdown.length === 1 ? numberValue(uomBreakdown[0].ratio, 1) : "",
      uomBreakdown: uomBreakdownDisplay,
      convertedBaseQty: countedQty,
      countedQty,
      expectedQty,
      varianceQty,
      baseUom: text(line.unit),
      unitCostExVat: unitCost,
      expectedValue: expectedQty * unitCost,
      countedValue: countedQty * unitCost,
      varianceValue: varianceQty * unitCost,
      varianceDirection: varianceQty > 0 ? "positive" : varianceQty < 0 ? "negative" : "none",
      varianceStatus: varianceQty > 0 ? "Over" : varianceQty < 0 ? "Under" : "Matched",
      notes: text(rawLine.note || rawLine.notes),
    };
  });
  const actor = await attachActor(env, workspaceId, text(row.created_by));
  const expectedValue = lineItems.reduce((sum, line) => sum + numberValue(line.expectedValue), 0);
  const countedValue = lineItems.reduce((sum, line) => sum + numberValue(line.countedValue), 0);
  const varianceValue = countedValue - expectedValue;
  const varianceQty = lineItems.reduce((sum, line) => sum + numberValue(line.varianceQty), 0);
  const occurredAt = text(row.counted_at || row.updated_at || row.created_at);
  return {
    entityType: "stock_take",
    entityId,
    transactionReference: "",
    title: `Stock Take · ${text(row.location_name || entityId)}`,
    status: text(row.status, "posted"),
    occurredAt,
    createdAt: text(row.created_at),
    createdBy: actor.id,
    createdByName: actor.name,
    createdByEmail: actor.email,
    committedBy: actor.name,
    locationIds: unique([row.location_id]),
    locationNames: unique([row.location_name]),
    summaryCards: [
      { key: "lineCount", label: "Items Counted", value: lineItems.length, type: "number" },
      { key: "varianceItems", label: "Items With Variance", value: lineItems.filter((line) => numberValue(line.varianceQty) !== 0).length, type: "number" },
      { key: "varianceQty", label: "Variance Quantity", value: varianceQty, type: "number" },
      { key: "expectedValue", label: "Expected Value", value: expectedValue, type: "money" },
      { key: "countedValue", label: "Counted Value", value: countedValue, type: "money" },
      { key: "varianceValue", label: "Variance Value", value: varianceValue, type: "money" },
      { key: "variancePercent", label: "Variance %", value: expectedValue ? varianceValue / expectedValue : 0, type: "percent" },
    ],
    lineItemColumns: [
      { key: "itemName", label: "Item" },
      { key: "category", label: "Category" },
      { key: "countedUom", label: "Counted UOM" },
      { key: "enteredQty", label: "Entered Qty", type: "number" },
      { key: "conversionRatio", label: "UOM Ratio", type: "number" },
      { key: "uomBreakdown", label: "Count Breakdown" },
      { key: "convertedBaseQty", label: "Converted Base Qty", type: "number" },
      { key: "baseUom", label: "Base UOM" },
      { key: "expectedQty", label: "Expected Qty", type: "number" },
      { key: "varianceQty", label: "Variance Qty", type: "number" },
      { key: "varianceStatus", label: "Variance" },
      { key: "unitCostExVat", label: "Unit Cost Ex VAT", type: "money" },
      { key: "expectedValue", label: "Expected Value", type: "money" },
      { key: "countedValue", label: "Counted Value", type: "money" },
      { key: "varianceValue", label: "Variance Value", type: "money" },
      { key: "notes", label: "Notes" },
    ],
    lineItems,
    stockMovements: [],
    auditTrail: [],
    metadata: {
      locationId: text(row.location_id),
      locationName: text(row.location_name),
      templateId: text(row.stocktake_template_id),
      templateName: text(row.template_name || raw.templateName),
      sessionMode: text(raw.sessionMode),
      note: text(raw.note),
      countedAt: occurredAt,
      committedAt: text(row.updated_at || row.counted_at || row.created_at),
      varianceClassification: "Stock variance (not wastage)",
    },
  };
}

function normaliseStockTakeUomBreakdown(value: unknown, baseUom = "ea"): Row[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value as Row).map(([key, count]) => ({
          key,
          uomName: key === "base" ? "Base UOM" : key,
          count,
          ratio: 1,
        }))
      : [];
  return rows
    .map(objectValue)
    .map((entry) => {
      const rawUomName = text(entry.uomName || entry.selectedUom || entry.unit || entry.key);
      const uomName = ["base", "base uom"].includes(rawUomName.toLowerCase())
        ? text(entry.baseUom || entry.baseUnit, baseUom)
        : rawUomName;
      return {
      uomName,
      baseUom: text(entry.baseUom || entry.baseUnit),
      ratio: rawNumber(entry, ["ratio", "qtyInBase", "qty_in_base", "packSize"], 1) || 1,
      count: rawNumber(entry, ["count", "quantity", "qty", "scans"], 0),
      };
    })
    .filter((entry) => text(entry.uomName) && numberValue(entry.count) > 0);
}

async function loadDetail(env: Env, workspaceId: string, entityType: TransactionEntityType, entityId: string): Promise<DetailPayload | null> {
  if (entityType === "grv") return loadGrvDetail(env, workspaceId, entityId);
  if (entityType === "credit_note") return loadCreditNoteDetail(env, workspaceId, entityId);
  if (entityType === "manufacturing_batch") return loadManufacturingDetail(env, workspaceId, entityId);
  if (entityType === "transfer") return loadTransferDetail(env, workspaceId, entityId);
  return loadStockTakeDetail(env, workspaceId, entityId);
}

async function assertDetailLocationAccess(env: Env, auth: AuthContext, workspaceId: string, locationIds: string[]): Promise<void> {
  const allowed = await getUserAllowedLocationIds(env, auth, workspaceId);
  if (allowed === null) return;
  const ids = unique(locationIds);
  if (!ids.length) throw new Error("Permission denied: transaction has no permitted location scope.");
  const placeholders = ids.map((_, index) => `?${index + 2}`).join(", ");
  const localRows = await env.DB.prepare(
    `SELECT id FROM locations WHERE workspace_id = ?1 AND id IN (${placeholders})`,
  ).bind(workspaceId, ...ids).all<{ id: string }>();
  const localIds = unique((localRows.results || []).map((row) => row.id));
  if (!localIds.length) throw new Error("Permission denied: transaction has no permitted local location scope.");
  for (const locationId of localIds) await assertLocationAccess(env, auth, workspaceId, locationId, "transaction_detail");
}

export async function getTransactionDetailReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  transactionReference: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-reporting");
  const reference = decodeURIComponent(text(transactionReference)).toUpperCase();
  if (!isTransactionReference(reference)) return error(request, env, 400, "Invalid transaction reference.");

  const url = new URL(request.url);
  const linked = await resolveReferenceLink(env, workspaceId, reference);
  const requestedTypeValue = text(url.searchParams.get("entityType"));
  const requestedType = requestedTypeValue as TransactionEntityType;
  const requestedId = text(url.searchParams.get("entityId"));
  const inferredType = entityTypeFromReference(reference);
  const supportedTypes = new Set<TransactionEntityType>(["grv", "credit_note", "manufacturing_batch", "transfer", "stock_take"]);
  if (requestedTypeValue && !supportedTypes.has(requestedType)) return error(request, env, 400, "Unsupported transaction type.");
  if (requestedType && inferredType && requestedType !== inferredType) return error(request, env, 409, "Transaction type does not match the Transaction ID.");
  const entityType = linked?.entityType || requestedType || inferredType;
  const entityId = linked?.entityId || requestedId;
  if (!entityType || !entityId) return error(request, env, 404, "Transaction could not be resolved.");
  if (linked && requestedId && linked.entityId !== requestedId) return error(request, env, 409, "Transaction reference does not match the requested transaction.");
  if (linked && requestedType && linked.entityType !== requestedType) return error(request, env, 409, "Transaction type does not match the requested transaction.");

  const detail = await loadDetail(env, workspaceId, entityType, entityId);
  if (!detail) return error(request, env, 404, "Transaction not found.");

  const storedReference = await getTransactionReference(env, workspaceId, entityType, entityId);
  const detailReference = text(
    detail.transactionReference || detail.metadata?.transactionReference,
  );
  const expectedReference = storedReference || detailReference || historicalTransactionReference(entityType, entityId, detail.occurredAt || detail.createdAt);
  if (expectedReference.toUpperCase() !== reference) return error(request, env, 404, "Transaction reference was not found in this workspace.");

  await assertDetailLocationAccess(env, auth, workspaceId, detail.locationIds);
  detail.transactionReference = expectedReference;
  detail.stockMovements = await loadMovements(env, workspaceId, entityType, entityId);
  if (entityType === "grv" || entityType === "credit_note") {
    const movementQty = detail.stockMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.quantity)), 0);
    const movementValue = detail.stockMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.value)), 0);
    const lineQty = detail.lineItems.reduce((sum, line) => sum + Math.abs(numberValue(line.baseQuantity ?? line.quantity)), 0);
    const lineValue = detail.lineItems.reduce((sum, line) => sum + Math.abs(numberValue(line.totalExVat)), 0);
    const requiresStockMovement = entityType === "grv" || detail.lineItems.some((line) => text(line.stockImpact) !== "Financial Only");
    const reconciled = !requiresStockMovement || (detail.stockMovements.length > 0
      && Math.abs(movementQty - lineQty) <= 0.0001
      && Math.abs(movementValue - lineValue) <= 0.01);
    detail.summaryCards.push({ key: "stockMovementRows", label: "Stock Movements", value: detail.stockMovements.length, type: "number" });
    detail.summaryCards.push({ key: "reconciled", label: "Ledger Reconciliation", value: reconciled ? "Reconciled" : "Review Required" });
    detail.metadata = { ...(detail.metadata || {}), ledgerReconciled: reconciled, ledgerQuantity: movementQty, ledgerValue: movementValue };
  }
  if (entityType === "manufacturing_batch") {
    const componentMovements = detail.stockMovements.filter((movement) => text(movement.movementType) === "manufacturing_component_out");
    const outputMovements = detail.stockMovements.filter((movement) => text(movement.movementType) === "manufacturing_finished_in");
    const wastageMovements = detail.stockMovements.filter((movement) => ["manufacturing_wastage", "manufacturing_waste_out"].includes(text(movement.movementType)));
    const ingredientQty = detail.lineItems.reduce((sum, line) => sum + Math.abs(numberValue(line.quantity)), 0);
    const ingredientValue = detail.lineItems.reduce((sum, line) => sum + Math.abs(numberValue(line.totalExVat)), 0);
    const ledgerIngredientQty = componentMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.quantity)), 0);
    const ledgerIngredientValue = componentMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.value)), 0);
    const actualYield = numberValue(detail.metadata?.actualYield);
    const outputValue = numberValue(detail.metadata?.outputValue);
    const ledgerOutputQty = outputMovements.reduce((sum, movement) => sum + numberValue(movement.quantity), 0);
    const ledgerOutputValue = outputMovements.reduce((sum, movement) => sum + numberValue(movement.value), 0);
    const wastageQty = numberValue(detail.metadata?.wastageQty);
    const wastageValue = numberValue(detail.metadata?.wastageValue);
    const ledgerWastageValue = wastageMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.value)), 0);
    const ingredientsReconciled = componentMovements.length > 0
      && Math.abs(ingredientQty - ledgerIngredientQty) <= 0.0001
      && Math.abs(ingredientValue - ledgerIngredientValue) <= 0.01;
    const outputReconciled = outputMovements.length > 0
      && Math.abs(actualYield - ledgerOutputQty) <= 0.0001
      && Math.abs(outputValue - ledgerOutputValue) <= 0.01;
    const wastageReconciled = wastageQty <= 0 || (wastageMovements.length > 0 && Math.abs(wastageValue - ledgerWastageValue) <= 0.01);
    const reconciled = ingredientsReconciled && outputReconciled && wastageReconciled;
    detail.summaryCards.push({ key: "stockMovementRows", label: "Stock Movements", value: detail.stockMovements.length, type: "number" });
    detail.summaryCards.push({ key: "reconciled", label: "Ledger Reconciliation", value: reconciled ? "Reconciled" : "Review Required" });
    detail.metadata = {
      ...(detail.metadata || {}),
      ledgerReconciled: reconciled,
      ingredientLedgerQuantity: ledgerIngredientQty,
      ingredientLedgerValue: ledgerIngredientValue,
      outputLedgerQuantity: ledgerOutputQty,
      outputLedgerValue: ledgerOutputValue,
      wastageLedgerValue: ledgerWastageValue,
      wastageAccountingPolicy: "Yield loss is accounting-only; component usage is not deducted twice.",
    };
  }
  if (entityType === "transfer") {
    const transferType = text(detail.metadata?.transferType, "internal");
    const workspaceRole = text(detail.metadata?.workspaceRole, transferType === "external" ? "Sender" : "Internal");
    const movementType = (movement: Row) => text(movement.movementType).toLowerCase();
    const outMovements = detail.stockMovements.filter((movement) => movementType(movement) === "transfer_out");
    const inMovements = detail.stockMovements.filter((movement) => movementType(movement) === "transfer_in");
    const returnMovements = detail.stockMovements.filter((movement) => {
      const type = movementType(movement);
      return type.includes("reversal") || type.includes("return") || type.includes("restore");
    });
    const shippedQty = detail.lineItems.reduce((sum, line) => sum + numberValue(line.shippedQty), 0);
    const receivedQty = detail.lineItems.reduce((sum, line) => sum + numberValue(line.receivedQty), 0);
    const returnedQty = detail.lineItems.reduce((sum, line) => sum + numberValue(line.returnedQty), 0);
    const shippedValue = detail.lineItems.reduce((sum, line) => sum + Math.abs(numberValue(line.transferValue)), 0);
    const receivedValue = detail.lineItems.reduce((sum, line) => sum + Math.abs(numberValue(line.receivedValue)), 0);
    const returnedValue = detail.lineItems.reduce((sum, line) => sum + Math.abs(numberValue(line.returnedValue)), 0);
    const ledgerOutQty = outMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.quantity)), 0);
    const ledgerInQty = inMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.quantity)), 0);
    const ledgerReturnedQty = returnMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.quantity)), 0);
    const ledgerOutValue = outMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.value)), 0);
    const ledgerInValue = inMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.value)), 0);
    const ledgerReturnedValue = returnMovements.reduce((sum, movement) => sum + Math.abs(numberValue(movement.value)), 0);
    const qtyTolerance = 0.0001;
    const valueTolerance = 0.01;
    const senderReconciled = Math.abs(shippedQty - ledgerOutQty) <= qtyTolerance
      && Math.abs(shippedValue - ledgerOutValue) <= valueTolerance
      && Math.abs(returnedQty - ledgerReturnedQty) <= qtyTolerance
      && Math.abs(returnedValue - ledgerReturnedValue) <= valueTolerance;
    const receiverReconciled = Math.abs(receivedQty - ledgerInQty) <= qtyTolerance
      && Math.abs(receivedValue - ledgerInValue) <= valueTolerance;
    const internalReconciled = senderReconciled && receiverReconciled;
    const reconciled = workspaceRole === "Sender"
      ? senderReconciled
      : workspaceRole === "Receiver"
        ? receiverReconciled
        : internalReconciled;
    detail.lineItems = detail.lineItems.map((line) => {
      const sourceItemId = text(line.sourceStockItemId || line.itemId);
      const destinationItemId = text(line.destinationStockItemId || sourceItemId);
      const lineOut = outMovements
        .filter((movement) => text(movement.itemId) === sourceItemId)
        .reduce((sum, movement) => sum + Math.abs(numberValue(movement.quantity)), 0);
      const lineIn = inMovements
        .filter((movement) => text(movement.itemId) === destinationItemId)
        .reduce((sum, movement) => sum + Math.abs(numberValue(movement.quantity)), 0);
      const lineReturned = returnMovements
        .filter((movement) => text(movement.itemId) === sourceItemId)
        .reduce((sum, movement) => sum + Math.abs(numberValue(movement.quantity)), 0);
      const lineReconciled = workspaceRole === "Sender"
        ? Math.abs(numberValue(line.shippedQty) - lineOut) <= qtyTolerance
          && Math.abs(numberValue(line.returnedQty) - lineReturned) <= qtyTolerance
        : workspaceRole === "Receiver"
          ? Math.abs(numberValue(line.receivedQty) - lineIn) <= qtyTolerance
          : Math.abs(numberValue(line.shippedQty) - lineOut) <= qtyTolerance
            && Math.abs(numberValue(line.receivedQty) - lineIn) <= qtyTolerance;
      return {
        ...line,
        ledgerOutQty: lineOut,
        ledgerInQty: lineIn,
        ledgerReturnedQty: lineReturned,
        ledgerReconciliation: lineReconciled ? "Reconciled" : "Review Required",
      };
    });
    detail.lineItemColumns = [
      ...detail.lineItemColumns,
      { key: "ledgerOutQty", label: "Ledger Out", type: "number" },
      { key: "ledgerInQty", label: "Ledger In", type: "number" },
      { key: "ledgerReturnedQty", label: "Ledger Returned", type: "number" },
      { key: "ledgerReconciliation", label: "Ledger Reconciliation" },
    ];
    detail.summaryCards.push({ key: "stockMovementRows", label: "Stock Movements", value: detail.stockMovements.length, type: "number" });
    detail.summaryCards.push({ key: "reconciled", label: "Ledger Reconciliation", value: reconciled ? "Reconciled" : "Review Required" });
    detail.metadata = {
      ...(detail.metadata || {}),
      ledgerReconciled: reconciled,
      ledgerRole: workspaceRole,
      ledgerOutQuantity: ledgerOutQty,
      ledgerInQuantity: ledgerInQty,
      ledgerReturnedQuantity: ledgerReturnedQty,
      ledgerOutValue,
      ledgerInValue,
      ledgerReturnedValue,
    };
  }
  if (entityType === "stock_take") {
    const qtyTolerance = 0.0001;
    const valueTolerance = 0.01;
    detail.lineItems = detail.lineItems.map((line) => {
      const movements = detail.stockMovements.filter((movement) =>
        text(movement.itemId) === text(line.itemId)
        && (!text(line.locationId) || text(movement.locationId) === text(line.locationId))
      );
      const ledgerVarianceQty = movements.reduce((sum, movement) => sum + numberValue(movement.quantity), 0);
      const ledgerVarianceValue = movements.reduce((sum, movement) => sum + numberValue(movement.value), 0);
      const lineReconciled = Math.abs(numberValue(line.varianceQty) - ledgerVarianceQty) <= qtyTolerance
        && Math.abs(numberValue(line.varianceValue) - ledgerVarianceValue) <= valueTolerance;
      return {
        ...line,
        ledgerVarianceQty,
        ledgerVarianceValue,
        ledgerMovementRows: movements.length,
        ledgerReconciliation: lineReconciled ? "Reconciled" : "Review Required",
      };
    });
    detail.lineItemColumns = [
      ...detail.lineItemColumns,
      { key: "ledgerVarianceQty", label: "Ledger Variance Qty", type: "number" },
      { key: "ledgerVarianceValue", label: "Ledger Variance Value", type: "money" },
      { key: "ledgerMovementRows", label: "Ledger Rows", type: "number" },
      { key: "ledgerReconciliation", label: "Ledger Reconciliation" },
    ];
    const reconciled = detail.lineItems.every((line) => text(line.ledgerReconciliation) === "Reconciled");
    const ledgerVarianceQty = detail.stockMovements.reduce((sum, movement) => sum + numberValue(movement.quantity), 0);
    const ledgerVarianceValue = detail.stockMovements.reduce((sum, movement) => sum + numberValue(movement.value), 0);
    detail.summaryCards.push({ key: "stockMovementRows", label: "Stock Variance Movements", value: detail.stockMovements.length, type: "number" });
    detail.summaryCards.push({ key: "reconciled", label: "Ledger Reconciliation", value: reconciled ? "Reconciled" : "Review Required" });
    detail.metadata = {
      ...(detail.metadata || {}),
      ledgerReconciled: reconciled,
      ledgerVarianceQuantity: ledgerVarianceQty,
      ledgerVarianceValue,
      varianceAccountingPolicy: "Stock take variance is inventory variance, not wastage.",
    };
  }
  const databaseAuditTrail = await loadAuditTrail(env, workspaceId, entityType, entityId);
  detail.auditTrail = mergeTransactionAuditTrail(detail.auditTrail, databaseAuditTrail);
  if (entityType === "transfer") {
    const acceptedEvent = [...detail.auditTrail].reverse().find((event) => {
      const action = text(event.action).toLowerCase();
      return action.includes("accepted") || action.includes("rejected") || action.includes("cancelled");
    });
    if (acceptedEvent) {
      detail.committedBy = text(acceptedEvent.actorName || acceptedEvent.actorEmail, detail.committedBy);
      detail.metadata = {
        ...(detail.metadata || {}),
        acceptedOrClosedBy: text(acceptedEvent.actorName || acceptedEvent.actorEmail),
      };
    }
  }
  if (!detail.auditTrail.length) {
    detail.auditTrail = [{
      id: `${entityId}:created`,
      action: detail.status || "committed",
      actorId: detail.createdBy,
      actorName: detail.createdByName,
      actorEmail: detail.createdByEmail,
      createdAt: detail.occurredAt || detail.createdAt,
    }];
  }

  const reportingTimeZone = await resolveWorkspaceTimeZone(env, workspaceId);
  detail.timeZone = reportingTimeZone;
  detail.metadata = {
    ...(detail.metadata || {}),
    reportingTimeZone,
  };

  return json(request, env, {
    ok: true,
    transaction: detail,
    source: "cloudflare-d1:transaction-detail",
  });
}

function mergeTransactionAuditTrail(existing: Row[] = [], loaded: Row[] = []): Row[] {
  const seen = new Set<string>();
  return [...existing, ...loaded]
    .filter((event) => {
      const key = text(event.id) || `${text(event.action)}::${text(event.createdAt)}::${text(event.actorId || event.actorName)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt)));
}
