import type { Request, Response } from 'express';
import { getExperimentById, getRunsByExperimentId } from '../../metadata/repositories/experiments.js';

/**
 * SSE endpoint for experiment state/metric events.
 * Event types: state-transition, progress, metric-snapshot, completed, failed
 */
export function sseEventsHandler(req: Request, res: Response): void {
  const { id } = req.params as { id: string };
  const exp = getExperimentById(id);
  if (!exp) {
    res.status(404).json({ code: 'NOT_FOUND', message: `Experiment ${id} not found` });
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial state
  let eventId = Number(req.header('Last-Event-ID') ?? 0);
  const sendEvent = (type: string, data: unknown) => {
    eventId += 1;
    res.write(`id: ${eventId}\n`);
    res.write('retry: 2000\n');
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('state-transition', { experimentId: id, state: exp.status, timestamp: new Date().toISOString() });
  const initialRuns = getRunsByExperimentId(id);
  const lastStates = new Map(initialRuns.map((run) => [run.id, run.state]));
  const metricRuns = new Set(initialRuns.filter((run) => run.metrics_json).map((run) => run.id));

  // Poll for updates
  const interval = setInterval(() => {
    try {
      const current = getExperimentById(id);
      if (!current) {
        clearInterval(interval);
        res.end();
        return;
      }

      const runs = getRunsByExperimentId(id);
      const totalRuns = runs.length;
      const completedRuns = runs.filter(r => r.state === 'COMPLETED').length;
      const failedRuns = runs.filter(r => ['FAILED', 'CLEANUP_FAILED'].includes(r.state)).length;
      const activeRun = runs.find(r => !['PENDING', 'COMPLETED', 'FAILED', 'CLEANING', 'CLEANUP_FAILED'].includes(r.state));

      for (const run of runs) {
        const previous = lastStates.get(run.id);
        if (previous !== run.state) {
          sendEvent('state-transition', { experimentId: id, runId: run.id, from: previous ?? null,
            state: run.state, timestamp: new Date().toISOString() });
          lastStates.set(run.id, run.state);
        }
        if (run.metrics_json && !metricRuns.has(run.id)) {
          sendEvent('metric-snapshot', { experimentId: id, runId: run.id, loadRps: run.load_rps,
            metrics: JSON.parse(run.metrics_json), timestamp: new Date().toISOString() });
          metricRuns.add(run.id);
        }
      }

      sendEvent('progress', {
        experimentId: id,
        status: current.status,
        totalRuns,
        completedRuns,
        failedRuns,
        activeRunId: activeRun?.id,
        activeRunState: activeRun?.state,
        timestamp: new Date().toISOString(),
      });

      // If terminal state, send final event and close
      const cancelledRuns = runs.filter(r => r.state === 'CANCEL_REQUESTED').length;
      if (['COMPLETED', 'FAILED', 'CLEANUP_FAILED', 'CANCEL_REQUESTED'].includes(current.status)
        && completedRuns + failedRuns + cancelledRuns >= totalRuns) {
        sendEvent(current.status === 'COMPLETED' ? 'completed' : 'failed', {
          experimentId: id,
          status: current.status,
          completedRuns,
          failedRuns,
        });
        clearInterval(interval);
        res.end();
      }
    } catch {
      // Connection may have been closed
      clearInterval(interval);
    }
  }, 2000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
  });
}
