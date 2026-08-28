import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { TENANT_SCHEMA_SQL } from "../src/tenant-schema.generated";
import type { DbLike, DbResult, DbStatementLike } from "../src/legacy/types";
import { encryptTextWithSecret } from "../src/legacy/crypto";
import type {
  CanonicalSaleRefundedEvent,
  YocoV2RateGateResponse,
} from "../src/modules/yoco-engine-v2/contracts";
import {
  YOCO_V2_CONTROLLED_CUTOVER_MIGRATION,
  YOCO_V2_EFFECT_GATE_MIGRATION,
  YOCO_V2_FOUNDATION_MIGRATION,
  YOCO_V2_REFUND_RECONCILIATION_MIGRATION,
  YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION,
  YOCO_V2_SALE_SHADOW_MIGRATION,
  YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION,
} from "../src/modules/yoco-engine-v2/migrations";
import {
  refundLookupUpdatedWindow,
  resolveCanonicalYocoRefund,
  saveManualRefundAllocation,
} from "../src/modules/yoco-engine-v2/refund-resolver";
import {
  buildRefundReportingProposal,
  buildRefundStockProposals,
} from "../src/modules/yoco-engine-v2/refund-effect-proposals";
import {
  runYocoV2Reconciliation,
  runScheduledYocoV2Reconciliation,
} from "../src/modules/yoco-engine-v2/reconciliation";
import { processYocoV2QueueMessage } from "../src/modules/yoco-engine-v2/processor";
import { yocoV2FeatureFlags } from "../src/modules/yoco-engine-v2/config";
import { MODIFIER_ENGINE_REFUNDS_RELIABILITY_NOTES_MIGRATION } from "../src/modules/modifier-engine/migrations";

class SqliteStatement implements DbStatementLike {
  private values: unknown[] = [];
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}
  bind(...values: unknown[]): DbStatementLike {
    const statement = new SqliteStatement(this.database, this.sql);
    statement.values = values.map((value) =>
      value === undefined ? null : value,
    );
    return statement;
  }
  private materialize() {
    const numberedValues: unknown[] = [];
    const numberedSql = this.sql.replace(/\?(\d+)/g, (_match, index) => {
      numberedValues.push(this.values[Number(index) - 1] ?? null);
      return "?";
    });
    return numberedValues.length
      ? { sql: numberedSql, values: numberedValues }
      : { sql: this.sql, values: this.values };
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const materialized = this.materialize();
    const row = this.database
      .prepare(materialized.sql)
      .get(...materialized.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const materialized = this.materialize();
    const rows = this.database
      .prepare(materialized.sql)
      .all(...materialized.values) as T[];
    return {
      results: rows,
      success: true,
      meta: { changes: 0, rows_read: rows.length },
    };
  }
  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    const materialized = this.materialize();
    const result = this.database
      .prepare(materialized.sql)
      .run(...materialized.values);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(result.changes),
        rows_written: Number(result.changes),
      },
    };
  }
  async raw<T = unknown[]>(): Promise<T[]> {
    const materialized = this.materialize();
    const rows = this.database
      .prepare(materialized.sql)
      .all(...materialized.values) as Record<string, unknown>[];
    return rows.map((row) => Object.values(row) as T);
  }
}

class SqliteDb implements DbLike {
  constructor(readonly database = new DatabaseSync(":memory:")) {}
  prepare(query: string): DbStatementLike {
    return new SqliteStatement(this.database, query);
  }
  async batch<T = Record<string, unknown>>(
    statements: DbStatementLike[],
  ): Promise<Array<DbResult<T>>> {
    const results: Array<DbResult<T>> = [];
    for (const statement of statements) results.push(await statement.run<T>());
    return results;
  }
}

type Fixture = {
  event: Record<string, unknown>;
  refund: Record<string, unknown>;
  original_order: Record<string, unknown>;
  previous_refund?: {
    refund_id: string;
    source_order_id: string;
    line_id: string;
    quantity: number;
  };
  refund_order_status?: number;
};

function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(
      join(import.meta.dirname, "fixtures/yoco-v2", `${name}.json`),
      "utf8",
    ),
  );
}

function createDb() {
  const db = new SqliteDb();
  db.database.exec(TENANT_SCHEMA_SQL);
  db.database.exec(`
    CREATE TABLE IF NOT EXISTS integration_logs (
      id TEXT PRIMARY KEY, workspace_id TEXT, provider TEXT, operation TEXT, status TEXT,
      severity TEXT, message TEXT, details_json TEXT, correlation_id TEXT, started_at TEXT,
      completed_at TEXT, duration_ms INTEGER, created_at TEXT
    );
  `);
  db.database.exec(`
    ALTER TABLE yoco_orders ADD COLUMN parent_yoco_order_id TEXT;
    ALTER TABLE yoco_orders ADD COLUMN provider_refund_id TEXT;
    ALTER TABLE yoco_orders ADD COLUMN refund_reason TEXT;
    ALTER TABLE yoco_orders ADD COLUMN refund_behavior TEXT;
    ALTER TABLE yoco_orders ADD COLUMN gross_total REAL;
    ALTER TABLE yoco_orders ADD COLUMN vat_total REAL;
    ALTER TABLE yoco_orders ADD COLUMN net_total REAL;
    ALTER TABLE yoco_orders ADD COLUMN vat_rate REAL;
    ALTER TABLE yoco_orders ADD COLUMN vat_registered INTEGER;
  `);
  db.database.exec(YOCO_V2_FOUNDATION_MIGRATION);
  db.database.exec(YOCO_V2_SALE_SHADOW_MIGRATION);
  db.database.exec(YOCO_V2_REFUND_RECONCILIATION_MIGRATION);
  // The sale-side cutover table must exist before the effect-gate unification below, which reads
  // from BOTH yoco_v2_effect_controls and yoco_v2_refund_effect_controls. Production applies them
  // in this order (TENANT_MIGRATIONS 25, 26, then 35), so the harness must too.
  db.database.exec(YOCO_V2_CONTROLLED_CUTOVER_MIGRATION);
  db.database.exec(YOCO_V2_REFUND_CONTROLLED_CUTOVER_MIGRATION);
  db.database.exec(MODIFIER_ENGINE_REFUNDS_RELIABILITY_NOTES_MIGRATION);
  db.database.exec(YOCO_V2_RECONCILIATION_BACKOFF_MIGRATION);
  // See the note in yoco-v2-ownership-connect-migration.test.ts: the live effect gate lives in
  // yoco_v2_effect_gate (TENANT_MIGRATIONS 35 + the runtime schema repair), so a harness that omits
  // it does not represent any real tenant.
  db.database.exec(YOCO_V2_EFFECT_GATE_MIGRATION);
  return db;
}

function seedCore(db: SqliteDb) {
  db.database.exec(`
    INSERT INTO workspace_settings (workspace_id, vat_rate) VALUES ('ws_1', 15);
    INSERT INTO locations (id, workspace_id, name, active, external_provider, external_location_id)
      VALUES ('loc_1', 'ws_1', 'Main', 1, 'yoco', 'yoco_loc_1');
    INSERT INTO stock_items (id, workspace_id, name, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('ingredient_1', 'ws_1', 'Beef', 'raw', 'kg', 100, 1, 1);
    INSERT INTO stock_items (id, workspace_id, name, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('ingredient_2', 'ws_1', 'Cheese', 'raw', 'kg', 80, 1, 1);
    INSERT INTO products (id, workspace_id, name, active, external_provider, yoco_item_id, yoco_variant_id)
      VALUES ('product_1', 'ws_1', 'Burger', 1, 'yoco', 'yoco_prod_1', 'yoco_var_1');
    INSERT INTO products (id, workspace_id, name, active, external_provider, yoco_item_id, yoco_variant_id)
      VALUES ('product_2', 'ws_1', 'Chips', 1, 'yoco', 'yoco_prod_2', 'yoco_var_2');
    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active)
      VALUES ('recipe_product_1', 'ws_1', 'product', 'product_1', 1, 1);
    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order)
      VALUES ('recipe_line_product_1', 'ws_1', 'recipe_product_1', 'ingredient_1', 0.5, 'kg', 1);
    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active)
      VALUES ('recipe_product_2', 'ws_1', 'product', 'product_2', 1, 1);
    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order)
      VALUES ('recipe_line_product_2', 'ws_1', 'recipe_product_2', 'ingredient_2', 0.2, 'kg', 1);
    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active)
      VALUES ('recipe_modifier_cheese', 'ws_1', 'yoco_modifier', 'mod_cheese', 1, 1);
    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order)
      VALUES ('recipe_line_modifier_cheese', 'ws_1', 'recipe_modifier_cheese', 'ingredient_2', 0.1, 'kg', 1);
    INSERT INTO integration_effect_ownership
      (workspace_id, integration_type, effect_type, engine_version, enabled, enabled_at, enabled_by, updated_at)
      VALUES
      ('ws_1', 'YOCO', 'SALE_REPORTING', 'V2', 1, '2026-07-15T00:00:00.000Z', 'test', '2026-07-15T00:00:00.000Z'),
      ('ws_1', 'YOCO', 'SALE_STOCK', 'V2', 1, '2026-07-15T00:00:00.000Z', 'test', '2026-07-15T00:00:00.000Z'),
      ('ws_1', 'YOCO', 'REFUND_REPORTING', 'V2', 1, '2026-07-15T00:00:00.000Z', 'test', '2026-07-15T00:00:00.000Z'),
      ('ws_1', 'YOCO', 'REFUND_STOCK', 'V2', 1, '2026-07-15T00:00:00.000Z', 'test', '2026-07-15T00:00:00.000Z');
  `);
}

