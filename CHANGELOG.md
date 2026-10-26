# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Spend Guard proxy** (`apps/proxy`): per-agent budgets for OpenAI and Anthropic API usage.
  - Drop-in: point the official SDK at the proxy and use an `apg_live_` key; streaming supported for
    Anthropic Messages, OpenAI Chat Completions and Responses.
  - Reserve-then-settle accounting in integer micro-dollars: worst-case cost reserved under a row lock,
    exact cost settled from provider usage (cache reads/writes, long context, web search priced separately).
  - Daily, monthly, project-wide and per-request budgets; requests-per-minute; allowed models; runaway-loop
    detection; kill switch. Errors in each provider's own format, with `x-should-retry: false` on budget blocks.
  - Customers' provider keys encrypted with AES-256-GCM (bound to project and provider, rotatable master keys);
    issued keys stored as SHA-256 hashes; prompts never stored.
  - Client disconnects cancel the provider call; orphaned reservations are swept at their worst case.
  - Operator CLI, `proxy.http` manual tests, overhead benchmark, Docker target `proxy`, CI job.
  - Price catalog verified against the official pages (2026-10-16): 16 Anthropic and 17 OpenAI models,
    including Claude 5.5 and OpenAI gpt-6; retired models removed.

### Fixed

- **Spend Guard proxy:** OpenAI cache writes (GPT-5.6 and later) are billed at 1.25× the input rate
  instead of the plain input rate, and every OpenAI request reserves for a possible cache write.
- **Spend Guard proxy:** Claude Sonnet 4.5 no longer carries a long-prompt surcharge that Anthropic
  removed; Claude Haiku 5.5's surcharge above 100K prompt tokens is applied.
- **Spend Guard proxy:** `cli prices` no longer needs a database.

- Step-by-step decision tracing at `LOG_LEVEL=debug` (`1/7` … `7/7`), with readable colored logs in local development.
- `api.http` with 30+ manual test cases for the VS Code REST Client extension.
- Shared VS Code setup: debug configurations for the API, tests and MCP server; recommended extensions; format on save.

### Fixed

- The guard no longer exits when Postgres restarts or drops pooled connections; it logs a warning and
  reconnects on the next query. Requests fail after 5 s instead of hanging when the database is unreachable.

- The payment log no longer says "replaying original decision" when an idempotency key is reused for a different request; it now logs a warning matching the 409 response.

### Changed

- Demo shopping agent's velocity limit raised from 5 to 10 per minute so manual test runs don't trip it.

## [1.0.0] - 2026-10-09

### Added

- Guard service: 12-rule policy engine (budgets, per-transaction limit, category scope, merchant allowlist,
  velocity, prompt-injection detection, intent drift, human-approval threshold, kill switch).
- Exactly-once payments with required `Idempotency-Key`, per-agent row locking and a unique constraint.
- Append-only double-entry ledger with integrity and reconciliation endpoint.
- Human approval queue with expiry, versioned policies and an audit log.
- Optional Claude classifier as a second opinion for prompt injection.
- MCP server exposing `request_payment`, `check_budget` and `get_payment_status`.
- Demo shopping agent built on Claude and the MCP server.
- React dashboard with live decisions (SSE over Redis pub/sub), attack scenarios, approvals and freeze controls.
- OpenAPI docs, Prometheus metrics, Grafana dashboard, k6 and Node load tests.
- Docker image, Docker Compose stack, GitHub Actions CI and Render blueprint.
