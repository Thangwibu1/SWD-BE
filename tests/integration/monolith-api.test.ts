import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type pg from 'pg';
import { startTestPostgres } from './helpers/dev-postgres.js';
import type { TestPostgres } from './helpers/dev-postgres.js';
import { Database } from '../../src/sut/shared/database/db.js';
import { createPool } from '../../src/sut/shared/database/pool.js';
import { migrateSut } from '../../src/sut/shared/database/migrator.js';
import { generateDataset, SEED_USER_PASSWORD, DATASET_PROFILES } from '../../src/sut/shared/database/seed/dataset.js';
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

const logger = createLogger('test-monolith', 'silent');

let tpg: TestPostgres;
let pool: pg.Pool;
let db: Database;
let app: Express;
let userId: string;

beforeAll(async () => {
  tpg = await startTestPostgres('monolith-api');
  pool = createPool({ connectionString: tpg.url });
  db = new Database(pool);

  // Migrate and seed with pilot data.
  const client = await pool.connect();
  try {
    await migrateSut(client);
    const dataset = generateDataset(DATASET_PROFILES.pilot);
    await loadDataset(client, dataset);
    userId = dataset.users[0]!.id;
  } finally {
    client.release();
  }

  // Wire monolith modules (A01 style — no cache).
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

const rid = { 'X-Request-Id': 'test-001' };

describe('Health', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health').set(rid);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /ready returns ready', async () => {
    const res = await request(app).get('/ready').set(rid);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });
});

