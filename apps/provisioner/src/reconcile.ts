// One store's work, as idempotent steps. Every step checks the real state first, so running the
// whole sequence again (after a crash, a restart or a retry) is always safe:
//   Provisioning: namespace -> role binding -> helm chart -> pods ready -> register MCP server -> Ready
//   Deleting:     unregister MCP server -> delete namespace (takes volumes and Secrets) -> row removed
// A store that misses its deadline, or fails the chart 3 times, ends Failed with the reason.
import type { Gateway, Helm, Kube } from './clients.js';

export interface StoreRow {
  id: string;
  name: string;
  namespace: string;
  status: 'Provisioning' | 'Ready' | 'Failed' | 'Deleting';
  attempts: number;
  deadline: Date;
}

export interface Store {
  /** Writes only while the row is still in `expect` (a delete request wins over a running install). */
  update(id: string, expect: StoreRow['status'], fields: Record<string, unknown>): Promise<boolean>;
  remove(id: string): Promise<void>;
}

export interface Settings {
  domain: string; // shop-<name>.<domain>
  scheme: 'http' | 'https';
  tlsIssuer: string; // '' = no TLS for provisioned stores
  maxAttempts: number;
  pollMs: number;
  timeoutMin: number; // only for the Failed message; the row's deadline is what is enforced
}

export interface Deps {
  kube: Kube;
  helm: Helm;
  gateway: Gateway;
  db: Store;
  cfg: Settings;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const storeHost = (name: string, domain: string) => `shop-${name}.${domain}`;
export const serverSlug = (name: string) => `store-${name}`;
export const wooUrl = (ns: string) => `http://store-woo-mcp.${ns}:3000/mcp`;

class Timeout extends Error {}
class Superseded extends Error {} // the row left Provisioning (a delete request): stop here

export async function provision(s: StoreRow, d: Deps): Promise<void> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const left = () => Math.floor((s.deadline.getTime() - now()) / 1000);
  const step = async (name: string) => {
    if (left() <= 0) throw new Timeout(name);
    if (!(await d.db.update(s.id, 'Provisioning', { step: name }))) throw new Superseded();
  };
  const host = storeHost(s.name, d.cfg.domain);
  try {
    await step('creating namespace');
    await d.kube.ensureNamespace(s.namespace, s.name);
    await d.kube.ensureRoleBinding(s.namespace);

    await step('installing store chart');
    const state = await d.helm.status(s.namespace);
    if (state !== 'deployed') {
      // 'pending' here means an earlier install died mid-way (we hold the lease, so nobody else
      // is running it); 'failed' means the last attempt errored. Either way: clear and reinstall.
      // Generated Secrets carry helm.sh/resource-policy: keep, so the database keeps its password.
      if (state !== 'none') await d.helm.uninstall(s.namespace);
      try {
        await d.helm.install(
          s.namespace,
          {
            storeHost: host,
            storeUrl: `${d.cfg.scheme}://${host}`,
            'ingress.tlsSecretName': d.cfg.tlsIssuer ? 'shop-tls' : '',
            'ingress.certIssuer': d.cfg.tlsIssuer,
          },
          Math.max(60, left()),
        );
      } catch (e) {
        const attempts = s.attempts + 1;
        const reason = `chart install failed (attempt ${attempts}/${d.cfg.maxAttempts}): ${(e as Error).message}`;
        if (attempts >= d.cfg.maxAttempts) {
          await d.db.update(s.id, 'Provisioning', { status: 'Failed', reason, attempts });
          return;
        }
        await d.db.update(s.id, 'Provisioning', { reason, attempts });
        throw e; // retried on a later tick
      }
    }

    await step('waiting for pods');
    for (;;) {
      const r = await d.kube.workloadsReady(s.namespace);
      if (r.ready) break;
      if (left() <= 0) throw new Timeout(`waiting for pods (${r.detail})`);
      await sleep(d.cfg.pollMs);
    }

    await step('registering MCP server');
    const token = await d.kube.secretValue(s.namespace, 'store-woo-inbound', 'token');
    if (!token) throw new Error('woo-mcp token Secret not found');
    const serverId = await d.gateway.upsertServer(serverSlug(s.name), wooUrl(s.namespace), token);

    await d.db.update(s.id, 'Provisioning', {
      status: 'Ready',
      step: null,
      reason: null,
      server_id: serverId,
      url: `${d.cfg.scheme}://${host}`,
    });
  } catch (e) {
    if (e instanceof Superseded) return; // teardown takes over on the next tick
    if (e instanceof Timeout) {
      await d.db.update(s.id, 'Provisioning', { status: 'Failed', reason: `timed out after ${d.cfg.timeoutMin} min while ${e.message}` });
      return;
    }
    throw e;
  }
}

export async function teardown(s: StoreRow, d: Deps): Promise<void> {
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  await d.db.update(s.id, 'Deleting', { step: 'removing MCP server' });
  await d.gateway.deleteServer(serverSlug(s.name)); // tools disappear first
  await d.db.update(s.id, 'Deleting', { step: 'deleting namespace' });
  await d.kube.deleteNamespace(s.namespace); // PVCs, Secrets, Ingress, release: all namespaced
  for (let i = 0; i < 60; i++) {
    if (!(await d.kube.namespaceExists(s.namespace))) {
      await d.db.remove(s.id);
      return;
    }
    await sleep(d.cfg.pollMs);
  }
  throw new Error('namespace still terminating'); // retried on a later tick
}
