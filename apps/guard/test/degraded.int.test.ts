import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/** Redis is an optimization, not a dependency: with Redis down the guard must stay correct. */
describe('with Redis unavailable', () => {
  let app: FastifyInstance;
  let deps: AppDeps;

  beforeAll(async () => {
    const cfg = loadConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/agentpay_test',
      REDIS_URL: 'redis://localhost:6390', // nothing listens here
      ADMIN_TOKEN: 'test-admin-token',
      NODE_ENV: 'test',
    });
    ({ app, deps } = await buildApp({ cfg, classifier: null, logger: false }));
    await deps.db.query(
      'TRUNCATE ledger_entries, payment_requests, audit_log, policies, agents RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports degraded readiness but keeps serving', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.redis).toMatch(/degraded/);
  });

  it('still enforces velocity limits using Postgres', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/agents',
      headers: { 'x-admin-token': 'test-admin-token' },
      payload: { name: 'No Redis', policy: { velocityMax: 2 } },
    });
    const key = created.json().apiKey as string;
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments',
        headers: { authorization: `Bearer ${key}`, 'idempotency-key': randomUUID() },
        payload: { merchant: 'Amazon', category: 'books', amountCents: 1_000, reason: 'A book' },
      });
      statuses.push(res.json().status);
    }
    expect(statuses).toEqual(['approved', 'approved', 'blocked', 'blocked']);
  });
});

/** A Postgres restart or failover drops every connection. The guard must survive it and recover. */
describe('when Postgres drops its connections', () => {
  let app: FastifyInstance;
  let deps: AppDeps;

  beforeAll(async () => {
    const cfg = loadConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/agentpay_test',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
      ADMIN_TOKEN: 'test-admin-token',
      NODE_ENV: 'test',
    });
    ({ app, deps } = await buildApp({ cfg, classifier: null, logger: false }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not crash and serves the next request', async () => {
    // Warm the pool so several idle connections exist, then kill them all from the server side.
    await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: '/readyz' })));
    await deps.db.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
    );
    await new Promise((r) => setTimeout(r, 200)); // let the 'error' events fire

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.postgres).toBe('ok');
  });
});