function gateResponse(
  body: unknown,
  status = 200,
  classification: YocoV2RateGateResponse["classification"] = status === 404
    ? "NOT_FOUND"
    : "SUCCESS",
): YocoV2RateGateResponse {
  return {
    ok: status >= 200 && status < 300,
    classification,
    responseStatus: status,
    bodyText: body == null ? "" : JSON.stringify(body),
    responseHeaders: { "content-type": "application/json" },
    retryAfterSeconds: classification === "RATE_LIMITED" ? 30 : 0,
    cacheStatus: "MISS",
    durationMs: 1,
    circuit: {
      pausedUntil:
        classification === "RATE_LIMITED" ? "2026-07-15T09:00:30.000Z" : null,
      pauseReason: classification === "RATE_LIMITED" ? "RATE_LIMITED" : null,
      interventionRequired: false,
      consecutiveAuthFailures: 0,
      consecutiveRateLimits: classification === "RATE_LIMITED" ? 1 : 0,
      updatedAt: "2026-07-15T09:00:00.000Z",
    },
  };
}

function gateNamespace(
  handler: (
    input: any,
  ) => YocoV2RateGateResponse | Promise<YocoV2RateGateResponse>,
) {
  return {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(
          requestInput: RequestInfo | URL,
          requestInit?: RequestInit,
        ) {
          const request =
            requestInput instanceof Request
              ? requestInput
              : new Request(requestInput, requestInit);
          const input = await request.json<any>();
          return new Response(JSON.stringify(await handler(input)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
  } as any;
}

async function configureApiKey(db: SqliteDb) {
  const encrypted = await encryptTextWithSecret("secret", "sk_live_never_log");
  db.database
    .prepare(
      `INSERT INTO yoco_connections (workspace_id, status, api_key_encrypted, connection_active) VALUES (?, 'connected', ?, 1)`,
    )
    .run("ws_1", encrypted);
}

function envFor(
  db: SqliteDb,
  handler: (
    input: any,
  ) => YocoV2RateGateResponse | Promise<YocoV2RateGateResponse>,
) {
  return {
    DB: db,
    CENTRAL_DB: db,
    YOCO_KEY_ENCRYPTION_SECRET: "secret",
    YOCO_API_BASE_URL: "https://api.yoco.com",
    YOCO_V2_RATE_GATE: gateNamespace(handler),
    YOCO_V2_ADMIN_ENABLED: "true",
    YOCO_V2_QUEUE_ENABLED: "true",
    YOCO_V2_LIVE_SALE_REPORTING: "true",
    YOCO_V2_LIVE_SALE_STOCK: "true",
    YOCO_V2_LIVE_REFUND_REPORTING: "true",
    YOCO_V2_LIVE_REFUND_STOCK: "true",
    YOCO_V2_API_TIMEOUT_MS: "1000",
    YOCO_V2_REQUEST_SPACING_MS: "0",
    YOCO_V2_ORDER_CACHE_TTL_MS: "0",
    YOCO_V2_REFUND_CACHE_TTL_MS: "0",
    YOCO_V2_RECONCILIATION_OVERLAP_MINUTES: "120",
    YOCO_V2_RECONCILIATION_LOOKBACK_HOURS: "24",
  } as any;
}

function fixtureGate(
  data: Fixture,
  options: {
    listOrders?: Record<string, unknown>[];
    listRefunds?: Record<string, unknown>[];
    failLists?: YocoV2RateGateResponse;
  } = {},
) {
  return (input: any) => {
    const url = new URL(String(input.url));
    if (url.pathname === "/v1/orders/") {
      if (options.failLists) return options.failLists;
      return gateResponse({ data: options.listOrders || [] });
    }
    if (url.pathname === "/v1/refunds/") {
      if (options.failLists) return options.failLists;
      return gateResponse({ data: options.listRefunds || [] });
    }
    if (url.pathname.startsWith("/v1/refunds/"))
      return gateResponse({ data: data.refund });
    if (url.pathname.startsWith("/v1/payments/"))
      return gateResponse({
        data: { id: "pay_ref_1", order_id: (data.original_order as any).id },
      });
    if (url.pathname.startsWith("/v1/orders/")) {
      const id = decodeURIComponent(
        url.pathname.split("/").filter(Boolean).pop() || "",
      );
      if (
        data.refund_order_status === 404 &&
        id === (data.refund as any).refund_order_id
      )
        return gateResponse(null, 404, "NOT_FOUND");
      if (id === (data.original_order as any).id)
        return gateResponse({ data: data.original_order });
      return gateResponse(null, 404, "NOT_FOUND");
    }
    return gateResponse(null, 404, "NOT_FOUND");
  };
}

function rawEvent(
  data: Fixture,
  id = "raw_refund",
  eventOverride?: Record<string, unknown>,
) {
  const event = eventOverride || data.event;
  return {
    id,
    workspace_id: "ws_1",
    integration_id: "integration_1",
    trace_id: `trace_${id}`,
    event_type: String(event.type || "refund.succeeded"),
    payload_json: JSON.stringify(event),
    received_at: "2026-07-15T08:00:01.000Z",
    yoco_event_id: String(event.id || id),
    event_key: `event:${event.id || id}`,
  };
}

function processingRun(id = "run_refund", attempt = 4) {
  return { id, attempt_number: attempt };
}

async function setupFixture(name: string, attempt = 4) {
  const data = fixture(name);
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  if (data.previous_refund) {
    const previous: CanonicalSaleRefundedEvent = {
      event_id: "previous_domain",
      event_type: "sale.refunded",
      schema_version: "1.0.0",
      source: "yoco",
      workspace_id: "ws_1",
      integration_id: "integration_1",
      refund_id: data.previous_refund.refund_id,
      source_order_id: data.previous_refund.source_order_id,
      occurred_at: "2026-07-15T07:00:00.000Z",
      received_at: "2026-07-15T07:00:01.000Z",
      currency: "ZAR",
      refund_type: "PARTIAL_QUANTITY",
      gross_amount: 100,
      discount_amount: 0,
      net_amount: 86.96,
      tax_amount: 13.04,
      tip_amount: 0,
      financial_resolution_status: "RESOLVED",
      inventory_resolution_status: "RESOLVED",
      reporting_resolution_status: "RESOLVED",
      reconciliation_status: "PENDING",
      overall_status: "COMPLETED",
      lines: [
        {
          source_refund_line_id: "previous_line",
          source_original_line_id: data.previous_refund.line_id,
          source_product_id: "yoco_prod_1",
          source_name: "Burger",
          quantity: data.previous_refund.quantity,
          gross_amount: 100,
          discount_amount: 0,
          net_amount: 86.96,
          tax_amount: 13.04,
          match_confidence: 1,
          resolution_method: "EXACT_SOURCE_LINE",
          mapping_status: "MAPPED",
          mapped_menu_item_id: "product_1",
        },
      ],
      metadata: {},
    };
    db.database
      .prepare(
        `INSERT INTO yoco_v2_domain_events (id, workspace_id, integration_id, raw_event_id, event_key, event_type, schema_version, source_entity_id, occurred_at, payload_json, resolution_status, created_at, updated_at) VALUES (?, 'ws_1', 'integration_1', 'raw_previous', ?, 'sale.refunded', '1.0.0', ?, ?, ?, 'COMPLETED', ?, ?)`,
      )
      .run(
        "previous_domain",
        `refund:${previous.refund_id}`,
        previous.refund_id,
        previous.occurred_at,
        JSON.stringify(previous),
        previous.occurred_at,
        previous.occurred_at,
      );
  }
  const env = envFor(db, fixtureGate(data));
  const result = await resolveCanonicalYocoRefund(env, {
    rawEvent: rawEvent(data),
    processingRun: processingRun("run_refund", attempt),
  });
  return { data, db, env, ...result };
}

function originalQuantity(line: any) {
  const original = line?.metadata?.original_line || {};
  return Math.max(
    0.000001,
    Math.abs(
      Number(
        original.quantity ??
          original.qty ??
          original.count ??
          line.quantity ??
          1,
      ),
    ),
  );
}

function seedSaleMovementSnapshots(setup: any, canonical = setup.canonical) {
  const now = "2026-07-15T07:59:00.000Z";
  let index = 0;
  for (const line of canonical.lines || []) {
    const originalQty = originalQuantity(line);
    const movements: Array<{
      ingredient: string;
      quantity: number;
      cost: number;
      modifierId?: string;
      ruleId?: string;
      ruleVersion?: number;
      actionType?: string;
    }> = [];
    if (line.mapped_menu_item_id === "product_1")
      movements.push({
        ingredient: "ingredient_1",
        quantity: -0.5 * originalQty,
        cost: 100,
      });
    if (line.mapped_menu_item_id === "product_2")
      movements.push({
        ingredient: "ingredient_2",
        quantity: -0.2 * originalQty,
        cost: 80,
      });
    for (const modifier of line.modifiers || []) {
      if (modifier.mapped_modifier_id === "mod_cheese") {
        movements.push({
          ingredient: "ingredient_2",
          quantity:
            -0.1 * originalQty * Math.abs(Number(modifier.quantity || 1)),
          cost: 80,
          modifierId: "mod_cheese",
          ruleId: "rule_mod_cheese_v1",
          ruleVersion: 1,
          actionType: "ADD_RECIPE",
        });
      }
    }
    for (const movement of movements) {
      index += 1;
      const proposalKey = `sale-snapshot:${canonical.source_order_id}:${line.source_original_line_id}:${movement.modifierId || "base"}:${movement.ingredient}:${index}`;
      setup.db.database
        .prepare(
          `INSERT INTO modifier_sale_movement_snapshots
          (id,workspace_id,domain_event_id,source_order_id,source_line_id,menu_item_id,modifier_id,
           ingredient_item_id,location_id,original_line_quantity,movement_quantity,base_uom,
           unit_cost_ex_vat,movement_value,proposal_key,modifier_rule_id,modifier_rule_version,
           modifier_action_type,rule_snapshot_json,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          `snapshot_${index}`,
          "ws_1",
          String(setup.domainEvent.id),
          canonical.source_order_id,
          line.source_original_line_id,
          line.mapped_menu_item_id || null,
          movement.modifierId || null,
          movement.ingredient,
          "loc_1",
          originalQty,
          movement.quantity,
          "kg",
          movement.cost,
          movement.quantity * movement.cost,
          proposalKey,
          movement.ruleId || null,
          movement.ruleVersion || null,
          movement.actionType || null,
          JSON.stringify({ version: movement.ruleVersion || null }),
          "APPLIED",
          now,
          now,
        );
    }
  }
}

// Refunds no longer auto-open manual reviews; the manual-allocation capability remains for an
// explicit admin-initiated review, so these tests seed one directly to exercise that path.
function seedRefundManualReview(setup: any) {
  const now = new Date().toISOString();
  const lines =
    (setup.canonical?.metadata as any)?.original_order?.line_items || [];
  setup.db.database
    .prepare(
      `INSERT INTO yoco_v2_manual_reviews (id,workspace_id,integration_id,domain_event_id,review_type,status,reason_code,reason_message,available_source_lines_json,refund_financials_json,proposed_allocation_json,resolved_allocation_json,audit_history_json,created_at,updated_at)
     VALUES ('rev_seed','ws_1','integration_1',?, 'REFUND_LINE_ALLOCATION','OPEN','AMOUNT_ONLY_WITHOUT_RETURN_LINES','Administrator opened allocation review.',?, '{}','[]','[]','[]',?,?)`,
    )
    .run(String(setup.domainEvent.id), JSON.stringify(lines), now, now);
  return setup.db.database
    .prepare(`SELECT * FROM yoco_v2_manual_reviews WHERE id = 'rev_seed'`)
    .get() as any;
}

const exactFixtures: Array<[string, string, number]> = [
  ["full-refund", "FULL", 2],
  ["single-line-partial-refund", "PARTIAL_LINE", 1],
  ["partial-quantity-refund", "PARTIAL_QUANTITY", 1],
  ["multiple-line-partial-refund", "PARTIAL_QUANTITY", 2],
  ["discounted-refund", "FULL", 1],
  ["vat-refund", "PARTIAL_QUANTITY", 1],
  ["refund-before-order-event", "PARTIAL_LINE", 1],
  ["modifiers-on-refunded-line", "FULL", 1],
];

for (const [name, refundType, lineCount] of exactFixtures) {
  test(`fixture ${name} resolves canonical refund exactly`, async () => {
    const { canonical } = await setupFixture(name);
    assert.equal(canonical.refund_type, refundType);
    assert.equal(canonical.lines.length, lineCount);
    assert.equal(canonical.financial_resolution_status, "RESOLVED");
    assert.equal(canonical.inventory_resolution_status, "RESOLVED");
  });
}

test("canonical refund inherits the approved original sale tender for payment reporting", async () => {
  const data = fixture("full-refund");
  data.original_order = {
    ...data.original_order,
    payments: [
      { id: "pay_original_cash", status: "approved", payment_method: "cash" },
    ],
  };
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const resolved = await resolveCanonicalYocoRefund(
    envFor(db, fixtureGate(data)),
    {
      rawEvent: rawEvent(data, "raw_refund_original_tender"),
      processingRun: processingRun("run_refund_original_tender", 4),
    },
  );
  assert.equal(resolved.canonical.payment_method, "cash");
});

test("amount-only and custom amount refunds record reporting and skip stock without a manual review", async () => {
  for (const name of [
    "amount-only-refund",
    "custom-amount-refund",
    "two-equal-priced-products",
  ]) {
    const { canonical, db } = await setupFixture(name);
    assert.equal(canonical.refund_type, "AMOUNT_ONLY");
    assert.equal(canonical.lines.length, 0);
    // Policy: reporting still resolves; stock is skipped (NOT_APPLICABLE); no review is opened.
    assert.equal(canonical.financial_resolution_status, "RESOLVED");
    assert.equal(canonical.inventory_resolution_status, "NOT_APPLICABLE");
    assert.equal(
      Number(
        (
          db.database
            .prepare(
              `SELECT COUNT(*) AS count FROM yoco_v2_manual_reviews WHERE status = 'OPEN'`,
            )
            .get() as any
        ).count,
      ),
      0,
    );
  }
});

test("a full-order-remainder refund prorates VAT/gross/net to what's actually left, not the original line's full amount", async () => {
  // Regression guard: when a prior partial refund already reduced how much of "line_1" (2
  // Burgers) remains, and a later refund event covers the FULL remainder as one lump sum with no
  // return-line detail, the FULL_ORDER_REMAINDER path used to build a synthetic "returned line"
  // that carried the ORIGINAL (unscaled) line's gross/tax/net regardless of how much was actually
  // remaining — so a 1-of-2-Burgers remainder was refunded as if all 2 were still outstanding.
  const { canonical } = await setupFixture("full-refund-after-partial");
  assert.equal(canonical.refund_type, "FULL");
  const burgerLine = canonical.lines.find((line) => line.source_original_line_id === "line_1");
  assert.ok(burgerLine, "the remaining Burger quantity should still be allocated a line");
  assert.equal(burgerLine.quantity, 1, "only the 1 remaining Burger should be refunded, not the original 2");
  assert.equal(burgerLine.tax_amount, 13.05, "VAT should be prorated to the 1 remaining Burger, not the full 2-Burger line");
  // Total refund tax = prorated Burger (13.05) + the untouched Chips line's own tax (6.52).
  assert.equal(canonical.tax_amount, 19.57);
});

test("an amount-only refund reverses the VAT rate recorded at sale time, not the workspace's current rate", async () => {
  // Regression guard: an amount-only refund (no explicit tax figure on Yoco's own refund
  // resource) used to recompute VAT at whatever the CURRENT workspace_settings rate is. If the
  // workspace's VAT registration changes between the sale and the refund, that silently
  // corrupts the reversal. It must instead reuse the rate snapshotted on the original sale's
  // yoco_orders row.
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  db.database
    .prepare(
      `INSERT INTO yoco_orders (id, workspace_id, yoco_order_id, order_type, status, total, occurred_at, raw_json, created_at, gross_total, vat_total, net_total, vat_rate, vat_registered)
       VALUES ('order_db_1', 'ws_1', 'ord_ref_1', 'sale', 'completed', 250, '2026-07-15T08:00:00.000Z', '{}', '2026-07-15T08:00:00.000Z', 250, 32.61, 217.39, 15, 1)`,
    )
    .run();
  // The workspace becomes VAT-unregistered AFTER the sale, before the refund is processed.
  db.database
    .prepare(`UPDATE workspace_settings SET vat_rate = 0 WHERE workspace_id = 'ws_1'`)
    .run();

  const data = fixture("amount-only-refund");
  const env = envFor(db, fixtureGate(data));
  const { canonical } = await resolveCanonicalYocoRefund(env, {
    rawEvent: rawEvent(data),
    processingRun: processingRun("run_refund", 4),
  });
  assert.equal(canonical.refund_type, "AMOUNT_ONLY");
  // R50 refund at the sale-time 15% rate: 50 - 50/1.15 = 6.52, NOT 0.
  assert.equal(canonical.tax_amount, 6.52);
});

test("refund lines nested in the refund order returns[] with variant-only ids resolve and allocate stock", async () => {
  // Mirrors real Yoco POS data: the refund + refund order carry no top-level line_items; the
  // returned line lives under refund_order.returns[].returned_line_items and identifies the product
  // only by variant_id (no product_id, no original_line_id). Previously this fell to AMOUNT_ONLY.
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const refund = {
    id: "ref_v",
    order_id: "reford_v",
    original_order_id: "ord_v",
    payment_id: "pay_v",
    total_amount: { amount: 7000, currency: "ZAR" },
    status: "approved",
    payment_method: "cash",
    refund_type: "other",
  };
  const returnedLine = {
    id: "retline_1",
    variant_id: "yoco_var_1",
    name: "Cheese Burger (Burger Only)",
    quantity: "1",
    item_type: "product",
    unit_price: { amount: 7000, currency: "ZAR" },
    total_price: { amount: 7000, currency: "ZAR" },
    net_amount: { amount: 7000, currency: "ZAR" },
    applied_taxes: [
      {
        name: "VAT",
        type: "inclusive",
        percentage: "15.00",
        tax_amount: { amount: 913, currency: "ZAR" },
      },
    ],
    modifiers: [],
  };
  const refundOrder = {
    id: "reford_v",
    currency: "ZAR",
    location_id: "yoco_loc_1",
    status: "completed",
    line_items: [],
    amounts: { net_amount: { amount: -7000, currency: "ZAR" } },
    refunds: [refund],
    returns: [
      {
        source_order_id: "ord_v",
        amounts: {
          gross_amount: { amount: 7000, currency: "ZAR" },
          tax_amount: { amount: 913, currency: "ZAR" },
          net_amount: { amount: 7000, currency: "ZAR" },
        },
        returned_line_items: [returnedLine],
      },
    ],
  };
  const originalOrder = {
    id: "ord_v",
    currency: "ZAR",
    location_id: "yoco_loc_1",
    status: "completed",
    amounts: {
      gross_amount: { amount: 14000, currency: "ZAR" },
      net_amount: { amount: 14000, currency: "ZAR" },
      tax_amount: { amount: 1826, currency: "ZAR" },
    },
    line_items: [
      {
        id: "line_v1",
        variant_id: "yoco_var_1",
        name: "Cheese Burger (Burger Only)",
        quantity: "2",
        item_type: "product",
        unit_price: { amount: 7000, currency: "ZAR" },
        total_price: { amount: 14000, currency: "ZAR" },
        net_amount: { amount: 14000, currency: "ZAR" },
        applied_taxes: [
          {
            name: "VAT",
            type: "inclusive",
            percentage: "15.00",
            tax_amount: { amount: 1826, currency: "ZAR" },
          },
        ],
        modifiers: [],
      },
    ],
  };
  const handler = (input: any) => {
    const url = new URL(String(input.url));
    if (url.pathname === "/v1/orders/" || url.pathname === "/v1/refunds/")
      return gateResponse({ data: [] });
    if (url.pathname.startsWith("/v1/refunds/"))
      return gateResponse({ data: refund });
    if (url.pathname.startsWith("/v1/payments/"))
      return gateResponse({ data: { id: "pay_v", order_id: "ord_v" } });
    if (url.pathname.startsWith("/v1/orders/")) {
      const id = decodeURIComponent(
        url.pathname.split("/").filter(Boolean).pop() || "",
      );
      if (id === "reford_v") return gateResponse({ data: refundOrder });
      if (id === "ord_v") return gateResponse({ data: originalOrder });
    }
    return gateResponse(null, 404, "NOT_FOUND");
  };
  const result = await resolveCanonicalYocoRefund(envFor(db, handler), {
    rawEvent: rawEvent(
      {
        event: { id: "evt_v", type: "refund.succeeded", data: { refund } },
      } as any,
      "raw_v",
    ),
    processingRun: processingRun("run_v", 4),
  });
  assert.equal(result.canonical.refund_type, "PARTIAL_QUANTITY");
  assert.equal(result.canonical.lines.length, 1);
  assert.equal(result.canonical.lines[0].quantity, 1);
  assert.equal(result.canonical.lines[0].resolution_method, "RETURN_RESOURCE");
  assert.equal(result.canonical.inventory_resolution_status, "RESOLVED");
});

test("multiple refunds reduce remaining quantities and prevent over-refund", async () => {
  const { canonical } = await setupFixture("multiple-refunds-one-order");
  assert.equal(canonical.lines.length, 1);
  assert.equal(canonical.lines[0].quantity, 1);
  const exceeded = await setupFixture("refund-exceeding-remaining-quantity");
  assert.equal(exceeded.canonical.lines.length, 0);
  assert.equal(
    exceeded.canonical.inventory_resolution_status,
    "NOT_APPLICABLE",
  );
  assert.equal(
    (exceeded.canonical.metadata as any).allocation_reason_code,
    "REFUND_QUANTITY_EXCEEDS_REMAINING",
  );
});

test("refund lookup window advances on retry and stays inside Yoco's 31-day range limit", () => {
  const receivedAt = "2026-07-15T08:00:01.000Z";
  const nowMs = Date.parse("2026-07-17T10:00:00.000Z");
  const window = refundLookupUpdatedWindow(receivedAt, nowMs);
  const startMs = Date.parse(window.updated_at__gte);
  const endMs = Date.parse(window.updated_at__lte);

  assert.equal(endMs, nowMs + 5 * 60_000);
  assert.ok(endMs > Date.parse(receivedAt) + 60 * 60_000);
  assert.ok(endMs - startMs < 31 * 24 * 60 * 60_000);

  const oldWindow = refundLookupUpdatedWindow(
    "2026-04-01T00:00:00.000Z",
    nowMs,
  );
  assert.ok(
    Date.parse(oldWindow.updated_at__lte) -
      Date.parse(oldWindow.updated_at__gte) <
      31 * 24 * 60 * 60_000,
  );
});

test("duplicate refund webhooks enrich one canonical event", async () => {
  const data = fixture("duplicate-refund-webhook");
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const env = envFor(db, fixtureGate(data));
  await resolveCanonicalYocoRefund(env, {
    rawEvent: rawEvent(data, "raw_a"),
    processingRun: processingRun("run_a"),
  });
  await resolveCanonicalYocoRefund(env, {
    rawEvent: rawEvent(data, "raw_b"),
    processingRun: processingRun("run_b"),
  });
  assert.equal(
    Number(
      (
        db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_v2_domain_events WHERE event_type = 'sale.refunded'`,
          )
          .get() as any
      ).count,
    ),
    1,
  );
});

test("flat Yoco payment.refunded webhook discovers the real refund and upgrades the provisional refund-order identity", async () => {
  const data = fixture("single-line-partial-refund");
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  let refundVisible = false;
  const discoveredRefund = {
    ...data.refund,
    id: "ref_line",
    // Live Yoco responses can correlate correctly by payment while exposing an
    // order_id that is not identical to payment.refunded.order_id.
    order_id: "ord_ref_1",
    original_order_id: "ord_ref_1",
    payment_id: "pay_ref_1",
    created_at: "2026-07-08T08:00:00.000Z",
    updated_at: "2026-07-15T08:00:00.000Z",
    processed_at: "2026-07-15T08:00:00.500Z",
  };
  const handler = (input: any) => {
    const url = new URL(String(input.url));
    if (url.pathname === "/v1/refunds/") {
      assert.ok(url.searchParams.get("updated_at__gte"));
      assert.ok(url.searchParams.get("updated_at__lte"));
      assert.equal(url.searchParams.get("created_at__gte"), null);
      assert.equal(url.searchParams.get("status"), "approved");
      return gateResponse({ data: refundVisible ? [discoveredRefund] : [] });
    }
    if (url.pathname.startsWith("/v1/payments/"))
      return gateResponse({ data: { id: "pay_ref_1", order_id: "ord_ref_1" } });
    if (url.pathname === "/v1/orders/ord_ref_1")
      return gateResponse({ data: data.original_order });
    if (url.pathname === "/v1/orders/refund_order_1")
      return gateResponse(null, 404, "NOT_FOUND");
    return gateResponse(null, 404, "NOT_FOUND");
  };
  const env = envFor(db, handler);
  const raw = {
    id: "raw_flat_refund",
    workspace_id: "ws_1",
    integration_id: "integration_1",
    trace_id: "trace_flat_refund",
    event_type: "payment.refunded",
    payload_json: JSON.stringify({
      business_id: "business_1",
      event_type: "payment.refunded",
      order_id: "refund_order_1",
      payment_id: "pay_ref_1",
    }),
    received_at: "2026-07-15T08:00:01.000Z",
    yoco_event_id: "msg_flat_refund_1",
    event_key: "yoco-event:msg_flat_refund_1",
  };

  await assert.rejects(
    resolveCanonicalYocoRefund(env, {
      rawEvent: raw,
      processingRun: processingRun("run_flat_wait", 1),
    }),
    (error: any) =>
      error.code === "YOCO_V2_REFUND_LOOKUP_WAITING" &&
      error.retryable === true,
  );
  assert.equal(
    (
      db.database
        .prepare(
          `SELECT source_entity_id FROM yoco_v2_domain_events WHERE raw_event_id = 'raw_flat_refund'`,
        )
        .get() as any
    ).source_entity_id,
    "refund_order_1",
  );

  refundVisible = true;
  const resolved = await resolveCanonicalYocoRefund(env, {
    rawEvent: raw,
    processingRun: processingRun("run_flat_resolved", 4),
  });
  assert.equal(resolved.canonical.refund_id, "ref_line");
  assert.equal(resolved.canonical.source_order_id, "ord_ref_1");
  assert.equal(resolved.canonical.source_payment_id, "pay_ref_1");
  assert.equal(resolved.canonical.lines.length, 1);
  assert.equal(resolved.canonical.inventory_resolution_status, "RESOLVED");
  assert.equal(
    Number(
      (
        db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_v2_domain_events WHERE event_type = 'sale.refunded' AND COALESCE(resolution_status, '') <> 'SUPERSEDED'`,
          )
          .get() as any
      ).count,
    ),
    1,
  );
  assert.equal(
    (
      db.database
        .prepare(
          `SELECT source_entity_id FROM yoco_v2_domain_events WHERE raw_event_id = 'raw_flat_refund' AND COALESCE(resolution_status, '') <> 'SUPERSEDED'`,
        )
        .get() as any
    ).source_entity_id,
    "ref_line",
  );
  assert.equal(
    Number(
      (
        db.database
          .prepare(`SELECT COUNT(*) AS count FROM stock_movements`)
          .get() as any
      ).count,
    ),
    0,
  );
});

test("flat payment.refunded follows Yoco next_cursor and resolves a refund found on page two", async () => {
  const data = fixture("single-line-partial-refund");
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const sourceOrder = { ...data.original_order, id: "ord_ref_page_2" };
  const discoveredRefund = {
    ...data.refund,
    id: "ref_page_2",
    order_id: "refund_order_page_2",
    original_order_id: "ord_ref_page_2",
    payment_id: "pay_ref_page_2",
    updated_at: "2026-07-15T08:00:00.000Z",
    processed_at: "2026-07-15T08:00:00.500Z",
  };
  let refundListCalls = 0;
  const handler = (input: any) => {
    const url = new URL(String(input.url));
    if (url.pathname === "/v1/refunds/") {
      refundListCalls += 1;
      assert.ok(url.searchParams.get("updated_at__gte"));
      assert.ok(url.searchParams.get("updated_at__lte"));
      assert.equal(url.searchParams.get("created_at_gte"), null);
      assert.equal(url.searchParams.get("created_at_lte"), null);
      assert.equal(url.searchParams.get("status"), "approved");
      if (!url.searchParams.get("cursor"))
        return gateResponse({ data: [], next_cursor: "refund-cursor-2" });
      assert.equal(url.searchParams.get("cursor"), "refund-cursor-2");
      return gateResponse({ data: [discoveredRefund], next_cursor: null });
    }
    if (url.pathname === "/v1/refunds/ref_page_2")
      return gateResponse({ data: discoveredRefund });
    if (url.pathname === "/v1/payments/pay_ref_page_2")
      return gateResponse({
        data: { id: "pay_ref_page_2", order_id: "ord_ref_page_2", refunds: [] },
      });
    if (url.pathname === "/v1/orders/refund_order_page_2")
      return gateResponse(null, 404, "NOT_FOUND");
    if (url.pathname === "/v1/orders/ord_ref_page_2")
      return gateResponse({ data: sourceOrder });
    return gateResponse(null, 404, "NOT_FOUND");
  };
  const raw = {
    id: "raw_flat_refund_page_2",
    workspace_id: "ws_1",
    integration_id: "integration_1",
    trace_id: "trace_flat_refund_page_2",
    event_type: "payment.refunded",
    payload_json: JSON.stringify({
      business_id: "business_1",
      event_type: "payment.refunded",
      order_id: "refund_order_page_2",
      payment_id: "pay_ref_page_2",
    }),
    received_at: "2026-07-15T08:00:01.000Z",
    yoco_event_id: "msg_flat_refund_page_2",
    event_key: "yoco-event:msg_flat_refund_page_2",
  };

  const resolved = await resolveCanonicalYocoRefund(envFor(db, handler), {
    rawEvent: raw,
    processingRun: processingRun("run_flat_refund_page_2", 4),
  });
  assert.equal(refundListCalls, 2);
  assert.equal(resolved.canonical.refund_id, "ref_page_2");
  assert.equal(resolved.canonical.source_order_id, "ord_ref_page_2");
  assert.equal(resolved.canonical.source_payment_id, "pay_ref_page_2");
  assert.equal(resolved.canonical.inventory_resolution_status, "RESOLVED");
  assert.equal(
    Number(
      (
        db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_v2_api_requests WHERE endpoint_name = 'refund.list'`,
          )
          .get() as any
      ).count,
    ),
    2,
  );
});

