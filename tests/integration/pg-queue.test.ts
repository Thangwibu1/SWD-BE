import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Database } from '../../src/sut/shared/database/db.js';
import { createPool } from '../../src/sut/shared/database/pool.js';
import { migrateSut } from '../../src/sut/shared/database/migrator.js';
import { ensureReliabilitySchema } from '../../src/sut/shared/database/reliability.js';
import { createPaymentModule } from '../../src/sut/monolith/payment-module.js';
import {
  claimQueueJob,
  createPgCart,
  createPgQueueOrders,
  processQueueJob,
} from '../../src/sut/monolith/pg-queue.js';
import { startTestPostgres, type TestPostgres } from './helpers/dev-postgres.js';

describe('PostgreSQL queue durability and replica concurrency', () => {
  let postgres: TestPostgres;
  let db: Database;
  const workers: ChildProcess[] = [];
  const endpoints = new Map<ChildProcess, string>();
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
  };
  const waitFor = async (condition: () => Promise<boolean>) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Queue worker did not settle');
  };
  const startWorker = async (role = 'pg-queue-worker', architectureId = 'A14') => {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string')
          return reject(new Error('Missing worker port'));
        server.close(() => resolve(address.port));
      });
    });
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        APP_ROLE: role,
        ARCHITECTURE_ID: architectureId,
        DATABASE_URL: postgres.url,
        SUT_PORT: String(port),
        LOG_LEVEL: 'warn',
      },
    });
    workers.push(child);
    endpoints.set(child, `http://127.0.0.1:${port}`);
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Worker exited: ${output}`);
      return fetch(`http://127.0.0.1:${port}/ready`)
        .then((r) => r.ok)
        .catch(() => false);
    });
    return child;
  };
  const userId = randomUUID(),
    productId = randomUUID();
  const request = {
    userId,
    items: [{ productId, quantity: 2 }],
    paymentMode: 'MOCK_SUCCESS' as const,
  };
  const stock = async () =>
    (
      await db.query(
        'test.stock',
        'SELECT available_quantity,reserved_quantity FROM inventory WHERE product_id=$1',
        [productId],
      )
    ).rows[0]!;
  beforeAll(async () => {
    postgres = await startTestPostgres(`pg-queue-${process.pid}-${Date.now().toString(36)}`);
    db = new Database(createPool({ connectionString: postgres.url, max: 20 }));
    const client = await db.pool.connect();
    try {
      await migrateSut(client);
    } finally {
      client.release();
    }
    await ensureReliabilitySchema(db);
    await db.query(
      'test.user',
      "INSERT INTO users(id,email,password_hash) VALUES($1,'queue@test.local','x')",
      [userId],
    );
    await db.query(
      'test.product',
      "INSERT INTO products(id,sku,name,category,price) VALUES($1,'queue','Queue','test',10)",
      [productId],
    );
    await db.query(
      'test.inventory',
      'INSERT INTO inventory(product_id,available_quantity) VALUES($1,100)',
      [productId],
    );
  }, 120_000);
  afterAll(async () => {
    for (const worker of workers) await stop(worker);
    await db?.pool.end();
    await postgres?.stop();
  });

  it('shares synchronous checkout payments across real monolith processes and restart', async () => {
    const first = await startWorker('sut-monolith', 'A19');
    const second = await startWorker('sut-monolith', 'A19');
    const before = await stock();
    const created = await fetch(`${endpoints.get(first)}/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(request),
    });
    expect(created.status).toBe(201);
    const order = await created.json() as { id: string; totalAmount: string };
    const replay = async (process: ChildProcess) => {
      const response = await fetch(`${endpoints.get(process)}/payments/mock`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.id, amount: order.totalAmount, mode: 'MOCK_SUCCESS' }),
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { duplicate: boolean }).duplicate).toBe(true);
    };
    await replay(second);
    await stop(first);
    await stop(second);
    const restarted = await startWorker('sut-monolith', 'A19');
    await replay(restarted);
    const cancelled = await fetch(`${endpoints.get(restarted)}/orders/${order.id}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(await stock()).toEqual(before);
    await stop(restarted);
  });

  it('commits order, reservation and one job atomically across duplicate requests', async () => {
    const key = randomUUID(),
      before = await stock();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createPgQueueOrders(db).checkout(key, request)),
    );
    expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
    expect((await db.query('test.jobs', 'SELECT * FROM reliability.queue_jobs')).rowCount).toBe(1);
    expect(await stock()).toEqual({
      available_quantity: before.available_quantity - 2,
      reserved_quantity: before.reserved_quantity + 2,
    });
    await expect(
      createPgQueueOrders(db).checkout(key, { ...request, paymentMode: 'MOCK_FAIL' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    const job = await claimQueueJob(db);
    expect(job).toBeDefined();
    await processQueueJob(db, job!);
    expect((await createPgQueueOrders(db).get(results[0]!.order.id)).status).toBe('CONFIRMED');
    await createPgQueueOrders(db).cancel(results[0]!.order.id);
    expect(await stock()).toEqual(before);
  });
  it('rolls back the order and job on insufficient stock', async () => {
    const key = randomUUID(),
      before = await stock();
    await expect(
      createPgQueueOrders(db).checkout(key, { ...request, items: [{ productId, quantity: 1000 }] }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(
      (await db.query('test.order', 'SELECT id FROM orders WHERE idempotency_key=$1', [key]))
        .rowCount,
    ).toBe(0);
    expect(await stock()).toEqual(before);
  });
  it('reclaims a crashed worker after payment, fences stale leases and never charges twice', async () => {
    const before = await stock();
    const result = await createPgQueueOrders(db).checkout(randomUUID(), request);
    const oldJob = (await claimQueueJob(db))!;
    await createPaymentModule(db).charge({
      orderId: result.order.id,
      amount: oldJob.request.totalAmount,
      mode: 'MOCK_SUCCESS',
    });
    await db.query(
      'test.crash',
      "UPDATE reliability.queue_jobs SET lease_until=now()-interval '1 second' WHERE order_id=$1",
      [result.order.id],
    );
    const newJob = (await claimQueueJob(new Database(db.pool)))!;
    expect(newJob.lease_token).not.toBe(oldJob.lease_token);
    await processQueueJob(db, oldJob);
    expect((await createPgQueueOrders(db).get(result.order.id)).status).toBe('PENDING');
    await processQueueJob(new Database(db.pool), newJob);
    await processQueueJob(db, newJob);
    expect((await createPgQueueOrders(db).get(result.order.id)).status).toBe('CONFIRMED');
    expect(
      (
        await db.query('test.payments', 'SELECT * FROM reliability.payments WHERE order_id=$1', [
          result.order.id,
        ])
      ).rowCount,
    ).toBe(1);
    await createPgQueueOrders(db).cancel(result.order.id);
    expect(await stock()).toEqual(before);
  });
  it.each(['MOCK_FAIL', 'MOCK_TIMEOUT'] as const)(
    'releases stock on %s without leaving pending jobs',
    async (mode) => {
      const before = await stock();
      const result = await createPgQueueOrders(db).checkout(randomUUID(), {
        ...request,
        paymentMode: mode,
      });
      await processQueueJob(db, (await claimQueueJob(db))!);
      expect((await createPgQueueOrders(db).get(result.order.id)).status).toBe('FAILED');
      expect(await stock()).toEqual(before);
      expect(await claimQueueJob(db)).toBeUndefined();
    },
  );
  it('shares carts and preserves concurrent updates from separate API instances', async () => {
    const otherProduct = randomUUID();
    await Promise.all([
      createPgCart(db).upsert(userId, productId, 3),
      createPgCart(new Database(db.pool)).upsert(userId, otherProduct, 4),
    ]);
    const cart = await createPgCart(new Database(db.pool)).get(userId);
    expect(cart.items).toHaveLength(2);
    expect(cart.items.map((i) => i.quantity).sort()).toEqual([3, 4]);
  });
  it('recovers a claimed job after killing and restarting the actual worker process', async () => {
    const before = await stock();
    const result = await createPgQueueOrders(db).checkout(randomUUID(), {
      ...request,
      paymentMode: 'MOCK_TIMEOUT',
    });
    const worker = await startWorker();
    await waitFor(
      async () =>
        (
          await db.query(
            'test.claimed',
            'SELECT state FROM reliability.queue_jobs WHERE order_id=$1',
            [result.order.id],
          )
        ).rows[0]?.state === 'PROCESSING',
    );
    await stop(worker);
    // Advance the lease deadline instead of spending 30 seconds idle in the test.
    await db.query(
      'test.expire',
      "UPDATE reliability.queue_jobs SET lease_until=now()-interval '1 second' WHERE order_id=$1",
      [result.order.id],
    );
    const restarted = await startWorker();
    await waitFor(
      async () => (await createPgQueueOrders(db).get(result.order.id)).status === 'FAILED',
    );
    await stop(restarted);
    expect(await stock()).toEqual(before);
    expect(
      (
        await db.query(
          'test.attempts',
          'SELECT attempts FROM reliability.queue_jobs WHERE order_id=$1',
          [result.order.id],
        )
      ).rows[0]?.attempts,
    ).toBe(2);
  });
});
