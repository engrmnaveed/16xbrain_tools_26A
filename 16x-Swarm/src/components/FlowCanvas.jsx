import React, { useEffect, useState } from 'react';

// Node x-positions on a 1000-wide viewBox
const NODES = {
  user:    { x: 80,  label: 'USER',    color: 'var(--c-user)' },
  planner: { x: 360, label: 'PLANNER', color: 'var(--c-planner)' },
  coder:   { x: 640, label: 'CODER',   color: 'var(--c-coder)' },
  qa:      { x: 920, label: 'QA',      color: 'var(--c-qa)' },
};
const Y = 64;

function pathBetween(from, to) {
  const a = NODES[from].x;
  const b = NODES[to].x;
  const lift = from === 'qa' && to === 'coder' ? 34 : from === 'qa' && to === 'user' ? 46 : -30;
  const mid = (a + b) / 2;
  return `M ${a} ${Y} Q ${mid} ${Y + lift} ${b} ${Y}`;
}

export default function FlowCanvas({ flows, agents, running }) {
  const [packets, setPackets] = useState([]);

  useEffect(() => {
    if (!flows.length) { setPackets([]); return; }
    const latest = flows[flows.length - 1];
    setPackets((p) => [...p.slice(-2), { ...latest, key: `${latest.id}-${Date.now()}` }]);
    const t = setTimeout(() => {
      setPackets((p) => p.filter((x) => x.id !== latest.id));
    }, 2600);
    return () => clearTimeout(t);
  }, [flows]);

  const agentStatus = (name) =>
    name === 'user' ? 'idle' : agents[name]?.status || 'idle';

  return (
    <div className="flow-canvas">
      <svg viewBox="0 0 1000 110" preserveAspectRatio="none">
        {/* static bus lines */}
        <path d={pathBetween('user', 'planner')} className="bus-line" />
        <path d={pathBetween('planner', 'coder')} className="bus-line" />
        <path d={pathBetween('coder', 'qa')} className="bus-line" />
        <path d={pathBetween('qa', 'coder')} className="bus-line bus-return" />

        {/* animated packets */}
        {packets.map((p) => (
          <g key={p.key}>
            <circle r="6" className="packet" fill={NODES[p.from].color}>
              <animateMotion dur="1.6s" fill="freeze" path={pathBetween(p.from, p.to)} />
            </circle>
            <circle r="12" className="packet-halo" fill={NODES[p.from].color}>
              <animateMotion dur="1.6s" fill="freeze" path={pathBetween(p.from, p.to)} />
            </circle>
          </g>
        ))}

        {/* nodes */}
        {Object.entries(NODES).map(([name, n]) => {
          const st = agentStatus(name);
          return (
            <g key={name} className={`flow-node node-${st}`}>
              <circle cx={n.x} cy={Y} r="16" className="node-ring" stroke={n.color} />
              <circle cx={n.x} cy={Y} r={st === 'streaming' ? 7 : 5} fill={n.color} className="node-core" />
              <text x={n.x} y={Y - 28} textAnchor="middle" className="node-label" fill={n.color}>
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* flow labels */}
      <div className="flow-labels">
        {packets.map((p) => (
          <span key={`l-${p.key}`} className="flow-label" style={{ color: NODES[p.from].color }}>
            {NODES[p.from].label} → {NODES[p.to].label} · {p.label}
          </span>
        ))}
        {!packets.length && !running && (
          <span className="flow-label dim">message bus idle — run a task or hit Demo</span>
        )}
      </div>
    </div>
  );
}
