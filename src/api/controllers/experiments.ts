import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { validateCandidate } from '../../evaluator/architecture-validator/index.js';
import { loadRegistry } from '../../evaluator/registry/index.js';
import { loadCostCatalog } from '../../evaluator/cost-engine/index.js';
import { loadNormalizationBounds } from '../../evaluator/score-engine/index.js';
import { assertSnapshotAvailable } from '../../sut/shared/database/snapshot.js';
import { insertCandidate } from '../../metadata/repositories/candidates.js';
import {
  insertExperiment, getExperimentById, listExperiments,
  getRunsByExperimentId, cancelExperiment, getExperimentByIdempotencyKey, getTransitions, getDashboardData,
} from '../../metadata/repositories/experiments.js';

const experimentOptionsSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  workloadProfile: z.enum(['BROWSING_V1', 'MIXED_V1', 'CHECKOUT_V1', 'FLASH_SALE_V1']).default('MIXED_V1'),
  loadLevelsRps: z.array(z.number().int().min(1).max(10_000)).min(1).max(10).default([25]),
  warmupSeconds: z.number().int().min(0).max(3600).default(120),
  measureSeconds: z.number().int().min(1).max(86_400).default(600),
  cooldownSeconds: z.number().int().min(0).max(3600).default(60),
  repetitions: z.number().int().min(1).max(5).default(1),
  invalidRetryLimit: z.number().int().min(0).max(1).default(1),
  datasetProfile: z.enum(['pilot', 'main', 'capacity']).default('pilot'),
  protocolVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i).optional(),
  slo: z.object({
    p99Ms: z.number().positive(),
    errorRateMax: z.number().min(0).max(1),
    consistencyViolationsMax: z.number().int().min(0).default(0),
  }).default({ p99Ms: 100, errorRateMax: 0.01, consistencyViolationsMax: 0 }),
  costCatalogVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i).default('research-v1'),
  scoreBoundsVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i).default('development-v1'),
}).strict();

const createExperimentSchema = experimentOptionsSchema.extend({
  candidate: z.record(z.string(), z.unknown()),
  modelMetadata: z.object({
    modelName: z.string().max(120).optional(),
    promptId: z.string().max(120).optional(),
    generationSeed: z.number().int().optional(),
  }).strict().optional(),
});

