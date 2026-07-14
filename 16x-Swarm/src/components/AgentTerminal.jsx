import React, { useEffect, useRef } from 'react';

const META = {
  planner: { title: 'PLANNER', tag: 'spec architect', cls: 'planner' },
  coder:   { title: 'CODER',   tag: 'implementation', cls: 'coder' },
  qa:      { title: 'QA',      tag: 'ruthless review', cls: 'qa' },
};

const STATUS_TEXT = {
  idle: 'standby',
  streaming: 'thinking…',
  done: 'complete',
  rejected: 'rejected — retrying',
  error: 'error',
};

export default function AgentTerminal({ name, data }) {
  const bodyRef = useRef(null);
  const meta = META[name];

  // Autoscroll while streaming
  useEffect(() => {
    const el = bodyRef.current;
    if (el && data.status === 'streaming') el.scrollTop = el.scrollHeight;
  }, [data.output, data.status]);

  const copyOutput = () => navigator.clipboard?.writeText(data.output || '');

  return (
    <section className={`terminal term-${meta.cls} st-${data.status}`}>
      <header className="term-head">
        <div className="term-id">
          <span className="term-led" />
          <span className="term-title">{meta.title}</span>
          <span className="term-tag">{meta.tag}</span>
        </div>
        <div className="term-meta">
          {data.model && <span className="term-model">{data.model}</span>}
          <span className="term-status">{STATUS_TEXT[data.status]}</span>
        </div>
      </header>

      <div className="term-body" ref={bodyRef}>
        {data.output ? (
          <pre>{data.output}{data.status === 'streaming' && <span className="cursor">▊</span>}</pre>
        ) : (
          <div className="term-empty">
            <span className="term-empty-glyph">◇</span>
            awaiting dispatch
          </div>
        )}
      </div>

      <footer className="term-foot">
        <span>
          {data.ms != null && `${(data.ms / 1000).toFixed(1)}s`}
          {data.tokens != null && ` · ${data.tokens} tok`}
        </span>
        {data.output && (
          <button className="btn tiny" onClick={copyOutput}>copy</button>
        )}
      </footer>
    </section>
  );
}
