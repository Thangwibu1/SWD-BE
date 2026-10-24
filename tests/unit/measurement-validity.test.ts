import { describe, expect, it } from 'vitest';
import { checkGates, type MetricValues } from '../../src/evaluator/score-engine/index.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger('test', 'silent');
const baseline: MetricValues = {
  p99Ms: 50, errorRate: 0, droppedIterations: 0, consistencyViolations: 0,
  oomKills: 0, unexpectedCrashes: 0, measurementDurationSeconds: 20.5,
  expectedMeasurementDurationSeconds: 20, sampleCount: 40, metricCoveragePercent: 100,
  offeredRps: 2, achievedOperationRps: 2,
};
const gates = (patch: Partial<MetricValues>) => checkGates({ ...baseline, ...patch },
  { p99Ms: 100, errorRateMax: 0.01, consistencyViolationsMax: 0 }, logger).gates;
const valid = (patch: Partial<MetricValues>) => gates(patch).find(g => g.code === 'GATE_MEASUREMENT_VALID')?.passed;

describe('measurement validity and capacity remain distinct', () => {
  it('accepts normal startup and graceful-stop overhead', () => {
    expect(valid({})).toBe(true);
    expect(valid({ measurementDurationSeconds: 51 })).toBe(true);
  });
  it('rejects the recorded A25 timing anomaly', () => {
    expect(valid({ measurementDurationSeconds: 564.411 })).toBe(false);
  });
  it('continues to reject incomplete windows and missing resource samples', () => {
    expect(valid({ measurementDurationSeconds: 18 })).toBe(false);
    expect(valid({ metricCoveragePercent: 90 })).toBe(false);
    expect(valid({ sampleCount: 0 })).toBe(false);
  });
  it('keeps slow responses and underdelivery as valid capacity failures', () => {
    const result = gates({ p99Ms: 180, achievedOperationRps: 0.5 });
    expect(result.find(g => g.code === 'GATE_MEASUREMENT_VALID')?.passed).toBe(true);
    expect(result.find(g => g.code === 'GATE_P99')?.passed).toBe(false);
    expect(result.find(g => g.code === 'GATE_ACHIEVED_RATE')?.passed).toBe(false);
  });
});
