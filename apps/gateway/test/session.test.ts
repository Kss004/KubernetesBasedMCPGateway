// Session token round-trip, tamper rejection, expiry.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mintSession, verifySession } from '../src/session.ts';

const SECRET = randomBytes(32);

describe('session', () => {
  it('round-trips a valid token', () => {
    const t = mintSession('user-1', SECRET);
    assert.deepEqual(verifySession(t, SECRET), { userId: 'user-1' });
  });
  it('rejects tampered tokens and wrong secrets', () => {
    const t = mintSession('user-1', SECRET);
    assert.equal(verifySession(t.slice(0, -2) + 'xx', SECRET), null);
    assert.equal(verifySession(t, randomBytes(32)), null);
    assert.equal(verifySession('garbage', SECRET), null);
  });
  it('rejects expired tokens', () => {
    const t = mintSession('user-1', SECRET, -1000);
    assert.equal(verifySession(t, SECRET), null);
  });
});
