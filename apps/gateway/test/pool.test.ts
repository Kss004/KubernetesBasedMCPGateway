// Shared upstream auth headers (bug 2), safe retry rule (bug 3), in-band tool errors.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { authHeaders, isSessionGone } from '../src/pool.ts';
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
