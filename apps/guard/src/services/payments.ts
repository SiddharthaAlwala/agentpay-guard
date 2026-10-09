import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Db, Tx } from '../db.js';
import { withTx } from '../db.js';
import { HttpError, type Agent, type PaymentRequestInput, type PaymentRow } from '../domain.js';
import * as metrics from '../metrics.js';
import { evaluate } from '../policy/engine.js';
import { detectInjection, type InjectionResult } from '../policy/injection.js';
import type { InjectionClassifier } from '../policy/llmClassifier.js';
import { audit, type AgentService } from './agents.js';
import type { EventBus } from './events.js';
import type { VelocityTracker } from './velocity.js';

const START_OF_DAY = `(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
const START_OF_MONTH = `(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

export interface CreateResult {
  payment: PaymentRow;
  replay: boolean;
}

/** Canonical JSON (sorted keys) so the same request always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const requestHash = (input: PaymentRequestInput) => createHash('sha256').update(canonical(input)).digest('hex');

export class PaymentService {
  constructor(
    private db: Db,
    private agents: AgentService,
    private velocity: VelocityTracker,
    private events: EventBus,
    private classifier: InjectionClassifier | null,
  ) {}

  /**
   * The heart of the guard. Concurrency model:
   *  1. Fast idempotency check without locks (cheap path for retries).
   *  2. Optional LLM classification *outside* the transaction so no lock is held during a network call.
   *  3. Inside one transaction: lock the agent row (SELECT ... FOR UPDATE), which serializes this
   *     agent's payments so budget checks cannot race; re-check idempotency under the lock; evaluate;
   *     insert the decision and, if approved, a balanced ledger journal.
   *  4. A UNIQUE(agent_id, idempotency_key) constraint backs all of this up at the storage layer.
   */
  async create(agent: Agent, input: PaymentRequestInput, idempotencyKey: string): Promise<CreateResult> {
    const started = performance.now();
    const hash = requestHash(input);

    const existing = await this.findByKey(this.db, agent.id, idempotencyKey);
    if (existing) return this.replay(existing, hash);

    const injection = await this.scan(input);

    try {
      const payment = await withTx(this.db, async (tx) => {
        const locked = await tx.query<Agent>(
          'SELECT id, name, owner, status, api_key_prefix, created_at FROM agents WHERE id = $1 FOR UPDATE',
          [agent.id],
        );
        const current = locked.rows[0];
        if (!current) throw new HttpError(404, 'agent_not_found', 'Agent not found');

        const again = await this.findByKey(tx, agent.id, idempotencyKey);
        if (again) return { kind: 'replay' as const, row: again };

        const policy = await this.agents.policy(tx, agent.id);
        const spend = await this.committedSpend(tx, agent.id);
        const id = randomUUID();
        const velocity = await this.velocity.hit(tx, agent.id, policy.velocity_window_sec, id);

        const decision = evaluate({
          agent: current,
          policy,
          request: input,
          spentTodayCents: spend.today,
          spentMonthCents: spend.month,
          velocityCount: velocity.count,
          injection,
        });
        const latencyMs = Number((performance.now() - started).toFixed(2));

        const { rows } = await tx.query<PaymentRow>(
          `INSERT INTO payment_requests
             (id, agent_id, idempotency_key, request_hash, merchant, category, amount_cents, currency, reason,
              user_intent, source_url, status, risk_score, decision_reasons, policy_version, decided_at, latency_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   CASE WHEN $12 = 'pending_approval' THEN NULL ELSE now() END, $16)
           RETURNING *`,
          [
            id,
            agent.id,
            idempotencyKey,
            hash,
            input.merchant,
            input.category,
            input.amountCents,
            input.currency,
            input.reason,
            input.context.userIntent ?? null,
            input.context.sourceUrl ?? null,
            decision.outcome,
            decision.riskScore,
            JSON.stringify(decision.reasons),
            policy.version,
            latencyMs,
          ],
        );
        const row = rows[0]!;
        if (decision.outcome === 'approved') await this.postToLedger(tx, row);
        await audit(tx, `agent:${agent.id}`, `payment.${decision.outcome}`, 'payment', row.id, {
          amountCents: row.amount_cents,
          merchant: row.merchant,
          riskScore: row.risk_score,
          injection: injection.signals.map((s) => s.id),
          velocitySource: velocity.source,
        });
        return { kind: 'created' as const, row };
      });

      if (payment.kind === 'replay') return this.replay(payment.row, hash);

      const row = payment.row;
      metrics.paymentDecisions.inc({ outcome: row.status });
      metrics.decisionLatency.observe((performance.now() - started) / 1000);
      for (const r of row.decision_reasons)
        if (r.outcome !== 'pass') metrics.ruleHits.inc({ rule: r.rule, outcome: r.outcome });
      if (row.status === 'blocked') metrics.blockedCents.inc(row.amount_cents);
      this.events.publish({ type: 'payment.decided', payment: { ...toApi(row), agentName: agent.name } });
      return { payment: row, replay: false };
    } catch (err) {
      // The agent row lock makes this unreachable in practice; the unique constraint is the
      // storage-level safety net if that invariant is ever broken (e.g. a future code path).
      if ((err as { code?: string }).code === '23505') {
        const winner = await this.findByKey(this.db, agent.id, idempotencyKey);
        if (winner) return this.replay(winner, hash);
      }
      throw err;
    }
  }

  private replay(existing: PaymentRow, hash: string): CreateResult {
    if (existing.request_hash !== hash) {
      throw new HttpError(
        409,
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different payment request.',
      );
    }
    metrics.idempotentReplays.inc();
    return { payment: existing, replay: true };
  }

  private async scan(input: PaymentRequestInput): Promise<InjectionResult> {
    const heuristic = detectInjection(input.reason, input.context.sourceUrl);
    if (!this.classifier) return heuristic;
    const verdict = await this.classifier.classify({
      reason: input.reason,
      userIntent: input.context.userIntent,
      merchant: input.merchant,
      category: input.category,
    });
    if (!verdict) return heuristic;
    return {
      ...heuristic,
      score: Math.max(heuristic.score, verdict.score),
      source: 'heuristic+llm',
      llmRationale: verdict.score > heuristic.score ? verdict.rationale : undefined,
    };
  }

  private async findByKey(q: Tx | Db, agentId: string, key: string): Promise<PaymentRow | null> {
    const { rows } = await q.query<PaymentRow>(
      'SELECT * FROM payment_requests WHERE agent_id = $1 AND idempotency_key = $2',
      [agentId, key],
    );
    return rows[0] ?? null;
  }

  /** Approved spend plus pending approvals (reserved), so a queue of pending requests cannot overspend. */
  async committedSpend(q: Tx | Db, agentId: string): Promise<{ today: number; month: number }> {
    const { rows } = await q.query<{ today: number; month: number }>(
      `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= ${START_OF_DAY}), 0)::bigint AS today,
              COALESCE(SUM(amount_cents), 0)::bigint AS month
         FROM payment_requests
        WHERE agent_id = $1 AND status IN ('approved', 'pending_approval') AND created_at >= ${START_OF_MONTH}`,
      [agentId],
    );
    return rows[0] ?? { today: 0, month: 0 };
  }

  private async postToLedger(tx: Tx, p: PaymentRow) {
    const journal = randomUUID();
    const merchant = p.merchant.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await tx.query(
      `INSERT INTO ledger_entries (journal_id, payment_id, account, direction, amount_cents) VALUES
         ($1, $2, $3, 'debit', $5),
         ($1, $2, $4, 'credit', $5)`,
      [journal, p.id, `expense:agent:${p.agent_id}`, `payable:merchant:${merchant}`, p.amount_cents],
    );
  }

  async review(id: string, decision: 'approve' | 'reject', reviewer: string, note?: string): Promise<PaymentRow> {
    const row = await withTx(this.db, async (tx) => {
      const { rows } = await tx.query<PaymentRow>('SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE', [id]);
      const p = rows[0];
      if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found');
      if (p.status !== 'pending_approval') {
        throw new HttpError(409, 'not_pending', `Payment is already ${p.status}.`);
      }
      if (decision === 'approve') {
        const agent = await tx.query<{ status: string }>('SELECT status FROM agents WHERE id = $1', [p.agent_id]);
        if (agent.rows[0]?.status === 'frozen') {
          throw new HttpError(409, 'agent_frozen', 'Cannot approve a payment for a frozen agent.');
        }
      }
      const status = decision === 'approve' ? 'approved' : 'rejected';
      const updated = await tx.query<PaymentRow>(
        `UPDATE payment_requests SET status = $2, decided_by = $3, review_note = $4, decided_at = now()
          WHERE id = $1 RETURNING *`,
        [id, status, `human:${reviewer}`, note ?? null],
      );
      const u = updated.rows[0]!;
      if (status === 'approved') await this.postToLedger(tx, u);
      await audit(tx, `human:${reviewer}`, `payment.${status}`, 'payment', id, { note });
      return u;
    });
    metrics.humanReviews.inc({ decision });
    this.events.publish({ type: 'payment.reviewed', payment: toApi(row) });
    return row;
  }

  /** Pending approvals nobody answered expire and release their reserved budget. */
  async expireStale(ttlMinutes: number): Promise<number> {
    const { rows } = await this.db.query<PaymentRow>(
      `UPDATE payment_requests SET status = 'expired', decided_at = now(), decided_by = 'system:ttl'
        WHERE status = 'pending_approval' AND created_at < now() - make_interval(mins => $1)
        RETURNING *`,
      [ttlMinutes],
    );
    for (const r of rows) this.events.publish({ type: 'payment.reviewed', payment: toApi(r) });
    return rows.length;
  }

  async get(id: string): Promise<PaymentRow> {
    const { rows } = await this.db.query<PaymentRow>('SELECT * FROM payment_requests WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'payment_not_found', 'Payment not found');
    return rows[0];
  }

  async list(filter: { status?: string; agentId?: string; limit: number }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status) {
      args.push(filter.status);
      where.push(`p.status = $${args.length}`);
    }
    if (filter.agentId) {
      args.push(filter.agentId);
      where.push(`p.agent_id = $${args.length}`);
    }
    args.push(filter.limit);
    const { rows } = await this.db.query<PaymentRow & { agent_name: string }>(
      `SELECT p.*, a.name AS agent_name FROM payment_requests p JOIN agents a ON a.id = p.agent_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.created_at DESC LIMIT $${args.length}`,
      args,
    );
    return rows.map((r) => ({ ...toApi(r), agentName: r.agent_name }));
  }

  /** Proves the books balance: every journal nets to zero, and the ledger matches approved payments. */
  async ledgerIntegrity() {
    const { rows } = await this.db.query<{
      debits: number;
      credits: number;
      journals: number;
      unbalanced: number;
      approved_total: number;
      approved_count: number;
      double_posted: number;
    }>(
      `WITH j AS (
         SELECT journal_id,
                SUM(amount_cents) FILTER (WHERE direction = 'debit') AS d,
                SUM(amount_cents) FILTER (WHERE direction = 'credit') AS c
           FROM ledger_entries GROUP BY journal_id
       ), dp AS (
         SELECT payment_id FROM ledger_entries WHERE direction = 'debit' GROUP BY payment_id HAVING COUNT(*) > 1
       )
       SELECT COALESCE((SELECT SUM(d) FROM j), 0)::bigint AS debits,
              COALESCE((SELECT SUM(c) FROM j), 0)::bigint AS credits,
              (SELECT COUNT(*) FROM j)::int AS journals,
              (SELECT COUNT(*) FROM j WHERE COALESCE(d, 0) <> COALESCE(c, 0))::int AS unbalanced,
              COALESCE((SELECT SUM(amount_cents) FROM payment_requests WHERE status = 'approved'), 0)::bigint AS approved_total,
              (SELECT COUNT(*) FROM payment_requests WHERE status = 'approved')::int AS approved_count,
              (SELECT COUNT(*) FROM dp)::int AS double_posted`,
    );
    const r = rows[0]!;
    return {
      debitsCents: r.debits,
      creditsCents: r.credits,
      journals: r.journals,
      unbalancedJournals: r.unbalanced,
      doublePostedPayments: r.double_posted,
      approvedPaymentsCents: r.approved_total,
      approvedPayments: r.approved_count,
      balanced: r.debits === r.credits && r.unbalanced === 0,
      reconciled: r.debits === r.approved_total && r.journals === r.approved_count && r.double_posted === 0,
    };
  }

  async stats() {
    const [byStatus, rulesHit, latency] = await Promise.all([
      this.db.query<{ status: string; n: number; cents: number }>(
        `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_cents), 0)::bigint AS cents FROM payment_requests GROUP BY status`,
      ),
      this.db.query<{ rule: string; n: number }>(
        `SELECT r->>'rule' AS rule, COUNT(*)::int AS n
           FROM payment_requests, jsonb_array_elements(decision_reasons) r
          WHERE r->>'outcome' <> 'pass'
          GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      ),
      this.db.query<{ p50: number | null; p95: number | null; p99: number | null }>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
                percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99
           FROM payment_requests WHERE latency_ms IS NOT NULL`,
      ),
    ]);
    const statuses = Object.fromEntries(byStatus.rows.map((r) => [r.status, { count: r.n, amountCents: r.cents }]));
    return {
      statuses,
      totalRequests: byStatus.rows.reduce((s, r) => s + r.n, 0),
      blockedAmountCents: statuses.blocked?.amountCents ?? 0,
      approvedAmountCents: statuses.approved?.amountCents ?? 0,
      topRules: rulesHit.rows,
      latencyMs: latency.rows[0],
    };
  }
}

export function toApi(p: PaymentRow) {
  return {
    id: p.id,
    agentId: p.agent_id,
    idempotencyKey: p.idempotency_key,
    merchant: p.merchant,
    category: p.category,
    amountCents: p.amount_cents,
    currency: p.currency,
    reason: p.reason,
    userIntent: p.user_intent,
    sourceUrl: p.source_url,
    status: p.status,
    riskScore: p.risk_score,
    reasons: p.decision_reasons,
    policyVersion: p.policy_version,
    decidedBy: p.decided_by,
    reviewNote: p.review_note,
    latencyMs: p.latency_ms,
    createdAt: p.created_at,
    decidedAt: p.decided_at,
  };
}
