import { AppError } from '../../../utils/errors.js';

/**
 * Domain error catalogue shared by every SUT role. The `code` is part of the
 * public contract (openapi ErrorEnvelope) and must be identical across the
 * monolith, REST and event-driven families so k6 classifies errors the same way.
 */
export const DOMAIN_ERRORS = {
  VALIDATION_FAILED: { status: 400, message: 'Request validation failed' },
  INVALID_CREDENTIALS: { status: 401, message: 'Invalid email or password' },
  USER_NOT_FOUND: { status: 404, message: 'User not found' },
  PRODUCT_NOT_FOUND: { status: 404, message: 'Product not found' },
  PRODUCT_INACTIVE: { status: 409, message: 'Product is not active' },
  ORDER_NOT_FOUND: { status: 404, message: 'Order not found' },
  CART_ITEM_NOT_FOUND: { status: 404, message: 'Cart item not found' },
  CART_EMPTY: { status: 409, message: 'Cart is empty' },
  INSUFFICIENT_STOCK: { status: 409, message: 'Insufficient stock' },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, message: 'Idempotency-Key header is required' },
  IDEMPOTENCY_KEY_CONFLICT: {
    status: 409,
    message: 'Idempotency-Key was used with a different request',
  },
  ORDER_NOT_CANCELLABLE: { status: 409, message: 'Order cannot be cancelled in its current state' },
  PAYMENT_DECLINED: { status: 402, message: 'Payment declined' },
  PAYMENT_ALREADY_PROCESSED: { status: 409, message: 'Payment already processed for this order' },
  DEPENDENCY_TIMEOUT: { status: 504, message: 'Downstream dependency timed out' },
  DEPENDENCY_UNAVAILABLE: { status: 503, message: 'Downstream dependency unavailable' },
  NOT_FOUND: { status: 404, message: 'Route not found' },
  INTERNAL_ERROR: { status: 500, message: 'Unexpected server error' },
} as const satisfies Record<string, { status: number; message: string }>;

export type DomainErrorCode = keyof typeof DOMAIN_ERRORS;

export class DomainError extends AppError {
  constructor(code: DomainErrorCode, details: unknown = null, message?: string) {
    const def = DOMAIN_ERRORS[code];
    super(def.status, code, message ?? def.message, details);
    this.name = 'DomainError';
  }
}

/**
 * Business errors are expected outcomes (e.g. stock exhausted during a flash
 * sale) and k6 counts them in business_error_rate, not as unexpected 4xx.
 */
export const BUSINESS_ERROR_CODES: ReadonlySet<DomainErrorCode> = new Set([
  'INSUFFICIENT_STOCK',
  'PAYMENT_DECLINED',
  'PRODUCT_INACTIVE',
  'CART_EMPTY',
  'ORDER_NOT_CANCELLABLE',
]);
