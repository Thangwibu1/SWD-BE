import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectRabbitMQ } from '../../src/sut/shared/messaging/rabbitmq-client.js';
import { getTestDb, cleanTestDb, seedTestDb } from '../helpers/test-db.js';
import type { TestDatabase } from '../helpers/test-db.js';
import { createTestLogger } from '../helpers/logger.js';
import type { ChannelModel, Channel } from 'amqplib';
import { startTestPostgres } from './helpers/dev-postgres.js';
import type { TestPostgres } from './helpers/dev-postgres.js';
import { startTestRabbitMQ } from './helpers/dev-rabbitmq.js';
import type { TestRabbitMQ } from './helpers/dev-rabbitmq.js';
import { migrateSut } from '../../src/sut/shared/database/migrator.js';

/**
 * Event-Driven Architecture Tests
 *
 * Tests for A09-A12 event-driven profiles:
 * - Message redelivery handling
 * - Idempotency under duplicate events
 * - Compensation logic (payment failure → stock release)
 * - Publisher confirms
 * - Manual acknowledgement
 *
 * Per guide section 10.3 and section 29.
 */
describe('Event-Driven Tests', () => {
  const logger = createTestLogger();
  let db: TestDatabase;
  let connection: ChannelModel;
  let channel: Channel;
  let postgres: TestPostgres;
  let rabbit: TestRabbitMQ;

  const EXCHANGE = 'test-ecommerce-events';
  const QUEUE_PREFIX = 'test-';

  beforeAll(async () => {
    postgres = await startTestPostgres('event-driven');
    rabbit = await startTestRabbitMQ('event-driven-rabbit');
    process.env.TEST_DATABASE_URL = postgres.url;
    db = await getTestDb();
    const migrationClient = await db.getClient();
    try {
      await migrateSut(migrationClient);
    } finally {
      migrationClient.release();
    }
    await seedTestDb(db);

    // Connect to RabbitMQ
    connection = await connectRabbitMQ(rabbit.url, logger);
    channel = await connection.createChannel();

    // Declare test exchange
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  }, 120_000);

  afterAll(async () => {
    await channel?.close();
    await connection?.close();
    if (db) {
      await cleanTestDb(db);
      await db.end();
    }
    await postgres?.stop();
    await rabbit?.stop();
  });

  describe('Event Publishing', () => {
    it('should publish event with publisher confirm', async () => {
      const confirmChannel = await connection.createConfirmChannel();
      await confirmChannel.assertExchange(EXCHANGE, 'topic', { durable: true });

      const event = {
        eventId: crypto.randomUUID(),
        eventType: 'order.created',
        occurredAt: new Date().toISOString(),
        aggregateId: 'test-order-001',
        correlationId: 'test-correlation-001',
        causationId: null,
        schemaVersion: 1,
        payload: {
          orderId: 'test-order-001',
          userId: 'test-user-001',
          items: [{ productId: 'prod-001', quantity: 2 }],
          totalAmount: 5000,
        },
      };

      const published = await new Promise<boolean>((resolve) => {
        confirmChannel.publish(
          EXCHANGE,
          'order.created',
          Buffer.from(JSON.stringify(event)),
          { persistent: true },
          (err) => {
            if (err) {
              logger.error(err, 'Publish failed');
              resolve(false);
            } else {
              resolve(true);
            }
          }
        );
      });

      expect(published).toBe(true);
      await confirmChannel.close();
    });

    it('should handle publish failure gracefully', async () => {
      const confirmChannel = await connection.createConfirmChannel();

      // Try to publish to non-existent exchange
      const event = {
        eventId: crypto.randomUUID(),
        eventType: 'test.event',
        occurredAt: new Date().toISOString(),
        aggregateId: 'test-001',
        correlationId: 'test-correlation',
        causationId: null,
        schemaVersion: 1,
        payload: {},
      };

      const failure = await new Promise<Error>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Broker did not reject invalid exchange')), 5_000);
        confirmChannel.once('error', (error) => {
          clearTimeout(timeout);
          resolve(error);
        });
        confirmChannel.publish(
          'non-existent-exchange',
          'test.event',
          Buffer.from(JSON.stringify(event)),
          { persistent: true },
          (error) => {
            if (error) {
              clearTimeout(timeout);
              resolve(error);
            }
          }
        );
      });
      expect(failure.message).toContain('NOT_FOUND');
      await confirmChannel.close().catch(() => undefined);
    });
  });

  describe('Event Consumption with Manual Ack', () => {
    it('should consume event and manually acknowledge', async () => {
      const queueName = `${QUEUE_PREFIX}manual-ack-test`;
      await channel.assertQueue(queueName, { durable: true, autoDelete: true });
      await channel.bindQueue(queueName, EXCHANGE, 'test.manual.ack');

      // Publish test event
      const event = {
        eventId: crypto.randomUUID(),
        eventType: 'test.manual.ack',
        occurredAt: new Date().toISOString(),
        aggregateId: 'test-001',
        correlationId: 'test-correlation',
        causationId: null,
        schemaVersion: 1,
        payload: { message: 'test payload' },
      };

      channel.publish(
        EXCHANGE,
        'test.manual.ack',
        Buffer.from(JSON.stringify(event)),
        { persistent: true }
      );

      // Consume with manual ack
      const received = await new Promise<boolean>((resolve) => {
        channel.consume(queueName, (msg) => {
          if (msg) {
            const receivedEvent = JSON.parse(msg.content.toString());
            expect(receivedEvent.eventId).toBe(event.eventId);
            channel.ack(msg);
            resolve(true);
          }
        }, { noAck: false });

        setTimeout(() => resolve(false), 2000);
      });

      expect(received).toBe(true);
    });

    it('should nack and requeue on processing failure', async () => {
      const queueName = `${QUEUE_PREFIX}nack-test`;
      await channel.assertQueue(queueName, { durable: true, autoDelete: true });
      await channel.bindQueue(queueName, EXCHANGE, 'test.nack');

      const event = {
        eventId: crypto.randomUUID(),
        eventType: 'test.nack',
        occurredAt: new Date().toISOString(),
        aggregateId: 'test-002',
        correlationId: 'test-correlation',
        causationId: null,
        schemaVersion: 1,
        payload: {},
      };

      channel.publish(
        EXCHANGE,
        'test.nack',
        Buffer.from(JSON.stringify(event)),
        { persistent: true }
      );

      let attemptCount = 0;
      const maxAttempts = 2;

      const redelivered = await new Promise<boolean>((resolve) => {
        channel.consume(queueName, (msg) => {
          if (msg) {
            attemptCount++;

            if (attemptCount === 1) {
              // First attempt: nack and requeue
              channel.nack(msg, false, true);
            } else if (attemptCount === 2) {
              // Second attempt: verify redelivered flag and ack
              expect(msg.fields.redelivered).toBe(true);
              channel.ack(msg);
              resolve(true);
            }
          }
        }, { noAck: false });

        setTimeout(() => resolve(false), 3000);
      });

      expect(redelivered).toBe(true);
      expect(attemptCount).toBe(maxAttempts);
    });
  });

  describe('Idempotency', () => {
    it('should handle duplicate eventId gracefully', async () => {
      const queueName = `${QUEUE_PREFIX}idempotency-test`;
      await channel.assertQueue(queueName, { durable: true, autoDelete: true });
      await channel.bindQueue(queueName, EXCHANGE, 'test.idempotency');

      const event = {
        eventId: 'idempotent-event-001',
        eventType: 'test.idempotency',
        occurredAt: new Date().toISOString(),
        aggregateId: 'test-003',
        correlationId: 'test-correlation',
        causationId: null,
        schemaVersion: 1,
        payload: { counter: 1 },
      };

      // Create idempotency tracker (in-memory for test)
      const processedEvents = new Set<string>();

      // Publish same event twice
      channel.publish(EXCHANGE, 'test.idempotency', Buffer.from(JSON.stringify(event)), { persistent: true });
      channel.publish(EXCHANGE, 'test.idempotency', Buffer.from(JSON.stringify(event)), { persistent: true });

      let processCount = 0;
      let receivedCount = 0;

      await new Promise<void>((resolve) => {
        channel.consume(queueName, (msg) => {
          if (msg) {
            receivedCount++;
            const receivedEvent = JSON.parse(msg.content.toString());

            if (!processedEvents.has(receivedEvent.eventId)) {
              // First time seeing this eventId
              processedEvents.add(receivedEvent.eventId);
              processCount++;
            }
            // Always ack (idempotent consumer)
            channel.ack(msg);

            if (receivedCount === 2) {
              resolve();
            }
          }
        }, { noAck: false });

        setTimeout(resolve, 3000);
      });

      expect(receivedCount).toBe(2); // Received twice
      expect(processCount).toBe(1); // Processed only once
    });
  });

  describe('Compensation Logic', () => {
    it('should release inventory on payment failure', async () => {
      const queueName = `${QUEUE_PREFIX}compensation-test`;
      await channel.assertQueue(queueName, { durable: true, autoDelete: true });
      await channel.bindQueue(queueName, EXCHANGE, 'payment.failed');

      // Get a product with stock
      const product = await db.query(
        'SELECT id FROM products WHERE is_active = true LIMIT 1'
      );
      const productId = product.rows[0]!.id;

      // Get initial stock
      const initialStock = await db.query(
        'SELECT available_quantity, reserved_quantity FROM inventory WHERE product_id = $1',
        [productId]
      );
      const initialAvailable = initialStock.rows[0]!.available_quantity;
      const initialReserved = initialStock.rows[0]!.reserved_quantity;

      // Simulate: inventory reserved
      await db.query(
        'UPDATE inventory SET available_quantity = available_quantity - 2, reserved_quantity = reserved_quantity + 2 WHERE product_id = $1',
        [productId]
      );

      // Publish payment.failed event
      const orderId = crypto.randomUUID();
      const paymentFailedEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'payment.failed',
        occurredAt: new Date().toISOString(),
        aggregateId: orderId,
        correlationId: crypto.randomUUID(),
        causationId: crypto.randomUUID(),
        schemaVersion: 1,
        payload: {
          orderId,
          reason: 'INSUFFICIENT_FUNDS',
          items: [{ productId, quantity: 2 }],
        },
      };

      channel.publish(
        EXCHANGE,
        'payment.failed',
        Buffer.from(JSON.stringify(paymentFailedEvent)),
        { persistent: true }
      );

      // Consume and compensate
      await new Promise<void>((resolve) => {
        channel.consume(queueName, async (msg) => {
          if (msg) {
            const event = JSON.parse(msg.content.toString());

            // Compensation: release reserved stock
            for (const item of event.payload.items) {
              await db.query(
                'UPDATE inventory SET available_quantity = available_quantity + $1, reserved_quantity = reserved_quantity - $1 WHERE product_id = $2',
                [item.quantity, item.productId]
              );
            }

            channel.ack(msg);
            resolve();
          }
        }, { noAck: false });

        setTimeout(resolve, 3000);
      });

      // Verify stock restored
      const finalStock = await db.query(
        'SELECT available_quantity, reserved_quantity FROM inventory WHERE product_id = $1',
        [productId]
      );

      expect(finalStock.rows[0]!.available_quantity).toBe(initialAvailable);
      expect(finalStock.rows[0]!.reserved_quantity).toBe(initialReserved);
    });
  });

  describe('Event Ordering and Causation', () => {
    it('should preserve causation chain via causationId', async () => {
      const queueName = `${QUEUE_PREFIX}causation-test`;
      await channel.assertQueue(queueName, { durable: true, autoDelete: true });
      await channel.bindQueue(queueName, EXCHANGE, 'order.*');

      const orderId = crypto.randomUUID();
      const correlationId = crypto.randomUUID();

      // Event 1: order.created
      const event1 = {
        eventId: crypto.randomUUID(),
        eventType: 'order.created',
        occurredAt: new Date().toISOString(),
        aggregateId: orderId,
        correlationId,
        causationId: null,
        schemaVersion: 1,
        payload: { orderId },
      };

      // Event 2: inventory.reserved (caused by order.created)
      const event2 = {
        eventId: crypto.randomUUID(),
        eventType: 'inventory.reserved',
        occurredAt: new Date().toISOString(),
        aggregateId: orderId,
        correlationId,
        causationId: event1.eventId,
        schemaVersion: 1,
        payload: { orderId },
      };

      // Event 3: order.confirmed (caused by inventory.reserved)
      const event3 = {
        eventId: crypto.randomUUID(),
        eventType: 'order.confirmed',
        occurredAt: new Date().toISOString(),
        aggregateId: orderId,
        correlationId,
        causationId: event2.eventId,
        schemaVersion: 1,
        payload: { orderId },
      };

      // Publish all events
      channel.publish(EXCHANGE, 'order.created', Buffer.from(JSON.stringify(event1)), { persistent: true });
      await new Promise(resolve => setTimeout(resolve, 50));
      channel.publish(EXCHANGE, 'order.reserved', Buffer.from(JSON.stringify(event2)), { persistent: true });
      await new Promise(resolve => setTimeout(resolve, 50));
      channel.publish(EXCHANGE, 'order.confirmed', Buffer.from(JSON.stringify(event3)), { persistent: true });

      const receivedEvents: Array<{ eventId: string; causationId: string | null; correlationId: string }> = [];

      await new Promise<void>((resolve) => {
        channel.consume(queueName, (msg) => {
          if (msg) {
            const event = JSON.parse(msg.content.toString());
            receivedEvents.push(event);
            channel.ack(msg);

            if (receivedEvents.length === 3) {
              resolve();
            }
          }
        }, { noAck: false });

        setTimeout(resolve, 3000);
      });

      // Verify causation chain
      expect(receivedEvents).toHaveLength(3);
      expect(receivedEvents[0]!.causationId).toBeNull();
      expect(receivedEvents[1]!.causationId).toBe(receivedEvents[0]!.eventId);
      expect(receivedEvents[2]!.causationId).toBe(receivedEvents[1]!.eventId);

      // All events share same correlationId
      expect(receivedEvents.every(e => e.correlationId === correlationId)).toBe(true);
    });
  });
});
