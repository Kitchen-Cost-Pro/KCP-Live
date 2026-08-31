import type { Env } from "./types";

export type TransactionEntityType =
  "grv" | "credit_note" | "manufacturing_batch" | "transfer" | "stock_take" | "adjustment";

const ENTITY_PREFIX: Record<TransactionEntityType, string> = {
  grv: "GRV",
  credit_note: "CN",
  manufacturing_batch: "MFG",
  transfer: "TRF",
  stock_take: "STK",
  adjustment: "ADJ",
};

let schemaReady: Promise<void> | null = null;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeDate(
  value: unknown,
  { fallbackToNow = true }: { fallbackToNow?: boolean } = {},
): Date | null {
  const raw = clean(value);
  const parsed = raw ? new Date(raw) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  return fallbackToNow ? new Date() : null;
}

export function transactionDateKey(
  value: unknown,
  timeZone = "Africa/Johannesburg",
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(normalizeDate(value) || new Date());
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value || "00";
  return `${part("year")}${part("month")}${part("day")}`;
}

export function transactionPrefix(entityType: TransactionEntityType): string {
  return ENTITY_PREFIX[entityType];
}

export function formatTransactionReference(
  entityType: TransactionEntityType,
  dateKey: string,
  sequence: number,
): string {
  return `${transactionPrefix(entityType)}-${clean(dateKey)}-${Math.max(0, Math.trunc(sequence)).toString().padStart(4, "0")}`;
}

function shortStableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(6, "0").slice(-6);
}

export function historicalTransactionReference(
  entityType: TransactionEntityType,
  entityId: unknown,
  occurredAt: unknown,
): string {
  const id = clean(entityId) || "unknown";
  const parsed = normalizeDate(occurredAt, { fallbackToNow: false });
  const dateKey = parsed ? transactionDateKey(parsed) : "000000";
  return `${transactionPrefix(entityType)}-${dateKey}-H${shortStableHash(`${entityType}:${id}`)}`;
}

export function isTransactionReference(
  value: unknown,
  entityType?: TransactionEntityType,
): boolean {
  const prefix = entityType
    ? transactionPrefix(entityType)
    : "(?:GRV|CN|MFG|TRF|STK)";
  return new RegExp(`^${prefix}-\\d{6}-(?:\\d{4,}|H[A-Z0-9]{6})$`, "i").test(
    clean(value),
  );
}

async function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.CENTRAL_DB.batch([
        env.CENTRAL_DB
          .prepare(`CREATE TABLE IF NOT EXISTS transaction_reference_sequences (
          entity_type TEXT NOT NULL,
          date_key TEXT NOT NULL,
          last_sequence INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (entity_type, date_key)
        )`),
        env.CENTRAL_DB
          .prepare(`CREATE TABLE IF NOT EXISTS transaction_references (
          reference TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          prefix TEXT NOT NULL,
          date_key TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (entity_type, date_key, sequence)
        )`),
        env.CENTRAL_DB
          .prepare(`CREATE TABLE IF NOT EXISTS transaction_reference_links (
          workspace_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          reference TEXT NOT NULL REFERENCES transaction_references(reference) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (workspace_id, entity_type, entity_id),
          UNIQUE (workspace_id, entity_type, reference)
        )`),
        env.CENTRAL_DB
          .prepare(`CREATE INDEX IF NOT EXISTS idx_transaction_reference_links_reference
          ON transaction_reference_links(reference)`),
      ]);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function getTransactionReference(
  env: Env,
  workspaceId: string,
  entityType: TransactionEntityType,
  entityId: string,
): Promise<string> {
  if (!clean(workspaceId) || !clean(entityId)) return "";
  await ensureSchema(env);
  const row = await env.CENTRAL_DB.prepare(
    `SELECT reference
       FROM transaction_reference_links
      WHERE workspace_id = ?1
        AND entity_type = ?2
        AND entity_id = ?3
      LIMIT 1`,
  )
    .bind(workspaceId, entityType, entityId)
    .first<{ reference: string }>();
  return clean(row?.reference);
}

