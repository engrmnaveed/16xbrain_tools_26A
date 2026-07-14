import { useState, useRef, useEffect } from 'react';
import Markdown from './Markdown.jsx';
import { adviseMigrationStrategy, reviewDecision, explainBottleneck, generateMigrationScript, askSchema, extractCode } from '../lib/ai.js';
import { exampleJoinQuery } from '../lib/analysis.js';
import { collectionToJson } from '../lib/nosqlTransform.js';
import { sampleCypher } from '../lib/graphTransform.js';

const NoKey = ({ openSettings }) => (
  <div className="no-key-note">
    🔑 AI features need an OpenRouter API key. It's stored securely on your machine
    (main process only) and used directly against openrouter.ai.
    <br />
    <button onClick={openSettings}>Add API key</button>
  </div>
);

/* ------------------------------- Analysis -------------------------------- */
function AnalysisTab({ ctx, hasKey, openSettings, mode }) {
  const { schema, docModel, graphModel, report } = ctx;
  const [explains, setExplains] = useState({});
  const [busy, setBusy] = useState({});
  const joinExample = exampleJoinQuery(schema);

  const explain = async (i, issue) => {
    if (!hasKey) { openSettings(); return; }
    setBusy((b) => ({ ...b, [i]: true }));
    const res = await explainBottleneck(ctx, issue);
    setBusy((b) => ({ ...b, [i]: false }));
    setExplains((e) => ({ ...e, [i]: res.error ? `⚠ ${res.error}` : res.content }));
  };

  return (
    <>
      <div className="metric-grid">
        <div className="metric"><div className="m-val good">{report.eliminated}<span style={{ fontSize: 13, color: 'var(--text-2)' }}>/{report.totalJoins}</span></div><div className="m-label">JOINs eliminated (doc)</div></div>
        <div className="metric"><div className="m-val good">{report.eliminationPct}%</div><div className="m-label">JOIN reduction</div></div>
        <div className="metric"><div className="m-val">{report.readAmplification.sql}→{report.readAmplification.document}</div><div className="m-label">Reads per page (SQL→Doc)</div></div>
        <div className="metric"><div className={`m-val ${report.unindexedFks.length ? 'bad' : 'good'}`}>{report.unindexedFks.length}</div><div className="m-label">Unindexed FKs</div></div>
      </div>

      {joinExample && (
        <div className="insp-section">
          <div className="insp-h">Worst-case JOIN chain ({joinExample.tablesTouched} tables)</div>
          <div className="joinchain">{joinExample.query}</div>
        </div>
      )}

      <div className="insp-section">
        <div className="insp-h">⚠ Indexing bottlenecks</div>
        {report.unindexedFks.length === 0 && <div className="issue-card" style={{ borderLeftColor: 'var(--doc)' }}>All foreign keys have supporting indexes. Clean.</div>}
        {report.unindexedFks.map((u, i) => (
          <div className="issue-card" key={i}>
            <code>{u.table}.{u.column}</code> → <code>{u.references}</code>: {u.message.split('. ').slice(1).join('. ')}
            <div>
              <button className="ai-explain" disabled={busy[i]} onClick={() => explain(i, u)}>
                {busy[i] ? 'Thinking…' : '✨ Explain impact + interim fix (AI)'}
              </button>
            </div>
            {explains[i] && <div className="ai-note">✨<Markdown text={explains[i]} className="" /></div>}
          </div>
        ))}
      </div>

      <div className="insp-section">
        <div className="insp-h">🔥 Hot tables under JOIN pressure</div>
        {report.hotTables.map((h) => (
          <div className="decision-row" key={h.table}>
            <span className="d-badge" style={{ background: 'rgba(244,63,94,.12)', color: '#fb7185' }}>{h.score}×</span>
            <span><b>{h.table}</b> participates in {h.score} relationship endpoints — a contention hot-spot at scale.</span>
          </div>
        ))}
      </div>

      <div className="insp-section">
        <div className="insp-h">{mode === 'graph' ? 'Graph decisions' : 'Document decisions'} (engine)</div>
        {(mode === 'graph' ? graphModel.decisions : docModel.decisions).map((d, i) => (
          <DecisionRow key={i} d={d} ctx={ctx} hasKey={hasKey} openSettings={openSettings} />
        ))}
      </div>

      {mode === 'graph' && (
        <div className="insp-section">
          <div className="insp-h">Sample Cypher</div>
          <div className="code-block">{sampleCypher(graphModel)}</div>
        </div>
      )}
      {mode === 'doc' && docModel.collections[0] && (
        <div className="insp-section">
          <div className="insp-h">Sample document — {docModel.collections[0].name}</div>
          <div className="code-block">{collectionToJson(docModel.collections[0])}</div>
        </div>
      )}
    </>
  );
}

function DecisionRow({ d, ctx, hasKey, openSettings }) {
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const critique = async (e) => {
    e.stopPropagation();
    if (!hasKey) { openSettings(); return; }
    setBusy(true);
    const res = await reviewDecision(ctx, d.table);
    setBusy(false);
    setReview(res.error ? `⚠ ${res.error}` : res.content);
  };
  return (
    <div className={`decision-row d-${d.action}`} onClick={critique} title="Click for an AI second opinion">
      <span className="d-badge">{d.action.replace('-', ' ')}</span>
      <span>
        {d.detail}
        {busy && <div style={{ marginTop: 6 }}><span className="spinner" style={{ display: 'inline-block' }} /></div>}
        {review && <div className="ai-note">✨<Markdown text={review} className="" /></div>}
      </span>
    </div>
  );
}

