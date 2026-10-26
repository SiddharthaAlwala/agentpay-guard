import { withTx, type Db } from '../db.js';
import type { Usage } from '../pricing/cost.js';
import type { KeyContext } from './keys.js';

/** Budget windows are calendar days and months in UTC. */
export function periods(now = new Date()): { day: string; month: string } {
  const iso = now.toISOString();
  return { day: iso.slice(0, 10), month: `${iso.slice(0, 7)}-01` };
}

export interface ReserveInput {
  key: KeyContext;
  requestId: string;
  provider: string;
  endpoint: string;
  model: string;
  stream: boolean;
  reserveMicros: number;
  now?: Date;
}

export type BudgetScope = 'key_daily' | 'key_monthly' | 'project_monthly';

export type ReserveResult =
  { ok: true; eventId: string } | { ok: false; scope: BudgetScope; limitMicros: number; committedMicros: number };

export interface SettleInput {
  status: 'settled' | 'estimated' | 'failed';
  costMicros: number;
  usage: Usage | null;
  httpStatus: number;
  latencyMs: number;
}

interface CounterRow {
  scope: 'key' | 'project';
  period: 'day' | 'month';
  spent_micros: number;
  reserved_micros: number;
}

/**
 * Reserve-then-settle accounting.
 *
 * Before a request goes out we reserve its worst-case cost; afterwards we replace the reservation
 * with the real cost. Checking "spent + reserved + this request ≤ budget" while holding a lock
 * means 50 concurrent requests cannot all see the same remaining budget and overspend it together.
 */
export class BudgetService {
  constructor(private db: Db) {}

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const { key } = input;
    const p = periods(input.now);
    const keyLimited = key.dailyBudgetMicros !== null || key.monthlyBudgetMicros !== null;
    const projectLimited = key.projectMonthlyBudgetMicros !== null;

    const params = [
      input.requestId,
      key.projectId,
      key.keyId,
      input.provider,
      input.endpoint,
      input.model,
      input.stream,
      input.reserveMicros,
      p.day,
      p.month,
    ];
    if (!keyLimited && !projectLimited) {
      // Nothing to check: a single statement (one round trip, one commit) keeps the hot path fast.
      const { rows } = await this.db.query<{ id: string }>(RESERVE_SQL, params);
      return { ok: true, eventId: rows[0]!.id };
    }

