import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createAiContract } from '../../src/evaluator/registry/ai-contract.js';
import { validateCandidate } from '../../src/evaluator/architecture-validator/index.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
const workload = z.enum(['BROWSING_V1', 'MIXED_V1', 'CHECKOUT_V1', 'FLASH_SALE_V1']);
export const studySchema = z
  .object({
    studyId: id,
    orderSeed: z.number().int().nonnegative(),
    generationRepetitions: z.number().int().min(1).max(20),
    requestTimeoutMs: z.number().int().min(1000).max(600_000),
    intervalMs: z.number().int().min(0).max(60_000),
    models: z
      .array(
        z
          .object({
            id,
            provider: z.enum(['openai', 'anthropic', 'gemini']),
            model: z.string().min(1).max(100),
            apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
            baseUrl: z.url(),
            maxOutputTokens: z.number().int().min(512).max(65_536),
            sendMaxOutputTokens: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1),
    scenarios: z
      .array(
        z
          .object({
            id,
            requirements: z.string().min(20),
            workloadProfile: workload,
            expected: z.enum(['supported', 'unsupported']),
            constraints: z
              .object({
                family: z.string().optional(),
                broker: z.enum(['NONE', 'POSTGRES', 'RABBITMQ']).optional(),
                cacheTargets: z.array(z.enum(['product', 'cart'])).optional(),
                scalingProfile: z.string().optional(),
              })
              .strict()
              .default({}),
          })
          .strict(),
      )
      .min(1),
    benchmark: z
      .object({
        datasetProfile: z.enum(['pilot', 'main', 'capacity']),
        loadLevelsRps: z.array(z.number().int().min(1).max(10_000)).min(1).max(10).optional(),
        requestVolumes: z.array(z.number().int().min(1).max(10_000_000)).min(1).max(10).optional(),
        repetitions: z.number().int().min(1).max(5),
        warmupSeconds: z.number().int().min(0).max(3600),
        measureSeconds: z.number().int().min(1).max(86_400),
        cooldownSeconds: z.number().int().min(0).max(3600),
        invalidRetryLimit: z.number().int().min(0).max(1),
        costCatalogVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
        scoreBoundsVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
        slo: z
          .object({
            p99Ms: z.number().positive(),
            errorRateMax: z.number().min(0).max(1),
            consistencyViolationsMax: z.number().int().min(0),
          })
          .strict(),
      })
      .strict()
      .superRefine((benchmark, ctx) => {
        if (!!benchmark.loadLevelsRps === !!benchmark.requestVolumes)
          ctx.addIssue({ code: 'custom', message: 'Configure exactly one of loadLevelsRps or requestVolumes' });
        const tiers = benchmark.loadLevelsRps ?? benchmark.requestVolumes ?? [];
        if (new Set(tiers).size !== tiers.length)
          ctx.addIssue({ code: 'custom', message: 'Duplicate benchmark tiers' });
      }),
  })
  .strict()
  .superRefine((study, ctx) => {
    for (const key of ['models', 'scenarios'] as const) {
      if (new Set(study[key].map((item) => item.id)).size !== study[key].length)
        ctx.addIssue({ code: 'custom', message: `Duplicate ${key} IDs` });
    }
    if (new Set(study.models.map((model) => model.model)).size !== study.models.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate provider model IDs' });
  });
export type Study = z.infer<typeof studySchema>;
export type Model = Study['models'][number];
export type Scenario = Study['scenarios'][number];
export interface Job {
  id: string;
  modelId: string;
  scenarioId: string;
  repetition: number;
  promptHash: string;
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function plan(study: Study) {
  const contract = createAiContract();
  const benchmarkDescription = study.benchmark.requestVolumes
    ? `khối lượng ${study.benchmark.requestVolumes.map((value) => value.toLocaleString('en-US')).join(', ')} business operations, mỗi mức trong ${study.benchmark.measureSeconds} giây; hệ thống sẽ đo raw HTTP requests riêng`
    : `mức tải ${study.benchmark.loadLevelsRps!.join(', ')} operations/s`;
  const prompts = Object.fromEntries(
    study.scenarios.map((scenario) => [
      scenario.id,
      contract.prompt.replace(
        '[THAY BẰNG YÊU CẦU CỦA BẠN]',
        `${scenario.requirements}\nGiới hạn chung: tối đa 2 vCPU, 4096 MiB; thanh toán mock, không overselling, idempotency bền vững. Mục tiêu P99 HTTP ${study.benchmark.slo.p99Ms} ms cần được đo; nếu async phải phân biệt acceptance và hoàn tất. Workload đo: ${scenario.workloadProfile}; benchmark: ${benchmarkDescription}. Không suy diễn các mức tải này là năng lực đã đạt.`,
      ),
    ]),
  );
  const jobs: Job[] = study.models.flatMap((model) =>
    study.scenarios.flatMap((scenario) =>
      Array.from({ length: study.generationRepetitions }, (_, i) => ({
        id: `${model.id}__${scenario.id}__${i + 1}`,
        modelId: model.id,
        scenarioId: scenario.id,
        repetition: i + 1,
        promptHash: hash(prompts[scenario.id]!),
      })),
    ),
  );
  let seed = study.orderSeed >>> 0;
  for (let i = jobs.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = Math.floor((seed / 0x100000000) * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!];
  }
  // Catch contradictory or misspelled supported constraints before collecting data.
  for (const scenario of study.scenarios.filter((s) => s.expected === 'supported')) {
    if (!contract.candidates.some((c) => matches(c, scenario)))
      throw new Error(`No catalog candidate satisfies ${scenario.id}`);
  }
  return {
    version: 1,
    fingerprint: hash(JSON.stringify({ study, prompts, schema: contract.selectionSchema })),
    study,
    prompts,
    jobs,
    selectionSchema: contract.selectionSchema,
    catalog: contract.candidates,
  };
}
export type Plan = ReturnType<typeof plan>;

function matches(
  candidate: ReturnType<typeof createAiContract>['candidates'][number],
  scenario: Scenario,
) {
  const c = scenario.constraints;
  return (
    (!c.family || c.family === candidate.architectureFamily) &&
    (!c.broker || c.broker === candidate.decisions.messaging.broker) &&
    (!c.scalingProfile || c.scalingProfile === candidate.decisions.scalingProfile) &&
    (!c.cacheTargets ||
      JSON.stringify([...c.cacheTargets].sort()) ===
        JSON.stringify([...candidate.decisions.cache.targets].sort()))
  );
}

export function createAssessor(schema: Plan['selectionSchema']) {
  const validateSelection = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  return (text: string, scenario: Scenario) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        status: 'INVALID_JSON',
        errors: ['Response is not a single JSON object'],
        candidate: null,
      };
    }
    if (!validateSelection(parsed))
      return {
        status: 'INVALID_SCHEMA',
        errors: structuredClone(validateSelection.errors),
        candidate: null,
      };
    if ((parsed as { error?: string }).error === 'UNSUPPORTED_REQUIREMENTS') {
      return {
        status: scenario.expected === 'unsupported' ? 'CORRECT_REJECTION' : 'FALSE_REJECTION',
        errors: [],
        candidate: null,
      };
    }
    const validation = validateCandidate(parsed);
    if (!validation.valid)
      return { status: 'INVALID_CANDIDATE', errors: validation.errors, candidate: null };
    const candidate = parsed as Plan['catalog'][number];
    if (scenario.expected === 'unsupported' || !matches(candidate, scenario))
      return {
        status: 'REQUIREMENTS_MISMATCH',
        errors: ['Candidate violates mandatory scenario requirements'],
        candidate,
      };
    return { status: 'VALID', errors: [], candidate };
  };
}
export type Assessment = ReturnType<ReturnType<typeof createAssessor>>;
export interface Generation {
  jobId: string;
  status: string;
  text: string;
  assessment?: Assessment;
  requestedModel: string;
  returnedModel?: string;
  usage?: unknown;
  finishReason?: string;
  durationMs: number;
  generatedAt: string;
  source: 'api' | 'manual';
  error?: string;
}

export function providerRequest(model: Model, prompt: string, key: string) {
  const base = model.baseUrl.replace(/\/$/, '');
  if (model.provider === 'openai')
    return {
      url: `${base}/chat/completions`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: {
        model: model.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        ...(model.sendMaxOutputTokens !== false
          ? { max_completion_tokens: model.maxOutputTokens }
          : {}),
      },
    };
  if (model.provider === 'anthropic')
    return {
      url: `${base}/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: model.model,
        max_tokens: model.maxOutputTokens,
        messages: [{ role: 'user', content: prompt }],
      },
    };
  return {
    url: `${base}/models/${encodeURIComponent(model.model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: model.maxOutputTokens },
    },
  };
}

// Treat provider envelopes as untrusted; never turn truncation into a successful sample.
export function providerResponse(provider: Model['provider'], raw: unknown) {
  const data = z.record(z.string(), z.unknown()).parse(raw);
  if (provider === 'openai') {
    const parsed = z
      .object({
        model: z.string(),
        usage: z.unknown().optional(),
        choices: z
          .array(
            z.object({
              finish_reason: z.string(),
              message: z.object({ content: z.string().nullable() }),
            }),
          )
          .min(1),
      })
      .parse(data);
    return {
      text: parsed.choices[0]!.message.content ?? '',
      returnedModel: parsed.model,
      usage: parsed.usage,
      finishReason: parsed.choices[0]!.finish_reason,
      complete: parsed.choices[0]!.finish_reason === 'stop',
    };
  }
  if (provider === 'anthropic') {
    const parsed = z
      .object({
        model: z.string(),
        usage: z.unknown().optional(),
        stop_reason: z.string(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      })
      .parse(data);
    return {
      text: parsed.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join(''),
      returnedModel: parsed.model,
      usage: parsed.usage,
      finishReason: parsed.stop_reason,
      complete: parsed.stop_reason === 'end_turn',
    };
  }
  const parsed = z
    .object({
      modelVersion: z.string().optional(),
      usageMetadata: z.unknown().optional(),
      candidates: z
        .array(
          z.object({
            finishReason: z.string(),
            content: z
              .object({
                parts: z.array(
                  z.object({ text: z.string().optional(), thought: z.boolean().optional() }),
                ),
              })
              .optional(),
          }),
        )
        .min(1),
    })
    .parse(data);
  const first = parsed.candidates[0]!;
  return {
    text:
      first.content?.parts
        .filter((p) => !p.thought)
        .map((p) => p.text ?? '')
        .join('') ?? '',
    returnedModel: parsed.modelVersion ?? '',
    usage: parsed.usageMetadata,
    finishReason: first.finishReason,
    complete: first.finishReason === 'STOP',
  };
}

export function csv(rows: Record<string, unknown>[], columns: string[]) {
  const cell = (value: unknown) => {
    let text =
      value === undefined || value === null
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return (
    '\ufeff' +
    [
      columns.map(cell).join(','),
      ...rows.map((row) => columns.map((key) => cell(row[key])).join(',')),
    ].join('\n') +
    '\n'
  );
}
