import React, { useState } from 'react';
import { useStore } from '../state/store.js';
import { importJSON } from '../io/importers.js';
import { openTextFile } from '../io/fileBridge.js';

export default function JsonView() {
  const replaceSchema = useStore(s => s.replaceSchema);
  const showToast = useStore(s => s.showToast);
  const setView = useStore(s => s.setView);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);

  const parse = (t) => {
    try { setParsed(JSON.parse(t)); setError(null); }
    catch (e) { setParsed(null); setError(e.message); }
  };

  const openFile = async () => {
    try {
      const f = await openTextFile([{ name: 'JSON', extensions: ['json'] }]);
      if (!f) return;
      setText(f.content); setFileName(f.name); parse(f.content);
    } catch (e) { showToast(e.message, 'error'); }
  };

  const toSchema = () => {
    try {
      const name = (fileName || 'imported').replace(/\.json$/i, '');
      const { tables, relations } = importJSON(text, name);
      replaceSchema(tables, relations, { merge: true });
      setView('canvas');
      showToast(`Inferred ${tables.length} table(s) from JSON — added to diagram.`, 'success');
    } catch (e) { showToast(e.message, 'error'); }
  };

  return (
    <div className="view">
      <h1>JSON workbench</h1>
      <p className="sub">Inspect any JSON with a collapsible tree, and infer a relational schema from its shape — nested arrays become child tables with foreign keys.</p>

      <div className="panel">
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn" onClick={openFile}>Open .json file…</button>
          {fileName && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{fileName}</span>}
          <div className="grow" />
          <button className="btn primary" onClick={toSchema} disabled={!parsed}>→ Infer schema into diagram</button>
        </div>
        <textarea rows={8} style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }}
          placeholder='Paste JSON here… e.g. {"users": [{"id": 1, "name": "Ada", "orders": [{"total": 9.99}]}]}'
          value={text} onChange={(e) => { setText(e.target.value); parse(e.target.value); }} />
        {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>✕ {error}</div>}
      </div>

      {parsed !== null && (
        <div className="panel">
          <h3>Tree view</h3>
          <div className="json-tree"><JsonNode value={parsed} name={null} depth={0} /></div>
        </div>
      )}
    </div>
  );
}

function JsonNode({ value, name, depth }) {
  const [open, setOpen] = useState(depth < 2);
  const key = name != null ? <><span className="jk">"{name}"</span>: </> : null;

  if (value === null) return <div>{key}<span className="jnull">null</span></div>;
  if (typeof value === 'string') return <div>{key}<span className="js">"{truncate(value)}"</span></div>;
  if (typeof value === 'number') return <div>{key}<span className="jn">{value}</span></div>;
  if (typeof value === 'boolean') return <div>{key}<span className="jb">{String(value)}</span></div>;

  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  const brackets = isArr ? ['[', ']'] : ['{', '}'];

  return (
    <div>
      <span className="toggle" onClick={() => setOpen(o => !o)}>{open ? '▾' : '▸'} </span>
      {key}{brackets[0]}
      {!open && <span style={{ color: 'var(--text-faint)' }}> {entries.length} {isArr ? 'items' : 'keys'} {brackets[1]}</span>}
      {open && (
        <>
          <div className="json-node">
            {entries.slice(0, 200).map(([k, v]) => <JsonNode key={k} name={isArr ? null : k} value={v} depth={depth + 1} />)}
            {entries.length > 200 && <div style={{ color: 'var(--text-faint)' }}>… {entries.length - 200} more</div>}
          </div>
          <div>{brackets[1]}</div>
        </>
      )}
    </div>
  );
}

const truncate = (s) => s.length > 120 ? s.slice(0, 120) + '…' : s;