export function createExperimentController(req: Request, res: Response): void {
  try {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      res.status(400).json({ code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required', requestId: req.requestId });
      return;
    }
    const existing = getExperimentByIdempotencyKey(idempotencyKey);
    if (existing) {
      res.status(202).json({ experimentId: existing.id, candidateId: existing.candidate_id, status: existing.status,
        message: 'Existing idempotent experiment returned', requestId: req.requestId });
      return;
    }
    const parsed = createExperimentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_EXPERIMENT_REQUEST', message: 'Experiment request is invalid',
        details: parsed.error.issues, requestId: req.requestId });
      return;
    }
    const body = parsed.data;
    const candidate = body.candidate;
    try {
      loadCostCatalog(body.costCatalogVersion);
      loadNormalizationBounds(body.scoreBoundsVersion);
      assertSnapshotAvailable(body.datasetProfile);
    } catch (error) {
      res.status(400).json({ code: 'INVALID_FROZEN_INPUT', message: error instanceof Error ? error.message : String(error), requestId: req.requestId });
      return;
    }

    // Validate candidate
    const valResult = validateCandidate(candidate);
    const modelName = body.modelMetadata?.modelName;
    const promptId = body.modelMetadata?.promptId;
    const insertData: Parameters<typeof insertCandidate>[0] = {
      candidateId: String(candidate['candidateId'] ?? 'manual'),
      rawJson: JSON.stringify(candidate),
      validationStatus: valResult.valid ? 'VALID' : 'INVALID',
    };
    if (modelName) insertData.modelName = modelName;
    if (promptId) insertData.promptId = promptId;
    if (valResult.errors.length > 0) insertData.validationErrorsJson = JSON.stringify(valResult.errors);
    if (valResult.architectureId) insertData.architectureId = valResult.architectureId;
    const candidateId = insertCandidate(insertData);

    if (!valResult.valid) {
      res.status(422).json({
        code: 'INVALID_CANDIDATE',
        message: 'Candidate validation failed',
        validationErrors: valResult.errors,
        requestId: req.requestId,
      });
      return;
    }

    const experimentId = insertExperiment({
      name: body.name ?? `Experiment ${new Date().toISOString()}`,
      candidateId,
      workloadProfile: body.workloadProfile,
      loadLevelsRps: body.loadLevelsRps,
      slo: body.slo,
      costCatalogVersion: body.costCatalogVersion,
      scoreBoundsVersion: body.scoreBoundsVersion,
      repetitions: body.repetitions,
      warmupSeconds: body.warmupSeconds,
      measureSeconds: body.measureSeconds,
      cooldownSeconds: body.cooldownSeconds,
      idempotencyKey,
      invalidRetryLimit: body.invalidRetryLimit,
      datasetProfile: body.datasetProfile,
      ...(body.protocolVersion ? { protocolVersion: body.protocolVersion } : {}),
    });

    res.status(202).json({
      experimentId,
      candidateId,
      status: 'PENDING',
      message: 'Experiment created and queued',
      requestId: req.requestId,
    });
  } catch (err: unknown) {
    res.status(500).json({ code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Unknown error', requestId: req.requestId });
  }
}

export function createArchitectureExperimentController(req: Request, res: Response): void {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  if (!idempotencyKey) {
    res.status(400).json({ code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required', requestId: req.requestId });
    return;
  }
  const existing = getExperimentByIdempotencyKey(idempotencyKey);
  if (existing) {
    res.status(202).json({ experimentId: existing.id, candidateId: existing.candidate_id, status: existing.status,
      message: 'Existing idempotent experiment returned', requestId: req.requestId });
    return;
  }
  const parsed = experimentOptionsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_EXPERIMENT_REQUEST', message: 'Stress-test configuration is invalid',
      details: parsed.error.issues, requestId: req.requestId });
    return;
  }
  const { id } = req.params as { id: string };
  const profile = loadRegistry().get(id);
  if (!profile) {
    res.status(404).json({ code: 'NOT_FOUND', message: `Architecture ${id} not found`, requestId: req.requestId });
    return;
  }
  try {
    loadCostCatalog(parsed.data.costCatalogVersion);
    loadNormalizationBounds(parsed.data.scoreBoundsVersion);
    assertSnapshotAvailable(parsed.data.datasetProfile);
    const candidate = {
      schemaVersion: '1.0.0', candidateId: `direct-${id}-${crypto.randomUUID()}`,
      architectureId: id, architectureFamily: profile.family,
      priorities: [
        { metric: 'p99_ms', operator: 'LTE', target: parsed.data.slo.p99Ms, weight: 0.45 },
        { metric: 'monthly_cost_usd', operator: 'MIN', weight: 0.30 },
        { metric: 'scalability', operator: 'MAX', weight: 0.25 },
      ],
      components: profile.allowedRoles,
      decisions: {
        cache: { enabled: profile.cache.enabled, targets: profile.cache.enabled ? ['product', 'cart'] : [],
          ...(profile.cache.enabled ? { ttlSeconds: 60 } : {}) },
        messaging: profile.messaging,
        scalingProfile: profile.scalingProfile,
        communication: profile.communication,
      },
      assumptions: ['Direct registry stress test using evaluator-controlled resources'],
      rationale: [`User selected immutable architecture profile ${id}`],
    };
    const validation = validateCandidate(candidate);
    if (!validation.valid) throw new Error(`Generated registry candidate is invalid: ${JSON.stringify(validation.errors)}`);
    const candidateId = insertCandidate({ candidateId: candidate.candidateId, modelName: 'direct-selection',
      promptId: 'registry-direct-v1', rawJson: JSON.stringify(candidate), normalizedJson: JSON.stringify(candidate),
      validationStatus: 'VALID', architectureId: id });
    const { protocolVersion, ...options } = parsed.data;
    const experimentId = insertExperiment({ ...options, ...(protocolVersion ? { protocolVersion } : {}), name: parsed.data.name ?? `${id} direct stress test`,
      candidateId, idempotencyKey });
    res.status(202).json({ experimentId, candidateId, status: 'PENDING', architectureId: id,
      message: 'Architecture stress test created and queued', requestId: req.requestId });
  } catch (error) {
    res.status(400).json({ code: 'INVALID_FROZEN_INPUT', message: error instanceof Error ? error.message : String(error), requestId: req.requestId });
  }
}

export function getExperimentController(req: Request, res: Response): void {
  const { id } = req.params as { id: string };
  const exp = getExperimentById(id);
  if (!exp) {
    res.status(404).json({ code: 'NOT_FOUND', message: `Experiment ${id} not found`, requestId: req.requestId });
    return;
  }

  const runs = getRunsByExperimentId(id);
  res.json({
    ...exp,
    load_levels_json: JSON.parse(exp.load_levels_json),
    slo_json: JSON.parse(exp.slo_json),
    runs: runs.map(r => ({
      ...r,
      metrics_json: r.metrics_json ? JSON.parse(r.metrics_json) : null,
      cost_json: r.cost_json ? JSON.parse(r.cost_json) : null,
      gates_json: r.gates_json ? JSON.parse(r.gates_json) : null,
      scores_json: r.scores_json ? JSON.parse(r.scores_json) : null,
      transitions: getTransitions(r.id),
    })),
  });
}

