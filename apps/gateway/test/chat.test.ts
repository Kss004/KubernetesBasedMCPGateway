// P6 chat loop: system prompt date, zod arg validation, tool loop with
// mocked fetch (no gateway needed), turn cap.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  toLlmTools,
  validateToolArgs,
  driveLoop,
  chatCompletions,
  handleChat,
  MAX_TURNS,
  type LlmMessage,
  type LlmTurn,
} from '../src/chat.ts';

// handleChat reads LLM config from env; pin dummy values so the unit test
// never depends on the machine's environment (fetch is always injected).
process.env.LLM_BASE_URL ??= 'https://test.invalid/v1beta/openai';
process.env.LLM_MODEL ??= 'test-model';
process.env.LLM_API_KEY ??= 'test-key';

describe('buildSystemPrompt', () => {
  it('pins the current date for after/before questions', () => {
    const s = buildSystemPrompt(new Date('2026-10-16T09:00:00Z'));
    assert.ok(s.includes('2026-10-16') && s.includes('list_orders'));
  });
});

describe('toLlmTools', () => {
  it('maps prefixed tools to function tools, defaulting bad schemas', () => {
    const out = toLlmTools([
      { name: 'woo__list_orders', description: 'd', inputSchema: { type: 'object' }, serverId: 's', serverSlug: 'woo', changed: false },
      { name: 'x__y', description: '', inputSchema: null, serverId: 's', serverSlug: 'x', changed: false },
    ]);
    assert.equal(out[0].function.name, 'woo__list_orders');
    assert.deepEqual(out[1].function.parameters, { type: 'object' });
  });
});

describe('validateToolArgs', () => {
  const schema = { type: 'object', properties: { after: { type: 'string' }, limit: { type: 'integer' } }, required: ['after'] };
  it('passes good args, keeps extras', () => {
    const r = validateToolArgs(schema, { after: '2026-10-16', extra: 1 });
    assert.equal(r.ok, true);
  });
  it('rejects missing required, wrong types, non-integers, bad enum', () => {
    assert.equal(validateToolArgs(schema, {}).ok, false);
    assert.equal(validateToolArgs(schema, { after: 5 }).ok, false);
    assert.equal(validateToolArgs(schema, { after: 'x', limit: 1.5 }).ok, false);
    assert.equal(validateToolArgs({ type: 'object', properties: { s: { enum: ['a'] } } }, { s: 'b' }).ok, false);
  });
  it('passes through when no usable schema', () => {
    assert.equal(validateToolArgs(null, { a: 1 }).ok, true);
    assert.equal(validateToolArgs({}, 'nope').ok, false);
  });
});

describe('driveLoop', () => {
  it('runs tool then answers, emitting tool + text + done', async () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'orders today?' }];
    const turns: LlmTurn[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'woo__list_orders', argsText: '{"after":"2026-10-16"}' }] },
      { content: '2 orders today.', toolCalls: [] },
    ];
    const events: Array<{ event: string; data: unknown }> = [];
    let n = 0;
    const emit = (event: string, data: unknown): void => {
      events.push({ event, data });
    };
    await driveLoop({
      messages,
      callLlm: async () => turns[n++],
      callTool: async (name, argsText) => {
        emit('tool', { name, status: 'start' }); // mirrors handleChat's dispatch wrapper
        assert.equal(name, 'woo__list_orders');
        assert.ok(argsText.includes('2026-10-16'));
        emit('tool', { name, status: 'done' });
        return { ok: true, text: '{"orders":[]}' };
      },
      emit,
    });
    assert.deepEqual(events.map((e) => e.event), ['tool', 'tool', 'text', 'done']);
    assert.ok(messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'));
  });
  it('feeds validation errors back to the model', async () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'hi' }];
    const events: string[] = [];
    let calls = 0;
    await driveLoop({
      messages,
      callLlm: async () =>
        calls++ === 0
          ? { content: '', toolCalls: [{ id: 'c1', name: 't', argsText: '{}' }] }
          : { content: 'fixed', toolCalls: [] },
      callTool: async () => ({ ok: false, error: 'missing required argument: after' }),
      emit: (event) => events.push(event),
      maxTurns: 4,
    });
    assert.ok(messages.some((m) => m.role === 'tool' && (m.content as string).includes('missing required')));
    assert.equal(events[events.length - 1], 'done');
  });
  it(`stops at the turn cap (${MAX_TURNS})`, async () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'loop me' }];
    const events: string[] = [];
    await driveLoop({
      messages,
      callLlm: async () => ({ content: '', toolCalls: [{ id: 'c', name: 't', argsText: '{}' }] }),
      callTool: async () => ({ ok: true, text: '{}' }),
      emit: (event) => events.push(event),
      maxTurns: 3,
    });
    assert.equal(events[events.length - 1], 'error');
    assert.equal(messages.filter((m) => m.role === 'assistant').length, 3);
  });
  it('echoes provider extra_content (Gemini 3 thought_signature) back on the next turn', async () => {
    const extra = { google: { thought_signature: 'sig' } };
    const messages: LlmMessage[] = [{ role: 'user', content: 'q' }];
    let n = 0;
    await driveLoop({
      messages,
      callLlm: async () =>
        n++ === 0
          ? { content: '', toolCalls: [{ id: 'c1', name: 't', argsText: '{}', extra }] }
          : { content: 'ok', toolCalls: [] },
      callTool: async () => ({ ok: true, text: '{}' }),
      emit: () => {},
    });
    const sent = messages.find((m) => m.role === 'assistant')?.tool_calls?.[0];
    assert.deepEqual(sent?.extra_content, extra);
  });
});

