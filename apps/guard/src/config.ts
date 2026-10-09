import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/agentpay'),
  DATABASE_SSL: bool,
  DATABASE_POOL_MAX: z.coerce.number().int().default(20),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ADMIN_TOKEN: z.string().min(8).default('change-me-admin-token'),
  /** Public demo: opens the dashboard's admin actions and enables attack scenarios. Never use with real money. */
  DEMO_MODE: bool,
  PENDING_APPROVAL_TTL_MIN: z.coerce.number().int().default(30),
  /** Optional second-opinion classifier for prompt injection, using Claude. */
  LLM_CLASSIFIER: bool,
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-5-5'),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(3000),
  /** Requests per minute per agent key (or per IP for unauthenticated calls). */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(600),
  /** Shown as the dashboard's "Source" link. */
  REPO_URL: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  CORS_ORIGIN: z.string().default('*'),
  STATIC_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && !cfg.DEMO_MODE && cfg.ADMIN_TOKEN === 'change-me-admin-token') {
    throw new Error('ADMIN_TOKEN must be set in production');
  }
  return cfg;
}
