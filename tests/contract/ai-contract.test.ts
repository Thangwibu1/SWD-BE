import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createAiContract } from '../../src/evaluator/registry/ai-contract.js';
import { validateCandidate } from '../../src/evaluator/architecture-validator/index.js';

describe('AI contract and executable profiles', () => {
  const contract = createAiContract();
  const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(contract.schema);
  const validateSelection = new Ajv2020({ strict: true, allErrors: true }).compile(contract.selectionSchema);
  it('allows explicit unsupported requirements as AI output but never as an experiment candidate', () => {
    const unsupported = { error: 'UNSUPPORTED_REQUIREMENTS', unsupportedRequirements: ['Kafka broker'] };
    expect(validateSelection(unsupported)).toBe(true);
    expect(validateSchema(unsupported)).toBe(false);
    expect(validateCandidate(unsupported).valid).toBe(false);
    expect(validateSelection({ error: 'UNSUPPORTED_REQUIREMENTS', unsupportedRequirements: [] })).toBe(false);
  });
  it.each(contract.candidates)(
    'accepts the exported candidate for $architectureId',
    (candidate) => {
      expect(validateSchema(candidate), JSON.stringify(validateSchema.errors)).toBe(true);
      expect(validateSelection(candidate)).toBe(true);
      expect(validateCandidate(candidate).valid).toBe(true);
    },
  );
  it('rejects cross-profile decisions and unimplemented components', () => {
    const candidate = structuredClone(contract.candidates.find((c) => c.architectureId === 'A14')!);
    candidate.components.push('kafka');
    expect(validateSchema(candidate)).toBe(false);
    expect(validateCandidate(candidate)).toMatchObject({ valid: false, code: 'VAL-007' });
  });
  it('rejects contradictory messaging, cache targets and arbitrary TTL', () => {
    const candidate = contract.candidates.find((c) => c.architectureId === 'A15')!;
    for (const mutate of [
      (c: typeof candidate) => {
        c.decisions.messaging.enabled = false;
      },
      (c: typeof candidate) => {
        c.decisions.cache.targets.push('cart');
      },
      (c: typeof candidate) => {
        c.decisions.cache.ttlSeconds = 999;
      },
    ]) {
      const modified = structuredClone(candidate);
      mutate(modified);
      expect(validateCandidate(modified)).toMatchObject({ valid: false, code: 'VAL-004' });
    }
  });
  it('rejects unsupported IDs instead of approximating them', () => {
    const candidate = { ...contract.candidates[0], architectureId: 'A99' };
    expect(validateSchema(candidate)).toBe(false);
    expect(validateCandidate(candidate)).toMatchObject({ valid: false, code: 'VAL-002' });
  });
});
