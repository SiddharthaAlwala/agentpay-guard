-- Runs once, on first start of the Compose Postgres container.
-- The integration tests use their own database so they never touch dev data.
CREATE DATABASE agentpay_test;
