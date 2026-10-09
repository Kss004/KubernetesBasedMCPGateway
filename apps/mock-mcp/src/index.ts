// mock-mcp: deterministic second upstream (T3.0) so aggregation/routing is
// testable before the gateway lands. No bearer token: exercises the
// optional-credential path. Tools:
// - convert_currency: plausible deterministic tool (fixed table, no network).
// - list_products: DELIBERATE name collision with woo-mcp (gateway prefixes).
// - sleep_forever: timeout demo (gateway must bound it, T3.5).
// - break_me: kill switch; flips this server failing until pod restart.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { serve } from 'mcp-mini';

let broken = false;
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const guard = () => {
  if (broken) throw new Error('mock-mcp is broken (break_me toggled)');
};

const RATES: Record<string, number> = { USD: 1, EUR: 0.92, INR: 83.2, GBP: 0.79 };

function register(server: McpServer): void {
  server.registerTool(
    'convert_currency',
    {
      description: 'Convert an amount between currencies at fixed demo rates.',
      inputSchema: {
        amount: z.number().positive(),
        from: z.enum(['USD', 'EUR', 'INR', 'GBP']),
        to: z.enum(['USD', 'EUR', 'INR', 'GBP']),
      },
    },
    async (args) => {
      guard();
      const usd = args.amount / RATES[args.from];
      return text({ amount: args.amount, from: args.from, to: args.to, result: +(usd * RATES[args.to]).toFixed(2) });
    },
  );

  server.registerTool(
    'list_products',
    { description: 'List demo products (name collides with woo-mcp on purpose).', inputSchema: {} },
    async () => {
      guard();
      return text([
        { id: 901, name: 'Mock Widget', price: '1.00' },
        { id: 902, name: 'Mock Gizmo', price: '2.00' },
      ]);
    },
  );

  server.registerTool(
    'sleep_forever',
    { description: 'Sleeps until the caller times out (failure-demo tool).', inputSchema: {} },
    async () => {
      guard();
      await new Promise((r) => setTimeout(r, 10 * 60 * 1000));
      return text({ woke: true });
    },
  );

  server.registerTool(
    'break_me',
    { description: 'Kill switch: makes every tool fail until pod restart.', inputSchema: {} },
    async () => {
      broken = true;
      return text({ broken: true });
    },
  );
}

serve({ name: 'mock-mcp', version: '0.1.0', port: Number(process.env.PORT ?? 3000), register });
