/**
 * Model price catalog, in US dollars per million tokens (standard tier, no batch discount).
 *
 * Prices change, and charging the wrong amount is the one bug a spend guard cannot have, so:
 *  - each row holds only the numbers printed on the provider's page; the provider's published rules
 *    (cache multipliers, long-prompt surcharges) are applied by one helper per provider;
 *  - every provider block records where the numbers came from and when they were last checked;
 *  - a model that is not listed is blocked by default (projects can opt into "max_price" instead);
 *  - `npm run cli -- prices` prints the table so it can be compared against the pricing pages.
 *
 * Re-check monthly, and whenever a provider launches or retires a model. Retired models are removed:
 * the provider rejects them anyway, and a price nobody can confirm is a guess.
 */

export type Provider = 'anthropic' | 'openai';

export interface Rates {
  input: number;
  output: number;
  /** Reading a cached prompt prefix. */
  cacheRead: number;
  /** Writing a prompt prefix to the cache. OpenAI has one write rate (GPT-5.6 and later), stored here. */
  cacheWrite5m?: number;
  /** Anthropic's 1-hour cache write. */
  cacheWrite1h?: number;
}

export interface ModelPrice extends Rates {
  provider: Provider;
  model: string;
  /** Largest output the model can produce: the worst case when a request does not set a limit. */
  maxOutputTokens: number;
  /** Some models charge more for every token once the prompt exceeds a threshold. */
  longContext?: Rates & { aboveInputTokens: number };
  aliases?: string[];
}

