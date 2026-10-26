import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

// Local development only. Production refuses to start without real keys (see loadConfig).
const DEV_ENCRYPTION_KEYS = 'dev:ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzItYnl0ZXM=';

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(8090),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/spendguard'),
  DATABASE_SSL: bool,
  DATABASE_POOL_MAX: z.coerce.number().int().default(20),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /**
   * Master keys for the provider-key vault: comma-separated `id:base64(32 bytes)`.
   * The first one encrypts new secrets; the others can still decrypt (key rotation).
   */
  ENCRYPTION_KEYS: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com'),
  /** Long generations can take minutes; this is the ceiling for one upstream call. */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** Reservations older than this are assumed orphaned (crash) and settled at their worst case. */
  STALE_RESERVATION_MIN: z.coerce.number().int().positive().default(15),
  BODY_LIMIT_MB: z.coerce.number().int().positive().default(32),
  /** When set, /metrics requires `Authorization: Bearer <token>`: it reveals spend by model. */
  METRICS_TOKEN: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof EnvSchema> & { encryptionKeys: Map<string, Buffer>; activeKeyId: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.message}`);
  const cfg = parsed.data;

  if (cfg.NODE_ENV === 'production' && !cfg.ENCRYPTION_KEYS) {
    throw new Error('ENCRYPTION_KEYS must be set in production');
  }
  const keys = parseKeys(cfg.ENCRYPTION_KEYS || DEV_ENCRYPTION_KEYS);
  if (cfg.NODE_ENV === 'production' && keys.has('dev')) {
    throw new Error('The development encryption key must not be used in production');
  }
  return { ...cfg, encryptionKeys: keys, activeKeyId: [...keys.keys()][0]! };
}

function parseKeys(raw: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const part of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [id, b64] = part.split(':');
    if (!id || !b64) throw new Error('ENCRYPTION_KEYS entries must look like id:base64');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes (got ${key.length})`);
    keys.set(id, key);
  }
  if (keys.size === 0) throw new Error('ENCRYPTION_KEYS is empty');
  return keys;
}
