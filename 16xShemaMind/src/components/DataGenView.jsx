import React, { useState } from 'react';
import { useStore } from '../state/store.js';
import { generateData, dataToJSON, dataToCSV, dataToSQLInserts, dataToMongoInserts } from '../datagen/generator.js';
import { exportDataWorkbook } from '../io/excel.js';
import { saveTextFile, saveBase64File } from '../io/fileBridge.js';

export default function DataGenView() {
  const project = useStore(s => s.project);
  const showToast = useStore(s => s.showToast);
  const [seed, setSeed] = useState(42);
  const [defaultRows, setDefaultRows] = useState(25);
  const [rowsPerTable, setRowsPerTable] = useState({});
  const [data, setData] = useState(null);
  const [previewTable, setPreviewTable] = useState(null);

  if (!project.tables.length) {
    return (
      <div className="view"><div className="empty-state">
        <h2>No tables yet</h2>
        <p>Design a schema first — then generate realistic seed data that respects your relations.</p>
      </div></div>
    );
  }

  const run = () => {
    try {
      const d = generateData(project, { rowsPerTable, defaultRows: Number(defaultRows) || 25, seed: Number(seed) || 42 });
      setData(d);
      setPreviewTable(Object.keys(d)[0] || null);
      const total = Object.values(d).reduce((a, r) => a + r.length, 0);
      showToast(`Generated ${total} rows across ${Object.keys(d).length} tables (FK-consistent).`, 'success');
    } catch (e) { showToast(e.message, 'error'); }
  };

  const dl = async (kind) => {
    if (!data) return;
    try {
      if (kind === 'json') await saveTextFile(`${project.meta.name}-data.json`, dataToJSON(data));
      if (kind === 'sql') await saveTextFile(`${project.meta.name}-seed.sql`, dataToSQLInserts(project, data));
      if (kind === 'mongo') await saveTextFile(`${project.meta.name}-seed.mongodb.js`, dataToMongoInserts(data));
      if (kind === 'xlsx') await saveBase64File(`${project.meta.name}-data.xlsx`, exportDataWorkbook(data));
      if (kind === 'csv' && previewTable) await saveTextFile(`${previewTable}.csv`, dataToCSV(data[previewTable]));
      showToast('Saved.', 'success');
    } catch (e) { if (e.message !== 'cancelled') showToast(e.message, 'error'); }
  };

  const rows = data && previewTable ? data[previewTable] : null;
  const cols = rows && rows.length ? Object.keys(rows[0]) : [];

  return (
    <div className="view">
      <h1>Random data generator</h1>
      <p className="sub">Name-aware, type-aware fake data. Foreign keys sample real parent rows, in dependency order — referential integrity guaranteed. Seeded, so runs are reproducible.</p>

      <div className="panel">
        <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
          <div><label className="lbl">Seed</label>
            <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} style={{ width: 90 }} /></div>
          <div><label className="lbl">Default rows / table</label>
            <input type="number" value={defaultRows} min={1} max={10000} onChange={(e) => setDefaultRows(e.target.value)} style={{ width: 110 }} /></div>
          <div className="grow" />
          <button className="btn primary" onClick={run} style={{ alignSelf: 'flex-end' }}>⚡ Generate</button>
        </div>
        <label className="lbl" style={{ marginTop: 14 }}>Per-table row counts (optional)</label>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {project.tables.map(t => (
            <div key={t.id} className="row" style={{ gap: 4 }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>{t.name}</span>
              <input type="number" placeholder={String(defaultRows)} style={{ width: 68 }}
                value={rowsPerTable[t.id] ?? ''} min={0} max={10000}
                onChange={(e) => setRowsPerTable(r => ({ ...r, [t.id]: e.target.value === '' ? undefined : Number(e.target.value) }))} />
            </div>
          ))}
        </div>
      </div>

      {data && (
        <>
          <div className="panel">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>Export data:</h3>
              <button className="btn sm" onClick={() => dl('json')}>JSON</button>
              <button className="btn sm" onClick={() => dl('xlsx')}>Excel (.xlsx)</button>
              <button className="btn sm" onClick={() => dl('sql')}>SQL INSERTs</button>
              <button className="btn sm" onClick={() => dl('mongo')}>Mongo insertMany</button>
              <button className="btn sm" onClick={() => dl('csv')} disabled={!previewTable}>CSV (current table)</button>
            </div>
          </div>

          <div className="panel">
            <div className="row" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Preview</h3>
              <select value={previewTable || ''} onChange={(e) => setPreviewTable(e.target.value)}>
                {Object.keys(data).map(n => <option key={n} value={n}>{n} ({data[n].length})</option>)}
              </select>
            </div>
            {rows && rows.length > 0 ? (
              <div style={{ overflow: 'auto', maxHeight: 420 }}>
                <table className="grid">
                  <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>
                    {rows.slice(0, 50).map((r, i) => (
                      <tr key={i}>{cols.map(c => <td key={c} title={fmt(r[c])}>{fmt(r[c])}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p style={{ color: 'var(--text-dim)' }}>No rows.</p>}
          </div>
        </>
      )}
    </div>
  );
}

const fmt = (v) => v == null ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v);
