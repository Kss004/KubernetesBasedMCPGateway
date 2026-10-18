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
