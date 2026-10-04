import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import type { ChannelModel, Channel } from 'amqplib';
import { createPool } from '../../src/sut/shared/database/pool.js';
import { Database } from '../../src/sut/shared/database/db.js';
import { ensureReliabilitySchema } from '../../src/sut/shared/database/reliability.js';
import { migrateSut } from '../../src/sut/shared/database/migrator.js';
import { RabbitMQClient } from '../../src/sut/shared/events/rabbitmq.js';
import type { EventEnvelope } from '../../src/sut/shared/events/rabbitmq.js';
import { replayDeadLetters } from '../../src/sut/shared/events/dead-letter.js';
import { createOrderModule } from '../../src/sut/monolith/order-module.js';
import { createPaymentModule } from '../../src/sut/monolith/payment-module.js';
import { applyInventoryOperation } from '../../src/sut/services/inventory/operations.js';
import { createRestSaga } from '../../src/sut/services/order/rest-saga.js';
import { DomainError } from '../../src/sut/shared/errors/domain-errors.js';
import { createLogger } from '../../src/utils/logger.js';
import { startTestPostgres } from './helpers/dev-postgres.js';
import type { TestPostgres } from './helpers/dev-postgres.js';
import { startTestRabbitMQ } from './helpers/dev-rabbitmq.js';
import type { TestRabbitMQ } from './helpers/dev-rabbitmq.js';

const logger = createLogger('reliability-test', 'silent');
const waitFor = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for durable processing');
};