describe('handleChat', () => {
  it('dispatches validated args, audits as the human user, emits SSE tool/text/done', async () => {
    const tool = {
      name: 'woo__list_orders',
      description: 'd',
      inputSchema: { type: 'object', properties: { after: { type: 'string' } }, required: ['after'] },
      serverId: 's1',
      serverSlug: 'woo',
      changed: false,
    };
    const auditParams: unknown[][] = [];
    const pg = { query: async (...a: unknown[]) => { auditParams.push(a); return { rows: [] }; } };
    const aggregator = { listAllTools: () => [tool], resolve: (n: string) => (n === tool.name ? { serverId: 's1', tool } : null) };
    const upstreamArgs: unknown[] = [];
    const upstreams = {
      callTool: async (sid: string, tname: string, args: unknown) => {
        upstreamArgs.push([sid, tname, args]);
        return { content: [{ type: 'text', text: '[]' }] };
      },
    };
    const llmTurns: LlmTurn[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'woo__list_orders', argsText: '{"after":"2026-10-16"}' }] },
      { content: '2 orders today.', toolCalls: [] },
    ];
    let n = 0;
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => {
        const t = llmTurns[n++];
        return {
          choices: [
            {
              message: {
                content: t.content,
                tool_calls: t.toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.argsText } })),
              },
            },
          ],
        };
      },
    })) as unknown as typeof fetch;
    const chunks: string[] = [];
    const res = {
      writableEnded: false,
      headersSent: false,
      writeHead: () => {},
      write: (c: string) => { chunks.push(String(c)); return true; },
      end: () => {},
      on: () => {},
    };
    await handleChat({
      pg: pg as never,
      aggregator: aggregator as never,
      upstreams: upstreams as never,
      user: { id: 'u1', name: 'B', role: 'member' },
      body: { messages: [{ role: 'user', content: 'orders today?' }] },
      res: res as never,
      fetchImpl,
    });
    const sse = chunks.join('');
    assert.ok(sse.includes('"status":"start"') && sse.includes('"status":"done"'));
    assert.ok(sse.includes('2 orders today.') && sse.includes('event: done'));
    assert.deepEqual(upstreamArgs, [['s1', 'list_orders', { after: '2026-10-16' }]]); // prefix stripped, zod-checked
    const auditValues = auditParams[0][1] as unknown[];
    assert.equal(auditValues[0], 'u1'); // human user, not a service account
    assert.ok((auditValues[3] as string).includes('list_orders'));
  });
});
describe('chatCompletions', () => {
  it('posts OpenAI-compatible shape with bearer key and parses tool calls', async () => {
    let gotUrl = '';
    let gotBody: Record<string, unknown> = {};
    let gotAuth = '';
    const fakeFetch = (async (url: unknown, init: unknown) => {
      gotUrl = String(url);
      const i = init as { headers: Record<string, string>; body: string };
      gotAuth = i.headers.Authorization;
      gotBody = JSON.parse(i.body) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{"a":1}' } }] } }],
        }),
      };
    }) as typeof fetch;
    const turn = await chatCompletions(
      [{ role: 'user', content: 'hi' }],
      [{ type: 'function', function: { name: 't', description: 't', parameters: {} } }],
      { baseUrl: 'https://x/v1beta/openai/', model: 'm', apiKey: 'k' },
      fakeFetch,
    );
    assert.equal(gotUrl, 'https://x/v1beta/openai/chat/completions');
    assert.equal(gotAuth, 'Bearer k');
    assert.equal((gotBody as { model: string }).model, 'm');
    assert.equal(turn.toolCalls[0].name, 't');
    assert.equal(turn.content, 'hi');
  });
});

describe('handleChat permissions (bug 1)', () => {
  it('hides and rejects member-denied tools, audits the attempt as denied', async () => {
    const mk = (name: string) => ({ name, description: 'd', inputSchema: { type: 'object' }, serverId: 's1', serverSlug: 'woo', changed: false });
    const tools = [mk('woo__list_orders'), mk('woo__create_product')];
    const audit: unknown[][] = [];
    const pg = { query: async (_q: unknown, v: unknown[]) => { audit.push(v); return { rows: [] }; } };
    const aggregator = { listAllTools: () => tools, resolve: (n: string) => { const t = tools.find((x) => x.name === n); return t ? { serverId: 's1', tool: t } : null; } };
    let upstreamCalls = 0;
    const upstreams = { callTool: async () => { upstreamCalls++; return { content: [] }; } };
    const sentTools: string[][] = [];
    let n = 0;
    const fetchImpl = (async (_u: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { tools?: Array<{ function: { name: string } }> };
      sentTools.push((body.tools ?? []).map((t) => t.function.name));
      const msg = n++ === 0
        ? { content: '', tool_calls: [{ id: 'c1', function: { name: 'woo__create_product', arguments: '{}' } }] }
        : { content: 'cannot', tool_calls: [] };
      return { ok: true, json: async () => ({ choices: [{ message: msg }] }) };
    }) as unknown as typeof fetch;
    const res = { writableEnded: false, headersSent: false, writeHead: () => {}, write: () => true, end: () => {}, on: () => {} };
    await handleChat({
      pg: pg as never, aggregator: aggregator as never, upstreams: upstreams as never,
      user: { id: 'u2', name: 'B', role: 'member' },
      body: { messages: [{ role: 'user', content: 'make a product' }] },
      res: res as never, fetchImpl,
    });
    assert.deepEqual(sentTools[0], ['woo__list_orders']); // model never sees the write tool
    assert.equal(upstreamCalls, 0); // forged direct call never reaches upstream
    assert.equal(audit[0][4], 'denied');
  });
});
