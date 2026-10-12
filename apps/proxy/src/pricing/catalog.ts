/**
 * Model price catalog, in US dollars per million tokens (standard tier, no batch discount).
 *
 * Prices change, and charging the wrong amount is the one bug a spend guard cannot have, so:
 *  - every provider block records where the numbers came from and when they were last checked;
 *  - a model that is not listed is blocked by default (projects can opt into "max_price" instead);
 *  - `npm run cli -- prices` prints the table so it can be compared against the pricing pages.
 *
 * VERIFY BEFORE LAUNCH: these entries were written from memory and must be checked against
 *   https://docs.claude.com/en/docs/about-claude/pricing
 *   https://platform.openai.com/docs/pricing
 * then `verifiedAt` set to the date checked. Newer models are added the same way.
 */

export type Provider = 'anthropic' | 'openai';

export interface Rates {
  input: number;
  output: number;
  /** Reading a cached prompt prefix. */
  cacheRead: number;
  /** Writing a prompt prefix to the cache (Anthropic only; OpenAI caches automatically for free). */
  cacheWrite5m?: number;
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
  anthropic: { source: 'https://docs.claude.com/en/docs/about-claude/pricing', verifiedAt: null },
  openai: { source: 'https://platform.openai.com/docs/pricing', verifiedAt: null },
};

/** Anthropic server-side web search: $10 per 1,000 searches. */
export const ANTHROPIC_WEB_SEARCH_USD = 0.01;

const anthropicRates = (input: number, output: number): Rates => ({
  input,
  output,
  cacheRead: input * 0.1,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

export const CATALOG: ModelPrice[] = [
  // Anthropic
  {
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    ...anthropicRates(5, 25),
    maxOutputTokens: 64_000,
    aliases: ['claude-opus-4-5-20251101'],
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-1',
    ...anthropicRates(15, 75),
    maxOutputTokens: 32_000,
    aliases: ['claude-opus-4-1-20250805'],
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-0',
    ...anthropicRates(15, 75),
    maxOutputTokens: 32_000,
    aliases: ['claude-opus-4-20250514'],
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    ...anthropicRates(3, 15),
    maxOutputTokens: 64_000,
    longContext: { aboveInputTokens: 200_000, ...anthropicRates(6, 22.5) },
    aliases: ['claude-sonnet-4-5-20250929'],
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-0',
    ...anthropicRates(3, 15),
    maxOutputTokens: 64_000,
    longContext: { aboveInputTokens: 200_000, ...anthropicRates(6, 22.5) },
    aliases: ['claude-sonnet-4-20250514'],
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    ...anthropicRates(1, 5),
    maxOutputTokens: 64_000,
    aliases: ['claude-haiku-4-5-20251001'],
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-haiku',
    ...anthropicRates(0.8, 4),
    maxOutputTokens: 8_192,
    aliases: ['claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest'],
  },

  // OpenAI
  { provider: 'openai', model: 'gpt-5', input: 1.25, cacheRead: 0.125, output: 10, maxOutputTokens: 128_000 },
  { provider: 'openai', model: 'gpt-5-mini', input: 0.25, cacheRead: 0.025, output: 2, maxOutputTokens: 128_000 },
  { provider: 'openai', model: 'gpt-5-nano', input: 0.05, cacheRead: 0.005, output: 0.4, maxOutputTokens: 128_000 },
  { provider: 'openai', model: 'gpt-4.1', input: 2, cacheRead: 0.5, output: 8, maxOutputTokens: 32_768 },
  { provider: 'openai', model: 'gpt-4.1-mini', input: 0.4, cacheRead: 0.1, output: 1.6, maxOutputTokens: 32_768 },
  { provider: 'openai', model: 'gpt-4.1-nano', input: 0.1, cacheRead: 0.025, output: 0.4, maxOutputTokens: 32_768 },
  { provider: 'openai', model: 'gpt-4o', input: 2.5, cacheRead: 1.25, output: 10, maxOutputTokens: 16_384 },
  { provider: 'openai', model: 'gpt-4o-mini', input: 0.15, cacheRead: 0.075, output: 0.6, maxOutputTokens: 16_384 },
  { provider: 'openai', model: 'o3', input: 2, cacheRead: 0.5, output: 8, maxOutputTokens: 100_000 },
  { provider: 'openai', model: 'o4-mini', input: 1.1, cacheRead: 0.275, output: 4.4, maxOutputTokens: 100_000 },
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
