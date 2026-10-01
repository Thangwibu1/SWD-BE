import { Router } from 'express';
import type { SutApis } from '../domain/types.js';
import { DomainError } from '../errors/domain-errors.js';
import { asyncHandler } from '../http/sut-http.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new DomainError('VALIDATION_FAILED', { field, reason: 'invalid uuid' });
  }
  return value;
}

function pageParams(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Math.max(1, Math.trunc(Number(query.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(query.pageSize) || 20)));
  return { page, pageSize };
}

/**
 * Express router with all 15 SUT endpoints (guide §8). The router depends only
 * on SutApis so it works unchanged for the monolith, REST gateway and event
 * gateway — each family supplies a different implementation of SutApis.
 */
export function createBusinessRouter(apis: SutApis, service: string): Router {
  const r = Router();

  // 1. POST /auth/login
  r.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
        throw new DomainError('VALIDATION_FAILED', { field: 'email|password' });
      }
      const result = await apis.auth.login(email, password);
      res.json(result);
    }),
  );

  // 2. GET /products
  r.get(
    '/products',
    asyncHandler(async (req, res) => {
      const { page, pageSize } = pageParams(req.query as Record<string, unknown>);
      const category =
        typeof req.query.category === 'string' && req.query.category.length > 0
          ? req.query.category
          : null;
      res.json(await apis.catalog.list({ category, page, pageSize }));
    }),
  );

  // 4. GET /products/search — must be registered before /products/:id
  r.get(
    '/products/search',
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (q.length === 0) {
        throw new DomainError('VALIDATION_FAILED', { field: 'q', reason: 'required' });
      }
      const { page, pageSize } = pageParams(req.query as Record<string, unknown>);
      res.json(await apis.catalog.search({ q, page, pageSize }));
    }),
  );

  // 3. GET /products/:id
  r.get(
    '/products/:id',
    asyncHandler(async (req, res) => {
      const id = requireUuid(req.params.id, 'id');
      res.json(await apis.catalog.get(id));
    }),
  );

  // 5. GET /inventory/:productId
  r.get(
    '/inventory/:productId',
    asyncHandler(async (req, res) => {
      const productId = requireUuid(req.params.productId, 'productId');
      res.json(await apis.inventory.get(productId));
    }),
  );

  // 6. POST /cart/items
  r.post(
    '/cart/items',
    asyncHandler(async (req, res) => {
      const userId = requireUuid(req.headers['x-user-id'], 'X-User-Id');
      const { productId, quantity } = req.body as { productId?: string; quantity?: number };
      if (!productId || typeof productId !== 'string' || !UUID_RE.test(productId)) {
        throw new DomainError('VALIDATION_FAILED', { field: 'productId' });
      }
      if (typeof quantity !== 'number' || quantity < 1 || quantity > 100 || !Number.isInteger(quantity)) {
        throw new DomainError('VALIDATION_FAILED', { field: 'quantity' });
      }
      res.json(await apis.cart.upsert(userId, productId, quantity));
    }),
  );

  // 7. GET /cart
  r.get(
    '/cart',
    asyncHandler(async (req, res) => {
      const userId = requireUuid(req.headers['x-user-id'], 'X-User-Id');
      res.json(await apis.cart.get(userId));
    }),
  );

  // 8. DELETE /cart/items/:productId
  r.delete(
    '/cart/items/:productId',
    asyncHandler(async (req, res) => {
      const userId = requireUuid(req.headers['x-user-id'], 'X-User-Id');
      const productId = requireUuid(req.params.productId, 'productId');
      res.json(await apis.cart.remove(userId, productId));
    }),
  );

  // 9. POST /orders (checkout)
  r.post(
    '/orders',
    asyncHandler(async (req, res) => {
      const idempotencyKey = req.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        throw new DomainError('IDEMPOTENCY_KEY_REQUIRED');
      }
      const body = req.body as { userId?: string; items?: unknown; paymentMode?: string };
      if (!body.userId || typeof body.userId !== 'string') {
        throw new DomainError('VALIDATION_FAILED', { field: 'userId' });
      }
      if (!Array.isArray(body.items) || body.items.length === 0) {
        throw new DomainError('VALIDATION_FAILED', { field: 'items', reason: 'non-empty array' });
      }
      const validModes = ['MOCK_SUCCESS', 'MOCK_FAIL', 'MOCK_TIMEOUT'] as const;
      if (!validModes.includes(body.paymentMode as (typeof validModes)[number])) {
        throw new DomainError('VALIDATION_FAILED', { field: 'paymentMode' });
      }
      const result = await apis.orders.checkout(idempotencyKey, {
        userId: body.userId,
        items: body.items as Array<{ productId: string; quantity: number }>,
        paymentMode: body.paymentMode as (typeof validModes)[number],
      });
      const status = result.outcome === 'accepted' ? 202 : 201;
      res.status(status).json(result.order);
    }),
  );

  // 10. GET /orders/:id
  r.get(
    '/orders/:id',
    asyncHandler(async (req, res) => {
      const id = requireUuid(req.params.id, 'id');
      res.json(await apis.orders.get(id));
    }),
  );

  // 11. GET /users/:id/orders
  r.get(
    '/users/:id/orders',
    asyncHandler(async (req, res) => {
      const userId = requireUuid(req.params.id, 'id');
      const { page, pageSize } = pageParams(req.query as Record<string, unknown>);
      res.json(await apis.orders.listByUser(userId, page, pageSize));
    }),
  );

  // 12. POST /payments/mock
  r.post(
    '/payments/mock',
    asyncHandler(async (req, res) => {
      const body = req.body as { orderId?: string; amount?: string; mode?: string };
      if (!body.orderId || !UUID_RE.test(body.orderId)) {
        throw new DomainError('VALIDATION_FAILED', { field: 'orderId' });
      }
      if (typeof body.amount !== 'string' || !/^\d+\.\d{2}$/.test(body.amount)) {
        throw new DomainError('VALIDATION_FAILED', { field: 'amount' });
      }
      const validModes = ['MOCK_SUCCESS', 'MOCK_FAIL', 'MOCK_TIMEOUT'] as const;
      if (!validModes.includes(body.mode as (typeof validModes)[number])) {
        throw new DomainError('VALIDATION_FAILED', { field: 'mode' });
      }
      res.json(
        await apis.payments.charge({
          orderId: body.orderId,
          amount: body.amount,
          mode: body.mode as (typeof validModes)[number],
        }),
      );
    }),
  );

  // 13. POST /orders/:id/cancel
  r.post(
    '/orders/:id/cancel',
    asyncHandler(async (req, res) => {
      const id = requireUuid(req.params.id, 'id');
      res.json(await apis.orders.cancel(id));
    }),
  );

  // 14. GET /health
  r.get('/health', (_req, res) => {
    res.json({ status: 'ok', service });
  });

  // 15. GET /ready — each family sets up readiness checks in its bootstrap.
  //     Default: basic health = ok.
  r.get('/ready', (_req, res) => {
    res.json({ status: 'ready', checks: [{ name: 'default', ok: true }] });
  });

  return r;
}
