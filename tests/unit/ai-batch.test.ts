import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createAssessor,
  csv,
  plan,
  providerRequest,
  providerResponse,
  studySchema,
} from '../../scripts/lib/ai-batch.js';

const study = studySchema.parse(
  JSON.parse(readFileSync('experiments/ai-batch/study.json', 'utf8')),
);
const frozen = plan(study);
const assess = createAssessor(frozen.selectionSchema);
const scenario = (id: string) => study.scenarios.find((s) => s.id === id)!;

describe('AI batch evidence and constraints', () => {
  it('freezes 432 repeatable jobs and shares exactly the same prompt across models', () => {
    expect(frozen.jobs).toHaveLength(432);
    expect(new Set(frozen.jobs.map((j) => j.id)).size).toBe(432);
    expect(plan(study)).toEqual(frozen);
    for (const s of study.scenarios) {
      expect(
        new Set(frozen.jobs.filter((j) => j.scenarioId === s.id).map((j) => j.promptHash)).size,
      ).toBe(1);
      expect(frozen.prompts[s.id]).not.toContain('[THAY BẰNG YÊU CẦU CỦA BẠN]');
    }
  });
  it('requires a new fingerprint when model or benchmark settings change', () => {
    const changed = structuredClone(study);
    changed.benchmark.measureSeconds++;
    expect(plan(changed).fingerprint).not.toBe(frozen.fingerprint);
    changed.models[0]!.model = 'another-model';
    expect(plan(changed).fingerprint).not.toBe(frozen.fingerprint);
  });
  it('keeps wrong selections distinct from schema validity', () => {
    const a01 = JSON.stringify(frozen.catalog.find((c) => c.architectureId === 'A01'));
    expect(assess(a01, scenario('small-team')).status).toBe('VALID');
    expect(assess(a01, scenario('shared-redis-cart')).status).toBe('REQUIREMENTS_MISMATCH');
    expect(assess(a01, scenario('unsupported-kafka')).status).toBe('REQUIREMENTS_MISMATCH');
  });
  it('records correct and false rejections, invalid JSON, and invalid weights', () => {
    const refusal = JSON.stringify({
      error: 'UNSUPPORTED_REQUIREMENTS',
      unsupportedRequirements: ['Kafka'],
    });
    expect(assess(refusal, scenario('unsupported-kafka')).status).toBe('CORRECT_REJECTION');
    expect(assess(refusal, scenario('small-team')).status).toBe('FALSE_REJECTION');
    expect(assess('```json\n{}\n```', scenario('small-team')).status).toBe('INVALID_JSON');
    const candidate = structuredClone(frozen.catalog[0]!);
    candidate.priorities[0]!.weight = 0.9;
    expect(assess(JSON.stringify(candidate), scenario('small-team')).status).toBe(
      'INVALID_CANDIDATE',
    );
  });
  it('rejects an impossible supported test case before calling a model', () => {
    const changed = structuredClone(study);
    changed.scenarios[0]!.constraints.scalingProfile = 'AUTOSCALING';
    expect(() => plan(changed)).toThrow('No catalog candidate');
    changed.models.push(changed.models[0]!);
    expect(studySchema.safeParse(changed).success).toBe(false);
  });
  it('prepares six distinct APIKEY.FAN models and per-model keys against one provider', () => {
    const base = JSON.parse(readFileSync('experiments/ai-batch/study.json', 'utf8'));
    const overlay = JSON.parse(
      readFileSync('experiments/ai-batch/apikey-fan-6-models.study.json', 'utf8'),
    );
    delete overlay.extends;
    overlay.models = overlay.models.map((model: Record<string, unknown>, index: number) => ({
      ...model,
      model: `provider-model-${index + 1}`,
    }));
    const configured = studySchema.parse({ ...base, ...overlay });
    expect(configured.models).toHaveLength(6);
    expect(new Set(configured.models.map((model) => model.model)).size).toBe(6);
    expect(new Set(configured.models.map((model) => model.baseUrl))).toEqual(
      new Set(['https://api.apikey.fan/v1']),
    );
    expect(new Set(configured.models.map((model) => model.apiKeyEnv)).size).toBe(6);
    expect(configured.benchmark.requestVolumes).toEqual([10_000, 100_000, 500_000]);
    expect(configured.benchmark.measureSeconds).toBe(600);
    expect(configured.scenarios).toHaveLength(1);
    expect(configured.generationRepetitions).toBe(6);
    expect(plan(configured).jobs).toHaveLength(36);
  });
  it('uses native provider auth and output fields without temperature assumptions', () => {
    for (const model of study.models) {
      const request = providerRequest(model, 'prompt', 'fake-test-key');
      expect(request.url).not.toContain('fake-test-key');
      expect(JSON.stringify(request.body)).not.toContain('fake-test-key');
      expect(request.body).not.toHaveProperty('temperature');
    }
    const proxyModel = {
      ...study.models[0]!,
      baseUrl: 'https://api.apikey.fan/v1',
      sendMaxOutputTokens: false,
    };
    const proxyRequest = providerRequest(proxyModel, 'prompt', 'shared-key');
    expect(proxyRequest.url).toBe('https://api.apikey.fan/v1/chat/completions');
    expect(proxyRequest.headers).toMatchObject({ Authorization: 'Bearer shared-key' });
    expect(proxyRequest.body).toMatchObject({ stream: false });
    expect(proxyRequest.body).not.toHaveProperty('max_completion_tokens');
    const text = '{"answer":true}';
    expect(
      providerResponse('openai', {
        model: 'snapshot',
        choices: [{ finish_reason: 'length', message: { content: text } }],
        usage: { total_tokens: 12 },
      }),
    ).toMatchObject({ complete: false, text, returnedModel: 'snapshot' });
    expect(
      providerResponse('anthropic', {
        model: 'claude',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking' }, { type: 'text', text }],
      }),
    ).toMatchObject({ complete: true, text });
    expect(
      providerResponse('gemini', {
        modelVersion: 'gemini',
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: 'private thought', thought: true }, { text }] },
          },
        ],
      }),
    ).toMatchObject({ complete: true, text });
    expect(() => providerResponse('gemini', { candidates: [] })).toThrow();
  });
  it('escapes CSV content and spreadsheet formulas', () => {
    const result = csv([{ id: '=CMD()', error: 'a,"b"\nc' }], ['id', 'error']);
    expect(result).toContain('"\'=CMD()"');
    expect(result).toContain('"a,""b""\nc"');
  });
});
