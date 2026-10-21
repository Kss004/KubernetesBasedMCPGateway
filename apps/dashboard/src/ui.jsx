import { useEffect, useRef } from 'react';

// Cursor spotlight, as on urumi.ai's hero: a blurred 700px teal glow that trails the pointer.
// urumi.ai drives it with Framer Motion's useSpring(stiffness 80, damping 22, mass 0.6); this is
// the same spring integrated by hand (no animation library). Overdamped, so it glides in
// without bouncing. Off for touch pointers and reduced motion; the loop stops once settled.
const SIZE = 700;
const K = 80;
const C = 22;
const M = 0.6;

export function Spotlight() {
  const ref = useRef(null);
  useEffect(() => {
    if (matchMedia('(pointer: coarse), (prefers-reduced-motion: reduce)').matches) return;
    const el = ref.current;
    const p = { x: innerWidth * 0.7, y: 220 }; // position
    const v = { x: 0, y: 0 }; // velocity
    const t = { ...p }; // target (the pointer)
    let raf = 0;
    let last = 0;
    const place = () => (el.style.transform = `translate3d(${p.x - SIZE / 2}px, ${p.y - SIZE / 2}px, 0)`);
    const step = (now) => {
      const dt = Math.min((now - (last || now)) / 1000, 1 / 30); // clamp after a hidden tab
      last = now;
      for (const k of ['x', 'y']) {
        v[k] += ((-K * (p[k] - t[k]) - C * v[k]) / M) * dt;
        p[k] += v[k] * dt;
      }
      place();
      const settled = Math.abs(p.x - t.x) + Math.abs(p.y - t.y) < 0.5 && Math.abs(v.x) + Math.abs(v.y) < 0.5;
      raf = settled ? 0 : requestAnimationFrame(step);
      if (settled) last = 0;
    };
    const move = (e) => {
      t.x = e.clientX;
      t.y = e.clientY;
      if (!raf) raf = requestAnimationFrame(step);
    };
    place();
    window.addEventListener('pointermove', move, { passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      cancelAnimationFrame(raf);
    };
  }, []);
  return <div className="spotlight" ref={ref} aria-hidden="true" />;
}

// Shared page furniture in the urumi.ai style: mono eyebrow ("01 / SERVERS"),
// a large heading with an italic accent phrase, and a short muted lead.
export function PageHead({ n, label, title, accent, lead }) {
  return (
    <div className="page-head">
      <p className="eyebrow">
        {String(n).padStart(2, '0')} / {label}
      </p>
      <h2>
        {title} <em>{accent}</em>
      </h2>
      {lead && <p className="lead">{lead}</p>}
    </div>
  );
}

// Three bouncing dots while the agent is working (replaces "thinking…").
export function Typing() {
  return (
    <span className="typing" role="status" aria-label="Agent is working">
      <i />
      <i />
      <i />
    </span>
  );
}
