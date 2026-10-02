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
  repetitions: number;
  status: string;
  created_at: string;
  updated_at: string;
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
  repetitions: number;
}): string {
  const db = getEvaluatorDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO experiments (id, name, candidate_id, workload_profile, load_levels_json, slo_json, cost_catalog_version, repetitions, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.name, data.candidateId, data.workloadProfile,
    JSON.stringify(data.loadLevelsRps), JSON.stringify(data.slo),
    data.costCatalogVersion, data.repetitions, 'PENDING',
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

export function getExperimentById(id: string): ExperimentRow | undefined {
  const db = getEvaluatorDb();
  return db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as ExperimentRow | undefined;
}

export function listExperiments(
  filters: { status?: string; limit?: number; offset?: number } = {},
): { experiments: ExperimentRow[]; total: number } {
  const db = getEvaluatorDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) as count FROM experiments ${where}`).get(...params) as { count: number }).count;

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  const experiments = db.prepare(
    `SELECT * FROM experiments ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as ExperimentRow[];

  return { experiments, total };
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
  db.prepare('UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?').run('CANCEL_REQUESTED', new Date().toISOString(), id);
  return true;
}
