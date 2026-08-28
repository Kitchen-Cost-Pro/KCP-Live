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

// Temporary diagnostic (2026-08-28): find every unbounded/unindexed query burning through the
// free-tier rows-read quota, not just the one already found in reconciliation.ts. This is the one
// choke point every tenant DO query passes through (FacadeStatement.first/all/run/batch below), so
// logging here catches ANY query anywhere in the app, not just a specific suspected code path.
// Remove once the account's rows-read usage is understood and back to a stable baseline.
//
// Lowered from 10,000: a 10k-per-query threshold missed requests that were expensive in
// aggregate — e.g. a Reporting page load firing several individual queries in the low thousands
// each, none crossing the old bar alone, but summing to 30k+ across one request. 2,000 trades
// more log noise for catching that pattern too.
const HEAVY_READ_LOG_THRESHOLD = 2_000;

function logIfHeavyRead(query: string, cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): void {
  const rowsRead = Number(cursor.rowsRead || 0);
  if (rowsRead < HEAVY_READ_LOG_THRESHOLD) return;
  console.warn(`[heavy-read] rows_read=${rowsRead} sql=${query.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
}

export class FacadeStatement {
  constructor(
    private readonly sql: SqlStorage,
    readonly query: string,
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
    const cursor = this.execCursor();
    const rows = cursor.toArray();
    logIfHeavyRead(this.query, cursor);
    if (!rows.length) return null;
    const row = rows[0] as Record<string, unknown>;
    return (column === undefined ? row : (row[column] ?? null)) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<FacadeResult<T>> {
    const cursor = this.execCursor();
    const results = cursor.toArray() as T[];
    logIfHeavyRead(this.query, cursor);
    return { results, success: true, meta: metaFrom(cursor) };
  }

  async run<T = Record<string, unknown>>(): Promise<FacadeResult<T>> {
    const cursor = this.execCursor();
    cursor.toArray(); // drain to force execution + populate rowsWritten
    logIfHeavyRead(this.query, cursor);
    return { results: [] as T[], success: true, meta: metaFrom(cursor) };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const cursor = this.execCursor();
    const rows = [...cursor.raw()] as T[];
    logIfHeavyRead(this.query, cursor);
    return rows;
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
        logIfHeavyRead(st.query, cursor);
        out.push({ results: [] as T[], success: true, meta: metaFrom(cursor) });
      }
      return out;
    });
  }

  /** Run a multi-statement SQL script (migration runner). */
  execScript(script: string): void {
    for (const raw of splitSqlStatements(script)) {
      const statement = raw.trim();
      if (!statement) continue;
      try {
        this.sql.exec(statement);
      } catch (cause) {
        // Durable Object migrations may be interrupted after one statement in a multi-statement
        // migration has already committed. On the next request SQLite then reports a duplicate
        // column for the statement that did succeed, which previously prevented that workspace
        // from ever completing the remaining migration statements. Treat only this known,
        // idempotent ALTER TABLE ADD COLUMN case as already applied; every other SQL error remains
        // fatal so genuine schema problems are never hidden.
        if (isRetryableAddColumnError(statement, cause)) continue;
        throw cause;
      }
    }
  }
}

/**
 * True when `cause` is the specific, safe-to-ignore SQLite error a retried `ALTER TABLE ... ADD
 * COLUMN` throws after that exact statement already committed on a prior, interrupted attempt.
 * Exported (rather than kept private to execScript) so tests can exercise the real classification
 * logic against real migration text instead of re-implementing — and risk drifting from — it.
 *
 * splitSqlStatements() deliberately keeps a leading line or block comment glued to the statement
 * that follows it (there is no statement-terminating semicolon inside a comment), so a documented
 * migration like `-- Stop the write storm...\nALTER TABLE ...` must have its leading comment
 * stripped before checking that the statement starts with ALTER — otherwise a real interrupted
 * migration with an explanatory header comment would fail this check and turn a routine, expected
 * retry into a fatal error.
 */
export function isRetryableAddColumnError(statement: string, cause: unknown): boolean {
  const withoutLeadingComments = statement.replace(/^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/))+/, '').trimStart();
  const isAddColumn = /^ALTER\s+TABLE\s+[^\s]+\s+ADD\s+COLUMN\s+/i.test(withoutLeadingComments);
  const message = String((cause as Error)?.message || cause || '');
  const isDuplicateColumn = /duplicate column name|already exists/i.test(message);
  return isAddColumn && isDuplicateColumn;
}

/**
 * Split a SQL script into complete statements.
 *
 * Durable Object SQLite accepts one statement per `sql.exec()` call. A plain semicolon splitter is
 * not sufficient because SQLite trigger bodies contain statement terminators between `BEGIN` and
 * the trigger's closing `END;`. Keep the complete trigger definition together while still ignoring
 * semicolons inside quoted values and SQL comments.
 */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let token = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inBracket = false;
  let inLineComment = false;
  let inBlockComment = false;
  let isTrigger = false;
  let triggerBodyStarted = false;
  let triggerBodyEnded = false;
  let caseDepth = 0;
  const leadingTokens: string[] = [];

  const resetStatementState = () => {
    token = '';
    isTrigger = false;
    triggerBodyStarted = false;
    triggerBodyEnded = false;
    caseDepth = 0;
    leadingTokens.length = 0;
  };

  const flushToken = () => {
    if (!token) return;
    const upper = token.toUpperCase();
    token = '';

    if (!triggerBodyStarted && leadingTokens.length < 4) {
      leadingTokens.push(upper);
      const normalized = leadingTokens.filter((value) => value !== 'TEMP' && value !== 'TEMPORARY');
      isTrigger = normalized[0] === 'CREATE' && normalized[1] === 'TRIGGER';
    }

    if (!isTrigger) return;
    if (!triggerBodyStarted && upper === 'BEGIN') {
      triggerBodyStarted = true;
      return;
    }
    if (!triggerBodyStarted || triggerBodyEnded) return;
    if (upper === 'CASE') {
      caseDepth += 1;
      return;
    }
    if (upper === 'END') {
      if (caseDepth > 0) caseDepth -= 1;
      else triggerBodyEnded = true;
    }
  };

  const finishStatement = () => {
    const statement = current.trim();
    if (statement) statements.push(statement);
    current = '';
    resetStatementState();
  };

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    const next = script[i + 1] || '';
    current += ch;

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"' && next === '"') {
        current += next;
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inBacktick) {
      if (ch === '`' && next === '`') {
        current += next;
        i += 1;
      } else if (ch === '`') {
        inBacktick = false;
      }
      continue;
    }
    if (inBracket) {
      if (ch === ']') inBracket = false;
      continue;
    }

    if (ch === '-' && next === '-') {
      flushToken();
      current += next;
      i += 1;
      inLineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      flushToken();
      current += next;
      i += 1;
      inBlockComment = true;
      continue;
    }
    if (ch === "'") {
      flushToken();
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      flushToken();
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      flushToken();
      inBacktick = true;
      continue;
    }
    if (ch === '[') {
      flushToken();
      inBracket = true;
      continue;
    }

    if (/[A-Za-z0-9_]/.test(ch)) {
      token += ch;
      continue;
    }

    flushToken();
    if (ch === ';' && (!isTrigger || (triggerBodyStarted && triggerBodyEnded))) {
      finishStatement();
    }
  }

  flushToken();
  finishStatement();
  return statements;
}
