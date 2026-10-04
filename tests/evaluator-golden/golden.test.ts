import { describe, it, expect } from 'vitest';
import { checkGates, computeScores, loadNormalizationBounds } from '../../src/evaluator/score-engine/index.js';
import { computeCost, loadCostCatalog } from '../../src/evaluator/cost-engine/index.js';
import { computePareto } from '../../src/evaluator/pareto-engine/index.js';
import { bootstrapMedian95 } from '../../src/evaluator/statistics/index.js';
import { buildManifest, buildReport } from '../../src/evaluator/report-builder/index.js';
import type { MetricValues } from '../../src/evaluator/score-engine/index.js';
import { createTestLogger } from '../helpers/logger.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Golden Tests - Evaluator Engines', () => {
  const logger = createTestLogger();

  describe('checkGates', () => {
    it('should produce expected gate results for passing metrics', () => {
      const metrics: MetricValues = {
        p99Ms: 125.4,
        errorRate: 0.005,
        droppedIterations: 0,
        consistencyViolations: 0,
        oomKills: 0,
        unexpectedCrashes: 0,
        measurementDurationSeconds: 600,
        sampleCount: 30000,
        metricCoveragePercent: 100,
      };

      const slo = {
        p99Ms: 150,
        errorRateMax: 0.01,
        consistencyViolationsMax: 0,
      };

      const gates = checkGates(metrics, slo, logger);

      // Includes the load-generator CPU saturation guard.
      expect(gates.gates).toHaveLength(8);
      expect(gates.allPassed).toBe(true);
      expect(gates.feasible).toBe(true);

      // Find specific gates
      const p99Gate = gates.gates.find(g => g.code === 'GATE_P99');
      expect(p99Gate).toBeDefined();
      expect(p99Gate?.passed).toBe(true);
      expect(p99Gate?.observed).toBe(125.4);
      expect(p99Gate?.threshold).toBe(150);
    });

    it('should fail when P99 exceeds SLO', () => {
      const metrics: MetricValues = {
        p99Ms: 125.4,
        errorRate: 0.005,
        droppedIterations: 0,
        consistencyViolations: 0,
        oomKills: 0,
        unexpectedCrashes: 0,
        measurementDurationSeconds: 600,
        sampleCount: 30000,
        metricCoveragePercent: 100,
      };

      const slo = {
        p99Ms: 100,
        errorRateMax: 0.01,
        consistencyViolationsMax: 0,
      };

      const gates = checkGates(metrics, slo, logger);

      const p99Gate = gates.gates.find(g => g.code === 'GATE_P99');
      expect(p99Gate?.passed).toBe(false);
      expect(gates.allPassed).toBe(false);
      expect(gates.feasible).toBe(false);
    });

    it('should fail when consistency violations occur', () => {
      const metrics: MetricValues = {
        p99Ms: 125.4,
        errorRate: 0.005,
        droppedIterations: 0,
        consistencyViolations: 1, // Has violation
        oomKills: 0,
        unexpectedCrashes: 0,
        measurementDurationSeconds: 600,
        sampleCount: 30000,
        metricCoveragePercent: 100,
      };

      const slo = {
        p99Ms: 150,
        errorRateMax: 0.01,
        consistencyViolationsMax: 0,
      };

      const gates = checkGates(metrics, slo, logger);

      const correctnessGate = gates.gates.find(g => g.code === 'GATE_CORRECTNESS');
      expect(correctnessGate?.passed).toBe(false);
      expect(gates.allPassed).toBe(false);
      expect(gates.feasible).toBe(false);
    });
  });


  describe('computeCost', () => {
    it('should produce deterministic cost calculation', () => {
      const catalog = loadCostCatalog('research-v1');

      const resourceUsage = {
        totalVCPU: 1.5,
        totalMemoryGiB: 3.0,
        hasRedis: true,
        hasRabbitMQ: false,
        hasLoadBalancer: false,
        replicaCount: 1,
        storageGiB: 10,
        egressGiBPerMonth: 50,
      };

      const cost = computeCost(
        catalog,
        resourceUsage,
        'MODULAR_MONOLITH',
        true,
        false,
        logger
      );

      // Verify deterministic calculation
      // vcpuHour = 0.031, gbRamHour = 0.0042, hoursPerMonth = 730
      const expectedComputeMonth = 730 * (1.5 * 0.031 + 3.0 * 0.0042);
      const expectedManagedServices = 20 + 10; // postgres + redis

      expect(cost.computeMonth).toBeCloseTo(expectedComputeMonth, 2);
      expect(cost.managedServicesMonth).toBe(expectedManagedServices);
      expect(cost.infraMonth).toBeGreaterThan(0);
      expect(cost.tco12m).toBeGreaterThan(0);
      expect(cost.engineeringComplexity).toBe('LOW');
    });

    it('should add RabbitMQ cost when messaging enabled', () => {
      const catalog = loadCostCatalog('research-v1');

      const resourceUsage = {
        totalVCPU: 1.5,
        totalMemoryGiB: 3.0,
        hasRedis: false,
        hasRabbitMQ: true,
        hasLoadBalancer: false,
        replicaCount: 1,
        storageGiB: 10,
        egressGiBPerMonth: 50,
      };

      const cost = computeCost(
        catalog,
        resourceUsage,
        'EVENT_DRIVEN_MICROSERVICES',
        false,
        true,
        logger
      );

      // Should include postgres (20) + rabbitmq (15)
      expect(cost.managedServicesMonth).toBe(35);
      expect(cost.engineeringComplexity).toBe('HIGH');
    });
  });


  describe('Full pipeline golden test', () => {
    it('should produce identical results from same raw inputs', () => {
      // This tests determinism - running twice should give identical output
      const catalog = loadCostCatalog('research-v1');

      const metrics: MetricValues = {
        p99Ms: 125.4,
        errorRate: 0.005,
        droppedIterations: 0,
        consistencyViolations: 0,
        oomKills: 0,
        unexpectedCrashes: 0,
        measurementDurationSeconds: 600,
        sampleCount: 30000,
        metricCoveragePercent: 100,
      };

      const slo = {
        p99Ms: 150,
        errorRateMax: 0.01,
        consistencyViolationsMax: 0,
      };

      const resourceUsage = {
        totalVCPU: 1.5,
        totalMemoryGiB: 3.0,
        hasRedis: true,
        hasRabbitMQ: false,
        hasLoadBalancer: false,
        replicaCount: 1,
        storageGiB: 10,
        egressGiBPerMonth: 50,
      };

      // Run 1
      const gates1 = checkGates(metrics, slo, logger);
      const cost1 = computeCost(catalog, resourceUsage, 'MODULAR_MONOLITH', true, false, logger);

      // Run 2
      const gates2 = checkGates(metrics, slo, logger);
      const cost2 = computeCost(catalog, resourceUsage, 'MODULAR_MONOLITH', true, false, logger);

      // Should be identical
      expect(gates1).toEqual(gates2);
      expect(cost1).toEqual(cost2);
    });
  });

  describe('score, Pareto, regret and confidence intervals', () => {
    it('loads immutable versioned normalization bounds and rejects traversal', () => {
      expect(loadNormalizationBounds('development-v1').p99_ms).toEqual({ lower: 10, upper: 500 });
      expect(() => loadNormalizationBounds('../development-v1')).toThrow('Invalid score bounds version');
    });

    it('matches deterministic score and Pareto output', () => {
      const bounds = {
        p99_ms: { lower: 50, upper: 250 }, error_rate: { lower: 0, upper: 0.05 },
        throughput_rps: { lower: 25, upper: 300 }, monthly_cost_usd: { lower: 50, upper: 250 },
        cpu_efficiency: { lower: 10, upper: 100 }, memory_peak_mib: { lower: 512, upper: 4096 },
      };
      const scored = computeScores({ p99Ms: 100, errorRate: 0.01, achievedRps: 200, cpuEfficiency: 55,
        memoryPeakMiB: 1024, costMonth: 100, consistencyViolations: 0 }, bounds,
      [{ metric: 'p99_ms', weight: 0.5 }, { metric: 'monthly_cost_usd', weight: 0.5 }], logger);
      expect(scored.weightedUtility).toBe(75);

      const pareto = computePareto([
        { experimentId: 'a', candidateId: 'a', architectureId: 'A01', feasible: true, isParetoOptimal: false,
          dimensions: {}, normalizedScores: { performance: 90, cost: 60 }, regret: 0 },
        { experimentId: 'b', candidateId: 'b', architectureId: 'A02', feasible: true, isParetoOptimal: false,
          dimensions: {}, normalizedScores: { performance: 70, cost: 90 }, regret: 0 },
        { experimentId: 'c', candidateId: 'c', architectureId: 'A03', feasible: true, isParetoOptimal: false,
          dimensions: {}, normalizedScores: { performance: 60, cost: 50 }, regret: 0 },
      ], ['performance', 'cost'], logger);
      expect(pareto.frontierIds).toEqual(['a', 'b']);
      expect(pareto.points.find((point) => point.experimentId === 'c')?.regret).toBe(35);
      expect(bootstrapMedian95([100, 105, 110, 115, 120])).toEqual(bootstrapMedian95([100, 105, 110, 115, 120]));
    });
  });

  describe('deterministic report artifacts', () => {
    it('rebuilds byte-identical report and manifest from fixed input', () => {
      const first = mkdtempSync(path.join(os.tmpdir(), 'arch-report-a-'));
      const second = mkdtempSync(path.join(os.tmpdir(), 'arch-report-b-'));
      const data = { experimentName: 'Golden', architectureId: 'A01', workload: 'MIXED_V1', loadRps: 50,
        metrics: { p99: 100 }, cost: { infraMonth: 80 }, gates: { feasible: true }, scores: { utility: 75 },
        invariants: { passed: true }, generatedAt: '2026-10-01T00:00:00.000Z' };
      try {
        for (const directory of [first, second]) {
          mkdirSync(path.join(directory, 'raw'), { recursive: true });
          writeFileSync(path.join(directory, 'raw', 'evidence.json'), '{"ok":true}');
          buildReport(directory, data, logger);
          buildManifest(directory, 'experiment', 'run', logger, data.generatedAt);
        }
        expect(readFileSync(path.join(first, 'report.html'), 'utf8')).toBe(readFileSync(path.join(second, 'report.html'), 'utf8'));
        expect(readFileSync(path.join(first, 'manifest.json'), 'utf8')).toBe(readFileSync(path.join(second, 'manifest.json'), 'utf8'));
      } finally {
        rmSync(first, { recursive: true, force: true });
        rmSync(second, { recursive: true, force: true });
      }
    });
  });
});
