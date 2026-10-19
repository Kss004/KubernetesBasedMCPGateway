// Chat agent tool loop (P6, T6.2-T6.4): POST /api/chat over SSE, in-process (D7).
// Calls the same aggregator/pool as /mcp with the logged-in user's identity;
// every dispatch writes an audit row as that human user, never args/results
// (D22). History arrives from the client each request; nothing stored server-side.
// LLM via OpenAI-compatible chat-completions with plain fetch, no SDK (D10):
// Gemini primary, Ollama fallback via LLM_BASE_URL/LLM_MODEL/LLM_API_KEY
// (key Secret-mounted out-of-band, never in values).
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Pool as PgPool } from 'pg';
import { z } from 'zod';
import { logCall } from './audit.js';
import { splitName, type Aggregator, type PrefixedTool } from './aggregator.js';
import type { UpstreamPool } from './pool.js';
import { CALL_TIMEOUT_MS, capResult, grantsAllow, isToolError } from './router.js';

export const MAX_TURNS = 8;

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = (env.LLM_BASE_URL ?? '').trim();
  const model = (env.LLM_MODEL ?? '').trim();
  const apiKey = (env.LLM_API_KEY ?? '').trim();
  if (!baseUrl || !model || !apiKey) throw Object.assign(new Error('chat not configured'), { status: 503 });
  return { baseUrl, model, apiKey };
}

// The model does not know what "today" means, so pin date + timezone (T6.2);
// list_orders answers "today" via after/before off this day.
export function buildSystemPrompt(now = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return [
    'You are the store assistant.',
    'Format: plain text only. No markdown (no ** or #, no tables), never raw HTML. For lists, one item per line starting with "- ".',
    `Current date: ${now.toISOString().slice(0, 10)}. Timezone: ${tz}. Local time: ${now.toString()}.`,
    'For "today" questions pass after=<day>T00:00:00 and before=<day>T23:59:59 to list_orders.',
    // E2E H1: on follow-up turns the model copied store data from earlier replies (history
    // carries no tool results) instead of calling a tool, and invented orders.
    'Store facts (orders, products, prices, totals, stock, statuses, customers) must come only from tool results in this reply.',
    'For every question about them, call the matching tool now, even if earlier messages mention the same data. Never reuse, guess or invent them.',
    'If a tool fails or returns nothing, say so plainly. Keep each reply short and factual.',
  ].join('\n');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function toLlmTools(
  tools: PrefixedTool[],
): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters: isRecord(t.inputSchema) ? t.inputSchema : { type: 'object' },
    },
  }));
}

const zodForType = (t: unknown): z.ZodTypeAny => {
  if (t === 'string') return z.string();
  if (t === 'number' || t === 'integer') return z.number();
  if (t === 'boolean') return z.boolean();
  if (t === 'array') return z.array(z.unknown());
  if (t === 'object') return z.record(z.string(), z.unknown());
  return z.unknown();
};

/** Zod-check model args against the tool's JSON inputSchema; extra keys pass through. */
export function validateToolArgs(
  inputSchema: unknown,
  args: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!isRecord(args)) return { ok: false, error: 'args must be an object' };
  if (!isRecord(inputSchema) || (inputSchema.type !== undefined && inputSchema.type !== 'object'))
    return { ok: true, value: args };
  if (!isRecord(inputSchema.properties)) {
    const r = z.record(z.string(), z.unknown()).safeParse(args);
    return r.success ? { ok: true, value: args } : { ok: false, error: 'args must be an object' };
  }
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((x): x is string => typeof x === 'string')
    : [];
  for (const name of required) {
    if (!(name in args)) return { ok: false, error: `missing required argument: ${name}` };
  }
  const props = inputSchema.properties as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(args)) {
    const decl = props[k];
    if (!decl || !isRecord(decl)) continue;
    if (Array.isArray(decl.enum) && decl.enum.length > 0 && !decl.enum.includes(v))
      return { ok: false, error: `invalid value for argument ${k}` };
    if (decl.type === undefined) continue;
    const r = zodForType(decl.type).safeParse(v);
    if (!r.success) return { ok: false, error: `invalid type for argument ${k}: expected ${String(decl.type)}` };
    if (decl.type === 'integer' && typeof v === 'number' && !Number.isInteger(v))
      return { ok: false, error: `invalid type for argument ${k}: expected integer` };
  }
  return { ok: true, value: args };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: unknown }>;
  tool_call_id?: string;
}

