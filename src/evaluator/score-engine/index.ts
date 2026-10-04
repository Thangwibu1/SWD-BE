import type { Logger } from '../../utils/logger.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface GateConfig {
  p99Ms: number;
  errorRateMax: number;
  consistencyViolationsMax: number;
}

export interface GateResult {
  code: string;
  passed: boolean;
  observed: number | string;
  threshold: number | string;
  message: string;
}

export interface GatesOutput {
  allPassed: boolean;
  feasible: boolean;
  gates: GateResult[];
}

export interface MetricValues {
  p99Ms: number;
  errorRate: number;
  droppedIterations: number;
  consistencyViolations: number;
  oomKills: number;
  unexpectedCrashes: number;
  measurementDurationSeconds: number;
  sampleCount: number;
  metricCoveragePercent: number;
  loadHostCpuPercent?: number;
  expectedMeasurementDurationSeconds?: number;
  minimumSampleCount?: number;
  offeredRps?: number;
  achievedOperationRps?: number;
}

export interface NormalizationBounds {
  lower: number;
  upper: number;
}

const REQUIRED_BOUND_KEYS = [
  'p99_ms', 'error_rate', 'throughput_rps', 'monthly_cost_usd',
  'cpu_efficiency', 'memory_peak_mib',
] as const;

export function loadNormalizationBounds(version: string): Record<string, NormalizationBounds> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version)) {
    throw new Error(`Invalid score bounds version: ${version}`);
  }
  const filePath = path.resolve('score-bounds', `${version}.json`);
  const catalog = JSON.parse(readFileSync(filePath, 'utf8')) as {
    version?: unknown;
    bounds?: Record<string, { lower?: unknown; upper?: unknown }>;
  };
  if (catalog.version !== version || !catalog.bounds) {
    throw new Error(`Score bounds catalog ${version} has an invalid version or bounds object`);
  }
  for (const key of REQUIRED_BOUND_KEYS) {
    const bound = catalog.bounds[key];
    if (!bound || typeof bound.lower !== 'number' || typeof bound.upper !== 'number'
      || !Number.isFinite(bound.lower) || !Number.isFinite(bound.upper) || bound.lower >= bound.upper) {
      throw new Error(`Score bounds catalog ${version} has invalid bounds for ${key}`);
    }
  }
  return catalog.bounds as Record<string, NormalizationBounds>;
}

export interface DimensionScore {
  dimension: string;
  rawValue: number;
  normalizedScore: number; // 0-100
  direction: 'lower-is-better' | 'higher-is-better';
  bounds: NormalizationBounds;
}

export interface ScoreResult {
  feasible: boolean;
  gates: GatesOutput;
  dimensions: DimensionScore[];
  weightedUtility: number | null;
}

/**
 * Check hard gates per guide section 22.1
 */
