import { credentialContext, generateApiKey, hashApiKey, KEY_PREFIX, type Vault } from '../crypto.js';
import type { Db } from '../db.js';
import type { Provider } from '../pricing/catalog.js';
import { periods } from './budget.js';

export interface KeyLimits {
  dailyBudgetMicros?: number | null;
  monthlyBudgetMicros?: number | null;
  maxRequestMicros?: number | null;
  rpmLimit?: number | null;
  allowedModels?: string[] | null;
  loopMaxRepeats?: number;
  loopWindowSec?: number;
}

/**
 * Account management: the operations the dashboard will call in milestone 2.
 * For now they are driven by the CLI (src/cli.ts).
 */
export class AdminService {
  constructor(
    private db: Db,
    private vault: Vault,
  ) {}

  async upsertUser(login: string, extra: { githubId?: number; name?: string; email?: string } = {}) {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO users (login, github_id, name, email) VALUES ($1, $2, $3, $4)
       ON CONFLICT (login) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name),
                                         email = COALESCE(EXCLUDED.email, users.email)
       RETURNING id`,
      [login, extra.githubId ?? null, extra.name ?? null, extra.email ?? null],
    );
    return rows[0]!.id;
  }

  async createProject(ownerId: string, name: string, monthlyBudgetMicros: number | null = null) {
    const { rows } = await this.db.query<{ id: string }>(
      'INSERT INTO projects (owner_id, name, monthly_budget_micros) VALUES ($1, $2, $3) RETURNING id',
      [ownerId, name, monthlyBudgetMicros],
    );
    return rows[0]!.id;
  }

  async updateProject(
    projectId: string,
    patch: { monthlyBudgetMicros?: number | null; unknownModelPolicy?: 'block' | 'max_price' },
  ) {
    await this.db.query(
      `UPDATE projects SET
         monthly_budget_micros = CASE WHEN $2 THEN $3::bigint ELSE monthly_budget_micros END,
         unknown_model_policy = COALESCE($4, unknown_model_policy)
       WHERE id = $1`,
      [
        projectId,
        patch.monthlyBudgetMicros !== undefined,
        patch.monthlyBudgetMicros ?? null,
        patch.unknownModelPolicy ?? null,
      ],
    );
  }

  /** Stores (or replaces) a project's provider key. Only the last 4 characters stay readable. */
  async setProviderKey(projectId: string, provider: Provider, plaintext: string) {
    const { secret, keyId } = this.vault.encrypt(plaintext, credentialContext(projectId, provider));
    await this.db.query(
      `INSERT INTO provider_credentials (project_id, provider, secret, key_id, last4) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, provider) DO UPDATE
          SET secret = EXCLUDED.secret, key_id = EXCLUDED.key_id, last4 = EXCLUDED.last4, updated_at = now()`,
      [projectId, provider, secret, keyId, plaintext.slice(-4)],
    );
  }

  /** Returns the plaintext key exactly once. Only its hash is stored. */
  async createKey(projectId: string, name: string, limits: KeyLimits = {}) {
    const key = generateApiKey();
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO api_keys (project_id, name, key_hash, prefix, last4, daily_budget_micros, monthly_budget_micros,
                             max_request_micros, rpm_limit, allowed_models, loop_max_repeats, loop_window_sec)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 20), COALESCE($12, 60)) RETURNING id`,
      [
        projectId,
        name,
        hashApiKey(key),
        key.slice(0, KEY_PREFIX.length + 4),
        key.slice(-4),
        limits.dailyBudgetMicros ?? null,
        limits.monthlyBudgetMicros ?? null,
        limits.maxRequestMicros ?? null,
        limits.rpmLimit ?? null,
        limits.allowedModels ?? null,
        limits.loopMaxRepeats ?? null,
        limits.loopWindowSec ?? null,
      ],
    );
    return { id: rows[0]!.id, key };
  }

  async updateKeyLimits(keyId: string, limits: KeyLimits) {
    const cols: Record<keyof KeyLimits, string> = {
      dailyBudgetMicros: 'daily_budget_micros',
      monthlyBudgetMicros: 'monthly_budget_micros',
      maxRequestMicros: 'max_request_micros',
      rpmLimit: 'rpm_limit',
      allowedModels: 'allowed_models',
      loopMaxRepeats: 'loop_max_repeats',
      loopWindowSec: 'loop_window_sec',
    };
    const sets: string[] = [];
    const values: unknown[] = [keyId];
    for (const [field, value] of Object.entries(limits)) {
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${cols[field as keyof KeyLimits]} = $${values.length}`);
    }
    if (sets.length) await this.db.query(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = $1`, values);
  }

  /** Kill switch. Takes effect on the next request: every request re-reads the key's status. */
  async setKeyStatus(keyId: string, status: 'active' | 'frozen' | 'revoked') {
    const { rowCount } = await this.db.query(
      `UPDATE api_keys SET status = $2, revoked_at = CASE WHEN $2 = 'revoked' THEN now() ELSE revoked_at END
        WHERE id = $1 AND status <> 'revoked'`,
      [keyId, status],
    );
    return (rowCount ?? 0) > 0;
  }

  async listKeys(projectId: string) {
    const p = periods();
    const { rows } = await this.db.query(
      `SELECT k.id, k.name, k.prefix || '…' || k.last4 AS display, k.status, k.daily_budget_micros,
              k.monthly_budget_micros, k.max_request_micros, k.rpm_limit, k.allowed_models, k.last_used_at,
              COALESCE(d.spent_micros, 0) AS spent_today_micros, COALESCE(m.spent_micros, 0) AS spent_month_micros
         FROM api_keys k
         LEFT JOIN spend_counters d ON d.scope = 'key' AND d.scope_id = k.id AND d.period = 'day' AND d.period_start = $2
         LEFT JOIN spend_counters m ON m.scope = 'key' AND m.scope_id = k.id AND m.period = 'month' AND m.period_start = $3
        WHERE k.project_id = $1 ORDER BY k.created_at`,
      [projectId, p.day, p.month],
    );
    return rows;
  }

  async usageByModel(projectId: string, since: Date) {
    const { rows } = await this.db.query(
      `SELECT provider, model, count(*)::int AS requests,
              count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
              COALESCE(sum(cost_micros), 0)::bigint AS cost_micros,
              COALESCE(sum(input_tokens), 0)::bigint AS input_tokens,
              COALESCE(sum(output_tokens), 0)::bigint AS output_tokens
         FROM usage_events WHERE project_id = $1 AND created_at >= $2
        GROUP BY provider, model ORDER BY cost_micros DESC`,
      [projectId, since],
    );
    return rows;
  }

  async recentEvents(projectId: string, limit = 20) {
    const { rows } = await this.db.query(
      `SELECT e.created_at, k.name AS key, e.provider, e.model, e.stream, e.status, e.block_reason, e.http_status,
              e.reserved_micros, e.cost_micros, e.input_tokens, e.output_tokens, e.latency_ms
         FROM usage_events e JOIN api_keys k ON k.id = e.key_id
        WHERE e.project_id = $1 ORDER BY e.created_at DESC LIMIT $2`,
      [projectId, limit],
    );
    return rows;
  }
}
