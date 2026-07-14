import React from 'react';
import { useStore } from '../state/store.js';
import { validateProject } from '../model/schema.js';

export default function Sidebar() {
  const project = useStore(s => s.project);
  const selectedTableId = useStore(s => s.selectedTableId);
  const select = useStore(s => s.select);
  const addTable = useStore(s => s.addTable);
  const setView = useStore(s => s.setView);
  const openModal = useStore(s => s.openModal);

  const issues = validateProject(project);
  const errors = issues.filter(i => i.level === 'error').length;
  const warnings = issues.filter(i => i.level === 'warning').length;

  return (
    <div className="sidebar">
      <div className="head">
        <h3>Tables ({project.tables.length})</h3>
        <button className="btn sm" onClick={() => addTable()}>+</button>
      </div>
      <div className="table-list">
        {project.tables.length === 0 && (
          <p style={{ padding: 10, color: 'var(--text-faint)', fontSize: 12, lineHeight: 1.6 }}>
            No tables yet.<br />Double-click the canvas, import a source, or describe your app in the Script tab.
          </p>
        )}
        {project.tables.map(t => (
          <div key={t.id} className={'table-item' + (t.id === selectedTableId ? ' sel' : '')}
            onClick={() => { select(t.id); setView('canvas'); }}>
            <span>▦</span> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
            <span className="cnt">{t.fields.length}</span>
          </div>
        ))}
      </div>
      <div className="foot">
        {(errors > 0 || warnings > 0) && (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', padding: '2px 4px' }}>
            {errors > 0 && <span style={{ color: 'var(--red)' }}>● {errors} error{errors > 1 ? 's' : ''} </span>}
            {warnings > 0 && <span style={{ color: 'var(--amber)' }}>● {warnings} warning{warnings > 1 ? 's' : ''}</span>}
            <div style={{ marginTop: 4, maxHeight: 80, overflowY: 'auto' }}>
              {issues.slice(0, 5).map((i, idx) => (
                <div key={idx} style={{ fontSize: 10.5, color: 'var(--text-faint)', cursor: i.tableId ? 'pointer' : 'default' }}
                  onClick={() => i.tableId && select(i.tableId)}>· {i.message}</div>
              ))}
            </div>
          </div>
        )}
        <button className="btn sm" onClick={() => openModal('import')}>⤓ Import</button>
        <button className="btn sm" onClick={() => openModal('export')} disabled={!project.tables.length}>⤒ Export</button>
      </div>
    </div>
  );
}