test("flat payment.refunded resolves from final refund-order detail while the refunds list is still empty", async () => {
  const data = fixture("single-line-partial-refund");
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const refundOrder = {
    id: "refund_order_1",
    status: "completed",
    original_order_id: "ord_ref_1",
    payment_id: "pay_ref_1",
    updated_at: "2026-07-15T08:00:00.500Z",
    amounts: { total_amount: { amount: 5000, currency: "ZAR" } },
    returns: [
      {
        source_order_id: "ord_ref_1",
        total_amount: { amount: 5000, currency: "ZAR" },
        returned_line_items: (data.refund as any).returned_line_items,
      },
    ],
  };
  const handler = (input: any) => {
    const url = new URL(String(input.url));
    if (url.pathname === "/v1/orders/refund_order_1")
      return gateResponse({ data: refundOrder });
    if (url.pathname === "/v1/payments/pay_ref_1")
      return gateResponse({
        data: { id: "pay_ref_1", order_id: "ord_ref_1", refunds: [] },
      });
    if (url.pathname === "/v1/refunds/") return gateResponse({ data: [] });
    if (url.pathname === "/v1/orders/ord_ref_1")
      return gateResponse({ data: data.original_order });
    return gateResponse(null, 404, "NOT_FOUND");
  };
  const env = envFor(db, handler);
  const raw = {
    id: "raw_flat_refund_order_fallback",
    workspace_id: "ws_1",
    integration_id: "integration_1",
    trace_id: "trace_flat_refund_order_fallback",
    event_type: "payment.refunded",
    payload_json: JSON.stringify({
      business_id: "business_1",
      event_type: "payment.refunded",
      order_id: "refund_order_1",
      payment_id: "pay_ref_1",
    }),
    received_at: "2026-07-15T08:00:01.000Z",
    yoco_event_id: "msg_flat_refund_order_fallback",
    event_key: "yoco-event:msg_flat_refund_order_fallback",
  };

  const resolved = await resolveCanonicalYocoRefund(env, {
    rawEvent: raw,
    processingRun: processingRun("run_flat_refund_order_fallback", 3),
  });
  assert.equal(resolved.canonical.refund_id, "refund_order_1");
  assert.equal(resolved.canonical.source_order_id, "ord_ref_1");
  assert.equal(resolved.canonical.source_payment_id, "pay_ref_1");
  assert.equal(resolved.canonical.lines.length, 1);
  assert.equal(resolved.canonical.financial_resolution_status, "RESOLVED");
  assert.equal(resolved.canonical.inventory_resolution_status, "RESOLVED");
  assert.equal(
    Number(
      (
        db.database
          .prepare(`SELECT COUNT(*) AS count FROM stock_movements`)
          .get() as any
      ).count,
    ),
    0,
  );
  const apiEndpoints = db.database
    .prepare(
      `SELECT endpoint_name FROM yoco_v2_api_requests ORDER BY created_at, id`,
    )
    .all() as any[];
  assert.ok(apiEndpoints.some((row) => row.endpoint_name === "order.detail"));
  assert.ok(apiEndpoints.some((row) => row.endpoint_name === "payment.detail"));
  assert.ok(apiEndpoints.some((row) => row.endpoint_name === "refund.list"));
});

