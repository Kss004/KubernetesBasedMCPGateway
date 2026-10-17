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
