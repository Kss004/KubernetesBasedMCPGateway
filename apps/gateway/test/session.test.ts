// Session token round-trip, tamper rejection, expiry.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mintSession, verifySession } from '../src/session.ts';

const SECRET = randomBytes(32);

describe('session', () => {
  it('round-trips a valid token', () => {
    const t = mintSession('user-1', 3, SECRET);
    assert.deepEqual(verifySession(t, SECRET), { userId: 'user-1', version: 3 });
  });
  it('rejects tampered tokens and wrong secrets', () => {
    const t = mintSession('user-1', 3, SECRET);
    assert.equal(verifySession(t.slice(0, -2) + 'xx', SECRET), null);
    assert.equal(verifySession(t, randomBytes(32)), null);
    assert.equal(verifySession('garbage', SECRET), null);
  });
  it('rejects expired tokens', () => {
    const t = mintSession('user-1', 3, SECRET, -1000);
    assert.equal(verifySession(t, SECRET), null);
  });
});

describe('clientIp', () => {
  it('clientIp takes the last X-Forwarded-For hop (the one our ingress added)', async () => {
    const { clientIp } = await import('../src/session.ts');
    assert.equal(clientIp('6.6.6.6, 10.0.0.9', '10.244.0.5'), '10.0.0.9');
    assert.equal(clientIp(undefined, '10.244.0.5'), '10.244.0.5');
    assert.equal(clientIp('', undefined), 'unknown');
  });
});

describe('session versions (logout invalidation)', () => {
  it('signs the version, so it cannot be edited, and rejects old v1 tokens', () => {
    const t = mintSession('user-1', 3, SECRET);
    const parts = t.split('.');
    parts[2] = '4';
    assert.equal(verifySession(parts.join('.'), SECRET), null);
    assert.equal(verifySession('v1.user-1.9999999999999.sig', SECRET), null);
  });
});