test("refund order and returned lines delayed remain retryable before manual review", async () => {
  const orderDelayed = fixture("refund-order-temporarily-unavailable");
  const db1 = createDb();
  seedCore(db1);
  await configureApiKey(db1);
  await assert.rejects(
    resolveCanonicalYocoRefund(envFor(db1, fixtureGate(orderDelayed)), {
      rawEvent: rawEvent(orderDelayed),
      processingRun: processingRun("run_wait_order", 1),
    }),
    (error: any) =>
      error.code === "YOCO_V2_REFUND_ORDER_WAITING" && error.retryable === true,
  );
  const linesDelayed = fixture("returned-lines-delayed");
  const db2 = createDb();
  seedCore(db2);
  await configureApiKey(db2);
  await assert.rejects(
    resolveCanonicalYocoRefund(envFor(db2, fixtureGate(linesDelayed)), {
      rawEvent: rawEvent(linesDelayed),
      processingRun: processingRun("run_wait_lines", 1),
    }),
    (error: any) =>
      error.code === "YOCO_V2_RETURN_LINES_WAITING" && error.retryable === true,
  );
});

test("manual allocation validates totals and creates a deterministic stock proposal", async () => {
  const setup = await setupFixture("amount-only-refund");
  const review = seedRefundManualReview(setup);
  await saveManualRefundAllocation(setup.env, {
    workspaceId: "ws_1",
    reviewId: review.id,
    allocation: [{ source_original_line_id: "line_2", quantity: 1 }],
    resolvedBy: "admin_1",
  });
  const rerun = await resolveCanonicalYocoRefund(setup.env, {
    rawEvent: rawEvent(setup.data, "raw_manual"),
    processingRun: processingRun("run_manual", 4),
  });
  assert.equal(rerun.canonical.lines.length, 1);
  assert.equal(rerun.canonical.lines[0].resolution_method, "MANUAL_ALLOCATION");
  seedSaleMovementSnapshots(setup, rerun.canonical);
  const proposals = await buildRefundStockProposals(
    setup.env,
    rerun.domainEvent,
    rerun.canonical,
    "raw_manual",
    "run_manual",
  );
  assert.equal(proposals.filter((row) => !row.warning_code).length, 1);
  assert.equal(
    Number(
      (
        setup.db.database
          .prepare(`SELECT COUNT(*) AS count FROM stock_movements`)
          .get() as any
      ).count,
    ),
    0,
  );
});

