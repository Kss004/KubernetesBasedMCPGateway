// Team & keys: every user manages their own keys (/api/me/keys); admins also
// invite users (create + one-time password) and issue or revoke anyone's keys.
import { useCallback, useEffect, useState } from 'react';
import { api, guard } from './api.js';

export default function Team({ me, setStatus }) {
  const isAdmin = me.role === 'admin';
  const [myKeys, setMyKeys] = useState([]);
  const [users, setUsers] = useState([]);
  const [allKeys, setAllKeys] = useState([]);
  const [newKey, setNewKey] = useState('');

  const load = useCallback(async () => {
    setMyKeys((await api('/api/me/keys')).keys);
    if (!isAdmin) return;
    const [{ users }, { keys }] = await Promise.all([api('/api/users'), api('/api/keys')]);
    setUsers(users);
    setAllKeys(keys);
  }, [isAdmin]);

  useEffect(() => {
    guard(setStatus, load)();
  }, [load, setStatus]);

  const run = (fn) => guard(setStatus, async (...a) => {
    await fn(...a);
    await load();
  });

  // Plaintext key exists only in this response; the gateway stores a SHA-256 hash.
  const createMine = run(async () => setNewKey((await api('/api/me/keys', { method: 'POST', body: {} })).key));
  const createFor = (userId) => run(async () => setNewKey((await api('/api/keys', { method: 'POST', body: { user_id: userId } })).key));

  return (
    <section>
      {newKey && (
        <div className="card newkey">
          <strong>New API key — copy it now, it will not be shown again:</strong>
          <code className="mono">{newKey}</code>
          <div className="row">
            <button onClick={() => navigator.clipboard?.writeText(newKey)}>Copy</button>
            <button onClick={() => setNewKey('')}>Done</button>
          </div>
          <p className="muted">
            MCP client: URL <code>{window.location.origin}/mcp</code>, header <code>Authorization: Bearer &lt;key&gt;</code>
          </p>
        </div>
      )}

      <h2>
        My API <em>keys</em>
      </h2>
      <KeyTable keys={myKeys} onRevoke={(k) => run(() => api(`/api/me/keys/${k.id}/revoke`, { method: 'POST', body: {} }))()} />
      <button className="primary" onClick={createMine}>
        Generate my key
      </button>

      {isAdmin && (
        <>
          <h2>Users</h2>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Invite / reset password</th>
                <th>Keys</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <UserRow key={u.id} u={u} setStatus={setStatus} onCreateKey={createFor(u.id)} />
              ))}
            </tbody>
          </table>
          <AddUser onAdd={run((body) => api('/api/users', { method: 'POST', body }))} />

          <h2>
            All <em>keys</em>
          </h2>
          <KeyTable
            keys={allKeys}
            showUser
            onRevoke={(k) => run(() => api(`/api/keys/${k.id}/revoke`, { method: 'POST', body: {} }))()}
          />
        </>
      )}
    </section>
  );
}

function KeyTable({ keys, showUser, onRevoke }) {
  if (keys.length === 0) return <p className="muted">No keys yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          {showUser && <th>User</th>}
          <th>Prefix</th>
          <th>State</th>
          <th>Created</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k.id}>
            {showUser && <td>{k.user_name || k.user_id}</td>}
            <td className="mono">{k.prefix}…</td>
            <td>
              <span className={`pill ${k.revoked ? 'st-Unreachable' : 'st-Connected'}`}>{k.revoked ? 'revoked' : 'active'}</span>
            </td>
            <td>{new Date(k.created_at).toLocaleString()}</td>
            <td>
              {!k.revoked && (
                <button
                  className="danger"
                  onClick={() => window.confirm(`Revoke key ${k.prefix}…? Any client using it stops working at once.`) && onRevoke(k)}
                >
                  Revoke
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UserRow({ u, setStatus, onCreateKey }) {
  const [pw, setPw] = useState('');
  const setPassword = guard(setStatus, async () => {
    await api(`/api/users/${u.id}/password`, { method: 'POST', body: { password: pw } });
    setPw('');
    setStatus(`Password set for ${u.name}. Share it out-of-band; no email is sent.`);
  });
  return (
    <tr>
      <td>{u.name}</td>
      <td>
        <span className="pill">{u.role}</span>
      </td>
      <td className="row">
        <input type="password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="one-time password" autoComplete="new-password" />
        <button onClick={setPassword} disabled={pw.length < 8} title="At least 8 characters">
          Set
        </button>
      </td>
      <td>
        <button onClick={onCreateKey}>Issue key</button>
      </td>
    </tr>
  );
}

function AddUser({ onAdd }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        await onAdd({ name, role });
        setName('');
      }}
    >
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required />
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <button type="submit" className="primary">
        Invite user
      </button>
    </form>
  );
}
