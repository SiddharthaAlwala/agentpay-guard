import { createHash, randomBytes } from 'node:crypto';
import type { Db, Tx } from '../db.js';
import { withTx } from '../db.js';
import { HttpError, type Agent, type Policy, type PolicyUpdate } from '../domain.js';
import type { EventBus } from './events.js';

export const DEFAULT_POLICY: Required<PolicyUpdate> = {
  perTxLimitCents: 50_000,
  dailyLimitCents: 100_000,
  monthlyLimitCents: 500_000,
  approvalThresholdCents: 20_000,
  allowedCategories: [],
  blockedCategories: ['gift_cards', 'crypto', 'wire_transfer', 'cash_equivalent'],
  merchantAllowlist: [],
  velocityMax: 5,
  velocityWindowSec: 60,
  injectionReviewScore: 30,
  injectionBlockScore: 60,
  intentCheck: true,
};

const COLUMN: Record<keyof PolicyUpdate, string> = {
  perTxLimitCents: 'per_tx_limit_cents',
  dailyLimitCents: 'daily_limit_cents',
  monthlyLimitCents: 'monthly_limit_cents',
  approvalThresholdCents: 'approval_threshold_cents',
  allowedCategories: 'allowed_categories',
  blockedCategories: 'blocked_categories',
  merchantAllowlist: 'merchant_allowlist',
  velocityMax: 'velocity_max',
  velocityWindowSec: 'velocity_window_sec',
  injectionReviewScore: 'injection_review_score',
  injectionBlockScore: 'injection_block_score',
  intentCheck: 'intent_check',
};

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export async function audit(
  tx: Tx | Db,
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
) {
  await tx.query('INSERT INTO audit_log (actor, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)', [
    actor,
    action,
    entityType,
    entityId,
    JSON.stringify(details),
  ]);
}

export class AgentService {
  constructor(
    private db: Db,
    private events: EventBus,
  ) {}

