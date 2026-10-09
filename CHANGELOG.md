# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
