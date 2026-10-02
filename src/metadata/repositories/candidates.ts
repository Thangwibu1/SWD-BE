import { getEvaluatorDb } from '../sqlite.js';
import crypto from 'node:crypto';

export interface CandidateRow {
  id: string;
  candidate_id: string;
  model_name: string | null;
  prompt_id: string | null;
  raw_json: string;
  normalized_json: string | null;
  validation_status: string;
  validation_errors_json: string | null;
  architecture_id: string | null;
  created_at: string;
}

export function insertCandidate(data: {
  candidateId: string;
  modelName?: string;
  promptId?: string;
  rawJson: string;
  normalizedJson?: string;
  validationStatus: string;
  validationErrorsJson?: string;
  architectureId?: string;
}): string {
  const db = getEvaluatorDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO candidates (id, candidate_id, model_name, prompt_id, raw_json, normalized_json, validation_status, validation_errors_json, architecture_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.candidateId, data.modelName ?? null, data.promptId ?? null,
    data.rawJson, data.normalizedJson ?? null, data.validationStatus,
    data.validationErrorsJson ?? null, data.architectureId ?? null,
  );
  return id;
}

export function getCandidateById(id: string): CandidateRow | undefined {
  const db = getEvaluatorDb();
  return db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as CandidateRow | undefined;
}

export function listCandidates(limit = 50, offset = 0): CandidateRow[] {
  const db = getEvaluatorDb();
  return db.prepare('SELECT * FROM candidates ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as CandidateRow[];
}
