// The three things the provisioner talks to, each behind a small interface so reconcile.ts can be
// tested with fakes: the Kubernetes API (plain fetch with the pod's ServiceAccount token), the
// helm binary, and the gateway's admin API (to register a store's MCP server).
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export interface Kube {
  ensureNamespace(ns: string, store: string): Promise<void>;
  /** Gives this provisioner the store-manager role inside `ns`, and nowhere else. */
  ensureRoleBinding(ns: string): Promise<void>;
  namespaceExists(ns: string): Promise<boolean>;
  deleteNamespace(ns: string): Promise<void>;
  /** Every Deployment and StatefulSet in `ns` has all its replicas ready. */
  workloadsReady(ns: string): Promise<{ ready: boolean; detail: string }>;
  secretValue(ns: string, name: string, key: string): Promise<string | null>;
  /** Server-side apply: creates or updates the object (idempotent). */
  apply(obj: { apiVersion: string; kind: string; metadata: { name: string; namespace: string } }): Promise<void>;
  /** Deletes one object by API path; a missing object is fine. */
  remove(path: string): Promise<void>;
  deploymentReady(ns: string, name: string): Promise<{ ready: boolean; detail: string }>;
}

/** REST path of a namespaced object (only the kinds the provisioner manages for hosted servers). */
export function objectPath(apiVersion: string, kind: string, ns: string, name: string): string {
  const plural: Record<string, string> = { Deployment: 'deployments', Service: 'services', Secret: 'secrets', NetworkPolicy: 'networkpolicies' };
  const base = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
  return `${base}/namespaces/${ns}/${plural[kind]}/${name}`;
}

export type ReleaseState = 'none' | 'deployed' | 'failed' | 'pending';

export interface Helm {
  status(ns: string): Promise<ReleaseState>;
  install(ns: string, sets: Record<string, string>, timeoutSec: number): Promise<void>;
  uninstall(ns: string): Promise<void>;
}

export interface Gateway {
  /** Creates or updates the server row; returns its id. A null token registers it without auth. */
  upsertServer(slug: string, url: string, token: string | null): Promise<string>;
  deleteServer(slug: string): Promise<void>;
}

