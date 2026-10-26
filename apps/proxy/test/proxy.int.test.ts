import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { estimatePromptTokens } from '../src/estimate.js';
import { findPrice } from '../src/pricing/catalog.js';
import { worstCaseMicros } from '../src/pricing/cost.js';
import type { KeyLimits } from '../src/services/admin.js';
import { KeyStore } from '../src/services/keys.js';
import { REAL_ANTHROPIC_KEY, REAL_OPENAI_KEY, startMockProviders, type MockState } from './mockProviders.js';

const TEST_DB = process.env.TEST_DATABASE_URL_PROXY ?? 'postgres://postgres:postgres@localhost:5432/spendguard_test';
const TEST_REDIS = process.env.TEST_REDIS_URL_PROXY ?? 'redis://localhost:6379/2';
const HAIKU = 'claude-haiku-4-5';

const env = (over: Record<string, string> = {}) => ({
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DB,
  REDIS_URL: TEST_REDIS,
  ...over,
});

let mock: { url: string; state: MockState; app: FastifyInstance };
let app: FastifyInstance;
let deps: AppDeps;
let base: string;
let n = 0;

beforeAll(async () => {
  mock = await startMockProviders();
  ({ app, deps } = await buildApp({
    cfg: loadConfig(env({ ANTHROPIC_BASE_URL: mock.url, OPENAI_BASE_URL: mock.url })),
    logger: false,
  }));
  await deps.db.query('TRUNCATE users, projects, provider_credentials, api_keys, spend_counters, usage_events CASCADE');
  await deps.redis.flushdb();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await mock?.app.close();
});

/** A fresh customer: user, project with both provider keys stored, and one Spend Guard key. */
async function customer(limits: KeyLimits = {}, opts: { projectMonthlyMicros?: number; providers?: boolean } = {}) {
  n++;
  const userId = await deps.admin.upsertUser(`user${n}`);
  const projectId = await deps.admin.createProject(userId, `project ${n}`, opts.projectMonthlyMicros ?? null);
  if (opts.providers !== false) {
    await deps.admin.setProviderKey(projectId, 'anthropic', REAL_ANTHROPIC_KEY);
    await deps.admin.setProviderKey(projectId, 'openai', REAL_OPENAI_KEY);
  }
  const { id: keyId, key } = await deps.admin.createKey(projectId, `key ${n}`, limits);
  return {
    projectId,
    keyId,
    key,
    claude: new Anthropic({ apiKey: key, baseURL: `${base}/anthropic` }),
    gpt: new OpenAI({ apiKey: key, baseURL: `${base}/openai/v1` }),
  };
}

const events = async (keyId: string) =>
  (
    await deps.db.query(
      'SELECT status, block_reason, cost_micros, reserved_micros, input_tokens, output_tokens, cache_read_tokens FROM usage_events WHERE key_id = $1 ORDER BY created_at',
      [keyId],
    )
  ).rows;

const counter = async (keyId: string, period = 'day') =>
  (
    await deps.db.query<{ spent_micros: number; reserved_micros: number }>(
      "SELECT spent_micros, reserved_micros FROM spend_counters WHERE scope = 'key' AND scope_id = $1 AND period = $2",
      [keyId, period],
    )
  ).rows[0];

/** Streams settle just after the last byte reaches the client, so wait for that. */
const settledEvents = async (keyId: string, count = 1) => {
  await waitFor(async () => (await events(keyId)).filter((e) => e.status !== 'reserved').length >= count);
  return events(keyId);
};

const hi = (text = 'Hi') => ({ model: HAIKU, max_tokens: 100, messages: [{ role: 'user' as const, content: text }] });

/** What the proxy reserves for hi(text): used to set budgets that admit an exact number of requests. */
const reserveFor = (text = 'Hi') =>
  worstCaseMicros(findPrice('anthropic', HAIKU)!, estimatePromptTokens(hi(text)), 100, false);

const waitFor = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
};

describe('authentication', () => {
  it('rejects a request without a key, in Anthropic error format', async () => {
    const res = await fetch(`${base}/anthropic/v1/messages`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
  });

  it('refuses a raw provider key and explains what to use instead', async () => {
    const gpt = new OpenAI({
      apiKey: 'sk-proj-someone-pasted-their-real-key',
      baseURL: `${base}/openai/v1`,
      maxRetries: 0,
    });
    const err = await gpt.chat.completions
      .create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OpenAI.AuthenticationError);
    expect(err.message).toContain('not a Spend Guard key');
  });

  it('rejects unknown and revoked keys', async () => {
    const c = await customer();
    await deps.admin.setKeyStatus(c.keyId, 'revoked');
    const err = await c.claude.messages.create(hi()).catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.AuthenticationError);
  });

  it('stores provider keys encrypted, never in plaintext', async () => {
    const c = await customer();
    const { rows } = await deps.db.query<{ secret: Buffer; last4: string }>(
      'SELECT secret, last4 FROM provider_credentials WHERE project_id = $1',
      [c.projectId],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.secret.toString('latin1')).not.toContain('sk-');
      expect(['0001', '0002']).toContain(r.last4);
    }
  });

  it('answers when the project has no provider key saved', async () => {
    const c = await customer({}, { providers: false });
    const err = await c.claude.messages.create(hi()).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toContain('No Anthropic API key');
  });
});

