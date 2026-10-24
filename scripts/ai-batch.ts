import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createAssessor,
  csv,
  hash,
  plan,
  providerRequest,
  providerResponse,
  studySchema,
  type Generation,
  type Plan,
} from './lib/ai-batch.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: {
      type: 'string',
      default: 'experiments/ai-batch/apikey-fan-6-models.study.json',
    },
    out: { type: 'string' },
    limit: { type: 'string', default: '1' },
    model: { type: 'string' },
    'retry-errors': { type: 'boolean', default: false },
  },
});
const mode = positionals[0] ?? 'prepare';
if (!['prepare', 'preflight', 'probe', 'generate', 'import', 'submit', 'collect'].includes(mode))
  throw new Error('Modes: prepare, preflight, probe, generate, import, submit, collect');
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
  throw new Error('--limit must be 1..10000');
const configPath = path.resolve(values.config);
const rawConfig = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
let resolvedConfig = rawConfig;
if (typeof rawConfig['extends'] === 'string') {
  const basePath = path.resolve(path.dirname(configPath), rawConfig['extends']);
  const base = JSON.parse(readFileSync(basePath, 'utf8')) as Record<string, unknown>;
  if ('extends' in base) throw new Error('Nested study config extends is not supported');
  const overrides = { ...rawConfig };
  delete overrides['extends'];
  resolvedConfig = { ...base, ...overrides };
}
const study = studySchema.parse(resolvedConfig);
const modelFilter = values.model;
if (
  modelFilter &&
  !study.models.some((model) => model.id === modelFilter || model.model === modelFilter)
)
  throw new Error(`Unknown --model ${modelFilter}`);
const benchmarkTiers = study.benchmark.requestVolumes ?? study.benchmark.loadLevelsRps ?? [];
const placeholderModels = study.models.filter((model) =>
  model.model.startsWith('REPLACE_MODEL_ID_'),
);
if (placeholderModels.length)
  throw new Error(
    `Replace model IDs before running: ${placeholderModels.map((model) => model.id).join(', ')}`,
  );
