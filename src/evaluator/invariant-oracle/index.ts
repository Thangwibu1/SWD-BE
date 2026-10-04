import type { Logger } from '../../utils/logger.js';
import crypto from 'node:crypto';

export interface InvariantResult {
  id: string;
  name: string;
  passed: boolean;
  details: string;
  severity: 'CRITICAL' | 'WARNING';
}

export interface OracleResult {
  passed: boolean;
  violations: InvariantResult[];
  criticalViolationCount: number;
  warningCount: number;
}

/**
 * Run all business invariant checks (INV-01 through INV-07) against the SUT database.
 * For event-driven architectures, the eventual consistency window must have elapsed
 * before calling this function.
 */
export async function runInvariantOracle(
  databaseUrl: string,
  _runId: string,
  logger: Logger,
  sutBaseUrl?: string,
  eventualTimeoutMs = 5000,
): Promise<OracleResult> {
  logger.info('Running invariant oracle checks');

  const results: InvariantResult[] = [];

  // INV-01: available_quantity and reserved_quantity are non-negative
  results.push(await checkInvariant(databaseUrl, {
    id: 'INV-01',
    name: 'Non-negative inventory quantities',
    severity: 'CRITICAL',
    query: `SELECT COUNT(*) as violations FROM inventory WHERE available_quantity < 0 OR reserved_quantity < 0`,
  }, logger));

  // INV-02: One idempotency key produces at most one order
  results.push(await checkInvariant(databaseUrl, {
    id: 'INV-02',
    name: 'Idempotency key uniqueness',
    severity: 'CRITICAL',
    query: `SELECT COUNT(*) as violations FROM (
      SELECT idempotency_key FROM orders GROUP BY idempotency_key HAVING COUNT(*) > 1
    ) duplicate_keys`,
  }, logger));

  // INV-03: total_amount = sum(quantity * unit_price) with tolerance 0.01
  results.push(await checkInvariant(databaseUrl, {
    id: 'INV-03',
    name: 'Order total amount consistency',
    severity: 'WARNING',
    query: `SELECT COUNT(*) as violations FROM orders o
      WHERE ABS(o.total_amount - COALESCE(
        (SELECT SUM(oi.quantity * oi.unit_price) FROM order_items oi WHERE oi.order_id = o.id), 0
      )) > 0.01`,
  }, logger));

  if (sutBaseUrl) {
    results.push(await checkPaymentReplay(sutBaseUrl, logger));
    results.push(await checkCancelRestoresStock(databaseUrl, sutBaseUrl, eventualTimeoutMs, logger));
    results.push(await checkConcurrentOversell(databaseUrl, sutBaseUrl, eventualTimeoutMs, logger));
    results.push(await checkTerminalState(databaseUrl, sutBaseUrl, eventualTimeoutMs, logger));
  } else {
    for (const item of [
      ['INV-04', 'Single payment per order', 'CRITICAL'],
      ['INV-05', 'Cancel restores stock', 'WARNING'],
      ['INV-06', 'No overselling', 'CRITICAL'],
      ['INV-07', 'Terminal state integrity', 'WARNING'],
    ] as const) {
      results.push({ id: item[0], name: item[1], passed: false, details: 'Active oracle requires SUT base URL', severity: item[2] });
    }
  }

  const criticalViolations = results.filter(r => !r.passed && r.severity === 'CRITICAL');
  const warnings = results.filter(r => !r.passed && r.severity === 'WARNING');

  logger.info({
    total: results.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    critical: criticalViolations.length,
  }, 'Invariant oracle complete');

  return {
    passed: criticalViolations.length === 0,
    violations: results,
    criticalViolationCount: criticalViolations.length,
    warningCount: warnings.length,
  };
}

async function requestJson(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, body };
}