export function listExperimentsController(req: Request, res: Response): void {
  const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    status: z.string().max(32).optional(),
    architectureId: z.string().regex(/^A(?:0[1-9]|1[0-2])$/).optional(),
    workloadProfile: z.enum(['BROWSING_V1', 'MIXED_V1', 'CHECKOUT_V1', 'FLASH_SALE_V1']).optional(),
    modelName: z.string().max(120).optional(),
    search: z.string().max(160).optional(),
    createdFrom: z.iso.datetime().optional(),
    createdTo: z.iso.datetime().optional(),
  }).strict();
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_QUERY', message: 'Experiment filters are invalid',
      details: parsed.error.issues, requestId: req.requestId });
    return;
  }
  const { limit, offset } = parsed.data;
  const filterOpts: Parameters<typeof listExperiments>[0] = {};
  if (parsed.data.status) filterOpts.status = parsed.data.status;
  if (parsed.data.architectureId) filterOpts.architectureId = parsed.data.architectureId;
  if (parsed.data.workloadProfile) filterOpts.workloadProfile = parsed.data.workloadProfile;
  if (parsed.data.modelName) filterOpts.modelName = parsed.data.modelName;
  if (parsed.data.search) filterOpts.search = parsed.data.search;
  if (parsed.data.createdFrom) filterOpts.createdFrom = parsed.data.createdFrom;
  if (parsed.data.createdTo) filterOpts.createdTo = parsed.data.createdTo;
  const result = listExperiments(filterOpts);
  const dashboard = getDashboardData();
  const registry = loadRegistry();
  const familyTotals = new Map<string, { total: number; passed: number }>();
  for (const run of dashboard.gateRuns) {
    const family = run.architecture_id ? registry.get(run.architecture_id)?.family ?? 'UNKNOWN' : 'UNKNOWN';
    const counts = familyTotals.get(family) ?? { total: 0, passed: 0 };
    counts.total += 1;
    try {
      const gates = JSON.parse(run.gates_json) as { allPassed?: boolean; feasible?: boolean };
      if (gates.allPassed === true || gates.feasible === true) counts.passed += 1;
    } catch { /* corrupt legacy rows count as non-passing */ }
    familyTotals.set(family, counts);
  }
  const workloadP99 = new Map<string, number[]>();
  for (const row of dashboard.metrics) {
    try {
      const metrics = JSON.parse(row.metrics_json) as { p99Ms?: number; httpReqDuration?: { p99?: number } };
      const p99 = metrics.p99Ms ?? metrics.httpReqDuration?.p99;
      if (typeof p99 === 'number' && Number.isFinite(p99)) {
        const values = workloadP99.get(row.workload_profile) ?? [];
        values.push(p99);
        workloadP99.set(row.workload_profile, values);
      }
    } catch { /* ignore corrupt legacy rows in dashboard summaries */ }
  }
  const statusCounts = Object.fromEntries(dashboard.statusCounts.map((row) => [row.status, row.count]));
  res.json({
    experiments: result.experiments.map(e => ({
      ...e,
      load_levels_json: JSON.parse(e.load_levels_json),
      slo_json: JSON.parse(e.slo_json),
    })),
    total: result.total,
    limit,
    offset,
    summary: {
      statusCounts,
      invalidCandidates: dashboard.invalidCandidates,
      passRateByFamily: Array.from(familyTotals, ([family, counts]) => ({
        family, passRate: counts.total ? counts.passed / counts.total : 0, total: counts.total,
      })),
      averageP99ByWorkload: Array.from(workloadP99, ([workload, values]) => ({
        workload, averageP99Ms: values.reduce((sum, value) => sum + value, 0) / values.length,
      })),
    },
  });
}

export function getExperimentResultsController(req: Request, res: Response): void {
  const { id } = req.params as { id: string };
  const exp = getExperimentById(id);
  if (!exp) {
    res.status(404).json({ code: 'NOT_FOUND', message: `Experiment ${id} not found`, requestId: req.requestId });
    return;
  }

  const runs = getRunsByExperimentId(id);
  const completedRuns = runs.filter(r => r.state === 'COMPLETED' || r.state === 'CLEANING');

  res.json({
    experimentId: id,
    status: exp.status,
    totalRuns: runs.length,
    completedRuns: completedRuns.length,
    results: completedRuns.map(r => ({
      runId: r.id,
      runNumber: r.run_number,
      loadRps: r.load_rps,
      metrics: r.metrics_json ? JSON.parse(r.metrics_json) : null,
      cost: r.cost_json ? JSON.parse(r.cost_json) : null,
      gates: r.gates_json ? JSON.parse(r.gates_json) : null,
      scores: r.scores_json ? JSON.parse(r.scores_json) : null,
    })),
  });
}

export function cancelExperimentController(req: Request, res: Response): void {
  const { id } = req.params as { id: string };
  const result = cancelExperiment(id);
  if (result) {
    res.json({ message: 'Cancellation requested', requestId: req.requestId });
  } else {
    res.status(409).json({ code: 'CANNOT_CANCEL', message: 'Experiment cannot be cancelled in current state', requestId: req.requestId });
  }
}
