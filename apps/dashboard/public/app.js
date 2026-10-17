'use strict';
// Minimal dashboard: plain fetch + DOM, no framework. All model/upstream
// text is rendered via textContent only, never innerHTML (R14).
const $ = (id) => document.getElementById(id);
const status = (msg) => { $('status').textContent = msg; };

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON (e.g. SSE stub misuse) */ }
  if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
  return body;
};

const td = (text) => {
  const e = document.createElement('td');
  e.textContent = text ?? '';
  return e;
};
const btn = (label, onClick) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', () => onClick().catch((e) => status(String(e.message || e))));
  return b;
};

let me = null;
const isAdmin = () => me && me.role === 'admin';

function show(id) {
  for (const s of ['login', 'servers', 'team', 'audit', 'chat']) {
    $('sec-' + s).hidden = s !== id;
  }
}

async function boot() {
  $('nav').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      show(b.dataset.sec);
      if (b.dataset.sec === 'servers') loadServers();
      if (b.dataset.sec === 'team') loadTeam();
      if (b.dataset.sec === 'audit') loadAudit();
    }),
  );
  $('login-form').addEventListener('submit', onLogin);
  $('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    me = null;
    renderAuth();
    show('login');
  });
  $('servers-reload').addEventListener('click', () => loadServers().catch((e) => status(String(e.message))));
  $('server-add').addEventListener('submit', onServerAdd);
  $('team-reload').addEventListener('click', () => loadTeam().catch((e) => status(String(e.message))));
  $('user-add').addEventListener('submit', onUserAdd);
  $('key-add').addEventListener('submit', onKeyAdd);
  $('mykey-create').addEventListener('click', () => onMyKeyCreate().catch((e) => status(String(e.message))));
  $('audit-reload').addEventListener('click', () => loadAudit().catch((e) => status(String(e.message))));
  $('chat-form').addEventListener('submit', onChat);
  try {
    me = await api('/api/me');
  } catch {
    me = null;
  }
  renderAuth();
  show(me ? 'servers' : 'login');
  if (me) loadServers().catch((e) => status(String(e.message)));
}

function renderAuth() {
  $('nav').hidden = !me;
  $('who').hidden = !me;
  $('sec-login').hidden = !!me;
  if (me) $('whoami').textContent = me.name + ' (' + me.role + ')';
}

async function onLogin(ev) {
  ev.preventDefault();
  try {
    me = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ name: $('login-name').value, password: $('login-pass').value }),
    });
    $('login-pass').value = '';
    status('');
    renderAuth();
    show('servers');
    await loadServers();
  } catch (e) {
    status('login failed: ' + e.message);
  }
}

// --- Servers: registry rows + pool health + aggregator tools (changed flag). ---
async function loadServers() {
  const tbody = $('servers-table').querySelector('tbody');
  tbody.textContent = '';
  const { servers } = await api('/api/servers');
  const { upstreams } = await api('/api/upstreams');
  let tools = [];
  try {
    tools = (await api('/api/tools')).tools;
  } catch {
    tools = []; // members cannot list tools; servers stay visible to admins only anyway
  }
  const health = new Map(upstreams.map((u) => [u.id, u.status]));
  const byServer = new Map();
  for (const t of tools) {
    if (!byServer.has(t.serverId)) byServer.set(t.serverId, []);
    byServer.get(t.serverId).push(t);
  }
  for (const s of servers) {
    const tr = document.createElement('tr');
    tr.append(td(s.slug));
    const urlCell = document.createElement('td');
    const urlInput = document.createElement('input');
    urlInput.value = s.url;
    urlInput.size = 38;
    urlCell.append(urlInput);
    tr.append(urlCell);
    tr.append(td(health.get(s.id) || '?'));
    tr.append(td(String(s.enabled)));
    const toolsCell = document.createElement('td');
    for (const t of byServer.get(s.id) || []) {
      const d = document.createElement('div');
      d.textContent = t.changed ? t.name + ' [CHANGED]' : t.name;
      if (t.changed) d.className = 'changed';
      d.title = t.description || '';
      toolsCell.append(d);
    }
    tr.append(toolsCell);
    const act = document.createElement('td');
    act.append(btn('Save URL', async () => {
      await api('/api/servers/' + s.id, { method: 'PATCH', body: JSON.stringify({ url: urlInput.value }) });
      status('saved ' + s.slug);
      await loadServers();
    }));
    act.append(btn(s.enabled ? 'Disable' : 'Enable', async () => {
      await api('/api/servers/' + s.id, { method: 'PATCH', body: JSON.stringify({ enabled: !s.enabled }) });
      await loadServers();
    }));
    tr.append(act);
    tbody.append(tr);
  }
  if (servers.length === 0) status('no servers registered');
  else status('');
}

async function onServerAdd(ev) {
  ev.preventDefault();
  const body = { slug: $('add-slug').value, url: $('add-url').value, auth_type: $('add-auth').value };
  if ($('add-header').value) body.header_name = $('add-header').value;
  if ($('add-secret').value) body.secret = $('add-secret').value;
  try {
    await api('/api/servers', { method: 'POST', body: JSON.stringify(body) });
    ev.target.reset();
    status('');
    await loadServers();
  } catch (e) {
    status('add failed: ' + e.message);
  }
}

