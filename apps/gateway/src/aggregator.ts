// Tool aggregator (T3.4): cached per-server tool lists so tools/list never
// waits on a dead upstream. Refresh on our own timer; serve last-known for
// Unreachable. Names are <slug>__<tool> (D5), whole name <= 64 chars.
// Defensive limits against untrusted upstreams: <=200 tools/server,
// description truncated to 1024 chars, sha256 per description with a change
// flag for the dashboard (compromised-upstream defence, R14).
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Pool as PgPool } from 'pg';
import { listServers } from './servers.js';
import { decryptSecret } from './crypto.js';
import { authHeaders } from './pool.js';

export const MAX_TOOLS_PER_SERVER = 200;
export const MAX_NAME_LEN = 64;
export const MAX_DESCRIPTION_LEN = 1024;

export interface PrefixedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  serverId: string;
  serverSlug: string;
  changed: boolean;
}

/** prefix or null when the whole name would exceed 64 chars. */
export function prefixName(slug: string, tool: string): string | null {
  const name = `${slug}__${tool}`;
  return name.length <= MAX_NAME_LEN ? name : null;
}

/** Split at the first __; slug charset has no underscore so this is exact. */
export function splitName(prefixed: string): { slug: string; tool: string } | null {
  const i = prefixed.indexOf('__');
  if (i <= 0) return null;
  const slug = prefixed.slice(0, i);
  const tool = prefixed.slice(i + 2);
  if (!/^[a-z0-9-]+$/.test(slug) || tool.length === 0) return null;
  return { slug, tool };
}

export const capDescription = (d: string): string =>
  d.length > MAX_DESCRIPTION_LEN ? d.slice(0, MAX_DESCRIPTION_LEN) + '…[truncated]' : d;

const descHash = (d: string): string => createHash('sha256').update(d, 'utf8').digest('hex');

export class Aggregator {
  private cache = new Map<string, { tools: PrefixedTool[]; hashes: Map<string, string> }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pg: PgPool,
    private credKey: Buffer,
    private refreshMs = 15000,
    private toolTimeoutMs = 5000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh().catch(() => {}), this.refreshMs);
    void this.refresh().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  listAllTools(): PrefixedTool[] {
    return [...this.cache.values()].flatMap((c) => c.tools);
  }

  resolve(prefixed: string): { serverId: string; tool: PrefixedTool } | null {
    if (!splitName(prefixed)) return null; // validates shape; lookup is by full name
    for (const [serverId, c] of this.cache) {
      const tool = c.tools.find((t) => t.name === prefixed);
      if (tool) return { serverId, tool };
    }
    return null;
  }

  private async headersFor(serverId: string, authType: string, headerName: string | null): Promise<Record<string, string>> {
    const { rows } = await this.pg.query('SELECT enc_secret FROM server_credentials WHERE server_id = $1', [
      serverId,
    ]);
    if (rows.length === 0) return {};
    let secret: string;
    try {
      secret = decryptSecret(rows[0].enc_secret, this.credKey);
    } catch {
      return {};
    }
    return authHeaders(authType, headerName, secret);
  }

  async refresh(): Promise<void> {
    const servers = await listServers(this.pg);
    const seen = new Set<string>();
    // Parallel: a slow upstream only delays its own tool list (each has toolTimeoutMs).
    await Promise.allSettled(servers.map(async (s) => {
      seen.add(s.id);
      if (!s.enabled) {
        this.cache.delete(s.id);
        return;
      }
      const tools = await this.fetchTools(s).catch(() => null);
      if (tools === null) return; // keep last-known for Unreachable
      const prev = this.cache.get(s.id);
      const withFlags = tools.map((t) => {
        const h = descHash(t.description);
        const prevH = prev?.hashes.get(t.name);
        return { ...t, changed: prevH !== undefined && prevH !== h };
      });
      this.cache.set(s.id, {
        tools: withFlags,
        hashes: new Map(withFlags.map((t) => [t.name, descHash(t.description)])),
      });
    }));
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id);
  }

  private async fetchTools(s: { id: string; slug: string; url: string; auth_type: string; header_name: string | null }): Promise<PrefixedTool[]> {
    const { id: serverId, slug, url } = s;
    const client = new Client({ name: 'gateway-aggregator', version: '0.1.0' });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.toolTimeoutMs);
    try {
      // Per-request signal: the SDK transport ignores requestInit.signal (E2E M3, see pool.probe).
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: await this.headersFor(serverId, s.auth_type, s.header_name) },
      });
      await client.connect(transport, { signal: ctl.signal });
      const { tools } = await client.listTools(undefined, { signal: ctl.signal });
      const out: PrefixedTool[] = [];
      for (const tool of tools.slice(0, MAX_TOOLS_PER_SERVER)) {
        const name = prefixName(slug, tool.name);
        if (name === null) continue;
        const description = capDescription(typeof tool.description === 'string' ? tool.description : '');
        out.push({ name, description, inputSchema: tool.inputSchema ?? {}, serverId, serverSlug: slug, changed: false });
      }
      return out;
    } finally {
      clearTimeout(t);
      await client.close().catch(() => {}); // aborts the transport's own in-flight fetch
    }
  }
}
