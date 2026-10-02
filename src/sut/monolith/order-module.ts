import type { Database, SqlExecutor } from '../shared/database/db.js';
import type {
  CheckoutRequest,
  CheckoutResult,
  Order,
  OrderApi,
  OrderSummary,
  Page,
  PaymentApi,
} from '../shared/domain/types.js';
import { fromCents, orderTotalCents } from '../shared/domain/money.js';
import {
  assertUniqueItems,
  isCancellable,
  isSameCheckout,
  MAX_CHECKOUT_LINES,
} from '../shared/domain/order-rules.js';
import type { OrderStatus, PaymentStatus } from '../shared/domain/order-rules.js';
import { DomainError } from '../shared/errors/domain-errors.js';
import type { InventoryTxOps } from './inventory-module.js';

/**
 * Order module — checkout, query, cancel.
 *
 * The monolith runs checkout within a single PostgreSQL transaction that
 * spans inventory reservation, order creation, payment and confirmation.
 * This is the key structural difference vs REST (distributed calls) and
 * event-driven (saga with compensation).
 */
export interface EventPublisher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publish(routingKey: string, event: Omit<any, 'eventId' | 'occurredAt' | 'schemaVersion'>): Promise<void>;
}

export type NotificationSender = (orderId: string) => void;

export function createOrderModule(
  db: Database,
  inventoryTx: InventoryTxOps,
  payments: PaymentApi,
  sendNotification?: NotificationSender,
  publisher?: EventPublisher,
): OrderApi {
  return {
    async checkout(idempotencyKey, request): Promise<CheckoutResult> {
      if (publisher) {
        return checkoutAsync(db, publisher, idempotencyKey, request);
      }
      return checkoutInTransaction(db, inventoryTx, payments, idempotencyKey, request, sendNotification);
    },

    async get(orderId): Promise<Order> {
      return getOrder(db, orderId);
    },

    async listByUser(userId, page, pageSize): Promise<Page<OrderSummary>> {
      const offset = (page - 1) * pageSize;
      const countRes = await db.query<{ cnt: string }>(
        'order.listByUser.count',
        `SELECT count(*)::text AS cnt FROM orders WHERE user_id = $1`,
        [userId],
      );
      const total = Number(countRes.rows[0]?.cnt ?? 0);
      const dataRes = await db.query<OrderDbRow>(
        'order.listByUser',
        `SELECT id, user_id, status, payment_status, total_amount, created_at, updated_at
         FROM orders WHERE user_id = $1
         ORDER BY created_at DESC, id
         LIMIT $2 OFFSET $3`,
        [userId, pageSize, offset],
      );
      return {
        items: dataRes.rows.map(toSummary),
        page,
        pageSize,
        total,
      };
    },

    async cancel(orderId): Promise<Order> {
      return cancelOrder(db, inventoryTx, orderId);
    },
  };
}

// ─── Checkout ──────────────────────────────────────────────────────────

