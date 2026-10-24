import { afterEach, expect, it, vi } from 'vitest';
import { runInvariantOracle } from '../../src/evaluator/invariant-oracle/index.js';
import { createTestLogger } from '../helpers/logger.js';

const state = vi.hoisted(() => ({ reservationPending: true, commitReads: 0, cancelled: false, racing: false }));
vi.mock('pg', () => ({ default: { Client: class {
  async connect() {}
  async end() {}
  async query(sql: string) {
    if (sql.includes('COUNT(*) as violations')) return { rows: [{ violations: '0' }] };
    if (sql.includes('FROM users')) return { rows: [{ user_id: 'user', product_id: 'product', available_quantity: 100 }] };
    if (sql.includes('SELECT inventory_reserved')) {
      state.commitReads++;
      if (state.commitReads >= 3) state.reservationPending = false;
      return { rows: [{ inventory_reserved: state.reservationPending }] };
    }
    if (sql.includes('UPDATE inventory')) { state.racing = true; return { rows: [] }; }
    return { rows: [{ available_quantity: state.racing ? 0 : state.cancelled ? 101 : 100,
      reserved_quantity: state.cancelled ? 0 : state.reservationPending ? 1 : 0 }] };
  }
} } }));
afterEach(() => vi.unstubAllGlobals());

it('checks cancellation after a confirmed order finishes its delayed inventory commit', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/payments/mock')) return Response.json({ paymentId: 'payment', duplicate: true });
    if (url.endsWith('/cancel')) {
      state.cancelled = true;
      return Response.json({ status: 'CANCELLED' });
    }
    if (url.endsWith('/orders') && init.method === 'POST') {
      state.cancelled = false;
      return Response.json({ id: 'order', status: 'PENDING' }, { status: 202 });
    }
    return Response.json({ status: state.cancelled ? 'CANCELLED' : 'CONFIRMED' });
  }));
  const result = await runInvariantOracle('postgres://fixture', 'run', createTestLogger(), 'http://fixture', 1000);
  expect(result.violations.find(item => item.id === 'INV-05')).toMatchObject({ passed: true });
  expect(state.commitReads).toBeGreaterThanOrEqual(3);
});
