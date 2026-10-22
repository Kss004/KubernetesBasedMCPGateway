// Handling many tools: ranking, and search mode in the chat loop keeping the normal checks and audit.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchTools } from '../src/toolsearch.ts';
import { handleChat } from '../src/chat.ts';

process.env.LLM_BASE_URL ??= 'https://test.invalid/v1';
process.env.LLM_MODEL ??= 'test-model';
process.env.LLM_API_KEY ??= 'test-key';

const mk = (name: string, description: string) => {
  const slug = name.split('__')[0];
  return { name, description, inputSchema: { type: 'object', properties: { per_page: { type: 'integer' } } }, serverId: slug, serverSlug: slug, changed: false };
};
const stores = ['alpha', 'beta', 'gamma', 'delta'];
const TOOLS = [
  ...stores.flatMap((s) => [
    mk(`store-${s}__list_orders`, 'List orders, with count and total.'),
    mk(`store-${s}__list_products`, 'List products in the store.'),
    mk(`store-${s}__create_product`, 'Create a product with a name and price.'),
  ]),
  mk('mock__convert_currency', 'Convert an amount between currencies at fixed demo rates.'),
  mk('deepwiki__ask_wiki_question', 'Ask a question about a GitHub repository.'),
];

describe('searchTools', () => {
  it('puts the named store first and matches plural and singular', () => {
    const r = searchTools(TOOLS, 'beta orders').map((t) => t.name);
    assert.equal(r[0], 'store-beta__list_orders');
    assert.ok(r.length <= 8);
  });
  it('finds a tool by what it does, from its description', () => {
    assert.equal(searchTools(TOOLS, 'convert currency')[0].name, 'mock__convert_currency');
    assert.equal(searchTools(TOOLS, 'github repository question')[0].name, 'deepwiki__ask_wiki_question');
  });
  it('returns nothing for an empty or unrelated query', () => {
    assert.deepEqual(searchTools(TOOLS, ''), []);
    assert.deepEqual(searchTools(TOOLS, 'zzz qqq'), []);
  });
});

describe('chat search mode', () => {
  const run = async (role: 'admin' | 'member', script: Array<Array<{ name: string; arguments: unknown }>>) => {
    const audit: unknown[][] = [];
    const pg = { query: async (_q: unknown, v: unknown[]) => { audit.push(v); return { rows: [] }; } };
    const aggregator = { listAllTools: () => TOOLS, resolve: (n: string) => { const t = TOOLS.find((x) => x.name === n); return t ? { serverId: t.serverId, tool: t } : null; } };
    const upstreamCalls: string[] = [];
    const upstreams = { callTool: async (sid: string, tool: string) => { upstreamCalls.push(`${sid}/${tool}`); return { content: [{ type: 'text', text: '{"count":1,"total":"9.99"}' }] }; } };
    const sentTools: string[][] = [];
    const toolResults: string[] = [];
    let n = 0;
    const fetchImpl = (async (_u: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> };
      sentTools.push((body.tools ?? []).map((t) => t.function.name));
      for (const m of body.messages) if (m.role === 'tool' && !toolResults.includes(m.content)) toolResults.push(m.content);
      const calls = script[n++];
      const msg = calls
        ? { content: '', tool_calls: calls.map((c, i) => ({ id: `c${n}${i}`, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
        : { content: 'Alpha: 1 order, 9.99', tool_calls: [] };
      return { ok: true, json: async () => ({ choices: [{ message: msg }] }) };
    }) as unknown as typeof fetch;
    const events: string[] = [];
    const res = { writableEnded: false, headersSent: false, writeHead: () => {}, write: (s: string) => (events.push(s), true), end: () => {}, on: () => {} };
    await handleChat({
      pg: pg as never, aggregator: aggregator as never, upstreams: upstreams as never,
      user: { id: 'u1', name: 'A', role }, body: { messages: [{ role: 'user', content: 'orders in alpha today?' }] },
      res: res as never, fetchImpl, toolSearchThreshold: 5,
    });
    return { audit, upstreamCalls, sentTools, toolResults, events };
  };

  it('above the threshold the model sees only the two meta-tools, and call_tool runs and audits the real tool', async () => {
    const r = await run('admin', [
      [{ name: 'search_tools', arguments: { query: 'alpha orders' } }],
      [{ name: 'call_tool', arguments: { name: 'store-alpha__list_orders', arguments: { per_page: 5 } } }],
    ]);
    assert.deepEqual(r.sentTools[0], ['search_tools', 'call_tool']);
    assert.match(r.toolResults[0], /store-alpha__list_orders/);
    assert.deepEqual(r.upstreamCalls, ['store-alpha/list_orders']);
    assert.equal(r.audit.length, 1);
    assert.deepEqual([r.audit[0][3], r.audit[0][4]], ['store-alpha__list_orders', 'ok']);
  });

  it('a member never finds denied tools, and call_tool on one is refused and audited as denied', async () => {
    const r = await run('member', [
      [{ name: 'search_tools', arguments: { query: 'create product alpha' } }],
      [{ name: 'call_tool', arguments: { name: 'store-alpha__create_product', arguments: {} } }],
    ]);
    assert.doesNotMatch(r.toolResults[0], /create_product/);
    assert.deepEqual(r.upstreamCalls, []);
    assert.deepEqual([r.audit[0][3], r.audit[0][4], r.audit[0][5]], ['store-alpha__create_product', 'denied', 'forbidden']);
  });

  it('call_tool still validates arguments against the tool schema', async () => {
    const r = await run('admin', [[{ name: 'call_tool', arguments: { name: 'store-alpha__list_orders', arguments: { per_page: 'five' } } }]]);
    assert.deepEqual(r.upstreamCalls, []);
    assert.equal(r.audit[0][5], 'validation');
  });
});
