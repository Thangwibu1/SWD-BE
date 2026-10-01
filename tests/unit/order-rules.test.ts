import { describe, expect, it } from 'vitest';
import {
  canTransition,
  allowedFrom,
  isCancellable,
  assertUniqueItems,
  isSameCheckout,
} from '../../src/sut/shared/domain/order-rules.js';

describe('canTransition', () => {
  it('allows PENDING → CONFIRMED', () => {
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(true);
  });

  it('allows PENDING → FAILED', () => {
    expect(canTransition('PENDING', 'FAILED')).toBe(true);
  });

  it('allows PENDING → CANCELLED', () => {
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
  });

  it('allows CONFIRMED → CANCELLED', () => {
    expect(canTransition('CONFIRMED', 'CANCELLED')).toBe(true);
  });

  it('rejects CONFIRMED → PENDING (INV-07)', () => {
    expect(canTransition('CONFIRMED', 'PENDING')).toBe(false);
  });

  it('rejects CANCELLED → PENDING (INV-07)', () => {
    expect(canTransition('CANCELLED', 'PENDING')).toBe(false);
  });

  it('rejects FAILED → PENDING (INV-07)', () => {
    expect(canTransition('FAILED', 'PENDING')).toBe(false);
  });

  it('rejects CANCELLED → any', () => {
    expect(canTransition('CANCELLED', 'CONFIRMED')).toBe(false);
    expect(canTransition('CANCELLED', 'FAILED')).toBe(false);
  });

  it('rejects FAILED → any', () => {
    expect(canTransition('FAILED', 'CONFIRMED')).toBe(false);
    expect(canTransition('FAILED', 'CANCELLED')).toBe(false);
  });
});

describe('allowedFrom', () => {
  it('returns valid sources for CONFIRMED', () => {
    expect(allowedFrom('CONFIRMED')).toEqual(['PENDING']);
  });

  it('returns valid sources for CANCELLED', () => {
    const from = allowedFrom('CANCELLED');
    expect(from).toContain('PENDING');
    expect(from).toContain('CONFIRMED');
  });
});

describe('isCancellable', () => {
  it('CONFIRMED is cancellable', () => {
    expect(isCancellable('CONFIRMED')).toBe(true);
  });

  it('PENDING is not cancellable', () => {
    expect(isCancellable('PENDING')).toBe(false);
  });

  it('CANCELLED is not cancellable', () => {
    expect(isCancellable('CANCELLED')).toBe(false);
  });

  it('FAILED is not cancellable', () => {
    expect(isCancellable('FAILED')).toBe(false);
  });
});

describe('assertUniqueItems', () => {
  it('passes for unique product IDs', () => {
    expect(() =>
      assertUniqueItems([
        { productId: 'a', quantity: 1 },
        { productId: 'b', quantity: 2 },
      ]),
    ).not.toThrow();
  });

  it('throws on duplicate product ID', () => {
    expect(() =>
      assertUniqueItems([
        { productId: 'a', quantity: 1 },
        { productId: 'a', quantity: 2 },
      ]),
    ).toThrow();
  });
});

describe('isSameCheckout', () => {
  it('matches identical requests', () => {
    const existing = {
      userId: 'u1',
      items: [{ productId: 'p1', quantity: 2 }],
    };
    const request = {
      userId: 'u1',
      items: [{ productId: 'p1', quantity: 2 }],
    };
    expect(isSameCheckout(existing, request)).toBe(true);
  });

  it('rejects different user', () => {
    const existing = { userId: 'u1', items: [{ productId: 'p1', quantity: 2 }] };
    const request = { userId: 'u2', items: [{ productId: 'p1', quantity: 2 }] };
    expect(isSameCheckout(existing, request)).toBe(false);
  });

  it('rejects different items', () => {
    const existing = { userId: 'u1', items: [{ productId: 'p1', quantity: 2 }] };
    const request = { userId: 'u1', items: [{ productId: 'p2', quantity: 2 }] };
    expect(isSameCheckout(existing, request)).toBe(false);
  });

  it('rejects different quantities', () => {
    const existing = { userId: 'u1', items: [{ productId: 'p1', quantity: 2 }] };
    const request = { userId: 'u1', items: [{ productId: 'p1', quantity: 3 }] };
    expect(isSameCheckout(existing, request)).toBe(false);
  });
});
