// Multi-store provisioning, gateway side (bonus). The gateway only records what users want:
// a row per store with a status. The provisioner (apps/provisioner), a separate pod with its own
// narrowly scoped Kubernetes rights, does the work and moves the row through
// Provisioning -> Ready | Failed, and Deleting -> gone. The internet-facing gateway never
// talks to the Kubernetes API.
import type { Pool } from 'pg';
import { z } from 'zod';

export interface StoreLimits {
  perUser: number;
  total: number;
  timeoutMin: number;
}

// DNS label for the namespace (urumi-store-<name>), the host (shop-<name>.<domain>) and the MCP
// slug (store-<name>): lowercase, 3-20 characters, starts with a letter, no trailing dash.
const NAME = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,18}[a-z0-9]$/, 'name: 3-20 lowercase letters, digits or dashes, starting with a letter');
const RESERVED = new Set(['app', 'shop', 'www', 'admin', 'api', 'mail', 'woo', 'gateway', 'system', 'default', 'test']);

export const storeNamespace = (name: string) => `urumi-store-${name}`;

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function listStores(pool: Pool, user: { id: string; role: 'admin' | 'member' }) {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.status, s.step, s.reason, s.url, s.created_at, s.updated_at, s.owner_id,
            u.name AS owner_name, sv.slug AS server_slug
     FROM stores s
     LEFT JOIN users u ON u.id = s.owner_id
     LEFT JOIN servers sv ON sv.id = s.server_id
     WHERE $1::boolean OR s.owner_id = $2
     ORDER BY s.created_at`,
    [user.role === 'admin', user.id],
  );
  return rows;
}

export async function createStore(pool: Pool, user: { id: string }, input: unknown, limits: StoreLimits) {
  const { name } = z.object({ name: NAME }).parse(input);
  if (RESERVED.has(name)) throw err(400, `"${name}" is reserved`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One lock for the count-then-insert, so two quick clicks cannot both pass the limit.
    await client.query('LOCK TABLE stores IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await client.query(
      `SELECT count(*) FILTER (WHERE owner_id = $1)::int AS mine, count(*)::int AS total FROM stores`,
      [user.id],
    );
    const { mine, total } = rows[0] as { mine: number; total: number };
    if (mine >= limits.perUser) throw err(429, `limit reached: ${limits.perUser} stores per user`);
    if (total >= limits.total) throw err(429, `limit reached: ${limits.total} stores on this platform`);
    const ins = await client.query(
      `INSERT INTO stores(name, owner_id, namespace, status, step, deadline)
       VALUES ($1, $2, $3, 'Provisioning', 'queued', now() + make_interval(mins => $4))
       RETURNING id, name, status, step, created_at`,
      [name, user.id, storeNamespace(name), limits.timeoutMin],
    );
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    if ((e as { code?: string }).code === '23505') throw err(409, `a store named "${name}" already exists`);
    throw e;
  } finally {
    client.release();
  }
}

/** Marks a store for teardown; the provisioner removes the MCP registration, then the namespace. */
export async function deleteStore(pool: Pool, user: { id: string; role: 'admin' | 'member' }, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE stores SET status = 'Deleting', step = 'queued', reason = NULL, lease_until = NULL, updated_at = now()
     WHERE id = $1 AND ($2::boolean OR owner_id = $3) AND status <> 'Deleting'`,
    [id, user.role === 'admin', user.id],
  );
  return (rowCount ?? 0) > 0;
}