async function checkoutInTransaction(
  db: Database,
  inventoryTx: InventoryTxOps,
  payments: PaymentApi,
  idempotencyKey: string,
  request: CheckoutRequest,
  sendNotification?: NotificationSender,
): Promise<CheckoutResult> {
  assertUniqueItems(request.items);
  if (request.items.length > MAX_CHECKOUT_LINES) {
    throw new DomainError('VALIDATION_FAILED', { field: 'items', reason: `max ${MAX_CHECKOUT_LINES}` });
  }

  return db.transaction(async (tx) => {
    // Idempotency replay: look up existing order with same key.
    const existing = await tx.query<OrderDbRow & { items_json: string }>(
      'order.idempotency',
      `SELECT o.*, json_agg(json_build_object(
         'productId', oi.product_id, 'quantity', oi.quantity, 'unitPrice', oi.unit_price
       ) ORDER BY oi.product_id) AS items_json
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.idempotency_key = $1
       GROUP BY o.id`,
      [idempotencyKey],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const storedItems: Array<{ productId: string; quantity: number }> = JSON.parse(
        typeof row.items_json === 'string' ? row.items_json : JSON.stringify(row.items_json),
      ) as Array<{ productId: string; quantity: number }>;
      if (!isSameCheckout({ userId: row.user_id, items: storedItems }, request)) {
        throw new DomainError('IDEMPOTENCY_KEY_CONFLICT');
      }
      return { order: await getOrderFromTx(tx, row.id), outcome: 'completed' as const, replayed: true };
    }

    // Look up unit prices for the ordered products.
    const productIds = request.items.map((i) => i.productId);
    const priceRes = await tx.query<{ id: string; price: string; is_active: boolean }>(
      'order.lookupPrices',
      `SELECT id, price, is_active FROM products WHERE id = ANY($1)`,
      [productIds],
    );
    const priceMap = new Map(priceRes.rows.map((r) => [r.id, r]));
    const itemsWithPrice: Array<{ productId: string; quantity: number; unitPrice: string }> = [];
    for (const item of request.items) {
      const product = priceMap.get(item.productId);
      if (!product) throw new DomainError('PRODUCT_NOT_FOUND');
      if (!product.is_active) throw new DomainError('PRODUCT_INACTIVE');
      itemsWithPrice.push({ productId: item.productId, quantity: item.quantity, unitPrice: product.price });
    }

    // Reserve inventory (SELECT FOR UPDATE inside the same transaction).
    await inventoryTx.reserveStock(tx, request.items);

    // Compute total (INV-03: total_amount = sum(quantity * unit_price)).
    const totalCents = orderTotalCents(itemsWithPrice);
    const totalAmount = fromCents(totalCents);

    // Create order with status PENDING.
    const orderRes = await tx.query<{ id: string; created_at: string; updated_at: string }>(
      'order.create',
      `INSERT INTO orders (user_id, status, payment_status, total_amount, idempotency_key)
       VALUES ($1, 'PENDING', 'PENDING', $2, $3)
       RETURNING id, created_at, updated_at`,
      [request.userId, totalAmount, idempotencyKey],
    );
    const orderId = orderRes.rows[0]!.id;

    // Insert order items.
    for (const item of itemsWithPrice) {
      await tx.query(
        'order.createItem',
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [orderId, item.productId, item.quantity, item.unitPrice],
      );
    }

    // Process payment (synchronous mock).
    const paymentResult = await payments.charge({
      orderId,
      amount: totalAmount,
      mode: request.paymentMode,
    });

    // Transition based on payment result.
    if (paymentResult.status === 'PAID') {
      await tx.query('order.confirm', `UPDATE orders SET status = 'CONFIRMED', payment_status = 'PAID', updated_at = now() WHERE id = $1`, [orderId]);
      await inventoryTx.commitStock(tx, request.items);
      // Fire-and-forget notification (A04)
      if (sendNotification && !existing?.rows[0]) {
        sendNotification(orderId);
      }
    } else {
      await tx.query('order.fail', `UPDATE orders SET status = 'FAILED', payment_status = 'FAILED', updated_at = now() WHERE id = $1`, [orderId]);
      await inventoryTx.releaseStock(tx, request.items);
      throw new DomainError('PAYMENT_DECLINED');
    }

    return { order: await getOrderFromTx(tx, orderId), outcome: 'completed' as const, replayed: false };
  });
}

// ─── Async Checkout (Event-Driven) ──────────────────────────────────────

