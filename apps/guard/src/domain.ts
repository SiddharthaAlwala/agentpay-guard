import { z } from 'zod';

export const PaymentStatus = ['approved', 'blocked', 'pending_approval', 'rejected', 'expired'] as const;
export type PaymentStatus = (typeof PaymentStatus)[number];

export type RuleOutcome = 'pass' | 'review' | 'block';

export interface RuleResult {
  rule: string;
  outcome: RuleOutcome;
  message: string;
  /** Contribution to the overall risk score (0-100). */
  risk: number;
}

export interface Agent {
  id: string;
  name: string;
  owner: string;
  status: 'active' | 'frozen';
  api_key_prefix: string;
  created_at: string;
}

export interface Policy {
  agent_id: string;
  version: number;
  currency: string;
  per_tx_limit_cents: number;
  daily_limit_cents: number;
  monthly_limit_cents: number;
  approval_threshold_cents: number;
  allowed_categories: string[];
  blocked_categories: string[];
  merchant_allowlist: string[];
  velocity_max: number;
  velocity_window_sec: number;
  injection_review_score: number;
  injection_block_score: number;
  intent_check: boolean;
}

export interface PaymentRow {
  id: string;
  agent_id: string;
  idempotency_key: string;
  request_hash: string;
  merchant: string;
  category: string;
  amount_cents: number;
  currency: string;
  reason: string;
  user_intent: string | null;
  source_url: string | null;
  status: PaymentStatus;
  risk_score: number;
  decision_reasons: RuleResult[];
  policy_version: number;
  decided_by: string;
  review_note: string | null;
  latency_ms: number | null;
  created_at: string;
  decided_at: string | null;
}

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/, 'use lowercase letters, digits, - or _');

export const PaymentRequestSchema = z.object({
  merchant: z.string().trim().min(1).max(200),
  category: slug,
  amountCents: z.number().int().positive().max(100_000_000),
  currency: z.string().length(3).toUpperCase().default('USD'),
  reason: z.string().trim().min(1).max(2000),
  context: z
    .object({
      /** The human's original instruction to the agent. Used to detect intent drift. */
      userIntent: z.string().max(2000).optional(),
      /** Where the agent was when it decided to pay (product page, email...). */
      sourceUrl: z.string().max(2000).optional(),
    })
    .default({}),
});
export type PaymentRequestInput = z.infer<typeof PaymentRequestSchema>;

export const PolicyUpdateSchema = z
  .object({
    perTxLimitCents: z.number().int().positive(),
    dailyLimitCents: z.number().int().positive(),
    monthlyLimitCents: z.number().int().positive(),
    approvalThresholdCents: z.number().int().positive(),
    allowedCategories: z.array(slug),
    blockedCategories: z.array(slug),
    merchantAllowlist: z.array(z.string().trim().toLowerCase().min(1)),
    velocityMax: z.number().int().positive().max(10_000),
    velocityWindowSec: z.number().int().positive().max(86_400),
    injectionReviewScore: z.number().int().min(0).max(100),
    injectionBlockScore: z.number().int().min(0).max(100),
    intentCheck: z.boolean(),
  })
  .partial();
export type PolicyUpdate = z.infer<typeof PolicyUpdateSchema>;

export const CreateAgentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  owner: z.string().trim().min(1).max(100).default('demo-user'),
  policy: PolicyUpdateSchema.default({}),
});

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
