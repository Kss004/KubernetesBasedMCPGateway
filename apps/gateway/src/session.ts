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

// v2 adds the user's session_version (logout ends the session server-side).
// v1 tokens no longer verify, so the deploy logs everyone out once.
const PREFIX = 'v2';

export function mintSession(userId: string, version: number, secret: Buffer, ttlMs = 7 * 24 * 3600 * 1000): string {
  const exp = Date.now() + ttlMs;
  const body = `${PREFIX}.${userId}.${version}.${exp}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token: string, secret: Buffer): { userId: string; version: number } | null {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== PREFIX) return null;
  const version = Number(parts[2]);
  const exp = Number(parts[3]);
  if (!Number.isInteger(version) || !Number.isFinite(exp) || exp < Date.now()) return null;
  const body = `${PREFIX}.${parts[1]}.${parts[2]}.${parts[3]}`;
  const want = createHmac('sha256', secret).update(body).digest();
  let got: Buffer;
  try {
    got = Buffer.from(parts[4], 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return { userId: parts[1], version };
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

// The login rate limit moved to ratelimit.ts (Postgres-backed, shared by every replica).

// The socket peer is always the ingress pod, so use the last X-Forwarded-For hop: the address
// our ingress controller saw. Earlier hops are client-supplied and spoofable.
export function clientIp(xff: string | string[] | undefined, socketAddr: string | undefined): string {
  const last = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last || socketAddr || 'unknown';
}
