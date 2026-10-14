// T3.4/T3.5 pure rules: prefix shape, 64-char cap, description + result caps.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prefixName, splitName, capDescription } from '../src/aggregator.ts';
import { capResult, RESULT_CAP_BYTES } from '../src/router.ts';

describe('prefixName', () => {
  it('prefixes and enforces 64 chars', () => {
    assert.equal(prefixName('woo', 'list_orders'), 'woo__list_orders');
    assert.equal(prefixName('a'.repeat(32), 'b'.repeat(30))?.length, 64);
  });
  it('boundary: exactly 64 passes, 65 drops', () => {
    assert.equal(prefixName('a'.repeat(31), 'b'.repeat(31))?.length, 64);
    assert.equal(prefixName('a'.repeat(31), 'b'.repeat(32)), null);
  });
});

describe('splitName', () => {
  it('splits at first __ and rejects bad shapes', () => {
    assert.deepEqual(splitName('woo__list_orders'), { slug: 'woo', tool: 'list_orders' });
    assert.equal(splitName('nodivider'), null);
    assert.equal(splitName('__tool'), null);
    assert.equal(splitName('BAD__tool'), null);
  });
});

describe('caps', () => {
  it('truncates long descriptions with a marker', () => {
    const out = capDescription('x'.repeat(2000));
    assert.ok(out.length < 2000 && out.endsWith('…[truncated]'));
  });
  it('passes small results through, truncates huge ones', () => {
    const small = { content: [{ type: 'text', text: 'hi' }] };
    assert.deepEqual(capResult(small), small);
    const big = capResult({ content: [{ type: 'text', text: 'y'.repeat(RESULT_CAP_BYTES + 10) }] }) as {
      truncated: boolean;
    };
    assert.equal(big.truncated, true);
  });
});
