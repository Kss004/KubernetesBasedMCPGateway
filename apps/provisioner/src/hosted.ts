// Hosted MCP servers: deploy an admin-chosen image into urumi-hosted, register it, remove it.
// Every object is server-side applied, so re-running after a crash or retry is safe.
import { createDecipheriv } from 'node:crypto';
import type { Gateway, Kube } from './clients.js';
import { objectPath } from './clients.js';

export const HOSTED_NS = 'urumi-hosted';

export interface HostedRow {
  id: string;
  slug: string;
  image: string;
  port: number;
  path: string;
  env_enc: string;
  status: 'Deploying' | 'Ready' | 'Failed' | 'Removing';
  deadline: Date;
}

export interface HostedStore {
  update(id: string, expect: HostedRow['status'], fields: Record<string, unknown>): Promise<boolean>;
  remove(id: string): Promise<void>;
}

export interface HostedDeps {
  kube: Kube;
  gateway: Gateway;
  db: HostedStore;
  credKey: Buffer;
  gatewayNamespace: string;
  pollMs: number;
  timeoutMin: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Same format as the gateway's crypto.ts: base64(iv 12B || ciphertext || tag 16B). */
export function decryptEnv(blob: string, key: Buffer): Record<string, string> {
  const raw = Buffer.from(blob, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'));
}

const name = (slug: string) => `hosted-${slug}`;
export const hostedUrl = (h: Pick<HostedRow, 'slug' | 'port' | 'path'>) => `http://${name(h.slug)}.${HOSTED_NS}:${h.port}${h.path}`;

/** The four objects for one hosted server. Locked down: no API token, non-root, read-only root fs. */
export function manifests(h: HostedRow, env: Record<string, string>, gatewayNamespace: string) {
  const n = name(h.slug);
  const labels = { hosted: n, 'app.kubernetes.io/managed-by': 'harbor-provisioner' };
  return [
    { apiVersion: 'v1', kind: 'Secret', metadata: { name: n, namespace: HOSTED_NS, labels }, type: 'Opaque', stringData: { ...env, PORT: String(h.port) } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: n, namespace: HOSTED_NS, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { hosted: n } },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'server',
                image: h.image,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: h.port }],
                envFrom: [{ secretRef: { name: n } }],
                resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
                volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
                readinessProbe: { tcpSocket: { port: h.port }, periodSeconds: 5 },
                livenessProbe: { tcpSocket: { port: h.port }, initialDelaySeconds: 15, periodSeconds: 20 },
              },
            ],
            volumes: [{ name: 'tmp', emptyDir: {} }],
          },
        },
      },
    },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: n, namespace: HOSTED_NS, labels }, spec: { selector: { hosted: n }, ports: [{ port: h.port, targetPort: h.port }] } },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: n, namespace: HOSTED_NS, labels },
      spec: {
        podSelector: { matchLabels: { hosted: n } },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': gatewayNamespace } }, podSelector: { matchLabels: { app: 'gateway' } } }],
            ports: [{ port: h.port }],
          },
        ],
      },
    },
  ];
}

class Superseded extends Error {}

export async function deployHosted(h: HostedRow, d: HostedDeps): Promise<void> {
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const left = () => h.deadline.getTime() - Date.now();
  const step = async (s: string) => {
    if (!(await d.db.update(h.id, 'Deploying', { step: s }))) throw new Superseded();
  };
  try {
    await step('applying objects');
    for (const m of manifests(h, decryptEnv(h.env_enc, d.credKey), d.gatewayNamespace)) await d.kube.apply(m as never);
    await step('waiting for the pod');
    let detail = 'starting';
    for (;;) {
      const r = await d.kube.deploymentReady(HOSTED_NS, name(h.slug));
      if (r.ready) break;
      detail = r.detail;
      if (left() <= 0) {
        await d.db.update(h.id, 'Deploying', { status: 'Failed', reason: `timed out after ${d.timeoutMin} min (${detail})` });
        return;
      }
      await sleep(d.pollMs);
    }
    await step('registering MCP server');
    const serverId = await d.gateway.upsertServer(h.slug, hostedUrl(h), null);
    await d.db.update(h.id, 'Deploying', { status: 'Ready', step: null, reason: null, server_id: serverId });
  } catch (e) {
    if (e instanceof Superseded) return;
    throw e;
  }
}

export async function removeHostedServer(h: HostedRow, d: HostedDeps): Promise<void> {
  await d.db.update(h.id, 'Removing', { step: 'removing MCP server' });
  await d.gateway.deleteServer(h.slug);
  await d.db.update(h.id, 'Removing', { step: 'deleting objects' });
  const n = name(h.slug);
  for (const [apiVersion, kind] of [['networking.k8s.io/v1', 'NetworkPolicy'], ['v1', 'Service'], ['apps/v1', 'Deployment'], ['v1', 'Secret']])
    await d.kube.remove(objectPath(apiVersion, kind, HOSTED_NS, n));
  await d.db.remove(h.id);
}
