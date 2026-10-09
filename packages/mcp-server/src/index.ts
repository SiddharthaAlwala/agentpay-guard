#!/usr/bin/env node
/**
 * AgentPay Guard MCP server.
 *
 * Gives any MCP-capable agent (Claude Desktop, Claude Code, LangGraph, your own) three tools:
 *   request_payment, check_budget, get_payment_status
 * Every payment goes through the guard's policy engine. The agent never holds card details.
 *
 * Config (env):
 *   AGENTPAY_URL      default http://localhost:8080
 *   AGENTPAY_API_KEY  the agent's key (apg_...)
 */
import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GuardClient, formatDecision, type Decision } from './client.js';

const baseUrl = process.env.AGENTPAY_URL ?? 'http://localhost:8080';
const apiKey = process.env.AGENTPAY_API_KEY;
if (!apiKey) {
  console.error('AGENTPAY_API_KEY is required (e.g. apg_demo_shopping_assistant in demo mode)');
  process.exit(1);
}

const client = new GuardClient(baseUrl, apiKey);
// Retries of an identical call within this session reuse the same idempotency key,
// so a confused or looping agent cannot pay twice for the same thing.
const session = randomUUID();

const server = new McpServer({ name: 'agentpay-guard', version: '1.0.0' });

server.registerTool(
  'request_payment',
  {
    title: 'Request a payment',
    description:
      "Pay a merchant on the user's behalf. The request is checked against the user's spending policy and may be " +
      "approved, blocked, or held for the user's approval. Always pass the user's original request as user_intent. " +
      'If a payment is blocked, do not try to work around it: tell the user why.',
    inputSchema: {
      merchant: z.string().describe('Merchant name, e.g. "Amazon"'),
      category: z
        .string()
        .describe(
          'Spending category slug, e.g. electronics, books, office_supplies, flights, hotels, groceries, software',
        ),
      amount_usd: z.number().positive().describe('Total amount in US dollars, e.g. 49.99'),
      reason: z.string().describe('What is being bought and why, in your own words'),
      user_intent: z.string().optional().describe("The user's original request, verbatim"),
      source_url: z.string().optional().describe('The page where you found this item'),
    },
  },
  async (args) => {
    const body = {
      merchant: args.merchant,
      category: args.category.toLowerCase().replace(/[^a-z0-9_-]+/g, '_'),
      amountCents: Math.round(args.amount_usd * 100),
      currency: 'USD',
      reason: args.reason,
      context: { userIntent: args.user_intent, sourceUrl: args.source_url },
    };
    const key = createHash('sha256').update(session).update(JSON.stringify(body)).digest('hex').slice(0, 40);
    try {
      const decision = await client.requestPayment(body, key);
      return {
        content: [{ type: 'text', text: formatDecision(decision) }],
        structuredContent: decision as unknown as Record<string, unknown>,
      };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Payment service error: ${(err as Error).message}` }] };
    }
  },
);

server.registerTool(
  'check_budget',
  {
    title: 'Check remaining budget',
    description:
      'Shows how much the user has allowed you to spend today and this month, and which categories are allowed.',
    inputSchema: {},
  },
  async () => {
    try {
      const b = await client.budget();
      const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
      const text = [
        `Daily: ${usd(b.daily.remainingCents)} remaining of ${usd(b.daily.limitCents)}`,
        `Monthly: ${usd(b.monthly.remainingCents)} remaining of ${usd(b.monthly.limitCents)}`,
        `Per transaction limit: ${usd(b.perTransactionLimitCents)}; purchases of ${usd(b.approvalThresholdCents)} or more need the user's approval`,
        `Allowed categories: ${b.allowedCategories.length ? b.allowedCategories.join(', ') : 'any (except blocked)'}`,
        `Never allowed: ${b.blockedCategories.join(', ')}`,
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Payment service error: ${(err as Error).message}` }] };
    }
  },
);

server.registerTool(
  'get_payment_status',
  {
    title: 'Check a payment',
    description: 'Look up a payment by id, e.g. to see whether the user approved a held payment.',
    inputSchema: { payment_id: z.string().describe('The id returned by request_payment') },
  },
  async ({ payment_id }) => {
    try {
      const d: Decision = await client.payment(payment_id);
      return { content: [{ type: 'text', text: formatDecision(d) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Payment service error: ${(err as Error).message}` }] };
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`agentpay-guard MCP server ready (guard: ${baseUrl})`);
