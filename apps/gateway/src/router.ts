// MCP router (T3.5): authenticate the user key, serve aggregated tools.
// Stateless (D6): this function handles one POST per call, no sessions.
// Members default-allow every tool in the core (D23); per-tool grants are
// T11.1 — the grantsAllow() hook below is where that check lands.
// Audit rows for denied attempts are T4.4 (console-logged until then).
import type { Pool as PgPool } from 'pg';
import { authenticate } from './keys.js';
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

// T11.1 hook: currently allow-all per D23 (members default-allow every tool).
function grantsAllow(_role: 'admin' | 'member', _toolName: string): boolean {
  return true;
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
  const me = await authenticate(opts.pg, key);
  if (!me) return { status: 401, json: { error: 'unauthorized' } };

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
      const tools = opts.aggregator.listAllTools().map((t) => ({
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
      if (!hit) return err(-32602, 'unknown tool');
      if (!grantsAllow(me.role, p.name)) {
        console.error(`audit denied user=${me.userId} tool=${p.name}`);
        return err(-32000, 'forbidden for role');
      }
      const args = (p.arguments ?? {}) as Record<string, unknown>;
      const upstreamName = splitName(p.name)?.tool ?? p.name; // part after the first __
      try {
        const result = await opts.upstreams.callTool(hit.serverId, upstreamName, args, CALL_TIMEOUT_MS);
        return ok(capResult(result));
      } catch (e) {
        const st = (e as { status?: number }).status ?? 500;
        const msg = (e as Error).message ?? 'upstream error';
        if (st === 404) return err(-32602, 'unknown tool');
        if (st === 503) return err(-32000, 'server disabled');
        if (st === 502) return err(-32000, 'server unreachable');
        if (st === 504) return err(-32000, msg);
        return err(-32603, msg);
      }
    }
    default:
      return err(-32601, 'method not found');
  }
}
