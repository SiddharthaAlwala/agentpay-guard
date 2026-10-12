import { ANTHROPIC_WEB_SEARCH_USD, type ModelPrice, type Rates } from './catalog.js';

/** Token counts in one shape, whichever provider they came from. */
export interface Usage {
  /** Prompt tokens billed at the normal input rate (not read from or written to the cache). */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Includes hidden reasoning/thinking tokens, which are billed as output. */
  outputTokens: number;
  webSearches: number;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 0,
  webSearches: 0,
});

/**
 * Rates are converted to integer "thousandths of a micro-dollar per token" so the arithmetic is
 * exact. (tokens × USD-per-million = micro-dollars, so $0.075/M becomes 75 thousandths.)
 * The total is rounded up once: we never under-count.
 */
const milli = (usdPerMillion: number) => Math.round(usdPerMillion * 1000);

function ratesFor(price: ModelPrice, promptTokens: number): Rates {
  return price.longContext && promptTokens > price.longContext.aboveInputTokens ? price.longContext : price;
}

export function costMicros(price: ModelPrice, u: Usage): number {
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
  const r = ratesFor(price, prompt);
  const thousandths =
    u.inputTokens * milli(r.input) +
    u.cacheReadTokens * milli(r.cacheRead) +
    u.cacheWrite5mTokens * milli(r.cacheWrite5m ?? r.input) +
    u.cacheWrite1hTokens * milli(r.cacheWrite1h ?? r.input) +
    u.outputTokens * milli(r.output);
  return Math.ceil(thousandths / 1000) + u.webSearches * Math.round(ANTHROPIC_WEB_SEARCH_USD * 1_000_000);
}

/**
 * The most a request can cost before we know the real usage: every prompt token at the highest
 * input rate it could be billed at, and the full output allowance.
 */
export function worstCaseMicros(
  price: ModelPrice,
  estimatedPromptTokens: number,
  maxOutputTokens: number,
  mayWriteCache: boolean,
): number {
  const r = ratesFor(price, estimatedPromptTokens);
  const inputRate = mayWriteCache ? Math.max(r.input, r.cacheWrite1h ?? r.input) : r.input;
  return Math.ceil((estimatedPromptTokens * milli(inputRate) + maxOutputTokens * milli(r.output)) / 1000);
}

export const microsToUsd = (m: number) => m / 1_000_000;
export const usdToMicros = (usd: number) => Math.round(usd * 1_000_000);
export const formatUsd = (m: number) => `$${(m / 1_000_000).toFixed(m < 10_000 ? 4 : 2)}`;
