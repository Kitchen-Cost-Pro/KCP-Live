/**
 * D1-compatible facade over a Durable Object's SQLite storage (`ctx.storage.sql`).
 *
 * Goal: let the existing worker code — written against D1 as
 *   `env.DB.prepare(sql).bind(...args).first()/.all()/.run()` and `env.DB.batch([...])`
 * — run UNCHANGED inside a WorkspaceDO where `env.DB` is a `FacadeDatabase`.
 *
 * Parity notes:
 * - DO `sql.exec(query, ...bindings)` is SYNCHRONOUS and returns a cursor; D1 is async. These
 *   methods return Promises so `await env.DB.prepare(...).first()` keeps working.
 * - SQLite binds `?N` numbered params by index, matching D1's `.bind(a,b,c)` → ?1,?2,?3 (incl.
 *   repeated params like `?4`). Passing `...params` in bind order is correct.
 * - `batch()` runs in `storage.transactionSync` for atomicity (D1 batch is atomic).
 */

export interface FacadeMeta {
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  duration: number;
}

export interface FacadeResult<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: FacadeMeta;
}

function metaFrom(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): FacadeMeta {
  return {
    changes: Number(cursor.rowsWritten || 0),
    last_row_id: 0,
    rows_read: Number(cursor.rowsRead || 0),
    rows_written: Number(cursor.rowsWritten || 0),
    duration: 0
  };
}

export class FacadeStatement {
  constructor(
    private readonly sql: SqlStorage,
    private readonly query: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): FacadeStatement {
    return new FacadeStatement(this.sql, this.query, params);
  }

  /** Internal: execute synchronously and return the cursor. Used by first/all/run/batch. */
  execCursor(): SqlStorageCursor<Record<string, SqlStorageValue>> {
    // Coerce JS values DO SQLite can't bind into the forms D1 accepts:
    //  - `undefined` -> null
    //  - booleans -> 1/0 (D1 does this; DO SQLite rejects raw booleans, silently stringifying to
    //    "true"/"false" which then breaks numeric predicates like `COALESCE(is_stocked,1)=1`).
    const safe = this.params.map((p) => {
      if (p === undefined) return null;
      if (typeof p === 'boolean') return p ? 1 : 0;
      return p;
    }) as SqlStorageValue[];
    return this.sql.exec(this.query, ...safe);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const rows = this.execCursor().toArray();
    if (!rows.length) return null;
    const row = rows[0] as Record<string, unknown>;
    return (column === undefined ? row : (row[column] ?? null)) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<FacadeResult<T>> {
    const cursor = this.execCursor();
    const results = cursor.toArray() as T[];
    return { results, success: true, meta: metaFrom(cursor) };
  }

  async run<T = Record<string, unknown>>(): Promise<FacadeResult<T>> {
    const cursor = this.execCursor();
    cursor.toArray(); // drain to force execution + populate rowsWritten
    return { results: [] as T[], success: true, meta: metaFrom(cursor) };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return [...this.execCursor().raw()] as T[];
  }
}

export class FacadeDatabase {
  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: DurableObjectStorage
  ) {}

  prepare(query: string): FacadeStatement {
    return new FacadeStatement(this.sql, query);
  }

  async batch<T = Record<string, unknown>>(statements: FacadeStatement[]): Promise<FacadeResult<T>[]> {
    // D1 batch is atomic; run all statements inside one synchronous transaction.
    return this.storage.transactionSync<FacadeResult<T>[]>(() => {
      const out: FacadeResult<T>[] = [];
      for (const st of statements) {
        const cursor = st.execCursor();
        cursor.toArray();
        out.push({ results: [] as T[], success: true, meta: metaFrom(cursor) });
      }
      return out;
    });
  }

  /** Run a multi-statement SQL script (migration runner). */
  execScript(script: string): void {
    for (const raw of splitSqlStatements(script)) {
      const statement = raw.trim();
      if (statement) this.sql.exec(statement);
    }
  }
}

/** Split a SQL file into statements on `;`, ignoring `;` inside string literals. */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === ';' && !inSingle && !inDouble) {
      statements.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}
