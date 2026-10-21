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
