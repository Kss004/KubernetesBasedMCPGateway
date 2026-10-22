// Hosted MCP servers: the objects we create are locked down, and deploy/remove are idempotent.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { decryptEnv, deployHosted, hostedUrl, manifests, removeHostedServer, type HostedDeps, type HostedRow } from '../src/hosted.ts';

const key = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const enc = (v: unknown) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
};
const row = (over: Partial<HostedRow> = {}): HostedRow => ({
  id: 'h1', slug: 'demo', image: 'ghcr.io/x/mock-mcp:1', port: 3000, path: '/mcp', env_enc: enc({ API_KEY: 's3cret' }),
  status: 'Deploying', deadline: new Date(Date.now() + 600_000), ...over,
});

describe('hosted manifests', () => {
  const [secret, dep, svc, np] = manifests(row(), { API_KEY: 's3cret' }, 'urumi-gateway') as any[];
  it('decrypts env with the gateway key format and puts it only in the Secret', () => {
    assert.deepEqual(decryptEnv(row().env_enc, key), { API_KEY: 's3cret' });
    assert.equal(secret.stringData.API_KEY, 's3cret');
    assert.ok(!JSON.stringify(dep).includes('s3cret'));
  });
  it('runs locked down: no API token, non-root, read-only root fs, no capabilities, limits', () => {
    const pod = dep.spec.template.spec;
    const c = pod.containers[0];
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.securityContext.runAsNonRoot, true);
    assert.equal(c.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(c.securityContext.capabilities.drop, ['ALL']);
    assert.ok(c.resources.limits.cpu && c.resources.limits.memory);
  });
  it('accepts traffic only from gateway pods, on its port', () => {
    const from = np.spec.ingress[0].from[0];
    assert.deepEqual(from.namespaceSelector.matchLabels, { 'kubernetes.io/metadata.name': 'urumi-gateway' });
    assert.deepEqual(from.podSelector.matchLabels, { app: 'gateway' });
    assert.equal(np.spec.ingress[0].ports[0].port, 3000);
    assert.equal(svc.metadata.namespace, 'urumi-hosted');
  });
});

describe('deploy and remove', () => {
  const fake = (readyAfter = 1) => {
    const log: string[] = [];
    const objs = new Set<string>();
    const state: Record<string, unknown> = { status: 'Deploying' };
    let polls = 0;
    const d: HostedDeps = {
      credKey: key, gatewayNamespace: 'urumi-gateway', pollMs: 0, timeoutMin: 10, sleep: async () => {},
      kube: {
        apply: async (o: any) => { log.push(`apply ${o.kind}`); objs.add(`${o.kind}`); },
        remove: async (p: string) => { log.push(`remove ${p.split('/').slice(-2, -1)[0]}`); },
        deploymentReady: async () => ({ ready: ++polls > readyAfter, detail: 'ImagePullBackOff' }),
      } as any,
      gateway: {
        upsertServer: async (slug, url, token) => { log.push(`register ${slug} ${url} token=${token}`); return 's9'; },
        deleteServer: async (slug) => { log.push(`unregister ${slug}`); },
      },
      db: {
        update: async (_id, expect, f) => (state.status === expect ? (Object.assign(state, f), true) : false),
        remove: async () => { state.removed = true; },
      },
    };
    return { d, log, state, objs };
  };
  it('applies the 4 objects, waits, registers without auth, ends Ready', async () => {
    const f = fake();
    await deployHosted(row(), f.d);
    assert.equal(f.state.status, 'Ready');
    assert.deepEqual(f.log.slice(0, 4), ['apply Secret', 'apply Deployment', 'apply Service', 'apply NetworkPolicy']);
    assert.equal(f.log[4], `register demo ${hostedUrl(row())} token=null`);
  });
  it('a pod that never starts fails with the reason Kubernetes gives', async () => {
    const f = fake(1_000_000);
    await deployHosted(row({ deadline: new Date(Date.now() - 1) }), f.d);
    assert.equal(f.state.status, 'Failed');
    assert.match(String(f.state.reason), /timed out after 10 min \(ImagePullBackOff\)/);
  });
  it('remove unregisters first, then deletes every object, then the row', async () => {
    const f = fake();
    f.state.status = 'Removing';
    await removeHostedServer(row({ status: 'Removing' }), f.d);
    assert.deepEqual(f.log, ['unregister demo', 'remove networkpolicies', 'remove services', 'remove deployments', 'remove secrets']);
    assert.equal(f.state.removed, true);
  });
});
