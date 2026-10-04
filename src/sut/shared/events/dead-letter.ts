import type { ChannelModel } from 'amqplib';

/** Confirm each replay before acknowledging its original dead-letter delivery. */
export async function replayDeadLetters(connection: ChannelModel, queue: string, limit: number): Promise<number> {
  if (!/^[a-z][a-z0-9.-]{0,150}$/.test(queue) || queue.endsWith('.dead') || queue.endsWith('.retry') ||
      !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid queue or replay limit (1–1000)');
  const channel = await connection.createConfirmChannel();
  try {
    await channel.checkQueue(queue);
    await channel.checkQueue(`${queue}.dead`);
    let replayed = 0;
    while (replayed < limit) {
      const message = await channel.get(`${queue}.dead`, { noAck: false });
      if (!message) break;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Replay confirmation timed out')), 5000);
        channel.sendToQueue(queue, message.content, {
          ...message.properties, persistent: true,
          headers: { ...message.properties.headers, 'x-retry-count': 0 },
        }, (error: unknown) => {
          clearTimeout(timeout);
          if (error) reject(error); else resolve();
        });
      });
      channel.ack(message);
      replayed++;
    }
    return replayed;
  } finally {
    // Failure leaves the original unacknowledged; closing requeues it.
    await channel.close().catch(() => undefined);
  }
}
