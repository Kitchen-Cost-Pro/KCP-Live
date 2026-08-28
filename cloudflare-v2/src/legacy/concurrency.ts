/**
 * Runs `tasks` with at most `limit` in flight at once, waiting for all to settle before
 * returning. Extracted from index.ts's cron `scheduled()` handler so it can be unit-tested
 * directly — that handler otherwise needs a full Cloudflare Env mock to exercise at all.
 *
 * Unbounded `Promise.all` across every active workspace (each firing several jobs, including a
 * potentially large report-schedule run) is the same "many expensive things at once exhaust a
 * shared account-wide quota" shape as the 2026-08-26 migration incident, just at account scale
 * instead of a single Durable Object. Bounding concurrency keeps total in-flight work roughly
 * constant regardless of how many workspaces exist.
 */
export async function runWithConcurrencyLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker));
}
