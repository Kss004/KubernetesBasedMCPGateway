// Rate limits and the login lock against a real Postgres (the logic is SQL, shared by replicas).
// Runs when TEST_DATABASE_URL points at a throwaway database; skipped otherwise.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../src/db.ts';
import { LoginLimiter, RateLimiter, pruneLimits } from '../src/ratelimit.ts';

const url = process.env.TEST_DATABASE_URL;

describe('rate limits (Postgres)', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: pg.Pool;
  before(async () => {
    pool = new pg.Pool({ connectionString: url });
    await migrate(pool);
    await pool.query('TRUNCATE rate_counters, login_limits');
  });
  after(async () => pool?.end());

  it('allows perMinute hits in a window, then refuses with a Retry-After', async () => {
    const rl = new RateLimiter(pool);
    for (let i = 0; i < 3; i++) assert.equal((await rl.hit('mcp:a', 3)).ok, true);
    const v = await rl.hit('mcp:a', 3);
    assert.equal(v.ok, false);
    assert.ok(v.retryAfter >= 1 && v.retryAfter <= 60);
    assert.equal((await rl.hit('mcp:b', 3)).ok, true, 'other keys have their own budget');
    assert.equal((await rl.hit('mcp:a', 0)).ok, true, '0 disables the limit');
  });

  it('counts correctly when two replicas hit at once', async () => {
    const a = new RateLimiter(pool);
    const otherPool = new pg.Pool({ connectionString: url });
    const b = new RateLimiter(otherPool);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).hit('mcp:race', 10)));
    await otherPool.end();
    assert.equal(results.filter((r) => r.ok).length, 10);
  });

  it('locks a name after 5 failures, for every replica, and success clears it', async () => {
    const one = new LoginLimiter(pool);
    const two = new LoginLimiter(pool); // a second replica sharing the database
    const keys = ['ip:1.2.3.4', 'name:a'];
    for (let i = 0; i < 4; i++) await (i % 2 ? one : two).fail(keys);
    assert.equal(await one.lockedFor(keys), 0);
    await two.fail(keys);
    const wait = await one.lockedFor(['name:a']);
    assert.ok(wait > 0 && wait <= 60, `locked for ${wait}s`);
    assert.equal(await two.lockedFor(['ip:9.9.9.9', 'name:b']), 0);
    await one.success('name:b');
    for (let i = 0; i < 4; i++) await one.fail(['name:c']);
    await one.success('name:c');
    await one.fail(['name:c']);
    assert.equal(await two.lockedFor(['name:c']), 0);
  });

  it('expired windows reset the count, and prune removes stale rows', async () => {
    const l = new LoginLimiter(pool, 5, 1, 60); // 1-second window
    for (let i = 0; i < 4; i++) await l.fail(['name:d']);
    await new Promise((r) => setTimeout(r, 1100));
    await l.fail(['name:d']);
    assert.equal(await l.lockedFor(['name:d']), 0);
    await pool.query(`UPDATE rate_counters SET window_start = now() - interval '10 minutes'`);
    await pruneLimits(pool);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM rate_counters')).rows[0].n, 0);
  });

  it('migrate is safe to run from two replicas at once', async () => {
    const other = new pg.Pool({ connectionString: url });
    await Promise.all([migrate(pool), migrate(other)]);
    await other.end();
  });
});
