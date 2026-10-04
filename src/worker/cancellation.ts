import { getEvaluatorDb } from '../metadata/sqlite.js';

export class RunCancelledError extends Error {
  constructor() {
    super('Experiment cancellation requested');
    this.name = 'RunCancelledError';
  }
}

export function isCancellationRequested(runId: string): boolean {
  const row = getEvaluatorDb().prepare(`
    SELECT e.status
    FROM experiment_runs r
    JOIN experiments e ON e.id = r.experiment_id
    WHERE r.id = ?
  `).get(runId) as { status: string } | undefined;
  return row?.status === 'CANCEL_REQUESTED';
}

export function throwIfCancellationRequested(runId: string): void {
  if (isCancellationRequested(runId)) throw new RunCancelledError();
}

export async function waitWithCancellation(runId: string, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    throwIfCancellationRequested(runId);
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
  }
}

export function monitorCancellation(runId: string, controller: AbortController): () => void {
  const interval = setInterval(() => {
    if (isCancellationRequested(runId)) controller.abort(new RunCancelledError());
  }, 500);
  return () => clearInterval(interval);
}
