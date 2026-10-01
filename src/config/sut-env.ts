import { z } from 'zod';

/**
 * Environment config for SUT roles (sut-monolith, api-gateway, services).
 * Loaded only by SUT bootstrap functions, not by the evaluator.
 */
const sutEnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://bench:bench@localhost:5432/ecommerce'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ARCHITECTURE_ID: z
    .string()
    .regex(/^A\d{2}$/)
    .default('A01'),
  SUT_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Milliseconds before an outbound HTTP call to another service times out. */
  SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  /** DB connection pool size per SUT process. */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Comma-separated list of downstream monolith URLs for the API gateway to proxy to. */
  MONOLITH_URL: z.string().optional(),
  /** URL of the async notification mock service. */
  NOTIFICATION_URL: z.string().optional(),
  USER_URL: z.string().optional(),
  CATALOG_URL: z.string().optional(),
  ORDER_URL: z.string().optional(),
  PAYMENT_URL: z.string().optional(),
  INVENTORY_URL: z.string().optional(),
});

export type SutConfig = z.infer<typeof sutEnvSchema>;

export function loadSutConfig(source: NodeJS.ProcessEnv = process.env): SutConfig {
  const parsed = sutEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid SUT configuration: ${issues}`);
  }
  return parsed.data;
}
