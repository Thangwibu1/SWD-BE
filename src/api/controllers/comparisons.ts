import type { Request, Response } from 'express';
import { computePareto, type ParetoPoint } from '../../evaluator/pareto-engine/index.js';
import { bootstrapMedian95 } from '../../evaluator/statistics/index.js';
import { getExperimentById, getRunsByExperimentId } from '../../metadata/repositories/experiments.js';
import { createLogger } from '../../utils/logger.js';

interface ParsedRun {
  loadRps: number;
  metrics: { httpReqDuration?: { p99?: number }; httpReqFailed?: number; achievedRps?: number };
  cost: { infraMonth?: number };
  gates: { feasible?: boolean };
  scores: { dimensions?: Array<{ dimension: string; rawValue: number; normalizedScore: number }> };
}

export function compareExperimentsController(req: Request, res: Response): void {
  const body = req.body as { experimentIds?: unknown; weights?: unknown };
  const ids = body.experimentIds;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 10 || ids.some((id) => typeof id !== 'string')) {
    res.status(400).json({ code: 'INVALID_COMPARISON', message: 'experimentIds must contain 2-10 IDs', requestId: req.requestId });
    return;
  }

  const summaries = ids.map((id) => {
    const experiment = getExperimentById(id);
    if (!experiment) return null;
    const runs: ParsedRun[] = getRunsByExperimentId(id)
      .filter((run) => run.state === 'COMPLETED' && run.metrics_json && run.cost_json && run.gates_json && run.scores_json)
      .map((run) => ({
        loadRps: run.load_rps,
        metrics: JSON.parse(run.metrics_json!) as ParsedRun['metrics'],
        cost: JSON.parse(run.cost_json!) as ParsedRun['cost'],
        gates: JSON.parse(run.gates_json!) as ParsedRun['gates'],
        scores: JSON.parse(run.scores_json!) as ParsedRun['scores'],
      }));
    if (runs.length === 0) return null;
    const loadGroups = new Map<number, ParsedRun[]>();
    for (const run of runs) loadGroups.set(run.loadRps, [...(loadGroups.get(run.loadRps) ?? []), run]);
    const sustainableLoads = [...loadGroups].filter(([, group]) =>
      group.filter((run) => run.gates.feasible).length >= Math.ceil(group.length * 0.8),
    ).map(([load]) => load);
    const maxSustainableRps = Math.max(0, ...sustainableLoads);
    const representativeLoad = maxSustainableRps || Math.max(...runs.map((run) => run.loadRps));
    const representative = loadGroups.get(representativeLoad) ?? [];
    const feasible = maxSustainableRps > 0;
    const dimensions = new Map<string, { raw: number[]; normalized: number[] }>();
    for (const run of representative) {
      for (const dimension of run.scores.dimensions ?? []) {
        const current = dimensions.get(dimension.dimension) ?? { raw: [], normalized: [] };
        current.raw.push(dimension.rawValue);
        current.normalized.push(dimension.normalizedScore);
        dimensions.set(dimension.dimension, current);
      }
    }
    const rawDimensions = Object.fromEntries([...dimensions].map(([key, value]) => [key, bootstrapMedian95(value.raw)?.estimate ?? 0]));
    const normalizedScores = Object.fromEntries([...dimensions].map(([key, value]) => [key, bootstrapMedian95(value.normalized)?.estimate ?? 0]));
    return {
      experimentId: id,
      candidateId: experiment.candidate_id,
      architectureId: experiment.architecture_id ?? 'unknown',
      feasible,
      maxSustainableRps,
      p99Ms: bootstrapMedian95(representative.map((run) => run.metrics.httpReqDuration?.p99 ?? 0)),
      errorRate: bootstrapMedian95(representative.map((run) => run.metrics.httpReqFailed ?? 0)),
      monthlyCostUsd: bootstrapMedian95(representative.map((run) => run.cost.infraMonth ?? 0)),
      dimensions: rawDimensions,
      normalizedScores,
    };
  });

  if (summaries.some((summary) => summary === null)) {
    res.status(409).json({ code: 'INCOMPLETE_COMPARISON', message: 'Every experiment must exist and have completed results', requestId: req.requestId });
    return;
  }
  const complete = summaries.filter((summary): summary is NonNullable<typeof summary> => summary !== null);
  const points: ParetoPoint[] = complete.map((summary) => ({
    experimentId: summary.experimentId,
    candidateId: summary.candidateId,
    architectureId: summary.architectureId,
    feasible: summary.feasible,
    isParetoOptimal: false,
    dimensions: summary.dimensions,
    normalizedScores: summary.normalizedScores,
    regret: 0,
  }));
  const dimensions = [...new Set(points.flatMap((point) => Object.keys(point.normalizedScores)))];
  const pareto = computePareto(points, dimensions, createLogger('comparison-api'));
  const suppliedWeights = body.weights && typeof body.weights === 'object' && !Array.isArray(body.weights)
    ? body.weights as Record<string, unknown> : undefined;
  const weights = Object.fromEntries(dimensions.map((dimension) => {
    const value = suppliedWeights?.[dimension];
    return [dimension, typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : suppliedWeights ? 0 : 1];
  }));
  const rank = (scenario: Record<string, number>) => complete.map((summary) => ({
    experimentId: summary.experimentId,
    utility: weightedUtility(summary.normalizedScores, scenario),
  })).sort((left, right) => right.utility - left.utility);
  const baseline = rank(weights);
  const scenarios = dimensions.flatMap((dimension) => [0.8, 1.2].map((factor) => {
    const changed = { ...weights, [dimension]: (weights[dimension] ?? 1) * factor };
    return { dimension, factor, ranking: rank(changed) };
  }));
  const sensitivity = {
    weights,
    baseline,
    scenarios,
    selectionStable: scenarios.every((scenario) => scenario.ranking[0]?.experimentId === baseline[0]?.experimentId),
  };
  res.json({ summaries, pareto, dimensions, confidenceLevel: 0.95, sensitivity });
}

function weightedUtility(scores: Record<string, number>, weights: Record<string, number>): number {
  const entries = Object.entries(weights);
  const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight <= 0) return 0;
  return Math.round(entries.reduce((sum, [dimension, weight]) => sum + (scores[dimension] ?? 0) * weight, 0) / totalWeight * 100) / 100;
}
