import { useState, useCallback, useEffect } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Canvas from './components/Canvas.jsx';
import Inspector from './components/Inspector.jsx';
import { SettingsModal, DocsModal } from './components/Modals.jsx';
import { parseSchema } from './lib/sqlParser.js';
import { toDocumentModel } from './lib/nosqlTransform.js';
import { toGraphModel } from './lib/graphTransform.js';
import { modernizationReport } from './lib/analysis.js';
import { PRESETS } from './lib/presets.js';

export default function App() {
  const [sqlText, setSqlText] = useState(PRESETS[0].sql);
  const [activePreset, setActivePreset] = useState(PRESETS[0].id);
  const [ctx, setCtx] = useState(null); // { schema, docModel, graphModel, report }
  const [parseErrors, setParseErrors] = useState([]);
  const [mode, setMode] = useState('sql');
  const [selected, setSelected] = useState(null);
  const [settings, setSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);

  const isWin = window.dataflux?.platform !== 'darwin';

  const refreshSettings = useCallback(async () => {
    const s = await window.dataflux?.getSettings();
    setSettings(s || { hasApiKey: false });
  }, []);
  useEffect(() => { refreshSettings(); }, [refreshSettings]);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2600);
  }, []);

  const analyze = useCallback(() => {
    const schema = parseSchema(sqlText);
    setParseErrors(schema.errors);
    if (!schema.tables.length) { setCtx(null); return; }
    const docModel = toDocumentModel(schema);
    const graphModel = toGraphModel(schema);
    const report = modernizationReport(schema, docModel, graphModel);
    setCtx({ schema, docModel, graphModel, report });
    setMode('sql');
    setSelected(null);
    toast(`Parsed ${schema.tables.length} tables · ${schema.relationships.length} relationships`);
  }, [sqlText, toast]);

  // Analyze the default preset on first launch
  useEffect(() => { analyze(); }, []); // eslint-disable-line

  const exportBlueprint = async () => {
    if (!ctx) return;
    const blueprint = {
      tool: '16xDataFlux v1.0 — 16xbrains.com',
      generatedAt: new Date().toISOString(),
      source: { tables: ctx.schema.tables, relationships: ctx.schema.relationships, indexes: ctx.schema.indexes },
      documentModel: { collections: ctx.docModel.collections, decisions: ctx.docModel.decisions },
      graphModel: { nodes: ctx.graphModel.nodes, edges: ctx.graphModel.edges, decisions: ctx.graphModel.decisions },
      performanceReport: ctx.report
    };
    const ok = await window.dataflux?.saveFile({
      defaultName: 'dataflux-blueprint.json',
      content: JSON.stringify(blueprint, null, 2)
    });
    if (ok) toast('Blueprint exported');
  };

  const switchMode = (m) => {
    setMode(m);
  };

  return (
    <div className="app">
      <div className={`topbar ${isWin ? 'win' : ''}`}>
        <div className="brand">
          <span className="logo">16x<em>DataFlux</em></span>
          <span className="tag">DB Modernization Mapper</span>
        </div>

        <div className="mode-switch">
          <button className={`mode-btn ${mode === 'sql' ? 'active-sql' : ''}`} onClick={() => switchMode('sql')}>
            <span className="dot" />▦ SQL
          </button>
          <span className="mode-arrow">⇢</span>
          <button className={`mode-btn ${mode === 'doc' ? 'active-doc' : ''}`} onClick={() => switchMode('doc')} disabled={!ctx}>
            <span className="dot" />📄 Document
          </button>
          <span className="mode-arrow">⇢</span>
          <button className={`mode-btn ${mode === 'graph' ? 'active-graph' : ''}`} onClick={() => switchMode('graph')} disabled={!ctx}>
            <span className="dot" />⬡ Graph
          </button>
        </div>

        <div className="top-actions">
          <button className="icon-btn" onClick={exportBlueprint} disabled={!ctx}>⇩ Export</button>
          <button className="icon-btn" onClick={() => setShowDocs(true)}>📖 Docs</button>
          <button className="icon-btn primary" onClick={() => setShowSettings(true)}>
            {settings?.hasApiKey ? '⚙ Settings' : '🔑 Set API key'}
          </button>
        </div>
      </div>

      <div className="app-body">
        <Sidebar
          sqlText={sqlText}
          setSqlText={setSqlText}
          onAnalyze={analyze}
          activePreset={activePreset}
          setActivePreset={setActivePreset}
          parseErrors={parseErrors}
          hasKey={!!settings?.hasApiKey}
          openSettings={() => setShowSettings(true)}
          toast={toast}
        />
        <Canvas
          schema={ctx?.schema}
          docModel={ctx?.docModel}
          graphModel={ctx?.graphModel}
          report={ctx?.report}
          mode={mode}
          selected={selected}
          onSelect={setSelected}
        />
        <Inspector
          ctx={ctx}
          hasKey={!!settings?.hasApiKey}
          openSettings={() => setShowSettings(true)}
          mode={mode}
          toast={toast}
        />
      </div>

      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} settings={settings} refresh={refreshSettings} toast={toast} />
      )}
      {showDocs && <DocsModal onClose={() => setShowDocs(false)} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}