export async function ensureTransactionReference(
  env: Env,
  workspaceId: string,
  entityType: TransactionEntityType,
  entityId: string,
  occurredAt: unknown,
  preferredReference = "",
): Promise<string> {
  const safeWorkspaceId = clean(workspaceId);
  const safeEntityId = clean(entityId);
  if (!safeWorkspaceId || !safeEntityId)
    throw new Error(
      "Transaction reference requires a workspace and entity id.",
    );
  await ensureSchema(env);

  const existing = await getTransactionReference(
    env,
    safeWorkspaceId,
    entityType,
    safeEntityId,
  );
  if (existing) return existing;

  const preferred = clean(preferredReference).toUpperCase();
  let reference = preferred;
  let dateKey = transactionDateKey(occurredAt);
  let sequence = 0;

  if (preferred) {
    if (
      !isTransactionReference(preferred, entityType) ||
      preferred.includes("-H")
    ) {
      throw new Error(`Invalid preferred ${entityType} transaction reference.`);
    }
    const match = preferred.match(/-(\d{6})-(\d+)$/);
    dateKey = match?.[1] || dateKey;
    sequence = Number(match?.[2] || 0);
    await env.CENTRAL_DB.prepare(
      `INSERT INTO transaction_references (reference, entity_type, prefix, date_key, sequence, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
       ON CONFLICT(reference) DO NOTHING`,
    )
      .bind(
        reference,
        entityType,
        transactionPrefix(entityType),
        dateKey,
        sequence,
      )
      .run();
  } else {
    const counter = await env.CENTRAL_DB.prepare(
      `INSERT INTO transaction_reference_sequences (entity_type, date_key, last_sequence, updated_at)
       VALUES (?1, ?2, 1, datetime('now'))
       ON CONFLICT(entity_type, date_key) DO UPDATE SET
         last_sequence = transaction_reference_sequences.last_sequence + 1,
         updated_at = excluded.updated_at
       RETURNING last_sequence`,
    )
      .bind(entityType, dateKey)
      .first<{ last_sequence: number }>();
    sequence = Number(counter?.last_sequence || 1);
    reference = formatTransactionReference(entityType, dateKey, sequence);
    await env.CENTRAL_DB.prepare(
      `INSERT INTO transaction_references (reference, entity_type, prefix, date_key, sequence, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
    )
      .bind(
        reference,
        entityType,
        transactionPrefix(entityType),
        dateKey,
        sequence,
      )
      .run();
  }

  await env.CENTRAL_DB.prepare(
    `INSERT INTO transaction_reference_links (workspace_id, entity_type, entity_id, reference, created_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'))
     ON CONFLICT(workspace_id, entity_type, entity_id) DO NOTHING`,
  )
    .bind(safeWorkspaceId, entityType, safeEntityId, reference)
    .run();

  const linked = await getTransactionReference(
    env,
    safeWorkspaceId,
    entityType,
    safeEntityId,
  );
  if (!linked)
    throw new Error(
      "Transaction reference could not be linked to the transaction.",
    );
  if (preferred && linked !== preferred)
    throw new Error(
      "Transaction already uses a different transaction reference.",
    );
  return linked;
}

export async function resolveTransactionReferences(
  env: Env,
  workspaceId: string,
  rows: Array<Record<string, unknown>>,
  entityType: TransactionEntityType,
  idKey = "id",
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.map((row) => clean(row[idKey])).filter(Boolean)),
  ];
  const result = new Map<string, string>();
  if (!ids.length) return result;
  await ensureSchema(env);
  const placeholders = ids.map((_, index) => `?${index + 3}`).join(", ");
  const found = await env.CENTRAL_DB.prepare(
    `SELECT entity_id, reference
       FROM transaction_reference_links
      WHERE workspace_id = ?1
        AND entity_type = ?2
        AND entity_id IN (${placeholders})`,
  )
    .bind(workspaceId, entityType, ...ids)
    .all<{ entity_id: string; reference: string }>();
  for (const row of found.results || [])
    result.set(clean(row.entity_id), clean(row.reference));
  return result;
}
