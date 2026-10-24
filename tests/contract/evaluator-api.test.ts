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
  const previousResultsRoot = process.env['RESULTS_ROOT'];
  const resultsRoot = path.join(directory, 'results');
  const config = loadConfig({
    ...process.env,
    APP_ROLE: 'controller-api',
    EVALUATOR_DB_PATH: dbPath,
  });
  const app = createApp({ config, logger: createLogger('test', 'silent') });

  beforeAll(() => {
    process.env['EVALUATOR_DB_PATH'] = dbPath;
    process.env['RESULTS_ROOT'] = resultsRoot;
  });
  afterAll(() => {
    closeEvaluatorDb();
    if (previousPath === undefined) delete process.env['EVALUATOR_DB_PATH'];
    else process.env['EVALUATOR_DB_PATH'] = previousPath;
    if (previousResultsRoot === undefined) delete process.env['RESULTS_ROOT'];
    else process.env['RESULTS_ROOT'] = previousResultsRoot;
    rmSync(directory, { recursive: true, force: true });
  });

  it('serves AI batch summaries without exposing arbitrary filesystem paths', async () => {
    await request(app)
      .post('/api/v1/ai-batch/studies/ui-study-v1/snapshot')
      .send({
        summary: {
          studyId: 'ui-study-v1',
          plannedGenerations: 30,
          recordedGenerations: 10,
          maximumBenchmarkRuns: 90,
          collectedRuns: 9,
          groups: [],
        },
        comparison: [
          {
            modelId: 'model-1',
            architectureId: 'A01',
            targetRps: 20,
            p99MsMedian: 42,
          },
        ],
        probes: [{ modelId: 'model-1', passed: true }],
      })
      .expect(202);
    const list = await request(app).get('/api/v1/ai-batch/studies').expect(200);
    expect(list.body.studies[0]).toMatchObject({ studyId: 'ui-study-v1', collectedRuns: 9 });
    const detail = await request(app).get('/api/v1/ai-batch/studies/ui-study-v1').expect(200);
    expect(detail.body.comparison[0]).toMatchObject({ architectureId: 'A01', p99MsMedian: 42 });
    expect(detail.body.probes[0]).toMatchObject({ modelId: 'model-1', passed: true });
    await request(app)
      .post('/api/v1/ai-batch/studies/ui-study-v1/snapshot')
      .send({ summary: { studyId: 'wrong' }, comparison: [], probes: [] })
      .expect(400);
    await request(app).get('/api/v1/ai-batch/studies/..%2F..%2Fsecrets').expect(400);
  });

  it('publishes an evaluator OpenAPI contract and compilable experiment schema', () => {
    const candidate = JSON.parse(
      readFileSync(path.resolve('schemas/architecture-candidate.schema.json'), 'utf8'),
    );
    const experiment = JSON.parse(
      readFileSync(path.resolve('schemas/experiment-request.schema.json'), 'utf8'),
    );
    const openapi = JSON.parse(
      readFileSync(path.resolve('schemas/evaluator-openapi.json'), 'utf8'),
    ) as { paths: Record<string, unknown> };
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(candidate);
    expect(() => ajv.compile(experiment)).not.toThrow();
    for (const required of [
      '/experiments',
      '/experiments/{id}/events',
      '/architectures/{id}/experiments',
      '/health',
      '/ready',
    ]) {
      expect(openapi.paths[required]).toBeDefined();
    }
  });

  it('creates a direct registry stress test idempotently', async () => {
    const first = await request(app)
      .post('/api/v1/architectures/A01/experiments')
      .set('Idempotency-Key', 'direct-a01-contract')
      .send({
        measureSeconds: 1,
        warmupSeconds: 0,
        cooldownSeconds: 0,
        protocolVersion: 'contract-v1',
      })
      .expect(202);
    const second = await request(app)
      .post('/api/v1/architectures/A01/experiments')
      .set('Idempotency-Key', 'direct-a01-contract')
      .send({ measureSeconds: 1, warmupSeconds: 0, cooldownSeconds: 0 })
      .expect(202);
    expect(second.body.experimentId).toBe(first.body.experimentId);
    expect(
      (
        getEvaluatorDb()
          .prepare('SELECT protocol_version FROM experiments WHERE id=?')
          .get(first.body.experimentId) as { protocol_version: string }
      ).protocol_version,
    ).toBe('contract-v1');
    expect(
      (
        getEvaluatorDb().prepare('SELECT COUNT(*) AS count FROM experiments').get() as {
          count: number;
        }
      ).count,
    ).toBe(1);

    const filtered = await request(app)
      .get('/api/v1/experiments')
      .query({
        architectureId: 'A01',
        workloadProfile: 'MIXED_V1',
        modelName: 'direct-selection',
        search: 'A01',
      })
      .expect(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.experiments[0].architecture_id).toBe('A01');
    expect(filtered.body.experiments[0].model_name).toBe('direct-selection');
    expect(filtered.body.summary.statusCounts.PENDING).toBe(1);
  });

  it('queues exact request-volume tiers and derives their offered rates', async () => {
    const response = await request(app)
      .post('/api/v1/architectures/A01/experiments')
      .set('Idempotency-Key', 'direct-volume-contract')
      .send({ requestVolumes: [10_000, 100_000, 500_000], measureSeconds: 600,
        warmupSeconds: 0, cooldownSeconds: 0, datasetProfile: 'capacity', repetitions: 1 });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const runs = getEvaluatorDb()
      .prepare('SELECT target_operations, load_rps FROM experiment_runs WHERE experiment_id=? ORDER BY target_operations')
      .all(response.body.experimentId) as Array<{ target_operations: number; load_rps: number }>;
    expect(runs.map((run) => run.target_operations)).toEqual([10_000, 100_000, 500_000]);
    expect(runs.map((run) => run.load_rps)).toEqual([
      10_000 / 600, 100_000 / 600, 500_000 / 600,
    ]);
    await request(app)
      .post('/api/v1/architectures/A01/experiments')
      .set('Idempotency-Key', 'mixed-rate-volume-contract')
      .send({ loadLevelsRps: [20], requestVolumes: [10_000] })
      .expect(400);
  });

  it('exports the runnable AI contract before the architecture ID route', async () => {
    const response = await request(app).get('/api/v1/architectures/ai-contract').expect(200);
    expect(response.body.supportedArchitectureIds).toContain('A16');
    const candidate = response.body.candidates.find(
      (c: { architectureId: string }) => c.architectureId === 'A15',
    );
    const validation = await request(app)
      .post('/api/v1/candidates/validate')
      .send(candidate)
      .expect(200);
    expect(validation.body.valid).toBe(true);
    const job = await request(app)
      .post('/api/v1/architectures/A15/experiments')
      .set('Idempotency-Key', 'direct-a15-contract')
      .send({ measureSeconds: 1 })
      .expect(202);
    expect(job.body.architectureId).toBe('A15');
  });

  it('queues a cart-only profile without injecting product cache TTL', async () => {
    const job = await request(app)
      .post('/api/v1/architectures/A18/experiments')
      .set('Idempotency-Key', 'direct-cart-only-contract')
      .send({ measureSeconds: 1 })
      .expect(202);
    const stored = getEvaluatorDb()
      .prepare('SELECT raw_json FROM candidates WHERE id=?')
      .get(job.body.candidateId) as { raw_json: string };
    const candidate = JSON.parse(stored.raw_json);
    expect(candidate.decisions.cache).toEqual({ enabled: true, targets: ['cart'] });
  });

  it('returns disjoint pages and an accurate total for experiment history', async () => {
    const first = await request(app)
      .get('/api/v1/experiments')
      .query({ limit: 1, offset: 0 })
      .expect(200);
    const second = await request(app)
      .get('/api/v1/experiments')
      .query({ limit: 1, offset: 1 })
      .expect(200);
    expect(first.body.total).toBeGreaterThan(1);
    expect(second.body.total).toBe(first.body.total);
    expect(first.body.experiments).toHaveLength(1);
    expect(second.body.experiments).toHaveLength(1);
    expect(first.body.experiments[0].id).not.toBe(second.body.experiments[0].id);
    const empty = await request(app)
      .get('/api/v1/experiments')
      .query({ limit: 1, offset: first.body.total })
      .expect(200);
    expect(empty.body.experiments).toHaveLength(0);
  });

  it('rejects a direct stress test before queueing when its dataset snapshot is absent', async () => {
    const before = (
      getEvaluatorDb().prepare('SELECT COUNT(*) AS count FROM experiments').get() as {
        count: number;
      }
    ).count;
    const response = await request(app)
      .post('/api/v1/architectures/A01/experiments')
      .set('Idempotency-Key', 'missing-main-dataset-contract')
      .send({ datasetProfile: 'main', measureSeconds: 1, warmupSeconds: 0, cooldownSeconds: 0 })
      .expect(400);
    expect(response.body.code).toBe('INVALID_FROZEN_INPUT');
    expect(response.body.message).toContain('Dataset snapshot main-20261001 is not installed');
    expect(
      (
        getEvaluatorDb().prepare('SELECT COUNT(*) AS count FROM experiments').get() as {
          count: number;
        }
      ).count,
    ).toBe(before);
  });

  it('rejects an invalid candidate without creating runs', async () => {
    const before = (
      getEvaluatorDb().prepare('SELECT COUNT(*) AS count FROM experiment_runs').get() as {
        count: number;
      }
    ).count;
    const candidate = JSON.parse(
      readFileSync(path.resolve('tests/fixtures/candidate-A01.json'), 'utf8'),
    ) as Record<string, unknown>;
    candidate['estimatedLatency'] = 10;
    await request(app)
      .post('/api/v1/experiments')
      .set('Idempotency-Key', 'invalid-candidate-contract')
      .send({
        candidate,
        workloadProfile: 'MIXED_V1',
        loadLevelsRps: [25],
        repetitions: 1,
        slo: { p99Ms: 100, errorRateMax: 0.01 },
        costCatalogVersion: 'research-v1',
      })
      .expect(422);
    expect(
      (
        getEvaluatorDb().prepare('SELECT COUNT(*) AS count FROM experiment_runs').get() as {
          count: number;
        }
      ).count,
    ).toBe(before);
  });
});
