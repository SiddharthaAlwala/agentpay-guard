# Spend Guard proxy

Budgets for AI agents' OpenAI and Anthropic usage, enforced **before** the money is spent.

An agent left running overnight can loop, retry forever or switch to an expensive model, and the
provider bill shows it the next morning. Provider spending limits apply to a whole account. Spend
Guard sits between your agents and the provider and gives every agent its own key with its own
limits.

```python
# Before
client = Anthropic(api_key="sk-ant-...")
# After: one changed line, one different key
client = Anthropic(base_url="https://<your-spend-guard>/anthropic", api_key="apg_live_...")
```

```ts
const openai = new OpenAI({ baseURL: 'https://<your-spend-guard>/openai/v1', apiKey: 'apg_live_...' });
```

## What it enforces, per agent key

| Limit                   | What happens when it's hit                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| Daily / monthly budget  | `429`, with `x-should-retry: false` so SDKs don't retry a budget that's used up |
| Project monthly budget  | Same, shared across all of a project's keys                                      |
| Max cost per request    | `400` before sending, if the request's worst case is above the limit             |
| Requests per minute     | `429` with `retry-after`                                                         |
| Allowed models          | `403`                                                                            |
| Runaway loop            | `429` when the identical request repeats N times within a window                 |
| Kill switch (freeze)    | `403` on the very next request                                                   |
| Unknown model           | `400` by default, because a model it can't price is a budget it can't enforce   |

Errors come back in the provider's own JSON format, so the official SDKs raise their usual
exception classes (`RateLimitError`, `PermissionDeniedError`, …) and existing error handling keeps
working.

Supported endpoints: Anthropic `POST /v1/messages` (streaming included), `POST
/v1/messages/count_tokens`, `GET /v1/models`; OpenAI `POST /v1/chat/completions` and `POST
/v1/responses` (streaming included), `GET /v1/models`. Anything else gets a clear 404.

## How a request flows

```
agent ──apg_live_ key──▶ Spend Guard ──real provider key──▶ Anthropic / OpenAI
                           │  1. find key by SHA-256 hash (one indexed query, decrypts provider key)
                           │  2. key status, allowed models, price lookup
                           │  3. rate + loop limits (one Redis Lua call)
                           │  4. reserve the worst-case cost (Postgres)
                           │  5. forward; stream events back byte for byte
                           │  6. read real usage → settle the exact cost
```

**Reserve, then settle.** Before forwarding, the proxy reserves the most the request could cost:
the estimated prompt plus the full `max_tokens`, at the model's price. The request is admitted
only if `spent + reserved + this reservation ≤ budget`, checked while holding a row lock on the
budget's owner. When the provider answers, its usage numbers give the exact cost, which replaces
the reservation. Without the reservation, 20 parallel requests would each see the same remaining
budget and overspend it together. The integration test fires 12 parallel calls at a budget with
room for exactly 5, and exactly 5 get through.

**Exact money.** Amounts are integer micro-dollars. Prices are converted to integer thousandths of a
micro-dollar per token, so the arithmetic has no floating-point drift, and the total is rounded up
once. Cached input, cache writes (5-minute and 1-hour), long-context pricing above 200K tokens and
Anthropic web searches are each billed at their own rate.

**Streams.** Events are passed through as they arrive, in their original bytes. The proxy reads
usage from them on the way (`message_start`/`message_delta` for Anthropic, the final usage chunk
for Chat Completions, `response.completed` for Responses). Chat Completions only reports usage in
a stream when asked, so the proxy asks (`stream_options.include_usage`), and hides that extra chunk
from clients that didn't ask for it themselves.

**When something goes wrong:**

