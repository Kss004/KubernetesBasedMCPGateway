// Multi-store API rules against a real Postgres: names, per-user and platform limits, duplicates,
// and who can see or delete which store. Runs when TEST_DATABASE_URL is set.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../src/db.ts';
import { createStore, deleteStore, listStores } from '../src/stores.ts';

const url = process.env.TEST_DATABASE_URL;
const limits = { perUser: 2, total: 3, timeoutMin: 10 };

describe('stores API (Postgres)', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: pg.Pool;
  let a: { id: string; role: 'admin' | 'member' };
  let b: { id: string; role: 'admin' | 'member' };
  let admin: { id: string; role: 'admin' | 'member' };
  before(async () => {
    pool = new pg.Pool({ connectionString: url });
    await migrate(pool);
    await pool.query('DELETE FROM stores');
    await pool.query(`DELETE FROM users WHERE name LIKE 'st-test-%'`);
    const mk = async (name: string, role: string) =>
      (await pool.query(`INSERT INTO users(name, role) VALUES ($1, $2) RETURNING id`, [name, role])).rows[0].id as string;
    a = { id: await mk('st-test-a', 'member'), role: 'member' };
    b = { id: await mk('st-test-b', 'member'), role: 'member' };
    admin = { id: await mk('st-test-admin', 'admin'), role: 'admin' };
  });
  after(async () => {
    await pool.query('DELETE FROM stores');
    await pool.query(`DELETE FROM users WHERE name LIKE 'st-test-%'`);
    await pool.end();
  });

  it('validates names and rejects reserved ones', async () => {
    for (const bad of ['ab', 'Alpha', '1abc', 'abc-', 'a_b_c', 'x'.repeat(21)])
      await assert.rejects(createStore(pool, a, { name: bad }, limits), /name: 3-20/, bad);
    await assert.rejects(createStore(pool, a, { name: 'shop' }, limits), (e: { status?: number }) => e.status === 400);
  });

  it('creates Provisioning rows with a namespace and deadline; enforces the per-user limit', async () => {
    const s = await createStore(pool, a, { name: 'alpha' }, limits);
    assert.equal(s.status, 'Provisioning');
    const { rows } = await pool.query(`SELECT namespace, deadline > now() + interval '9 minutes' AS ok FROM stores WHERE id = $1`, [s.id]);
    assert.deepEqual(rows[0], { namespace: 'urumi-store-alpha', ok: true });
    await createStore(pool, a, { name: 'beta' }, limits);
    await assert.rejects(createStore(pool, a, { name: 'gamma' }, limits), /2 stores per user/);
  });

  it('rejects a duplicate name and enforces the platform limit', async () => {
    await assert.rejects(createStore(pool, b, { name: 'alpha' }, limits), (e: { status?: number }) => e.status === 409);
    await createStore(pool, b, { name: 'delta' }, limits);
    await assert.rejects(createStore(pool, b, { name: 'omega' }, limits), /3 stores on this platform/);
  });

  it('members see and delete only their own stores; admins see and delete all', async () => {
    assert.deepEqual((await listStores(pool, a)).map((s) => s.name).sort(), ['alpha', 'beta']);
    assert.equal((await listStores(pool, admin)).length, 3);
    const delta = (await listStores(pool, b))[0];
    assert.equal(await deleteStore(pool, a, delta.id), false, "A cannot delete B's store");
    assert.equal(await deleteStore(pool, b, delta.id), true);
    assert.equal((await listStores(pool, b))[0].status, 'Deleting');
    const alpha = (await listStores(pool, a)).find((s) => s.name === 'alpha')!;
    assert.equal(await deleteStore(pool, admin, alpha.id), true);
  });

  it('two quick creates cannot both pass the limit', async () => {
    await pool.query('DELETE FROM stores');
    const r = await Promise.allSettled([
      createStore(pool, a, { name: 'race-one' }, { ...limits, perUser: 1 }),
      createStore(pool, a, { name: 'race-two' }, { ...limits, perUser: 1 }),
    ]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  });
});
