// Audit log: admins see every user, members only their own rows (enforced server-side).
import { useCallback, useEffect, useState } from 'react';
import { api, guard } from './api.js';

export default function Audit({ me, setStatus }) {
  const [rows, setRows] = useState(null); // null = not loaded yet (E2E N7: no empty-state flash)
  const [user, setUser] = useState('');

  const load = useCallback(async () => setRows((await api('/api/audit')).audit), []);
  useEffect(() => {
    guard(setStatus, load)();
  }, [load, setStatus]);

  const users = [...new Set((rows ?? []).map((r) => r.user_name).filter(Boolean))].sort();
  const shown = user ? (rows ?? []).filter((r) => r.user_name === user) : rows ?? [];

  return (
    <section>
      <div className="row">
        <button onClick={guard(setStatus, load)}>Refresh</button>
        {me.role === 'admin' && (
          <label>
            User
            <select value={user} onChange={(e) => setUser(e.target.value)}>
              <option value="">all</option>
              {users.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Server</th>
            <th>Tool</th>
            <th>Outcome</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.created_at).toLocaleString()}</td>
              <td>{a.user_name || '—'}</td>
              <td>{a.server_slug || '—'}</td>
              <td className="mono">{a.tool}</td>
              <td>
                <span className={`pill out-${a.outcome}`}>{a.outcome}</span>
                {a.error_class && <span className="muted"> {a.error_class}</span>}
              </td>
              <td>{a.duration_ms} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows === null && <p className="muted">Loading…</p>}
      {rows !== null && shown.length === 0 && <p className="muted">No calls yet.</p>}
    </section>
  );
}
