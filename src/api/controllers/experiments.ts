import type { Request, Response } from 'express';
import { validateCandidate } from '../../evaluator/architecture-validator/index.js';
import { insertCandidate } from '../../metadata/repositories/candidates.js';
import {
  insertExperiment, getExperimentById, listExperiments,
  getRunsByExperimentId, getTransitions, cancelExperiment,
  updateExperimentStatus,
} from '../../metadata/repositories/experiments.js';

export function createExperimentController(req: Request, res: Response): void {
  try {
    const body = req.body as Record<string, unknown>;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      res.status(400).json({ code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required', requestId: req.requestId });
      return;
    }

    const candidate = body['candidate'] as Record<string, unknown>;
    if (!candidate) {
      res.status(400).json({ code: 'MISSING_CANDIDATE', message: 'candidate field is required', requestId: req.requestId });
      return;
    }

    // Validate candidate
    const valResult = validateCandidate(candidate);
    const modelMeta = body['modelMetadata'] as Record<string, unknown> | undefined;
    const modelName = modelMeta?.['modelName'] as string | undefined;
    const promptId = modelMeta?.['promptId'] as string | undefined;
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
      name: String(body['name'] ?? `Experiment ${new Date().toISOString()}`),
      candidateId,
      workloadProfile: String(body['workloadProfile'] ?? 'MIXED_V1'),
      loadLevelsRps: (body['loadLevelsRps'] as number[]) ?? [25],
      slo: (body['slo'] as { p99Ms: number; errorRateMax: number }) ?? { p99Ms: 100, errorRateMax: 0.01 },
      costCatalogVersion: String(body['costCatalogVersion'] ?? 'research-v1'),
      repetitions: Number(body['repetitions'] ?? 1),
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
    })),
  });
}

export function listExperimentsController(req: Request, res: Response): void {
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '50')), 100);
  const offset = parseInt(String(req.query['offset'] ?? '0'));
  const statusFilter = req.query['status'] as string | undefined;
  const filterOpts: { status?: string; limit?: number; offset?: number } = { limit, offset };
  if (statusFilter) filterOpts.status = statusFilter;
  const result = listExperiments(filterOpts);
  res.json({
    experiments: result.experiments.map(e => ({
      ...e,
      load_levels_json: JSON.parse(e.load_levels_json),
      slo_json: JSON.parse(e.slo_json),
    })),
    total: result.total,
    limit,
    offset,
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
