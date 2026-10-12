-- Spend Guard schema.
-- Money is stored in integer micro-dollars (1 USD = 1,000,000 micros). A single token of a cheap
-- model costs a fraction of a cent, so cents are too coarse; integers avoid floating-point drift.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- People who sign in. GitHub login fills github_id in milestone 2; the CLI creates users by login.
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id   bigint UNIQUE,
  login       text NOT NULL UNIQUE,
  name        text,
  email       text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A project is one customer application. Budgets on the project cap all of its keys together.
CREATE TABLE projects (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               uuid NOT NULL REFERENCES users(id),
  name                   text NOT NULL,
  monthly_budget_micros  bigint CHECK (monthly_budget_micros >= 0),
  -- What to do with a model that is not in the price catalog: block it (safe default), or
  -- allow it and price it at the most expensive known model from the same provider.
  unknown_model_policy   text NOT NULL DEFAULT 'block' CHECK (unknown_model_policy IN ('block', 'max_price')),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_idx ON projects (owner_id);

-- The customer's real provider key, encrypted with AES-256-GCM. Agents never see it.
-- secret = 12-byte IV || 16-byte auth tag || ciphertext. key_id names the encryption key used,
-- so the master key can be rotated without re-encrypting everything at once.
CREATE TABLE provider_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  secret      bytea NOT NULL,
  key_id      text NOT NULL,
  last4       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, provider)
);

-- Keys we issue to agents. Only a SHA-256 hash is stored: the plaintext is shown once at creation.
-- A fast hash is enough because the keys are 190 bits of randomness (passwords need slow hashes
-- because people choose guessable ones).
CREATE TABLE api_keys (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  key_hash               text NOT NULL UNIQUE,
  prefix                 text NOT NULL,
  last4                  text NOT NULL,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'revoked')),
  daily_budget_micros    bigint CHECK (daily_budget_micros >= 0),
  monthly_budget_micros  bigint CHECK (monthly_budget_micros >= 0),
  max_request_micros     bigint CHECK (max_request_micros >= 0),
  rpm_limit              int CHECK (rpm_limit > 0),
  allowed_models         text[],
  -- Runaway-loop detection: block when the identical request repeats this often within the window.
  loop_max_repeats       int NOT NULL DEFAULT 20 CHECK (loop_max_repeats > 1),
  loop_window_sec        int NOT NULL DEFAULT 60 CHECK (loop_window_sec > 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_used_at           timestamptz,
  revoked_at             timestamptz
);
CREATE INDEX api_keys_project_idx ON api_keys (project_id);

-- Running totals per budget window. reserved = worst-case cost of requests still in flight;
-- spent = settled actual cost. A request is admitted only if spent + reserved + its worst case fits.
CREATE TABLE spend_counters (
  scope          text NOT NULL CHECK (scope IN ('key', 'project')),
  scope_id       uuid NOT NULL,
  period         text NOT NULL CHECK (period IN ('day', 'month')),
  period_start   date NOT NULL,
  spent_micros   bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  PRIMARY KEY (scope, scope_id, period, period_start)
);

-- One row per proxied request, including blocked ones. Metadata only: prompts and completions
-- are never stored.
CREATE TABLE usage_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         text NOT NULL,
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_id             uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  endpoint           text NOT NULL,
  model              text,
  stream             boolean NOT NULL DEFAULT false,
  -- reserved: in flight. settled: exact cost from the provider's usage numbers.
  -- estimated: provider usage unavailable (stream cut off, crash), cost estimated conservatively.
  -- blocked: refused by a limit, never sent. failed: provider returned an error, nothing billed.
  status             text NOT NULL CHECK (status IN ('reserved', 'settled', 'estimated', 'blocked', 'failed')),
  block_reason       text,
  http_status        int,
  reserved_micros    bigint NOT NULL DEFAULT 0,
  cost_micros        bigint NOT NULL DEFAULT 0,
  input_tokens       int,
  output_tokens      int,
  cache_read_tokens  int,
  cache_write_tokens int,
  period_day         date NOT NULL,
  period_month       date NOT NULL,
  latency_ms         int,
  created_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz
);
CREATE INDEX usage_events_project_time_idx ON usage_events (project_id, created_at DESC);
CREATE INDEX usage_events_key_time_idx ON usage_events (key_id, created_at DESC);
-- The sweeper looks for reservations that never settled (process crash mid-request).
CREATE INDEX usage_events_reserved_idx ON usage_events (created_at) WHERE status = 'reserved';
