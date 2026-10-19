// Shared upstream auth headers (bug 2), safe retry rule (bug 3), in-band tool errors.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { authHeaders, isSessionGone, UpstreamPool } from '../src/pool.ts';
import { grantsAllow, isToolError } from '../src/router.ts';

describe('authHeaders', () => {
  it('builds bearer and custom-header credentials', () => {
    assert.deepEqual(authHeaders('bearer', null, 's'), { Authorization: 'Bearer s' });
    assert.deepEqual(authHeaders('header', 'X-API-Key', 's'), { 'X-API-Key': 's' });
  });
  it('sends nothing without a secret or header name', () => {
    assert.deepEqual(authHeaders('bearer', null, undefined), {});
    assert.deepEqual(authHeaders('header', null, 's'), {});
    assert.deepEqual(authHeaders('none', null, 's'), {});
  });
});

describe('isSessionGone', () => {
  it('retries only the transport 404', () => {
    assert.equal(isSessionGone(new StreamableHTTPError(404, 'Session not found')), true);
    assert.equal(isSessionGone(new StreamableHTTPError(500, 'boom')), false);
    assert.equal(isSessionGone(new Error('woo: 404 product not found')), false);
  });
});

describe('isToolError / grantsAllow', () => {
  it('reads isError and the member deny list', () => {
    assert.equal(isToolError({ isError: true, content: [] }), true);
    assert.equal(isToolError({ content: [] }), false);
    assert.equal(grantsAllow('member', 'woo__create_product'), false);
    assert.equal(grantsAllow('member', 'woo__list_orders'), true);
    assert.equal(grantsAllow('admin', 'woo__create_product'), true);
  });
});

describe('UpstreamPool.refreshNow', () => {
  it('re-enabled server is Connected on the next refresh, not after backoff', async () => {
    const row = { id: 's1', slug: 'mock', url: 'http://x/mcp', auth_type: 'none', header_name: null, enabled: true };
    let up = false;
    const pg = {
      query: async (sql: string) => ({ rows: sql.startsWith('SELECT server_id') ? [] : [row] }),
    };
    const pool = new UpstreamPool(pg as never, Buffer.alloc(32));
    (pool as unknown as { probe: () => Promise<boolean> }).probe = async () => up;
    await pool.refreshNow();
    await pool.refreshNow(); // two failures: Unreachable, backed off
    assert.equal(pool.getStates()[0].status, 'Unreachable');
    row.enabled = false;
    await pool.refreshNow();
    assert.equal(pool.getStates()[0].status, 'Disabled');
    row.enabled = true;
    up = true;
    await pool.refreshNow();
    assert.equal(pool.getStates()[0].status, 'Connected');
  });
});

describe('UpstreamPool outage detection (E2E M3)', () => {
  it('marks Unreachable on the 2nd consecutive failed probe, with no skipped tick', async () => {
    const row = { id: 's1', slug: 'everything', url: 'http://x/mcp', auth_type: 'none', header_name: null, enabled: true };
    let up = true;
    const pg = { query: async (sql: string) => ({ rows: sql.startsWith('SELECT server_id') ? [] : [row] }) };
    const pool = new UpstreamPool(pg as never, Buffer.alloc(32));
    (pool as unknown as { probe: () => Promise<boolean> }).probe = async () => up;
    await pool.refreshNow();
    assert.equal(pool.getStates()[0].status, 'Connected');
    up = false;
    await pool.refreshNow(); // 1st failure: still Connected, no backoff yet
    assert.equal(pool.getStates()[0].status, 'Connected');
    await pool.refreshNow(); // next tick, immediately: 2nd failure is probed, not skipped
    assert.equal(pool.getStates()[0].status, 'Unreachable');
  });
});

// Bounds are loose (5s vs 300-400ms timeouts) so a loaded machine cannot flake them; the bug
// they guard against took 13-65s (E2E round 5/7 flake reports).
describe('UpstreamPool timeouts are enforced (E2E M3)', () => {
  it('a probe and a tool call to an upstream that never answers fail at our timeout', async () => {
    const http = await import('node:http');
    const hang = http.createServer(() => {}); // accepts, never responds
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const port = (hang.address() as { port: number }).port;
    const row = { id: 's1', slug: 'hang', url: `http://127.0.0.1:${port}/mcp`, auth_type: 'none', header_name: null, enabled: true };
    const pg = { query: async (sql: string) => ({ rows: sql.startsWith('SELECT server_id') ? [] : [row] }) };
    const pool = new UpstreamPool(pg as never, Buffer.alloc(32), 5000, 300);
    try {
      let t0 = Date.now();
      await pool.refreshNow();
      assert.ok(Date.now() - t0 < 5000, `probe took ${Date.now() - t0}ms`);
      // Force Connected so callTool reaches the upstream, then expect our 400ms timeout.
      (pool as unknown as { states: Map<string, { status: string }> }).states.get('s1')!.status = 'Connected';
      t0 = Date.now();
      await assert.rejects(pool.callTool('s1', 'x', {}, 400), /upstream timeout after 400ms/);
      assert.ok(Date.now() - t0 < 5000, `call took ${Date.now() - t0}ms`);
    } finally {
      hang.closeAllConnections();
      hang.close();
    }
  });
});

describe('Aggregator tool refresh timeout (E2E M3)', () => {
  it('a refresh against an upstream that never answers ends at the tool timeout', async () => {
    const { Aggregator } = await import('../src/aggregator.ts');
    const http = await import('node:http');
    const hang = http.createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const port = (hang.address() as { port: number }).port;
    const row = { id: 's1', slug: 'hang', url: `http://127.0.0.1:${port}/mcp`, auth_type: 'none', header_name: null, enabled: true };
    const pg = { query: async (sql: string) => ({ rows: sql.includes('FROM servers') ? [row] : [] }) };
    const agg = new Aggregator(pg as never, Buffer.alloc(32), 15000, 300);
    try {
      const t0 = Date.now();
      await agg.refresh();
      assert.ok(Date.now() - t0 < 5000, `refresh took ${Date.now() - t0}ms`);
    } finally {
      hang.closeAllConnections();
      hang.close();
    }
  });
});
