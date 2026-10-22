// Multi-store: create and delete stores. The gateway records the request; the provisioner pod
// installs each store in its own namespace and registers its MCP server (store-<name>__*).
import { useCallback, useEffect, useState } from 'react';
import { api, guard } from './api.js';

const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

export default function Stores({ me, setStatus }) {
  const [data, setData] = useState(null); // null = loading
  const [name, setName] = useState('');

  const load = useCallback(async () => setData(await api('/api/stores')), []);

  useEffect(() => {
    guard(setStatus, load)();
    const t = setInterval(() => load().catch(() => {}), 5000); // status moves on its own
    return () => clearInterval(t);
  }, [load, setStatus]);

  const create = guard(setStatus, async (e) => {
    e.preventDefault();
    await api('/api/stores', { method: 'POST', body: { name } });
    setName('');
    setStatus(`Store "${name}" is being created. It takes a few minutes.`);
    await load();
  });

  const remove = (s) =>
    guard(setStatus, async () => {
      if (!window.confirm(`Delete store "${s.name}"? Its database, files and tools are removed for good.`)) return;
      await api(`/api/stores/${s.id}`, { method: 'DELETE' });
      await load();
    });

  if (data === null) return <p className="muted">Loading…</p>;
  if (!data.enabled) return <p className="muted">Store provisioning is not enabled on this deployment.</p>;
  const stores = data.stores;
  const mine = stores.filter((s) => s.owner_id === me.id).length;

  return (
    <section>
      <form className="row" onSubmit={create}>
        <label className="grow">
          New store name
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="e.g. alpha"
            pattern="[a-z][a-z0-9\-]{1,18}[a-z0-9]"
            title="3-20 lowercase letters, digits or dashes, starting with a letter"
            required
          />
        </label>
        <button type="submit" className="primary" disabled={mine >= data.limits.perUser}>
          Create store
        </button>
      </form>
      <p className="muted small">
        You have {mine} of {data.limits.perUser} stores. Each one gets its own namespace, database, volumes and HTTPS
        address, and its tools appear as <span className="mono">store-&lt;name&gt;__*</span>. Creation times out after{' '}
        {data.limits.timeoutMin} minutes.
      </p>

      <table>
        <thead>
          <tr>
            <th>Store</th>
            <th>Status</th>
            <th>Address</th>
            {me.role === 'admin' && <th>Owner</th>}
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {stores.map((s) => (
            <tr key={s.id}>
              <td className="mono">{s.name}</td>
              <td>
                <span className={`pill store-${s.status}`}>{s.status}</span>
                {s.step && s.status !== 'Ready' && <span className="muted small"> · {s.step}</span>}
                {s.reason && <div className="store-reason">{s.reason}</div>}
              </td>
              <td>
                {s.url && s.status === 'Ready' ? (
                  <a href={`${s.url}/shop`} target="_blank" rel="noreferrer">
                    {s.url.replace(/^https?:\/\//, '')}
                  </a>
                ) : (
                  '—'
                )}
              </td>
              {me.role === 'admin' && <td>{s.owner_name ?? '—'}</td>}
              <td>{ago(s.created_at)}</td>
              <td className="actions">
                {s.status !== 'Deleting' && (
                  <button className="danger" onClick={remove(s)}>
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {stores.length === 0 && <p className="muted">No stores yet.</p>}
    </section>
  );
}