| Situation                                 | Behaviour                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Provider rejects the request (4xx/5xx)    | Error passed through untouched; nothing billed                                                 |
| Provider unreachable (connection refused) | `502`, nothing billed (the request provably never arrived)                                     |
| Client disconnects mid-stream             | Provider call cancelled immediately; cost estimated from what was streamed                     |
| Timeout or unknown failure mid-request    | Charged at the reserved worst case: budgets err on the safe side                               |
| Proxy crashes mid-request                 | Reservation stays; a sweeper settles it at the worst case after 15 minutes                     |
| Postgres down                             | `503`, nothing forwarded (fail closed: budgets can't be enforced without it)                   |
| Redis down                                | Rate and loop limits pause; budgets keep working (fail open on the soft limits only)          |
| Shutdown / deploy                         | Stops accepting connections, finishes in-flight requests and their bookkeeping, then exits    |

## Security

- **Agents never hold the real provider key.** The customer gives it to Spend Guard once; it is
  stored encrypted with AES-256-GCM. Authenticated encryption means tampering is detected, and the
  ciphertext is bound to its project and provider, so copying it into another project's row makes
  decryption fail. Master keys carry an id, so they can be rotated without re-encrypting everything.
- **Spend Guard keys are stored only as SHA-256 hashes.** A fast hash is fine because each key has
  ~190 bits of randomness; slow hashes exist for guessable human passwords.
- **Metadata only.** Prompts and completions are never stored or logged. Auth headers are redacted
  from logs. `/metrics` can be protected with `METRICS_TOKEN`.
- Sending a raw provider key to the proxy is refused with an explanation.

## Run it locally

Needs Postgres and Redis (`docker compose up postgres redis` from the repo root works; if your
Compose volume already existed, create the databases once: `CREATE DATABASE spendguard;
CREATE DATABASE spendguard_test;`).

```bash
cp .env.proxy.example .env.proxy
npm run dev:proxy                                  # http://localhost:8090

# create an account, store your Anthropic key encrypted, and issue an agent key with limits
export ANTHROPIC_API_KEY=sk-ant-...                # read from the environment, never a flag
npm run cli -w apps/proxy -- setup --login you --project "My agent" --provider anthropic \
  --name nightly-job --daily 2 --max-request 0.25 --rpm 30

npm run cli -w apps/proxy -- usage --project <project id>     # spend by key and model, latest requests
npm run cli -w apps/proxy -- freeze --key <key id>            # kill switch (unfreeze / revoke too)
npm run cli -w apps/proxy -- limits --key <key id> --daily 5 --models claude-haiku-4-5
npm run cli -w apps/proxy -- prices                           # the price table and when it was verified
```

`proxy.http` in the repo root has ready-made requests for the VS Code REST Client.

## Tests and numbers

`npm test -w apps/proxy` runs 53 tests against real Postgres and Redis. The integration tests drive
the proxy with the **official OpenAI and Anthropic SDKs** against a local fake provider, so they
prove that real client code works unchanged: streaming, error classes, retry behaviour.

`npm run bench -w apps/proxy` measures the overhead against the same fake provider. On a 2-vCPU
sandbox that also ran Postgres, Redis, the fake provider and the load generator:

| Path                    | Added latency, p50 (sequential) |
| ----------------------- | ------------------------------- |
| Key with no budgets     | ~3 ms                           |
| Key with budgets        | ~4 ms                           |

12,000 requests at concurrency 20 settled to exactly 12,000 × the expected cost with zero
reservations left open. Real provider calls take hundreds of milliseconds to minutes, so the proxy
adds well under 1% to a typical request.

## Known limits (v1)

- **Prices are checked by hand.** `src/pricing/catalog.ts` was last verified against the official
  pages on 2026-10-16 (`npm run cli -w apps/proxy -- prices` shows the date). Re-check monthly and on
  every model launch or retirement; `gpt-5.6-sol` is on a promotional price until at least 2026-11-21.
  Unknown models are blocked by default.
- The prompt-size estimate (used only for the reservation) is conservative but not a tokenizer. A
  request whose real prompt exceeds the estimate can overshoot a budget by that difference, once.
- For OpenAI streams cut off before the end, hidden reasoning tokens can't be seen, so the estimate
  may be low.
- OpenAI `background` responses, the Batch APIs, embeddings, images and audio aren't proxied yet.
  Service-tier pricing (OpenAI flex/priority) and OpenAI built-in tool fees aren't modelled yet.
- Requests sharing a budget are serialized while reserving (~4 ms each), which caps one budgeted key
  at roughly 250 reservations per second.
- Budget windows are UTC days and months.