export function checkGates(
  metrics: MetricValues,
  slo: GateConfig,
  logger: Logger,
): GatesOutput {
  const gates: GateResult[] = [];

  // Gate 1: P99 meets SLO
  gates.push({
    code: 'GATE_P99',
    passed: metrics.p99Ms <= slo.p99Ms,
    observed: Math.round(metrics.p99Ms * 100) / 100,
    threshold: slo.p99Ms,
    message: `P99 latency ${metrics.p99Ms.toFixed(2)}ms vs SLO ${slo.p99Ms}ms`,
  });

  gates.push({
    code: 'GATE_LOAD_GENERATOR_CPU',
    passed: (metrics.loadHostCpuPercent ?? 0) <= 70,
    observed: Math.round((metrics.loadHostCpuPercent ?? 0) * 10) / 10,
    threshold: 70,
    message: `Load-host CPU ${(metrics.loadHostCpuPercent ?? 0).toFixed(1)}% vs max 70%`,
  });

  // Gate 2: Error rate meets threshold
  gates.push({
    code: 'GATE_ERROR_RATE',
    passed: metrics.errorRate <= slo.errorRateMax,
    observed: Math.round(metrics.errorRate * 10000) / 10000,
    threshold: slo.errorRateMax,
    message: `Error rate ${(metrics.errorRate * 100).toFixed(2)}% vs max ${(slo.errorRateMax * 100).toFixed(2)}%`,
  });

  // Gate 3: dropped_iterations = 0
  gates.push({
    code: 'GATE_DROPPED_ITERATIONS',
    passed: metrics.droppedIterations === 0,
    observed: metrics.droppedIterations,
    threshold: 0,
    message: `Dropped iterations: ${metrics.droppedIterations}`,
  });

  const minimumAchievedRatio = 0.95;
  const achievedRatio = metrics.offeredRps && metrics.achievedOperationRps !== undefined
    ? metrics.achievedOperationRps / metrics.offeredRps
    : 1;
  gates.push({
    code: 'GATE_ACHIEVED_RATE',
    passed: achievedRatio >= minimumAchievedRatio,
    observed: Math.round(achievedRatio * 10_000) / 100,
    threshold: minimumAchievedRatio * 100,
    message: `Achieved operation rate ${(achievedRatio * 100).toFixed(2)}% of offered rate`,
  });

  // Gate 4: No critical invariant violations
  gates.push({
    code: 'GATE_CORRECTNESS',
    passed: metrics.consistencyViolations <= slo.consistencyViolationsMax,
    observed: metrics.consistencyViolations,
    threshold: slo.consistencyViolationsMax,
    message: `Consistency violations: ${metrics.consistencyViolations}`,
  });

  // Gate 5: No OOM or unexpected crash
  gates.push({
    code: 'GATE_STABILITY',
    passed: metrics.oomKills === 0 && metrics.unexpectedCrashes === 0,
    observed: `OOM=${metrics.oomKills}, crashes=${metrics.unexpectedCrashes}`,
    threshold: '0',
    message: `OOM kills: ${metrics.oomKills}, crashes: ${metrics.unexpectedCrashes}`,
  });

  // Gate 6: Measurement validity
  const minimumDuration = (metrics.expectedMeasurementDurationSeconds ?? 0) * 0.95;
  const minimumSamples = metrics.minimumSampleCount ?? 1;
  gates.push({
    code: 'GATE_MEASUREMENT_VALID',
    passed: metrics.metricCoveragePercent >= 95
      && metrics.measurementDurationSeconds >= minimumDuration
      && metrics.sampleCount >= minimumSamples,
    observed: `coverage=${metrics.metricCoveragePercent.toFixed(1)}%, duration=${metrics.measurementDurationSeconds.toFixed(1)}s, samples=${metrics.sampleCount}`,
    threshold: `coverage>=95%, duration>=${minimumDuration.toFixed(1)}s, samples>=${minimumSamples}`,
    message: `Metric coverage: ${metrics.metricCoveragePercent.toFixed(1)}%, duration: ${metrics.measurementDurationSeconds.toFixed(1)}s, samples: ${metrics.sampleCount}`,
  });

  const allPassed = gates.every(g => g.passed);
  const feasible = allPassed; // INFEASIBLE if any gate fails

  logger.info({
    allPassed,
    gateResults: gates.map(g => `${g.code}:${g.passed ? 'PASS' : 'FAIL'}`).join(', '),
  }, 'Gate check complete');

  return { allPassed, feasible, gates };
}

/**
 * Normalize a metric value to 0-100 score per guide section 22.2
 */
