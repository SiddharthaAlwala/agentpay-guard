import type { Redis } from 'ioredis';
import type { Tx } from '../db.js';

/**
 * Sliding-window counter in a single atomic Lua script:
 * drop entries older than the window, add this request, return the count.
 */
const SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return redis.call('ZCARD', key)
`;

export class VelocityTracker {
  constructor(private redis: Redis | null) {}

  /**
   * Records an attempt and returns how many attempts this agent made in the window (including this one).
   * If Redis is unavailable we fall back to counting rows in Postgres inside the caller's
   * transaction, which is exact because the caller holds the agent's row lock.
   */
  async hit(
    tx: Tx,
    agentId: string,
    windowSec: number,
    requestId: string,
  ): Promise<{ count: number; source: 'redis' | 'postgres' }> {
    if (this.redis && this.redis.status === 'ready') {
      try {
        const count = (await this.redis.eval(
          SLIDING_WINDOW,
          1,
          `velocity:${agentId}`,
          Date.now().toString(),
          (windowSec * 1000).toString(),
          requestId,
        )) as number;
        return { count, source: 'redis' };
      } catch {
        // fall through to Postgres
      }
    }
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_requests
        WHERE agent_id = $1 AND created_at > now() - make_interval(secs => $2)`,
      [agentId, windowSec],
    );
    return { count: (rows[0]?.n ?? 0) + 1, source: 'postgres' };
  }

  async reset(agentId?: string) {
    if (!this.redis || this.redis.status !== 'ready') return;
    if (agentId) {
      await this.redis.del(`velocity:${agentId}`);
      return;
    }
    const keys = await this.redis.keys('velocity:*');
    if (keys.length) await this.redis.del(...keys);
  }
}
