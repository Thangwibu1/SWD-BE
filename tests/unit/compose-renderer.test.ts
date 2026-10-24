import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { renderCompose } from '../../src/evaluator/compose-renderer/index.js';
import { loadRegistry } from '../../src/evaluator/registry/index.js';
import { auditRenderedProfile, applicationInstanceCount } from '../../src/evaluator/registry/audit.js';

const directories: string[] = [];
const previousControlNetwork = process.env['SUT_CONTROL_NETWORK'];

afterEach(() => {
  if (previousControlNetwork === undefined) delete process.env['SUT_CONTROL_NETWORK'];
  else process.env['SUT_CONTROL_NETWORK'] = previousControlNetwork;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('compose renderer control network', () => {
  it('applies the registry allocation to the app alias and detects deployment drift', () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'compose-renderer-'));
    directories.push(outputDir);
    const original = loadRegistry().get('A01')!;
    const profile = { ...original, resources: { ...original.resources,
      'sut-monolith': { cpus: 1.1, memoryMiB: 2048 } } };
    const rendered = renderCompose({ runId: 'allocation-alias', profile,
      databaseUrl: 'postgres://bench:bench@postgres:5432/ecommerce', hostPortStart: 20500, outputDir });
    const compose = YAML.parse(rendered.composeContent);
    expect(compose.services.app.cpus).toBe('1.1');
    expect(compose.services.app.mem_limit).toBe('2048m');
    expect(auditRenderedProfile(profile, rendered.composeContent)).toEqual([]);
    compose.services.app.cpus = '0.1';
    expect(auditRenderedProfile(profile, YAML.stringify(compose))).toContain('app: resource mismatch');
    delete compose.services.app;
    expect(auditRenderedProfile(profile, YAML.stringify(compose))).toContain('sut-monolith: required role is absent');
  });

  it('counts concrete application instances instead of searching role names for replica', () => {
    expect(applicationInstanceCount(loadRegistry().get('A01')!)).toBe(1);
    expect(applicationInstanceCount(loadRegistry().get('A03')!)).toBe(2);
    expect(applicationInstanceCount(loadRegistry().get('A16')!)).toBe(4);
    expect(applicationInstanceCount(loadRegistry().get('A49')!)).toBe(3);
  });

  it('gives the worker and Prometheus per-run SUT aliases and lightweight probes', () => {
    process.env['SUT_CONTROL_NETWORK'] = 'architecture-evaluation-control';
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'compose-renderer-'));
    directories.push(outputDir);
    const profile = loadRegistry().get('A09');
    expect(profile).toBeDefined();

    const rendered = renderCompose({
      runId: 'run-123',
      profile: profile!,
      databaseUrl: 'postgres://bench:bench@postgres:5432/ecommerce',
      hostPortStart: 20500,
      outputDir,
    });
    const compose = YAML.parse(rendered.composeContent) as {
      services: Record<string, { healthcheck?: { test?: string[] }; networks?: Record<string, { aliases?: string[] }> }>;
      networks: Record<string, { internal?: boolean; external?: boolean; name?: string }>;
    };

    expect(rendered.controlHost).toBe('sut-run-123');
    expect(rendered.controlDatabaseHost).toBe('sut-db-run-123');
    expect(compose.services['app']?.networks?.['evaluator_control']?.aliases).toEqual(['sut-run-123']);
    expect(compose.services['postgres']?.networks?.['evaluator_control']?.aliases).toEqual(['sut-db-run-123']);
    expect(compose.services['app']?.healthcheck?.test).toEqual(['CMD', 'curl', '-fsS', 'http://localhost:3000/ready']);
    expect(compose.services['rabbitmq']?.healthcheck?.test).toEqual(['CMD-SHELL', 'nc -z 127.0.0.1 5672']);
    expect(compose.networks['default']?.internal).toBe(true);
    expect(compose.networks['evaluator_control']).toEqual({ external: true, name: 'architecture-evaluation-control' });
  });

  it('keeps concrete replicas declared by a logical registry role', () => {
    delete process.env['SUT_CONTROL_NETWORK'];
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'compose-renderer-'));
    directories.push(outputDir);
    const profile = loadRegistry().get('A03');
    expect(profile).toBeDefined();

    const rendered = renderCompose({
      runId: 'scaled-run',
      profile: profile!,
      databaseUrl: 'postgres://bench:bench@postgres:5432/ecommerce',
      hostPortStart: 20500,
      outputDir,
    });
    const compose = YAML.parse(rendered.composeContent) as { services: Record<string, unknown> };

    expect(compose.services).toHaveProperty('sut-monolith');
    expect(compose.services).toHaveProperty('sut-monolith-2');
  });

  it('keeps replicas explicitly named by the registry', () => {
    delete process.env['SUT_CONTROL_NETWORK'];
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'compose-renderer-'));
    directories.push(outputDir);
    const profile = loadRegistry().get('A11');
    expect(profile).toBeDefined();

    const rendered = renderCompose({
      runId: 'explicit-scaled-run',
      profile: profile!,
      databaseUrl: 'postgres://bench:bench@postgres:5432/ecommerce',
      hostPortStart: 20500,
      outputDir,
    });
    const compose = YAML.parse(rendered.composeContent) as { services: Record<string, unknown> };

    expect(compose.services).toHaveProperty('catalog-service-1');
    expect(compose.services).toHaveProperty('catalog-service-2');
  });
});
