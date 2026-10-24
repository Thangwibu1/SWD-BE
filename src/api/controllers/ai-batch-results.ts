import type { Request, Response } from 'express';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const SAFE_STUDY_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

function rootDirectory(): string {
  return path.resolve(process.env['RESULTS_ROOT'] ?? './results', 'ai-batch');
}

function readJson(target: string): unknown {
  return JSON.parse(readFileSync(target, 'utf8')) as unknown;
}

function writeJson(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
}

export function publishAiBatchStudyController(req: Request, res: Response): void {
  const { studyId } = req.params as { studyId: string };
  if (!SAFE_STUDY_ID.test(studyId)) {
    res.status(400).json({ code: 'INVALID_STUDY_ID', message: 'Invalid AI batch study ID' });
    return;
  }
  const body = req.body as { summary?: unknown; comparison?: unknown; probes?: unknown };
  if (
    !body.summary ||
    typeof body.summary !== 'object' ||
    Array.isArray(body.summary) ||
    !Array.isArray(body.comparison) ||
    body.comparison.length > 10_000 ||
    !Array.isArray(body.probes) ||
    body.probes.length > 100
  ) {
    res.status(400).json({
      code: 'INVALID_AI_RESULTS',
      message: 'summary, comparison and probes are required',
    });
    return;
  }
  const summary = body.summary as Record<string, unknown>;
  if (summary['studyId'] !== studyId) {
    res.status(400).json({
      code: 'INVALID_AI_RESULTS',
      message: 'summary studyId must match route',
    });
    return;
  }
  try {
    const directory = path.join(rootDirectory(), studyId);
    writeJson(path.join(directory, 'summary.json'), summary);
    writeJson(path.join(directory, 'comparison.json'), body.comparison);
    for (const probe of body.probes) {
      if (!probe || typeof probe !== 'object' || Array.isArray(probe)) continue;
      const modelId = (probe as Record<string, unknown>)['modelId'];
      if (typeof modelId === 'string' && SAFE_STUDY_ID.test(modelId))
        writeJson(path.join(directory, 'probes', `${modelId}.json`), probe);
    }
    res.status(202).json({ studyId, published: true });
  } catch (error) {
    res.status(500).json({
      code: 'AI_RESULTS_WRITE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function listAiBatchStudiesController(_req: Request, res: Response): void {
  try {
    const root = rootDirectory();
    if (!existsSync(root)) {
      res.json({ studies: [] });
      return;
    }
    const studies = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SAFE_STUDY_ID.test(entry.name))
      .flatMap((entry) => {
        const summaryPath = path.join(root, entry.name, 'summary.json');
        if (!existsSync(summaryPath)) return [];
        const summary = readJson(summaryPath) as Record<string, unknown>;
        return [
          {
            studyId: entry.name,
            updatedAt: statSync(summaryPath).mtime.toISOString(),
            plannedGenerations: summary['plannedGenerations'] ?? 0,
            recordedGenerations: summary['recordedGenerations'] ?? 0,
            maximumBenchmarkRuns: summary['maximumBenchmarkRuns'] ?? 0,
            collectedRuns: summary['collectedRuns'] ?? 0,
          },
        ];
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    res.json({ studies });
  } catch (error) {
    res.status(500).json({
      code: 'AI_RESULTS_READ_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function getAiBatchStudyController(req: Request, res: Response): void {
  const { studyId } = req.params as { studyId: string };
  if (!SAFE_STUDY_ID.test(studyId)) {
    res.status(400).json({ code: 'INVALID_STUDY_ID', message: 'Invalid AI batch study ID' });
    return;
  }
  try {
    const directory = path.join(rootDirectory(), studyId);
    const summaryPath = path.join(directory, 'summary.json');
    if (!existsSync(summaryPath)) {
      res.status(404).json({ code: 'NOT_FOUND', message: `AI batch study ${studyId} not found` });
      return;
    }
    const comparisonPath = path.join(directory, 'comparison.json');
    const probesDirectory = path.join(directory, 'probes');
    const probes = existsSync(probesDirectory)
      ? readdirSync(probesDirectory)
          .filter((name) => name.endsWith('.json') && !name.endsWith('.provider.json'))
          .map((name) => readJson(path.join(probesDirectory, name)))
      : [];
    res.json({
      studyId,
      updatedAt: statSync(summaryPath).mtime.toISOString(),
      summary: readJson(summaryPath),
      comparison: existsSync(comparisonPath) ? readJson(comparisonPath) : [],
      probes,
    });
  } catch (error) {
    res.status(500).json({
      code: 'AI_RESULTS_READ_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