describe('Anthropic Messages via the official SDK', () => {
  it('forwards with the real key and bills the exact cost from usage', async () => {
    const c = await customer();
    const { data: msg, response } = await c.claude.messages.create(hi()).withResponse();
    expect(msg.content[0]).toMatchObject({ type: 'text', text: 'Hello from mock Claude' });
    expect(mock.state.lastHeaders['x-api-key']).toBe(REAL_ANTHROPIC_KEY);
    // Haiku 4.5: 100 input × $1/M + 50 output × $5/M = $0.000350
    expect(response.headers.get('x-apg-cost-usd')).toBe('0.000350');
    expect(response.headers.get('request-id')).toBe('req_mock_1');
    expect(await settledEvents(c.keyId)).toMatchObject([
      { status: 'settled', cost_micros: 350, input_tokens: 100, output_tokens: 50 },
    ]);
    expect(await counter(c.keyId)).toEqual({ spent_micros: 350, reserved_micros: 0 });
  });

  it('streams events through unchanged and bills from the final usage', async () => {
    const c = await customer();
    const stream = c.claude.messages.stream(hi());
    let text = '';
    stream.on('text', (t) => (text += t));
    const final = await stream.finalMessage();
    expect(text).toBe('Hello from mock Claude');
    expect(final.usage.output_tokens).toBe(50);
    expect(await settledEvents(c.keyId)).toMatchObject([{ status: 'settled', cost_micros: 350 }]);
  });

  it('passes provider errors through untouched and bills nothing', async () => {
    const c = await customer();
    const err = await c.claude.messages.create(hi('MOCK:error')).catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
    expect(err.message).toContain('mock bad request');
    expect(await settledEvents(c.keyId)).toMatchObject([{ status: 'failed', cost_micros: 0 }]);
    expect(await counter(c.keyId)).toEqual({ spent_micros: 0, reserved_micros: 0 });
  });

  it('cancels the provider call when the client disconnects, and estimates what was streamed', async () => {
    const c = await customer();
    const before = mock.state.aborted;
    const stream = c.claude.messages.stream(hi('MOCK:slow'));
    let deltas = 0;
    await new Promise<void>((resolve) => {
      stream.on('text', () => {
        if (++deltas === 5) {
          stream.abort();
          resolve();
        }
      });
    });
    await stream.done().catch(() => undefined);
    await waitFor(async () => mock.state.aborted > before);
    await waitFor(async () => (await events(c.keyId))[0]?.status !== 'reserved');
    const [ev] = await events(c.keyId);
    expect(ev.status).toBe('estimated');
    // Input is known exactly from message_start; output is estimated from the text that was streamed.
    expect(ev.input_tokens).toBe(100);
    expect(ev.cost_micros).toBeGreaterThan(100);
    expect(ev.cost_micros).toBeLessThan(ev.reserved_micros);
    expect((await counter(c.keyId))!.reserved_micros).toBe(0);
  });
});

