export interface Decision {
  id: string;
  status: 'approved' | 'blocked' | 'pending_approval' | 'rejected' | 'expired';
  merchant: string;
  amountCents: number;
  riskScore: number;
  reasons: Array<{ rule: string; outcome: string; message: string }>;
  replay?: boolean;
}

export interface Budget {
  daily: { limitCents: number; remainingCents: number };
  monthly: { limitCents: number; remainingCents: number };
  perTransactionLimitCents: number;
  approvalThresholdCents: number;
  allowedCategories: string[];
  blockedCategories: string[];
}

/** Thin, dependency-free HTTP client for the AgentPay Guard agent API. */
export class GuardClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, ...(init.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
    return body;
  }

  requestPayment(body: unknown, idempotencyKey: string) {
    return this.call<Decision>('/v1/payments', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'idempotency-key': idempotencyKey },
    });
  }

  budget() {
    return this.call<Budget>('/v1/budget');
  }

  payment(id: string) {
    return this.call<Decision>(`/v1/payments/${encodeURIComponent(id)}`);
  }
}

/** Phrases the decision as an instruction the model will follow, not just data. */
export function formatDecision(d: Decision): string {
  const amount = `$${(d.amountCents / 100).toFixed(2)} to ${d.merchant}`;
  const why = d.reasons
    .filter((r) => r.outcome !== 'pass')
    .map((r) => `- ${r.message}`)
    .join('\n');
  const replay = d.replay ? ' (this was a duplicate of an earlier identical request; nothing new was charged)' : '';
  switch (d.status) {
    case 'approved':
      return `APPROVED: ${amount}${replay}. Payment id ${d.id}.`;
    case 'pending_approval':
      return `HELD FOR THE USER'S APPROVAL: ${amount}. Payment id ${d.id}.\n${why}\nTell the user it is waiting for their approval in the AgentPay dashboard. Do not retry or split the purchase.`;
    case 'blocked':
      return `BLOCKED: ${amount} was refused by the user's spending policy.\n${why}\nDo not try to work around this (no retries, no different merchant or category, no splitting). Explain the reason to the user.`;
    default:
      return `${d.status.toUpperCase()}: ${amount}. Payment id ${d.id}.`;
  }
}
