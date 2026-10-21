// T11.2 SSRF guard: blocked ranges, URL shapes, admission DNS check, connect-time check.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { checkUrl, classifyUrl, guardedLookup, isBlockedIp, upstreamTransport } from '../src/egress.ts';
import { validUrl } from '../src/servers.ts';

describe('isBlockedIp', () => {
  it('blocks loopback, private, link-local/metadata, CGNAT, k3s ranges and reserved space', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.5', '10.42.0.9', '10.43.0.10', '172.16.3.4', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fd00::1', 'fc00::abcd', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
      'not-an-ip',
    ])
      assert.equal(isBlockedIp(ip), true, ip);
  });
  it('allows public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '104.18.0.1', '2606:4700::1111', '::ffff:1.1.1.1'])
      assert.equal(isBlockedIp(ip), false, ip);
  });
});

describe('classifyUrl / validUrl', () => {
  it('keeps the in-cluster Services working (http or https)', () => {
    for (const u of [
      'http://store-woo-mcp.urumi-store:3000/mcp',
      'http://upstreams-mock-mcp.urumi-upstreams.svc.cluster.local:3000/mcp',
      'https://x.urumi-upstreams.svc/mcp',
    ])
      assert.equal(classifyUrl(u)?.kind, 'cluster', u);
  });
  it('accepts public https hosts', () => {
    for (const u of ['https://mcp.deepwiki.com/mcp', 'https://api.example.com:8443/mcp'])
      assert.equal(classifyUrl(u)?.kind, 'external', u);
  });
  it('rejects IP literals, internal names, plain http to the outside, and credentials in the URL', () => {
    for (const u of [
      'http://mcp.deepwiki.com/mcp', // external must be https
      'https://169.254.169.254/latest/meta-data', 'https://127.0.0.1/mcp', 'https://2130706433/mcp',
      'https://0x7f000001/mcp', 'https://[::1]/mcp', 'https://[::ffff:10.0.0.1]/mcp',
      'https://localhost/mcp', 'https://a.localhost/mcp', 'https://metadata.google.internal/',
      'https://gateway-postgres.urumi-gateway.svc.cluster.local/', 'https://kubernetes.default.svc/',
      'https://printer.local/', 'https://intranet/', 'https://user:pw@mcp.deepwiki.com/mcp',
      'ftp://mcp.deepwiki.com/', 'not a url',
    ])
      assert.equal(validUrl(u), false, u);
  });
});

describe('checkUrl (admission)', () => {
  const fake = (addrs: string[]) => (async () => addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))) as never;
  it('accepts a public host that resolves to public addresses only', async () => {
    assert.equal(await checkUrl('https://mcp.example.com/mcp', fake(['104.18.0.1', '2606:4700::1'])), null);
  });
  it('rejects a public-looking name that resolves inward (any one address is enough)', async () => {
    assert.match((await checkUrl('https://evil.example.com/mcp', fake(['1.1.1.1', '169.254.169.254']))) ?? '', /private or reserved/);
    assert.match((await checkUrl('https://evil.example.com/mcp', fake(['10.43.0.10']))) ?? '', /private or reserved/);
  });
  it('rejects names that do not resolve, and skips DNS for in-cluster Services', async () => {
    const fail = (async () => {
      throw new Error('ENOTFOUND');
    }) as never;
    assert.match((await checkUrl('https://nope.example.com/mcp', fail)) ?? '', /cannot resolve/);
    assert.equal(await checkUrl('http://store-woo-mcp.urumi-store:3000/mcp', fail), null);
  });
});

describe('connect-time guard (DNS rebinding, stored bad rows)', () => {
  it('guardedLookup refuses a name that resolves to loopback', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => guardedLookup('localhost', {}, (e) => r(e)));
    assert.equal(err?.code, 'EBLOCKED');
  });
  it('a stored row pointing at a private IP cannot connect', async () => {
    const client = new Client({ name: 't', version: '0' });
    await assert.rejects(client.connect(upstreamTransport('http://127.0.0.1:9/mcp', {})), /blocked address/);
  });
});
