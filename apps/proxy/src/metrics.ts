import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'spendguard_' });

export const requests = new client.Counter({
  name: 'spendguard_requests_total',
  help: 'Proxied requests by provider and outcome',
  labelNames: ['provider', 'outcome'] as const,
  registers: [registry],
});

export const spendUsd = new client.Counter({
  name: 'spendguard_spend_usd_total',
  help: 'Dollars billed through the proxy, by provider and model',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});

export const overhead = new client.Histogram({
  name: 'spendguard_overhead_seconds',
  help: 'Time the proxy adds before the request leaves for the provider (auth, limits, reservation)',
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
});

export const upstreamLatency = new client.Histogram({
  name: 'spendguard_upstream_seconds',
  help: 'Full provider call duration, including streaming',
  labelNames: ['provider'] as const,
  buckets: [0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const degraded = new client.Counter({
  name: 'spendguard_degraded_total',
  help: 'Times a dependency failed and the proxy fell back',
  labelNames: ['component'] as const,
  registers: [registry],
});
