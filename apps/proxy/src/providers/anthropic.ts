import { emptyUsage, type Usage } from '../pricing/cost.js';
import {
  bearer,
  charsToTokens,
  header,
  num,
  type ErrorKind,
  type ProviderAdapter,
  type RequestInfo,
  type StreamTracker,
} from './types.js';

const ERROR_TYPES: Record<ErrorKind, string> = {
  authentication: 'authentication_error',
  permission: 'permission_error',
  invalid_request: 'invalid_request_error',
  not_found: 'not_found_error',
  rate_limit: 'rate_limit_error',
  budget: 'rate_limit_error',
  unavailable: 'overloaded_error',
  upstream: 'api_error',
};

/** Anthropic reports cache writes either as one total or split by cache lifetime. */
export function anthropicUsage(u: Record<string, unknown> | undefined): Usage {
  const usage = emptyUsage();
  if (!u) return usage;
  usage.inputTokens = num(u.input_tokens);
  usage.cacheReadTokens = num(u.cache_read_input_tokens);
  usage.outputTokens = num(u.output_tokens);
  const split = u.cache_creation as Record<string, unknown> | undefined;
  if (split && (split.ephemeral_5m_input_tokens !== undefined || split.ephemeral_1h_input_tokens !== undefined)) {
    usage.cacheWrite5mTokens = num(split.ephemeral_5m_input_tokens);
    usage.cacheWrite1hTokens = num(split.ephemeral_1h_input_tokens);
  } else {
    usage.cacheWrite5mTokens = num(u.cache_creation_input_tokens);
  }
  const tools = u.server_tool_use as Record<string, unknown> | undefined;
  usage.webSearches = num(tools?.web_search_requests);
  return usage;
}

class AnthropicStream implements StreamTracker {
  private start: Usage | null = null;
  private final: Usage | null = null;
  private generatedChars = 0;
  private stopped = false;

  onEvent(ev: { event?: string; data: string }): boolean {
    if (!ev.data) return true;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return true;
    }
    switch (d.type) {
      case 'message_start':
        this.start = anthropicUsage(
          (d.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown>,
        );
        break;
      case 'content_block_delta': {
        const delta = d.delta as Record<string, unknown> | undefined;
        for (const f of ['text', 'partial_json', 'thinking']) {
          if (typeof delta?.[f] === 'string') this.generatedChars += (delta[f] as string).length;
        }
        break;
      }
      case 'message_delta': {
        // Cumulative totals for the whole message. Input fields may be present too; when they are
        // missing, the numbers from message_start still apply.
        const u = d.usage as Record<string, unknown> | undefined;
        const merged = { ...this.start, ...stripZero(anthropicUsage(u), u) };
        this.final = { ...emptyUsage(), ...merged };
        break;
      }
      case 'message_stop':
        this.stopped = true;
        break;
    }
    return true;
  }

  usage(): Usage | null {
    return this.stopped && this.final ? this.final : null;
  }

  estimate(fallbackPromptTokens: number): Usage {
    const base = this.final ?? this.start ?? { ...emptyUsage(), inputTokens: fallbackPromptTokens };
    return { ...base, outputTokens: Math.max(base.outputTokens, charsToTokens(this.generatedChars)) };
  }
}

/** Keeps only the fields the event actually reported, so absent fields don't overwrite real numbers. */
function stripZero(usage: Usage, raw: Record<string, unknown> | undefined): Partial<Usage> {
  if (!raw) return {};
  const out: Partial<Usage> = { outputTokens: usage.outputTokens };
  if (raw.input_tokens !== undefined) out.inputTokens = usage.inputTokens;
  if (raw.cache_read_input_tokens !== undefined) out.cacheReadTokens = usage.cacheReadTokens;
  if (raw.cache_creation_input_tokens !== undefined || raw.cache_creation !== undefined) {
    out.cacheWrite5mTokens = usage.cacheWrite5mTokens;
    out.cacheWrite1hTokens = usage.cacheWrite1hTokens;
  }
  if (raw.server_tool_use !== undefined) out.webSearches = usage.webSearches;
  return out;
}

export const anthropic: ProviderAdapter = {
  provider: 'anthropic',
  displayName: 'Anthropic',
  endpoints: {
    '/v1/messages': { method: 'POST', metered: true },
    '/v1/messages/count_tokens': { method: 'POST', metered: false },
    '/v1/models': { method: 'GET', metered: false },
  },

  extractKey: (headers) => header(headers, 'x-api-key') ?? bearer(headers),

  inspect(_path, body): RequestInfo {
    return {
      model: typeof body.model === 'string' ? body.model : '',
      stream: body.stream === true,
      maxOutputTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
      outputMultiplier: 1,
      mayWriteCache: JSON.stringify(body).includes('"cache_control"'),
    };
  },

  prepareBody: (_path, body) => ({ body, injectedUsage: false }),

  upstreamHeaders(clientHeaders, realKey) {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': realKey,
      'anthropic-version': header(clientHeaders, 'anthropic-version') ?? '2023-06-01',
    };
    const beta = header(clientHeaders, 'anthropic-beta');
    if (beta) h['anthropic-beta'] = beta;
    return h;
  },

  usageFromJson: (_path, json) => {
    const u = (json as Record<string, unknown> | null)?.usage;
    return u ? anthropicUsage(u as Record<string, unknown>) : null;
  },

  streamTracker: () => new AnthropicStream(),

  errorBody: (kind, message) => ({ type: 'error', error: { type: ERROR_TYPES[kind], message } }),
};