test("exact full, partial line, partial quantity and modifier refund proposals are positive reverse movements", async () => {
  for (const name of [
    "full-refund",
    "single-line-partial-refund",
    "partial-quantity-refund",
    "modifiers-on-refunded-line",
  ]) {
    const setup = await setupFixture(name);
    await buildRefundReportingProposal(
      setup.env,
      setup.domainEvent,
      setup.canonical,
      "raw_refund",
      "run_refund",
    );
    seedSaleMovementSnapshots(setup);
    const proposals = await buildRefundStockProposals(
      setup.env,
      setup.domainEvent,
      setup.canonical,
      "raw_refund",
      "run_refund",
    );
    assert.ok(
      proposals
        .filter((row) => !row.warning_code)
        .every((row) => Number(row.quantity) > 0),
    );
    if (name === "modifiers-on-refunded-line")
      assert.ok(proposals.some((row) => row.modifier_id === "mod_cheese"));
    assert.equal(
      Number(
        (
          setup.db.database
            .prepare(`SELECT COUNT(*) AS count FROM stock_movements`)
            .get() as any
        ).count,
      ),
      0,
    );
  }
});

test("refunds keep the original sale movement after the current recipe is changed", async () => {
  const setup = await setupFixture("single-line-partial-refund");
  seedSaleMovementSnapshots(setup);
  setup.db.database.exec(`
    INSERT INTO stock_items (id, workspace_id, name, item_type, unit, unit_cost, active, is_stocked)
      VALUES ('prep_1', 'ws_1', 'Prep', 'prep', 'kg', 0, 1, 0);
    DELETE FROM recipe_lines WHERE recipe_id = 'recipe_product_2';
    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order)
      VALUES ('product_to_prep', 'ws_1', 'recipe_product_2', 'prep_1', 1, 'kg', 1);
    INSERT INTO recipes (id, workspace_id, owner_type, owner_id, yield_qty, active)
      VALUES ('recipe_prep', 'ws_1', 'stock_item', 'prep_1', 1, 1);
    INSERT INTO recipe_lines (id, workspace_id, recipe_id, stock_item_id, quantity, unit, sort_order)
      VALUES ('prep_to_ingredient', 'ws_1', 'recipe_prep', 'ingredient_2', 0.2, 'kg', 1);
  `);
  const proposals = await buildRefundStockProposals(
    setup.env,
    setup.domainEvent,
    setup.canonical,
    "raw_refund",
    "run_refund",
  );
  assert.equal(
    proposals.filter((row) => row.ingredient_item_id === "ingredient_2").length,
    1,
  );
  assert.equal(
    proposals.filter((row) => row.ingredient_item_id === "prep_1").length,
    0,
  );
});