export const CATALOG_META: Record<Provider, { source: string; verifiedAt: string | null }> = {
  anthropic: { source: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-10-16' },
  // The summary page lists only current models; older models' prices are on each model's own page.
  openai: { source: 'https://developers.openai.com/api/docs/models/<model>', verifiedAt: '2026-10-16' },
};

/** Anthropic server-side web search: $10 per 1,000 searches. */
export const ANTHROPIC_WEB_SEARCH_USD = 0.01;

/**
 * Anthropic's published cache rules: 5-minute write 1.25× input, 1-hour write 2× input.
 * Cache reads are given per model because they differ (0.1× on most, 0.025× on Fable/Mythos 5.1).
 */
const anthropicRates = (input: number, cacheRead: number, output: number): Rates => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

/** OpenAI's long-prompt rule (GPT-5.4 and later): above 272K input tokens the whole request pays 2× input and cache rates, 1.5× output. */
const OPENAI_LONG_CONTEXT_TOKENS = 272_000;

/**
 * OpenAI rates. `cacheWrites` = GPT-5.6 and later, which bill tokens written to the cache at 1.25×
 * the input rate; older models write to the cache for free. `long` = the 272K surcharge applies.
 */
function openaiRates(
  input: number,
  cacheRead: number,
  output: number,
  opts: { cacheWrites?: boolean; long?: boolean } = {},
): Pick<ModelPrice, keyof Rates | 'longContext'> {
  const base = (k: number, o: number): Rates => ({
    input: input * k,
    cacheRead: cacheRead * k,
    output: output * o,
    ...(opts.cacheWrites ? { cacheWrite5m: input * 1.25 * k } : {}),
  });
  return {
    ...base(1, 1),
    ...(opts.long ? { longContext: { aboveInputTokens: OPENAI_LONG_CONTEXT_TOKENS, ...base(2, 1.5) } } : {}),
  };
}

export const CATALOG: ModelPrice[] = [
  // Anthropic: verified 2026-10-16 against the pricing page and the model-deprecations page.
  // The models page gives max output (128K) only for the four newest; for the other recent models
  // we use the same 128K, the largest any model allows, so a reservation can only err on the high side.
  { provider: 'anthropic', model: 'claude-fable-5-1', ...anthropicRates(10, 0.25, 50), maxOutputTokens: 128_000 },
  { provider: 'anthropic', model: 'claude-mythos-5-1', ...anthropicRates(10, 0.25, 50), maxOutputTokens: 128_000 },
  { provider: 'anthropic', model: 'claude-fable-5', ...anthropicRates(10, 1, 50), maxOutputTokens: 128_000 },
  { provider: 'anthropic', model: 'claude-mythos-5', ...anthropicRates(10, 1, 50), maxOutputTokens: 128_000 },
  { provider: 'anthropic', model: 'claude-opus-5-5', ...anthropicRates(4, 0.2, 20), maxOutputTokens: 128_000 },
  { provider: 'anthropic', model: 'claude-opus-5', ...anthropicRates(5, 0.5, 25), maxOutputTokens: 128_000 },
  { provider: 'anthropic', model: 'claude-opus-4-8', ...anthropicRates(5, 0.5, 25), maxOutputTokens: 128_000 },
  { provider: 'anthropic', model: 'claude-opus-4-7', ...anthropicRates(5, 0.5, 25), maxOutputTokens: 128_000 },
  { provider: 'anthropic', model: 'claude-opus-4-6', ...anthropicRates(5, 0.5, 25), maxOutputTokens: 128_000 },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    ...anthropicRates(5, 0.5, 25),
    maxOutputTokens: 64_000,
    aliases: ['claude-opus-4-5-20251101'],
  },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', ...anthropicRates(2, 0.1, 10), maxOutputTokens: 128_000 },
  { provider: 'anthropic', model: 'claude-sonnet-5', ...anthropicRates(2, 0.2, 10), maxOutputTokens: 128_000 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', ...anthropicRates(3, 0.3, 15), maxOutputTokens: 128_000 },
  {
    // Deprecated; retires 2026-11-30.
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    ...anthropicRates(3, 0.3, 15),
    maxOutputTokens: 64_000,
    aliases: ['claude-sonnet-4-5-20250929'],
  },
  {
    // The only Anthropic model with a long-prompt price: above 100K input tokens (cache included).
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    ...anthropicRates(0.1, 0.01, 0.5),
    maxOutputTokens: 128_000,
    longContext: { aboveInputTokens: 100_000, ...anthropicRates(0.5, 0.05, 2.5) },
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    ...anthropicRates(1, 0.1, 5),
    maxOutputTokens: 64_000,
    aliases: ['claude-haiku-4-5-20251001'],
  },

  // OpenAI: verified 2026-10-16 against each model's page and the deprecations page.
  {
    provider: 'openai',
    model: 'gpt-6-astra',
    ...openaiRates(10, 1, 50, { cacheWrites: true, long: true }),
    maxOutputTokens: 128_000,
  },
  {
    provider: 'openai',
    model: 'gpt-6.1-sol',
    ...openaiRates(2, 0.1, 10, { cacheWrites: true, long: true }),
    maxOutputTokens: 128_000,
  },
  {
    provider: 'openai',
    model: 'gpt-6-luna',
    ...openaiRates(0.1, 0.01, 0.5, { cacheWrites: true, long: true }),
    maxOutputTokens: 128_000,
  },
  {
    // Promotional price, guaranteed until at least 2026-11-21: re-check after that date.
    provider: 'openai',
    model: 'gpt-5.6-sol',
    ...openaiRates(4, 0.4, 20, { cacheWrites: true, long: true }),
    maxOutputTokens: 128_000,
    aliases: ['gpt-5.6'],
  },
  {
    provider: 'openai',
    model: 'gpt-5.6-terra',
    ...openaiRates(2, 0.2, 12, { cacheWrites: true, long: true }),
    maxOutputTokens: 128_000,
  },
  {
    provider: 'openai',
    model: 'gpt-5.6-luna',
    ...openaiRates(0.2, 0.02, 1.2, { cacheWrites: true, long: true }),
    maxOutputTokens: 128_000,
  },
  { provider: 'openai', model: 'gpt-5.5', ...openaiRates(5, 0.5, 30, { long: true }), maxOutputTokens: 128_000 },
  { provider: 'openai', model: 'gpt-5.4', ...openaiRates(2.5, 0.25, 15, { long: true }), maxOutputTokens: 128_000 },
  // Deprecated, still running. Shutdown dates from the deprecations page.
  { provider: 'openai', model: 'gpt-5.1', ...openaiRates(1.25, 0.125, 10), maxOutputTokens: 128_000 }, // 2027-04-01
  { provider: 'openai', model: 'gpt-5', ...openaiRates(1.25, 0.125, 10), maxOutputTokens: 128_000 }, // 2026-12-11
  { provider: 'openai', model: 'gpt-5-mini', ...openaiRates(0.25, 0.025, 2), maxOutputTokens: 128_000 }, // 2026-12-11
  { provider: 'openai', model: 'gpt-5-nano', ...openaiRates(0.05, 0.005, 0.4), maxOutputTokens: 128_000 }, // 2026-12-11
  { provider: 'openai', model: 'o3', ...openaiRates(2, 0.5, 8), maxOutputTokens: 100_000 }, // 2026-12-11
  { provider: 'openai', model: 'gpt-4.1', ...openaiRates(2, 0.5, 8), maxOutputTokens: 32_768 }, // 2027-01-14
  { provider: 'openai', model: 'gpt-4.1-mini', ...openaiRates(0.4, 0.1, 1.6), maxOutputTokens: 32_768 }, // 2027-01-14
  { provider: 'openai', model: 'gpt-4o', ...openaiRates(2.5, 1.25, 10), maxOutputTokens: 16_384 }, // 2027-01-14
  { provider: 'openai', model: 'gpt-4o-mini', ...openaiRates(0.15, 0.075, 0.6), maxOutputTokens: 16_384 }, // 2027-01-14
];

const DATED_SUFFIX = /^(\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Finds a model's price. Accepts exact ids, listed aliases, and dated snapshots of a listed model
 * ("gpt-4o-2024-08-06" → gpt-4o). Only a date may follow the base name, so "gpt-4o-mini" can
 * never be priced as "gpt-4o".
 */
export function findPrice(provider: Provider, model: string): ModelPrice | undefined {
  const candidates = CATALOG.filter((p) => p.provider === provider);
  for (const p of candidates) {
    if (p.model === model || p.aliases?.includes(model)) return p;
  }
  for (const p of candidates) {
    for (const base of [p.model, ...(p.aliases ?? [])]) {
      if (model.startsWith(base + '-') && DATED_SUFFIX.test(model.slice(base.length + 1))) return p;
    }
  }
  return undefined;
}

/** For projects that allow unknown models: price them as the provider's most expensive model. */
export function maxPrice(provider: Provider, model: string): ModelPrice {
  const candidates = CATALOG.filter((p) => p.provider === provider);
  const worst = candidates.reduce((a, b) => (b.output + b.input > a.output + a.input ? b : a));
  const maxOut = Math.max(...candidates.map((p) => p.maxOutputTokens));
  return { ...worst, model, aliases: [], maxOutputTokens: maxOut };
}
