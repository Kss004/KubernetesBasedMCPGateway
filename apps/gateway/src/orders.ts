// Dashboard Orders page: GET /api/orders?page=&per_page=&status=&from=&to=
// Calls woo__list_orders exactly as the chat agent does (role grants, schema check,
// one audit row as the logged-in user, never args/results), so the page shows nothing
// a member could not already get through chat or /mcp.
import type { Pool as PgPool } from 'pg';
import { z } from 'zod';
import { logCall } from './audit.js';
import { splitName, type Aggregator } from './aggregator.js';
import type { UpstreamPool } from './pool.js';
import { validateToolArgs } from './chat.js';
import { CALL_TIMEOUT_MS, grantsAllow, isToolError } from './router.js';

export const ORDERS_TOOL = 'woo__list_orders';
const STATUSES = ['any', 'pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ordersQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(STATUSES).default('any'),
  from: day.optional(),
  to: day.optional(),
});

/** URL query -> woo__list_orders arguments (dates are whole store days). */
export function ordersArgs(search: URLSearchParams): Record<string, unknown> {
  const q = ordersQuery.parse(Object.fromEntries(search));
  return {
    page: q.page,
    per_page: q.per_page,
    ...(q.status !== 'any' ? { status: q.status } : {}),
    ...(q.from ? { after: `${q.from}T00:00:00` } : {}),
    ...(q.to ? { before: `${q.to}T23:59:59` } : {}),
  };
}

type Status = { status: number; body: unknown };

export async function listOrders(opts: {
  pg: PgPool;
  aggregator: Aggregator;
  upstreams: UpstreamPool;
  user: { id: string; role: 'admin' | 'member' };
  search: URLSearchParams;
}): Promise<Status> {
  let args: Record<string, unknown>;
  try {
    args = ordersArgs(opts.search);
  } catch {
    return { status: 400, body: { error: 'invalid query' } };
  }
  const audit = (serverSlug: string, outcome: 'ok' | 'error' | 'denied', errorClass: string | null, durationMs: number) =>
    logCall(opts.pg, { userId: opts.user.id, keyId: null, serverSlug, tool: ORDERS_TOOL, outcome, errorClass, durationMs }).catch(
      () => {},
    );
  const hit = opts.aggregator.resolve(ORDERS_TOOL);
  if (!hit) return { status: 503, body: { error: 'the store server is not connected' } };
  if (!grantsAllow(opts.user.role, ORDERS_TOOL)) {
    await audit(hit.tool.serverSlug, 'denied', 'forbidden', 0);
    return { status: 403, body: { error: 'forbidden for role' } };
  }
  const v = validateToolArgs(hit.tool.inputSchema, args);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const t0 = Date.now();
  let result: unknown;
  try {
    result = await opts.upstreams.callTool(hit.serverId, splitName(ORDERS_TOOL)?.tool ?? ORDERS_TOOL, v.value, CALL_TIMEOUT_MS);
  } catch (e) {
    const st = (e as { status?: number }).status;
    await audit(hit.tool.serverSlug, 'error', st === 502 ? 'server_unreachable' : 'upstream_error', Date.now() - t0);
    return { status: st === 503 ? 503 : 502, body: { error: st === 503 ? 'the store server is disabled' : 'the store is unreachable' } };
  }
  // One audit row per call: the outcome is known here, before the reply is parsed.
  const toolErr = isToolError(result);
  await audit(hit.tool.serverSlug, toolErr ? 'error' : 'ok', toolErr ? 'tool_error' : null, Date.now() - t0);
  const text = (result as { content?: Array<{ type?: string; text?: string }> }).content?.find((c) => c.type === 'text')?.text;
  if (toolErr || !text) return { status: 502, body: { error: 'the store could not list orders' } };
  try {
    return { status: 200, body: JSON.parse(text) };
  } catch {
    return { status: 502, body: { error: 'the store sent an unreadable reply' } };
  }
}