export function normalizeMetric(
  value: number,
  bounds: NormalizationBounds,
  direction: 'lower-is-better' | 'higher-is-better',
): number {
  const range = bounds.upper - bounds.lower;
  if (range === 0) return 50; // Degenerate case

  let score: number;
  if (direction === 'lower-is-better') {
    score = 100 * (bounds.upper - value) / range;
  } else {
    score = 100 * (value - bounds.lower) / range;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Compute dimension scores from raw metrics.
 */
export function computeScores(
  metrics: {
    p99Ms: number;
    errorRate: number;
    achievedRps: number;
    cpuEfficiency: number;
    memoryPeakMiB: number;
    costMonth: number;
    consistencyViolations: number;
  },
  bounds: Record<string, NormalizationBounds>,
  weights: Array<{ metric: string; weight: number }>,
  logger: Logger,
  p99SloMs?: number,
): { dimensions: DimensionScore[]; weightedUtility: number | null } {
  const dimensions: DimensionScore[] = [];

  const dimensionDefs: Array<{
    dimension: string;
    rawValue: number;
    direction: 'lower-is-better' | 'higher-is-better';
    boundsKey: string;
  }> = [
    { dimension: 'p99_ms', rawValue: metrics.p99Ms, direction: 'lower-is-better', boundsKey: 'p99_ms' },
    { dimension: 'error_rate', rawValue: metrics.errorRate, direction: 'lower-is-better', boundsKey: 'error_rate' },
    { dimension: 'throughput_rps', rawValue: metrics.achievedRps, direction: 'higher-is-better', boundsKey: 'throughput_rps' },
    { dimension: 'monthly_cost_usd', rawValue: metrics.costMonth, direction: 'lower-is-better', boundsKey: 'monthly_cost_usd' },
    { dimension: 'cpu_efficiency', rawValue: metrics.cpuEfficiency, direction: 'higher-is-better', boundsKey: 'cpu_efficiency' },
    { dimension: 'memory_peak_mib', rawValue: metrics.memoryPeakMiB, direction: 'lower-is-better', boundsKey: 'memory_peak_mib' },
  ];

  for (const def of dimensionDefs) {
    const b = bounds[def.boundsKey] ?? { lower: 0, upper: 100 };
    const normalizedScore = def.dimension === 'p99_ms' && p99SloMs !== undefined && def.rawValue <= p99SloMs
      ? 100
      : normalizeMetric(def.rawValue, b, def.direction);
    dimensions.push({
      dimension: def.dimension,
      rawValue: def.rawValue,
      normalizedScore,
      direction: def.direction,
      bounds: b,
    });
  }

  // Weighted utility (auxiliary view)
  let weightedUtility: number | null = null;
  if (weights.length > 0) {
    let totalWeight = 0;
    let totalScore = 0;
    for (const w of weights) {
      const dim = dimensions.find(d => d.dimension === w.metric);
      if (dim) {
        totalScore += dim.normalizedScore * w.weight;
        totalWeight += w.weight;
      }
    }
    if (totalWeight > 0) {
      weightedUtility = Math.round((totalScore / totalWeight) * 100) / 100;
    }
  }

  logger.info({
    dimensions: dimensions.map(d => `${d.dimension}=${d.normalizedScore.toFixed(1)}`).join(', '),
    weightedUtility,
  }, 'Score computation complete');

  return { dimensions, weightedUtility };
}

/**
 * Compute gates from load and oracle results, then compute scores.
 */
export function computeGates(
  loadResult: { droppedIterations: number; httpReqDuration: { p99: number }; httpReqFailed: number },
  oracleResult: { violations: Array<{ passed?: boolean; severity?: string }> },
  slo: GateConfig,
  logger: Logger,
  validity: {
    oomKills?: number;
    unexpectedCrashes?: number;
    measurementDurationSeconds?: number;
    sampleCount?: number;
    metricCoveragePercent?: number;
    loadHostCpuPercent?: number;
    expectedMeasurementDurationSeconds?: number;
    minimumSampleCount?: number;
    offeredRps?: number;
    achievedOperationRps?: number;
  } = {},
): GatesOutput {
  const criticalViolations = oracleResult.violations.filter(
    (violation) => violation.passed === false && violation.severity === 'CRITICAL',
  ).length;
  const metrics: MetricValues = {
    p99Ms: loadResult.httpReqDuration.p99,
    errorRate: loadResult.httpReqFailed,
    droppedIterations: loadResult.droppedIterations,
    consistencyViolations: criticalViolations,
    oomKills: validity.oomKills ?? 0,
    unexpectedCrashes: validity.unexpectedCrashes ?? 0,
    measurementDurationSeconds: validity.measurementDurationSeconds ?? 0,
    sampleCount: validity.sampleCount ?? 0,
    metricCoveragePercent: validity.metricCoveragePercent ?? 0,
    loadHostCpuPercent: validity.loadHostCpuPercent ?? 100,
    ...(validity.offeredRps !== undefined ? { offeredRps: validity.offeredRps } : {}),
    ...(validity.achievedOperationRps !== undefined ? { achievedOperationRps: validity.achievedOperationRps } : {}),
    ...(validity.expectedMeasurementDurationSeconds !== undefined
      ? { expectedMeasurementDurationSeconds: validity.expectedMeasurementDurationSeconds }
      : {}),
    ...(validity.minimumSampleCount !== undefined
      ? { minimumSampleCount: validity.minimumSampleCount }
      : {}),
  };

  return checkGates(metrics, slo, logger);
}