export interface LlmTurn {
  content: string;
  // extra: provider data to echo back unchanged (Gemini 3 thought_signature, else 400 on the next turn).
  toolCalls: Array<{ id: string; name: string; argsText: string; extra?: unknown }>;
}

export async function chatCompletions(
  messages: LlmMessage[],
  llmTools: unknown[],
  cfg: LlmConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<LlmTurn> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let resp: Response;
  // ponytail: one retry on 429, waiting retry-after (seconds, capped at 10s; 1s if absent
  // or a date). No retry library by rule; add backoff with jitter if limits bite in prod.
  for (let attempt = 0; ; attempt++) {
    try {
      resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          ...(llmTools.length > 0 ? { tools: llmTools, tool_choice: 'auto' } : {}),
        }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      throw Object.assign(new Error(`llm unreachable: ${(e as Error).message}`), { status: 502 });
    }
    if (resp.status !== 429 || attempt > 0) break;
    const s = Number(resp.headers.get('retry-after'));
    await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(s) && s >= 0 ? s * 1000 : 1000, 10000)));
  }
  if (resp.status === 429)
    throw Object.assign(new Error('the model is rate-limited, try again in a few seconds'), { status: 429 });
  if (!resp.ok) throw Object.assign(new Error(`llm ${resp.status}`), { status: 502 });
  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
  };
  const msg = json?.choices?.[0]?.message;
  if (!msg || typeof msg !== 'object') throw Object.assign(new Error('llm bad response'), { status: 502 });
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls: LlmTurn['toolCalls'] = [];
  for (const tc of rawCalls) {
    if (!isRecord(tc) || !isRecord(tc.function) || typeof tc.function.name !== 'string') continue;
    const a = tc.function.arguments;
    toolCalls.push({
      id: typeof tc.id === 'string' && tc.id ? tc.id : randomUUID(),
      name: tc.function.name,
      argsText: typeof a === 'string' ? a : a === undefined ? '{}' : JSON.stringify(a),
      extra: tc.extra_content,
    });
  }
  return { content: typeof msg.content === 'string' ? msg.content : '', toolCalls };
}

// E2E H1 guard: prompts alone did not stop qwen3.8-27b from inventing orders on follow-up
// turns (2 of 4 runs). A reply that shows store data (order numbers, money) while no tool ran
// in this request never reaches the user: the model is told once to call the tool, and if it
// still does not, the user gets FALLBACK. Deterministic, unlike the prompt.
const STORE_DATA = /#\d+|[$€£]\s?\d+(?:[.,]\d+)?|\b\d+[.,]\d{2}\b/g;
// Tokens the user typed themselves ("priced $1.00") are echoes, not invented data.
export const looksLikeStoreData = (text: string, userText = ''): boolean =>
  (text.match(STORE_DATA) ?? []).some((tok) => !userText.includes(tok));
export const NUDGE =
  'Your last answer stated store data without calling a tool in this reply. Call the matching tool now and answer only from its result.';
export const FALLBACK = "I couldn't look that up with the store tools. Please ask again.";

export async function driveLoop(deps: {
  messages: LlmMessage[];
  callLlm: (messages: LlmMessage[]) => Promise<LlmTurn>;
  callTool: (name: string, argsText: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  emit: (event: string, data: unknown) => void;
  maxTurns?: number;
}): Promise<void> {
  const max = deps.maxTurns ?? MAX_TURNS;
  let toolsRan = false;
  let nudged = false;
  const lastUser = [...deps.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  for (let turn = 1; turn <= max; turn++) {
    const { content, toolCalls } = await deps.callLlm(deps.messages);
    if (toolCalls.length === 0) {
      if (!toolsRan && looksLikeStoreData(content, typeof lastUser === 'string' ? lastUser : '')) {
        if (!nudged) {
          nudged = true;
          deps.messages.push({ role: 'assistant', content }, { role: 'user', content: NUDGE });
          continue;
        }
        deps.emit('text', { content: FALLBACK });
        deps.emit('done', { turns: turn });
        return;
      }
      if (content) deps.emit('text', { content });
      deps.emit('done', { turns: turn });
      return;
    }
    toolsRan = true;
    if (content) deps.emit('text', { content });
    deps.messages.push({
      role: 'assistant',
      content,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.argsText },
        ...(tc.extra === undefined ? {} : { extra_content: tc.extra }),
      })),
    });
    for (const tc of toolCalls) {
      const r = await deps.callTool(tc.name, tc.argsText);
      deps.messages.push({ role: 'tool', tool_call_id: tc.id, content: r.ok ? r.text : `error: ${r.error}` });
    }
  }
  deps.emit('error', { message: 'turn limit reached' });
}

const ChatBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) }))
    .min(1)
    .max(50),
});

const errorClassFor = (e: unknown): string => {
  const st = (e as { status?: number }).status;
  if (st === 502) return 'server_unreachable';
  if (st === 503) return 'server_disabled';
  if (st === 504) return 'upstream_timeout';
  if (st === 404) return 'unknown_tool';
  return 'upstream_error';
};

// ponytail: non-streaming LLM calls, one text event per turn; switch to
// stream:true when the dashboard needs token streaming.
export async function handleChat(opts: {
  pg: PgPool;
  aggregator: Aggregator;
  upstreams: UpstreamPool;
  user: { id: string; name: string; role: 'admin' | 'member' };
  body: unknown;
  res: http.ServerResponse;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<void> {
  const cfg = loadLlmConfig();
  const parsed = ChatBody.safeParse(opts.body);
  if (!parsed.success) throw Object.assign(new Error('invalid messages'), { status: 400 });
  // Same role filter as /mcp tools/list: the model never sees tools the user may not call.
  const llmTools = toLlmTools(opts.aggregator.listAllTools().filter((t) => grantsAllow(opts.user.role, t.name)));
  const { res } = opts;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const emit = (event: string, data: unknown): void => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...parsed.data.messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ];
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let gone = false; // browser disconnected mid-loop: stop spending LLM and tool calls
  res.on('close', () => {
    gone = !res.writableEnded;
  });
  const fail = async (name: string, serverSlug: string, errorClass: string, error: string, durationMs = 0, outcome: 'error' | 'denied' = 'error') => {
    console.error(`chat tool ${outcome}: user=${opts.user.name} tool=${name} class=${errorClass} error=${error.slice(0, 200)}`);
    await logCall(opts.pg, {
      userId: opts.user.id,
      keyId: null,
      serverSlug,
      tool: name,
      outcome,
      errorClass,
      durationMs,
    }).catch(() => {});
    emit('tool', { name, status: 'error', error });
    return { ok: false as const, error };
  };
  try {
    await driveLoop({
      messages,
      callLlm: (ms) => {
        if (gone) throw new Error('client disconnected');
        return chatCompletions(ms, llmTools, cfg, fetchImpl);
      },
      callTool: async (name, argsText) => {
        emit('tool', { name, status: 'start' });
        const hit = opts.aggregator.resolve(name);
        if (!hit) return fail(name, '', 'unknown_tool', `unknown tool: ${name}`);
        if (!grantsAllow(opts.user.role, name))
          return fail(name, hit.tool.serverSlug, 'forbidden', 'forbidden for role', 0, 'denied');
        let args: unknown;
        try {
          args = argsText ? JSON.parse(argsText) : {};
        } catch {
          return fail(name, hit.tool.serverSlug, 'validation', 'arguments must be valid JSON');
        }
        const v = validateToolArgs(hit.tool.inputSchema, args);
        if (!v.ok) return fail(name, hit.tool.serverSlug, 'validation', v.error);
        const t0 = Date.now();
        try {
          const upstreamName = splitName(name)?.tool ?? name;
          const result = await opts.upstreams.callTool(hit.serverId, upstreamName, v.value, CALL_TIMEOUT_MS);
          const toolErr = isToolError(result);
          await logCall(opts.pg, {
            userId: opts.user.id,
            keyId: null,
            serverSlug: hit.tool.serverSlug,
            tool: name,
            outcome: toolErr ? 'error' : 'ok',
            errorClass: toolErr ? 'tool_error' : null,
            durationMs: Date.now() - t0,
          }).catch(() => {});
          emit('tool', { name, status: 'done' });
          return { ok: true as const, text: JSON.stringify(capResult(result)) };
        } catch (e) {
          return fail(name, hit.tool.serverSlug, errorClassFor(e), (e as Error).message ?? 'upstream error', Date.now() - t0);
        }
      },
      emit,
    });
  } catch (e) {
    const message = (e as Error).message ?? 'chat failed';
    // Capped: an error text must never carry tool arguments into the log in full (D22, E2E N4).
    if (message !== 'client disconnected') console.error(`chat failed: user=${opts.user.name} error=${message.slice(0, 200)}`);
    emit('error', { message });
  }
  res.end();
}
