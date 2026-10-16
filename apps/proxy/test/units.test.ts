import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, looksLikeOurKey, Vault } from '../src/crypto.js';
import { estimatePromptTokens } from '../src/estimate.js';
import { CATALOG, CATALOG_META, findPrice, maxPrice } from '../src/pricing/catalog.js';
import { costMicros, emptyUsage, worstCaseMicros } from '../src/pricing/cost.js';
import { anthropic } from '../src/providers/anthropic.js';
import { openai, openaiUsage } from '../src/providers/openai.js';
import { SseParser } from '../src/sse.js';

const enc = new TextEncoder();

describe('price catalog', () => {
  it('matches exact ids, aliases and dated snapshots', () => {
    expect(findPrice('openai', 'gpt-4o')?.model).toBe('gpt-4o');
    expect(findPrice('openai', 'gpt-4o-2024-08-06')?.model).toBe('gpt-4o');
    expect(findPrice('anthropic', 'claude-sonnet-4-5-20250929')?.model).toBe('claude-sonnet-4-5');
  });

  it('never prices a different model by prefix', () => {
    expect(findPrice('openai', 'gpt-4o-mini')?.model).toBe('gpt-4o-mini');
    expect(findPrice('openai', 'gpt-4o-audio-preview')).toBeUndefined();
    expect(findPrice('anthropic', 'claude-sonnet-4-5-turbo')).toBeUndefined();
    expect(findPrice('openai', 'claude-haiku-4-5')).toBeUndefined();
  });

  it('prices unknown models at the most expensive known model when allowed', () => {
    expect(maxPrice('anthropic', 'x').output).toBe(50);
    expect(maxPrice('openai', 'x').output).toBe(50);
  });

  it('has been checked against the official pages, with sane numbers on every row', () => {
    for (const meta of Object.values(CATALOG_META)) expect(meta.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const ids = new Set<string>();
    for (const p of CATALOG) {
      for (const id of [p.model, ...(p.aliases ?? [])]) {
        expect(ids.has(`${p.provider}:${id}`), `duplicate id ${id}`).toBe(false);
        ids.add(`${p.provider}:${id}`);
      }
      // A zero or missing price would let a model run for free against the budget.
      expect(p.input, p.model).toBeGreaterThan(0);
      expect(p.output, p.model).toBeGreaterThan(p.input);
      expect(p.cacheRead, p.model).toBeGreaterThan(0);
      expect(p.cacheRead, p.model).toBeLessThan(p.input);
      if (p.cacheWrite5m !== undefined) expect(p.cacheWrite5m, p.model).toBeGreaterThan(p.input);
      expect(p.maxOutputTokens, p.model).toBeGreaterThanOrEqual(16_384);
    }
  });

  it('knows the current flagship models of both providers', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
      expect(findPrice('anthropic', m), m).toBeDefined();
    }
    for (const m of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5-2026-04-23']) {
      expect(findPrice('openai', m), m).toBeDefined();
    }
  });

  it('no longer lists retired models', () => {
    expect(findPrice('anthropic', 'claude-opus-4-1')).toBeUndefined();
    expect(findPrice('anthropic', 'claude-3-5-haiku-20241022')).toBeUndefined();
    expect(findPrice('openai', 'o4-mini')).toBeUndefined();
  });
});

