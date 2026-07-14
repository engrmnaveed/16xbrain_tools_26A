import { useState, useEffect } from 'react';
import { useStore } from '../store.js';

export default function QueryBar() {
  const [q, setQ] = useState('');
  const runQuery = useStore((s) => s.runQuery);
  const run = useStore((s) => s.run);
  const chunks = useStore((s) => s.chunks);
  const suggestions = useStore((s) => s.suggestions);
  const loadSuggestions = useStore((s) => s.loadSuggestions);
  const settings = useStore((s) => s.settings);
  const docs = useStore((s) => s.docs);

  const busy = run && !['done', 'error'].includes(run.stage);

  useEffect(() => {
    if (docs.length && settings.apiKey && !suggestions.length) loadSuggestions();
  }, [docs.length, settings.apiKey]);

  const submit = (text) => {
    const query = (text ?? q).trim();
    if (!query || busy) return;
    setQ(query);
    runQuery(query);
  };

  return (
    <div className="query-bar-wrap">
      {suggestions.length > 0 && !run && (
        <div className="suggestions-row">
          <span className="muted small">AI suggests:</span>
          {suggestions.map((s, i) => (
            <button key={i} className="chip chip-btn" onClick={() => submit(s)}>{s}</button>
          ))}
        </div>
      )}
      <div className="query-bar">
        <span className="query-icon">⌕</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={
            chunks.length
              ? 'Ask a question about your documents…'
              : 'Add documents first, then ask anything…'
          }
          disabled={busy}
        />
        <button className="btn btn-primary" onClick={() => submit()} disabled={busy || !chunks.length}>
          {busy ? 'Running…' : 'Run pipeline'}
        </button>
      </div>
    </div>
  );
}
