import { useStore } from '../store.js';
import { DOC_COLORS } from './GalaxyView.jsx';

export default function DocumentsPanel() {
  const docs = useStore((s) => s.docs);
  const chunks = useStore((s) => s.chunks);
  const isIndexing = useStore((s) => s.isIndexing);
  const indexProgress = useStore((s) => s.indexProgress);
  const modelDownload = useStore((s) => s.modelDownload);
  const addFiles = useStore((s) => s.addFiles);
  const loadSample = useStore((s) => s.loadSample);
  const removeDoc = useStore((s) => s.removeDoc);
  const clearCorpus = useStore((s) => s.clearCorpus);
  const settings = useStore((s) => s.settings);

  const chunkCount = (docId) => chunks.filter((c) => c.docId === docId).length;

  return (
    <aside className="docs-panel">
      <div className="panel-title">
        Corpus
        {docs.length > 0 && (
          <button className="btn-icon" title="Remove all documents" onClick={clearCorpus}>🗑</button>
        )}
      </div>

      <div className="docs-actions">
        <button className="btn btn-primary" onClick={addFiles} disabled={isIndexing}>
          + Add documents
        </button>
        <button className="btn btn-ghost" onClick={loadSample} disabled={isIndexing}>
          ✦ Load sample corpus
        </button>
      </div>

      {isIndexing && (
        <div className="index-progress">
          {modelDownload && (
            <div className="muted small">Downloading embedding model… {modelDownload.pct}%</div>
          )}
          <div className="muted small">
            {indexProgress?.phase} {indexProgress ? `${indexProgress.done}/${indexProgress.total}` : ''}
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: indexProgress?.total ? `${(indexProgress.done / indexProgress.total) * 100}%` : '10%' }}
            />
          </div>
        </div>
      )}

      <div className="docs-list">
        {docs.length === 0 && !isIndexing && (
          <div className="docs-empty">
            <p>No documents yet.</p>
            <p className="muted small">
              Add .txt, .md, .pdf, .html or .csv files — or load the sample corpus to explore
              instantly. Everything is embedded <b>locally</b>; your files never leave this machine.
            </p>
          </div>
        )}
        {docs.map((d, i) => (
          <div className="doc-item" key={d.id}>
            <span className="doc-dot" style={{ background: DOC_COLORS[i % DOC_COLORS.length] }} />
            <div className="doc-meta">
              <div className="doc-name" title={d.name}>{d.name}</div>
              <div className="muted small">
                {(d.chars / 1000).toFixed(1)}k chars · {chunkCount(d.id)} chunks
              </div>
            </div>
            <button className="btn-icon" title="Remove" onClick={() => removeDoc(d.id)}>✕</button>
          </div>
        ))}
      </div>

      {chunks.length > 0 && (
        <div className="corpus-stats">
          <div><b>{chunks.length}</b> chunks indexed</div>
          <div className="muted small">
            {settings.strategy} · {settings.chunkSize} chars · overlap {settings.overlap} · 384-dim local embeddings
          </div>
        </div>
      )}
    </aside>
  );
}
