// Plain pg Pool + numbered idempotent migrations (no ORM).
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
  {
    // Logout invalidation. Session tokens carry this number; logout and a password
    // reset bump it, so every earlier token for the user stops working.
    version: 5,
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version int NOT NULL DEFAULT 0;`,
  },
  {
    // Observability: per-server metrics scan the audit table by time window.
    version: 6,
    sql: `CREATE INDEX IF NOT EXISTS audit_created_idx ON audit(created_at DESC);`,
  },
  {
    // Scaling: rate-limit and login-lock counters shared by every replica (ratelimit.ts).
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS rate_counters (
        key text NOT NULL,
        window_start timestamptz NOT NULL,
        n int NOT NULL,
        PRIMARY KEY (key, window_start)
      );
      CREATE TABLE IF NOT EXISTS login_limits (
        key text PRIMARY KEY,
        count int NOT NULL,
        first_at timestamptz NOT NULL,
        locked_until timestamptz
      );
    `,
  },
  {
    // Multi-store provisioning: the gateway records the wanted state, the provisioner pod works
    // it (stores.ts, apps/provisioner). lease_* lets a restarted provisioner pick work back up.
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS stores (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL UNIQUE,
        owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
        namespace text NOT NULL UNIQUE,
        status text NOT NULL CHECK (status IN ('Provisioning','Ready','Failed','Deleting')),
        step text,
        reason text,
        url text,
        server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
        attempts int NOT NULL DEFAULT 0,
        deadline timestamptz NOT NULL,
        lease_owner text,
        lease_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // Hosted MCP servers: added by container image, deployed by the provisioner (hosted.ts).
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS hosted_servers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL UNIQUE,
        image text NOT NULL,
        port int NOT NULL,
        path text NOT NULL,
        env_enc text NOT NULL,
        env_names text[] NOT NULL DEFAULT '{}',
        status text NOT NULL CHECK (status IN ('Deploying','Ready','Failed','Removing')),
        step text,
        reason text,
        server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        attempts int NOT NULL DEFAULT 0,
        deadline timestamptz NOT NULL,
        lease_owner text,
        lease_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
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

// Several replicas may start at once: a session-level advisory lock makes them migrate one at a
// time, so the second one finds every version already applied.
const MIGRATE_LOCK = 7_446_001;

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK]);
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
    // Pooled connections stay open, so the session lock must be released explicitly.
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK]).catch(() => {});
    client.release();
  }
}
