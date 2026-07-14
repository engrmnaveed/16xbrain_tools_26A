import React, { useState } from 'react';

const TYPE_META = {
  'run:start':  { icon: '▶', cls: 'ok' },
  'agent:start': { icon: '◈', cls: '' },
  'agent:done': { icon: '◆', cls: 'ok' },
  flow:         { icon: '⇢', cls: 'flow' },
  iteration:    { icon: '↻', cls: 'warn' },
  verdict:      { icon: '⚖', cls: '' },
  error:        { icon: '✗', cls: 'err' },
  'run:done':   { icon: '■', cls: 'ok' },
};

function summarize(e) {
  switch (e.type) {
    case 'run:start': return `run started — max ${e.maxIterations} iterations${e.demo ? ' (demo)' : ''}`;
    case 'agent:start': return `${e.agent} started on ${e.model}`;
    case 'agent:done': return `${e.agent} finished in ${(e.ms / 1000).toFixed(1)}s${e.usage ? ` · ${e.usage.completion_tokens} tok` : ''}`;
    case 'flow': return `${e.from} → ${e.to} · ${e.label}`;
    case 'iteration': return `iteration ${e.n}/${e.max}`;
    case 'verdict': return `QA verdict: ${e.verdict} (iteration ${e.iteration})`;
    case 'error': return e.message;
    case 'run:done': return `run finished — ${e.status}`;
    default: return e.type;
  }
}

export default function TracePanel({ trace, explanation, explaining, hasKey, onExplain, onExport, onClose }) {
  const [selected, setSelected] = useState(null);
  const events = trace.filter((e) => e.type !== 'agent:token');
  const t0 = events[0]?.ts;

  return (
    <div className="drawer">
      <header className="drawer-head">
        <h2>Trace Inspector</h2>
        <div className="drawer-actions">
          <button
            className="btn ghost"
            onClick={onExplain}
            disabled={explaining || !events.length}
            title={hasKey ? 'AI root-causes rejections and failures in this run' : 'Add an OpenRouter key in Settings'}
          >
            {explaining ? '✦ analyzing…' : '✦ Explain run'}
          </button>
          <button className="btn ghost" onClick={onExport} disabled={!events.length}>Export JSON</button>
          <button className="btn tiny" onClick={onClose}>✕</button>
        </div>
      </header>

      {explanation && (
        <div className="explain-box">
          <div className="explain-title">✦ AI ANALYSIS</div>
          <pre>{explanation}</pre>
        </div>
      )}

      <div className="drawer-body">
        {!events.length && <div className="term-empty">no events yet — run the swarm</div>}
        {events.map((e, i) => {
          const meta = TYPE_META[e.type] || { icon: '·', cls: '' };
          return (
            <div key={i} className={`trace-row ${meta.cls} ${selected === i ? 'sel' : ''}`} onClick={() => setSelected(selected === i ? null : i)}>
              <span className="trace-time">+{((e.ts - t0) / 1000).toFixed(1)}s</span>
              <span className="trace-icon">{meta.icon}</span>
              <span className="trace-sum">{summarize(e)}</span>
            </div>
          );
        })}
        {selected != null && events[selected] && (
          <pre className="trace-detail">{JSON.stringify(events[selected], null, 2)}</pre>
        )}
      </div>
    </div>
  );
}
