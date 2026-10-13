# Gateway resilience to postgres restarts (found 2026-10-13)

- Symptom: after a node reboot, `app.localhost/*` → 503 while `shop.localhost`
  worked. Cause: all pods restarted at once; gateway booted before postgres
  was up, `migrate()` threw at top level → crash → restart ×3 until pg
  accepted connections. During the window the Service had no ready endpoints.
- Fix 1 (`index.ts`): retry `migrate()` 10× with 3s backoff instead of
  crashlooping. Proven by log `migrate attempt 1 failed, retrying: EAI_AGAIN`.
- Fix 2 (`db.ts`): `pool.on('error')` logger. Found because 0.1.3 still
  restarted once on a mid-life pg drop: idle pool clients emit `error`, which
  throws unobserved without a listener. Verify: delete pg pod → log line
  `pg pool idle error: terminating connection...`, restarts stay 0,
  readyz honest throughout.
- Non-obvious: readiness (`/readyz` = `SELECT 1`) already kept bad endpoints
  out — the 503s were correct behavior during boot, just uglier than needed.
