import { createHash } from 'node:crypto';
import type { PaymentApi, PaymentRequest, PaymentResult } from '../shared/domain/types.js';
import { DomainError } from '../shared/errors/domain-errors.js';
import type { Database } from '../shared/database/db.js';

/**
 * Configurable payment mock (guide §8, endpoint 12).
 *
 * - MOCK_SUCCESS → PAID immediately.
 * - MOCK_FAIL → FAILED immediately.
 * - MOCK_TIMEOUT → DomainError DEPENDENCY_TIMEOUT after a delay.
 *
 * INV-04: An orderId that was already charged returns the same result with
 * `duplicate: true` — at most one successful charge per order.
 */
export function createPaymentModule(db?: Database): PaymentApi {
  /** In-memory ledger for INV-04 idempotency. */
  const ledger = new Map<string, PaymentResult>();

  return {
    async charge(request: PaymentRequest): Promise<PaymentResult> {
      if (db) {
        if (request.mode === 'MOCK_TIMEOUT') {
          await new Promise((r) => setTimeout(r, 6_000));
          throw new DomainError('DEPENDENCY_TIMEOUT');
        }
        return db.transaction(async (tx) => {
          const result: PaymentResult = {
            paymentId: deterministicPaymentId(request.orderId), orderId: request.orderId,
            status: request.mode === 'MOCK_SUCCESS' ? 'PAID' : 'FAILED', duplicate: false,
          };
          const inserted = await tx.query('payment.record', `INSERT INTO reliability.payments(order_id,request,result)
            VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING order_id`,
          [request.orderId, JSON.stringify(request), JSON.stringify(result)]);
          if (inserted.rowCount) return result;
          const existing = await tx.query<{ request: PaymentRequest; result: PaymentResult }>('payment.replay',
            'SELECT request,result FROM reliability.payments WHERE order_id=$1', [request.orderId]);
          const previous = existing.rows[0]!;
          if (previous.request.amount !== request.amount || previous.request.mode !== request.mode) {
            throw new DomainError('PAYMENT_ALREADY_PROCESSED');
          }
          return { ...previous.result, duplicate: true };
        });
      }
      const existing = ledger.get(request.orderId);
      if (existing) {
        return { ...existing, duplicate: true };
      }

      if (request.mode === 'MOCK_TIMEOUT') {
        await new Promise((r) => setTimeout(r, 6_000));
        throw new DomainError('DEPENDENCY_TIMEOUT');
      }

      const result: PaymentResult = {
        paymentId: deterministicPaymentId(request.orderId),
        orderId: request.orderId,
        status: request.mode === 'MOCK_SUCCESS' ? 'PAID' : 'FAILED',
        duplicate: false,
      };

      ledger.set(request.orderId, result);
      return result;
    },
  };
}

function deterministicPaymentId(orderId: string): string {
  const hex = createHash('sha256').update(`payment:${orderId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
