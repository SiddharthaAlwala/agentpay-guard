import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const { app, deps } = await buildApp({ cfg });

// Settle reservations left open by a crash, at their worst-case cost.
const sweeper = setInterval(() => {
  deps.budget
    .sweepStale(cfg.STALE_RESERVATION_MIN)
    .then((n) => n > 0 && app.log.warn({ settled: n }, 'settled stale reservations at worst case'))
    .catch((err) => app.log.error({ err }, 'reservation sweeper failed'));
}, 60_000);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down: finishing in-flight requests');
  clearInterval(sweeper);
  // close() stops accepting connections and waits for in-flight requests (including streams)
  // so they can settle their cost before the process exits.
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: cfg.PORT, host: cfg.HOST });
app.log.info({ redis: deps.redis.status }, `Spend Guard proxy listening on :${cfg.PORT}`);
