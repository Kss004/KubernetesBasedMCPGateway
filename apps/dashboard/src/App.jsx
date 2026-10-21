// Dashboard shell: session login, role-aware nav. All upstream and model text
// renders as React text nodes (escaped); nothing uses dangerouslySetInnerHTML (R14).
import { useEffect, useState } from 'react';
import { api, guard } from './api.js';
import Servers from './Servers.jsx';
import Team from './Team.jsx';
import Audit from './Audit.jsx';
import Chat from './Chat.jsx';
import Orders from './Orders.jsx';
import { PageHead } from './ui.jsx';

// Harbor wordmark: a line anchor in the accent colour (inline SVG, CSP-safe).
function Brand() {
  return (
    <span className="brand">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="5" r="2.2" />
        <path d="M12 7.2V21M8 11h8M4.5 13.5a7.5 7.5 0 0 0 15 0" />
      </svg>
      Harbor
    </span>
  );
}

const TABS = [
  { id: 'servers', label: 'Servers', adminOnly: true },
  { id: 'orders', label: 'Orders' },
  { id: 'team', label: 'Team & Keys' },
  { id: 'audit', label: 'Audit' },
  { id: 'chat', label: 'Chat' },
];

// Page heading per tab: title + italic accent phrase + lead (lead may depend on the role).
const PAGES = {
  servers: {
    title: 'Every MCP server,',
    accent: 'one gateway.',
    lead: () => 'Upstreams Harbor aggregates. Health is probed every 5 seconds and tools are exposed as slug__tool.',
  },
  orders: {
    title: 'Every order,',
    accent: 'page by page.',
    lead: () => 'Store orders through the woo server, with totals in the store currency. Each page load is one audited woo__list_orders call.',
  },
  team: {
    title: 'Your team and',
    accent: 'their keys.',
    lead: () => 'A key is shown once, then stored only as a SHA-256 hash. Revoking it takes effect on the next call.',
  },
  audit: {
    title: 'Every call,',
    accent: 'on the record.',
    lead: (me) =>
      `Who called which tool, when, and how it went. Arguments and results are never stored. Latest 200${me.role === 'admin' ? ', all users' : ', your calls only'}.`,
  },
  chat: {
    title: 'Talk to your',
    accent: 'store.',
    lead: () => 'The agent uses only the tools you are allowed to call, and every call is audited under your name.',
  },
};

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
  const head = (id) => {
    const p = PAGES[id];
    const i = tabs.findIndex((t) => t.id === id);
    return <PageHead n={i + 1} label={tabs[i].label} title={p.title} accent={p.accent} lead={p.lead(me)} />;
  };
  return (
    <>
      <header>
        <h1>
          <Brand />
        </h1>
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
        {tab !== 'chat' && (
          // key: remount on tab change so the entrance animation replays
          <div className="page" key={tab}>
            {head(tab)}
            {tab === 'servers' && <Servers setStatus={setStatus} />}
            {tab === 'orders' && <Orders setStatus={setStatus} />}
            {tab === 'team' && <Team me={me} setStatus={setStatus} />}
            {tab === 'audit' && <Audit me={me} setStatus={setStatus} />}
          </div>
        )}
        {/* Chat stays mounted so history survives tab switches. */}
        <div className="page" hidden={tab !== 'chat'}>
          {head('chat')}
          <Chat me={me} />
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
        <h1>
          <Brand />
        </h1>
        <p className="muted">
          One gateway for every <em>MCP server</em> your team uses.
        </p>
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
