import * as amqp from 'amqplib';
import type { Logger } from 'pino';

/**
 * RabbitMQ Client for Event-Driven Microservices
 *
 * Provides:
 * - Connection pooling
 * - Publisher confirms
 * - Manual acknowledgement
 * - Graceful shutdown
 */

export interface RabbitMQConfig {
  url: string;
  exchange: string;
  exchangeType: 'topic' | 'direct' | 'fanout';
  prefetchCount?: number;
}

export interface DomainEvent {
  eventId: string;
  eventType: string;
  [key: string]: unknown;
}

export class RabbitMQClient {
  private connection: amqp.ChannelModel | null = null;
  private publishChannel: amqp.ConfirmChannel | null = null;
  private consumeChannel: amqp.Channel | null = null;

  constructor(
    private config: RabbitMQConfig,
    private logger: Logger
  ) {}

  async connect(): Promise<void> {
    this.logger.info({ url: this.config.url }, 'Connecting to RabbitMQ');

    this.connection = await amqp.connect(this.config.url);

    const conn = this.connection.connection as unknown as { on: (event: string, handler: (arg?: unknown) => void) => void };
    conn.on('error', (err?: unknown) => {
      this.logger.error(err as Error, 'RabbitMQ connection error');
    });

    conn.on('close', () => {
      this.logger.warn('RabbitMQ connection closed');
    });

    // Create publish channel with confirms
    this.publishChannel = await this.connection.createConfirmChannel();

    // Create consume channel
    this.consumeChannel = await this.connection.createChannel();
    await this.consumeChannel.prefetch(this.config.prefetchCount || 10);

    // Declare exchange
    await this.publishChannel.assertExchange(
      this.config.exchange,
      this.config.exchangeType,
      { durable: true }
    );

    this.logger.info('RabbitMQ connected');
  }

  async publish(
    routingKey: string,
    event: DomainEvent,
    options: { persistent?: boolean; correlationId?: string } = {}
  ): Promise<void> {
    if (!this.publishChannel) {
      throw new Error('RabbitMQ not connected');
    }

    const message = Buffer.from(JSON.stringify(event));

    const publishOptions: amqp.Options.Publish = {
      persistent: options.persistent !== false,
      contentType: 'application/json',
      timestamp: Date.now(),
    };

    if (options.correlationId) {
      publishOptions.correlationId = options.correlationId;
    }

    return new Promise((resolve, reject) => {
      this.publishChannel!.publish(
        this.config.exchange,
        routingKey,
        message,
        publishOptions,
        (err: Error | null, _ok: amqp.Replies.Empty) => {
          if (err) {
            this.logger.error({ err, routingKey }, 'Failed to publish event');
            reject(err);
          } else {
            this.logger.debug({ routingKey, eventId: event.eventId }, 'Event published');
            resolve();
          }
        }
      );
    });
  }

  async consume(
    queueName: string,
    routingKeys: string[],
    handler: (event: DomainEvent, msg: amqp.ConsumeMessage) => Promise<void>
  ): Promise<void> {
    if (!this.consumeChannel) {
      throw new Error('RabbitMQ not connected');
    }

    // Assert queue
    await this.consumeChannel.assertQueue(queueName, {
      durable: true,
    });

    // Bind to routing keys
    for (const routingKey of routingKeys) {
      await this.consumeChannel.bindQueue(queueName, this.config.exchange, routingKey);
    }

    // Start consuming with manual ack
    await this.consumeChannel.consume(
      queueName,
      async (msg) => {
        if (!msg) return;

        try {
          const event = JSON.parse(msg.content.toString());

          this.logger.debug(
            { eventId: event.eventId, eventType: event.eventType, redelivered: msg.fields.redelivered },
            'Processing event'
          );

          await handler(event, msg);

          // Ack after successful processing
          this.consumeChannel!.ack(msg);

          this.logger.debug({ eventId: event.eventId }, 'Event processed successfully');
        } catch (error) {
          this.logger.error(
            { error, msgId: msg.properties.messageId },
            'Failed to process event'
          );

          // Nack and requeue (or send to DLQ in production)
          this.consumeChannel!.nack(msg, false, true);
        }
      },
      { noAck: false }
    );

    this.logger.info({ queueName, routingKeys }, 'Started consuming events');
  }

  async close(): Promise<void> {
    this.logger.info('Closing RabbitMQ connection');

    if (this.publishChannel) {
      await this.publishChannel.close();
    }

    if (this.consumeChannel) {
      await this.consumeChannel.close();
    }

    if (this.connection) {
      await this.connection.close();
    }

    this.logger.info('RabbitMQ connection closed');
  }
}

/**
 * Simple connect function for tests
 */
export async function connectRabbitMQ(url: string, logger: Logger): Promise<amqp.ChannelModel> {
  logger.info({ url }, 'Connecting to RabbitMQ');
  const connection = await amqp.connect(url);
  logger.info('RabbitMQ connected');
  return connection;
}
