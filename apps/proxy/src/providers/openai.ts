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

const CHAT = '/v1/chat/completions';
const RESPONSES = '/v1/responses';

const ERROR_TYPES: Record<ErrorKind, string> = {
  authentication: 'invalid_request_error',
  permission: 'invalid_request_error',
  invalid_request: 'invalid_request_error',
  not_found: 'invalid_request_error',
  rate_limit: 'requests',
  // OpenAI itself answers an exhausted balance with 429 insufficient_quota; we mirror that.
  budget: 'insufficient_quota',
  unavailable: 'server_error',
  upstream: 'server_error',
};

/** Chat Completions and Responses name the same numbers differently. Cached tokens are a subset of the prompt. */
export function openaiUsage(path: string, u: Record<string, unknown> | undefined | null): Usage | null {
  if (!u) return null;
  const usage = emptyUsage();
  const chat = path === CHAT;
  const prompt = num(chat ? u.prompt_tokens : u.input_tokens);
  const details = (chat ? u.prompt_tokens_details : u.input_tokens_details) as Record<string, unknown> | undefined;
  const cached = Math.min(num(details?.cached_tokens), prompt);
  usage.inputTokens = prompt - cached;
  usage.cacheReadTokens = cached;
  // Reasoning tokens are already included in the output count.
  usage.outputTokens = num(chat ? u.completion_tokens : u.output_tokens);
  return usage;
}

class ChatStream implements StreamTracker {
  private final: Usage | null = null;
  private generatedChars = 0;

  constructor(private injectedUsage: boolean) {}

  onEvent(ev: { data: string }): boolean {
    if (!ev.data || ev.data === '[DONE]') return true;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return true;
    }
    const choices = Array.isArray(d.choices) ? (d.choices as Array<Record<string, unknown>>) : [];
    for (const c of choices) {
      const delta = c.delta as Record<string, unknown> | undefined;
      for (const f of ['content', 'refusal', 'reasoning_content']) {
        if (typeof delta?.[f] === 'string') this.generatedChars += (delta[f] as string).length;
      }
      for (const t of (delta?.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
        const args = (t.function as Record<string, unknown> | undefined)?.arguments;
        if (typeof args === 'string') this.generatedChars += args.length;
      }
    }
    if (d.usage) {
      this.final = openaiUsage(CHAT, d.usage as Record<string, unknown>);
      // We asked for this usage-only chunk ourselves; a client that didn't ask may not expect a
      // chunk with an empty choices array, so it is held back.
      if (this.injectedUsage && choices.length === 0) return false;
    }
    return true;
  }

  usage() {
    return this.final;
  }

  estimate(fallbackPromptTokens: number): Usage {
    return { ...emptyUsage(), inputTokens: fallbackPromptTokens, outputTokens: charsToTokens(this.generatedChars) };
  }
}

class ResponsesStream implements StreamTracker {
  private final: Usage | null = null;
  private generatedChars = 0;

  onEvent(ev: { data: string }): boolean {
    if (!ev.data) return true;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return true;
    }
    const type = String(d.type ?? '');
    if (type.endsWith('.delta') && typeof d.delta === 'string') this.generatedChars += d.delta.length;
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const usage = (d.response as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
      this.final = openaiUsage(RESPONSES, usage) ?? this.final;
    }
    return true;
  }

  usage() {
    return this.final;
  }

  estimate(fallbackPromptTokens: number): Usage {
    return { ...emptyUsage(), inputTokens: fallbackPromptTokens, outputTokens: charsToTokens(this.generatedChars) };
  }
}

export const openai: ProviderAdapter = {
  provider: 'openai',
  displayName: 'OpenAI',
  endpoints: {
    [CHAT]: { method: 'POST', metered: true },
    [RESPONSES]: { method: 'POST', metered: true },
    '/v1/models': { method: 'GET', metered: false },
  },

  extractKey: (headers) => bearer(headers) ?? header(headers, 'x-api-key') ?? null,

  inspect(path, body): RequestInfo {
    const info: RequestInfo = {
      model: typeof body.model === 'string' ? body.model : '',
      stream: body.stream === true,
      maxOutputTokens: null,
      outputMultiplier: 1,
      mayWriteCache: false,
    };
    if (path === CHAT) {
      const max = body.max_completion_tokens ?? body.max_tokens;
      info.maxOutputTokens = typeof max === 'number' ? max : null;
      info.outputMultiplier = typeof body.n === 'number' && body.n > 1 ? body.n : 1;
    } else {
      info.maxOutputTokens = typeof body.max_output_tokens === 'number' ? body.max_output_tokens : null;
      if (body.background === true) {
        // Background responses finish after the HTTP call returns, so their cost can't be seen here.
        info.unsupported = 'background responses are not supported through Spend Guard yet';
      }
    }
    return info;
  },

  prepareBody(path, body, info) {
    // Chat Completions only reports usage in a stream when asked to. We always need it to bill
    // accurately, so we ask, and hide the extra chunk from clients that didn't.
    if (path === CHAT && info.stream) {
      const opts = (body.stream_options ?? {}) as Record<string, unknown>;
      if (opts.include_usage !== true) {
        return { body: { ...body, stream_options: { ...opts, include_usage: true } }, injectedUsage: true };
      }
    }
    return { body, injectedUsage: false };
  },

  upstreamHeaders(clientHeaders, realKey) {
    const h: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${realKey}` };
    const beta = header(clientHeaders, 'openai-beta');
    if (beta) h['openai-beta'] = beta;
    return h;
  },

  usageFromJson: (path, json) =>
    openaiUsage(path, (json as Record<string, unknown> | null)?.usage as Record<string, unknown> | undefined),

  streamTracker: (path, injectedUsage) => (path === CHAT ? new ChatStream(injectedUsage) : new ResponsesStream()),

  errorBody: (kind, message, code) => ({ error: { message, type: ERROR_TYPES[kind], param: null, code } }),
};
