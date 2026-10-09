import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const { app, deps } = await buildApp({ cfg });

// Expire pending approvals nobody answered, releasing their reserved budget.
const sweeper = setInterval(() => {
  deps.payments
    .expireStale(cfg.PENDING_APPROVAL_TTL_MIN)
    .then((n) => n > 0 && app.log.info({ expired: n }, 'expired stale approvals'))
    .catch((err) => app.log.error({ err }, 'sweeper failed'));
}, 60_000);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  clearInterval(sweeper);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: cfg.PORT, host: cfg.HOST });
app.log.info(
  { demoMode: cfg.DEMO_MODE, llmClassifier: cfg.LLM_CLASSIFIER, redis: deps.redis?.status },
  `AgentPay Guard listening on :${cfg.PORT} (docs at /docs)`,
);