test("rerunning refund proposal remains idempotent", async () => {
  const setup = await setupFixture("partial-quantity-refund");
  seedSaleMovementSnapshots(setup);
  await buildRefundReportingProposal(
    setup.env,
    setup.domainEvent,
    setup.canonical,
    "raw",
    "run",
  );
  await buildRefundReportingProposal(
    setup.env,
    setup.domainEvent,
    setup.canonical,
    "raw",
    "run",
  );
  await buildRefundStockProposals(
    setup.env,
    setup.domainEvent,
    setup.canonical,
    "raw",
    "run",
  );
  await buildRefundStockProposals(
    setup.env,
    setup.domainEvent,
    setup.canonical,
    "raw",
    "run",
  );
  assert.equal(
    Number(
      (
        setup.db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_v2_proposed_refund_reporting`,
          )
          .get() as any
      ).count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        setup.db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_v2_proposed_refund_stock_movements`,
          )
          .get() as any
      ).count,
    ),
    1,
  );
});

test("queue refund processing applies live reporting and keeps stock bounded by original deductions", async () => {
  const data = fixture("single-line-partial-refund");
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const env = envFor(db, fixtureGate(data));
  const raw = rawEvent(data, "raw_queue");
  db.database
    .prepare(
      `INSERT INTO yoco_v2_raw_events (id, workspace_id, integration_id, event_key, yoco_event_id, event_type, payload_json, payload_hash, signature_valid, received_at, headers_json, capture_status, queue_status, processing_status, processing_attempts, trace_id, created_at, updated_at) VALUES (?, 'ws_1', 'integration_1', 'queue-refund', 'evt_queue', 'refund.succeeded', ?, 'hash', 1, ?, '{}', 'CAPTURED', 'PUBLISHED', 'QUEUED', 0, ?, ?, ?)`,
    )
    .run(
      raw.id,
      raw.payload_json,
      raw.received_at,
      raw.trace_id,
      raw.received_at,
      raw.received_at,
    );
  const result = await processYocoV2QueueMessage(env, {
    raw_event_id: "raw_queue",
    workspace_id: "ws_1",
    integration_id: "integration_1",
    event_type: "refund.succeeded",
    trace_id: "trace_raw_queue",
    live_effects: true,
  });
  assert.equal(result.action, "ack");
  assert.equal(
    Number(
      (
        db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_orders WHERE order_type = 'refund'`,
          )
          .get() as any
      ).count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        db.database
          .prepare(`SELECT COUNT(*) AS count FROM stock_movements`)
          .get() as any
      ).count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_v2_live_refund_effect_outbox WHERE effect_type = 'REFUND_STOCK' AND status = 'BLOCKED'`,
          )
          .get() as any
      ).count,
    ),
    1,
  );
  const flags = yocoV2FeatureFlags(env, "ws_1");
  assert.equal(flags.yoco_v2_live_refund_reporting, true);
  assert.equal(flags.yoco_v2_live_refund_stock, true);
});

