import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/sut/shared/database/pool.js';
import { migrateSut } from '../../src/sut/shared/database/migrator.js';
import { startTestPostgres } from './helpers/dev-postgres.js';
import type { TestPostgres } from './helpers/dev-postgres.js';
import { startTestRabbitMQ } from './helpers/dev-rabbitmq.js';
import type { TestRabbitMQ } from './helpers/dev-rabbitmq.js';

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('No TCP address'));
    server.close(() => resolve(address.port));
  });
});
const waitFor = async (check: () => Promise<boolean>, timeout = 25_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Service operation did not settle');
};

describe('Real service roles over HTTP and AMQP', () => {
  let postgres: TestPostgres;
  let broker: TestRabbitMQ;
  let pool: ReturnType<typeof createPool>;
  let inventoryPort: number;
  let paymentPort: number;
  let orderPort: number;
  const children: ChildProcess[] = [];
  const logs = new Map<string, string>();
  const userId = randomUUID();
  const productId = randomUUID();
  const body = { userId, items: [{ productId, quantity: 2 }], paymentMode: 'MOCK_SUCCESS' };
  const post = (port: number, path: string, data: unknown, key = randomUUID()) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': randomUUID(), 'Idempotency-Key': key },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(12_000),
  });
  async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
  }
  async function start(role: string, port: number, architecture = 'A05') {
    let output = '';
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      windowsHide: true,
      env: { ...process.env, APP_ROLE: role, ARCHITECTURE_ID: architecture, SUT_PORT: String(port), LOG_LEVEL: 'warn',
        DATABASE_URL: postgres.url, RABBITMQ_URL: broker.url,
        INVENTORY_URL: `http://127.0.0.1:${inventoryPort}`, PAYMENT_URL: `http://127.0.0.1:${paymentPort}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout?.on('data', chunk => { output += String(chunk); logs.set(`${role}-${architecture}`, output); });
    child.stderr?.on('data', chunk => { output += String(chunk); logs.set(`${role}-${architecture}`, output); });
    if (role !== 'event-worker') {
      await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`Service ${role} exited: ${output}`);
        return fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
      });
    }
    return child;
  }

  beforeAll(async () => {
    postgres = await startTestPostgres(`service-recovery-${process.pid}-${Date.now().toString(36)}`);
    broker = await startTestRabbitMQ('service-recovery-rabbit');
    pool = createPool({ connectionString: postgres.url });
    const client = await pool.connect();
    try { await migrateSut(client); } finally { client.release(); }
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES ($1,'roles@example.com','x')", [userId]);
    await pool.query("INSERT INTO products(id,sku,name,category,price) VALUES ($1,'roles','Roles','test',10)", [productId]);
    await pool.query('INSERT INTO inventory(product_id,available_quantity) VALUES ($1,100)', [productId]);
    inventoryPort = await freePort(); paymentPort = await freePort(); orderPort = await freePort();
    await start('inventory-service', inventoryPort);
    await start('payment-mock', paymentPort);
  }, 120_000);

  afterAll(async () => {
    for (const child of children) await stop(child);
    await pool?.end();
    await broker?.stop();
    await postgres?.stop();
  });

  it('persists a failed HTTP dependency call and recovers automatically after restarting the order service', async () => {
    const order = await start('order-service', orderPort);
    const inventory = children[0]!;
    await stop(inventory);
    const key = randomUUID();
    const failed = await post(orderPort, '/orders', body, key);
    expect(failed.status).toBe(503);
    const pending = (await pool.query('SELECT id,status FROM orders WHERE idempotency_key=$1', [key])).rows[0];
    expect(pending.status).toBe('PENDING');
    await stop(order);
    await start('inventory-service', inventoryPort);
    const restarted = await start('order-service', orderPort);
    await waitFor(async () => (await pool.query('SELECT status FROM orders WHERE id=$1', [pending.id])).rows[0].status === 'CONFIRMED');
    const replay = await post(orderPort, '/orders', body, key);
    expect(replay.ok).toBe(true);
    expect((await pool.query('SELECT available_quantity,reserved_quantity FROM inventory WHERE product_id=$1', [productId])).rows[0])
      .toEqual({ available_quantity: 98, reserved_quantity: 0 });
    const declined = await post(orderPort, '/orders', { ...body, paymentMode: 'MOCK_FAIL' });
    expect(declined.status).toBe(402);
    const timeout = await post(orderPort, '/orders', { ...body, paymentMode: 'MOCK_TIMEOUT' });
    expect(timeout.status).toBe(504);
    expect((await pool.query('SELECT available_quantity,reserved_quantity FROM inventory WHERE product_id=$1', [productId])).rows[0])
      .toEqual({ available_quantity: 98, reserved_quantity: 0 });
    // Payment transport failures remain pending and replay the same charge key.
    await stop(children[1]!);
    const paymentKey = randomUUID();
    expect((await post(orderPort, '/orders', body, paymentKey)).status).toBe(503);
    const paymentOrder = (await pool.query('SELECT id FROM orders WHERE idempotency_key=$1', [paymentKey])).rows[0];
    await start('payment-mock', paymentPort);
    await waitFor(async () => (await pool.query('SELECT status FROM orders WHERE id=$1', [paymentOrder.id])).rows[0].status === 'CONFIRMED');
    expect((await post(orderPort, `/orders/${paymentOrder.id}/cancel`, {})).status).toBe(200);
    expect((await pool.query('SELECT available_quantity,reserved_quantity FROM inventory WHERE product_id=$1', [productId])).rows[0])
      .toEqual({ available_quantity: 98, reserved_quantity: 0 });
    await stop(restarted);
  }, 60_000);

  it('runs the production event chain and compensates failed payments with durable inbox/outbox', async () => {
    for (const child of children) await stop(child);
    await start('inventory-service', inventoryPort, 'A09');
    await start('payment-mock', paymentPort, 'A09');
    await start('event-worker', await freePort(), 'A09');
    await start('order-service', orderPort, 'A09');
    const key = randomUUID();
    const accepted = await post(orderPort, '/orders', body, key);
    expect(accepted.status).toBe(202);
    const row = (await pool.query('SELECT id FROM orders WHERE idempotency_key=$1', [key])).rows[0];
    try {
      await waitFor(async () => (await pool.query('SELECT status,inventory_committed FROM orders WHERE id=$1', [row.id])).rows[0].inventory_committed === true);
    } catch (error) { throw new Error(`${String(error)}\n${JSON.stringify(Object.fromEntries(logs))}`, { cause: error }); }
    const declinedKey = randomUUID();
    expect((await post(orderPort, '/orders', { ...body, paymentMode: 'MOCK_FAIL' }, declinedKey)).status).toBe(202);
    const declined = (await pool.query('SELECT id FROM orders WHERE idempotency_key=$1', [declinedKey])).rows[0];
    try { await waitFor(async () => {
      const value = (await pool.query('SELECT status,inventory_reserved FROM orders WHERE id=$1', [declined.id])).rows[0];
      return value.status === 'FAILED' && !value.inventory_reserved;
    }); } catch (error) { throw new Error(`${String(error)}\n${JSON.stringify(Object.fromEntries(logs))}`, { cause: error }); }
    expect((await pool.query('SELECT available_quantity,reserved_quantity FROM inventory WHERE product_id=$1', [productId])).rows[0])
      .toEqual({ available_quantity: 96, reserved_quantity: 0 });
    expect((await pool.query('SELECT count(*)::int AS count FROM reliability.inbox')).rows[0].count).toBeGreaterThan(0);
    expect((await pool.query('SELECT count(*)::int AS count FROM reliability.outbox WHERE published_at IS NOT NULL')).rows[0].count).toBeGreaterThan(0);
    // A later failing line must roll back the earlier reservation completely.
    const emptyProduct = randomUUID();
    await pool.query("INSERT INTO products(id,sku,name,category,price) VALUES ($1,$2,'Empty','test',5)", [emptyProduct, emptyProduct]);
    await pool.query('INSERT INTO inventory(product_id,available_quantity) VALUES ($1,0)', [emptyProduct]);
    const rejectedKey = randomUUID();
    expect((await post(orderPort, '/orders', { ...body, items: [...body.items, { productId: emptyProduct, quantity: 1 }] }, rejectedKey)).status).toBe(202);
    await waitFor(async () => (await pool.query('SELECT status FROM orders WHERE idempotency_key=$1', [rejectedKey])).rows[0].status === 'FAILED');
    expect((await pool.query('SELECT available_quantity,reserved_quantity FROM inventory WHERE product_id=$1', [productId])).rows[0])
      .toEqual({ available_quantity: 96, reserved_quantity: 0 });
    expect((await post(orderPort, `/orders/${row.id}/cancel`, {})).status).toBe(200);
    expect((await pool.query('SELECT available_quantity,reserved_quantity FROM inventory WHERE product_id=$1', [productId])).rows[0])
      .toEqual({ available_quantity: 98, reserved_quantity: 0 });
  }, 60_000);
});
