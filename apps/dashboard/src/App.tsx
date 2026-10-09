import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  getToken,
  setToken,
  usd,
  type AgentRow,
  type Integrity,
  type Payment,
  type Scenario,
  type ScenarioResult,
  type Stats,
  type Status,
} from './api';

const STAMP: Record<Status, string> = {
  approved: 'Approved',
  blocked: 'Blocked',
  pending_approval: 'Held',
  rejected: 'Rejected',
  expired: 'Expired',
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function App() {
  const [config, setConfig] = useState<{ demoMode: boolean; llmClassifier: boolean; repoUrl: string | null } | null>(
    null,
  );
  const [needsToken, setNeedsToken] = useState(false);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [pending, setPending] = useState<Payment[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<ScenarioResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const groups = groupBursts(payments);

  const refresh = useCallback(async () => {
    try {
      const [p, q, a, i, s] = await Promise.all([
        api.payments(),
        api.pending(),
        api.agents(),
        api.integrity(),
        api.stats(),
      ]);
      const first = seen.current.size === 0;
      const newIds = new Set(p.filter((x) => !seen.current.has(x.id)).map((x) => x.id));
      p.forEach((x) => seen.current.add(x.id));
      if (!first) setFresh(newIds);
      setPayments(p);
      setPending(q);
      setAgents(a);
      setIntegrity(i);
      setStats(s);
      setNeedsToken(false);
      setError(null);
    } catch (e) {
      if ((e as { status?: number }).status === 401) setNeedsToken(true);
      else setError(`Can't reach the guard service: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setError("Can't reach the guard service."));
  }, []);

  useEffect(() => {
    if (!config) return;
    refresh();
    if (config.demoMode)
      api
        .scenarios()
        .then(setScenarios)
        .catch(() => undefined);
  }, [config, refresh]);

  // Live updates: any decision anywhere triggers one debounced refresh.
  useEffect(() => {
    if (!config || needsToken) return;
    let timer: number | undefined;
    const es = new EventSource(api.eventsUrl());
    const poke = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 250);
    };
    es.addEventListener('hello', () => setLive(true));
    for (const t of ['payment.decided', 'payment.reviewed', 'agent.updated', 'demo.reset'])
      es.addEventListener(t, poke);
    es.onerror = () => setLive(false);
    return () => {
      es.close();
      window.clearTimeout(timer);
    };
  }, [config, needsToken, refresh]);

  const run = async (id: string) => {
    setRunning(id);
    setVerdict(null);
    try {
      setVerdict(await api.run(id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
      refresh();
    }
  };

  const review = async (id: string, action: 'approve' | 'reject') => {
    try {
      await api.review(id, action);
    } catch (e) {
      setError((e as Error).message);
    }
    refresh();
  };

  const toggleFreeze = async (a: AgentRow) => {
    await api.freeze(a.id, a.status === 'active').catch((e: Error) => setError(e.message));
    refresh();
  };

  const reset = async () => {
    seen.current.clear();
    setVerdict(null);
    await api.reset().catch((e: Error) => setError(e.message));
    refresh();
  };

  if (needsToken)
    return (
      <TokenGate
        onSave={(t) => {
          setToken(t);
          refresh();
        }}
      />
    );

  return (
    <div className="page">
      <header className="masthead">
        <div className="brand">
          <Shield />
          <span>AgentPay Guard</span>
        </div>
        <LedgerSeal integrity={integrity} />
        <div className="mast-meta">
          <span className={`live ${live ? 'on' : ''}`}>{live ? 'Live' : 'Connecting'}</span>
          <a href="/docs" target="_blank" rel="noreferrer">
            API docs
          </a>
          {config?.repoUrl && (
            <a href={config.repoUrl} target="_blank" rel="noreferrer">
              Source
            </a>
          )}
        </div>
      </header>

      <section className="intro">
        <h1>Your AI agents can spend money. This decides when they shouldn't.</h1>
        <p>
          Every payment an agent attempts passes through a policy engine first: budgets, merchant and category rules,
          runaway-loop limits, prompt-injection detection and a human approval step. Approved payments are written to a
          double-entry ledger that has to balance to the cent.
        </p>
        {config?.demoMode && (
          <p className="hint">Pick an attack under “Try to break it” and watch the decision land in the feed.</p>
        )}
      </section>

      {stats && (
        <dl className="figures">
          <div>
            <dt>Requests decided</dt>
            <dd>{stats.totalRequests.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Money stopped</dt>
            <dd className="neg">{usd(stats.blockedAmountCents)}</dd>
          </div>
          <div>
            <dt>Money allowed</dt>
            <dd>{usd(stats.approvedAmountCents)}</dd>
          </div>
          <div>
            <dt>Median decision time</dt>
            <dd>{stats.latencyMs?.p50 != null ? `${Math.round(stats.latencyMs.p50)} ms` : 'n/a'}</dd>
          </div>
        </dl>
      )}

      {error && (
        <div className="error" role="alert">
          {error}{' '}
          <button
            onClick={() => {
              setError(null);
              refresh();
            }}
          >
            Retry
          </button>
        </div>
      )}

      <main className="grid">
        <section className="feed" aria-labelledby="feed-title">
          <div className="section-head">
            <h2 id="feed-title">Decisions</h2>
            {config?.demoMode && (
              <button className="quiet" onClick={reset}>
                Clear demo data
              </button>
            )}
          </div>

          {verdict && (
            <div className="verdict" role="status">
              <strong>{verdict.title}.</strong> {verdict.verdict}
            </div>
          )}

          {payments.length === 0 ? (
            <p className="empty">
              No payment requests yet.{' '}
              {config?.demoMode
                ? 'Run a scenario to send some.'
                : 'Point an agent at POST /v1/payments to see decisions here.'}
            </p>
          ) : (
            <>
              <ol className="rows">
                {groups.slice(0, showAll ? undefined : 20).map((g) => (
                  <FeedRow key={g.first.id} p={g.first} count={g.count} fresh={fresh.has(g.first.id)} />
                ))}
              </ol>
              {groups.length > 20 && (
                <button className="quiet more" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Show fewer' : `Show all ${groups.length} rows`}
                </button>
              )}
            </>
          )}
        </section>

        <aside className="side">
          {config?.demoMode && scenarios.length > 0 && (
            <section aria-labelledby="sc-title">
              <h2 id="sc-title">Try to break it</h2>
              <ul className="scenarios">
                {scenarios.map((s) => (
                  <li key={s.id}>
                    <button onClick={() => run(s.id)} disabled={running !== null} aria-describedby={`d-${s.id}`}>
                      {running === s.id ? 'Running…' : s.title}
                    </button>
                    <p id={`d-${s.id}`}>{s.description}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="q-title">
            <h2 id="q-title">
              Waiting for you {pending.length > 0 && <span className="count">{pending.length}</span>}
            </h2>
            {pending.length === 0 ? (
              <p className="empty small">Nothing needs a decision. Held payments appear here.</p>
            ) : (
              <ul className="queue">
                {pending.map((p) => (
                  <li key={p.id}>
                    <div className="q-top">
                      <span>
                        {p.agentName} wants to pay <b>{p.merchant}</b>
                      </span>
                      <span className="amt">{usd(p.amountCents)}</span>
                    </div>
                    <p className="q-why">
                      {p.reasons
                        .filter((r) => r.outcome !== 'pass')
                        .map((r) => r.message)
                        .join(' ')}
                    </p>
                    <div className="q-actions">
                      <button className="approve" onClick={() => review(p.id, 'approve')}>
                        Approve
                      </button>
                      <button className="reject" onClick={() => review(p.id, 'reject')}>
                        Reject
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="ag-title">
            <h2 id="ag-title">Agents</h2>
            <ul className="agents">
              {agents.map((a) => {
                const limit = a.policy.daily_limit_cents;
                const spent = Number(a.spent_today_cents);
                const reserved = Number(a.reserved_today_cents);
                return (
                  <li key={a.id} className={a.status}>
                    <div className="ag-top">
                      <span className="ag-name">{a.name}</span>
                      <label className="switch">
                        <input type="checkbox" checked={a.status === 'frozen'} onChange={() => toggleFreeze(a)} />
                        <span>{a.status === 'frozen' ? 'Frozen' : 'Freeze'}</span>
                      </label>
                    </div>
                    <div
                      className="budget"
                      role="img"
                      aria-label={`${usd(spent)} spent and ${usd(reserved)} held of ${usd(limit)} today`}
                    >
                      <i className="spent" style={{ width: `${Math.min(100, (spent / limit) * 100)}%` }} />
                      <i className="held" style={{ width: `${Math.min(100, (reserved / limit) * 100)}%` }} />
                    </div>
                    <div className="ag-meta">
                      <span>
                        {usd(spent)} of {usd(limit)} today
                      </span>
                      <span>{a.blocked_today} blocked</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>
      </main>

      <footer className="foot">
        Policy engine, ledger and audit trail run on Postgres; velocity windows and live events on Redis.
        {config?.demoMode && ' Demo mode: fake money, public controls.'}
      </footer>
    </div>
  );
}

/** Collapses consecutive identical decisions (a retry storm, a runaway loop) into one ledger line. */
function groupBursts(payments: Payment[]): Array<{ first: Payment; count: number }> {
  const out: Array<{ first: Payment; count: number }> = [];
  for (const p of payments) {
    const last = out[out.length - 1];
    if (
      last &&
      last.first.agentId === p.agentId &&
      last.first.merchant === p.merchant &&
      last.first.status === p.status &&
      last.first.amountCents === p.amountCents
    ) {
      last.count += 1;
    } else {
      out.push({ first: p, count: 1 });
    }
  }
  return out;
}

function FeedRow({ p, fresh, count }: { p: Payment; fresh: boolean; count: number }) {
  const [open, setOpen] = useState(false);
  const flagged = p.reasons.filter((r) => r.outcome !== 'pass');
  return (
    <li className={`row ${p.status} ${fresh ? 'fresh' : ''}`}>
      <button className="row-main" onClick={() => setOpen(!open)} aria-expanded={open}>
        <time dateTime={p.createdAt}>{time(p.createdAt)}</time>
        <span className="who">
          <span className="merchant">
            {p.merchant}
            {count > 1 && <span className="times"> ×{count}</span>}
          </span>
          <span className="sub">
            {p.agentName}, {p.category.replace(/_/g, ' ')}
          </span>
        </span>
        <span className="amt">{count > 1 ? `${count} × ${usd(p.amountCents)}` : usd(p.amountCents)}</span>
        <span className={`stamp ${p.status}`}>{STAMP[p.status]}</span>
      </button>
      {open && (
        <div className="detail">
          <p>
            <span className="k">Agent's reason</span> {p.reason}
          </p>
          {p.userIntent && (
            <p>
              <span className="k">User asked for</span> {p.userIntent}
            </p>
          )}
          <ul className="why">
            {(flagged.length ? flagged : p.reasons).map((r, i) => (
              <li key={i} className={r.outcome}>
                <code>{r.rule}</code> {r.message}
              </li>
            ))}
          </ul>
          <p className="facts">
            Risk {p.riskScore}/100, decided by {p.decidedBy}
            {p.latencyMs != null && ` in ${p.latencyMs} ms`}
          </p>
        </div>
      )}
    </li>
  );
}

function LedgerSeal({ integrity }: { integrity: Integrity | null }) {
  if (!integrity) return <div className="seal" />;
  const ok = integrity.balanced && integrity.reconciled;
  return (
    <div className={`seal ${ok ? 'ok' : 'bad'}`} title="Sum of debits vs credits across every ledger journal">
      <span className="seal-label">{ok ? 'Books balance' : 'Books do not balance'}</span>
      <span className="seal-figures">
        {usd(integrity.debitsCents)} debited, {usd(integrity.creditsCents)} credited across {integrity.journals}{' '}
        journals
      </span>
    </div>
  );
}

function TokenGate({ onSave }: { onSave: (t: string) => void }) {
  const [value, setValue] = useState(getToken());
  return (
    <div className="gate">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value);
        }}
      >
        <Shield />
        <h1>Enter your admin token</h1>
        <p>This guard is not in demo mode, so the dashboard needs the ADMIN_TOKEN the service was started with.</p>
        <label htmlFor="tok">Admin token</label>
        <input id="tok" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        <button type="submit">Open dashboard</button>
      </form>
    </div>
  );
}

function Shield() {
  return (
    <svg className="shield" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3l11 4.5v7.5c0 7-5 12-11 14C10 27 5 22 5 15V7.5z" />
      <path d="M11 16l3.5 3.5L21 13" className="tick" />
    </svg>
  );
}
