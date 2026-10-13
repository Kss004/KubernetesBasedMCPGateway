// Gateway entry (T3.1/T3.2): config, migrations, /healthz, /readyz,
// admin server registry. /mcp is 501 until the human-written aggregator
// (T3.4) + router (T3.5) land; see HANDOFF.md for their exact contracts.
import http from 'node:http';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { listServers, createServer, patchServer, deleteServer } from './servers.js';
import { UpstreamPool } from './pool.js';

const cfg = loadConfig();
const pool = createPool(cfg.pg);
// Postgres may still be booting after a node restart; retry instead of
// crashlooping (readiness already keeps us out of endpoints meanwhile).
for (let i = 1; ; i++) {
  try {
    await migrate(pool);
    break;
  } catch (e) {
    if (i >= 10) throw e;
    console.error(`migrate attempt ${i} failed, retrying: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const upstreams = new UpstreamPool(pool, cfg.credKey);
upstreams.start();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const readJson = (req: http.IncomingMessage, limit = 64 << 10): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const errStatus = (e: unknown): number => (e as { status?: number }).status ?? 500;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      try {
        await pool.query('SELECT 1');
        res.writeHead(200).end('ready');
      } catch {
        res.writeHead(503).end('db unavailable');
      }
      return;
    }
    if (req.url === '/mcp') {
      // T3.4/T3.5: authenticate the user key, serve aggregated tools.
      res.writeHead(501).end('mcp not wired yet (T3.4/T3.5)');
      return;
    }
    if ((req.url ?? '').startsWith('/api/servers')) {
      const h = req.headers.authorization ?? '';
      if (ADMIN_TOKEN === '' || h !== `Bearer ${ADMIN_TOKEN}`) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      try {
        const m = /^\/api\/servers(?:\/([0-9a-f-]{36}))?$/.exec(req.url ?? '');
        if (!m) {
          send(res, 404, { error: 'not found' });
          return;
        }
        if (req.method === 'GET' && !m[1]) {
          send(res, 200, { servers: await listServers(pool) });
          return;
        }
        if (req.method === 'POST' && !m[1]) {
          send(res, 201, await createServer(pool, cfg.credKey, await readJson(req)));
          return;
        }
        if (req.method === 'PATCH' && m[1]) {
          const row = await patchServer(pool, cfg.credKey, m[1], await readJson(req));
          if (!row) send(res, 404, { error: 'not found' });
          else send(res, 200, row);
          return;
        }
        if (req.method === 'DELETE' && m[1]) {
          if (!(await deleteServer(pool, m[1]))) send(res, 404, { error: 'not found' });
          else send(res, 200, {});
          return;
        }
        send(res, 405, { error: 'method not allowed' });
      } catch (e) {
        const status = errStatus(e);
        if (status === 500) console.error('admin api', (e as Error).message);
        send(res, status, { error: (e as Error).message });
      }
      return;
    }
    if (req.url === '/api/upstreams' && req.method === 'GET') {
      const h = req.headers.authorization ?? '';
      if (ADMIN_TOKEN === '' || h !== `Bearer ${ADMIN_TOKEN}`) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      send(res, 200, { upstreams: upstreams.getStates() });
      return;
    }
    if ((req.url ?? '').startsWith('/.well-known/')) {
      // D26: real clients probe OAuth discovery; we use static keys.
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }
    res.writeHead(404).end();
  } catch {
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(cfg.port, () => console.log(`gateway on :${cfg.port}`));
