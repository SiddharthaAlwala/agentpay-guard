# Security policy

AgentPay Guard is a portfolio project and demo; it has not been audited and does not move real money.
Demo mode (`DEMO_MODE=true`) intentionally opens the admin controls and uses public demo API keys.
Never run demo mode with real payment credentials.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** on this
repository rather than opening a public issue. Include steps to reproduce and the commit you tested.

Bypasses of the policy engine (a payment approved that policy should have blocked, a double charge, a
ledger imbalance) count as security issues.
