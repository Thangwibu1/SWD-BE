import { getEvaluatorDb } from '../metadata/sqlite.js';
import { LeaseManager } from './lease-manager.js';
import { ExperimentStateMachine } from './experiment-state-machine.js';
import type { Logger } from '../utils/logger.js';
import { validateCandidate } from '../evaluator/architecture-validator/index.js';
import { loadRegistry } from '../evaluator/registry/index.js';
import { renderCompose } from '../evaluator/compose-renderer/index.js';
import { deployCompose, cleanupCompose } from '../evaluator/docker-runner/index.js';

export class WorkerLoop {
  private isRunning = false;
  private leaseManager: LeaseManager;

  constructor(private workerId: string, private logger: Logger) {
    this.leaseManager = new LeaseManager(workerId);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('Worker started');
    this.loop();
  }

  stop(): void {
    this.isRunning = false;
    this.logger.info('Worker stopping');
  }

  private async loop(): Promise<void> {
    while (this.isRunning) {
      try {
        const runId = this.findPendingRun();
        if (runId) {
          await this.processRun(runId);
        } else {
          // Sleep before polling again
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      } catch (err) {
        this.logger.error({ err }, 'Worker loop error');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private findPendingRun(): string | null {
    const db = getEvaluatorDb();
    const now = new Date().toISOString();
    
    // Find a run that is PENDING, or one that was abandoned (lease expired)
    const run = db.prepare(`
      SELECT id FROM experiment_runs 
      WHERE state IN ('PENDING', 'VALIDATING', 'PREPARING', 'DEPLOYING', 'READY_CHECK', 'SMOKE_TESTING', 'WARMING_UP', 'RUNNING', 'COLLECTING', 'VERIFYING', 'SCORING')
        AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY run_number ASC LIMIT 1
    `).get(now) as { id: string } | undefined;

    if (!run) return null;
    
    // Try to acquire lease
    if (this.leaseManager.acquireLease(run.id)) {
      return run.id;
    }
    
    return null;
  }

  private async processRun(runId: string): Promise<void> {
    const stateMachine = new ExperimentStateMachine(runId, this.logger);
    const db = getEvaluatorDb();
    
    let composePath: string | undefined;

    try {
      this.logger.info({ runId }, 'Processing run');
      
      const runRow = db.prepare('SELECT experiment_id FROM experiment_runs WHERE id = ?').get(runId) as { experiment_id: string };
      const expRow = db.prepare('SELECT candidate_id FROM experiments WHERE id = ?').get(runRow.experiment_id) as { candidate_id: string };
      const candidateRow = db.prepare('SELECT raw_json FROM candidates WHERE id = ?').get(expRow.candidate_id) as { raw_json: string };
      
      const candidateJson = JSON.parse(candidateRow.raw_json);
      
      // Phase: VALIDATING
      stateMachine.transitionTo('VALIDATING');
      const valResult = validateCandidate(candidateJson);
      if (!valResult.valid) {
        throw new Error(`Validation failed: ${valResult.code}`);
      }
      
      // Phase: PREPARING
      stateMachine.transitionTo('PREPARING');
      const registry = loadRegistry();
      const profile = registry.get((candidateJson as any).architectureId)!;
      
      const renderResult = renderCompose({
        runId,
        profile,
        databaseUrl: 'postgres://bench:bench@postgres:5432/ecommerce',
        hostPortStart: 20000
      });
      composePath = renderResult.filePath;
      
      // Phase: DEPLOYING
      stateMachine.transitionTo('DEPLOYING');
      await deployCompose({ runId, composeFilePath: composePath, logger: this.logger });
      
      // MVP: simulate other phases
      stateMachine.transitionTo('READY_CHECK');
      await new Promise(r => setTimeout(r, 2000));
      
      stateMachine.transitionTo('SMOKE_TESTING');
      await new Promise(r => setTimeout(r, 2000));
      
      stateMachine.transitionTo('WARMING_UP');
      stateMachine.transitionTo('RUNNING');
      stateMachine.transitionTo('COLLECTING');
      stateMachine.transitionTo('VERIFYING');
      stateMachine.transitionTo('SCORING');
      
      // Phase: COMPLETED
      db.prepare("UPDATE experiment_runs SET completed_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
      stateMachine.transitionTo('COMPLETED');
      
    } catch (err: any) {
      this.logger.error({ runId, err }, 'Run failed');
      db.prepare("UPDATE experiment_runs SET completed_at = ?, failure_code = ?, failure_message = ? WHERE id = ?").run(
        new Date().toISOString(),
        'INTERNAL_ERROR',
        err.message,
        runId
      );
      stateMachine.transitionTo('FAILED', err.message);
    } finally {
      // Phase: CLEANING
      if (composePath) {
        stateMachine.transitionTo('CLEANING');
        try {
          await cleanupCompose({ runId, composeFilePath: composePath, logger: this.logger });
          if ((db.prepare('SELECT state FROM experiment_runs WHERE id = ?').get(runId) as any).state !== 'FAILED') {
             // Actually state machine allows transition to COMPLETED after CLEANING?
             // Guide says: VERIFYING -> SCORING -> COMPLETED -> CLEANING. Wait, COMPLETED is before CLEANING? 
             // Guide: "VERIFYING -> SCORING -> COMPLETED -> CLEANING"
          }
        } catch (cleanupErr: any) {
          this.logger.error({ runId, err: cleanupErr }, 'Cleanup failed');
          stateMachine.transitionTo('CLEANUP_FAILED', cleanupErr.message);
        }
      }
      this.leaseManager.releaseLease(runId);
    }
  }
}
