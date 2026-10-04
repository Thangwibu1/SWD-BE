import amqplib from 'amqplib';
import type { Channel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Logger } from '../../../utils/logger.js';
import { currentRequestId } from '../observability/request-context.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSutMetrics } from '../observability/metrics.js';
import type { Database } from '../database/db.js';
import { ensureReliabilitySchema } from '../database/reliability.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

const EVENT_SCHEMA_FILES: Record<string, string> = {
  'order.created': 'order-created.schema.json',
  'inventory.reserved': 'inventory-reserved.schema.json',
  'inventory.rejected': 'inventory-rejected.schema.json',
  'payment.completed': 'payment-completed.schema.json',
  'payment.failed': 'payment-failed.schema.json',
  'inventory.released': 'inventory-released.schema.json',
  'order.confirmed': 'order-confirmed.schema.json',
  'order.cancelled': 'order-cancelled.schema.json',
};
const eventAjv = new Ajv2020({ allErrors: true, strict: true });
(addFormatsModule as unknown as (ajv: Ajv2020) => void)(eventAjv);
const schemaDir = path.resolve('schemas/events');
const envelopeValidator = eventAjv.compile(JSON.parse(readFileSync(path.join(schemaDir, 'event-envelope.schema.json'), 'utf8')));
const payloadValidators = new Map(Object.entries(EVENT_SCHEMA_FILES).map(([eventType, filename]) => [
  eventType,
  eventAjv.compile(JSON.parse(readFileSync(path.join(schemaDir, filename), 'utf8'))),
]));

function validateEvent(event: EventEnvelope): void {
  const payloadValidator = payloadValidators.get(event.eventType);
  if (!envelopeValidator(event) || !payloadValidator || !payloadValidator(event.payload)) {
    const errors = [...(envelopeValidator.errors ?? []), ...(payloadValidator?.errors ?? [])];
    throw new Error(`Invalid ${event.eventType} event: ${eventAjv.errorsText(errors)}`);
  }
}

