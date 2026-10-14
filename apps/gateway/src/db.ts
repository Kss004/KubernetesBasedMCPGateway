// Plain pg Pool + numbered idempotent migrations (no ORM, ponytail rule).
import { Pool } from 'pg';

export type Migration = { version: number; sql: string };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS servers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
        url text NOT NULL,
        auth_type text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none','bearer','header')),
        header_name text,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS server_credentials (
        server_id uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        enc_secret text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // T4.1: team users + API keys. Keys are 32 random bytes, shown once,
    // stored as SHA-256 hex (indexable lookup; bcrypt is for passwords).
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text UNIQUE NOT NULL,
        role text NOT NULL CHECK (role IN ('admin','member')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash text UNIQUE NOT NULL,
        prefix text NOT NULL,
        revoked boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id);
    `,
  },
  {
    // Audit (D22): every tools/call incl. failures and denied attempts.
    // No args or results stored (customer data / secrets risk).
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        key_id uuid,
        server_slug text NOT NULL DEFAULT '',
        tool text NOT NULL,
        outcome text NOT NULL CHECK (outcome IN ('ok','error','denied')),
        error_class text,
        duration_ms integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS audit_user_idx ON audit(user_id, created_at DESC);
    `,
  },
  {
    // Login (dashboard): password hash per user. Invite = admin sets a
    // one-time password; no email infra exists so the UI must say so.
    version: 4,
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;`,
  },
];

export function createPool(pg: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): Pool {
  const pool = new Pool({
    host: pg.host,
    port: pg.port,
    user: pg.user,
    password: pg.password,
    database: pg.database,
    max: 10,
  });
  // Idle-client failures (e.g. postgres restarts mid-life) must not crash
  // the process: ready probes/retries handle recovery. Without this, the
  // Pool's 'error' event throws unobserved.
  pool.on('error', (e) => console.error(`pg pool idle error: ${(e as Error).message}`));
  return pool;
}

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY)');
    for (const m of MIGRATIONS) {
      const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [m.version]);
      if (rows.length === 0) {
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [m.version]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
    }
  } finally {
    client.release();
  }
}