// --- Team & keys: admin tables plus member self-service /api/me/keys. ---
async function loadTeam() {
  $('admin-team').hidden = !isAdmin();
  const mtbody = $('mykeys-table').querySelector('tbody');
  mtbody.textContent = '';
  const { keys } = await api('/api/me/keys');
  for (const k of keys) {
    const tr = document.createElement('tr');
    tr.append(td(k.prefix), td(String(k.revoked)), td(k.created_at));
    const act = document.createElement('td');
    if (!k.revoked) {
      act.append(btn('Revoke', async () => {
        await api('/api/me/keys/' + k.id + '/revoke', { method: 'POST', body: '{}' });
        await loadTeam();
      }));
    }
    tr.append(act);
    mtbody.append(tr);
  }
  if (!isAdmin()) return;
  const { users } = await api('/api/users');
  const utbody = $('users-table').querySelector('tbody');
  utbody.textContent = '';
  const keyUser = $('key-user');
  keyUser.textContent = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.append(td(u.name), td(u.role));
    const pwCell = document.createElement('td');
    const pw = document.createElement('input');
    pw.type = 'password';
    pw.placeholder = 'one-time password';
    pwCell.append(pw);
    pwCell.append(btn('Set', async () => {
      await api('/api/users/' + u.id + '/password', { method: 'POST', body: JSON.stringify({ password: pw.value }) });
      status('password set for ' + u.name + ' (share it out-of-band; no email is sent)');
    }));
    tr.append(pwCell);
    utbody.append(tr);
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.name + ' (' + u.role + ')';
    keyUser.append(opt);
  }
  const { keys: all } = await api('/api/keys');
  const ktbody = $('keys-table').querySelector('tbody');
  ktbody.textContent = '';
  for (const k of all) {
    const tr = document.createElement('tr');
    tr.append(td(k.user_name || k.user_id), td(k.prefix), td(String(k.revoked)), td(k.created_at));
    const act = document.createElement('td');
    if (!k.revoked) {
      act.append(btn('Revoke', async () => {
        await api('/api/keys/' + k.id + '/revoke', { method: 'POST', body: '{}' });
        await loadTeam();
      }));
    }
    tr.append(act);
    ktbody.append(tr);
  }
}

async function onUserAdd(ev) {
  ev.preventDefault();
  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name: $('user-name').value, role: $('user-role').value }),
    });
    ev.target.reset();
    await loadTeam();
  } catch (e) {
    status('create user failed: ' + e.message);
  }
}

async function onKeyAdd(ev) {
  ev.preventDefault();
  try {
    const out = await api('/api/keys', { method: 'POST', body: JSON.stringify({ user_id: $('key-user').value }) });
    showKeyOnce(out.key);
    await loadTeam();
  } catch (e) {
    status('create key failed: ' + e.message);
  }
}

async function onMyKeyCreate() {
  const out = await api('/api/me/keys', { method: 'POST', body: '{}' });
  showKeyOnce(out.key);
  await loadTeam();
}

function showKeyOnce(key) {
  const p = $('newkey');
  p.hidden = false;
  // Plaintext shown once; never stored. Plain text via textContent.
  p.textContent = 'New key (copy now, it will not be shown again): ' + key;
}

// --- Audit: latest 200 rows, server-scoped by role. ---
async function loadAudit() {
  const tbody = $('audit-table').querySelector('tbody');
  tbody.textContent = '';
  const { audit } = await api('/api/audit');
  for (const a of audit) {
    const tr = document.createElement('tr');
    tr.append(
      td(a.created_at), td(a.user_name || ''), td(a.server_slug || ''),
      td(a.tool), td(a.outcome), td(a.error_class || ''), td(String(a.duration_ms)),
    );
    tbody.append(tr);
  }
  status(audit.length === 0 ? 'no audit rows' : '');
}

// --- Chat: POST /api/chat SSE; history comes from the client (D22). ---
const chatHistory = [];
async function onChat(ev) {
  ev.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  chatHistory.push({ role: 'user', content: text });
  addChatMsg('you', text);
  const replyDiv = addChatMsg('assistant', '…');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Drop empty contents: the API validates content min(1).
      body: JSON.stringify({ messages: chatHistory.filter((m) => m.content) }),
    });
    if (!res.ok || !res.body) {
      let msg = 'HTTP ' + res.status;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch { /* SSE stream already started or empty */ }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let reply = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const p of parts) {
        const line = p.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data);
          // Real backend (chat.ts): text events carry {content}, tool
          // progress {name,status}, errors {message}. All plain text.
          if (typeof evt.content === 'string') reply += evt.content;
          else if (typeof evt.text === 'string') reply += evt.text;
          else if (typeof evt.name === 'string') reply += '\n[tool: ' + evt.name + ' ' + (evt.status || '') + ']\n';
          else if (typeof evt.message === 'string') reply += '\n[error: ' + evt.message + ']\n';
        } catch { /* ignore partial frames */ }
      }
      replyDiv.textContent = reply;
    }
    replyDiv.textContent = reply;
    if (reply) chatHistory.push({ role: 'assistant', content: reply });
  } catch (e) {
    replyDiv.textContent = 'chat failed: ' + (e.message || e);
  }
}

function addChatMsg(who, text) {
  const log = $('chat-log');
  const wrap = document.createElement('div');
  wrap.className = 'msg-' + who;
  const head = document.createElement('strong');
  head.textContent = who + ': ';
  const body = document.createElement('span');
  body.textContent = text;
  wrap.append(head, body);
  log.append(wrap);
  log.scrollTop = log.scrollHeight;
  return body;
}

boot().catch((e) => status(String(e.message || e)));
