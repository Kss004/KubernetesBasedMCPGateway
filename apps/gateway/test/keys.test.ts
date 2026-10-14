// T4.1 key primitives: hash determinism, uniqueness, prefix rule.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashKey, makeKey } from '../src/keys.ts';

describe('hashKey', () => {
  it('is deterministic 64-hex sha256', () => {
    const h = hashKey('abc');
    assert.equal(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('makeKey', () => {
  it('returns 32-byte hex with matching hash and 8-char prefix', () => {
    const a = makeKey();
    assert.equal(a.key.length, 64);
    assert.equal(a.hash, hashKey(a.key));
    assert.equal(a.prefix, a.key.slice(0, 8));
    assert.notEqual(a.key, makeKey().key);
  });
});
