import { useEffect } from 'react';
import { useStore } from './store.js';
import GalaxyView from './components/GalaxyView.jsx';
import PipelineView from './components/PipelineView.jsx';
import DocumentsPanel from './components/DocumentsPanel.jsx';
import InspectorPanel from './components/InspectorPanel.jsx';
import QueryBar from './components/QueryBar.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import DocsModal from './components/DocsModal.jsx';

export default function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const showSettings = useStore((s) => s.showSettings);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const showDocs = useStore((s) => s.showDocs);
  const setShowDocs = useStore((s) => s.setShowDocs);
  const init = useStore((s) => s.init);
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.settings);

  useEffect(() => {
    init();
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◉</span>
          <span className="brand-name">RAG Explorer</span>
          <span className="brand-by">by 16xBrains</span>
        </div>
        <div className="view-toggle">
          <button className={view === 'galaxy' ? 'active' : ''} onClick={() => setView('galaxy')}>
            ✦ Galaxy
          </button>
          <button className={view === 'pipeline' ? 'active' : ''} onClick={() => setView('pipeline')}>
            ⇶ Pipeline
          </button>
        </div>
        <div className="topbar-actions">
          {!settings.apiKey && (
            <button className="btn btn-ghost btn-sm key-nudge" onClick={() => setShowSettings(true)}>
              🔑 Add OpenRouter key for AI features
            </button>
          )}
          <button className="btn-icon" title="How to use" onClick={() => setShowDocs(true)}>?</button>
          <button className="btn-icon" title="Settings" onClick={() => setShowSettings(true)}>⚙</button>
        </div>
      </header>

      <div className="main-row">
        <DocumentsPanel />
        <main className="center-stage">
          {view === 'galaxy' ? <GalaxyView /> : <PipelineView />}
        </main>
        <InspectorPanel />
      </div>

      <QueryBar />

      {showSettings && <SettingsModal />}
      {showDocs && <DocsModal />}
      {toast && <div className={`toast toast-${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}
