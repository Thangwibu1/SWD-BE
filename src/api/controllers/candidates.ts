import type { Request, Response } from 'express';
import { validateCandidate } from '../../evaluator/architecture-validator/index.js';
import { insertCandidate, getCandidateById, listCandidates } from '../../metadata/repositories/candidates.js';

export function validateCandidateController(req: Request, res: Response): void {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ code: 'INVALID_REQUEST', message: 'Request body must be a JSON object', requestId: req.requestId });
      return;
    }

    const result = validateCandidate(body);
    res.json({
      valid: result.valid,
      code: result.code,
      errors: result.errors,
      architectureId: result.architectureId,
      requestId: req.requestId,
    });
  } catch (err: unknown) {
    res.status(500).json({ code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Unknown error', requestId: req.requestId });
  }
}

export function getCandidateController(req: Request, res: Response): void {
  const { id } = req.params as { id: string };
  const candidate = getCandidateById(id);
  if (!candidate) {
    res.status(404).json({ code: 'NOT_FOUND', message: `Candidate ${id} not found`, requestId: req.requestId });
    return;
  }
  res.json({
    ...candidate,
    raw_json: JSON.parse(candidate.raw_json),
    normalized_json: candidate.normalized_json ? JSON.parse(candidate.normalized_json) : null,
    validation_errors_json: candidate.validation_errors_json ? JSON.parse(candidate.validation_errors_json) : null,
  });
}

export function listCandidatesController(req: Request, res: Response): void {
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '50')), 100);
  const offset = parseInt(String(req.query['offset'] ?? '0'));
  const candidates = listCandidates(limit, offset);
  res.json({ candidates, limit, offset });
}
