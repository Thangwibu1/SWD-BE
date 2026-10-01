import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SutContractValidator } from '../../src/sut/shared/contracts/openapi-validator.js';
import { DomainError } from '../../src/sut/shared/errors/domain-errors.js';
import { asyncHandler, createSutApp, finalizeSutApp } from '../../src/sut/shared/http/sut-http.js';
import { currentRequestId } from '../../src/sut/shared/observability/request-context.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger('test', 'silent');
const validator = new SutContractValidator();

function buildApp() {
  const app = createSutApp(logger);
  app.get(
    '/products/:id',
    asyncHandler(async () => {
      throw new DomainError('PRODUCT_NOT_FOUND');
    }),
  );
  app.get(
    '/ctx',
    asyncHandler(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 5));
      res.json({ requestId: currentRequestId() });
    }),
  );
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  return finalizeSutApp(app, logger);
}

describe('SUT HTTP shell', () => {
  const app = buildApp();

  it('returns a contract-valid envelope with the caller request id', async () => {
    const res = await request(app).get('/products/x').set('X-Request-Id', 'req-42').expect(404);
    expect(res.body.requestId).toBe('req-42');
    expect(res.headers['x-request-id']).toBe('req-42');
    expect(validator.validate('get', '/products/{id}', 404, res.body).valid).toBe(true);
  });

  it('propagates the request id through async continuations', async () => {
    const res = await request(app).get('/ctx').set('X-Request-Id', 'async-1').expect(200);
    expect(res.body.requestId).toBe('async-1');
  });

  it('generates a request id when missing', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps malformed JSON and oversized bodies to client errors', async () => {
    const bad = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"a":')
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const big = await request(app)
      .post('/echo')
      .send({ blob: 'x'.repeat(70 * 1024) })
      .expect(413);
    expect(big.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
