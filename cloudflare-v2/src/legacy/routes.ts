import type { AuthContext, Env, DbLike, DbStatementLike } from "./types";
import {
  error,
  getParam,
  json,
  limitFromUrl,
  offsetFromUrl,
  readJson,
} from "./http";
import {
  assertWorkspaceAccess,
  getUserAllowedLocationIds,
  assertWorkspacePermission,
  assertLocationAccess,
} from "./auth";
import {
  expandProductIngredients,
  extractYocoOrder,
  getOrderReturns,
  processYocoOrder,
  processYocoOrderReturns,
  resolveRefundReturnBehavior,
  stockValuationUnitCost,
  yocoWebhookEventDisposition,
  yocoWebhookEventFields,
  yocoWebhookPaymentSucceeded,
} from "./yoco-sales";
import { fetchModifierGroup, fetchOrder, fetchPayment, listOrders, listOrdersPage } from "./yoco-client";
import {
  connectYoco,
  disconnectYoco,
  fetchAssignedYocoModifierGroups,
  getYocoApiKey,
  getYocoConnection,
  getYocoModifierGroup,
  listYocoModifierGroups,
  productLinkedYocoModifierGroup,
  syncYocoCatalogue,
  syncYocoSales,
  retryFailedYocoOrders,
  resetYocoWebhook,
  testYocoWebhook,
} from "./yoco-service";
import { findRefund, verifyYocoWebhook } from "./yoco-webhooks";
import { recordIntegrationLog } from "./integration-log";
import {
  decryptTextWithSecret,
  encryptTextWithSecret,
  hmacSha256Base64,
} from "./crypto";
import {
  getAdminGmailCallback,
  getEmailDeliveryConfig,
  buildAdminYocoStatus,
} from "./admin-routes";
import {
  sendWorkspaceLowStockNow,
  sendWorkspaceLowStockDue,
  sendWorkspaceLowStockToUser,
} from "./low-stock-email";
import { sendEmail } from "./email";
import {
  calculateIncomingLocationCost,
  getWorkspaceInventoryCostingMethod,
  resolveLocationUnitCost,
  upsertLocationCostStatement,
} from "./inventory-costing";
import {
  ensureTransactionReference,
  getTransactionReference,
  historicalTransactionReference,
  resolveTransactionReferences,
} from "./transaction-references";
import { resolveLocationDisplayName } from "./location-display";
// @ts-ignore Shared unit-aware Yoco Money conversion. Money objects are minor units; normalized scalars are major units.
import { yocoMoneyToMajor } from "../../../src/modules/reporting/engine/yocoFinancials.js";

function text(value: unknown, fallback = "") {
  return String(value ?? fallback).trim();
}

function defaultStockSku(name: unknown) {
  return `SKU - ${text(name, "Unnamed Stock Item") || "Unnamed Stock Item"}`;
}

function resolveStockSku(name: unknown, ...candidates: unknown[]) {
  const explicit = candidates.map((value) => text(value)).find(Boolean);
  return explicit || defaultStockSku(name);
}

function routeText(value: unknown, fallback = "") {
  const raw = text(value, fallback);
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function nowIso() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() + 2);
  return d.toISOString().replace("Z", "+02:00");
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

let userPreferencesSchemaReady: Promise<void> | null = null;

function userPreferencePrincipal(auth: AuthContext) {
  const uid = text(auth.uid);
  if (uid) return `uid:${uid}`;
  return `email:${text(auth.email).toLowerCase()}`;
}

async function ensureUserPreferencesSchema(env: Env) {
  if (userPreferencesSchemaReady) return userPreferencesSchemaReady;
  userPreferencesSchemaReady = (async () => {
    await env.CENTRAL_DB.prepare(
      `CREATE TABLE IF NOT EXISTS user_preferences (
         principal_key TEXT PRIMARY KEY,
         auth_uid TEXT,
         email TEXT,
         preferences_json TEXT NOT NULL DEFAULT '{}',
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    ).run();
    await env.CENTRAL_DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_user_preferences_auth_uid
         ON user_preferences(auth_uid)`,
    ).run();
    await env.CENTRAL_DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_user_preferences_email
         ON user_preferences(email)`,
    ).run();
  })().catch((cause) => {
    userPreferencesSchemaReady = null;
    throw cause;
  });
  return userPreferencesSchemaReady;
}

async function readLegacyMemberPreferences(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  try {
    const info = await env.CENTRAL_DB.prepare(
      `PRAGMA table_info(workspace_members)`,
    ).all<{ name?: string }>();
    const hasLegacyColumn = (info.results || []).some(
      (row) => text(row.name).toLowerCase() === 'user_preferences_json',
    );
    if (!hasLegacyColumn) return {};
    const row = await env.CENTRAL_DB.prepare(
      `SELECT user_preferences_json
         FROM workspace_members
        WHERE workspace_id = ?1
          AND status = 'active'
          AND (auth_uid = ?2 OR lower(email) = lower(?3))
        LIMIT 1`,
    )
      .bind(workspaceId, auth.uid, auth.email)
      .first<{ user_preferences_json?: string }>();
    return objectValue(jsonParse(row?.user_preferences_json));
  } catch {
    return {};
  }
}

async function readPersonalPreferences(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await ensureUserPreferencesSchema(env);
  const principalKey = userPreferencePrincipal(auth);
  const row = await env.CENTRAL_DB.prepare(
    `SELECT preferences_json
       FROM user_preferences
      WHERE principal_key = ?1
      LIMIT 1`,
  )
    .bind(principalKey)
    .first<{ preferences_json?: string }>();
  if (row) return objectValue(jsonParse(row.preferences_json));

  const legacy = await readLegacyMemberPreferences(env, auth, workspaceId);
  if (Object.keys(legacy).length) {
    const now = nowIso();
    await env.CENTRAL_DB.prepare(
      `INSERT INTO user_preferences
         (principal_key, auth_uid, email, preferences_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(principal_key) DO UPDATE SET
         auth_uid = excluded.auth_uid,
         email = excluded.email,
         preferences_json = excluded.preferences_json,
         updated_at = excluded.updated_at`,
    )
      .bind(principalKey, auth.uid, auth.email, JSON.stringify(legacy), now)
      .run();
  }
  return legacy;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed =
    typeof value === "number"
      ? value
      : Number(
          String(value ?? "")
            .trim()
            .replace(/\s/g, "")
            .replace(/[^\d,.-]/g, "")
            .replace(",", "."),
        );
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatQuantity(value: unknown) {
  const number = numberValue(value, 0);
  if (!Number.isFinite(number)) return "0";
  return Number(number.toFixed(3)).toLocaleString("en-ZA");
}

function normalizeItemType(value: unknown, fallback = "raw") {
  return (
    text(value, fallback)
      .toLowerCase()
      .replace(/[\s-]+/g, "_") || fallback
  );
}

function isNonStockItemType(itemType: string) {
  return ["non_stock", "recipe_source", "virtual"].includes(
    normalizeItemType(itemType),
  );
}

function normalizeStockItemDuplicateName(value: unknown) {
  return text(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveStockItemType(merged: Record<string, unknown>): string {
  const explicit = normalizeItemType(
    merged.itemType ||
      merged.item_type ||
      (merged.isManufactured
        ? "manufactured"
        : merged.isSubRecipe
          ? "sub_recipe"
          : ""),
    "",
  );
  const category = text(merged.category).toLowerCase();
  if (
    ["sub_recipe", "subrecipe"].includes(explicit) ||
    category.includes("sub recipe") ||
    category.includes("sub-recipe")
  )
    return "sub_recipe";
  if (
    ["manufactured", "prep", "prepared", "manufactured_item"].includes(
      explicit,
    ) ||
    category.includes("manufactured")
  )
    return "manufactured";
  if (
    ["recipe_source", "non_stock", "virtual"].includes(explicit) ||
    category.includes("recipe source") ||
    category.includes("non-stock") ||
    category.includes("non stock") ||
    category.includes("virtual")
  )
    return "recipe_source";
  return "raw";
}

function stockItemIsStocked(row: Record<string, unknown>) {
  const raw = objectValue(jsonParse(row.raw_json));
  const itemType = deriveStockItemType({
    ...raw,
    itemType: row.item_type || raw.itemType || raw.type,
    category: row.category || raw.category,
  });
  if (["sub_recipe", "subrecipe", "virtual"].includes(itemType)) return false;
  if (itemType === "recipe_source" || itemType === "non_stock") return true;
  if (row.is_stocked !== undefined && row.is_stocked !== null)
    return Number(row.is_stocked) !== 0;
  if (raw.isStocked !== undefined) return raw.isStocked !== false;
  if (raw.is_stocked !== undefined) return Number(raw.is_stocked) !== 0;
  return true;
}

const STOCKED_ITEM_TYPE_SQL = (alias: string) =>
  `REPLACE(REPLACE(LOWER(COALESCE(${alias}.item_type, json_extract(${alias}.raw_json, '$.itemType'), '')), '-', '_'), ' ', '_')`;
const STOCKED_ITEM_SQL = `
  (${STOCKED_ITEM_TYPE_SQL("stock_items")} NOT IN ('sub_recipe', 'subrecipe', 'virtual')
   AND COALESCE(json_extract(stock_items.raw_json, '$.isSubRecipe'), json_extract(stock_items.raw_json, '$.is_sub_recipe'), json_extract(stock_items.raw_json, '$.SubRecipe'), 0) NOT IN (1, 'true', 'yes')
   AND LOWER(COALESCE(stock_items.category, '')) NOT LIKE '%sub recipe%'
   AND LOWER(COALESCE(stock_items.category, '')) NOT LIKE '%sub-recipe%'
   AND LOWER(COALESCE(stock_items.category, '')) NOT LIKE '%virtual%')
`;
const STOCKED_ITEM_ALIAS_SQL = (alias: string) => `
  (${STOCKED_ITEM_TYPE_SQL(alias)} NOT IN ('sub_recipe', 'subrecipe', 'virtual')
   AND COALESCE(json_extract(${alias}.raw_json, '$.isSubRecipe'), json_extract(${alias}.raw_json, '$.is_sub_recipe'), json_extract(${alias}.raw_json, '$.SubRecipe'), 0) NOT IN (1, 'true', 'yes')
   AND LOWER(COALESCE(${alias}.category, '')) NOT LIKE '%sub recipe%'
   AND LOWER(COALESCE(${alias}.category, '')) NOT LIKE '%sub-recipe%'
   AND LOWER(COALESCE(${alias}.category, '')) NOT LIKE '%virtual%')
`;

function normalizeUomConfigurations(value: unknown) {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [value]
      : [];
  return rows
    .map((entry) => {
      const row = objectValue(entry);
      return {
        baseUom: text(row.baseUom || row.base_uom || row.baseUnit || row.unit),
        customUom: text(
          row.customUom || row.custom_uom || row.customUnit || row.orderingUom,
        ),
        ratio: numberValue(
          row.ratio ??
            row.conversionRatio ??
            row.unitsPerCustomUnit ??
            row.units_per_custom_unit,
          0,
        ),
        barcode: text(row.barcode || row.customBarcode || row.customUomBarcode),
        isDefaultOrdering:
          row.isDefaultOrdering === true ||
          row.defaultOrdering === true ||
          ['true', '1', 'yes', 'on'].includes(text(row.isDefaultOrdering ?? row.defaultOrdering ?? row.is_default_ordering ?? row.defaultOrderUom).toLowerCase()),
      };
    })
    .filter((entry) => entry.customUom && entry.ratio > 0);
}

function moneyToMajor(value: unknown) {
  const amount = yocoMoneyToMajor(value, {
    scalarUnit: "major",
    absolute: false,
  });
  return Number.isFinite(amount) ? amount : 0;
}

function jsonParse(value: unknown) {
  if (!value || typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseObjectJson(value: unknown): Record<string, unknown> {
  return objectValue(jsonParse(value));
}

function isImportTemplateExampleValue(value: unknown) {
  const normalized = text(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  return (
    normalized === "example only" ||
    normalized.startsWith("example only ") ||
    normalized.includes(" example only ")
  );
}

function isImportTemplateExampleRow(row: Record<string, unknown>) {
  return Object.values(row || {}).some(isImportTemplateExampleValue);
}

function base64UrlEncodeText(value: string) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecodeText(value: string) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function stockIdentityKey(item: Record<string, unknown>) {
  return [
    text(item.name).toLowerCase().replace(/\s+/g, " "),
    text(item.category).toLowerCase().replace(/\s+/g, " "),
    text(item.unit || item.uom)
      .toLowerCase()
      .replace(/\s+/g, " "),
  ].join("|");
}

function duplicateProductKey(row: Record<string, unknown>) {
  return {
    name: text(row.name).toLowerCase().replace(/\s+/g, " "),
    category: text(row.category).toLowerCase().replace(/\s+/g, " "),
  };
}

function duplicateProductKeyString(key: { name: string; category: string }) {
  return `${key.name}|${key.category}`;
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function countBy<T>(values: T[], getKey: (value: T) => string) {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    const key = getKey(value);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

function productAuditSnapshot(row: Record<string, unknown>, deletedAt = "") {
  const raw = parseObjectJson(row.raw_json || row.rawJson);
  return {
    id: text(row.id || raw.id),
    name: text(row.name || raw.name || raw.productName || raw.title),
    category: text(row.category || raw.category, "General") || "General",
    sku: text(row.sku || raw.sku),
    price: numberValue(row.price ?? raw.price ?? raw.sellingPrice, 0),
    active:
      row.active === undefined
        ? raw.active !== false
        : Number(row.active) !== 0,
    deletedAt,
  };
}

function stockAuditSnapshot(row: Record<string, unknown>, deletedAt = "") {
  const raw = parseObjectJson(row.raw_json || row.rawJson);
  return {
    id: text(row.id || raw.id),
    name: text(row.name || raw.name || raw.ingredientName),
    category: text(row.category || raw.category, "General") || "General",
    unit: text(row.unit || raw.unit || raw.uom, "ea") || "ea",
    unitCost: numberValue(
      row.unit_cost ?? raw.unitCost ?? raw.cost ?? raw.costEx,
      0,
    ),
    itemType: text(row.item_type || raw.itemType || raw.type, "raw") || "raw",
    active:
      row.active === undefined
        ? raw.active !== false
        : Number(row.active) !== 0,
    deletedAt,
  };
}

function normalizeStockItemPayload(raw: Record<string, unknown>) {
  const rawJson = objectValue(raw.raw_json || raw.rawJson);
  const merged = { ...rawJson, ...raw };
  const name = text(merged.name || merged.ingredientName);
  const itemType = deriveStockItemType(merged);
  const category = text(
    merged.category,
    itemType === "sub_recipe"
      ? "General - Sub Recipe"
      : itemType === "manufactured"
        ? "General - Manufactured"
        : itemType === "recipe_source" ||
            itemType === "virtual" ||
            itemType === "non_stock"
          ? "General - Non Stock"
          : "General - Raw Materials",
  );
  const explicitStocked = merged.isStocked ?? merged.is_stocked;
  const isStocked = ["sub_recipe", "subrecipe", "virtual"].includes(itemType)
    ? 0
    : ["recipe_source", "non_stock"].includes(itemType)
      ? 1
      : explicitStocked === undefined || explicitStocked === null
        ? 1
        : explicitStocked === false || Number(explicitStocked) === 0
          ? 0
          : 1;
  const unit = text(merged.unit || merged.uom, "ea");
  const barcodes = Array.isArray(merged.barcodes)
    ? merged.barcodes.map((entry) => text(entry)).filter(Boolean)
    : text(
        merged.barcode_csv ||
          merged.barcodeCsv ||
          merged.barcode ||
          merged.barcodes,
      )
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

  const skuKeys = [
    "sku",
    "SKU",
    "skuCode",
    "stockCode",
    "itemCode",
    "customSku",
    "code",
  ];
  const hasSkuInput = skuKeys.some((key) =>
    Object.prototype.hasOwnProperty.call(raw, key),
  );
  const skuSource = hasSkuInput
    ? skuKeys.map((key) => raw[key]).find((value) => text(value))
    : skuKeys.map((key) => merged[key]).find((value) => text(value));
  const sku = resolveStockSku(name, skuSource);

  return {
    id: text(merged.id) || id("stock"),
    name,
    sku,
    category,
    itemType: itemType || "raw",
    unit,
    unitCost: numberValue(
      merged.cost ?? merged.unit_cost ?? merged.unitCost ?? merged.costEx,
      0,
    ),
    vatEnabled: merged.vatEnabled === false || merged.vat_enabled === 0 ? 0 : 1,
    thresholdQty: numberValue(
      merged.lowStockThreshold ?? merged.threshold_qty ?? merged.thresholdQty,
      5,
    ),
    parLevelQty: numberValue(
      merged.parLevel ?? merged.par_level_qty ?? merged.parLevelQty,
      0,
    ),
    yieldPct: numberValue(
      merged.yieldFactor ?? merged.yield_pct ?? merged.yieldPct,
      100,
    ),
    batchYield: numberValue(
      merged.yieldBatch ?? merged.batch_yield ?? merged.batchYield,
      1,
    ),
    barcodeCsv: barcodes.join(","),
    isStocked,
    balances: ["sub_recipe", "subrecipe", "virtual"].includes(itemType)
      ? {}
      : objectValue(merged.balances),
    stock: ["sub_recipe", "subrecipe", "virtual"].includes(itemType)
      ? 0
      : numberValue(merged.stock ?? merged.on_hand ?? merged.onHand, 0),
    rawJson: JSON.stringify({
      ...merged,
      sku,
      customSku: sku,
      itemType,
      isStocked: Boolean(isStocked),
      isSubRecipe: itemType === "sub_recipe",
      isManufactured: itemType === "manufactured",
    }),
  };
}

async function defaultLocationId(env: Env, workspaceId: string) {
  const row = await env.DB.prepare(
    `SELECT id
       FROM locations
      WHERE workspace_id = ?1
        AND active = 1
      ORDER BY
        kind = 'storage' DESC,
        lower(COALESCE(name, display_name, '')) = 'main store' DESC,
        id IN ('main', 'loc_main') DESC,
        COALESCE(external_provider, '') = '' DESC,
        is_default DESC,
        name ASC
      LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ id: string }>();
  return row?.id || "";
}

async function resolveActiveLocationId(
  env: Env,
  workspaceId: string,
  requestedLocationId = "",
) {
  const requested = text(requestedLocationId);
  if (!requested) return defaultLocationId(env, workspaceId);

  const direct = await env.DB.prepare(
    `SELECT id
       FROM locations
      WHERE workspace_id = ?1
        AND active = 1
        AND (id = ?2 OR name = ?2 OR display_name = ?2 OR external_name = ?2)
      LIMIT 1`,
  )
    .bind(workspaceId, requested)
    .first<{ id: string }>();
  if (direct?.id) return direct.id;

  const normalized = requested.toLowerCase().replace(/[\s_-]+/g, "");
  if (
    ["main", "default", "mainstore", "mainstorage", "locmain"].includes(
      normalized,
    )
  ) {
    return defaultLocationId(env, workspaceId);
  }

  return "";
}

async function saveStockItem(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  raw: Record<string, unknown>,
  options: { allowStockBalanceUpdate?: boolean } = {},
) {
  const item = normalizeStockItemPayload(raw);
  if (!item.name) throw new Error("Stock item name is required.");
  const allowStockBalanceUpdate = options.allowStockBalanceUpdate !== false;

  const existing = await env.DB.prepare(
    `SELECT id
       FROM stock_items
      WHERE workspace_id = ?1
        AND active = 1
        AND id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, item.id)
    .first<{ id: string }>();

  const duplicateRows = await env.DB.prepare(
    `SELECT id, name
       FROM stock_items
      WHERE workspace_id = ?1
        AND active = 1`,
  )
    .bind(workspaceId)
    .all<{ id: string; name: string }>();
  const nextNameKey = normalizeStockItemDuplicateName(item.name);
  const duplicateName = (duplicateRows.results || []).find(
    (row) =>
      normalizeStockItemDuplicateName(row.name) === nextNameKey &&
      text(row.id) !== item.id,
  );

  if (duplicateName?.id) {
    throw new Error(
      `A stock item named "${item.name}" already exists. Stock item names must be unique.`,
    );
  }

  const stockItemId = existing?.id || item.id;
  const now = nowIso();
  const statements = [
    env.DB.prepare(
      `INSERT INTO stock_items
	        (id, workspace_id, legacy_source_id, name, category, item_type, unit, unit_cost, vat_enabled, is_stocked,
	         threshold_qty, par_level_qty, yield_pct, batch_yield, barcode_csv, active, raw_json, created_at, updated_at)
	       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, ?16, ?17, ?17)
	       ON CONFLICT(id) DO UPDATE SET
	        name = excluded.name,
	        category = excluded.category,
	        item_type = excluded.item_type,
	        unit = excluded.unit,
	        unit_cost = excluded.unit_cost,
	        vat_enabled = excluded.vat_enabled,
	        is_stocked = excluded.is_stocked,
	        threshold_qty = excluded.threshold_qty,
	        par_level_qty = excluded.par_level_qty,
	        yield_pct = excluded.yield_pct,
        batch_yield = excluded.batch_yield,
        barcode_csv = excluded.barcode_csv,
        active = 1,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`,
    ).bind(
      stockItemId,
      workspaceId,
      text(
        raw.legacySourceId ||
          raw.legacy_source_id ||
          raw.sourceId ||
          stockItemId,
      ),
      item.name,
      item.category,
      item.itemType,
      item.unit,
      item.unitCost,
      item.vatEnabled,
      item.isStocked,
      item.thresholdQty,
      item.parLevelQty,
      item.yieldPct,
      item.batchYield,
      item.barcodeCsv,
      item.rawJson,
      now,
    ),
  ];

  const balances = Object.entries(item.balances)
    .map(
      ([locationId, quantity]) =>
        [text(locationId), numberValue(quantity, 0)] as const,
    )
    .filter(([locationId]) => locationId);

  if (!item.isStocked) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM stock_balances
        WHERE workspace_id = ?1
          AND stock_item_id = ?2`,
      ).bind(workspaceId, stockItemId),
    );
  }

  if (allowStockBalanceUpdate && item.isStocked && balances.length) {
    for (const [locationId, quantity] of balances) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = excluded.quantity,
          updated_at = excluded.updated_at`,
        ).bind(workspaceId, stockItemId, locationId, quantity, now),
      );
    }
  } else if (
    allowStockBalanceUpdate &&
    item.isStocked &&
    Object.prototype.hasOwnProperty.call(raw, "stock")
  ) {
    const locationId =
      text(raw.locationId || raw.targetLocation || raw.defaultLocationId) ||
      (await defaultLocationId(env, workspaceId));
    if (locationId) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = excluded.quantity,
          updated_at = excluded.updated_at`,
        ).bind(workspaceId, stockItemId, locationId, item.stock, now),
      );
    }
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
     VALUES (?1, ?2, ?3, 'stock_item_saved', 'stock_item', ?4, ?5, ?6)`,
    ).bind(id("audit"), workspaceId, auth.uid, stockItemId, item.rawJson, now),
  );

  await env.DB.batch(statements);
  await saveStockItemRecipe(env, workspaceId, stockItemId, raw, item);
  await updateProductsUsingRecipeSource(env, workspaceId, stockItemId);
  return stockItemId;
}

function stripStockBalanceImportFields(raw: Record<string, unknown>) {
  const sanitized = { ...raw };
  [
    "stock",
    "onHand",
    "on_hand",
    "quantity",
    "qty",
    "balances",
    "stockByLocation",
    "locationBalances",
  ].forEach((field) => {
    delete sanitized[field];
  });
  return sanitized;
}

function normalizeProductPayload(raw: Record<string, unknown>) {
  const rawJson = objectValue(raw.raw_json || raw.rawJson);
  const merged = { ...rawJson, ...raw };
  const name = text(merged.name || merged.productName || merged.title);
  const yocoItemId = text(merged.yocoItemId || merged.yoco_item_id);
  const yocoVariantId = text(merged.yocoVariantId || merged.yoco_variant_id);
  const externalProvider = text(
    merged.externalProvider ||
      merged.external_provider ||
      (yocoItemId || yocoVariantId ? "yoco" : ""),
  );
  const idValue = text(merged.id || merged.productId) || id("prod");
  const category =
    text(
      merged.category || merged.menuCategory || merged.yocoCategoryName,
      "General",
    ) || "General";
  const sellingPrice = numberValue(
    merged.sellingPrice ?? merged.price ?? merged.menuPrice,
    0,
  );
  const barcodeValues = Array.isArray(merged.barcodes)
    ? merged.barcodes.map((entry) => text(entry)).filter(Boolean)
    : text(
        merged.barcode_csv ||
          merged.barcodeCsv ||
          merged.barcode ||
          merged.barcodes,
      )
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

  return {
    id: idValue.replace(/[.#$/[\]\s]+/g, "_").slice(0, 140) || id("prod"),
    legacySourceId: text(
      merged.legacySourceId ||
        merged.legacy_source_id ||
        merged.sourceId ||
        idValue,
    ),
    name,
    category,
    sellingPrice,
    active:
      merged.active === false ||
      merged.deleted === true ||
      merged.archived === true
        ? 0
        : 1,
    externalProvider,
    sku: text(merged.sku || merged.customSku || merged.code),
    yocoItemId,
    yocoVariantId,
    yocoCategoryId: text(merged.yocoCategoryId || merged.yoco_category_id),
    yocoCategoryName: text(
      merged.yocoCategoryName || merged.yoco_category_name,
    ),
    recipeSourceStockItemId: text(
      merged.recipeSourceStockItemId || merged.recipe_source_stock_item_id,
    ),
    rawJson: JSON.stringify({
      ...merged,
      barcodes: barcodeValues,
      recipeSourceStockItemId: text(
        merged.recipeSourceStockItemId || merged.recipe_source_stock_item_id,
      ),
      sellingPrice,
      price: sellingPrice,
    }),
    locationPrices: objectValue(
      merged.locationPrices ||
        merged.locationPricing ||
        merged.pricesByLocation,
    ),
    recipe: Object.prototype.hasOwnProperty.call(merged, "recipe")
      ? arrayValue(merged.recipe)
      : null,
  };
}

function selectedYocoOptionSummary(variant: Record<string, unknown>) {
  return arrayValue(
    variant.selected_options || variant.selectedOptions || variant.options,
  )
    .map((entry) => {
      const option = objectValue(entry);
      const name = text(option.name || option.option_name || option.optionName);
      const value = text(
        option.value || option.value_name || option.valueName || option.name,
      );
      if (!value) return "";
      return name &&
        name.toLowerCase() !== "option" &&
        name.toLowerCase() !== value.toLowerCase()
        ? `${name}: ${value}`
        : value;
    })
    .filter(Boolean)
    .join(" / ");
}

function yocoVariantDisplay(raw: Record<string, unknown>) {
  const item = objectValue(raw.item || raw.yocoItem);
  const variant = objectValue(raw.variant || raw.yocoVariant);
  const itemName = text(
    raw.yocoItemName || item.name || raw.productName || raw.name,
  );
  const optionSummary = text(
    raw.yocoOptionSummary || selectedYocoOptionSummary(variant),
  );
  const explicitVariant = text(
    raw.yocoVariantName ||
      variant.name ||
      variant.display_name ||
      variant.displayName ||
      variant.option_name,
  );
  if (optionSummary) return optionSummary;
  if (
    explicitVariant &&
    explicitVariant.toLowerCase() !== itemName.toLowerCase()
  )
    return explicitVariant;
  return text(variant.sku || raw.sku);
}

function inferYocoItemNameFromSiblings(rows: Record<string, unknown>[]) {
  if (rows.length < 2) return "";
  const prefixes = rows
    .map((row) =>
      text(row.name)
        .split(/\s+-\s+/)[0]
        ?.trim(),
    )
    .filter(Boolean);
  if (prefixes.length !== rows.length) return "";
  const first = prefixes[0];
  return prefixes.every(
    (prefix) => prefix.toLowerCase() === first.toLowerCase(),
  )
    ? first
    : "";
}

function inferVariantNameFromProductName(
  productName: string,
  itemName: string,
) {
  const name = text(productName);
  const base = text(itemName);
  if (!name || !base) return "";
  const pattern = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+-\\s+(.+)$`,
    "i",
  );
  return text(name.match(pattern)?.[1]);
}

function yocoHasMultipleVariants(raw: Record<string, unknown>) {
  const item = objectValue(raw.item || raw.yocoItem);
  return (
    raw.yocoHasMultipleVariants === true ||
    item.has_multiple_variants === true ||
    item.hasMultipleVariants === true ||
    arrayValue(item.variants).length > 1
  );
}

function normalizeProductRecipeLines(recipe: unknown[]) {
  return recipe
    .map((line) => objectValue(line))
    .map((line) => ({
      stockItemId: text(
        line.stockItemId ||
          line.stock_item_id ||
          line.ingId ||
          line.ingredientId ||
          line.id,
      ),
      quantity: numberValue(line.quantity ?? line.qty, 0),
      unit: text(line.unit || line.uom, "ea") || "ea",
    }))
    .filter((line) => line.stockItemId && line.quantity > 0);
}

function normalizeStockRecipeLines(recipe: unknown[]) {
  return recipe
    .map((line) => objectValue(line))
    .map((line) => ({
      stockItemId: text(
        line.stockItemId ||
          line.stock_item_id ||
          line.ingId ||
          line.ingredientId ||
          line.id,
      ),
      quantity: numberValue(line.quantity ?? line.qty ?? line.amount, 0),
      unit: text(line.unit || line.uom, "ea") || "ea",
    }))
    .filter((line) => line.stockItemId && line.quantity > 0);
}

async function assertRecipeIngredientIdsAllowed(
  env: Env,
  workspaceId: string,
  recipeLines: Array<{ stockItemId: string }>,
) {
  const ids = [
    ...new Set(
      recipeLines.map((line) => text(line.stockItemId)).filter(Boolean),
    ),
  ];
  if (!ids.length) return;
  const placeholders = ids.map((_, index) => `?${index + 2}`).join(", ");
  const rows = await env.DB.prepare(
    `SELECT id, name, item_type, raw_json
       FROM stock_items
      WHERE workspace_id = ?1
        AND id IN (${placeholders})`,
  )
    .bind(workspaceId, ...ids)
    .all<Record<string, unknown>>();
  const disallowed = (rows.results || []).find((row) => {
    const itemType = normalizeItemType(
      row.item_type || objectValue(jsonParse(row.raw_json)).itemType,
      "raw",
    );
    return ["recipe_source", "non_stock", "virtual"].includes(itemType);
  });
  if (disallowed) {
    throw new Error(
      `${text(disallowed.name || disallowed.id)} is a non-stock item and cannot be assigned as a recipe ingredient.`,
    );
  }
}

async function saveProductRecipe(
  env: Env,
  workspaceId: string,
  productId: string,
  recipe: unknown[],
) {
  const recipeLines = normalizeProductRecipeLines(recipe);
  await assertRecipeIngredientIdsAllowed(env, workspaceId, recipeLines);
  const existingRecipe = await env.DB.prepare(
    `SELECT id
       FROM recipes
      WHERE workspace_id = ?1
        AND owner_type = 'product'
        AND owner_id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, productId)
    .first<{ id: string }>();
  const recipeId = existingRecipe?.id || id("recipe");
  const now = nowIso();
  const statements: DbStatementLike[] = [
    env.DB.prepare(
      `INSERT INTO recipes
        (id, workspace_id, owner_type, owner_id, yield_qty, yield_unit, active, created_at, updated_at)
       VALUES (?1, ?2, 'product', ?3, 1, 'ea', 1, ?4, ?4)
       ON CONFLICT(workspace_id, owner_type, owner_id) DO UPDATE SET
        active = 1,
        updated_at = excluded.updated_at`,
    ).bind(recipeId, workspaceId, productId, now),
    env.DB.prepare(
      `DELETE FROM recipe_lines
        WHERE workspace_id = ?1
          AND recipe_id = ?2`,
    ).bind(workspaceId, recipeId),
  ];

  recipeLines.forEach((line, index) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO recipe_lines
        (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        id("recipe_line"),
        workspaceId,
        recipeId,
        line.stockItemId,
        line.quantity,
        line.unit,
        index,
        now,
      ),
    );
  });

  statements.push(
    env.DB.prepare(
      `UPDATE products
        SET missing_recipe = ?3,
            updated_at = ?4
      WHERE workspace_id = ?1
        AND id = ?2`,
    ).bind(workspaceId, productId, recipeLines.length ? 0 : 1, now),
  );

  await env.DB.batch(statements);
}

async function recipeHasLines(
  env: Env,
  workspaceId: string,
  ownerType: string,
  ownerId: string,
) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM recipes r
       JOIN recipe_lines rl ON rl.workspace_id = r.workspace_id AND rl.recipe_id = r.id
      WHERE r.workspace_id = ?1
        AND r.owner_type = ?2
        AND r.owner_id = ?3
        AND r.active = 1`,
  )
    .bind(workspaceId, ownerType, ownerId)
    .first<{ count: number }>();
  return numberValue(row?.count, 0) > 0;
}

async function updateProductRecipeCompleteness(
  env: Env,
  workspaceId: string,
  productId: string,
) {
  const product = await env.DB.prepare(
    `SELECT recipe_source_stock_item_id
       FROM products
      WHERE workspace_id = ?1
        AND id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, productId)
    .first<{ recipe_source_stock_item_id?: string | null }>();
  const hasDirectRecipe = await recipeHasLines(
    env,
    workspaceId,
    "product",
    productId,
  );
  const recipeSourceStockItemId = text(product?.recipe_source_stock_item_id);
  const hasLinkedStockRecipe =
    !hasDirectRecipe && recipeSourceStockItemId
      ? await recipeHasLines(
          env,
          workspaceId,
          "stock_item",
          recipeSourceStockItemId,
        )
      : false;
  const missingRecipe = hasDirectRecipe || hasLinkedStockRecipe ? 0 : 1;
  await env.DB.prepare(
    `UPDATE products
        SET missing_recipe = ?3,
            updated_at = ?4
      WHERE workspace_id = ?1
        AND id = ?2`,
  )
    .bind(workspaceId, productId, missingRecipe, nowIso())
    .run();
}

async function updateProductsUsingRecipeSource(
  env: Env,
  workspaceId: string,
  stockItemId: string,
) {
  const rows = await env.DB.prepare(
    `SELECT id
       FROM products
      WHERE workspace_id = ?1
        AND recipe_source_stock_item_id = ?2
        AND active = 1`,
  )
    .bind(workspaceId, stockItemId)
    .all<{ id: string }>();
  await Promise.all(
    ((rows.results || []) as { id: string }[]).map((row) =>
      updateProductRecipeCompleteness(env, workspaceId, text(row.id)),
    ),
  );
}

async function saveYocoModifierRecipe(
  env: Env,
  workspaceId: string,
  ownerId: string,
  recipe: unknown[],
  linkedProductId?: string,
) {
  const recipeLines = normalizeProductRecipeLines(recipe);
  await assertRecipeIngredientIdsAllowed(env, workspaceId, recipeLines);
  const nextLinkedProductId =
    linkedProductId === undefined ? undefined : routeText(linkedProductId);
  const existingRecipe = await env.DB.prepare(
    `SELECT id, linked_product_id
       FROM recipes
      WHERE workspace_id = ?1
        AND owner_type = 'yoco_modifier'
        AND owner_id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, ownerId)
    .first<{ id: string; linked_product_id?: string | null }>();
  const recipeId = existingRecipe?.id || id("recipe");
  const persistedLinkedProductId =
    nextLinkedProductId === undefined
      ? text(existingRecipe?.linked_product_id)
      : nextLinkedProductId;
  const now = nowIso();
  const statements: DbStatementLike[] = [
    env.DB.prepare(
      `INSERT INTO recipes
        (id, workspace_id, owner_type, owner_id, yield_qty, yield_unit, linked_product_id, active, created_at, updated_at)
       VALUES (?1, ?2, 'yoco_modifier', ?3, 1, 'ea', ?4, 1, ?5, ?5)
       ON CONFLICT(workspace_id, owner_type, owner_id) DO UPDATE SET
        linked_product_id = excluded.linked_product_id,
        active = 1,
        updated_at = excluded.updated_at`,
    ).bind(
      recipeId,
      workspaceId,
      ownerId,
      persistedLinkedProductId || null,
      now,
    ),
    env.DB.prepare(
      `DELETE FROM recipe_lines
        WHERE workspace_id = ?1
          AND recipe_id = ?2`,
    ).bind(workspaceId, recipeId),
  ];

  recipeLines.forEach((line, index) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO recipe_lines
        (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        id("recipe_line"),
        workspaceId,
        recipeId,
        line.stockItemId,
        line.quantity,
        line.unit,
        index,
        now,
      ),
    );
  });

  await env.DB.batch(statements);
}

async function deleteYocoModifierRecipe(
  env: Env,
  workspaceId: string,
  ownerId: string,
) {
  const existingRecipe = await env.DB.prepare(
    `SELECT id
       FROM recipes
      WHERE workspace_id = ?1
        AND owner_type = 'yoco_modifier'
        AND owner_id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, ownerId)
    .first<{ id: string }>();
  const recipeId = existingRecipe?.id || id("recipe");
  const now = nowIso();
  const statements: DbStatementLike[] = [
    env.DB.prepare(
      `INSERT INTO recipes
        (id, workspace_id, owner_type, owner_id, yield_qty, yield_unit, linked_product_id, active, created_at, updated_at)
       VALUES (?1, ?2, 'yoco_modifier', ?3, 1, 'ea', NULL, 0, ?4, ?4)
       ON CONFLICT(workspace_id, owner_type, owner_id) DO UPDATE SET
        linked_product_id = NULL,
        active = 0,
        updated_at = excluded.updated_at`,
    ).bind(recipeId, workspaceId, ownerId, now),
    env.DB.prepare(
      `DELETE FROM recipe_lines
        WHERE workspace_id = ?1
          AND recipe_id = ?2`,
    ).bind(workspaceId, recipeId),
  ];
  await env.DB.batch(statements);
}

async function saveStockItemRecipe(
  env: Env,
  workspaceId: string,
  stockItemId: string,
  raw: Record<string, unknown>,
  item: ReturnType<typeof normalizeStockItemPayload>,
) {
  if (
    ![
      "manufactured",
      "sub_recipe",
      "recipe_source",
      "non_stock",
      "virtual",
    ].includes(item.itemType)
  )
    return;

  const recipeLines = normalizeStockRecipeLines(arrayValue(raw.recipe));
  await assertRecipeIngredientIdsAllowed(env, workspaceId, recipeLines);
  const existingRecipe = await env.DB.prepare(
    `SELECT id
       FROM recipes
      WHERE workspace_id = ?1
        AND owner_type = 'stock_item'
        AND owner_id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, stockItemId)
    .first<{ id: string }>();
  const recipeId = existingRecipe?.id || id("recipe");
  const now = nowIso();
  const statements: DbStatementLike[] = [
    env.DB.prepare(
      `INSERT INTO recipes
        (id, workspace_id, owner_type, owner_id, yield_qty, yield_unit, active, created_at, updated_at)
       VALUES (?1, ?2, 'stock_item', ?3, ?4, ?5, 1, ?6, ?6)
       ON CONFLICT(workspace_id, owner_type, owner_id) DO UPDATE SET
        yield_qty = excluded.yield_qty,
        yield_unit = excluded.yield_unit,
        active = 1,
        updated_at = excluded.updated_at`,
    ).bind(
      recipeId,
      workspaceId,
      stockItemId,
      item.batchYield || 1,
      item.unit || "ea",
      now,
    ),
    env.DB.prepare(
      `DELETE FROM recipe_lines
        WHERE workspace_id = ?1
          AND recipe_id = ?2`,
    ).bind(workspaceId, recipeId),
  ];

  recipeLines.forEach((line, index) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO recipe_lines
        (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        id("recipe_line"),
        workspaceId,
        recipeId,
        line.stockItemId,
        line.quantity,
        line.unit || item.unit || "ea",
        index,
        now,
      ),
    );
  });

  await env.DB.batch(statements);
}

async function getStockItemRecipeLines(
  env: Env,
  workspaceId: string,
  stockItemId: string,
  rawRecipe: unknown[],
) {
  const recipe = await env.DB.prepare(
    `SELECT id
       FROM recipes
      WHERE workspace_id = ?1
        AND owner_type = 'stock_item'
        AND owner_id = ?2
        AND active = 1
      LIMIT 1`,
  )
    .bind(workspaceId, stockItemId)
    .first<{ id: string }>();
  if (recipe?.id) {
    const lineRows = await env.DB.prepare(
      `SELECT stock_item_id, quantity, unit
         FROM recipe_lines
        WHERE workspace_id = ?1
          AND recipe_id = ?2
        ORDER BY sort_order ASC`,
    )
      .bind(workspaceId, recipe.id)
      .all<Record<string, unknown>>();
    const recipeLines = ((lineRows.results || []) as Record<string, unknown>[])
      .map((line) => ({
        ingId: text(line.stock_item_id),
        qty: numberValue(line.quantity, 0),
        unit: text(line.unit, "ea"),
      }))
      .filter((line) => line.ingId && line.qty > 0);
    if (recipeLines.length) return recipeLines;
  }

  return normalizeStockRecipeLines(rawRecipe).map((line) => ({
    ingId: line.stockItemId,
    qty: line.quantity,
    unit: line.unit,
  }));
}

async function saveProductRecord(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  raw: Record<string, unknown>,
) {
  const product = normalizeProductPayload(raw);
  if (!product.name) throw new Error("Menu item name is required.");

  const existing = await env.DB.prepare(
    `SELECT id, raw_json
       FROM products
      WHERE workspace_id = ?1
        AND active = 1
        AND (
          id = ?2
          OR legacy_source_id = ?3
          OR (?4 != '' AND external_provider = ?4 AND yoco_item_id = ?5 AND yoco_variant_id = ?6)
          OR lower(trim(name)) = lower(trim(?7))
        )
      ORDER BY CASE WHEN id = ?2 THEN 0 ELSE 1 END
      LIMIT 1`,
  )
    .bind(
      workspaceId,
      product.id,
      product.legacySourceId,
      product.externalProvider,
      product.yocoItemId,
      product.yocoVariantId,
      product.name,
    )
    .first<{ id: string; raw_json?: string }>();

  const productId = existing?.id || product.id;
  const now = nowIso();
  const persistedRawJson = mergeProductRawJson(
    product.rawJson,
    existing?.raw_json,
  );
  const statements: DbStatementLike[] = [
    env.DB.prepare(
      `INSERT INTO products
	        (id, workspace_id, legacy_source_id, name, sku, category, price, active, external_provider,
	         yoco_item_id, yoco_variant_id, yoco_category_id, yoco_category_name, recipe_source_stock_item_id, raw_json, updated_at)
	       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
	       ON CONFLICT(id) DO UPDATE SET
	        legacy_source_id = excluded.legacy_source_id,
	        name = excluded.name,
        sku = excluded.sku,
        category = excluded.category,
        price = excluded.price,
        active = excluded.active,
        external_provider = excluded.external_provider,
        yoco_item_id = excluded.yoco_item_id,
	        yoco_variant_id = excluded.yoco_variant_id,
	        yoco_category_id = excluded.yoco_category_id,
	        yoco_category_name = excluded.yoco_category_name,
	        recipe_source_stock_item_id = excluded.recipe_source_stock_item_id,
	        raw_json = excluded.raw_json,
	        updated_at = excluded.updated_at`,
    ).bind(
      productId,
      workspaceId,
      product.legacySourceId || productId,
      product.name,
      product.sku || null,
      product.category,
      product.sellingPrice,
      product.active,
      product.externalProvider || null,
      product.yocoItemId || null,
      product.yocoVariantId || null,
      product.yocoCategoryId || null,
      product.yocoCategoryName || null,
      product.recipeSourceStockItemId || null,
      persistedRawJson,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'product_saved', 'product', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      productId,
      persistedRawJson,
      now,
    ),
  ];

  if (
    Object.prototype.hasOwnProperty.call(raw, "locationPrices") ||
    Object.prototype.hasOwnProperty.call(raw, "locationPricing") ||
    Object.prototype.hasOwnProperty.call(raw, "pricesByLocation")
  ) {
    // Only clear the user's previous MANUAL overrides — leave Yoco-synced ('yoco')
    // per-location prices intact so a manual save doesn't wipe them.
    statements.push(
      env.DB.prepare(
        `DELETE FROM product_location_prices
        WHERE workspace_id = ?1
          AND product_id = ?2
          AND source = 'manual'`,
      ).bind(workspaceId, productId),
    );

    for (const [locationId, value] of Object.entries(product.locationPrices)) {
      const entry = objectValue(value);
      const price = numberValue(entry.sellingPrice ?? entry.price ?? value, 0);
      if (!text(locationId)) continue;
      statements.push(
        env.DB.prepare(
          `INSERT INTO product_location_prices
          (workspace_id, product_id, location_id, price, source, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'manual', ?5)
         ON CONFLICT(workspace_id, product_id, location_id) DO UPDATE SET
          price = excluded.price,
          source = 'manual',
          updated_at = excluded.updated_at`,
        ).bind(workspaceId, productId, text(locationId), price, now),
      );
    }
  }

  await env.DB.batch(statements);
  if (product.recipe)
    await saveProductRecipe(env, workspaceId, productId, product.recipe);
  await updateProductRecipeCompleteness(env, workspaceId, productId);
  return productId;
}

function mergeProductRawJson(nextRawJson: string, existingRawJson?: string) {
  const next = objectValue(jsonParse(nextRawJson));
  const existing = objectValue(jsonParse(existingRawJson));
  const preserveIfMissing = (key: string) => {
    const value = next[key];
    const hasValue = Array.isArray(value)
      ? value.length > 0
      : value !== undefined &&
        value !== null &&
        (typeof value !== "string" || value.trim() !== "");
    if (!hasValue && existing[key] !== undefined) next[key] = existing[key];
  };

  [
    "item",
    "variant",
    "yocoItem",
    "yocoVariant",
    "yocoItemName",
    "yocoVariantName",
    "yocoOptionSummary",
    "yocoHasMultipleVariants",
    "yocoModifierGroupIds",
    "yocoBrandId",
    "yocoBrandName",
    "yocoCategoryId",
    "yocoCategoryName",
  ].forEach(preserveIfMissing);

  return JSON.stringify(next);
}

function normalizeSupplierPayload(raw: Record<string, unknown>) {
  const merged = objectValue(raw.raw_json || raw.rawJson || raw);
  const payload = { ...merged, ...raw };
  const name = text(
    readImportField(payload, [
      "name",
      "Name",
      "supplierName",
      "SupplierName",
      "Supplier Name",
      "Supplier",
    ]),
  );
  const supplierId =
    text(
      readImportField(
        payload,
        [
          "id",
          "ID",
          "supplierId",
          "SupplierID",
          "Supplier Id",
          "Supplier ID",
          "Supplier_ID",
        ],
        name,
      ),
    ) || id("supplier");
  const addressLine1 = text(
    readImportField(payload, [
      "addressLine1",
      "Address_Line_1",
      "Address Line 1",
      "Address1",
      "Address 1",
    ]),
  );
  const addressLine2 = text(
    readImportField(payload, [
      "addressLine2",
      "Address_Line_2",
      "Address Line 2",
      "Address2",
      "Address 2",
    ]),
  );
  const city = text(readImportField(payload, ["city", "City", "Town"]));
  const province = text(
    readImportField(payload, ["province", "Province", "State", "Region"]),
  );
  const postalCode = text(
    readImportField(payload, [
      "postalCode",
      "Postal_Code",
      "Postal Code",
      "Postcode",
      "Zip",
      "ZIP",
    ]),
  );
  const country = text(readImportField(payload, ["country", "Country"]));
  const address =
    text(readImportField(payload, ["address", "Address"])) ||
    [addressLine1, addressLine2, city, province, postalCode, country]
      .filter(Boolean)
      .join(", ");

  return {
    id:
      supplierId.replace(/[.#$/[\]\s]+/g, "_").slice(0, 120) || id("supplier"),
    name,
    email: text(
      readImportField(payload, [
        "email",
        "Email",
        "E-mail",
        "Email Address",
        "Email_Address",
      ]),
    ),
    phone: text(
      readImportField(payload, [
        "phone",
        "Phone",
        "telephone",
        "Telephone",
        "Phone Number",
        "Phone_Number",
      ]),
    ),
    contactPerson: text(
      readImportField(payload, [
        "contactPerson",
        "contact",
        "ContactPerson",
        "Contact Person",
        "Contact_Person",
      ]),
    ),
    category:
      text(readImportField(payload, ["category", "Category"], "General")) ||
      "General",
    leadTime: numberValue(
      readImportField(
        payload,
        ["leadTime", "LeadTime", "Lead Time", "Lead_Time"],
        0,
      ),
      0,
    ),
    paymentTerms:
      text(
        readImportField(
          payload,
          ["paymentTerms", "PaymentTerms", "Payment Terms", "Payment_Terms"],
          "COD",
        ),
      ) || "COD",
    accountNumber: text(
      readImportField(payload, [
        "accountNumber",
        "AccountNumber",
        "Account Number",
        "Account_Number",
      ]),
    ),
    address,
    addressLine1,
    addressLine2,
    city,
    province,
    postalCode,
    country,
    notes: text(
      readImportField(payload, [
        "notes",
        "Notes",
        "Note",
        "Comments",
        "Comment",
      ]),
    ),
    rawJson: JSON.stringify({
      ...payload,
      name,
      email: text(
        readImportField(payload, [
          "email",
          "Email",
          "E-mail",
          "Email Address",
          "Email_Address",
        ]),
      ),
      phone: text(
        readImportField(payload, [
          "phone",
          "Phone",
          "telephone",
          "Telephone",
          "Phone Number",
          "Phone_Number",
        ]),
      ),
      contactPerson: text(
        readImportField(payload, [
          "contactPerson",
          "contact",
          "ContactPerson",
          "Contact Person",
          "Contact_Person",
        ]),
      ),
      category:
        text(readImportField(payload, ["category", "Category"], "General")) ||
        "General",
      leadTime: numberValue(
        readImportField(
          payload,
          ["leadTime", "LeadTime", "Lead Time", "Lead_Time"],
          0,
        ),
        0,
      ),
      paymentTerms:
        text(
          readImportField(
            payload,
            ["paymentTerms", "PaymentTerms", "Payment Terms", "Payment_Terms"],
            "COD",
          ),
        ) || "COD",
      accountNumber: text(
        readImportField(payload, [
          "accountNumber",
          "AccountNumber",
          "Account Number",
          "Account_Number",
        ]),
      ),
      address,
      addressLine1,
      addressLine2,
      city,
      province,
      postalCode,
      country,
      notes: text(
        readImportField(payload, [
          "notes",
          "Notes",
          "Note",
          "Comments",
          "Comment",
        ]),
      ),
    }),
  };
}

function readImportField(
  source: Record<string, unknown>,
  aliases: string[],
  fallback: unknown = "",
) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, alias))
      return source[alias];
  }

  const keyMap = new Map(
    Object.keys(source || {}).map((key) => [
      String(key)
        .replace(/^\uFEFF/, "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ""),
      key,
    ]),
  );
  for (const alias of aliases) {
    const normalized = String(alias)
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const matchedKey = keyMap.get(normalized);
    if (matchedKey) return source[matchedKey];
  }
  return fallback;
}

async function saveSupplier(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  raw: Record<string, unknown>,
) {
  const supplier = normalizeSupplierPayload(raw);
  if (!supplier.name) throw new Error("Supplier name is required.");

  const existing = await env.DB.prepare(
    `SELECT id
       FROM suppliers
      WHERE workspace_id = ?1
        AND active = 1
        AND (id = ?2 OR lower(trim(name)) = lower(trim(?3)))
      ORDER BY CASE WHEN id = ?2 THEN 0 ELSE 1 END
      LIMIT 1`,
  )
    .bind(workspaceId, supplier.id, supplier.name)
    .first<{ id: string }>();

  const supplierId = existing?.id || supplier.id;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO suppliers
        (id, workspace_id, legacy_source_id, name, email, phone, active, raw_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?8)
       ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        phone = excluded.phone,
        active = 1,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`,
    ).bind(
      supplierId,
      workspaceId,
      text(
        raw.legacySourceId ||
          raw.legacy_source_id ||
          raw.sourceId ||
          supplierId,
      ),
      supplier.name,
      supplier.email,
      supplier.phone,
      supplier.rawJson,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'supplier_saved', 'supplier', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      supplierId,
      supplier.rawJson,
      now,
    ),
  ]);

  return supplierId;
}

function normalizeLocationPayload(raw: Record<string, unknown>) {
  const name = text(
    raw.name ||
      raw.displayName ||
      raw.display_name ||
      raw.externalName ||
      raw.external_name,
  );
  const existingId = text(raw.id || raw.locationId || raw.location_id);
  const kind =
    text(raw.kind || raw.type, existingId ? "selling" : "storage") ||
    (existingId ? "selling" : "storage");
  const rawExternalProvider = text(
    raw.externalProvider || raw.external_provider || raw.source,
  );
  const externalLocationId = text(
    raw.externalLocationId ||
      raw.external_location_id ||
      raw.yocoLocationId ||
      raw.yocoStoreLocationId,
  );
  const externalProvider =
    rawExternalProvider &&
    !["live locations", "live location"].includes(
      rawExternalProvider.toLowerCase(),
    )
      ? rawExternalProvider
      : externalLocationId
        ? "yoco"
        : "";
  const externalName = text(
    raw.externalName || raw.external_name || raw.yocoLocationName,
  );
  const stockRouting = objectValue(
    raw.stockRouting || raw.stock_routing || raw.routing,
  );
  const isDefault =
    raw.isDefault === true || raw.is_default === 1 || existingId === "main";
  const locationId = existingId || (isDefault ? "main" : id("loc"));
  const rawForStorage = {
    ...raw,
    id: locationId,
    type: kind,
    kind,
    stockRouting,
  };

  return {
    id: locationId,
    name: name || externalName || "Location",
    displayName: text(
      raw.displayName || raw.display_name || raw.customName || raw.custom_name,
    ),
    externalName,
    kind,
    isDefault: isDefault ? 1 : 0,
    externalProvider,
    externalLocationId,
    stockRoutingJson: JSON.stringify(stockRouting),
    rawJson: JSON.stringify(rawForStorage),
  };
}

async function saveLocationRecord(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  raw: Record<string, unknown>,
) {
  const location = normalizeLocationPayload(raw);
  if (!location.name) throw new Error("Location name is required.");

  const existing = await env.DB.prepare(
    `SELECT id, external_provider, external_location_id
       FROM locations
      WHERE workspace_id = ?1
        AND (
          id = ?2
          OR (lower(trim(name)) = lower(trim(?3)) AND kind = ?4)
          OR (
            ?5 != ''
            AND external_location_id = ?5
            AND (?6 = '' OR external_provider = ?6 OR external_provider = 'yoco')
          )
        )
      ORDER BY CASE WHEN id = ?2 THEN 0 ELSE 1 END
      LIMIT 1`,
  )
    .bind(
      workspaceId,
      location.id,
      location.name,
      location.kind,
      location.externalLocationId,
      location.externalProvider,
    )
    .first<{
      id: string;
      external_provider?: string;
      external_location_id?: string;
    }>();

  const locationId = existing?.id || location.id;
  const externalProvider =
    location.externalProvider ||
    text(existing?.external_provider) ||
    (location.externalLocationId || existing?.external_location_id
      ? "yoco"
      : "");
  const externalLocationId =
    location.externalLocationId || text(existing?.external_location_id);
  const persistedExternalProvider = externalProvider || null;
  const persistedExternalLocationId = externalLocationId || null;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO locations
        (id, workspace_id, legacy_source_id, name, display_name, external_name, kind, active,
         is_default, external_provider, external_location_id, stock_routing_json, raw_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
       ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        display_name = excluded.display_name,
        external_name = excluded.external_name,
        kind = excluded.kind,
        active = 1,
        is_default = CASE WHEN locations.is_default = 1 THEN 1 ELSE excluded.is_default END,
        external_provider = COALESCE(NULLIF(excluded.external_provider, ''), locations.external_provider),
        external_location_id = COALESCE(NULLIF(excluded.external_location_id, ''), locations.external_location_id),
        stock_routing_json = excluded.stock_routing_json,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`,
    ).bind(
      locationId,
      workspaceId,
      text(
        raw.legacySourceId ||
          raw.legacy_source_id ||
          raw.sourceId ||
          locationId,
      ),
      location.name,
      location.displayName,
      location.externalName,
      location.kind,
      location.isDefault,
      persistedExternalProvider,
      persistedExternalLocationId,
      location.stockRoutingJson,
      location.rawJson,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'location_saved', 'location', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      locationId,
      location.rawJson,
      now,
    ),
  ]);

  // If the creator is location-scoped (a restricted, non-manager member), grant them access to the
  // location they just created — otherwise the read-side filter would hide it from them.
  const creatorAllowed = await getUserAllowedLocationIds(
    env,
    auth,
    workspaceId,
  );
  if (creatorAllowed && !creatorAllowed.includes(locationId)) {
    await env.CENTRAL_DB.prepare(
      `UPDATE workspace_members
          SET allowed_locations_json = ?3,
              updated_at = ?4
        WHERE workspace_id = ?1
          AND status = 'active'
          AND (auth_uid = ?2 OR lower(email) = lower(?5))`,
    )
      .bind(
        workspaceId,
        auth.uid,
        JSON.stringify([...creatorAllowed, locationId]),
        now,
        auth.email,
      )
      .run();
  }

  return locationId;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

type ExternalTransferEnvelope = {
  shipped: Array<Record<string, unknown>>;
  received: Array<Record<string, unknown>>;
  shortfalls: Array<Record<string, unknown>>;
  transferMeta: Record<string, unknown>;
  lifecycle: Record<string, unknown>;
};

function parseExternalTransferEnvelope(
  value: unknown,
): ExternalTransferEnvelope {
  const parsed = typeof value === "string" ? jsonParse(value) : value;
  if (Array.isArray(parsed)) {
    return {
      shipped: parsed.map(objectValue),
      received: [],
      shortfalls: [],
      transferMeta: {},
      lifecycle: {},
    };
  }
  const envelope = objectValue(parsed);
  const shipped = arrayValue(envelope.shipped || envelope.items).map(
    objectValue,
  );
  return {
    shipped,
    received: arrayValue(envelope.received).map(objectValue),
    shortfalls: arrayValue(envelope.shortfalls).map(objectValue),
    transferMeta: objectValue(
      envelope.transferMeta || envelope.transfer_meta || envelope.meta,
    ),
    lifecycle: objectValue(envelope.lifecycle),
  };
}

function cleanTransferDisplayName(
  value: unknown,
  idValue: unknown,
  fallback: string,
) {
  const candidate = text(value);
  const identifier = text(idValue);
  if (
    !candidate ||
    candidate === identifier ||
    looksOpaqueTransferIdentifier(candidate)
  ) {
    return fallback;
  }
  return candidate.slice(0, 160);
}

function looksOpaqueTransferIdentifier(value: string) {
  const normalized = text(value);
  return (
    /^(?:[a-z]{0,8}[_-])?[0-9a-f]{20,}$/i.test(normalized) ||
    /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(normalized) ||
    /^WS[-_][a-z0-9_-]{12,}$/i.test(normalized)
  );
}

function findExternalTransferItem(
  items: Array<Record<string, unknown>>,
  stockItemId: string,
) {
  return (
    items.find(
      (item) =>
        text(
          item.sourceStockItemId ||
            item.stockItemId ||
            item.stock_item_id ||
            item.id,
        ) === stockItemId,
    ) || {}
  );
}

function linkedTransferLocationName(
  sourceProfile: Record<string, unknown>,
  workspaceId: string,
  locationId: string,
) {
  if (!workspaceId || !locationId) return "";
  const linkedSites = objectValue(
    sourceProfile.linkedSites || sourceProfile.linked_sites,
  );
  const linked = objectValue(linkedSites[workspaceId]);
  const locations = arrayValue(
    linked.locations || linked.siteLocations || linked.site_locations,
  ).map(objectValue);
  const match = locations.find(
    (location) =>
      text(location.id || location.locationId || location.location_id) ===
      locationId,
  );
  return text(match?.name || match?.displayName || match?.locationName);
}

function linkedWorkspaceIds(profile: Record<string, unknown>) {
  const linkedSites = objectValue(profile.linkedSites || profile.linked_sites);
  const ids = new Set<string>();
  for (const [id, entry] of Object.entries(linkedSites)) {
    const linkedId = text(
      objectValue(entry).siteId || objectValue(entry).site_id || id,
    );
    if (linkedId) ids.add(linkedId);
  }
  return [...ids];
}

async function buildLinkedTransferProfile(
  env: Env,
  sourceProfile: Record<string, unknown>,
  linkedId: string,
) {
  const [workspace, settings, locations, stockItems] = await Promise.all([
    env.CENTRAL_DB.prepare(
      `SELECT id, name, status
         FROM workspaces
        WHERE id = ?1
        LIMIT 1`,
    )
      .bind(linkedId)
      .first<{ id: string; name: string; status: string }>(),
    env.DB.prepare(
      `SELECT raw_json
         FROM workspace_settings
        WHERE workspace_id = ?1
        LIMIT 1`,
    )
      .bind(linkedId)
      .first<{ raw_json: string }>(),
    env.DB.prepare(
      `SELECT id, name, display_name, external_name, kind, active, is_default
         FROM locations
        WHERE workspace_id = ?1
          AND active = 1
        ORDER BY is_default DESC, kind ASC, name ASC`,
    )
      .bind(linkedId)
      .all(),
    env.DB.prepare(
      `SELECT
          si.id,
          si.name,
          si.category,
          si.item_type,
          si.unit,
          si.unit_cost,
          si.barcode_csv,
          si.raw_json,
          COALESCE((SELECT SUM(quantity) FROM stock_balances sb WHERE sb.workspace_id = si.workspace_id AND sb.stock_item_id = si.id), 0) AS stock,
          COALESCE((
            SELECT json_group_object(sb.location_id, sb.quantity)
              FROM stock_balances sb
             WHERE sb.workspace_id = si.workspace_id
               AND sb.stock_item_id = si.id
          ), '{}') AS balances_json
         FROM stock_items si
        WHERE si.workspace_id = ?1
          AND si.active = 1
        ORDER BY si.name ASC`,
    )
      .bind(linkedId)
      .all(),
  ]);

  const sourceLink = objectValue(
    objectValue(sourceProfile.linkedSites || sourceProfile.linked_sites)[
      linkedId
    ],
  );
  const targetProfile = objectValue(jsonParse(settings?.raw_json));
  const targetName = text(
    targetProfile.siteName ||
      targetProfile.workspaceName ||
      targetProfile.name ||
      sourceLink.siteName ||
      sourceLink.name ||
      workspace?.name ||
      linkedId,
  );

  return {
    id: linkedId,
    siteId: linkedId,
    workspaceId: linkedId,
    name: targetName,
    siteName: targetName,
    orgId: text(
      targetProfile.orgId ||
        targetProfile.org_id ||
        sourceLink.orgId ||
        sourceLink.org_id ||
        sourceProfile.orgId ||
        sourceProfile.org_id,
    ),
    corpId: text(
      targetProfile.corpId ||
        targetProfile.corp_id ||
        sourceLink.corpId ||
        sourceLink.corp_id ||
        sourceProfile.corpId ||
        sourceProfile.corp_id,
    ),
    permissionLevel: text(
      sourceLink.permissionLevel ||
        sourceLink.permission_level ||
        "full_transfer",
      "full_transfer",
    ),
    viewingOnly:
      targetProfile.viewingOnly === true || targetProfile.viewing_only === true,
    migrated: Boolean(workspace),
    migrationRequired: !workspace,
    locations: arrayValue(locations.results)
      .map((location) => {
        const row = objectValue(location);
        return {
          id: text(row.id),
          name: text(
            row.display_name || row.name || row.external_name || row.id,
          ),
          type: text(row.kind || "selling", "selling"),
          active: row.active !== 0,
        };
      })
      .filter((location) => location.id && location.name),
    stockItems: arrayValue(stockItems.results)
      .map((item) => {
        const row = objectValue(item);
        const raw = objectValue(jsonParse(row.raw_json));
        const sku = resolveStockSku(
          row.name,
          raw.sku,
          raw.SKU,
          raw.skuCode,
          raw.stockCode,
          raw.itemCode,
          raw.customSku,
          raw.code,
        );
        return {
          id: text(row.id),
          name: text(row.name),
          category: text(row.category),
          itemType: text(row.item_type),
          unit: text(row.unit),
          sku,
          code: sku,
          barcodes: text(row.barcode_csv)
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          stock: Number(row.stock || 0) || 0,
          balances: objectValue(jsonParse(row.balances_json)),
        };
      })
      .filter((item) => item.id && item.name),
  };
}

// The 44 per-tenant tables (data-migration allowlist). Central tables are never imported into a DO.
const TENANT_TABLE_ALLOWLIST = new Set([
  "adjustment_lines",
  "adjustments",
  "audit_events",
  "credit_note_lines",
  "credit_notes",
  "grv_lines",
  "grvs",
  "integration_errors",
  "integration_logs",
  "locations",
  "low_stock_email_runs",
  "low_stock_email_settings",
  "manufacturing_batch_lines",
  "manufacturing_batches",
  "product_location_prices",
  "products",
  "purchase_order_lines",
  "purchase_orders",
  "recipe_lines",
  "recipes",
  "stock_balances",
  "stock_item_location_prices",
  "stock_items",
  "stock_movements",
  "stocktake_count_lines",
  "stocktake_drafts",
  "stocktake_sessions",
  "stocktake_template_lines",
  "stocktake_templates",
  "suppliers",
  "transfer_lines",
  "transfer_template_lines",
  "transfer_templates",
  "transfers",
  "user_location_permissions",
  "workspace_settings",
  "yoco_brands",
  "yoco_categories",
  "yoco_connections",
  "yoco_modifier_groups",
  "yoco_order_lines",
  "yoco_orders",
  "yoco_processed_signatures",
  "yoco_webhook_events",
]);

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * Data-migration import: bulk-insert a workspace's rows (from the OLD single D1) into THIS DO's own
 * SQLite. Body = { tables: { <tenantTable>: [ {col: value, ...}, ... ] } }. Table names are checked
 * against the tenant allowlist and column names against a strict identifier regex (identifiers can't
 * be parameterized); values are always bound. Superuser-gated by the front Worker before it forwards.
 */
export async function migrateImport(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
) {
  const payload = await readJson<{ tables?: Record<string, unknown> }>(request);
  const tables = objectValue(payload.tables);
  const counts: Record<string, number> = {};
  const errors: string[] = [];

  for (const [table, rawRows] of Object.entries(tables)) {
    if (!TENANT_TABLE_ALLOWLIST.has(table) || !SQL_IDENTIFIER.test(table)) {
      errors.push(`skipped disallowed table: ${table}`);
      continue;
    }
    const rows = arrayValue(rawRows).map(objectValue);
    let written = 0;
    let batch: DbStatementLike[] = [];
    const flush = async () => {
      if (batch.length) {
        await env.DB.batch(batch);
        batch = [];
      }
    };
    for (const row of rows) {
      const cols = Object.keys(row).filter((c) => SQL_IDENTIFIER.test(c));
      if (!cols.length) continue;
      const placeholders = cols.map((_, i) => `?${i + 1}`).join(", ");
      const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
      batch.push(env.DB.prepare(sql).bind(...cols.map((c) => row[c])));
      written += 1;
      if (batch.length >= 50) await flush();
    }
    await flush();
    counts[table] = written;
  }
  return json(request, env, { ok: true, workspaceId, counts, errors });
}

/**
 * A workspace's OWN transfer profile (locations + stock items with balances), built from its local
 * tenant tables. The front Worker fans this out across linked peers to assemble linked-transfer
 * profiles (each DO can only see its own stock).
 */
export async function getSelfTransferProfile(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const settings = await env.DB.prepare(
    `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json: string }>();
  const selfProfile = objectValue(jsonParse(settings?.raw_json));
  const profile = await buildLinkedTransferProfile(
    env,
    selfProfile,
    workspaceId,
  );
  return json(request, env, { ok: true, profile });
}

/**
 * Per-workspace summary for the admin overview — settings + stock/location counts + Yoco status, all
 * read from THIS workspace's DO. Fanned out by the front Worker (already admin-gated), so it does no
 * membership check of its own; it only ever exposes counts/settings for one workspace.
 */
export async function getAdminWorkspaceSummary(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  const [settingsRow, stockCount, locationCount, yocoRow] = await Promise.all([
    env.DB.prepare(
      `SELECT raw_json, vat_rate, low_stock_email_period, low_stock_email_time
         FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
    )
      .bind(workspaceId)
      .first<any>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM stock_items WHERE workspace_id = ?1 AND active = 1`,
    )
      .bind(workspaceId)
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM locations WHERE workspace_id = ?1 AND active = 1`,
    )
      .bind(workspaceId)
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT yc.status, yc.connection_active, yc.webhook_id, yc.webhook_url, yc.last_error,
              yc.created_at, yc.updated_at, yc.last_catalogue_sync_at, yc.last_sales_sync_at, yc.disconnected_at,
              (SELECT COUNT(*) FROM products p WHERE p.workspace_id = ?1 AND p.external_provider = 'yoco' AND p.active = 1) AS items_count,
              (SELECT COUNT(*) FROM locations l WHERE l.workspace_id = ?1 AND l.external_provider = 'yoco' AND l.active = 1) AS locations_count
         FROM yoco_connections yc WHERE yc.workspace_id = ?1 LIMIT 1`,
    )
      .bind(workspaceId)
      .first<any>(),
  ]);

  let yoco: Record<string, unknown> = {};
  if (yocoRow) {
    const status = text(yocoRow.status || "disconnected").toLowerCase();
    const lastSyncAt =
      yocoRow.last_sales_sync_at || yocoRow.last_catalogue_sync_at || "";
    yoco = {
      status,
      connectionActive:
        Number(yocoRow.connection_active || 0) === 1 || status === "connected",
      syncState: "idle",
      health: yocoRow.last_error
        ? "attention"
        : status === "connected"
          ? "healthy"
          : "offline",
      lastSyncCompletedAt: lastSyncAt,
      lastImportedAt: yocoRow.last_catalogue_sync_at || "",
      lastCheckedAt: lastSyncAt,
      updatedAt: yocoRow.updated_at || yocoRow.created_at || "",
      lastError: yocoRow.last_error || "",
      webhook: {
        enabled: Boolean(yocoRow.webhook_id),
        id: yocoRow.webhook_id || "",
        url: yocoRow.webhook_url || "",
      },
      disconnectedAt: yocoRow.disconnected_at || "",
      catalogue: { itemsCount: Number(yocoRow.items_count || 0) },
      locations: { count: Number(yocoRow.locations_count || 0) },
    };
  }

  return json(request, env, {
    ok: true,
    settings: settingsRow || {},
    metrics: {
      stockItemCount: Number(stockCount?.c || 0),
      locationCount: Number(locationCount?.c || 0),
    },
    yoco,
  });
}

/**
 * Purge ALL tenant tables for this workspace from its own DO. Called by the front Worker during admin
 * workspace deletion (superuser-gated before forwarding). Table names come from the fixed allowlist,
 * so the interpolation is safe. Returns the total rows deleted.
 */
export async function purgeWorkspaceTenant(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
) {
  const statements = [...TENANT_TABLE_ALLOWLIST].map((table) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
  );
  const results = await env.DB.batch(statements);
  const deletedRows = results.reduce(
    (total, r) => total + Number(r.meta?.changes || 0),
    0,
  );
  return json(request, env, { ok: true, deletedRows });
}

/**
 * Admin read of this workspace's settings (raw_json map) from its own DO. Fanned in by the front
 * Worker for the admin console (billing lock, etc.); admin-gated there, so no membership check here.
 */
export async function getAdminWorkspaceSettingsDO(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
) {
  const row = await env.DB.prepare(
    `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json?: string }>();
  return json(request, env, {
    ok: true,
    settings: jsonParse(row?.raw_json) || {},
  });
}

/** Admin merge-patch of this workspace's settings raw_json in its own DO (e.g. billing is_locked). */
export async function patchAdminWorkspaceSettingsDO(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
) {
  const payload = await readJson<Record<string, unknown>>(request);
  const row = await env.DB.prepare(
    `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json?: string }>();
  const existing = objectValue(jsonParse(row?.raw_json));
  const deleteKeys = Array.isArray(payload.__deleteKeys)
    ? payload.__deleteKeys
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];
  const nextPayload = { ...payload } as Record<string, unknown>;
  delete nextPayload.__deleteKeys;
  const merged = { ...existing, ...nextPayload } as Record<string, unknown>;
  for (const key of deleteKeys) delete merged[key];
  await env.DB.prepare(
    `INSERT INTO workspace_settings (workspace_id, raw_json, updated_at)
     VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(workspace_id) DO UPDATE SET
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
  )
    .bind(workspaceId, JSON.stringify(merged))
    .run();
  return json(request, env, { ok: true, settings: merged });
}

// --- DO-side admin actions. The front Worker gates with requireAdmin (CENTRAL_DB) and forwards
// here; these run against tenant env.DB and must NOT re-auth. They exist because the admin console's
// workspace actions query tenant tables (yoco_connections, products, locations, settings) that live
// in the DO, not CENTRAL_DB — running them centrally threw the generic "Something went wrong". ---
export async function adminYocoActionDO(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
  action: string,
) {
  const body = await readJson<Record<string, unknown>>(request).catch(
    () => ({}) as Record<string, unknown>,
  );
  console.log(`[admin-yoco] ${action} ws=${workspaceId}`);
  try {
    if (action === "connect") {
      const result = await connectYoco(
        env,
        workspaceId,
        text(body.apiKey || body.secretKey),
        { allowKeyReplacement: true, actorUid: 'kcp-admin' },
      );
      return json(request, env, { ok: true, ...result });
    }
    if (action === "disconnect") {
      const result = await disconnectYoco(env, workspaceId);
      return json(request, env, { ok: true, ...result });
    }
    if (action === "sync-catalogue") {
      const result = await syncYocoCatalogue(env, workspaceId);
      return json(request, env, { ok: true, ...result });
    }
    if (action === "sync-sales") {
      const sinceDays = Number(body.sinceDays || 0);
      // Clamp an explicit lookback window to a sane maximum (31 days).
      const clampedDays =
        Number.isFinite(sinceDays) && sinceDays > 0
          ? Math.min(sinceDays, 31)
          : 0;
      const sinceIso =
        clampedDays > 0
          ? new Date(
              Date.now() - clampedDays * 24 * 60 * 60 * 1000,
            ).toISOString()
          : "";
      const result = await syncYocoSales(
        env,
        workspaceId,
        sinceIso ? { sinceIso } : {},
      );
      return json(request, env, { ok: true, ...result });
    }
    if (action === "reconcile-sales") {
      const sinceDays = Number(body.sinceDays || 2);
      const clampedDays =
        Number.isFinite(sinceDays) && sinceDays > 0
          ? Math.min(Math.max(sinceDays, 1), 31)
          : 2;
      const sinceIso = new Date(
        Date.now() - clampedDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const result = await syncYocoSales(env, workspaceId, { sinceIso });
      return json(request, env, {
        ok: true,
        reconciliation: true,
        sinceIso,
        sinceDays: clampedDays,
        ...result,
      });
    }
    if (action === "retry-failed-orders") {
      const result = await retryFailedYocoOrders(env, workspaceId, { automatic: false });
      return json(request, env, { ok: true, ...result });
    }
    if (action === "reset-webhook") {
      const result = await resetYocoWebhook(env, workspaceId);
      return json(request, env, { ok: true, ...result });
    }
    if (action === "test-webhook") {
      const result = await testYocoWebhook(env, workspaceId);
      return json(request, env, { ok: true, ...result });
    }
    return error(request, env, 404, `Unknown Yoco admin action: ${action}`);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(
      `[admin-yoco] ${action} ws=${workspaceId} failed: ${message}`,
    );
    return error(request, env, 502, message || `Yoco ${action} failed.`);
  }
}

export async function postDashboardLowStockEmail(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload: Record<string, unknown> = await readJson<Record<string, unknown>>(request)
    .catch((): Record<string, unknown> => ({}));
  const locationId = text(payload.locationId);
  if (locationId) await assertLocationAccess(env, auth, workspaceId, locationId, 'dashboard notifications');
  const result = await sendWorkspaceLowStockToUser(env, workspaceId, auth.email, locationId);
  return json(request, env, { ok: true, ...result });
}

export async function adminYocoStatusDO(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
) {
  return json(request, env, await buildAdminYocoStatus(env, workspaceId));
}

export async function adminYocoEventsDO(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
) {
  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") || 25), 1),
    100,
  );
  const rows = await env.DB.prepare(
    `SELECT *
       FROM (
         SELECT id,
                'webhook' AS source,
                provider_event_id,
                event_type AS operation,
                yoco_order_id,
                status,
                COALESCE(NULLIF(error_message, ''), event_type) AS message,
                raw_json AS details_json,
                processed_at,
                NULL AS duration_ms,
                created_at
           FROM yoco_webhook_events
          WHERE workspace_id = ?1
         UNION ALL
         SELECT id,
                'operation' AS source,
                correlation_id AS provider_event_id,
                operation,
                NULL AS yoco_order_id,
                status,
                message,
                details_json,
                completed_at AS processed_at,
                duration_ms,
                created_at
           FROM integration_logs
          WHERE workspace_id = ?1
            AND provider = 'yoco'
       ) combined
      ORDER BY created_at DESC
      LIMIT ?2`,
  )
    .bind(workspaceId, limit)
    .all<any>();
  return json(request, env, {
    ok: true,
    events: (rows.results || []).map((row) => ({
      id: text(row.id),
      source: text(row.source || "webhook"),
      providerEventId: text(row.provider_event_id),
      eventType: text(row.operation || "webhook"),
      operation: text(row.operation || "webhook"),
      orderId: text(row.yoco_order_id),
      status: text(row.status || "received"),
      message: text(row.message),
      error: ['failed', 'rejected'].includes(text(row.status).toLowerCase()) ? text(row.message) : '',
      details: jsonParse(row.details_json) || {},
      durationMs: Number(row.duration_ms || 0) || 0,
      processedAt: text(row.processed_at),
      timestamp: text(row.created_at),
    })),
  });
}

export async function adminAuditEventsDO(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
) {
  const rows = await env.DB.prepare(
    `SELECT id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at
       FROM audit_events
      WHERE workspace_id = ?1
      ORDER BY created_at DESC
      LIMIT 250`,
  )
    .bind(workspaceId)
    .all<any>();
  return json(request, env, { ok: true, rows: rows.results || [] });
}

export async function adminActionDO(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
  action: string,
) {
  console.log(`[admin-action] ${action} ws=${workspaceId}`);
  try {
    if (action === "send-low-stock-email") {
      const result = await sendWorkspaceLowStockNow(env, workspaceId);
      return json(request, env, { ok: true, ...result });
    }
    if (action === "low-stock-due") {
      // Scheduled cron fan-out: due/window-gated per-workspace send (runs in this DO).
      const result = await sendWorkspaceLowStockDue(env, workspaceId);
      return json(request, env, { ok: true, ...result });
    }
    if (action === "yoco-webhook-health") {
      const health = await checkYocoWebhookSignatureHealth(env, workspaceId);
      const retry = await retryFailedYocoOrders(env, workspaceId, {
        automatic: true,
        maxAutomaticLookbackDays: 31,
      }).catch((caught) => ({
        status: 'retry_failed',
        error: caught instanceof Error ? caught.message : String(caught),
      }));
      return json(request, env, { ...health, retry });
    }
    if (action === "repair-baseline") {
      let changes = 0;
      const settings = await env.DB.prepare(
        `SELECT workspace_id FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
      )
        .bind(workspaceId)
        .first<{ workspace_id?: string }>();
      if (!settings?.workspace_id) {
        await env.DB.prepare(
          `INSERT INTO workspace_settings (workspace_id, raw_json, updated_at)
           VALUES (?1, ?2, datetime('now'))`,
        )
          .bind(
            workspaceId,
            JSON.stringify({
              businessName: workspaceId,
              siteName: workspaceId,
            }),
          )
          .run();
        changes += 1;
      }

      const locationCount = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM locations WHERE workspace_id = ?1 AND active = 1`,
      )
        .bind(workspaceId)
        .first<{ c?: number }>();
      if (Number(locationCount?.c || 0) === 0) {
        await env.DB.prepare(
          `INSERT INTO locations
             (id, workspace_id, name, display_name, kind, active, is_default, created_at, updated_at)
           VALUES (?1, ?2, 'Main Storage', 'Main Storage', 'storage', 1, 1, datetime('now'), datetime('now'))`,
        )
          .bind(`loc_${workspaceId}_main`, workspaceId)
          .run();
        changes += 1;
      } else {
        const defaultLocation = await env.DB.prepare(
          `SELECT id FROM locations WHERE workspace_id = ?1 AND active = 1 AND is_default = 1 LIMIT 1`,
        )
          .bind(workspaceId)
          .first<{ id?: string }>();
        if (!defaultLocation?.id) {
          const firstLocation = await env.DB.prepare(
            `SELECT id FROM locations WHERE workspace_id = ?1 AND active = 1 ORDER BY created_at, id LIMIT 1`,
          )
            .bind(workspaceId)
            .first<{ id?: string }>();
          if (firstLocation?.id) {
            await env.DB.prepare(
              `UPDATE locations SET is_default = CASE WHEN id = ?2 THEN 1 ELSE 0 END, updated_at = datetime('now')
                WHERE workspace_id = ?1 AND active = 1`,
            )
              .bind(workspaceId, firstLocation.id)
              .run();
            changes += 1;
          }
        }
      }
      return json(request, env, { ok: true, changes });
    }
    return error(request, env, 404, `Unknown workspace action: ${action}`);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(
      `[admin-action] ${action} ws=${workspaceId} failed: ${message}`,
    );
    return error(request, env, 502, message || `Action ${action} failed.`);
  }
}

const ORG_LINK_FIELDS = [
  "orgId",
  "org_id",
  "corpId",
  "corp_id",
  "permissionLevel",
  "groupMetadata",
  "linkedSites",
];

export async function adminOrgFieldsDO(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
) {
  const row = await env.DB.prepare(
    `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json?: string }>();
  const settings = objectValue(jsonParse(row?.raw_json));
  return json(request, env, {
    ok: true,
    orgId: text(settings.orgId || settings.org_id),
    corpId: text(settings.corpId || settings.corp_id),
    permissionLevel: text(settings.permissionLevel),
    groupMetadata: settings.groupMetadata || null,
    linkedSites: settings.linkedSites || {},
  });
}

export async function adminUnlinkOrgDO(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string,
) {
  const row = await env.DB.prepare(
    `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json?: string }>();
  const settings = objectValue(jsonParse(row?.raw_json));
  for (const field of ORG_LINK_FIELDS) delete settings[field];
  await env.DB.prepare(
    `INSERT INTO workspace_settings (workspace_id, raw_json)
     VALUES (?1, ?2)
     ON CONFLICT(workspace_id) DO UPDATE SET raw_json = excluded.raw_json`,
  )
    .bind(workspaceId, JSON.stringify(settings))
    .run();
  console.log(`[admin-unlink-org] cleared org fields ws=${workspaceId}`);
  return json(request, env, { ok: true });
}

async function recordYocoWebhookRejection(
  env: Env,
  details: {
    workspaceId: string;
    eventId: string;
    eventType: string;
    orderId: string;
    payloadHash: string;
    message: string;
  },
) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO yoco_webhook_events
        (id, workspace_id, provider_event_id, event_type, yoco_order_id,
         payload_hash, status, error_message, raw_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'rejected', ?7, '{}', ?8)
       ON CONFLICT(workspace_id, payload_hash) DO UPDATE SET
        status = 'rejected',
        error_message = excluded.error_message`,
    ).bind(
      id("yoco_evt"),
      details.workspaceId,
      details.eventId,
      details.eventType || "unknown",
      details.orderId || null,
      details.payloadHash,
      details.message,
      nowIso(),
    ),
    env.DB.prepare(
      `UPDATE yoco_connections
          SET last_error = ?2,
              updated_at = ?3
        WHERE workspace_id = ?1`,
    ).bind(details.workspaceId, details.message, nowIso()),
  ]);
}

function activeYocoWebhookSecrets(
  connection: Record<string, unknown> | null | undefined,
) {
  const secrets = [text(connection?.webhook_secret)];
  const previousSecret = text(connection?.webhook_previous_secret);
  const previousUntil = Date.parse(text(connection?.webhook_previous_until));
  if (
    previousSecret &&
    Number.isFinite(previousUntil) &&
    previousUntil > Date.now()
  ) {
    secrets.push(previousSecret);
  }
  return secrets.filter(Boolean);
}

async function markYocoWebhookSignatureMismatch(env: Env, workspaceId: string) {
  await env.DB.prepare(
    `UPDATE yoco_connections
        SET last_error = ?2,
            updated_at = ?3
      WHERE workspace_id = ?1`,
  )
    .bind(
      workspaceId,
      "Yoco webhook signature mismatch. The webhook subscription may be stale and will be reset on the next integration sync or manual webhook reset.",
      nowIso(),
    )
    .run();
}

const YOCO_SIGNATURE_ALERT_THRESHOLD = 3;
const YOCO_SIGNATURE_ALERT_WINDOW_MINUTES = 60;

async function checkYocoWebhookSignatureHealth(env: Env, workspaceId: string) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS failures,
            MIN(created_at) AS first_failure_at,
            MAX(created_at) AS last_failure_at
       FROM yoco_webhook_events
      WHERE workspace_id = ?1
        AND status = 'rejected'
        AND error_message LIKE '%signature%'
        AND datetime(created_at) >= datetime('now', ?2)`,
  )
    .bind(workspaceId, `-${YOCO_SIGNATURE_ALERT_WINDOW_MINUTES} minutes`)
    .first<Record<string, unknown>>();

  const failures = Number(row?.failures || 0) || 0;
  const alerting = failures >= YOCO_SIGNATURE_ALERT_THRESHOLD;
  const message = alerting
    ? `Yoco webhook alert: ${failures} signature verification failures in the last ${YOCO_SIGNATURE_ALERT_WINDOW_MINUTES} minutes. Reset the webhook subscription and verify the stored secret.`
    : "";

  if (alerting) {
    console.error(
      `[yoco-webhook-alert] ws=${workspaceId} failures=${failures} first=${text(row?.first_failure_at)} last=${text(row?.last_failure_at)}`,
    );
    await env.DB.prepare(
      `UPDATE yoco_connections
          SET last_error = ?2,
              updated_at = ?3
        WHERE workspace_id = ?1`,
    )
      .bind(workspaceId, message, nowIso())
      .run();
  }

  return {
    ok: true,
    alerting,
    failures,
    threshold: YOCO_SIGNATURE_ALERT_THRESHOLD,
    windowMinutes: YOCO_SIGNATURE_ALERT_WINDOW_MINUTES,
    firstFailureAt: text(row?.first_failure_at),
    lastFailureAt: text(row?.last_failure_at),
    message,
  };
}

async function scoped(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await assertWorkspaceAccess(env, auth, workspaceId);
}

const PERMISSION_MANAGER_ROLE_KEYS = new Set([
  "owner",
  "admin",
  "super",
  "super-user",
  "superuser",
  "root",
  "kcp-superuser",
  "kcp-super-user",
]);
// The KCP Super User is a hidden system role. It must never be created, edited, deleted, or
// assigned to a workspace member through the normal role/member routes — only the admin portal
// (admin_users table) manages it.
const RESERVED_HIDDEN_ROLE_KEYS = new Set([
  "super",
  "super-user",
  "superuser",
  "root",
  "kcp-superuser",
  "kcp-super-user",
]);
function isReservedHiddenRoleKey(value: unknown) {
  return RESERVED_HIDDEN_ROLE_KEYS.has(normalizeRoleKey(value));
}
const STOCK_TAKE_30_DAY_ROLE_KEYS = new Set([
  "owner",
  "admin",
  "super",
  "super-user",
  "superuser",
  "root",
  "manager",
]);
const STOCK_TAKE_EDIT_7_DAY_PERMISSION = "action-edit-stock-take-7-days";
const STOCK_TAKE_EDIT_30_DAY_PERMISSION = "action-edit-stock-take-30-days";

function normalizeRoleKey(value: unknown) {
  return text(value)
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

async function getWorkspaceActorRole(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  const [workspace, member, adminUser] = await Promise.all([
    env.CENTRAL_DB.prepare(
      `SELECT owner_uid
         FROM workspaces
        WHERE id = ?1
        LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ owner_uid?: string }>(),
    env.CENTRAL_DB.prepare(
      `SELECT role_key
         FROM workspace_members
        WHERE workspace_id = ?1
          AND status = 'active'
          AND (auth_uid = ?2 OR lower(email) = lower(?3))
        LIMIT 1`,
    )
      .bind(workspaceId, auth.uid, auth.email)
      .first<{ role_key?: string }>(),
    env.CENTRAL_DB.prepare(
      `SELECT role_key, status
         FROM admin_users
        WHERE status = 'active'
          AND (auth_uid = ?1 OR lower(email) = lower(?2))
        LIMIT 1`,
    )
      .bind(auth.uid, auth.email)
      .first<{ role_key?: string; status?: string }>(),
  ]);

  if (text(workspace?.owner_uid) === auth.uid) return "owner";
  const adminRole = normalizeRoleKey(adminUser?.role_key);
  if (adminRole === "superuser") return "superuser";
  return normalizeRoleKey(member?.role_key || "member") || "member";
}

async function denyUnlessPermissionManager(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  const actorRole = await getWorkspaceActorRole(env, auth, workspaceId);
  if (PERMISSION_MANAGER_ROLE_KEYS.has(actorRole)) return null;
  return error(
    request,
    env,
    403,
    "Only owners, admins, and super users can manage permission sets.",
  );
}

async function getWorkspaceActorPermissionSet(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  const actorRole = await getWorkspaceActorRole(env, auth, workspaceId);
  // KCP superusers have unrestricted access — return a wildcard sentinel.
  if (normalizeRoleKey(actorRole) === "superuser") {
    return { actorRole, permissions: ["*"] };
  }
  if (STOCK_TAKE_30_DAY_ROLE_KEYS.has(actorRole)) {
    return {
      actorRole,
      permissions: [
        STOCK_TAKE_EDIT_7_DAY_PERMISSION,
        STOCK_TAKE_EDIT_30_DAY_PERMISSION,
      ],
    };
  }
  const row = await env.CENTRAL_DB.prepare(
    `SELECT permissions_json
       FROM roles
      WHERE workspace_id = ?1
        AND role_key = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, actorRole)
    .first<{ permissions_json?: string }>();
  const parsed = jsonParse(row?.permissions_json) as
    Record<string, unknown> | unknown[];
  const parsedObject = objectValue(parsed);
  const rolePermissionsValue = parsedObject.permissions;
  const permissions: unknown[] = Array.isArray(rolePermissionsValue)
    ? rolePermissionsValue
    : Array.isArray(parsed)
      ? parsed
      : [];
  return {
    actorRole,
    permissions: permissions
      .map((permission) => text(permission))
      .filter(Boolean),
  };
}

async function canEditStockTakeSession(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  countedAt: string,
) {
  const { permissions } = await getWorkspaceActorPermissionSet(
    env,
    auth,
    workspaceId,
  );
  const hasAll = permissions.includes("*");
  const ageMs = Date.now() - new Date(countedAt || nowIso()).getTime();
  const ageDays = Math.max(0, Math.floor(ageMs / 86400000));
  if (
    ageDays <= 7 &&
    (hasAll ||
      permissions.includes(STOCK_TAKE_EDIT_7_DAY_PERMISSION) ||
      permissions.includes(STOCK_TAKE_EDIT_30_DAY_PERMISSION))
  )
    return true;
  if (
    ageDays <= 30 &&
    (hasAll || permissions.includes(STOCK_TAKE_EDIT_30_DAY_PERMISSION))
  )
    return true;
  return false;
}

export async function getLocations(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const allowedIds = await getUserAllowedLocationIds(env, auth, workspaceId);

  let rows;
  if (allowedIds === null) {
    // null = explicitly unrestricted manager/owner/superuser
    rows = await env.DB.prepare(
      `SELECT id, name, display_name, external_name, kind, active, is_default, external_provider, external_location_id, stock_routing_json, raw_json
         FROM locations
        WHERE workspace_id = ?1 AND active = 1
        ORDER BY is_default DESC, kind ASC, name ASC`,
    )
      .bind(workspaceId)
      .all();
  } else {
    const placeholders = allowedIds.map((_, i) => `?${i + 2}`).join(", ");
    rows = await env.DB.prepare(
      `SELECT id, name, display_name, external_name, kind, active, is_default, external_provider, external_location_id, stock_routing_json, raw_json
         FROM locations
        WHERE workspace_id = ?1 AND active = 1 AND id IN (${placeholders})
        ORDER BY is_default DESC, kind ASC, name ASC`,
    )
      .bind(workspaceId, ...allowedIds)
      .all();
  }

  const locations = (rows.results || []).map((row: Record<string, unknown>) => {
    const resolvedName = resolveLocationDisplayName(row);
    return {
      ...row,
      name: resolvedName,
      display_name: resolvedName,
    };
  });

  return json(request, env, { ok: true, locations });
}

export async function postLocation(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const locationId = await saveLocationRecord(
    env,
    auth,
    workspaceId,
    objectValue(payload.location || payload),
  );
  return json(request, env, { ok: true, id: locationId });
}

export async function patchLocation(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  locationId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const savedId = await saveLocationRecord(env, auth, workspaceId, {
    ...objectValue(payload.location || payload),
    id: text(locationId),
  });
  return json(request, env, { ok: true, id: savedId });
}

export async function deleteLocationRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  locationId = "",
) {
  await scoped(request, env, auth, workspaceId);
  const idValue = text(locationId);
  if (!idValue) return error(request, env, 400, "Location id is required.");

  const location = await env.DB.prepare(
    `SELECT id, name, display_name, kind, is_default, active
       FROM locations
      WHERE workspace_id = ?1
        AND id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, idValue)
    .first<Record<string, unknown>>();
  if (!location || numberValue(location.active, 1) === 0) {
    return error(request, env, 404, "Location could not be found.");
  }

  const normalizedId = text(location.id)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const normalizedName = text(location.display_name || location.name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const protectedMainStore =
    numberValue(location.is_default, 0) === 1 ||
    ["main", "locmain", "mainstore", "mainstorage", "defaultstock"].includes(
      normalizedId,
    ) ||
    normalizedName === "mainstore" ||
    normalizedName === "mainstorage";
  if (protectedMainStore) {
    return error(
      request,
      env,
      409,
      "Main Storage cannot be deleted. Rename it if needed.",
    );
  }

  if (text(location.kind).toLowerCase() !== "storage") {
    return error(
      request,
      env,
      409,
      "Selling locations are managed from the connected POS. Rename or hide them instead.",
    );
  }

  const balance = await env.DB.prepare(
    `SELECT COALESCE(SUM(ABS(quantity)), 0) AS total
       FROM stock_balances
      WHERE workspace_id = ?1
        AND location_id = ?2`,
  )
    .bind(workspaceId, idValue)
    .first<{ total: number }>();
  if (numberValue(balance?.total, 0) > 0) {
    return error(
      request,
      env,
      409,
      "Move or adjust all stock out of this storage location before deleting it.",
    );
  }

  const now = nowIso();
  const after = {
    ...location,
    active: 0,
    deletedAt: now,
    deletedBy: auth.uid,
  };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE locations
          SET active = 0,
              updated_at = ?3
        WHERE workspace_id = ?1
          AND id = ?2`,
    ).bind(workspaceId, idValue, now),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?1, ?2, ?3, 'location_deleted', 'location', ?4, ?5, ?6, ?7)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      idValue,
      JSON.stringify(location),
      JSON.stringify(after),
      now,
    ),
  ]);
  return json(request, env, { ok: true, deletedId: idValue });
}

export async function postSyncDefaultSiteName(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const name = text(payload.name || payload.siteName || payload.workspaceName);
  if (!name) return error(request, env, 400, "Site name is required.");

  const settings = await env.DB.prepare(
    `SELECT raw_json
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json: string }>();
  const rawSettings = objectValue(jsonParse(settings?.raw_json));
  const now = nowIso();
  // Workspace name lives in the CENTRAL registry; the rest is tenant-local. Split the write across
  // planes (a batch can't span two databases).
  await env.CENTRAL_DB.prepare(
    `UPDATE workspaces
        SET name = ?2,
            updated_at = ?3
      WHERE id = ?1`,
  )
    .bind(workspaceId, name, now)
    .run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspace_settings (workspace_id, raw_json, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(workspace_id) DO UPDATE SET
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`,
    ).bind(
      workspaceId,
      JSON.stringify({ ...rawSettings, siteName: name }),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, after_json, created_at)
       VALUES (?1, ?2, ?3, 'site_name_synced', 'workspace', ?4, ?5)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      JSON.stringify({ siteName: name }),
      now,
    ),
  ]);

  return json(request, env, {
    ok: true,
    sites: [{ id: "site_main", name, isDefault: true }],
  });
}

export async function getSiteConfiguration(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const [workspace, settings, locationCount] = await Promise.all([
    env.CENTRAL_DB.prepare(
      `SELECT id, name, status
         FROM workspaces
        WHERE id = ?1
        LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ id: string; name: string; status: string }>(),
    env.DB.prepare(
      `SELECT raw_json
         FROM workspace_settings
        WHERE workspace_id = ?1
        LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ raw_json: string }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM locations
        WHERE workspace_id = ?1
          AND active = 1`,
    )
      .bind(workspaceId)
      .first<{ count: number }>(),
  ]);

  if (!workspace)
    return error(
      request,
      env,
      404,
      "Workspace was not found in Cloudflare D1.",
    );

  const profile = objectValue(jsonParse(settings?.raw_json));
  const linkedSiteIds = linkedWorkspaceIds(profile);
  const orgId = text(profile.orgId || profile.org_id);
  const corpId = text(profile.corpId || profile.corp_id);
  const locationTotal = Number(locationCount?.count || 0);

  return json(request, env, {
    ok: true,
    siteConfiguration: {
      site_id: workspace.id,
      site_name: workspace.name,
      org_id: orgId,
      corp_id: corpId,
      viewing_only:
        profile.viewingOnly === true || profile.viewing_only === true,
      location_count: locationTotal,
      linked_site_count: linkedSiteIds.length,
      show_internal_transfer: locationTotal > 1,
      show_external_transfer: Boolean(orgId || corpId),
      status: workspace.status || "active",
      source: "cloudflare-d1",
    },
  });
}

export async function getWorkspaceSettingsRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const [workspace, settings] = await Promise.all([
    env.CENTRAL_DB.prepare(
      `SELECT id, name
         FROM workspaces
        WHERE id = ?1
        LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ id: string; name: string }>(),
    env.DB.prepare(
      `SELECT raw_json, updated_at
         FROM workspace_settings
        WHERE workspace_id = ?1
        LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ raw_json: string; updated_at: string }>(),
  ]);
  const raw = objectValue(jsonParse(settings?.raw_json));
  const siteName = text(
    raw.siteName ||
      raw.workspaceName ||
      raw.name ||
      workspace?.name ||
      workspaceId,
  );
  return json(request, env, {
    ok: true,
    settings: {
      ...raw,
      siteName,
      workspaceName: text(workspace?.name || raw.workspaceName || siteName),
      updatedAt: text(settings?.updated_at || raw.updatedAt),
    },
    source: "cloudflare-d1:workspace_settings",
  });
}

export async function getUserPreferencesRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  // Workspace access is still required, but the preference record belongs to the
  // authenticated person rather than to a workspace membership row. This also
  // supports workspace owners and KCP superusers, who may not have a member row.
  await scoped(request, env, auth, workspaceId);
  const preferences = await readPersonalPreferences(env, auth, workspaceId);
  return json(request, env, {
    ok: true,
    preferences,
    scope: 'user',
  });
}

export async function patchUserPreferencesRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const incoming = objectValue(payload.preferences || payload);
  const allowedKeys = new Set([
    'uiScale',
    'restaurantThemeId',
    'restaurantBackgroundId',
    'restaurantBackgroundDataUrl',
    'restaurantBackgroundName',
  ]);
  const safeIncoming = Object.fromEntries(
    Object.entries(incoming).filter(([key]) => allowedKeys.has(key)),
  );
  const current = await readPersonalPreferences(env, auth, workspaceId);
  const updatedAt = nowIso();
  const next = {
    ...current,
    ...safeIncoming,
    updatedAt,
  };
  const principalKey = userPreferencePrincipal(auth);
  await env.CENTRAL_DB.prepare(
    `INSERT INTO user_preferences
       (principal_key, auth_uid, email, preferences_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(principal_key) DO UPDATE SET
       auth_uid = excluded.auth_uid,
       email = excluded.email,
       preferences_json = excluded.preferences_json,
       updated_at = excluded.updated_at`,
  )
    .bind(principalKey, auth.uid, auth.email, JSON.stringify(next), updatedAt)
    .run();
  return json(request, env, { ok: true, preferences: next, scope: 'user' });
}

export async function patchWorkspaceSettingsRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  // Settings changes are privileged (workspace config).
  const denied = await denyUnlessPermissionManager(
    request,
    env,
    auth,
    workspaceId,
  );
  if (denied) return denied;
  const payload = await readJson<Record<string, unknown>>(request);
  const incoming = objectValue(payload.settings || payload);
  // SECURITY: never accept cross-workspace linkage keys from this route. They control
  // access to OTHER workspaces' costed inventory (linked transfer profiles) and external
  // transfer targets, and must be provisioned by the admin portal only — not by a member
  // spreading arbitrary JSON into workspace settings.
  for (const key of [
    "linkedSites",
    "linked_sites",
    "orgId",
    "org_id",
    "corpId",
    "corp_id",
  ]) {
    if (key in incoming) delete (incoming as Record<string, unknown>)[key];
  }
  const currentRow = await env.DB.prepare(
    `SELECT raw_json
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json: string }>();
  const current = objectValue(jsonParse(currentRow?.raw_json));
  const next = {
    ...current,
    ...incoming,
    updatedAt: nowIso(),
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspace_settings (workspace_id, raw_json, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(workspace_id) DO UPDATE SET
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`,
    ).bind(workspaceId, JSON.stringify(next), next.updatedAt),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'workspace_settings_saved', 'workspace_settings', ?2, ?4, ?5)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      JSON.stringify(next),
      next.updatedAt,
    ),
  ]);
  return json(request, env, { ok: true, settings: next });
}

function normalizeMemberRow(row: Record<string, unknown>) {
  const displayName = text(row.display_name || row.email || "Workspace User");
  const [firstName, ...surnameParts] = displayName.split(/\s+/);
  const rawLocations = jsonParse(
    row.allowed_locations_json as string | undefined,
  );
  const allowedLocations = Array.isArray(rawLocations)
    ? rawLocations.map((v) => text(v)).filter(Boolean)
    : [];
  return {
    key: text(row.id),
    id: text(row.id),
    uid: text(row.auth_uid),
    email: text(row.email).toLowerCase(),
    name: displayName,
    firstName: text(firstName),
    surname: text(surnameParts.join(" ")),
    role: text(row.role_key || "member", "member"),
    viewingOnly: Number(row.viewing_only || 0) === 1,
    lowStockAlert: Number(row.can_receive_low_stock_email || 0) === 1,
    canAccessExternalTransfers:
      Number(row.can_access_external_transfers ?? 1) !== 0,
    allowedLocations,
    status: text(row.auth_uid) ? "active" : "invited",
    joinedAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function normalizeRoleRow(row: Record<string, unknown>) {
  const permissions = jsonParse(row.permissions_json) as
    Record<string, unknown> | unknown[];
  return {
    key: text(row.role_key),
    name: text(row.role_key),
    label: text(row.name || row.role_key),
    permissions: Array.isArray(
      (permissions as Record<string, unknown>).permissions,
    )
      ? (permissions as Record<string, unknown>).permissions
      : Array.isArray(permissions)
        ? permissions
        : [],
    locations: Array.isArray((permissions as Record<string, unknown>).locations)
      ? (permissions as Record<string, unknown>).locations
      : ["all"],
    updatedAt: text(row.updated_at),
  };
}

const SYSTEM_ROLE_KEYS = new Set([
  "owner",
  "admin",
  "manager",
  "member",
  "storeman",
  "prep",
  "stocktaker",
  "stocktracker",
  "transfer_agent",
  "corporate_viewer",
]);

export async function getWorkspaceAccessRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await ensureMemberLocationsColumn(env);
  const [workspace, memberRows, roleRows, locationRows, adminUserRow] =
    await Promise.all([
      env.CENTRAL_DB.prepare(
        `SELECT owner_uid
         FROM workspaces
        WHERE id = ?1
        LIMIT 1`,
      )
        .bind(workspaceId)
        .first<{ owner_uid?: string }>(),
      env.CENTRAL_DB.prepare(
        `SELECT id, auth_uid, email, display_name, status, role_key, can_receive_low_stock_email, allowed_locations_json, created_at, updated_at
         FROM workspace_members
        WHERE workspace_id = ?1
          AND status != 'removed'
        ORDER BY lower(display_name), lower(email)`,
      )
        .bind(workspaceId)
        .all(),
      env.CENTRAL_DB.prepare(
        `SELECT role_key, name, permissions_json, updated_at
         FROM roles
        WHERE workspace_id = ?1
        ORDER BY lower(name)`,
      )
        .bind(workspaceId)
        .all(),
      env.DB.prepare(
        `SELECT id, name, display_name, kind, is_default
         FROM locations
        WHERE workspace_id = ?1
          AND active = 1
        ORDER BY lower(COALESCE(display_name, name))`,
      )
        .bind(workspaceId)
        .all(),
      env.CENTRAL_DB.prepare(
        `SELECT role_key FROM admin_users WHERE status = 'active' AND (auth_uid = ?1 OR lower(email) = lower(?2)) LIMIT 1`,
      )
        .bind(auth.uid, auth.email)
        .first<{ role_key?: string }>(),
    ]);

  const team = arrayValue(memberRows.results).map((row) =>
    normalizeMemberRow(objectValue(row)),
  );
  const memberRole = team.find(
    (member) =>
      text(member.uid) === auth.uid ||
      text(member.email).toLowerCase() === auth.email,
  )?.role;
  // True only when the user is a designated KCP super-user in admin_users — not just a workspace owner/admin.
  const currentIsKcpSuperUser = [
    "super",
    "super-user",
    "superuser",
    "root",
    "kcp-superuser",
    "kcp-super-user",
  ].includes(normalizeRoleKey(adminUserRow?.role_key));
  const currentRole = currentIsKcpSuperUser
    ? "superuser"
    : text(workspace?.owner_uid) === auth.uid
      ? "owner"
      : memberRole || "member";
  const actorRole = await getWorkspaceActorRole(env, auth, workspaceId);
  const customRoles = arrayValue(roleRows.results)
    .map((row) => normalizeRoleRow(objectValue(row)))
    .filter((role) => !SYSTEM_ROLE_KEYS.has(text(role.name)));
  return json(request, env, {
    ok: true,
    team,
    customRoles,
    locations: arrayValue(locationRows.results).map((row) => ({
      id: text((row as Record<string, unknown>).id),
      name: text((row as Record<string, unknown>).name),
      displayName: text(
        (row as Record<string, unknown>).display_name ||
          (row as Record<string, unknown>).name,
      ),
      kind: text((row as Record<string, unknown>).kind),
      type: text((row as Record<string, unknown>).kind),
      isDefault: Number((row as Record<string, unknown>).is_default || 0) === 1,
    })),
    superUsers: [],
    currentRole,
    currentIsKcpSuperUser,
    currentIsSuperUser: PERMISSION_MANAGER_ROLE_KEYS.has(actorRole),
  });
}

async function ensureMemberLocationsColumn(env: Env) {
  try {
    await env.CENTRAL_DB.prepare(
      `ALTER TABLE workspace_members ADD COLUMN allowed_locations_json TEXT DEFAULT NULL`,
    ).run();
  } catch {
    /* column already exists */
  }
  try {
    await env.CENTRAL_DB.prepare(
      `ALTER TABLE workspace_members ADD COLUMN can_access_external_transfers INTEGER NOT NULL DEFAULT 1`,
    ).run();
  } catch {
    /* column already exists */
  }
}

export async function postWorkspaceMemberRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await ensureMemberLocationsColumn(env);
  const payload = await readJson<Record<string, unknown>>(request);
  const email = text(payload.email).toLowerCase();
  const firstName = text(payload.firstName);
  const surname = text(payload.surname);
  const displayName = text(
    payload.name || `${firstName} ${surname}`.trim() || email,
  );
  const role = text(payload.role || "member", "member");
  if (isReservedHiddenRoleKey(role))
    return error(request, env, 403, "This role cannot be assigned.");
  const lowStockAlert =
    payload.lowStockAlert === true || payload.lowStockAlertTag === true;
  const canAccessExternalTransfers =
    payload.canAccessExternalTransfers !== false ? 1 : 0;
  const allowedLocationsJson =
    Array.isArray(payload.allowedLocations) && payload.allowedLocations.length
      ? JSON.stringify(
          payload.allowedLocations.map((v: unknown) => text(v)).filter(Boolean),
        )
      : null;
  if (!email) return error(request, env, 400, "Email is required.");
  if (!displayName) return error(request, env, 400, "Name is required.");
  const existing = await env.CENTRAL_DB.prepare(
    `SELECT role_key
       FROM workspace_members
      WHERE workspace_id = ?1
        AND lower(email) = lower(?2)
        AND status != 'removed'
      LIMIT 1`,
  )
    .bind(workspaceId, email)
    .first<{ role_key?: string }>();
  void existing;
  // Adding/inviting ANY workspace member (or changing a role) is a privileged action —
  // previously anyone could add a member at role 'member' and trigger invite emails.
  {
    const denied = await denyUnlessPermissionManager(
      request,
      env,
      auth,
      workspaceId,
    );
    if (denied) return denied;
  }
  const memberId = text(payload.id) || id("member");
  const now = nowIso();
  await env.CENTRAL_DB.prepare(
    `INSERT INTO workspace_members (id, workspace_id, email, display_name, status, role_key, can_receive_low_stock_email, can_access_external_transfers, allowed_locations_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?9, ?8, ?7, ?7)
     ON CONFLICT(workspace_id, email) DO UPDATE SET
       display_name = excluded.display_name,
       status = 'active',
       role_key = excluded.role_key,
       can_receive_low_stock_email = excluded.can_receive_low_stock_email,
       can_access_external_transfers = excluded.can_access_external_transfers,
       allowed_locations_json = excluded.allowed_locations_json,
       updated_at = excluded.updated_at`,
  )
    .bind(
      memberId,
      workspaceId,
      email,
      displayName,
      role,
      lowStockAlert ? 1 : 0,
      now,
      allowedLocationsJson,
      canAccessExternalTransfers,
    )
    .run();

  // Ensure the user has an app_users record and send a welcome / set-password email
  try {
    const existingUser = await env.CENTRAL_DB.prepare(
      `SELECT id, status FROM app_users WHERE lower(email) = lower(?1) LIMIT 1`,
    )
      .bind(email)
      .first<{ id: string; status: string }>();

    let userId = existingUser?.id;
    if (!userId) {
      userId = id("user");
      await env.CENTRAL_DB.prepare(
        `INSERT INTO app_users (id, email, display_name, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
      )
        .bind(userId, email, displayName, now)
        .run();
    }

    // Generate a password-reset token so they can set their first password
    const resetToken =
      crypto.randomUUID().replace(/-/g, "") +
      crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString(); // 48 hours
    await env.CENTRAL_DB.prepare(
      `INSERT INTO auth_reset_tokens (token, user_id, email, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    )
      .bind(resetToken, userId, email, expiresAt, now)
      .run();

    const emailConfig = await getEmailDeliveryConfig(env);
    const appUrl = text(
      emailConfig.appBaseUrl ||
        env.APP_BASE_URL ||
        "https://kcp-live.pages.dev",
    ).replace(/\/+$/, "");
    const setPasswordUrl = `${appUrl}?resetToken=${encodeURIComponent(resetToken)}`;
    const invitedByName = text(payload.invitedBy || auth.email || "");
    const workspaceName = text(payload.workspaceName || "your workspace");
    const recipientName = text(displayName || email.split("@")[0]);

    await sendEmail(env, emailConfig, {
      to: email,
      subject: `You've been added to ${workspaceName} on Kitchen Cost Pro`,
      text: [
        `Hi ${recipientName},`,
        "",
        `${invitedByName ? `${invitedByName} has` : "You have been"} added you to "${workspaceName}" on Kitchen Cost Pro.`,
        "",
        "To get started, click the link below to set your password:",
        "",
        setPasswordUrl,
        "",
        "This link is valid for 48 hours.",
        "",
        "If you were not expecting this invitation, you can safely ignore this email.",
        "",
        "— Kitchen Cost Pro",
      ].join("\n"),
    });
  } catch {
    // Don't fail the member creation if email delivery fails
  }

  return json(request, env, { ok: true, id: memberId });
}

export async function resendWorkspaceMemberInvite(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  memberId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const now = nowIso();

  const member = await env.CENTRAL_DB.prepare(
    `SELECT id, email, display_name, workspace_id FROM workspace_members WHERE id = ?1 AND workspace_id = ?2 LIMIT 1`,
  )
    .bind(memberId, workspaceId)
    .first<{
      id: string;
      email: string;
      display_name: string;
      workspace_id: string;
    }>();

  if (!member) return error(request, env, 404, "Member not found.");

  const email = text(member.email);
  const displayName = text(member.display_name || email.split("@")[0]);

  try {
    const existingUser = await env.CENTRAL_DB.prepare(
      `SELECT id FROM app_users WHERE lower(email) = lower(?1) LIMIT 1`,
    )
      .bind(email)
      .first<{ id: string }>();

    let userId = existingUser?.id;
    if (!userId) {
      userId = id("user");
      await env.CENTRAL_DB.prepare(
        `INSERT INTO app_users (id, email, display_name, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
      )
        .bind(userId, email, displayName, now)
        .run();
    }

    const resetToken =
      crypto.randomUUID().replace(/-/g, "") +
      crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString();
    await env.CENTRAL_DB.prepare(
      `INSERT INTO auth_reset_tokens (token, user_id, email, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    )
      .bind(resetToken, userId, email, expiresAt, now)
      .run();

    const emailConfig = await getEmailDeliveryConfig(env);
    const appUrl = text(
      emailConfig.appBaseUrl ||
        env.APP_BASE_URL ||
        "https://kcp-live.pages.dev",
    ).replace(/\/+$/, "");
    const setPasswordUrl = `${appUrl}?resetToken=${encodeURIComponent(resetToken)}`;
    const workspace = await env.CENTRAL_DB.prepare(
      `SELECT name FROM workspaces WHERE id = ?1 LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ name: string }>();
    const workspaceName = text(workspace?.name || "your workspace");

    await sendEmail(env, emailConfig, {
      to: email,
      subject: `Your invitation to ${workspaceName} on Kitchen Cost Pro`,
      text: [
        `Hi ${displayName},`,
        "",
        `This is a reminder that you have been invited to "${workspaceName}" on Kitchen Cost Pro.`,
        "",
        "Click the link below to set your password and get started:",
        "",
        setPasswordUrl,
        "",
        "This link is valid for 48 hours.",
        "",
        "If you were not expecting this invitation, you can safely ignore this email.",
        "",
        "— Kitchen Cost Pro",
      ].join("\n"),
    });
  } catch {
    // Don't fail if email delivery fails
  }

  return json(request, env, { ok: true });
}

export async function patchWorkspaceMemberRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  memberId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await ensureMemberLocationsColumn(env);
  const payload = await readJson<Record<string, unknown>>(request);
  const existing = await env.CENTRAL_DB.prepare(
    `SELECT role_key
       FROM workspace_members
      WHERE workspace_id = ?1
        AND id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, memberId)
    .first<{ role_key?: string }>();
  if (!existing) return error(request, env, 404, "Workspace member not found.");
  // A hidden super-user member cannot be edited through the normal member route.
  if (isReservedHiddenRoleKey(existing.role_key))
    return error(request, env, 403, "This member cannot be modified.");
  const email = text(payload.email).toLowerCase();
  const firstName = text(payload.firstName);
  const surname = text(payload.surname);
  const displayName = text(
    payload.name || `${firstName} ${surname}`.trim() || email,
  );
  const role =
    payload.role === undefined
      ? text(existing.role_key || "member", "member")
      : text(payload.role || "member", "member");
  if (isReservedHiddenRoleKey(role))
    return error(request, env, 403, "This role cannot be assigned.");
  const lowStockAlert =
    payload.lowStockAlert === true || payload.lowStockAlertTag === true;
  const canAccessExternalTransfers =
    payload.canAccessExternalTransfers === undefined
      ? null
      : payload.canAccessExternalTransfers !== false
        ? 1
        : 0;
  const allowedLocationsJson =
    Array.isArray(payload.allowedLocations) && payload.allowedLocations.length
      ? JSON.stringify(
          payload.allowedLocations.map((v: unknown) => text(v)).filter(Boolean),
        )
      : payload.allowedLocations === null ||
          (Array.isArray(payload.allowedLocations) &&
            !payload.allowedLocations.length)
        ? null
        : undefined;
  // Editing ANY member field (role, allowed locations, external-transfer access, email,
  // display name, low-stock tag) is a privileged action. Previously the permission check
  // only fired on role changes, letting a member widen their own location scope or rewrite
  // another member's email (IDOR / privilege escalation).
  {
    const denied = await denyUnlessPermissionManager(
      request,
      env,
      auth,
      workspaceId,
    );
    if (denied) return denied;
  }
  await env.CENTRAL_DB.prepare(
    `UPDATE workspace_members
        SET email = ?3,
            display_name = ?4,
            role_key = ?5,
            can_receive_low_stock_email = ?6,
            can_access_external_transfers = COALESCE(?9, can_access_external_transfers),
            allowed_locations_json = COALESCE(?8, allowed_locations_json),
            updated_at = ?7
      WHERE workspace_id = ?1
        AND id = ?2`,
  )
    .bind(
      workspaceId,
      memberId,
      email,
      displayName,
      role,
      lowStockAlert ? 1 : 0,
      nowIso(),
      allowedLocationsJson ?? null,
      canAccessExternalTransfers,
    )
    .run();
  return json(request, env, { ok: true });
}

export async function deleteWorkspaceMemberRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  memberId: string,
) {
  await scoped(request, env, auth, workspaceId);
  // Removing a member is privileged — previously ANY member could remove the owner/admins.
  const denied = await denyUnlessPermissionManager(
    request,
    env,
    auth,
    workspaceId,
  );
  if (denied) return denied;
  const targetMember = await env.CENTRAL_DB.prepare(
    `SELECT role_key FROM workspace_members WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`,
  )
    .bind(workspaceId, memberId)
    .first<{ role_key?: string }>();
  if (isReservedHiddenRoleKey(targetMember?.role_key))
    return error(request, env, 403, "This member cannot be removed.");
  await env.CENTRAL_DB.prepare(
    `UPDATE workspace_members
        SET status = 'removed',
            updated_at = ?3
      WHERE workspace_id = ?1
        AND id = ?2`,
  )
    .bind(workspaceId, memberId, nowIso())
    .run();
  return json(request, env, { ok: true });
}

export async function postWorkspaceRoleRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const denied = await denyUnlessPermissionManager(
    request,
    env,
    auth,
    workspaceId,
  );
  if (denied) return denied;
  const payload = await readJson<Record<string, unknown>>(request);
  const roleKey = text(payload.name || payload.roleKey)
    .toLowerCase()
    .replace(/\s+/g, "-");
  const label = text(payload.label || payload.name || roleKey);
  if (!roleKey) return error(request, env, 400, "Role name is required.");
  if (isReservedHiddenRoleKey(roleKey))
    return error(
      request,
      env,
      403,
      "This role is reserved and cannot be modified.",
    );
  const permissionsJson = JSON.stringify({
    permissions: Array.isArray(payload.permissions)
      ? payload.permissions.filter(Boolean)
      : [],
    locations:
      Array.isArray(payload.locations) && payload.locations.length
        ? payload.locations
        : ["all"],
  });
  await env.CENTRAL_DB.prepare(
    `INSERT INTO roles (id, workspace_id, role_key, name, permissions_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(workspace_id, role_key) DO UPDATE SET
       name = excluded.name,
       permissions_json = excluded.permissions_json,
       updated_at = excluded.updated_at`,
  )
    .bind(id("role"), workspaceId, roleKey, label, permissionsJson, nowIso())
    .run();
  return json(request, env, { ok: true, role: { name: roleKey, label } });
}

export async function deleteWorkspaceRoleRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  roleName: string,
) {
  await scoped(request, env, auth, workspaceId);
  const denied = await denyUnlessPermissionManager(
    request,
    env,
    auth,
    workspaceId,
  );
  if (denied) return denied;
  const roleKey = text(roleName).toLowerCase();
  if (isReservedHiddenRoleKey(roleKey))
    return error(
      request,
      env,
      403,
      "This role is reserved and cannot be modified.",
    );
  await env.CENTRAL_DB.prepare(
    `DELETE FROM roles
      WHERE workspace_id = ?1
        AND role_key = ?2`,
  )
    .bind(workspaceId, roleKey)
    .run();
  return json(request, env, { ok: true });
}

export async function getLinkedTransferProfiles(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const sourceSettings = await env.DB.prepare(
    `SELECT raw_json
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json: string }>();

  const sourceProfile = objectValue(jsonParse(sourceSettings?.raw_json));
  let linkedIds = linkedWorkspaceIds(sourceProfile);

  // If linkedSites is empty but an org/corp group id exists, discover peers dynamically.
  // This handles cases where the admin portal set the orgId but didn't populate linkedSites.
  if (!linkedIds.length) {
    const orgId = text(sourceProfile.orgId || sourceProfile.org_id);
    const corpId = text(sourceProfile.corpId || sourceProfile.corp_id);
    if (orgId || corpId) {
      // org/corp grouping is promoted to the central workspaces registry (was a cross-workspace
      // json_extract scan of workspace_settings, impossible per-DO).
      const rows = await env.CENTRAL_DB.prepare(
        `SELECT id AS workspace_id FROM workspaces
          WHERE id != ?1 AND status = 'active'
            AND (
              (org_id = ?2 AND ?2 != '')
              OR (corp_id = ?3 AND ?3 != '')
            )`,
      )
        .bind(workspaceId, orgId || "", corpId || "")
        .all<{ workspace_id: string }>();
      linkedIds = (rows.results || [])
        .map((r) => r.workspace_id)
        .filter(Boolean);
    }
  }

  if (!linkedIds.length) {
    return json(request, env, { ok: true, linkedProfiles: [] });
  }

  const profiles = [];
  for (const linkedId of linkedIds) {
    const profile = await buildLinkedTransferProfile(
      env,
      sourceProfile,
      linkedId,
    );
    profiles.push(profile);
  }

  return json(request, env, {
    ok: true,
    linkedProfiles: profiles,
    source: "cloudflare-d1",
  });
}

export async function getStockItems(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-ingredients");
  const url = new URL(request.url);
  const limit = limitFromUrl(url, 50, 200);
  const offset = offsetFromUrl(url);
  const search = `%${getParam(url, "search")}%`;
  const category = getParam(url, "category");
  const itemType = getParam(url, "itemType");
  let locationId = getParam(url, "locationId");
  const allowedLocationIds = await getUserAllowedLocationIds(
    env,
    auth,
    workspaceId,
  );
  if (allowedLocationIds !== null) {
    if (!locationId && allowedLocationIds.length === 1)
      locationId = allowedLocationIds[0];
    if (!locationId)
      throw new Error(
        "Permission denied: select one of your assigned locations to view stock.",
      );
    await assertLocationAccess(
      env,
      auth,
      workspaceId,
      locationId,
      "stock_items_read",
    );
  }

  const filters = ["si.workspace_id = ?1", "si.active = 1"];
  const binds: unknown[] = [workspaceId];

  if (search !== "%%") {
    binds.push(search);
    filters.push(
      `(si.name LIKE ?${binds.length} OR si.category LIKE ?${binds.length} OR si.barcode_csv LIKE ?${binds.length} OR COALESCE(json_extract(si.raw_json, '$.sku'), '') LIKE ?${binds.length} OR COALESCE(json_extract(si.raw_json, '$.customSku'), '') LIKE ?${binds.length} OR COALESCE(json_extract(si.raw_json, '$.stockCode'), '') LIKE ?${binds.length} OR COALESCE(json_extract(si.raw_json, '$.itemCode'), '') LIKE ?${binds.length})`,
    );
  }
  if (category) {
    binds.push(category);
    filters.push(`si.category = ?${binds.length}`);
  }
  if (itemType) {
    binds.push(itemType);
    filters.push(`si.item_type = ?${binds.length}`);
  }

  const locationSelect = locationId
    ? `COALESCE((SELECT quantity FROM stock_balances sb WHERE sb.workspace_id = si.workspace_id AND sb.stock_item_id = si.id AND sb.location_id = ?${binds.length + 1}), 0)`
    : `COALESCE((SELECT SUM(quantity) FROM stock_balances sb WHERE sb.workspace_id = si.workspace_id AND sb.stock_item_id = si.id), 0)`;
  if (locationId) binds.push(locationId);

  binds.push(limit, offset);
  const limitIndex = binds.length - 1;
  const offsetIndex = binds.length;

  const rows = await env.DB.prepare(
    `SELECT
        si.id,
        si.name,
        si.category,
	        si.item_type,
	        si.is_stocked,
	        si.unit,
        si.unit_cost,
        si.vat_enabled,
        si.threshold_qty,
        si.par_level_qty,
        si.yield_pct,
        si.batch_yield,
        si.barcode_csv,
        si.raw_json,
        ${locationSelect} AS on_hand,
        COALESCE((
	          SELECT json_group_object(sb.location_id, sb.quantity)
	            FROM stock_balances sb
	           WHERE sb.workspace_id = si.workspace_id
	             AND sb.stock_item_id = si.id
                 ${locationId ? `AND sb.location_id = ?${binds.indexOf(locationId) + 1}` : ""}
	        ), '{}') AS balances_json,
        COALESCE((
          SELECT json_group_object(silp.location_id, silp.price)
            FROM stock_item_location_prices silp
           WHERE silp.workspace_id = si.workspace_id
             AND silp.stock_item_id = si.id
             ${locationId ? `AND silp.location_id = ?${binds.indexOf(locationId) + 1}` : ""}
        ), '{}') AS location_costs_json
       FROM stock_items si
      WHERE ${filters.join(" AND ")}
      ORDER BY si.name ASC
      LIMIT ?${limitIndex} OFFSET ?${offsetIndex}`,
  )
    .bind(...binds)
    .all();

  const stockItems = (rows.results || []) as Record<string, unknown>[];
  const stockItemIds = stockItems.map((row) => text(row.id)).filter(Boolean);
  if (stockItemIds.length) {
    const idPlaceholders = stockItemIds
      .map((_, index) => `?${index + 2}`)
      .join(", ");
    const recipeRows = await env.DB.prepare(
      `SELECT id, owner_id, yield_qty, yield_unit
         FROM recipes
        WHERE workspace_id = ?1
          AND owner_type = 'stock_item'
          AND active = 1
          AND owner_id IN (${idPlaceholders})`,
    )
      .bind(workspaceId, ...stockItemIds)
      .all<Record<string, unknown>>();
    const recipes = (recipeRows.results || []) as Record<string, unknown>[];
    const recipeIds = recipes.map((recipe) => text(recipe.id)).filter(Boolean);
    const linesByRecipe = new Map<string, Record<string, unknown>[]>();
    if (recipeIds.length) {
      const recipePlaceholders = recipeIds
        .map((_, index) => `?${index + 2}`)
        .join(", ");
      const lineRows = await env.DB.prepare(
        `SELECT recipe_id, stock_item_id, quantity, unit, sort_order
           FROM recipe_lines
          WHERE workspace_id = ?1
            AND recipe_id IN (${recipePlaceholders})
          ORDER BY sort_order ASC`,
      )
        .bind(workspaceId, ...recipeIds)
        .all<Record<string, unknown>>();
      ((lineRows.results || []) as Record<string, unknown>[]).forEach(
        (line) => {
          const recipeId = text(line.recipe_id);
          const current = linesByRecipe.get(recipeId) || [];
          current.push(line);
          linesByRecipe.set(recipeId, current);
        },
      );
    }

    const recipeByStockItem = new Map<string, Record<string, unknown>>();
    recipes.forEach((recipe) => {
      recipeByStockItem.set(text(recipe.owner_id), recipe);
    });

    stockItems.forEach((row) => {
      const recipe = recipeByStockItem.get(text(row.id));
      if (!recipe) return;
      const recipeLines = (linesByRecipe.get(text(recipe.id)) || [])
        .map((line) => ({
          ingId: text(line.stock_item_id),
          stockItemId: text(line.stock_item_id),
          qty: numberValue(line.quantity, 0),
          quantity: numberValue(line.quantity, 0),
          unit: text(line.unit || recipe.yield_unit || row.unit, "ea"),
        }))
        .filter((line) => line.ingId && line.qty > 0);
      const raw = objectValue(jsonParse(row.raw_json));
      row.raw_json = JSON.stringify({
        ...raw,
        recipe: recipeLines.length ? recipeLines : arrayValue(raw.recipe),
        yieldBatch: numberValue(
          recipe.yield_qty,
          numberValue(row.batch_yield, 1),
        ),
        yieldQty: numberValue(
          recipe.yield_qty,
          numberValue(row.batch_yield, 1),
        ),
        unit: text(row.unit || raw.unit || recipe.yield_unit, "ea"),
      });
      row.batch_yield = numberValue(
        recipe.yield_qty,
        numberValue(row.batch_yield, 1),
      );
    });
  }

  stockItems.forEach((row) => {
    const raw = objectValue(jsonParse(row.raw_json));
    const sku = resolveStockSku(
      row.name,
      raw.sku,
      raw.SKU,
      raw.skuCode,
      raw.stockCode,
      raw.itemCode,
      raw.customSku,
      raw.code,
    );
    row.raw_json = JSON.stringify({ ...raw, sku, customSku: sku });
  });

  return json(request, env, {
    ok: true,
    stockItems,
    page: { limit, offset },
  });
}

export async function getProducts(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const url = new URL(request.url);
  const limit = limitFromUrl(url, 100, 500);
  const offset = offsetFromUrl(url);
  const search = `%${getParam(url, "search")}%`;
  const category = getParam(url, "category");
  const binds: unknown[] = [workspaceId];
  const filters = [
    "workspace_id = ?1",
    "active = 1",
    "id NOT LIKE 'modifier:%'",
    "category NOT LIKE 'Modifier -%'",
  ];

  if (search !== "%%") {
    binds.push(search);
    filters.push(
      `(name LIKE ?${binds.length} OR category LIKE ?${binds.length} OR sku LIKE ?${binds.length})`,
    );
  }
  if (category) {
    binds.push(category);
    filters.push(`category = ?${binds.length}`);
  }

  binds.push(limit, offset);
  const limitIndex = binds.length - 1;
  const offsetIndex = binds.length;

  const [
    productRows,
    priceRows,
    recipeRows,
    lineRows,
    stockRows,
    modifierGroupRows,
    allProductRows,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT id, legacy_source_id, name, sku, category, price, active, external_provider,
	              yoco_item_id, yoco_variant_id, yoco_category_id, yoco_category_name,
	              recipe_source_stock_item_id, missing_recipe, raw_json, updated_at
	         FROM products
        WHERE ${filters.join(" AND ")}
        ORDER BY lower(category) ASC, lower(name) ASC
        LIMIT ?${limitIndex} OFFSET ?${offsetIndex}`,
    )
      .bind(...binds)
      .all(),
    env.DB.prepare(
      `SELECT product_id, location_id, price, updated_at
         FROM product_location_prices
        WHERE workspace_id = ?1`,
    )
      .bind(workspaceId)
      .all(),
    env.DB.prepare(
      `SELECT id, owner_type, owner_id, linked_product_id, yield_qty, yield_unit
	         FROM recipes
	        WHERE workspace_id = ?1
	          AND owner_type IN ('product', 'yoco_modifier', 'stock_item')
	          AND active = 1`,
    )
      .bind(workspaceId)
      .all(),
    env.DB.prepare(
      `SELECT rl.recipe_id, rl.stock_item_id, rl.quantity, rl.unit, rl.sort_order
         FROM recipe_lines rl
        WHERE rl.workspace_id = ?1
        ORDER BY rl.sort_order ASC`,
    )
      .bind(workspaceId)
      .all(),
    env.DB.prepare(
      `SELECT id, name, category, item_type, is_stocked, unit, unit_cost, raw_json
	         FROM stock_items
	        WHERE workspace_id = ?1`,
    )
      .bind(workspaceId)
      .all(),
    env.DB.prepare(
      `SELECT id, yoco_modifier_group_id, name, raw_json
         FROM yoco_modifier_groups
        WHERE workspace_id = ?1`,
    )
      .bind(workspaceId)
      .all(),
    env.DB.prepare(
      `SELECT id, name, price, yoco_item_id, yoco_variant_id, raw_json
         FROM products
        WHERE workspace_id = ?1
          AND active = 1
          AND id NOT LIKE 'modifier:%'
          AND category NOT LIKE 'Modifier -%'`,
    )
      .bind(workspaceId)
      .all(),
  ]);

  const pricesByProduct = new Map<
    string,
    Record<string, { sellingPrice: number; updatedAt: string }>
  >();
  arrayValue(priceRows.results).forEach((entry) => {
    const row = objectValue(entry);
    const productId = text(row.product_id);
    const locationId = text(row.location_id);
    if (!productId || !locationId) return;
    const current = pricesByProduct.get(productId) || {};
    current[locationId] = {
      sellingPrice: numberValue(row.price, 0),
      updatedAt: text(row.updated_at),
    };
    pricesByProduct.set(productId, current);
  });

  const recipeByProduct = new Map<string, Record<string, unknown>>();
  const recipeByStockItem = new Map<string, Record<string, unknown>>();
  const recipeByOwner = new Map<string, Record<string, unknown>>();
  arrayValue(recipeRows.results).forEach((entry) => {
    const row = objectValue(entry);
    const ownerType = text(row.owner_type);
    const ownerId = text(row.owner_id);
    recipeByOwner.set(`${ownerType}:${ownerId}`, row);
    if (ownerType === "product") recipeByProduct.set(ownerId, row);
    if (ownerType === "stock_item") recipeByStockItem.set(ownerId, row);
  });

  const linesByRecipe = new Map<string, Array<Record<string, unknown>>>();
  arrayValue(lineRows.results).forEach((entry) => {
    const row = objectValue(entry);
    const recipeId = text(row.recipe_id);
    if (!recipeId) return;
    const current = linesByRecipe.get(recipeId) || [];
    current.push(row);
    linesByRecipe.set(recipeId, current);
  });

  const stockUnitCosts = new Map<string, number>();
  const stockItemsById = new Map<string, Record<string, unknown>>();
  arrayValue(stockRows.results).forEach((entry) => {
    const row = objectValue(entry);
    const stockItemId = text(row.id);
    if (stockItemId)
      stockUnitCosts.set(stockItemId, numberValue(row.unit_cost, 0));
    if (stockItemId) stockItemsById.set(stockItemId, row);
  });

  const allProductsByVariant = new Map<string, Record<string, unknown>>();
  const allProductsByYocoItem = new Map<string, Record<string, unknown>[]>();
  arrayValue(allProductRows.results).forEach((entry) => {
    const row = objectValue(entry);
    productVariantAliases(row).forEach((variantId) => {
      if (variantId && !allProductsByVariant.has(variantId))
        allProductsByVariant.set(variantId, row);
    });
    const itemId = text(row.yoco_item_id);
    if (itemId)
      allProductsByYocoItem.set(itemId, [
        ...(allProductsByYocoItem.get(itemId) || []),
        row,
      ]);
  });

  const modifierGroupsById = new Map<string, Record<string, unknown>>();
  arrayValue(modifierGroupRows.results).forEach((entry) => {
    const row = objectValue(entry);
    const raw = objectValue(jsonParse(row.raw_json));
    const groupId = text(row.yoco_modifier_group_id || raw.id || row.id);
    if (groupId) modifierGroupsById.set(groupId, { ...row, raw });
  });

  const products = arrayValue(productRows.results).map((entry) => {
    const row = objectValue(entry);
    const raw = objectValue(jsonParse(row.raw_json));
    const yocoItem = objectValue(raw.item || raw.yocoItem);
    const yocoVariant = objectValue(raw.variant || raw.yocoVariant);
    const productId = text(row.id);
    const yocoItemId = text(row.yoco_item_id || raw.yocoItemId);
    const siblingItemName = inferYocoItemNameFromSiblings(
      allProductsByYocoItem.get(yocoItemId) || [],
    );
    const yocoItemName = text(
      raw.yocoItemName || yocoItem.name || siblingItemName,
    );
    const inferredVariantName = inferVariantNameFromProductName(
      text(row.name || raw.name || raw.productName),
      yocoItemName,
    );
    const yocoVariantName = text(yocoVariantDisplay(raw));
    const yocoOptionSummary = text(
      raw.yocoOptionSummary ||
        selectedYocoOptionSummary(yocoVariant) ||
        inferredVariantName ||
        yocoVariantName,
    );
    const recipe = recipeByProduct.get(productId);
    const recipeLines = recipe
      ? (linesByRecipe.get(text(recipe.id)) || []).map((line) => ({
          ingId: text(line.stock_item_id),
          stockItemId: text(line.stock_item_id),
          qty: numberValue(line.quantity, 0),
          quantity: numberValue(line.quantity, 0),
          unit: text(line.unit, "ea") || "ea",
        }))
      : [];
    const recipeSourceStockItemId = text(
      row.recipe_source_stock_item_id ||
        raw.recipeSourceStockItemId ||
        raw.recipe_source_stock_item_id,
    );
    const recipeSourceStockItem = recipeSourceStockItemId
      ? stockItemsById.get(recipeSourceStockItemId) || null
      : null;
    const recipeSourceRecipe = recipeSourceStockItemId
      ? recipeByStockItem.get(recipeSourceStockItemId) || null
      : null;
    const recipeSourceRecipeLines = recipeSourceRecipe
      ? (linesByRecipe.get(text(recipeSourceRecipe.id)) || []).map((line) => ({
          ingId: text(line.stock_item_id),
          stockItemId: text(line.stock_item_id),
          qty: numberValue(line.quantity, 0),
          quantity: numberValue(line.quantity, 0),
          unit:
            text(
              line.unit ||
                recipeSourceRecipe.yield_unit ||
                recipeSourceStockItem?.unit,
              "ea",
            ) || "ea",
        }))
      : [];
    const effectiveRecipeLines = recipeLines.length
      ? recipeLines
      : recipeSourceRecipeLines;
    const recipeStatus = recipeLines.length
      ? "COMPLETE"
      : recipeSourceRecipeLines.length
        ? "COMPLETE_VIA_LINKED_STOCK_ITEM"
        : "MISSING_RECIPE";
    const normalizedRecipeSourceStockItem = recipeSourceStockItem
      ? {
          id: text(recipeSourceStockItem.id),
          name: text(recipeSourceStockItem.name),
          category: text(recipeSourceStockItem.category, "General"),
          itemType: text(recipeSourceStockItem.item_type),
          isStocked: stockItemIsStocked(recipeSourceStockItem),
          unit: text(recipeSourceStockItem.unit, "ea"),
          recipe: recipeSourceRecipeLines,
          recipeLines: recipeSourceRecipeLines,
          recipeCount: recipeSourceRecipeLines.length,
        }
      : null;
    const modifierSummary = buildProductModifierSummary({
      raw,
      sellingPrice: numberValue(row.price ?? raw.sellingPrice ?? raw.price, 0),
      modifierGroupsById,
      allProductsByVariant,
      recipeByOwner,
      linesByRecipe,
      stockUnitCosts,
      baseRecipeCost: recipeCostForLines(effectiveRecipeLines, stockUnitCosts),
      hasBaseRecipe: effectiveRecipeLines.length > 0,
    });

    return {
      ...raw,
      id: productId,
      legacySourceId: text(row.legacy_source_id),
      workspaceId,
      source: "cloudflare-d1:products",
      name: text(row.name || raw.name || raw.productName || productId),
      category: text(row.category || raw.category, "General") || "General",
      sellingPrice: numberValue(row.price ?? raw.sellingPrice ?? raw.price, 0),
      price: numberValue(row.price ?? raw.price ?? raw.sellingPrice, 0),
      sku: text(row.sku || raw.sku),
      customSku: text(raw.customSku || row.sku),
      barcode: text(raw.barcode),
      barcodes: arrayValue(raw.barcodes)
        .map((barcode) => text(barcode))
        .filter(Boolean),
      yocoItemId,
      yocoVariantId: text(row.yoco_variant_id || raw.yocoVariantId),
      yocoItemName,
      yocoVariantName: yocoVariantName || inferredVariantName,
      yocoOptionSummary,
      yocoHasMultipleVariants: yocoHasMultipleVariants(raw),
      yocoCategoryId: text(row.yoco_category_id || raw.yocoCategoryId),
      yocoCategoryName: text(row.yoco_category_name || raw.yocoCategoryName),
      yocoBrandId: text(raw.yocoBrandId || yocoItem.brand_id),
      yocoBrandName: text(
        raw.yocoBrandName || objectValue(yocoItem.brand).name,
      ),
      externalProvider: text(row.external_provider || raw.externalProvider),
      locationPrices:
        pricesByProduct.get(productId) || objectValue(raw.locationPrices),
      recipe: recipeLines,
      recipeLines,
      directRecipe: recipeLines,
      directRecipeCount: recipeLines.length,
      effectiveRecipe: effectiveRecipeLines,
      effectiveRecipeLines,
      recipeCount: effectiveRecipeLines.length,
      recipeStatus,
      recipeSource:
        recipeStatus === "COMPLETE_VIA_LINKED_STOCK_ITEM"
          ? "linked_stock_item"
          : recipeLines.length
            ? "direct"
            : "missing",
      recipeSourceStockItemId,
      recipeSourceStockItem: normalizedRecipeSourceStockItem,
      recipeSourceStockItemName: normalizedRecipeSourceStockItem?.name || "",
      recipeSourceStockItemRecipeCount: recipeSourceRecipeLines.length,
      recipeSourceRecipeLines,
      modifierGroups: modifierSummary.groups,
      modifierGroupCount: modifierSummary.groups.length,
      modifierCount: modifierSummary.modifierCount,
      combinedGpMin: modifierSummary.gpMin,
      combinedGpMax: modifierSummary.gpMax,
      combinedGpDisplay: modifierSummary.gpDisplay,
      status: effectiveRecipeLines.length ? "complete" : "missing",
      missingRecipe: effectiveRecipeLines.length === 0,
      active: row.active !== 0,
      archived: false,
      deleted: false,
      catalogueStatus: "active",
      updatedAt: text(row.updated_at || raw.updatedAt),
    };
  });

  return json(request, env, {
    ok: true,
    products,
    items: products,
    page: { limit, offset },
  });
}

function recipeCostForLines(
  lines: Array<Record<string, unknown>>,
  stockUnitCosts: Map<string, number>,
) {
  return lines.reduce((total, line) => {
    const stockItemId = text(
      line.stockItemId || line.stock_item_id || line.ingId,
    );
    const quantity = numberValue(line.quantity ?? line.qty, 0);
    return total + quantity * numberValue(stockUnitCosts.get(stockItemId), 0);
  }, 0);
}

function modifierGroupProductOptions(rawGroup: Record<string, unknown>) {
  return arrayValue(
    rawGroup.modifiers ||
      rawGroup.modifier_items ||
      rawGroup.modifierItems ||
      rawGroup.modifier_options ||
      rawGroup.modifierOptions ||
      rawGroup.options ||
      rawGroup.items ||
      rawGroup.values,
  )
    .map(objectValue)
    .filter((modifier) => {
      const type = rawModifierType(modifier);
      const variantId = rawModifierVariantId(modifier);
      return (
        (!type || type === "product") &&
        Boolean(variantId || rawModifierId(modifier))
      );
    });
}

function buildProductModifierSummary({
  raw,
  sellingPrice,
  modifierGroupsById,
  allProductsByVariant,
  recipeByOwner,
  linesByRecipe,
  stockUnitCosts,
  baseRecipeCost,
  hasBaseRecipe,
}: {
  raw: Record<string, unknown>;
  sellingPrice: number;
  modifierGroupsById: Map<string, Record<string, unknown>>;
  allProductsByVariant: Map<string, Record<string, unknown>>;
  recipeByOwner: Map<string, Record<string, unknown>>;
  linesByRecipe: Map<string, Array<Record<string, unknown>>>;
  stockUnitCosts: Map<string, number>;
  baseRecipeCost: number;
  hasBaseRecipe: boolean;
}) {
  const groupIds = productModifierGroupIds(raw);
  const groups: Array<Record<string, unknown>> = [];
  const gpValues: number[] = [];
  let modifierCount = 0;

  [...new Set(groupIds)].forEach((groupId) => {
    const groupRow = modifierGroupsById.get(groupId);
    if (!groupRow) {
      // Group not in DB — likely an option/choice reference rather than a product modifier group. Skip it.
      return;
    }

    const rawGroup = objectValue(groupRow.raw || jsonParse(groupRow.raw_json));
    const groupName = text(groupRow.name || rawGroup.name || groupId, groupId);
    const productOptions = modifierGroupProductOptions(rawGroup);
    const groupGpValues: number[] = [];
    modifierCount += productOptions.length;

    if (hasBaseRecipe)
      productOptions.forEach((modifier) => {
        const variantId = rawModifierVariantId(modifier);
        const linkedProduct = variantId
          ? findProductByModifierVariant(allProductsByVariant, variantId)
          : null;
        const linkedProductRecipe = linkedProduct
          ? recipeByOwner.get(`product:${text(linkedProduct.id)}`)
          : null;
        const modifierRecipe = yocoModifierRecipeOwnerIds(groupId, modifier)
          .map((ownerId) => recipeByOwner.get(`yoco_modifier:${ownerId}`))
          .find(Boolean);
        const recipe = linkedProductRecipe || modifierRecipe;
        if (!recipe) return;

        const recipeLines = linesByRecipe.get(text(recipe.id)) || [];
        const modifierCost = recipeCostForLines(recipeLines, stockUnitCosts);
        const modifierPrice = moneyToMajor(
          modifier.price || modifier.amount || modifier.default_price || 0,
        );
        const combinedPrice = sellingPrice + modifierPrice;
        if (combinedPrice <= 0) return;
        const gp =
          ((combinedPrice - baseRecipeCost - modifierCost) / combinedPrice) *
          100;
        if (Number.isFinite(gp)) {
          gpValues.push(gp);
          groupGpValues.push(gp);
        }
      });

    groups.push({
      id: groupId,
      name: groupName,
      modifierCount: productOptions.length,
      gpDisplay: formatGpRange(groupGpValues),
    });
  });

  return {
    groups,
    modifierCount,
    gpMin: gpValues.length ? Math.min(...gpValues) : null,
    gpMax: gpValues.length ? Math.max(...gpValues) : null,
    gpDisplay: formatGpRange(gpValues),
  };
}

function modifierGroupRefId(ref: unknown) {
  if (typeof ref === "string" || typeof ref === "number") return text(ref);
  const row = objectValue(ref);
  return text(
    row.id ||
      row.modifier_group_id ||
      row.modifierGroupId ||
      row.modifier_group ||
      row.modifierGroup ||
      row.group_id ||
      row.groupId ||
      row.external_id ||
      row.uuid,
  );
}

function modifierGroupRefsFromRow(row: Record<string, unknown>) {
  const refs: unknown[] = [];
  [
    row.yocoModifierGroupIds,
    row.modifierGroupIds,
    row.modifier_group_ids,
    row.modifierGroupId,
    row.modifier_groups,
    row.modifierGroups,
    row.assigned_modifier_groups,
    row.assignedModifierGroups,
  ].forEach((value) => {
    if (Array.isArray(value)) refs.push(...value);
    else if (value && typeof value === "object")
      refs.push(...Object.values(value as Record<string, unknown>));
    else if (value !== undefined && value !== null) refs.push(value);
  });
  return refs;
}

function productModifierGroupIds(raw: Record<string, unknown>) {
  const rawItem = objectValue(raw.item || raw.yocoItem);
  const rawVariant = objectValue(raw.variant || raw.yocoVariant);
  const variantId = text(
    raw.yocoVariantId ||
      rawVariant.id ||
      rawVariant.variant_id ||
      rawVariant.variantId,
  );
  const refs = [
    ...modifierGroupRefsFromRow(raw),
    ...modifierGroupRefsFromRow(rawItem),
    ...modifierGroupRefsFromRow(rawVariant),
  ];

  arrayValue(rawItem.variants || rawItem.item_variants || rawItem.itemVariants)
    .map(objectValue)
    .filter((variant) => {
      if (!variantId) return false;
      const ids = [
        text(variant.id),
        text(variant.variant_id),
        text(variant.variantId),
      ].filter(Boolean);
      return ids.some(
        (idValue) => idValue === variantId || variantId.endsWith(`:${idValue}`),
      );
    })
    .forEach((variant) => refs.push(...modifierGroupRefsFromRow(variant)));

  return [...new Set(refs.map(modifierGroupRefId).filter(Boolean))];
}

function formatGpRange(values: number[]) {
  const normalized = values.filter((value) => Number.isFinite(value));
  if (!normalized.length) return "";
  const min = Math.min(...normalized);
  const max = Math.max(...normalized);
  const format = (value: number) => `${value.toFixed(1)}%`;
  return Math.abs(max - min) < 0.05
    ? format(min)
    : `${format(min)}-${format(max)}`;
}

export async function postProduct(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const productId = await saveProductRecord(
    env,
    auth,
    workspaceId,
    objectValue(payload.product || payload.item || payload),
  );
  return json(request, env, { ok: true, id: productId });
}

export async function patchProduct(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  productId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const existing = await env.DB.prepare(
    `SELECT id, legacy_source_id, name, sku, category, price, active, external_provider,
            yoco_item_id, yoco_variant_id, yoco_category_id, yoco_category_name,
            raw_json
       FROM products
      WHERE workspace_id = ?1
        AND id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, routeText(productId))
    .first<Record<string, unknown>>();
  const existingRaw = objectValue(jsonParse(existing?.raw_json));
  const savedId = await saveProductRecord(env, auth, workspaceId, {
    ...existingRaw,
    legacySourceId: text(
      existing?.legacy_source_id || existingRaw.legacySourceId,
    ),
    name: text(existing?.name || existingRaw.name),
    sku: text(existing?.sku || existingRaw.sku || existingRaw.customSku),
    category:
      text(existing?.category || existingRaw.category, "General") || "General",
    sellingPrice: numberValue(
      existing?.price ?? existingRaw.sellingPrice ?? existingRaw.price,
      0,
    ),
    price: numberValue(
      existing?.price ?? existingRaw.price ?? existingRaw.sellingPrice,
      0,
    ),
    active: existing?.active === 0 ? false : existingRaw.active,
    externalProvider: text(
      existing?.external_provider || existingRaw.externalProvider,
    ),
    yocoItemId: text(existing?.yoco_item_id || existingRaw.yocoItemId),
    yocoVariantId: text(existing?.yoco_variant_id || existingRaw.yocoVariantId),
    yocoCategoryId: text(
      existing?.yoco_category_id || existingRaw.yocoCategoryId,
    ),
    yocoCategoryName: text(
      existing?.yoco_category_name || existingRaw.yocoCategoryName,
    ),
    ...objectValue(payload.product || payload.item || payload),
    id: routeText(productId),
  });
  return json(request, env, { ok: true, id: savedId });
}

export async function deleteProductRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  productId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const idValue = routeText(productId);
  if (!idValue) return error(request, env, 400, "Menu item id is required.");
  const now = nowIso();
  const target = await env.DB.prepare(
    `SELECT id, name, category, sku, price, active, raw_json
       FROM products
      WHERE workspace_id = ?1
        AND id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, idValue)
    .first<Record<string, unknown>>();
  if (!target) return error(request, env, 404, "Menu item was not found.");
  const before = productAuditSnapshot(target);
  const after = { ...before, active: false, deletedAt: now };
  const key = duplicateProductKey(target);
  const duplicateWhere = key.name
    ? ` AND (
        id = ?3
        OR (lower(trim(name)) = ?4 AND lower(trim(category)) = ?5)
      )`
    : ` AND id = ?3`;
  const duplicateBinds = key.name
    ? [idValue, key.name, key.category]
    : [idValue];
  const result = await env.DB.prepare(
    `UPDATE products
        SET active = 0,
            updated_at = ?1
      WHERE workspace_id = ?2
        AND active = 1
        ${duplicateWhere}`,
  )
    .bind(now, workspaceId, ...duplicateBinds)
    .run();
  const deletedCount = Number(result.meta.changes || 0);
  if (!deletedCount)
    return error(
      request,
      env,
      404,
      "Menu item was not found or was already deleted.",
    );
  await env.DB.prepare(
    `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, before_json, after_json, created_at)
     VALUES (?1, ?2, ?3, 'product_deleted', 'product', ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id("audit"),
      workspaceId,
      auth.uid,
      idValue,
      JSON.stringify(before),
      JSON.stringify(after),
      now,
    )
    .run();
  return json(request, env, { ok: true, id: idValue, deletedCount });
}

export async function postProductImport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const rows = arrayValue(payload.rows || payload.products || payload.items);
  let importedCount = 0;
  const errors: Array<{ code: string; message: string }> = [];

  for (const row of rows) {
    try {
      const raw = objectValue(row);
      if (isImportTemplateExampleRow(raw)) continue;
      if (!text(raw.name || raw.productName || raw.title)) {
        errors.push({
          code: "ERR_MISSING_REQ",
          message: "Menu item name is required.",
        });
        continue;
      }
      await saveProductRecord(env, auth, workspaceId, raw);
      importedCount += 1;
    } catch (cause) {
      errors.push({
        code: "ERR_IMPORT_PRODUCT",
        message:
          cause instanceof Error
            ? cause.message
            : "Menu item could not be imported.",
      });
    }
  }

  return json(request, env, {
    ok: true,
    importedCount,
    skippedCount: Math.max(0, rows.length - importedCount),
    errors,
  });
}

export async function postProductBulkDelete(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<{ ids?: unknown[]; items?: unknown[] }>(
    request,
  );
  const ids = [
    ...new Set(
      arrayValue(payload.ids || payload.items)
        .map((entry) =>
          routeText(typeof entry === "string" ? entry : objectValue(entry).id),
        )
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return json(request, env, { ok: true, deletedCount: 0 });

  const now = nowIso();
  const chunkSize = 40;
  const duplicateRows: Record<string, unknown>[] = [];
  for (const idChunk of chunkValues(ids, chunkSize)) {
    const idPlaceholders = idChunk.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT id, name, category, sku, price, active, raw_json
         FROM products
        WHERE workspace_id = ?
          AND id IN (${idPlaceholders})`,
    )
      .bind(workspaceId, ...idChunk)
      .all<Record<string, unknown>>();
    duplicateRows.push(...(rows.results || []));
  }
  const duplicateKeys = [
    ...new Map(
      duplicateRows
        .map((row) => duplicateProductKey(row))
        .filter((key) => key.name)
        .map((key) => [duplicateProductKeyString(key), key]),
    ).values(),
  ];
  const duplicateKeyStrings = duplicateKeys.map(duplicateProductKeyString);
  let deletedCount = 0;

  for (const idChunk of chunkValues(ids, chunkSize)) {
    const placeholders = idChunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(
      `UPDATE products
          SET active = 0,
              updated_at = ?
        WHERE workspace_id = ?
          AND active = 1
          AND id IN (${placeholders})`,
    )
      .bind(now, workspaceId, ...idChunk)
      .run();
    deletedCount += Number(result.meta.changes || 0);
  }

  for (const keyChunk of chunkValues(duplicateKeyStrings, chunkSize)) {
    const placeholders = keyChunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(
      `UPDATE products
          SET active = 0,
              updated_at = ?
        WHERE workspace_id = ?
          AND active = 1
          AND (lower(trim(name)) || '|' || lower(trim(category))) IN (${placeholders})`,
    )
      .bind(now, workspaceId, ...keyChunk)
      .run();
    deletedCount += Number(result.meta.changes || 0);
  }

  if (deletedCount) {
    const deletedItems = duplicateRows.map((row) => ({
      ...productAuditSnapshot(row, now),
      active: false,
    }));
    await env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'products_bulk_deleted', 'product', 'bulk', ?4, ?5)`,
    )
      .bind(
        id("audit"),
        workspaceId,
        auth.uid,
        JSON.stringify({
          ids,
          items: deletedItems,
          duplicateKeys,
          deletedCount,
        }),
        now,
      )
      .run();
  }
  return json(request, env, {
    ok: true,
    deletedCount,
    requestedCount: ids.length,
  });
}

export async function getSuppliers(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const url = new URL(request.url);
  const limit = limitFromUrl(url, 100, 500);
  const offset = offsetFromUrl(url);
  const search = `%${getParam(url, "search")}%`;
  const binds: unknown[] = [workspaceId];
  const filters = ["workspace_id = ?1", "active = 1"];

  if (search !== "%%") {
    binds.push(search);
    filters.push(
      `(name LIKE ?${binds.length} OR email LIKE ?${binds.length} OR phone LIKE ?${binds.length})`,
    );
  }

  binds.push(limit, offset);
  const limitIndex = binds.length - 1;
  const offsetIndex = binds.length;
  const rows = await env.DB.prepare(
    `SELECT id, legacy_source_id, name, email, phone, raw_json, updated_at
       FROM suppliers
      WHERE ${filters.join(" AND ")}
      ORDER BY lower(name) ASC
      LIMIT ?${limitIndex} OFFSET ?${offsetIndex}`,
  )
    .bind(...binds)
    .all();

  const suppliers = (rows.results || []).map((row) => {
    const record = row as Record<string, unknown>;
    const raw = objectValue(jsonParse(record.raw_json));
    return {
      ...raw,
      id: text(record.id),
      legacySourceId: text(record.legacy_source_id),
      name: text(record.name || raw.name),
      email: text(record.email || raw.email),
      phone: text(record.phone || raw.phone),
      contactPerson: text(raw.contactPerson || raw.contact),
      category: text(raw.category, "General") || "General",
      leadTime: numberValue(raw.leadTime, 0),
      paymentTerms: text(raw.paymentTerms, "COD") || "COD",
      accountNumber: text(raw.accountNumber),
      address: text(raw.address),
      addressLine1: text(raw.addressLine1 || raw.Address_Line_1),
      addressLine2: text(raw.addressLine2 || raw.Address_Line_2),
      city: text(raw.city || raw.City),
      province: text(raw.province || raw.Province || raw.state),
      postalCode: text(raw.postalCode || raw.Postal_Code || raw.postal_code),
      country: text(raw.country || raw.Country),
      notes: text(raw.notes || raw.Notes || raw.note),
      updatedAt: text(record.updated_at || raw.updatedAt),
      source: "cloudflare-d1:suppliers",
    };
  });

  return json(request, env, {
    ok: true,
    suppliers,
    items: suppliers,
    page: { limit, offset },
  });
}

export async function postSupplier(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const supplierId = await saveSupplier(
    env,
    auth,
    workspaceId,
    objectValue(payload.supplier || payload),
  );
  return json(request, env, { ok: true, id: supplierId });
}

export async function patchSupplier(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  supplierId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const savedId = await saveSupplier(env, auth, workspaceId, {
    ...objectValue(payload.supplier || payload),
    id: text(supplierId),
  });
  return json(request, env, { ok: true, id: savedId });
}

export async function deleteSupplierRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  supplierId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const idValue = text(supplierId);
  if (!idValue) return error(request, env, 400, "Supplier id is required.");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE suppliers
          SET active = 0,
              updated_at = ?3
        WHERE workspace_id = ?1
          AND id = ?2`,
    ).bind(workspaceId, idValue, now),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, created_at)
       VALUES (?1, ?2, ?3, 'supplier_deleted', 'supplier', ?4, ?5)`,
    ).bind(id("audit"), workspaceId, auth.uid, idValue, now),
  ]);
  return json(request, env, { ok: true, id: idValue });
}

export async function postSupplierBulkDelete(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const ids = arrayValue(payload.ids || payload.items)
    .map((entry) =>
      text(typeof entry === "string" ? entry : objectValue(entry).id),
    )
    .filter(Boolean);
  if (!ids.length) return json(request, env, { ok: true, deletedCount: 0 });

  const now = nowIso();
  const statements = ids.flatMap((supplierId) => [
    env.DB.prepare(
      `UPDATE suppliers
          SET active = 0,
              updated_at = ?3
        WHERE workspace_id = ?1
          AND id = ?2`,
    ).bind(workspaceId, supplierId, now),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, created_at)
       VALUES (?1, ?2, ?3, 'supplier_deleted', 'supplier', ?4, ?5)`,
    ).bind(id("audit"), workspaceId, auth.uid, supplierId, now),
  ]);
  await env.DB.batch(statements);
  return json(request, env, { ok: true, deletedCount: ids.length });
}

export async function postSupplierImport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const rows = arrayValue(payload.rows || payload.suppliers);
  const errors: Array<{ code: string; message: string }> = [];
  let importedCount = 0;

  for (const row of rows) {
    try {
      const raw = objectValue(row);
      if (isImportTemplateExampleRow(raw)) continue;
      const supplier = normalizeSupplierPayload(raw);
      if (!supplier.name) {
        errors.push({
          code: "ERR_MISSING_REQ",
          message: "Supplier name is required.",
        });
        continue;
      }
      await saveSupplier(env, auth, workspaceId, raw);
      importedCount += 1;
    } catch (cause) {
      errors.push({
        code: "ERR_IMPORT_SUPPLIER",
        message:
          cause instanceof Error
            ? cause.message
            : "Supplier could not be imported.",
      });
    }
  }

  return json(request, env, {
    ok: true,
    importedCount,
    skippedCount: Math.max(0, rows.length - importedCount),
    errors,
  });
}

export async function postStockItem(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const stockItemId = await saveStockItem(
    env,
    auth,
    workspaceId,
    objectValue(payload.item || payload.stockItem || payload),
  );
  return json(request, env, { ok: true, id: stockItemId });
}

export async function patchStockItem(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  stockItemId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const idToSave = text(stockItemId);
  const savedId = await saveStockItem(env, auth, workspaceId, {
    ...objectValue(payload.item || payload.stockItem || payload),
    id: idToSave,
  });
  return json(request, env, { ok: true, id: savedId });
}

export async function deleteStockItemRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  stockItemId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const now = nowIso();
  const target = await env.DB.prepare(
    `SELECT id, name, category, item_type, unit, unit_cost, active, raw_json
       FROM stock_items
      WHERE workspace_id = ?1
        AND id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, stockItemId)
    .first<Record<string, unknown>>();
  if (!target) return error(request, env, 404, "Stock item was not found.");
  const before = stockAuditSnapshot(target);
  const after = { ...before, active: false, deletedAt: now };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE stock_items
          SET active = 0,
              updated_at = ?3
        WHERE workspace_id = ?1
          AND id = ?2`,
    ).bind(workspaceId, stockItemId, now),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?1, ?2, ?3, 'stock_item_deleted', 'stock_item', ?4, ?5, ?6, ?7)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      stockItemId,
      JSON.stringify(before),
      JSON.stringify(after),
      now,
    ),
  ]);
  return json(request, env, { ok: true, id: stockItemId });
}

export async function postStockBulkDelete(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<{ ids?: unknown[]; itemIds?: unknown[] }>(
    request,
  );
  const ids = arrayValue(payload.ids || payload.itemIds)
    .map((entry) => text(entry))
    .filter(Boolean);
  if (!ids.length) return json(request, env, { ok: true, deletedCount: 0 });
  const now = nowIso();
  const chunkSize = 40;
  const deletedItems: Record<string, unknown>[] = [];
  let deletedCount = 0;

  for (const idChunk of chunkValues(ids, chunkSize)) {
    const placeholders = idChunk.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT id, name, category, item_type, unit, unit_cost, active, raw_json
         FROM stock_items
        WHERE workspace_id = ?
          AND active = 1
          AND id IN (${placeholders})`,
    )
      .bind(workspaceId, ...idChunk)
      .all<Record<string, unknown>>();
    deletedItems.push(
      ...(rows.results || []).map((row) => ({
        ...stockAuditSnapshot(row, now),
        active: false,
      })),
    );

    const result = await env.DB.prepare(
      `UPDATE stock_items
          SET active = 0,
              updated_at = ?
        WHERE workspace_id = ?
          AND id IN (${placeholders})`,
    )
      .bind(now, workspaceId, ...idChunk)
      .run();
    deletedCount += Number(result.meta.changes || 0);
  }

  if (deletedCount) {
    await env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'stock_items_deleted', 'stock_item', '', ?4, ?5)`,
    )
      .bind(
        id("audit"),
        workspaceId,
        auth.uid,
        JSON.stringify({ ids, items: deletedItems, deletedCount }),
        now,
      )
      .run();
  }
  return json(request, env, { ok: true, deletedCount });
}

export async function patchStockLevel(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  stockItemId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-ingredients");
  const payload = await readJson<Record<string, unknown>>(request);
  const quantity = numberValue(
    payload.stock ?? payload.nextLevel ?? payload.quantity,
    0,
  );
  const locationId =
    text(payload.locationId) || (await defaultLocationId(env, workspaceId));
  if (!locationId)
    return error(request, env, 400, "A location is required to update stock.");
  await assertLocationAccess(
    env,
    auth,
    workspaceId,
    locationId,
    "stock_level_update",
  );
  const stockItem = await env.DB.prepare(
    `SELECT id, item_type, is_stocked, raw_json
	       FROM stock_items
	      WHERE workspace_id = ?1
	        AND id = ?2
	        AND active = 1
	      LIMIT 1`,
  )
    .bind(workspaceId, stockItemId)
    .first<Record<string, unknown>>();
  if (!stockItem) return error(request, env, 404, "Stock item was not found.");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
        quantity = excluded.quantity,
        updated_at = excluded.updated_at`,
    ).bind(workspaceId, stockItemId, locationId, quantity, now),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'stock_level_updated', 'stock_balance', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      stockItemId,
      JSON.stringify({ locationId, quantity }),
      now,
    ),
  ]);
  return json(request, env, {
    ok: true,
    id: stockItemId,
    locationId,
    quantity,
  });
}

export async function postStockImport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<{
    items?: unknown[];
    options?: Record<string, unknown>;
  }>(request);
  const rows = arrayValue(payload.items)
    .map(objectValue)
    .filter((item) => !isImportTemplateExampleRow(item))
    .filter((item) => text(item.name || item.ingredientName));
  const fallbackLocation =
    text(
      payload.options?.defaultImportLocationId || payload.options?.locationId,
    ) || (await defaultLocationId(env, workspaceId));
  const allowStockBalanceUpdate =
    payload.options?.allowStockBalanceUpdate === true;
  let importedCount = 0;
  for (const row of rows) {
    const stockPayload = allowStockBalanceUpdate
      ? { ...row }
      : stripStockBalanceImportFields(row);
    delete stockPayload.__openingStockProvided;
    await saveStockItem(
      env,
      auth,
      workspaceId,
      {
        ...stockPayload,
        locationId:
          text(row.locationId || row.targetLocation || row.defaultLocationId) ||
          fallbackLocation,
      },
      { allowStockBalanceUpdate },
    );
    importedCount += 1;
  }
  return json(request, env, { ok: true, importedCount });
}

export async function postStockLocationCostsImport(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-ingredients");
  const payload = await readJson<{
    locationId?: unknown;
    locationName?: unknown;
    batchId?: unknown;
    source?: unknown;
    updates?: unknown[];
  }>(request);
  const locationId = text(payload.locationId);
  if (!locationId)
    return error(
      request,
      env,
      400,
      "Please select a location before exporting or importing location costs.",
    );
  await assertLocationAccess(
    env,
    auth,
    workspaceId,
    locationId,
    "location_cost_import",
  );
  const updates = arrayValue(payload.updates)
    .map(objectValue)
    .filter((entry) => text(entry.stockItemId));
  if (!updates.length)
    return error(
      request,
      env,
      400,
      "No valid location cost updates were supplied.",
    );

  const location = await env.DB.prepare(
    `SELECT id, name, display_name
       FROM locations
      WHERE workspace_id = ?1
        AND id = ?2
        AND active = 1
      LIMIT 1`,
  )
    .bind(workspaceId, locationId)
    .first<Record<string, unknown>>();
  if (!location)
    return error(request, env, 404, "Selected location was not found.");

  const now = nowIso();
  const batchId = text(payload.batchId) || id("loc_cost_batch");
  const statements: DbStatementLike[] = [];
  let updatedCount = 0;

  for (const update of updates) {
    const stockItemId = text(update.stockItemId);
    const newCostExVat = numberValue(update.newCostExVat, NaN);
    if (!stockItemId || !Number.isFinite(newCostExVat) || newCostExVat < 0)
      continue;
    const stockItem = await env.DB.prepare(
      `SELECT si.id, si.name, si.unit_cost, silp.price AS location_price
         FROM stock_items si
         LEFT JOIN stock_item_location_prices silp
           ON silp.workspace_id = si.workspace_id
          AND silp.stock_item_id = si.id
          AND silp.location_id = ?3
        WHERE si.workspace_id = ?1
          AND si.id = ?2
          AND si.active = 1
        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId, locationId)
      .first<Record<string, unknown>>();
    if (!stockItem) continue;
    const oldCostExVat = numberValue(
      stockItem.location_price ?? stockItem.unit_cost,
      0,
    );
    if (Math.round(oldCostExVat * 10000) === Math.round(newCostExVat * 10000))
      continue;

    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_item_location_prices (workspace_id, stock_item_id, location_id, price, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
         price = excluded.price,
         updated_at = excluded.updated_at`,
      ).bind(workspaceId, stockItemId, locationId, newCostExVat, now),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?1, ?2, ?3, 'location_cost_imported', 'stock_item_location_price', ?4, ?5, ?6, ?7)`,
      ).bind(
        id("audit"),
        workspaceId,
        auth.uid,
        stockItemId,
        JSON.stringify({
          locationId,
          locationName:
            location.display_name ||
            location.name ||
            payload.locationName ||
            "",
          oldCostExVat,
        }),
        JSON.stringify({
          locationId,
          locationName:
            location.display_name ||
            location.name ||
            payload.locationName ||
            "",
          newCostExVat,
          source: text(payload.source) || "LOCATION_COSTING_IMPORT",
          batchId,
          itemName: stockItem.name || update.itemName || "",
        }),
        now,
      ),
    );
    updatedCount += 1;
  }

  if (!updatedCount)
    return json(request, env, { ok: true, updatedCount: 0, batchId });
  await env.DB.batch(statements);
  return json(request, env, { ok: true, updatedCount, batchId });
}

export async function postStockResetDashboardHistory(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<{ includeStockOnHand?: boolean }>(request);
  const includeStockOnHand = payload.includeStockOnHand === true;
  const now = nowIso();
  const resetAt = `${now.slice(0, 10)}T00:00:00.000Z`;
  const stockBalanceCount = includeStockOnHand
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM stock_balances
        WHERE workspace_id = ?1`,
      )
        .bind(workspaceId)
        .first<{ count: number }>()
    : null;
  const statements: DbStatementLike[] = [
    env.DB.prepare(`DELETE FROM stock_movements WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(
      `DELETE FROM yoco_processed_signatures WHERE workspace_id = ?1`,
    ).bind(workspaceId),
    env.DB.prepare(`DELETE FROM yoco_order_lines WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(`DELETE FROM yoco_orders WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(
      `DELETE FROM yoco_webhook_events WHERE workspace_id = ?1`,
    ).bind(workspaceId),
    env.DB.prepare(
      `DELETE FROM integration_errors WHERE workspace_id = ?1`,
    ).bind(workspaceId),
    env.DB.prepare(
      `DELETE FROM low_stock_email_runs WHERE workspace_id = ?1`,
    ).bind(workspaceId),
    env.DB.prepare(
      `DELETE FROM credit_note_lines WHERE workspace_id = ?1`,
    ).bind(workspaceId),
    env.DB.prepare(`DELETE FROM credit_notes WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(`DELETE FROM grv_lines WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(`DELETE FROM grvs WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(
      `DELETE FROM purchase_order_lines WHERE workspace_id = ?1`,
    ).bind(workspaceId),
    env.DB.prepare(`DELETE FROM purchase_orders WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(`DELETE FROM adjustment_lines WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(`DELETE FROM adjustments WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(`DELETE FROM transfer_lines WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(`DELETE FROM transfers WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(
      `DELETE FROM stocktake_count_lines WHERE workspace_id = ?1`,
    ).bind(workspaceId),
    env.DB.prepare(
      `DELETE FROM stocktake_sessions WHERE workspace_id = ?1`,
    ).bind(workspaceId),
    env.DB.prepare(`DELETE FROM stocktake_drafts WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(
      `DELETE FROM manufacturing_batch_lines WHERE workspace_id = ?1`,
    ).bind(workspaceId),
    env.DB.prepare(
      `DELETE FROM manufacturing_batches WHERE workspace_id = ?1`,
    ).bind(workspaceId),
    env.DB.prepare(`DELETE FROM audit_events WHERE workspace_id = ?1`).bind(
      workspaceId,
    ),
    env.DB.prepare(
      `INSERT INTO workspace_settings (workspace_id, raw_json, updated_at)
       VALUES (?1, json_set('{}', '$.dashboardResetAt', ?2, '$.dashboard_reset_at', ?2, '$.reportingResetAt', ?2, '$.reporting_reset_at', ?2), ?3)
       ON CONFLICT(workspace_id) DO UPDATE SET
        raw_json = json_set(
          CASE WHEN json_valid(workspace_settings.raw_json) THEN workspace_settings.raw_json ELSE '{}' END,
          '$.dashboardResetAt',
          ?2,
          '$.dashboard_reset_at',
          ?2,
          '$.reportingResetAt',
          ?2,
          '$.reporting_reset_at',
          ?2
        ),
        updated_at = excluded.updated_at`,
    ).bind(workspaceId, resetAt, now),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, after_json, created_at)
       VALUES (?1, ?2, ?3, 'reporting_reset', 'workspace', ?4, ?5)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      JSON.stringify({
        includeStockOnHand,
        resetScope: "reporting",
        clearedReports: "all_reporting_tiles",
      }),
      now,
    ),
  ];
  if (includeStockOnHand) {
    statements.push(
      env.DB.prepare(
        `UPDATE stock_balances
          SET quantity = 0,
              updated_at = ?2
        WHERE workspace_id = ?1`,
      ).bind(workspaceId, now),
    );
  }
  await env.DB.batch(statements);
  return json(request, env, {
    ok: true,
    mode: includeStockOnHand ? "reporting_stock" : "reporting",
    resetAt: now,
    stockResetCount: includeStockOnHand
      ? Number(stockBalanceCount?.count || 0)
      : 0,
  });
}

/**
 * Enrich rows with the actor's email/display_name from the CENTRAL workspace_members table.
 * Replaces the old `LEFT JOIN workspace_members` — a cross-plane join that's impossible now that
 * members live in CENTRAL_DB. Mutates + returns the rows, adding `created_by_email`/`created_by_name`
 * exactly as the removed JOIN aliased them, so downstream mapping code is unchanged.
 */
async function attachActorInfo<T extends Record<string, unknown>>(
  env: Env,
  workspaceId: string,
  rows: T[],
  createdByKey = "created_by",
): Promise<T[]> {
  const uids = [
    ...new Set(rows.map((r) => text(r[createdByKey])).filter(Boolean)),
  ];
  if (!uids.length) return rows;
  const memberPh = uids.map((_, index) => `?${index + 2}`).join(", ");
  const appPh = uids.map((_, index) => `?${index + 1}`).join(", ");
  const [memberRes, appRes] = await Promise.all([
    env.CENTRAL_DB.prepare(
      `SELECT auth_uid, email, display_name
         FROM workspace_members
        WHERE workspace_id = ?1 AND (auth_uid IN (${memberPh}) OR email IN (${memberPh}))`,
    )
      .bind(workspaceId, ...uids)
      .all<{ auth_uid: string; email: string; display_name: string }>(),
    env.CENTRAL_DB.prepare(
      `SELECT id, email, display_name
         FROM app_users
        WHERE id IN (${appPh}) OR email IN (${appPh})`,
    )
      .bind(...uids)
      .all<{ id: string; email: string; display_name: string }>(),
  ]);
  const map = new Map<string, { email: string; name: string }>();
  // app_users first, then workspace_members overrides (member identity takes precedence).
  for (const a of appRes.results || []) {
    const info = { email: text(a.email), name: text(a.display_name) };
    if (a.id) map.set(text(a.id), info);
    if (a.email) map.set(text(a.email), info);
  }
  for (const m of memberRes.results || []) {
    const info = { email: text(m.email), name: text(m.display_name) };
    if (m.auth_uid) map.set(text(m.auth_uid), info);
    if (m.email) map.set(text(m.email), info);
  }
  for (const row of rows) {
    const info = map.get(text(row[createdByKey]));
    (row as Record<string, unknown>).created_by_email = info?.email || "";
    (row as Record<string, unknown>).created_by_name = info?.name || "";
  }
  return rows;
}

function preferredResolvedActor(...candidates: unknown[]) {
  for (const candidate of candidates) {
    const value = text(candidate);
    if (!value) continue;
    if (["system", "manual"].includes(value.toLowerCase())) continue;
    return value;
  }
  return "";
}

export async function getAdjustments(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const url = new URL(request.url);
  const limit = limitFromUrl(url, 100, 500);
  const offset = offsetFromUrl(url);
  const [adjRows, movRows] = await Promise.all([
    env.DB.prepare(
      `SELECT
          al.id,
          a.id AS adjustment_id,
          a.adjustment_type,
          a.occurred_at,
          a.created_at,
          a.reason,
          a.created_by,
          a.raw_json,
          al.stock_item_id,
          si.name AS stock_item_name,
          si.category AS stock_item_category,
          si.unit,
          si.unit_cost,
          al.location_id,
          l.name AS location_name,
          l.display_name AS location_display_name,
          al.quantity_delta,
          al.unit_cost AS line_unit_cost,
          0 AS is_yoco_wastage
         FROM adjustment_lines al
         JOIN adjustments a ON a.id = al.adjustment_id AND a.workspace_id = al.workspace_id
         JOIN stock_items si ON si.id = al.stock_item_id AND si.workspace_id = al.workspace_id
         LEFT JOIN locations l ON l.id = al.location_id AND l.workspace_id = al.workspace_id
        WHERE al.workspace_id = ?1
        ORDER BY a.occurred_at DESC
        LIMIT ?2 OFFSET ?3`,
    )
      .bind(workspaceId, limit, offset)
      .all(),
    env.DB.prepare(
      `SELECT
          sm.id,
          sm.occurred_at,
          sm.created_at,
          sm.created_by,
          sm.metadata_json AS raw_json,
          sm.stock_item_id,
          si.name AS stock_item_name,
          si.category AS stock_item_category,
          si.unit,
          si.unit_cost,
          sm.location_id,
          l.name AS location_name,
          l.display_name AS location_display_name,
          sm.quantity_delta,
          sm.unit_cost AS line_unit_cost
         FROM stock_movements sm
         JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
         LEFT JOIN locations l ON l.id = sm.location_id AND l.workspace_id = sm.workspace_id
        WHERE sm.workspace_id = ?1
          AND sm.movement_type = 'wastage'
          AND sm.document_type = 'yoco_order'
        ORDER BY sm.occurred_at DESC
        LIMIT 500`,
    )
      .bind(workspaceId)
      .all(),
  ]);

  // Actor name/email used to come from a `LEFT JOIN workspace_members`; members are now central.
  await attachActorInfo(
    env,
    workspaceId,
    (adjRows.results || []) as Record<string, unknown>[],
  );
  await attachActorInfo(
    env,
    workspaceId,
    (movRows.results || []) as Record<string, unknown>[],
  );

  const mapRow = (record: Record<string, unknown>, isYocoWastage: boolean) => {
    const raw = objectValue(jsonParse(record.raw_json));
    const impactQty = numberValue(record.quantity_delta, 0);
    const previousStock = numberValue(raw.previousStock, 0);
    const newStock = numberValue(raw.newStock, previousStock + impactQty);
    // Yoco wastage movements store created_at without 'Z' (SQLite DEFAULT datetime('now') = local-ambiguous).
    // occurred_at always has a proper ISO 'Z' suffix, so use it for Yoco rows to avoid the
    // dashboardResetAt filter treating the timestamp as local time instead of UTC.
    const createdAt = isYocoWastage
      ? text(record.occurred_at)
      : text(record.created_at || record.occurred_at);
    return {
      id: text(record.id),
      adjustmentId: text(record.adjustment_id || record.id),
      timestamp: text(record.occurred_at),
      createdAt,
      date: text(record.occurred_at).slice(0, 10),
      itemId: text(record.stock_item_id),
      stockItemId: text(record.stock_item_id),
      itemName: text(record.stock_item_name),
      stockItemName: text(record.stock_item_name),
      category: text(record.stock_item_category, "General"),
      locationId: text(record.location_id),
      locationName: text(record.location_display_name || record.location_name),
      createdBy: text(record.created_by),
      createdByName: isYocoWastage
        ? text(record.created_by_name || record.created_by_email) ||
          "Yoco (Webhook)"
        : text(
            record.created_by_name ||
              record.created_by_email ||
              record.created_by,
          ),
      user: isYocoWastage
        ? text(record.created_by_name || record.created_by_email) ||
          "Yoco (Webhook)"
        : text(
            record.created_by_name ||
              record.created_by_email ||
              record.created_by,
          ),
      mode: isYocoWastage ? "wastage" : text(record.adjustment_type),
      qty: Math.abs(impactQty),
      unit: text(record.unit),
      prevStock: previousStock,
      impactQty,
      impactEx:
        impactQty * numberValue(record.line_unit_cost || record.unit_cost, 0),
      newStock,
      note: isYocoWastage
        ? text(raw.refundNote) ||
          (text(raw.refundReason)
            ? text(raw.refundReason).replace(/_/g, " ")
            : "") ||
          "Damaged or Defective"
        : text(record.reason || raw.note),
      wasteReason: isYocoWastage
        ? text(raw.refundReason) || "damaged_or_defective"
        : text(raw.wasteReason),
      source: isYocoWastage
        ? "cloudflare-d1:yoco_wastage"
        : "cloudflare-d1:adjustments",
    };
  };

  const adjustments = [
    ...(adjRows.results || []).map((r) =>
      mapRow(r as Record<string, unknown>, false),
    ),
    ...(movRows.results || []).map((r) =>
      mapRow(r as Record<string, unknown>, true),
    ),
  ].sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));

  return json(request, env, { ok: true, adjustments, page: { limit, offset } });
}

export async function getWastageAdjustments(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  // Legacy frontend queries both /adjustments and /wastage-adjustments and concatenates them.
  // In D1, GET /adjustments already returns all adjustments including wastage.
  // We return an empty list here to prevent 404 errors in the console while maintaining compat.
  await scoped(request, env, auth, workspaceId);
  return json(request, env, { ok: true, items: [], wastageAdjustments: [] });
}

export async function postAdjustment(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-adjustments");
  const payload = await readJson<Record<string, unknown>>(request);
  const mode = text(payload.mode || payload.adjustmentType);
  const items = arrayValue(payload.items).map(objectValue);
  if (!mode)
    return error(request, env, 400, "Select an adjustment type first.");
  if (!items.length)
    return error(
      request,
      env,
      400,
      "Add at least one stock item to the adjustment.",
    );

  // Idempotency: honour a client-supplied stable id so a retry / double-submit does not
  // re-apply the stock delta. The write below is a single atomic env.DB.batch, so an existing
  // row means the whole adjustment already committed — return success without re-applying.
  const clientAdjustmentId = text(payload.id || payload.clientId);
  const adjustmentId = clientAdjustmentId || id("adj");
  if (clientAdjustmentId) {
    const existingAdjustment = await env.DB.prepare(
      `SELECT id FROM adjustments WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`,
    )
      .bind(workspaceId, clientAdjustmentId)
      .first<{ id: string }>();
    if (existingAdjustment) {
      return json(request, env, {
        ok: true,
        id: adjustmentId,
        duplicate: true,
      });
    }
  }
  const occurredAt = text(payload.date)
    ? new Date(`${text(payload.date)}T00:00:00.000Z`).toISOString()
    : nowIso();
  const reason = text(payload.note || payload.reason);
  const wasteReason = text(payload.wasteReason);
  const createdAt = nowIso();
  const statements = [
    env.DB.prepare(
      `INSERT INTO adjustments (id, workspace_id, adjustment_type, occurred_at, reason, created_by, raw_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      adjustmentId,
      workspaceId,
      mode,
      occurredAt,
      reason,
      auth.uid,
      JSON.stringify(payload),
      createdAt,
    ),
  ];
  const entries = [];

  for (const rawLine of items) {
    const stockItemId = text(
      rawLine.stockItemId || rawLine.itemId || rawLine.ingId,
    );
    if (!stockItemId) continue;
    const requestedLocationId = text(rawLine.locationId || payload.locationId);
    const locationId = await resolveActiveLocationId(
      env,
      workspaceId,
      requestedLocationId,
    );
    if (!locationId) {
      return error(
        request,
        env,
        400,
        requestedLocationId
          ? `The selected adjustment location (${requestedLocationId}) is no longer active. Please choose a valid location.`
          : "A valid adjustment location is required.",
      );
    }

    await assertLocationAccess(
      env,
      auth,
      workspaceId,
      locationId,
      "adjustment",
    );

    const stockItem = await env.DB.prepare(
      `SELECT id, name, unit, unit_cost, raw_json
	         FROM stock_items
	        WHERE workspace_id = ?1
	          AND id = ?2
	          AND active = 1
	          AND ${STOCKED_ITEM_SQL}
	        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId)
      .first<Record<string, unknown>>();
    if (!stockItem)
      return error(
        request,
        env,
        404,
        `${text(rawLine.stockItemName || stockItemId)} could not be found.`,
      );

    const balance = await env.DB.prepare(
      `SELECT quantity
         FROM stock_balances
        WHERE workspace_id = ?1
          AND stock_item_id = ?2
          AND location_id = ?3
        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId, locationId)
      .first<{ quantity: number }>();

    const previousStock = numberValue(balance?.quantity, 0);
    const quantity = Math.max(
      numberValue(rawLine.quantity ?? rawLine.qty, 0),
      0,
    );
    let impactQty = 0;
    let newStock = previousStock;

    if (mode === "override") {
      newStock = quantity;
      impactQty = newStock - previousStock;
    } else if (mode === "add") {
      impactQty = Math.abs(quantity);
      newStock = previousStock + impactQty;
    } else {
      impactQty = -Math.abs(quantity);
      newStock = previousStock + impactQty;
    }

    if (newStock < 0) {
      return error(
        request,
        env,
        409,
        `${text(stockItem.name)} cannot go below zero stock at the selected location.`,
      );
    }

    const lineId = id("adj_line");
    const movementId = id("move");
    const unitCost = (
      await resolveLocationUnitCost(
        env,
        workspaceId,
        stockItemId,
        locationId,
        stockItem,
      )
    ).cost;
    const lineMeta = {
      note: reason,
      wasteReason,
      previousStock,
      newStock,
      mode,
    };
    const now = nowIso();

    statements.push(
      env.DB.prepare(
        // Incremental write (apply the signed delta) so duplicate lines and concurrent
        // mutations don't clobber each other. impactQty already carries the sign.
        `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = stock_balances.quantity + ?4,
          updated_at = excluded.updated_at`,
      ).bind(workspaceId, stockItemId, locationId, impactQty, now),
      env.DB.prepare(
        `INSERT INTO adjustment_lines (id, workspace_id, adjustment_id, stock_item_id, location_id, quantity_delta, unit_cost)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(
        lineId,
        workspaceId,
        adjustmentId,
        stockItemId,
        locationId,
        impactQty,
        unitCost,
      ),
      env.DB.prepare(
        `INSERT INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
           quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'adjustment', 'adjustment', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        movementId,
        workspaceId,
        stockItemId,
        locationId,
        adjustmentId,
        impactQty,
        unitCost,
        impactQty * unitCost,
        occurredAt,
        auth.uid,
        JSON.stringify(lineMeta),
        now,
      ),
    );

    entries.push({
      id: lineId,
      adjustmentId,
      stockItemId,
      itemName: text(stockItem.name),
      locationId,
      impactQty,
      previousStock,
      newStock,
    });
  }

  if (!entries.length)
    return error(request, env, 400, "No valid adjustment lines were found.");
  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
     VALUES (?1, ?2, ?3, 'adjustment_posted', 'adjustment', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      adjustmentId,
      JSON.stringify({ entries }),
      nowIso(),
    ),
  );

  await env.DB.batch(statements);
  return json(request, env, { ok: true, id: adjustmentId, entries });
}

export async function postWastageAdjustment(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-adjustments");
  const payload = await readJson<Record<string, unknown>>(request);
  const items = arrayValue(payload.items).map(objectValue);
  const wasteReason = text(payload.wasteReason) || "Other";
  const note = text(payload.note || payload.reason);
  const requestedLocationId = text(payload.locationId);
  const date = text(payload.date);

  if (!items.length)
    return error(request, env, 400, "Select at least one menu item to waste.");

  const locationId = await resolveActiveLocationId(
    env,
    workspaceId,
    requestedLocationId,
  );
  if (!locationId)
    return error(request, env, 400, "A valid location is required.");
  await assertLocationAccess(env, auth, workspaceId, locationId, "wastage");

  const occurredAt = date
    ? new Date(`${date}T00:00:00.000Z`).toISOString()
    : nowIso();
  // Idempotency: honour a client-supplied stable id so a retry does not re-deduct stock.
  const clientWastageId = text(payload.id || payload.clientId);
  const adjustmentId = clientWastageId || id("wst_adj");
  if (clientWastageId) {
    const existingWastage = await env.DB.prepare(
      `SELECT id FROM adjustments WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`,
    )
      .bind(workspaceId, clientWastageId)
      .first<{ id: string }>();
    if (existingWastage) {
      return json(request, env, {
        ok: true,
        id: adjustmentId,
        duplicate: true,
      });
    }
  }
  const createdAt = nowIso();
  const statements: DbStatementLike[] = [
    env.DB.prepare(
      `INSERT INTO adjustments (id, workspace_id, adjustment_type, occurred_at, reason, created_by, raw_json, created_at)
       VALUES (?1, ?2, 'wastage', ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      adjustmentId,
      workspaceId,
      occurredAt,
      note || `Wastage: ${wasteReason}`,
      auth.uid,
      JSON.stringify(payload),
      createdAt,
    ),
  ];

  const summary: Record<string, unknown>[] = [];
  let movementCount = 0;

  for (const rawItem of items) {
    const productId = text(rawItem.productId || rawItem.id);
    const productName = text(rawItem.productName || rawItem.name);
    const quantity = Math.max(
      numberValue(rawItem.quantity ?? rawItem.qty, 0),
      0,
    );
    if (!productId || quantity <= 0) continue;

    const ingredients = await expandProductIngredients(
      env,
      workspaceId,
      productId,
      quantity,
    );
    if (!ingredients.length) {
      summary.push({ productId, productName, quantity, skipped: "no_recipe" });
      continue;
    }

    for (const ingredient of ingredients) {
      const balance = await env.DB.prepare(
        `SELECT quantity FROM stock_balances WHERE workspace_id = ?1 AND stock_item_id = ?2 AND location_id = ?3 LIMIT 1`,
      )
        .bind(workspaceId, ingredient.stockItemId, locationId)
        .first<{ quantity: number }>();

      const previousStock = numberValue(balance?.quantity, 0);
      // Zero-floor: never waste more than is on hand at the location (don't drive the balance negative).
      const available = Math.max(previousStock, 0);
      const delta = -Math.min(Math.abs(ingredient.totalQty), available);
      if (delta === 0) {
        summary.push({
          productId,
          productName,
          quantity,
          stockItemId: ingredient.stockItemId,
          stockItemName: ingredient.stockItemName,
          skipped: "no_stock",
        });
        continue;
      }
      const newStock = previousStock + delta;
      const unitCost = (
        await resolveLocationUnitCost(
          env,
          workspaceId,
          ingredient.stockItemId,
          locationId,
          ingredient.unitCost,
        )
      ).cost;
      const movId = id("mov");
      const lineId = id("adj_line");
      const now = nowIso();
      const meta = JSON.stringify({
        productId,
        productName,
        wasteReason,
        note,
        previousStock,
        newStock,
        mode: "wastage",
        wastageQty: quantity,
      });

      statements.push(
        env.DB.prepare(
          // Incremental so two wasted products sharing an ingredient both deduct it.
          `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
            quantity = stock_balances.quantity + ?4, updated_at = excluded.updated_at`,
        ).bind(workspaceId, ingredient.stockItemId, locationId, delta, now),
        env.DB.prepare(
          `INSERT INTO adjustment_lines (id, workspace_id, adjustment_id, stock_item_id, location_id, quantity_delta, unit_cost)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).bind(
          lineId,
          workspaceId,
          adjustmentId,
          ingredient.stockItemId,
          locationId,
          delta,
          unitCost,
        ),
        env.DB.prepare(
          `INSERT INTO stock_movements
            (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
             quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
           VALUES (?1, ?2, ?3, ?4, 'wastage', 'wastage_adjustment', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        ).bind(
          movId,
          workspaceId,
          ingredient.stockItemId,
          locationId,
          adjustmentId,
          delta,
          unitCost,
          delta * unitCost,
          occurredAt,
          auth.uid,
          meta,
          now,
        ),
      );

      summary.push({
        productId,
        productName,
        quantity,
        stockItemId: ingredient.stockItemId,
        stockItemName: ingredient.stockItemName,
        unit: ingredient.unit,
        qtyDeducted: Math.abs(delta),
        costImpact: Math.abs(delta * unitCost),
      });
      movementCount += 1;
    }
  }

  if (!movementCount) {
    const noRecipe = summary
      .filter((s) => s.skipped === "no_recipe")
      .map((s) => s.productName)
      .filter(Boolean);
    const msg = noRecipe.length
      ? `No recipes found for: ${noRecipe.join(", ")}. Set up a recipe for each menu item before recording wastage.`
      : "No valid wastage lines could be processed.";
    return error(request, env, 400, msg);
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'wastage_posted', 'adjustment', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      adjustmentId,
      JSON.stringify({ summary }),
      nowIso(),
    ),
  );

  await env.DB.batch(statements);
  return json(request, env, {
    ok: true,
    id: adjustmentId,
    movements: movementCount,
    summary,
  });
}

export async function postStockCategoryAction(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  action: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const name = text(payload.name || payload.categoryName || payload.category);
  const currentName = text(
    payload.currentName || payload.current || payload.from,
  );
  const nextName = text(payload.nextName || payload.next || payload.to || name);
  const now = nowIso();
  if (action === "rename") {
    if (!currentName || !nextName)
      return error(request, env, 400, "Both category names are required.");
    await env.DB.prepare(
      `UPDATE stock_items
          SET category = ?3,
              updated_at = ?4
        WHERE workspace_id = ?1
          AND lower(trim(category)) = lower(trim(?2))`,
    )
      .bind(workspaceId, currentName, nextName, now)
      .run();
    return json(request, env, { ok: true });
  }
  if (action === "delete") {
    const inUse = await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM stock_items
        WHERE workspace_id = ?1
          AND active = 1
          AND lower(trim(category)) = lower(trim(?2))`,
    )
      .bind(workspaceId, name)
      .first<{ count: number }>();
    if (Number(inUse?.count || 0) > 0) {
      return error(
        request,
        env,
        409,
        `This category is still assigned to ${inUse?.count} stock item(s).`,
      );
    }
    return json(request, env, { ok: true });
  }
  if (!name) return error(request, env, 400, "Category name is required.");
  return json(request, env, { ok: true });
}

export async function postStockUomAction(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  action: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const name = text(payload.name || payload.uomName || payload.uom);
  const currentName = text(
    payload.currentName || payload.current || payload.from,
  );
  const nextName = text(payload.nextName || payload.next || payload.to || name);
  const now = nowIso();
  if (action === "rename") {
    if (!currentName || !nextName)
      return error(request, env, 400, "Both UOM names are required.");
    await env.DB.prepare(
      `UPDATE stock_items
          SET unit = ?3,
              updated_at = ?4
        WHERE workspace_id = ?1
          AND lower(trim(unit)) = lower(trim(?2))`,
    )
      .bind(workspaceId, currentName, nextName, now)
      .run();
    return json(request, env, { ok: true });
  }
  if (action === "delete") {
    const inUse = await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM stock_items
        WHERE workspace_id = ?1
          AND active = 1
          AND lower(trim(unit)) = lower(trim(?2))`,
    )
      .bind(workspaceId, name)
      .first<{ count: number }>();
    if (Number(inUse?.count || 0) > 0) {
      return error(
        request,
        env,
        409,
        `This UOM is still assigned to ${inUse?.count} stock item(s).`,
      );
    }
    return json(request, env, { ok: true });
  }
  if (!name) return error(request, env, 400, "UOM name is required.");
  return json(request, env, { ok: true });
}

function normalizePurchaseOrderPayload(raw: Record<string, unknown>) {
  const order = objectValue(raw.order || raw);
  const orderId = text(order.id) || id("po");
  const date =
    text(order.date || order.orderedAt || order.createdAt) ||
    nowIso().slice(0, 10);
  const supplierId = text(
    order.supplierId || order.supplier_id || order.supplier,
  );
  const items = arrayValue(order.items)
    .map(objectValue)
    .map((line) => {
      const qty = numberValue(line.qty ?? line.quantity ?? line.orderQty, 0);
      const unitCost = numberValue(
        line.unitCost ?? line.cost ?? line.price ?? line.unit_price,
        0,
      );
      const packSize = numberValue(line.packSize ?? line.pack_size, 1) || 1;
      const baseUom = text(line.unit || line.uom, "ea") || "ea";
      const selectedUom =
        text(
          line.selectedUom || line.purchaseUom || line.orderUom || baseUom,
          baseUom,
        ) || baseUom;
      return {
        ...line,
        id: text(line.id || line.stockItemId || line.ingId) || id("pol"),
        stockItemId: text(
          line.stockItemId || line.ingredientId || line.ingId || line.id,
        ),
        stockItemName: text(
          line.stockItemName ||
            line.ingredientName ||
            line.name ||
            line.description,
        ),
        qty,
        quantity: qty,
        packSize,
        unitCost,
        unit: baseUom,
        selectedUom,
        purchaseUom: selectedUom,
        uomConfigurations: normalizeUomConfigurations(
          line.uomConfigurations || line.uomConfig || line.uomConversions,
        ),
        receivedQty: numberValue(line.receivedQty ?? line.received, 0),
        remainingQty: numberValue(
          line.remainingQty,
          Math.max(qty - numberValue(line.receivedQty ?? line.received, 0), 0),
        ),
        locationId: text(
          line.locationId ||
            line.targetLocation ||
            order.locationId ||
            order.targetLocation,
        ),
        targetLocation: text(
          line.targetLocation ||
            line.locationId ||
            order.targetLocation ||
            order.locationId,
        ),
        locationName: text(
          line.locationName ||
            line.targetLocationName ||
            order.targetLocationName ||
            order.locationName,
        ),
        targetLocationName: text(
          line.targetLocationName ||
            line.locationName ||
            order.targetLocationName ||
            order.locationName,
        ),
        lineTotalEx: qty * packSize * unitCost,
      };
    })
    .filter((line) => text(line.stockItemId) && numberValue(line.qty, 0) > 0);

  const totalEx = items.reduce(
    (sum, line) => sum + numberValue(line.lineTotalEx, 0),
    0,
  );
  const totalVat = numberValue(order.totalVat, totalEx * 0.15);
  const totalInc = numberValue(order.totalInc, totalEx + totalVat);
  const status = text(order.status, "draft")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const normalized = {
    ...order,
    id: orderId,
    poNumber:
      text(order.poNumber || order.reference || order.number) ||
      `PO-${orderId.slice(-6).toUpperCase()}`,
    reference:
      text(order.reference || order.poNumber || order.number) ||
      `PO-${orderId.slice(-6).toUpperCase()}`,
    date,
    supplierId,
    supplierName: text(order.supplierName || order.supplier),
    locationId: text(order.locationId || order.targetLocation),
    targetLocation: text(order.targetLocation || order.locationId),
    targetLocationName: text(order.targetLocationName || order.locationName),
    status:
      status === "submitted" || status === "pending"
        ? "sent"
        : status || "draft",
    items,
    receivedItems: arrayValue(order.receivedItems),
    receivedHistory: arrayValue(order.receivedHistory),
    receivedTotalEx: numberValue(order.receivedTotalEx, 0),
    notes: text(order.notes),
    createdAt: text(order.createdAt),
    submittedAt: text(order.submittedAt),
    partiallyReceivedAt: text(order.partiallyReceivedAt),
    receivedAt: text(order.receivedAt),
    updatedAt: nowIso(),
    createdBy: text(order.createdBy),
    createdByName: text(order.createdByName),
    createdByEmail: text(order.createdByEmail),
    totalEx,
    totalVat,
    totalInc,
  };

  return {
    id: orderId,
    supplierId,
    status: text(normalized.status, "draft"),
    poNumber: normalized.poNumber,
    targetLocationId:
      normalized.locationId || normalized.targetLocation || null,
    orderedAt: date.length <= 10 ? `${date}T00:00:00.000Z` : date,
    expectedAt: text(order.expectedAt || order.expected_at) || null,
    totalEx,
    totalVat,
    totalInc,
    rawJson: JSON.stringify(normalized),
    normalized,
  };
}

export async function getPurchaseOrders(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const limit = limitFromUrl(new URL(request.url), 500, 1000);
  const rows = await env.DB.prepare(
    `SELECT
        po.id,
        po.supplier_id,
        po.status,
        po.po_number,
        po.target_location_id,
        po.ordered_at,
        po.expected_at,
        po.total_ex,
        po.total_vat,
        po.total_inc,
        po.raw_json,
        po.created_at,
        po.updated_at,
        (
          SELECT ae.actor_uid
            FROM audit_events ae
           WHERE ae.workspace_id = po.workspace_id
             AND ae.entity_type = 'purchase_order'
             AND ae.entity_id = po.id
           ORDER BY ae.created_at DESC
           LIMIT 1
        ) AS created_by,
        s.name AS supplier_name,
        l.name AS location_name,
        l.display_name AS location_display_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.workspace_id = po.workspace_id
       LEFT JOIN locations l ON l.id = po.target_location_id AND l.workspace_id = po.workspace_id
      WHERE po.workspace_id = ?1
      ORDER BY po.updated_at DESC, po.ordered_at DESC
      LIMIT ?2`,
  )
    .bind(workspaceId, limit)
    .all();

  // created_by comes from the (tenant) audit_events subquery; enrich name/email from central members.
  await attachActorInfo(
    env,
    workspaceId,
    (rows.results || []) as Record<string, unknown>[],
  );

  const orders = (rows.results || []).map((row) => {
    const record = row as Record<string, unknown>;
    const raw = objectValue(jsonParse(record.raw_json));
    return {
      ...raw,
      id: text(record.id),
      poNumber: text(raw.poNumber || record.po_number),
      reference: text(raw.reference || raw.poNumber || record.po_number),
      date: text(raw.date || record.ordered_at).slice(0, 10),
      supplierId: text(raw.supplierId || record.supplier_id),
      supplierName: text(raw.supplierName || record.supplier_name),
      locationId: text(raw.locationId || record.target_location_id),
      targetLocation: text(
        raw.targetLocation || raw.locationId || record.target_location_id,
      ),
      targetLocationName: text(
        raw.targetLocationName ||
          record.location_display_name ||
          record.location_name,
      ),
      status: text(record.status || raw.status, "draft"),
      totalEx: numberValue(record.total_ex, numberValue(raw.totalEx, 0)),
      totalVat: numberValue(record.total_vat, numberValue(raw.totalVat, 0)),
      totalInc: numberValue(record.total_inc, numberValue(raw.totalInc, 0)),
      createdBy: text(raw.createdBy || record.created_by),
      createdByName: text(
        raw.createdByName ||
          record.created_by_name ||
          record.created_by_email ||
          record.created_by,
      ),
      createdByEmail: text(raw.createdByEmail || record.created_by_email),
      createdAt: text(raw.createdAt || record.created_at),
      updatedAt: text(record.updated_at || raw.updatedAt),
      items: arrayValue(raw.items),
    };
  });

  return json(request, env, { ok: true, orders });
}

export async function postPurchaseOrder(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(
    env,
    auth,
    workspaceId,
    "nav-purchase-orders",
  );
  const payload = normalizePurchaseOrderPayload(
    await readJson<Record<string, unknown>>(request),
  );
  if (!payload.supplierId)
    return error(
      request,
      env,
      400,
      "Select a supplier before saving the purchase order.",
    );
  if (!payload.normalized.items.length)
    return error(
      request,
      env,
      400,
      "Add at least one stock item to the purchase order.",
    );

  const now = nowIso();
  const receivingLocationId =
    payload.targetLocationId || (await defaultLocationId(env, workspaceId));
  if (receivingLocationId) {
    await assertLocationAccess(
      env,
      auth,
      workspaceId,
      receivingLocationId,
      "purchase_order",
    );
    payload.targetLocationId = receivingLocationId;
    payload.normalized.locationId = receivingLocationId;
    payload.normalized.targetLocation = receivingLocationId;
    payload.normalized.items = payload.normalized.items.map((line) => ({
      ...line,
      locationId:
        text(line.locationId || line.targetLocation) || receivingLocationId,
      targetLocation:
        text(line.targetLocation || line.locationId) || receivingLocationId,
    }));
    payload.rawJson = JSON.stringify(payload.normalized);
  }
  for (const line of payload.normalized.items) {
    const stockItemId = text(line.stockItemId || line.id);
    const stockItem = stockItemId
      ? await env.DB.prepare(
          `SELECT id
	           FROM stock_items
	          WHERE workspace_id = ?1
	            AND id = ?2
	            AND active = 1
	            AND ${STOCKED_ITEM_SQL}
	          LIMIT 1`,
        )
          .bind(workspaceId, stockItemId)
          .first<{ id: string }>()
      : null;
    if (!stockItem) {
      return error(
        request,
        env,
        400,
        `${text(line.stockItemName || stockItemId || "Stock item")} is not a stocked item and cannot be added to a purchase order.`,
      );
    }
  }
  // workspace_members is a CENTRAL table — read via env.CENTRAL_DB, not the tenant DO's env.DB
  // (mirrors postCreditNote / postStockTake). env.DB here throws "no such table" → 500 on PO save.
  const actor = await env.CENTRAL_DB.prepare(
    `SELECT display_name, email
	       FROM workspace_members
      WHERE workspace_id = ?1
        AND auth_uid = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, auth.uid)
    .first<Record<string, unknown>>();
  payload.normalized.createdBy = auth.uid;
  payload.normalized.createdByName = text(
    actor?.display_name || actor?.email || auth.uid,
  );
  payload.normalized.createdByEmail = text(actor?.email);
  payload.rawJson = JSON.stringify(payload.normalized);
  const statements = [
    env.DB.prepare(
      `INSERT INTO purchase_orders
        (id, workspace_id, supplier_id, status, po_number, target_location_id, ordered_at, expected_at,
         total_ex, total_vat, total_inc, raw_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
       ON CONFLICT(id) DO UPDATE SET
        supplier_id = excluded.supplier_id,
        status = excluded.status,
        po_number = excluded.po_number,
        target_location_id = excluded.target_location_id,
        ordered_at = excluded.ordered_at,
        expected_at = excluded.expected_at,
        total_ex = excluded.total_ex,
        total_vat = excluded.total_vat,
        total_inc = excluded.total_inc,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`,
    ).bind(
      payload.id,
      workspaceId,
      payload.supplierId || null,
      payload.status,
      payload.poNumber,
      receivingLocationId || null,
      payload.orderedAt,
      payload.expectedAt,
      payload.totalEx,
      payload.totalVat,
      payload.totalInc,
      payload.rawJson,
      now,
    ),
    env.DB.prepare(
      `DELETE FROM purchase_order_lines
        WHERE workspace_id = ?1
          AND purchase_order_id = ?2`,
    ).bind(workspaceId, payload.id),
  ];

  payload.normalized.items.forEach((line, index) => {
    const qty = numberValue(line.qty ?? line.quantity, 0);
    const unitPrice = numberValue(line.unitCost, 0);
    const totalEx = qty * numberValue(line.packSize, 1) * unitPrice;
    const totalVat = totalEx * 0.15;
    const lineKey =
      text(line.id || line.stockItemId || `line_${index}`)
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .slice(0, 80) || `line_${index}`;
    statements.push(
      env.DB.prepare(
        `INSERT INTO purchase_order_lines
        (id, workspace_id, purchase_order_id, stock_item_id, description, quantity, unit, unit_price, total_ex, total_vat, total_inc)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(
        `${payload.id}:line:${index}:${lineKey}`,
        workspaceId,
        payload.id,
        text(line.stockItemId),
        text(line.stockItemName),
        qty,
        text(line.unit, "ea") || "ea",
        unitPrice,
        totalEx,
        totalVat,
        totalEx + totalVat,
      ),
    );
  });

  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
     VALUES (?1, ?2, ?3, 'purchase_order_saved', 'purchase_order', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      payload.id,
      payload.rawJson,
      now,
    ),
  );

  await env.DB.batch(statements);
  return json(request, env, { ok: true, id: payload.id });
}

export async function patchPurchaseOrder(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  orderId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const current = await env.DB.prepare(
    `SELECT raw_json
       FROM purchase_orders
      WHERE workspace_id = ?1
        AND id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, text(orderId))
    .first<Record<string, unknown>>();
  if (!current)
    return error(request, env, 404, "Purchase order could not be found.");

  const patch = await readJson<Record<string, unknown>>(request);
  const merged = {
    ...objectValue(jsonParse(current.raw_json)),
    ...objectValue(patch.order || patch),
    id: text(orderId),
  };
  return postPurchaseOrder(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ order: merged }),
    }),
    env,
    auth,
    workspaceId,
  );
}

export async function deletePurchaseOrderRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  orderId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const idValue = text(orderId);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM purchase_order_lines WHERE workspace_id = ?1 AND purchase_order_id = ?2`,
    ).bind(workspaceId, idValue),
    env.DB.prepare(
      `DELETE FROM purchase_orders WHERE workspace_id = ?1 AND id = ?2`,
    ).bind(workspaceId, idValue),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, created_at)
       VALUES (?1, ?2, ?3, 'purchase_order_deleted', 'purchase_order', ?4, ?5)`,
    ).bind(id("audit"), workspaceId, auth.uid, idValue, nowIso()),
  ]);
  return json(request, env, { ok: true, id: idValue });
}

export async function postPurchaseOrderBulkDelete(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const ids = arrayValue(payload.ids)
    .map((value) => text(value))
    .filter(Boolean);
  if (!ids.length) return json(request, env, { ok: true, deleted: 0 });

  const statements = ids.flatMap((orderId) => [
    env.DB.prepare(
      `DELETE FROM purchase_order_lines WHERE workspace_id = ?1 AND purchase_order_id = ?2`,
    ).bind(workspaceId, orderId),
    env.DB.prepare(
      `DELETE FROM purchase_orders WHERE workspace_id = ?1 AND id = ?2`,
    ).bind(workspaceId, orderId),
  ]);
  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
     VALUES (?1, ?2, ?3, 'purchase_orders_bulk_deleted', 'purchase_order', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      ids.join(","),
      JSON.stringify({ ids }),
      nowIso(),
    ),
  );
  await env.DB.batch(statements);
  return json(request, env, { ok: true, deleted: ids.length });
}

function normalizeGoodsReceiptPayload(raw: Record<string, unknown>) {
  const receipt = objectValue(raw.receipt || raw);
  const receiptId = text(receipt.id) || id("grv");
  const date =
    text(receipt.date || receipt.receivedAt || receipt.timestamp) ||
    nowIso().slice(0, 10);
  const defaultLocationId = text(receipt.locationId || receipt.targetLocation);
  const items = arrayValue(receipt.items)
    .map(objectValue)
    .map((line) => {
      const receivedQty = numberValue(
        line.receivedQty ?? line.qty ?? line.quantity,
        0,
      );
      const orderedQty = numberValue(
        line.orderedQty ?? line.orderQty ?? line.qtyOrdered,
        0,
      );
      const packSize = numberValue(line.packSize ?? line.pack_size, 1) || 1;
      const unitCost = numberValue(line.unitCost ?? line.cost ?? line.price, 0);
      const locationId = text(
        line.locationId || line.targetLocation || defaultLocationId,
      );
      const baseUom = text(line.unit || line.uom, "ea") || "ea";
      const selectedUom =
        text(
          line.selectedUom || line.receivingUom || line.purchaseUom || baseUom,
          baseUom,
        ) || baseUom;
      return {
        ...line,
        id:
          text(line.id || line.stockItemId || line.ingredientId) || id("grvl"),
        stockItemId: text(
          line.stockItemId || line.ingredientId || line.ingId || line.id,
        ),
        stockItemName: text(
          line.stockItemName || line.ingredientName || line.name,
        ),
        unit: baseUom,
        selectedUom,
        receivingUom: selectedUom,
        uomConfigurations: normalizeUomConfigurations(
          line.uomConfigurations || line.uomConfig || line.uomConversions,
        ),
        orderedQty,
        receivedQty,
        qty: receivedQty,
        varianceQty: receivedQty - orderedQty,
        packSize,
        baseQuantity: receivedQty * packSize,
        unitCost,
        costEx: unitCost,
        lineTotalEx: receivedQty * packSize * unitCost,
        locationId,
        targetLocation: locationId,
        locationName: text(
          line.locationName ||
            line.targetLocationName ||
            receipt.locationName ||
            receipt.targetLocationName,
        ),
        targetLocationName: text(
          line.targetLocationName ||
            line.locationName ||
            receipt.targetLocationName ||
            receipt.locationName,
        ),
      };
    })
    .filter(
      (line) => text(line.stockItemId) && numberValue(line.receivedQty, 0) > 0,
    );
  const totalEx = items.reduce(
    (sum, line) => sum + numberValue(line.lineTotalEx, 0),
    0,
  );
  const totalVat = numberValue(receipt.totalVat, totalEx * 0.15);
  const totalInc = numberValue(receipt.totalInc, totalEx + totalVat);
  const timestamp = date.length <= 10 ? `${date}T00:00:00.000Z` : date;
  const normalized = {
    ...receipt,
    id: receiptId,
    grvNumber:
      text(receipt.grvNumber || receipt.invoice || receipt.reference) ||
      `GRV-${receiptId.slice(-6).toUpperCase()}`,
    invoice:
      text(receipt.invoice || receipt.grvNumber || receipt.reference) ||
      `GRV-${receiptId.slice(-6).toUpperCase()}`,
    sourcePoId: text(receipt.sourcePoId || receipt.poId),
    poNumber: text(receipt.poNumber || receipt.purchaseOrderNumber),
    supplierId: text(receipt.supplierId),
    supplierName:
      text(receipt.supplierName || receipt.supplier, "Manual Receipt") ||
      "Manual Receipt",
    supplier:
      text(receipt.supplier || receipt.supplierName, "Manual Receipt") ||
      "Manual Receipt",
    date: timestamp.slice(0, 10),
    timestamp,
    locationId: defaultLocationId,
    targetLocation: defaultLocationId,
    locationName: text(receipt.locationName || receipt.targetLocationName),
    notes: text(receipt.notes),
    splitByLocation:
      receipt.splitByLocation === true || receipt.split_by_location === 1,
    overrideCostPrice:
      receipt.overrideCostPrice !== false &&
      receipt.override_cost_price !== false &&
      receipt.override_cost_price !== 0,
    costingMethod: text(receipt.costingMethod || receipt.costing_method),
    status: "finalized",
    workflowStatus: "finalized",
    totalEx,
    totalVat,
    totalInc,
    lineCount: items.length,
    varianceCount: items.filter(
      (line) => numberValue(line.varianceQty, 0) !== 0,
    ).length,
    items,
    type: text(receipt.sourcePoId || receipt.poId) ? "PO_GRV" : "MANUAL_GRV",
    submittedByUserId: text(receipt.submittedByUserId || receipt.userId),
    submittedByName: text(receipt.submittedByName || receipt.userName),
  };

  return {
    id: receiptId,
    supplierId: normalized.supplierId || null,
    purchaseOrderId: normalized.sourcePoId || null,
    invoiceNumber: normalized.invoice,
    receivedAt: timestamp,
    pricesIncludeVat:
      receipt.pricesIncludeVat === true || receipt.prices_include_vat === 1
        ? 1
        : 0,
    splitByLocation:
      receipt.splitByLocation === true || receipt.split_by_location === 1
        ? 1
        : 0,
    overrideCostPrice: normalized.overrideCostPrice === true ? 1 : 0,
    costingMethod: normalized.costingMethod,
    totalEx,
    totalVat,
    totalInc,
    rawJson: JSON.stringify(normalized),
    normalized,
  };
}

export async function getGoodsReceipts(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const limit = limitFromUrl(new URL(request.url), 500, 1000);
  const rows = await env.DB.prepare(
    `SELECT
        grv.id,
        grv.supplier_id,
        grv.purchase_order_id,
        grv.invoice_number,
        grv.received_at,
        grv.total_ex,
        grv.total_vat,
        grv.total_inc,
        grv.raw_json,
        grv.created_at,
        (
          SELECT ae.actor_uid
            FROM audit_events ae
           WHERE ae.workspace_id = grv.workspace_id
             AND ae.entity_type = 'grv'
             AND ae.entity_id = grv.id
           ORDER BY ae.created_at DESC
           LIMIT 1
        ) AS created_by,
        s.name AS supplier_name
       FROM grvs grv
       LEFT JOIN suppliers s ON s.id = grv.supplier_id AND s.workspace_id = grv.workspace_id
      WHERE grv.workspace_id = ?1
      ORDER BY grv.received_at DESC
      LIMIT ?2`,
  )
    .bind(workspaceId, limit)
    .all();

  const receiptRows = (rows.results || []) as Record<string, unknown>[];
  await attachActorInfo(env, workspaceId, receiptRows);
  const receiptReferences = await resolveTransactionReferences(
    env,
    workspaceId,
    receiptRows,
    "grv",
  );
  const receipts = receiptRows.map((row) => {
    const record = row as Record<string, unknown>;
    const raw = objectValue(jsonParse(record.raw_json));
    return {
      ...raw,
      id: text(record.id),
      transactionReference: text(
        raw.transactionReference ||
          receiptReferences.get(text(record.id)) ||
          historicalTransactionReference(
            "grv",
            text(record.id),
            record.received_at || record.created_at,
          ),
      ),
      grvNumber: text(raw.grvNumber || record.invoice_number),
      invoice: text(raw.invoice || record.invoice_number),
      sourcePoId: text(raw.sourcePoId || record.purchase_order_id),
      supplierId: text(raw.supplierId || record.supplier_id),
      supplierName: text(
        raw.supplierName || record.supplier_name || "Manual Receipt",
      ),
      supplier: text(
        raw.supplier ||
          raw.supplierName ||
          record.supplier_name ||
          "Manual Receipt",
      ),
      date: text(raw.date || record.received_at).slice(0, 10),
      timestamp: text(raw.timestamp || record.received_at || record.created_at),
      createdAt: text(record.created_at),
      totalEx: numberValue(record.total_ex, numberValue(raw.totalEx, 0)),
      totalVat: numberValue(record.total_vat, numberValue(raw.totalVat, 0)),
      totalInc: numberValue(record.total_inc, numberValue(raw.totalInc, 0)),
      createdBy: text(
        raw.createdBy || raw.submittedByUserId || record.created_by,
      ),
      createdByName: text(
        raw.createdByName ||
          raw.submittedByName ||
          record.created_by_name ||
          record.created_by_email ||
          record.created_by,
      ),
      createdByEmail: text(raw.createdByEmail || record.created_by_email),
      submittedByName: text(
        raw.submittedByName ||
          raw.createdByName ||
          record.created_by_name ||
          record.created_by_email ||
          record.created_by,
      ),
      submittedByUserId: text(
        raw.submittedByUserId || raw.createdBy || record.created_by,
      ),
      items: arrayValue(raw.items),
    };
  });
  return json(request, env, { ok: true, receipts });
}

function mergeGoodsReceiptIntoPurchaseOrder(
  orderRaw: Record<string, unknown>,
  receipt: Record<string, unknown>,
) {
  const receiptLines = arrayValue(receipt.items).map(objectValue);
  const orderLines = arrayValue(orderRaw.items).map(objectValue);
  const orderLineIdCounts = countBy(orderLines, (line) =>
    text(line.id || line.purchaseOrderLineId || line.poLineId),
  );
  const orderItemCounts = countBy(orderLines, (line) =>
    text(line.stockItemId || line.ingredientId || line.ingId || line.id),
  );
  const orderItemLocationCounts = countBy(orderLines, (line) => {
    const itemId = text(
      line.stockItemId || line.ingredientId || line.ingId || line.id,
    );
    const locationId = text(line.locationId || line.targetLocation);
    return itemId && locationId ? `${itemId}::${locationId}` : "";
  });
  const receivedByLineId = new Map<string, number>();
  const receivedByItemAndLocation = new Map<string, number>();
  const receivedByItem = new Map<string, number>();

  receiptLines.forEach((line) => {
    const itemId = text(
      line.stockItemId || line.ingredientId || line.ingId || line.id,
    );
    if (!itemId) return;
    const receivedQty = numberValue(line.receivedQty ?? line.qty, 0);
    const lineId = text(
      line.purchaseOrderLineId || line.poLineId || line.orderLineId || line.id,
    );
    const locationId = text(line.locationId || line.targetLocation);

    if (lineId && orderLineIdCounts.get(lineId) === 1) {
      receivedByLineId.set(
        lineId,
        numberValue(receivedByLineId.get(lineId), 0) + receivedQty,
      );
    }
    if (locationId) {
      const compositeKey = `${itemId}::${locationId}`;
      receivedByItemAndLocation.set(
        compositeKey,
        numberValue(receivedByItemAndLocation.get(compositeKey), 0) +
          receivedQty,
      );
    }
    receivedByItem.set(
      itemId,
      numberValue(receivedByItem.get(itemId), 0) + receivedQty,
    );
  });

  const items = orderLines.map((line) => {
    const itemId = text(
      line.stockItemId || line.ingredientId || line.ingId || line.id,
    );
    const lineId = text(line.id || line.purchaseOrderLineId || line.poLineId);
    const locationId = text(line.locationId || line.targetLocation);
    const compositeKey = `${itemId}::${locationId}`;
    const received =
      lineId && receivedByLineId.has(lineId)
        ? numberValue(receivedByLineId.get(lineId), 0)
        : locationId &&
            orderItemLocationCounts.get(compositeKey) === 1 &&
            receivedByItemAndLocation.has(compositeKey)
          ? numberValue(receivedByItemAndLocation.get(compositeKey), 0)
          : orderItemCounts.get(itemId) === 1
            ? numberValue(receivedByItem.get(itemId), 0)
            : 0;
    const qty = numberValue(line.qty ?? line.quantity ?? line.orderQty, 0);
    const receivedQty = numberValue(line.receivedQty, 0) + received;
    return {
      ...line,
      receivedQty,
      remainingQty: Math.max(qty - receivedQty, 0),
    };
  }) as Array<Record<string, unknown>>;
  const anyReceived = items.some(
    (line) => numberValue(line.receivedQty, 0) > 0,
  );
  const allReceived =
    items.length > 0 &&
    items.every(
      (line) =>
        numberValue(line.receivedQty, 0) >=
        numberValue(line.qty ?? line.quantity, 0),
    );
  const status = allReceived
    ? "completed"
    : anyReceived
      ? "partially_received"
      : text(orderRaw.status, "sent");
  const now = nowIso();
  return {
    ...orderRaw,
    status,
    items,
    lastGrvId: text(receipt.id),
    grvId: status === "completed" ? text(receipt.id) : text(orderRaw.grvId),
    receivedAt: status === "completed" ? now : text(orderRaw.receivedAt),
    partiallyReceivedAt:
      status === "partially_received"
        ? now
        : text(orderRaw.partiallyReceivedAt),
    receivedItems: receiptLines,
    receivedHistory: [
      ...arrayValue(orderRaw.receivedHistory),
      {
        grvId: text(receipt.id),
        timestamp: now,
        date: text(receipt.date || receipt.timestamp).slice(0, 10),
        totalEx: numberValue(receipt.totalEx, 0),
        lineCount: receiptLines.length,
      },
    ],
    receivedTotalEx:
      numberValue(orderRaw.receivedTotalEx, 0) +
      numberValue(receipt.totalEx, 0),
    updatedAt: now,
  };
}

export async function postGoodsReceipt(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-grv");
  const payload = normalizeGoodsReceiptPayload(
    await readJson<Record<string, unknown>>(request),
  );
  if (!payload.normalized.items.length)
    return error(request, env, 400, "Add at least one received stock item.");

  const existingReceipt = await env.DB.prepare(
    `SELECT id
       FROM grvs
      WHERE workspace_id = ?1
        AND id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, payload.id)
    .first<{ id: string }>();
  if (existingReceipt?.id) {
    const transactionReference =
      (await getTransactionReference(env, workspaceId, "grv", payload.id)) ||
      historicalTransactionReference("grv", payload.id, payload.receivedAt);
    return json(request, env, {
      ok: true,
      id: payload.id,
      transactionReference,
      duplicate: true,
    });
  }

  const transactionReference = await ensureTransactionReference(
    env,
    workspaceId,
    "grv",
    payload.id,
    payload.receivedAt,
  );
  (payload.normalized as Record<string, unknown>).transactionReference =
    transactionReference;
  payload.rawJson = JSON.stringify(payload.normalized);
  const now = nowIso();
  // The persisted workspace setting is authoritative. Never let a stale or modified
  // browser payload choose the valuation method used by the inventory ledger.
  const costingMethod = await getWorkspaceInventoryCostingMethod(
    env,
    workspaceId,
  );
  const shouldOverrideCostPrice = payload.overrideCostPrice !== 0;
  payload.normalized.costingMethod = costingMethod;
  payload.normalized.overrideCostPrice = shouldOverrideCostPrice;
  payload.rawJson = JSON.stringify(payload.normalized);
  const receivingLocationId = await resolveActiveLocationId(
    env,
    workspaceId,
    text(payload.normalized.locationId || payload.normalized.targetLocation),
  );
  const preserveLineLocations =
    payload.normalized.splitByLocation === true ||
    Boolean(payload.purchaseOrderId);
  if (receivingLocationId)
    await assertLocationAccess(
      env,
      auth,
      workspaceId,
      receivingLocationId,
      "grv",
    );
  if (receivingLocationId) {
    payload.normalized.locationId = receivingLocationId;
    payload.normalized.targetLocation = receivingLocationId;
    payload.normalized.items = payload.normalized.items.map((line) => ({
      ...line,
      locationId: preserveLineLocations
        ? text(line.locationId || line.targetLocation) || receivingLocationId
        : receivingLocationId,
      targetLocation: preserveLineLocations
        ? text(line.targetLocation || line.locationId) || receivingLocationId
        : receivingLocationId,
    }));
    payload.rawJson = JSON.stringify(payload.normalized);
  }
  const statements = [
    env.DB.prepare(
      `INSERT INTO grvs
        (id, workspace_id, supplier_id, purchase_order_id, invoice_number, received_at, prices_include_vat,
         split_by_location, total_ex, total_vat, total_inc, created_by, raw_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    ).bind(
      payload.id,
      workspaceId,
      payload.supplierId,
      payload.purchaseOrderId,
      payload.invoiceNumber,
      payload.receivedAt,
      payload.pricesIncludeVat,
      payload.splitByLocation,
      payload.totalEx,
      payload.totalVat,
      payload.totalInc,
      auth.uid,
      payload.rawJson,
      now,
    ),
  ];

  for (const [index, line] of payload.normalized.items.entries()) {
    const stockItemId = text(line.stockItemId);
    const locationId = await resolveActiveLocationId(
      env,
      workspaceId,
      text(line.locationId || line.targetLocation) || receivingLocationId,
    );
    if (!locationId)
      return error(
        request,
        env,
        400,
        `${text(line.stockItemName || stockItemId)} needs a receiving location.`,
      );
    const stockItem = await env.DB.prepare(
      `SELECT id, name, unit, unit_cost, raw_json
	         FROM stock_items
	        WHERE workspace_id = ?1
	          AND id = ?2
	          AND active = 1
	          AND ${STOCKED_ITEM_SQL}
	        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId)
      .first<Record<string, unknown>>();
    if (!stockItem)
      return error(
        request,
        env,
        404,
        `${text(line.stockItemName || stockItemId)} could not be found.`,
      );

    const currentBalance = await env.DB.prepare(
      `SELECT quantity
         FROM stock_balances
        WHERE workspace_id = ?1
          AND stock_item_id = ?2
          AND location_id = ?3
        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId, locationId)
      .first<{ quantity: number }>();
    const before = numberValue(currentBalance?.quantity, 0);
    const quantity = numberValue(
      line.baseQuantity,
      numberValue(line.receivedQty, 0),
    );
    const previousCost = (
      await resolveLocationUnitCost(
        env,
        workspaceId,
        stockItemId,
        locationId,
        stockItem,
      )
    ).cost;
    const unitCost = numberValue(line.unitCost ?? previousCost, previousCost);
    const nextLocationCost = calculateIncomingLocationCost({
      method: costingMethod,
      previousQuantity: before,
      previousUnitCost: previousCost,
      incomingQuantity: quantity,
      incomingUnitCost: unitCost,
    });
    const totalEx = numberValue(line.lineTotalEx, quantity * unitCost);
    const totalVat = totalEx * 0.15;
    const metadata = JSON.stringify({
      before,
      after: before + quantity,
      grvId: payload.id,
      costingMethod,
      overrideCostPrice: shouldOverrideCostPrice,
      previousCost,
      receivedUnitCost: unitCost,
      nextCost: shouldOverrideCostPrice ? nextLocationCost : previousCost,
    });
    const grvLineId = id("grvl");

    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = stock_balances.quantity + ?4,
          updated_at = excluded.updated_at`,
      ).bind(workspaceId, stockItemId, locationId, quantity, now),
      env.DB.prepare(
        `INSERT INTO grv_lines (id, workspace_id, grv_id, stock_item_id, location_id, quantity, unit, unit_price, total_ex, total_vat, total_inc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(
        grvLineId,
        workspaceId,
        payload.id,
        stockItemId,
        locationId,
        quantity,
        text(line.unit || stockItem.unit),
        unitCost,
        totalEx,
        totalVat,
        totalEx + totalVat,
      ),
      env.DB.prepare(
        `INSERT INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
           destination_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'grv_in', 'grv', ?5, ?4, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        id("move"),
        workspaceId,
        stockItemId,
        locationId,
        payload.id,
        quantity,
        unitCost,
        totalEx,
        payload.receivedAt,
        auth.uid,
        metadata,
        now,
      ),
    );

    if (shouldOverrideCostPrice) {
      // GRV cost overrides are location-specific. Do not update stock_items.unit_cost here,
      // because that master fallback cost is shared by every location and makes one GRV
      // look like it changed costing everywhere. Location/reporting costs must come from
      // stock_item_location_prices keyed by workspace + stock item + location.
      statements.push(
        upsertLocationCostStatement(
          env,
          workspaceId,
          stockItemId,
          locationId,
          nextLocationCost,
          now,
        ),
      );
    }
  }

  if (payload.purchaseOrderId) {
    const po = await env.DB.prepare(
      `SELECT raw_json
         FROM purchase_orders
        WHERE workspace_id = ?1
          AND id = ?2
        LIMIT 1`,
    )
      .bind(workspaceId, payload.purchaseOrderId)
      .first<Record<string, unknown>>();
    if (po) {
      const nextPo = mergeGoodsReceiptIntoPurchaseOrder(
        objectValue(jsonParse(po.raw_json)),
        payload.normalized,
      );
      statements.push(
        env.DB.prepare(
          `UPDATE purchase_orders
            SET status = ?3,
                raw_json = ?4,
                updated_at = ?5
          WHERE workspace_id = ?1
            AND id = ?2`,
        ).bind(
          workspaceId,
          payload.purchaseOrderId,
          text(nextPo.status),
          JSON.stringify(nextPo),
          now,
        ),
      );
    }
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
     VALUES (?1, ?2, ?3, 'grv_saved', 'grv', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      payload.id,
      payload.rawJson,
      now,
    ),
  );

  await env.DB.batch(statements);
  return json(request, env, { ok: true, id: payload.id, transactionReference });
}

function normalizeCreditNotePayload(raw: Record<string, unknown>) {
  const note = objectValue(raw.creditNote || raw.note || raw);
  const creditNoteId = text(note.id) || id("cn");
  const date = text(note.date || note.timestamp || note.creditedAt) || nowIso();
  const locationId = text(note.locationId || note.targetLocation);
  const items = arrayValue(note.items)
    .map(objectValue)
    .map((line) => {
      const packSize = Math.max(
        numberValue(line.packSize ?? line.pack_size, 1),
        1,
      );
      const rawReturnedQty = numberValue(
        line.returnedQty ??
          line.packQty ??
          line.receivedQty ??
          line.quantity ??
          line.qty,
        0,
      );
      const returnedQty =
        rawReturnedQty > 0
          ? rawReturnedQty
          : numberValue(line.baseQuantity, 0) / packSize;
      const hasBaseQuantity =
        line.baseQuantity !== undefined &&
        line.baseQuantity !== null &&
        text(line.baseQuantity) !== "";
      const baseQuantity = hasBaseQuantity
        ? numberValue(line.baseQuantity, returnedQty * packSize)
        : returnedQty * packSize;
      const unitCost = numberValue(
        line.unitCost ?? line.costEx ?? line.cost ?? line.price,
        0,
      );
      const hasLineTotalEx =
        line.lineTotalEx !== undefined &&
        line.lineTotalEx !== null &&
        text(line.lineTotalEx) !== "";
      const lineTotalEx = hasLineTotalEx
        ? numberValue(line.lineTotalEx, baseQuantity * unitCost)
        : baseQuantity * unitCost;
      const baseUom = text(line.unit || line.uom, "ea") || "ea";
      const selectedUom =
        text(
          line.selectedUom ||
            line.returnUom ||
            line.receivingUom ||
            line.purchaseUom ||
            baseUom,
          baseUom,
        ) || baseUom;
      return {
        ...line,
        id: text(line.id) || id("cnl"),
        stockItemId: text(
          line.stockItemId ||
            line.ingredientId ||
            line.ingId ||
            line.itemId ||
            line.id,
        ),
        stockItemName: text(
          line.stockItemName ||
            line.ingredientName ||
            line.name ||
            line.itemName,
        ),
        locationId: text(line.locationId || line.targetLocation || locationId),
        locationName: text(
          line.locationName || line.targetLocationName || note.locationName,
        ),
        unit: baseUom,
        selectedUom,
        returnUom: selectedUom,
        uomConfigurations: normalizeUomConfigurations(
          line.uomConfigurations || line.uomConfig || line.uomConversions,
        ),
        returnedQty,
        packQty: returnedQty,
        originalOrderQty: numberValue(line.originalOrderQty ?? line.maxReturnQty, 0),
        maxReturnQty: numberValue(line.maxReturnQty ?? line.originalOrderQty, 0),
        packSize,
        baseQuantity,
        unitCost,
        lineTotalEx,
      };
    })
    .filter(
      (line) => text(line.stockItemId) && numberValue(line.baseQuantity, 0) > 0,
    );
  const totalEx = items.reduce(
    (sum, line) => sum + numberValue(line.lineTotalEx, 0),
    0,
  );
  const normalized = {
    ...note,
    id: creditNoteId,
    cnNumber:
      text(note.cnNumber || note.number || note.invoice) ||
      `CN-${creditNoteId.slice(-6).toUpperCase()}`,
    number:
      text(note.cnNumber || note.number || note.invoice) ||
      `CN-${creditNoteId.slice(-6).toUpperCase()}`,
    invoice:
      text(note.invoice || note.cnNumber || note.number) ||
      `CN-${creditNoteId.slice(-6).toUpperCase()}`,
    supplierId: text(note.supplierId),
    supplierName: text(note.supplierName || note.supplier),
    date: date.slice(0, 10),
    timestamp: date.length <= 10 ? `${date}T00:00:00.000Z` : date,
    locationId,
    locationName: text(note.locationName),
    sourcePoId: text(note.sourcePoId || note.purchaseOrderId || note.poId),
    notes: text(note.notes || note.reason),
    pricesIncludeVat: note.pricesIncludeVat === true,
    totalEx,
    lineCount: items.length,
    items,
    type: "SUPPLIER_CREDIT_NOTE",
  };
  return {
    id: creditNoteId,
    supplierId: normalized.supplierId || null,
    creditNoteNumber: normalized.cnNumber,
    creditedAt: normalized.timestamp,
    locationId: normalized.locationId || null,
    reason: normalized.notes,
    pricesIncludeVat: normalized.pricesIncludeVat ? 1 : 0,
    totalEx,
    rawJson: JSON.stringify(normalized),
    normalized,
  };
}

export async function getCreditNotes(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const limit = limitFromUrl(new URL(request.url), 500, 1000);
  const rows = await env.DB.prepare(
    `SELECT
        cn.id,
        cn.supplier_id,
        cn.credit_note_number,
        cn.credited_at,
        cn.location_id,
        cn.reason,
        cn.total_ex,
        cn.prices_include_vat,
        cn.raw_json,
        cn.created_at,
        cn.created_by,
        s.name AS supplier_name,
        l.name AS location_name,
        l.display_name AS location_display_name
       FROM credit_notes cn
       LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.workspace_id = cn.workspace_id
       LEFT JOIN locations l ON l.id = cn.location_id AND l.workspace_id = cn.workspace_id
      WHERE cn.workspace_id = ?1
      ORDER BY cn.credited_at DESC
      LIMIT ?2`,
  )
    .bind(workspaceId, limit)
    .all();

  const creditRows = (rows.results || []) as Record<string, unknown>[];
  await attachActorInfo(env, workspaceId, creditRows);
  const creditReferences = await resolveTransactionReferences(
    env,
    workspaceId,
    creditRows,
    "credit_note",
  );

  const creditNotes = creditRows.map((row) => {
    const record = row as Record<string, unknown>;
    const raw = objectValue(jsonParse(record.raw_json));
    return {
      ...raw,
      id: text(record.id),
      transactionReference: text(
        raw.transactionReference ||
          creditReferences.get(text(record.id)) ||
          historicalTransactionReference(
            "credit_note",
            text(record.id),
            record.credited_at || record.created_at,
          ),
      ),
      cnNumber: text(raw.cnNumber || record.credit_note_number),
      number: text(raw.number || raw.cnNumber || record.credit_note_number),
      invoice: text(raw.invoice || raw.cnNumber || record.credit_note_number),
      supplierId: text(raw.supplierId || record.supplier_id),
      supplierName: text(raw.supplierName || record.supplier_name),
      supplier: text(raw.supplier || raw.supplierName || record.supplier_name),
      date: text(raw.date || record.credited_at).slice(0, 10),
      timestamp: text(raw.timestamp || record.credited_at || record.created_at),
      createdAt: text(record.created_at),
      locationId: text(raw.locationId || record.location_id),
      locationName: text(
        raw.locationName ||
          record.location_display_name ||
          record.location_name,
      ),
      notes: text(raw.notes || record.reason),
      totalEx: numberValue(record.total_ex, numberValue(raw.totalEx, 0)),
      pricesIncludeVat:
        raw.pricesIncludeVat === true || record.prices_include_vat === 1,
      createdBy: text(raw.createdBy || record.created_by),
      createdByName: text(
        raw.createdByName ||
          record.created_by_name ||
          record.created_by_email ||
          record.created_by,
      ),
      createdByEmail: text(raw.createdByEmail || record.created_by_email),
      items: arrayValue(raw.items),
      type: "SUPPLIER_CREDIT_NOTE",
    };
  });
  return json(request, env, { ok: true, creditNotes });
}

export async function postCreditNote(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-credit-note");
  const payload = normalizeCreditNotePayload(
    await readJson<Record<string, unknown>>(request),
  );
  if (!payload.normalized.items.length)
    return error(
      request,
      env,
      400,
      "Add at least one stock item to the credit note.",
    );
  if (!payload.normalized.supplierName)
    return error(request, env, 400, "Supplier name is required.");
  if (!payload.creditNoteNumber)
    return error(request, env, 400, "Credit note number is required.");
  if (!payload.reason)
    return error(
      request,
      env,
      400,
      "Reasoning is required before saving the credit note.",
    );

  // Guard against re-committing the same credit note: the per-line balance deduction and
  // movement inserts are not idempotent, so re-saving would deduct stock again and create
  // duplicate movements. Mirrors the GRV / stock-take early-return on an existing record.
  const existingCreditNote = await env.DB.prepare(
    `SELECT id FROM credit_notes WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`,
  )
    .bind(workspaceId, payload.id)
    .first<{ id: string }>();
  if (existingCreditNote) {
    // Now that the frontend sends a stable id (reset only after a successful save), an existing
    // row means this exact credit note already committed — treat a retry as an idempotent success.
    const transactionReference =
      (await getTransactionReference(
        env,
        workspaceId,
        "credit_note",
        payload.id,
      )) ||
      historicalTransactionReference(
        "credit_note",
        payload.id,
        payload.creditedAt,
      );
    return json(request, env, {
      ok: true,
      id: payload.id,
      transactionReference,
      duplicate: true,
    });
  }

  const sourcePoId = text(payload.normalized.sourcePoId);
  if (sourcePoId) {
    const requestedByStockItem = new Map<string, { quantity: number; name: string; fallbackMaximum: number }>();
    for (const line of payload.normalized.items) {
      const stockItemId = text(line.stockItemId);
      if (!stockItemId) continue;
      const current = requestedByStockItem.get(stockItemId) || { quantity: 0, name: text(line.stockItemName || stockItemId), fallbackMaximum: 0 };
      current.quantity += numberValue(line.returnedQty ?? line.packQty, 0);
      current.fallbackMaximum += numberValue(line.maxReturnQty ?? line.originalOrderQty, 0);
      requestedByStockItem.set(stockItemId, current);
    }

    // Include earlier credit notes for this PO so several smaller returns cannot cumulatively
    // exceed the original ordered quantity. The current credit note id is excluded so retries
    // remain idempotent and do not count themselves twice.
    const priorCreditRows = await env.DB.prepare(
      `SELECT raw_json
         FROM credit_notes
        WHERE workspace_id = ?1
          AND id <> ?2
          AND json_valid(raw_json) = 1
          AND COALESCE(json_extract(raw_json, '$.sourcePoId'), '') = ?3`,
    )
      .bind(workspaceId, payload.id, sourcePoId)
      .all<{ raw_json: string }>();
    const previouslyReturnedByStockItem = new Map<string, number>();
    for (const row of priorCreditRows.results || []) {
      const prior = objectValue(jsonParse(row.raw_json));
      for (const line of arrayValue(prior.items).map(objectValue)) {
        const stockItemId = text(line.stockItemId || line.itemId || line.id);
        if (!stockItemId) continue;
        const quantity = numberValue(line.returnedQty ?? line.packQty ?? line.quantity, 0);
        previouslyReturnedByStockItem.set(
          stockItemId,
          (previouslyReturnedByStockItem.get(stockItemId) || 0) + quantity,
        );
      }
    }

    for (const [stockItemId, requested] of requestedByStockItem.entries()) {
      const ordered = await env.DB.prepare(
        `SELECT SUM(quantity) AS quantity
           FROM purchase_order_lines
          WHERE workspace_id = ?1
            AND purchase_order_id = ?2
            AND stock_item_id = ?3`,
      )
        .bind(workspaceId, sourcePoId, stockItemId)
        .first<{ quantity: number }>();
      const originalQuantity = numberValue(ordered?.quantity, requested.fallbackMaximum);
      const previouslyReturned = previouslyReturnedByStockItem.get(stockItemId) || 0;
      const cumulativeReturn = previouslyReturned + requested.quantity;
      if (originalQuantity > 0 && cumulativeReturn > originalQuantity + 0.000001) {
        const remainingQuantity = Math.max(originalQuantity - previouslyReturned, 0);
        return error(
          request,
          env,
          409,
          `${requested.name} cannot return more than the original purchase order quantity of ${formatQuantity(originalQuantity)}. ${formatQuantity(remainingQuantity)} remains available to return.`,
        );
      }
    }
  }

  const transactionReference = await ensureTransactionReference(
    env,
    workspaceId,
    "credit_note",
    payload.id,
    payload.creditedAt,
  );
  (payload.normalized as Record<string, unknown>).transactionReference =
    transactionReference;
  const now = nowIso();
  const headerLocationId =
    (await resolveActiveLocationId(
      env,
      workspaceId,
      payload.locationId || "",
    )) || null;
  if (headerLocationId)
    await assertLocationAccess(
      env,
      auth,
      workspaceId,
      headerLocationId,
      "credit_note",
    );
  const actor = await env.CENTRAL_DB.prepare(
    `SELECT display_name, email
       FROM workspace_members
      WHERE workspace_id = ?1
        AND auth_uid = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, auth.uid)
    .first<Record<string, unknown>>();
  const actorName = text(
    actor?.display_name || actor?.email || auth.email || auth.uid,
  );
  const rawForStorage = JSON.stringify({
    ...payload.normalized,
    createdBy: auth.uid,
    createdByName: actorName,
    createdByEmail: text(actor?.email || auth.email),
  });
  const statements = [
    env.DB.prepare(
      `INSERT INTO credit_notes
        (id, workspace_id, supplier_id, credit_note_number, credited_at, location_id, reason,
         total_ex, prices_include_vat, created_by, raw_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
       ON CONFLICT(id) DO UPDATE SET
        supplier_id = excluded.supplier_id,
        credit_note_number = excluded.credit_note_number,
        credited_at = excluded.credited_at,
        location_id = excluded.location_id,
        reason = excluded.reason,
        total_ex = excluded.total_ex,
        prices_include_vat = excluded.prices_include_vat,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`,
    ).bind(
      payload.id,
      workspaceId,
      payload.supplierId,
      payload.creditNoteNumber,
      payload.creditedAt,
      headerLocationId,
      payload.reason,
      payload.totalEx,
      payload.pricesIncludeVat,
      auth.uid,
      rawForStorage,
      now,
    ),
    env.DB.prepare(
      `DELETE FROM credit_note_lines
        WHERE workspace_id = ?1
          AND credit_note_id = ?2`,
    ).bind(workspaceId, payload.id),
  ];

  for (const [index, line] of payload.normalized.items.entries()) {
    const stockItemId = text(line.stockItemId);
    const locationId = await resolveActiveLocationId(
      env,
      workspaceId,
      text(line.locationId) || payload.normalized.locationId,
    );
    if (!locationId)
      return error(
        request,
        env,
        400,
        `${text(line.stockItemName || stockItemId)} needs a location.`,
      );

    const stockItem = await env.DB.prepare(
      `SELECT id, name, unit, unit_cost, raw_json
	         FROM stock_items
	        WHERE workspace_id = ?1
	          AND id = ?2
	          AND active = 1
	          AND ${STOCKED_ITEM_SQL}
	        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId)
      .first<Record<string, unknown>>();
    if (!stockItem)
      return error(
        request,
        env,
        404,
        `${text(line.stockItemName || stockItemId)} could not be found.`,
      );

    const currentBalance = await env.DB.prepare(
      `SELECT quantity
         FROM stock_balances
        WHERE workspace_id = ?1
          AND stock_item_id = ?2
          AND location_id = ?3
        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId, locationId)
      .first<{ quantity: number }>();

    const before = numberValue(currentBalance?.quantity, 0);
    const quantity = numberValue(line.baseQuantity, 0);
    const fallbackCost = (
      await resolveLocationUnitCost(
        env,
        workspaceId,
        stockItemId,
        locationId,
        stockItem,
      )
    ).cost;
    const hasExplicitLineCost =
      line.unitCost !== undefined &&
      line.unitCost !== null &&
      text(line.unitCost) !== "";
    const unitCost = hasExplicitLineCost
      ? numberValue(line.unitCost, fallbackCost)
      : fallbackCost;
    const hasLineTotalEx =
      line.lineTotalEx !== undefined &&
      line.lineTotalEx !== null &&
      text(line.lineTotalEx) !== "";
    const totalEx = hasLineTotalEx
      ? numberValue(line.lineTotalEx, quantity * unitCost)
      : quantity * unitCost;
    const after = before - quantity;
    // Zero-floor: a credit note returns stock to the supplier, so you cannot credit more than is
    // on hand at the location. Block rather than silently drive the balance negative (consistent
    // with the adjustment / manufacturing insufficient-stock guards).
    if (after < 0) {
      return error(
        request,
        env,
        409,
        `${text(stockItem.name)} does not have enough stock at the selected location to credit ${formatQuantity(quantity)} ${text(stockItem.unit)}. Available: ${formatQuantity(before)} ${text(stockItem.unit)}.`,
      );
    }
    const metadata = JSON.stringify({
      before,
      after,
      creditNoteId: payload.id,
    });
    const lineKey =
      text(line.id || stockItemId || `line_${index}`)
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .slice(0, 80) || `line_${index}`;
    const creditNoteLineId = `${payload.id}:line:${index}:${lineKey}`;

    statements.push(
      env.DB.prepare(
        // Deduct consistently on both new-row and existing-row (bind the negative delta) —
        // previously a missing balance row inserted +quantity (added stock instead of removing).
        `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = stock_balances.quantity + ?4,
          updated_at = excluded.updated_at`,
      ).bind(workspaceId, stockItemId, locationId, -quantity, now),
      env.DB.prepare(
        `INSERT INTO credit_note_lines (id, workspace_id, credit_note_id, stock_item_id, location_id, quantity, unit, unit_cost, total_ex)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        creditNoteLineId,
        workspaceId,
        payload.id,
        stockItemId,
        locationId,
        quantity,
        text(line.unit || stockItem.unit),
        unitCost,
        totalEx,
      ),
      env.DB.prepare(
        `INSERT INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
           source_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'credit_note_out', 'credit_note', ?5, ?4, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        id("move"),
        workspaceId,
        stockItemId,
        locationId,
        payload.id,
        -quantity,
        unitCost,
        -totalEx,
        payload.creditedAt,
        auth.uid,
        metadata,
        now,
      ),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
     VALUES (?1, ?2, ?3, 'credit_note_saved', 'credit_note', ?4, ?5, ?6)`,
    ).bind(id("audit"), workspaceId, auth.uid, payload.id, rawForStorage, now),
  );

  await env.DB.batch(statements);
  return json(request, env, { ok: true, id: payload.id, transactionReference });
}

function normalizeStockTakeTemplatePayload(raw: Record<string, unknown>) {
  const template = objectValue(raw.template || raw);
  const templateId = text(template.id) || id("stt");
  const targetLocations = [
    text(template.targetLocation || template.locationId),
    ...arrayValue(
      template.targetLocations || template.locations || template.locationIds,
    ).map((entry) => text(entry)),
  ].filter(Boolean);
  const selections = arrayValue(template.selections)
    .map((entry) => text(entry))
    .filter(Boolean);
  const normalized = {
    ...template,
    id: templateId,
    name: text(template.name),
    siteId: text(template.siteId),
    siteName: text(template.siteName),
    targetLocation: targetLocations[0] || "",
    targetLocations: [...new Set(targetLocations)],
    scope: text(template.scope, "category") === "items" ? "items" : "category",
    selections,
  };
  return {
    id: templateId,
    name: normalized.name,
    locationId: normalized.targetLocation || null,
    rawJson: JSON.stringify(normalized),
    normalized,
  };
}

export async function getStockTakes(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const limit = limitFromUrl(new URL(request.url), 500, 1000);
  const rows = await env.DB.prepare(
    `SELECT
        sts.id,
        sts.stocktake_template_id,
        sts.location_id,
        sts.status,
        sts.counted_at,
        sts.created_by,
        sts.raw_json,
        sts.created_at,
        sts.updated_at,
        l.name AS location_name,
        l.display_name AS location_display_name
       FROM stocktake_sessions sts
       LEFT JOIN locations l ON l.id = sts.location_id AND l.workspace_id = sts.workspace_id
      WHERE sts.workspace_id = ?1
        AND sts.status = 'posted'
      ORDER BY sts.counted_at DESC, sts.updated_at DESC
      LIMIT ?2`,
  )
    .bind(workspaceId, limit)
    .all();

  const stockTakeRows = (rows.results || []) as Record<string, unknown>[];
  await attachActorInfo(env, workspaceId, stockTakeRows);
  const stockTakeReferences = await resolveTransactionReferences(
    env,
    workspaceId,
    stockTakeRows,
    "stock_take",
  );

  const stockTakes = stockTakeRows.map((row) => {
    const record = row as Record<string, unknown>;
    const raw = objectValue(jsonParse(record.raw_json));
    return {
      ...raw,
      id: text(record.id),
      transactionReference: text(
        raw.transactionReference ||
          stockTakeReferences.get(text(record.id)) ||
          historicalTransactionReference(
            "stock_take",
            text(record.id),
            record.counted_at || record.created_at,
          ),
      ),
      templateId: text(raw.templateId || record.stocktake_template_id),
      locationId: text(raw.locationId || record.location_id),
      locationName: text(
        raw.locationName ||
          record.location_display_name ||
          record.location_name,
      ),
      timestamp: text(raw.timestamp || record.counted_at || record.created_at),
      date: text(raw.date || record.counted_at).slice(0, 10),
      createdBy: text(raw.createdBy || record.created_by),
      createdByName: text(
        raw.createdByName ||
          record.created_by_name ||
          record.created_by_email ||
          record.created_by,
      ),
      createdByEmail: text(raw.createdByEmail || record.created_by_email),
      user: text(
        raw.user ||
          raw.createdByName ||
          record.created_by_name ||
          record.created_by_email ||
          record.created_by,
      ),
      items: arrayValue(raw.items),
    };
  });
  return json(request, env, { ok: true, stockTakes });
}

export async function getStockTakeTemplates(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const rows = await env.DB.prepare(
    `SELECT id, name, location_id, raw_json, created_at, updated_at
       FROM stocktake_templates
      WHERE workspace_id = ?1
        AND active = 1
      ORDER BY lower(name) ASC`,
  )
    .bind(workspaceId)
    .all();
  const templates = (rows.results || []).map((row) => {
    const record = row as Record<string, unknown>;
    const raw = objectValue(jsonParse(record.raw_json));
    return {
      ...raw,
      id: text(record.id),
      name: text(raw.name || record.name),
      targetLocation: text(raw.targetLocation || record.location_id),
      targetLocations: arrayValue(raw.targetLocations).length
        ? arrayValue(raw.targetLocations)
        : [text(record.location_id)].filter(Boolean),
      createdAt: text(record.created_at),
      updatedAt: text(record.updated_at),
    };
  });
  return json(request, env, { ok: true, templates });
}

export async function postStockTakeTemplate(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = normalizeStockTakeTemplatePayload(
    await readJson<Record<string, unknown>>(request),
  );
  if (!payload.name) return error(request, env, 400, "Enter a template name.");
  if (!payload.normalized.targetLocations.length)
    return error(request, env, 400, "Choose at least one target location.");
  if (!payload.normalized.selections.length)
    return error(
      request,
      env,
      400,
      "Select at least one category or stock item.",
    );
  if (payload.normalized.scope === "items") {
    const requestedSelections = payload.normalized.selections;
    const placeholders = requestedSelections
      .map((_, index) => `?${index + 2}`)
      .join(", ");
    const rows = await env.DB.prepare(
      `SELECT id
         FROM stock_items si
        WHERE si.workspace_id = ?1
          AND si.active = 1
          AND ${STOCKED_ITEM_ALIAS_SQL("si")}
          AND si.id IN (${placeholders})`,
    )
      .bind(workspaceId, ...requestedSelections)
      .all<{ id: string }>();
    const allowed = new Set(
      (rows.results || []).map((row) => text(row.id)).filter(Boolean),
    );
    payload.normalized.selections = requestedSelections.filter((selection) =>
      allowed.has(selection),
    );
    if (!payload.normalized.selections.length)
      return error(
        request,
        env,
        400,
        "Select at least one countable stock item.",
      );
    payload.rawJson = JSON.stringify(payload.normalized);
  }

  const now = nowIso();
  const statements = [
    env.DB.prepare(
      `INSERT INTO stocktake_templates (id, workspace_id, name, location_id, active, raw_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?6)
       ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        location_id = excluded.location_id,
        active = 1,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`,
    ).bind(
      payload.id,
      workspaceId,
      payload.name,
      payload.locationId,
      payload.rawJson,
      now,
    ),
    env.DB.prepare(
      `DELETE FROM stocktake_template_lines
        WHERE workspace_id = ?1
          AND stocktake_template_id = ?2`,
    ).bind(workspaceId, payload.id),
  ];

  payload.normalized.selections.forEach((selection, index) => {
    if (payload.normalized.scope !== "items") return;
    statements.push(
      env.DB.prepare(
        `INSERT INTO stocktake_template_lines (id, workspace_id, stocktake_template_id, stock_item_id, sort_order)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(id("sttl"), workspaceId, payload.id, selection, index),
    );
  });

  await env.DB.batch(statements);
  return json(request, env, {
    ok: true,
    id: payload.id,
    template: payload.normalized,
  });
}

export async function deleteStockTakeTemplateRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  templateId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await env.DB.prepare(
    `UPDATE stocktake_templates
        SET active = 0,
            updated_at = ?3
      WHERE workspace_id = ?1
        AND id = ?2`,
  )
    .bind(workspaceId, text(templateId), nowIso())
    .run();
  return json(request, env, { ok: true, id: text(templateId) });
}

function normalizeStockTakeUomCounts(value: unknown) {
  const rows = Array.isArray(value) ? value : Object.values(objectValue(value));
  return rows
    .map(objectValue)
    .map((row) => {
      const ratio = numberValue(
        row.ratio ?? row.qtyInBase ?? row.qty_in_base ?? row.packSize,
        1,
      );
      const count = numberValue(row.count ?? row.scannedCount ?? row.qty, 0);
      const safeRatio = ratio > 0 ? ratio : 1;
      const uomName = text(row.uomName || row.selectedUom || row.unit);
      return {
        key: text(row.key || `${uomName.toLowerCase()}::${safeRatio}`),
        uomName,
        baseUom: text(row.baseUom || row.baseUnit),
        ratio: safeRatio,
        count,
        scans: numberValue(row.scans ?? count, 0),
        lastBarcode: text(row.lastBarcode || row.barcode),
      };
    })
    .filter((row) => row.uomName && row.count > 0);
}

export async function postStockTake(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-stock-count");
  const body = await readJson<Record<string, unknown>>(request);
  const draft = objectValue(body.stockTake || body);
  const requestedSessionId = text(draft.id);
  if (requestedSessionId) {
    const existingSession = await env.DB.prepare(
      `SELECT id
         FROM stocktake_sessions
        WHERE workspace_id = ?1
          AND id = ?2
          AND status = 'posted'
        LIMIT 1`,
    )
      .bind(workspaceId, requestedSessionId)
      .first<{ id: string }>();
    if (existingSession?.id) {
      const transactionReference =
        (await getTransactionReference(
          env,
          workspaceId,
          "stock_take",
          requestedSessionId,
        )) ||
        historicalTransactionReference(
          "stock_take",
          requestedSessionId,
          nowIso(),
        );
      return json(request, env, {
        ok: true,
        id: requestedSessionId,
        transactionReference,
        duplicate: true,
        skipped: true,
      });
    }
  }
  const requestedLocationId = text(
    draft.locationId ||
      draft.targetLocation ||
      draft.locationName ||
      draft.targetLocationName,
  );
  const locationId = await resolveActiveLocationId(
    env,
    workspaceId,
    requestedLocationId,
  );
  const requestedTemplateId = text(draft.templateId);
  let templateId: string | null = null;
  if (requestedTemplateId) {
    const template = await env.DB.prepare(
      `SELECT id
         FROM stocktake_templates
        WHERE workspace_id = ?1
          AND id = ?2
        LIMIT 1`,
    )
      .bind(workspaceId, requestedTemplateId)
      .first<{ id: string }>();
    templateId = template?.id || null;
  }
  const items = arrayValue(draft.items)
    .map(objectValue)
    .map((line) => ({
      stockItemId: text(
        line.stockItemId || line.itemId || line.ingId || line.id,
      ),
      shelfCount: numberValue(
        line.shelfCount ?? line.countedQty ?? line.count,
        NaN,
      ),
      unit: text(line.unit),
      selectedUom: text(line.selectedUom),
      uomCounts: normalizeStockTakeUomCounts(
        line.uomCounts || line.countBreakdown || line.scanBreakdown,
      ),
      scanBreakdown: normalizeStockTakeUomCounts(
        line.scanBreakdown || line.countBreakdown || line.uomCounts,
      ),
    }))
    .filter(
      (line) =>
        line.stockItemId &&
        Number.isFinite(line.shelfCount) &&
        line.shelfCount >= 0,
    );
  if (!locationId)
    return error(request, env, 400, "Select an active stock take location.");
  await assertLocationAccess(env, auth, workspaceId, locationId, "stock_take");
  if (!items.length)
    return error(request, env, 400, "Enter at least one shelf count first.");

  const sessionId = requestedSessionId || id("st");
  const countedAt = text(draft.date)
    ? new Date(`${text(draft.date)}T00:00:00.000Z`).toISOString()
    : nowIso();
  const transactionReference = await ensureTransactionReference(
    env,
    workspaceId,
    "stock_take",
    sessionId,
    countedAt,
  );
  const now = nowIso();
  const countedItems: Array<Record<string, unknown>> = [];
  const statements = [
    env.DB.prepare(
      `INSERT INTO stocktake_sessions
        (id, workspace_id, stocktake_template_id, location_id, status, counted_at, created_by, raw_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'posted', ?5, ?6, '{}', ?7, ?7)
       ON CONFLICT(id) DO UPDATE SET
        status = 'posted',
        counted_at = excluded.counted_at,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`,
    ).bind(
      sessionId,
      workspaceId,
      templateId,
      locationId,
      countedAt,
      auth.uid,
      now,
    ),
  ];

  for (const line of items) {
    const stockItem = await env.DB.prepare(
      `SELECT id, name, unit, unit_cost, raw_json
	         FROM stock_items
	        WHERE workspace_id = ?1
	          AND id = ?2
	          AND active = 1
	          AND ${STOCKED_ITEM_SQL}
	        LIMIT 1`,
    )
      .bind(workspaceId, line.stockItemId)
      .first<Record<string, unknown>>();
    if (!stockItem) continue;

    const currentBalance = await env.DB.prepare(
      `SELECT quantity
         FROM stock_balances
        WHERE workspace_id = ?1
          AND stock_item_id = ?2
          AND location_id = ?3
        LIMIT 1`,
    )
      .bind(workspaceId, line.stockItemId, locationId)
      .first<{ quantity: number }>();
    const systemStock = numberValue(currentBalance?.quantity, 0);
    const shelfCount = numberValue(line.shelfCount, 0);
    const variance = shelfCount - systemStock;
    const unitCost = (
      await resolveLocationUnitCost(
        env,
        workspaceId,
        line.stockItemId,
        locationId,
        stockItem,
      )
    ).cost;
    const countedLine = {
      id: text(stockItem.id),
      stockItemId: text(stockItem.id),
      name: text(stockItem.name),
      stockItemName: text(stockItem.name),
      systemStock,
      shelfCount,
      variance,
      unit: text(stockItem.unit || line.unit),
      cost: unitCost,
      varianceImpactEx: variance * unitCost,
      selectedUom: line.selectedUom,
      uomCounts: line.uomCounts,
      scanBreakdown: line.scanBreakdown,
    };
    countedItems.push(countedLine);
    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = excluded.quantity,
          updated_at = excluded.updated_at`,
      ).bind(workspaceId, line.stockItemId, locationId, shelfCount, now),
      env.DB.prepare(
        `INSERT INTO stocktake_count_lines (id, workspace_id, stocktake_session_id, stock_item_id, location_id, expected_qty, counted_qty, variance_qty, unit_cost)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        id("stcl"),
        workspaceId,
        sessionId,
        line.stockItemId,
        locationId,
        systemStock,
        shelfCount,
        variance,
        unitCost,
      ),
      env.DB.prepare(
        `INSERT INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
           quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'stock_take_variance', 'stock_take', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        id("move"),
        workspaceId,
        line.stockItemId,
        locationId,
        sessionId,
        variance,
        unitCost,
        variance * unitCost,
        countedAt,
        auth.uid,
        JSON.stringify({
          systemStock,
          shelfCount,
          ...(line.uomCounts.length ? { uomCounts: line.uomCounts } : {}),
          ...(line.scanBreakdown.length
            ? { scanBreakdown: line.scanBreakdown }
            : {}),
        }),
        now,
      ),
    );
  }

  if (!countedItems.length)
    return error(request, env, 400, "No valid counted lines were found.");

  const location = await env.DB.prepare(
    `SELECT name, display_name
       FROM locations
      WHERE workspace_id = ?1
        AND id = ?2
      LIMIT 1`,
  )
    .bind(workspaceId, locationId)
    .first<Record<string, unknown>>();
  const actor = await env.CENTRAL_DB.prepare(
    `SELECT
        COALESCE(wm.display_name, au.display_name) AS display_name,
        COALESCE(wm.email, au.email) AS email
       FROM (SELECT ?2 AS created_by) actor
       LEFT JOIN workspace_members wm ON wm.workspace_id = ?1
        AND (wm.auth_uid = actor.created_by OR lower(wm.email) = lower(actor.created_by))
       LEFT JOIN app_users au ON au.id = actor.created_by
      LIMIT 1`,
  )
    .bind(workspaceId, auth.uid)
    .first<Record<string, unknown>>();
  const actorName = text(
    actor?.display_name ||
      actor?.email ||
      auth.token?.name ||
      auth.email ||
      auth.uid,
  );
  const actorEmail = text(actor?.email || auth.email);
  const normalized = {
    id: sessionId,
    transactionReference,
    timestamp: countedAt,
    date: text(draft.date || countedAt).slice(0, 10),
    templateId: templateId || "",
    templateName: text(draft.templateName),
    sessionMode: text(draft.sessionMode, "quick"),
    locationId,
    locationName: text(
      location?.display_name || location?.name || draft.locationName,
    ),
    note: text(draft.note),
    createdBy: auth.uid,
    createdByName: actorName,
    createdByEmail: actorEmail,
    user: actorName,
    lineCount: countedItems.length,
    items: countedItems,
  };

  statements[0] = env.DB.prepare(
    `INSERT INTO stocktake_sessions
      (id, workspace_id, stocktake_template_id, location_id, status, counted_at, created_by, raw_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'posted', ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT(id) DO UPDATE SET
      status = 'posted',
      counted_at = excluded.counted_at,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at`,
  ).bind(
    sessionId,
    workspaceId,
    templateId,
    locationId,
    countedAt,
    auth.uid,
    JSON.stringify(normalized),
    now,
  );
  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
     VALUES (?1, ?2, ?3, 'stock_take_posted', 'stock_take', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      sessionId,
      JSON.stringify(normalized),
      now,
    ),
  );

  await env.DB.batch(statements);
  return json(request, env, { ok: true, id: sessionId, transactionReference });
}

export async function patchStockTake(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  stockTakeId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const sessionId = text(stockTakeId);
  if (!sessionId) return error(request, env, 400, "Stock take id is required.");

  const session = await env.DB.prepare(
    `SELECT id, stocktake_template_id, location_id, counted_at, created_by, raw_json, created_at
       FROM stocktake_sessions
      WHERE workspace_id = ?1
        AND id = ?2
        AND status = 'posted'
      LIMIT 1`,
  )
    .bind(workspaceId, sessionId)
    .first<Record<string, unknown>>();
  if (!session)
    return error(request, env, 404, "Stock take count was not found.");

  const raw = objectValue(jsonParse(session.raw_json));
  const countedAt = text(
    session.counted_at ||
      raw.timestamp ||
      raw.date ||
      session.created_at ||
      nowIso(),
  );
  const canEdit = await canEditStockTakeSession(
    env,
    auth,
    workspaceId,
    countedAt,
  );
  if (!canEdit) {
    return error(
      request,
      env,
      403,
      "You do not have permission to edit this stock count for its age.",
    );
  }

  const body = await readJson<Record<string, unknown>>(request);
  const draft = objectValue(body.stockTake || body);
  const requestedItems = arrayValue(draft.items)
    .map(objectValue)
    .map((line) => ({
      stockItemId: text(
        line.stockItemId || line.itemId || line.ingId || line.id,
      ),
      shelfCount: numberValue(
        line.shelfCount ?? line.countedQty ?? line.count,
        NaN,
      ),
    }))
    .filter(
      (line) =>
        line.stockItemId &&
        Number.isFinite(line.shelfCount) &&
        line.shelfCount >= 0,
    );
  if (!requestedItems.length)
    return error(request, env, 400, "Enter at least one corrected count.");

  const locationId = text(session.location_id || raw.locationId);
  if (!locationId)
    return error(request, env, 400, "This stock count has no valid location.");

  const requestedByItem = new Map(
    requestedItems.map((line) => [line.stockItemId, line.shelfCount]),
  );
  const originalItems = arrayValue(raw.items).map(objectValue);
  const stockItemIds = new Set(
    originalItems
      .map((line) => text(line.stockItemId || line.id))
      .filter(Boolean),
  );
  const invalidItem = requestedItems.find(
    (line) => !stockItemIds.has(line.stockItemId),
  );
  if (invalidItem)
    return error(
      request,
      env,
      400,
      "One or more corrected items do not belong to this stock count.",
    );

  const now = nowIso();
  const actor = await env.CENTRAL_DB.prepare(
    `SELECT
        COALESCE(wm.display_name, au.display_name) AS display_name,
        COALESCE(wm.email, au.email) AS email
       FROM (SELECT ?2 AS created_by) actor
       LEFT JOIN workspace_members wm ON wm.workspace_id = ?1
        AND (wm.auth_uid = actor.created_by OR lower(wm.email) = lower(actor.created_by))
       LEFT JOIN app_users au ON au.id = actor.created_by
      LIMIT 1`,
  )
    .bind(workspaceId, auth.uid)
    .first<Record<string, unknown>>();
  const actorName = text(
    actor?.display_name ||
      actor?.email ||
      auth.token?.name ||
      auth.email ||
      auth.uid,
  );
  const actorEmail = text(actor?.email || auth.email);

  const correctedItems: Array<Record<string, unknown>> = [];
  const changedItems: Array<Record<string, unknown>> = [];
  const statements = [
    env.DB.prepare(
      `DELETE FROM stocktake_count_lines
        WHERE workspace_id = ?1
          AND stocktake_session_id = ?2`,
    ).bind(workspaceId, sessionId),
  ];

  for (const original of originalItems) {
    const stockItemId = text(original.stockItemId || original.id);
    if (!stockItemId) continue;
    const stockItem = await env.DB.prepare(
      `SELECT id, name, unit, unit_cost, raw_json
	         FROM stock_items
	        WHERE workspace_id = ?1
	          AND id = ?2
	          AND active = 1
	          AND ${STOCKED_ITEM_SQL}
	        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId)
      .first<Record<string, unknown>>();
    if (!stockItem) continue;

    const previousShelfCount = numberValue(
      original.shelfCount ?? original.countedQty ?? original.count,
      0,
    );
    const shelfCount = requestedByItem.has(stockItemId)
      ? numberValue(requestedByItem.get(stockItemId), previousShelfCount)
      : previousShelfCount;
    const systemStock = numberValue(
      original.systemStock ?? original.expectedQty ?? original.expected ?? 0,
      0,
    );
    const unitCost = (
      await resolveLocationUnitCost(
        env,
        workspaceId,
        stockItemId,
        locationId,
        stockItem,
      )
    ).cost;
    const variance = shelfCount - systemStock;
    const delta = shelfCount - previousShelfCount;
    const correctedLine = {
      ...original,
      id: text(stockItem.id),
      stockItemId: text(stockItem.id),
      name: text(original.name || stockItem.name),
      stockItemName: text(
        original.stockItemName || original.name || stockItem.name,
      ),
      systemStock,
      shelfCount,
      variance,
      unit: text(original.unit || stockItem.unit),
      cost: unitCost,
      varianceImpactEx: variance * unitCost,
    };
    correctedItems.push(correctedLine);

    if (delta !== 0) {
      const currentBalance = await env.DB.prepare(
        `SELECT quantity
           FROM stock_balances
          WHERE workspace_id = ?1
            AND stock_item_id = ?2
            AND location_id = ?3
          LIMIT 1`,
      )
        .bind(workspaceId, stockItemId, locationId)
        .first<{ quantity: number }>();
      const nextBalance = numberValue(currentBalance?.quantity, 0) + delta;
      statements.push(
        env.DB.prepare(
          // Incremental (delta-based) so concurrent/duplicate mutations don't clobber.
          `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
            quantity = stock_balances.quantity + ?4,
            updated_at = excluded.updated_at`,
        ).bind(workspaceId, stockItemId, locationId, delta, now),
        env.DB.prepare(
          `INSERT INTO stock_movements
            (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
             quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
           VALUES (?1, ?2, ?3, ?4, 'stock_take_correction', 'stock_take', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        ).bind(
          id("move"),
          workspaceId,
          stockItemId,
          locationId,
          sessionId,
          delta,
          unitCost,
          delta * unitCost,
          now,
          auth.uid,
          JSON.stringify({
            previousShelfCount,
            shelfCount,
            originalSystemStock: systemStock,
            editedFromStockTake: true,
          }),
          now,
        ),
      );
      changedItems.push({
        stockItemId,
        stockItemName: correctedLine.stockItemName,
        previousShelfCount,
        shelfCount,
        delta,
        unit: correctedLine.unit,
      });
    }

    statements.push(
      env.DB.prepare(
        `INSERT INTO stocktake_count_lines (id, workspace_id, stocktake_session_id, stock_item_id, location_id, expected_qty, counted_qty, variance_qty, unit_cost)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        id("stcl"),
        workspaceId,
        sessionId,
        stockItemId,
        locationId,
        systemStock,
        shelfCount,
        variance,
        unitCost,
      ),
    );
  }

  if (!correctedItems.length)
    return error(request, env, 400, "No valid stock count lines were found.");
  if (!changedItems.length)
    return json(request, env, { ok: true, id: sessionId, unchanged: true });

  const editHistory = arrayValue(raw.editHistory);
  const normalized = {
    ...raw,
    id: sessionId,
    timestamp: text(raw.timestamp || countedAt),
    date: text(raw.date || countedAt).slice(0, 10),
    locationId,
    editedAt: now,
    editedBy: auth.uid,
    editedByName: actorName,
    editedByEmail: actorEmail,
    editHistory: [
      ...editHistory,
      {
        editedAt: now,
        editedBy: auth.uid,
        editedByName: actorName,
        editedByEmail: actorEmail,
        changedItems,
      },
    ].slice(-20),
    items: correctedItems,
  };

  statements.push(
    env.DB.prepare(
      `UPDATE stocktake_sessions
          SET raw_json = ?3,
              updated_at = ?4
        WHERE workspace_id = ?1
          AND id = ?2`,
    ).bind(workspaceId, sessionId, JSON.stringify(normalized), now),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?1, ?2, ?3, 'stock_take_edited', 'stock_take', ?4, ?5, ?6, ?7)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      sessionId,
      JSON.stringify(raw),
      JSON.stringify(normalized),
      now,
    ),
  );

  await env.DB.batch(statements);
  return json(request, env, { ok: true, id: sessionId, stockTake: normalized });
}

export async function getStockTakeDrafts(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  // Draft ownership is always derived from the authenticated Worker session. Never allow a
  // browser-supplied query parameter to read another workspace member's active count drafts.
  const userId = auth.uid;
  const rows = await env.DB.prepare(
    `SELECT id, raw_json, saved_at, updated_at
       FROM stocktake_drafts
      WHERE workspace_id = ?1
        AND user_id = ?2
      ORDER BY updated_at DESC
      LIMIT 100`,
  )
    .bind(workspaceId, userId)
    .all();
  const drafts = (rows.results || []).map((row) => {
    const record = row as Record<string, unknown>;
    const raw = objectValue(jsonParse(record.raw_json));
    return {
      ...raw,
      id: text(record.id),
      savedByUserId: userId,
      savedAt: text(record.updated_at || record.saved_at),
    };
  });
  return json(request, env, { ok: true, drafts });
}

export async function postStockTakeDraft(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const draft = objectValue(payload.draft || payload);
  // The authenticated session is the source of truth for draft ownership. Client identity fields
  // are retained only inside the normalized response and cannot redirect the write to another user.
  const userId = auth.uid;
  const draftId = text(draft.id) || id("std");
  const locationId = text(draft.locationId || draft.targetLocation);
  if (!locationId)
    return error(
      request,
      env,
      400,
      "Choose a stock take location before saving a draft.",
    );
  const now = nowIso();
  const saved = { ...draft, id: draftId, savedByUserId: userId, savedAt: now };
  await env.DB.prepare(
    `INSERT INTO stocktake_drafts (id, workspace_id, user_id, location_id, raw_json, saved_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(id) DO UPDATE SET
      location_id = excluded.location_id,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at`,
  )
    .bind(draftId, workspaceId, userId, locationId, JSON.stringify(saved), now)
    .run();
  return json(request, env, { ok: true, draft: saved });
}

export async function deleteStockTakeDraftRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  _userId: string,
  draftId = "",
) {
  await scoped(request, env, auth, workspaceId);
  // Ignore the legacy path user id and delete only drafts owned by the authenticated user.
  const uid = auth.uid;
  const idValue = text(draftId);
  if (idValue) {
    await env.DB.prepare(
      `DELETE FROM stocktake_drafts
        WHERE workspace_id = ?1
          AND user_id = ?2
          AND id = ?3`,
    )
      .bind(workspaceId, uid, idValue)
      .run();
  } else {
    await env.DB.prepare(
      `DELETE FROM stocktake_drafts
        WHERE workspace_id = ?1
          AND user_id = ?2`,
    )
      .bind(workspaceId, uid)
      .run();
  }
  return json(request, env, { ok: true });
}

export async function getManufacturingBatches(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const limit = limitFromUrl(new URL(request.url), 500, 1000);
  const rows = await env.DB.prepare(
    `SELECT
        mb.id,
        mb.stock_item_id,
        si.name AS stock_item_name,
        si.unit AS stock_item_unit,
        mb.location_id,
        l.name AS location_name,
        l.display_name AS location_display_name,
        mb.quantity_made,
        mb.actual_quantity,
        mb.wastage_quantity,
        mb.unit,
        mb.posted_at,
        mb.created_by,
        mb.raw_json,
        mb.created_at
       FROM manufacturing_batches mb
        LEFT JOIN stock_items si ON si.id = mb.stock_item_id AND si.workspace_id = mb.workspace_id
        LEFT JOIN locations l ON l.id = mb.location_id AND l.workspace_id = mb.workspace_id
      WHERE mb.workspace_id = ?1
      ORDER BY mb.posted_at DESC
      LIMIT ?2`,
  )
    .bind(workspaceId, limit)
    .all();
  const rowsResults = (rows.results || []) as Record<string, unknown>[];
  await attachActorInfo(env, workspaceId, rowsResults);
  const manufacturingReferences = await resolveTransactionReferences(
    env,
    workspaceId,
    rowsResults,
    "manufacturing_batch",
  );
  const batches = rowsResults.map((row) => {
    const record = row;
    const raw = objectValue(jsonParse(record.raw_json));
    const resolvedActorName = preferredResolvedActor(
      record.created_by_name,
      record.created_by_email,
      raw.createdByName,
      raw.createdByEmail,
      raw.user,
    );
    const resolvedActorEmail = preferredResolvedActor(
      record.created_by_email,
      raw.createdByEmail,
    );
    return {
      ...raw,
      id: text(record.id),
      transactionReference: text(
        raw.transactionReference ||
          manufacturingReferences.get(text(record.id)) ||
          historicalTransactionReference(
            "manufacturing_batch",
            text(record.id),
            record.posted_at || record.created_at,
          ),
      ),
      itemId: text(raw.itemId || record.stock_item_id),
      itemName: text(raw.itemName || record.stock_item_name),
      producedQty: numberValue(
        raw.producedQty || record.actual_quantity || record.quantity_made,
        0,
      ),
      expectedQty: numberValue(
        raw.expectedQty || raw.producedQty || record.quantity_made,
        0,
      ),
      variance: numberValue(
        raw.variance,
        numberValue(record.actual_quantity || record.quantity_made, 0) -
          numberValue(raw.expectedQty || record.quantity_made, 0),
      ),
      wastageQty: numberValue(raw.wastageQty || record.wastage_quantity, 0),
      unit: text(raw.unit || record.unit || record.stock_item_unit),
      date: text(raw.date || record.posted_at).slice(0, 10),
      timestamp: text(raw.timestamp || record.posted_at || record.created_at),
      createdAt: text(record.created_at),
      locationId: text(raw.locationId || record.location_id),
      locationName: text(
        raw.locationName ||
          record.location_display_name ||
          record.location_name,
      ),
      note: text(raw.note),
      components: arrayValue(raw.components),
      createdBy: text(record.created_by || raw.createdBy),
      createdByName:
        resolvedActorName || text(record.created_by || raw.createdBy),
      createdByEmail: resolvedActorEmail,
      user:
        resolvedActorName ||
        resolvedActorEmail ||
        text(record.created_by || raw.createdBy),
    };
  });
  return json(request, env, { ok: true, batches });
}

export async function postManufacturingBatch(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-mfg-products");
  const body = await readJson<Record<string, unknown>>(request);
  const payload = objectValue(body.batch || body);
  const manufacturedItemId = text(
    payload.manufacturedItemId || payload.itemId || payload.stockItemId,
  );
  const requestedLocationId = text(
    payload.locationId || payload.targetLocation,
  );
  const locationId = await resolveActiveLocationId(
    env,
    workspaceId,
    requestedLocationId,
  );
  const producedQty = numberValue(payload.producedQty, 0);
  const expectedQty = numberValue(payload.expectedQty, 0);
  if (!manufacturedItemId)
    return error(request, env, 400, "Select a manufactured item first.");
  if (!locationId)
    return error(request, env, 400, "Choose an active location.");
  await assertLocationAccess(
    env,
    auth,
    workspaceId,
    locationId,
    "manufacturing",
  );
  if (!(producedQty > 0))
    return error(
      request,
      env,
      400,
      "Actual produced quantity must be greater than zero.",
    );
  if (!(expectedQty > 0))
    return error(
      request,
      env,
      400,
      "Expected quantity must be greater than zero.",
    );

  const manufactured = await env.DB.prepare(
    `SELECT id, name, unit, unit_cost, batch_yield, raw_json
       FROM stock_items
      WHERE workspace_id = ?1
        AND id = ?2
        AND active = 1
        AND ${STOCKED_ITEM_SQL}
      LIMIT 1`,
  )
    .bind(workspaceId, manufacturedItemId)
    .first<Record<string, unknown>>();
  if (!manufactured)
    return error(request, env, 404, "Manufactured item could not be found.");

  const manufacturedRaw = objectValue(jsonParse(manufactured.raw_json));
  const recipe = await getStockItemRecipeLines(
    env,
    workspaceId,
    manufacturedItemId,
    arrayValue(manufacturedRaw.recipe),
  );
  if (!recipe.length)
    return error(
      request,
      env,
      400,
      "This manufactured item has no blueprint ingredients yet.",
    );

  // Idempotency: honour a client-supplied stable id so a retry does not re-consume components
  // and re-produce output. The write is a single atomic env.DB.batch, so an existing row means
  // the whole batch already committed.
  const clientBatchId = text(payload.id || payload.clientId);
  const batchId = clientBatchId || id("mfg");
  if (clientBatchId) {
    const existingBatch = await env.DB.prepare(
      `SELECT id FROM manufacturing_batches WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`,
    )
      .bind(workspaceId, clientBatchId)
      .first<{ id: string }>();
    if (existingBatch) {
      const transactionReference =
        (await getTransactionReference(
          env,
          workspaceId,
          "manufacturing_batch",
          batchId,
        )) ||
        historicalTransactionReference(
          "manufacturing_batch",
          batchId,
          nowIso(),
        );
      return json(request, env, {
        ok: true,
        id: batchId,
        transactionReference,
        duplicate: true,
      });
    }
  }
  const postedAt = text(payload.date)
    ? new Date(`${text(payload.date)}T00:00:00.000Z`).toISOString()
    : nowIso();
  const transactionReference = await ensureTransactionReference(
    env,
    workspaceId,
    "manufacturing_batch",
    batchId,
    postedAt,
  );
  const now = nowIso();
  const costingMethod = await getWorkspaceInventoryCostingMethod(
    env,
    workspaceId,
  );
  const yieldBatch =
    numberValue(manufactured.batch_yield || manufacturedRaw.yieldBatch, 1) || 1;
  const statements: DbStatementLike[] = [];
  const components: Array<Record<string, unknown>> = [];
  let theoreticalBatchCost = 0;

  for (const line of recipe) {
    const component = await env.DB.prepare(
      `SELECT id, name, unit, unit_cost, raw_json
	         FROM stock_items
	        WHERE workspace_id = ?1
	          AND id = ?2
	          AND active = 1
	          AND ${STOCKED_ITEM_SQL}
	        LIMIT 1`,
    )
      .bind(workspaceId, line.ingId)
      .first<Record<string, unknown>>();
    if (!component)
      return error(
        request,
        env,
        404,
        "One of the blueprint ingredients could not be found.",
      );

    const currentBalance = await env.DB.prepare(
      `SELECT quantity
         FROM stock_balances
        WHERE workspace_id = ?1
          AND stock_item_id = ?2
          AND location_id = ?3
        LIMIT 1`,
    )
      .bind(workspaceId, line.ingId, locationId)
      .first<{ quantity: number }>();
    const before = numberValue(currentBalance?.quantity, 0);
    const usage = (numberValue(line.qty, 0) / yieldBatch) * expectedQty;
    if (before - usage < 0) {
      return error(
        request,
        env,
        409,
        `Not enough ${text(component.name)} in the selected location. Available: ${formatQuantity(before)} ${text(component.unit)}. Required: ${formatQuantity(usage)} ${text(component.unit)}. After production would be ${formatQuantity(before - usage)} ${text(component.unit)}.`,
      );
    }

    const unitCost = (
      await resolveLocationUnitCost(
        env,
        workspaceId,
        text(component.id),
        locationId,
        component,
      )
    ).cost;
    theoreticalBatchCost += usage * unitCost;
    components.push({
      ingId: text(component.id),
      name: text(component.name),
      qty: usage,
      unit: text(component.unit),
      cost: unitCost,
    });
    statements.push(
      env.DB.prepare(
        // Incremental so a component listed on two lines deducts twice.
        `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = stock_balances.quantity + ?4,
          updated_at = excluded.updated_at`,
      ).bind(workspaceId, line.ingId, locationId, -usage, now),
      env.DB.prepare(
        `INSERT INTO manufacturing_batch_lines
          (id, workspace_id, manufacturing_batch_id, component_stock_item_id, location_id, quantity_used, unit, unit_cost)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        id("mfgl"),
        workspaceId,
        batchId,
        line.ingId,
        locationId,
        usage,
        text(component.unit),
        unitCost,
      ),
      env.DB.prepare(
        `INSERT INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
           quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'manufacturing_component_out', 'manufacturing_batch', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        id("move"),
        workspaceId,
        line.ingId,
        locationId,
        batchId,
        -usage,
        unitCost,
        -usage * unitCost,
        postedAt,
        auth.uid,
        JSON.stringify({ batchId, before, after: before - usage }),
        now,
      ),
    );
  }

  const manufacturedBalance = await env.DB.prepare(
    `SELECT quantity
       FROM stock_balances
      WHERE workspace_id = ?1
        AND stock_item_id = ?2
        AND location_id = ?3
      LIMIT 1`,
  )
    .bind(workspaceId, manufacturedItemId, locationId)
    .first<{ quantity: number }>();
  const manufacturedBefore = numberValue(manufacturedBalance?.quantity, 0);
  const previousManufacturedCost = (
    await resolveLocationUnitCost(
      env,
      workspaceId,
      manufacturedItemId,
      locationId,
      manufactured,
    )
  ).cost;
  const expectedUnitCost =
    expectedQty > 0
      ? theoreticalBatchCost / expectedQty
      : numberValue(manufactured.unit_cost, 0);
  const actualUnitCost =
    producedQty > 0 ? theoreticalBatchCost / producedQty : expectedUnitCost;
  const nextManufacturedLocationCost = calculateIncomingLocationCost({
    method: costingMethod,
    previousQuantity: manufacturedBefore,
    previousUnitCost: previousManufacturedCost,
    incomingQuantity: producedQty,
    incomingUnitCost: actualUnitCost,
  });
  const producedValue = producedQty * actualUnitCost;
  const wastageQty = Math.max(expectedQty - producedQty, 0);
  const wastageValue = wastageQty * expectedUnitCost;
  const normalized: Record<string, any> = {
    id: batchId,
    transactionReference,
    timestamp: postedAt,
    date: text(payload.date || postedAt).slice(0, 10),
    itemId: text(manufactured.id),
    itemName: text(manufactured.name),
    producedQty,
    expectedQty,
    batchCount: numberValue(payload.batchCount || payload.batchMultiplier, 0),
    variance: producedQty - expectedQty,
    wastageQty,
    wastageValue,
    expectedUnitCost,
    actualUnitCost,
    previousUnitCost: previousManufacturedCost,
    nextLocationUnitCost: nextManufacturedLocationCost,
    costingMethod,
    batchCost: theoreticalBatchCost,
    unit: text(manufactured.unit),
    locationId,
    locationName: text(payload.locationName),
    siteId: text(payload.siteId),
    siteName: text(payload.siteName),
    note: text(payload.note),
    components,
    created_by: auth.uid,
    createdBy: auth.uid,
  };
  await attachActorInfo(env, workspaceId, [normalized]);
  normalized.createdByName =
    normalized.created_by_name || normalized.created_by_email || auth.uid;
  normalized.createdByEmail = normalized.created_by_email;
  normalized.user =
    normalized.created_by_name || normalized.created_by_email || auth.uid;

  statements.unshift(
    env.DB.prepare(
      `INSERT INTO manufacturing_batches
        (id, workspace_id, stock_item_id, location_id, quantity_made, actual_quantity, wastage_quantity, unit, posted_at, created_by, raw_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    ).bind(
      batchId,
      workspaceId,
      manufacturedItemId,
      locationId,
      producedQty,
      producedQty,
      wastageQty,
      text(manufactured.unit),
      postedAt,
      auth.uid,
      JSON.stringify(normalized),
      now,
    ),
  );
  statements.push(
    env.DB.prepare(
      // Incremental add of the produced quantity.
      `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
        quantity = stock_balances.quantity + ?4,
        updated_at = excluded.updated_at`,
    ).bind(workspaceId, manufacturedItemId, locationId, producedQty, now),
    upsertLocationCostStatement(
      env,
      workspaceId,
      manufacturedItemId,
      locationId,
      nextManufacturedLocationCost,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO stock_movements
        (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
         quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
       VALUES (?1, ?2, ?3, ?4, 'manufacturing_finished_in', 'manufacturing_batch', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    ).bind(
      id("move"),
      workspaceId,
      manufacturedItemId,
      locationId,
      batchId,
      producedQty,
      actualUnitCost,
      producedValue,
      postedAt,
      auth.uid,
      JSON.stringify({
        batchId,
        before: manufacturedBefore,
        after: manufacturedBefore + producedQty,
        expectedQty,
        wastageQty,
        expectedUnitCost,
        actualUnitCost,
        costingMethod,
        previousLocationCost: previousManufacturedCost,
        nextLocationCost: nextManufacturedLocationCost,
      }),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'manufacturing_batch_posted', 'manufacturing_batch', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      batchId,
      JSON.stringify(normalized),
      now,
    ),
  );
  if (wastageQty > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
           quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'manufacturing_wastage', 'manufacturing_batch', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        id("move"),
        workspaceId,
        manufacturedItemId,
        locationId,
        batchId,
        0,
        expectedUnitCost,
        -wastageValue,
        postedAt,
        auth.uid,
        JSON.stringify({
          batchId,
          expectedQty,
          producedQty,
          wastageQty,
          reason: "Actual yield below expected yield",
          // Yield loss is informational: only actual finished quantity was added to stock and
          // the full component cost is already absorbed into actualUnitCost. A second physical
          // stock-out here would break quantity reconciliation and double-count inventory value.
          accountingOnly: true,
        }),
        now,
      ),
    );
  }

  await env.DB.batch(statements);
  return json(request, env, {
    ok: true,
    id: batchId,
    transactionReference,
    batch: normalized,
  });
}

/**
 * Restore the SENDER's stock for one of its outbound external transfers that closed without full
 * receipt. `shortfalls === null` => restore the full shipped qty (rejected/cancelled); otherwise
 * restore only the per-line shortfall amounts (accepted with a short/partial receipt). Then stamp
 * the sender's local `transfers` row to `finalStatus` so it is never reconciled twice.
 */
async function restoreSenderTransfer(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  transferId: string,
  finalStatus: string,
  shortfalls: Array<Record<string, unknown>> | null,
  context: Record<string, unknown> = {},
): Promise<void> {
  const now = nowIso();
  const acceptedAt = text(context.acceptedAt) || now;
  const requestedAt = text(context.requestedAt);
  const transferMeta = objectValue(context.transferMeta);
  const receivedItems = arrayValue(context.received).map(objectValue);
  const contextShortfalls = arrayValue(context.shortfalls).map(objectValue);
  const tf = await env.DB.prepare(
    `SELECT from_location_id FROM transfers WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`,
  )
    .bind(workspaceId, transferId)
    .first<{ from_location_id: string }>();
  const fromLocationId = text(tf?.from_location_id);
  const lineRows = await env.DB.prepare(
    `SELECT stock_item_id, quantity, unit_cost FROM transfer_lines WHERE workspace_id = ?1 AND transfer_id = ?2`,
  )
    .bind(workspaceId, transferId)
    .all<Record<string, unknown>>();

  const restoreMap = new Map<string, { qty: number; unitCost: number }>();
  if (shortfalls === null) {
    for (const l of lineRows.results || []) {
      const sid = text(l.stock_item_id);
      const q = numberValue(l.quantity, 0);
      if (sid && q > 0)
        restoreMap.set(sid, { qty: q, unitCost: numberValue(l.unit_cost, 0) });
    }
  } else {
    const costBySid = new Map(
      (lineRows.results || []).map((l) => [
        text(l.stock_item_id),
        numberValue(l.unit_cost, 0),
      ]),
    );
    for (const s of shortfalls) {
      const sid = text(s.sourceStockItemId);
      const q = numberValue(s.shortfall, 0);
      if (sid && q > 0)
        restoreMap.set(sid, {
          qty: q,
          unitCost: numberValue(s.unitCost, costBySid.get(sid) || 0),
        });
    }
  }

  const statements = [];
  for (const [sid, { qty, unitCost }] of restoreMap) {
    const meta = JSON.stringify({
      ...transferMeta,
      status: finalStatus,
      acceptedAt,
      requestedAt,
      reversedTransferId: transferId,
      reason: finalStatus,
      returnedQty: qty,
      lazy: true,
    });
    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = stock_balances.quantity + ?4,
          updated_at = excluded.updated_at`,
      ).bind(workspaceId, sid, fromLocationId, qty, now),
      env.DB.prepare(
        `INSERT INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
           source_location_id, destination_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'transfer_reversal', 'transfer', ?5, ?4, ?4, ?6, ?7, ?8, ?9, ?10, ?11, ?9)`,
      ).bind(
        id("move"),
        workspaceId,
        sid,
        fromLocationId,
        transferId,
        qty,
        unitCost,
        qty * unitCost,
        now,
        auth.uid,
        meta,
      ),
    );
  }
  // Enrich every sender movement line with the receiver lifecycle. This is what allows the
  // outbound report to show the accepted external destination even though the matching Transfer In
  // lives in another workspace database.
  for (const rawLine of lineRows.results || []) {
    const sid = text(rawLine.stock_item_id);
    if (!sid) continue;
    const shippedQty = numberValue(rawLine.quantity, 0);
    const receivedLine = findExternalTransferItem(receivedItems, sid);
    const shortfallLine = findExternalTransferItem(contextShortfalls, sid);
    const returnedQty =
      finalStatus === "accepted"
        ? numberValue(shortfallLine.shortfall ?? shortfallLine.returnedQty, 0)
        : shippedQty;
    const receivedQty =
      finalStatus === "accepted"
        ? numberValue(
            receivedLine.receivedQty ?? receivedLine.quantity,
            Math.max(0, shippedQty - returnedQty),
          )
        : 0;
    statements.push(
      env.DB.prepare(
        `UPDATE stock_movements
            SET metadata_json = json_patch(
              CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
              ?4
            )
          WHERE workspace_id = ?1
            AND document_type = 'transfer'
            AND document_id = ?2
            AND stock_item_id = ?3
            AND movement_type = 'transfer_out'`,
      ).bind(
        workspaceId,
        transferId,
        sid,
        JSON.stringify({
          ...transferMeta,
          status: finalStatus,
          requestedAt,
          acceptedAt,
          shippedQty,
          receivedQty,
          returnedQty,
        }),
      ),
    );
  }

  // Stamp and enrich the local transfer row so a later getTransfers won't restore again.
  statements.push(
    env.DB.prepare(
      `UPDATE transfers
          SET status = ?2,
              accepted_at = ?3,
              raw_json = json_patch(
                CASE WHEN json_valid(raw_json) THEN raw_json ELSE '{}' END,
                ?5
              )
        WHERE workspace_id = ?4 AND id = ?1`,
    ).bind(
      transferId,
      finalStatus,
      acceptedAt,
      workspaceId,
      JSON.stringify({
        ...transferMeta,
        status: finalStatus,
        requestedAt,
        acceptedAt,
        lifecycle: {
          status: finalStatus,
          requestedAt,
          acceptedAt,
          received: receivedItems,
          shortfalls: contextShortfalls,
        },
      }),
    ),
  );
  await env.DB.batch(statements);
}

/**
 * Lazily settle the sender side of outbound external transfers: for any still-'pending_receipt'
 * local row whose central outbox has moved to accepted/rejected, restore any un-received stock and
 * mirror the final status locally. No cross-DO calls — reads the central outbox + writes local only.
 */
async function reconcileSentTransfers(
  env: Env,
  auth: AuthContext,
  workspaceId: string,
): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT id FROM transfers
      WHERE workspace_id = ?1 AND transfer_type = 'external' AND status IN ('pending_receipt', 'pending')`,
  )
    .bind(workspaceId)
    .all<{ id: string }>();
  const ids = (pending.results || []).map((r) => text(r.id)).filter(Boolean);
  if (!ids.length) return;

  const ph = ids.map((_, i) => `?${i + 2}`).join(", ");
  const outbox = await env.CENTRAL_DB.prepare(
    `SELECT id, status, items_json, requested_at, accepted_at,
            from_workspace_id, to_workspace_id, from_location_id, to_location_id
       FROM external_transfers
      WHERE from_workspace_id = ?1 AND id IN (${ph}) AND status IN ('accepted', 'rejected', 'cancelled')`,
  )
    .bind(workspaceId, ...ids)
    .all<Record<string, unknown>>();

  for (const row of outbox.results || []) {
    const st = text(row.status);
    const envelope = parseExternalTransferEnvelope(row.items_json);
    const context = {
      transferMeta: {
        ...envelope.transferMeta,
        transferType: "external",
        transferScope: "external",
        fromSiteId: text(row.from_workspace_id),
        toSiteId: text(row.to_workspace_id),
        fromLocationId: text(row.from_location_id),
        toLocationId: text(row.to_location_id),
      },
      requestedAt: text(row.requested_at || envelope.transferMeta.requestedAt),
      acceptedAt: text(row.accepted_at || envelope.lifecycle.acceptedAt),
      received: envelope.received,
      shortfalls: envelope.shortfalls,
    };
    if (st === "rejected" || st === "cancelled") {
      await restoreSenderTransfer(
        env,
        auth,
        workspaceId,
        text(row.id),
        st,
        null,
        context,
      );
    } else if (st === "accepted") {
      await restoreSenderTransfer(
        env,
        auth,
        workspaceId,
        text(row.id),
        "accepted",
        envelope.shortfalls,
        context,
      );
    }
  }
}

export async function getTransfers(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);

  // Settle any outbound external transfers the receiver has accepted/rejected since last view.
  await reconcileSentTransfers(env, auth, workspaceId);

  // This workspace's OWN transfers (internal + outbound external). No cross-plane joins: actor comes
  // from attachActorInfo (central), peer workspace names from a central lookup below.
  const rows = await env.DB.prepare(
    `SELECT
        t.id, t.transfer_type, t.status,
        t.from_location_id, fl.name AS from_location_name, fl.display_name AS from_location_display_name,
        t.to_location_id, tl.name AS to_location_name, tl.display_name AS to_location_display_name,
        t.from_workspace_id, t.to_workspace_id, t.note, t.requested_at, t.accepted_at, t.created_by, t.raw_json,
        trl.id AS line_id, trl.stock_item_id, si.name AS stock_item_name, trl.quantity, trl.unit, trl.unit_cost
       FROM transfers t
       LEFT JOIN transfer_lines trl ON trl.transfer_id = t.id AND trl.workspace_id = t.workspace_id
       LEFT JOIN stock_items si ON si.id = trl.stock_item_id AND si.workspace_id = trl.workspace_id
       LEFT JOIN locations fl ON fl.id = t.from_location_id
       LEFT JOIN locations tl ON tl.id = t.to_location_id
      WHERE t.workspace_id = ?1
      ORDER BY t.requested_at DESC
      LIMIT 1000`,
  )
    .bind(workspaceId)
    .all();

  await attachActorInfo(
    env,
    workspaceId,
    (rows.results || []) as Record<string, unknown>[],
  );
  const transferSettings = await env.DB.prepare(
    `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json?: string }>();
  const sourceProfile = objectValue(jsonParse(transferSettings?.raw_json));

  const localTransferRows = (rows.results || []) as Record<string, unknown>[];
  const localTransferReferences = await resolveTransactionReferences(
    env,
    workspaceId,
    localTransferRows,
    "transfer",
  );
  const map = new Map<
    string,
    Record<string, unknown> & { items: Array<Record<string, unknown>> }
  >();
  for (const row of localTransferRows) {
    const record = row as Record<string, unknown>;
    const transferId = text(record.id);
    const transferRaw = objectValue(jsonParse(text(record.raw_json)));
    const transferMeta = objectValue(
      transferRaw.transferMeta || transferRaw.transfer_meta || transferRaw,
    );
    const lifecycle = objectValue(transferRaw.lifecycle);
    const lifecycleReceived = arrayValue(lifecycle.received).map(objectValue);
    const lifecycleShortfalls = arrayValue(lifecycle.shortfalls).map(
      objectValue,
    );
    const fromSiteId = text(
      transferMeta.fromSiteId || record.from_workspace_id || workspaceId,
    );
    const toSiteId = text(
      transferMeta.toSiteId || record.to_workspace_id || workspaceId,
    );
    const fromLocationId = text(
      transferMeta.fromLocationId || record.from_location_id,
    );
    const toLocationId = text(
      transferMeta.toLocationId || record.to_location_id,
    );
    const transferType = text(
      record.transfer_type || transferMeta.transferType,
    );
    if (!map.has(transferId)) {
      const fromLocationName = cleanTransferDisplayName(
        transferMeta.fromLocationName ||
          record.from_location_display_name ||
          record.from_location_name,
        fromLocationId,
        transferType === "external" ? "Source Location" : "Unknown Location",
      );
      const linkedToLocationName = linkedTransferLocationName(
        sourceProfile,
        toSiteId,
        toLocationId,
      );
      const toLocationName = cleanTransferDisplayName(
        transferMeta.toLocationName ||
          linkedToLocationName ||
          record.to_location_display_name ||
          record.to_location_name,
        toLocationId,
        transferType === "external" ? "External Location" : "Unknown Location",
      );
      map.set(transferId, {
        id: transferId,
        transferId,
        transactionReference: text(
          transferMeta.transactionReference ||
            localTransferReferences.get(transferId) ||
            historicalTransactionReference(
              "transfer",
              transferId,
              transferMeta.requestedAt || record.requested_at,
            ),
        ),
        transferType,
        transferScope: text(transferMeta.transferScope) || transferType,
        status: text(lifecycle.status || transferMeta.status || record.status),
        direction: "outbound",
        from: fromLocationId,
        to: toLocationId,
        fromLocationId,
        toLocationId,
        fromName: fromLocationName,
        toName: toLocationName,
        fromLocationName,
        toLocationName,
        fromSiteId,
        toSiteId,
        fromSiteName: cleanTransferDisplayName(
          transferMeta.fromSiteName,
          fromSiteId,
          fromSiteId === workspaceId ? "Current Site" : "External Site",
        ),
        toSiteName: cleanTransferDisplayName(
          transferMeta.toSiteName,
          toSiteId,
          toSiteId === workspaceId ? "Current Site" : "External Site",
        ),
        note: text(record.note),
        user: text(
          record.created_by_name ||
            record.created_by_email ||
            record.created_by,
        ),
        createdBy: text(record.created_by),
        createdByName: text(record.created_by_name),
        createdByEmail: text(record.created_by_email),
        requestedAt: text(transferMeta.requestedAt || record.requested_at),
        acceptedAt: text(
          lifecycle.acceptedAt || transferMeta.acceptedAt || record.accepted_at,
        ),
        postedAt: text(
          lifecycle.acceptedAt ||
            transferMeta.acceptedAt ||
            record.accepted_at ||
            record.requested_at,
        ),
        timestamp: text(
          lifecycle.acceptedAt ||
            transferMeta.acceptedAt ||
            record.accepted_at ||
            record.requested_at,
        ),
        date: text(
          lifecycle.acceptedAt ||
            transferMeta.acceptedAt ||
            record.accepted_at ||
            record.requested_at,
        ).slice(0, 10),
        createdAt: text(record.requested_at),
        updatedAt: text(
          lifecycle.acceptedAt ||
            transferMeta.acceptedAt ||
            record.accepted_at ||
            record.requested_at,
        ),
        items: [],
      });
    }
    if (record.line_id) {
      const stockItemId = text(record.stock_item_id);
      const shippedQty = numberValue(record.quantity, 0);
      const receivedLine = findExternalTransferItem(
        lifecycleReceived,
        stockItemId,
      );
      const shortfallLine = findExternalTransferItem(
        lifecycleShortfalls,
        stockItemId,
      );
      const returnedQty = numberValue(
        shortfallLine.shortfall ?? shortfallLine.returnedQty,
        text(record.status) === "rejected" ||
          text(record.status) === "cancelled"
          ? shippedQty
          : 0,
      );
      const receivedQty = numberValue(
        receivedLine.receivedQty ?? receivedLine.quantity,
        text(record.status) === "accepted"
          ? Math.max(0, shippedQty - returnedQty)
          : 0,
      );
      map.get(transferId)?.items.push({
        id: stockItemId,
        stockItemId,
        name: text(record.stock_item_name),
        stockItemName: text(record.stock_item_name),
        qty: shippedQty,
        quantity: shippedQty,
        shippedQty,
        receivedQty,
        returnedQty,
        unit: text(record.unit),
        unitCost: numberValue(record.unit_cost, 0),
      });
    }
  }

  // INBOUND external transfers (sent TO this workspace) live in the central outbox, not locally.
  const inbound = await env.CENTRAL_DB.prepare(
    `SELECT id, from_workspace_id, to_workspace_id, from_location_id, to_location_id, status, items_json, note, created_by, requested_at, accepted_at
       FROM external_transfers
      WHERE to_workspace_id = ?1
      ORDER BY requested_at DESC
      LIMIT 1000`,
  )
    .bind(workspaceId)
    .all<Record<string, unknown>>();
  for (const row of inbound.results || []) {
    const transferId = text(row.id);
    const envelope = parseExternalTransferEnvelope(row.items_json);
    const transferMeta = envelope.transferMeta;
    const localTargetLocation = await env.DB.prepare(
      `SELECT id, name, display_name FROM locations
        WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`,
    )
      .bind(workspaceId, text(row.to_location_id))
      .first<{ id: string; name: string; display_name?: string }>();
    const fromLocationName = cleanTransferDisplayName(
      transferMeta.fromLocationName,
      row.from_location_id,
      "External Location",
    );
    const toLocationName = cleanTransferDisplayName(
      localTargetLocation?.display_name ||
        localTargetLocation?.name ||
        transferMeta.toLocationName,
      row.to_location_id,
      "Receiving Location",
    );
    map.set(transferId, {
      id: transferId,
      transferId,
      transactionReference: text(
        transferMeta.transactionReference ||
          historicalTransactionReference(
            "transfer",
            transferId,
            transferMeta.requestedAt || row.requested_at,
          ),
      ),
      transferType: "external",
      transferScope: "external",
      status: text(
        envelope.lifecycle.status || transferMeta.status || row.status,
      ),
      direction: "inbound",
      from: text(row.from_location_id),
      to: text(row.to_location_id),
      fromLocationId: text(row.from_location_id),
      toLocationId: text(row.to_location_id),
      fromName: fromLocationName,
      toName: toLocationName,
      fromLocationName,
      toLocationName,
      fromSiteId: text(row.from_workspace_id),
      toSiteId: text(row.to_workspace_id),
      fromSiteName: cleanTransferDisplayName(
        transferMeta.fromSiteName,
        row.from_workspace_id,
        "External Site",
      ),
      toSiteName: cleanTransferDisplayName(
        transferMeta.toSiteName,
        row.to_workspace_id,
        "Current Site",
      ),
      note: text(row.note),
      user: text(row.created_by),
      createdBy: text(row.created_by),
      createdByName: "",
      createdByEmail: "",
      requestedAt: text(transferMeta.requestedAt || row.requested_at),
      acceptedAt: text(
        envelope.lifecycle.acceptedAt ||
          transferMeta.acceptedAt ||
          row.accepted_at,
      ),
      postedAt: text(
        envelope.lifecycle.acceptedAt ||
          transferMeta.acceptedAt ||
          row.accepted_at ||
          row.requested_at,
      ),
      timestamp: text(
        envelope.lifecycle.acceptedAt ||
          transferMeta.acceptedAt ||
          row.accepted_at ||
          row.requested_at,
      ),
      date: text(
        envelope.lifecycle.acceptedAt ||
          transferMeta.acceptedAt ||
          row.accepted_at ||
          row.requested_at,
      ).slice(0, 10),
      createdAt: text(row.requested_at),
      updatedAt: text(
        envelope.lifecycle.acceptedAt ||
          transferMeta.acceptedAt ||
          row.accepted_at ||
          row.requested_at,
      ),
      items: envelope.shipped.map((it) => {
        const stockItemId = text(it.stockItemId || it.id);
        const shippedQty = numberValue(it.quantity ?? it.qty, 0);
        const receivedLine = findExternalTransferItem(
          envelope.received,
          stockItemId,
        );
        const shortfallLine = findExternalTransferItem(
          envelope.shortfalls,
          stockItemId,
        );
        const returnedQty = numberValue(
          shortfallLine.shortfall ?? shortfallLine.returnedQty,
          text(row.status) === "rejected" || text(row.status) === "cancelled"
            ? shippedQty
            : 0,
        );
        const receivedQty = numberValue(
          receivedLine.receivedQty ?? receivedLine.quantity,
          text(row.status) === "accepted"
            ? Math.max(0, shippedQty - returnedQty)
            : 0,
        );
        return {
          id: stockItemId,
          stockItemId,
          name: text(it.name),
          stockItemName: text(it.name),
          qty: shippedQty,
          quantity: shippedQty,
          shippedQty,
          receivedQty,
          returnedQty,
          unit: text(it.unit),
          unitCost: numberValue(it.unitCost ?? it.unit_cost, 0),
        };
      }),
    });
  }

  // Fill peer workspace names from the central registry (was a cross-plane JOIN on workspaces).
  const wsIds = new Set<string>();
  for (const e of map.values()) {
    wsIds.add(text(e.fromSiteId));
    wsIds.add(text(e.toSiteId));
  }
  wsIds.delete("");
  if (wsIds.size) {
    const ids = [...wsIds];
    const ph = ids.map((_, i) => `?${i + 1}`).join(", ");
    const nameRows = await env.CENTRAL_DB.prepare(
      `SELECT id, name FROM workspaces WHERE id IN (${ph})`,
    )
      .bind(...ids)
      .all<{ id: string; name: string }>();
    const names = new Map(
      (nameRows.results || []).map((r) => [text(r.id), text(r.name)]),
    );
    for (const e of map.values()) {
      e.fromSiteName = cleanTransferDisplayName(
        names.get(text(e.fromSiteId)) || e.fromSiteName,
        e.fromSiteId,
        text(e.fromSiteId) === workspaceId ? "Current Site" : "External Site",
      );
      e.toSiteName = cleanTransferDisplayName(
        names.get(text(e.toSiteId)) || e.toSiteName,
        e.toSiteId,
        text(e.toSiteId) === workspaceId ? "Current Site" : "External Site",
      );
    }
  }

  const transfers = [...map.values()].map((entry) => ({
    ...entry,
    lineCount: entry.items.length,
    shippedQty: entry.items.reduce(
      (sum, item) => sum + numberValue(item.shippedQty ?? item.quantity, 0),
      0,
    ),
    receivedQty: entry.items.reduce(
      (sum, item) => sum + numberValue(item.receivedQty, 0),
      0,
    ),
    returnedQty: entry.items.reduce(
      (sum, item) => sum + numberValue(item.returnedQty, 0),
      0,
    ),
  })) as unknown as Array<
    Record<string, unknown> & {
      transferType: string;
      items: Array<Record<string, unknown>>;
    }
  >;
  return json(request, env, {
    ok: true,
    transfers: transfers.filter(
      (entry) => text(entry.transferType) === "internal",
    ),
    externalTransfers: transfers.filter(
      (entry) => text(entry.transferType) !== "internal",
    ),
  });
}

export async function getTransferTemplates(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const rows = await env.DB.prepare(
    `SELECT
        tt.id,
        tt.name,
        tt.created_at,
        tt.updated_at,
        ttl.stock_item_id,
        si.name AS stock_item_name,
        si.category,
        si.unit,
        si.barcode_csv,
        ttl.sort_order
       FROM transfer_templates tt
       LEFT JOIN transfer_template_lines ttl ON ttl.transfer_template_id = tt.id AND ttl.workspace_id = tt.workspace_id
       LEFT JOIN stock_items si ON si.id = ttl.stock_item_id AND si.workspace_id = ttl.workspace_id
      WHERE tt.workspace_id = ?1
        AND tt.active = 1
      ORDER BY tt.updated_at DESC, ttl.sort_order ASC`,
  )
    .bind(workspaceId)
    .all();

  const map = new Map<
    string,
    Record<string, unknown> & { items: Array<Record<string, unknown>> }
  >();
  for (const row of rows.results || []) {
    const record = row as Record<string, unknown>;
    const templateId = text(record.id);
    if (!map.has(templateId)) {
      map.set(templateId, {
        id: templateId,
        name: text(record.name),
        createdAt: text(record.created_at),
        updatedAt: text(record.updated_at),
        items: [],
      });
    }
    if (record.stock_item_id) {
      map.get(templateId)?.items.push({
        stockItemId: text(record.stock_item_id),
        stockItemName: text(record.stock_item_name),
        name: text(record.stock_item_name),
        sku: text(record.barcode_csv).split(",")[0] || "",
        category: text(record.category),
        unit: text(record.unit),
      });
    }
  }

  return json(request, env, { ok: true, templates: [...map.values()] });
}

export async function postTransferTemplate(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const template = objectValue(payload.template || payload);
  const templateId = text(template.id) || id("tt");
  const name = text(template.name);
  const itemIds = [
    ...new Set(
      arrayValue(template.items)
        .map(objectValue)
        .map((line) => text(line.stockItemId || line.itemId || line.id))
        .filter(Boolean),
    ),
  ];
  if (!name) return error(request, env, 400, "Enter a template name.");
  if (!itemIds.length)
    return error(
      request,
      env,
      400,
      "Select at least one stock item for this template.",
    );
  if (itemIds.length > 5000)
    return error(
      request,
      env,
      400,
      "A transfer template can contain at most 5 000 stock items.",
    );

  const lineRows = itemIds.map((stockItemId, sortOrder) => ({
    id: id("ttl"),
    stockItemId,
    sortOrder,
  }));
  const lineRowsJson = JSON.stringify(lineRows);

  // Validate the complete selection before replacing an existing template. This avoids silently
  // dropping deleted/stale stock IDs and guarantees the subsequent three-statement batch remains
  // atomic for both D1 and the per-workspace Durable Object SQLite facade.
  const validation = await env.DB.prepare(
    `SELECT
        COUNT(*) AS requested_count,
        COUNT(si.id) AS valid_count
       FROM json_each(?2) selected
       LEFT JOIN stock_items si
         ON si.id = json_extract(selected.value, '$.stockItemId')
        AND si.workspace_id = ?1
        AND si.active = 1`,
  )
    .bind(workspaceId, lineRowsJson)
    .first<{ requested_count?: number; valid_count?: number }>();
  if (
    numberValue(validation?.requested_count, 0) !== lineRows.length ||
    numberValue(validation?.valid_count, 0) !== lineRows.length
  ) {
    return error(
      request,
      env,
      400,
      "One or more selected stock items are no longer available. Refresh the list and try again.",
    );
  }

  const now = nowIso();
  const statements = [
    env.DB.prepare(
      `INSERT INTO transfer_templates (id, workspace_id, name, active, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)
       ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        active = 1,
        updated_at = excluded.updated_at`,
    ).bind(templateId, workspaceId, name, auth.uid, now),
    env.DB.prepare(
      `DELETE FROM transfer_template_lines
        WHERE workspace_id = ?1
          AND transfer_template_id = ?2`,
    ).bind(workspaceId, templateId),
    env.DB.prepare(
      `INSERT INTO transfer_template_lines (
         id,
         workspace_id,
         transfer_template_id,
         stock_item_id,
         sort_order
       )
       SELECT
         json_extract(selected.value, '$.id'),
         ?1,
         ?2,
         json_extract(selected.value, '$.stockItemId'),
         CAST(json_extract(selected.value, '$.sortOrder') AS INTEGER)
       FROM json_each(?3) selected`,
    ).bind(workspaceId, templateId, lineRowsJson),
  ];

  await env.DB.batch(statements);
  return json(request, env, {
    ok: true,
    id: templateId,
    createdAt: now,
    updatedAt: now,
    itemCount: lineRows.length,
  });
}

export async function deleteTransferTemplateRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  templateId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await env.DB.prepare(
    `UPDATE transfer_templates
        SET active = 0,
            updated_at = ?3
      WHERE workspace_id = ?1
        AND id = ?2`,
  )
    .bind(workspaceId, text(templateId), nowIso())
    .run();
  return json(request, env, { ok: true, id: text(templateId) });
}

export async function postInternalTransfer(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-transfers");
  const payload = await readJson<Record<string, unknown>>(request);
  const fromLocationId = await resolveActiveLocationId(
    env,
    workspaceId,
    text(payload.fromLocationId || payload.from_location_id),
  );
  const toLocationId = await resolveActiveLocationId(
    env,
    workspaceId,
    text(payload.toLocationId || payload.to_location_id),
  );
  const items = arrayValue(payload.items).map(objectValue);
  if (!fromLocationId || !toLocationId)
    return error(request, env, 400, "Select both transfer locations.");
  await assertLocationAccess(
    env,
    auth,
    workspaceId,
    fromLocationId,
    "transfer_source",
  );
  await assertLocationAccess(
    env,
    auth,
    workspaceId,
    toLocationId,
    "transfer_destination",
  );
  if (fromLocationId === toLocationId)
    return error(
      request,
      env,
      400,
      "Source and destination must be different.",
    );
  if (!items.length)
    return error(request, env, 400, "Add at least one stock item to transfer.");

  const requestedTransferId = text(payload.id || payload.transferId);
  if (requestedTransferId) {
    const existingTransfer = await env.DB.prepare(
      `SELECT id
         FROM transfers
        WHERE workspace_id = ?1
          AND id = ?2
        LIMIT 1`,
    )
      .bind(workspaceId, requestedTransferId)
      .first<{ id: string }>();
    if (existingTransfer?.id) {
      const transactionReference =
        (await getTransactionReference(
          env,
          workspaceId,
          "transfer",
          requestedTransferId,
        )) ||
        historicalTransactionReference(
          "transfer",
          requestedTransferId,
          nowIso(),
        );
      return json(request, env, {
        ok: true,
        id: requestedTransferId,
        transactionReference,
        duplicate: true,
        skipped: true,
        items: [],
      });
    }
  }

  const transferId = requestedTransferId || id("tf");
  const actionAt = nowIso();
  const requestedAt = actionAt;
  const transactionReference = await ensureTransactionReference(
    env,
    workspaceId,
    "transfer",
    transferId,
    requestedAt,
  );
  const note = text(payload.note);
  const createdAt = actionAt;
  const costingMethod = await getWorkspaceInventoryCostingMethod(
    env,
    workspaceId,
  );
  const rawJson = JSON.stringify({
    ...payload,
    transactionReference,
    requestedAt: actionAt,
    acceptedAt: actionAt,
    postedAt: actionAt,
    actionAt,
  });
  const statements = [
    env.DB.prepare(
      `INSERT INTO transfers
        (id, workspace_id, transfer_type, status, from_location_id, to_location_id, from_workspace_id,
         to_workspace_id, note, requested_at, accepted_at, created_by, raw_json)
       VALUES (?1, ?2, 'internal', 'posted', ?3, ?4, ?2, ?2, ?5, ?6, ?6, ?7, ?8)`,
    ).bind(
      transferId,
      workspaceId,
      fromLocationId,
      toLocationId,
      note,
      requestedAt,
      auth.uid,
      rawJson,
    ),
  ];
  const movedItems = [];

  for (const rawLine of items) {
    const stockItemId = text(
      rawLine.stockItemId || rawLine.itemId || rawLine.ingId || rawLine.id,
    );
    const quantity = numberValue(rawLine.quantity ?? rawLine.qty, 0);
    if (!stockItemId || !(quantity > 0)) continue;

    const stockItem = await env.DB.prepare(
      `SELECT id, name, unit, unit_cost, raw_json
         FROM stock_items
        WHERE workspace_id = ?1
          AND id = ?2
          AND active = 1
          AND ${STOCKED_ITEM_SQL}
        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId)
      .first<Record<string, unknown>>();
    if (!stockItem)
      return error(
        request,
        env,
        404,
        `${text(rawLine.stockItemName || stockItemId)} could not be found.`,
      );

    const [fromBalance, toBalance] = await Promise.all([
      env.DB.prepare(
        `SELECT quantity
           FROM stock_balances
          WHERE workspace_id = ?1
            AND stock_item_id = ?2
            AND location_id = ?3
          LIMIT 1`,
      )
        .bind(workspaceId, stockItemId, fromLocationId)
        .first<{ quantity: number }>(),
      env.DB.prepare(
        `SELECT quantity
           FROM stock_balances
          WHERE workspace_id = ?1
            AND stock_item_id = ?2
            AND location_id = ?3
          LIMIT 1`,
      )
        .bind(workspaceId, stockItemId, toLocationId)
        .first<{ quantity: number }>(),
    ]);

    const sourceBefore = numberValue(fromBalance?.quantity, 0);
    const destinationBefore = numberValue(toBalance?.quantity, 0);
    if (sourceBefore - quantity < 0) {
      return error(
        request,
        env,
        409,
        `${text(stockItem.name)} only has ${sourceBefore} available at the source location.`,
      );
    }

    const unitCost = (
      await resolveLocationUnitCost(
        env,
        workspaceId,
        stockItemId,
        fromLocationId,
        stockItem,
      )
    ).cost;
    const destinationPreviousCost = (
      await resolveLocationUnitCost(
        env,
        workspaceId,
        stockItemId,
        toLocationId,
        stockItem,
      )
    ).cost;
    const destinationNextCost = calculateIncomingLocationCost({
      method: costingMethod,
      previousQuantity: destinationBefore,
      previousUnitCost: destinationPreviousCost,
      incomingQuantity: quantity,
      incomingUnitCost: unitCost,
    });
    const lineId = id("tl");
    const sourceMovementId = id("move");
    const destinationMovementId = id("move");
    const metadata = JSON.stringify({
      transactionReference,
      sourceBefore,
      sourceAfter: sourceBefore - quantity,
      destinationBefore,
      destinationAfter: destinationBefore + quantity,
      costingMethod,
      sourceLocationCost: unitCost,
      destinationPreviousCost,
      destinationNextCost,
    });

    statements.push(
      env.DB.prepare(
        // Incremental deduct at source / add at destination (duplicate-line + concurrency safe).
        `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = stock_balances.quantity + ?4,
          updated_at = excluded.updated_at`,
      ).bind(workspaceId, stockItemId, fromLocationId, -quantity, createdAt),
      env.DB.prepare(
        `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = stock_balances.quantity + ?4,
          updated_at = excluded.updated_at`,
      ).bind(workspaceId, stockItemId, toLocationId, quantity, createdAt),
      upsertLocationCostStatement(
        env,
        workspaceId,
        stockItemId,
        toLocationId,
        destinationNextCost,
        createdAt,
      ),
      env.DB.prepare(
        `INSERT INTO transfer_lines (id, workspace_id, transfer_id, stock_item_id, quantity, unit, unit_cost)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(
        lineId,
        workspaceId,
        transferId,
        stockItemId,
        quantity,
        text(stockItem.unit || rawLine.unit),
        unitCost,
      ),
      env.DB.prepare(
        `INSERT INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
           source_location_id, destination_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'transfer_out', 'transfer', ?5, ?4, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).bind(
        sourceMovementId,
        workspaceId,
        stockItemId,
        fromLocationId,
        transferId,
        toLocationId,
        -quantity,
        unitCost,
        -quantity * unitCost,
        requestedAt,
        auth.uid,
        metadata,
        createdAt,
      ),
      env.DB.prepare(
        `INSERT INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
           source_location_id, destination_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'transfer_in', 'transfer', ?5, ?6, ?4, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).bind(
        destinationMovementId,
        workspaceId,
        stockItemId,
        toLocationId,
        transferId,
        fromLocationId,
        quantity,
        unitCost,
        quantity * unitCost,
        requestedAt,
        auth.uid,
        metadata,
        createdAt,
      ),
    );

    movedItems.push({
      stockItemId,
      id: stockItemId,
      name: text(stockItem.name),
      qty: quantity,
      quantity,
      unit: text(stockItem.unit || rawLine.unit),
      unitCost,
      destinationUnitCost: destinationNextCost,
      fromBalanceBefore: sourceBefore,
      toBalanceBefore: destinationBefore,
    });
  }

  if (!movedItems.length)
    return error(request, env, 400, "No valid transfer lines were found.");
  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
     VALUES (?1, ?2, ?3, 'transfer_posted', 'transfer', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      transferId,
      JSON.stringify({ movedItems }),
      createdAt,
    ),
  );

  await env.DB.batch(statements);
  return json(request, env, {
    ok: true,
    id: transferId,
    transactionReference,
    items: movedItems,
  });
}

export async function postExternalTransfer(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  await assertWorkspacePermission(env, auth, workspaceId, "nav-transfers");
  const payload = await readJson<Record<string, unknown>>(request);
  const targetWorkspaceId = text(payload.to_site_id || payload.toSiteId);
  const requestedFromLocationId = text(
    payload.from_location_id || payload.fromLocationId,
  );
  const fromLocationId = await resolveActiveLocationId(
    env,
    workspaceId,
    requestedFromLocationId,
  );
  const toLocationId = text(payload.to_location_id || payload.toLocationId);
  const requestedFromSiteName = text(
    payload.from_site_name || payload.fromSiteName,
  );
  const requestedToSiteName = text(payload.to_site_name || payload.toSiteName);
  const requestedFromLocationName = text(
    payload.from_location_name || payload.fromLocationName,
  );
  const requestedToLocationName = text(
    payload.to_location_name || payload.toLocationName,
  );
  const items = arrayValue(payload.items).map(objectValue);
  if (!targetWorkspaceId)
    return error(request, env, 400, "Receiving workspace is required.");
  if (targetWorkspaceId === workspaceId)
    return error(
      request,
      env,
      400,
      "External transfers must be sent to another workspace.",
    );
  if (!fromLocationId || !toLocationId)
    return error(
      request,
      env,
      400,
      "Select both sending and receiving locations.",
    );
  await assertLocationAccess(
    env,
    auth,
    workspaceId,
    fromLocationId,
    "external_transfer_source",
  );
  if (!items.length)
    return error(request, env, 400, "Add at least one stock item to transfer.");

  const settings = await env.DB.prepare(
    `SELECT raw_json
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json: string }>();
  const sourceProfile = objectValue(jsonParse(settings?.raw_json));
  let linkedIds = linkedWorkspaceIds(sourceProfile);
  if (!linkedIds.length) {
    // Group membership is authoritative in the CENTRAL registry (settings-save strips org/corp keys).
    const sourceReg = await env.CENTRAL_DB.prepare(
      `SELECT org_id, corp_id FROM workspaces WHERE id = ?1 LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ org_id?: string; corp_id?: string }>();
    const orgId = text(
      sourceReg?.org_id || sourceProfile.orgId || sourceProfile.org_id,
    );
    const corpId = text(
      sourceReg?.corp_id || sourceProfile.corpId || sourceProfile.corp_id,
    );
    if (orgId || corpId) {
      const orgRows = await env.CENTRAL_DB.prepare(
        `SELECT id AS workspace_id FROM workspaces
          WHERE id != ?1 AND status = 'active'
            AND (
              (org_id = ?2 AND ?2 != '')
              OR (corp_id = ?3 AND ?3 != '')
            )`,
      )
        .bind(workspaceId, orgId || "", corpId || "")
        .all<{ workspace_id: string }>();
      linkedIds = (orgRows.results || [])
        .map((r) => r.workspace_id)
        .filter(Boolean);
    }
  }
  // Require the target to be an explicitly linked workspace. Previously the check was
  // skipped entirely when no links were configured, letting a member push a transfer into
  // any workspace whose location id they could supply.
  if (!linkedIds.includes(targetWorkspaceId)) {
    return error(
      request,
      env,
      403,
      "Receiving workspace is not linked for external transfers.",
    );
  }

  const [sourceWorkspace, target, sourceLocation] = await Promise.all([
    env.CENTRAL_DB.prepare(
      `SELECT id, name
         FROM workspaces
        WHERE id = ?1
        LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ id: string; name: string }>(),
    // Target workspace lives in the CENTRAL registry; its locations live in ITS OWN DO (validated
    // at accept time, not here — A cannot read B's tenant tables).
    env.CENTRAL_DB.prepare(
      `SELECT id, name
       FROM workspaces
      WHERE id = ?1
        AND status = 'active'
      LIMIT 1`,
    )
      .bind(targetWorkspaceId)
      .first<{ id: string; name: string }>(),
    env.DB.prepare(
      `SELECT id, name, display_name
         FROM locations
        WHERE workspace_id = ?1
          AND id = ?2
          AND active = 1
        LIMIT 1`,
    )
      .bind(workspaceId, fromLocationId)
      .first<{ id: string; name: string; display_name?: string }>(),
  ]);

  if (!target) {
    return error(
      request,
      env,
      412,
      `Receiving workspace ${targetWorkspaceId} is not provisioned on this account yet.`,
    );
  }
  if (!sourceLocation)
    return error(request, env, 404, "Sending location could not be found.");
  // Receiving location is validated by the target workspace's DO when it accepts the transfer.
  const fromSiteName = cleanTransferDisplayName(
    sourceWorkspace?.name || requestedFromSiteName,
    workspaceId,
    "Current Site",
  );
  const toSiteName = cleanTransferDisplayName(
    target.name || requestedToSiteName,
    targetWorkspaceId,
    "External Site",
  );
  const fromLocationName = cleanTransferDisplayName(
    sourceLocation.display_name ||
      sourceLocation.name ||
      requestedFromLocationName,
    fromLocationId,
    "Source Location",
  );
  const toLocationName = cleanTransferDisplayName(
    requestedToLocationName,
    toLocationId,
    "External Location",
  );
  const transferMeta: Record<string, unknown> = {
    transferType: "external",
    transferScope: "external",
    fromSiteId: workspaceId,
    fromSiteName,
    fromLocationId,
    fromLocationName,
    toSiteId: targetWorkspaceId,
    toSiteName,
    toLocationId,
    toLocationName,
    status: "pending_receipt",
  };

  // Idempotency: honour a client-supplied stable id so a retry does not deduct sending stock twice
  // and create duplicate pending transfers. The write is a single atomic env.DB.batch.
  const clientTransferId = text(payload.id || payload.clientId);
  const transferId = clientTransferId || id("tf");
  if (clientTransferId) {
    const existingTransfer = await env.DB.prepare(
      `SELECT id FROM transfers WHERE workspace_id = ?1 AND id = ?2 LIMIT 1`,
    )
      .bind(workspaceId, clientTransferId)
      .first<{ id: string }>();
    if (existingTransfer) {
      const transactionReference =
        (await getTransactionReference(
          env,
          workspaceId,
          "transfer",
          transferId,
        )) || historicalTransactionReference("transfer", transferId, nowIso());
      return json(request, env, {
        ok: true,
        id: transferId,
        transactionReference,
        duplicate: true,
      });
    }
  }
  const actionAt = nowIso();
  const requestedAt = actionAt;
  const transactionReference = await ensureTransactionReference(
    env,
    workspaceId,
    "transfer",
    transferId,
    requestedAt,
  );
  const note = text(payload.note);
  const createdAt = actionAt;
  const rawJson = JSON.stringify({
    ...payload,
    ...transferMeta,
    transactionReference,
    transferMeta: { ...transferMeta, transactionReference },
    requestedAt: actionAt,
    postedAt: actionAt,
    actionAt,
  });
  const statements = [
    env.DB.prepare(
      `INSERT INTO transfers
        (id, workspace_id, transfer_type, status, from_location_id, to_location_id, from_workspace_id,
         to_workspace_id, note, requested_at, created_by, raw_json)
       VALUES (?1, ?2, 'external', 'pending_receipt', ?3, ?4, ?2, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      transferId,
      workspaceId,
      fromLocationId,
      toLocationId,
      targetWorkspaceId,
      note,
      requestedAt,
      auth.uid,
      rawJson,
    ),
  ];
  const movedItems = [];

  for (const rawLine of items) {
    const stockItemId = text(
      rawLine.stockItemId || rawLine.itemId || rawLine.ingId || rawLine.id,
    );
    const quantity = numberValue(rawLine.quantity ?? rawLine.qty, 0);
    if (!stockItemId || !(quantity > 0)) continue;

    const stockItem = await env.DB.prepare(
      `SELECT id, name, category, unit, unit_cost, raw_json
         FROM stock_items
        WHERE workspace_id = ?1
          AND id = ?2
          AND active = 1
          AND ${STOCKED_ITEM_SQL}
        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId)
      .first<Record<string, unknown>>();
    if (!stockItem)
      return error(
        request,
        env,
        404,
        `${text(rawLine.stockItemName || stockItemId)} could not be found.`,
      );

    const fromBalance = await env.DB.prepare(
      `SELECT quantity
         FROM stock_balances
        WHERE workspace_id = ?1
          AND stock_item_id = ?2
          AND location_id = ?3
        LIMIT 1`,
    )
      .bind(workspaceId, stockItemId, fromLocationId)
      .first<{ quantity: number }>();

    const sourceBefore = numberValue(fromBalance?.quantity, 0);
    // Block the transfer when the source location does not hold enough stock.
    if (sourceBefore - quantity < 0) {
      return error(
        request,
        env,
        409,
        `${text(stockItem.name)} only has ${sourceBefore} available at the source location.`,
      );
    }

    const unitCost = (
      await resolveLocationUnitCost(
        env,
        workspaceId,
        stockItemId,
        fromLocationId,
        stockItem,
      )
    ).cost;
    const metadata = JSON.stringify({
      ...transferMeta,
      transactionReference,
      requestedAt,
      acceptedAt: "",
      sourceBefore,
      sourceAfter: sourceBefore - quantity,
      targetWorkspaceId,
      targetLocationId: toLocationId,
      shippedQty: quantity,
      receivedQty: 0,
      returnedQty: 0,
    });

    statements.push(
      env.DB.prepare(
        // Incremental deduct at source (duplicate-line + concurrency safe).
        `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
          quantity = stock_balances.quantity + ?4,
          updated_at = excluded.updated_at`,
      ).bind(workspaceId, stockItemId, fromLocationId, -quantity, createdAt),
      env.DB.prepare(
        `INSERT INTO transfer_lines (id, workspace_id, transfer_id, stock_item_id, quantity, unit, unit_cost)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(
        id("tl"),
        workspaceId,
        transferId,
        stockItemId,
        quantity,
        text(stockItem.unit || rawLine.unit),
        unitCost,
      ),
      env.DB.prepare(
        `INSERT INTO stock_movements
          (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
           source_location_id, destination_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'transfer_out', 'transfer', ?5, ?4, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).bind(
        id("move"),
        workspaceId,
        stockItemId,
        fromLocationId,
        transferId,
        toLocationId,
        -quantity,
        unitCost,
        -quantity * unitCost,
        requestedAt,
        auth.uid,
        metadata,
        createdAt,
      ),
    );

    movedItems.push({
      stockItemId,
      id: stockItemId,
      name: text(stockItem.name),
      category: text(stockItem.category),
      qty: quantity,
      quantity,
      shippedQty: quantity,
      unit: text(stockItem.unit || rawLine.unit),
      unitCost,
      fromBalanceBefore: sourceBefore,
    });
  }

  if (!movedItems.length)
    return error(request, env, 400, "No valid transfer lines were found.");
  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
     VALUES (?1, ?2, ?3, 'external_transfer_sent', 'transfer', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      transferId,
      JSON.stringify({ ...transferMeta, requestedAt, movedItems }),
      createdAt,
    ),
  );

  await env.DB.batch(statements);

  // Central outbox = the shared source of truth for this cross-workspace transfer's lifecycle.
  // (Separate from the local batch above — a batch cannot span the tenant DB + CENTRAL_DB.)
  await env.CENTRAL_DB.prepare(
    `INSERT INTO external_transfers
       (id, from_workspace_id, to_workspace_id, from_location_id, to_location_id, status, items_json, note, created_by, requested_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending_receipt', ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      transferId,
      workspaceId,
      targetWorkspaceId,
      fromLocationId,
      toLocationId,
      JSON.stringify({
        shipped: movedItems,
        received: [],
        shortfalls: [],
        transferMeta: { ...transferMeta, transactionReference, requestedAt },
        lifecycle: {
          status: "pending_receipt",
          transactionReference,
          requestedAt,
        },
      }),
      note,
      auth.uid,
      createdAt,
    )
    .run();

  return json(request, env, {
    ok: true,
    id: transferId,
    transactionReference,
    items: movedItems,
    status: "pending_receipt",
  });
}

export async function acceptExternalTransfer(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  transferId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request);
  const receivedLines = arrayValue(payload.items).map(objectValue);
  // Source of truth is the CENTRAL outbox (the source's transfer_lines live in the sender's own DO).
  const transfer = await env.CENTRAL_DB.prepare(
    `SELECT id, from_workspace_id, to_workspace_id, from_location_id, to_location_id, status, items_json, requested_at
       FROM external_transfers
      WHERE id = ?1
        AND to_workspace_id = ?2
      LIMIT 1`,
  )
    .bind(text(transferId), workspaceId)
    .first<Record<string, unknown>>();

  if (!transfer)
    return error(
      request,
      env,
      404,
      `External transfer ${text(transferId)} could not be found for this workspace.`,
    );
  if (
    text(transfer.status) !== "pending_receipt" &&
    text(transfer.status) !== "pending"
  ) {
    return error(
      request,
      env,
      409,
      `External transfer ${text(transferId)} is already ${text(transfer.status) || "closed"}.`,
    );
  }

  const sourceWorkspaceId = text(transfer.from_workspace_id);
  const targetLocationId = text(transfer.to_location_id);
  const targetLocation = await env.DB.prepare(
    `SELECT id, name, display_name
       FROM locations
      WHERE workspace_id = ?1
        AND id = ?2
        AND active = 1
      LIMIT 1`,
  )
    .bind(workspaceId, targetLocationId)
    .first<{ id: string; name: string; display_name?: string }>();
  if (!targetLocation)
    return error(request, env, 404, "Receiving location could not be found.");

  // Line items come from the outbox items_json (written by the sender), NOT the source's
  // transfer_lines (which live in the sender's own DO, unreachable from here). The envelope parser
  // remains backwards compatible with historical rows that stored a bare array.
  const envelope = parseExternalTransferEnvelope(transfer.items_json);
  const shippedLines = envelope.shipped.map((it) => ({
    stock_item_id: text(it.stockItemId || it.id),
    quantity: numberValue(it.quantity ?? it.qty, 0),
    unit: text(it.unit),
    unit_cost: numberValue(it.unitCost ?? it.unit_cost, 0),
    name: text(it.name),
    category: text(it.category),
  }));
  const lineRows = { results: shippedLines };
  const workspaceRows = await env.CENTRAL_DB.prepare(
    `SELECT id, name FROM workspaces WHERE id IN (?1, ?2)`,
  )
    .bind(sourceWorkspaceId, workspaceId)
    .all<{ id: string; name: string }>();
  const workspaceNames = new Map(
    (workspaceRows.results || []).map((row) => [text(row.id), text(row.name)]),
  );
  const storedMeta = envelope.transferMeta;
  const transferMeta: Record<string, unknown> = {
    ...storedMeta,
    transferType: "external",
    transferScope: "external",
    fromSiteId: sourceWorkspaceId,
    fromSiteName: cleanTransferDisplayName(
      storedMeta.fromSiteName || workspaceNames.get(sourceWorkspaceId),
      sourceWorkspaceId,
      "External Site",
    ),
    fromLocationId: text(transfer.from_location_id),
    fromLocationName: cleanTransferDisplayName(
      storedMeta.fromLocationName,
      transfer.from_location_id,
      "External Location",
    ),
    toSiteId: workspaceId,
    toSiteName: cleanTransferDisplayName(
      workspaceNames.get(workspaceId) || storedMeta.toSiteName,
      workspaceId,
      "Current Site",
    ),
    toLocationId: targetLocationId,
    toLocationName: cleanTransferDisplayName(
      targetLocation.display_name ||
        targetLocation.name ||
        storedMeta.toLocationName,
      targetLocationId,
      "Receiving Location",
    ),
    requestedAt: text(transfer.requested_at || storedMeta.requestedAt),
  };
  const senderTransactionReference = await ensureTransactionReference(
    env,
    sourceWorkspaceId,
    "transfer",
    text(transferId),
    transferMeta.requestedAt,
    text(storedMeta.transactionReference),
  );
  const transactionReference = await ensureTransactionReference(
    env,
    workspaceId,
    "transfer",
    text(transferId),
    transferMeta.requestedAt,
    senderTransactionReference,
  );
  transferMeta.transactionReference = transactionReference;

  const receivedBySourceId = new Map<string, Record<string, unknown>>();
  for (const line of receivedLines) {
    const sourceStockItemId = text(
      line.sourceStockItemId ||
        line.source_stock_item_id ||
        line.transferLineStockItemId ||
        line.stockItemId ||
        line.id,
    );
    if (sourceStockItemId) receivedBySourceId.set(sourceStockItemId, line);
  }

  const now = nowIso();
  const costingMethod = await getWorkspaceInventoryCostingMethod(
    env,
    workspaceId,
  );
  const statements = [];
  const receivedItems = [];
  // Un-received quantities are returned to the SENDER — but the sender's stock lives in its own DO,
  // so we record the shortfalls in the outbox and the sender restores them lazily on getTransfers.
  const shortfalls: Array<{
    sourceStockItemId: string;
    shortfall: number;
    unitCost: number;
  }> = [];

  for (const rawLine of lineRows.results || []) {
    const line = objectValue(rawLine);
    const sourceStockItemId = text(line.stock_item_id);
    const receiptLine = receivedBySourceId.get(sourceStockItemId) || {};
    const shippedQty = numberValue(line.quantity, 0);
    const receivedQty =
      receiptLine.receivedQty === undefined &&
      receiptLine.quantity === undefined &&
      receiptLine.qty === undefined
        ? shippedQty
        : numberValue(
            receiptLine.receivedQty ?? receiptLine.quantity ?? receiptLine.qty,
            0,
          );
    if (receivedQty < 0)
      return error(
        request,
        env,
        400,
        `${text(line.name)} cannot be received with a negative quantity.`,
      );
    if (receivedQty > shippedQty)
      return error(
        request,
        env,
        409,
        `${text(line.name)} cannot receive more than the shipped quantity.`,
      );

    // Unit cost for the return movement is taken from the shipped line so it's available even for
    // a fully rejected line (receivedQty 0), where we never resolve a destination stock item.
    const lineUnitCost = numberValue(line.unit_cost, 0);

    // Credit the destination ONLY when something is actually received. A fully rejected line
    // (receivedQty 0) skips the credit but still returns the full quantity to the sender via the
    // return block below. Previously an early `continue` on receivedQty === 0 skipped BOTH the
    // credit AND the return, silently destroying the stock (sender already deducted at send time).
    if (receivedQty > 0) {
      let targetStockItemId = text(
        receiptLine.targetStockItemId ||
          receiptLine.target_stock_item_id ||
          receiptLine.receivingStockItemId ||
          receiptLine.stockItemId,
      );
      let targetStockItem = targetStockItemId
        ? await env.DB.prepare(
            `SELECT id, name, unit, unit_cost, raw_json
             FROM stock_items
            WHERE workspace_id = ?1
              AND id = ?2
              AND active = 1
              AND ${STOCKED_ITEM_SQL}
            LIMIT 1`,
          )
            .bind(workspaceId, targetStockItemId)
            .first<Record<string, unknown>>()
        : null;

      if (!targetStockItem) {
        targetStockItem = await env.DB.prepare(
          `SELECT id, name, unit, unit_cost, raw_json
             FROM stock_items
            WHERE workspace_id = ?1
              AND active = 1
              AND ${STOCKED_ITEM_SQL}
              AND lower(trim(name)) = lower(trim(?2))
              AND lower(trim(category)) = lower(trim(?3))
              AND lower(trim(unit)) = lower(trim(?4))
            LIMIT 1`,
        )
          .bind(
            workspaceId,
            text(line.name),
            text(line.category),
            text(line.unit),
          )
          .first<Record<string, unknown>>();
        targetStockItemId = text(targetStockItem?.id);
      }

      if (!targetStockItem || !targetStockItemId) {
        return error(
          request,
          env,
          404,
          `${text(line.name)} could not be matched to an active stock item in the receiving workspace.`,
        );
      }

      const balance = await env.DB.prepare(
        `SELECT quantity
           FROM stock_balances
          WHERE workspace_id = ?1
            AND stock_item_id = ?2
            AND location_id = ?3
          LIMIT 1`,
      )
        .bind(workspaceId, targetStockItemId, targetLocationId)
        .first<{ quantity: number }>();
      const before = numberValue(balance?.quantity, 0);
      const unitCost = lineUnitCost;
      const previousTargetCost = (
        await resolveLocationUnitCost(
          env,
          workspaceId,
          targetStockItemId,
          targetLocationId,
          targetStockItem,
        )
      ).cost;
      const nextTargetCost = calculateIncomingLocationCost({
        method: costingMethod,
        previousQuantity: before,
        previousUnitCost: previousTargetCost,
        incomingQuantity: receivedQty,
        incomingUnitCost: unitCost,
      });
      const metadata = JSON.stringify({
        ...transferMeta,
        status: "accepted",
        acceptedAt: now,
        sourceWorkspaceId,
        sourceStockItemId,
        targetBefore: before,
        targetAfter: before + receivedQty,
        shippedQty,
        receivedQty,
        returnedQty: shippedQty - receivedQty,
        costingMethod,
        transferredUnitCost: unitCost,
        previousTargetCost,
        nextTargetCost,
      });

      statements.push(
        env.DB.prepare(
          // Incremental add at destination (two source lines mapping to one target both apply).
          `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
            quantity = stock_balances.quantity + ?4,
            updated_at = excluded.updated_at`,
        ).bind(
          workspaceId,
          targetStockItemId,
          targetLocationId,
          receivedQty,
          now,
        ),
        upsertLocationCostStatement(
          env,
          workspaceId,
          targetStockItemId,
          targetLocationId,
          nextTargetCost,
          now,
        ),
        env.DB.prepare(
          `INSERT INTO stock_movements
            (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
             source_location_id, destination_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
           VALUES (?1, ?2, ?3, ?4, 'transfer_in', 'transfer', ?5, ?6, ?4, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        ).bind(
          id("move"),
          workspaceId,
          targetStockItemId,
          targetLocationId,
          text(transferId),
          text(transfer.from_location_id),
          receivedQty,
          unitCost,
          receivedQty * unitCost,
          now,
          auth.uid,
          metadata,
          now,
        ),
      );

      receivedItems.push({
        sourceStockItemId,
        stockItemId: targetStockItemId,
        id: targetStockItemId,
        name: text(targetStockItem.name || line.name),
        shippedQty,
        receivedQty,
        unit: text(targetStockItem.unit || line.unit),
        unitCost,
        destinationUnitCost: nextTargetCost,
      });
    }

    // Return any un-received quantity to the sender. Covers BOTH a short receipt (0 < received <
    // shipped) AND a fully rejected line (received 0). The sender already deducted the full shipped
    // qty at send time, so we credit the shortfall back to the sender's source location with an
    // audited movement — stock and value are never silently destroyed.
    const shortfall = shippedQty - receivedQty;
    if (shortfall > 0) {
      shortfalls.push({ sourceStockItemId, shortfall, unitCost: lineUnitCost });
    }
  }

  // B's local credits + B's audit (all in B's own DO).
  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'external_transfer_accepted', 'transfer', ?4, ?5, ?6)`,
    ).bind(
      id("audit"),
      workspaceId,
      auth.uid,
      text(transferId),
      JSON.stringify({
        ...transferMeta,
        status: "accepted",
        acceptedAt: now,
        receivedItems,
        shortfalls,
      }),
      now,
    ),
  );
  await env.DB.batch(statements);

  // Flip the CENTRAL outbox to accepted + record what was received and any shortfalls, so the SENDER
  // can restore its own stock lazily (it cannot be touched from here). CAS on status = idempotent.
  const sourceItems = envelope.shipped;
  const nextItemsJson = JSON.stringify({
    shipped: sourceItems,
    received: receivedItems,
    shortfalls,
    transferMeta: {
      ...transferMeta,
      status: "accepted",
      acceptedAt: now,
    },
    lifecycle: {
      status: "accepted",
      requestedAt: transferMeta.requestedAt,
      acceptedAt: now,
      partialAcceptance: shortfalls.length > 0,
      senderReconciled: false,
    },
  });
  await env.CENTRAL_DB.prepare(
    `UPDATE external_transfers
        SET status = 'accepted', accepted_at = ?2, items_json = ?3, updated_at = ?2
      WHERE id = ?1 AND status IN ('pending_receipt', 'pending')`,
  )
    .bind(text(transferId), now, nextItemsJson)
    .run();

  return json(request, env, {
    ok: true,
    id: text(transferId),
    transactionReference,
    items: receivedItems,
    status: "accepted",
  });
}

export async function rejectExternalTransfer(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  transferId: string,
  action = "reject",
) {
  await scoped(request, env, auth, workspaceId);
  // Either the receiving workspace (reject) or the sending workspace (cancel) can stop a
  // pending external transfer. Because the source stock was already deducted when the
  // request was sent, we must RESTORE it and record a reversing movement.
  const transfer = await env.CENTRAL_DB.prepare(
    `SELECT id, from_workspace_id, to_workspace_id, from_location_id, to_location_id, status, items_json
       FROM external_transfers
      WHERE id = ?1
        AND (to_workspace_id = ?2 OR from_workspace_id = ?2)
      LIMIT 1`,
  )
    .bind(text(transferId), workspaceId)
    .first<Record<string, unknown>>();

  if (!transfer)
    return error(
      request,
      env,
      404,
      `External transfer ${text(transferId)} could not be found for this workspace.`,
    );
  if (
    text(transfer.status) !== "pending_receipt" &&
    text(transfer.status) !== "pending"
  ) {
    return error(
      request,
      env,
      409,
      `External transfer ${text(transferId)} is already ${text(transfer.status) || "closed"}.`,
    );
  }

  const envelope = parseExternalTransferEnvelope(transfer.items_json);
  const transferMeta = {
    ...envelope.transferMeta,
    transferType: "external",
    transferScope: "external",
    fromSiteId: text(transfer.from_workspace_id),
    toSiteId: text(transfer.to_workspace_id),
    fromLocationId: text(transfer.from_location_id),
    toLocationId: text(transfer.to_location_id),
  };
  const isSender = text(transfer.from_workspace_id) === workspaceId;
  const newStatus = action === "cancel" || isSender ? "cancelled" : "rejected";
  const fromLocationId = text(transfer.from_location_id);
  const now = nowIso();
  const restoredItems: Array<Record<string, unknown>> = [];

  // Only the SENDER restores stock here (its stock + transfer_lines are local). A receiver reject
  // only flips the outbox; the sender restores lazily on its next getTransfers (reconcileSentTransfers).
  if (isSender) {
    const lineRows = await env.DB.prepare(
      `SELECT stock_item_id, quantity, unit, unit_cost
         FROM transfer_lines
        WHERE workspace_id = ?1
          AND transfer_id = ?2`,
    )
      .bind(workspaceId, text(transferId))
      .all<Record<string, unknown>>();

    const statements = [];
    for (const rawLine of lineRows.results || []) {
      const line = objectValue(rawLine);
      const stockItemId = text(line.stock_item_id);
      const quantity = numberValue(line.quantity, 0);
      if (!stockItemId || !(quantity > 0)) continue;

      const balance = await env.DB.prepare(
        `SELECT quantity FROM stock_balances
          WHERE workspace_id = ?1 AND stock_item_id = ?2 AND location_id = ?3 LIMIT 1`,
      )
        .bind(workspaceId, stockItemId, fromLocationId)
        .first<{ quantity: number }>();
      const before = numberValue(balance?.quantity, 0);
      const unitCost = numberValue(line.unit_cost, 0);
      const metadata = JSON.stringify({
        ...transferMeta,
        status: newStatus,
        acceptedAt: now,
        shippedQty: quantity,
        receivedQty: 0,
        returnedQty: quantity,
        reversedTransferId: text(transferId),
        reason: newStatus,
        before,
        after: before + quantity,
      });

      statements.push(
        env.DB.prepare(
          `INSERT INTO stock_balances (workspace_id, stock_item_id, location_id, quantity, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(workspace_id, stock_item_id, location_id) DO UPDATE SET
            quantity = stock_balances.quantity + ?4,
            updated_at = excluded.updated_at`,
        ).bind(workspaceId, stockItemId, fromLocationId, quantity, now),
        env.DB.prepare(
          `INSERT INTO stock_movements
            (id, workspace_id, stock_item_id, location_id, movement_type, document_type, document_id,
             source_location_id, destination_location_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at)
           VALUES (?1, ?2, ?3, ?4, 'transfer_reversal', 'transfer', ?5, ?4, ?4, ?6, ?7, ?8, ?9, ?10, ?11, ?9)`,
        ).bind(
          id("move"),
          workspaceId,
          stockItemId,
          fromLocationId,
          text(transferId),
          quantity,
          unitCost,
          quantity * unitCost,
          now,
          auth.uid,
          metadata,
        ),
        env.DB.prepare(
          `UPDATE stock_movements
              SET metadata_json = json_patch(
                CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
                ?4
              )
            WHERE workspace_id = ?1
              AND document_type = 'transfer'
              AND document_id = ?2
              AND stock_item_id = ?3
              AND movement_type = 'transfer_out'`,
        ).bind(
          workspaceId,
          text(transferId),
          stockItemId,
          JSON.stringify({
            ...transferMeta,
            status: newStatus,
            acceptedAt: now,
            shippedQty: quantity,
            receivedQty: 0,
            returnedQty: quantity,
          }),
        ),
      );
      restoredItems.push({
        stockItemId,
        quantity,
        restoredTo: before + quantity,
      });
    }

    // Mark the sender's local ledger row so lazy reconcile won't restore it again.
    statements.push(
      env.DB.prepare(
        `UPDATE transfers
            SET status = ?2,
                accepted_at = ?3,
                raw_json = json_patch(
                  CASE WHEN json_valid(raw_json) THEN raw_json ELSE '{}' END,
                  ?5
                )
          WHERE workspace_id = ?4 AND id = ?1`,
      ).bind(
        text(transferId),
        newStatus,
        now,
        workspaceId,
        JSON.stringify({
          ...transferMeta,
          status: newStatus,
          acceptedAt: now,
          lifecycle: {
            status: newStatus,
            acceptedAt: now,
            received: [],
            shortfalls: envelope.shipped.map((item) => ({
              sourceStockItemId: text(item.stockItemId || item.id),
              shortfall: numberValue(item.quantity ?? item.qty, 0),
              unitCost: numberValue(item.unitCost ?? item.unit_cost, 0),
            })),
          },
        }),
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
         VALUES (?1, ?2, ?3, ?4, 'transfer', ?5, ?6, ?7)`,
      ).bind(
        id("audit"),
        workspaceId,
        auth.uid,
        `external_transfer_${newStatus}`,
        text(transferId),
        JSON.stringify({
          ...transferMeta,
          status: newStatus,
          acceptedAt: now,
          restoredItems,
        }),
        now,
      ),
    );
    await env.DB.batch(statements);
  } else {
    // Receiver reject: record B's audit of the rejection locally.
    await env.DB.prepare(
      `INSERT INTO audit_events (id, workspace_id, actor_uid, event_type, entity_type, entity_id, after_json, created_at)
       VALUES (?1, ?2, ?3, 'external_transfer_rejected', 'transfer', ?4, ?5, ?6)`,
    )
      .bind(
        id("audit"),
        workspaceId,
        auth.uid,
        text(transferId),
        JSON.stringify({
          ...transferMeta,
          status: newStatus,
          acceptedAt: now,
          rejected: true,
        }),
        now,
      )
      .run();
  }

  // Flip the central outbox (CAS on still-pending = idempotent).
  const rejectedShortfalls = envelope.shipped.map((item) => ({
    sourceStockItemId: text(item.stockItemId || item.id),
    shortfall: numberValue(item.quantity ?? item.qty, 0),
    unitCost: numberValue(item.unitCost ?? item.unit_cost, 0),
  }));
  await env.CENTRAL_DB.prepare(
    `UPDATE external_transfers
        SET status = ?2,
            accepted_at = ?3,
            items_json = ?4,
            updated_at = ?3
      WHERE id = ?1 AND status IN ('pending_receipt', 'pending')`,
  )
    .bind(
      text(transferId),
      newStatus,
      now,
      JSON.stringify({
        shipped: envelope.shipped,
        received: [],
        shortfalls: rejectedShortfalls,
        transferMeta: { ...transferMeta, status: newStatus, acceptedAt: now },
        lifecycle: {
          status: newStatus,
          acceptedAt: now,
          senderReconciled: isSender,
        },
      }),
    )
    .run();

  return json(request, env, {
    ok: true,
    id: text(transferId),
    status: newStatus,
    items: restoredItems,
  });
}

export async function getDashboardSource(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const url = new URL(request.url);
  const limit = Math.max(
    1,
    Math.min(2000, Number(getParam(url, "limit", "500")) || 500),
  );

  const [movementRows, orderRows, errorRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, movement_type, document_type, document_id, quantity_delta, unit_cost, value_delta, occurred_at, created_by, metadata_json, created_at
         FROM stock_movements
        WHERE workspace_id = ?1
        ORDER BY occurred_at DESC
        LIMIT ?2`,
    )
      .bind(workspaceId, limit)
      .all(),
    env.DB.prepare(
      `SELECT id, yoco_order_id, yoco_payment_id, location_id, order_type, status, payment_method, total, occurred_at, raw_json, created_at
         FROM yoco_orders
        WHERE workspace_id = ?1
        ORDER BY occurred_at DESC
        LIMIT ?2`,
    )
      .bind(workspaceId, limit)
      .all(),
    env.DB.prepare(
      `SELECT id, provider, error_type, message, context_json, created_at
         FROM integration_errors
        WHERE workspace_id = ?1
        ORDER BY created_at DESC
        LIMIT ?2`,
    )
      .bind(workspaceId, limit)
      .all(),
  ]);

  return json(request, env, {
    logs_inventory_audit: movementRows.results || [],
    logs_sales: orderRows.results || [],
    logs_sales_errors: errorRows.results || [],
  });
}

export async function getDashboard(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const url = new URL(request.url);
  const rawLocationId = getParam(url, "locationId");
  // Resolve the requested location through the fuzzy resolver (matches by id, name,
  // display_name, external_name) so a name/legacy id still filters correctly. Falls
  // back to the raw value if it can't be resolved.
  const locationId = rawLocationId
    ? (await resolveActiveLocationId(env, workspaceId, rawLocationId)) ||
      rawLocationId
    : "";
  const from = getParam(url, "from", new Date().toISOString().slice(0, 10));
  const to = getParam(url, "to", new Date().toISOString().slice(0, 10));

  const locationClause = locationId ? "AND sb.location_id = ?2" : "";
  const balanceBinds = locationId ? [workspaceId, locationId] : [workspaceId];

  const valuation = await env.DB.prepare(
    `SELECT
        COUNT(DISTINCT sb.stock_item_id) AS stock_item_count,
        COALESCE(SUM(sb.quantity), 0) AS on_hand_qty,
        COALESCE(SUM(sb.quantity * CASE
          WHEN silp.stock_item_id IS NOT NULL THEN COALESCE(silp.price, 0)
          ELSE COALESCE(
            NULLIF(si.unit_cost, 0),
            json_extract(si.raw_json, '$.lastPurchasePrice'),
            json_extract(si.raw_json, '$.lastPurchaseCost'),
            json_extract(si.raw_json, '$.latestPurchasePrice'),
            json_extract(si.raw_json, '$.costEx'),
            json_extract(si.raw_json, '$.cost'),
            0)
        END), 0) AS stock_value,
        COUNT(DISTINCT CASE WHEN sb.quantity <= si.threshold_qty THEN sb.stock_item_id END) AS low_stock_count
       FROM stock_balances sb
       JOIN stock_items si ON si.id = sb.stock_item_id AND si.workspace_id = sb.workspace_id
	   LEFT JOIN stock_item_location_prices silp
	     ON silp.workspace_id = sb.workspace_id
	    AND silp.stock_item_id = sb.stock_item_id
	    AND silp.location_id = sb.location_id
	      WHERE sb.workspace_id = ?1 ${locationClause}
	        AND si.active = 1
	        AND ${STOCKED_ITEM_ALIAS_SQL("si")}`,
  )
    .bind(...balanceBinds)
    .first();

  const movementBinds = locationId
    ? [workspaceId, locationId, from, to]
    : [workspaceId, from, to];
  const movementLocationClause = locationId ? "AND location_id = ?2" : "";
  const adjustmentLocationClause = locationId ? "AND al.location_id = ?2" : "";
  const fromIndex = locationId ? 3 : 2;
  const toIndex = locationId ? 4 : 3;

  // --- Shared movement classification + valuation: ONE source of truth so the Wastage
  // TILE (summary total) and the Wastage GRAPH (daily series) can never disagree, and so
  // wastage reconciles with the waste dashboard view (which uses the same rule + cost basis). ---
  // Current valuation unit cost — mirrors the frontend getStockValuationUnitCost ladder.
  const CURRENT_COST_SQL = `CASE
    WHEN silp.stock_item_id IS NOT NULL THEN COALESCE(silp.price, 0)
    ELSE COALESCE(
      NULLIF(si.unit_cost, 0),
      json_extract(si.raw_json, '$.lastPurchasePrice'),
      json_extract(si.raw_json, '$.lastPurchaseCost'),
      json_extract(si.raw_json, '$.latestPurchasePrice'),
      json_extract(si.raw_json, '$.costEx'),
      json_extract(si.raw_json, '$.cost'),
      0)
  END`;
  // Transactional movements (sale/grv/credit): the stored value_delta is the ACTUAL
  // transaction amount — trust it, deriving qty×current cost only when it is missing.
  const TXN_VALUE_SQL = `CASE
    WHEN sm.value_delta IS NOT NULL AND sm.value_delta != 0 THEN sm.value_delta
    WHEN sm.unit_cost IS NOT NULL THEN sm.quantity_delta * sm.unit_cost
    ELSE sm.quantity_delta * ${CURRENT_COST_SQL}
  END`;
  const IS_ACCOUNTING_ONLY_SQL = `(json_extract(sm.metadata_json,'$.accountingOnly') IN (1,'true') OR json_extract(sm.metadata_json,'$.dashboardOnly') IN (1,'true'))`;
  const IS_PRODUCT_WASTAGE_SQL = `(lower(COALESCE(sm.document_type, '')) IN ('wastage_adjustment', 'wastage-adjustment'))`;
  // Preserve the valuation captured when the transaction was posted. Revaluing historical
  // wastage/adjustment/stock-take rows at today's cost makes reports change after a later GRV.
  // Accounting-only movements (e.g. manufacturing_wastage) deliberately carry quantity_delta=0
  // (they aren't a real unit-count change — the real stock effect is already recorded on the
  // paired manufacturing_finished_in movement), so qty×cost would wrongly collapse to 0 here —
  // trust the value captured at write time instead for these rows.
  const DERIVED_VALUE_SQL = `CASE
    WHEN ${IS_ACCOUNTING_ONLY_SQL} THEN sm.value_delta
    WHEN sm.value_delta IS NOT NULL AND sm.value_delta != 0 THEN sm.value_delta
    WHEN sm.unit_cost IS NOT NULL THEN sm.quantity_delta * sm.unit_cost
    ELSE sm.quantity_delta * ${CURRENT_COST_SQL}
  END`;
  // Canonical wastage rule (matches frontend isWastageAdjustmentLog): a waste/manufact
  // movement, OR an adjustment with an explicit wasteReason / mode='wastage'. A plain
  // 'remove' or negative qty is a MANUAL adjustment, NOT wastage.
  const IS_WASTE_SQL = `(
    lower(sm.movement_type) LIKE '%waste%'
    OR lower(sm.movement_type) LIKE '%wastage%'
    OR lower(sm.movement_type) = 'manufacturing_wastage'
    OR (lower(sm.movement_type) LIKE '%adjust%' AND (
         lower(COALESCE(json_extract(sm.metadata_json, '$.mode'), '')) = 'wastage'
         OR COALESCE(json_extract(sm.metadata_json, '$.wasteReason'), '') <> ''
       ))
  )`;
  const IS_SALE_SQL = `lower(sm.movement_type) LIKE '%sale%'`;
  const IS_GRV_SQL = `(lower(sm.movement_type) LIKE '%grv%' OR lower(sm.movement_type) LIKE '%goods%')`;
  const IS_CREDIT_SQL = `lower(sm.movement_type) LIKE '%credit%'`;
  const IS_STOCKTAKE_SQL = `(lower(sm.movement_type) LIKE '%stock_take%' OR lower(sm.movement_type) LIKE '%stocktake%')`;
  // Manual adjustment = an adjust-type movement that is NOT wastage.
  const IS_ADJUST_SQL = `(lower(sm.movement_type) LIKE '%adjust%' AND NOT ${IS_WASTE_SQL})`;
  // Subset of IS_WASTE_SQL for manufacturing yield loss specifically, so the dashboard tile
  // can show it as its own line item alongside (not folded silently into) other wastage.
  const IS_MANUFACTURING_WASTE_SQL = `lower(sm.movement_type) = 'manufacturing_wastage' OR lower(sm.movement_type) = 'manufacturing_waste_out'`;
  // Per-movement value chosen by class: transactional keeps stored value; everything
  // else (wastage/adjustment/stock-take) derives qty × current cost.
  const CLASS_VALUE_SQL = `CASE WHEN ${IS_SALE_SQL} OR ${IS_GRV_SQL} OR ${IS_CREDIT_SQL} THEN ${TXN_VALUE_SQL} ELSE ${DERIVED_VALUE_SQL} END`;

  // Grouped movement rows (returned to the client for reference / legacy fallbacks).
  const movements = await env.DB.prepare(
    `SELECT
        sm.movement_type AS movement_type,
        sm.metadata_json AS metadata_json,
        COALESCE(SUM(sm.quantity_delta), 0) AS quantity_delta,
        COALESCE(SUM(${CLASS_VALUE_SQL}), 0) AS value_delta
       FROM stock_movements sm
       LEFT JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
       LEFT JOIN stock_item_location_prices silp
         ON silp.workspace_id = sm.workspace_id
        AND silp.stock_item_id = sm.stock_item_id
        AND silp.location_id = sm.location_id
      WHERE sm.workspace_id = ?1 ${movementLocationClause ? "AND sm.location_id = ?2" : ""}
        AND date(sm.occurred_at) BETWEEN date(?${fromIndex}) AND date(?${toIndex})
      GROUP BY sm.movement_type, sm.metadata_json`,
  )
    .bind(...movementBinds)
    .all();

  // Movement TOTALS in one row using the SAME classification/value the daily series uses,
  // so summary.wastage == Σ movementSeries.wastage exactly (tile == graph).
  const totalsRow = objectValue(
    await env.DB.prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN ${IS_GRV_SQL} THEN ${TXN_VALUE_SQL} ELSE 0 END), 0) AS grv,
        COALESCE(SUM(CASE WHEN ${IS_CREDIT_SQL} THEN ${TXN_VALUE_SQL} ELSE 0 END), 0) AS credit_note,
        COALESCE(SUM(CASE WHEN ${IS_SALE_SQL} THEN ${TXN_VALUE_SQL} ELSE 0 END), 0) AS sale,
        COALESCE(SUM(CASE WHEN ${IS_STOCKTAKE_SQL} THEN ${DERIVED_VALUE_SQL} ELSE 0 END), 0) AS stock_take,
        COALESCE(SUM(CASE WHEN ${IS_WASTE_SQL} AND NOT ${IS_MANUFACTURING_WASTE_SQL} AND NOT ${IS_PRODUCT_WASTAGE_SQL} THEN abs(${DERIVED_VALUE_SQL}) ELSE 0 END), 0) AS wastage,
        COALESCE(SUM(CASE WHEN ${IS_MANUFACTURING_WASTE_SQL} THEN abs(${TXN_VALUE_SQL}) ELSE 0 END), 0) AS manufacturing_wastage,
        COALESCE(SUM(CASE WHEN ${IS_ADJUST_SQL} THEN abs(${DERIVED_VALUE_SQL}) ELSE 0 END), 0) AS adjustment,
        COALESCE(SUM(CASE WHEN NOT ${IS_ACCOUNTING_ONLY_SQL} THEN ${CLASS_VALUE_SQL} ELSE 0 END), 0) AS net_value
       FROM stock_movements sm
       LEFT JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
       LEFT JOIN stock_item_location_prices silp
         ON silp.workspace_id = sm.workspace_id
        AND silp.stock_item_id = sm.stock_item_id
        AND silp.location_id = sm.location_id
      WHERE sm.workspace_id = ?1 ${movementLocationClause ? "AND sm.location_id = ?2" : ""}
        AND date(sm.occurred_at) BETWEEN date(?${fromIndex}) AND date(?${toIndex})`,
    )
      .bind(...movementBinds)
      .first(),
  );

  const productWastageRow = objectValue(
    await env.DB.prepare(
      `SELECT
        COALESCE(SUM(abs(al.quantity_delta * CASE
          WHEN al.unit_cost IS NOT NULL THEN al.unit_cost
          ELSE ${CURRENT_COST_SQL}
        END)), 0) AS product_wastage
       FROM adjustment_lines al
       JOIN adjustments a ON a.id = al.adjustment_id AND a.workspace_id = al.workspace_id
       LEFT JOIN stock_items si ON si.id = al.stock_item_id AND si.workspace_id = al.workspace_id
       LEFT JOIN stock_item_location_prices silp
         ON silp.workspace_id = al.workspace_id
        AND silp.stock_item_id = al.stock_item_id
        AND silp.location_id = al.location_id
      WHERE al.workspace_id = ?1 ${adjustmentLocationClause}
        AND lower(COALESCE(a.adjustment_type, '')) = 'wastage'
        AND date(a.occurred_at) BETWEEN date(?${fromIndex}) AND date(?${toIndex})`,
    )
      .bind(...movementBinds)
      .first(),
  );

  const productWastage = numberValue(productWastageRow.product_wastage, 0);
  const movementTotals = {
    grv: numberValue(totalsRow.grv, 0),
    creditNote: numberValue(totalsRow.credit_note, 0),
    sale: numberValue(totalsRow.sale, 0),
    adjustment: numberValue(totalsRow.adjustment, 0),
    stockTake: numberValue(totalsRow.stock_take, 0),
    wastage: numberValue(totalsRow.wastage, 0) + productWastage,
    manufacturingWastage: numberValue(totalsRow.manufacturing_wastage, 0),
    netValue: numberValue(totalsRow.net_value, 0),
  };

  const stockValue = numberValue(objectValue(valuation).stock_value, 0);
  const costOfSales = Math.abs(movementTotals.sale);
  const countVariance = movementTotals.stockTake;
  const manualAdjustments = movementTotals.adjustment;
  const wastage = Math.abs(
    movementTotals.wastage + movementTotals.manufacturingWastage,
  );
  const openingStock = stockValue - movementTotals.netValue;

  // Daily movement series for the chart — same classification + value expressions as the
  // totals above, so the Wastage line sums exactly to the Wastage tile.
  const dailyRows = await env.DB.prepare(
    `SELECT date(sm.occurred_at) AS day,
            COALESCE(SUM(CASE WHEN ${IS_SALE_SQL} THEN abs(${TXN_VALUE_SQL}) ELSE 0 END), 0) AS cos,
            COALESCE(SUM(CASE WHEN ${IS_WASTE_SQL} AND NOT ${IS_MANUFACTURING_WASTE_SQL} AND NOT ${IS_PRODUCT_WASTAGE_SQL} THEN abs(${DERIVED_VALUE_SQL}) ELSE 0 END), 0) AS waste,
            COALESCE(SUM(CASE WHEN ${IS_MANUFACTURING_WASTE_SQL} THEN abs(${TXN_VALUE_SQL}) ELSE 0 END), 0) AS manuf_waste,
            COALESCE(SUM(CASE WHEN NOT ${IS_ACCOUNTING_ONLY_SQL} THEN ${CLASS_VALUE_SQL} ELSE 0 END), 0) AS net
       FROM stock_movements sm
       LEFT JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
       LEFT JOIN stock_item_location_prices silp
         ON silp.workspace_id = sm.workspace_id
        AND silp.stock_item_id = sm.stock_item_id
        AND silp.location_id = sm.location_id
      WHERE sm.workspace_id = ?1 ${movementLocationClause ? "AND sm.location_id = ?2" : ""}
        AND date(sm.occurred_at) BETWEEN date(?${fromIndex}) AND date(?${toIndex})
      GROUP BY day
      ORDER BY day ASC`,
  )
    .bind(...movementBinds)
    .all();
  const productWastageDaily = await env.DB.prepare(
    `SELECT
        date(a.occurred_at) AS day,
        COALESCE(SUM(abs(al.quantity_delta * CASE
          WHEN al.unit_cost IS NOT NULL THEN al.unit_cost
          ELSE ${CURRENT_COST_SQL}
        END)), 0) AS waste
       FROM adjustment_lines al
       JOIN adjustments a ON a.id = al.adjustment_id AND a.workspace_id = al.workspace_id
       LEFT JOIN stock_items si ON si.id = al.stock_item_id AND si.workspace_id = al.workspace_id
       LEFT JOIN stock_item_location_prices silp
         ON silp.workspace_id = al.workspace_id
        AND silp.stock_item_id = al.stock_item_id
        AND silp.location_id = al.location_id
      WHERE al.workspace_id = ?1 ${adjustmentLocationClause}
        AND lower(COALESCE(a.adjustment_type, '')) = 'wastage'
        AND date(a.occurred_at) BETWEEN date(?${fromIndex}) AND date(?${toIndex})
      GROUP BY day
      ORDER BY day ASC`,
  )
    .bind(...movementBinds)
    .all();

  const days: string[] = [];
  try {
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (
      let d = new Date(start);
      d <= end && days.length <= 400;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      days.push(d.toISOString().slice(0, 10));
    }
  } catch {
    /* ignore malformed range */
  }
  if (!days.length) days.push(to);

  const dayBuckets = new Map<
    string,
    { cos: number; waste: number; manufWaste: number; net: number }
  >();
  for (const day of days)
    dayBuckets.set(day, { cos: 0, waste: 0, manufWaste: 0, net: 0 });
  for (const entry of dailyRows.results || []) {
    const row = objectValue(entry);
    const bucket = dayBuckets.get(text(row.day));
    if (!bucket) continue;
    // cos/waste/net are already classified + valued in SQL (matches the summary tile).
    bucket.cos += numberValue(row.cos, 0);
    bucket.waste += numberValue(row.waste, 0);
    bucket.manufWaste += numberValue(row.manuf_waste, 0);
    bucket.net += numberValue(row.net, 0);
  }
  for (const entry of productWastageDaily.results || []) {
    const row = objectValue(entry);
    const bucket = dayBuckets.get(text(row.day));
    if (!bucket) continue;
    bucket.waste += numberValue(row.waste, 0);
  }
  // End-of-day stock value reconstructed backward from the current valuation.
  const stockValueByDay = new Array(days.length).fill(0);
  let runningStockValue = stockValue;
  for (let i = days.length - 1; i >= 0; i--) {
    stockValueByDay[i] = Number(runningStockValue.toFixed(2));
    runningStockValue -= dayBuckets.get(days[i])?.net || 0;
  }
  const round2 = (n: number) => Number((n || 0).toFixed(2));
  const movementSeries = {
    labels: days,
    costOfSales: days.map((d) => round2(dayBuckets.get(d)?.cos || 0)),
    wastage: days.map((d) => round2(dayBuckets.get(d)?.waste || 0)),
    manufacturingWastage: days.map((d) =>
      round2(dayBuckets.get(d)?.manufWaste || 0),
    ),
    stockValue: stockValueByDay,
  };

  const lowStockRows = await env.DB.prepare(
    `SELECT
        sb.stock_item_id AS itemId,
        si.name,
        si.category,
        sb.location_id AS locationId,
        COALESCE(l.display_name, l.name, sb.location_id) AS locationName,
        sb.quantity AS currentStock,
        si.threshold_qty AS threshold,
        si.unit,
        MAX(0, si.threshold_qty - sb.quantity) * CASE
          WHEN silp.stock_item_id IS NOT NULL THEN COALESCE(silp.price, 0)
          ELSE COALESCE(
            NULLIF(si.unit_cost, 0),
            json_extract(si.raw_json, '$.lastPurchasePrice'),
            json_extract(si.raw_json, '$.lastPurchaseCost'),
            json_extract(si.raw_json, '$.latestPurchasePrice'),
            json_extract(si.raw_json, '$.costEx'),
            json_extract(si.raw_json, '$.cost'),
            0)
        END AS deficitValue
       FROM stock_balances sb
       JOIN stock_items si ON si.id = sb.stock_item_id AND si.workspace_id = sb.workspace_id
       LEFT JOIN locations l ON l.id = sb.location_id AND l.workspace_id = sb.workspace_id
       LEFT JOIN stock_item_location_prices silp
         ON silp.workspace_id = sb.workspace_id
        AND silp.stock_item_id = sb.stock_item_id
        AND silp.location_id = sb.location_id
	      WHERE sb.workspace_id = ?1 ${locationId ? "AND sb.location_id = ?2" : ""}
	        AND si.active = 1
	        AND ${STOCKED_ITEM_ALIAS_SQL("si")}
        AND sb.quantity <= si.threshold_qty
      ORDER BY deficitValue DESC, si.name ASC
      LIMIT 100`,
  )
    .bind(...balanceBinds)
    .all();

  const [
    openPurchaseOrders,
    grvsPending,
    activeSuppliers,
    stockTakeTemplateCount,
    openStockTakeCount,
    recipesUpdated,
    averageGpRow,
    pendingExternalTransfers,
    recentActivity,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM purchase_orders
        WHERE workspace_id = ?1
          AND lower(status) NOT IN ('closed', 'complete', 'completed', 'cancelled', 'archived')`,
    )
      .bind(workspaceId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM purchase_orders
        WHERE workspace_id = ?1
          AND (lower(status) IN ('ordered', 'open', 'pending') OR lower(status) LIKE '%pending%')`,
    )
      .bind(workspaceId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM suppliers
        WHERE workspace_id = ?1
          AND active = 1`,
    )
      .bind(workspaceId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM stocktake_templates
        WHERE workspace_id = ?1
          AND active = 1`,
    )
      .bind(workspaceId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM stocktake_sessions
        WHERE workspace_id = ?1
          AND lower(status) NOT IN ('posted', 'complete', 'completed', 'closed', 'cancelled', 'canceled', 'deleted', 'archived')`,
    )
      .bind(workspaceId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM recipes
        WHERE workspace_id = ?1
          AND active = 1`,
    )
      .bind(workspaceId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(AVG(((p.price - COALESCE(recipe_costs.recipe_cost, linked_recipe_costs.recipe_cost, 0)) / p.price) * 100), 0) AS average_gp
	         FROM products p
	         LEFT JOIN (
	           SELECT
	             r.owner_id,
	             SUM(rl.quantity * si.unit_cost) AS recipe_cost
            FROM recipes r
            JOIN recipe_lines rl ON rl.recipe_id = r.id AND rl.workspace_id = r.workspace_id
            JOIN stock_items si ON si.id = rl.stock_item_id AND si.workspace_id = rl.workspace_id
           WHERE r.workspace_id = ?1
	             AND r.owner_type = 'product'
	             AND r.active = 1
	           GROUP BY r.owner_id
	         ) recipe_costs ON recipe_costs.owner_id = p.id
	         LEFT JOIN (
	           SELECT
	             p2.id AS product_id,
	             SUM(rl.quantity * si.unit_cost) AS recipe_cost
	            FROM products p2
	            JOIN recipes r ON r.workspace_id = p2.workspace_id
	             AND r.owner_type = 'stock_item'
	             AND r.owner_id = p2.recipe_source_stock_item_id
	             AND r.active = 1
	            JOIN recipe_lines rl ON rl.recipe_id = r.id AND rl.workspace_id = r.workspace_id
	            JOIN stock_items si ON si.id = rl.stock_item_id AND si.workspace_id = rl.workspace_id
	           WHERE p2.workspace_id = ?1
	           GROUP BY p2.id
	         ) linked_recipe_costs ON linked_recipe_costs.product_id = p.id AND recipe_costs.owner_id IS NULL
	        WHERE p.workspace_id = ?1
	          AND p.active = 1
	          AND p.price > 0`,
    )
      .bind(workspaceId)
      .first<{ average_gp: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM transfers
        WHERE transfer_type <> 'internal'
          AND to_workspace_id = ?1
          AND lower(status) IN ('pending_receipt', 'pending')`,
    )
      .bind(workspaceId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT * FROM (
        SELECT
          t.id,
          'transfer' AS type,
          CASE WHEN lower(t.status) = 'pending_receipt' THEN 'External Transfer Awaiting Receipt' ELSE 'Transfer Posted' END AS title,
          COALESCE(tl.display_name, tl.name, fl.display_name, fl.name, 'Workspace activity') AS location,
          t.requested_at AS timestamp
         FROM transfers t
         LEFT JOIN locations fl ON fl.id = t.from_location_id
         LEFT JOIN locations tl ON tl.id = t.to_location_id
        WHERE t.workspace_id = ?1
           OR (t.transfer_type <> 'internal' AND t.to_workspace_id = ?1)
        UNION ALL
        SELECT
          sts.id,
          'stocktake' AS type,
          'Stock Count Completed' AS title,
          COALESCE(l.display_name, l.name, 'Workspace activity') AS location,
          COALESCE(sts.counted_at, sts.updated_at, sts.created_at) AS timestamp
         FROM stocktake_sessions sts
         LEFT JOIN locations l ON l.id = sts.location_id
        WHERE sts.workspace_id = ?1
      UNION ALL
        SELECT
          sm.id,
          CASE
            WHEN sm.movement_type LIKE '%sale%' THEN 'sale'
            WHEN sm.movement_type LIKE '%grv%' THEN 'grv'
            WHEN sm.movement_type LIKE '%manufact%' THEN 'manufacturing'
            WHEN sm.movement_type LIKE '%adjust%' THEN 'adjustment'
            WHEN sm.movement_type LIKE '%transfer%' THEN 'transfer'
            ELSE 'movement'
          END AS type,
          CASE
            WHEN sm.movement_type LIKE '%sale%' THEN 'Sale Synced'
            WHEN sm.movement_type LIKE '%grv%' THEN 'GRV Received'
            WHEN sm.movement_type LIKE '%manufact%' THEN 'Manufacturing Posted'
            WHEN sm.movement_type LIKE '%adjust%' THEN 'Manual Adjustment Added'
            WHEN sm.movement_type LIKE '%transfer%' THEN 'Transfer Posted'
            ELSE 'Stock Movement'
          END AS title,
          COALESCE(si.name, l.display_name, l.name, 'Workspace activity') AS location,
          sm.occurred_at AS timestamp
         FROM stock_movements sm
         LEFT JOIN stock_items si ON si.id = sm.stock_item_id AND si.workspace_id = sm.workspace_id
         LEFT JOIN locations l ON l.id = sm.location_id AND l.workspace_id = sm.workspace_id
        WHERE sm.workspace_id = ?1
      UNION ALL
        SELECT
          po.id,
          'purchase-order' AS type,
          'Purchase Order Updated' AS title,
          COALESCE(s.name, 'Workspace activity') AS location,
          COALESCE(po.updated_at, po.ordered_at, po.created_at) AS timestamp
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.workspace_id = po.workspace_id
        WHERE po.workspace_id = ?1
      )
      ORDER BY timestamp DESC
      LIMIT 8`,
    )
      .bind(workspaceId)
      .all(),
  ]);

  const lowStock = arrayValue(lowStockRows.results).map((entry) => {
    const row = objectValue(entry);
    const currentStock = numberValue(row.currentStock, 0);
    return {
      id: `${text(row.itemId)}:${text(row.locationId)}`,
      itemId: text(row.itemId),
      name: text(row.name),
      item: text(row.name),
      category: text(row.category),
      locationId: text(row.locationId),
      locationName: text(row.locationName),
      currentStock,
      threshold: numberValue(row.threshold, 0),
      unit: text(row.unit),
      severity: currentStock <= 0 ? "Critical" : "Medium",
      deficitValue: numberValue(row.deficitValue, 0),
    };
  });
  const lowStockItemCount = new Set(
    lowStock.map((row) => text(row.itemId)).filter(Boolean),
  ).size;
  const stockTakesDue =
    numberValue(stockTakeTemplateCount?.count, 0) ||
    numberValue(openStockTakeCount?.count, 0);
  const averageGp = numberValue(averageGpRow?.average_gp, 0);
  const insightCounts = {
    lowStockCount: lowStockItemCount,
    lowStockLocationCount: lowStock.length,
    openPurchaseOrders: numberValue(openPurchaseOrders?.count, 0),
    activeSuppliers: numberValue(activeSuppliers?.count, 0),
    grvsPending: numberValue(grvsPending?.count, 0),
    stockTakesDue,
    recipesUpdated: numberValue(recipesUpdated?.count, 0),
    pendingExternalTransfers: numberValue(pendingExternalTransfers?.count, 0),
  };

  return json(request, env, {
    ok: true,
    range: { from, to },
    locationId: locationId || null,
    valuation,
    movements: movements.results || [],
    movementTotals,
    movementSeries,
    summary: {
      stockValue: { raw: stockValue, type: "currency" },
      totalStockValue: { raw: stockValue, type: "currency" },
      openingStock: { raw: openingStock, type: "currency" },
      closingStock: { raw: stockValue, type: "currency" },
      costOfSales: { raw: costOfSales, type: "currency" },
      countVariance: { raw: countVariance, type: "currency" },
      manualAdjustments: { raw: manualAdjustments, type: "currency" },
      wastage: { raw: wastage, type: "currency" },
      manufacturingWastage: {
        raw: numberValue(movementTotals.manufacturingWastage, 0),
        type: "currency",
      },
      lowStockCount: { raw: insightCounts.lowStockCount, type: "number" },
      gpPercentage: { raw: averageGp, type: "percent" },
      averageGp: { raw: averageGp, type: "percent" },
    },
    insights: {
      ...insightCounts,
      lowStockRows: lowStock,
      pendingExternalTransferRows: [],
      recentActivity: recentActivity.results || [],
    },
  });
}

export async function postImportPreview(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<{
    locations?: unknown[];
    stockItems?: unknown[];
    options?: Record<string, unknown>;
  }>(request);
  const locations = arrayValue(payload.locations)
    .map(objectValue)
    .filter((location) => !isImportTemplateExampleRow(location))
    .filter((location) =>
      text(
        location.name ||
          location.displayName ||
          location.display_name ||
          location.id ||
          location.locationId,
      ),
    );
  const stockItems = arrayValue(payload.stockItems)
    .map(objectValue)
    .filter((item) => !isImportTemplateExampleRow(item))
    .filter((item) => text(item.name || item.ingredientName));
  const importedLocations: string[] = [];
  const importedStockItems: string[] = [];

  for (const location of locations) {
    importedLocations.push(
      await saveLocationRecord(env, auth, workspaceId, location),
    );
  }

  const fallbackLocation =
    text(
      payload.options?.defaultImportLocationId || payload.options?.locationId,
    ) || (await defaultLocationId(env, workspaceId));
  for (const stockItem of stockItems) {
    importedStockItems.push(
      await saveStockItem(
        env,
        auth,
        workspaceId,
        {
          ...stripStockBalanceImportFields(stockItem),
          locationId:
            text(
              stockItem.locationId ||
                stockItem.targetLocation ||
                stockItem.defaultLocationId,
            ) || fallbackLocation,
        },
        { allowStockBalanceUpdate: false },
      ),
    );
  }

  return json(request, env, {
    ok: true,
    message: "Snapshot import completed.",
    counts: {
      locations: importedLocations.length,
      stockItems: importedStockItems.length,
    },
    imported: {
      locations: importedLocations,
      stockItems: importedStockItems,
    },
  });
}

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_SCOPES = ["openid", "email", "profile", GMAIL_SEND_SCOPE];

function gmailTokenSecret(env: Env) {
  return text(
    env.GMAIL_TOKEN_ENCRYPTION_SECRET || env.YOCO_KEY_ENCRYPTION_SECRET,
  );
}

function gmailStateSecret(env: Env) {
  return text(
    env.GMAIL_OAUTH_STATE_SECRET ||
      env.GMAIL_TOKEN_ENCRYPTION_SECRET ||
      env.YOCO_KEY_ENCRYPTION_SECRET ||
      env.GMAIL_CLIENT_SECRET,
  );
}

function gmailConfigured(env: Env) {
  return Boolean(
    text(env.GMAIL_CLIENT_ID) &&
    text(env.GMAIL_CLIENT_SECRET) &&
    gmailTokenSecret(env) &&
    gmailStateSecret(env),
  );
}

function gmailRedirectUri(request: Request, env: Env) {
  return (
    text(env.GMAIL_OAUTH_REDIRECT_URI) ||
    `${new URL(request.url).origin}/api/gmail/oauth/callback`
  );
}

function sanitizeGmailConnection(raw: Record<string, unknown>) {
  const gmail = objectValue(objectValue(raw.integrations).gmail);
  const status = text(gmail.status || "disconnected").toLowerCase();
  return {
    status,
    connectionActive:
      status === "connected" && Boolean(text(gmail.refreshTokenEncrypted)),
    accountEmail: text(gmail.accountEmail),
    accountName: text(gmail.accountName),
    connectedAt: text(gmail.connectedAt),
    connectedBy: text(gmail.connectedByEmail),
    lastSentAt: text(gmail.lastSentAt),
    lastError: text(gmail.lastError),
    scope: text(gmail.scope),
    configured: true,
  };
}

async function getWorkspaceSettingsRaw(env: Env, workspaceId: string) {
  const row = await env.DB.prepare(
    `SELECT raw_json
       FROM workspace_settings
      WHERE workspace_id = ?1
      LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ raw_json?: string }>();
  return objectValue(jsonParse(row?.raw_json));
}

async function saveWorkspaceSettingsRaw(
  env: Env,
  workspaceId: string,
  settings: Record<string, unknown>,
) {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO workspace_settings (workspace_id, raw_json, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(workspace_id) DO UPDATE SET
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at`,
  )
    .bind(workspaceId, JSON.stringify({ ...settings, updatedAt: now }), now)
    .run();
}

async function signGmailState(env: Env, state: Record<string, unknown>) {
  const secret = gmailStateSecret(env);
  if (!secret) throw new Error("Gmail OAuth state secret is not configured.");
  const payload = base64UrlEncodeText(JSON.stringify(state));
  const signature = (await hmacSha256Base64(secret, payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${payload}.${signature}`;
}

async function verifyGmailState(env: Env, value: string) {
  const [payload, signature] = String(value || "").split(".");
  if (!payload || !signature)
    throw new Error("Gmail connection state is invalid.");
  const secret = gmailStateSecret(env);
  if (!secret) throw new Error("Gmail OAuth state secret is not configured.");
  const expected = (await hmacSha256Base64(secret, payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  if (signature !== expected)
    throw new Error("Gmail connection state could not be verified.");
  const parsed = objectValue(jsonParse(base64UrlDecodeText(payload)));
  const issuedAt = numberValue(parsed.iat, 0);
  if (!issuedAt || Date.now() - issuedAt > 10 * 60 * 1000)
    throw new Error(
      "Gmail connection link has expired. Start the connection again.",
    );
  return parsed;
}

async function exchangeGmailCode(request: Request, env: Env, code: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: text(env.GMAIL_CLIENT_ID),
      client_secret: text(env.GMAIL_CLIENT_SECRET),
      redirect_uri: gmailRedirectUri(request, env),
      grant_type: "authorization_code",
    }),
  });
  const result = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new Error(
      text(
        result.error_description ||
          result.error ||
          "Google did not return a Gmail access token.",
      ),
    );
  return result;
}

async function fetchGmailUserInfo(accessToken: string) {
  const response = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  const result = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new Error("Could not confirm the linked Gmail account.");
  return result;
}

async function refreshGmailAccessToken(
  env: Env,
  refreshTokenEncrypted: string,
) {
  const secret = gmailTokenSecret(env);
  if (!secret)
    throw new Error("Gmail token encryption secret is not configured.");
  const refreshToken = await decryptTextWithSecret(
    secret,
    refreshTokenEncrypted,
  );
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: text(env.GMAIL_CLIENT_ID),
      client_secret: text(env.GMAIL_CLIENT_SECRET),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const result = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new Error(
      text(
        result.error_description ||
          result.error ||
          "Google could not refresh Gmail access.",
      ),
    );
  return text(result.access_token);
}

function gmailCallbackHtml(message: string, ok = true, returnUrl = "") {
  const safeMessage = text(message).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeReturnUrl = text(returnUrl).replace(/"/g, "&quot;");
  return new Response(
    `<!doctype html>
<html><head><meta charset="utf-8"><title>Gmail ${ok ? "Connected" : "Connection Failed"}</title></head>
<body style="font-family:Inter,Arial,sans-serif;background:#08111f;color:#f5f8ff;display:grid;place-items:center;min-height:100vh;margin:0">
  <main style="max-width:520px;padding:28px;border:1px solid #28415f;border-radius:16px;background:#101b2c;text-align:center">
    <h1 style="margin:0 0 12px">${ok ? "Gmail connected" : "Gmail connection failed"}</h1>
    <p style="color:#aebbd0">${safeMessage}</p>
    ${safeReturnUrl ? `<a href="${safeReturnUrl}" style="color:#7cb7ff">Return to Kitchen Cost Pro</a>` : ""}
  </main>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'kcp:gmail-oauth', ok: ${ok ? "true" : "false"}, message: ${JSON.stringify(message)} }, '*');
      window.setTimeout(() => window.close(), 900);
    }
  </script>
</body></html>`,
    {
      status: ok ? 200 : 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

export async function getGmailStatus(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  if (!gmailConfigured(env)) {
    return json(request, env, {
      ok: true,
      status: "not_configured",
      connectionActive: false,
      configured: false,
      message: "Gmail OAuth is not configured for this environment.",
    });
  }
  const settings = await getWorkspaceSettingsRaw(env, workspaceId);
  return json(request, env, { ok: true, ...sanitizeGmailConnection(settings) });
}

export async function postGmailConnectStart(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  if (!gmailConfigured(env))
    return error(request, env, 400, "Gmail OAuth is not configured.");
  const origin =
    text(request.headers.get("origin")) ||
    text(env.APP_BASE_URL) ||
    new URL(request.url).origin;
  const state = await signGmailState(env, {
    workspaceId,
    uid: auth.uid,
    email: auth.email,
    returnUrl: `${origin.replace(/\/+$/, "")}/?route=integrations&gmail=connected`,
    iat: Date.now(),
    nonce: id("gmail_state"),
  });
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", text(env.GMAIL_CLIENT_ID));
  authUrl.searchParams.set("redirect_uri", gmailRedirectUri(request, env));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  return json(request, env, {
    ok: true,
    authUrl: authUrl.toString(),
    redirectUri: gmailRedirectUri(request, env),
    scopes: GMAIL_SCOPES,
  });
}

export async function getGmailOAuthCallback(request: Request, env: Env) {
  const url = new URL(request.url);
  // System Gmail connect uses state prefixed with "system:"
  const rawState = text(url.searchParams.get("state"));
  if (rawState.startsWith("system:")) {
    return getAdminGmailCallback(request, env);
  }
  try {
    if (!gmailConfigured(env))
      throw new Error("Gmail OAuth is not configured.");
    const code = text(url.searchParams.get("code"));
    const stateValue = rawState;
    const googleError = text(url.searchParams.get("error"));
    if (googleError) throw new Error(googleError);
    if (!code) throw new Error("Google did not return an authorization code.");
    const state = await verifyGmailState(env, stateValue);
    const workspaceId = text(state.workspaceId);
    if (!workspaceId)
      throw new Error("Workspace is missing from the Gmail connection state.");

    const token = await exchangeGmailCode(request, env, code);
    const accessToken = text(token.access_token);
    const refreshToken = text(token.refresh_token);
    if (!accessToken)
      throw new Error("Google did not return a Gmail access token.");
    if (!refreshToken)
      throw new Error(
        "Google did not return a refresh token. Remove the app from your Google account permissions and connect again.",
      );
    const userInfo = await fetchGmailUserInfo(accessToken);
    const secret = gmailTokenSecret(env);
    const settings = await getWorkspaceSettingsRaw(env, workspaceId);
    const integrations = objectValue(settings.integrations);
    integrations.gmail = {
      status: "connected",
      accountEmail: text(userInfo.email),
      accountName: text(userInfo.name || userInfo.email),
      connectedAt: nowIso(),
      connectedByUid: text(state.uid),
      connectedByEmail: text(state.email),
      refreshTokenEncrypted: await encryptTextWithSecret(secret, refreshToken),
      scope: text(token.scope || GMAIL_SCOPES.join(" ")),
      tokenType: text(token.token_type || "Bearer"),
    };
    await saveWorkspaceSettingsRaw(env, workspaceId, {
      ...settings,
      integrations,
    });
    return gmailCallbackHtml(
      `Connected ${text(userInfo.email || "Gmail")} for supplier communication.`,
      true,
      text(state.returnUrl),
    );
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "Gmail connection failed.";
    return gmailCallbackHtml(message, false);
  }
}

export async function postGmailDisconnect(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const settings = await getWorkspaceSettingsRaw(env, workspaceId);
  const integrations = objectValue(settings.integrations);
  integrations.gmail = {
    ...objectValue(integrations.gmail),
    status: "disconnected",
    disconnectedAt: nowIso(),
    disconnectedByUid: auth.uid,
    disconnectedByEmail: auth.email,
    refreshTokenEncrypted: "",
  };
  await saveWorkspaceSettingsRaw(env, workspaceId, {
    ...settings,
    integrations,
  });
  return json(request, env, { ok: true, status: "disconnected" });
}

function encodeMimeHeader(value: string) {
  const raw = text(value);
  if (/^[\x00-\x7F]*$/.test(raw)) return raw;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(raw)))}?=`;
}

function gmailSupplierFromName(settings: Record<string, unknown>) {
  const businessName = text(
    settings.siteName ||
      settings.businessName ||
      settings.workspaceName ||
      settings.name,
  );
  return businessName ? `${businessName} - KCP` : "Kitchen Cost Pro - KCP";
}

function formatMimeAddress(
  email: string,
  displayName = "Kitchen Cost Pro - KCP",
) {
  const cleanEmail = text(email);
  const cleanName = text(displayName, "Kitchen Cost Pro - KCP").replace(
    /"/g,
    '\\"',
  );
  if (!cleanEmail) return encodeMimeHeader(cleanName);
  return `"${encodeMimeHeader(cleanName)}" <${cleanEmail}>`;
}

function normalizeAttachment(value: unknown) {
  const entry = objectValue(value);
  const filename = text(entry.filename || entry.name);
  const contentType = text(
    entry.contentType || entry.type || "application/octet-stream",
  );
  const rawContent = text(entry.base64 || entry.content || entry.data);
  const base64 = rawContent.includes(",")
    ? rawContent.split(",").pop() || ""
    : rawContent;
  return filename && base64 ? { filename, contentType, base64 } : null;
}

function buildGmailMime(
  payload: Record<string, unknown>,
  fromEmail: string,
  fallbackFromName = "Kitchen Cost Pro - KCP",
) {
  const to = text(payload.to);
  const cc = text(payload.cc);
  const subject = text(payload.subject, "Supplier communication");
  const body = text(payload.body);
  const attachments = arrayValue(payload.attachments)
    .map(normalizeAttachment)
    .filter(Boolean) as Array<{
    filename: string;
    contentType: string;
    base64: string;
  }>;
  if (!to || !to.includes("@"))
    throw new Error("Supplier email recipient is required.");
  if (!body && !attachments.length)
    throw new Error("Email body or attachment is required.");
  const headers = [
    `From: ${formatMimeAddress(fromEmail, text(payload.fromName || fallbackFromName))}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    `Subject: ${encodeMimeHeader(subject)}`,
    "MIME-Version: 1.0",
  ].filter(Boolean);
  if (!attachments.length) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      body,
    ].join("\r\n");
  }
  const boundary = `kcp_${crypto.randomUUID().replace(/-/g, "")}`;
  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body || "Please see attached.",
    "",
  ];
  attachments.forEach((attachment) => {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename.replace(/"/g, "")}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.filename.replace(/"/g, "")}"`,
      "",
      attachment.base64.replace(/\s/g, "").replace(/(.{76})/g, "$1\r\n"),
      "",
    );
  });
  lines.push(`--${boundary}--`);
  return lines.join("\r\n");
}

function gmailSendErrorMessage(result: Record<string, unknown>) {
  const errorBody = objectValue(result.error);
  const message = text(
    errorBody.message || result.message || result.error || "Gmail send failed.",
  );
  const status = text(errorBody.status).toLowerCase();
  const details = JSON.stringify(arrayValue(errorBody.details));
  const combined = `${message} ${status} ${details}`.toLowerCase();
  if (
    combined.includes("service_disabled") ||
    combined.includes("accessnotconfigured") ||
    combined.includes("api has not been used") ||
    (combined.includes("gmail api") && combined.includes("disabled"))
  ) {
    return "Gmail API is disabled for this Google Cloud project. Enable Gmail API for the OAuth project, wait a few minutes, then try sending again.";
  }
  if (combined.includes("insufficient") && combined.includes("permission")) {
    return "Gmail permission is missing. Reconnect Gmail and approve send-only access.";
  }
  return message;
}

export async function postGmailSendSupplierEmail(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  if (!gmailConfigured(env))
    return error(request, env, 400, "Gmail OAuth is not configured.");
  const payload = objectValue(await readJson<Record<string, unknown>>(request));
  const settings = await getWorkspaceSettingsRaw(env, workspaceId);
  const gmail = objectValue(objectValue(settings.integrations).gmail);
  if (
    text(gmail.status).toLowerCase() !== "connected" ||
    !text(gmail.refreshTokenEncrypted)
  ) {
    return error(
      request,
      env,
      409,
      "Connect Gmail before sending supplier emails.",
    );
  }
  const accessToken = await refreshGmailAccessToken(
    env,
    text(gmail.refreshTokenEncrypted),
  );
  const fromEmail = text(gmail.accountEmail || auth.email);
  // Defense-in-depth: always CC the logged-in user so they stay on the supplier
  // chain even if the client omits it. Dedupe and never self-CC the recipient.
  const currentUserEmail = text(auth.email).trim();
  if (
    currentUserEmail &&
    currentUserEmail.toLowerCase() !== text(payload.to).trim().toLowerCase()
  ) {
    const ccParts = text(payload.cc)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (
      !ccParts.some(
        (part) => part.toLowerCase() === currentUserEmail.toLowerCase(),
      )
    ) {
      ccParts.push(currentUserEmail);
    }
    payload.cc = ccParts.join(", ");
  }
  const raw = base64UrlEncodeText(
    buildGmailMime(payload, fromEmail, gmailSupplierFromName(settings)),
  );
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
  );
  const result = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const providerError = response.ok ? "" : gmailSendErrorMessage(result);
  const integrations = objectValue(settings.integrations);
  const sentAt = nowIso();
  integrations.gmail = {
    ...gmail,
    lastSentAt: sentAt,
    lastError: providerError,
  };
  await saveWorkspaceSettingsRaw(env, workspaceId, {
    ...settings,
    integrations,
  });
  if (!response.ok)
    return error(request, env, response.status, providerError, result);
  return json(request, env, {
    ok: true,
    id: text(result.id),
    threadId: text(result.threadId),
    sentAt,
  });
}

export async function postYocoConnect(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<{
    apiKey?: string;
  }>(request);
  const denied = await denyUnlessPermissionManager(request, env, auth, workspaceId);
  if (denied) return denied;
  const connection = await connectYoco(env, workspaceId, payload.apiKey || "", { actorUid: auth.uid });
  const catalogue = await syncYocoCatalogue(env, workspaceId);
  const sales = {
    skipped: true,
    reason: "Initial Yoco connection imports the catalogue only. Historical orders are not imported or deducted.",
  };
  return json(request, env, {
    ok: true,
    ...connection,
    ...catalogue,
    ...sales,
    catalogueSync: catalogue,
    salesSync: sales,
  });
}

// Lightweight change signal for the cross-user live-refresh poll. Combines the Yoco sync markers
// with the most recent write timestamps in the two highest-traffic audit trails: stock_movements
// (every stock mutation) and audit_events (settings, members, roles, adjustments, credit notes,
// transfers, etc.). The stock_movements / audit_events MAX() reads hit a (workspace_id, created_at)
// index, so this stays a cheap indexed lookup — safe to poll often. When the returned version
// differs from the client's last-seen value, the client refetches its active tab. Not every table
// is covered (e.g. pure location/menu renames), so this is a best-effort cross-user signal layered
// on top of the acting user's immediate local refresh.
export async function getDataVersion(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(
         (SELECT MAX(COALESCE(processed_at, created_at)) FROM yoco_webhook_events WHERE workspace_id = ?1 AND created_at > datetime('now', '-12 hours')),
         (SELECT last_sales_sync_at FROM yoco_connections WHERE workspace_id = ?1),
         ''
       ) AS yoco,
       (SELECT COALESCE(MAX(created_at), '') FROM stock_movements WHERE workspace_id = ?1) AS mv,
       (SELECT COALESCE(MAX(created_at), '') FROM audit_events WHERE workspace_id = ?1) AS au`,
  )
    .bind(workspaceId)
    .first<{ yoco: string; mv: string; au: string }>();
  const version = `${text(row?.yoco)}|${text(row?.mv)}|${text(row?.au)}`;
  return json(request, env, { version });
}

export async function getYocoStatus(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const [connection, catalogue, modifierCatalogue, locations] =
    await Promise.all([
      getYocoConnection(env, workspaceId),
      env.DB.prepare(
        `SELECT COUNT(*) AS itemsCount
         FROM products
        WHERE workspace_id = ?1 AND external_provider = 'yoco' AND active = 1`,
      )
        .bind(workspaceId)
        .first<{ itemsCount: number }>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS modifierGroupsCount,
              COALESCE(SUM(product_modifier_count), 0) AS productModifiersCount
         FROM yoco_modifier_groups
        WHERE workspace_id = ?1`,
      )
        .bind(workspaceId)
        .first<{
          modifierGroupsCount: number;
          productModifiersCount: number;
        }>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM locations
        WHERE workspace_id = ?1 AND external_provider = 'yoco' AND active = 1`,
      )
        .bind(workspaceId)
        .first<{ count: number }>(),
    ]);

  const status = text(connection?.status || "disconnected").toLowerCase();
  return json(request, env, {
    ok: true,
    status,
    connectionActive:
      connection?.connection_active === 1 || status === "connected",
    syncState: "idle",
    health: connection?.last_error
      ? "attention"
      : status === "connected"
        ? "healthy"
        : "offline",
    connectedAt: connection?.created_at || "",
    disconnectedAt: connection?.disconnected_at || "",
    lastSyncCompletedAt:
      connection?.last_sales_sync_at ||
      connection?.last_catalogue_sync_at ||
      "",
    lastError: connection?.last_error || "",
    webhook: {
      enabled: Boolean(connection?.webhook_id || connection?.webhook_secret),
      id: connection?.webhook_id || "",
      url: connection?.webhook_url || "",
    },
    catalogue: {
      itemsCount: Number(catalogue?.itemsCount || 0),
      modifierGroupsCount: Number(modifierCatalogue?.modifierGroupsCount || 0),
      productModifiersCount: Number(
        modifierCatalogue?.productModifiersCount || 0,
      ),
    },
    locations: { count: Number(locations?.count || 0) },
  });
}

function rawModifierId(modifier: Record<string, unknown>) {
  return text(
    modifier.modifier_id || modifier.modifierId || modifier.id || modifier.uuid,
  );
}

function rawModifierVariantId(modifier: Record<string, unknown>) {
  const product = objectValue(modifier.product);
  const item = objectValue(modifier.item);
  const variant = objectValue(modifier.variant);
  const productVariant = objectValue(
    modifier.product_variant || modifier.productVariant,
  );
  return text(
    modifier.variant_id ||
      modifier.variantId ||
      modifier.item_variant_id ||
      modifier.itemVariantId ||
      modifier.variation_id ||
      modifier.product_variant_id ||
      modifier.productVariantId ||
      modifier.product_id ||
      modifier.productId ||
      modifier.item_id ||
      modifier.itemId ||
      productVariant.id ||
      productVariant.variant_id ||
      productVariant.variantId ||
      variant.id ||
      variant.variant_id ||
      variant.variantId ||
      product.variant_id ||
      product.variantId ||
      product.id ||
      item.variant_id ||
      item.variantId ||
      item.id,
  );
}

function rawModifierName(
  modifier: Record<string, unknown>,
  fallback = "Yoco Modifier",
) {
  return text(
    modifier.name ||
      modifier.display_name ||
      modifier.displayName ||
      modifier.product_name ||
      modifier.productName,
    fallback,
  );
}

function rawModifierProductDisplayName(
  modifier: Record<string, unknown>,
  fallback = "Yoco Product Modifier",
) {
  const product = objectValue(modifier.product);
  const item = objectValue(modifier.item);
  const variant = objectValue(modifier.variant);
  const productVariant = objectValue(
    modifier.product_variant || modifier.productVariant,
  );
  const productName = text(
    modifier.product_name ||
      modifier.productName ||
      product.name ||
      product.display_name ||
      product.displayName ||
      item.name ||
      item.display_name ||
      item.displayName,
  );
  const variantName = text(
    modifier.variant_name ||
      modifier.variantName ||
      productVariant.name ||
      productVariant.display_name ||
      productVariant.displayName ||
      variant.name ||
      variant.display_name ||
      variant.displayName,
  );
  if (
    productName &&
    variantName &&
    productName.toLowerCase() !== variantName.toLowerCase()
  )
    return `${productName} - ${variantName}`;
  return productName || variantName || rawModifierName(modifier, fallback);
}

function rawModifierType(modifier: Record<string, unknown>) {
  return text(
    modifier.type ||
      modifier.kind ||
      modifier.modifier_type ||
      modifier.modifierType,
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function yocoModifierRecipeOwnerIds(
  groupId: string,
  modifier: Record<string, unknown>,
) {
  const modifierId = rawModifierId(modifier);
  const variantId = rawModifierVariantId(modifier);
  const ownerIds = [
    groupId && modifierId ? `${groupId}:${modifierId}` : "",
    modifierId,
    variantId ? `variant:${variantId}` : "",
    rawModifierName(modifier)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, ""),
  ].filter(Boolean);
  return [...new Set(ownerIds)];
}

function recipeLinesForRecipe(
  recipe: Record<string, unknown> | undefined,
  linesByRecipe: Map<string, Array<Record<string, unknown>>>,
) {
  if (!recipe) return [];
  return (linesByRecipe.get(text(recipe.id)) || []).map((line) => ({
    ingId: text(line.stock_item_id),
    stockItemId: text(line.stock_item_id),
    qty: numberValue(line.quantity, 0),
    quantity: numberValue(line.quantity, 0),
    unit: text(line.unit, "ea") || "ea",
  }));
}

function stripModifierRecipeRouteId(value: string) {
  const idValue = routeText(value);
  return idValue.startsWith("modifier:")
    ? idValue.slice("modifier:".length)
    : idValue;
}

function normalizeModifierLinkName(value: unknown) {
  return text(value)
    .toLowerCase()
    .replace(/\byoco\b/g, " ")
    .replace(/\bmodifier\b/g, " ")
    .replace(/\bproduct\b/g, " ")
    .replace(/\boption\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function linkedProductIdsFromValue(value: unknown) {
  const raw = text(value);
  if (!raw) return [];
  const parsed = jsonParse(raw);
  if (Array.isArray(parsed))
    return parsed.map((entry) => text(entry)).filter(Boolean);
  return raw
    .split(",")
    .map((entry) => text(entry))
    .filter(Boolean);
}

function encodeLinkedProductIds(ids: string[]) {
  const normalized = [
    ...new Set(ids.map((entry) => text(entry)).filter(Boolean)),
  ];
  if (!normalized.length) return "";
  if (normalized.length === 1) return normalized[0];
  return JSON.stringify(normalized);
}

function mergeRecipeLines(recipeLines: Array<Array<Record<string, unknown>>>) {
  const linesByStockItem = new Map<string, Record<string, unknown>>();
  recipeLines.flat().forEach((line) => {
    const stockItemId = text(
      line.stockItemId || line.ingId || line.stock_item_id,
    );
    if (!stockItemId) return;
    const current = linesByStockItem.get(stockItemId);
    if (current) {
      current.qty =
        numberValue(current.qty, 0) + numberValue(line.qty || line.quantity, 0);
      current.quantity =
        numberValue(current.quantity, 0) +
        numberValue(line.quantity || line.qty, 0);
      return;
    }
    linesByStockItem.set(stockItemId, { ...line });
  });
  return [...linesByStockItem.values()];
}

function productVariantAliases(row: Record<string, unknown>) {
  const raw = objectValue(jsonParse(row.raw_json));
  const item = objectValue(raw.item);
  const variant = objectValue(raw.variant);
  const itemId = text(
    row.yoco_item_id || item.id || item.item_id || item.itemId,
  );
  const variantId = text(
    row.yoco_variant_id ||
      variant.id ||
      variant.variant_id ||
      variant.variantId,
  );
  const aliases = [
    variantId,
    text(variant.variant_id || variant.variantId),
    itemId && variantId ? `${itemId}:${variantId}` : "",
    itemId && text(variant.variant_id || variant.variantId)
      ? `${itemId}:${text(variant.variant_id || variant.variantId)}`
      : "",
  ].filter(Boolean);
  return [...new Set(aliases)];
}

function findProductByModifierVariant(
  productsByVariant: Map<string, Record<string, unknown>>,
  variantId: string,
) {
  const direct = productsByVariant.get(text(variantId));
  if (direct) return direct;
  const parts = text(variantId)
    .split(":")
    .map((part) => text(part))
    .filter(Boolean);
  for (const part of parts) {
    const match = productsByVariant.get(part);
    if (match) return match;
  }
  return null;
}

export async function getYocoModifierRecipes(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const [groupRows, productRows, recipeRows, lineRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, yoco_modifier_group_id, name, raw_json, updated_at
         FROM yoco_modifier_groups
        WHERE workspace_id = ?1
        ORDER BY name COLLATE NOCASE`,
    )
      .bind(workspaceId)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id, name, category, price, yoco_item_id, yoco_variant_id, raw_json
         FROM products
        WHERE workspace_id = ?1
          AND active = 1
          AND id NOT LIKE 'modifier:%'
          AND category NOT LIKE 'Modifier -%'`,
    )
      .bind(workspaceId)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id, owner_type, owner_id, linked_product_id, active
         FROM recipes
        WHERE workspace_id = ?1
          AND (
            (owner_type = 'product' AND active = 1)
            OR owner_type = 'yoco_modifier'
          )`,
    )
      .bind(workspaceId)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT recipe_id, stock_item_id, quantity, unit, sort_order
         FROM recipe_lines
        WHERE workspace_id = ?1
        ORDER BY sort_order ASC`,
    )
      .bind(workspaceId)
      .all<Record<string, unknown>>(),
  ]);

  const productsByVariant = new Map<string, Record<string, unknown>>();
  const productsById = new Map<string, Record<string, unknown>>();
  const productsByName = new Map<string, Record<string, unknown>>();
  arrayValue(productRows.results).forEach((entry) => {
    const row = objectValue(entry);
    const productId = text(row.id);
    const normalizedName = normalizeModifierLinkName(row.name);
    if (productId) productsById.set(productId, row);
    productVariantAliases(row).forEach((variantId) => {
      if (variantId && !productsByVariant.has(variantId))
        productsByVariant.set(variantId, row);
    });
    if (normalizedName && !productsByName.has(normalizedName))
      productsByName.set(normalizedName, row);
  });

  const recipesByOwner = new Map<string, Record<string, unknown>>();
  arrayValue(recipeRows.results).forEach((entry) => {
    const row = objectValue(entry);
    recipesByOwner.set(`${text(row.owner_type)}:${text(row.owner_id)}`, row);
  });

  const linesByRecipe = new Map<string, Array<Record<string, unknown>>>();
  arrayValue(lineRows.results).forEach((entry) => {
    const row = objectValue(entry);
    const recipeId = text(row.recipe_id);
    if (!recipeId) return;
    const current = linesByRecipe.get(recipeId) || [];
    current.push(row);
    linesByRecipe.set(recipeId, current);
  });

  const items: Array<Record<string, unknown>> = [];
  arrayValue(groupRows.results).forEach((entry) => {
    const group = objectValue(entry);
    const raw = objectValue(jsonParse(group.raw_json));
    const groupId = text(raw.id || group.yoco_modifier_group_id || group.id);
    const groupName = text(raw.name || group.name, "Yoco Modifier Group");
    const modifiers = arrayValue(
      raw.modifiers ||
        raw.modifier_items ||
        raw.modifierItems ||
        raw.modifier_options ||
        raw.modifierOptions ||
        raw.options ||
        raw.items ||
        raw.values,
    ).map(objectValue);
    modifiers.forEach((modifier) => {
      const variantId = rawModifierVariantId(modifier);
      const type = rawModifierType(modifier);
      if (type && type !== "product") return;
      if (!type && !variantId) return;

      const ownerIds = yocoModifierRecipeOwnerIds(groupId, modifier);
      const ownerId = ownerIds[0] || "";
      if (!ownerId) return;
      const manualRecipe = ownerIds
        .map((candidateOwnerId) =>
          recipesByOwner.get(`yoco_modifier:${candidateOwnerId}`),
        )
        .find(Boolean);
      if (manualRecipe && Number(manualRecipe.active ?? 1) === 0) return;
      const modifierName = rawModifierName(modifier, ownerId);
      const manualLinkedProductIds = linkedProductIdsFromValue(
        manualRecipe?.linked_product_id,
      );
      const variantLinkedProduct = variantId
        ? findProductByModifierVariant(productsByVariant, variantId)
        : null;
      const nameLinkedProduct =
        productsByName.get(normalizeModifierLinkName(modifierName)) || null;
      const autoLinkedProduct = variantLinkedProduct || nameLinkedProduct;
      const autoLinkedProductSource = autoLinkedProduct
        ? variantLinkedProduct &&
          text(variantLinkedProduct.id) === text(autoLinkedProduct.id)
          ? "variant"
          : "name"
        : "";
      const linkedProducts = manualLinkedProductIds.length
        ? (manualLinkedProductIds
            .map((idValue) => productsById.get(idValue))
            .filter(Boolean) as Array<Record<string, unknown>>)
        : autoLinkedProduct
          ? [autoLinkedProduct]
          : [];
      const productLineSets = linkedProducts.map((product) =>
        recipeLinesForRecipe(
          recipesByOwner.get(`product:${text(product.id)}`),
          linesByRecipe,
        ),
      );
      const productLines = mergeRecipeLines(productLineSets);
      const manualLines = recipeLinesForRecipe(manualRecipe, linesByRecipe);
      const recipe = productLines.length ? productLines : manualLines;
      const linkedProductNames = linkedProducts
        .map((product) => text(product.name))
        .filter(Boolean);
      const yocoModifierProductName = rawModifierProductDisplayName(
        modifier,
        modifierName,
      );
      const hasYocoProductVariantLink = Boolean(
        variantId && yocoModifierProductName,
      );

      items.push({
        id: `modifier:${ownerId}`,
        recipeOwnerType: "yoco_modifier",
        recipeOwnerId: ownerId,
        source: "Yoco modifier",
        name: modifierName,
        category: `Modifier - ${groupName}`,
        sellingPrice: moneyToMajor(
          modifier.price || modifier.amount || modifier.default_price || 0,
        ),
        price: moneyToMajor(
          modifier.price || modifier.amount || modifier.default_price || 0,
        ),
        sku: text(modifier.sku || modifier.code),
        yocoModifierId: rawModifierId(modifier),
        yocoModifierVariantId: variantId,
        yocoModifierProductName,
        yocoModifierGroupId: groupId,
        yocoModifierGroupName: groupName,
        linkedProductId:
          linkedProducts.length === 1
            ? text(linkedProducts[0].id)
            : encodeLinkedProductIds(
                linkedProducts.map((product) => text(product.id)),
              ),
        linkedProductIds: linkedProducts
          .map((product) => text(product.id))
          .filter(Boolean),
        linkedProductName: linkedProductNames.join(", "),
        linkedProductNames,
        modifierLinkStatus:
          linkedProducts.length || hasYocoProductVariantLink
            ? "linked"
            : variantId
              ? "variant_unmatched"
              : "missing",
        modifierLinkSource: manualLinkedProductIds.length
          ? "manual"
          : autoLinkedProductSource ||
            (hasYocoProductVariantLink ? "yoco_variant" : ""),
        linkedProductRecipeCount: productLines.length,
        autoLinkedProductId:
          !manualLinkedProductIds.length && autoLinkedProduct
            ? text(autoLinkedProduct.id)
            : "",
        autoLinkedProductName:
          !manualLinkedProductIds.length && autoLinkedProduct
            ? text(autoLinkedProduct.name)
            : "",
        manualRecipeCount: manualLines.length,
        recipeSource: productLines.length
          ? "linked_product"
          : manualLines.length
            ? "manual_modifier"
            : "missing",
        recipe,
        recipeCount: recipe.length,
        status: recipe.length ? "complete" : "missing",
        missingRecipe: recipe.length === 0,
        active: true,
        archived: false,
        deleted: false,
        catalogueStatus: "active",
        updatedAt: text(group.updated_at),
      });
    });
  });

  items.sort(
    (left, right) =>
      text(left.category).localeCompare(text(right.category)) ||
      text(left.name).localeCompare(text(right.name)),
  );

  return json(request, env, {
    ok: true,
    items,
    modifiers: items,
    count: items.length,
  });
}

export async function patchYocoModifierRecipe(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  ownerId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const cleanOwnerId = stripModifierRecipeRouteId(ownerId);
  if (!cleanOwnerId)
    return error(request, env, 400, "Modifier recipe id is required.");
  const payload = objectValue(await readJson<Record<string, unknown>>(request));
  await saveYocoModifierRecipe(
    env,
    workspaceId,
    cleanOwnerId,
    arrayValue(payload.recipe),
    Object.prototype.hasOwnProperty.call(payload, "linkedProductIds")
      ? encodeLinkedProductIds(
          arrayValue(payload.linkedProductIds).map((entry) => text(entry)),
        )
      : Object.prototype.hasOwnProperty.call(payload, "linkedProductId")
        ? text(payload.linkedProductId)
        : undefined,
  );
  return json(request, env, {
    ok: true,
    id: `modifier:${cleanOwnerId}`,
    recipeOwnerId: cleanOwnerId,
  });
}

export async function deleteYocoModifierRecipeRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  ownerId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const cleanOwnerId = stripModifierRecipeRouteId(ownerId);
  if (!cleanOwnerId)
    return error(request, env, 400, "Modifier recipe id is required.");
  await deleteYocoModifierRecipe(env, workspaceId, cleanOwnerId);
  return json(request, env, {
    ok: true,
    id: `modifier:${cleanOwnerId}`,
    recipeOwnerId: cleanOwnerId,
    deletedCount: 1,
  });
}

export async function getYocoModifierGroups(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const url = new URL(request.url);
  if (url.searchParams.get("live") === "1") {
    const apiKey = await getYocoApiKey(env, workspaceId);
    const groups = await fetchAssignedYocoModifierGroups(env, apiKey);
    return json(request, env, {
      ok: true,
      source: "yoco",
      count: groups.length,
      data: groups,
    });
  }
  const groups = await listYocoModifierGroups(env, workspaceId);
  return json(request, env, {
    ok: true,
    source: "cache",
    count: groups.length,
    data: groups,
  });
}

export async function getYocoModifierGroupRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
  modifierGroupId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const url = new URL(request.url);
  if (url.searchParams.get("live") === "1") {
    const apiKey = await getYocoApiKey(env, workspaceId);
    const group = productLinkedYocoModifierGroup(
      objectValue(
        await fetchModifierGroup(env, apiKey, routeText(modifierGroupId)),
      ),
    );
    if (!group)
      return error(
        request,
        env,
        404,
        "Yoco modifier group with product-linked modifiers not found.",
      );
    return json(request, env, { ok: true, source: "yoco", data: group });
  }
  const group = await getYocoModifierGroup(
    env,
    workspaceId,
    routeText(modifierGroupId),
  );
  if (!group) return error(request, env, 404, "Yoco modifier group not found.");
  return json(request, env, { ok: true, source: "cache", data: group });
}

export async function postYocoDisconnect(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const actorRole = await getWorkspaceActorRole(env, auth, workspaceId);
  if (normalizeRoleKey(actorRole) !== 'superuser') {
    return error(request, env, 403, 'Only a KCP super user can disconnect the workspace Yoco integration.');
  }
  const result = await disconnectYoco(env, workspaceId);
  return json(request, env, { ok: true, ...result });
}

export async function postYocoSyncCatalogue(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request).catch(
    () => ({}) as Record<string, unknown>,
  );
  const result = await syncYocoCatalogue(env, workspaceId, {
    resetWebhook: payload.resetWebhook === true,
  });
  return json(request, env, { ok: true, ...result });
}

export async function postYocoSyncSales(
  request: Request,
  env: Env,
  auth: AuthContext,
  workspaceId: string,
) {
  await scoped(request, env, auth, workspaceId);
  const payload = await readJson<Record<string, unknown>>(request).catch(
    () => ({}) as Record<string, unknown>,
  );
  const result = await syncYocoSales(env, workspaceId, {
    resetWebhook: payload.resetWebhook === true,
  });
  return json(request, env, { ok: true, ...result });
}

async function loadYocoOrderForWebhook(
  env: Env,
  workspaceId: string,
  payloadOrder: Record<string, unknown> | null,
  orderId: string,
  paymentId: string,
) {
  if (payloadOrder && (!orderId || getObjectLineItems(payloadOrder).length))
    return payloadOrder;
  const apiKey = await getYocoApiKey(env, workspaceId);
  if (orderId) {
    const byOrderId = (await fetchOrder(env, apiKey, orderId).catch(
      () => payloadOrder,
    )) as Record<string, unknown> | null;
    if (byOrderId) return byOrderId;
  }
  if (!paymentId) return payloadOrder;

  // Resolve the payment directly first. Yoco payments expose order_id, which avoids
  // relying on an undocumented payment_id filter on the Orders API.
  const payment = (await fetchPayment(env, apiKey, paymentId).catch(() => null)) as Record<string, unknown> | null;
  const paymentOrderId = text(payment?.order_id || payment?.orderId);
  if (paymentOrderId) {
    const paymentOrder = (await fetchOrder(env, apiKey, paymentOrderId).catch(() => null)) as Record<string, unknown> | null;
    if (paymentOrder) return paymentOrder;
  }

  // Keep the legacy list fallback for older Yoco accounts.
  const candidateOrders = (await listOrders(env, apiKey, {
    payment_id: paymentId,
    limit: 25,
  }).catch(() => [])) as Record<string, unknown>[];
  let matched = candidateOrders.find((order) =>
    orderHasPayment(order, paymentId),
  );

  // A number of Yoco accounts return an empty list when payment_id is used as a
  // server-side filter. Inspect a bounded set of normal order pages before giving
  // up so a valid payment.created webhook can still resolve its order immediately.
  if (!matched) {
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const page: { rows: unknown[]; nextCursor: unknown } | null = await listOrdersPage(env, apiKey, {
        cursor,
        limit: 100,
      }).catch(() => null);
      if (!page) break;
      const rows = (page.rows || []) as Record<string, unknown>[];
      matched = rows.find((order) => orderHasPayment(order, paymentId));
      if (matched) break;
      cursor = text(page.nextCursor) || null;
      if (!cursor || !rows.length) break;
    }
  }

  if (matched) {
    const matchedOrderId = text(
      matched.id || matched.order_id || matched.orderId,
    );
    return matchedOrderId
      ? ((await fetchOrder(env, apiKey, matchedOrderId).catch(
          () => matched,
        )) as Record<string, unknown>)
      : matched;
  }
  return payloadOrder;
}

function getObjectLineItems(order: Record<string, unknown>) {
  for (const key of [
    "line_items",
    "lineItems",
    "items",
    "order_lines",
    "orderLines",
  ]) {
    const value = order[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function orderHasPayment(order: Record<string, unknown>, paymentId: string) {
  const wanted = text(paymentId);
  if (!wanted) return false;
  if (
    [order.payment_id, order.paymentId].some((value) => text(value) === wanted)
  )
    return true;
  const payments = Array.isArray(order.payments)
    ? (order.payments as Record<string, unknown>[])
    : [];
  return payments.some((payment) =>
    [payment.id, payment.payment_id, payment.paymentId].some(
      (value) => text(value) === wanted,
    ),
  );
}

export async function postYocoWebhook(
  request: Request,
  env: Env,
  workspaceId: string,
) {
  const startedMs = Date.now();
  const receivedAt = nowIso();
  const body = await request.text();
  const headerEventId =
    request.headers.get("webhook-id") ||
    request.headers.get("svix-id") ||
    request.headers.get("x-yoco-event-id") ||
    "";
  let eventId = headerEventId || id("yoco_evt");
  let webhookDbId = id("yoco_evt");
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  let payload: Record<string, unknown> = {};
  try {
    payload = body.trim() ? (JSON.parse(body) as Record<string, unknown>) : {};
    eventId = headerEventId || text(
      payload.id || payload.event_id || payload.eventId,
      eventId,
    );
  } catch {
    await recordYocoWebhookRejection(env, {
      workspaceId,
      eventId,
      eventType: request.headers.get("x-yoco-event-type") || "unknown",
      orderId: "",
      payloadHash: hash,
      message: "Yoco webhook payload was not valid JSON.",
    });
    await recordIntegrationLog(env, workspaceId, {
      operation: "yoco.webhook.receive",
      status: "failed",
      message: "Yoco webhook payload was not valid JSON.",
      details: { eventId, signaturePresent: Boolean(request.headers.get("webhook-signature") || request.headers.get("svix-signature")) },
      startedAt: receivedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });
    return error(request, env, 400, "Yoco webhook payload was not valid JSON.");
  }
  const { eventType, orderId, paymentId } = yocoWebhookEventFields(payload);
  const eventDisposition = yocoWebhookEventDisposition(eventType);
  const connection = await getYocoConnection(env, workspaceId);
  if (!connection?.webhook_secret) {
    await recordYocoWebhookRejection(env, {
      workspaceId,
      eventId,
      eventType:
        eventType || request.headers.get("x-yoco-event-type") || "unknown",
      orderId,
      payloadHash: hash,
      message: "Yoco webhook secret is not configured for this workspace.",
    });
    await recordIntegrationLog(env, workspaceId, {
      operation: "yoco.webhook.signature",
      status: "failed",
      message: "Yoco webhook secret is not configured for this workspace.",
      details: { eventId, eventType, orderId },
      startedAt: receivedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });
    return error(
      request,
      env,
      401,
      "Yoco webhook secret is not configured for this workspace.",
    );
  }
  const webhookSecrets = activeYocoWebhookSecrets(connection);
  const verified = await verifyYocoWebhook(
    body,
    request.headers,
    webhookSecrets,
  );
  if (!verified) {
    await markYocoWebhookSignatureMismatch(env, workspaceId);
    await recordYocoWebhookRejection(env, {
      workspaceId,
      eventId,
      eventType:
        eventType || request.headers.get("x-yoco-event-type") || "unknown",
      orderId,
      payloadHash: hash,
      message: "Yoco webhook signature could not be verified.",
    });
    await recordIntegrationLog(env, workspaceId, {
      operation: "yoco.webhook.signature",
      status: "failed",
      message: "Yoco webhook signature could not be verified.",
      details: {
        eventId,
        eventType,
        orderId,
        webhookTimestamp: request.headers.get("webhook-timestamp") || request.headers.get("svix-timestamp") || "",
      },
      startedAt: receivedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });
    // Never process an unauthenticated webhook, even when it contains a valid-looking
    // order id. Missed events are recovered through the authenticated Yoco sales sync.
    return error(
      request,
      env,
      401,
      "Yoco webhook signature could not be verified.",
    );
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO yoco_webhook_events
      (id, workspace_id, provider_event_id, event_type, yoco_order_id, payload_hash, status, raw_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'received', ?7, ?8)`,
  )
    .bind(
      webhookDbId,
      workspaceId,
      eventId,
      eventType || request.headers.get("x-yoco-event-type") || "unknown",
      orderId || null,
      hash,
      body || "{}",
      nowIso(),
    )
    .run();

  const existing = await env.DB.prepare(
    `SELECT id, status
       FROM yoco_webhook_events
      WHERE workspace_id = ?1
        AND (
          payload_hash = ?2
          OR (?3 <> '' AND provider_event_id = ?3)
        )
      ORDER BY CASE WHEN payload_hash = ?2 THEN 0 ELSE 1 END
      LIMIT 1`,
  )
    .bind(workspaceId, hash, eventId)
    .first<{ id: string; status: string }>();

  if (existing?.id) webhookDbId = existing.id;
  if (["processed", "ignored"].includes(text(existing?.status).toLowerCase())) {
    return json(request, env, { ok: true, status: "duplicate" });
  }

  // Atomically claim this delivery before doing any external reads or stock work.
  // A concurrent retry of the same Yoco event receives 200 but cannot enter the
  // processing path while the first delivery owns the row. A five-minute lease
  // lets a later retry recover an event if the Worker was terminated mid-flight.
  const processingStartedAt = nowIso();
  const claim = await env.DB.prepare(
    `UPDATE yoco_webhook_events
        SET status = 'processing',
            processed_at = ?2,
            error_message = NULL
      WHERE id = ?1
        AND (
          status IN ('received', 'failed', 'rejected', 'attention')
          OR (
            status = 'processing'
            AND datetime(COALESCE(processed_at, created_at)) <= datetime(?2, '-5 minutes')
          )
        )`,
  ).bind(webhookDbId, processingStartedAt).run();
  if (Number(claim.meta?.changes || claim.meta?.rows_written || 0) === 0) {
    return json(request, env, { ok: true, status: "processing" });
  }

  if (eventDisposition === "ignored") {
    const message = `Webhook event ${eventType || "unknown"} is not a stock-changing Yoco event and was safely ignored.`;
    await env.DB.prepare(
      `UPDATE yoco_webhook_events
          SET status = 'ignored',
              processed_at = ?2,
              error_message = ?3
        WHERE id = ?1`,
    ).bind(webhookDbId, nowIso(), message).run();
    await recordIntegrationLog(env, workspaceId, {
      operation: "yoco.webhook.ignore",
      status: "success",
      message,
      details: { eventId, eventType, eventDisposition, signatureVerified: true },
      startedAt: receivedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });
    return json(request, env, { ok: true, status: "ignored", message });
  }

  if (eventDisposition === "waiting") {
    const message = `Webhook event ${eventType} was received. Waiting for the final order.completed event before deducting stock.`;
    await env.DB.prepare(
      `UPDATE yoco_webhook_events
          SET status = 'attention',
              processed_at = ?2,
              error_message = ?3
        WHERE id = ?1`,
    ).bind(webhookDbId, nowIso(), message).run();
    await recordIntegrationLog(env, workspaceId, {
      operation: "yoco.webhook.waiting_for_order_completion",
      status: "warning",
      message,
      details: { eventId, eventType, orderId, paymentId, signatureVerified: true },
      startedAt: receivedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });
    return json(request, env, { ok: true, status: "attention", message });
  }

  if (
    ["payment.succeeded", "payment.successful"].includes(text(eventType).toLowerCase())
    && !yocoWebhookPaymentSucceeded(payload)
  ) {
    const message = `Webhook event ${eventType} did not contain a successful or succeeded payment status and was ignored.`;
    await env.DB.prepare(
      `UPDATE yoco_webhook_events
          SET status = 'ignored',
              processed_at = ?2,
              error_message = ?3
        WHERE id = ?1`,
    ).bind(webhookDbId, nowIso(), message).run();
    await recordIntegrationLog(env, workspaceId, {
      operation: "yoco.webhook.payment_status",
      status: "warning",
      message,
      details: { eventId, eventType, orderId, paymentId, signatureVerified: true },
      startedAt: receivedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });
    return json(request, env, { ok: true, status: "ignored", message });
  }

  let order = extractYocoOrder(payload);
  if (!order && !orderId && !paymentId) {
    await env.DB.prepare(
      `UPDATE yoco_webhook_events
          SET status = 'failed',
              error_message = 'Webhook payload did not include an order id or payment id.'
        WHERE id = ?1`,
    )
      .bind(webhookDbId)
      .run();
    return error(
      request,
      env,
      400,
      "Webhook payload did not include an order id or payment id.",
    );
  }
  order = (await loadYocoOrderForWebhook(
    env,
    workspaceId,
    order,
    orderId,
    paymentId,
  )) as Record<string, unknown> | null;
  if (!order) {
    await env.DB.prepare(
      `UPDATE yoco_webhook_events
          SET status = 'failed',
              error_message = 'Yoco order could not be loaded.'
        WHERE id = ?1`,
    ).bind(webhookDbId).run();
    await recordIntegrationLog(env, workspaceId, {
      operation: "yoco.webhook.order_load",
      status: "failed",
      message: "Yoco order could not be loaded.",
      details: { eventId, eventType, orderId, paymentId },
      startedAt: receivedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });
    return error(request, env, 400, "Yoco order could not be loaded.");
  }

  const resolvedOrderId = text(order.id || order.order_id || order.orderId || orderId);
  if (resolvedOrderId && resolvedOrderId !== orderId) {
    await env.DB.prepare(
      `UPDATE yoco_webhook_events
          SET yoco_order_id = ?2
        WHERE id = ?1`,
    ).bind(webhookDbId, resolvedOrderId).run();
  }

  try {
    const isRefund = eventDisposition === "refund";
    const isReturn = eventDisposition === "return";
    const refundObj = isRefund ? findRefund(order, paymentId) : null;
    const refundBehavior = refundObj
      ? resolveRefundReturnBehavior(refundObj)
      : "return";

    // Process the main event (sale or financial refund)
    // Skip entirely if reason maps to 'skip' (e.g. other+scrap note)
    let result =
      refundBehavior === "skip"
        ? {
            processed: false,
            reason: "skipped_refund_reason",
            missingRecipes: 0,
            orderLines: 0,
            stockMovements: 0,
          }
        : await processYocoOrder(env, workspaceId, order, {
            mode: isRefund ? "refund" : "sale",
            refund: refundObj,
            eventType,
            returnBehavior: isRefund ? refundBehavior : undefined,
          });

    // Process any order.returns entries (stock restorations from physical item returns).
    // Uses the same dedup-signature system so re-delivery of the same webhook is safe.
    const orderHasReturns = getOrderReturns(order).length > 0;
    const returnsResult =
      isReturn || (!isRefund && orderHasReturns)
        ? await processYocoOrderReturns(env, workspaceId, order, {
            eventType,
            overrideBehavior:
              isRefund && refundBehavior !== "return"
                ? refundBehavior
                : undefined,
          })
        : { returnsProcessed: 0, totalMovements: 0, results: [] };

    // If this was a pure return event and the main pass found nothing to process,
    // surface the first return result so the caller gets meaningful feedback.
    if (
      isReturn &&
      !isRefund &&
      !result.orderLines &&
      returnsResult.results.length
    ) {
      result = returnsResult.results[0];
    }

    const returnNeedsRetry = returnsResult.results.some((entry) => entry.retryable === true);
    const totalMovements = Number(result.stockMovements || 0) + Number(returnsResult.totalMovements || 0);
    const resultReason = text(result.reason);
    const duplicateSuccess = resultReason === 'duplicate' || Number(result.skippedDuplicates || 0) > 0;
    const intentionallyIgnored = [
      'before_stock_depletion_start',
      'skipped_refund_reason',
      'skipped_other_reason'
    ].includes(resultReason);
    const needsAttention = result.retryable === true || returnNeedsRetry || (
      totalMovements === 0 && !duplicateSuccess && !intentionallyIgnored
    );
    const webhookStatus = intentionallyIgnored ? 'ignored' : needsAttention ? 'attention' : 'processed';
    const outcomeMessage = intentionallyIgnored
      ? `Webhook intentionally ignored: ${resultReason}. No stock was changed.`
      : needsAttention
        ? resultReason === 'stock_depletion_disabled'
          ? 'Webhook received, but stock depletion is not live. Use Business Settings > Go Live before new sales can deduct stock.'
          : resultReason === 'order_not_paid_or_completed'
            ? 'Webhook received, but the Yoco order is not yet available in a paid/completed state. It will remain retryable.'
            : `Webhook received, but stock deduction needs attention: ${resultReason || 'missing recipe or product mapping'}.`
        : duplicateSuccess && totalMovements === 0
          ? 'Webhook matched stock movements that were already processed. No duplicate deduction was created.'
          : `Stock deduction completed with ${totalMovements} stock movement(s).`;
    await env.DB.prepare(
      `UPDATE yoco_webhook_events
          SET status = ?2,
              yoco_order_id = COALESCE(NULLIF(?5, ''), yoco_order_id),
              processed_at = ?3,
              error_message = ?4
        WHERE id = ?1`,
    )
      .bind(webhookDbId, webhookStatus, nowIso(), outcomeMessage, resolvedOrderId)
      .run();

    await recordIntegrationLog(env, workspaceId, {
      operation: "yoco.webhook.process",
      status: needsAttention ? "warning" : "success",
      message: outcomeMessage,
      details: {
        eventId,
        eventType,
        orderId: resolvedOrderId || orderId,
        paymentId,
        signatureVerified: true,
        result,
        returnsProcessed: returnsResult.returnsProcessed,
        returnMovements: returnsResult.totalMovements,
        totalMovements,
        webhookStatus,
      },
      startedAt: receivedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });

    return json(request, env, {
      ok: true,
      status: webhookStatus,
      result,
      ...(returnsResult.returnsProcessed > 0
        ? {
            returnsProcessed: returnsResult.returnsProcessed,
            returnMovements: returnsResult.totalMovements,
          }
        : {}),
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await env.DB.prepare(
      `UPDATE yoco_webhook_events
          SET status = 'failed',
              error_message = ?2
        WHERE id = ?1`,
    )
      .bind(webhookDbId, message)
      .run();
    await recordIntegrationLog(env, workspaceId, {
      operation: "yoco.webhook.process",
      status: "failed",
      message,
      details: { eventId, eventType, orderId, paymentId, signatureVerified: true },
      startedAt: receivedAt,
      completedAt: nowIso(),
      durationMs: Date.now() - startedMs,
    });
    throw caught;
  }
}

export function notFound(request: Request, env: Env) {
  return error(request, env, 404, "Route not found.");
}