async function checkoutAsync(
  db: Database,
  publisher: EventPublisher,
  idempotencyKey: string,
  request: CheckoutRequest,
): Promise<CheckoutResult> {
  assertUniqueItems(request.items);
  if (request.items.length > MAX_CHECKOUT_LINES) {
    throw new DomainError('VALIDATION_FAILED', { field: 'items', reason: `max ${MAX_CHECKOUT_LINES}` });
  }

  return db.transaction(async (tx) => {
    // Idempotency replay
    const existing = await tx.query<OrderDbRow & { items_json: string }>(
      'order.idempotency',
      `SELECT o.*, json_agg(json_build_object(
         'productId', oi.product_id, 'quantity', oi.quantity, 'unitPrice', oi.unit_price
       ) ORDER BY oi.product_id) AS items_json
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.idempotency_key = $1
       GROUP BY o.id`,
      [idempotencyKey],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const storedItems: Array<{ productId: string; quantity: number }> = JSON.parse(
        typeof row.items_json === 'string' ? row.items_json : JSON.stringify(row.items_json),
      ) as Array<{ productId: string; quantity: number }>;
      if (!isSameCheckout({ userId: row.user_id, items: storedItems }, request)) {
        throw new DomainError('IDEMPOTENCY_KEY_CONFLICT');
      }
      return { order: await getOrderFromTx(tx, row.id), outcome: 'accepted' as const, replayed: true };
    }

    // Look up unit prices
    const productIds = request.items.map((i) => i.productId);
    const priceRes = await tx.query<{ id: string; price: string; is_active: boolean }>(
      'order.lookupPrices',
      `SELECT id, price, is_active FROM products WHERE id = ANY($1)`,
      [productIds],
    );
    const priceMap = new Map(priceRes.rows.map((r) => [r.id, r]));
    const itemsWithPrice: Array<{ productId: string; quantity: number; unitPrice: string }> = [];
    for (const item of request.items) {
      const product = priceMap.get(item.productId);
      if (!product) throw new DomainError('PRODUCT_NOT_FOUND');
      if (!product.is_active) throw new DomainError('PRODUCT_INACTIVE');
      itemsWithPrice.push({ productId: item.productId, quantity: item.quantity, unitPrice: product.price });
    }

    const totalCents = orderTotalCents(itemsWithPrice);
    const totalAmount = fromCents(totalCents);

    const orderRes = await tx.query<{ id: string; created_at: string; updated_at: string }>(
      'order.create',
      `INSERT INTO orders (user_id, status, payment_status, total_amount, idempotency_key)
       VALUES ($1, 'PENDING', 'PENDING', $2, $3)
       RETURNING id, created_at, updated_at`,
      [request.userId, totalAmount, idempotencyKey],
    );
    const orderId = orderRes.rows[0]!.id;

    for (const item of itemsWithPrice) {
      await tx.query(
        'order.createItem',
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [orderId, item.productId, item.quantity, item.unitPrice],
      );
    }

    const order = await getOrderFromTx(tx, orderId);

    // Publish event
    await publisher.publish('order.created', {
      eventType: 'order.created',
      aggregateId: orderId,
      correlationId: '',
      payload: {
        orderId,
        userId: request.userId,
        items: itemsWithPrice,
        totalAmount,
        paymentMode: request.paymentMode,
      },
    });

    return { order, outcome: 'accepted' as const, replayed: false };
  });
}

// ─── Cancel ────────────────────────────────────────────────────────────

async function cancelOrder(
  db: Database,
  inventoryTx: InventoryTxOps,
  orderId: string,
): Promise<Order> {
  return db.transaction(async (tx) => {
    const orderRes = await tx.query<OrderDbRow>(
      'order.lockForCancel',
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const row = orderRes.rows[0];
    if (!row) throw new DomainError('ORDER_NOT_FOUND');
    if (!isCancellable(row.status as OrderStatus)) {
      throw new DomainError('ORDER_NOT_CANCELLABLE');
    }

    // Get items for stock release (INV-05).
    const itemsRes = await tx.query<{ product_id: string; quantity: number }>(
      'order.cancelItems',
      `SELECT product_id, quantity FROM order_items WHERE order_id = $1`,
      [orderId],
    );
    const items = itemsRes.rows.map((r) => ({ productId: r.product_id, quantity: r.quantity }));

    await tx.query(
      'order.cancel',
      `UPDATE orders SET status = 'CANCELLED', payment_status = 'REFUNDED', updated_at = now() WHERE id = $1`,
      [orderId],
    );

    // Release stock back to available.
    await inventoryTx.releaseStock(tx, items);

    return getOrderFromTx(tx, orderId);
  });
}

// ─── Queries ───────────────────────────────────────────────────────────

async function getOrder(db: Database, orderId: string): Promise<Order> {
  return getOrderFromTx(db, orderId);
}

async function getOrderFromTx(tx: SqlExecutor, orderId: string): Promise<Order> {
  const orderRes = await tx.query<OrderDbRow>(
    'order.get',
    `SELECT id, user_id, status, payment_status, total_amount, created_at, updated_at
     FROM orders WHERE id = $1`,
    [orderId],
  );
  const row = orderRes.rows[0];
  if (!row) throw new DomainError('ORDER_NOT_FOUND');

  const itemsRes = await tx.query<{ product_id: string; quantity: number; unit_price: string }>(
    'order.getItems',
    `SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY product_id`,
    [orderId],
  );
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status as OrderStatus,
    paymentStatus: row.payment_status as PaymentStatus,
    totalAmount: row.total_amount,
    items: itemsRes.rows.map((r) => ({
      productId: r.product_id,
      quantity: r.quantity,
      unitPrice: r.unit_price,
    })),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

interface OrderDbRow {
  id: string;
  user_id: string;
  status: string;
  payment_status: string;
  total_amount: string;
  idempotency_key?: string;
  created_at: string;
  updated_at: string;
}

function toSummary(row: OrderDbRow): OrderSummary {
  return {
    id: row.id,
    status: row.status as OrderStatus,
    paymentStatus: row.payment_status as PaymentStatus,
    totalAmount: row.total_amount,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
