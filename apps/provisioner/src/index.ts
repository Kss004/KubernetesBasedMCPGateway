// Store provisioner (multi-store bonus). A separate pod from the gateway: it is the only thing
// with Kubernetes write rights, and those rights are confined to urumi-store-* namespaces
// (ClusterRoles + a ValidatingAdmissionPolicy in charts/gateway/templates/provisioner.yaml).
// It never takes requests: it reads the wanted state from the stores table and works it.
//
// Work is claimed with a lease (lease_owner, lease_until) renewed while a store is being worked.
// If this pod dies mid-install, the lease runs out and the next pod (or this one, restarted)
// claims the store again and re-runs its idempotent steps (reconcile.ts).
import http from 'node:http';
import os from 'node:os';
import pg from 'pg';
import { GatewayApi, HelmCli, KubeApi } from './clients.js';
import { provision, teardown, type Deps, type StoreRow } from './reconcile.js';

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const POD = env('POD_NAME', os.hostname());
const TICK_MS = 5000;
const LEASE_SEC = 60;
const PARALLEL = Number(env('PARALLEL', '4'));

const pool = new pg.Pool({
  host: env('PGHOST'),
  user: env('PGUSER', 'gateway'),
  password: env('PGPASSWORD'),
  database: env('PGDATABASE', 'gateway'),
  max: 6,
});
pool.on('error', (e) => console.error(`pg idle error: ${e.message}`));

const deps: Deps = {
  kube: new KubeApi(env('STORE_ROLE'), { name: env('SA_NAME'), namespace: env('SA_NAMESPACE') }),
  helm: new HelmCli(env('CHART_DIR', '/charts/store'), env('STORE_VALUES', 'values-prod.yaml,values-provisioned.yaml').split(',')),
  gateway: new GatewayApi(env('GATEWAY_URL'), env('ADMIN_TOKEN')),
  db: {
    async update(id, expect, fields) {
      const keys = Object.keys(fields);
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const { rowCount } = await pool.query(
        `UPDATE stores SET ${sets}${sets ? ', ' : ''}updated_at = now() WHERE id = $1 AND status = $2`,
        [id, expect, ...keys.map((k) => fields[k])],
      );
      return (rowCount ?? 0) > 0;
    },
    async remove(id) {
      await pool.query(`DELETE FROM stores WHERE id = $1 AND status = 'Deleting'`, [id]);
    },
  },
  cfg: {
    domain: env('STORE_DOMAIN'),
    scheme: env('STORE_SCHEME', 'https') === 'http' ? 'http' : 'https',
    tlsIssuer: env('STORE_TLS_ISSUER', ''),
    maxAttempts: 3,
    pollMs: 5000,
    timeoutMin: Number(env('TIMEOUT_MIN', '10')),
  },
};

const running = new Set<string>();
let lastTick = Date.now();

/** Claims up to `n` stores that need work and are not leased by a live provisioner. */
async function claim(n: number): Promise<StoreRow[]> {
  if (n <= 0) return [];
  const { rows } = await pool.query(
    `UPDATE stores SET lease_owner = $1, lease_until = now() + make_interval(secs => $2)
     WHERE id IN (
       SELECT id FROM stores
       WHERE status IN ('Provisioning', 'Deleting') AND (lease_until IS NULL OR lease_until < now())
         AND NOT (id = ANY($4::uuid[]))
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $3)
     RETURNING id, name, namespace, status, attempts, deadline`,
    [POD, LEASE_SEC, n, [...running]],
  );
  return rows as StoreRow[];
}

async function work(s: StoreRow): Promise<void> {
  running.add(s.id);
  const renew = setInterval(
    () =>
      void pool
        .query(`UPDATE stores SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2`, [s.id, POD, LEASE_SEC])
        .catch(() => {}),
    LEASE_SEC * 333, // a third of the lease
  );
  try {
    console.log(`${s.status === 'Deleting' ? 'teardown' : 'provision'} ${s.name}`);
    if (s.status === 'Deleting') await teardown(s, deps);
    else await provision(s, deps);
    await pool.query(`UPDATE stores SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2`, [s.id, POD]);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`${s.name}: ${msg} (will retry)`);
    // Keep the reason visible and retry after a short back-off (the lease runs out in 15s).
    await pool
      .query(`UPDATE stores SET reason = coalesce(reason, $3), lease_until = now() + interval '15 seconds' WHERE id = $1 AND lease_owner = $2`, [
        s.id,
        POD,
        msg.slice(0, 300),
      ])
      .catch(() => {});
  } finally {
    clearInterval(renew);
    running.delete(s.id);
  }
}

async function tick(): Promise<void> {
  lastTick = Date.now();
  for (const s of await claim(PARALLEL - running.size)) void work(s);
}

// Liveness: the loop must keep ticking (a stuck event loop gets the pod restarted).
http
  .createServer((req, res) => {
    const ok = Date.now() - lastTick < 60_000;
    res.writeHead(ok ? 200 : 503).end(ok ? 'ok' : 'stalled');
  })
  .listen(8080);

// The stores table is created by the gateway's migrations; wait for it on a fresh install.
for (;;) {
  try {
    await pool.query('SELECT 1 FROM stores LIMIT 1');
    break;
  } catch (e) {
    console.error(`waiting for the stores table: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
console.log(`provisioner ${POD} ready (domain ${deps.cfg.domain}, parallel ${PARALLEL})`);
setInterval(() => void tick().catch((e) => console.error(`tick: ${(e as Error).message}`)), TICK_MS);
void tick().catch((e) => console.error(`tick: ${(e as Error).message}`));

process.on('SIGTERM', () => process.exit(0)); // leases expire and another pod resumes the work
