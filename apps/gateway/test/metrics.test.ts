// Observability: per-server metrics, Prometheus text, and why an upstream is Unreachable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { prometheusText, serverMetrics } from '../src/metrics.ts';
import { describeFailure, UpstreamPool } from '../src/pool.ts';
import { testTrustedHosts } from '../src/egress.ts';

describe('serverMetrics', () => {
  it('maps the two audit queries into per-server numbers; denials do not count as errors', async () => {
    const pg = {
      query: async (sql: string) =>
        sql.includes('percentile_cont')
          ? { rows: [{ server: 'woo', calls: 10, ok: 6, errors: 2, denied: 2, p50: 40.4, p95: 910.6, max_ms: 1200, last_call: '2026-10-22T10:00:00Z' }] }
          : { rows: [{ server: 'woo', error_class: 'timeout', n: 1 }, { server: 'woo', error_class: 'tool_error', n: 1 }] },
    };
    const [m] = await serverMetrics(pg as never, '24h');
    assert.deepEqual(m, {
      server: 'woo', calls: 10, ok: 6, errors: 2, denied: 2, error_rate: 0.25,
      p50_ms: 40, p95_ms: 911, max_ms: 1200, last_call: '2026-10-22T10:00:00.000Z',
      error_classes: { timeout: 1, tool_error: 1 },
    });
  });
  it('a server with only denied calls has a 0 error rate and no latency', async () => {
    const pg = { query: async (sql: string) => ({ rows: sql.includes('percentile_cont') ? [{ server: 'mock', calls: 3, ok: 0, errors: 0, denied: 3, p50: null, p95: null, max_ms: null, last_call: null }] : [] }) };
    const [m] = await serverMetrics(pg as never, '1h');
    assert.equal(m.error_rate, 0);
    assert.equal(m.p50_ms, null);
  });
});

describe('prometheusText', () => {
  it('emits gauges with escaped labels and skips missing values', () => {
    const text = prometheusText(
      [{ server: 'woo', calls: 3, ok: 2, errors: 1, denied: 0, error_rate: 0.3333, p50_ms: 40, p95_ms: null, max_ms: 50, last_call: null, error_classes: {} }],
      [{ id: '1', slug: 'we"ird', url: '', auth_type: 'none', header_name: null, enabled: true, status: 'Unreachable', reason: 'x', since: '' }],
    );
    assert.match(text, /# TYPE harbor_upstream_up gauge/);
    assert.match(text, /harbor_upstream_up\{server="we\\"ird",status="Unreachable"\} 0/);
    assert.match(text, /harbor_tool_calls_1h\{server="woo",outcome="error"\} 1/);
    assert.match(text, /harbor_tool_latency_ms_1h\{server="woo",quantile="0.5"\} 40/);
    assert.ok(!text.includes('quantile="0.95"'));
  });
});

describe('describeFailure', () => {
  it('turns transport errors into short reasons', () => {
    const wrapped = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
    assert.equal(describeFailure(wrapped('ECONNREFUSED')), 'connection refused (nothing listening)');
    assert.equal(describeFailure(wrapped('ENOTFOUND')), 'host name does not resolve');
    assert.equal(describeFailure(wrapped('EBLOCKED')), 'blocked by the SSRF guard (private or reserved address)');
    assert.equal(describeFailure(new StreamableHTTPError(401, 'nope')), 'upstream rejected the credential (HTTP 401)');
    assert.equal(describeFailure(new StreamableHTTPError(502, 'bad gateway')), 'upstream answered HTTP 502');
    assert.equal(describeFailure(new Error('x'.repeat(300))).length, 160);
  });
});

describe('UpstreamPool records why a server is Unreachable', () => {
  it('a closed port gives "connection refused" and a since timestamp', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r())); // now nothing listens there
    testTrustedHosts.add(`127.0.0.1:${port}`);
    const row = { id: 's1', slug: 'dead', url: `http://127.0.0.1:${port}/mcp`, auth_type: 'none', header_name: null, enabled: true };
    const pg = { query: async (sql: string) => ({ rows: sql.startsWith('SELECT server_id') ? [] : [row] }) };
    const pool = new UpstreamPool(pg as never, Buffer.alloc(32), 5000, 1000);
    await pool.refreshNow();
    await pool.refreshNow(); // 2 failures -> Unreachable
    const [s] = pool.getStates();
    assert.equal(s.status, 'Unreachable');
    assert.equal(s.reason, 'connection refused (nothing listening)');
    assert.ok(!Number.isNaN(Date.parse(s.since)));
  });
});
