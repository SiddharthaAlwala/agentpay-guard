export type Status = 'approved' | 'blocked' | 'pending_approval' | 'rejected' | 'expired';

export interface Reason {
  rule: string;
  outcome: 'pass' | 'review' | 'block';
  message: string;
  risk: number;
}

export interface Payment {
  id: string;
  agentId: string;
  agentName?: string;
  merchant: string;
  category: string;
  amountCents: number;
  reason: string;
  userIntent: string | null;
  status: Status;
  riskScore: number;
  reasons: Reason[];
  decidedBy: string;
  latencyMs: number | null;
  createdAt: string;
  replay?: boolean;
}

export interface AgentRow {
  id: string;
  name: string;
  status: 'active' | 'frozen';
  api_key_prefix: string;
  spent_today_cents: number;
  reserved_today_cents: number;
  blocked_today: number;
  policy: {
    daily_limit_cents: number;
    per_tx_limit_cents: number;
    approval_threshold_cents: number;
    allowed_categories: string[];
    version: number;
  };
}

export interface Integrity {
  debitsCents: number;
  creditsCents: number;
  journals: number;
  balanced: boolean;
  reconciled: boolean;
  approvedPayments: number;
}

export interface Stats {
  totalRequests: number;
  blockedAmountCents: number;
  approvedAmountCents: number;
  statuses: Partial<Record<Status, { count: number; amountCents: number }>>;
  latencyMs?: { p50: number | null; p95: number | null };
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
}

export interface ScenarioResult {
  scenario: string;
  title: string;
  verdict: string;
  results: Payment[];
}

const TOKEN_KEY = 'agentpay.adminToken';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* storage unavailable */
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-admin-token': getToken(),
      'x-actor': 'dashboard',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message ?? `HTTP ${res.status}`), { status: res.status });
  return body as T;
}

export const api = {
  config: () => call<{ demoMode: boolean; llmClassifier: boolean; repoUrl: string | null }>('/v1/config'),
  agents: () => call<AgentRow[]>('/v1/admin/agents'),
  payments: () => call<Payment[]>('/v1/admin/payments?limit=80'),
  pending: () => call<Payment[]>('/v1/admin/payments?status=pending_approval&limit=50'),
  integrity: () => call<Integrity>('/v1/admin/ledger/integrity'),
  stats: () => call<Stats>('/v1/admin/stats'),
  scenarios: () => call<Scenario[]>('/v1/demo/scenarios'),
  run: (id: string) => call<ScenarioResult>(`/v1/demo/scenarios/${id}`, { method: 'POST', body: '{}' }),
  reset: () => call<{ status: string }>('/v1/demo/reset', { method: 'POST', body: '{}' }),
  review: (id: string, action: 'approve' | 'reject') =>
    call<Payment>(`/v1/admin/payments/${id}/${action}`, { method: 'POST', body: '{}' }),
  freeze: (id: string, frozen: boolean) =>
    call(`/v1/admin/agents/${id}/${frozen ? 'freeze' : 'unfreeze'}`, { method: 'POST', body: '{}' }),
  eventsUrl: () => `/v1/admin/events?token=${encodeURIComponent(getToken())}`,
};

export const usd = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