async function oracleFixture(databaseUrl: string): Promise<{ userId: string; productId: string; available: number }> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ user_id: string; product_id: string; available_quantity: number }>(`
      SELECT u.id AS user_id, p.id AS product_id, i.available_quantity
      FROM users u CROSS JOIN products p JOIN inventory i ON i.product_id = p.id
      WHERE u.role = 'customer' AND p.is_active AND i.available_quantity >= 20
      ORDER BY u.id, p.id LIMIT 1`);
    const row = result.rows[0];
    if (!row) throw new Error('No oracle fixture with sufficient stock');
    return { userId: row.user_id, productId: row.product_id, available: row.available_quantity };
  } finally {
    await client.end();
  }
}

function checkoutRequest(userId: string, productId: string, idempotencyKey: string, paymentMode = 'MOCK_SUCCESS'): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': crypto.randomUUID(),
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ userId, items: [{ productId, quantity: 1 }], paymentMode }),
  };
}

async function checkPaymentReplay(sutBaseUrl: string, logger: Logger): Promise<InvariantResult> {
  try {
    const orderId = crypto.randomUUID();
    const init: RequestInit = {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({ orderId, amount: '1.00', mode: 'MOCK_SUCCESS' }),
    };
    const first = await requestJson(`${sutBaseUrl}/payments/mock`, init);
    const second = await requestJson(`${sutBaseUrl}/payments/mock`, init);
    const passed = first.status === 200 && second.status === 200
      && first.body['paymentId'] === second.body['paymentId'] && second.body['duplicate'] === true;
    return { id: 'INV-04', name: 'Single payment per order', passed, details: passed ? 'Replay returned the original payment' : 'Payment replay created a different result', severity: 'CRITICAL' };
  } catch (err) {
    logger.error({ err }, 'INV-04 active oracle failed');
    return failedOracle('INV-04', 'Single payment per order', 'CRITICAL', err);
  }
}

async function checkCancelRestoresStock(databaseUrl: string, sutBaseUrl: string, timeoutMs: number, logger: Logger): Promise<InvariantResult> {
  try {
    const fixture = await oracleFixture(databaseUrl);
    const created = await requestJson(`${sutBaseUrl}/orders`, checkoutRequest(fixture.userId, fixture.productId, `oracle-cancel-${crypto.randomUUID()}`));
    const orderId = String(created.body['id'] ?? '');
    await waitForOrder(sutBaseUrl, orderId, ['CONFIRMED'], timeoutMs);
    const beforeCancel = await inventoryQuantity(databaseUrl, fixture.productId);
    const cancelled = await requestJson(`${sutBaseUrl}/orders/${orderId}/cancel`, { method: 'POST', headers: { 'X-Request-Id': crypto.randomUUID() } });
    const afterCancel = await inventoryQuantity(databaseUrl, fixture.productId);
    const passed = cancelled.status === 200 && afterCancel.available === beforeCancel.available + 1 && afterCancel.reserved === beforeCancel.reserved;
    return { id: 'INV-05', name: 'Cancel restores stock', passed, details: passed ? 'Stock restored exactly once' : `before=${JSON.stringify(beforeCancel)}, after=${JSON.stringify(afterCancel)}`, severity: 'WARNING' };
  } catch (err) {
    logger.error({ err }, 'INV-05 active oracle failed');
    return failedOracle('INV-05', 'Cancel restores stock', 'WARNING', err);
  }
}

async function checkConcurrentOversell(databaseUrl: string, sutBaseUrl: string, timeoutMs: number, logger: Logger): Promise<InvariantResult> {
  try {
    const fixture = await oracleFixture(databaseUrl);
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('UPDATE inventory SET available_quantity = 5, reserved_quantity = 0 WHERE product_id = $1', [fixture.productId]);
    await client.end();
    await Promise.all(Array.from({ length: 10 }, () => requestJson(
      `${sutBaseUrl}/orders`, checkoutRequest(fixture.userId, fixture.productId, `oracle-race-${crypto.randomUUID()}`),
    )));
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    const quantity = await inventoryQuantity(databaseUrl, fixture.productId);
    const passed = quantity.available >= 0 && quantity.reserved >= 0;
    return { id: 'INV-06', name: 'No overselling', passed, details: `available=${quantity.available}, reserved=${quantity.reserved}`, severity: 'CRITICAL' };
  } catch (err) {
    logger.error({ err }, 'INV-06 active oracle failed');
    return failedOracle('INV-06', 'No overselling', 'CRITICAL', err);
  }
}

