/**
 * Account-wide daily write-budget gate for inbound Yoco webhook processing. Cloudflare's Workers
 * Free plan caps D1+Durable Object writes at 100,000/day, account-wide, shared across every
 * Durable Object — a deliberate cost decision, not a temporary constraint (see the KCP free-tier
 * memory). Nothing else in this codebase tracks that budget before deciding whether to write;
 * this is the first such mechanism.
 *
 * A single Durable Object instance gives single-threaded serialization for a shared counter for
 * free — the same property `YocoV2RateGateDO` relies on for its outbound circuit breaker. D1/KV
 * can't do atomic increment-and-compare across concurrent isolates without locking that itself
 * burns writes, which is exactly the race this gate exists to prevent.
 */

export interface WriteBudgetStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface StoredBudgetState {
  dateKey: string;
  used: number;
}

export interface WriteBudgetReserveInput {
  estimatedWrites: number;
  dailyCap: number;
  softWarnRatio: number;
}

export interface WriteBudgetReserveResult {
  allowed: boolean;
  used: number;
  remaining: number;
  dailyCap: number;
  softWarn: boolean;
  dateKey: string;
}

function utcDateKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

export class YocoV2WriteBudgetCoordinator {
  constructor(private readonly storage: WriteBudgetStorage) {}

  async getState(nowMs = Date.now()): Promise<StoredBudgetState> {
    const stored = await this.storage.get<StoredBudgetState>('budget');
    const dateKey = utcDateKey(nowMs);
    if (!stored || stored.dateKey !== dateKey) {
      return { dateKey, used: 0 };
    }
    return stored;
  }

  /**
   * Reserve `estimatedWrites` against today's budget. This is an approximation, not a hard
   * ledger — the reservation itself is atomic (single-threaded DO), but the actual downstream
   * D1/DO writes it accounts for are not transactionally tied to it. That's an accepted
   * trade-off: good enough for a soft fail-safe, not a precise accounting system.
   */
  async reserve(input: WriteBudgetReserveInput, nowMs = Date.now()): Promise<WriteBudgetReserveResult> {
    const dailyCap = Math.max(1, Math.floor(input.dailyCap));
    const softWarnRatio = Math.min(1, Math.max(0, input.softWarnRatio));
    const current = await this.getState(nowMs);
    const wouldUse = current.used + Math.max(0, Math.floor(input.estimatedWrites));
    const allowed = wouldUse <= dailyCap;

    if (allowed) {
      await this.storage.put<StoredBudgetState>('budget', { dateKey: current.dateKey, used: wouldUse });
    }

    const used = allowed ? wouldUse : current.used;
    return {
      allowed,
      used,
      remaining: Math.max(0, dailyCap - used),
      dailyCap,
      softWarn: used >= dailyCap * softWarnRatio,
      dateKey: current.dateKey
    };
  }
}
