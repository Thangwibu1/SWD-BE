import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getEvaluatorDb } from '../src/metadata/sqlite.js';
import { bootstrapMedian95 } from '../src/evaluator/statistics/index.js';
import { computePareto, type ParetoPoint } from '../src/evaluator/pareto-engine/index.js';
import { createLogger } from '../src/utils/logger.js';

interface Row { experiment_id: string; name: string; architecture_id: string; model_name: string; workload_profile: string; load_rps: number; run_number: number; attempt: number; state: string; metrics_json: string | null; cost_json: string | null; gates_json: string | null; scores_json: string | null }
const version = process.argv[2] ?? 'main-v1';
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(version)) throw new Error('Unsafe protocol version');
const db = getEvaluatorDb();
const rawRows = db.prepare(`SELECT e.id AS experiment_id, e.name, c.architecture_id, c.model_name, e.workload_profile,
  r.load_rps, r.run_number, r.attempt, r.state, r.metrics_json, r.cost_json, r.gates_json, r.scores_json
  FROM experiments e JOIN candidates c ON c.id=e.candidate_id JOIN experiment_runs r ON r.experiment_id=e.id
  WHERE e.protocol_version=? ORDER BY e.id,r.load_rps,r.run_number,r.attempt`).all(version) as Row[];
const latestAttempts = new Map<string, Row>();
for (const row of rawRows) latestAttempts.set(`${row.experiment_id}:${row.load_rps}:${row.run_number}`, row);
const rows = [...latestAttempts.values()];
const measurementVersions = new Set(rows.filter((row) => row.metrics_json).map((row) =>
  (JSON.parse(row.metrics_json!) as { measurementSchemaVersion?: string }).measurementSchemaVersion ?? 'legacy'));
if (measurementVersions.size > 1) throw new Error('Protocol mixes incompatible measurement definitions; use a new protocol version');
if (!rows.length) throw new Error(`No evidence for protocol ${version}`);
const terminal = rows.filter((row) => ['COMPLETED', 'FAILED', 'CLEANUP_FAILED', 'CANCEL_REQUESTED'].includes(row.state));
if (terminal.length !== rows.length) throw new Error(`Protocol ${version} still has ${rows.length - terminal.length} non-terminal runs`);
const groups = new Map<string, Row[]>();
for (const row of rows) groups.set(row.experiment_id, [...(groups.get(row.experiment_id) ?? []), row]);
const summaries = [...groups].map(([experimentId, group]) => {
  const completed = group.filter((row) => row.state === 'COMPLETED' && row.metrics_json && row.gates_json);
  const feasible = completed.filter((row) => (JSON.parse(row.gates_json!) as { allPassed?: boolean }).allPassed);
  const byLoad = new Map<number, { passed: number; total: number }>();
  for (const row of group) {
    const bucket = byLoad.get(row.load_rps) ?? { passed: 0, total: 0 };
    bucket.total += 1;
    if (row.state === 'COMPLETED' && row.gates_json && (JSON.parse(row.gates_json) as { allPassed?: boolean }).allPassed) bucket.passed += 1;
    byLoad.set(row.load_rps, bucket);
  }
  const sustainable = [...byLoad].filter(([, count]) => count.passed / count.total >= 0.8).map(([load]) => load);
  const highest = Math.max(0, ...sustainable);
  const representative = completed.filter((row) => row.load_rps === highest);
  const metric = (row: Row) => JSON.parse(row.metrics_json!) as Record<string, number>;
  const cost = (row: Row) => JSON.parse(row.cost_json ?? '{}') as Record<string, number>;
  return {
    experimentId, name: group[0]!.name, architectureId: group[0]!.architecture_id, modelName: group[0]!.model_name,
    workload: group[0]!.workload_profile, completedRuns: completed.length, totalRuns: group.length,
    maxSustainableRps: highest,
    p99Ms: bootstrapMedian95(representative.map((row) => metric(row)['p99Ms'] ?? 0)),
    errorRate: bootstrapMedian95(representative.map((row) => metric(row)['errorRate'] ?? 0)),
    monthlyCostUsd: bootstrapMedian95(representative.map((row) => cost(row)['infraMonth'] ?? 0)),
    feasible: feasible.length > 0,
    scoreDimensions: representative.map((row) => JSON.parse(row.scores_json ?? '{}') as { dimensions?: Array<{ dimension: string; normalizedScore: number }> }),
  };
});
const points: ParetoPoint[] = summaries.map((summary) => {
  const dimensions: Record<string, number[]> = {};
  for (const score of summary.scoreDimensions) for (const item of score.dimensions ?? []) (dimensions[item.dimension] ??= []).push(item.normalizedScore);
  const normalizedScores = Object.fromEntries(Object.entries(dimensions).map(([key, value]) => [key, median(value)]));
  return { experimentId: summary.experimentId, candidateId: summary.experimentId, architectureId: summary.architectureId,
    feasible: summary.feasible, isParetoOptimal: false, dimensions: {}, normalizedScores, regret: 0 };
});
const dimensionNames = [...new Set(points.flatMap((point) => Object.keys(point.normalizedScores)))];
const pareto = computePareto(points, dimensionNames, createLogger('protocol-aggregate'));
const modelMetrics = {
  // A fixed-profile benchmark has no model-output or repair denominator.
  validArchitectureRate: null,
  sloPassRate: rows.filter((row) => row.gates_json && (JSON.parse(row.gates_json) as { allPassed?: boolean }).allPassed).length / rows.length,
  paretoHitRate: summaries.filter((summary) => pareto.frontierIds.includes(summary.experimentId)).length / summaries.length,
  normalizedRegret: median(pareto.points.map((point) => point.regret)),
  selectionStability: null,
  repairRate: null,
};
const output = { protocolVersion: version, measurementSchemaVersion: [...measurementVersions][0] ?? null, generatedAt: new Date().toISOString(), limitations: [
  'Synthetic single-region workload; external validity depends on production traffic similarity.',
  'Projected cost is catalog-based and excludes organization-specific discounts and staffing variance.',
  'Confidence intervals quantify repetition uncertainty, not all infrastructure or demand uncertainty.',
  'AI validity, repair rate and selection stability are unmeasured without model generation and repeated selection evidence.',
], modelMetrics, summaries: summaries.map(({ scoreDimensions: _, ...summary }) => summary), pareto };
const outputDir = path.resolve('results', 'protocols', version);
mkdirSync(outputDir, { recursive: true });
writeFileSync(path.join(outputDir, 'aggregate.json'), `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(path.join(outputDir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>${escapeHtml(version)} report</title><style>body{font:14px system-ui;max-width:1200px;margin:40px auto}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px}</style><h1>${escapeHtml(version)} reproducible report</h1><p>Generated from immutable run evidence in SQLite and artifact manifests.</p><h2>Limitations</h2><ul>${output.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><h2>Aggregate evidence</h2><pre>${escapeHtml(JSON.stringify(output, null, 2))}</pre>`);
console.log(JSON.stringify({ outputDir, experiments: summaries.length, runs: rows.length, modelMetrics }, null, 2));

function median(values: number[]): number { const sorted=[...values].sort((a,b)=>a-b); if(!sorted.length)return 0; const middle=Math.floor(sorted.length/2); return sorted.length%2 ? sorted[middle]! : ((sorted[middle-1]??0)+(sorted[middle]??0))/2; }
function escapeHtml(value: string): string { return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
