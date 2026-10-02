import { getEvaluatorDb } from '../metadata/sqlite.js';

export class LeaseManager {
  constructor(private ownerId: string, private leaseSeconds: number = 300) {}
  
  acquireLease(runId: string): boolean {
    const db = getEvaluatorDb();
    const now = new Date();
    const until = new Date(now.getTime() + this.leaseSeconds * 1000);
    
    const info = db.prepare(`
      UPDATE experiment_runs 
      SET lease_owner = ?, lease_until = ? 
      WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)
    `).run(this.ownerId, until.toISOString(), runId, now.toISOString());
    
    return info.changes > 0;
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
    db.prepare('UPDATE experiment_runs SET lease_until = ? WHERE id = ? AND lease_owner = ?').run(
      until.toISOString(), runId, this.ownerId
    );
  }
}
