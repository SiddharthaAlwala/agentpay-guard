import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'agentpay_' });

export const paymentDecisions = new client.Counter({
  name: 'agentpay_payment_decisions_total',
  help: 'Payment decisions by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const ruleHits = new client.Counter({
  name: 'agentpay_rule_hits_total',
  help: 'Policy rules that fired, by rule and outcome',
  labelNames: ['rule', 'outcome'] as const,
  registers: [registry],
});

export const idempotentReplays = new client.Counter({
  name: 'agentpay_idempotent_replays_total',
  help: 'Retried requests answered from the original decision instead of paying twice',
  registers: [registry],
});

export const blockedCents = new client.Counter({
  name: 'agentpay_blocked_amount_cents_total',
  help: 'Money the guard refused to let agents spend',
  registers: [registry],
});

export const decisionLatency = new client.Histogram({
  name: 'agentpay_decision_latency_seconds',
  help: 'Time to reach a payment decision',
  buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const humanReviews = new client.Counter({
  name: 'agentpay_human_reviews_total',
  help: 'Human approval decisions',
  labelNames: ['decision'] as const,
  registers: [registry],
});
