// Handling many tools (stand-out). Every store adds 5 tools and every server a few more, and a
// model handed hundreds of tool schemas gets slow, expensive and confused. Above a threshold the
// chat agent gets two meta-tools instead of the full list:
//   search_tools(query)            -> the best-matching tools the user may call, with schemas
//   call_tool(name, arguments)     -> runs one of them through the normal path (role check,
//                                      schema check, audit), exactly like a direct call.
// /mcp is unchanged: external clients still list every tool and choose for themselves.
import type { PrefixedTool } from './aggregator.js';

export const SEARCH_TOOL = 'search_tools';
export const CALL_TOOL = 'call_tool';
export const SEARCH_LIMIT = 8;

export const META_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: SEARCH_TOOL,
      description:
        'Find tools by what they do. Returns up to 8 matching tools with their exact names, descriptions and argument schemas. ' +
        'Include the store or server name when the question is about one (e.g. "alpha orders").',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What you need, in a few words, e.g. "list orders beta store"' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: CALL_TOOL,
      description: 'Call a tool found with search_tools, by its exact name, with arguments matching its schema.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact tool name from search_tools, e.g. store-alpha__list_orders' },
          arguments: { type: 'object', description: 'Arguments for that tool' },
        },
        required: ['name'],
      },
    },
  },
];

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

// Light stemming so "orders"/"order" and "products"/"product" match.
const stem = (w: string): string => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

/** Ranks tools by keyword overlap: name parts (server slug and tool name) count more than description words. */
export function searchTools(tools: PrefixedTool[], query: string, limit = SEARCH_LIMIT): PrefixedTool[] {
  const q = [...new Set(words(query).map(stem))];
  if (q.length === 0) return [];
  const scored = tools.map((t) => {
    const nameParts = new Set(words(t.name).map(stem));
    const desc = new Set(words(t.description).map(stem));
    let score = 0;
    for (const w of q) {
      if (nameParts.has(w)) score += 3;
      else if (desc.has(w)) score += 1;
    }
    return { t, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .slice(0, limit)
    .map((x) => x.t);
}

/** The prompt lines that tell the model how to work in search mode. */
export function searchPrompt(tools: PrefixedTool[]): string {
  const servers = [...new Set(tools.map((t) => t.serverSlug))].sort();
  return [
    `There are ${tools.length} tools across these servers: ${servers.join(', ')}. Tool names are <server>__<tool>.`,
    'You do not see them directly: call search_tools to find the right ones, then call_tool with the exact name and arguments.',
    'For a question about several stores, find and call the tool for each store.',
  ].join('\n');
}
