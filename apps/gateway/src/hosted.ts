// Hosted MCP servers (stand-out): an admin adds a server by container image instead of URL.
// Like stores, the gateway only records the request; the provisioner deploys it into the
// urumi-hosted namespace (Deployment, Service, Secret, NetworkPolicy), registers it as an upstream,
// and removes all of it again. Env values are encrypted at rest like upstream credentials.
import type { Pool } from 'pg';
import { z } from 'zod';
import { encryptSecret } from './crypto.js';

export interface HostedLimits {
  max: number;
  /** An image must start with one of these (registry/repository prefixes). */
  imagePrefixes: string[];
  timeoutMin: number;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const Create = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/, 'slug: 3-32 lowercase letters, digits or dashes'),
  image: z.string().min(3).max(255).regex(/^[a-z0-9][a-z0-9._\/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/, 'image: registry/repository:tag'),
  port: z.number().int().min(1024).max(65535).default(3000),
  path: z.string().regex(/^\/[A-Za-z0-9._\/-]*$/).max(100).default('/mcp'),
  env: z.record(z.string().regex(ENV_NAME, 'env names: UPPER_CASE'), z.string().max(4096)).default({}),
});

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function listHosted(pool: Pool) {
  const { rows } = await pool.query(
    `SELECT h.id, h.slug, h.image, h.port, h.path, h.status, h.step, h.reason, h.created_at, h.env_names,
            (sv.id IS NOT NULL) AS registered
     FROM hosted_servers h LEFT JOIN servers sv ON sv.id = h.server_id
     ORDER BY h.created_at`,
  );
  return rows; // env values are never returned, only their names
}

export async function createHosted(pool: Pool, credKey: Buffer, userId: string | null, input: unknown, limits: HostedLimits) {
  const v = Create.parse(input);
  if (!limits.imagePrefixes.some((p) => v.image.startsWith(p)))
    throw err(400, `image must come from an allowed registry: ${limits.imagePrefixes.join(', ')}`);
  if (Object.keys(v.env).length > 10) throw err(400, 'at most 10 env variables');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE hosted_servers IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await client.query('SELECT count(*)::int AS n FROM hosted_servers');
    if (rows[0].n >= limits.max) throw err(429, `limit reached: ${limits.max} hosted servers`);
    const taken = await client.query('SELECT 1 FROM servers WHERE slug = $1', [v.slug]);
    if (taken.rows.length) throw err(409, `a server named "${v.slug}" already exists`);
    const ins = await client.query(
      `INSERT INTO hosted_servers(slug, image, port, path, env_enc, env_names, status, step, created_by, deadline)
       VALUES ($1, $2, $3, $4, $5, $6, 'Deploying', 'queued', $7, now() + make_interval(mins => $8))
       RETURNING id, slug, image, status`,
      [v.slug, v.image, v.port, v.path, encryptSecret(JSON.stringify(v.env), credKey), Object.keys(v.env), userId, limits.timeoutMin],
    );
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    if ((e as { code?: string }).code === '23505') throw err(409, `a hosted server named "${v.slug}" already exists`);
    throw e;
  } finally {
    client.release();
  }
}

export async function removeHosted(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE hosted_servers SET status = 'Removing', step = 'queued', reason = NULL, lease_until = NULL, updated_at = now()
     WHERE id = $1 AND status <> 'Removing'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}
