import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listOrders, ordersArgs } from '../src/orders.js';

describe('ordersArgs (dashboard Orders page)', () => {
  it('defaults to page 1 of 20, all statuses', () => {
    assert.deepEqual(ordersArgs(new URLSearchParams('')), { page: 1, per_page: 20 });
  });
  it('maps status and whole-day dates to woo__list_orders arguments', () => {
    assert.deepEqual(ordersArgs(new URLSearchParams('page=3&per_page=50&status=completed&from=2026-10-01&to=2026-10-21')), {
      page: 3,
      per_page: 50,
      status: 'completed',
      after: '2026-10-01T00:00:00',
      before: '2026-10-21T23:59:59',
    });
  });
  it('rejects bad input instead of passing it upstream', () => {
    for (const q of ['per_page=500', 'page=0', 'status=hacked', 'from=2026-10-01T00:00:00', 'from=yesterday'])
      assert.throws(() => ordersArgs(new URLSearchParams(q)), q);
  });
});

describe('listOrders audit', () => {
  const run = async (callTool: () => Promise<unknown>) => {
    const rows: unknown[][] = [];
    const r = await listOrders({
      pg: { query: async (_sql: string, params: unknown[]) => rows.push(params) } as never,
      aggregator: { resolve: () => ({ serverId: 's1', tool: { serverSlug: 'woo', inputSchema: {} } }) } as never,
      upstreams: { callTool } as never,
      user: { id: 'u1', role: 'member' },
      search: new URLSearchParams(''),
    });
    return { r, outcomes: rows.map((p) => p[4]) };
  };
  it('writes one ok row and returns the parsed reply', async () => {
    const { r, outcomes } = await run(async () => ({ content: [{ type: 'text', text: '{"count":0}' }] }));
    assert.deepEqual(r, { status: 200, body: { count: 0 } });
    assert.deepEqual(outcomes, ['ok']);
  });
  it('an unreadable reply is still one row, not ok + error', async () => {
    const { r, outcomes } = await run(async () => ({ content: [{ type: 'text', text: 'not json' }] }));
    assert.equal(r.status, 502);
    assert.deepEqual(outcomes, ['ok']);
  });
  it('an unreachable store writes one error row', async () => {
    const { r, outcomes } = await run(async () => {
      throw Object.assign(new Error('server unreachable'), { status: 502 });
    });
    assert.equal(r.status, 502);
    assert.deepEqual(outcomes, ['error']);
  });
});
