// API keys (T4.1): 32 random bytes shown once, stored as SHA-256 hex.
// Bcrypt is for passwords only: keys are high-entropy and looked up by hash.
// Revoke = flag (keeps attribution for denied attempts, D22).
import { randomBytes, createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface KeyUser {
  keyId: string;
  userId: string;
  name: string;
  role: 'admin' | 'member';
}

export const hashKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

export function makeKey(): { key: string; hash: string; prefix: string } {
  const key = randomBytes(32).toString('hex');
  return { key, hash: hashKey(key), prefix: key.slice(0, 8) };
}

export async function createUser(pool: Pool, name: string, role: 'admin' | 'member') {
  const { rows } = await pool.query('INSERT INTO users(name, role) VALUES ($1,$2) RETURNING id, name, role', [
    name,
    role,
  ]);
  return rows[0] as { id: string; name: string; role: 'admin' | 'member' };
}

export async function listUsers(pool: Pool) {
  const { rows } = await pool.query('SELECT id, name, role FROM users ORDER BY name');
  return rows as Array<{ id: string; name: string; role: 'admin' | 'member' }>;
}

/** Creates a key, returns plaintext ONCE (never stored, never logged). */
export async function createApiKey(pool: Pool, userId: string) {
  const { key, hash, prefix } = makeKey();
  const { rows } = await pool.query(
    'INSERT INTO api_keys(user_id, key_hash, prefix) VALUES ($1,$2,$3) RETURNING id, prefix, created_at',
    [userId, hash, prefix],
  );
  return { id: rows[0].id as string, key, prefix, created_at: rows[0].created_at };
}

export async function listKeys(pool: Pool) {
  const { rows } = await pool.query(
    `SELECT k.id, k.user_id, u.name AS user_name, u.role, k.prefix, k.revoked, k.created_at
     FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.created_at`,
  );
  return rows;
}

export async function revokeKey(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('UPDATE api_keys SET revoked = true WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function authenticate(pool: Pool, key: string): Promise<KeyUser | null> {
  if (!key) return null;
  const { rows } = await pool.query(
    `SELECT k.id AS key_id, u.id AS user_id, u.name, u.role
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1 AND k.revoked = false`,
    [hashKey(key)],
  );
  if (rows.length === 0) return null;
  return { keyId: rows[0].key_id, userId: rows[0].user_id, name: rows[0].name, role: rows[0].role };
}
