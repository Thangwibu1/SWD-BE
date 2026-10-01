import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type pg from 'pg';
import { startTestPostgres } from './helpers/dev-postgres.js';
import type { TestPostgres } from './helpers/dev-postgres.js';
import { Database } from '../../src/sut/shared/database/db.js';
import { createPool } from '../../src/sut/shared/database/pool.js';
import { migrateSut } from '../../src/sut/shared/database/migrator.js';
import { generateDataset, DATASET_PROFILES } from '../../src/sut/shared/database/seed/dataset.js';
import { loadDataset } from '../../src/sut/shared/database/seed/loader.js';
import { createSutApp, finalizeSutApp } from '../../src/sut/shared/http/sut-http.js';
import { createBusinessRouter } from '../../src/sut/shared/router/business-router.js';
import { createAuthModule } from '../../src/sut/monolith/auth-module.js';
import { createCatalogModule } from '../../src/sut/monolith/catalog-module.js';
import { createInventoryModule } from '../../src/sut/monolith/inventory-module.js';
import { createCartModule, MemoryCartStore } from '../../src/sut/monolith/cart-module.js';
import { createOrderModule } from '../../src/sut/monolith/order-module.js';
import { createPaymentModule } from '../../src/sut/monolith/payment-module.js';
import { NullProductCache } from '../../src/sut/monolith/product-cache.js';
import { createLogger } from '../../src/utils/logger.js';
import type { SutApis } from '../../src/sut/shared/domain/types.js';

const logger = createLogger('test-invariants', 'silent');

let tpg: TestPostgres;
let pool: pg.Pool;
let db: Database;
let app: Express;
let userId: string;
let productIds: string[];

beforeAll(async () => {
  tpg = await startTestPostgres('invariants');
  pool = createPool({ connectionString: tpg.url });
  db = new Database(pool);

  const client = await pool.connect();
  try {
    await migrateSut(client);
    const dataset = generateDataset(DATASET_PROFILES.pilot);
    await loadDataset(client, dataset);
    userId = dataset.users[0]!.id;
    productIds = dataset.products.slice(0, 10).map((p) => p.id);
  } finally {
    client.release();
  }

  const auth = createAuthModule(db);
  const catalog = createCatalogModule(db, new NullProductCache());
  const inventory = createInventoryModule(db);
  const cart = createCartModule(new MemoryCartStore());
  const payments = createPaymentModule();
  const orders = createOrderModule(db, inventory, payments);
  const apis: SutApis = { auth, catalog, inventory, cart, orders, payments };

  app = createSutApp(logger);
  app.use(createBusinessRouter(apis, 'test'));
  finalizeSutApp(app, logger);
}, 60_000);

afterAll(async () => {
  await pool.end().catch(() => undefined);
  await tpg.stop();
});

const rid = { 'X-Request-Id': 'invariant-test' };

