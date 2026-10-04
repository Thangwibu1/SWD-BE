import type { Request, Response } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { getEvaluatorDb } from '../../metadata/sqlite.js';

export function listExperimentArtifactsController(req: Request, res: Response): void {
  const { id } = req.params as { id: string };
  const db = getEvaluatorDb();
  const artifacts = db.prepare(`SELECT a.id, a.run_id AS runId, a.type, a.relative_path AS relativePath,
      a.sha256, a.size_bytes AS sizeBytes, a.created_at AS createdAt
    FROM artifacts a JOIN experiment_runs r ON r.id = a.run_id
    WHERE r.experiment_id = ? ORDER BY r.run_number, a.relative_path`).all(id);
  res.json({ experimentId: id, artifacts });
}

export function downloadArtifactController(req: Request, res: Response): void {
  const { artifactId: id } = req.params as { artifactId: string };
  const requestedExperimentId = (req.params as { experimentId?: string }).experimentId;
  const db = getEvaluatorDb();
  const artifact = db.prepare(`SELECT a.relative_path, r.id AS run_id, r.experiment_id
    FROM artifacts a JOIN experiment_runs r ON r.id = a.run_id WHERE a.id = ?`).get(id) as
    { relative_path: string; run_id: string; experiment_id: string } | undefined;
  if (!artifact) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Artifact not found', requestId: req.requestId });
    return;
  }
  if (requestedExperimentId && requestedExperimentId !== artifact.experiment_id) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Artifact not found', requestId: req.requestId });
    return;
  }
  const root = path.resolve(process.env['RESULTS_ROOT'] ?? './results');
  const runRoot = path.resolve(root, artifact.experiment_id, artifact.run_id);
  const file = path.resolve(runRoot, artifact.relative_path);
  if (!file.startsWith(`${runRoot}${path.sep}`) || !existsSync(file)) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Artifact file not found', requestId: req.requestId });
    return;
  }
  res.download(file, path.basename(file));
}
