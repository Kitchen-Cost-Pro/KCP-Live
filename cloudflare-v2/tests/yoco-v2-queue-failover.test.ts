import assert from 'node:assert/strict';
import test from 'node:test';

import type { YocoV2QueueMessage } from '../src/modules/yoco-engine-v2/contracts';
import {
  consumeYocoV2QueueBatch,
  scheduleImmediateYocoV2Processing
} from '../src/modules/yoco-engine-v2/queue-consumer';

function queueMessage(id: string): YocoV2QueueMessage {
  return {
    raw_event_id: id,
    workspace_id: 'ws_1',
    integration_id: 'yoco:ws_1',
    event_type: 'order.completed',
    trace_id: `trace_${id}`,
    live_effects: true
  };
}

test('verified webhook immediate lane runs through waitUntil', async () => {
  const pending: Promise<unknown>[] = [];
  const dispatched: YocoV2QueueMessage[] = [];
  const message = queueMessage('raw_live_1');

  const scheduled = scheduleImmediateYocoV2Processing(
    (promise) => pending.push(promise),
    message,
    async (queued) => {
      dispatched.push(queued);
      return { ok: true, action: 'ack', status: 'COMPLETED' };
    }
  );

  assert.equal(scheduled, true);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.deepEqual(dispatched, [message]);
});

test('immediate lane is optional outside a Durable Object waitUntil context', () => {
  const scheduled = scheduleImmediateYocoV2Processing(
    undefined,
    queueMessage('raw_live_2'),
    async () => ({ ok: true, action: 'ack' })
  );
  assert.equal(scheduled, false);
});

test('queue consumer retries thrown dispatch failures instead of silently swallowing them', async () => {
  const states: string[] = [];
  const message = queueMessage('raw_live_3');
  await consumeYocoV2QueueBatch({
    messages: [{
      body: message,
      ack: () => states.push('ack'),
      retry: () => states.push('retry')
    }]
  } as MessageBatch<YocoV2QueueMessage>, async () => {
    throw new Error('simulated Durable Object dispatch failure');
  });
  assert.deepEqual(states, ['retry']);
});
