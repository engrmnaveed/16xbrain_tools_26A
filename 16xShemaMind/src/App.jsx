import React, { useEffect, useCallback, useState } from 'react';
import { useStore } from './state/store.js';
import Sidebar from './components/Sidebar.jsx';
import Canvas from './components/Canvas.jsx';
import Inspector from './components/Inspector.jsx';
import ScriptView from './components/ScriptView.jsx';
import DataGenView from './components/DataGenView.jsx';
import JsonView from './components/JsonView.jsx';
import DocsView from './components/DocsView.jsx';
import SettingsView from './components/SettingsView.jsx';
import { ModalRoot } from './components/Modals.jsx';
import { openTextFile, saveTextFile, onMenu } from './io/fileBridge.js';
import { reviewSchema, suggestRelations, explainSchema, hasAIKey } from './ai/openrouter.js';

const TABS = [
  { id: 'canvas', label: 'Diagram' },
  { id: 'script', label: 'Script' },
  { id: 'data', label: 'Data' },
  { id: 'json', label: 'JSON' },
  { id: 'docs', label: 'Docs' },
  { id: 'settings', label: 'Settings' }
];

export default function App() {
  const { project, dirty, filePath, view, setView, toast, aiBusy, setAiBusy,
    newProject, loadProject, setFilePath, markSaved, undo, redo,
    openModal, showToast, addRelation, mutate } = useStore();
  const isMac = navigator.platform.toLowerCase().includes('mac');

  // ---------- file ops ----------
  const doSave = useCallback(async () => {
    const st = useStore.getState();
    const json = JSON.stringify(st.project, null, 2);
    if (st.filePath && window.schemamind) {
      await window.schemamind.writePath({ filePath: st.filePath, content: json, encoding: 'utf8' });
      st.markSaved();
      st.showToast('Saved.', 'success');
    } else {
      try {
        const res = await saveTextFile(`${st.project.meta.name.replace(/\s+/g, '-').toLowerCase()}.schemamind.json`, json,
          [{ name: 'SchemaMind project', extensions: ['json'] }]);
        st.setFilePath(res.path);
        st.showToast('Project saved.', 'success');
      } catch (e) { if (e.message !== 'cancelled') st.showToast(e.message, 'error'); }
    }
  }, []);

  const doOpen = useCallback(async () => {
    try {
      const f = await openTextFile([{ name: 'SchemaMind project', extensions: ['json'] }]);
      if (!f) return;
      const data = JSON.parse(f.content);
      if (!data.meta || !Array.isArray(data.tables)) throw new Error('Not a SchemaMind project file.');
      loadProject(data, f.path);
      showToast(`Opened "${data.meta.name}".`, 'success');
    } catch (e) { showToast(e.message, 'error'); }
  }, [loadProject, showToast]);

  // ---------- menu + shortcuts ----------
  useEffect(() => {
    const offs = [
      onMenu('menu:new', () => newProject('Untitled Schema')),
      onMenu('menu:open', doOpen),
      onMenu('menu:save', doSave),
      onMenu('menu:import', () => openModal('import')),
      onMenu('menu:export', () => openModal('export')),
      onMenu('menu:undo', undo),
      onMenu('menu:redo', redo),
      onMenu('menu:docs', () => setView('docs'))
    ];
    return () => offs.forEach(off => off && off());
  }, [doOpen, doSave]);

  useEffect(() => {
    const h = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const inField = /input|textarea|select/i.test(e.target.tagName);
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); doSave(); }
      else if (k === 'o') { e.preventDefault(); doOpen(); }
      else if (k === 'n') { e.preventDefault(); newProject('Untitled Schema'); }
      else if (k === 'i' && !inField) { e.preventDefault(); openModal('import'); }
      else if (k === 'e' && !inField) { e.preventDefault(); openModal('export'); }
      else if (k === 'z' && !inField) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [doSave, doOpen]);

  // ---------- AI toolbar actions ----------
  const requireKey = () => {
    if (!hasAIKey()) { showToast('Add your OpenRouter key in Settings first.', 'error'); setView('settings'); return false; }
    if (!project.tables.length) { showToast('Design at least one table first.', 'error'); return false; }
    return true;
  };

  const aiReview = async () => {
    if (!requireKey()) return;
    setAiBusy(true);
    try { openModal('ai-review', { review: await reviewSchema(project) }); }
    catch (e) { showToast(e.message, 'error'); }
    finally { setAiBusy(false); }
  };

  const aiRelations = async () => {
    if (!requireKey()) return;
    setAiBusy(true);
    try {
      const { relations } = await suggestRelations(project);
      if (!relations.length) { showToast('AI found no missing relations — nice.', 'success'); return; }
      relations.forEach(r => addRelation(r));
      showToast(`AI added ${relations.length} suggested relation(s). Undo with ⌘/Ctrl+Z if unwanted.`, 'success');
    } catch (e) { showToast(e.message, 'error'); }
    finally { setAiBusy(false); }
  };

  const aiDocs = async () => {
    if (!requireKey()) return;
    setAiBusy(true);
    try { openModal('ai-docs', { markdown: await explainSchema(project) }); }
    catch (e) { showToast(e.message, 'error'); }
    finally { setAiBusy(false); }
  };

  return (
    <div className="app">
      <div className="topbar">
        {isMac && window.schemamind && <div className="mac-pad" />}
        <div className="brand"><span className="logo">SchemaMind</span><span className="by">by 16xbrains</span></div>
        <input className="proj-name" type="text" value={project.meta.name}
          onChange={(e) => mutate(p => { p.meta.name = e.target.value; }, { record: false })} />
        {dirty && <span className="dirty-dot" title="Unsaved changes">•</span>}

        <div className="tabs">
          {TABS.map(t => (
            <button key={t.id} className={'tab' + (view === t.id ? ' active' : '')} onClick={() => setView(t.id)}>{t.label}</button>
          ))}
        </div>

        <button className="btn sm ai" onClick={aiReview} disabled={aiBusy} title="AI design review">{aiBusy ? <span className="spinner" /> : '✦'} Review</button>
        <button className="btn sm ai" onClick={aiRelations} disabled={aiBusy} title="AI: find missing relations">✦ Relations</button>
        <button className="btn sm ai" onClick={aiDocs} disabled={aiBusy} title="AI: write schema documentation">✦ Docs</button>
        <button className="btn sm" onClick={doSave} title="Save project (⌘/Ctrl+S)">Save</button>
      </div>

      <div className="main">
        {(view === 'canvas') && <Sidebar />}
        <div className="content">
          {view === 'canvas' && (
            project.tables.length === 0 ? <EmptyCanvas /> : <>
              <Canvas />
              <Inspector />
            </>
          )}
          {view === 'script' && <ScriptView />}
          {view === 'data' && <DataGenView />}
          {view === 'json' && <JsonView />}
          {view === 'docs' && <DocsView />}
          {view === 'settings' && <SettingsView />}
        </div>
      </div>

      <ModalRoot />
      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </div>
  );
}

function EmptyCanvas() {
  const { addTable, openModal, setView } = useStore();
  return (
    <div className="canvas-wrap" style={{ cursor: 'default' }}>
      <div className="empty-state">
        <h2>Start your schema</h2>
        <p>Three ways in — pick whichever matches how you think.</p>
        <div className="actions">
          <button className="btn primary" onClick={() => addTable()}>+ First table</button>
          <button className="btn" onClick={() => openModal('import')}>⤓ Import SQL / JSON / Excel</button>
          <button className="btn ai" onClick={() => setView('script')}>✦ Describe it in English</button>
        </div>
      </div>
    </div>
  );
}
