import { getEvaluatorDb } from '../sqlite.js';
import crypto from 'node:crypto';

export interface ExperimentRow {
  id: string;
  name: string;
  candidate_id: string;
  workload_profile: string;
  load_levels_json: string;
  slo_json: string;
  cost_catalog_version: string;
  score_bounds_version: string;
  protocol_version: string | null;
  idempotency_key: string | null;
  invalid_retry_limit: number;
  dataset_profile: 'pilot' | 'main' | 'capacity';
  repetitions: number;
  status: string;
  created_at: string;
  updated_at: string;
  architecture_id: string | null;
  model_name: string | null;
}

export interface RunRow {
  id: string;
  experiment_id: string;
  run_number: number;
  load_rps: number;
  state: string;
  lease_owner: string | null;
  lease_until: string | null;
  started_at: string | null;
  completed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  metrics_json: string | null;
  cost_json: string | null;
  gates_json: string | null;
  scores_json: string | null;
  attempt: number;
}

export interface TransitionRow {
  id: string;
  run_id: string;
  from_state: string | null;
  to_state: string;
  reason: string | null;
  occurred_at: string;
}

export function insertExperiment(data: {
  name: string;
  candidateId: string;
  workloadProfile: string;
  loadLevelsRps: number[];
  slo: { p99Ms: number; errorRateMax: number; consistencyViolationsMax?: number };
  costCatalogVersion: string;
  scoreBoundsVersion?: string;
  protocolVersion?: string;
  idempotencyKey?: string;
  invalidRetryLimit?: number;
  datasetProfile?: 'pilot' | 'main' | 'capacity';
  repetitions: number;
  warmupSeconds?: number;
  measureSeconds?: number;
  cooldownSeconds?: number;
}): string {
  const db = getEvaluatorDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO experiments (
      id, name, candidate_id, workload_profile, load_levels_json, slo_json,
      cost_catalog_version, score_bounds_version, protocol_version, idempotency_key, invalid_retry_limit, dataset_profile, repetitions, status,
      warmup_seconds, measure_seconds, cooldown_seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.name, data.candidateId, data.workloadProfile,
    JSON.stringify(data.loadLevelsRps), JSON.stringify(data.slo),
    data.costCatalogVersion, data.scoreBoundsVersion ?? 'development-v1', data.protocolVersion ?? null,
    data.idempotencyKey ?? null, data.invalidRetryLimit ?? 1, data.datasetProfile ?? 'pilot', data.repetitions, 'PENDING',
    data.warmupSeconds ?? 120, data.measureSeconds ?? 600, data.cooldownSeconds ?? 60,
  );

  // Create runs for each load level × repetition
  for (const rps of data.loadLevelsRps) {
    for (let rep = 1; rep <= data.repetitions; rep++) {
      const runId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO experiment_runs (id, experiment_id, run_number, load_rps, state)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, id, rep, rps, 'PENDING');
    }
  }

  return id;
}

export function getExperimentByIdempotencyKey(key: string): ExperimentRow | undefined {
  const db = getEvaluatorDb();
  return db.prepare(`SELECT e.*, c.architecture_id, c.model_name FROM experiments e
    JOIN candidates c ON c.id = e.candidate_id WHERE e.idempotency_key = ?`).get(key) as ExperimentRow | undefined;
}

export function getExperimentById(id: string): ExperimentRow | undefined {
  const db = getEvaluatorDb();
  return db.prepare(`SELECT e.*, c.architecture_id, c.model_name
    FROM experiments e JOIN candidates c ON c.id = e.candidate_id WHERE e.id = ?`).get(id) as ExperimentRow | undefined;
}