describe('cost', () => {
  const sonnet = findPrice('anthropic', 'claude-sonnet-4-5')!;
  const mini = findPrice('openai', 'gpt-4o-mini')!;

  it('is exact in integer micro-dollars, with no floating-point drift', () => {
    // 1000 cached tokens at $0.075/M is exactly 75 micros (0.075 * 1000 in floats is 75.00000000000001).
    expect(costMicros(mini, { ...emptyUsage(), cacheReadTokens: 1000 })).toBe(75);
    expect(costMicros(sonnet, { ...emptyUsage(), inputTokens: 100_000, outputTokens: 100_000 })).toBe(1_800_000);
  });

  it('rounds up fractions so we never under-count', () => {
    expect(costMicros(mini, { ...emptyUsage(), inputTokens: 1 })).toBe(1); // 0.15 micros
  });

  it('bills cache writes and reads at their own rates', () => {
    const u = { ...emptyUsage(), cacheWrite5mTokens: 1000, cacheWrite1hTokens: 1000, cacheReadTokens: 1000 };
    expect(costMicros(sonnet, u)).toBe(3750 + 6000 + 300);
  });

  it('has no long-prompt surcharge on Sonnet 4.5 any more', () => {
    expect(costMicros(sonnet, { ...emptyUsage(), inputTokens: 300_000 })).toBe(900_000);
  });

  it('Haiku 5.5: higher rates for the whole request above 100K prompt tokens, cache reads included', () => {
    const haiku = findPrice('anthropic', 'claude-haiku-5-5')!;
    expect(costMicros(haiku, { ...emptyUsage(), inputTokens: 100_000 })).toBe(10_000); // $0.10/M
    expect(costMicros(haiku, { ...emptyUsage(), inputTokens: 100_001 })).toBe(50_001); // $0.50/M, rounded up
    // 60K new + 50K read from cache = 110K prompt: over the threshold, so the reads pay $0.05/M.
    expect(costMicros(haiku, { ...emptyUsage(), inputTokens: 60_000, cacheReadTokens: 50_000 })).toBe(30_000 + 2_500);
  });

  it('OpenAI: 2x input and 1.5x output above 272K prompt tokens', () => {
    const sol = findPrice('openai', 'gpt-6.1-sol')!;
    expect(costMicros(sol, { ...emptyUsage(), inputTokens: 272_000, outputTokens: 1000 })).toBe(544_000 + 10_000);
    expect(costMicros(sol, { ...emptyUsage(), inputTokens: 272_001, outputTokens: 1000 })).toBe(1_088_004 + 15_000);
  });

  it('OpenAI GPT-5.6+: cache writes cost 1.25x input; older models write for free', () => {
    const sol = findPrice('openai', 'gpt-6.1-sol')!;
    expect(costMicros(sol, { ...emptyUsage(), cacheWrite5mTokens: 1000 })).toBe(2500);
    expect(costMicros(mini, { ...emptyUsage(), cacheWrite5mTokens: 1000 })).toBe(150);
  });

  it('adds server-side web searches', () => {
    expect(costMicros(sonnet, { ...emptyUsage(), webSearches: 3 })).toBe(30_000);
  });

  it('worst case assumes the full output allowance and the cache-write rate when caching is possible', () => {
    expect(worstCaseMicros(sonnet, 1000, 1000, false)).toBe(3000 + 15_000);
    expect(worstCaseMicros(sonnet, 1000, 1000, true)).toBe(6000 + 15_000);
    const sol = findPrice('openai', 'gpt-6.1-sol')!;
    expect(worstCaseMicros(sol, 1000, 1000, true)).toBe(2500 + 10_000);
  });
});

describe('OpenAI usage', () => {
  it('splits the prompt into plain input, cache reads and cache writes (Responses example from the docs)', () => {
    const u = openaiUsage('/v1/responses', {
      input_tokens: 15_000,
      input_tokens_details: { cached_tokens: 12_000, cache_write_tokens: 3_000 },
      output_tokens: 10,
    })!;
    expect(u).toMatchObject({ inputTokens: 0, cacheReadTokens: 12_000, cacheWrite5mTokens: 3_000, outputTokens: 10 });
  });

  it('never counts more cached tokens than the prompt had', () => {
    const u = openaiUsage('/v1/chat/completions', {
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 80 },
      completion_tokens: 5,
    })!;
    expect(u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens).toBe(100);
  });
});

describe('vault', () => {
  const k1 = Buffer.alloc(32, 1);
  const k2 = Buffer.alloc(32, 2);
  const vault = new Vault(new Map([['k1', k1]]), 'k1');

  it('round-trips a secret', () => {
    const { secret, keyId } = vault.encrypt('sk-ant-secret', 'p1:anthropic');
    expect(secret.toString('latin1')).not.toContain('sk-ant');
    expect(vault.decrypt(secret, keyId, 'p1:anthropic')).toBe('sk-ant-secret');
  });

  it('refuses a ciphertext that was tampered with', () => {
    const { secret, keyId } = vault.encrypt('sk-ant-secret', 'p1:anthropic');
    secret[secret.length - 1]! ^= 1;
    expect(() => vault.decrypt(secret, keyId, 'p1:anthropic')).toThrow();
  });

  it("refuses a secret moved to another project's row", () => {
    const { secret, keyId } = vault.encrypt('sk-ant-secret', 'p1:anthropic');
    expect(() => vault.decrypt(secret, keyId, 'p2:anthropic')).toThrow();
  });

  it('still decrypts old secrets after the master key is rotated', () => {
    const { secret } = vault.encrypt('old', 'p1:openai');
    const rotated = new Vault(
      new Map([
        ['k2', k2],
        ['k1', k1],
      ]),
      'k2',
    );
    expect(rotated.decrypt(secret, 'k1', 'p1:openai')).toBe('old');
    expect(rotated.encrypt('new', 'p1:openai').keyId).toBe('k2');
  });
});

