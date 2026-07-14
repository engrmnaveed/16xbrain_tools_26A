import { useState, useEffect } from 'react';

export function SettingsModal({ onClose, settings, refresh, toast }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(settings?.model || 'anthropic/claude-3.5-sonnet');
  const [temp, setTemp] = useState(settings?.temperature ?? 0.3);
  const [models, setModels] = useState([]);

  useEffect(() => {
    window.dataflux?.aiModels().then((m) => setModels(m || []));
  }, []);

  const popular = [
    'anthropic/claude-3.5-sonnet',
    'anthropic/claude-3.5-haiku',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'google/gemini-2.0-flash-001',
    'meta-llama/llama-3.3-70b-instruct'
  ];
  const modelIds = models.length ? models.map((m) => m.id) : popular;

  const save = async () => {
    const patch = { model, temperature: +temp };
    if (key.trim()) patch.openrouterKey = key.trim();
    await window.dataflux?.setSettings(patch);
    await refresh();
    toast('Settings saved');
    onClose();
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>⚙ Settings</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label>
              OpenRouter API key{' '}
              <span className={`key-status ${settings?.hasApiKey ? 'on' : 'off'}`}>
                {settings?.hasApiKey ? `● active ${settings.keyHint}` : '○ not set'}
              </span>
            </label>
            <input
              type="password"
              placeholder={settings?.hasApiKey ? 'Enter a new key to replace the current one' : 'sk-or-v1-…'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <div className="form-hint">
              Stored in your OS user-data folder and only ever read by the app's main process —
              never exposed to the UI layer. Get a key at{' '}
              <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">openrouter.ai/keys</a>.
            </div>
          </div>
          <div className="form-row">
            <label>Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {!modelIds.includes(model) && <option value={model}>{model}</option>}
              {modelIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <div className="form-hint">Any OpenRouter model works. Claude 3.5 Sonnet gives the best schema reasoning.</div>
          </div>
          <div className="form-row">
            <label>Temperature — {temp}</label>
            <input type="range" min="0" max="1" step="0.1" value={temp} onChange={(e) => setTemp(e.target.value)} />
            <div className="form-hint">Keep low (0.2–0.4) for deterministic engineering advice.</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {settings?.hasApiKey && (
              <button className="icon-btn" onClick={async () => { await window.dataflux?.setSettings({ clearKey: true }); await refresh(); toast('Key removed'); }}>
                Remove key
              </button>
            )}
            <button className="save-btn" onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DocsModal({ onClose }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <h2>📖 How to use 16xDataFlux</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body docs-body">
          <h3>What this tool does</h3>
          <p>
            16xDataFlux takes a legacy relational schema and shows — visually and quantitatively — what it
            becomes as a modern <b>document store</b> (MongoDB-style) or <b>property graph</b> (Neo4j-style).
            Watch the tables physically morph: children get absorbed into parent documents, junction tables
            dissolve into arrays or first-class relationships, and JOIN arrows disappear.
          </p>

          <h3>The three views</h3>
          <div className="docs-legend">
            <div className="leg l-sql"><b>▦ Relational</b><span>Your source of truth. Amber arrows are foreign keys — each one is a JOIN paid on every query.</span></div>
            <div className="leg l-doc"><b>📄 Document</b><span>Tables morph into collections. Watch child tables fly into their parents as embedded arrays/sub-documents.</span></div>
            <div className="leg l-graph"><b>⬡ Graph</b><span>Entities become node labels on a ring; junction tables become the edges themselves, carrying properties.</span></div>
          </div>

          <h3>Workflow</h3>
          <div className="step"><span className="n">1</span><span>Load a schema: pick a <b>preset</b>, paste DDL, open a <kbd>.sql</kbd> file, or type a domain into the <b>AI schema generator</b>.</span></div>
          <div className="step"><span className="n">2</span><span>Hit <b>⚡ Analyze & Morph</b>. The deterministic engine parses tables, FKs and indexes, then designs both target models with a written rationale per table.</span></div>
          <div className="step"><span className="n">3</span><span>Switch modes in the top bar and watch the morph. Drag to pan, scroll to zoom, click any card for detail.</span></div>
          <div className="step"><span className="n">4</span><span>Open the <b>📊 Analysis</b> tab: JOIN-elimination stats, worst-case JOIN chain, unindexed FKs, hot tables. Click any engine decision for an <b>AI second opinion</b>.</span></div>
          <div className="step"><span className="n">5</span><span><b>✨ Strategy</b> writes a phased migration plan; <b>⚙ Scripts</b> generates a runnable MongoDB ETL or Neo4j Cypher skeleton; <b>💬 Assistant</b> answers questions grounded in <i>your</i> schema.</span></div>

          <h3>Where the AI fits (and where it doesn't)</h3>
          <p>
            Parsing, transformation and bottleneck detection are <b>deterministic</b> — same input, same output,
            no key needed. The AI layer (OpenRouter, any model) sits on top: it critiques the engine's decisions,
            explains production impact, writes the strategy and generates migration code. Every AI call is
            grounded in the parsed schema + engine output, so answers reference your real tables.
          </p>

          <h3>Internal use (data engineers)</h3>
          <p>
            Use it as a pre-migration design review: load a client's DDL, screenshot the morph for the proposal,
            check the unindexed-FK list before you quote, and hand the generated ETL skeleton to the implementation
            team as a starting contract.
          </p>

          <h3>Keys & privacy</h3>
          <p>
            Your OpenRouter key is stored in the OS user-data directory, read only by the Electron main process,
            and sent only to <kbd>openrouter.ai</kbd>. Schemas never leave your machine except inside those AI calls.
          </p>
        </div>
      </div>
    </div>
  );
}
