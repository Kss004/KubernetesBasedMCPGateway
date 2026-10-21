// Admin CRUD for upstream servers + their encrypted credentials (T3.2).
// Guarded by a bootstrap admin token (ADMIN_TOKEN, Secret-mounted). P4 login
// replaces this with session auth; the token path stays for make seed.
// Plaintext secrets never appear in a response or a log: only presence.
import type { Pool } from 'pg';
import { z } from 'zod';
import { encryptSecret } from './crypto.js';

export interface ServerRow {
  id: string;
  slug: string;
  url: string;
  auth_type: 'none' | 'bearer' | 'header';
  header_name: string | null;
  enabled: boolean;
  has_secret: boolean;
}

// T11.2 SSRF guard: upstreams are cluster-internal (D18/D25), so only
// Service DNS in urumi-store / urumi-upstreams is allowed. Any IP literal is
// denied (covers loopback 127/8, link-local 169.254/16 incl. 169.254.169.254,
// and private ranges). Plain hostname check only.
// Limit: no DNS resolution at admission; a name later resolving to a
// forbidden IP is not caught — resolve-and-recheck before dialing if that matters.
export function validUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username !== '' || u.password !== '') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (/^[\d.]+$/.test(host)) return false; // dotted-decimal / decimal-int IP literal
  if (host.includes(':')) return false; // any IPv6 literal (::1, fe80::/10, mapped)
  return /^[a-z0-9-]+\.(urumi-store|urumi-upstreams)(\.svc(\.cluster\.local)?)?$/.test(host);
}

const SLUG = z.string().regex(/^[a-z0-9-]{1,32}$/);
const Create = z.object({
  slug: SLUG,
  url: z.string().min(1),
  auth_type: z.enum(['none', 'bearer', 'header']).default('none'),
  header_name: z.string().min(1).max(64).optional(),
  secret: z.string().min(1).max(1024).optional(),
});
const Patch = z.object({
  url: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  auth_type: z.enum(['none', 'bearer', 'header']).optional(),
  header_name: z.string().min(1).max(64).nullable().optional(),
  secret: z.string().min(1).max(1024).nullable().optional(),
});

export async function listServers(pool: Pool): Promise<ServerRow[]> {
  const { rows } = await pool.query(
    `SELECT s.id, s.slug, s.url, s.auth_type, s.header_name, s.enabled,
            (c.server_id IS NOT NULL) AS has_secret
     FROM servers s LEFT JOIN server_credentials c ON c.server_id = s.id
     ORDER BY s.slug`,
  );
  return rows;
}

export async function createServer(pool: Pool, credKey: Buffer, input: unknown): Promise<ServerRow> {
  const v = Create.parse(input);
  if (!validUrl(v.url)) throw Object.assign(new Error('invalid url'), { status: 400 });
  if (v.auth_type !== 'none' && !v.secret) throw Object.assign(new Error('secret required'), { status: 400 });
  if (v.auth_type === 'header' && !v.header_name) throw Object.assign(new Error('header_name required'), { status: 400 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO servers(slug, url, auth_type, header_name) VALUES ($1,$2,$3,$4)
       RETURNING id, slug, url, auth_type, header_name, enabled`,
      [v.slug, v.url, v.auth_type, v.header_name ?? null],
    );
    if (v.secret) {
      await client.query('INSERT INTO server_credentials(server_id, enc_secret) VALUES ($1,$2)', [
        rows[0].id,
        encryptSecret(v.secret, credKey),
      ]);
    }
    await client.query('COMMIT');
    return { ...rows[0], has_secret: !!v.secret };
  } catch (e) {
    await client.query('ROLLBACK');
    if ((e as { code?: string }).code === '23505') throw Object.assign(new Error('slug taken'), { status: 409 });
    throw e;
  } finally {
    client.release();
  }
}

export async function patchServer(
  pool: Pool,
  credKey: Buffer,
  id: string,
  input: unknown,
): Promise<ServerRow | null> {
  const v = Patch.parse(input);
  if (v.url !== undefined && !validUrl(v.url)) throw Object.assign(new Error('invalid url'), { status: 400 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const push = (col: string, val: unknown) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };
    if (v.url !== undefined) push('url', v.url);
    if (v.enabled !== undefined) push('enabled', v.enabled);
    if (v.auth_type !== undefined) push('auth_type', v.auth_type);
    if (v.header_name !== undefined) push('header_name', v.header_name);
    push('updated_at', new Date());
    const { rowCount } = await client.query(`UPDATE servers SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (v.secret !== undefined) {
      if (v.secret === null) {
        await client.query('DELETE FROM server_credentials WHERE server_id = $1', [id]);
      } else {
        await client.query(
          `INSERT INTO server_credentials(server_id, enc_secret) VALUES ($1,$2)
           ON CONFLICT (server_id) DO UPDATE SET enc_secret = EXCLUDED.enc_secret, updated_at = now()`,
          [id, encryptSecret(v.secret, credKey)],
        );
      }
    }
    // Validate the merged row, not the patch fields alone (same rules as create).
    const { rows: chk } = await client.query(
      `SELECT s.auth_type, s.header_name, (c.server_id IS NOT NULL) AS has_secret
       FROM servers s LEFT JOIN server_credentials c ON c.server_id = s.id WHERE s.id = $1`,
      [id],
    );
    const m = chk[0] as { auth_type: string; header_name: string | null; has_secret: boolean } | undefined;
    if (m && m.auth_type !== 'none' && !m.has_secret) throw Object.assign(new Error('secret required'), { status: 400 });
    if (m && m.auth_type === 'header' && !m.header_name)
      throw Object.assign(new Error('header_name required'), { status: 400 });
    await client.query('COMMIT');
    if ((rowCount ?? 0) === 0) return null;
    const list = await listServers(pool);
    return list.find((s) => s.id === id) ?? null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteServer(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM servers WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
