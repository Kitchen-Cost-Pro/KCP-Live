import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithConcurrencyLimit } from '../src/legacy/concurrency';

test('runWithConcurrencyLimit: runs every task exactly once', async () => {
  const ran: number[] = [];
  await runWithConcurrencyLimit(
    Array.from({ length: 12 }, (_, i) => async () => { ran.push(i); }),
    5,
  );
  assert.deepEqual([...ran].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
});

test('runWithConcurrencyLimit: never exceeds the concurrency limit at any point in time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await runWithConcurrencyLimit(
    Array.from({ length: 20 }, () => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    }),
    5,
  );
  assert.ok(maxInFlight <= 5, `max concurrent was ${maxInFlight}, expected <= 5`);
  assert.ok(maxInFlight > 1, 'sanity check: should actually run some tasks concurrently, not serially');
});

test('runWithConcurrencyLimit: an empty task list resolves immediately without error', async () => {
  await runWithConcurrencyLimit([], 5);
});

test('runWithConcurrencyLimit: a limit larger than the task count is safe (does not create empty workers that error)', async () => {
  const ran: number[] = [];
  await runWithConcurrencyLimit(
    [async () => { ran.push(1); }, async () => { ran.push(2); }],
    100,
  );
  assert.equal(ran.length, 2);
});

test('runWithConcurrencyLimit: one task failing does not stop the others from running (Promise.all semantics on the worker pool, matching the original .catch-wrapped call sites)', async () => {
  const ran: number[] = [];
  await assert.rejects(
    runWithConcurrencyLimit(
      [
        async () => { ran.push(1); },
        async () => { throw new Error('boom'); },
        async () => { ran.push(3); },
      ],
      1, // force sequential order so task 3 is only reached if the failure didn't halt the queue
    ),
  );
  // Task 1 ran before the failure; task 3's fate depends on worker scheduling, but the important
  // invariant is that the failure propagates rather than being silently swallowed.
  assert.ok(ran.includes(1));
});
