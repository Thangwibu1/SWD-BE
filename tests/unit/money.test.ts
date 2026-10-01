import { describe, expect, it } from 'vitest';
import { toCents, fromCents, orderTotalCents } from '../../src/sut/shared/domain/money.js';

describe('toCents', () => {
  it('converts whole dollars', () => {
    expect(toCents('10.00')).toBe(1000);
  });

  it('converts dollars with cents', () => {
    expect(toCents('19.99')).toBe(1999);
  });

  it('converts single-cent amounts', () => {
    expect(toCents('0.01')).toBe(1);
  });

  it('handles large amounts', () => {
    expect(toCents('9999999999.99')).toBe(999999999999);
  });

  it('handles missing decimal', () => {
    expect(toCents('5')).toBe(500);
  });

  it('handles single decimal digit', () => {
    expect(toCents('5.5')).toBe(550);
  });

  it('rejects negative values', () => {
    expect(() => toCents('-1.00')).toThrow();
  });

  it('rejects non-numeric strings', () => {
    expect(() => toCents('abc')).toThrow();
  });
});

describe('fromCents', () => {
  it('formats round dollars', () => {
    expect(fromCents(1000)).toBe('10.00');
  });

  it('formats with cents', () => {
    expect(fromCents(1999)).toBe('19.99');
  });

  it('formats zero', () => {
    expect(fromCents(0)).toBe('0.00');
  });

  it('formats single cent', () => {
    expect(fromCents(1)).toBe('0.01');
  });

  it('rejects negative', () => {
    expect(() => fromCents(-1)).toThrow();
  });
});

describe('orderTotalCents', () => {
  it('computes sum(qty * unitPrice) exactly', () => {
    const lines = [
      { quantity: 2, unitPrice: '19.99' },
      { quantity: 1, unitPrice: '5.50' },
    ];
    expect(orderTotalCents(lines)).toBe(2 * 1999 + 1 * 550);
  });

  it('returns 0 for empty lines', () => {
    expect(orderTotalCents([])).toBe(0);
  });

  it('handles single item', () => {
    expect(orderTotalCents([{ quantity: 3, unitPrice: '10.00' }])).toBe(3000);
  });
});
