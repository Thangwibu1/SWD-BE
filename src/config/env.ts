import { z } from 'zod';

export const APP_ROLES = [
  'controller-api',
  'experiment-worker',
  'sut-monolith',
  'api-gateway',
  'user-service',
  'catalog-service',
  'inventory-service',
  'order-service',
  'payment-mock',
  'notification-mock',
  'event-worker',
] as const;

export type AppRole = (typeof APP_ROLES)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ROLE: z.enum(APP_ROLES).default('controller-api'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  EVALUATOR_DB_PATH: z.string().default('./data/evaluator.db'),
  RESULTS_ROOT: z.string().default('./results'),
  ARCHITECTURE_REGISTRY_DIR: z.string().default('./architecture-registry'),
  COST_CATALOG_DIR: z.string().default('./cost-catalogs'),
  DOCKER_BIN: z.string().default('docker'),
  DOCKER_PROJECT_PREFIX: z.literal('bench').default('bench'),
  SUT_HOST: z.string().default('127.0.0.1'),
  SUT_PORT_RANGE_START: z.coerce.number().int().default(20000),
  SUT_PORT_RANGE_END: z.coerce.number().int().default(21000),
  MAX_CONCURRENT_EXPERIMENTS: z.coerce.number().int().min(1).max(1).default(1),
  EXPERIMENT_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  LOAD_RUNNER_MODE: z.enum(['local', 'ssh']).default('local'),
  K6_BIN: z.string().default('k6'),
  LOAD_HOST_SSH: z.string().default(''),
  LOAD_HOST_WORKDIR: z.string().default('/opt/architecture-benchmark'),
  PROMETHEUS_URL: z.string().default('http://127.0.0.1:9090'),
  CADVISOR_URL: z.string().default('http://127.0.0.1:8080'),
  DEFAULT_WARMUP_SECONDS: z.coerce.number().int().nonnegative().default(120),
  DEFAULT_MEASURE_SECONDS: z.coerce.number().int().positive().default(600),
  DEFAULT_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),
  DEFAULT_REPETITIONS: z.coerce.number().int().positive().default(5),
  EVENTUAL_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Parse process environment once. Throws with a readable message so a
 * misconfigured role fails fast at boot instead of mid-experiment.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (parsed.data.SUT_PORT_RANGE_START >= parsed.data.SUT_PORT_RANGE_END) {
    throw new Error('SUT_PORT_RANGE_START must be lower than SUT_PORT_RANGE_END');
  }
  return parsed.data;
}
