// woo-mcp: stateless Streamable HTTP MCP server (fresh McpServer + transport
// per request, D6). Verifies the gateway bearer token on every /mcp request.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import type { WooConfig } from './woo.js';

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.WOO_MCP_TOKEN ?? '';
const wooCfg: WooConfig = {
  serviceBase: process.env.WP_BASE ?? 'http://store-wordpress',
  homeBase: process.env.WP_HOME_URL ?? 'http://shop.localhost',
  consumerKey: process.env.REST_CONSUMER_KEY ?? '',
  consumerSecret: process.env.REST_CONSUMER_SECRET ?? '',
  timeoutMs: Number(process.env.WOO_TIMEOUT_MS ?? 10000),
};

const validToken = (req: http.IncomingMessage): boolean => {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ') || TOKEN === '') return false;
  const a = Buffer.from(h.slice(7));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

const readBody = (req: http.IncomingMessage, limit = 1 << 20): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mcp' || !validToken(req)) {
      res.writeHead(req.method === 'POST' ? 401 : 404).end();
      return;
    }
    const body = await readBody(req);
    const mcp = new McpServer({ name: 'woo-mcp', version: '0.1.0' });
    registerTools(mcp, wooCfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close().catch(() => {}));
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch {
    if (!res.headersSent) res.writeHead(400).end();
  }
});

server.listen(PORT, () => console.log(`woo-mcp on :${PORT}`));