test("reconciliation discovers missing webhook, rebuilds canonical activity and overlap stays idempotent", async () => {
  const data = fixture("single-line-partial-refund");
  const sale = data.original_order;
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const env = envFor(
    db,
    fixtureGate(data, { listOrders: [sale], listRefunds: [data.refund] }),
  );
  const first = await runYocoV2Reconciliation(env, "ws_1", "integration_1", {
    windowStart: "2026-07-15T00:00:00.000Z",
    windowEnd: "2026-07-15T12:00:00.000Z",
  });
  assert.equal(first.status, "COMPLETED");
  assert.equal(Number(first.missing_events_found), 2);
  assert.equal(
    Number(
      (
        db.database
          .prepare(`SELECT COUNT(*) AS count FROM yoco_v2_domain_events`)
          .get() as any
      ).count,
    ),
    2,
  );
  const rawBefore = Number(
    (
      db.database
        .prepare(`SELECT COUNT(*) AS count FROM yoco_v2_raw_events`)
        .get() as any
    ).count,
  );
  await runYocoV2Reconciliation(env, "ws_1", "integration_1", {
    windowStart: "2026-07-15T00:00:00.000Z",
    windowEnd: "2026-07-15T13:00:00.000Z",
  });
  assert.equal(
    Number(
      (
        db.database
          .prepare(`SELECT COUNT(*) AS count FROM yoco_v2_raw_events`)
          .get() as any
      ).count,
    ),
    rawBefore,
  );
});

test("reconciliation delayed and ambiguous refunds remain waiting or manual review", async () => {
  const delayed = fixture("returned-lines-delayed");
  const db1 = createDb();
  seedCore(db1);
  await configureApiKey(db1);
  const env1 = envFor(
    db1,
    fixtureGate(delayed, { listRefunds: [delayed.refund] }),
  );
  const run1 = await runYocoV2Reconciliation(env1, "ws_1", "integration_1", {
    windowStart: "2026-07-15T00:00:00.000Z",
    windowEnd: "2026-07-15T12:00:00.000Z",
  });
  assert.equal(run1.status, "COMPLETED");
  assert.equal(
    Number(
      (
        db1.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_v2_raw_events WHERE processing_status = 'WAITING'`,
          )
          .get() as any
      ).count,
    ),
    1,
  );

  const ambiguous = fixture("two-equal-priced-products");
  const db2 = createDb();
  seedCore(db2);
  await configureApiKey(db2);
  const env2 = envFor(
    db2,
    fixtureGate(ambiguous, { listRefunds: [ambiguous.refund] }),
  );
  await runYocoV2Reconciliation(env2, "ws_1", "integration_1", {
    windowStart: "2026-07-15T00:00:00.000Z",
    windowEnd: "2026-07-15T12:00:00.000Z",
  });
  // Ambiguous amount-only refund records reporting and skips stock; it never opens a review.
  assert.equal(
    Number(
      (
        db2.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_v2_manual_reviews WHERE status = 'OPEN'`,
          )
          .get() as any
      ).count,
    ),
    0,
  );
});

test("checkpoint advances only on success and failed or rate-limited runs preserve it", async () => {
  const data = fixture("single-line-partial-refund");
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const successEnv = envFor(
    db,
    fixtureGate(data, { listOrders: [], listRefunds: [] }),
  );
  await runYocoV2Reconciliation(successEnv, "ws_1", "integration_1", {
    windowStart: "2026-07-15T00:00:00.000Z",
    windowEnd: "2026-07-15T12:00:00.000Z",
  });
  const checkpoint = (
    db.database
      .prepare(`SELECT checkpoint_at FROM yoco_v2_reconciliation_state`)
      .get() as any
  ).checkpoint_at;
  const rateLimited = gateResponse({ message: "limited" }, 429, "RATE_LIMITED");
  const failedEnv = envFor(db, fixtureGate(data, { failLists: rateLimited }));
  await assert.rejects(
    runYocoV2Reconciliation(failedEnv, "ws_1", "integration_1", {
      windowEnd: "2026-07-15T13:00:00.000Z",
    }),
  );
  assert.equal(
    (
      db.database
        .prepare(`SELECT checkpoint_at FROM yoco_v2_reconciliation_state`)
        .get() as any
    ).checkpoint_at,
    checkpoint,
  );
  assert.equal(
    (
      db.database
        .prepare(
          `SELECT status FROM yoco_v2_reconciliation_runs ORDER BY started_at DESC LIMIT 1`,
        )
        .get() as any
    ).status,
    "PAUSED_RATE_LIMIT",
  );
});

test("reconciliation applies live financial effects and blocks stock returns without original sale deductions", async () => {
  const data = fixture("full-refund");
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const env = envFor(db, fixtureGate(data, { listRefunds: [data.refund] }));
  await runYocoV2Reconciliation(env, "ws_1", "integration_1", {
    windowStart: "2026-07-15T00:00:00.000Z",
    windowEnd: "2026-07-15T12:00:00.000Z",
  });
  assert.equal(
    Number(
      (
        db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_orders WHERE order_type = 'refund'`,
          )
          .get() as any
      ).count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        db.database
          .prepare(`SELECT COUNT(*) AS count FROM stock_movements`)
          .get() as any
      ).count,
    ),
    0,
  );
  assert.ok(
    Number(
      (
        db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_v2_live_refund_effect_outbox WHERE effect_type = 'REFUND_STOCK' AND status = 'BLOCKED'`,
          )
          .get() as any
      ).count,
    ) >= 1,
  );
});

test("custom amount manual allocation requires and records explicit financial-difference acknowledgement", async () => {
  const setup = await setupFixture("custom-amount-refund");
  const review = seedRefundManualReview(setup);
  await assert.rejects(
    saveManualRefundAllocation(setup.env, {
      workspaceId: "ws_1",
      reviewId: review.id,
      allocation: [{ source_original_line_id: "line_2", quantity: 1 }],
      resolvedBy: "admin_1",
    }),
    /acknowledgement is required/i,
  );
  const saved = await saveManualRefundAllocation(setup.env, {
    workspaceId: "ws_1",
    reviewId: review.id,
    allocation: [{ source_original_line_id: "line_2", quantity: 1 }],
    resolvedBy: "admin_1",
    acknowledgeFinancialDifference: true,
  });
  const history = JSON.parse(String(saved.audit_history_json || "[]"));
  assert.equal(history.at(-1).financial_difference_acknowledged, true);
  const rerun = await resolveCanonicalYocoRefund(setup.env, {
    rawEvent: rawEvent(setup.data, "raw_custom_manual"),
    processingRun: processingRun("run_custom_manual", 4),
  });
  assert.equal(rerun.canonical.lines.length, 1);
  assert.equal(rerun.canonical.lines[0].resolution_method, "MANUAL_ALLOCATION");
});

