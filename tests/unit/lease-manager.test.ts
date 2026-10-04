import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeEvaluatorDb, getEvaluatorDb } from '../../src/metadata/sqlite.js';
import { LeaseManager } from '../../src/worker/lease-manager.js';

describe('global sandbox lease', () => {
  let directory = '';
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'lease-manager-'));
    process.env['EVALUATOR_DB_PATH'] = path.join(directory, 'evaluator.db');
    const db = getEvaluatorDb();
    db.prepare(`INSERT INTO candidates (id, candidate_id, raw_json, validation_status, architecture_id)
      VALUES ('candidate', 'candidate', '{}', 'VALID', 'A01')`).run();
    for (const [experiment, run] of [['experiment-1', 'run-1'], ['experiment-2', 'run-2']]) {
      db.prepare(`INSERT INTO experiments (id, name, candidate_id, workload_profile, load_levels_json, slo_json,
        cost_catalog_version, repetitions, status) VALUES (?, ?, 'candidate', 'MIXED_V1', '[25]', '{}', 'research-v1', 1, 'PENDING')`)
        .run(experiment, experiment);
      db.prepare(`INSERT INTO experiment_runs (id, experiment_id, run_number, load_rps, state)
        VALUES (?, ?, 1, 25, 'PENDING')`).run(run, experiment);
    }
  });
  afterEach(() => {
    closeEvaluatorDb();
    delete process.env['EVALUATOR_DB_PATH'];
    rmSync(directory, { recursive: true, force: true });
  });

  it('allows only one active SUT lease and permits exact recovery after expiry', () => {
    const first = new LeaseManager('worker-1', 300);
    const second = new LeaseManager('worker-2', 300);
    expect(first.acquireLease('run-1')).toBe(true);
    expect(second.acquireLease('run-2')).toBe(false);
    first.extendLease('run-1');
    first.releaseLease('run-1');
    expect(second.acquireLease('run-2')).toBe(true);
    second.releaseLease('run-2');
    getEvaluatorDb().prepare("UPDATE experiment_runs SET state = 'RUNNING', lease_owner = 'dead-worker', lease_until = ? WHERE id = 'run-1'")
      .run(new Date(Date.now() - 1000).toISOString());
    expect(second.acquireLease('run-1')).toBe(true);
  });
});
