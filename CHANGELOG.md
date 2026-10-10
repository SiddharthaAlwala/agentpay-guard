# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Step-by-step decision tracing at `LOG_LEVEL=debug` (`1/7` … `7/7`), with readable colored logs in local development.
- `api.http` with 30+ manual test cases for the VS Code REST Client extension.
- Shared VS Code setup: debug configurations for the API, tests and MCP server; recommended extensions; format on save.

### Fixed

- The guard no longer exits when Postgres restarts or drops pooled connections; it logs a warning and
  reconnects on the next query. Requests fail after 5 s instead of hanging when the database is unreachable.

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
