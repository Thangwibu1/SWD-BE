import { randomUUID } from 'node:crypto';
import type { Database } from '../shared/database/db.js';
import type { CheckoutRequest, CartApi, CartLine, PaymentResult } from '../shared/domain/types.js';
import { DomainError } from '../shared/errors/domain-errors.js';
import { createOrderModule } from './order-module.js';
import { createInventoryModule } from './inventory-module.js';
import { createPaymentModule } from './payment-module.js';
import { createCartModule } from './cart-module.js';

type JobRequest = CheckoutRequest & { totalAmount: string };
type Job = { order_id: string; request: JobRequest; lease_token: string; attempts: number };

/** The queue write, order and stock reservation commit as one local transaction. */
export function createPgQueueOrders(db: Database) {
  const inventory = createInventoryModule(db);
  const orders = createOrderModule(db, inventory, createPaymentModule(db), undefined, {
    async publish(key, event) {
      if (key !== 'order.created') return;
      const items = [...event.payload.items].sort((a, b) => a.productId.localeCompare(b.productId));
      await inventory.reserveStock(db, items);
      await db.query('queue.reserve', 'UPDATE orders SET inventory_reserved=true WHERE id=$1', [
        event.aggregateId,
      ]);
      await db.query(
        'queue.enqueue',
        `INSERT INTO reliability.queue_jobs(order_id,request)
        VALUES ($1,$2)`,
        [
          event.aggregateId,
          JSON.stringify({
            userId: event.payload.userId,
            items,
            paymentMode: event.payload.paymentMode,
            totalAmount: event.payload.totalAmount,
          }),
        ],
      );
    },
  });
  return {
    ...orders,
    checkout: (key: string, request: CheckoutRequest) =>
      db.transaction(async (tx) => {
        const result = await orders.checkout(key, {
          ...request,
          items: [...request.items].sort((a, b) => a.productId.localeCompare(b.productId)),
        });
        const stored = await tx.query<{ request: JobRequest }>(
          'queue.replay.request',
          'SELECT request FROM reliability.queue_jobs WHERE order_id=$1',
          [result.order.id],
        );
        if (stored.rows[0]?.request.paymentMode !== request.paymentMode)
          throw new DomainError('IDEMPOTENCY_KEY_CONFLICT');
        return result;
      }),
  };
}

/** Shared carts without Redis, with atomic read/modify/write across API replicas. */
export function createPgCart(db: Database): CartApi {
  const cart = createCartModule({
    async get(userId) {
      const result = await db.query<{ items: CartLine[] }>(
        'cart.read',
        'SELECT items FROM reliability.carts WHERE user_id=$1',
        [userId],
      );
      return result.rows[0]?.items ?? [];
    },
    async set(userId, items) {
      await db.query(
        'cart.write',
        `INSERT INTO reliability.carts(user_id,items) VALUES ($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET items=EXCLUDED.items`,
        [userId, JSON.stringify(items)],
      );
    },
    async clear(userId) {
      await db.query('cart.clear', 'DELETE FROM reliability.carts WHERE user_id=$1', [userId]);
    },
  });
  const locked = <T>(userId: string, action: () => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.query('cart.lock', 'SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [userId]);
      return action();
    });
  return {
    get: cart.get,
    upsert: (user, product, quantity) => locked(user, () => cart.upsert(user, product, quantity)),
    remove: (user, product) => locked(user, () => cart.remove(user, product)),
  };
}

export async function claimQueueJob(db: Database): Promise<Job | undefined> {
  const result = await db.query<Job>(
    'queue.claim',
    `UPDATE reliability.queue_jobs SET
    state='PROCESSING', lease_until=now()+interval '30 seconds', lease_token=$1, attempts=attempts+1
    WHERE order_id=(SELECT order_id FROM reliability.queue_jobs
      WHERE (state='PENDING' AND available_at<=now()) OR (state='PROCESSING' AND lease_until<now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    [randomUUID()],
  );
  return result.rows[0];
}

/** A stale lease may replay the durable payment but cannot finalize another worker's job. */
export async function processQueueJob(db: Database, job: Job): Promise<void> {
  let payment: PaymentResult | undefined;
  try {
    payment = await createPaymentModule(db).charge({
      orderId: job.order_id,
      amount: job.request.totalAmount,
      mode: job.request.paymentMode,
    });
  } catch (error) {
    if (
      !(error instanceof DomainError) ||
      error.code !== 'DEPENDENCY_TIMEOUT' ||
      job.request.paymentMode !== 'MOCK_TIMEOUT'
    ) {
      await db.query(
        'queue.retry',
        `UPDATE reliability.queue_jobs SET state='PENDING', lease_until=NULL,
        available_at=now()+($3 * interval '1 second') WHERE order_id=$1 AND lease_token=$2 AND state='PROCESSING'`,
        [job.order_id, job.lease_token, Math.min(30, 2 ** Math.min(job.attempts, 5))],
      );
      throw error;
    }
  }
  const inventory = createInventoryModule(db);
  await db.transaction(async (tx) => {
    const owned = await tx.query(
      'queue.fence',
      `SELECT order_id FROM reliability.queue_jobs
      WHERE order_id=$1 AND lease_token=$2 AND state='PROCESSING' FOR UPDATE`,
      [job.order_id, job.lease_token],
    );
    if (!owned.rowCount) return;
    const order = await tx.query<{ status: string }>(
      'queue.order.lock',
      'SELECT status FROM orders WHERE id=$1 FOR UPDATE',
      [job.order_id],
    );
    if (order.rows[0]?.status === 'PENDING') {
      const paid = payment?.status === 'PAID';
      if (paid) await inventory.commitStock(tx, job.request.items);
      else await inventory.releaseStock(tx, job.request.items);
      await tx.query(
        'queue.finalize',
        `UPDATE orders SET status=$2,payment_status=$3,
        inventory_reserved=false,inventory_committed=$4,updated_at=now() WHERE id=$1`,
        [job.order_id, paid ? 'CONFIRMED' : 'FAILED', paid ? 'PAID' : 'FAILED', paid],
      );
    }
    await tx.query(
      'queue.ack',
      `UPDATE reliability.queue_jobs SET state='DONE',lease_until=NULL
      WHERE order_id=$1 AND lease_token=$2`,
      [job.order_id, job.lease_token],
    );
  });
}
