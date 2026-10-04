import type { Database } from '../../shared/database/db.js';
import type { CheckoutRequest, OrderApi, PaymentApi } from '../../shared/domain/types.js';
import { DomainError } from '../../shared/errors/domain-errors.js';
import type { DomainErrorCode } from '../../shared/errors/domain-errors.js';
import { createOrderModule } from '../../monolith/order-module.js';
import type { InventoryAction, StockItem } from '../inventory/operations.js';
import type { Logger } from '../../../utils/logger.js';

export interface RestSagaDependencies {
  inventory(action: InventoryAction, orderId: string, items: StockItem[]): Promise<void>;
  payments: PaymentApi;
}
type SagaRequest = CheckoutRequest & { totalAmount: string };
type SagaRow = { request: SagaRequest; stage: string; failure_code: DomainErrorCode | null };

export function createRestSaga(db: Database, dependencies: RestSagaDependencies): OrderApi & {
  recover(): Promise<void>;
} {
  // Reuse price validation, idempotency and order creation. The publisher here
  // persists a synchronous saga in the same transaction; it never sends AMQP.
  const orders = createOrderModule(db, undefined, dependencies.payments, undefined, {
    async publish(_key, event) {
      await db.query('saga.create', `INSERT INTO reliability.rest_sagas(order_id,request,stage)
        VALUES ($1,$2,'RESERVING')`, [event.aggregateId, JSON.stringify({
        userId: event.payload.userId, items: event.payload.items,
        paymentMode: event.payload.paymentMode, totalAmount: event.payload.totalAmount,
      })]);
    },
  });

  async function run(orderId: string, cancelling = false): Promise<void> {
    const client = await db.pool.connect();
    let locked = false;
    let destroyed = false;
    try {
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,2)) AS locked', [orderId]);
      locked = lock.rows[0]!.locked;
      if (!locked) throw new DomainError('DEPENDENCY_UNAVAILABLE');
      const found = await client.query<SagaRow>('SELECT request,stage,failure_code FROM reliability.rest_sagas WHERE order_id=$1', [orderId]);
      const saga = found.rows[0];
      if (!saga) throw new DomainError('ORDER_NOT_FOUND');
      const stage = async (value: string, failure: DomainErrorCode | null = null) => {
        await client.query('UPDATE reliability.rest_sagas SET stage=$2,failure_code=$3,updated_at=now() WHERE order_id=$1', [orderId, value, failure]);
        saga.stage = value;
        saga.failure_code = failure;
      };
      const finish = async (status: string, paymentStatus: string, value: string) => {
        await client.query('BEGIN');
        try {
          await client.query('UPDATE orders SET status=$2,payment_status=$3,updated_at=now() WHERE id=$1', [orderId, status, paymentStatus]);
          await stage(value, saga.failure_code);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      };
      if (cancelling) {
        if (saga.stage !== 'DONE' && saga.stage !== 'CANCELLING') throw new DomainError('ORDER_NOT_CANCELLABLE');
        await stage('CANCELLING');
      }
      if (saga.stage === 'RESERVING') {
        try {
          await dependencies.inventory('reserve', orderId, saga.request.items);
          await stage('PAYING');
        } catch (error) {
          if (!(error instanceof DomainError) || !['INSUFFICIENT_STOCK', 'PRODUCT_NOT_FOUND'].includes(error.code)) throw error;
          await stage('COMPENSATING', error.code as DomainErrorCode);
        }
      }
      if (saga.stage === 'PAYING') {
        try {
          const result = await dependencies.payments.charge({ orderId, amount: saga.request.totalAmount, mode: saga.request.paymentMode });
          await stage(result.status === 'PAID' ? 'COMMITTING' : 'COMPENSATING', result.status === 'PAID' ? null : 'PAYMENT_DECLINED');
        } catch (error) {
          // MOCK_TIMEOUT has no charge side effect by contract. Other transport
          // failures remain PAYING and replay the same durable payment key.
          if (saga.request.paymentMode !== 'MOCK_TIMEOUT' || !(error instanceof DomainError) || error.code !== 'DEPENDENCY_TIMEOUT') throw error;
          await stage('COMPENSATING', 'DEPENDENCY_TIMEOUT');
        }
      }
      if (saga.stage === 'COMMITTING') {
        await dependencies.inventory('commit', orderId, saga.request.items);
        await finish('CONFIRMED', 'PAID', 'DONE');
      }
      if (saga.stage === 'COMPENSATING') {
        await dependencies.inventory('release', orderId, saga.request.items);
        await finish('FAILED', 'FAILED', 'FAILED');
      }
      if (saga.stage === 'CANCELLING') {
        await dependencies.inventory('release', orderId, saga.request.items);
        await finish('CANCELLED', 'REFUNDED', 'CANCELLED');
      }
      if (saga.stage === 'FAILED') throw new DomainError(saga.failure_code ?? 'PAYMENT_DECLINED');
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,2))', [orderId]); }
        catch { client.release(true); destroyed = true; }
      }
      if (!destroyed) client.release();
    }
  }

  return {
    get: orders.get, listByUser: orders.listByUser,
    async checkout(key, request) {
      const pending = await orders.checkout(key, request);
      const saved = await db.query<SagaRow>('saga.request', 'SELECT request FROM reliability.rest_sagas WHERE order_id=$1', [pending.order.id]);
      if (saved.rows[0]?.request.paymentMode !== request.paymentMode) throw new DomainError('IDEMPOTENCY_KEY_CONFLICT');
      await run(pending.order.id);
      return { order: await orders.get(pending.order.id), outcome: 'completed', replayed: pending.replayed };
    },
    async cancel(id) { await run(id, true); return orders.get(id); },
    async recover() {
      const pending = await db.query<{ order_id: string }>('saga.pending', `SELECT order_id FROM reliability.rest_sagas
        WHERE stage NOT IN ('DONE','FAILED','CANCELLED') ORDER BY updated_at LIMIT 20`);
      let failure: unknown;
      for (const row of pending.rows) {
        try { await run(row.order_id); }
        catch (error) {
          if (!(error instanceof DomainError) || !['PAYMENT_DECLINED', 'DEPENDENCY_TIMEOUT', 'INSUFFICIENT_STOCK', 'PRODUCT_NOT_FOUND'].includes(error.code)) {
            failure = error;
            // Rotate unavailable sagas so one failed dependency does not
            // starve the rest of the recovery queue.
            await db.query('saga.defer', 'UPDATE reliability.rest_sagas SET updated_at=now() WHERE order_id=$1', [row.order_id]);
          }
        }
      }
      if (failure) throw failure;
    },
  };
}

export function startSagaRecovery(saga: { recover(): Promise<void> }, logger: Logger): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      active = saga.recover().catch((err: unknown) => logger.warn({ err }, 'Saga recovery failed')).finally(schedule);
    }, 1000);
    timer.unref();
  };
  schedule();
  return async () => { stopped = true; clearTimeout(timer); await active; };
}
