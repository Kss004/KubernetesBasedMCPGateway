// Hosted MCP servers API against a real Postgres: allow-listed images only, no slug clash with
// existing servers, env stored encrypted and never returned, platform limit. TEST_DATABASE_URL.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../src/db.ts';
import { createHosted, listHosted, removeHosted } from '../src/hosted.ts';
import { decryptSecret } from '../src/crypto.ts';

const url = process.env.TEST_DATABASE_URL;
const key = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const limits = { max: 2, imagePrefixes: ['ghcr.io/kss004/'], timeoutMin: 10 };

describe('hosted servers API (Postgres)', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: pg.Pool;
  before(async () => {
    pool = new pg.Pool({ connectionString: url });
    await migrate(pool);
    await pool.query('DELETE FROM hosted_servers');
    await pool.query(`DELETE FROM servers WHERE slug LIKE 'ht-%'`);
    await pool.query(`INSERT INTO servers(slug, url, auth_type) VALUES ('ht-taken', 'http://x.urumi-upstreams:3000/mcp', 'none')`);
  });
  after(async () => {
    await pool.query('DELETE FROM hosted_servers');
    await pool.query(`DELETE FROM servers WHERE slug LIKE 'ht-%'`);
    await pool.end();
  });

  it('only allow-listed images', async () => {
    await assert.rejects(createHosted(pool, key, null, { slug: 'ht-evil', image: 'docker.io/evil/miner:1' }, limits), /allowed registry/);
  });
  it('no clash with an existing server slug', async () => {
    await assert.rejects(createHosted(pool, key, null, { slug: 'ht-taken', image: 'ghcr.io/kss004/x:1' }, limits), /already exists/);
  });
  it('stores env encrypted, returns only the names, and enforces the limit', async () => {
    const h = await createHosted(pool, key, null, { slug: 'ht-one', image: 'ghcr.io/kss004/x:1', env: { API_KEY: 's3cret' } }, limits);
    assert.equal(h.status, 'Deploying');
    const { rows } = await pool.query('SELECT env_enc FROM hosted_servers WHERE id = $1', [h.id]);
    assert.ok(!rows[0].env_enc.includes('s3cret'));
    assert.deepEqual(JSON.parse(decryptSecret(rows[0].env_enc, key)), { API_KEY: 's3cret' });
    const listed = await listHosted(pool);
    assert.deepEqual(listed[0].env_names, ['API_KEY']);
    assert.ok(!JSON.stringify(listed).includes('s3cret') && !('env_enc' in listed[0]));
    await createHosted(pool, key, null, { slug: 'ht-two', image: 'ghcr.io/kss004/x:1' }, limits);
    await assert.rejects(createHosted(pool, key, null, { slug: 'ht-three', image: 'ghcr.io/kss004/x:1' }, limits), /2 hosted servers/);
    assert.equal(await removeHosted(pool, h.id), true);
    assert.equal(await removeHosted(pool, h.id), false, 'already removing');
  });
  it('rejects bad env names and low ports', async () => {
    await assert.rejects(createHosted(pool, key, null, { slug: 'ht-four', image: 'ghcr.io/kss004/x:1', env: { 'bad-name': 'x' } }, limits));
    await assert.rejects(createHosted(pool, key, null, { slug: 'ht-four', image: 'ghcr.io/kss004/x:1', port: 80 }, limits));
  });
});
