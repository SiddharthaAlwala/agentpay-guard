import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import { Redis } from 'ioredis';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { createPool, type Db } from './db.js';
import {
  CreateAgentSchema,
  HttpError,
  PaymentRequestSchema,
  PaymentStatus,
  PolicyUpdateSchema,
  type Agent,
} from './domain.js';
import { registry } from './metrics.js';
import { createClaudeClassifier, type InjectionClassifier } from './policy/llmClassifier.js';
import { AgentService } from './services/agents.js';
import { EventBus, type GuardEvent } from './services/events.js';
import { PaymentService, toApi } from './services/payments.js';
import { VelocityTracker } from './services/velocity.js';
import { DemoRunner, SCENARIOS, type ScenarioName } from './demo/scenarios.js';
import { seedDemo } from './demo/seed.js';
import { migrate } from './migrate.js';

declare module 'fastify' {
  interface FastifyRequest {
    agent?: Agent;
  }
}

export interface AppDeps {
  db: Db;
  redis: Redis | null;
  redisSub: Redis | null;
  agents: AgentService;
  payments: PaymentService;
  velocity: VelocityTracker;
  events: EventBus;
  demo: DemoRunner;
}

export interface BuildOptions {
  cfg: Config;
  /** Inject for tests. */
  classifier?: InjectionClassifier | null;
  logger?: boolean;
}

function connectRedis(url: string): Redis {
  const r = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  r.on('error', () => undefined); // status is checked before use; failures fall back gracefully
  return r;
}

