import type { Request, Response } from 'express';
import { getExperimentById, getRunsByExperimentId, getTransitions } from '../../metadata/repositories/experiments.js';

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
  const sendEvent = (type: string, data: unknown) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('state-transition', { experimentId: id, state: exp.status, timestamp: new Date().toISOString() });

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
      const completedRuns = runs.filter(r => r.state === 'COMPLETED' || r.state === 'CLEANING').length;
      const failedRuns = runs.filter(r => r.state === 'FAILED').length;
      const activeRun = runs.find(r => !['PENDING', 'COMPLETED', 'FAILED', 'CLEANING', 'CLEANUP_FAILED'].includes(r.state));

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
      if (['COMPLETED', 'FAILED', 'CLEANUP_FAILED'].includes(current.status) && completedRuns + failedRuns >= totalRuns) {
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
