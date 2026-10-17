// Admin: registered upstreams with live status and tools; add, edit, disable, remove.
// Secrets are write-only: the API returns only has_secret, never the value.
import { useCallback, useEffect, useState } from 'react';
import { api, guard } from './api.js';

const EMPTY = { slug: '', url: '', auth_type: 'none', header_name: '', secret: '' };

export default function Servers({ setStatus }) {
  const [servers, setServers] = useState([]);
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

  return (
    <section>
      <h2>MCP servers</h2>
      <table>
        <thead>
          <tr>
            <th>Server</th>
            <th>Status</th>
            <th>Tools</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => {
            const st = s.enabled ? health[s.id] ?? 'Unreachable' : 'Disabled';
            return (
              <tr key={s.id}>
                <td>
                  <strong>{s.slug}</strong>
                  <div className="muted mono">{s.url}</div>
                  <div className="muted">
                    auth: {s.auth_type}
                    {s.header_name ? ` (${s.header_name})` : ''}
                    {s.has_secret ? ', secret set' : ''}
                  </div>
                  {editing === s.id && <EditForm s={s} onSave={(body) => patch(s.id, body)()} onCancel={() => setEditing(null)} />}
                </td>
                <td>
                  <span className={`pill st-${st}`}>{st}</span>
                </td>
                <td>
                  {(tools[s.id] ?? []).map((t) => (
                    <div key={t.name} className={t.changed ? 'changed mono' : 'mono'} title={t.description}>
                      {t.name}
                      {t.changed ? ' [description changed]' : ''}
                    </div>
                  ))}
                </td>
                <td className="actions">
                  <button onClick={() => setEditing(editing === s.id ? null : s.id)}>Edit</button>
                  <button onClick={patch(s.id, { enabled: !s.enabled })}>{s.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="danger" onClick={remove(s)}>
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {servers.length === 0 && <p className="muted">No servers registered.</p>}

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
        <input value={form.url} onChange={set('url')} placeholder="http://svc.urumi-upstreams:3000/mcp" required />
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
