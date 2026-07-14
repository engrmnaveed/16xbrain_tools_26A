import { useStore } from '../store.js';
import { DOC_COLORS } from './GalaxyView.jsx';

// Right-hand panel: streaming answer + retrieved chunks + chunk inspector.
export default function InspectorPanel() {
  const run = useStore((s) => s.run);
  const selectedChunk = useStore((s) => s.selectedChunk);
  const selectChunk = useStore((s) => s.selectChunk);
  const chunks = useStore((s) => s.chunks);
  const docs = useStore((s) => s.docs);
  const runAudit = useStore((s) => s.runAudit);
  const settings = useStore((s) => s.settings);

  const docIndex = new Map(docs.map((d, i) => [d.id, i]));

  if (selectedChunk) {
    const color = DOC_COLORS[(docIndex.get(selectedChunk.docId) ?? 0) % DOC_COLORS.length];
    const score = run?.all?.find((s) => s.id === selectedChunk.id)?.score;
    return (
      <aside className="inspector-panel">
        <div className="panel-title">
          Chunk inspector
          <button className="btn-icon" onClick={() => selectChunk(null)}>✕</button>
        </div>
        <div className="chunk-card">
          <div className="chunk-card-head">
            <span className="doc-dot" style={{ background: color }} />
            <b>{selectedChunk.docName}</b>
            <span className="muted small">chunk {selectedChunk.index + 1}</span>
          </div>
          {score != null && (
            <div className="chunk-score">
              similarity to query: <b>{score.toFixed(4)}</b>
              <div className="scorebar-wrap wide">
                <span className="scorebar" style={{ width: `${Math.max(2, score * 100)}%` }} />
              </div>
            </div>
          )}
          <div className="muted small">
            chars {selectedChunk.start}–{selectedChunk.end} · {selectedChunk.text.length} chars
          </div>
          <div className="chunk-text">{selectedChunk.text}</div>
        </div>
      </aside>
    );
  }

  if (!run) {
    return (
      <aside className="inspector-panel">
        <div className="panel-title">Results</div>
        <div className="inspector-empty muted">
          Run a query to see retrieval results and the grounded answer here.
          Click any star in the galaxy to inspect its chunk.
        </div>
      </aside>
    );
  }

  return (
    <aside className="inspector-panel">
      <div className="panel-title">Results</div>

      {run.top?.length > 0 && (
        <>
          <div className="section-label">Retrieved context · top {run.top.length}</div>
          <div className="retrieved-list compact">
            {run.top.map((c, i) => (
              <button key={c.id} className="retrieved-item"
                onClick={() => selectChunk(chunks.find((x) => x.id === c.id) || c)}>
                <span className="rank">#{i + 1}</span>
                <span className="doc-dot" style={{ background: DOC_COLORS[(docIndex.get(c.docId) ?? 0) % DOC_COLORS.length] }} />
                <span className="retrieved-doc">{c.docName}</span>
                <span className="scorebar-wrap">
                  <span className="scorebar" style={{ width: `${Math.max(4, c.score * 100)}%` }} />
                  <span className="scoreval">{c.score.toFixed(3)}</span>
                </span>
              </button>
            ))}
          </div>
          {settings.apiKey && !run.audit && !run.auditLoading && ['done'].includes(run.stage) && (
            <button className="btn btn-ghost btn-sm" onClick={runAudit}>⚖ AI audit retrieval</button>
          )}
          {run.auditLoading && <div className="muted small">Auditing…</div>}
          {run.audit && !run.audit.error && (
            <div className={`audit-box audit-${run.audit.coverage}`}>
              <div className="audit-head">Coverage: <b>{run.audit.coverage}</b></div>
              <div className="audit-advice">💡 {run.audit.advice}</div>
            </div>
          )}
        </>
      )}

      <div className="section-label">
        Answer {run.stage === 'generate' && <span className="stage-spinner" />}
      </div>
      <div className="answer-stream">
        {run.answer || (run.stage !== 'done' && run.stage !== 'error' ? '…' : '')}
      </div>
      {run.stage === 'error' && <div className="stage-error">{run.error}</div>}

      {run.timings && Object.keys(run.timings).length > 0 && (
        <div className="timing-row muted small">
          {Object.entries(run.timings).map(([k, v]) => (
            <span key={k}>{k}: {v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`}</span>
          ))}
        </div>
      )}
    </aside>
  );
}