describe('api keys', () => {
  it('are random, well-formed, and stored only as a hash', () => {
    const keys = new Set(Array.from({ length: 1000 }, generateApiKey));
    expect(keys.size).toBe(1000);
    const k = [...keys][0]!;
    expect(looksLikeOurKey(k)).toBe(true);
    expect(k).toMatch(/^apg_live_[0-9A-Za-z]{32}$/);
    expect(hashApiKey(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(looksLikeOurKey('sk-proj-abc')).toBe(false);
  });
});

describe('SSE parser', () => {
  it('reassembles events split across network chunks', () => {
    const p = new SseParser();
    expect(p.push(enc.encode('event: a\ndata: {"x"'))).toEqual([]);
    const evs = p.push(enc.encode(':1}\n\nevent: b\ndata: 2\n\ndata: 3')); // third event incomplete
    expect(evs.map((e) => [e.event, e.data])).toEqual([
      ['a', '{"x":1}'],
      ['b', '2'],
    ]);
    expect(evs[0]!.raw).toBe('event: a\ndata: {"x":1}\n\n');
    expect(p.flush()?.data).toBe('3');
  });

  it('keeps multi-byte characters intact when a chunk splits them', () => {
    const bytes = enc.encode('data: héllo 👋\n\n');
    const p = new SseParser();
    const out = [...p.push(bytes.subarray(0, 9)), ...p.push(bytes.subarray(9))];
    expect(out[0]!.data).toBe('héllo 👋');
  });

  it('handles CRLF line endings', () => {
    expect(new SseParser().push(enc.encode('data: x\r\n\r\n'))[0]!.data).toBe('x');
  });
});

describe('prompt estimate', () => {
  it('over-estimates plain English (real tokenizers average ~4 chars per token)', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(100); // ~1000 real tokens
    expect(estimatePromptTokens({ messages: [{ role: 'user', content: text }] })).toBeGreaterThan(1300);
  });

  it('counts each non-ASCII character as a token', () => {
    expect(estimatePromptTokens({ messages: [{ role: 'user', content: '你好世界' }] })).toBe(4 + 1 + 10);
  });

  it('gives images a flat allowance instead of counting base64 as text', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2_000_000) } };
    const est = estimatePromptTokens({ messages: [{ role: 'user', content: [img] }] });
    expect(est).toBeLessThan(3_000);
  });
});

describe('stream usage', () => {
  const sse = (type: string, d: object) => ({ raw: '', event: type, data: JSON.stringify({ type, ...d }) });

  it('Anthropic: input from message_start, final output from message_delta', () => {
    const t = anthropic.streamTracker('/v1/messages', false);
    t.onEvent(
      sse('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } } }),
    );
    expect(t.usage()).toBeNull();
    t.onEvent(sse('message_delta', { usage: { output_tokens: 42 } }));
    t.onEvent(sse('message_stop', {}));
    expect(t.usage()).toMatchObject({ inputTokens: 10, cacheReadTokens: 5, outputTokens: 42 });
  });

  it('Anthropic: estimates output from streamed text when cut off', () => {
    const t = anthropic.streamTracker('/v1/messages', false);
    t.onEvent(sse('message_start', { message: { usage: { input_tokens: 10, output_tokens: 1 } } }));
    t.onEvent(sse('content_block_delta', { delta: { type: 'text_delta', text: 'x'.repeat(30) } }));
    expect(t.usage()).toBeNull();
    expect(t.estimate(999)).toMatchObject({ inputTokens: 10, outputTokens: 10 });
  });

  it('OpenAI: drops only the usage chunk it injected', () => {
    const injected = openai.streamTracker('/v1/chat/completions', true);
    const usageChunk = {
      raw: '',
      data: JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    };
    expect(injected.onEvent(usageChunk)).toBe(false);
    expect(injected.usage()).toMatchObject({ inputTokens: 5, outputTokens: 2 });
    const asked = openai.streamTracker('/v1/chat/completions', false);
    expect(asked.onEvent(usageChunk)).toBe(true);
  });

  it('OpenAI: asks for streaming usage without overwriting other stream options', () => {
    const body = { model: 'gpt-4o', stream: true, stream_options: { include_obfuscation: false } };
    const out = openai.prepareBody('/v1/chat/completions', body, openai.inspect('/v1/chat/completions', body));
    expect(out).toEqual({
      body: { ...body, stream_options: { include_obfuscation: false, include_usage: true } },
      injectedUsage: true,
    });
  });
});

describe('config', () => {
  it('uses the development vault key locally, and refuses it in production', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig({ ENCRYPTION_KEYS: '' }).activeKeyId).toBe('dev');
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/ENCRYPTION_KEYS must be set/);
    const real = `k1:${Buffer.alloc(32, 7).toString('base64')}`;
    expect(loadConfig({ NODE_ENV: 'production', ENCRYPTION_KEYS: real }).activeKeyId).toBe('k1');
    expect(() => loadConfig({ ENCRYPTION_KEYS: 'k1:dG9vLXNob3J0' })).toThrow(/32 bytes/);
  });
});