describe('INV-01: available_quantity and reserved_quantity non-negative', () => {
  it('database constraints enforce non-negative stock', async () => {
    const res = await pool.query(
      `SELECT count(*) AS n FROM inventory
       WHERE available_quantity < 0 OR reserved_quantity < 0`,
    );
    expect(Number(res.rows[0].n)).toBe(0);
  });

  it('checkout does not produce negative stock', async () => {
    // Get initial stock for first product.
    const pid = productIds[0]!;
    const invBefore = await request(app).get(`/inventory/${pid}`).set(rid);
    const avail = invBefore.body.availableQuantity;

    // Try to buy exactly the available quantity.
    if (avail > 0) {
      const qty = Math.min(avail, 5);
      await request(app)
        .post('/orders')
        .set({ ...rid, 'Idempotency-Key': `inv01-${Date.now()}` })
        .send({ userId, items: [{ productId: pid, quantity: qty }], paymentMode: 'MOCK_SUCCESS' });

      const invAfter = await request(app).get(`/inventory/${pid}`).set(rid);
      expect(invAfter.body.availableQuantity).toBeGreaterThanOrEqual(0);
      expect(invAfter.body.reservedQuantity).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('INV-02: idempotency key produces at most one order', () => {
  it('replaying same key 5 times creates exactly one order', async () => {
    const key = `inv02-replay-${Date.now()}`;
    const pid = productIds[1]!;
    const results = [];

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/orders')
        .set({ ...rid, 'Idempotency-Key': key })
        .send({ userId, items: [{ productId: pid, quantity: 1 }], paymentMode: 'MOCK_SUCCESS' });
      results.push(res);
    }

    // All should return 201 with the same order ID.
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.status === 201)).toBe(true);

    // DB should have exactly one order with this key.
    const dbRes = await pool.query(
      `SELECT count(*) AS n FROM orders WHERE idempotency_key = $1`,
      [key],
    );
    expect(Number(dbRes.rows[0].n)).toBe(1);
  });
});

describe('INV-03: total_amount = sum(quantity * unit_price)', () => {
  it('all orders satisfy the total invariant', async () => {
    const res = await pool.query(`
      SELECT o.id, o.total_amount,
             COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS computed_total
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY o.id
      HAVING ABS(o.total_amount - COALESCE(SUM(oi.quantity * oi.unit_price), 0)) > 0.01
    `);
    expect(res.rows.length).toBe(0);
  });
});

describe('INV-05: cancel releases correct stock', () => {
  it('stock is restored to pre-checkout level after cancel', async () => {
    const pid = productIds[2]!;
    const invBefore = await request(app).get(`/inventory/${pid}`).set(rid);
    const availBefore = invBefore.body.availableQuantity as number;

    const qty = 2;
    const checkoutRes = await request(app)
      .post('/orders')
      .set({ ...rid, 'Idempotency-Key': `inv05-${Date.now()}` })
      .send({ userId, items: [{ productId: pid, quantity: qty }], paymentMode: 'MOCK_SUCCESS' });
    expect(checkoutRes.status).toBe(201);
    const orderId = checkoutRes.body.id;

    // Stock should have decreased.
    const invMid = await request(app).get(`/inventory/${pid}`).set(rid);
    expect(invMid.body.availableQuantity).toBe(availBefore - qty);

    // Cancel.
    const cancelRes = await request(app).post(`/orders/${orderId}/cancel`).set(rid);
    expect(cancelRes.status).toBe(200);

    // Stock should be restored.
    const invAfter = await request(app).get(`/inventory/${pid}`).set(rid);
    expect(invAfter.body.availableQuantity).toBe(availBefore);
  });
});

describe('INV-06: concurrent checkout does not oversell', () => {
  it('N concurrent buyers for limited stock produce no negative inventory', async () => {
    const pid = productIds[3]!;

    // Set stock to a known low value.
    await pool.query(
      `UPDATE inventory SET available_quantity = 5, reserved_quantity = 0, version = version + 1
       WHERE product_id = $1`,
      [pid],
    );

    // 10 concurrent checkouts for qty 1 each (only 5 should succeed).
    const promises = Array.from({ length: 10 }, (_, i) =>
      request(app)
        .post('/orders')
        .set({ ...rid, 'Idempotency-Key': `inv06-${Date.now()}-${i}` })
        .send({ userId, items: [{ productId: pid, quantity: 1 }], paymentMode: 'MOCK_SUCCESS' }),
    );
    const results = await Promise.all(promises);

    const successes = results.filter((r) => r.status === 201);
    const failures = results.filter((r) => r.status === 409);

    // At most 5 should succeed (the available stock).
    expect(successes.length).toBeLessThanOrEqual(5);
    // Failures should be INSUFFICIENT_STOCK.
    for (const f of failures) {
      expect(f.body.code).toBe('INSUFFICIENT_STOCK');
    }

    // Verify stock is non-negative (INV-01).
    const inv = await request(app).get(`/inventory/${pid}`).set(rid);
    expect(inv.body.availableQuantity).toBeGreaterThanOrEqual(0);
    expect(inv.body.reservedQuantity).toBeGreaterThanOrEqual(0);
  });
});

describe('INV-07: terminal state does not go back to PENDING', () => {
  it('CANCELLED order cannot be re-cancelled', async () => {
    // Find a cancelled order from seed data or create one.
    const pid = productIds[4]!;
    const co = await request(app)
      .post('/orders')
      .set({ ...rid, 'Idempotency-Key': `inv07-${Date.now()}` })
      .send({ userId, items: [{ productId: pid, quantity: 1 }], paymentMode: 'MOCK_SUCCESS' });
    const oid = co.body.id;
    await request(app).post(`/orders/${oid}/cancel`).set(rid);

    // Try to cancel again.
    const res = await request(app).post(`/orders/${oid}/cancel`).set(rid);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_NOT_CANCELLABLE');
  });

  it('FAILED order cannot be cancelled', async () => {
    const pid = productIds[5]!;
    const co = await request(app)
      .post('/orders')
      .set({ ...rid, 'Idempotency-Key': `inv07-fail-${Date.now()}` })
      .send({ userId, items: [{ productId: pid, quantity: 1 }], paymentMode: 'MOCK_FAIL' });
    // Payment declined => 402, order is FAILED.
    expect(co.status).toBe(402);

    // The order was rolled back on MOCK_FAIL in the transaction, so we check
    // by querying seed data for a FAILED order instead.
    const failedRes = await pool.query<{ id: string }>(
      `SELECT id FROM orders WHERE status = 'FAILED' LIMIT 1`,
    );
    if (failedRes.rows[0]) {
      const res = await request(app).post(`/orders/${failedRes.rows[0].id}/cancel`).set(rid);
      expect(res.status).toBe(409);
    }
  });
});
