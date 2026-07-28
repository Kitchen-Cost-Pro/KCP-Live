import type { YocoV2QueueDispatchResult, YocoV2QueueMessage } from './contracts';
import { structuredYocoV2Log } from './observability';

export type YocoV2QueueDispatcher = (message: YocoV2QueueMessage) => Promise<YocoV2QueueDispatchResult>;

function logMessage(
  message: YocoV2QueueMessage,
  input: {
    status: string;
    operation: string;
    detail: string;
    errorCategory?: string;
  }
): void {
  structuredYocoV2Log({
    trace_id: String(message.trace_id || 'yoco-v2-trace-missing'),
    raw_event_id: String(message.raw_event_id || ''),
    workspace_id: String(message.workspace_id || ''),
    integration_id: String(message.integration_id || ''),
    event_type: String(message.event_type || ''),
    status: input.status,
    error_category: input.errorCategory,
    operation: input.operation,
    message: input.detail
  });
}

/**
 * Start canonical processing from the workspace Durable Object as soon as the
 * verified webhook has been stored. The Cloudflare Queue remains the durable
 * retry lane. Both paths are safe to run because the processor acquires the
 * same atomic event lock before applying reporting or stock effects.
 */
export function scheduleImmediateYocoV2Processing(
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  message: YocoV2QueueMessage,
  dispatch: YocoV2QueueDispatcher
): boolean {
  if (!waitUntil) return false;

  waitUntil((async () => {
    logMessage(message, {
      status: 'started',
      operation: 'yoco.v2.immediate.start',
      detail: 'Verified webhook entered the immediate background processing lane.'
    });
    try {
      const result = await dispatch(message);
      logMessage(message, {
        status: String(result.status || (result.ok ? 'completed' : 'waiting')).toLowerCase(),
        operation: 'yoco.v2.immediate.complete',
        detail: result.action === 'retry'
          ? `Immediate processing requested a durable queue retry${result.error ? `: ${result.error}` : '.'}`
          : 'Immediate background processing finished; the durable queue remains idempotent fallback.'
      });
    } catch (cause) {
      logMessage(message, {
        status: 'failed',
        operation: 'yoco.v2.immediate.failed',
        errorCategory: 'INTERNAL_ERROR',
        detail: `Immediate background processing failed; the durable queue retains the event: ${cause instanceof Error ? cause.message : String(cause)}`
      });
    }
  })());
  return true;
}

export async function consumeYocoV2QueueBatch(
  batch: MessageBatch<YocoV2QueueMessage>,
  dispatch: YocoV2QueueDispatcher
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    logMessage(message.body, {
      status: 'received',
      operation: 'yoco.v2.queue.receive',
      detail: 'Cloudflare Queue consumer received the captured Yoco event.'
    });
    try {
      const result = await dispatch(message.body);
      if (result.action === 'retry') {
        logMessage(message.body, {
          status: String(result.status || 'retry_scheduled').toLowerCase(),
          operation: 'yoco.v2.queue.retry.requested',
          detail: result.error || 'Queue processor requested a retry.'
        });
        message.retry({ delaySeconds: Math.max(1, Number(result.delaySeconds || 1)) });
        return;
      }
      logMessage(message.body, {
        status: String(result.status || (result.ok ? 'completed' : 'acknowledged')).toLowerCase(),
        operation: 'yoco.v2.queue.ack',
        detail: result.error || 'Queue event was acknowledged after idempotent processing.'
      });
      message.ack();
    } catch (cause) {
      logMessage(message.body, {
        status: 'failed',
        operation: 'yoco.v2.queue.dispatch.failed',
        errorCategory: 'INTERNAL_ERROR',
        detail: `Queue dispatch failed and will be retried: ${cause instanceof Error ? cause.message : String(cause)}`
      });
      message.retry();
    }
  }));
}
