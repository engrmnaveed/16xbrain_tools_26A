import React, { useState } from 'react';
import { checkKey } from '../engine/openrouter.js';

const MODEL_PRESETS = [
  'anthropic/claude-sonnet-4',
  'anthropic/claude-3.5-haiku',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'google/gemini-2.5-pro',
  'deepseek/deepseek-chat-v3-0324',
  'meta-llama/llama-3.3-70b-instruct',
];

function ModelField({ label, hint, value, onChange }) {
  return (
    <label className="field">
      <span className="field-label">{label} <em>{hint}</em></span>
      <input list="model-presets" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </label>
  );
}

export default function SettingsPanel({ settings, onSave, onClose }) {
  const [draft, setDraft] = useState(settings);
  const [keyState, setKeyState] = useState(null); // null | 'checking' | 'ok' | 'bad'

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setModel = (agent, v) => setDraft((d) => ({ ...d, models: { ...d.models, [agent]: v } }));

  const testKey = async () => {
    if (!draft.apiKey) return;
    setKeyState('checking');
    setKeyState((await checkKey(draft.apiKey).catch(() => false)) ? 'ok' : 'bad');
  };

  const save = () => { onSave(draft); onClose(); };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Settings</h2>
          <button className="btn tiny" onClick={onClose}>✕</button>
        </header>

        <div className="modal-body">
          <h3>OpenRouter</h3>
          <label className="field">
            <span className="field-label">
              API key <em>stored encrypted on this machine · get one at openrouter.ai/keys</em>
            </span>
            <div className="field-row">
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => { set({ apiKey: e.target.value }); setKeyState(null); }}
                placeholder="sk-or-v1-…"
                spellCheck={false}
              />
              <button className="btn ghost" onClick={testKey} disabled={!draft.apiKey || keyState === 'checking'}>
                {keyState === 'checking' ? '…' : 'Test'}
              </button>
            </div>
            {keyState === 'ok' && <span className="key-ok">✓ key is valid</span>}
            {keyState === 'bad' && <span className="key-bad">✗ key rejected by OpenRouter</span>}
          </label>

          <h3>Agent models</h3>
          <p className="hint">Any OpenRouter model ID works. Mix vendors — e.g. a strong coder with a cheap, adversarial QA.</p>
          <datalist id="model-presets">
            {MODEL_PRESETS.map((m) => <option key={m} value={m} />)}
          </datalist>
          <ModelField label="Planner" hint="writes the spec" value={draft.models.planner} onChange={(v) => setModel('planner', v)} />
          <ModelField label="Coder" hint="implements it" value={draft.models.coder} onChange={(v) => setModel('coder', v)} />
          <ModelField label="QA" hint="reviews & rejects" value={draft.models.qa} onChange={(v) => setModel('qa', v)} />
          <ModelField label="AI assist" hint="prompt refiner & trace explainer" value={draft.assistModel} onChange={(v) => set({ assistModel: v })} />

          <h3>Run behavior</h3>
          <div className="field-grid">
            <label className="field">
              <span className="field-label">Max iterations <em>QA reject → Coder retry loops</em></span>
              <input
                type="number" min="1" max="8"
                value={draft.maxIterations}
                onChange={(e) => set({ maxIterations: Math.max(1, Math.min(8, +e.target.value || 1)) })}
              />
            </label>
            <label className="field">
              <span className="field-label">Temperature <em>0 = strict · 1 = creative</em></span>
              <input
                type="number" min="0" max="1" step="0.1"
                value={draft.temperature}
                onChange={(e) => set({ temperature: Math.max(0, Math.min(1, +e.target.value || 0)) })}
              />
            </label>
          </div>
        </div>

        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn run" onClick={save}>Save</button>
        </footer>
      </div>
    </div>
  );
}
