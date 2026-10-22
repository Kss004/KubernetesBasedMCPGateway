// Provision / teardown steps against fakes: happy path, retry safety, crash recovery, timeouts,
// and a delete request winning over a running install.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Gateway, Helm, Kube, ReleaseState } from '../src/clients.ts';
import { provision, teardown, type Deps, type StoreRow } from '../src/reconcile.ts';

function world(over: { release?: ReleaseState; installFails?: number; readyAfter?: number; status?: StoreRow['status'] } = {}) {
  const log: string[] = [];
  const st = { release: over.release ?? ('none' as ReleaseState), installFails: over.installFails ?? 0, readyPolls: 0, ns: new Set<string>(), servers: new Map<string, string>() };
  const row: Record<string, unknown> = { status: over.status ?? 'Provisioning' };
  const kube: Kube = {
    async ensureNamespace(ns) {
      log.push(`ns ${ns}`);
      st.ns.add(ns);
    },
    async ensureRoleBinding(ns) {
      log.push(`rb ${ns}`);
    },
    async namespaceExists(ns) {
      return st.ns.has(ns);
    },
    async deleteNamespace(ns) {
      log.push(`delete ns ${ns}`);
      st.ns.delete(ns);
    },
    async workloadsReady() {
      st.readyPolls++;
      return { ready: st.readyPolls > (over.readyAfter ?? 0), detail: 'waiting for store-wordpress' };
    },
    async secretValue() {
      return 'tok';
    },
  };
  const helm: Helm = {
    async status() {
      return st.release;
    },
    async install(ns, sets) {
      log.push(`install ${ns} ${sets.storeHost} tls=${sets['ingress.tlsSecretName']}`);
      if (st.installFails > 0) {
        st.installFails--;
        st.release = 'failed';
        throw new Error('Error: context deadline exceeded');
      }
      st.release = 'deployed';
    },
    async uninstall(ns) {
      log.push(`uninstall ${ns}`);
      st.release = 'none';
    },
  };
  const gateway: Gateway = {
    async upsertServer(slug, url) {
      log.push(`register ${slug} ${url}`);
      st.servers.set(slug, url);
      return 'srv-1';
    },
    async deleteServer(slug) {
      log.push(`unregister ${slug}`);
      st.servers.delete(slug);
    },
  };
  const d: Deps = {
    kube,
    helm,
    gateway,
    db: {
      async update(_id, expect, fields) {
        if (row.status !== expect) return false;
        Object.assign(row, fields);
        return true;
      },
      async remove() {
        row.removed = true;
      },
    },
    cfg: { domain: 'example.test', scheme: 'https', tlsIssuer: 'letsencrypt-prod', maxAttempts: 3, pollMs: 0, timeoutMin: 10 },
    sleep: async () => {},
  };
  const store = (attempts = 0, deadlineMs = 600_000): StoreRow => ({
    id: 's1',
    name: 'alpha',
    namespace: 'urumi-store-alpha',
    status: row.status as StoreRow['status'],
    attempts,
    deadline: new Date(Date.now() + deadlineMs),
  });
  return { d, st, row, log, store };
}

describe('provision', () => {
  it('runs every step and ends Ready with the MCP server registered', async () => {
    const w = world({ readyAfter: 2 });
    await provision(w.store(), w.d);
    assert.equal(w.row.status, 'Ready');
    assert.equal(w.row.url, 'https://shop-alpha.example.test');
    assert.equal(w.row.server_id, 'srv-1');
    assert.equal(w.st.servers.get('store-alpha'), 'http://store-woo-mcp.urumi-store-alpha:3000/mcp');
    assert.deepEqual(w.log, [
      'ns urumi-store-alpha',
      'rb urumi-store-alpha',
      'install urumi-store-alpha shop-alpha.example.test tls=shop-tls',
      'register store-alpha http://store-woo-mcp.urumi-store-alpha:3000/mcp',
    ]);
  });

  it('is safe to re-run: an installed release is not installed again', async () => {
    const w = world({ release: 'deployed' });
    await provision(w.store(), w.d);
    assert.equal(w.row.status, 'Ready');
    assert.ok(!w.log.some((l) => l.startsWith('install')));
  });

  it('recovers from a provisioner that died mid-install (pending release): clears it and reinstalls', async () => {
    const w = world({ release: 'pending' });
    await provision(w.store(), w.d);
    assert.equal(w.row.status, 'Ready');
    const i = w.log.indexOf('uninstall urumi-store-alpha');
    assert.ok(i >= 0 && w.log[i + 1].startsWith('install'), w.log.join(' | '));
  });

  it('a failed install is retried, and the 3rd failure ends Failed with the reason', async () => {
    const w = world({ installFails: 5 });
    await assert.rejects(provision(w.store(0), w.d));
    assert.equal(w.row.status, 'Provisioning');
    assert.match(String(w.row.reason), /attempt 1\/3/);
    await assert.rejects(provision(w.store(1), w.d));
    await provision(w.store(2), w.d);
    assert.equal(w.row.status, 'Failed');
    assert.match(String(w.row.reason), /chart install failed \(attempt 3\/3\): Error: context deadline exceeded/);
  });

  it('a store past its deadline fails cleanly with the step it was on', async () => {
    const w = world({ readyAfter: 1_000_000 });
    const s = w.store(0, 0); // deadline already reached
    await provision(s, w.d);
    assert.equal(w.row.status, 'Failed');
    assert.equal(w.row.reason, 'timed out after 10 min while creating namespace');
  });

  it('a delete request wins: the running install cannot flip the row back to Ready', async () => {
    const w = world();
    const s = w.store();
    w.row.status = 'Deleting'; // user clicked Delete while the chart was installing
    await provision(s, w.d);
    assert.equal(w.row.status, 'Deleting');
    assert.deepEqual(w.log, [], 'nothing more is installed or registered');
  });
});

describe('teardown', () => {
  it('removes the MCP server first, then the namespace, then the row', async () => {
    const w = world({ status: 'Deleting' });
    w.st.ns.add('urumi-store-alpha');
    w.st.servers.set('store-alpha', 'x');
    await teardown(w.store(), w.d);
    assert.deepEqual(w.log, ['unregister store-alpha', 'delete ns urumi-store-alpha']);
    assert.equal(w.st.servers.size, 0);
    assert.equal(w.row.removed, true);
  });

  it('is safe to re-run when everything is already gone', async () => {
    const w = world({ status: 'Deleting' });
    await teardown(w.store(), w.d);
    assert.equal(w.row.removed, true);
  });
});
