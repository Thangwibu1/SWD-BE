import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';

const config = loadConfig({ NODE_ENV: 'test' });
const logger = createLogger('test', 'silent');

describe('config', () => {
  it('rejects unknown APP_ROLE', () => {
    expect(() => loadConfig({ APP_ROLE: 'shell' })).toThrow(/APP_ROLE/);
  });
  it('rejects inverted port range', () => {
    expect(() =>
      loadConfig({ SUT_PORT_RANGE_START: '21000', SUT_PORT_RANGE_END: '20000' }),
    ).toThrow();
  });
});

describe('evaluator app bootstrap', () => {
  const app = createApp({ config, logger });

  it('serves health with a request id', async () => {
    const res = await request(app).get('/api/v1/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('echoes a safe caller request id and replaces unsafe ones', async () => {
    const ok = await request(app).get('/api/v1/health').set('X-Request-Id', 'abc-123');
    expect(ok.headers['x-request-id']).toBe('abc-123');
    // Valid HTTP header value, but contains spaces/symbols outside the safe pattern.
    const unsafe = 'a b<script>';
    const bad = await request(app).get('/api/v1/health').set('X-Request-Id', unsafe);
    expect(bad.headers['x-request-id']).not.toBe(unsafe);
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the standard error envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nope').set('X-Request-Id', 'r1').expect(404);
    expect(res.body).toEqual({
      code: 'NOT_FOUND',
      message: expect.any(String),
      details: null,
      requestId: 'r1',
    });
  });

  it('reports not-ready when a probe fails', async () => {
    const failing = createApp({
      config,
      logger,
      readinessProbes: [{ name: 'db', check: () => false }],
    });
    const res = await request(failing).get('/api/v1/ready').expect(503);
    expect(res.body.checks).toEqual([{ name: 'db', ok: false }]);
  });

  it('only sets CORS headers for allowlisted origins', async () => {
    const allowed = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await request(app).get('/api/v1/health').set('Origin', 'http://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
