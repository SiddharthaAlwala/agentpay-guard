-- AgentPay Guard: initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  owner           text NOT NULL DEFAULT 'demo-user',
  api_key_hash    text NOT NULL UNIQUE,
  api_key_prefix  text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One policy per agent. Versioned so every decision can point at the exact policy it used.
CREATE TABLE policies (
  agent_id                  uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  version                   integer NOT NULL DEFAULT 1,
  currency                  text    NOT NULL DEFAULT 'USD',
  per_tx_limit_cents        bigint  NOT NULL CHECK (per_tx_limit_cents > 0),
  daily_limit_cents         bigint  NOT NULL CHECK (daily_limit_cents > 0),
  monthly_limit_cents       bigint  NOT NULL CHECK (monthly_limit_cents > 0),
  approval_threshold_cents  bigint  NOT NULL CHECK (approval_threshold_cents > 0),
  allowed_categories        text[]  NOT NULL DEFAULT '{}',
  blocked_categories        text[]  NOT NULL DEFAULT '{gift_cards,crypto,wire_transfer,cash_equivalent}',
  merchant_allowlist        text[]  NOT NULL DEFAULT '{}',
  velocity_max              integer NOT NULL DEFAULT 5,
  velocity_window_sec       integer NOT NULL DEFAULT 60,
  injection_review_score    integer NOT NULL DEFAULT 30,
  injection_block_score     integer NOT NULL DEFAULT 60,
  intent_check              boolean NOT NULL DEFAULT true,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          uuid NOT NULL REFERENCES agents(id),
  idempotency_key   text NOT NULL,
  request_hash      text NOT NULL,
  merchant          text NOT NULL,
  category          text NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  currency          text NOT NULL,
  reason            text NOT NULL,
  user_intent       text,
  source_url        text,
  status            text NOT NULL CHECK (status IN ('approved', 'blocked', 'pending_approval', 'rejected', 'expired')),
  risk_score        integer NOT NULL DEFAULT 0,
  decision_reasons  jsonb NOT NULL DEFAULT '[]',
  policy_version    integer NOT NULL,
  decided_by        text NOT NULL DEFAULT 'policy-engine',
  review_note       text,
  latency_ms        numeric(10, 2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  -- The database is the final word on idempotency: a retry can never create a second payment.
  CONSTRAINT uq_agent_idempotency UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX idx_payments_agent_created ON payment_requests (agent_id, created_at DESC);
CREATE INDEX idx_payments_status ON payment_requests (status) WHERE status = 'pending_approval';
CREATE INDEX idx_payments_created ON payment_requests (created_at DESC);

-- Double-entry ledger. Every journal has entries whose debits equal its credits.
CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  journal_id    uuid NOT NULL,
  payment_id    uuid NOT NULL REFERENCES payment_requests(id),
  account       text NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_journal ON ledger_entries (journal_id);
CREATE INDEX idx_ledger_payment ON ledger_entries (payment_id);

-- The ledger is append-only: corrections are new journals, never edits.
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor       text NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