describe('OpenAI via the official SDK', () => {
  it('chat completions: bills cached prompt tokens at the cached rate', async () => {
    const c = await customer();
    const r = await c.gpt.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(r.choices[0]!.message.content).toBe('Hello from mock GPT');
    expect(mock.state.lastHeaders.authorization).toBe(`Bearer ${REAL_OPENAI_KEY}`);
    // gpt-4o-mini: 100 × $0.15/M + 20 cached × $0.075/M + 30 × $0.60/M = 34.5 micros, rounded up
    expect(await settledEvents(c.keyId)).toMatchObject([
      { status: 'settled', cost_micros: 35, input_tokens: 100, cache_read_tokens: 20 },
    ]);
  });

  it('chat streaming: asks the provider for usage, but hides that extra chunk from the client', async () => {
    const c = await customer();
    const stream = await c.gpt.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    let text = '';
    let emptyChunks = 0;
    for await (const chunk of stream) {
      if (chunk.choices.length === 0) emptyChunks++;
      text += chunk.choices[0]?.delta.content ?? '';
    }
    expect(text).toBe('Hello from mock GPT');
    expect(emptyChunks).toBe(0);
    expect(mock.state.lastBody).toMatchObject({ stream_options: { include_usage: true } });
    expect(await settledEvents(c.keyId)).toMatchObject([{ status: 'settled', cost_micros: 35 }]);
  });

  it('chat streaming: keeps the usage chunk when the client asked for it', async () => {
    const c = await customer();
    const stream = await c.gpt.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let usageSeen = false;
    for await (const chunk of stream) if (chunk.usage) usageSeen = true;
    expect(usageSeen).toBe(true);
  });

  it('responses API: plain and streaming', async () => {
    const c = await customer();
    const r = await c.gpt.responses.create({ model: 'gpt-4.1-mini', input: 'Hi' });
    expect(r.output_text).toBe('Hello from mock Responses');
    const stream = await c.gpt.responses.create({ model: 'gpt-4.1-mini', input: 'Hi again', stream: true });
    for await (const _ of stream) void _;
    // gpt-4.1-mini: 80 × $0.40/M + 40 × $1.60/M = 96 micros
    expect(await settledEvents(c.keyId, 2)).toMatchObject([
      { status: 'settled', cost_micros: 96 },
      { status: 'settled', cost_micros: 96 },
    ]);
  });

  it('refuses background responses, whose cost happens after the call returns', async () => {
    const c = await customer();
    const err = await c.gpt.responses.create({ model: 'gpt-4.1-mini', input: 'Hi', background: true }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(await settledEvents(c.keyId)).toMatchObject([{ status: 'blocked', block_reason: 'unsupported_feature' }]);
  });

  it('forwards free endpoints without billing', async () => {
    const c = await customer();
    const models = await c.gpt.models.list();
    expect(models.data[0]!.id).toBe('mock-model');
    expect(await events(c.keyId)).toEqual([]);
  });
});

describe('budgets', () => {
  it('blocks once the daily budget is used, and tells SDKs not to retry', async () => {
    // Room for two requests: each reserves its worst case, then settles at the real 350 micros.
    const c = await customer({ dailyBudgetMicros: 350 + 350 + reserveFor() - 1 });
    await c.claude.messages.create(hi());
    await c.claude.messages.create(hi('Hi there'));
    const callsBefore = mock.state.calls;
    const err = await c.claude.messages.create(hi('third')).catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
    expect(err.message).toContain('daily budget');
    expect(err.headers.get('x-apg-block-reason')).toBe('budget_exceeded');
    expect(mock.state.calls).toBe(callsBefore);
    // x-should-retry: false → the SDK gave up after one attempt instead of retrying twice.
    // Blocked requests are recorded just after the response goes out.
    const blocked = async () => (await events(c.keyId)).filter((e) => e.status === 'blocked');
    await waitFor(async () => (await blocked()).length > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(await blocked()).toHaveLength(1);
  });

  it('never overspends under concurrency: 12 parallel calls against room for exactly 5', async () => {
    const r = reserveFor('MOCK:delay');
    const c = await customer({ dailyBudgetMicros: r * 5, loopMaxRepeats: 100 });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => c.claude.messages.create(hi('MOCK:delay'), { maxRetries: 0 })),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(5);
    await settledEvents(c.keyId, 12);
    const total = await counter(c.keyId);
    expect(total).toEqual({ spent_micros: 5 * 350, reserved_micros: 0 });
  });

  it('applies the project budget across all of its keys', async () => {
    const c = await customer({}, { projectMonthlyMicros: 350 + reserveFor() - 1 });
    const second = await deps.admin.createKey(c.projectId, 'second agent');
    await c.claude.messages.create(hi());
    const other = new Anthropic({ apiKey: second.key, baseURL: `${base}/anthropic`, maxRetries: 0 });
    const err = await other.messages.create(hi()).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.message).toContain("project's monthly budget");
  });

  it('blocks a single request whose worst case exceeds the per-request limit', async () => {
    const c = await customer({ maxRequestMicros: 10_000 }); // $0.01
    const callsBefore = mock.state.calls;
    const err = await c.claude.messages.create({ ...hi(), max_tokens: 20_000 }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toContain('Lower max_tokens');
    expect(mock.state.calls).toBe(callsBefore);
    await c.claude.messages.create(hi()); // a small request still goes through
  });
});

describe('controls', () => {
  it('kill switch: a frozen key is refused immediately and works again once unfrozen', async () => {
    const c = await customer();
    await deps.admin.setKeyStatus(c.keyId, 'frozen');
    const err = await c.claude.messages.create(hi()).catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.PermissionDeniedError);
    await deps.admin.setKeyStatus(c.keyId, 'active');
    await expect(c.claude.messages.create(hi())).resolves.toBeTruthy();
  });

  it('enforces the allowed-models list', async () => {
    const c = await customer({ allowedModels: ['gpt-4o-mini'] });
    const err = await c.gpt.chat.completions
      .create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OpenAI.PermissionDeniedError);
    await expect(
      c.gpt.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }] }),
    ).resolves.toBeTruthy();
  });

  it('blocks models it cannot price, unless the project opts into worst-case pricing', async () => {
    const c = await customer();
    const err = await c.claude.messages.create({ ...hi(), model: 'claude-future-9' }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toContain('no price');
    await deps.admin.updateProject(c.projectId, { unknownModelPolicy: 'max_price' });
    await expect(c.claude.messages.create({ ...hi(), model: 'claude-future-9' })).resolves.toBeTruthy();
    const settled = (await settledEvents(c.keyId, 2)).find((e) => e.status === 'settled')!;
    // Priced as the most expensive Anthropic model in the catalog (Fable 5.1: $10/$50).
    expect(settled.cost_micros).toBe(100 * 10 + 50 * 50);
  });

  it('detects a runaway loop: the same request over and over', async () => {
    const c = await customer({ loopMaxRepeats: 3, loopWindowSec: 60 });
    for (let i = 0; i < 3; i++) await c.claude.messages.create(hi('stuck'));
    const err = await c.claude.messages.create(hi('stuck')).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.message).toContain('Runaway loop');
    await expect(c.claude.messages.create(hi('a different request'))).resolves.toBeTruthy();
  });

  it('enforces requests per minute', async () => {
    const c = await customer({ rpmLimit: 2 });
    await c.claude.messages.create(hi('one'));
    await c.claude.messages.create(hi('two'));
    const err = await c.claude.messages.create(hi('three'), { maxRetries: 0 }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.headers.get('retry-after')).toBe('60');
  });

  it('answers unsupported endpoints in the provider format', async () => {
    const c = await customer();
    const res = await fetch(`${base}/openai/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'endpoint_not_supported' } });
  });
});

describe('failure handling', () => {
  it('settles reservations orphaned by a crash at their worst case', async () => {
    const c = await customer();
    const reserved = await deps.budget.reserve({
      key: (await new KeyStore(deps.db, deps.vault).resolve(c.key, 'anthropic'))!,
      requestId: 'crashed-request',
      provider: 'anthropic',
      endpoint: '/v1/messages',
      model: HAIKU,
      stream: false,
      reserveMicros: 5_000,
    });
    expect(reserved.ok).toBe(true);
    await deps.db.query(
      "UPDATE usage_events SET created_at = now() - interval '1 hour' WHERE request_id = 'crashed-request'",
    );
    expect(await deps.budget.sweepStale(15)).toBeGreaterThanOrEqual(1);
    expect(await events(c.keyId)).toMatchObject([{ status: 'estimated', cost_micros: 5_000 }]);
    expect(await counter(c.keyId)).toEqual({ spent_micros: 5_000, reserved_micros: 0 });
  });

  it('returns 502 and bills nothing when the provider is unreachable', async () => {
    const { app: down } = await buildApp({
      cfg: loadConfig(env({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999', OPENAI_BASE_URL: 'http://127.0.0.1:59999' })),
      logger: false,
    });
    try {
      const c = await customer();
      const res = await down.inject({
        method: 'POST',
        url: '/anthropic/v1/messages',
        headers: { 'x-api-key': c.key, 'content-type': 'application/json' },
        payload: hi(),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ type: 'error', error: { type: 'api_error' } });
      expect(await events(c.keyId)).toMatchObject([{ status: 'failed', cost_micros: 0 }]);
      expect((await counter(c.keyId))!.reserved_micros).toBe(0);
    } finally {
      await down.close();
    }
  });

  it('keeps enforcing budgets when Redis is down (rate and loop limits pause)', async () => {
    const { app: noRedis } = await buildApp({
      cfg: loadConfig(env({ REDIS_URL: 'redis://127.0.0.1:1', ANTHROPIC_BASE_URL: mock.url })),
      logger: false,
    });
    try {
      const c = await customer({ dailyBudgetMicros: 350 + reserveFor() - 1, rpmLimit: 1 });
      const call = () =>
        noRedis.inject({
          method: 'POST',
          url: '/anthropic/v1/messages',
          headers: { 'x-api-key': c.key, 'content-type': 'application/json' },
          payload: hi(),
        });
      expect((await call()).statusCode).toBe(200);
      const second = await call();
      expect(second.statusCode).toBe(429);
      expect(second.headers['x-apg-block-reason']).toBe('budget_exceeded');
      const ready = await noRedis.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.redis).toContain('degraded');
    } finally {
      await noRedis.close();
    }
  });
});
