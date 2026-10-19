// everything-mcp: third upstream (T7.1), deterministic and offline (D8).
// Reuses mcp-mini stateless shell like mock-mcp. No auth, no network.
// Tools: echo (round-trip), add (tiny deterministic op).
// ponytail: stateless here, real SDK everything is stateful; pool 404-retry covers both.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { serve } from 'mcp-mini';

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });

function register(server: McpServer): void {
  server.registerTool(
    'echo',
    { description: 'Echo back the input text.', inputSchema: { text: z.string() } },
    async (args) => text({ echo: args.text }),
  );
  server.registerTool(
    'add',
    { description: 'Add two numbers.', inputSchema: { a: z.number(), b: z.number() } },
    async (args) => text({ result: args.a + args.b }),
  );
}

serve({ name: 'everything-mcp', version: '0.1.0', port: Number(process.env.PORT ?? 3000), register });