const current = plan(study);
const out = path.resolve(values.out ?? `results/ai-batch/${study.studyId}`);
mkdirSync(out, { recursive: true });
const file = (...parts: string[]) => path.join(out, ...parts);
const read = <T>(name: string): T => JSON.parse(readFileSync(file(name), 'utf8')) as T;
function save(name: string, value: unknown) {
  const target = file(name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(`${target}.tmp`, JSON.stringify(value, null, 2) + '\n');
  renameSync(`${target}.tmp`, target);
}
const lock = file('.lock');
try {
  mkdirSync(lock);
} catch {
  throw new Error(
    `Another batch process may be active: ${lock}. Remove the empty lock only after confirming that process has stopped.`,
  );
}
try {
  let frozen: Plan;
  if (existsSync(file('manifest.json'))) {
    frozen = read<Plan>('manifest.json');
    if (frozen.fingerprint !== current.fingerprint)
      throw new Error(
        'Study or registry changed. Use a new studyId/output directory to preserve frozen evidence.',
      );
  } else {
    if (mode !== 'prepare') throw new Error('Run prepare first.');
    frozen = current;
    save('manifest.json', frozen);
    save('selection.schema.json', frozen.selectionSchema);
    save('catalog.json', frozen.catalog);
    mkdirSync(file('prompts'), { recursive: true });
    mkdirSync(file('manual'), { recursive: true });
    for (const [id, text] of Object.entries(frozen.prompts))
      writeFileSync(file('prompts', `${id}.txt`), text);
  }
  let assessor: ReturnType<typeof createAssessor> | undefined;
  const assess: ReturnType<typeof createAssessor> = (text, scenario) => {
    assessor ??= createAssessor(frozen.selectionSchema);
    return assessor(text, scenario);
  };
  const records = new Map<string, Generation>();
  for (const job of frozen.jobs) {
    const name = `generations/${job.id}.json`;
    if (existsSync(file(name))) records.set(job.id, read<Generation>(name));
  }
  const api = (process.env['EVALUATOR_API_URL'] ?? 'http://localhost:8088').replace(/\/$/, '');
  async function apiJson(
    route: string,
    body?: unknown,
    key?: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${api}/api/v1${route}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `Evaluator ${route}: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    return (await response.json()) as Record<string, unknown>;
  }
  if (mode === 'preflight') {
    let failed = false;
    for (const model of study.models) {
      const available = !!process.env[model.apiKeyEnv];
      console.log(
        `${model.id}: ${model.model}: ${available ? 'KEY_PRESENT (access not yet verified)' : `MISSING ${model.apiKeyEnv}`}`,
      );
      if (!available) failed = true;
    }
    try {
      await apiJson('/ready');
      const remote = await apiJson('/architectures/ai-contract');
      if (
        hash(JSON.stringify(remote['selectionSchema'])) !==
        hash(JSON.stringify(frozen.selectionSchema))
      )
        throw new Error('Remote evaluator catalog/schema differs from frozen local contract');
      console.log(
        'Evaluator ready; remote AI contract matches. Snapshot availability is checked on submit.',
      );
    } catch (error) {
      failed = true;
      console.error(String(error));
    }
    if (failed) process.exitCode = 1;
  }
  if (mode === 'probe') {
    const scenario = study.scenarios.find((item) => item.expected === 'supported');
    if (!scenario) throw new Error('Probe requires at least one supported scenario');
    let failed = false;
    for (const model of study.models) {
      const key = process.env[model.apiKeyEnv];
      if (!key) throw new Error(`Missing ${model.apiKeyEnv}`);
      const startedAt = new Date().toISOString();
      const start = Date.now();
      const request = providerRequest(model, frozen.prompts[scenario.id]!, key);
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(study.requestTimeoutMs),
      });
      const raw = await response.text();
      mkdirSync(file('probes'), { recursive: true });
      writeFileSync(file('probes', `${model.id}.provider.json`), raw);
      let probe: Record<string, unknown> = {
        modelId: model.id,
        requestedModel: model.model,
        scenarioId: scenario.id,
        httpStatus: response.status,
        startedAt,
        durationMs: Date.now() - start,
        passed: false,
      };
      try {
        if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
        const parsed = providerResponse(model.provider, JSON.parse(raw));
        const assessment = assess(parsed.text, scenario);
        probe = {
          ...probe,
          returnedModel: parsed.returnedModel,
          finishReason: parsed.finishReason,
          complete: parsed.complete,
          usage: parsed.usage,
          assessmentStatus: assessment.status,
          architectureId: assessment.candidate?.architectureId,
          passed: parsed.complete && assessment.status === 'VALID',
        };
        if (!probe['passed']) throw new Error(`Probe assessment: ${assessment.status}`);
      } catch (error) {
        failed = true;
        probe['error'] = error instanceof Error ? error.message : String(error);
      }
      save(`probes/${model.id}.json`, probe);
      console.log(`${model.id}: ${probe['passed'] ? 'PASS' : 'FAIL'}`);
      await delay(study.intervalMs);
    }
    if (failed) process.exitCode = 1;
  }
  if (mode === 'generate' || mode === 'import') {
    const pending = frozen.jobs
      .filter((job) => {
        if (!modelFilter) return true;
        const model = study.models.find((item) => item.id === job.modelId)!;
        return model.id === modelFilter || model.model === modelFilter;
      })
      .filter(
        (job) =>
          !records.has(job.id) ||
          (values['retry-errors'] && records.get(job.id)?.status === 'API_ERROR'),
      )
      .filter((job) => mode !== 'import' || existsSync(file('manual', `${job.id}.txt`)))
      .slice(0, limit);
    // Validate all selected credentials before the first billable request.
    if (mode === 'generate')
      for (const job of pending) {
        const model = study.models.find((m) => m.id === job.modelId)!;
        if (!process.env[model.apiKeyEnv])
          throw new Error(
            `Missing ${model.apiKeyEnv}; set it in the process environment or use manual import.`,
          );
      }
    for (const job of pending) {
      const model = study.models.find((m) => m.id === job.modelId)!;
      const scenario = study.scenarios.find((s) => s.id === job.scenarioId)!;
      const start = Date.now();
      const record: Generation = {
        jobId: job.id,
        status: 'API_ERROR',
        text: '',
        requestedModel: model.model,
        durationMs: 0,
        generatedAt: new Date().toISOString(),
        source: mode === 'import' ? 'manual' : 'api',
      };
      const attempt = `${job.id}-${Date.now()}`;
      try {
        if (mode === 'import') record.text = readFileSync(file('manual', `${job.id}.txt`), 'utf8');
        else {
          const request = providerRequest(
            model,
            frozen.prompts[job.scenarioId]!,
            process.env[model.apiKeyEnv]!,
          );
          const response = await fetch(request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: AbortSignal.timeout(study.requestTimeoutMs),
          });
          // Persist every provider response, including HTTP failures; no headers or API keys.
          const raw = await response.text();
          mkdirSync(file('provider'), { recursive: true });
          writeFileSync(file('provider', `${attempt}.json`), raw);
          if (!response.ok)
            throw new Error(`Provider HTTP ${response.status}; see provider/${attempt}.json`);
          const parsed = providerResponse(model.provider, JSON.parse(raw));
          Object.assign(record, parsed);
          if (!parsed.complete) {
            record.status = 'INCOMPLETE';
            record.error = `Provider finish reason: ${parsed.finishReason}`;
          }
        }
        record.assessment = assess(record.text, scenario);
        if (record.status !== 'INCOMPLETE') record.status = record.assessment.status;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
      }
      record.durationMs = Date.now() - start;
      save(`attempts/${attempt}.json`, record);
      save(`generations/${job.id}.json`, record);
      records.set(job.id, record);
      console.log(`${job.id}: ${record.status}`);
      if (mode === 'generate') await delay(study.intervalMs);
    }
  }
  if (mode === 'submit') {
    const remote = await apiJson('/architectures/ai-contract');
    if (
      hash(JSON.stringify(remote['selectionSchema'])) !==
      hash(JSON.stringify(frozen.selectionSchema))
    )
      throw new Error('Remote evaluator contract differs from frozen contract');
    let submitted = 0;
    for (const job of frozen.jobs) {
      const record = records.get(job.id);
      if (record?.status !== 'VALID' || existsSync(file('submissions', `${job.id}.json`))) continue;
      if (submitted >= limit) break;
      const scenario = study.scenarios.find((s) => s.id === job.scenarioId)!;
      const checked = assess(record.text, scenario);
      if (checked.status !== 'VALID' || !checked.candidate)
        throw new Error(`Evidence no longer validates: ${job.id}`);
      const body = {
        ...study.benchmark,
        candidate: checked.candidate,
        name: `${study.studyId} ${job.id}`.slice(0, 160),
        modelMetadata: {
          modelName: record.requestedModel,
          promptId: `${study.studyId}/${job.scenarioId}`,
        },
        workloadProfile: scenario.workloadProfile,
        protocolVersion: study.studyId,
      };
      const key = `ai-batch-${hash(`${frozen.fingerprint}:${job.id}:${JSON.stringify(body)}`)}`;
      const response = await apiJson('/experiments', body, key);
      if (typeof response['experimentId'] !== 'string')
        throw new Error('Evaluator did not return experimentId');
      save(`submissions/${job.id}.json`, {
        experimentId: response['experimentId'],
        evaluatorUrl: api,
        idempotencyKey: key,
        body,
        submittedAt: new Date().toISOString(),
      });
      submitted++;
      console.log(`${job.id}: queued ${response['experimentId']}`);
    }
  }
  if (mode === 'collect') {
    // One snapshot per submission. Re-run while jobs are running; includes failures and all attempts.
    for (const job of frozen.jobs) {
      if (!existsSync(file('submissions', `${job.id}.json`))) continue;
      const submission = read<{ experimentId: string; evaluatorUrl: string }>(
        `submissions/${job.id}.json`,
      );
      if (submission.evaluatorUrl !== api)
        throw new Error('EVALUATOR_API_URL differs from the submitted evaluator');
      try {
        const detail = await apiJson(`/experiments/${encodeURIComponent(submission.experimentId)}`);
        save(`benchmarks/${job.id}.json`, detail);
        console.log(`${job.id}: ${String(detail['status'])}`);
      } catch (error) {
        console.error(`${job.id}: ${String(error)}`);
        process.exitCode = 1;
      }
    }
  }
  const rows: Record<string, unknown>[] = frozen.jobs.map((job) => {
    const record = records.get(job.id);
    const scenario = study.scenarios.find((s) => s.id === job.scenarioId)!;
    return {
      ...job,
      expected: scenario.expected,
      workload: scenario.workloadProfile,
      status: record?.status ?? 'PENDING',
      source: record?.source,
      requestedModel: record?.requestedModel,
      returnedModel: record?.returnedModel,
      architectureId: record?.assessment?.candidate?.architectureId,
      durationMs: record?.durationMs,
      usage: record?.usage,
      error: record?.error,
      errors: record?.assessment?.errors,
    };
  });
  writeFileSync(
    file('generations.csv'),
    csv(rows, [
      'id',
      'modelId',
      'scenarioId',
      'repetition',
      'expected',
      'workload',
      'status',
      'source',
      'requestedModel',
      'returnedModel',
      'architectureId',
      'durationMs',
      'usage',
      'error',
      'errors',
      'promptHash',
    ]),
  );
  const selectionRows = frozen.jobs.map((job) => {
    const record = records.get(job.id);
    const candidate = record?.assessment?.candidate;
    return [
      job.modelId,
      record?.requestedModel,
      record?.returnedModel,
      job.repetition,
      record?.status ?? 'PENDING',
      candidate?.architectureId,
      candidate?.architectureFamily,
      candidate?.decisions.messaging.broker,
      candidate?.decisions.cache.targets.join(', '),
      candidate?.decisions.scalingProfile,
      record?.error ?? record?.assessment?.errors?.join('; '),
      `generations/${job.id}.json`,
    ]
      .map(markdownCell)
      .join(' | ');
  });
  writeFileSync(
    file('architecture-selections.md'),
    [
      '# AI architecture selections',
      '',
      `Study: \`${study.studyId}\``,
      '',
      'Mỗi dòng là một trong sáu lần gọi của model. `VALID` có thể benchmark; các trạng thái khác được giữ nguyên để đối chiếu và không tự retry.',
      '',
      '| Model | Requested model | Returned model | Lần | Trạng thái | Architecture | Family | Broker | Cache | Scaling | Lỗi/validation | Evidence |',
      '| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...selectionRows.map((row) => `| ${row} |`),
      '',
    ].join('\n'),
  );
  const runs: Record<string, unknown>[] = [];
  const resultCandidates: Record<string, unknown>[] = [];
  for (const job of frozen.jobs)
    if (existsSync(file('benchmarks', `${job.id}.json`))) {
      const detail = read<{ id: string; status: string; runs: Record<string, unknown>[] }>(
        `benchmarks/${job.id}.json`,
      );
      const record = records.get(job.id);
      const scenario = study.scenarios.find((item) => item.id === job.scenarioId)!;
      const candidate = record?.assessment?.candidate;
      for (const run of detail.runs) {
        runs.push({
          jobId: job.id,
          modelId: job.modelId,
          scenarioId: job.scenarioId,
          generationRepetition: job.repetition,
          experimentId: detail.id,
          experimentStatus: detail.status,
          ...run,
        });
        const metrics = objectValue(run['metrics_json']);
        const duration = objectValue(metrics['httpReqDuration']);
        const errors = objectValue(metrics['errorBreakdown']);
        const health = objectValue(metrics['containerHealth']);
        const cost = objectValue(run['cost_json']);
        const costBreakdown = objectValue(cost['breakdown']);
        const gates = objectValue(run['gates_json']);
        const gateItems = Array.isArray(gates['gates'])
          ? (gates['gates'] as Array<Record<string, unknown>>)
          : [];
        const scores = objectValue(run['scores_json']);
        const scoreItems = Array.isArray(scores['dimensions'])
          ? (scores['dimensions'] as Array<Record<string, unknown>>)
          : [];
        const normalizedScore = (dimension: string) =>
          scoreItems.find((item) => item['dimension'] === dimension)?.['normalizedScore'];
        const targetRps = numberValue(run['load_rps']);
        const achievedRps = numberValue(metrics['achievedRps']);
        resultCandidates.push({
          jobId: job.id,
          modelId: job.modelId,
          requestedModel: record?.requestedModel,
          returnedModel: record?.returnedModel,
          scenarioId: job.scenarioId,
          workload: scenario.workloadProfile,
          generationRepetition: job.repetition,
          generationStatus: record?.status,
          architectureId: candidate?.architectureId,
          architectureFamily: candidate?.architectureFamily,
          broker: candidate?.decisions.messaging.broker,
          cacheTargets: candidate?.decisions.cache.targets.join('|'),
          scalingProfile: candidate?.decisions.scalingProfile,
          experimentId: detail.id,
          experimentStatus: detail.status,
          runId: run['id'],
          targetRps,
          targetOperations: run['target_operations'] ?? metrics['targetOperations'],
          benchmarkRepetition: run['run_number'],
          attempt: run['attempt'],
          runState: run['state'],
          failureCode: run['failure_code'],
          failureMessage: run['failure_message'],
          totalRequests: metrics['totalRequests'],
          totalIterations: metrics['totalIterations'],
          droppedIterations: metrics['droppedIterations'],
          achievedRps,
          achievedRatePercent:
            targetRps && achievedRps !== undefined ? (achievedRps / targetRps) * 100 : undefined,
          volumeCompletionPercent:
            numberValue(run['target_operations']) &&
            numberValue(metrics['totalIterations']) !== undefined
              ? (numberValue(metrics['totalIterations'])! /
                  numberValue(run['target_operations'])!) *
                100
              : undefined,
          p50Ms: metrics['p50Ms'] ?? duration['p50'],
          p95Ms: metrics['p95Ms'] ?? duration['p95'],
          p99Ms: metrics['p99Ms'] ?? duration['p99'],
          averageMs: duration['avg'],
          maxMs: duration['max'],
          errorRate: metrics['errorRate'] ?? metrics['httpReqFailed'],
          http5xxRate: errors['http5xxRate'],
          http4xxUnexpectedRate: errors['http4xxUnexpectedRate'],
          networkErrorRate: errors['networkErrorRate'],
          timeoutRate: errors['timeoutRate'],
          businessErrorRate: errors['businessErrorRate'],
          checkoutAcceptanceRate: metrics['checkoutAcceptanceRate'],
          checkoutConfirmationSamples: metrics['checkoutConfirmationSamples'],
          checkoutSampledConfirmationRate: metrics['checkoutSampledConfirmationRate'],
          checkoutSampledUnsettledRate: metrics['checkoutSampledUnsettledRate'],
          stockoutRate: metrics['stockoutRate'],
          cpuEfficiency: metrics['cpuEfficiency'],
          memoryPeakMiB: metrics['memoryPeakMiB'],
          loadHostCpuPercent: metrics['loadHostCpuPercent'],
          oomKills: health['oomKills'],
          unexpectedCrashes: health['unexpectedCrashes'],
          metricCoveragePercent: metrics['metricCoveragePercent'],
          measurementDurationSeconds: metrics['measurementDurationSeconds'],
          allGatesPassed: gates['allPassed'],
          feasible: gates['feasible'],
          failedGates: gateItems
            .filter((item) => item['passed'] === false)
            .map((item) => String(item['code']))
            .join('|'),
          infraMonthUsd: cost['infraMonth'],
          tco12mUsd: cost['tco12m'],
          engineeringComplexity: cost['engineeringComplexity'],
          computeMonthUsd: costBreakdown['compute'],
          postgresMonthUsd: costBreakdown['postgres'],
          redisMonthUsd: costBreakdown['redis'],
          rabbitmqMonthUsd: costBreakdown['rabbitmq'],
          loadBalancerMonthUsd: costBreakdown['loadBalancer'],
          trafficMonthUsd: costBreakdown['traffic'],
          weightedUtility: scores['weightedUtility'],
          p99Score: normalizedScore('p99_ms'),
          errorRateScore: normalizedScore('error_rate'),
          throughputScore: normalizedScore('throughput_rps'),
          monthlyCostScore: normalizedScore('monthly_cost_usd'),
          cpuEfficiencyScore: normalizedScore('cpu_efficiency'),
          memoryScore: normalizedScore('memory_peak_mib'),
        });
      }
    }
  writeFileSync(
    file('runs.csv'),
    csv(runs, [
      'jobId',
      'modelId',
      'scenarioId',
      'generationRepetition',
      'experimentId',
      'experimentStatus',
      'id',
      'load_rps',
      'target_operations',
      'run_number',
      'attempt',
      'state',
      'failure_code',
      'failure_message',
      'metrics_json',
      'cost_json',
      'gates_json',
      'scores_json',
    ]),
  );
  const latestResults = new Map<string, Record<string, unknown>>();
  for (const row of resultCandidates) {
    const key = `${String(row['jobId'])}:${String(row['targetOperations'] ?? row['targetRps'])}:${String(row['benchmarkRepetition'])}`;
    const existing = latestResults.get(key);
    if (
      !existing ||
      (numberValue(row['attempt']) ?? -1) >= (numberValue(existing['attempt']) ?? -1)
    )
      latestResults.set(key, row);
  }
  const resultColumns = [
    'jobId',
    'modelId',
    'requestedModel',
    'returnedModel',
    'scenarioId',
    'workload',
    'generationRepetition',
    'generationStatus',
    'architectureId',
    'architectureFamily',
    'broker',
    'cacheTargets',
    'scalingProfile',
    'experimentId',
    'experimentStatus',
    'runId',
    'targetRps',
    'targetOperations',
    'benchmarkRepetition',
    'attempt',
    'runState',
    'failureCode',
    'failureMessage',
    'totalRequests',
    'totalIterations',
    'droppedIterations',
    'achievedRps',
    'achievedRatePercent',
    'volumeCompletionPercent',
    'p50Ms',
    'p95Ms',
    'p99Ms',
    'averageMs',
    'maxMs',
    'errorRate',
    'http5xxRate',
    'http4xxUnexpectedRate',
    'networkErrorRate',
    'timeoutRate',
    'businessErrorRate',
    'checkoutAcceptanceRate',
    'checkoutConfirmationSamples',
    'checkoutSampledConfirmationRate',
    'checkoutSampledUnsettledRate',
    'stockoutRate',
    'cpuEfficiency',
    'memoryPeakMiB',
    'loadHostCpuPercent',
    'oomKills',
    'unexpectedCrashes',
    'metricCoveragePercent',
    'measurementDurationSeconds',
    'allGatesPassed',
    'feasible',
    'failedGates',
    'infraMonthUsd',
    'tco12mUsd',
    'engineeringComplexity',
    'computeMonthUsd',
    'postgresMonthUsd',
    'redisMonthUsd',
    'rabbitmqMonthUsd',
    'loadBalancerMonthUsd',
    'trafficMonthUsd',
    'weightedUtility',
    'p99Score',
    'errorRateScore',
    'throughputScore',
    'monthlyCostScore',
    'cpuEfficiencyScore',
    'memoryScore',
  ];
  writeFileSync(file('results.csv'), csv([...latestResults.values()], resultColumns));
  const comparisonGroups = new Map<string, Record<string, unknown>[]>();
  for (const row of latestResults.values()) {
    const key = [
      row['modelId'],
      row['scenarioId'],
      row['architectureId'],
      row['targetOperations'] ?? row['targetRps'],
    ]
      .map(String)
      .join(':');
    comparisonGroups.set(key, [...(comparisonGroups.get(key) ?? []), row]);
  }
  const comparisonRows = [...comparisonGroups.values()].map((group) => {
    const completed = group.filter(
      (row) => row['runState'] === 'COMPLETED' && numberValue(row['p99Ms']) !== undefined,
    );
    const passing = group.filter((row) => row['allGatesPassed'] === true);
    const selectedGenerations = new Set(group.map((row) => String(row['jobId']))).size;
    const numericMedian = (column: string) =>
      median(
        completed
          .map((row) => numberValue(row[column]))
          .filter((value): value is number => value !== undefined),
      );
    return {
      modelId: group[0]?.['modelId'],
      requestedModel: group[0]?.['requestedModel'],
      scenarioId: group[0]?.['scenarioId'],
      workload: group[0]?.['workload'],
      architectureId: group[0]?.['architectureId'],
      architectureFamily: group[0]?.['architectureFamily'],
      broker: group[0]?.['broker'],
      cacheTargets: group[0]?.['cacheTargets'],
      scalingProfile: group[0]?.['scalingProfile'],
      targetRps: group[0]?.['targetRps'],
      targetOperations: group[0]?.['targetOperations'],
      selectedGenerations,
      generationRepetitions: study.generationRepetitions,
      selectionRate: selectedGenerations / study.generationRepetitions,
      totalSamples: group.length,
      completedSamples: completed.length,
      failedSamples: group.length - completed.length,
      gatePassSamples: passing.length,
      gatePassRate: group.length ? passing.length / group.length : undefined,
      suitable: group.length > 0 && passing.length / group.length >= 0.8,
      p50MsMedian: numericMedian('p50Ms'),
      p95MsMedian: numericMedian('p95Ms'),
      p99MsMedian: numericMedian('p99Ms'),
      completedOperationsMedian: numericMedian('totalIterations'),
      totalHttpRequestsMedian: numericMedian('totalRequests'),
      achievedRpsMedian: numericMedian('achievedRps'),
      achievedRatePercentMedian: numericMedian('achievedRatePercent'),
      volumeCompletionPercentMedian: numericMedian('volumeCompletionPercent'),
      errorRateMedian: numericMedian('errorRate'),
      cpuEfficiencyMedian: numericMedian('cpuEfficiency'),
      memoryPeakMiBMedian: numericMedian('memoryPeakMiB'),
      infraMonthUsdMedian: numericMedian('infraMonthUsd'),
      tco12mUsdMedian: numericMedian('tco12mUsd'),
      weightedUtilityMedian: numericMedian('weightedUtility'),
    };
  });
  writeFileSync(
    file('comparison.csv'),
    csv(comparisonRows, [
      'modelId',
      'requestedModel',
      'scenarioId',
      'workload',
      'architectureId',
      'architectureFamily',
      'broker',
      'cacheTargets',
      'scalingProfile',
      'targetRps',
      'targetOperations',
      'selectedGenerations',
      'generationRepetitions',
      'selectionRate',
      'totalSamples',
      'completedSamples',
      'failedSamples',
      'gatePassSamples',
      'gatePassRate',
      'suitable',
      'p50MsMedian',
      'p95MsMedian',
      'p99MsMedian',
      'completedOperationsMedian',
      'totalHttpRequestsMedian',
      'achievedRpsMedian',
      'achievedRatePercentMedian',
      'volumeCompletionPercentMedian',
      'errorRateMedian',
      'cpuEfficiencyMedian',
      'memoryPeakMiBMedian',
      'infraMonthUsdMedian',
      'tco12mUsdMedian',
      'weightedUtilityMedian',
    ]),
  );
  save('comparison.json', comparisonRows);
  const groups = study.models.flatMap((model) =>
    study.scenarios.map((scenario) => {
      const group = rows.filter(
        (r) => r['modelId'] === model.id && r['scenarioId'] === scenario.id,
      );
      const measured = group.filter((r) => r['status'] !== 'PENDING');
      const valid = measured.filter((r) => r['status'] === 'VALID');
      const counts: Record<string, number> = {};
      for (const row of valid) {
        const id = String(row['architectureId']);
        counts[id] = (counts[id] ?? 0) + 1;
      }
      const answered = measured.filter((r) => r['status'] !== 'API_ERROR');
      const correctCount = measured.filter(
        (r) => r['status'] === 'VALID' || r['status'] === 'CORRECT_REJECTION',
      ).length;
      return {
        modelId: model.id,
        scenarioId: scenario.id,
        expected: scenario.expected,
        planned: group.length,
        measured: measured.length,
        apiErrors: measured.length - answered.length,
        responseCount: answered.length,
        correctCount,
        statusCounts: Object.fromEntries(
          [...new Set(group.map((r) => String(r['status'])))].map((status) => [
            status,
            group.filter((r) => r['status'] === status).length,
          ]),
        ),
        responseAccuracy: answered.length ? correctCount / answered.length : null,
        endToEndSuccessRate: measured.length ? correctCount / measured.length : null,
        selectionCounts: counts,
        selectionStability:
          valid.length >= 2 ? Math.max(...Object.values(counts)) / valid.length : null,
      };
    }),
  );
  const supportedJobs = frozen.jobs.filter(
    (j) => study.scenarios.find((s) => s.id === j.scenarioId)!.expected === 'supported',
  ).length;
  const summaryOutput = {
    studyId: study.studyId,
    fingerprint: frozen.fingerprint,
    mode,
    plannedGenerations: frozen.jobs.length,
    recordedGenerations: records.size,
    maximumBenchmarkRuns: supportedJobs * benchmarkTiers.length * study.benchmark.repetitions,
    nominalBenchmarkHours:
      (supportedJobs *
        benchmarkTiers.length *
        study.benchmark.repetitions *
        (study.benchmark.warmupSeconds +
          study.benchmark.measureSeconds +
          study.benchmark.cooldownSeconds)) /
      3600,
    collectedRuns: runs.length,
    groups,
    limitations: [
      'Selection stability is modal share among valid responses; null with fewer than two valid responses.',
      'API errors are retained separately; generation repetitions are not benchmark repetitions.',
      'No automatic response repair or provider retry; --retry-errors appends a new API attempt.',
      'Raw provider usage is retained; API dollar costs are not estimated.',
      'Development cost catalog/score bounds are for pilot evidence, not publication.',
      'Request-volume tiers mean scheduled business operations in a 600-second window; raw HTTP requests are reported separately.',
      'Each passing sample must pass every hard gate; the aggregate suitable label requires at least 80% passing samples for that model/scenario/architecture/volume group.',
    ],
  };
  save('summary.json', summaryOutput);
  if (mode === 'collect') {
    const probes = existsSync(file('probes'))
      ? study.models.flatMap((model) =>
          existsSync(file('probes', `${model.id}.json`))
            ? [read<Record<string, unknown>>(`probes/${model.id}.json`)]
            : [],
        )
      : [];
    await apiJson(
      `/ai-batch/studies/${encodeURIComponent(study.studyId)}/snapshot`,
      { summary: summaryOutput, comparison: comparisonRows, probes },
      `ai-batch-results-${frozen.fingerprint}`,
    );
    console.log(`Published UI snapshot to ${api}`);
  }
  console.log(
    `Output: ${out}; generations ${records.size}/${frozen.jobs.length}; benchmark upper bound ${supportedJobs * benchmarkTiers.length * study.benchmark.repetitions} runs.`,
  );
} finally {
  rmdirSync(lock);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function markdownCell(value: unknown) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
