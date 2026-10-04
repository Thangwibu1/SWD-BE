import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { loadRegistry } from '../src/evaluator/registry/index.js';
import { validateCandidate } from '../src/evaluator/architecture-validator/index.js';
import { insertCandidate } from '../src/metadata/repositories/candidates.js';
import { insertExperiment } from '../src/metadata/repositories/experiments.js';
import { assertSnapshotAvailable } from '../src/sut/shared/database/snapshot.js';

interface Protocol {
  version: string;
  seed: number;
  architectures: string[];
  workloads: string[];
  loadLevelsRps: number[];
  repetitions: number;
  warmupSeconds: number;
  measureSeconds: number;
  cooldownSeconds: number;
  costCatalogVersion: string;
  scoreBoundsVersion: string;
  slo: { p99Ms: number; errorRateMax: number; consistencyViolationsMax: number };
  invalidRetryLimit: number;
  datasetProfile?: 'pilot' | 'main' | 'capacity';
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function shuffle<T>(values: T[], seed: number): T[] {
  const result = [...values];
  const next = random(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(next() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

const protocolPath = path.resolve(process.argv[2] ?? 'protocols/pilot-v1.yaml');
const dryRun = process.argv.includes('--dry-run');
const apiUrl = process.env['EVALUATOR_API_URL'];
const protocol = YAML.parse(readFileSync(protocolPath, 'utf8')) as Protocol;
if (protocol.seed !== 20261001) throw new Error('Worker snapshot seed is fixed at 20261001; a different seed is not supported');
if (!Array.isArray(protocol.loadLevelsRps) || !protocol.loadLevelsRps.length || protocol.loadLevelsRps.length > 10
  || new Set(protocol.loadLevelsRps).size !== protocol.loadLevelsRps.length
  || protocol.loadLevelsRps.some((rate) => !Number.isInteger(rate) || rate < 1 || rate > 10_000)) {
  throw new Error('Protocol requires 1-10 distinct integer load levels between 1 and 10000');
}
if (!protocol.version || !Number.isInteger(protocol.seed) || ![1, 3, 5].includes(protocol.repetitions)) {
  throw new Error('Protocol must have a version, integer seed, and 1, 3, or 5 repetitions');
}
if (!protocol.version.startsWith('capacity') && protocol.repetitions === 1) throw new Error('One repetition is reserved for capacity discovery');
if (protocol.version.startsWith('main') && protocol.repetitions !== 5) throw new Error('Main protocol requires 5 repetitions');
const publicationReady = protocol.costCatalogVersion !== 'research-v1'
  && protocol.scoreBoundsVersion !== 'development-v1'
  && protocol.loadLevelsRps.length >= 4 && protocol.loadLevelsRps.length <= 6;
if (protocol.version.startsWith('main') && !dryRun && !publicationReady) {
  throw new Error('Main protocol is not publication-ready: freeze 4-6 pilot-derived loads, a dated cost catalog, and pilot-derived score bounds first');
}
const datasetProfile = protocol.datasetProfile ?? (protocol.version.startsWith('main') ? 'main' : 'pilot');
if (!dryRun && !apiUrl) assertSnapshotAvailable(datasetProfile, protocol.seed);

const registry = loadRegistry();
const jobs = protocol.workloads.flatMap((workload, block) =>
  shuffle(protocol.architectures, protocol.seed + block).map((architectureId) => ({ architectureId, workload })));
const created: Array<{ architectureId: string; workload: string; experimentId: string }> = [];

for (const job of jobs) {
  const profile = registry.get(job.architectureId);
  if (!profile) throw new Error(`Unknown architecture ${job.architectureId}`);
  const candidate = {
    schemaVersion: '1.0.0', candidateId: `${protocol.version}-${job.architectureId}-${job.workload}`,
    architectureId: job.architectureId, architectureFamily: profile.family,
    priorities: [
      { metric: 'p99_ms', operator: 'LTE', target: protocol.slo.p99Ms, weight: 0.45 },
      { metric: 'monthly_cost_usd', operator: 'MIN', weight: 0.30 },
      { metric: 'scalability', operator: 'MAX', weight: 0.25 },
    ],
    components: profile.allowedRoles,
    decisions: {
      cache: { enabled: profile.cache.enabled, targets: profile.cache.enabled ? ['product', 'cart'] : [], ...(profile.cache.enabled ? { ttlSeconds: 60 } : {}) },
      messaging: { enabled: profile.messaging.enabled, broker: profile.messaging.broker },
      scalingProfile: profile.scalingProfile, communication: profile.communication,
    },
    assumptions: ['Controlled single-host benchmark'], rationale: [`Evaluate fixed profile ${job.architectureId}`],
  };
  const validation = validateCandidate(candidate);
  if (!validation.valid) throw new Error(`${job.architectureId} generated candidate invalid: ${JSON.stringify(validation.errors)}`);
  if (dryRun) continue;
  if (apiUrl) {
    const request = {
      candidate, name: `${protocol.version} ${job.architectureId} ${job.workload}`,
      modelMetadata: { modelName: 'protocol-runner', promptId: protocol.version },
      workloadProfile: job.workload, loadLevelsRps: protocol.loadLevelsRps, slo: protocol.slo,
      costCatalogVersion: protocol.costCatalogVersion, scoreBoundsVersion: protocol.scoreBoundsVersion,
      repetitions: protocol.repetitions, protocolVersion: protocol.version, datasetProfile,
      invalidRetryLimit: protocol.invalidRetryLimit, warmupSeconds: protocol.warmupSeconds,
      measureSeconds: protocol.measureSeconds, cooldownSeconds: protocol.cooldownSeconds,
    };
    const body = JSON.stringify(request);
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v1/experiments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'Idempotency-Key': `protocol-${createHash('sha256').update(body).digest('hex')}` },
      body, signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as { experimentId?: string; message?: string };
    if (!response.ok || !result.experimentId) throw new Error(`Protocol submission failed: ${response.status} ${JSON.stringify(result)}`);
    created.push({ ...job, experimentId: result.experimentId });
    continue;
  }
  const candidateId = insertCandidate({
    candidateId: candidate.candidateId, modelName: 'protocol-runner', promptId: protocol.version,
    rawJson: JSON.stringify(candidate), normalizedJson: JSON.stringify(candidate), validationStatus: 'VALID', architectureId: job.architectureId,
  });
  const experimentId = insertExperiment({
    name: `${protocol.version} ${job.architectureId} ${job.workload}`, candidateId,
    workloadProfile: job.workload, loadLevelsRps: protocol.loadLevelsRps, slo: protocol.slo,
    costCatalogVersion: protocol.costCatalogVersion, repetitions: protocol.repetitions,
    scoreBoundsVersion: protocol.scoreBoundsVersion, protocolVersion: protocol.version,
    invalidRetryLimit: protocol.invalidRetryLimit,
    datasetProfile,
    warmupSeconds: protocol.warmupSeconds, measureSeconds: protocol.measureSeconds, cooldownSeconds: protocol.cooldownSeconds,
  });
  created.push({ ...job, experimentId });
}

console.log(JSON.stringify({ protocol: protocol.version, publicationReady, dryRun, jobCount: jobs.length, randomizedOrder: jobs, created }, null, 2));