/* ------------------------------- Strategy -------------------------------- */
function StrategyTab({ ctx, hasKey, openSettings }) {
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!hasKey) return <NoKey openSettings={openSettings} />;
  const run = async () => {
    setBusy(true);
    const res = await adviseMigrationStrategy(ctx);
    setBusy(false);
    setOut(res.error ? `## Error\n${res.error}` : res.content);
  };
  return (
    <>
      <button className="ai-cta" onClick={run} disabled={busy}>
        {busy ? <><span className="spinner" /> Assessing your schema…</> : '✨ Generate migration strategy'}
      </button>
      <p style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 8, lineHeight: 1.5 }}>
        The AI receives the parsed schema, the engine's embed/reference/edge decisions and the
        performance report — it doesn't guess, it reviews.
      </p>
      {out && <Markdown text={out} />}
    </>
  );
}

/* -------------------------------- Script --------------------------------- */
function ScriptTab({ ctx, hasKey, openSettings, toast }) {
  const [target, setTarget] = useState('doc');
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!hasKey) return <NoKey openSettings={openSettings} />;
  const run = async () => {
    setBusy(true);
    const res = await generateMigrationScript(ctx, target);
    setBusy(false);
    setOut(res.error ? `-- Error: ${res.error}` : extractCode(res.content));
  };
  const save = async () => {
    const name = target === 'doc' ? 'migrate-to-mongodb.js' : 'migrate-to-neo4j.cypher';
    const ok = await window.dataflux?.saveFile({ defaultName: name, content: out });
    if (ok) toast(`Saved ${name}`);
  };
  return (
    <>
      <div className="script-target">
        <button className={target === 'doc' ? 'sel-doc' : ''} onClick={() => setTarget('doc')}>📄 MongoDB ETL</button>
        <button className={target === 'graph' ? 'sel-graph' : ''} onClick={() => setTarget('graph')}>⬡ Neo4j Cypher</button>
      </div>
      <button className="ai-cta" onClick={run} disabled={busy}>
        {busy ? <><span className="spinner" /> Writing migration skeleton…</> : '✨ Generate migration script'}
      </button>
      {out && (
        <>
          <div className="code-block" style={{ marginTop: 12 }}>{out}</div>
          <div className="copy-row">
            <button className="icon-btn" onClick={() => { navigator.clipboard.writeText(out); toast('Copied'); }}>⧉ Copy</button>
            <button className="icon-btn primary" onClick={save}>💾 Save to file</button>
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------- Assistant ------------------------------- */
function AssistantTab({ ctx, hasKey, openSettings }) {
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef(null);
  useEffect(() => { logRef.current?.scrollTo(0, 1e6); }, [history, busy]);
  if (!hasKey) return <NoKey openSettings={openSettings} />;

  const send = async (q) => {
    const question = (q || input).trim();
    if (!question || busy) return;
    setInput('');
    const h = [...history, { role: 'user', content: question }];
    setHistory(h);
    setBusy(true);
    const res = await askSchema(ctx, history, question);
    setBusy(false);
    setHistory([...h, { role: 'assistant', content: res.error ? `⚠ ${res.error}` : res.content }]);
  };

  const suggestions = [
    'Which table is riskiest to migrate first?',
    'Why did you dissolve the junction tables?',
    'What indexes should I add today, before migrating?',
    'Estimate the effort for this migration'
  ];

  return (
    <div className="chat-wrap">
      <div className="chat-log" ref={logRef}>
        {history.length === 0 && (
          <>
            <div className="chat-msg assistant">
              I'm grounded in your loaded schema, both target models and the performance report. Ask me anything about this migration.
            </div>
            <div className="chat-suggest">
              {suggestions.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}
            </div>
          </>
        )}
        {history.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.content} className="" /> : m.content}
          </div>
        ))}
        {busy && <div className="chat-msg assistant"><span className="spinner" style={{ display: 'inline-block' }} /></div>}
      </div>
      <div className="chat-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Ask about this schema…"
        />
        <button onClick={() => send()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </div>
  );
}

/* -------------------------------- Shell ---------------------------------- */
export default function Inspector({ ctx, hasKey, openSettings, mode, toast }) {
  const [tab, setTab] = useState('analysis');
  if (!ctx?.schema) {
    return (
      <div className="inspector">
        <div className="insp-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-2)', fontSize: 12 }}>
          Load a schema to see the analysis.
        </div>
      </div>
    );
  }
  return (
    <div className="inspector">
      <div className="insp-tabs">
        {[['analysis', '📊 Analysis'], ['strategy', '✨ Strategy'], ['script', '⚙ Scripts'], ['assistant', '💬 Assistant']].map(([id, label]) => (
          <button key={id} className={`insp-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="insp-body">
        {tab === 'analysis' && <AnalysisTab ctx={ctx} hasKey={hasKey} openSettings={openSettings} mode={mode} />}
        {tab === 'strategy' && <StrategyTab ctx={ctx} hasKey={hasKey} openSettings={openSettings} />}
        {tab === 'script' && <ScriptTab ctx={ctx} hasKey={hasKey} openSettings={openSettings} toast={toast} />}
        {tab === 'assistant' && <AssistantTab ctx={ctx} hasKey={hasKey} openSettings={openSettings} />}
      </div>
    </div>
  );
}
