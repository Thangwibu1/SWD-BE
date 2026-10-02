import { getEvaluatorDb } from '../metadata/sqlite.js';
import type { Logger } from '../utils/logger.js';

export type ExperimentState =
  | 'PENDING'
  | 'VALIDATING'
  | 'PREPARING'
  | 'DEPLOYING'
  | 'READY_CHECK'
  | 'SMOKE_TESTING'
  | 'WARMING_UP'
  | 'RUNNING'
  | 'COLLECTING'
  | 'VERIFYING'
  | 'SCORING'
  | 'COMPLETED'
  | 'CANCEL_REQUESTED'
  | 'FAILED'
  | 'CLEANING'
  | 'CLEANUP_FAILED';

export class ExperimentStateMachine {
  constructor(private runId: string, private logger: Logger) {}

  transitionTo(newState: ExperimentState, reason?: string): void {
    const db = getEvaluatorDb();
    
    db.transaction(() => {
      // Get current state
      const run = db.prepare('SELECT state FROM experiment_runs WHERE id = ?').get(this.runId) as { state: string };
      if (!run) {
        throw new Error(`Run ${this.runId} not found`);
      }
      
      const oldState = run.state;
      
      // Update state
      db.prepare('UPDATE experiment_runs SET state = ? WHERE id = ?').run(newState, this.runId);
      
      // Record transition
      db.prepare(`
        INSERT INTO state_transitions (id, run_id, from_state, to_state, reason)
        VALUES (?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), this.runId, oldState, newState, reason || null);
      
      this.logger.info({ runId: this.runId, from: oldState, to: newState, reason }, 'State transition');
    })();
  }
}
