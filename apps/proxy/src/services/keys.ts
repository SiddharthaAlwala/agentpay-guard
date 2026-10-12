import { credentialContext, hashApiKey, type Vault } from '../crypto.js';
import type { Db } from '../db.js';
import type { Provider } from '../pricing/catalog.js';

export interface KeyContext {
  keyId: string;
  keyName: string;
  projectId: string;
  status: 'active' | 'frozen' | 'revoked';
  dailyBudgetMicros: number | null;
  monthlyBudgetMicros: number | null;
  maxRequestMicros: number | null;
  rpmLimit: number | null;
  allowedModels: string[] | null;
  loopMaxRepeats: number;
  loopWindowSec: number;
  projectMonthlyBudgetMicros: number | null;
  unknownModelPolicy: 'block' | 'max_price';
  /** The customer's real provider key, decrypted only for the duration of this request. */
  providerKey: string | null;
}

interface Row {
  id: string;
  name: string;
  project_id: string;
  status: KeyContext['status'];
  daily_budget_micros: number | null;
  monthly_budget_micros: number | null;
  max_request_micros: number | null;
  rpm_limit: number | null;
  allowed_models: string[] | null;
  loop_max_repeats: number;
  loop_window_sec: number;
  project_monthly_budget_micros: number | null;
  unknown_model_policy: KeyContext['unknownModelPolicy'];
  secret: Buffer | null;
  enc_key_id: string | null;
}

export class KeyStore {
  constructor(
    private db: Db,
    private vault: Vault,
  ) {}

  /** One indexed query: the key, its project's settings and the matching provider credential. */
  async resolve(plaintextKey: string, provider: Provider): Promise<KeyContext | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT k.id, k.name, k.project_id, k.status, k.daily_budget_micros, k.monthly_budget_micros,
              k.max_request_micros, k.rpm_limit, k.allowed_models, k.loop_max_repeats, k.loop_window_sec,
              p.monthly_budget_micros AS project_monthly_budget_micros, p.unknown_model_policy,
              c.secret, c.key_id AS enc_key_id
         FROM api_keys k
         JOIN projects p ON p.id = k.project_id
         LEFT JOIN provider_credentials c ON c.project_id = k.project_id AND c.provider = $2
        WHERE k.key_hash = $1`,
      [hashApiKey(plaintextKey), provider],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      keyId: r.id,
      keyName: r.name,
      projectId: r.project_id,
      status: r.status,
      dailyBudgetMicros: r.daily_budget_micros,
      monthlyBudgetMicros: r.monthly_budget_micros,
      maxRequestMicros: r.max_request_micros,
      rpmLimit: r.rpm_limit,
      allowedModels: r.allowed_models,
      loopMaxRepeats: r.loop_max_repeats,
      loopWindowSec: r.loop_window_sec,
      projectMonthlyBudgetMicros: r.project_monthly_budget_micros,
      unknownModelPolicy: r.unknown_model_policy,
      providerKey:
        r.secret && r.enc_key_id
          ? this.vault.decrypt(r.secret, r.enc_key_id, credentialContext(r.project_id, provider))
          : null,
    };
  }
}
