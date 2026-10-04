import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config/env.js';
import { closeEvaluatorDb, getEvaluatorDb } from '../../src/metadata/sqlite.js';
import { createLogger } from '../../src/utils/logger.js';

describe('evaluator API contract and direct stress tests', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'evaluator-api-'));
  const dbPath = path.join(directory, 'evaluator.db');
  const previousPath = process.env['EVALUATOR_DB_PATH'];
  const config = loadConfig({ ...process.env, APP_ROLE: 'controller-api', EVALUATOR_DB_PATH: dbPath });
  const app = createApp({ config, logger: createLogger('test', 'silent') });

  beforeAll(() => { process.env['EVALUATOR_DB_PATH'] = dbPath; });
  afterAll(() => {
    closeEvaluatorDb();
    if (previousPath === undefined) delete process.env['EVALUATOR_DB_PATH']; else process.env['EVALUATOR_DB_PATH'] = previousPath;
    rmSync(directory, { recursive: true, force: true });
  });

  it('publishes an evaluator OpenAPI contract and compilable experiment schema', () => {
    const candidate = JSON.parse(readFileSync(path.resolve('schemas/architecture-candidate.schema.json'), 'utf8'));
    const experiment = JSON.parse(readFileSync(path.resolve('schemas/experiment-request.schema.json'), 'utf8'));
    const openapi = JSON.parse(readFileSync(path.resolve('schemas/evaluator-openapi.json'), 'utf8')) as { paths: Record<string, unknown> };
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(candidate);
    expect(() => ajv.compile(experiment)).not.toThrow();
    for (const required of ['/experiments', '/experiments/{id}/events', '/architectures/{id}/experiments', '/health', '/ready']) {
      expect(openapi.paths[required]).toBeDefined();
    }
  });

  it('creates a direct registry stress test idempotently', async () => {
    const first = await request(app).post('/api/v1/architectures/A01/experiments')
      .set('Idempotency-Key', 'direct-a01-contract').send({ measureSeconds: 1, warmupSeconds: 0, cooldownSeconds: 0, protocolVersion: 'contract-v1' }).expect(202);
    const second = await request(app).post('/api/v1/architectures/A01/experiments')
      .set('Idempotency-Key', 'direct-a01-contract').send({ measureSeconds: 1, warmupSeconds: 0, cooldownSeconds: 0 }).expect(202);
    expect(second.body.experimentId).toBe(first.body.experimentId);
    expect((getEvaluatorDb().prepare('SELECT protocol_version FROM experiments WHERE id=?').get(first.body.experimentId) as { protocol_version: string }).protocol_version).toBe('contract-v1');
    expect((getEvaluatorDb().prepare('SELECT COUNT(*) AS count FROM experiments').get() as { count: number }).count).toBe(1);

    const filtered = await request(app).get('/api/v1/experiments')
      .query({ architectureId: 'A01', workloadProfile: 'MIXED_V1', modelName: 'direct-selection', search: 'A01' })
      .expect(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.experiments[0].architecture_id).toBe('A01');
    expect(filtered.body.experiments[0].model_name).toBe('direct-selection');
    expect(filtered.body.summary.statusCounts.PENDING).toBe(1);
  });

  it('rejects a direct stress test before queueing when its dataset snapshot is absent', async () => {
    const before = (getEvaluatorDb().prepare('SELECT COUNT(*) AS count FROM experiments').get() as { count: number }).count;
    const response = await request(app).post('/api/v1/architectures/A01/experiments')
      .set('Idempotency-Key', 'missing-main-dataset-contract')
      .send({ datasetProfile: 'main', measureSeconds: 1, warmupSeconds: 0, cooldownSeconds: 0 })
      .expect(400);
    expect(response.body.code).toBe('INVALID_FROZEN_INPUT');
    expect(response.body.message).toContain('Dataset snapshot main-20261001 is not installed');
    expect((getEvaluatorDb().prepare('SELECT COUNT(*) AS count FROM experiments').get() as { count: number }).count).toBe(before);
  });

  it('rejects an invalid candidate without creating runs', async () => {
    const before = (getEvaluatorDb().prepare('SELECT COUNT(*) AS count FROM experiment_runs').get() as { count: number }).count;
    const candidate = JSON.parse(readFileSync(path.resolve('tests/fixtures/candidate-A01.json'), 'utf8')) as Record<string, unknown>;
    candidate['estimatedLatency'] = 10;
    await request(app).post('/api/v1/experiments').set('Idempotency-Key', 'invalid-candidate-contract')
      .send({ candidate, workloadProfile: 'MIXED_V1', loadLevelsRps: [25], repetitions: 1,
        slo: { p99Ms: 100, errorRateMax: 0.01 }, costCatalogVersion: 'research-v1' }).expect(422);
    expect((getEvaluatorDb().prepare('SELECT COUNT(*) AS count FROM experiment_runs').get() as { count: number }).count).toBe(before);
  });
});
