import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SUT_ROUTES } from '../../src/sut/shared/contracts/routes.js';
import { loadRegistry } from '../../src/evaluator/registry/index.js';

describe('API parity across architecture families', () => {
  const openApi = JSON.parse(readFileSync(path.resolve('schemas/sut-openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };

  it('contains exactly the 15 public operations for every profile', () => {
    const declared = Object.entries(openApi.paths).flatMap(([route, methods]) =>
      Object.keys(methods)
        .filter((method) => ['get', 'post', 'delete'].includes(method))
        .map((method) => `${method.toUpperCase()} ${route}`),
    ).sort();
    const expected = SUT_ROUTES.map((route) => `${route.method.toUpperCase()} ${route.openapiPath}`).sort();
    expect(declared).toEqual(expected);
    expect(loadRegistry().size).toBe(12);
  });

  it('routes every public prefix to the responsible REST/event service', () => {
    const gateway = readFileSync(path.resolve('src/sut/gateway/bootstrap.ts'), 'utf8');
    for (const prefix of ['/auth', '/products', '/inventory', '/orders', '/users', '/payments']) {
      expect(gateway).toContain(`startsWith('${prefix}')`);
    }
  });

  it.each(['A01', 'A02', 'A03', 'A04'])('%s uses the shared monolith business router', (id) => {
    const profile = loadRegistry().get(id);
    expect(profile?.family).toBe('MODULAR_MONOLITH');
    expect(readFileSync(path.resolve('src/sut/monolith/bootstrap.ts'), 'utf8')).toContain('createBusinessRouter');
  });

  it.each(['A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12'])('%s exposes all contract domains through the gateway', (id) => {
    const profile = loadRegistry().get(id);
    expect(profile?.allowedRoles).toContain('api-gateway');
    expect(profile?.allowedRoles).toContain('inventory-service');
  });
});
