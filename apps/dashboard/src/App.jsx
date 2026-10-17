// Dashboard shell: session login, role-aware nav. All upstream and model text
// renders as React text nodes (escaped); nothing uses dangerouslySetInnerHTML (R14).
import { useEffect, useState } from 'react';
import { api, guard } from './api.js';
import Servers from './Servers.jsx';
import Team from './Team.jsx';
import Audit from './Audit.jsx';
import Chat from './Chat.jsx';

const TABS = [
  { id: 'servers', label: 'Servers', adminOnly: true },
  { id: 'team', label: 'Team & Keys' },
  { id: 'audit', label: 'Audit' },
  { id: 'chat', label: 'Chat' },
];

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = logged out
  const [tab, setTab] = useState('chat');
  const [status, setStatus] = useState('');

  useEffect(() => {
    api('/api/me')
      .then((u) => {
        setMe(u);
        setTab(u.role === 'admin' ? 'servers' : 'chat');
      })
      .catch(() => setMe(null));
  }, []);

  const logout = guard(setStatus, async () => {
    await api('/api/logout', { method: 'POST', body: {} });
    setMe(null);
  });

  if (me === undefined) return <main className="center">Loading…</main>;
  if (me === null)
    return (
      <Login
        onLogin={(u) => {
          setMe(u);
          setTab(u.role === 'admin' ? 'servers' : 'chat');
        }}
      />
    );

  const tabs = TABS.filter((t) => !t.adminOnly || me.role === 'admin');
  return (
    <>
      <header>
        <h1>Urumi Gateway</h1>
        <nav>
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="who">
          {me.name} <span className="pill">{me.role}</span>
          <button onClick={logout}>Logout</button>
        </div>
      </header>
      <main>
        {status && (
          <p className="status" role="status">
            {status}
          </p>
        )}
        {tab === 'servers' && <Servers setStatus={setStatus} />}
        {tab === 'team' && <Team me={me} setStatus={setStatus} />}
        {tab === 'audit' && <Audit me={me} setStatus={setStatus} />}
        {/* Chat stays mounted so history survives tab switches. */}
        <div hidden={tab !== 'chat'}>
          <Chat />
        </div>
      </main>
    </>
  );
}

function Login({ onLogin }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      onLogin(await api('/api/login', { method: 'POST', body: { name, password } }));
    } catch (err) {
      setError(`Login failed: ${err.message}`);
      setPassword('');
    }
  };
  return (
    <main className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Urumi Gateway</h1>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="status">{error}</p>}
        <button type="submit" className="primary">
          Log in
        </button>
      </form>
    </main>
  );
}
