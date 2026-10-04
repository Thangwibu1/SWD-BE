import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getEvaluatorDb } from '../src/metadata/sqlite.js';

interface Row { workload_profile: string; load_rps: number; metrics_json: string; cost_json: string; gates_json: string }

const protocolVersion = process.argv[2] ?? 'pilot-v1';
const outputVersion = process.argv[3] ?? `${protocolVersion}-bounds`;
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(outputVersion)) throw new Error('Unsafe output bounds version');
const db = getEvaluatorDb();
const rows = db.prepare(`SELECT e.workload_profile, r.load_rps, r.metrics_json, r.cost_json, r.gates_json
  FROM experiment_runs r JOIN experiments e ON e.id = r.experiment_id
  WHERE e.protocol_version = ? AND r.state = 'COMPLETED' AND r.metrics_json IS NOT NULL
  ORDER BY e.workload_profile, r.load_rps`).all(protocolVersion) as Row[];
if (rows.length === 0) throw new Error(`No completed evidence for protocol ${protocolVersion}`);

const values: Record<string, number[]> = {
  p99_ms: [], error_rate: [], throughput_rps: [], monthly_cost_usd: [], cpu_efficiency: [], memory_peak_mib: [],
};
const passByLoad = new Map<string, { passed: number; total: number }>();
for (const row of rows) {
  const metrics = JSON.parse(row.metrics_json) as Record<string, unknown>;
  const cost = JSON.parse(row.cost_json) as Record<string, unknown>;
  const gates = JSON.parse(row.gates_json) as { allPassed?: boolean };
  const duration = metrics['httpReqDuration'] as Record<string, number> | undefined;
  push(values.p99_ms!, Number(metrics['p99Ms'] ?? duration?.['p99']));
  push(values.error_rate!, Number(metrics['errorRate'] ?? metrics['httpReqFailed']));
  push(values.throughput_rps!, Number(metrics['achievedRps']));
  push(values.monthly_cost_usd!, Number(cost['infraMonth'] ?? cost['monthlyInfraCost']));
  push(values.cpu_efficiency!, Number(metrics['cpuEfficiency']));
  push(values.memory_peak_mib!, Number(metrics['memoryPeakMiB']));
  const key = `${row.workload_profile}:${row.load_rps}`;
  const aggregate = passByLoad.get(key) ?? { passed: 0, total: 0 };
  aggregate.total += 1;
  if (gates.allPassed) aggregate.passed += 1;
  passByLoad.set(key, aggregate);
}

const bounds = Object.fromEntries(Object.entries(values).map(([key, samples]) => {
  if (samples.length < 2) throw new Error(`Insufficient pilot samples for ${key}`);
  let lower = percentile(samples, 0.05);
  let upper = percentile(samples, 0.95);
  if (lower === upper) { const pad = Math.max(Math.abs(lower) * 0.05, 0.000001); lower -= pad; upper += pad; }
  return [key, { lower, upper }];
}));
const perWorkload = new Map<string, number[]>();
for (const [key, count] of passByLoad) {
  const separator = key.lastIndexOf(':');
  const workload = key.slice(0, separator);
  const load = Number(key.slice(separator + 1));
  if (count.passed / count.total >= 0.8) perWorkload.set(workload, [...(perWorkload.get(workload) ?? []), load]);
}
const recommendedLoads = Object.fromEntries([...perWorkload].map(([workload, loads]) => [workload, selectLoads(loads)]));
mkdirSync(path.resolve('score-bounds'), { recursive: true });
const boundsPath = path.resolve('score-bounds', `${outputVersion}.json`);
writeFileSync(boundsPath, `${JSON.stringify({
  version: outputVersion,
  source: `Pilot protocol ${protocolVersion}; percentile 5/95 from ${rows.length} completed runs`,
  generatedAt: new Date().toISOString(),
  bounds,
}, null, 2)}\n`);
const calibrationPath = path.resolve('results', 'protocols', protocolVersion, 'calibration.json');
mkdirSync(path.dirname(calibrationPath), { recursive: true });
writeFileSync(calibrationPath, `${JSON.stringify({ protocolVersion, completedRuns: rows.length, scoreBoundsVersion: outputVersion, recommendedLoads, passByLoad: Object.fromEntries(passByLoad) }, null, 2)}\n`);
console.log(JSON.stringify({ boundsPath, calibrationPath, recommendedLoads }, null, 2));

function push(target: number[], value: number): void { if (Number.isFinite(value)) target.push(value); }
function percentile(samples: number[], quantile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position); const upper = Math.ceil(position); const fraction = position - lower;
  return (sorted[lower] ?? 0) + ((sorted[upper] ?? sorted[lower] ?? 0) - (sorted[lower] ?? 0)) * fraction;
}
function selectLoads(loads: number[]): number[] {
  const unique = [...new Set(loads)].sort((a, b) => a - b);
  if (unique.length <= 6) return unique;
  const indexes = [0, .2, .4, .6, .8, 1].map((fraction) => Math.round((unique.length - 1) * fraction));
  return [...new Set(indexes.map((index) => unique[index]!))];
}
