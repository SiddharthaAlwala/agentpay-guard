import type { Provider } from '../pricing/catalog.js';
import type { Usage } from '../pricing/cost.js';
import type { SseEvent } from '../sse.js';

/** What the proxy needs to know about a request before forwarding it. */
export interface RequestInfo {
  model: string;
  stream: boolean;
  /** The request's own output limit, or null when it sets none (the model maximum then applies). */
  maxOutputTokens: number | null;
  /** n > 1 asks for several completions, each billed in full. */
  outputMultiplier: number;
  /** The prompt may be written to the cache, which bills those tokens above the input rate. */
  mayWriteCache: boolean;
  /** Set when the request uses a feature the proxy cannot meter; it is refused with this message. */
  unsupported?: string;
}

export interface Endpoint {
  method: 'GET' | 'POST';
  /** Metered endpoints are budgeted and billed; the others are free calls forwarded as-is. */
  metered: boolean;
}

export type ErrorKind =
  | 'authentication'
  | 'permission'
  | 'invalid_request'
  | 'not_found'
  | 'rate_limit'
  | 'budget'
  | 'unavailable'
  | 'upstream';

export const ERROR_STATUS: Record<ErrorKind, number> = {
  authentication: 401,
  permission: 403,
  invalid_request: 400,
  not_found: 404,
  rate_limit: 429,
  budget: 429,
  unavailable: 503,
  upstream: 502,
};

/** Reads a provider's streaming events, keeping track of usage as it goes. */
export interface StreamTracker {
  /** Returns false for an event the client should not receive. */
  onEvent(ev: SseEvent): boolean;
  /** Exact usage, once the provider has reported it. */
  usage(): Usage | null;
  /** Best guess from what was streamed, for streams that end before usage is reported. */
  estimate(fallbackPromptTokens: number): Usage;
}

export interface ProviderAdapter {
  provider: Provider;
  displayName: string;
  endpoints: Record<string, Endpoint>;
  extractKey(headers: Record<string, string | string[] | undefined>): string | null;
  inspect(path: string, body: Record<string, unknown>): RequestInfo;
  /** Returns the body to send upstream, and whether we changed it in a way the stream must undo. */
  prepareBody(
    path: string,
    body: Record<string, unknown>,
    info: RequestInfo,
  ): {
    body: Record<string, unknown>;
    injectedUsage: boolean;
  };
  upstreamHeaders(
    clientHeaders: Record<string, string | string[] | undefined>,
    realKey: string,
  ): Record<string, string>;
  usageFromJson(path: string, json: unknown): Usage | null;
  streamTracker(path: string, injectedUsage: boolean): StreamTracker;
  /** An error body in this provider's own format, so its SDKs raise their usual exceptions. */
  errorBody(kind: ErrorKind, message: string, code: string): unknown;
}

export function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function bearer(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = header(headers, 'authorization');
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]!.trim() : null;
}

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Characters of generated text seen in a stream, for estimating cut-off streams (≈3 chars/token). */
export const charsToTokens = (chars: number) => Math.ceil(chars / 3);
