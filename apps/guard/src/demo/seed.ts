import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PolicyUpdate } from '../domain.js';
import type { AgentService } from '../services/agents.js';

export interface DemoAgentSpec {
  slug: 'shopping' | 'travel' | 'ops' | 'groceries';
  name: string;
  /** Fixed, public keys: demo mode only. Real agents get random keys. */
  apiKey: string;
  policy: PolicyUpdate;
}

export const DEMO_AGENTS: DemoAgentSpec[] = [
  {
    slug: 'shopping',
    name: 'Shopping Assistant',
    apiKey: 'apg_demo_shopping_assistant',
    policy: {
      perTxLimitCents: 30_000,
      dailyLimitCents: 100_000,
      monthlyLimitCents: 400_000,
      approvalThresholdCents: 15_000,
      allowedCategories: ['electronics', 'office_supplies', 'books', 'household'],
      velocityMax: 5,
      velocityWindowSec: 60,
    },
  },
  {
    slug: 'travel',
    name: 'Travel Booker',
    apiKey: 'apg_demo_travel_booker',
    policy: {
      perTxLimitCents: 150_000,
      dailyLimitCents: 300_000,
      monthlyLimitCents: 1_000_000,
      approvalThresholdCents: 80_000,
      allowedCategories: ['flights', 'hotels', 'ground_transport'],
      merchantAllowlist: ['delta', 'united', 'marriott', 'hilton', 'uber', 'lyft'],
    },
  },
  {
    slug: 'ops',
    name: 'Cloud Ops Bot',
    apiKey: 'apg_demo_cloud_ops_bot',
    policy: {
      perTxLimitCents: 50_000,
      dailyLimitCents: 200_000,
      monthlyLimitCents: 1_000_000,
      approvalThresholdCents: 40_000,
      allowedCategories: ['software', 'cloud'],
      velocityMax: 5,
      velocityWindowSec: 60,
    },
  },
  {
    slug: 'groceries',
    name: 'Grocery Runner',
    apiKey: 'apg_demo_grocery_runner',
    policy: {
      perTxLimitCents: 10_000,
      dailyLimitCents: 50_000,
      monthlyLimitCents: 300_000,
      approvalThresholdCents: 20_000,
      allowedCategories: ['groceries', 'household'],
      velocityMax: 1000,
      velocityWindowSec: 60,
      intentCheck: false,
    },
  },
];

/** Creates the demo agents if they don't exist yet. Returns slug -> agent id. */
export async function seedDemo(agents: AgentService): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const spec of DEMO_AGENTS) {
    const found = await agents.findByApiKey(spec.apiKey);
    if (found) {
      ids[spec.slug] = found.id;
      continue;
    }
    const { agent } = await agents.create(
      { name: spec.name, owner: 'demo-user', policy: spec.policy },
      'system:seed',
      spec.apiKey,
    );
    ids[spec.slug] = agent.id;
  }
  return ids;
}

// CLI: `npm run seed`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { loadConfig } = await import('../config.js');
  const { createPool } = await import('../db.js');
  const { migrate } = await import('../migrate.js');
  const { AgentService } = await import('../services/agents.js');
  const { EventBus } = await import('../services/events.js');
  const db = createPool(loadConfig());
  await migrate(db);
  await seedDemo(new AgentService(db, new EventBus(null, null)));
  console.log('Demo agents ready:');
  for (const a of DEMO_AGENTS) console.log(`  ${a.name.padEnd(20)} ${a.apiKey}`);
  await db.end();
}