export function listExperiments(
  filters: {
    status?: string;
    architectureId?: string;
    workloadProfile?: string;
    modelName?: string;
    search?: string;
    createdFrom?: string;
    createdTo?: string;
    limit?: number;
    offset?: number;
  } = {},
): { experiments: ExperimentRow[]; total: number } {
  const db = getEvaluatorDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push('e.status = ?');
    params.push(filters.status);
  }
  if (filters.architectureId) {
    conditions.push('c.architecture_id = ?');
    params.push(filters.architectureId);
  }
  if (filters.workloadProfile) {
    conditions.push('e.workload_profile = ?');
    params.push(filters.workloadProfile);
  }
  if (filters.modelName) {
    conditions.push('c.model_name = ?');
    params.push(filters.modelName);
  }
  if (filters.search) {
    conditions.push('(e.name LIKE ? OR e.id LIKE ?)');
    const pattern = `%${filters.search}%`;
    params.push(pattern, pattern);
  }
  if (filters.createdFrom) {
    conditions.push('e.created_at >= ?');
    params.push(filters.createdFrom);
  }
  if (filters.createdTo) {
    conditions.push('e.created_at <= ?');
    params.push(filters.createdTo);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) as count FROM experiments e
    JOIN candidates c ON c.id = e.candidate_id ${where}`).get(...params) as { count: number }).count;

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  const experiments = db.prepare(
    `SELECT e.*, c.architecture_id, c.model_name FROM experiments e
     JOIN candidates c ON c.id = e.candidate_id
     ${where} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as ExperimentRow[];

  return { experiments, total };
}

export interface DashboardData {
  statusCounts: Array<{ status: string; count: number }>;
  invalidCandidates: number;
  gateRuns: Array<{ architecture_id: string | null; gates_json: string }>;
  metrics: Array<{ workload_profile: string; metrics_json: string }>;
}

export function getDashboardData(): DashboardData {
  const db = getEvaluatorDb();
  const statusCounts = db.prepare(
    'SELECT status, COUNT(*) AS count FROM experiments GROUP BY status',
  ).all() as DashboardData['statusCounts'];
  const invalidCandidates = (db.prepare(
    "SELECT COUNT(*) AS count FROM candidates WHERE validation_status = 'INVALID'",
  ).get() as { count: number }).count;
  const gateRuns = db.prepare(`SELECT c.architecture_id, r.gates_json FROM experiment_runs r
    JOIN experiments e ON e.id = r.experiment_id JOIN candidates c ON c.id = e.candidate_id
    WHERE r.gates_json IS NOT NULL`).all() as DashboardData['gateRuns'];
  const metrics = db.prepare(`SELECT e.workload_profile, r.metrics_json FROM experiment_runs r
    JOIN experiments e ON e.id = r.experiment_id WHERE r.metrics_json IS NOT NULL`).all() as DashboardData['metrics'];
  return { statusCounts, invalidCandidates, gateRuns, metrics };
}

export function getRunsByExperimentId(experimentId: string): RunRow[] {
  const db = getEvaluatorDb();
  return db.prepare('SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY load_rps, run_number').all(experimentId) as RunRow[];
}

export function getRunById(runId: string): RunRow | undefined {
  const db = getEvaluatorDb();
  return db.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(runId) as RunRow | undefined;
}

export function updateExperimentStatus(id: string, status: string): void {
  const db = getEvaluatorDb();
  db.prepare('UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
}

export function updateRunResults(runId: string, data: {
  metricsJson?: string;
  costJson?: string;
  gatesJson?: string;
  scoresJson?: string;
}): void {
  const db = getEvaluatorDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (data.metricsJson !== undefined) { sets.push('metrics_json = ?'); params.push(data.metricsJson); }
  if (data.costJson !== undefined) { sets.push('cost_json = ?'); params.push(data.costJson); }
  if (data.gatesJson !== undefined) { sets.push('gates_json = ?'); params.push(data.gatesJson); }
  if (data.scoresJson !== undefined) { sets.push('scores_json = ?'); params.push(data.scoresJson); }
  if (sets.length === 0) return;
  params.push(runId);
  db.prepare(`UPDATE experiment_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function getTransitions(runId: string): TransitionRow[] {
  const db = getEvaluatorDb();
  return db.prepare('SELECT * FROM state_transitions WHERE run_id = ? ORDER BY occurred_at').all(runId) as TransitionRow[];
}

export function cancelExperiment(id: string): boolean {
  const db = getEvaluatorDb();
  const exp = getExperimentById(id);
  if (!exp) return false;
  const cancellableStates = ['PENDING', 'VALIDATING', 'PREPARING', 'DEPLOYING', 'READY_CHECK', 'SMOKE_TESTING', 'WARMING_UP', 'RUNNING'];
  if (!cancellableStates.includes(exp.status)) return false;
  db.transaction(() => {
    db.prepare('UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?').run('CANCEL_REQUESTED', new Date().toISOString(), id);
    db.prepare("UPDATE experiment_runs SET state = 'CANCEL_REQUESTED' WHERE experiment_id = ? AND state = 'PENDING'").run(id);
  })();
  return true;
}