test("reconciliation uses documented date filters and paginates through root next_cursor before advancing its checkpoint", async () => {
  const data = fixture("single-line-partial-refund");
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  let orderListCalls = 0;
  const assertDocumentedDateFilters = (url: URL) => {
    assert.equal(
      url.searchParams.get("created_at__gte"),
      "2026-07-15T00:00:00.000Z",
    );
    assert.equal(
      url.searchParams.get("created_at__lte"),
      "2026-07-15T12:00:00.000Z",
    );
    assert.equal(url.searchParams.get("created_at_gte"), null);
    assert.equal(url.searchParams.get("created_at_lte"), null);
  };
  const handler = (input: any) => {
    const url = new URL(String(input.url));
    if (url.pathname === "/v1/orders/") {
      orderListCalls += 1;
      assertDocumentedDateFilters(url);
      if (!url.searchParams.get("cursor"))
        return gateResponse({
          data: [data.original_order],
          next_cursor: "cursor-2",
        });
      assert.equal(url.searchParams.get("cursor"), "cursor-2");
      return gateResponse({ data: [], next_cursor: null });
    }
    if (url.pathname === "/v1/refunds/") {
      assertDocumentedDateFilters(url);
      return gateResponse({ data: [], next_cursor: null });
    }
    if (url.pathname.startsWith("/v1/orders/"))
      return gateResponse({ data: data.original_order });
    return gateResponse(null, 404, "NOT_FOUND");
  };
  const run = await runYocoV2Reconciliation(
    envFor(db, handler),
    "ws_1",
    "integration_1",
    {
      windowStart: "2026-07-15T00:00:00.000Z",
      windowEnd: "2026-07-15T12:00:00.000Z",
    },
  );
  assert.equal(run.status, "COMPLETED");
  assert.equal(orderListCalls, 2);
  assert.equal(
    Number(
      (
        db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM yoco_v2_api_requests WHERE endpoint_name = 'order.list'`,
          )
          .get() as any
      ).count,
    ),
    2,
  );
});

test("reconciliation reports unresolved mappings without scanning retired legacy effect paths", async () => {
  const data = fixture("single-line-partial-refund");
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  db.database
    .prepare(
      `UPDATE products SET yoco_item_id = 'unmapped_product', yoco_variant_id = 'unmapped_variant' WHERE id = 'product_2'`,
    )
    .run();
  db.database
    .prepare(
      `INSERT INTO yoco_orders
    (id, workspace_id, yoco_order_id, yoco_payment_id, location_id, order_type, status, total, occurred_at, raw_json,
     parent_yoco_order_id, provider_refund_id, gross_total, vat_total, net_total)
    VALUES ('legacy_only_sale', 'ws_1', 'legacy_order_only', 'legacy_payment', 'loc_1', 'sale', 'completed', 100,
      '2026-07-15T07:00:00.000Z', '{}', NULL, NULL, 100, 13.04, 86.96)`,
    )
    .run();
  const env = envFor(
    db,
    fixtureGate(data, { listOrders: [], listRefunds: [data.refund] }),
  );
  const run = await runYocoV2Reconciliation(env, "ws_1", "integration_1", {
    windowStart: "2026-07-15T00:00:00.000Z",
    windowEnd: "2026-07-15T12:00:00.000Z",
  });
  assert.equal(run.status, "COMPLETED");
  const findings = db.database
    .prepare(
      `SELECT finding_type FROM yoco_v2_reconciliation_findings WHERE reconciliation_run_id = ? ORDER BY finding_type`,
    )
    .all(run.id) as Array<{ finding_type: string }>;
  const types = new Set(findings.map((row) => row.finding_type));
  assert.equal(types.has("UNRESOLVED_MAPPING"), true);
  assert.equal(types.has("LEGACY_ONLY_EFFECT"), false);
  assert.equal(types.has("V2_ONLY_SOURCE_ACTIVITY"), false);
});

// --- Scheduled-reconciliation write-storm regressions --------------------------------------------
// These cover the defect that consumed an entire day's Durable Object row-write allowance overnight
// with no client traffic: a failing run never recorded that it had run, so `dailyDue` stayed true
// and every 15-minute cron tick re-ran the full deep scan forever.

test("scheduled reconciliation skips a workspace that has not gone live and writes nothing", async () => {
  const data = fixture("single-line-partial-refund");
  const db = createDb();
  seedCore(db);
  // Deliberately NO configureApiKey(): no yoco_connections row at all, i.e. never went live.
  const env = envFor(db, fixtureGate(data, { listOrders: [], listRefunds: [] }));

  const result = await runScheduledYocoV2Reconciliation(
    env,
    "ws_1",
    "integration_1",
    new Date("2026-07-15T02:00:00.000Z"),
  );

  assert.equal(result, null);
  // The critical assertion: not a single row written. The old code created reconciliation state, a
  // RUNNING run row and a FAILED update on every tick for workspaces like this.
  assert.equal(
    (db.database.prepare(`SELECT COUNT(*) AS n FROM yoco_v2_reconciliation_state`).get() as any).n,
    0,
  );
  assert.equal(
    (db.database.prepare(`SELECT COUNT(*) AS n FROM yoco_v2_reconciliation_runs`).get() as any).n,
    0,
  );
});

test("scheduled reconciliation stays skipped while a connection is present but not activated", async () => {
  const data = fixture("single-line-partial-refund");
  const db = createDb();
  seedCore(db);
  const encrypted = await encryptTextWithSecret("secret", "sk_live_never_log");
  // Connected credentials, but Go Live never flipped connection_active.
  db.database
    .prepare(
      `INSERT INTO yoco_connections (workspace_id, status, api_key_encrypted, connection_active) VALUES (?, 'connected', ?, 0)`,
    )
    .run("ws_1", encrypted);
  const env = envFor(db, fixtureGate(data, { listOrders: [], listRefunds: [] }));

  assert.equal(
    await runScheduledYocoV2Reconciliation(env, "ws_1", "integration_1", new Date("2026-07-15T02:00:00.000Z")),
    null,
  );
  assert.equal(
    (db.database.prepare(`SELECT COUNT(*) AS n FROM yoco_v2_reconciliation_runs`).get() as any).n,
    0,
  );
});

test("a failing scheduled run records the attempt and backs off instead of re-running every tick", async () => {
  const data = fixture("single-line-partial-refund");
  const db = createDb();
  seedCore(db);
  await configureApiKey(db);
  const rateLimited = gateResponse({ message: "limited" }, 429, "RATE_LIMITED");
  const failingEnv = envFor(db, fixtureGate(data, { failLists: rateLimited }));

  // 02:00 — first tick fails.
  await assert.rejects(
    runScheduledYocoV2Reconciliation(failingEnv, "ws_1", "integration_1", new Date("2026-07-15T02:00:00.000Z")),
  );
  const afterFirst = db.database
    .prepare(`SELECT last_daily_run_at, consecutive_failures, next_retry_at FROM yoco_v2_reconciliation_state`)
    .get() as any;
  // The attempt is stamped even though the run threw — this is what breaks the loop.
  assert.ok(afterFirst.last_daily_run_at, "expected the failed attempt to stamp last_daily_run_at");
  assert.equal(Number(afterFirst.consecutive_failures), 1);
  assert.ok(afterFirst.next_retry_at, "expected a backoff deadline to be recorded");
  const runsAfterFirst = (
    db.database.prepare(`SELECT COUNT(*) AS n FROM yoco_v2_reconciliation_runs`).get() as any
  ).n;
  assert.equal(runsAfterFirst, 1);

  // 02:15 — the very next cron tick. Previously this re-ran the whole deep scan.
  assert.equal(
    await runScheduledYocoV2Reconciliation(failingEnv, "ws_1", "integration_1", new Date("2026-07-15T02:15:00.000Z")),
    null,
  );
  assert.equal(
    (db.database.prepare(`SELECT COUNT(*) AS n FROM yoco_v2_reconciliation_runs`).get() as any).n,
    runsAfterFirst,
    "a tick inside the backoff window must not start another run",
  );

  // Past the 15-minute backoff, it is allowed to try again — and a success clears the counters.
  const okEnv = envFor(db, fixtureGate(data, { listOrders: [], listRefunds: [] }));
  await runScheduledYocoV2Reconciliation(okEnv, "ws_1", "integration_1", new Date("2026-07-15T04:00:00.000Z"));
  const afterRecovery = db.database
    .prepare(`SELECT consecutive_failures, next_retry_at FROM yoco_v2_reconciliation_state`)
    .get() as any;
  assert.equal(Number(afterRecovery.consecutive_failures), 0);
  assert.equal(afterRecovery.next_retry_at, null);
});

test("a repeated finding updates one row instead of appending a new one per run", async () => {
  const db = createDb();
  seedCore(db);
  const insertFinding = (runIdValue: string, at: string) =>
    db.database
      .prepare(
        `INSERT INTO yoco_v2_reconciliation_findings
          (id, reconciliation_run_id, workspace_id, integration_id, source_entity_type,
           source_entity_id, finding_type, severity, status, details_json, repair_action,
           repaired_at, created_at, last_seen_at, last_run_id, occurrence_count)
         VALUES (?1, ?2, 'ws_1', 'integration_1', 'ORDER', 'order_1', 'UNRESOLVED_MAPPING',
                 'MEDIUM', 'OPEN', '{}', NULL, NULL, ?3, ?3, ?2, 1)
         ON CONFLICT(workspace_id, integration_id, finding_type, source_entity_type, source_entity_id)
         DO UPDATE SET last_seen_at = excluded.last_seen_at,
                       last_run_id = excluded.last_run_id,
                       occurrence_count = yoco_v2_reconciliation_findings.occurrence_count + 1`,
      )
      .run(`finding_${runIdValue}`, runIdValue, at);

  insertFinding("run_1", "2026-07-15T02:00:00.000Z");
  insertFinding("run_2", "2026-07-15T02:15:00.000Z");
  insertFinding("run_3", "2026-07-15T02:30:00.000Z");

  const rows = db.database
    .prepare(`SELECT occurrence_count, last_run_id, last_seen_at FROM yoco_v2_reconciliation_findings`)
    .all() as any[];
  assert.equal(rows.length, 1, "three sightings of one issue must not create three rows");
  assert.equal(Number(rows[0].occurrence_count), 3);
  assert.equal(rows[0].last_run_id, "run_3");
  assert.equal(rows[0].last_seen_at, "2026-07-15T02:30:00.000Z");
});
