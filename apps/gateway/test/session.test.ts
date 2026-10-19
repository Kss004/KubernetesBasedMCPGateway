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

describe('LoginLimiter (bug 6)', () => {
  it('locks a key for 1 min after 5 failures in the window, then frees it', async () => {
    const { LoginLimiter } = await import('../src/session.ts');
    let t = 0;
    const l = new LoginLimiter(5, 15 * 60_000, 60_000, () => t);
    const keys = ['ip:1.2.3.4', 'name:a'];
    for (let i = 0; i < 4; i++) l.fail(keys);
    assert.equal(l.lockedFor(keys), 0);
    l.fail(keys);
    assert.equal(l.lockedFor(keys), 60);
    assert.equal(l.lockedFor(['name:a']), 60); // same name from another IP is locked too
    assert.equal(l.lockedFor(['ip:9.9.9.9', 'name:b']), 0);
    t += 60_001;
    assert.equal(l.lockedFor(keys), 0);
  });
  it('failures outside the window do not add up; success clears the name', async () => {
    const { LoginLimiter } = await import('../src/session.ts');
    let t = 0;
    const l = new LoginLimiter(5, 15 * 60_000, 60_000, () => t);
    for (let i = 0; i < 4; i++) l.fail(['name:a']);
    t += 15 * 60_000 + 1;
    l.fail(['name:a']);
    assert.equal(l.lockedFor(['name:a']), 0);
    for (let i = 0; i < 3; i++) l.fail(['name:a']);
    l.success('name:a');
    l.fail(['name:a']);
    assert.equal(l.lockedFor(['name:a']), 0);
  });
  it('clientIp takes the last X-Forwarded-For hop (the one our ingress added)', async () => {
    const { clientIp } = await import('../src/session.ts');
    assert.equal(clientIp('6.6.6.6, 10.0.0.9', '10.244.0.5'), '10.0.0.9');
    assert.equal(clientIp(undefined, '10.244.0.5'), '10.244.0.5');
    assert.equal(clientIp('', undefined), 'unknown');
  });
});
