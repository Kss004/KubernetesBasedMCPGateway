// Rate limits shared by every gateway replica (Scaling). Counters live in Postgres, so a client
// gets the same budget whichever pod answers.
// - RateLimiter: fixed one-minute windows per key (an API key on /mcp, a user on chat).
// - LoginLimiter: 5 failures in 15 min on a key (client IP or user name) lock that key for 1 min.
//   Checked before bcrypt and identical for unknown names, so it does not reveal which names exist.
import type { Pool } from 'pg';

export interface Verdict {
  ok: boolean;
  /** Seconds until the current window ends (for Retry-After). */
  retryAfter: number;
}

export class RateLimiter {
  constructor(private pg: Pool) {}

  /** Counts one hit for `key` in the current minute and says whether it is within `perMinute`. */
  async hit(key: string, perMinute: number): Promise<Verdict> {
    if (perMinute <= 0) return { ok: true, retryAfter: 0 }; // 0 disables the limit
    const { rows } = await this.pg.query(
      `INSERT INTO rate_counters(key, window_start, n) VALUES ($1, date_trunc('minute', now()), 1)
       ON CONFLICT (key, window_start) DO UPDATE SET n = rate_counters.n + 1
       RETURNING n, ceil(extract(epoch FROM date_trunc('minute', now()) + interval '1 minute' - now()))::int AS reset`,
      [key],
    );
    const { n, reset } = rows[0] as { n: number; reset: number };
    return { ok: n <= perMinute, retryAfter: Math.max(1, reset) };
  }
}

export class LoginLimiter {
  constructor(
    private pg: Pool,
    private max = 5,
    private windowSec = 15 * 60,
    private lockSec = 60,
  ) {}

  /** Seconds left on the longest lock among keys, or 0. */
  async lockedFor(keys: string[]): Promise<number> {
    const { rows } = await this.pg.query(
      `SELECT coalesce(ceil(max(extract(epoch FROM locked_until - now()))), 0)::int AS wait
       FROM login_limits WHERE key = ANY($1) AND locked_until > now()`,
      [keys],
    );
    return (rows[0] as { wait: number }).wait;
  }

  /** One failed login for each key; the 5th failure in the window locks that key. */
  async fail(keys: string[]): Promise<void> {
    for (const key of keys) {
      // One statement per key, so two replicas counting at once cannot lose an update.
      await this.pg.query(
        `INSERT INTO login_limits(key, count, first_at) VALUES ($1, 1, now())
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN login_limits.first_at < now() - make_interval(secs => $2) THEN 1 ELSE login_limits.count + 1 END,
           first_at = CASE WHEN login_limits.first_at < now() - make_interval(secs => $2) THEN now() ELSE login_limits.first_at END`,
        [key, this.windowSec],
      );
      await this.pg.query(
        `UPDATE login_limits SET count = 0, first_at = now(), locked_until = now() + make_interval(secs => $3)
         WHERE key = $1 AND count >= $2`,
        [key, this.max, this.lockSec],
      );
    }
  }

  async success(key: string): Promise<void> {
    await this.pg.query('DELETE FROM login_limits WHERE key = $1', [key]);
  }
}

/** Drops finished windows and expired login entries; run on a timer. */
export async function pruneLimits(pg: Pool): Promise<void> {
  await pg.query(`DELETE FROM rate_counters WHERE window_start < now() - interval '5 minutes'`);
  await pg.query(
    `DELETE FROM login_limits WHERE (locked_until IS NULL OR locked_until < now()) AND first_at < now() - interval '15 minutes'`,
  );
}
