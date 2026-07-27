import type { YocoV2QueueDispatchResult, YocoV2QueueMessage } from './contracts';

export type YocoV2QueueDispatcher = (message: YocoV2QueueMessage) => Promise<YocoV2QueueDispatchResult>;

export async function consumeYocoV2QueueBatch(
  batch: MessageBatch<YocoV2QueueMessage>,
  dispatch: YocoV2QueueDispatcher
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    try {
      const result = await dispatch(message.body);
      if (result.action === 'retry') {
        message.retry({ delaySeconds: Math.max(1, Number(result.delaySeconds || 1)) });
        return;
      }
      message.ack();
    } catch {
      message.retry();
    }
  }));
}
