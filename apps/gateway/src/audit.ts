// Audit log (D22): who called what, when, how long, what happened.
// Never stores tool arguments or results — they can carry customer data
// or secrets. Denied attempts are logged too, attributed when the key
// is known (e.g. revoked). Audit writes never fail a request.
import type { Pool } from 'pg';

export type Outcome = 'ok' | 'error' | 'denied';

export interface AuditEntry {
  userId: string | null;
  keyId?: string | null;
  serverSlug: string;
  tool: string;
  outcome: Outcome;
  errorClass?: string | null;
  durationMs: number;
}

export async function logCall(pool: Pool, e: AuditEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit(user_id, key_id, server_slug, tool, outcome, error_class, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.userId, e.keyId ?? null, e.serverSlug, e.tool, e.outcome, e.errorClass ?? null, e.durationMs],
    );
  } catch (err) {
    // Callers swallow this so the request still succeeds; the lost row must not vanish silently.
    console.error(`audit write failed (user=${e.userId ?? '-'} tool=${e.tool} outcome=${e.outcome}): ${(err as Error).message}`);
    throw err;
  }
}

/** Latest 200 rows (D13 fallback), optionally scoped to one user. */
export async function listAudit(pool: Pool, userId?: string) {
  if (userId) {
    const { rows } = await pool.query(
      `SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 200`,
      [userId],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC LIMIT 200`,
  );
  return rows;
}
