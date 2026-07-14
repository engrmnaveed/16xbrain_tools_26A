import { useState } from 'react';
import { PRESETS } from '../lib/presets.js';
import { generateSchemaFromDescription } from '../lib/ai.js';

export default function Sidebar({ sqlText, setSqlText, onAnalyze, activePreset, setActivePreset, parseErrors, hasKey, openSettings, toast }) {
  const [aiDesc, setAiDesc] = useState('');
  const [generating, setGenerating] = useState(false);

  const loadPreset = (p) => {
    setSqlText(p.sql);
    setActivePreset(p.id);
  };

  const openFile = async () => {
    const f = await window.dataflux?.openSqlFile();
    if (f) {
      setSqlText(f.content);
      setActivePreset(null);
      toast(`Loaded ${f.name}`);
    }
  };

  const aiGenerate = async () => {
    if (!aiDesc.trim()) return;
    if (!hasKey) { openSettings(); return; }
    setGenerating(true);
    const res = await generateSchemaFromDescription(aiDesc.trim());
    setGenerating(false);
    if (res.error) { toast(`AI error: ${res.error}`); return; }
    setSqlText(res.sql);
    setActivePreset(null);
    toast('AI generated a schema — review it, then Analyze & Morph');
  };

  return (
    <aside className="sidebar">
      <div className="side-section">
        <div className="side-label">Preset legacy schemas</div>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`preset-card ${activePreset === p.id ? 'active' : ''}`}
              onClick={() => loadPreset(p)}
            >
              <span className="p-icon">{p.icon}</span>
              <div className="p-name">{p.name}</div>
              <div className="p-blurb">{p.blurb}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="side-section">
        <div className="side-label">✨ AI schema generator</div>
        <div className="ai-generate">
          <input
            placeholder="e.g. airline booking system…"
            value={aiDesc}
            onChange={(e) => setAiDesc(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && aiGenerate()}
          />
          <button onClick={aiGenerate} disabled={generating}>
            {generating ? '…' : 'Gen'}
          </button>
        </div>
      </div>

      <div className="side-section" style={{ paddingBottom: 0 }}>
        <div className="side-label">
          SQL DDL
          <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            {sqlText.length ? `${sqlText.split('\n').length} lines` : ''}
          </span>
        </div>
      </div>
      <div className="sql-editor">
        <textarea
          spellCheck={false}
          placeholder={'-- Paste CREATE TABLE statements here\nCREATE TABLE users (\n  id INT PRIMARY KEY,\n  ...\n);'}
          value={sqlText}
          onChange={(e) => { setSqlText(e.target.value); setActivePreset(null); }}
        />
        {parseErrors?.length > 0 && (
          <div className="parse-errors">⚠ {parseErrors.join(' · ')}</div>
        )}
        <div className="side-actions">
          <button className="icon-btn" onClick={openFile}>📂 Open .sql</button>
          <button className="icon-btn" onClick={() => { setSqlText(''); setActivePreset(null); }}>✕ Clear</button>
        </div>
        <button className="analyze-btn" disabled={!sqlText.trim()} onClick={onAnalyze}>
          ⚡ Analyze & Morph
        </button>
      </div>
    </aside>
  );
}
