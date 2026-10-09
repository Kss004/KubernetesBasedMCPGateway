// make seed worker: runs INSIDE the gateway pod (kubectl exec), so no
// port-forward is needed. Creates the woo row or updates url+secret.
const ADMIN = process.env.ADMIN ?? '';
const TOKEN = process.env.TOKEN ?? '';
const URL = process.env.WOO_URL ?? '';
const BASE = 'http://localhost:3000';
const H = { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' };

const list = await (await fetch(`${BASE}/api/servers`, { headers: H })).json();
const existing = list.servers.find((s) => s.slug === 'woo');
if (!existing) {
  const r = await fetch(`${BASE}/api/servers`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ slug: 'woo', url: URL, auth_type: 'bearer', secret: TOKEN }),
  });
  if (!r.ok) throw new Error(`seed POST ${r.status}: ${await r.text()}`);
  console.log('seeded woo');
} else {
  const r = await fetch(`${BASE}/api/servers/${existing.id}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ url: URL, secret: TOKEN }),
  });
  if (!r.ok) throw new Error(`seed PATCH ${r.status}: ${await r.text()}`);
  console.log('updated woo');
}
