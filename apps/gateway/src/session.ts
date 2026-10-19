// Dashboard sessions (login): stateless signed tokens, no server table.
// Cookie is HttpOnly + SameSite=Lax; session-authed mutations additionally
// require Content-Type: application/json (a cross-site form cannot set that
// without a preflight). Passwords use bcryptjs — the one deliberate
// dependency: password hashing must never be home-rolled.
import { createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

export const hashPassword = (pw: string): Promise<string> => bcrypt.hash(pw, 10);
export const checkPassword = (pw: string, hash: string): Promise<boolean> => bcrypt.compare(pw, hash);
// Dummy hash so unknown-user logins take the same code path (no enumeration).
const DUMMY = '$2b$10$C6UzMDM.H6dfI/f/IKc8OOuDvDvDvDvDvDvDvDvDvDvDvDvDvDvD.';
export const checkPasswordDummy = (pw: string): Promise<boolean> => bcrypt.compare(pw, DUMMY);

const PREFIX = 'v1';

export function mintSession(userId: string, secret: Buffer, ttlMs = 7 * 24 * 3600 * 1000): string {
  const exp = Date.now() + ttlMs;
  const body = `${PREFIX}.${userId}.${exp}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token: string, secret: Buffer): { userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const exp = Number(parts[2]);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const body = `${PREFIX}.${parts[1]}.${parts[2]}`;
  const want = createHmac('sha256', secret).update(body).digest();
  let got: Buffer;
  try {
    got = Buffer.from(parts[3], 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return { userId: parts[1] };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, i).trim()] = raw; // malformed %-escape: keep raw, verifySession rejects it
    }
  }
  return out;
}

// Bug 6: login rate limit. 5 failures in 15 min on a key (client IP or user name) lock that
// key for 1 min. Checked before bcrypt and identical for unknown names (no enumeration).
// ponytail: in-memory per pod and reset on restart; ceiling = one gateway replica.
// Upgrade: a shared store (Postgres or Redis) when the gateway runs more than one replica.
export class LoginLimiter {
  private entries = new Map<string, { count: number; first: number; lockedUntil: number }>();
  constructor(
    private max = 5,
    private windowMs = 15 * 60_000,
    private lockMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  /** Seconds left on the longest lock among keys, or 0. */
  lockedFor(keys: string[]): number {
    const t = this.now();
    let wait = 0;
    for (const k of keys) wait = Math.max(wait, (this.entries.get(k)?.lockedUntil ?? 0) - t);
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  fail(keys: string[]): void {
    const t = this.now();
    if (this.entries.size > 10_000) this.prune(t);
    for (const k of keys) {
      let e = this.entries.get(k);
      if (!e || t - e.first > this.windowMs) e = { count: 0, first: t, lockedUntil: 0 };
      e.count += 1;
      if (e.count >= this.max) Object.assign(e, { count: 0, first: t, lockedUntil: t + this.lockMs });
      this.entries.set(k, e);
    }
  }

  success(key: string): void {
    this.entries.delete(key);
  }

  private prune(t: number): void {
    for (const [k, e] of this.entries) if (e.lockedUntil < t && t - e.first > this.windowMs) this.entries.delete(k);
  }
}

// The socket peer is always the ingress pod, so use the last X-Forwarded-For hop: the address
// our ingress controller saw. Earlier hops are client-supplied and spoofable.
export function clientIp(xff: string | string[] | undefined, socketAddr: string | undefined): string {
  const last = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last || socketAddr || 'unknown';
}
