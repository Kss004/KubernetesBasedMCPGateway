// SSRF guard for upstream server URLs (T11.2). Two kinds of upstream are allowed:
// - in-cluster: a Service in urumi-store, urumi-store-<name> (provisioned stores),
//   urumi-upstreams or urumi-hosted, by DNS name (http or https);
// - external: a public https host, e.g. a hosted MCP server.
// External hosts are checked twice: when an admin saves the URL (clear 400), and on every
// connection, where the resolved IP is pinned and re-checked (a name that later points at
// 10.x or 169.254.169.254, i.e. DNS rebinding, fails to connect). Redirects are refused, so an
// allowed host cannot bounce a request inward.
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// urumi-store-<name> are provisioned stores; urumi-hosted holds servers deployed by image.
const CLUSTER_SERVICE = /^[a-z0-9-]+\.(urumi-store(-[a-z0-9-]+)?|urumi-upstreams|urumi-hosted)(\.svc(\.cluster\.local)?)?$/;
// Internal-only name suffixes that must never be treated as public hosts.
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.svc', '.cluster.local', '.home.arpa'];

// Loopback, private, link-local (cloud metadata 169.254.169.254), CGNAT, multicast, reserved
// and documentation ranges. The k3s pod (10.42/16) and Service (10.43/16) ranges sit in 10/8.
const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(a, p, 'ipv6');

/** True for any address an upstream must not resolve to. IPv4-mapped IPv6 is checked as IPv4. */
export function isBlockedIp(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  const family = net.isIP(ip);
  if (family === 0) return true; // not an IP at all: fail closed
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

type Target = { kind: 'cluster' | 'external'; host: string };

/** Shape check, no DNS. Returns where the URL points, or null if it is never allowed. */
export function classifyUrl(raw: string): Target | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost') return null;
  if (CLUSTER_SERVICE.test(host)) return { kind: 'cluster', host };
  // External: https only, a dotted DNS name, never an IP literal or an internal suffix.
  if (u.protocol !== 'https:') return null;
  if (host.includes(':') || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return null; // IP literals
  if (!host.includes('.') || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return null;
  return { kind: 'external', host };
}

/** Admission check: the shape rules, plus every address an external host resolves to. */
export async function checkUrl(raw: string, lookup = dns.promises.lookup): Promise<string | null> {
  const t = classifyUrl(raw);
  if (!t) return 'url must be an in-cluster Service (urumi-store*, urumi-upstreams, urumi-hosted) or a public https host';
  if (t.kind === 'cluster') return null;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(t.host, { all: true });
  } catch {
    return `cannot resolve ${t.host}`;
  }
  if (addrs.length === 0) return `cannot resolve ${t.host}`;
  if (addrs.some((a) => isBlockedIp(a.address))) return `${t.host} resolves to a private or reserved address`;
  return null;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** dns.lookup that refuses blocked addresses; used for every external connection. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '');
    const bad = addrs.find((a) => isBlockedIp(a.address));
    if (bad || addrs.length === 0) {
      return cb(Object.assign(new Error(`blocked address for ${hostname}`), { code: 'EBLOCKED' }), '');
    }
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

const externalAgent = new Agent({ connect: { lookup: guardedLookup as never } });

/** fetch for external upstreams: guarded lookup on every connection, no redirects. */
const externalFetch = (async (url: string | URL, init?: RequestInit) => {
  // A connection to an IP literal skips DNS (and so guardedLookup): check it here.
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedIp(host)) throw new TypeError(`blocked address ${host}`);
  return undiciFetch(url, { ...(init as object), dispatcher: externalAgent, redirect: 'error' } as never);
}) as unknown as typeof fetch;

/** Unit tests only: host:port values treated like in-cluster Services (plain fetch). Nothing in
 *  the app adds to it, so it is always empty in a running gateway. */
export const testTrustedHosts = new Set<string>();

/** MCP transport for one upstream. Anything that is not an in-cluster Service (including a
 *  row that no longer passes classifyUrl) gets the guarded fetch: fail closed. */
export function upstreamTransport(url: string, headers: Record<string, string>): StreamableHTTPClientTransport {
  const cluster = classifyUrl(url)?.kind === 'cluster' || testTrustedHosts.has(new URL(url).host);
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    ...(cluster ? {} : { fetch: externalFetch }),
  });
}
