// Shared stateless MCP server shell (D6): fresh McpServer + transport per
// request, optional bearer check (empty token = open, for mock-mcp), /healthz.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface ServeOptions {
  name: string;
  version: string;
  port: number;
  bearerToken?: string;
  register: (server: McpServer) => void;
}

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

export function serve(opts: ServeOptions): void {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200).end('ok');
        return;
      }
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      if (opts.bearerToken !== undefined && opts.bearerToken !== '') {
        const h = req.headers.authorization ?? '';
        const a = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : h);
        const b = Buffer.from(opts.bearerToken);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          res.writeHead(401).end();
          return;
        }
      }
      const body = await readBody(req);
      const mcp = new McpServer({ name: opts.name, version: opts.version });
      opts.register(mcp);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close().catch(() => {}));
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
    }
  });
  server.listen(opts.port, () => console.log(`${opts.name} on :${opts.port}`));
  // Node as PID 1 has no default SIGTERM handler, so without this a pod ignores scale-down
  // and keeps answering until SIGKILL at the end of its grace period (E2E M3).
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
