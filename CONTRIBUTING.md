# Contributing

## Setup

```bash
nvm use                 # Node 22 (see .nvmrc)
npm install
docker compose up -d postgres redis
cp .env.example .env
npm run dev             # guard on :8080
npm run dev:dashboard   # dashboard on :5173
```

## Before opening a pull request

```bash
npm run check           # lint, format check, typecheck, tests
```

CI runs the same checks plus a Docker build and smoke test, and must be green to merge.

## Conventions

- Branches: `feat/...`, `fix/...`, `docs/...`, `chore/...`
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(guard): add merchant cooldown rule`
- Any change to a money path (policy engine, payments service, ledger) needs a test that proves the invariant,
  not just the happy path: concurrency, retries, and the ledger balancing afterwards.
- Schema changes go in a new numbered file in `apps/guard/migrations/`; never edit an applied migration.
