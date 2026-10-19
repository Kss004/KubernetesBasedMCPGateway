// Gateway entry: config, migrations, /healthz, /readyz, admin server
// registry + users/keys, session login, audit, aggregated /mcp.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { listServers, createServer, patchServer, deleteServer } from './servers.js';
import { Aggregator } from './aggregator.js';
import { handleMcp } from './router.js';
import { handleChat } from './chat.js';
import { UpstreamPool } from './pool.js';
import { listUsers, createUser, listKeys, createApiKey, revokeKey } from './keys.js';
import { listAudit } from './audit.js';
import {
  hashPassword,
  checkPassword,
  checkPasswordDummy,
  mintSession,
  verifySession,
  parseCookies,
} from './session.js';

const cfg = loadConfig();
const pool = createPool(cfg.pg);
// Postgres may still be booting after a node restart; retry instead of
// crashlooping (readiness already keeps us out of endpoints meanwhile).
for (let i = 1; ; i++) {
  try {
    await migrate(pool);
    break;
  } catch (e) {
    if (i >= 60) throw e; // ~3 min: covers a first-time postgres image pull
    console.error(`migrate attempt ${i} failed, retrying: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const upstreams = new UpstreamPool(pool, cfg.credKey);
upstreams.start();
const aggregator = new Aggregator(pool, cfg.credKey);
aggregator.start();
// After an admin server change, refresh status (pool first) and tools now, not on the next timer.
const refreshUpstreams = async (): Promise<void> => {
  await upstreams.refreshNow().catch(() => {});
  await aggregator.refresh().catch(() => {});
};

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const SESSION_RAW = process.env.SESSION_SECRET ?? '';
const SESSION_SECRET = SESSION_RAW.length >= 16 ? Buffer.from(SESSION_RAW, 'utf8') : null;
const isAdmin = (req: http.IncomingMessage): boolean => {
  if (ADMIN_TOKEN === '') return false;
  const a = Buffer.from(req.headers.authorization ?? '');
  const b = Buffer.from(`Bearer ${ADMIN_TOKEN}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

interface SessionUser {
  id: string;
  name: string;
  role: 'admin' | 'member';
}
async function sessionUser(req: http.IncomingMessage): Promise<SessionUser | null> {
  if (!SESSION_SECRET) return null;
  const token = parseCookies(req.headers.cookie).session;
  if (!token) return null;
  const v = verifySession(token, SESSION_SECRET);
  if (!v) return null;
  const { rows } = await pool.query('SELECT id, name, role FROM users WHERE id = $1', [v.userId]);
  return rows[0] ?? null;
}
// Admin via bootstrap token (scripts) or an admin session (dashboard).
// Session-authed mutations need a JSON content type (CSRF defence).
const isJsonReq = (req: http.IncomingMessage): boolean =>
  (req.headers['content-type'] ?? '').includes('application/json');
async function adminAuth(req: http.IncomingMessage): Promise<SessionUser | 'token' | null> {
  if (isAdmin(req)) return 'token';
  const u = await sessionUser(req);
  if (u && u.role === 'admin') {
    if (req.method !== 'GET' && !isJsonReq(req)) return null;
    return u;
  }
  return null;
}
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

// P5 dashboard: React build output (apps/dashboard/dist, fixed file names).
// Preloaded once; exact paths only (no join from the URL, no traversal).
// Prod image copies the dir to ./public (Dockerfile); dev resolves from the tree.
const dashDir = (() => {
  const candidates = [
    process.env.DASHBOARD_DIR ?? '',
    'public',
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'dist'),
  ];
  for (const d of candidates) {
    if (!d) continue;
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {
      // try next candidate
    }
  }
  return null;
})();
const dashFiles = new Map<string, { buf: Buffer; type: string }>();
if (dashDir) {
  const entries: Array<[string, string, string]> = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'application/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ];
  for (const [url, file, type] of entries) {
    try {
      dashFiles.set(url, { buf: fs.readFileSync(path.join(dashDir, file)), type });
    } catch {
      // leave unmapped; GET / then 503s instead of serving a partial app
    }
  }
}

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
    if ((req.url ?? '').split('?')[0] === '/mcp') {
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' });
        return;
      }
      try {
        const body = await readJson(req, 1 << 20);
        const out = await handleMcp({
          pg: pool,
          aggregator,
          upstreams,
          auth: req.headers.authorization ?? '',
          body,
        });
        send(res, out.status, out.json);
      } catch (e) {
        send(res, errStatus(e), { error: (e as Error).message });
      }
      return;
    }
    if ((req.url ?? '').startsWith('/api/servers')) {
      if (!(await adminAuth(req))) {
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
          const row = await createServer(pool, cfg.credKey, await readJson(req));
          await refreshUpstreams();
          send(res, 201, row);
          return;
        }
        if (req.method === 'PATCH' && m[1]) {
          const row = await patchServer(pool, cfg.credKey, m[1], await readJson(req));
          if (!row) send(res, 404, { error: 'not found' });
          else {
            await refreshUpstreams();
            send(res, 200, row);
          }
          return;
        }
        if (req.method === 'DELETE' && m[1]) {
          if (!(await deleteServer(pool, m[1]))) send(res, 404, { error: 'not found' });
          else {
            await refreshUpstreams();
            send(res, 200, {});
          }
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
      if (!(await adminAuth(req))) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      send(res, 200, { upstreams: upstreams.getStates() });
      return;
    }
    if ((req.url ?? '').split('?')[0] === '/api/tools' && req.method === 'GET') {
      // Dashboard servers page: cached tool names + description-change flags.
      if (!(await adminAuth(req))) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      send(res, 200, { tools: aggregator.listAllTools() });
      return;
    }
    if ((req.url ?? '').split('?')[0] === '/api/chat' && req.method === 'POST') {
      // P6 chat (D7/D22): logged-in session user, history from the client each
      // request, no server storage. JSON content-type required (CSRF defence).
      const u = await sessionUser(req);
      if (!u) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      if (!isJsonReq(req)) {
        send(res, 403, { error: 'json content type required' });
        return;
      }
      try {
        await handleChat({ pg: pool, aggregator, upstreams, user: u, body: await readJson(req, 256 << 10), res });
      } catch (e) {
        if (!res.headersSent) send(res, errStatus(e), { error: (e as Error).message });
        else {
          try {
            res.end();
          } catch {
            // client already gone
          }
        }
      }
      return;
    }
    if ((req.url ?? '').startsWith('/api/users')) {
      if (!(await adminAuth(req))) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      try {
        if (req.method === 'GET' && req.url === '/api/users') {
          send(res, 200, { users: await listUsers(pool) });
          return;
        }
        if (req.method === 'POST' && req.url === '/api/users') {
          const v = z.object({ name: z.string().min(1).max(64), role: z.enum(['admin', 'member']) }).parse(
            await readJson(req),
          );
          send(res, 201, await createUser(pool, v.name, v.role));
          return;
        }
        // Invite: admin sets a one-time password (no email infra by design).
        const mp = /^\/api\/users\/([0-9a-f-]{36})\/password$/.exec(req.url ?? '');
        if (req.method === 'POST' && mp) {
          const v = z.object({ password: z.string().min(8).max(256) }).parse(await readJson(req));
          const { rowCount } = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
            await hashPassword(v.password),
            mp[1],
          ]);
          if ((rowCount ?? 0) === 0) send(res, 404, { error: 'not found' });
          else send(res, 200, { ok: true });
          return;
        }
        send(res, 405, { error: 'method not allowed' });
      } catch (e) {
        const status = errStatus(e);
        if ((e as { code?: string }).code === '23505') send(res, 409, { error: 'name taken' });
        else {
          if (status === 500) console.error('users api', (e as Error).message);
          send(res, status, { error: (e as Error).message });
        }
      }
      return;
    }
    if ((req.url ?? '').startsWith('/api/keys')) {
      // Member self-service lives under /api/me/keys; this stays admin-only.
      if (!(await adminAuth(req))) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      try {
        if (req.method === 'GET' && req.url === '/api/keys') {
          send(res, 200, { keys: await listKeys(pool) });
          return;
        }
        if (req.method === 'POST' && req.url === '/api/keys') {
          const v = z.object({ user_id: z.string().uuid() }).parse(await readJson(req));
          // Plaintext key returned ONCE here; never stored, never logged.
          send(res, 201, await createApiKey(pool, v.user_id));
          return;
        }
        const m = /^\/api\/keys\/([0-9a-f-]{36})\/revoke$/.exec(req.url ?? '');
        if (req.method === 'POST' && m) {
          if (!(await revokeKey(pool, m[1]))) send(res, 404, { error: 'not found' });
          else send(res, 200, { revoked: true });
          return;
        }
        send(res, 405, { error: 'method not allowed' });
      } catch (e) {
        const status = errStatus(e);
        if (status === 500) console.error('keys api', (e as Error).message);
        send(res, status, { error: (e as Error).message });
      }
      return;
    }
    if (req.url === '/api/login' && req.method === 'POST') {
      if (!SESSION_SECRET) {
        send(res, 503, { error: 'login not configured' });
        return;
      }
      try {
        const v = z.object({ name: z.string().min(1), password: z.string().min(1) }).parse(await readJson(req));
        const { rows } = await pool.query('SELECT id, name, role, password_hash FROM users WHERE name = $1', [v.name]);
        const u = rows[0] as { id: string; name: string; role: 'admin' | 'member'; password_hash: string | null } | undefined;
        const okLogin = u?.password_hash
          ? await checkPassword(v.password, u.password_hash)
          : await checkPasswordDummy(v.password).then(() => false);
        if (!u || !okLogin) {
          send(res, 401, { error: 'invalid credentials' });
          return;
        }
        const token = mintSession(u.id, SESSION_SECRET);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`,
        });
        res.end(JSON.stringify({ id: u.id, name: u.name, role: u.role }));
      } catch (e) {
        send(res, errStatus(e), { error: (e as Error).message });
      }
      return;
    }
    if (req.url === '/api/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
      });
      res.end('{}');
      return;
    }
    if (req.url === '/api/me' && req.method === 'GET') {
      const u = await sessionUser(req);
      if (!u) send(res, 401, { error: 'unauthorized' });
      else send(res, 200, u);
      return;
    }
    if ((req.url ?? '').startsWith('/api/me/keys')) {
      const u = await sessionUser(req);
      if (!u) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      if (req.method !== 'GET' && !isJsonReq(req)) {
        send(res, 403, { error: 'json content type required' });
        return;
      }
      try {
        if (req.method === 'GET' && req.url === '/api/me/keys') {
          const { rows } = await pool.query(
            `SELECT k.id, k.prefix, k.revoked, k.created_at FROM api_keys k
             WHERE k.user_id = $1 ORDER BY k.created_at`,
            [u.id],
          );
          send(res, 200, { keys: rows });
          return;
        }
        if (req.method === 'POST' && req.url === '/api/me/keys') {
          send(res, 201, await createApiKey(pool, u.id));
          return;
        }
        const m = /^\/api\/me\/keys\/([0-9a-f-]{36})\/revoke$/.exec(req.url ?? '');
        if (req.method === 'POST' && m) {
          const { rowCount } = await pool.query('UPDATE api_keys SET revoked = true WHERE id = $1 AND user_id = $2', [
            m[1],
            u.id,
          ]);
          if ((rowCount ?? 0) === 0) send(res, 404, { error: 'not found' });
          else send(res, 200, { revoked: true });
          return;
        }
        send(res, 405, { error: 'method not allowed' });
      } catch (e) {
        send(res, errStatus(e), { error: (e as Error).message });
      }
      return;
    }
    if ((req.url ?? '').startsWith('/api/audit') && req.method === 'GET') {
      if (isAdmin(req)) {
        const url = new URL(req.url ?? '/api/audit', 'http://x');
        const uid = url.searchParams.get('user_id') ?? undefined;
        if (uid !== undefined && !/^[0-9a-f-]{36}$/i.test(uid)) {
          send(res, 400, { error: 'user_id must be a uuid' });
          return;
        }
        send(res, 200, { audit: await listAudit(pool, uid) });
        return;
      }
      const u = await sessionUser(req);
      if (!u) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      // Members see only their own rows; admins see all (D22).
      send(res, 200, { audit: await listAudit(pool, u.role === 'admin' ? undefined : u.id) });
      return;
    }
    if ((req.url ?? '').startsWith('/.well-known/')) {
      // D26: real clients probe OAuth discovery; we use static keys.
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }
    const dashPath = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && dashFiles.has(dashPath)) {
      const f = dashFiles.get(dashPath)!;
      res.writeHead(200, { 'Content-Type': f.type });
      res.end(f.buf);
      return;
    }
    if (req.method === 'GET' && (dashPath === '/' || dashPath === '/index.html') && !dashFiles.has('/')) {
      res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"dashboard not built"}');
      return;
    }
    res.writeHead(404).end();
  } catch {
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(cfg.port, () => console.log(`gateway on :${cfg.port}`));
// Node as PID 1 has no default SIGTERM handler, so without this a pod ignores scale-down
// and keeps answering until SIGKILL at the end of its grace period (E2E M3).
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
