/**
 * Measures the latency the proxy adds, against the in-repo mock providers (so provider latency
 * doesn't drown the signal). Needs local Postgres and Redis.
 *
 *   npm run bench -w apps/proxy
 */
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { REAL_ANTHROPIC_KEY, startMockProviders } from '../test/mockProviders.js';

const TOTAL = Number(process.env.BENCH_REQUESTS ?? 3000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 20);

const mock = await startMockProviders();
const { app, deps } = await buildApp({
  cfg: loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.BENCH_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/spendguard_test',
    REDIS_URL: 'redis://localhost:6379/3',
    ANTHROPIC_BASE_URL: mock.url,
  }),
  logger: false,
});
await app.listen({ port: 0, host: '127.0.0.1' });
const proxy = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const user = await deps.admin.upsertUser('bench');
const project = await deps.admin.createProject(user, 'bench');
await deps.admin.setProviderKey(project, 'anthropic', REAL_ANTHROPIC_KEY);
const open = await deps.admin.createKey(project, 'no budget', { loopMaxRepeats: 1_000_000 });
const budgeted = await deps.admin.createKey(project, 'with budgets', {
  dailyBudgetMicros: 1_000_000_000,
  monthlyBudgetMicros: 1_000_000_000,
  loopMaxRepeats: 1_000_000,
});

const body = JSON.stringify({
  model: 'claude-haiku-4-5',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Hi' }],
});

async function run(label: string, url: string, apiKey: string) {
  const times: number[] = [];
  let next = 0;
  let errors = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next++ < TOTAL) {
        const t = performance.now();
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body,
        });
        await res.arrayBuffer();
        if (!res.ok) errors++;
        times.push(performance.now() - t);
      }
    }),
  );
  const secs = (performance.now() - started) / 1000;
  times.sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]!.toFixed(2);
  console.log(
    `${label.padEnd(26)} ${String(Math.round(times.length / secs)).padStart(6)} req/s   p50 ${pct(50)} ms   p95 ${pct(95)} ms   p99 ${pct(99)} ms   errors ${errors}`,
  );
  return times;
}

console.log(`${TOTAL} requests, concurrency ${CONCURRENCY}\n`);
await run('warm-up', `${proxy}/anthropic/v1/messages`, open.key);
await run('direct to mock provider', `${mock.url}/v1/messages`, REAL_ANTHROPIC_KEY);
await run('via proxy, no budgets', `${proxy}/anthropic/v1/messages`, open.key);
await run('via proxy, with budgets', `${proxy}/anthropic/v1/messages`, budgeted.key);

// Settlement finishes just after each response is sent; give the last ones a moment.
await new Promise((r) => setTimeout(r, 500));
const { rows } = await deps.db.query(
  `SELECT count(*)::int AS events, sum(cost_micros)::bigint AS cost,
          (SELECT sum(reserved_micros) FROM spend_counters WHERE scope = 'project' AND scope_id = $1) AS still_reserved
     FROM usage_events WHERE project_id = $1`,
  [project],
);
console.log('\naccounting check:', rows[0]);
await app.close();
await mock.app.close();
