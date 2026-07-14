import React, { useState } from 'react';
import { getAISettings, saveAISettings, SUGGESTED_MODELS } from '../ai/openrouter.js';
import { useStore } from '../state/store.js';

export default function SettingsView() {
  const showToast = useStore(s => s.showToast);
  const [s, setS] = useState(getAISettings());

  const save = () => {
    saveAISettings(s);
    showToast('AI settings saved. Keys are stored locally on this machine only.', 'success');
  };

  return (
    <div className="view">
      <h1>Settings</h1>
      <p className="sub">SchemaMind is local-first. The only network calls it ever makes are to OpenRouter, and only when you trigger an AI action.</p>

      <div className="panel" style={{ maxWidth: 620 }}>
        <h3>✦ AI — OpenRouter</h3>
        <label className="lbl">API key</label>
        <input type="password" style={{ width: '100%' }} value={s.apiKey} placeholder="sk-or-v1-…"
          onChange={(e) => setS({ ...s, apiKey: e.target.value.trim() })} />
        <p style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4 }}>
          Get a key at openrouter.ai/keys. Stored in local app storage, never sent anywhere except OpenRouter.
        </p>

        <label className="lbl">Model</label>
        <input type="text" style={{ width: '100%' }} value={s.model} list="model-list"
          onChange={(e) => setS({ ...s, model: e.target.value.trim() })} />
        <datalist id="model-list">
          {SUGGESTED_MODELS.map(m => <option key={m} value={m} />)}
        </datalist>
        <p style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4 }}>
          Any OpenRouter model id works. Claude Sonnet is a strong default for schema work.
        </p>

        <label className="lbl">Temperature — {s.temperature}</label>
        <input type="range" min="0" max="1" step="0.1" value={s.temperature}
          onChange={(e) => setS({ ...s, temperature: Number(e.target.value) })} style={{ width: 220 }} />

        <div style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={save}>Save settings</button>
        </div>
      </div>

      <div className="panel" style={{ maxWidth: 620 }}>
        <h3>Where AI is embedded</h3>
        <ul style={{ paddingLeft: 18, color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.8 }}>
          <li><strong style={{ color: 'var(--text)' }}>Script view</strong> — describe your product in plain English, get a full schema.</li>
          <li><strong style={{ color: 'var(--text)' }}>Inspector → ✦ Suggest</strong> — AI proposes missing fields for the selected table.</li>
          <li><strong style={{ color: 'var(--text)' }}>Toolbar → ✦ Review</strong> — full design review: normalization, indexes, constraints, naming.</li>
          <li><strong style={{ color: 'var(--text)' }}>Toolbar → ✦ Relations</strong> — detects relations you probably forgot.</li>
          <li><strong style={{ color: 'var(--text)' }}>Toolbar → ✦ Docs</strong> — writes onboarding documentation for your schema.</li>
        </ul>
      </div>
    </div>
  );
}
