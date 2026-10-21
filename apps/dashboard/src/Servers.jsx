// Admin: registered upstreams with live status and tools; add, edit, disable, remove.
// Secrets are write-only: the API returns only has_secret, never the value.
import { useCallback, useEffect, useState } from 'react';
import { api, guard } from './api.js';

const EMPTY = { slug: '', url: '', auth_type: 'none', header_name: '', secret: '' };

export default function Servers({ setStatus }) {
  const [servers, setServers] = useState(null); // null = not loaded yet (no empty-state flash)
  const [health, setHealth] = useState({});
  const [tools, setTools] = useState({});
  const [editing, setEditing] = useState(null); // server id
  const [form, setForm] = useState(EMPTY);

  const load = useCallback(async () => {
    const [{ servers }, { upstreams }, { tools }] = await Promise.all([
      api('/api/servers'),
      api('/api/upstreams'),
      api('/api/tools'),
    ]);
    setServers(servers);
    setHealth(Object.fromEntries(upstreams.map((u) => [u.id, u.status])));
    const by = {};
    for (const t of tools) (by[t.serverId] ??= []).push(t);
    setTools(by);
  }, []);

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
  const stateOf = (s) => (s.enabled ? health[s.id] ?? 'Unreachable' : 'Disabled');
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
        <p className="mcp-label">Registered servers</p>
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
    </section>
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