  /** Creates an agent and returns its API key. The key is shown once; only its hash is stored. */
  async create(input: { name: string; owner: string; policy: PolicyUpdate }, actor = 'admin', fixedKey?: string) {
    const apiKey = fixedKey ?? `apg_${randomBytes(24).toString('base64url')}`;
    const policy = { ...DEFAULT_POLICY, ...input.policy };
    validatePolicy(policy);
    return withTx(this.db, async (tx) => {
      const { rows } = await tx.query<Agent>(
        `INSERT INTO agents (name, owner, api_key_hash, api_key_prefix) VALUES ($1, $2, $3, $4)
         RETURNING id, name, owner, status, api_key_prefix, created_at`,
        [input.name, input.owner, hashKey(apiKey), apiKey.slice(0, 8)],
      );
      const agent = rows[0]!;
      const cols = Object.keys(policy) as Array<keyof PolicyUpdate>;
      await tx.query(
        `INSERT INTO policies (agent_id, ${cols.map((c) => COLUMN[c]).join(', ')})
         VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
        [agent.id, ...cols.map((c) => policy[c])],
      );
      await audit(tx, actor, 'agent.created', 'agent', agent.id, { name: agent.name, policy });
      return { agent, apiKey };
    });
  }

  async findByApiKey(apiKey: string): Promise<Agent | null> {
    const { rows } = await this.db.query<Agent>(
      'SELECT id, name, owner, status, api_key_prefix, created_at FROM agents WHERE api_key_hash = $1',
      [hashKey(apiKey)],
    );
    return rows[0] ?? null;
  }

  async get(id: string): Promise<{ agent: Agent; policy: Policy }> {
    const { rows } = await this.db.query<Agent>(
      'SELECT id, name, owner, status, api_key_prefix, created_at FROM agents WHERE id = $1',
      [id],
    );
    if (!rows[0]) throw new HttpError(404, 'agent_not_found', 'Agent not found');
    return { agent: rows[0], policy: await this.policy(this.db, id) };
  }

  async policy(q: Tx | Db, agentId: string): Promise<Policy> {
    const { rows } = await q.query<Policy>('SELECT * FROM policies WHERE agent_id = $1', [agentId]);
    if (!rows[0]) throw new HttpError(404, 'policy_not_found', 'Policy not found');
    return rows[0];
  }

  async list() {
    const { rows } = await this.db.query(
      `SELECT a.id, a.name, a.owner, a.status, a.api_key_prefix, a.created_at,
              row_to_json(p.*) AS policy,
              COALESCE(SUM(pr.amount_cents) FILTER (WHERE pr.status = 'approved'), 0)::bigint AS spent_today_cents,
              COALESCE(SUM(pr.amount_cents) FILTER (WHERE pr.status = 'pending_approval'), 0)::bigint AS reserved_today_cents,
              COUNT(pr.id) FILTER (WHERE pr.status = 'blocked')::int AS blocked_today
         FROM agents a
         JOIN policies p ON p.agent_id = a.id
         LEFT JOIN payment_requests pr
           ON pr.agent_id = a.id AND pr.created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        GROUP BY a.id, p.agent_id
        ORDER BY a.created_at`,
    );
    return rows;
  }

  async updatePolicy(agentId: string, update: PolicyUpdate, actor: string): Promise<Policy> {
    const cols = (Object.keys(update) as Array<keyof PolicyUpdate>).filter((k) => update[k] !== undefined);
    if (cols.length === 0) throw new HttpError(400, 'empty_update', 'No policy fields supplied');
    const policy = await withTx(this.db, async (tx) => {
      const current = await this.policy(tx, agentId);
      validatePolicy({ ...fromRow(current), ...update });
      const { rows } = await tx.query<Policy>(
        `UPDATE policies SET ${cols.map((c, i) => `${COLUMN[c]} = $${i + 2}`).join(', ')},
                version = version + 1, updated_at = now()
          WHERE agent_id = $1 RETURNING *`,
        [agentId, ...cols.map((c) => update[c])],
      );
      await audit(tx, actor, 'policy.updated', 'agent', agentId, { changes: update, version: rows[0]!.version });
      return rows[0]!;
    });
    this.events.publish({ type: 'agent.updated', agentId });
    return policy;
  }

  async setStatus(agentId: string, status: 'active' | 'frozen', actor: string): Promise<Agent> {
    const agent = await withTx(this.db, async (tx) => {
      const { rows } = await tx.query<Agent>(
        'UPDATE agents SET status = $2 WHERE id = $1 RETURNING id, name, owner, status, api_key_prefix, created_at',
        [agentId, status],
      );
      if (!rows[0]) throw new HttpError(404, 'agent_not_found', 'Agent not found');
      await audit(tx, actor, status === 'frozen' ? 'agent.frozen' : 'agent.unfrozen', 'agent', agentId);
      return rows[0];
    });
    this.events.publish({ type: 'agent.updated', agentId });
    return agent;
  }
}

function fromRow(p: Policy): Required<PolicyUpdate> {
  return {
    perTxLimitCents: p.per_tx_limit_cents,
    dailyLimitCents: p.daily_limit_cents,
    monthlyLimitCents: p.monthly_limit_cents,
    approvalThresholdCents: p.approval_threshold_cents,
    allowedCategories: p.allowed_categories,
    blockedCategories: p.blocked_categories,
    merchantAllowlist: p.merchant_allowlist,
    velocityMax: p.velocity_max,
    velocityWindowSec: p.velocity_window_sec,
    injectionReviewScore: p.injection_review_score,
    injectionBlockScore: p.injection_block_score,
    intentCheck: p.intent_check,
  };
}

function validatePolicy(p: Required<PolicyUpdate>) {
  if (p.perTxLimitCents > p.dailyLimitCents) {
    throw new HttpError(400, 'invalid_policy', 'perTxLimitCents cannot exceed dailyLimitCents');
  }
  if (p.dailyLimitCents > p.monthlyLimitCents) {
    throw new HttpError(400, 'invalid_policy', 'dailyLimitCents cannot exceed monthlyLimitCents');
  }
  if (p.injectionReviewScore > p.injectionBlockScore) {
    throw new HttpError(400, 'invalid_policy', 'injectionReviewScore cannot exceed injectionBlockScore');
  }
}
