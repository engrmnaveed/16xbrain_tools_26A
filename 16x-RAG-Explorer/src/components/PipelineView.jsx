import { useStore } from '../store.js';
import { DOC_COLORS } from './GalaxyView.jsx';

const STAGE_ORDER = ['expand', 'embed', 'search', 'generate', 'done'];

function stageStatus(run, stage) {
  if (!run) return 'idle';
  if (run.stage === 'error') {
    const errIdx = STAGE_ORDER.indexOf(run.lastStage || run.stage);
    return STAGE_ORDER.indexOf(stage) < errIdx ? 'done' : 'error';
  }
  const cur = STAGE_ORDER.indexOf(run.stage);
  const idx = STAGE_ORDER.indexOf(stage);
  if (run.stage === 'done') return 'done';
  if (idx < cur) return 'done';
  if (idx === cur) return 'active';
  return 'pending';
}

function ms(v) {
  return v == null ? '' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
}

function Stage({ id, num, title, subtitle, status, timing, children }) {
  return (
    <div className={`stage stage-${status}`} id={`stage-${id}`}>
      <div className="stage-rail">
        <div className="stage-dot">{status === 'done' ? '✓' : num}</div>
        <div className="stage-line" />
      </div>
      <div className="stage-body">
        <div className="stage-head">
          <span className="stage-title">{title}</span>
          {timing != null && <span className="stage-timing">{ms(timing)}</span>}
          {status === 'active' && <span className="stage-spinner" />}
        </div>
        <div className="stage-subtitle">{subtitle}</div>
        {children}
      </div>
    </div>
  );
}

function VectorPreview({ vector, label }) {
  if (!vector) return null;
  const cells = vector.slice(0, 48);
  const max = Math.max(...cells.map(Math.abs), 1e-6);
  return (
    <div className="vector-preview" title={`${label}: first 48 of ${vector.length} dimensions`}>
      {cells.map((v, i) => (
        <span
          key={i}
          className="vcell"
          style={{
            opacity: 0.25 + 0.75 * (Math.abs(v) / max),
            background: v >= 0 ? 'var(--accent)' : 'var(--pink)'
          }}
        />
      ))}
      <span className="vdots">…{vector.length}d</span>
    </div>
  );
}

export default function PipelineView() {
  const run = useStore((s) => s.run);
  const chunks = useStore((s) => s.chunks);
  const docs = useStore((s) => s.docs);
  const settings = useStore((s) => s.settings);
  const selectChunk = useStore((s) => s.selectChunk);
  const runAudit = useStore((s) => s.runAudit);

  const docIndex = new Map(docs.map((d, i) => [d.id, i]));

  return (
    <div className="pipeline-view">
      {!run && (
        <div className="pipeline-empty">
          <h2>The RAG pipeline, made visible</h2>
          <p>
            Run a query to watch each stage light up: your question becomes a vector, flies into
            the corpus, pulls back the nearest chunks, and grounds the model's answer in them.
          </p>
        </div>
      )}

      {run && (
        <div className="pipeline-stages">
          <div className="stage stage-done">
            <div className="stage-rail"><div className="stage-dot">Q</div><div className="stage-line" /></div>
            <div className="stage-body">
              <div className="stage-head"><span className="stage-title">Query</span></div>
              <div className="query-bubble">{run.query}</div>
            </div>
          </div>

          {settings.useHyde && (
            <Stage id="expand" num="1" title="AI query expansion (HyDE)" status={stageStatus(run, 'expand')}
              timing={run.timings?.expand}
              subtitle="An LLM writes a hypothetical answer passage — embedding that instead of the raw query often lands closer to real document chunks.">
              {run.expansion && !run.expansion.error && (
                <div className="expansion-box">
                  <div className="expansion-text">“{run.expansion.hypothetical}”</div>
                  {run.expansion.keywords && (
                    <div className="chip-row">
                      {run.expansion.keywords.map((k, i) => <span key={i} className="chip">{k}</span>)}
                    </div>
                  )}
                </div>
              )}
              {run.expansion?.error && <div className="stage-error">Expansion failed: {run.expansion.error}</div>}
            </Stage>
          )}

          <Stage id="embed" num={settings.useHyde ? '2' : '1'} title="Embed the query" status={stageStatus(run, 'embed')}
            timing={run.timings?.embed}
            subtitle="A local sentence-transformer (all-MiniLM-L6-v2, running on this machine) converts the text into a 384-dimensional vector — a point in meaning-space.">
            {run.queryPos && (
              <div className="embed-result">
                <VectorPreview vector={run.queryVector} label="query vector" />
                <span className="embed-coords">
                  → 3D projection ({run.queryPos.map((v) => v.toFixed(1)).join(', ')})
                </span>
              </div>
            )}
          </Stage>

          <Stage id="search" num={settings.useHyde ? '3' : '2'} title="Vector search" status={stageStatus(run, 'search')}
            timing={run.timings?.search}
            subtitle={`Cosine similarity against all ${chunks.length} chunk vectors. Top ${settings.topK} above threshold ${settings.scoreThreshold} become the context.`}>
            {run.top?.length > 0 && (
              <div className="retrieved-list">
                {run.top.map((c, i) => (
                  <button key={c.id} className="retrieved-item" onClick={() => selectChunk(chunks.find((x) => x.id === c.id) || c)}>
                    <span className="rank">#{i + 1}</span>
                    <span className="doc-dot" style={{ background: DOC_COLORS[(docIndex.get(c.docId) ?? 0) % DOC_COLORS.length] }} />
                    <span className="retrieved-doc">{c.docName}</span>
                    <span className="retrieved-snippet">{c.text.slice(0, 90)}…</span>
                    <span className="scorebar-wrap">
                      <span className="scorebar" style={{ width: `${Math.max(4, c.score * 100)}%` }} />
                      <span className="scoreval">{c.score.toFixed(3)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {run.top?.length > 0 && stageStatus(run, 'search') === 'done' && settings.apiKey && (
              <div className="audit-row">
                {!run.audit && !run.auditLoading && (
                  <button className="btn btn-ghost btn-sm" onClick={runAudit}>
                    ⚖ AI audit: are these the right chunks?
                  </button>
                )}
                {run.auditLoading && <span className="muted">Auditing retrieval…</span>}
                {run.audit && !run.audit.error && (
                  <div className={`audit-box audit-${run.audit.coverage}`}>
                    <div className="audit-head">
                      Coverage: <b>{run.audit.coverage}</b>
                      {run.audit.missing && run.audit.missing !== 'null' && (
                        <span> · missing: {run.audit.missing}</span>
                      )}
                    </div>
                    <ul>
                      {(run.audit.verdicts || []).map((v) => (
                        <li key={v.index} className={v.relevant ? 'ok' : 'bad'}>
                          [{v.index}] {v.relevant ? 'relevant' : 'off-target'} — {v.reason}
                        </li>
                      ))}
                    </ul>
                    <div className="audit-advice">💡 {run.audit.advice}</div>
                  </div>
                )}
                {run.audit?.error && <div className="stage-error">Audit failed: {run.audit.error}</div>}
              </div>
            )}
          </Stage>

          <Stage id="generate" num={settings.useHyde ? '4' : '3'} title="Grounded generation" status={stageStatus(run, 'generate')}
            timing={run.timings?.generate}
            subtitle={`The retrieved chunks are injected into the prompt. ${settings.model} answers only from that context, citing [1]–[${Math.max(run.top?.length || 0, 1)}].`}>
            {run.answer && <div className="answer-stream">{run.answer}</div>}
          </Stage>

          {run.stage === 'error' && (
            <div className="stage-error big">Pipeline error: {run.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
