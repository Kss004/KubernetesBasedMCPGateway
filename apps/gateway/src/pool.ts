// Upstream pool (T3.3): health states + per-call fresh clients (D6).
// No persistent MCP connections: the gateway is stateless, so every call
// builds a short-lived Client + transport. The background loop only tracks
// Connected / Unreachable / Disabled (probe every 5s, 2s timeout, Unreachable
// after 2 consecutive failures; backing off to 30s while down) so listing
// never waits on a dead upstream. Stateful upstreams (everything) can drop
// sessions with 404: callUpstream re-connects once and retries once.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Pool as PgPool } from 'pg';
import { listServers } from './servers.js';
import { decryptSecret } from './crypto.js';

export type UpstreamStatus = 'Connected' | 'Unreachable' | 'Disabled';
export interface UpstreamState {
  id: string;
  slug: string;
  url: string;
  auth_type: 'none' | 'bearer' | 'header';
  header_name: string | null;
  enabled: boolean;
  status: UpstreamStatus;
}

export class UpstreamPool {
  private states = new Map<string, UpstreamState & { failures: number; skipUntil: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pg: PgPool,
    private credKey: Buffer,
    private healthIntervalMs = 5000,
    private healthTimeoutMs = 2000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.healthIntervalMs);
    void this.tick().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStates(): UpstreamState[] {
    return [...this.states.values()].map(({ failures: _f, skipUntil: _s, ...s }) => s);
  }

  private secrets = new Map<string, string>();

  private async tick(): Promise<void> {
    const rows = await listServers(this.pg);
    await this.refreshSecrets();
    const seen = new Set<string>();
    const now = Date.now();
    for (const r of rows) {
      seen.add(r.id);
      let st = this.states.get(r.id);
      if (!st) {
        st = { ...r, status: r.enabled ? 'Unreachable' : 'Disabled', failures: 0, skipUntil: 0 };
        this.states.set(r.id, st);
      } else {
        Object.assign(st, { slug: r.slug, url: r.url, auth_type: r.auth_type, header_name: r.header_name, enabled: r.enabled });
      }
      if (!r.enabled) {
        st.status = 'Disabled';
        st.failures = 0;
        this.secrets.delete(r.id);
        continue;
      }
      if (now < st.skipUntil) continue; // backed off while down
      const ok = await this.probe(st);
      if (ok) {
        st.status = 'Connected';
        st.failures = 0;
        st.skipUntil = 0;
      } else {
        st.failures += 1;
        if (st.failures >= 2) st.status = 'Unreachable';
        // capped backoff while down: 5s, 10s, 20s, 30s max
        st.skipUntil = now + Math.min(30000, 5000 * 2 ** Math.max(0, st.failures - 1));
      }
    }
    for (const id of [...this.states.keys()]) {
      if (!seen.has(id)) {
        this.states.delete(id);
        this.secrets.delete(id);
      }
    }
  }

  private async probe(st: UpstreamState): Promise<boolean> {
    const client = new Client({ name: 'gateway-health', version: '0.1.0' });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.healthTimeoutMs);
    try {
      const transport = new StreamableHTTPClientTransport(new URL(st.url), {
        requestInit: { headers: this.authHeaders(st), signal: ctl.signal },
      });
      await client.connect(transport);
      await client.listTools();
      await client.close().catch(() => {});
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  private authHeaders(st: UpstreamState): Record<string, string> {
    const secret = this.secrets.get(st.id);
    if (!secret) return {};
    if (st.auth_type === 'bearer') return { Authorization: `Bearer ${secret}` };
    if (st.auth_type === 'header' && st.header_name) return { [st.header_name]: secret };
    return {};
  }

  async refreshSecrets(): Promise<void> {
    const { rows } = await this.pg.query('SELECT server_id, enc_secret FROM server_credentials');
    this.secrets.clear();
    for (const r of rows as Array<{ server_id: string; enc_secret: string }>) {
      try {
        this.secrets.set(r.server_id, decryptSecret(r.enc_secret, this.credKey));
      } catch {
        // corrupt entry: leave absent; calls fail closed with a clear error
      }
    }
  }

  /** One tool call on a fresh client (D6). Retries once on dropped session. */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const st = this.states.get(serverId);
    if (!st) throw Object.assign(new Error('unknown server'), { status: 404 });
    if (!st.enabled || st.status === 'Disabled') throw Object.assign(new Error('server disabled'), { status: 503 });
    if (st.status === 'Unreachable') throw Object.assign(new Error('server unreachable'), { status: 502 });
    await this.refreshSecrets();
    const attempt = async (): Promise<unknown> => {
      const client = new Client({ name: 'gateway', version: '0.1.0' });
      const ctl = new AbortController();
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, timeoutMs);
      try {
        const transport = new StreamableHTTPClientTransport(new URL(st.url), {
          requestInit: { headers: this.authHeaders(st), signal: ctl.signal },
        });
        await client.connect(transport);
        try {
          return await client.callTool({ name: toolName, arguments: args });
        } finally {
          await client.close().catch(() => {});
        }
      } catch (e) {
        if (timedOut) throw Object.assign(new Error(`upstream timeout after ${timeoutMs}ms`), { status: 504 });
        throw e;
      } finally {
        clearTimeout(t);
      }
    };
    try {
      return await attempt();
    } catch (e) {
      if (isSessionGone(e)) return await attempt(); // re-init once, then throw if still bad
      throw e;
    }
  }
}

const isSessionGone = (e: unknown): boolean =>
  /404|session|not found/i.test((e as Error)?.message ?? '');
