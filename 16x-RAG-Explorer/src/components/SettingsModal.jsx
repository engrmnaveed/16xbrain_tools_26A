import { useState } from 'react';
import { useStore } from '../store.js';
import { STRATEGIES } from '../engine/chunker.js';
import { SUGGESTED_MODELS } from '../ai/openrouter.js';

export default function SettingsModal() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const chunkAdvice = useStore((s) => s.chunkAdvice);
  const chunkAdviceLoading = useStore((s) => s.chunkAdviceLoading);
  const runChunkAdvisor = useStore((s) => s.runChunkAdvisor);
  const applyChunkAdvice = useStore((s) => s.applyChunkAdvice);
  const docs = useStore((s) => s.docs);

  const [form, setForm] = useState({ ...settings });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setShowSettings(false);
    await saveSettings({
      ...form,
      chunkSize: Number(form.chunkSize) || 512,
      overlap: Number(form.overlap) || 0,
      topK: Number(form.topK) || 5,
      scoreThreshold: Number(form.scoreThreshold) || 0
    });
  };

  return (
    <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="btn-icon" onClick={() => setShowSettings(false)}>✕</button>
        </div>

        <div className="settings-section">
          <h3>OpenRouter (AI features)</h3>
          <label>
            API key
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder="sk-or-v1-…"
            />
          </label>
          <div className="muted small">
            Stored locally on this machine only. Get a key at{' '}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">openrouter.ai/keys</a>.
            Powers answers, retrieval audits, query suggestions, HyDE expansion and the chunking advisor.
          </div>
          <label>
            Model
            <select value={form.model} onChange={(e) => set('model', e.target.value)}>
              {SUGGESTED_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
              {!SUGGESTED_MODELS.some((m) => m.id === form.model) && (
                <option value={form.model}>{form.model}</option>
              )}
            </select>
          </label>
          <label>
            Custom model ID (optional, overrides above)
            <input
              type="text"
              placeholder="e.g. mistralai/mistral-large"
              onChange={(e) => e.target.value.trim() && set('model', e.target.value.trim())}
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={form.useHyde}
              onChange={(e) => set('useHyde', e.target.checked)}
            />
            HyDE query expansion — LLM rewrites the query as a hypothetical answer before embedding (often improves recall)
          </label>
        </div>

        <div className="settings-section">
          <h3>Retrieval</h3>
          <div className="settings-grid">
            <label>
              Top K chunks
              <input type="number" min="1" max="20" value={form.topK}
                onChange={(e) => set('topK', e.target.value)} />
            </label>
            <label>
              Score threshold
              <input type="number" min="0" max="1" step="0.05" value={form.scoreThreshold}
                onChange={(e) => set('scoreThreshold', e.target.value)} />
            </label>
          </div>
        </div>

        <div className="settings-section">
          <h3>Chunking <span className="muted small">(re-indexes on change)</span></h3>
          <label>
            Strategy
            <select value={form.strategy} onChange={(e) => set('strategy', e.target.value)}>
              {Object.entries(STRATEGIES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          <div className="muted small">{STRATEGIES[form.strategy]?.desc}</div>
          <div className="settings-grid">
            <label>
              Chunk size (chars)
              <input type="number" min="128" max="4000" step="64" value={form.chunkSize}
                onChange={(e) => set('chunkSize', e.target.value)} />
            </label>
            <label>
              Overlap (chars)
              <input type="number" min="0" max="512" value={form.overlap}
                onChange={(e) => set('overlap', e.target.value)} />
            </label>
          </div>

          {docs.length > 0 && settings.apiKey && (
            <div className="advisor-box">
              {!chunkAdvice && !chunkAdviceLoading && (
                <button className="btn btn-ghost btn-sm" onClick={runChunkAdvisor}>
                  ✨ Ask AI: best chunking for my corpus?
                </button>
              )}
              {chunkAdviceLoading && <span className="muted small">Analyzing corpus…</span>}
              {chunkAdvice && !chunkAdvice.error && (
                <div className="advice-result">
                  <div>
                    <b>{STRATEGIES[chunkAdvice.strategy]?.label || chunkAdvice.strategy}</b>
                    {' · '}{chunkAdvice.chunkSize} chars · overlap {chunkAdvice.overlap}
                  </div>
                  <div className="muted small">{chunkAdvice.reasoning}</div>
                  <button className="btn btn-primary btn-sm" onClick={applyChunkAdvice}>
                    Apply & re-index
                  </button>
                </div>
              )}
              {chunkAdvice?.error && <div className="stage-error">{chunkAdvice.error}</div>}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={() => setShowSettings(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