describe('Auth', () => {
  it('POST /auth/login succeeds with seed credentials', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set(rid)
      .send({ email: 'user000000@bench.example', password: SEED_USER_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBeTruthy();
    expect(res.body.token).toBeTruthy();
    expect(res.body.role).toMatch(/^(customer|admin)$/);
  });

  it('POST /auth/login rejects wrong password', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set(rid)
      .send({ email: 'user000000@bench.example', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('Catalog', () => {
  it('GET /products returns paginated active products', async () => {
    const res = await request(app).get('/products?page=1&pageSize=5').set(rid);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(5);
    expect(res.body.page).toBe(1);
    expect(res.body.total).toBeGreaterThan(0);
    for (const p of res.body.items) {
      expect(p.isActive).toBe(true);
    }
  });

  it('GET /products?category= filters by category', async () => {
    const res = await request(app).get('/products?category=electronics&pageSize=5').set(rid);
    expect(res.status).toBe(200);
    for (const p of res.body.items) {
      expect(p.category).toBe('electronics');
    }
  });

  it('GET /products/:id returns a product', async () => {
    const list = await request(app).get('/products?pageSize=1').set(rid);
    const id = list.body.items[0].id;
    const res = await request(app).get(`/products/${id}`).set(rid);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  it('GET /products/:id returns 404 for missing', async () => {
    const res = await request(app).get('/products/00000000-0000-0000-0000-000000000000').set(rid);
    expect(res.status).toBe(404);
  });

  it('GET /products/search?q= searches by name/sku', async () => {
    const res = await request(app).get('/products/search?q=lamp&pageSize=5').set(rid);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Inventory', () => {
  it('GET /inventory/:productId returns stock', async () => {
    const list = await request(app).get('/products?pageSize=1').set(rid);
    const pid = list.body.items[0].id;
    const res = await request(app).get(`/inventory/${pid}`).set(rid);
    expect(res.status).toBe(200);
    expect(res.body.productId).toBe(pid);
    expect(res.body.availableQuantity).toBeGreaterThanOrEqual(0);
    expect(res.body.reservedQuantity).toBeGreaterThanOrEqual(0);
  });
});

describe('Cart', () => {
  it('GET /cart returns empty cart', async () => {
    const res = await request(app)
      .get('/cart')
      .set({ ...rid, 'X-User-Id': userId });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userId);
    expect(res.body.items).toEqual([]);
  });

  it('POST /cart/items adds item', async () => {
    const list = await request(app).get('/products?pageSize=1').set(rid);
    const pid = list.body.items[0].id;
    const res = await request(app)
      .post('/cart/items')
      .set({ ...rid, 'X-User-Id': userId })
      .send({ productId: pid, quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].productId).toBe(pid);
    expect(res.body.items[0].quantity).toBe(2);
  });

  it('DELETE /cart/items/:productId removes item', async () => {
    const list = await request(app).get('/products?pageSize=1').set(rid);
    const pid = list.body.items[0].id;
    const res = await request(app)
      .delete(`/cart/items/${pid}`)
      .set({ ...rid, 'X-User-Id': userId });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('Checkout & Orders', () => {
  let productId: string;
  let orderId: string;

  beforeAll(async () => {
    const list = await request(app).get('/products?pageSize=1').set(rid);
    productId = list.body.items[0].id;
  });

  it('POST /orders creates order with 201', async () => {
    const res = await request(app)
      .post('/orders')
      .set({ ...rid, 'Idempotency-Key': 'idem-test-001' })
      .send({
        userId,
        items: [{ productId, quantity: 1 }],
        paymentMode: 'MOCK_SUCCESS',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe('CONFIRMED');
    expect(res.body.paymentStatus).toBe('PAID');
    expect(res.body.items).toHaveLength(1);
    orderId = res.body.id;
  });

  it('POST /orders with same Idempotency-Key returns replay (INV-02)', async () => {
    const res = await request(app)
      .post('/orders')
      .set({ ...rid, 'Idempotency-Key': 'idem-test-001' })
      .send({
        userId,
        items: [{ productId, quantity: 1 }],
        paymentMode: 'MOCK_SUCCESS',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(orderId);
  });

  it('POST /orders with same Idempotency-Key but different payload rejects (INV-02)', async () => {
    const list = await request(app).get('/products?pageSize=2').set(rid);
    const otherProductId = list.body.items[1]?.id ?? productId;
    const res = await request(app)
      .post('/orders')
      .set({ ...rid, 'Idempotency-Key': 'idem-test-001' })
      .send({
        userId,
        items: [{ productId: otherProductId, quantity: 5 }],
        paymentMode: 'MOCK_SUCCESS',
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('GET /orders/:id returns order', async () => {
    const res = await request(app).get(`/orders/${orderId}`).set(rid);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(orderId);
    expect(res.body.status).toBe('CONFIRMED');
  });

  it('GET /users/:id/orders returns order history', async () => {
    const res = await request(app).get(`/users/${userId}/orders?page=1&pageSize=10`).set(rid);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('POST /orders/:id/cancel cancels CONFIRMED order and releases stock (INV-05)', async () => {
    // Get stock before cancel.
    const invBefore = await request(app).get(`/inventory/${productId}`).set(rid);
    const availBefore = invBefore.body.availableQuantity;

    const res = await request(app).post(`/orders/${orderId}/cancel`).set(rid);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.paymentStatus).toBe('REFUNDED');

    // Stock should have been returned.
    const invAfter = await request(app).get(`/inventory/${productId}`).set(rid);
    expect(invAfter.body.availableQuantity).toBe(availBefore + 1);
  });

  it('POST /orders/:id/cancel rejects already cancelled', async () => {
    const res = await request(app).post(`/orders/${orderId}/cancel`).set(rid);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_NOT_CANCELLABLE');
  });

  it('POST /orders with MOCK_FAIL returns 402', async () => {
    const res = await request(app)
      .post('/orders')
      .set({ ...rid, 'Idempotency-Key': 'idem-fail-001' })
      .send({
        userId,
        items: [{ productId, quantity: 1 }],
        paymentMode: 'MOCK_FAIL',
      });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('PAYMENT_DECLINED');
  });

  it('POST /orders without Idempotency-Key rejects', async () => {
    const res = await request(app)
      .post('/orders')
      .set(rid)
      .send({
        userId,
        items: [{ productId, quantity: 1 }],
        paymentMode: 'MOCK_SUCCESS',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('Payment Mock', () => {
  it('POST /payments/mock returns result', async () => {
    const res = await request(app)
      .post('/payments/mock')
      .set(rid)
      .send({
        orderId: '00000000-0000-0000-0000-000000000001',
        amount: '10.00',
        mode: 'MOCK_SUCCESS',
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PAID');
    expect(res.body.duplicate).toBe(false);
  });

  it('POST /payments/mock returns duplicate on replay (INV-04)', async () => {
    const res = await request(app)
      .post('/payments/mock')
      .set(rid)
      .send({
        orderId: '00000000-0000-0000-0000-000000000001',
        amount: '10.00',
        mode: 'MOCK_SUCCESS',
      });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
  });
});

describe('404 handling', () => {
  it('unknown route returns 404 with envelope', async () => {
    const res = await request(app).get('/unknown-route').set(rid);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
