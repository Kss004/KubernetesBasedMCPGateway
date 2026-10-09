// Gateway entry (T3.1): config, migrations, /healthz, /readyz.
// /mcp is 501 until the human-written aggregator (T3.4) + router (T3.5) land;
// see HANDOFF.md for their exact contracts. Nothing here guesses at them.
import http from 'node:http';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

const cfg = loadConfig();
const pool = createPool(cfg.pg);
await migrate(pool);

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
