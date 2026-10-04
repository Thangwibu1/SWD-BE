import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadCostCatalog, computeCost } from '../src/evaluator/cost-engine/index.js';
import { computeGates, computeScores } from '../src/evaluator/score-engine/index.js';
import { buildManifest, buildReport } from '../src/evaluator/report-builder/index.js';
import { createLogger } from '../src/utils/logger.js';

const runDir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(runDir)) throw new Error('Usage: npm run report:rebuild -- <run-directory>');
const readJson = <T>(relative: string): T => JSON.parse(readFileSync(path.join(runDir, relative), 'utf8')) as T;
const experiment = readJson<{ name: string; workloadProfile: string; loadRps: number; measureSeconds: number;
  slo: { p99Ms: number; errorRateMax: number; consistencyViolationsMax?: number }; costCatalogVersion?: string }>('input/experiment.json');
const candidate = readJson<{ architectureId: string; priorities?: Array<{ metric: string; weight: number }> }>('input/candidate.json');
const profile = readJson<{ family: string; cache: { enabled: boolean }; messaging: { enabled: boolean };
  allowedRoles: string[]; resources: Record<string, { cpus: number; memoryMiB: number }> }>('input/resolved-profile.yaml');
const summary = readJson<{ metrics: Record<string, Record<string, number> & { values?: Record<string, number> }> }>('raw/k6-summary.json');
const oracle = readJson<{ violations: Array<{ passed?: boolean; severity?: string }> }>('raw/invariant-output.json');
const environment = readJson<{ measurementEndedAt?: string }>('environment.json');
const metric = (name: string) => summary.metrics[name]?.values ?? summary.metrics[name] ?? {};
const duration = metric('http_req_duration');
const requests = metric('http_reqs');
const dropped = metric('dropped_iterations');
const failed = metric('http_req_failed');
const loadResult = {
  droppedIterations: dropped['count'] ?? 0,
  totalRequests: requests['count'] ?? 0,
  httpReqDuration: { p50: duration['p(50)'] ?? duration['med'] ?? 0, p95: duration['p(95)'] ?? 0,
    p99: duration['p(99)'] ?? 0, avg: duration['avg'] ?? 0, max: duration['max'] ?? 0 },
  httpReqFailed: failed['rate'] ?? failed['value'] ?? 0,
  achievedRps: requests['rate'] ?? 0,
  measurementDurationSeconds: experiment.measureSeconds,
};
const allocations = Object.values(profile.resources);
const totalVCPU = allocations.reduce((sum, resource) => sum + resource.cpus, 0);
const totalMemoryGiB = allocations.reduce((sum, resource) => sum + resource.memoryMiB, 0) / 1024;
const logger = createLogger('report-rebuild');
const catalog = loadCostCatalog(experiment.costCatalogVersion ?? 'research-v1');
const cost = computeCost(catalog, { totalVCPU, totalMemoryGiB, hasRedis: profile.cache.enabled,
  hasRabbitMQ: profile.messaging.enabled, hasLoadBalancer: profile.allowedRoles.includes('api-gateway'),
  replicaCount: profile.allowedRoles.filter((role) => role.includes('replica')).length + 1,
  storageGiB: 10, egressGiBPerMonth: 50 }, profile.family, profile.cache.enabled, profile.messaging.enabled, logger);
const statsPath = path.join(runDir, 'raw', 'container-stats.csv');
const statRows = existsSync(statsPath) ? readFileSync(statsPath, 'utf8').trim().split(/\r?\n/).slice(1) : [];
const memoryPeakMiB = Math.max(0, ...statRows.map((row) => Number(row.split(',')[4] ?? 0)));
const expectedSamples = Math.max(1, Math.floor(experiment.measureSeconds / 2));
const sampleTimes = new Set(statRows.map((row) => row.split(',')[0]));
const gates = computeGates(loadResult, oracle, { ...experiment.slo,
  consistencyViolationsMax: experiment.slo.consistencyViolationsMax ?? 0 }, logger, {
  measurementDurationSeconds: experiment.measureSeconds, sampleCount: loadResult.totalRequests,
  metricCoveragePercent: Math.min(100, sampleTimes.size / expectedSamples * 100),
});
const scores = computeScores({ p99Ms: loadResult.httpReqDuration.p99, errorRate: loadResult.httpReqFailed,
  achievedRps: loadResult.achievedRps, cpuEfficiency: loadResult.totalRequests / (totalVCPU * experiment.measureSeconds || 1),
  memoryPeakMiB, costMonth: cost.infraMonth,
  consistencyViolations: oracle.violations.filter((item) => item.passed === false && item.severity === 'CRITICAL').length }, {
  p99_ms: { lower: 10, upper: 500 }, error_rate: { lower: 0, upper: 0.05 },
  throughput_rps: { lower: 10, upper: 500 }, monthly_cost_usd: { lower: 50, upper: 500 },
  cpu_efficiency: { lower: 1, upper: 100 }, memory_peak_mib: { lower: 512, upper: 4096 },
}, candidate.priorities ?? [], logger);
const generatedAt = environment.measurementEndedAt ?? '1970-01-01T00:00:00.000Z';
buildReport(runDir, { experimentName: experiment.name, architectureId: candidate.architectureId,
  workload: experiment.workloadProfile, loadRps: experiment.loadRps, metrics: loadResult,
  cost: cost as unknown as Record<string, unknown>, gates: gates as unknown as Record<string, unknown>,
  scores: scores as unknown as Record<string, unknown>,
  invariants: oracle, generatedAt, limitations: ['Single-host synthetic benchmark; projected cost depends on the frozen catalog.'] }, logger);
const manifest = buildManifest(runDir, path.basename(path.dirname(runDir)), path.basename(runDir), logger, generatedAt);
console.log(JSON.stringify({ runDir, artifactCount: manifest.artifacts.length, generatedAt }, null, 2));