async function checkTerminalState(databaseUrl: string, sutBaseUrl: string, timeoutMs: number, logger: Logger): Promise<InvariantResult> {
  try {
    const fixture = await oracleFixture(databaseUrl);
    const created = await requestJson(`${sutBaseUrl}/orders`, checkoutRequest(fixture.userId, fixture.productId, `oracle-terminal-${crypto.randomUUID()}`));
    const orderId = String(created.body['id'] ?? '');
    await waitForOrder(sutBaseUrl, orderId, ['CONFIRMED'], timeoutMs);
    await requestJson(`${sutBaseUrl}/orders/${orderId}/cancel`, { method: 'POST', headers: { 'X-Request-Id': crypto.randomUUID() } });
    await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 1000)));
    const current = await requestJson(`${sutBaseUrl}/orders/${orderId}`, { method: 'GET', headers: { 'X-Request-Id': crypto.randomUUID() } });
    const passed = current.body['status'] === 'CANCELLED';
    return { id: 'INV-07', name: 'Terminal state integrity', passed, details: `final status=${String(current.body['status'])}`, severity: 'WARNING' };
  } catch (err) {
    logger.error({ err }, 'INV-07 active oracle failed');
    return failedOracle('INV-07', 'Terminal state integrity', 'WARNING', err);
  }
}

async function waitForOrder(sutBaseUrl: string, orderId: string, expected: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await requestJson(`${sutBaseUrl}/orders/${orderId}`, { method: 'GET', headers: { 'X-Request-Id': crypto.randomUUID() } });
    if (expected.includes(String(result.body['status']))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Order ${orderId} did not reach ${expected.join('|')}`);
}

async function inventoryQuantity(databaseUrl: string, productId: string): Promise<{ available: number; reserved: number }> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ available_quantity: number; reserved_quantity: number }>('SELECT available_quantity, reserved_quantity FROM inventory WHERE product_id = $1', [productId]);
    const row = result.rows[0];
    if (!row) throw new Error(`Inventory ${productId} missing`);
    return { available: row.available_quantity, reserved: row.reserved_quantity };
  } finally {
    await client.end();
  }
}

function failedOracle(id: string, name: string, severity: 'CRITICAL' | 'WARNING', err: unknown): InvariantResult {
  return { id, name, passed: false, details: err instanceof Error ? err.message : String(err), severity };
}

async function checkInvariant(
  databaseUrl: string,
  config: { id: string; name: string; severity: 'CRITICAL' | 'WARNING'; query: string },
  logger: Logger,
): Promise<InvariantResult> {
  try {
    // Dynamic import pg to avoid loading it when not needed
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();

    try {
      const result = await client.query(config.query);
      const violations = parseInt(String(result.rows[0]?.violations ?? '0'), 10);
      const passed = violations === 0;

      if (!passed) {
        logger.warn({ invariant: config.id, violations }, `Invariant ${config.id} FAILED`);
      }

      return {
        id: config.id,
        name: config.name,
        passed,
        details: passed ? 'No violations' : `${violations} violation(s) found`,
        severity: config.severity,
      };
    } finally {
      await client.end();
    }
  } catch (err) {
    logger.error({ err, invariant: config.id }, `Invariant ${config.id} check error`);
    return {
      id: config.id,
      name: config.name,
      passed: false,
      details: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
      severity: config.severity,
    };
  }
}