const docSchema = (schema: z.ZodType) => {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
};

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; deps: AppDeps }> {
  const { cfg } = opts;
  const db = createPool(cfg);
  await migrate(db, () => undefined);

  const redis = connectRedis(cfg.REDIS_URL);
  const redisSub = connectRedis(cfg.REDIS_URL);
  await Promise.race([
    Promise.all([once(redis, 'ready'), once(redisSub, 'ready')]),
    new Promise((r) => setTimeout(r, 2000)),
  ]);

  const events = new EventBus(redis, redisSub);
  const velocity = new VelocityTracker(redis);
  const agents = new AgentService(db, events);
  const classifier = opts.classifier === undefined ? createClaudeClassifier(cfg) : opts.classifier;
  const payments = new PaymentService(db, agents, velocity, events, classifier);
  const demo = new DemoRunner({ db, agents, payments, velocity, events });
  const deps: AppDeps = { db, redis, redisSub, agents, payments, velocity, events, demo };

  if (cfg.DEMO_MODE) await seedDemo(agents);

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: cfg.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers["x-admin-token"]'],
            // Human-readable, colored logs in local development; JSON everywhere else (for log tooling).
            transport:
              cfg.NODE_ENV === 'development' && process.stdout.isTTY
                ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
                : undefined,
          },
    trustProxy: true,
    genReqId: (req) => (req.headers['x-request-id'] as string) || crypto.randomUUID(),
  });

  payments.log = app.log.child({ component: 'payments' });

  // Zod is the validator; JSON schemas on routes are for OpenAPI docs only.
  app.setValidatorCompiler(() => () => true);

  await app.register(cors, { origin: cfg.CORS_ORIGIN === '*' ? true : cfg.CORS_ORIGIN.split(',') });
  await app.register(rateLimit, {
    max: cfg.RATE_LIMIT_PER_MIN,
    timeWindow: '1 minute',
    // Limit per agent key so one runaway agent cannot starve the others sharing an IP.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? `key:${createHash('sha256').update(auth).digest('hex').slice(0, 16)}` : `ip:${req.ip}`;
    },
    redis: redis.status === 'ready' ? redis : undefined,
    skipOnError: true,
    allowList: (req) => req.url.startsWith('/healthz') || req.url.startsWith('/metrics'),
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AgentPay Guard API',
        version: '1.0.0',
        description:
          'A spending firewall for AI agents. Agents call `POST /v1/payments`; the guard approves, blocks, or holds each request for a human.',
      },
      components: {
        securitySchemes: {
          agentKey: { type: 'http', scheme: 'bearer', description: 'Agent API key (apg_...)' },
          adminToken: { type: 'apiKey', in: 'header', name: 'x-admin-token' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation_failed',
        message: 'Request validation failed',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong', requestId: req.id });
  });

  // ---------- auth ----------
  const agentAuth = async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!key) throw new HttpError(401, 'missing_api_key', 'Send the agent API key as "Authorization: Bearer apg_..."');
    const agent = await agents.findByApiKey(key);
    if (!agent) throw new HttpError(401, 'invalid_api_key', 'Unknown agent API key');
    req.agent = agent;
  };

  const adminAuth = async (req: FastifyRequest) => {
    if (cfg.DEMO_MODE) return;
    const token =
      (req.headers['x-admin-token'] as string | undefined) ?? (req.query as { token?: string })?.token ?? '';
    const a = Buffer.from(token);
    const b = Buffer.from(cfg.ADMIN_TOKEN);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpError(401, 'unauthorized', 'Valid x-admin-token header required');
    }
  };

  const actor = (req: FastifyRequest) => (req.headers['x-actor'] as string | undefined)?.slice(0, 64) || 'admin';
  const idParam = z.object({ id: z.uuid() });

  // ---------- health & ops ----------
  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await db.query('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'down';
    }
    checks.redis = redis.status === 'ready' ? 'ok' : 'degraded (falling back to Postgres)';
    const ready = checks.postgres === 'ok';
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => {
    const pending = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM payment_requests WHERE status = 'pending_approval'",
    );
    reply.header('content-type', registry.contentType);
    return `${await registry.metrics()}\n# HELP agentpay_pending_approvals Payments waiting for a human\n# TYPE agentpay_pending_approvals gauge\nagentpay_pending_approvals ${pending.rows[0]?.n ?? 0}\n`;
  });
  app.get('/v1/config', { schema: { tags: ['meta'], summary: 'Public runtime configuration' } }, async () => ({
    demoMode: cfg.DEMO_MODE,
    llmClassifier: Boolean(classifier),
    repoUrl: cfg.REPO_URL ?? null,
    version: '1.0.0',
  }));

  // ---------- agent API ----------
  app.post(
    '/v1/payments',
    {
      preHandler: agentAuth,
      schema: {
        tags: ['agent'],
        summary: 'Request a payment',
        description:
          "Evaluates the request against the agent's policy. Requires an `Idempotency-Key` header: retries with the same key return the original decision and never pay twice.",
        security: [{ agentKey: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string' } },
          required: ['idempotency-key'],
        },
        body: docSchema(PaymentRequestSchema),
      },
    },
    async (req, reply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length === 0 || key.length > 255) {
        throw new HttpError(400, 'missing_idempotency_key', 'Idempotency-Key header (1-255 chars) is required');
      }
      const input = PaymentRequestSchema.parse(req.body);
      const { payment, replay } = await payments.create(req.agent!, input, key);
      reply.header('idempotent-replay', String(replay));
      return reply.status(replay ? 200 : 201).send({ ...toApi(payment), replay });
    },
  );

  app.get(
    '/v1/payments/:id',
    {
      preHandler: agentAuth,
      schema: { tags: ['agent'], summary: 'Get a payment decision', security: [{ agentKey: [] }] },
    },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const p = await payments.get(id);
      if (p.agent_id !== req.agent!.id) throw new HttpError(404, 'payment_not_found', 'Payment not found');
      return toApi(p);
    },
  );

  app.get(
    '/v1/budget',
    {
      preHandler: agentAuth,
      schema: { tags: ['agent'], summary: 'Remaining budget for the calling agent', security: [{ agentKey: [] }] },
    },
    async (req) => {
      const agent = req.agent!;
      const policy = await agents.policy(db, agent.id);
      const spend = await payments.committedSpend(db, agent.id);
      return {
        agent: { id: agent.id, name: agent.name, status: agent.status },
        currency: policy.currency,
        perTransactionLimitCents: policy.per_tx_limit_cents,
        approvalThresholdCents: policy.approval_threshold_cents,
        daily: {
          limitCents: policy.daily_limit_cents,
          committedCents: spend.today,
          remainingCents: Math.max(0, policy.daily_limit_cents - spend.today),
        },
        monthly: {
          limitCents: policy.monthly_limit_cents,
          committedCents: spend.month,
          remainingCents: Math.max(0, policy.monthly_limit_cents - spend.month),
        },
        allowedCategories: policy.allowed_categories,
        blockedCategories: policy.blocked_categories,
      };
    },
  );

  // ---------- admin API ----------
  const admin = { preHandler: adminAuth };
  const adminSchema = (summary: string, extra: Record<string, unknown> = {}) => ({
    tags: ['admin'],
    summary,
    security: [{ adminToken: [] }],
    ...extra,
  });

  app.get(
    '/v1/admin/agents',
    { ...admin, schema: adminSchema("List agents with policy and today's spend") },
    async () => agents.list(),
  );

  app.post(
    '/v1/admin/agents',
    {
      ...admin,
      schema: adminSchema('Create an agent (returns its API key once)', { body: docSchema(CreateAgentSchema) }),
    },
    async (req, reply) => {
      const input = CreateAgentSchema.parse(req.body);
      const { agent, apiKey } = await agents.create(input, actor(req));
      return reply.status(201).send({ agent, apiKey, note: 'Store this key now. It cannot be shown again.' });
    },
  );

  app.get('/v1/admin/agents/:id', { ...admin, schema: adminSchema('Get an agent and its policy') }, async (req) => {
    const { id } = idParam.parse(req.params);
    return agents.get(id);
  });

  app.patch(
    '/v1/admin/agents/:id/policy',
    { ...admin, schema: adminSchema("Update an agent's policy (versioned)", { body: docSchema(PolicyUpdateSchema) }) },
    async (req) => {
      const { id } = idParam.parse(req.params);
      return agents.updatePolicy(id, PolicyUpdateSchema.parse(req.body), actor(req));
    },
  );

  app.post(
    '/v1/admin/agents/:id/freeze',
    { ...admin, schema: adminSchema('Kill switch: freeze an agent') },
    async (req) => {
      const { id } = idParam.parse(req.params);
      return agents.setStatus(id, 'frozen', actor(req));
    },
  );

  app.post('/v1/admin/agents/:id/unfreeze', { ...admin, schema: adminSchema('Unfreeze an agent') }, async (req) => {
    const { id } = idParam.parse(req.params);
    return agents.setStatus(id, 'active', actor(req));
  });

  app.get('/v1/admin/payments', { ...admin, schema: adminSchema('List payment decisions') }, async (req) => {
    const q = z
      .object({
        status: z.enum(PaymentStatus).optional(),
        agentId: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    return payments.list(q);
  });

  const reviewBody = z.object({ note: z.string().max(500).optional() }).default({});
  app.post(
    '/v1/admin/payments/:id/approve',
    { ...admin, schema: adminSchema('Approve a pending payment') },
    async (req) => {
      const { id } = idParam.parse(req.params);
      return toApi(await payments.review(id, 'approve', actor(req), reviewBody.parse(req.body ?? {}).note));
    },
  );

  app.post(
    '/v1/admin/payments/:id/reject',
    { ...admin, schema: adminSchema('Reject a pending payment') },
    async (req) => {
      const { id } = idParam.parse(req.params);
      return toApi(await payments.review(id, 'reject', actor(req), reviewBody.parse(req.body ?? {}).note));
    },
  );

  app.get(
    '/v1/admin/ledger/integrity',
    { ...admin, schema: adminSchema('Prove the double-entry ledger balances and reconciles') },
    async () => payments.ledgerIntegrity(),
  );

  app.get('/v1/admin/stats', { ...admin, schema: adminSchema('Decision statistics') }, async () => payments.stats());

  app.get('/v1/admin/audit', { ...admin, schema: adminSchema('Append-only audit trail') }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const { rows } = await db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
    return rows;
  });

  app.get(
    '/v1/admin/events',
    { ...admin, schema: adminSchema('Server-sent events stream of decisions') },
    (req, reply) => {
      streamEvents(req, reply, events);
    },
  );

  // ---------- demo ----------
  if (cfg.DEMO_MODE) {
    app.get('/v1/demo/scenarios', { schema: { tags: ['demo'], summary: 'List attack scenarios' } }, async () =>
      Object.entries(SCENARIOS).map(([id, s]) => ({ id, ...s })),
    );
    app.post(
      '/v1/demo/scenarios/:name',
      {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        schema: { tags: ['demo'], summary: 'Run an attack scenario' },
      },
      async (req) => {
        const { name } = z
          .object({ name: z.enum(Object.keys(SCENARIOS) as [ScenarioName, ...ScenarioName[]]) })
          .parse(req.params);
        return demo.run(name);
      },
    );
    app.post(
      '/v1/demo/reset',
      {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { tags: ['demo'], summary: 'Reset demo data' },
      },
      async () => {
        await demo.reset();
        return { status: 'reset' };
      },
    );
  }

  // ---------- dashboard (single-page app) ----------
  const staticDir = cfg.STATIC_DIR ? path.resolve(cfg.STATIC_DIR) : undefined;
  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((req, reply) => {
      const apiPath = /^\/(v1|docs|metrics|healthz|readyz)(\/|$)/.test(req.url);
      const isFile = /\.[a-z0-9]+$/i.test(req.url.split('?')[0] ?? '');
      if (req.method === 'GET' && !apiPath && !isFile) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'not_found', message: `${req.method} ${req.url} not found` });
    });
  }

  app.addHook('onClose', async () => {
    redis.disconnect();
    redisSub.disconnect();
    await db.end();
  });

  return { app, deps };
}

function streamEvents(req: FastifyRequest, reply: FastifyReply, events: EventBus) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  });
  res.write(`event: hello\ndata: {}\n\n`);
  const send = (e: GuardEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const unsubscribe = events.subscribe(send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function once(emitter: Redis, event: string) {
  return new Promise<void>((resolve) => {
    if (emitter.status === 'ready') return resolve();
    emitter.once(event, () => resolve());
  });
}
