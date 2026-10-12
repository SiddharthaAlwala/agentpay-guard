import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { AddressInfo } from 'node:net';

/**
 * A fake Anthropic + OpenAI API that behaves like the real ones for the parts the proxy relies
 * on: authentication, usage numbers, and streaming event formats. Behaviour is steered by a
 * marker in the prompt text, e.g. "MOCK:error" or "MOCK:slow".
 */
export const REAL_ANTHROPIC_KEY = 'sk-ant-test-real-key-0001';
export const REAL_OPENAI_KEY = 'sk-proj-test-real-key-0002';

export interface MockState {
  calls: number;
  lastBody: Record<string, unknown> | null;
  lastHeaders: Record<string, unknown>;
  aborted: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startMockProviders(): Promise<{ url: string; state: MockState; app: FastifyInstance }> {
  const state: MockState = { calls: 0, lastBody: null, lastHeaders: {}, aborted: 0 };
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });

  const marker = (req: FastifyRequest) => /MOCK:(\w+)/.exec(JSON.stringify(req.body ?? {}))?.[1];

  const record = (req: FastifyRequest) => {
    state.calls++;
    state.lastBody = req.body as Record<string, unknown>;
    state.lastHeaders = req.headers;
  };

  async function sse(req: FastifyRequest, raw: import('node:http').ServerResponse, events: string[], delayMs: number) {
    let closed = false;
    raw.on('close', () => {
      if (!raw.writableFinished) {
        closed = true;
        state.aborted++;
      }
    });
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_mock_stream' });
    for (const e of events) {
      if (closed) return;
      raw.write(e);
      if (delayMs) await sleep(delayMs);
    }
    raw.end();
  }

  // ---------------- Anthropic ----------------
  app.post('/v1/messages', async (req, reply) => {
    record(req);
    if (req.headers['x-api-key'] !== REAL_ANTHROPIC_KEY) {
      return reply
        .code(401)
        .send({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    }
    const m = marker(req);
    if (m === 'error') {
      return reply
        .code(400)
        .send({ type: 'error', error: { type: 'invalid_request_error', message: 'mock bad request' } });
    }
    if (m === 'delay') await sleep(300);
    const body = req.body as { model: string; stream?: boolean };
    const usage = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 };
    if (!body.stream) {
      reply.header('request-id', 'req_mock_1');
      return {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'Hello from mock Claude' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage,
      };
    }
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const words =
      m === 'slow' ? Array.from({ length: 200 }, (_, i) => `word${i} `) : ['Hello ', 'from ', 'mock ', 'Claude'];
    reply.hijack();
    await sse(
      req,
      reply.raw,
      [
        ev('message_start', {
          message: {
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...usage, output_tokens: 1 },
          },
        }),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ...words.map((w) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: w } })),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }),
        ev('message_stop', {}),
      ],
      m === 'slow' ? 20 : 0,
    );
  });

  app.get('/v1/models', async (req, reply) => {
    record(req);
    const ok =
      req.headers['x-api-key'] === REAL_ANTHROPIC_KEY || req.headers.authorization === `Bearer ${REAL_OPENAI_KEY}`;
    if (!ok) return reply.code(401).send({ error: 'bad key' });
    return { data: [{ id: 'mock-model' }] };
  });

  // ---------------- OpenAI ----------------
  const openaiAuth = (req: FastifyRequest) => req.headers.authorization === `Bearer ${REAL_OPENAI_KEY}`;
  const openaiError = (message: string, code: string) => ({
    error: { message, type: 'invalid_request_error', param: null, code },
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    record(req);
    if (!openaiAuth(req)) return reply.code(401).send(openaiError('Incorrect API key provided', 'invalid_api_key'));
    if (marker(req) === 'error') return reply.code(400).send(openaiError('mock bad request', 'bad'));
    const body = req.body as { model: string; stream?: boolean; stream_options?: { include_usage?: boolean } };
    const usage = {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 20 },
    };
    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: body.model };
    if (!body.stream) {
      return {
        ...base,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from mock GPT' }, finish_reason: 'stop' }],
        usage,
      };
    }
    const withUsage = body.stream_options?.include_usage === true;
    const chunk = (o: object) =>
      `data: ${JSON.stringify({ ...base, ...(withUsage ? { usage: null } : {}), ...o })}\n\n`;
    const events = [
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
      ...['Hello ', 'from ', 'mock ', 'GPT'].map((t) =>
        chunk({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }),
      ),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ...(withUsage ? [`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`] : []),
      'data: [DONE]\n\n',
    ];
    reply.hijack();
    await sse(req, reply.raw, events, 0);
  });

  app.post('/v1/responses', async (req, reply) => {
    record(req);
    if (!openaiAuth(req)) return reply.code(401).send(openaiError('Incorrect API key provided', 'invalid_api_key'));
    const body = req.body as { model: string; stream?: boolean };
    const usage = {
      input_tokens: 80,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 40,
      total_tokens: 120,
    };
    const response = {
      id: 'resp_mock',
      object: 'response',
      created_at: 1,
      model: body.model,
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello from mock Responses', annotations: [] }],
        },
      ],
      usage,
    };
    if (!body.stream) return response;
    let seq = 0;
    const ev = (type: string, data: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`;
    reply.hijack();
    await sse(
      req,
      reply.raw,
      [
        ev('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } }),
        ev('response.output_text.delta', {
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta: 'Hello from mock Responses',
        }),
        ev('response.completed', { response }),
      ],
      0,
    );
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, state, app };
}
