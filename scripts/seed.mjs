// make seed worker: runs INSIDE the gateway pod (kubectl exec), so no
// port-forward is needed. Registers the three in-cluster upstreams and, when the cluster has
// internet, DeepWiki (a public hosted MCP server we did not write). Idempotent: creates a missing
// row, or updates url (+secret) on an existing one.
const ADMIN = process.env.ADMIN ?? '';
const TOKEN = process.env.TOKEN ?? '';
const BASE = 'http://localhost:3000';
const H = { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' };

const servers = [
  { slug: 'woo', url: process.env.WOO_URL ?? '', auth_type: 'bearer', secret: TOKEN },
  { slug: 'mock', url: process.env.MOCK_URL ?? '', auth_type: 'none' },
  { slug: 'everything', url: process.env.EVERYTHING_URL ?? '', auth_type: 'none' },
  // Optional: an empty DEEPWIKI_URL skips it; a failure (offline cluster) only warns.
  { slug: 'deepwiki', url: process.env.DEEPWIKI_URL ?? '', auth_type: 'none', optional: true },
];

if (!ADMIN || !TOKEN) throw new Error('seed: admin token or woo token missing (Secret not found?)');
const res = await fetch(`${BASE}/api/servers`, { headers: H });
if (!res.ok) throw new Error(`seed list ${res.status}: ${await res.text()}`);
const list = await res.json();
for (const { optional, ...s } of servers) {
  if (optional && !s.url) {
    console.log(`skipped ${s.slug} (no url)`);
    continue;
  }
  const existing = list.servers.find((x) => x.slug === s.slug);
  const patch = s.secret ? { url: s.url, secret: s.secret } : { url: s.url };
  const r = existing
    ? await fetch(`${BASE}/api/servers/${existing.id}`, { method: 'PATCH', headers: H, body: JSON.stringify(patch) })
    : await fetch(`${BASE}/api/servers`, { method: 'POST', headers: H, body: JSON.stringify(s) });
  if (!r.ok && optional) {
    console.log(`skipped ${s.slug} ${r.status}: ${await r.text()}`);
    continue;
  }
  if (!r.ok) throw new Error(`seed ${s.slug} ${r.status}: ${await r.text()}`);
  console.log(`${existing ? 'updated' : 'seeded'} ${s.slug}`);
}
