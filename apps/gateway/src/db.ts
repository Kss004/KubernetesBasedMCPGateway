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
];

export function createPool(pg: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): Pool {
  return new Pool({
    host: pg.host,
    port: pg.port,
    user: pg.user,
    password: pg.password,
    database: pg.database,
    max: 10,
  });
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
