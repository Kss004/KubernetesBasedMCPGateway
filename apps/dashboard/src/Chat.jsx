// Chat agent UI: POST /api/chat streams SSE events (text, tool, error, done).
// History lives here and is re-sent each turn; the server stores nothing (D22).
import { useEffect, useRef, useState } from 'react';
import { Typing } from './ui.jsx';

// Quick starts for the empty state (DoD prompts; members can run all three).
const PROMPTS = ['What orders came in today?', 'List the products in the store', 'Convert 100 USD to EUR'];

// "woo__list_orders" -> { server: "woo", tool: "list_orders" }
const splitTool = (name) => {
  const i = name.indexOf('__');
  return i > 0 ? { server: name.slice(0, i), tool: name.slice(i + 2) } : { server: 'harbor', tool: name }; // search_tools / call_tool
};

export default function Chat({ me }) {
  const [msgs, setMsgs] = useState([]); // { role, content, tools?: [{name,status,error}] }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [msgs]);

  const send = async (e) => {
    e.preventDefault();
    await ask(input.trim());
  };

  const ask = async (text) => {
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    // Display keeps each message's tool chips; the request sends only role + content.
    const shown = [...msgs, { role: 'user', content: text }];
    const history = shown.filter((m) => m.content).map(({ role, content }) => ({ role, content }));
    const reply = { role: 'assistant', content: '', tools: [] };
    const update = () => setMsgs([...shown, { ...reply, tools: [...reply.tools] }]);
    update();
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop();
        for (const f of frames) {
          const event = f.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
          const data = f.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
          if (!data) continue;
          let d;
          try {
            d = JSON.parse(data);
          } catch {
            continue;
          }
          if (event === 'text') reply.content += (reply.content ? '\n\n' : '') + d.content;
          else if (event === 'tool') {
            const open = reply.tools.findLast((t) => t.name === d.name && t.status === 'start');
            if (d.status === 'start' || !open) reply.tools.push({ name: d.name, status: d.status, error: d.error });
            else Object.assign(open, { status: d.status, error: d.error });
          } else if (event === 'error') reply.content += `\n[error: ${d.message}]`;
          update();
        }
      }
    } catch (err) {
      reply.content += `[chat failed: ${err.message}]`;
      update();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat">
      <div className="chat-panel">
        <div className="chat-log" ref={logRef}>
          {msgs.length === 0 && (
            <div className="chat-empty">
              <p className="eyebrow">Start with</p>
              <div className="prompts">
                {PROMPTS.map((p) => (
                  <button key={p} type="button" onClick={() => ask(p)} disabled={busy}>
                    {p} <span aria-hidden="true">→</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`msg msg-${m.role}`}>
              {m.role === 'assistant' && <div className="who">Harbor agent</div>}
              {m.tools?.map((t, j) => {
                const { server, tool } = splitTool(t.name);
                const state = t.status === 'start' ? 'running' : t.status === 'done' ? 'done' : 'failed';
                return (
                  <div key={j} className={`tool-card tool-${t.status}`} title={t.error || ''}>
                    <span className="tag">{server}</span>
                    <span className="mono">{tool}</span>
                    <span className="state">{state}</span>
                    {t.error && <div className="tool-err">{t.error}</div>}
                  </div>
                );
              })}
              {m.content ? (
                <div className="text">{m.content}</div>
              ) : (
                m.role === 'assistant' && busy && i === msgs.length - 1 && <Typing />
              )}
            </div>
          ))}
        </div>
        <form className="chat-form" onSubmit={send}>
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) send(e);
            }}
            placeholder="Ask about orders, products…"
          />
          <button type="submit" className="primary" disabled={busy || !input.trim()}>
            Send <span aria-hidden="true">↑</span>
          </button>
        </form>
        <p className="chat-foot">
          <span className="dot-live" aria-hidden="true" /> Working as {me.name} · {me.role} · every tool call audited
        </p>
      </div>
    </section>
  );
}
