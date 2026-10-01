import { describe, expect, it } from 'vitest';
import { SUT_ROUTES } from '../../src/sut/shared/contracts/routes.js';
import {
  SutContractValidator,
  loadSutOpenApi,
} from '../../src/sut/shared/contracts/openapi-validator.js';
import {
  BUSINESS_ERROR_CODES,
  DOMAIN_ERRORS,
  DomainError,
} from '../../src/sut/shared/errors/domain-errors.js';
import { toEnvelope } from '../../src/utils/errors.js';

const doc = loadSutOpenApi();
const validator = new SutContractValidator(doc);
const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('SUT OpenAPI contract', () => {
  it('declares exactly the 15 endpoints from the guide and nothing else', () => {
    const declared = validator
      .operations()
      .map((o) => `${o.method.toUpperCase()} ${o.path}`)
      .sort();
    const expected = SUT_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.openapiPath}`).sort();
    expect(declared).toHaveLength(15);
    expect(declared).toEqual(expected);
    for (const route of SUT_ROUTES) {
      expect(doc.paths[route.openapiPath]?.[route.method]?.operationId).toBe(route.operationId);
    }
  });

  it('compiles every declared response schema in Ajv strict mode', () => {
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        for (const status of Object.keys(op.responses)) {
          // Compiling (via validate) throws on any invalid/unknown keyword.
          expect(() => validator.validate(method, p, Number(status), {})).not.toThrow();
        }
      }
    }
  });

  it('requires X-Request-Id on business endpoints and Idempotency-Key on checkout', () => {
    const raw = doc as unknown as {
      paths: Record<string, Record<string, { parameters?: Array<{ $ref?: string }> }>>;
    };
    for (const route of SUT_ROUTES.filter((r) => r.path !== '/health' && r.path !== '/ready')) {
      const refs = (raw.paths[route.openapiPath]?.[route.method]?.parameters ?? []).map(
        (p) => p.$ref,
      );
      expect(refs, route.path).toContain('#/components/parameters/RequestId');
    }
    const checkoutRefs = (raw.paths['/orders']?.post?.parameters ?? []).map((p) => p.$ref);
    expect(checkoutRefs).toContain('#/components/parameters/IdempotencyKey');
  });

  it('allows 201 (sync) and 202 (event-driven) for checkout with the same Order schema', () => {
    const order = {
      id: uuid,
      userId: uuid,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      totalAmount: '10.00',
      items: [{ productId: uuid, quantity: 1, unitPrice: '10.00' }],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    expect(validator.validate('post', '/orders', 201, order).valid).toBe(true);
    expect(validator.validate('post', '/orders', 202, order).valid).toBe(true);
  });

  it('rejects responses with unknown fields, wrong money format or bad status', () => {
    const product = {
      id: uuid,
      sku: 'SKU-1',
      name: 'n',
      category: 'c',
      price: '1.50',
      isActive: true,
    };
    expect(validator.validate('get', '/products/{id}', 200, product).valid).toBe(true);
    expect(validator.validate('get', '/products/{id}', 200, { ...product, extra: 1 }).valid).toBe(
      false,
    );
    expect(validator.validate('get', '/products/{id}', 200, { ...product, price: 1.5 }).valid).toBe(
      false,
    );
    expect(
      validator.validate('get', '/products/{id}', 200, { ...product, price: '1.5' }).valid,
    ).toBe(false);
    expect(() => validator.validate('get', '/products/{id}', 418, product)).toThrow(/not declared/);
    expect(() => validator.validate('put', '/products/{id}', 200, product)).toThrow(
      /not in the contract/,
    );
  });

  it('validates the standard error envelope', () => {
    const envelope = { code: 'PRODUCT_NOT_FOUND', message: 'x', details: null, requestId: 'r1' };
    expect(validator.validate('get', '/products/{id}', 404, envelope).valid).toBe(true);
    expect(
      validator.validate('get', '/products/{id}', 404, { code: 'X', message: 'x' }).valid,
    ).toBe(false);
  });
});

describe('domain errors', () => {
  it('map to the envelope with stable codes and statuses', () => {
    const { status, body } = toEnvelope(
      new DomainError('INSUFFICIENT_STOCK', { productId: uuid }),
      'req-1',
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      code: 'INSUFFICIENT_STOCK',
      message: 'Insufficient stock',
      details: { productId: uuid },
      requestId: 'req-1',
    });
    expect(validator.validate('post', '/orders', 409, body).valid).toBe(true);
  });

  it('every business error code is a known domain error', () => {
    for (const code of BUSINESS_ERROR_CODES) expect(DOMAIN_ERRORS[code]).toBeDefined();
  });

  it('hides internals for unexpected errors', () => {
    const { status, body } = toEnvelope(new Error('db password=secret'), 'r');
    expect(status).toBe(500);
    expect(body.message).not.toContain('secret');
  });
});
