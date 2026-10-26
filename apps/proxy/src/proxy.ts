import type { ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { looksLikeOurKey } from './crypto.js';
import { estimatePromptTokens } from './estimate.js';
import * as metrics from './metrics.js';
import { findPrice, maxPrice, type ModelPrice } from './pricing/catalog.js';
import { costMicros, formatUsd, worstCaseMicros, type Usage } from './pricing/cost.js';
import { ERROR_STATUS, type ErrorKind, type ProviderAdapter } from './providers/types.js';
import type { BudgetScope, BudgetService, SettleInput } from './services/budget.js';
import type { KeyContext, KeyStore } from './services/keys.js';
import type { LimitService } from './services/limits.js';
import { SseParser } from './sse.js';

export interface ProxyDeps {
  cfg: Config;
  keys: KeyStore;
  budget: BudgetService;
  limits: LimitService;
  adapters: ProviderAdapter[];
  /** Bookkeeping that runs after the response is sent; awaited on shutdown so none is lost. */
  background: Set<Promise<unknown>>;
}

/** Provider response headers worth passing on (request ids for support tickets, rate-limit info). */
const PASS_HEADERS =
  /^(request-id|x-request-id|retry-after|anthropic-ratelimit-.*|x-ratelimit-.*|openai-processing-ms|openai-version)$/i;

const SCOPE_LABEL: Record<BudgetScope, string> = {
  key_daily: "This key's daily",
  key_monthly: "This key's monthly",
  project_monthly: "This project's monthly",
};

/** Connection failures where the request provably never reached the provider, so nothing was billed. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export function registerProxyRoutes(app: FastifyInstance, deps: ProxyDeps) {
  for (const adapter of deps.adapters) {
    const base = adapter.provider === 'anthropic' ? deps.cfg.ANTHROPIC_BASE_URL : deps.cfg.OPENAI_BASE_URL;
    for (const [path, endpoint] of Object.entries(adapter.endpoints)) {
      app.route({
        method: endpoint.method,
        url: `/${adapter.provider}${path}`,
        bodyLimit: deps.cfg.BODY_LIMIT_MB * 1024 * 1024,
        handler: (req, reply) =>
          new ProxyRequest(deps, adapter, base.replace(/\/$/, ''), path, endpoint.metered, req, reply).run(),
      });
    }
    // Anything else under the provider prefix gets a clear answer in the provider's own format.
    app.all(`/${adapter.provider}/*`, async (req, reply) =>
      reply
        .code(404)
        .send(
          adapter.errorBody(
            'not_found',
            `${req.method} ${req.url.replace(`/${adapter.provider}`, '')} is not supported by Spend Guard. Supported: ${Object.keys(adapter.endpoints).join(', ')}`,
            'endpoint_not_supported',
          ),
        ),
    );
  }
}

/** One proxied call, from authentication to settlement. */
class ProxyRequest {
  private readonly started = performance.now();
  private log: FastifyBaseLogger;
  private key: KeyContext | null = null;
  private model = '';
  private stream = false;

  constructor(
    private deps: ProxyDeps,
    private adapter: ProviderAdapter,
    private baseUrl: string,
    private path: string,
    private metered: boolean,
    private req: FastifyRequest,
    private reply: FastifyReply,
  ) {
    this.log = req.log.child({ provider: adapter.provider, endpoint: path });
  }

  async run() {
    // 1. Authenticate: the caller must present one of our keys, never a raw provider key.
    const presented = this.adapter.extractKey(this.req.headers);
    if (!presented) {
      return this.fail(
        'authentication',
        'Missing API key. Use your Spend Guard key (apg_live_...).',
        'missing_api_key',
      );
    }
    if (!looksLikeOurKey(presented)) {
      return this.fail(
        'authentication',
        `That is not a Spend Guard key. Give your ${this.adapter.displayName} key to Spend Guard once, then use the apg_live_... key it issues.`,
        'invalid_api_key',
      );
    }
    try {
      this.key = await this.deps.keys.resolve(presented, this.adapter.provider);
    } catch (err) {
      return this.unavailable(err);
    }
    const key = this.key;
    if (!key || key.status === 'revoked') {
      return this.fail('authentication', 'Invalid or revoked Spend Guard key.', 'invalid_api_key');
    }
    this.log = this.log.child({ keyId: key.keyId, projectId: key.projectId });
    if (key.status === 'frozen') {
      return this.block(
        'permission',
        'This key is frozen (kill switch). Unfreeze it in Spend Guard to continue.',
        'key_frozen',
      );
    }
    if (!key.providerKey) {
      return this.fail(
        'invalid_request',
        `No ${this.adapter.displayName} API key is saved for this project. Add one in Spend Guard first.`,
        'provider_key_missing',
      );
    }
    if (!this.metered) return this.forwardUnmetered(key.providerKey);

    // 2. Understand the request.
    const body = this.req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return this.fail('invalid_request', 'Request body must be a JSON object.', 'invalid_body');
    }
    const json = body as Record<string, unknown>;
    const info = this.adapter.inspect(this.path, json);
    this.model = info.model;
    this.stream = info.stream;
    if (!info.model) return this.fail('invalid_request', '"model" is required.', 'model_required');
    if (info.unsupported) return this.block('invalid_request', info.unsupported, 'unsupported_feature');

    // 3. Policy checks that need no counting.
    if (key.allowedModels && !key.allowedModels.includes(info.model)) {
      return this.block(
        'permission',
        `Model "${info.model}" is not allowed for this key. Allowed: ${key.allowedModels.join(', ')}.`,
        'model_not_allowed',
      );
    }
    let price: ModelPrice | undefined = findPrice(this.adapter.provider, info.model);
    if (!price) {
      if (key.unknownModelPolicy === 'block') {
        return this.block(
          'invalid_request',
          `Spend Guard has no price for "${info.model}" yet, so it cannot enforce your budget and blocked the call. Use a listed model, or allow unknown models (priced as the most expensive model) in project settings.`,
          'unknown_model',
        );
      }
      price = maxPrice(this.adapter.provider, info.model);
    }

    // 4. Rate and loop limits (Redis).
    const limit = await this.deps.limits.check(key.keyId, this.req.id, json, key);
    if (!limit.ok) {
      return limit.reason === 'loop'
        ? this.block(
            'rate_limit',
            `Runaway loop suspected: this exact request was sent ${limit.count} times in ${key.loopWindowSec}s. Blocked to protect your budget.`,
            'loop_detected',
            { 'x-should-retry': 'false' },
          )
        : this.block(
            'rate_limit',
            `Rate limit of ${key.rpmLimit} requests per minute reached for this key.`,
            'rate_limited',
            {
              'retry-after': String(limit.retryAfterSec),
            },
          );
    }

    // 5. Worst-case cost, then reserve it against every budget that applies.
    const promptTokens = estimatePromptTokens(json);
    const maxOutput = (info.maxOutputTokens ?? price.maxOutputTokens) * info.outputMultiplier;
    const reserveMicros = worstCaseMicros(price, promptTokens, maxOutput, info.mayWriteCache);
    if (key.maxRequestMicros !== null && reserveMicros > key.maxRequestMicros) {
      return this.block(
        'invalid_request',
        `This request could cost up to ${formatUsd(reserveMicros)} (~${promptTokens} prompt + ${maxOutput} output tokens), above this key's per-request limit of ${formatUsd(key.maxRequestMicros)}. Lower max_tokens or raise the limit.`,
        'request_cost_limit',
      );
    }
    let eventId: string;
    try {
      const r = await this.deps.budget.reserve({
        key,
        requestId: this.req.id,
        provider: this.adapter.provider,
        endpoint: this.path,
        model: info.model,
        stream: info.stream,
        reserveMicros,
      });
      if (!r.ok) {
        return this.block(
          'budget',
          `${SCOPE_LABEL[r.scope]} budget of ${formatUsd(r.limitMicros)} is used up (${formatUsd(r.committedMicros)} spent or in flight; this request needs up to ${formatUsd(reserveMicros)}).`,
          'budget_exceeded',
          // SDKs retry 429s automatically; a spent budget won't recover in seconds, so tell them not to.
          { 'x-should-retry': 'false' },
        );
      }
      eventId = r.eventId;
    } catch (err) {
      return this.unavailable(err);
    }

    // 6. Forward, then settle the real cost.
    const prepared = this.adapter.prepareBody(this.path, json, info);
    metrics.overhead.observe((performance.now() - this.started) / 1000);
    return this.forwardMetered(key.providerKey, prepared, price, promptTokens, eventId, reserveMicros);
  }

  private async forwardMetered(
    providerKey: string,
    prepared: { body: Record<string, unknown>; injectedUsage: boolean },
    price: ModelPrice,
    promptTokens: number,
    eventId: string,
    reserveMicros: number,
  ) {
    const clientGone = new AbortController();
    // If the caller hangs up we cancel the provider call too, so they stop paying for tokens nobody reads.
    this.reply.raw.on('close', () => {
      if (!this.reply.raw.writableFinished) clientGone.abort(new Error('client disconnected'));
    });
    const upstreamStart = performance.now();
    const settle = (s: Omit<SettleInput, 'latencyMs' | 'httpStatus'> & { httpStatus?: number }, outcome: string) => {
      metrics.upstreamLatency.observe({ provider: this.adapter.provider }, (performance.now() - upstreamStart) / 1000);
      return this.settle(eventId, { ...s, httpStatus: s.httpStatus ?? 0, latencyMs: this.elapsed() }, outcome);
    };

    let upstream: Response;
    try {
      upstream = await fetch(this.baseUrl + this.path, {
        method: 'POST',
        headers: this.adapter.upstreamHeaders(this.req.headers, providerKey),
        body: JSON.stringify(prepared.body),
        signal: AbortSignal.any([clientGone.signal, AbortSignal.timeout(this.deps.cfg.UPSTREAM_TIMEOUT_MS)]),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code ?? '';
      // Never reached the provider: nothing billed. Otherwise we can't know, so charge the worst case.
      await (NEVER_SENT.has(code)
        ? settle({ status: 'failed', costMicros: 0, usage: null, httpStatus: 502 }, 'upstream_unreachable')
        : settle({ status: 'estimated', costMicros: reserveMicros, usage: null, httpStatus: 502 }, 'upstream_aborted'));
      if (clientGone.signal.aborted) return this.reply;
      return this.fail(
        'upstream',
        `Could not reach ${this.adapter.displayName}: ${(err as Error).message}`,
        'upstream_unreachable',
      );
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    if (upstream.ok && contentType.includes('text/event-stream')) {
      return this.pipeStream(upstream, prepared.injectedUsage, price, promptTokens, settle);
    }

    let text: string;
    try {
      text = await upstream.text();
    } catch {
      await settle(
        { status: 'estimated', costMicros: reserveMicros, usage: null, httpStatus: upstream.status },
        'body_aborted',
      );
      return this.reply;
    }
    // The cost is known now; writing it down happens after the response is on its way, so the
    // database round trip is not added to the caller's latency. The reservation keeps the budget
    // safe in the meantime.
    let costMicrosValue = 0;
    if (upstream.ok) {
      const usage = parseUsage(() => this.adapter.usageFromJson(this.path, JSON.parse(text)));
      costMicrosValue = usage ? costMicros(price, usage) : reserveMicros;
      void settle(
        { status: usage ? 'settled' : 'estimated', costMicros: costMicrosValue, usage, httpStatus: upstream.status },
        usage ? 'settled' : 'estimated',
      );
    } else {
      // Providers don't bill requests they reject.
      void settle({ status: 'failed', costMicros: 0, usage: null, httpStatus: upstream.status }, 'upstream_error');
    }
    return this.reply
      .code(upstream.status)
      .headers(this.passHeaders(upstream.headers))
      .header('x-apg-cost-usd', (costMicrosValue / 1_000_000).toFixed(6))
      .type(contentType)
      .send(text);
  }

  /**
   * Streams events to the client as they arrive while reading usage from them. Events are passed
   * through byte-for-byte; the only exception is the usage chunk we requested on the client's behalf.
   */
  private async pipeStream(
    upstream: Response,
    injectedUsage: boolean,
    price: ModelPrice,
    promptTokens: number,
    settle: (
      s: Omit<SettleInput, 'latencyMs' | 'httpStatus'> & { httpStatus?: number },
      outcome: string,
    ) => Promise<void>,
  ) {
    this.reply.hijack();
    const res = this.reply.raw;
    res.writeHead(upstream.status, {
      ...this.passHeaders(upstream.headers),
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
      'x-apg-request-id': this.req.id,
    });
    const tracker = this.adapter.streamTracker(this.path, injectedUsage);
    const parser = new SseParser();
    let interrupted = false;
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        for (const ev of parser.push(chunk)) {
          if (tracker.onEvent(ev)) await write(res, ev.raw);
        }
      }
      const tail = parser.flush();
      if (tail && tracker.onEvent(tail)) await write(res, tail.raw);
    } catch {
      interrupted = true;
    } finally {
      res.end();
    }
    const usage = tracker.usage();
    if (usage) {
      await settle({ status: 'settled', costMicros: costMicros(price, usage), usage, httpStatus: 200 }, 'settled');
    } else {
      // Cut off before the provider reported usage (client left, network dropped): estimate from
      // what was actually streamed.
      const est = tracker.estimate(promptTokens);
      await settle(
        { status: 'estimated', costMicros: costMicros(price, est), usage: est, httpStatus: 200 },
        interrupted ? 'stream_interrupted' : 'estimated',
      );
    }
    return this.reply;
  }

  /** Free endpoints (model list, token counting): forwarded with the real key, not budgeted. */
  private async forwardUnmetered(providerKey: string) {
    try {
      const upstream = await fetch(this.baseUrl + this.path, {
        method: this.req.method,
        headers: this.adapter.upstreamHeaders(this.req.headers, providerKey),
        body: this.req.method === 'GET' ? undefined : JSON.stringify(this.req.body ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await upstream.text();
      this.finish('unmetered', upstream.status);
      return this.reply
        .code(upstream.status)
        .headers(this.passHeaders(upstream.headers))
        .type(upstream.headers.get('content-type') ?? 'application/json')
        .send(text);
    } catch (err) {
      return this.fail(
        'upstream',
        `Could not reach ${this.adapter.displayName}: ${(err as Error).message}`,
        'upstream_unreachable',
      );
    }
  }

  private settle(eventId: string, s: SettleInput, outcome: string): Promise<void> {
    return this.track(this.doSettle(eventId, s, outcome));
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.deps.background.add(p);
    void p.finally(() => this.deps.background.delete(p));
    return p;
  }

  private async doSettle(eventId: string, s: SettleInput, outcome: string) {
    try {
      await this.deps.budget.settle(eventId, s);
    } catch (err) {
      // The reservation stays open and the sweeper settles it at the worst case later, so a
      // database hiccup here can only make budgets stricter, never looser.
      metrics.degraded.inc({ component: 'settle' });
      this.log.error({ err, eventId }, 'settlement failed; sweeper will settle at worst case');
    }
    if (s.costMicros > 0) {
      metrics.spendUsd.inc({ provider: this.adapter.provider, model: this.model }, s.costMicros / 1_000_000);
    }
    this.finish(outcome, s.httpStatus, { costUsd: s.costMicros / 1_000_000, usage: s.usage ?? undefined });
  }

  /** Refuses the request and records it, so blocked calls show up in the customer's log. */
  private block(kind: ErrorKind, message: string, code: string, headers: Record<string, string> = {}) {
    if (this.key) {
      void this.track(
        this.deps.budget
          .recordBlocked(
            this.key,
            {
              requestId: this.req.id,
              provider: this.adapter.provider,
              endpoint: this.path,
              model: this.model,
              stream: this.stream,
            },
            code,
            ERROR_STATUS[kind],
          )
          .catch((err) => this.log.warn({ err }, 'could not record blocked request')),
      );
    }
    return this.fail(kind, message, code, headers, `blocked_${code}`);
  }

  private unavailable(err: unknown) {
    metrics.degraded.inc({ component: 'postgres' });
    this.log.error({ err }, 'database unavailable; refusing request');
    // Fail closed: without the database we cannot enforce budgets, so nothing is forwarded.
    return this.fail('unavailable', 'Spend Guard is temporarily unavailable. Please retry.', 'guard_unavailable');
  }

  private fail(
    kind: ErrorKind,
    message: string,
    code: string,
    headers: Record<string, string> = {},
    outcome = `rejected_${code}`,
  ) {
    this.finish(outcome, ERROR_STATUS[kind], { reason: code });
    return this.reply
      .code(ERROR_STATUS[kind])
      .headers({ 'x-apg-request-id': this.req.id, 'x-apg-block-reason': code, ...headers })
      .send(this.adapter.errorBody(kind, message, code));
  }

  /** One structured log line per request: the access log, with the business fields that matter. */
  private finish(outcome: string, status: number, extra: Record<string, unknown> = {}) {
    metrics.requests.inc({ provider: this.adapter.provider, outcome });
    this.log.info(
      { outcome, status, model: this.model || undefined, stream: this.stream, ms: this.elapsed(), ...extra },
      'proxied request',
    );
  }

  private elapsed() {
    return Math.round(performance.now() - this.started);
  }

  private passHeaders(h: Headers): Record<string, string> {
    const out: Record<string, string> = { 'x-apg-request-id': this.req.id };
    h.forEach((value, name) => {
      if (PASS_HEADERS.test(name)) out[name] = value;
    });
    return out;
  }
}

/** Respects backpressure, and gives up instead of waiting forever if the client is gone. */
function write(res: ServerResponse, data: string): Promise<void> {
  if (res.destroyed) return Promise.reject(new Error('client disconnected'));
  if (res.write(data)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error('client disconnected'));
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}

/** A malformed success body still has to be billed: no usage means the worst case is charged. */
function parseUsage(read: () => Usage | null): Usage | null {
  try {
    return read();
  } catch {
    return null;
  }
}
