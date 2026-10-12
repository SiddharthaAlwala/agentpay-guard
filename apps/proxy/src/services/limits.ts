import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Both limits in one atomic Lua call (one round trip). Each is a sliding window: drop entries older
 * than the window, add this request, count. ARGV[3] = 0 means "no rate limit on this key".
 */
const LIMITS_SCRIPT = `
local now = tonumber(ARGV[1])
local member = ARGV[2]
local rpm = 0
if tonumber(ARGV[3]) > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - 60000)
  redis.call('ZADD', KEYS[1], now, member)
  redis.call('PEXPIRE', KEYS[1], 60000)
  rpm = redis.call('ZCARD', KEYS[1])
end
local window = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, now - window)
redis.call('ZADD', KEYS[2], now, member)
redis.call('PEXPIRE', KEYS[2], window)
return { rpm, redis.call('ZCARD', KEYS[2]) }
`;

export type LimitResult =
  { ok: true } | { ok: false; reason: 'rate_limit' | 'loop'; retryAfterSec: number; count: number };

/**
 * Request-rate and runaway-loop limits, kept in Redis because they are hot counters that don't
 * need durability.
 *
 * If Redis is unavailable these checks are skipped (fail open). That is deliberate: they are
 * early-warning limits, while the dollar budgets, the hard guarantee, live in Postgres and keep
 * working. Taking every customer's agents offline because a cache blipped would be the worse outcome.
 */
export class LimitService {
  constructor(
    private redis: Redis | null,
    private onDegraded: (err: unknown) => void = () => undefined,
  ) {}

  async check(
    keyId: string,
    requestId: string,
    body: unknown,
    opts: { rpmLimit: number | null; loopMaxRepeats: number; loopWindowSec: number },
  ): Promise<LimitResult> {
    if (!this.redis || this.redis.status !== 'ready') return { ok: true };
    try {
      // An agent stuck in a loop sends the exact same request over and over. Identical bodies
      // hash to the same fingerprint; legitimate traffic almost never repeats verbatim this often.
      const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
      // {keyId} is a hash tag: both keys land on the same node if Redis is ever clustered.
      const [rpm, repeats] = (await this.redis.eval(
        LIMITS_SCRIPT,
        2,
        `sg:{${keyId}}:rpm`,
        `sg:{${keyId}}:loop:${fingerprint}`,
        Date.now().toString(),
        requestId,
        String(opts.rpmLimit ?? 0),
        String(opts.loopWindowSec * 1000),
      )) as [number, number];
      if (opts.rpmLimit !== null && rpm > opts.rpmLimit) {
        return { ok: false, reason: 'rate_limit', retryAfterSec: 60, count: rpm };
      }
      if (repeats > opts.loopMaxRepeats) {
        return { ok: false, reason: 'loop', retryAfterSec: opts.loopWindowSec, count: repeats };
      }
      return { ok: true };
    } catch (err) {
      this.onDegraded(err);
      return { ok: true };
    }
  }
}