describe('Production reliability against PostgreSQL and RabbitMQ', () => {
  let postgres: TestPostgres;
  let broker: TestRabbitMQ;
  let pool: ReturnType<typeof createPool>;
  let db: Database;
  let connection: ChannelModel;
  let channel: Channel;
  const clients: RabbitMQClient[] = [];
  const userId = randomUUID();
  const productId = randomUUID();
  const request = { userId, items: [{ productId, quantity: 2 }], paymentMode: 'MOCK_SUCCESS' as const };
  const stock = async () => (await pool.query('SELECT available_quantity,reserved_quantity FROM inventory WHERE product_id=$1', [productId])).rows[0];
  const client = async () => {
    const value = new RabbitMQClient(broker.url, logger, db);
    await value.connect();
    clients.push(value);
    return value;
  };
  const event = (): EventEnvelope => ({
    eventId: randomUUID(), eventType: 'order.cancelled', occurredAt: new Date().toISOString(),
    aggregateId: randomUUID(), correlationId: randomUUID(), schemaVersion: 1,
    payload: { orderId: randomUUID(), reason: 'USER_CANCELLED' },
  });

  beforeAll(async () => {
    postgres = await startTestPostgres(`reliability-${process.pid}-${Date.now().toString(36)}`);
    broker = await startTestRabbitMQ('reliability-rabbit');
    pool = createPool({ connectionString: postgres.url });
    db = new Database(pool);
    const migration = await pool.connect();
    try { await migrateSut(migration); } finally { migration.release(); }
    await Promise.all([ensureReliabilitySchema(db), ensureReliabilitySchema(new Database(pool))]);
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES ($1,'test@example.com','x')", [userId]);
    await pool.query("INSERT INTO products(id,sku,name,category,price) VALUES ($1,'test','Test','test',10)", [productId]);
    await pool.query('INSERT INTO inventory(product_id,available_quantity) VALUES ($1,10000)', [productId]);
    connection = await amqp.connect(broker.url);
    channel = await connection.createChannel();
  }, 120_000);

  afterAll(async () => {
    for (const value of clients) await value.close().catch(() => undefined);
    await channel?.close();
    await connection?.close();
    await pool?.end();
    await broker?.stop();
    await postgres?.stop();
  });

  it('rolls back order creation when outbox enqueue fails', async () => {
    const orders = createOrderModule(db, undefined, createPaymentModule(), undefined, {
      async publish() { throw new Error('enqueue failed'); },
    });
    const key = randomUUID();
    await expect(orders.checkout(key, request)).rejects.toThrow('enqueue failed');
    expect((await pool.query('SELECT id FROM orders WHERE idempotency_key=$1', [key])).rowCount).toBe(0);
  });

  it('commits an order and its event while the broker client is offline, then relays after restart', async () => {
    const offline = new RabbitMQClient(broker.url, logger, db);
    const orders = createOrderModule(db, undefined, createPaymentModule(), undefined, {
      async publish(key, value) {
        await offline.publish(key, { ...value, eventId: randomUUID(), occurredAt: new Date().toISOString(), schemaVersion: 1 } as EventEnvelope);
      },
    });
    const key = randomUUID();
    const pending = await orders.checkout(key, request);
    await orders.checkout(key, request);
    const queued = await pool.query("SELECT event_id FROM reliability.outbox WHERE envelope->>'aggregateId'=$1", [pending.order.id]);
    expect(queued.rowCount).toBe(1);
    const relay = await client();
    await relay.flushOutbox();
    expect((await pool.query('SELECT published_at FROM reliability.outbox WHERE event_id=$1', [queued.rows[0].event_id])).rows[0].published_at).toBeTruthy();
    expect((await channel.checkQueue('inventory.order.created')).messageCount).toBeGreaterThan(0);
  });

  it('deduplicates across two replicas and a new client after restart', async () => {
    const queue = `test-durable-${randomUUID()}`;
    const one = await client();
    const two = await client();
    const incoming = event();
    let calls = 0;
    const handler = async () => { calls++; await db.query('test.effect', 'UPDATE inventory SET version=version+1 WHERE product_id=$1', [productId]); };
    await one.subscribe(queue, ['order.cancelled'], handler);
    await two.subscribe(queue, ['order.cancelled'], handler);
    const before = (await pool.query('SELECT version FROM inventory WHERE product_id=$1', [productId])).rows[0].version;
    for (let i = 0; i < 4; i++) channel.sendToQueue(queue, Buffer.from(JSON.stringify(incoming)), { persistent: true });
    await waitFor(async () => calls === 1 && (await channel.checkQueue(queue)).messageCount === 0);
    await one.close();
    await two.close();
    const restarted = await client();
    await restarted.subscribe(queue, ['order.cancelled'], handler);
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(incoming)), { persistent: true });
    await new Promise(r => setTimeout(r, 300));
    expect(calls).toBe(1);
    expect((await pool.query('SELECT version FROM inventory WHERE product_id=$1', [productId])).rows[0].version).toBe(before + 1);
    await restarted.close();
  });

  it('rolls back inbox and effects on handler failure, retries with delay, then dead-letters after four attempts', async () => {
    const queue = `test-retry-${randomUUID()}`;
    const value = await client();
    const incoming = event();
    let attempts = 0;
    const before = (await pool.query('SELECT version FROM inventory WHERE product_id=$1', [productId])).rows[0].version;
    await value.subscribe(queue, ['order.cancelled'], async () => {
      attempts++;
      await db.query('test.effect', 'UPDATE inventory SET version=version+1 WHERE product_id=$1', [productId]);
      await value.publish('order.cancelled', event());
      throw new Error('dependency unavailable');
    });
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(incoming)), { persistent: true });
    await waitFor(async () => (await channel.checkQueue(`${queue}.dead`)).messageCount === 1);
    expect(attempts).toBe(4);
    expect((await pool.query('SELECT * FROM reliability.inbox WHERE consumer=$1', [queue])).rowCount).toBe(0);
    expect((await pool.query('SELECT version FROM inventory WHERE product_id=$1', [productId])).rows[0].version).toBe(before);
    const dead = await channel.get(`${queue}.dead`, { noAck: true });
    expect(dead && dead.properties.headers?.['x-retry-count']).toBe(4);
    await value.close();
  });

  it('sends malformed messages directly to dead-letter storage', async () => {
    const queue = `test-invalid-${randomUUID()}`;
    const value = await client();
    await value.subscribe(queue, ['order.cancelled'], async () => { throw new Error('must not run'); });
    channel.sendToQueue(queue, Buffer.from('invalid json'), { persistent: true });
    await waitFor(async () => (await channel.checkQueue(`${queue}.dead`)).messageCount === 1);
    await value.close();
  });

  it('replays a dead-letter after a dependency recovers, preserving its ID and durable deduplication', async () => {
    const queue = `test-replay-${randomUUID()}`;
    const value = await client();
    let failing = true;
    let effects = 0;
    await value.subscribe(queue, ['order.cancelled'], async () => {
      if (failing) throw new Error('offline');
      effects++;
    });
    const incoming = event();
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(incoming)), { persistent: true });
    await waitFor(async () => (await channel.checkQueue(`${queue}.dead`)).messageCount === 1);
    failing = false;
    expect(await replayDeadLetters(connection, queue, 1)).toBe(1);
    await waitFor(async () => effects === 1);
    const inbox = await pool.query('SELECT event_id FROM reliability.inbox WHERE consumer=$1', [queue]);
    expect(inbox.rows[0].event_id).toBe(incoming.eventId);
    await value.close();
  });

  it('persists payment idempotency across fresh module instances', async () => {
    const payment = { orderId: randomUUID(), amount: '20.00', mode: 'MOCK_SUCCESS' as const };
    const first = await createPaymentModule(db).charge(payment);
    const duplicate = await createPaymentModule(new Database(pool)).charge(payment);
    expect(duplicate).toEqual({ ...first, duplicate: true });
    await expect(createPaymentModule(db).charge({ ...payment, amount: '30.00' })).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_PROCESSED' });
  });

  it('replays reserve/commit/release safely and blocks reserve after a release tombstone', async () => {
    const id = randomUUID();
    const before = await stock();
    for (const action of ['reserve', 'reserve', 'commit', 'commit', 'release', 'release'] as const) {
      await applyInventoryOperation(db, action, id, request.items);
    }
    expect(await stock()).toEqual(before);
    const ambiguous = randomUUID();
    await applyInventoryOperation(db, 'release', ambiguous, request.items);
    await expect(applyInventoryOperation(db, 'reserve', ambiguous, request.items)).rejects.toMatchObject({ code: 'ORDER_NOT_CANCELLABLE' });
    expect(await stock()).toEqual(before);
  });

  it('recovers a lost reserve response after recreating the REST orchestrator', async () => {
    const before = await stock();
    let loseResponse = true;
    const dependencies = {
      payments: createPaymentModule(db),
      async inventory(action: 'reserve' | 'commit' | 'release', id: string, items: typeof request.items) {
        await applyInventoryOperation(db, action, id, items);
        if (action === 'reserve' && loseResponse) { loseResponse = false; throw new DomainError('DEPENDENCY_UNAVAILABLE'); }
      },
    };
    const key = randomUUID();
    await expect(createRestSaga(db, dependencies).checkout(key, request)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    const restarted = createRestSaga(new Database(pool), dependencies);
    await restarted.recover();
    const result = await restarted.checkout(key, request);
    expect(result.order.status).toBe('CONFIRMED');
    expect(await stock()).toEqual({ available_quantity: before.available_quantity - 2, reserved_quantity: before.reserved_quantity });
    await restarted.cancel(result.order.id);
    expect(await stock()).toEqual(before);
  });

  it('compensates payment decline and resumes a failed release after restart', async () => {
    const before = await stock();
    let failRelease = true;
    const dependencies = {
      payments: createPaymentModule(db),
      async inventory(action: 'reserve' | 'commit' | 'release', id: string, items: typeof request.items) {
        if (action === 'release' && failRelease) { failRelease = false; throw new DomainError('DEPENDENCY_UNAVAILABLE'); }
        await applyInventoryOperation(db, action, id, items);
      },
    };
    const key = randomUUID();
    const declined = { ...request, paymentMode: 'MOCK_FAIL' as const };
    await expect(createRestSaga(db, dependencies).checkout(key, declined)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    await createRestSaga(new Database(pool), dependencies).recover();
    expect(await stock()).toEqual(before);
    await expect(createRestSaga(db, dependencies).checkout(key, declined)).rejects.toMatchObject({ code: 'PAYMENT_DECLINED' });
    expect((await pool.query('SELECT status FROM orders WHERE idempotency_key=$1', [key])).rows[0].status).toBe('FAILED');
  });

  it('compensates a mock payment timeout and keeps stock unchanged', async () => {
    const before = await stock();
    const saga = createRestSaga(db, {
      payments: { async charge() { throw new DomainError('DEPENDENCY_TIMEOUT'); } },
      inventory: (action, id, items) => applyInventoryOperation(db, action, id, items),
    });
    await expect(saga.checkout(randomUUID(), { ...request, paymentMode: 'MOCK_TIMEOUT' })).rejects.toMatchObject({ code: 'DEPENDENCY_TIMEOUT' });
    expect(await stock()).toEqual(before);
  });

  it('recovers a commit response lost after payment succeeded without a second stock decrement or payment', async () => {
    const before = await stock();
    let loseCommit = true;
    const dependencies = {
      payments: createPaymentModule(db),
      async inventory(action: 'reserve' | 'commit' | 'release', id: string, items: typeof request.items) {
        await applyInventoryOperation(db, action, id, items);
        if (action === 'commit' && loseCommit) { loseCommit = false; throw new DomainError('DEPENDENCY_UNAVAILABLE'); }
      },
    };
    const key = randomUUID();
    await expect(createRestSaga(db, dependencies).checkout(key, request)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    const restarted = createRestSaga(new Database(pool), dependencies);
    await restarted.recover();
    const result = await restarted.checkout(key, request);
    expect(result.order.status).toBe('CONFIRMED');
    expect((await pool.query('SELECT * FROM reliability.payments WHERE order_id=$1', [result.order.id])).rowCount).toBe(1);
    expect(await stock()).toEqual({ available_quantity: before.available_quantity - 2, reserved_quantity: before.reserved_quantity });
  });

  it('recovers cancellation when the release succeeded but its response was lost', async () => {
    const before = await stock();
    let loseRelease = true;
    const dependencies = {
      payments: createPaymentModule(db),
      async inventory(action: 'reserve' | 'commit' | 'release', id: string, items: typeof request.items) {
        await applyInventoryOperation(db, action, id, items);
        if (action === 'release' && loseRelease) { loseRelease = false; throw new DomainError('DEPENDENCY_UNAVAILABLE'); }
      },
    };
    const saga = createRestSaga(db, dependencies);
    const order = await saga.checkout(randomUUID(), request);
    await expect(saga.cancel(order.order.id)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    const restarted = createRestSaga(new Database(pool), dependencies);
    await restarted.recover();
    expect((await restarted.get(order.order.id)).status).toBe('CANCELLED');
    expect(await stock()).toEqual(before);
    await expect(restarted.cancel(order.order.id)).rejects.toMatchObject({ code: 'ORDER_NOT_CANCELLABLE' });
    expect(await stock()).toEqual(before);
  });
});
