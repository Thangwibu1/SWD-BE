import amqplib from 'amqplib';
import type { Connection, Channel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Logger } from '../../../utils/logger.js';
import { currentRequestId } from '../observability/request-context.js';

export interface EventEnvelope<T = any> {
  eventId: string;
  eventType: string;
  occurredAt: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  schemaVersion: number;
  payload: T;
}

export class RabbitMQClient {
  private conn: any | null = null;
  private pubChannel: ConfirmChannel | null = null;
  private subChannel: Channel | null = null;

  constructor(private url: string, private logger: Logger) {}

  async connect(): Promise<void> {
    this.logger.info({ url: this.url }, 'Connecting to RabbitMQ');
    this.conn = await amqplib.connect(this.url);
    
    this.conn.on('error', (err: any) => {
      this.logger.error({ err }, 'RabbitMQ connection error');
    });

    this.conn.on('close', () => {
      this.logger.info('RabbitMQ connection closed');
    });

    // Create publisher channel with publisher confirms
    this.pubChannel = await this.conn.createConfirmChannel();
    // Create subscriber channel
    this.subChannel = await this.conn.createChannel();
    
    // Ensure exchanges exist
    await this.pubChannel!.assertExchange('ecommerce.events', 'topic', { durable: true });
    
    this.logger.info('RabbitMQ connected and channels created');
  }

  async publish<T>(routingKey: string, event: EventEnvelope<T>): Promise<void> {
    if (!this.pubChannel) throw new Error('Publisher channel not initialized');

    // Inherit or keep correlation ID
    if (!event.correlationId) {
      event.correlationId = currentRequestId() ?? 'unknown';
    }

    const content = Buffer.from(JSON.stringify(event));

    return new Promise((resolve, reject) => {
      this.pubChannel!.publish(
        'ecommerce.events',
        routingKey,
        content,
        {
          persistent: true,
          messageId: event.eventId,
          timestamp: new Date(event.occurredAt).getTime(),
          correlationId: event.correlationId,
        },
        (err: any) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  }

  async subscribe(
    queueName: string,
    routingKeys: string[],
    handler: (event: EventEnvelope, msg: ConsumeMessage) => Promise<void>
  ): Promise<void> {
    if (!this.subChannel) throw new Error('Subscriber channel not initialized');

    await this.subChannel.assertQueue(queueName, { durable: true });
    this.subChannel.prefetch(10); // Process up to 10 messages concurrently

    for (const routingKey of routingKeys) {
      await this.subChannel.bindQueue(queueName, 'ecommerce.events', routingKey);
    }

    await this.subChannel.consume(
      queueName,
      async (msg) => {
        if (!msg) return;

        try {
          const event: EventEnvelope = JSON.parse(msg.content.toString());
          await handler(event, msg);
          this.subChannel!.ack(msg);
        } catch (err) {
          this.logger.error({ err, msgId: msg.properties.messageId }, 'Event processing failed');
          // Basic nack, requeue = false for dead-lettering if configured, but for now we can just requeue = true or false.
          // The guide says "chịu được redelivery", so let's requeue on error. Or maybe not forever.
          // For simplicity in benchmark, we will not requeue forever to avoid poison pill loops.
          // Actually, if it's a transient DB error we should requeue. Let's just requeue.
          this.subChannel!.nack(msg, false, true); // (allUpTo, requeue)
        }
      },
      { noAck: false } // manual acknowledgement
    );
  }

  async close(): Promise<void> {
    if (this.pubChannel) await this.pubChannel.close();
    if (this.subChannel) await this.subChannel.close();
    if (this.conn) await this.conn.close();
  }
}