// ---------- Kubernetes API ----------

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export class KubeApi implements Kube {
  constructor(
    private storeRole: string, // ClusterRole bound per store namespace
    private sa: { name: string; namespace: string },
  ) {}

  private async call(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<{ status: number; json: any }> {
    const token = (await readFile(`${SA_DIR}/token`, 'utf8')).trim(); // re-read: tokens rotate
    // NODE_EXTRA_CA_CERTS points at the ServiceAccount CA, so fetch trusts the API server.
    const res = await fetch(`https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text };
    }
    return { status: res.status, json };
  }

  private async must(method: string, path: string, body: unknown, ok: number[]): Promise<any> {
    const r = await this.call(method, path, body);
    if (!ok.includes(r.status)) throw new Error(`kubernetes ${method} ${path}: ${r.status} ${r.json?.message ?? ''}`.trim());
    return r.json;
  }

  async ensureNamespace(ns: string, store: string): Promise<void> {
    await this.must(
      'POST',
      '/api/v1/namespaces',
      { metadata: { name: ns, labels: { 'app.kubernetes.io/managed-by': 'harbor-provisioner', 'harbor.urumi/store': store } } },
      [201, 409],
    );
  }

  async ensureRoleBinding(ns: string): Promise<void> {
    await this.must(
      'POST',
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`,
      {
        metadata: { name: 'harbor-provisioner' },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: this.storeRole },
        subjects: [{ kind: 'ServiceAccount', name: this.sa.name, namespace: this.sa.namespace }],
      },
      [201, 409],
    );
  }

  async namespaceExists(ns: string): Promise<boolean> {
    const r = await this.call('GET', `/api/v1/namespaces/${ns}`);
    if (r.status === 404) return false;
    if (r.status !== 200) throw new Error(`kubernetes GET namespace ${ns}: ${r.status}`);
    return true; // includes Terminating
  }

  async deleteNamespace(ns: string): Promise<void> {
    await this.must('DELETE', `/api/v1/namespaces/${ns}`, undefined, [200, 202, 404]);
  }

  async workloadsReady(ns: string): Promise<{ ready: boolean; detail: string }> {
    const [d, s] = await Promise.all([
      this.must('GET', `/apis/apps/v1/namespaces/${ns}/deployments`, undefined, [200]),
      this.must('GET', `/apis/apps/v1/namespaces/${ns}/statefulsets`, undefined, [200]),
    ]);
    const waiting: string[] = [];
    for (const x of d.items ?? []) if ((x.status?.availableReplicas ?? 0) < (x.spec?.replicas ?? 1)) waiting.push(x.metadata.name);
    for (const x of s.items ?? []) if ((x.status?.readyReplicas ?? 0) < (x.spec?.replicas ?? 1)) waiting.push(x.metadata.name);
    const total = (d.items?.length ?? 0) + (s.items?.length ?? 0);
    if (total === 0) return { ready: false, detail: 'no workloads yet' };
    return { ready: waiting.length === 0, detail: waiting.length ? `waiting for ${waiting.join(', ')}` : 'all ready' };
  }

  async apply(obj: { apiVersion: string; kind: string; metadata: { name: string; namespace: string } }): Promise<void> {
    const path = `${objectPath(obj.apiVersion, obj.kind, obj.metadata.namespace, obj.metadata.name)}?fieldManager=harbor-provisioner&force=true`;
    const r = await this.call('PATCH', path, obj, 'application/apply-patch+yaml'); // JSON is valid YAML
    if (r.status !== 200 && r.status !== 201) throw new Error(`kubernetes apply ${obj.kind}/${obj.metadata.name}: ${r.status} ${r.json?.message ?? ''}`.trim());
  }

  async remove(path: string): Promise<void> {
    await this.must('DELETE', path, undefined, [200, 202, 404]);
  }

  async deploymentReady(ns: string, name: string): Promise<{ ready: boolean; detail: string }> {
    const r = await this.call('GET', `/apis/apps/v1/namespaces/${ns}/deployments/${name}`);
    if (r.status === 404) return { ready: false, detail: 'deployment not found' };
    if (r.status !== 200) throw new Error(`kubernetes GET deployment ${ns}/${name}: ${r.status}`);
    const ok = (r.json.status?.availableReplicas ?? 0) >= (r.json.spec?.replicas ?? 1);
    // Surface why a pod is not starting (bad image, crash) instead of just "waiting".
    const pods = await this.call('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`hosted=${name}`)}`);
    let detail = ok ? 'ready' : 'starting';
    for (const p of pods.json?.items ?? [])
      for (const c of p.status?.containerStatuses ?? []) {
        const w = c.state?.waiting;
        if (w?.reason && w.reason !== 'ContainerCreating') detail = `${w.reason}${w.message ? `: ${String(w.message).slice(0, 160)}` : ''}`;
      }
    return { ready: ok, detail };
  }

  async secretValue(ns: string, name: string, key: string): Promise<string | null> {
    const r = await this.call('GET', `/api/v1/namespaces/${ns}/secrets/${name}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`kubernetes GET secret ${ns}/${name}: ${r.status}`);
    const v = r.json?.data?.[key];
    return v ? Buffer.from(v, 'base64').toString('utf8') : null;
  }
}

// ---------- helm ----------

const run = (args: string[], timeoutMs: number): Promise<{ stdout: string }> =>
  new Promise((resolve, reject) => {
    execFile('helm', args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) {
        // The last stderr line is the useful one ("Error: ..."); never echo values (no secrets in them anyway).
        const line = (stderr || err.message).trim().split('\n').filter(Boolean).pop() ?? 'helm failed';
        reject(new Error(line.length > 300 ? `${line.slice(0, 297)}...` : line));
      } else resolve({ stdout });
    });
  });

export class HelmCli implements Helm {
  constructor(
    private chartDir: string,
    private valuesFiles: string[], // relative to chartDir
    private release = 'store',
  ) {}

  async status(ns: string): Promise<ReleaseState> {
    try {
      const { stdout } = await run(['status', this.release, '-n', ns, '-o', 'json'], 30_000);
      const s = String(JSON.parse(stdout)?.info?.status ?? '');
      if (s === 'deployed') return 'deployed';
      if (s.startsWith('pending')) return 'pending';
      return 'failed';
    } catch (e) {
      if (/not found/i.test((e as Error).message)) return 'none';
      throw e;
    }
  }

  async install(ns: string, sets: Record<string, string>, timeoutSec: number): Promise<void> {
    const args = ['upgrade', '--install', this.release, this.chartDir, '-n', ns, '--timeout', `${timeoutSec}s`];
    for (const f of this.valuesFiles) args.push('-f', `${this.chartDir}/${f}`);
    for (const [k, v] of Object.entries(sets)) args.push('--set-string', `${k}=${v}`);
    // No --wait: the bootstrap post-install hook already blocks until WooCommerce is set up.
    await run(args, (timeoutSec + 30) * 1000);
  }

  async uninstall(ns: string): Promise<void> {
    try {
      await run(['uninstall', this.release, '-n', ns, '--no-hooks'], 120_000);
    } catch (e) {
      if (!/not found/i.test((e as Error).message)) throw e;
    }
  }
}

// ---------- gateway admin API ----------

export class GatewayApi implements Gateway {
  constructor(
    private base: string,
    private adminToken: string,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.adminToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  private async find(slug: string): Promise<{ id: string } | undefined> {
    const r = await this.call('GET', '/api/servers');
    if (r.status !== 200) throw new Error(`gateway list servers: ${r.status}`);
    return (r.json.servers as Array<{ id: string; slug: string }>).find((s) => s.slug === slug);
  }

  async upsertServer(slug: string, url: string, token: string | null): Promise<string> {
    const existing = await this.find(slug);
    const auth = token ? { auth_type: 'bearer', secret: token } : { auth_type: 'none' };
    const r = existing
      ? await this.call('PATCH', `/api/servers/${existing.id}`, { url, ...auth, ...(token ? {} : { secret: null }), enabled: true })
      : await this.call('POST', '/api/servers', { slug, url, ...auth });
    if (r.status !== 200 && r.status !== 201) throw new Error(`gateway register ${slug}: ${r.status} ${r.json?.error ?? ''}`.trim());
    return r.json.id as string;
  }

  async deleteServer(slug: string): Promise<void> {
    const existing = await this.find(slug);
    if (!existing) return;
    const r = await this.call('DELETE', `/api/servers/${existing.id}`);
    if (r.status !== 200 && r.status !== 404) throw new Error(`gateway remove ${slug}: ${r.status}`);
  }
}