    return withTx(this.db, async (tx) => {
      // Locks serialize only requests that share a budget, always in the same order (project,
      // then key) so two transactions can never wait on each other. Keys without budgets skip
      // the lock entirely and run fully in parallel.
      if (projectLimited) await tx.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [key.projectId]);
      if (keyLimited) await tx.query('SELECT 1 FROM api_keys WHERE id = $1 FOR UPDATE', [key.keyId]);

      const { rows } = await tx.query<CounterRow>(
        `SELECT scope, period, spent_micros, reserved_micros FROM spend_counters
          WHERE (scope = 'key' AND scope_id = $1 AND ((period = 'day' AND period_start = $3) OR (period = 'month' AND period_start = $4)))
             OR (scope = 'project' AND scope_id = $2 AND period = 'month' AND period_start = $4)`,
        [key.keyId, key.projectId, p.day, p.month],
      );
      const committed = (scope: string, period: string) => {
        const r = rows.find((x) => x.scope === scope && x.period === period);
        return r ? r.spent_micros + r.reserved_micros : 0;
      };
      const checks: Array<[BudgetScope, number | null, number]> = [
        ['key_daily', key.dailyBudgetMicros, committed('key', 'day')],
        ['key_monthly', key.monthlyBudgetMicros, committed('key', 'month')],
        ['project_monthly', key.projectMonthlyBudgetMicros, committed('project', 'month')],
      ];
      for (const [scope, limit, used] of checks) {
        if (limit !== null && used + input.reserveMicros > limit) {
          return { ok: false, scope, limitMicros: limit, committedMicros: used };
        }
      }
      const inserted = await tx.query<{ id: string }>(RESERVE_SQL, params);
      return { ok: true, eventId: inserted.rows[0]!.id };
    });
  }

  /**
   * Swaps the reservation for the real cost, in one atomic statement. Safe to call twice (for
   * example by the request and by the stale-reservation sweeper): only the first call finds the
   * event still 'reserved'.
   */
  async settle(eventId: string, s: SettleInput): Promise<boolean> {
    const { rows } = await this.db.query<{ key_id: string }>(SETTLE_SQL, [
      eventId,
      s.status,
      s.costMicros,
      s.httpStatus,
      s.latencyMs,
      s.usage?.inputTokens ?? null,
      s.usage?.outputTokens ?? null,
      s.usage?.cacheReadTokens ?? null,
      s.usage ? s.usage.cacheWrite5mTokens + s.usage.cacheWrite1hTokens : null,
    ]);
    const keyId = rows[0]?.key_id;
    if (!keyId) return false;
    // Outside the settlement, and at most once a minute per key: updating the key row inside it
    // would take locks in the opposite order to reserve() and could deadlock under load.
    void this.db
      .query(
        `UPDATE api_keys SET last_used_at = now()
          WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
        [keyId],
      )
      .catch(() => undefined);
    return true;
  }

  async recordBlocked(
    key: KeyContext,
    e: { requestId: string; provider: string; endpoint: string; model: string; stream: boolean },
    reason: string,
    httpStatus: number,
  ): Promise<void> {
    const p = periods();
    await this.db.query(
      `INSERT INTO usage_events (request_id, project_id, key_id, provider, endpoint, model, stream, status,
                                 block_reason, http_status, period_day, period_month, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'blocked', $8, $9, $10, $11, now())`,
      [
        e.requestId,
        key.projectId,
        key.keyId,
        e.provider,
        e.endpoint,
        e.model,
        e.stream,
        reason,
        httpStatus,
        p.day,
        p.month,
      ],
    );
  }

  /**
   * A reservation still open after `minutes` belongs to a request whose process died mid-flight.
   * We can't know what the provider billed, so we charge the worst case: budgets err on the safe side.
   */
  async sweepStale(minutes: number): Promise<number> {
    const { rows } = await this.db.query<{ id: string; reserved_micros: number }>(
      `SELECT id, reserved_micros FROM usage_events
        WHERE status = 'reserved' AND created_at < now() - make_interval(mins => $1)
        ORDER BY created_at LIMIT 500`,
      [minutes],
    );
    let n = 0;
    for (const r of rows) {
      const ok = await this.settle(r.id, {
        status: 'estimated',
        costMicros: r.reserved_micros,
        usage: null,
        httpStatus: 0,
        latencyMs: 0,
      });
      if (ok) n++;
    }
    return n;
  }
}

/**
 * Inserts the reservation and adds it to the three counters in one statement. Counter rows are
 * always listed in the same order (key/day, key/month, project/month) so concurrent statements
 * lock them in the same order and cannot deadlock.
 */
const RESERVE_SQL = `
WITH ev AS (
  INSERT INTO usage_events (request_id, project_id, key_id, provider, endpoint, model, stream, status,
                            reserved_micros, period_day, period_month)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $9, $10)
  RETURNING id
), counters AS (
  INSERT INTO spend_counters AS c (scope, scope_id, period, period_start, reserved_micros)
  VALUES ('key', $3, 'day', $9, $8), ('key', $3, 'month', $10, $8), ('project', $2, 'month', $10, $8)
  ON CONFLICT (scope, scope_id, period, period_start)
  DO UPDATE SET reserved_micros = c.reserved_micros + EXCLUDED.reserved_micros
)
SELECT id FROM ev`;

/**
 * Marks the event settled and moves its amount from "reserved" to "spent", against the windows the
 * reservation was made in (so a request that crosses midnight releases yesterday's reservation).
 */
const SETTLE_SQL = `
WITH ev AS (
  UPDATE usage_events
     SET status = $2, cost_micros = $3, http_status = $4, latency_ms = $5, settled_at = now(),
         input_tokens = $6, output_tokens = $7, cache_read_tokens = $8, cache_write_tokens = $9
   WHERE id = $1 AND status = 'reserved'
  RETURNING key_id, project_id, reserved_micros, period_day, period_month
), counters AS (
  INSERT INTO spend_counters AS c (scope, scope_id, period, period_start, spent_micros)
  SELECT v.scope, v.scope_id, v.period, v.period_start, $3::bigint
    FROM ev, LATERAL (VALUES (1, 'key', ev.key_id, 'day', ev.period_day),
                             (2, 'key', ev.key_id, 'month', ev.period_month),
                             (3, 'project', ev.project_id, 'month', ev.period_month))
                     AS v(ord, scope, scope_id, period, period_start)
   ORDER BY v.ord
  ON CONFLICT (scope, scope_id, period, period_start)
  DO UPDATE SET spent_micros = c.spent_micros + EXCLUDED.spent_micros,
                reserved_micros = GREATEST(c.reserved_micros - (SELECT reserved_micros FROM ev), 0)
)
SELECT key_id FROM ev`;
