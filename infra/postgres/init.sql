-- Runs once, on first start of the Compose Postgres container.
-- The integration tests use their own database so they never touch dev data.
CREATE DATABASE agentpay_test;
-- Spend Guard proxy (apps/proxy) keeps its own databases.
CREATE DATABASE spendguard;
CREATE DATABASE spendguard_test;
