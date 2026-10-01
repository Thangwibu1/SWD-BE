import { randomUUID } from 'node:crypto';
import type { PaymentApi, PaymentRequest, PaymentResult } from '../shared/domain/types.js';
import { DomainError } from '../shared/errors/domain-errors.js';

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
export function createPaymentModule(): PaymentApi {
  /** In-memory ledger for INV-04 idempotency. */
  const ledger = new Map<string, PaymentResult>();

  return {
    async charge(request: PaymentRequest): Promise<PaymentResult> {
      const existing = ledger.get(request.orderId);
      if (existing) {
        return { ...existing, duplicate: true };
      }

      if (request.mode === 'MOCK_TIMEOUT') {
        await new Promise((r) => setTimeout(r, 6_000));
        throw new DomainError('DEPENDENCY_TIMEOUT');
      }

      const result: PaymentResult = {
        paymentId: randomUUID(),
        orderId: request.orderId,
        status: request.mode === 'MOCK_SUCCESS' ? 'PAID' : 'FAILED',
        duplicate: false,
      };

      ledger.set(request.orderId, result);
      return result;
    },
  };
}
