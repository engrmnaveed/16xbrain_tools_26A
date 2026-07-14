import React, { useState, useEffect, useMemo } from 'react';
import { useStore } from '../state/store.js';
import { parseScript, serializeProject } from '../dsl/parser.js';
import { englishToSchema, hasAIKey } from '../ai/openrouter.js';

export default function ScriptView() {
  const project = useStore(s => s.project);
  const replaceSchema = useStore(s => s.replaceSchema);
  const showToast = useStore(s => s.showToast);
  const setView = useStore(s => s.setView);
  const aiBusy = useStore(s => s.aiBusy);
  const setAiBusy = useStore(s => s.setAiBusy);

  const serialized = useMemo(() => serializeProject(project), [project]);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [english, setEnglish] = useState('');
  const [merge, setMerge] = useState(true);

  useEffect(() => { if (!dirty) setText(serialized); }, [serialized, dirty]);

  // live validation
  useEffect(() => {
    const id = setTimeout(() => {
      try { parseScript(text); setError(null); }
      catch (e) { setError(e.message); }
    }, 250);
    return () => clearTimeout(id);
  }, [text]);

  const apply = () => {
    try {
      const { tables, relations } = parseScript(text);
      replaceSchema(tables, relations);
      setDirty(false);
      showToast(`Applied: ${tables.length} tables, ${relations.length} relations.`, 'success');
    } catch (e) { setError(e.message); showToast(e.message, 'error'); }
  };

  const runEnglish = async () => {
    if (!english.trim()) return;
    if (!hasAIKey()) { showToast('Add your OpenRouter key in Settings → AI first.', 'error'); return; }
    setAiBusy(true);
    try {
      const { fragment, script } = await englishToSchema(english, merge ? project : null);
      replaceSchema(fragment.tables, fragment.relations, { merge: merge && project.tables.length > 0 });
      setDirty(false);
      setEnglish('');
      showToast(`AI built ${fragment.tables.length} table(s) from your description.`, 'success');
    } catch (e) { showToast(e.message, 'error'); }
    finally { setAiBusy(false); }
  };

  return (
    <div className="script-view">
      <div className="script-toolbar">
        <strong style={{ fontSize: 13 }}>SchemaScript</strong>
        <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>plain-text source of truth — edit and apply</span>
        <div className="grow" />
        <button className="btn sm" onClick={() => { setText(serialized); setDirty(false); setError(null); }} disabled={!dirty}>Revert</button>
        <button className="btn sm primary" onClick={apply} disabled={!!error}>Apply to diagram ⌘↵</button>
      </div>

      <div className="script-body">
        <textarea className="script-editor" spellCheck={false} value={text}
          placeholder={`table users {\n  id uuid pk\n  email string unique !null\n  role enum(admin, member) default(member)\n  created_at datetime default(now)\n}\n\ntable orders {\n  id uuid pk\n  total decimal !null\n}\n\nref orders.user_id > users.id`}
          onChange={(e) => { setText(e.target.value); setDirty(true); }}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') apply(); }} />
      </div>

      {error
        ? <div className="script-error">✕ {error}</div>
        : <div className="script-ok">✓ Valid SchemaScript{dirty ? ' — not applied yet' : ''}</div>}

      <div className="english-bar">
        <input type="text" value={english} disabled={aiBusy}
          placeholder='✦ Describe in plain English… e.g. "a food delivery app with restaurants, menus, orders, riders and reviews"'
          onChange={(e) => setEnglish(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runEnglish()} />
        <label className="checkbox-row" title="Add to current schema instead of replacing it">
          <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} /> merge
        </label>
        <button className="btn ai" onClick={runEnglish} disabled={aiBusy || !english.trim()}>
          {aiBusy ? <span className="spinner" /> : '✦ Generate'}
        </button>
      </div>
    </div>
  );
}
