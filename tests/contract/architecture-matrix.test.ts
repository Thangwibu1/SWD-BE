import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { loadRegistry } from '../../src/evaluator/registry/index.js';
import { renderCompose } from '../../src/evaluator/compose-renderer/index.js';
import { profileCandidate } from '../../src/evaluator/registry/ai-contract.js';
import { validateCandidate } from '../../src/evaluator/architecture-validator/index.js';
import { auditRenderedProfile } from '../../src/evaluator/registry/audit.js';

describe('complete executable cache matrix', () => {
  const profiles = [...loadRegistry().values()];
  it('covers all four cache modes exactly once for each of 13 topologies', () => {
    const groups = new Map<string, Set<string>>();
    for (const p of profiles) {
      const key = JSON.stringify([p.family, p.messaging.broker, p.scalingProfile]);
      const modes = groups.get(key) ?? new Set<string>();
      const mode = [...(p.cache.targets ?? [])].sort().join(',');
      expect(modes.has(mode), `duplicate topology/cache: ${p.id}`).toBe(false);
      modes.add(mode);
      groups.set(key, modes);
    }
    expect(groups.size).toBe(13);
    for (const modes of groups.values()) expect([...modes].sort()).toEqual(['', 'cart', 'cart,product', 'product']);
  });
  it.each(profiles)('$id renders only its required infrastructure and replicas within quota', p => {
    const candidate = profileCandidate(p);
    expect(candidate.decisions.cache.ttlSeconds).toBe(p.cache.targets?.includes('product') ? 60 : undefined);
    if (p.cache.targets?.join(',') === 'cart') {
      expect(validateCandidate({ ...candidate, decisions: { ...candidate.decisions,
        cache: { ...candidate.decisions.cache, ttlSeconds: 60 } } }).valid).toBe(false);
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'matrix-'));
    try {
      const rendered = renderCompose({ runId: `matrix-${p.id}`, profile: p,
        databaseUrl: 'postgres://bench:bench@postgres:5432/ecommerce', hostPortStart: 19000, outputDir: dir });
      const compose = parse(rendered.composeContent);
      expect(auditRenderedProfile(p, rendered.composeContent)).toEqual([]);
      expect(Boolean(compose.services.redis)).toBe(p.cache.enabled);
      expect(Boolean(compose.services.rabbitmq)).toBe(p.messaging.broker === 'RABBITMQ');
      expect(Boolean(compose.services['pg-queue-worker'])).toBe(p.messaging.broker === 'POSTGRES');
      if (p.scalingProfile === 'QUEUE_SINGLE_API_DUAL_WORKER') {
        expect(compose.services['sut-monolith-2']).toBeUndefined();
        expect(compose.services['pg-queue-worker-2']).toBeDefined();
      }
      let cpu = 0;
      let memory = 0;
      for (const svc of Object.values(compose.services) as Array<{ cpus: string; mem_limit: string; depends_on?: Record<string, unknown> }>) {
        cpu += Number(svc.cpus);
        memory += Number.parseInt(svc.mem_limit, 10);
        for (const dep of Object.keys(svc.depends_on ?? {})) expect(compose.services[dep]).toBeDefined();
      }
      expect(cpu).toBeLessThanOrEqual(2.001);
      expect(memory).toBeLessThanOrEqual(4096);
      expect(readFileSync(rendered.filePath, 'utf8')).toBe(rendered.composeContent);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
