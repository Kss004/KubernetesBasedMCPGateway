// Per-server metrics (observability), computed from the audit table: it already records every
// call with server, outcome, error class and duration, so there is nothing new on the request path.
// Served as JSON for the dashboard and in Prometheus text format for a scraper.
import type { Pool } from 'pg';
import type { UpstreamState } from './pool.js';

export const WINDOWS = { '1h': 60, '24h': 1440, '7d': 10080 } as const;
export type WindowName = keyof typeof WINDOWS;

export interface ServerMetrics {
  server: string;
  calls: number;
  ok: number;
  errors: number;
  denied: number;
  /** errors / (ok + errors): denied calls never reached the upstream, so they do not count. */
  error_rate: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  last_call: string | null;
  /** error_class -> count, e.g. { timeout: 2, server_unreachable: 5 }. */
  error_classes: Record<string, number>;
}

export async function serverMetrics(pool: Pool, window: WindowName): Promise<ServerMetrics[]> {
  const minutes = WINDOWS[window];
  // Latency percentiles cover calls that reached the upstream (ok or error), not denials.
  const { rows } = await pool.query(
    `SELECT server_slug AS server,
            count(*)::int AS calls,
            count(*) FILTER (WHERE outcome = 'ok')::int AS ok,
            count(*) FILTER (WHERE outcome = 'error')::int AS errors,
            count(*) FILTER (WHERE outcome = 'denied')::int AS denied,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE outcome <> 'denied') AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE outcome <> 'denied') AS p95,
            max(duration_ms) FILTER (WHERE outcome <> 'denied') AS max_ms,
            max(created_at) AS last_call
     FROM audit
     WHERE created_at > now() - make_interval(mins => $1) AND server_slug <> ''
     GROUP BY server_slug
     ORDER BY server_slug`,
    [minutes],
  );
  const { rows: classes } = await pool.query(
    `SELECT server_slug AS server, error_class, count(*)::int AS n
     FROM audit
     WHERE created_at > now() - make_interval(mins => $1) AND server_slug <> '' AND outcome = 'error'
     GROUP BY server_slug, error_class`,
    [minutes],
  );
  const byServer = new Map<string, Record<string, number>>();
  for (const c of classes as Array<{ server: string; error_class: string | null; n: number }>) {
    const m = byServer.get(c.server) ?? {};
    m[c.error_class ?? 'unknown'] = c.n;
    byServer.set(c.server, m);
  }
  const ms = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));
  return (rows as Array<Record<string, unknown>>).map((r) => {
    const ok = Number(r.ok);
    const errors = Number(r.errors);
    return {
      server: String(r.server),
      calls: Number(r.calls),
      ok,
      errors,
      denied: Number(r.denied),
      error_rate: ok + errors === 0 ? 0 : +(errors / (ok + errors)).toFixed(4),
      p50_ms: ms(r.p50),
      p95_ms: ms(r.p95),
      max_ms: ms(r.max_ms),
      last_call: r.last_call ? new Date(r.last_call as string).toISOString() : null,
      error_classes: byServer.get(String(r.server)) ?? {},
    };
  });
}

const label = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** Prometheus text exposition: gauges over the last hour, plus live upstream status. */
export function prometheusText(metrics: ServerMetrics[], states: UpstreamState[]): string {
  const out: string[] = [];
  const gauge = (name: string, help: string, rows: Array<[Record<string, string>, number | null]>) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, v] of rows) {
      if (v === null) continue;
      const l = Object.entries(labels)
        .map(([k, x]) => `${k}="${label(x)}"`)
        .join(',');
      out.push(`${name}{${l}} ${v}`);
    }
  };
  gauge('harbor_upstream_up', 'Upstream health: 1 Connected, 0 Unreachable or Disabled.', states.map((s) => [{ server: s.slug, status: s.status }, s.status === 'Connected' ? 1 : 0]));
  gauge('harbor_tool_calls_1h', 'Tool calls in the last hour, by outcome.', metrics.flatMap((m) => [
    [{ server: m.server, outcome: 'ok' }, m.ok] as [Record<string, string>, number],
    [{ server: m.server, outcome: 'error' }, m.errors] as [Record<string, string>, number],
    [{ server: m.server, outcome: 'denied' }, m.denied] as [Record<string, string>, number],
  ]));
  gauge('harbor_tool_error_rate_1h', 'Errors / (ok + errors) in the last hour.', metrics.map((m) => [{ server: m.server }, m.error_rate]));
  gauge('harbor_tool_latency_ms_1h', 'Tool call latency in the last hour, by quantile.', metrics.flatMap((m) => [
    [{ server: m.server, quantile: '0.5' }, m.p50_ms] as [Record<string, string>, number | null],
    [{ server: m.server, quantile: '0.95' }, m.p95_ms] as [Record<string, string>, number | null],
  ]));
  return out.join('\n') + '\n';
}
