import { getEvaluatorDb } from '../metadata/sqlite.js';

export class LeaseManager {
  constructor(private ownerId: string, private leaseSeconds: number = 300) {}
  
  acquireLease(runId: string): boolean {
    const db = getEvaluatorDb();
    const now = new Date();
    const until = new Date(now.getTime() + this.leaseSeconds * 1000);
    return db.transaction(() => {
      const active = db.prepare(`SELECT id FROM experiment_runs
        WHERE id <> ? AND lease_until >= ?
          AND state NOT IN ('COMPLETED','FAILED','CANCEL_REQUESTED','CLEANUP_FAILED')
        LIMIT 1`).get(runId, now.toISOString());
      if (active) return false;
      const info = db.prepare(`
        UPDATE experiment_runs
        SET lease_owner = ?, lease_until = ?
        WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)
      `).run(this.ownerId, until.toISOString(), runId, now.toISOString());
      return info.changes > 0;
    })();
  }
  
  releaseLease(runId: string): void {
    const db = getEvaluatorDb();
    db.prepare('UPDATE experiment_runs SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?').run(
      runId, this.ownerId
    );
  }
  
  extendLease(runId: string): void {
    const db = getEvaluatorDb();
    const until = new Date(Date.now() + this.leaseSeconds * 1000);
    const result = db.prepare('UPDATE experiment_runs SET lease_until = ? WHERE id = ? AND lease_owner = ?').run(
      until.toISOString(), runId, this.ownerId
    );
    if (result.changes !== 1) throw new Error(`Lease for run ${runId} is no longer owned by ${this.ownerId}`);
  }

  startHeartbeat(runId: string, onLeaseLost: (error: Error) => void): () => void {
    const intervalMs = Math.max(1000, Math.floor(this.leaseSeconds * 1000 / 3));
    const timer = setInterval(() => {
      try {
        this.extendLease(runId);
      } catch (error) {
        onLeaseLost(error instanceof Error ? error : new Error(String(error)));
      }
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
