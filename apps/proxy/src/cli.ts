/**
 * Operator CLI until the dashboard exists (milestone 2).
 *
 *   npm run cli -w apps/proxy -- setup --login you --project "My agent" --provider anthropic --daily 5
 *   npm run cli -w apps/proxy -- create-key --project <id> --name nightly-job --monthly 50 --max-request 0.50
 *   npm run cli -w apps/proxy -- freeze --key <id>         (kill switch; also: unfreeze, revoke)
 *   npm run cli -w apps/proxy -- limits --key <id> --daily 10 --rpm 30 --models gpt-4o-mini,gpt-4.1-mini
 *   npm run cli -w apps/proxy -- usage --project <id>
 *   npm run cli -w apps/proxy -- prices
 *
 * Provider keys are read from an environment variable (ANTHROPIC_API_KEY / OPENAI_API_KEY), never
 * from a flag, so they don't end up in shell history.
 */
import { parseArgs } from 'node:util';
import { Vault } from './crypto.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { CATALOG, CATALOG_META, type Provider } from './pricing/catalog.js';
import { formatUsd, usdToMicros } from './pricing/cost.js';
import { AdminService, type KeyLimits } from './services/admin.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    login: { type: 'string' },
    project: { type: 'string' },
    name: { type: 'string' },
    provider: { type: 'string' },
    key: { type: 'string' },
    daily: { type: 'string' },
    monthly: { type: 'string' },
    'project-monthly': { type: 'string' },
    'max-request': { type: 'string' },
    rpm: { type: 'string' },
    models: { type: 'string' },
    'loop-repeats': { type: 'string' },
    'loop-window': { type: 'string' },
    'unknown-models': { type: 'string' },
  },
});

/** Prints the price table. Needs no database, so it works anywhere the code is checked out. */
function printPrices() {
  for (const [provider, meta] of Object.entries(CATALOG_META)) {
    console.log(`${provider}: ${meta.source} (verified: ${meta.verifiedAt ?? 'NOT YET'})`);
  }
  console.table(
    CATALOG.map((p) => ({
      model: `${p.provider}/${p.model}`,
      input: p.input,
      output: p.output,
      'cache read': p.cacheRead,
      'cache write': p.cacheWrite5m ?? '-',
      'long prompt above': p.longContext?.aboveInputTokens ?? '-',
    })),
  );
}

if (positionals[0] === 'prices') {
  printPrices();
  process.exit(0);
}

const cfg = loadConfig();
const db = createPool(cfg);
await migrate(db, () => undefined);
const admin = new AdminService(db, new Vault(cfg.encryptionKeys, cfg.activeKeyId));

const usd = (v: string | undefined) => (v === undefined ? undefined : v === 'none' ? null : usdToMicros(Number(v)));
const int = (v: string | undefined) => (v === undefined ? undefined : v === 'none' ? null : Number.parseInt(v, 10));
const need = (v: string | undefined, flag: string): string => {
  if (!v) throw new Error(`--${flag} is required`);
  return v;
};

function limitsFromFlags(): KeyLimits {
  return {
    dailyBudgetMicros: usd(values.daily),
    monthlyBudgetMicros: usd(values.monthly),
    maxRequestMicros: usd(values['max-request']),
    rpmLimit: int(values.rpm),
    allowedModels: values.models === undefined ? undefined : values.models === 'none' ? null : values.models.split(','),
    loopMaxRepeats: int(values['loop-repeats']) ?? undefined,
    loopWindowSec: int(values['loop-window']) ?? undefined,
  };
}

async function saveProviderKey(projectId: string, provider: Provider) {
  const envName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const secret = process.env[envName];
  if (!secret)
    throw new Error(`Set ${envName} in your environment to store it (it is read from there, not from a flag)`);
  await admin.setProviderKey(projectId, provider, secret);
  console.log(`Stored ${provider} key ending in ...${secret.slice(-4)} (encrypted)`);
}

try {
  switch (positionals[0]) {
    case 'setup': {
      const userId = await admin.upsertUser(need(values.login, 'login'));
      const projectId = await admin.createProject(
        userId,
        need(values.project, 'project'),
        usd(values['project-monthly']) ?? null,
      );
      console.log(`Project ${projectId}`);
      if (values.provider) await saveProviderKey(projectId, values.provider as Provider);
      const { id, key } = await admin.createKey(projectId, values.name ?? 'default', limitsFromFlags());
      console.log(`Key ${id}\n\n  ${key}\n\nCopy it now: it is shown only once.`);
      break;
    }
    case 'provider-key':
      await saveProviderKey(need(values.project, 'project'), need(values.provider, 'provider') as Provider);
      break;
    case 'create-key': {
      const { id, key } = await admin.createKey(
        need(values.project, 'project'),
        values.name ?? 'default',
        limitsFromFlags(),
      );
      console.log(`Key ${id}\n\n  ${key}\n\nCopy it now: it is shown only once.`);
      break;
    }
    case 'limits':
      await admin.updateKeyLimits(need(values.key, 'key'), limitsFromFlags());
      console.log('Limits updated');
      break;
    case 'project':
      await admin.updateProject(need(values.project, 'project'), {
        monthlyBudgetMicros: usd(values['project-monthly']),
        unknownModelPolicy: values['unknown-models'] as 'block' | 'max_price' | undefined,
      });
      console.log('Project updated');
      break;
    case 'freeze':
    case 'unfreeze':
    case 'revoke': {
      const status = positionals[0] === 'freeze' ? 'frozen' : positionals[0] === 'unfreeze' ? 'active' : 'revoked';
      const ok = await admin.setKeyStatus(need(values.key, 'key'), status);
      console.log(ok ? `Key is now ${status}` : 'Key not found (or already revoked)');
      break;
    }
    case 'usage': {
      const projectId = need(values.project, 'project');
      const monthStart = new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00Z');
      console.log('\nKeys');
      console.table(
        (await admin.listKeys(projectId)).map((k) => ({
          name: k.name,
          key: k.display,
          status: k.status,
          today: formatUsd(Number(k.spent_today_micros)),
          month: formatUsd(Number(k.spent_month_micros)),
          'daily cap': k.daily_budget_micros === null ? '-' : formatUsd(Number(k.daily_budget_micros)),
        })),
      );
      console.log('This month by model');
      console.table(
        (await admin.usageByModel(projectId, monthStart)).map((r) => ({
          model: `${r.provider}/${r.model}`,
          requests: r.requests,
          blocked: r.blocked,
          cost: formatUsd(Number(r.cost_micros)),
          'in tok': Number(r.input_tokens),
          'out tok': Number(r.output_tokens),
        })),
      );
      console.log('Latest requests');
      console.table(
        (await admin.recentEvents(projectId, 15)).map((e) => ({
          at: new Date(e.created_at).toISOString().slice(11, 19),
          key: e.key,
          model: e.model,
          status: e.status + (e.block_reason ? ` (${e.block_reason})` : ''),
          cost: formatUsd(Number(e.cost_micros)),
          ms: e.latency_ms,
        })),
      );
      break;
    }
    default:
      console.log(
        'Commands: setup, provider-key, create-key, limits, project, freeze, unfreeze, revoke, usage, prices',
      );
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