export class RabbitMQClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private conn: any | null = null;
  private pubChannel: ConfirmChannel | null = null;
  private subChannel: Channel | null = null;
  private relayTimer?: ReturnType<typeof setTimeout>;
  private relayTask?: Promise<void>;
  private closed = false;

  constructor(private url: string, private logger: Logger, private db: Database) {}

  async connect(): Promise<void> {
    await ensureReliabilitySchema(this.db);
    this.closed = false;
    this.logger.info('Connecting to RabbitMQ');
    for (let i = 0; i < 30; i++) {
      try {
        this.conn = await amqplib.connect(this.url);
        break;
      } catch (err) {
        this.logger.warn({ err }, 'RabbitMQ connect failed, retrying in 2s...');
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!this.conn) {
      this.conn = await amqplib.connect(this.url);
    }
    
    this.conn.on('error', (err: unknown) => {
      this.logger.error({ err }, 'RabbitMQ connection error');
    });

    this.conn.on('close', () => {
      this.logger.info('RabbitMQ connection closed');
      // Fail the role so its supervisor recreates channels and subscriptions.
      if (!this.closed) process.exit(1);
    });

    // Create publisher channel with publisher confirms
    this.pubChannel = await this.conn.createConfirmChannel();
    // Create subscriber channel
    this.subChannel = await this.conn.createChannel();
    
    // Ensure exchanges exist
    await this.pubChannel!.assertExchange('ecommerce.events', 'topic', { durable: true });
    // Bind all queues before starting the relay: events survive consumers
    // starting late, including immediately after a broker/process restart.
    const topology: Record<string, string[]> = {
      'inventory.order.created': ['order.created'],
      'payment.inventory.reserved': ['inventory.reserved'],
      'order.payment.completed': ['payment.completed'],
      'order.payment.failed': ['payment.failed'],
      'order.inventory.rejected': ['inventory.rejected'],
      'inventory.payment.failed': ['payment.failed'],
      'inventory.order.confirmed': ['order.confirmed'],
      'notification.order.confirmed': ['order.confirmed'],
      'notification.order.cancelled': ['order.cancelled'],
    };
    for (const [queue, keys] of Object.entries(topology)) await this.declareQueue(queue, keys);
    this.scheduleRelay();
    
    this.logger.info('RabbitMQ connected and channels created');
  }

  async publish<T>(routingKey: string, event: EventEnvelope<T>): Promise<void> {
    // Inherit or keep correlation ID
    if (!event.correlationId) {
      const requestId = currentRequestId();
      event.correlationId = requestId && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(requestId)
        ? requestId
        : randomUUID();
    }
    validateEvent(event);
    // Database.query participates in the active handler/business transaction.
    await this.db.query('outbox.enqueue', `INSERT INTO reliability.outbox(event_id, routing_key, envelope)
      VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING`, [event.eventId, routingKey, JSON.stringify(event)]);
  }

  private async send(routingKey: string, event: EventEnvelope): Promise<void> {
    if (!this.pubChannel) throw new Error('Publisher channel not initialized');
    const content = Buffer.from(JSON.stringify(event));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Publisher confirmation timed out')), 5000);
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
        (err: unknown) => {
          clearTimeout(timeout);
          if (err) return reject(err);
          getSutMetrics().eventsPublished.inc({ event_type: event.eventType });
          resolve();
        }
      );
    });
  }

  /** At-least-once relay. A crash after confirm can redeliver the same event ID. */
  async flushOutbox(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const pending = await tx.query<{ event_id: string; routing_key: string; envelope: EventEnvelope }>(
        'outbox.claim', `SELECT event_id, routing_key, envelope FROM reliability.outbox
        WHERE published_at IS NULL ORDER BY created_at, event_id LIMIT 20 FOR UPDATE SKIP LOCKED`);
      for (const row of pending.rows) {
        await this.send(row.routing_key, row.envelope);
        await tx.query('outbox.sent', 'UPDATE reliability.outbox SET published_at=now() WHERE event_id=$1', [row.event_id]);
      }
    });
  }

  private scheduleRelay(): void {
    if (this.closed) return;
    this.relayTimer = setTimeout(() => {
      this.relayTask = this.flushOutbox().catch((err: unknown) => {
        this.logger.warn({ err }, 'Outbox relay failed; retained for retry');
      }).finally(() => this.scheduleRelay());
    }, 100);
    this.relayTimer.unref();
  }

  private async declareQueue(queue: string, keys: string[]): Promise<void> {
    const channel = this.subChannel!;
    await channel.assertQueue(`${queue}.dead`, { durable: true });
    await channel.assertQueue(queue, { durable: true });
    await channel.assertQueue(`${queue}.retry`, { durable: true, arguments: {
      'x-message-ttl': 1000, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue,
    } });
    for (const key of keys) await channel.bindQueue(queue, 'ecommerce.events', key);
  }

  private async retry(queue: string, msg: ConsumeMessage, invalid: boolean): Promise<void> {
    const attempt = Number(msg.properties.headers?.['x-retry-count'] ?? 0);
    const destination = invalid || attempt >= 3 ? `${queue}.dead` : `${queue}.retry`;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Retry handoff confirmation timed out')), 5000);
      this.pubChannel!.sendToQueue(destination, msg.content, {
        ...msg.properties, persistent: true,
        headers: { ...msg.properties.headers, 'x-retry-count': attempt + 1 },
      }, (err: unknown) => { clearTimeout(timeout); if (err) reject(err); else resolve(); });
    });
    this.subChannel!.ack(msg);
  }

  async subscribe(
    queueName: string,
    routingKeys: string[],
    handler: (event: EventEnvelope, msg: ConsumeMessage) => Promise<void>
  ): Promise<void> {
    if (!this.subChannel) throw new Error('Subscriber channel not initialized');

    await this.declareQueue(queueName, routingKeys);
    this.subChannel.prefetch(10); // Process up to 10 messages concurrently

    await this.subChannel.consume(
      queueName,
      async (msg) => {
        if (!msg) return;

        let invalid = true;
        try {
          const event: EventEnvelope = JSON.parse(msg.content.toString());
          const started = process.hrtime.bigint();
          validateEvent(event);
          invalid = false;
          getSutMetrics().eventsConsumed.inc({ event_type: event.eventType });
          if (msg.fields.redelivered) getSutMetrics().eventRedeliveries.inc({ event_type: event.eventType });
          await this.db.transaction(async (tx) => {
            const claim = await tx.query('inbox.claim', `INSERT INTO reliability.inbox(consumer,event_id)
              VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id`, [queueName, event.eventId]);
            if (claim.rowCount) await handler(event, msg);
          });
          this.subChannel!.ack(msg);
          getSutMetrics().eventProcessingDuration.observe({ event_type: event.eventType }, Number(process.hrtime.bigint() - started) / 1e9);
        } catch (err) {
          this.logger.error({ err, msgId: msg.properties.messageId }, 'Event processing failed');
          try {
            await this.retry(queueName, msg, invalid);
          } catch (retryError) {
            this.logger.error({ err: retryError }, 'Retry handoff failed; retaining original delivery');
            // Closing the channel returns unacknowledged deliveries to the
            // broker. The process exits so a supervisor can reconnect.
            await this.subChannel?.close().catch(() => undefined);
            if (!this.closed) process.exit(1);
          }
        }
      },
      { noAck: false } // manual acknowledgement
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.relayTimer);
    await this.relayTask;
    if (this.pubChannel) await this.pubChannel.close();
    if (this.subChannel) await this.subChannel.close();
    if (this.conn) await this.conn.close();
  }
}
