import type { Agent, PaymentRequestInput, Policy, RuleOutcome, RuleResult } from '../domain.js';
import type { InjectionResult } from './injection.js';
import { checkIntent } from './intent.js';

export interface EvaluationContext {
  agent: Agent;
  policy: Policy;
  request: PaymentRequestInput;
  /** Approved + pending (reserved) spend for the current UTC day and month, excluding this request. */
  spentTodayCents: number;
  spentMonthCents: number;
  /** Requests by this agent in the current velocity window, including this one. */
  velocityCount: number;
  injection: InjectionResult;
}

export interface Decision {
  outcome: 'approved' | 'blocked' | 'pending_approval';
  riskScore: number;
  reasons: RuleResult[];
}

export type Rule = (ctx: EvaluationContext) => RuleResult | null;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const pass = (rule: string, message: string): RuleResult => ({ rule, outcome: 'pass', message, risk: 0 });

export const rules: Record<string, Rule> = {
  agent_active: ({ agent }) =>
    agent.status === 'frozen'
      ? { rule: 'agent_active', outcome: 'block', message: 'Agent is frozen by its owner (kill switch).', risk: 100 }
      : null,

  currency: ({ policy, request }) =>
    request.currency !== policy.currency
      ? {
          rule: 'currency',
          outcome: 'block',
          message: `Currency ${request.currency} not allowed; policy uses ${policy.currency}.`,
          risk: 30,
        }
      : null,

  per_tx_limit: ({ policy, request }) =>
    request.amountCents > policy.per_tx_limit_cents
      ? {
          rule: 'per_tx_limit',
          outcome: 'block',
          message: `${usd(request.amountCents)} exceeds the per-transaction limit of ${usd(policy.per_tx_limit_cents)}.`,
          risk: 40,
        }
      : null,

  daily_budget: ({ policy, request, spentTodayCents }) =>
    spentTodayCents + request.amountCents > policy.daily_limit_cents
      ? {
          rule: 'daily_budget',
          outcome: 'block',
          message: `Daily budget exhausted: ${usd(spentTodayCents)} already committed of ${usd(policy.daily_limit_cents)}.`,
          risk: 30,
        }
      : null,

  monthly_budget: ({ policy, request, spentMonthCents }) =>
    spentMonthCents + request.amountCents > policy.monthly_limit_cents
      ? {
          rule: 'monthly_budget',
          outcome: 'block',
          message: `Monthly budget of ${usd(policy.monthly_limit_cents)} would be exceeded.`,
          risk: 30,
        }
      : null,

  blocked_category: ({ policy, request }) =>
    policy.blocked_categories.includes(request.category)
      ? {
          rule: 'blocked_category',
          outcome: 'block',
          message: `Category "${request.category}" is never allowed for agents.`,
          risk: 60,
        }
      : null,

  allowed_category: ({ policy, request }) =>
    policy.allowed_categories.length > 0 && !policy.allowed_categories.includes(request.category)
      ? {
          rule: 'allowed_category',
          outcome: 'review',
          message: `Category "${request.category}" is outside this agent's scope.`,
          risk: 25,
        }
      : null,

  merchant_allowlist: ({ policy, request }) =>
    policy.merchant_allowlist.length > 0 && !policy.merchant_allowlist.includes(request.merchant.toLowerCase())
      ? {
          rule: 'merchant_allowlist',
          outcome: 'review',
          message: `Merchant "${request.merchant}" is not on the allowlist.`,
          risk: 20,
        }
      : null,

  velocity: ({ policy, velocityCount }) =>
    velocityCount > policy.velocity_max
      ? {
          rule: 'velocity',
          outcome: 'block',
          message: `${velocityCount} requests in ${policy.velocity_window_sec}s exceeds the limit of ${policy.velocity_max}. Possible runaway loop.`,
          risk: 50,
        }
      : null,

  prompt_injection: ({ policy, injection }) => {
    if (injection.score >= policy.injection_block_score) {
      return {
        rule: 'prompt_injection',
        outcome: 'block',
        message: `Likely prompt injection (score ${injection.score}): ${describe(injection)}.`,
        risk: injection.score,
      };
    }
    if (injection.score >= policy.injection_review_score) {
      return {
        rule: 'prompt_injection',
        outcome: 'review',
        message: `Suspicious language (score ${injection.score}): ${describe(injection)}.`,
        risk: injection.score,
      };
    }
    return null;
  },

  intent_drift: ({ policy, request }) => {
    if (!policy.intent_check) return null;
    const check = checkIntent(request.context.userIntent, request.reason, request.merchant, request.category);
    if (!check?.drift) return null;
    return {
      rule: 'intent_drift',
      outcome: 'review',
      message: `Purchase does not match the user's request ("${truncate(request.context.userIntent ?? '', 60)}").`,
      risk: 25,
    };
  },

  approval_threshold: ({ policy, request }) =>
    request.amountCents >= policy.approval_threshold_cents
      ? {
          rule: 'approval_threshold',
          outcome: 'review',
          message: `${usd(request.amountCents)} is at or above the human-approval threshold of ${usd(policy.approval_threshold_cents)}.`,
          risk: 10,
        }
      : null,
};

function describe(injection: InjectionResult): string {
  const ids = injection.signals.map((s) => s.id.replace(/_/g, ' '));
  if (injection.llmRationale) ids.push(`classifier: ${injection.llmRationale}`);
  return ids.join(', ') || 'classifier flagged';
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const SEVERITY: Record<RuleOutcome, number> = { pass: 0, review: 1, block: 2 };

/**
 * Evaluates every rule (no short-circuit), so the decision always explains *all* the problems,
 * not just the first. The most severe outcome wins.
 */
export function evaluate(ctx: EvaluationContext): Decision {
  const hits: RuleResult[] = [];
  for (const rule of Object.values(rules)) {
    const r = rule(ctx);
    if (r) hits.push(r);
  }
  const worst = hits.reduce<RuleOutcome>((w, r) => (SEVERITY[r.outcome] > SEVERITY[w] ? r.outcome : w), 'pass');
  const riskScore = Math.min(
    100,
    hits.reduce((s, r) => s + r.risk, 0),
  );
  const outcome = worst === 'block' ? 'blocked' : worst === 'review' ? 'pending_approval' : 'approved';
  const reasons = hits.length > 0 ? hits : [pass('all_checks', 'All policy checks passed.')];
  return { outcome, riskScore, reasons };
}
