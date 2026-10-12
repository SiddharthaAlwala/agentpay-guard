import { once } from 'node:events';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import type { Config } from './config.js';
import { Vault } from './crypto.js';
import { createPool, type Db } from './db.js';
import { degraded, registry } from './metrics.js';
import { migrate } from './migrate.js';
import { anthropic } from './providers/anthropic.js';
import { openai } from './providers/openai.js';
import { registerProxyRoutes } from './proxy.js';
import { AdminService } from './services/admin.js';
import { BudgetService } from './services/budget.js';
import { KeyStore } from './services/keys.js';
import { LimitService } from './services/limits.js';

export interface AppDeps {
  db: Db;
  redis: Redis;
  vault: Vault;
  budget: BudgetService;
  admin: AdminService;
}

export async function buildApp(opts: {
  cfg: Config;
  logger?: boolean;
}): Promise<{ app: FastifyInstance; deps: AppDeps }> {
  const { cfg } = opts;
  const db = createPool(cfg);
  await migrate(db, () => undefined);

  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on('error', () => undefined); // status is checked before each use; limits fail open
  // Wait briefly for Redis, but start without it: it only backs the rate and loop limits.
  await Promise.race([once(redis, 'ready').catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);

  const vault = new Vault(cfg.encryptionKeys, cfg.activeKeyId);
  const budget = new BudgetService(db);
  const admin = new AdminService(db, vault);

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: cfg.LOG_LEVEL,
            // Keys must never reach the logs, even if someone turns on header logging later.
            redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
            ...(cfg.NODE_ENV === 'development' && process.stdout.isTTY
              ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
              : {}),
          },
    // One summary line per request is logged by the proxy itself, with cost and outcome.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    },
  });
  db.removeAllListeners('error');
  db.on('error', (err) => {
    degraded.inc({ component: 'postgres' });
    app.log.warn({ err: err.message }, 'idle database connection lost');
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await db.query('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'down';
    }
    checks.redis = redis.status === 'ready' ? 'ok' : 'degraded (rate and loop limits paused; budgets still enforced)';
    const ready = checks.postgres === 'ok';
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
  app.get('/metrics', async (req, reply) => {
    if (cfg.METRICS_TOKEN && req.headers.authorization !== `Bearer ${cfg.METRICS_TOKEN}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
  app.get('/', async () => ({
    name: 'AgentPay Spend Guard',
    docs: 'Point your OpenAI or Anthropic SDK base URL at /openai/v1 or /anthropic and use your apg_live_ key.',
  }));

  const background = new Set<Promise<unknown>>();
  registerProxyRoutes(app, {
    cfg,
    keys: new KeyStore(db, vault),
    budget,
    limits: new LimitService(redis, (err) => {
      degraded.inc({ component: 'redis' });
      app.log.warn({ err }, 'redis limit check failed; continuing without rate and loop limits');
    }),
    adapters: [anthropic, openai],
    background,
  });

  app.addHook('onClose', async () => {
    await Promise.allSettled([...background]);
    redis.disconnect();
    await db.end();
  });

  return { app, deps: { db, redis, vault, budget, admin } };
}
