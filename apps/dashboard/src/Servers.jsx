// Admin: registered upstreams with live status and tools; add, edit, disable, remove.
// Secrets are write-only: the API returns only has_secret, never the value.
import { useCallback, useEffect, useState } from 'react';
import { api, guard } from './api.js';

const EMPTY = { slug: '', url: '', auth_type: 'none', header_name: '', secret: '' };
const WINDOWS = ['1h', '24h', '7d'];

const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};
const pct = (r) => `${(r * 100).toFixed(r && r < 0.1 ? 1 : 0)}%`;

export default function Servers({ setStatus }) {
  const [servers, setServers] = useState(null); // null = not loaded yet (no empty-state flash)
  const [health, setHealth] = useState({}); // server id -> { status, reason, since }
  const [metrics, setMetrics] = useState({}); // slug -> per-server metrics
  const [win, setWin] = useState('24h');
  const [tools, setTools] = useState({});
  const [editing, setEditing] = useState(null); // server id
  const [form, setForm] = useState(EMPTY);

  const load = useCallback(async () => {
    const [{ servers }, { upstreams }, { tools }, m] = await Promise.all([
      api('/api/servers'),
      api('/api/upstreams'),
      api('/api/tools'),
      api(`/api/metrics?window=${win}`),
    ]);
    setServers(servers);
    setHealth(Object.fromEntries(upstreams.map((u) => [u.id, u])));
    setMetrics(Object.fromEntries(m.servers.map((x) => [x.server, x])));
    const by = {};
    for (const t of tools) (by[t.serverId] ??= []).push(t);
    setTools(by);
  }, [win]);

  useEffect(() => {
    guard(setStatus, load)();
    const t = setInterval(() => load().catch(() => {}), 5000); // health changes every probe
    return () => clearInterval(t);
  }, [load, setStatus]);

  const patch = (id, body) => guard(setStatus, async () => {
    await api(`/api/servers/${id}`, { method: 'PATCH', body });
    setEditing(null);
    await load();
  });

  const remove = (s) => guard(setStatus, async () => {
    if (!window.confirm(`Remove server "${s.slug}"? Its tools disappear for everyone.`)) return;
    await api(`/api/servers/${s.id}`, { method: 'DELETE' });
    await load();
  });

  const add = guard(setStatus, async (e) => {
    e.preventDefault();
    const body = { slug: form.slug, url: form.url, auth_type: form.auth_type };
    if (form.header_name) body.header_name = form.header_name;
    if (form.secret) body.secret = form.secret;
    await api('/api/servers', { method: 'POST', body });
    setForm(EMPTY);
    await load();
  });

  const list = servers ?? [];
  const stateOf = (s) => (s.enabled ? health[s.id]?.status ?? 'Unreachable' : 'Disabled');
  const live = list.filter((s) => stateOf(s) === 'Connected').length;
  const toolCount = Object.values(tools).reduce((n, ts) => n + ts.length, 0);

  return (
    <section>
      <div className="mcp-card">
        <div className="mcp-head">
          <span>
            <span className="accent">→</span> harbor · mcp
          </span>
          <span className="mcp-live">
            <span className={live ? 'dot-live' : 'dot-off'} aria-hidden="true" />
            {live}/{list.length} live
          </span>
        </div>
        <p className="mcp-label">
          Registered servers
          <span className="win-pick">
            {WINDOWS.map((w) => (
              <button key={w} className={w === win ? 'on' : ''} onClick={() => setWin(w)}>
                {w}
              </button>
            ))}
          </span>
        </p>
        {servers === null && <p className="muted">Loading…</p>}
        {servers?.length === 0 && <p className="muted">No servers registered.</p>}
        <ul className="mcp-rows">
          {list.map((s) => {
            const st = stateOf(s);
            return (
              <li key={s.id} className={`mcp-row is-${st}`}>
                <div className="mcp-main">
                  <span className="glyph" aria-hidden="true">
                    {st === 'Connected' ? '◆' : '○'}
                  </span>
                  <div className="mcp-id">
                    <span className="name">{s.slug}</span>
                    <span className="url">{s.url}</span>
                    <span className="meta">
                      auth: {s.auth_type}
                      {s.header_name ? ` (${s.header_name})` : ''}
                      {s.has_secret ? ', secret set' : ''}
                    </span>
                  </div>
                  <span className={`state st-${st}`}>{st}</span>
                </div>
                {st === 'Unreachable' && health[s.id] && (
                  <p className="mcp-reason">
                    {health[s.id].reason ?? 'checking…'}
                    {health[s.id].since ? ` · for ${ago(health[s.id].since)}` : ''}
                  </p>
                )}
                <Stats m={metrics[s.slug]} win={win} />
                <div className="mcp-tools">
                  {(tools[s.id] ?? []).map((t) => (
                    <span key={t.name} className={t.changed ? 'chip changed' : 'chip'} title={t.description}>
                      {t.name}
                      {t.changed ? ' · description changed' : ''}
                    </span>
                  ))}
                </div>
                <div className="actions">
                  <button onClick={() => setEditing(editing === s.id ? null : s.id)}>Edit</button>
                  <button onClick={patch(s.id, { enabled: !s.enabled })}>{s.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="danger" onClick={remove(s)}>
                    Remove
                  </button>
                </div>
                {editing === s.id && <EditForm s={s} onSave={(body) => patch(s.id, body)()} onCancel={() => setEditing(null)} />}
              </li>
            );
          })}
        </ul>
        <p className="mcp-foot">
          {toolCount} tools · named slug__tool · credentials are write-only and never reach a client
        </p>
      </div>

      <h3>Add server</h3>
      <form className="row" onSubmit={add}>
        <AuthFields form={form} setForm={setForm} withSlug />
        <button type="submit" className="primary">
          Add
        </button>
      </form>

      <Hosted setStatus={setStatus} onChange={load} />
    </section>
  );
}

// Hosted MCP servers: deployed into the cluster from a container image by the provisioner.
const HOSTED_EMPTY = { slug: '', image: '', port: '3000', path: '/mcp', env: '' };

function Hosted({ setStatus, onChange }) {
  const [data, setData] = useState(null);
  const [f, setF] = useState(HOSTED_EMPTY);
  const load = useCallback(async () => setData(await api('/api/hosted')), []);
  useEffect(() => {
    guard(setStatus, load)();
    const t = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [load, setStatus]);

  const add = guard(setStatus, async (e) => {
    e.preventDefault();
    // KEY=value per line; values are stored encrypted and only ever reach the server's Secret.
    const env = Object.fromEntries(
      f.env
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    await api('/api/hosted', { method: 'POST', body: { slug: f.slug, image: f.image, port: Number(f.port), path: f.path, env } });
    setF(HOSTED_EMPTY);
    setStatus(`Deploying ${f.slug}. It appears above once its pod is ready.`);
    await load();
  });
  const remove = (h) =>
    guard(setStatus, async () => {
      if (!window.confirm(`Remove hosted server "${h.slug}"? Its pod and tools are removed.`)) return;
      await api(`/api/hosted/${h.id}`, { method: 'DELETE' });
      await load();
      await onChange();
    });

  if (!data?.enabled) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <h3>Deploy a server from an image</h3>
      <p className="muted small">
        The platform runs it in <span className="mono">urumi-hosted</span>: no Kubernetes token, non-root, read-only
        filesystem, resource limits, and only the gateway may connect. Allowed images:{' '}
        <span className="mono">{data.limits.imagePrefixes.join(', ')}</span>
      </p>
      <form className="row" onSubmit={add}>
        <label>
          Slug
          <input value={f.slug} onChange={set('slug')} placeholder="hosted-demo" pattern="[a-z][a-z0-9\-]{1,30}[a-z0-9]" required />
        </label>
        <label className="grow">
          Image
          <input value={f.image} onChange={set('image')} placeholder={`${data.limits.imagePrefixes[0] ?? ''}…:tag`} required />
        </label>
        <label>
          Port
          <input value={f.port} onChange={set('port')} type="number" min="1024" max="65535" required />
        </label>
        <label>
          Path
          <input value={f.path} onChange={set('path')} required />
        </label>
        <label className="grow">
          Env (KEY=value per line, optional)
          <textarea value={f.env} onChange={set('env')} rows={1} autoComplete="off" />
        </label>
        <button type="submit" className="primary">
          Deploy
        </button>
      </form>
      {data.hosted.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Slug</th>
              <th>Image</th>
              <th>Status</th>
              <th>Env</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.hosted.map((h) => (
              <tr key={h.id}>
                <td className="mono">{h.slug}</td>
                <td className="mono">{h.image}</td>
                <td>
                  <span className={`pill store-${h.status === 'Deploying' ? 'Provisioning' : h.status === 'Removing' ? 'Deleting' : h.status}`}>
                    {h.status}
                  </span>
                  {h.step && h.status !== 'Ready' && <span className="muted small"> · {h.step}</span>}
                  {h.reason && <div className="store-reason">{h.reason}</div>}
                </td>
                <td className="mono">{h.env_names.join(', ') || '—'}</td>
                <td className="actions">
                  {h.status !== 'Removing' && (
                    <button className="danger" onClick={remove(h)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Stats({ m, win }) {
  if (!m) return <p className="mcp-stats muted">no calls in the last {win}</p>;
  const reached = m.ok + m.errors;
  const classes = Object.entries(m.error_classes)
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ');
  return (
    <p className="mcp-stats">
      <strong>{m.calls}</strong> calls · <span className={m.error_rate > 0.05 ? 'bad' : ''}>{pct(m.error_rate)} errors</span>
      {m.denied ? ` · ${m.denied} denied` : ''}
      {reached ? ` · p50 ${m.p50_ms}ms · p95 ${m.p95_ms}ms` : ''}
      {m.last_call ? ` · last ${ago(m.last_call)} ago` : ''}
      {classes ? <span className="muted"> · {classes}</span> : null}
    </p>
  );
}

function EditForm({ s, onSave, onCancel }) {
  const [form, setForm] = useState({ url: s.url, auth_type: s.auth_type, header_name: s.header_name ?? '', secret: '' });
  const submit = (e) => {
    e.preventDefault();
    const body = { url: form.url, auth_type: form.auth_type, header_name: form.header_name || null };
    if (form.auth_type === 'none') body.secret = null; // drop any stored credential
    else if (form.secret) body.secret = form.secret; // blank keeps the current secret
    onSave(body);
  };
  return (
    <form className="row edit" onSubmit={submit}>
      <AuthFields form={form} setForm={setForm} secretHint="blank keeps current" />
      <button type="submit" className="primary">
        Save
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function AuthFields({ form, setForm, withSlug, secretHint = 'required unless none' }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      {withSlug && (
        <label>
          Slug
          <input value={form.slug} onChange={set('slug')} placeholder="woo" pattern="[a-z0-9-]{1,32}" required />
        </label>
      )}
      <label className="grow">
        URL
        <input value={form.url} onChange={set('url')} placeholder="http://svc.urumi-upstreams:3000/mcp or https://mcp.example.com/mcp" required />
      </label>
      <label>
        Auth
        <select value={form.auth_type} onChange={set('auth_type')}>
          <option value="none">none</option>
          <option value="bearer">bearer token</option>
          <option value="header">custom header</option>
        </select>
      </label>
      {form.auth_type === 'header' && (
        <label>
          Header
          <input value={form.header_name} onChange={set('header_name')} placeholder="X-API-Key" required />
        </label>
      )}
      {form.auth_type !== 'none' && (
        <label>
          Secret
          <input type="password" value={form.secret} onChange={set('secret')} placeholder={secretHint} autoComplete="off" />
        </label>
      )}
    </>
  );
}
