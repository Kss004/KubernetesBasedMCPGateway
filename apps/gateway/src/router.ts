// MCP router (T3.5): authenticate the user key, serve aggregated tools.
// Stateless (D6): this function handles one POST per call, no sessions.
// Members default-allow every tool except writes (D23/T11.1: grantsAllow
// below hides denied tools from tools/list AND rejects direct tools/call).
// Audit rows for denied attempts are T4.4 (console-logged until then).
import type { Pool as PgPool } from 'pg';
import { authenticate, identifyKey } from './keys.js';
import { logCall } from './audit.js';
import { splitName, type Aggregator } from './aggregator.js';
import type { UpstreamPool } from './pool.js';

export const CALL_TIMEOUT_MS = 30000;
export const RESULT_CAP_BYTES = 256 * 1024;

/** Truncate an oversized result payload with a marker so one upstream cannot flood the client. */
export function capResult(payload: unknown): unknown {
  const s = JSON.stringify(payload);
  if (s.length <= RESULT_CAP_BYTES) return payload;
  const marker = '…[truncated: result exceeded 256KB]';
  return { content: [{ type: 'text', text: s.slice(0, RESULT_CAP_BYTES - marker.length) + marker }], truncated: true };
}

// T11.1 (D23): members default-allow every tool except writes.
// shortcut: fixed in-code deny list; if per-user/per-server grants are needed, move to a DB table + admin API.
const MEMBER_DENIED_SUFFIXES = new Set(['create_product', 'update_order_status']);

/** MCP tool results report failure in-band (isError), not as a thrown error. */
export const isToolError = (result: unknown): boolean =>
  !!result && typeof result === 'object' && (result as { isError?: unknown }).isError === true;

export function grantsAllow(role: 'admin' | 'member', toolName: string): boolean {
  if (role === 'admin') return true;
  const suffix = splitName(toolName)?.tool ?? toolName.split('__').pop() ?? toolName;
  return !MEMBER_DENIED_SUFFIXES.has(suffix);
}

interface RpcBody {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleMcp(opts: {
  pg: PgPool;
  aggregator: Aggregator;
  upstreams: UpstreamPool;
  auth: string;
  body: unknown;
}): Promise<{ status: number; json: unknown }> {
  const key = opts.auth.startsWith('Bearer ') ? opts.auth.slice(7) : '';
  const b = opts.body as RpcBody | null;
  if (!b || typeof b !== 'object' || typeof b.method !== 'string') {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } } };
  }
  const id = b.id ?? null;
  const ok = (result: unknown) => ({ status: 200, json: { jsonrpc: '2.0', id, result } });
  const err = (code: number, message: string, status = 200) => ({
    status,
    json: { jsonrpc: '2.0', id, error: { code, message } },
  });
  // Name the target for denied-attempt attribution (D22); never args.
  const target = (suffix: string): string => {
    if (b.method === 'tools/call') {
      const n = ((b.params ?? {}) as { name?: unknown }).name;
      if (typeof n === 'string') return n;
    }
    return `${b.method ?? '?'}${suffix}`;
  };

  const me = await authenticate(opts.pg, key);
  if (!me) {
    // Attribute revoked/known keys to their user; unknown keys stay anonymous.
    identifyKey(opts.pg, key)
      .then((known) => {
        if (known) {
          return logCall(opts.pg, {
            userId: known.userId,
            keyId: known.keyId,
            serverSlug: '',
            tool: target(':auth'),
            outcome: 'denied',
            errorClass: known.revoked ? 'revoked_key' : 'invalid_key',
            durationMs: 0,
          });
        }
      })
      .catch(() => {});
    return { status: 401, json: { error: 'unauthorized' } };
  }

  switch (b.method) {
    case 'initialize': {
      const p = (b.params ?? {}) as { protocolVersion?: string };
      return ok({
        protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'urumi-gateway', version: '0.2.0' },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202, json: {} };
    case 'ping':
      return ok({});
    case 'tools/list': {
      const tools = opts.aggregator
        .listAllTools()
        .filter((t) => grantsAllow(me.role, t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      return ok({ tools });
    }
    case 'tools/call': {
      const p = (b.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof p.name !== 'string') return err(-32602, 'unknown tool');
      const hit = opts.aggregator.resolve(p.name);
      if (!hit) {
        logCall(opts.pg, {
          userId: me.userId,
          keyId: me.keyId,
          serverSlug: '',
          tool: p.name,
          outcome: 'error',
          errorClass: 'unknown_tool',
          durationMs: 0,
        }).catch(() => {});
        return err(-32602, 'unknown tool');
      }
      if (!grantsAllow(me.role, p.name)) {
        logCall(opts.pg, {
          userId: me.userId,
          keyId: me.keyId,
          serverSlug: hit.tool.serverSlug,
          tool: p.name,
          outcome: 'denied',
          errorClass: 'forbidden',
          durationMs: 0,
        }).catch(() => {});
        return err(-32000, 'forbidden for role');
      }
      const args = (p.arguments ?? {}) as Record<string, unknown>;
      const upstreamName = splitName(p.name)?.tool ?? p.name; // part after the first __
      const t0 = Date.now();
      const done = (outcome: 'ok' | 'error', errorClass?: string) =>
        logCall(opts.pg, {
          userId: me.userId,
          keyId: me.keyId,
          serverSlug: hit.tool.serverSlug,
          tool: p.name as string,
          outcome,
          errorClass: errorClass ?? null,
          durationMs: Date.now() - t0,
        }).catch(() => {});
      try {
        const result = await opts.upstreams.callTool(hit.serverId, upstreamName, args, CALL_TIMEOUT_MS);
        await (isToolError(result) ? done('error', 'tool_error') : done('ok'));
        return ok(capResult(result));
      } catch (e) {
        const st = (e as { status?: number }).status ?? 500;
        const msg = (e as Error).message ?? 'upstream error';
        if (st === 404) {
          await done('error', 'unknown_tool');
          return err(-32602, 'unknown tool');
        }
        if (st === 503) {
          await done('error', 'server_disabled');
          return err(-32000, 'server disabled');
        }
        if (st === 502) {
          await done('error', 'server_unreachable');
          return err(-32000, 'server unreachable');
        }
        if (st === 504) {
          await done('error', 'upstream_timeout');
          return err(-32000, msg);
        }
        await done('error', 'upstream_error');
        return err(-32603, msg);
      }
    }
    default:
      return err(-32601, 'method not found');
  }
}
