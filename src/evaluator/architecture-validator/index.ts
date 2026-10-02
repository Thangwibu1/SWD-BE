import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { loadRegistry } from '../registry/index.js';

export interface ValidationResult {
  valid: boolean;
  code?: string;
  errors: any[];
  architectureId?: string;
}

export function validateCandidate(candidateJson: any): ValidationResult {
  const schemaPath = path.resolve('schemas/architecture-candidate.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  
  const valid = validate(candidateJson);
  let errors = validate.errors ? [...validate.errors] : [];
  
  if (!valid) {
    return { valid: false, code: 'VAL-001', errors };
  }
  
  const candidate = candidateJson as any;
  
  // Semantic Validation
  const registry = loadRegistry();
  const profile = registry.get(candidate.architectureId);
  
  if (!profile) {
    errors.push({ message: `VAL-002 UNSUPPORTED_ARCHITECTURE: ${candidate.architectureId}` } as any);
    return { valid: false, code: 'VAL-002', errors };
  }
  
  if (profile.family !== candidate.architectureFamily) {
    errors.push({ message: `VAL-003 FAMILY_MISMATCH: expected ${profile.family}` } as any);
    return { valid: false, code: 'VAL-003', errors };
  }
  
  if (
    profile.cache.enabled !== candidate.decisions.cache.enabled ||
    profile.messaging.broker !== candidate.decisions.messaging.broker ||
    profile.scalingProfile !== candidate.decisions.scalingProfile ||
    profile.communication !== candidate.decisions.communication
  ) {
    errors.push({ message: `VAL-004 PROFILE_MISMATCH: decisions do not match registry profile` } as any);
    return { valid: false, code: 'VAL-004', errors };
  }
  
  // Total weight
  const totalWeight = candidate.priorities.reduce((sum: number, p: any) => sum + p.weight, 0);
  if (Math.abs(totalWeight - 1.0) > 0.001) {
    errors.push({ message: `VAL-005 INVALID_PRIORITY_WEIGHT: sum is ${totalWeight}` } as any);
    return { valid: false, code: 'VAL-005', errors };
  }
  
  // Missing required targets
  const missingTargets = candidate.priorities.filter((p: any) => p.operator !== 'MIN' && p.operator !== 'MAX' && typeof p.target !== 'number');
  if (missingTargets.length > 0) {
    errors.push({ message: `VAL-006 MISSING_PRIORITY_TARGET: needed for LTE/GTE` } as any);
    return { valid: false, code: 'VAL-006', errors };
  }
  
  return { valid: true, errors: [], architectureId: candidate.architectureId };
}
