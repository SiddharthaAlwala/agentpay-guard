import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, looksLikeOurKey, Vault } from '../src/crypto.js';
import { estimatePromptTokens } from '../src/estimate.js';
import { findPrice, maxPrice } from '../src/pricing/catalog.js';
import { costMicros, emptyUsage, worstCaseMicros } from '../src/pricing/cost.js';
import { anthropic } from '../src/providers/anthropic.js';
import { openai } from '../src/providers/openai.js';
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
    expect(maxPrice('anthropic', 'x').output).toBe(75);
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

  it('switches to long-context rates above 200K prompt tokens', () => {
    expect(costMicros(sonnet, { ...emptyUsage(), inputTokens: 200_000 })).toBe(600_000);
    expect(costMicros(sonnet, { ...emptyUsage(), inputTokens: 200_001 })).toBe(1_200_006);
  });

  it('adds server-side web searches', () => {
    expect(costMicros(sonnet, { ...emptyUsage(), webSearches: 3 })).toBe(30_000);
  });

  it('worst case assumes the full output allowance and the cache-write rate when caching is requested', () => {
    expect(worstCaseMicros(sonnet, 1000, 1000, false)).toBe(3000 + 15_000);
    expect(worstCaseMicros(sonnet, 1000, 1000, true)).toBe(6000 + 15_000);
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
