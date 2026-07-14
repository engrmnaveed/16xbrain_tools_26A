import React, { useState, useMemo } from 'react';
import { useStore } from '../state/store.js';
import { importSQL, importJSON, importCSV } from '../io/importers.js';
import { importExcel, exportSchemaWorkbook } from '../io/excel.js';
import { parseScript } from '../dsl/parser.js';
import { EXPORT_FORMATS } from '../io/exporters.js';
import { openTextFile, saveTextFile, saveBase64File } from '../io/fileBridge.js';

export function ModalRoot() {
  const modal = useStore(s => s.modal);
  if (!modal) return null;
  const M = { import: ImportModal, export: ExportModal, 'ai-review': AiReviewModal, 'ai-docs': AiDocsModal }[modal.type];
  return M ? <M {...modal.props} /> : null;
}

function Modal({ title, children, footer, wide }) {
  const closeModal = useStore(s => s.closeModal);
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      <div className="modal" style={wide ? { width: 900 } : undefined}>
        <div className="mhead"><h2>{title}</h2><button className="icon-btn" onClick={closeModal}>✕</button></div>
        <div className="mbody">{children}</div>
        {footer && <div className="mfoot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------- Import ----------------
const IMPORT_KINDS = [
  { id: 'sql', label: 'SQL DDL (Postgres / MySQL / SQLite)', exts: ['sql', 'txt'], hint: 'Paste or open CREATE TABLE statements. Foreign keys become relations.' },
  { id: 'json', label: 'JSON sample → inferred schema', exts: ['json'], hint: 'Nested objects/arrays become related tables with FKs.' },
  { id: 'csv', label: 'CSV → table from headers', exts: ['csv'], hint: 'Column types are inferred from up to 25 sample rows.' },
  { id: 'xlsx', label: 'Excel workbook → tables', exts: ['xlsx', 'xls'], hint: 'Each worksheet becomes a table; cell types are inferred.' },
  { id: 'dsl', label: 'SchemaScript / DBML-like text', exts: ['txt', 'dbml', 'schema'], hint: 'SchemaMind’s own plain-text format.' },
  { id: 'project', label: 'SchemaMind project (.schemamind.json)', exts: ['json'], hint: 'A full project file including layout.' }
];

function ImportModal() {
  const { replaceSchema, loadProject, closeModal, showToast } = useStore();
  const [kind, setKind] = useState('sql');
  const [text, setText] = useState('');
  const [merge, setMerge] = useState(true);
  const [excelB64, setExcelB64] = useState(null);
  const [fileName, setFileName] = useState(null);
  const k = IMPORT_KINDS.find(x => x.id === kind);

  const openFile = async () => {
    const f = await openTextFile([{ name: k.label, extensions: k.exts }]);
    if (!f) return;
    setFileName(f.name);
    if (f.encoding === 'base64') { setExcelB64(f.content); setText(`(binary: ${f.name})`); }
    else { setText(f.content); setExcelB64(null); }
  };

  const run = () => {
    try {
      if (kind === 'project') {
        const data = JSON.parse(text);
        if (!data.meta || !Array.isArray(data.tables)) throw new Error('Not a SchemaMind project file.');
        loadProject(data);
        closeModal();
        showToast(`Project "${data.meta.name}" loaded.`, 'success');
        return;
      }
      let fragment;
      if (kind === 'sql') fragment = importSQL(text);
      else if (kind === 'json') fragment = importJSON(text, (fileName || 'imported').replace(/\.\w+$/, ''));
      else if (kind === 'csv') fragment = importCSV(text, (fileName || 'imported').replace(/\.\w+$/, ''));
      else if (kind === 'xlsx') {
        if (!excelB64) throw new Error('Open an .xlsx file first.');
        fragment = importExcel(excelB64);
      }
      else if (kind === 'dsl') fragment = parseScript(text);
      replaceSchema(fragment.tables, fragment.relations, { merge });
      closeModal();
      showToast(`Imported ${fragment.tables.length} table(s), ${fragment.relations.length} relation(s).`, 'success');
    } catch (e) { showToast(e.message, 'error'); }
  };

  return (
    <Modal title="Import" footer={<>
      <label className="checkbox-row" style={{ marginRight: 'auto' }}>
        <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} /> merge into current schema
      </label>
      <button className="btn" onClick={openFile}>Open file…</button>
      <button className="btn primary" onClick={run} disabled={!text.trim()}>Import</button>
    </>}>
      <label className="lbl">Format</label>
      <select value={kind} onChange={(e) => { setKind(e.target.value); setExcelB64(null); }} style={{ width: '100%' }}>
        {IMPORT_KINDS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '8px 0' }}>{k.hint}</p>
      <textarea rows={12} style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }}
        placeholder={kind === 'xlsx' ? 'Use "Open file…" for Excel workbooks.' : 'Paste content here, or use "Open file…"'}
        value={text} onChange={(e) => setText(e.target.value)} readOnly={kind === 'xlsx'} />
    </Modal>
  );
}

// ---------------- Export ----------------
function ExportModal() {
  const { project, showToast, closeModal } = useStore();
  const [formatId, setFormatId] = useState('sql-postgres');
  const fmt = EXPORT_FORMATS.find(f => f.id === formatId);
  const preview = useMemo(() => {
    try { return fmt.fn(project); } catch (e) { return `Error: ${e.message}`; }
  }, [formatId, project]);

  const save = async () => {
    try {
      const name = `${project.meta.name.replace(/\s+/g, '-').toLowerCase()}.${fmt.ext}`;
      await saveTextFile(name, preview, [{ name: fmt.label, extensions: [fmt.ext] }]);
      showToast('Exported.', 'success');
    } catch (e) { if (e.message !== 'cancelled') showToast(e.message, 'error'); }
  };

  const saveExcel = async () => {
    try {
      await saveBase64File(`${project.meta.name.replace(/\s+/g, '-').toLowerCase()}-dictionary.xlsx`, exportSchemaWorkbook(project));
      showToast('Excel data dictionary exported.', 'success');
    } catch (e) { if (e.message !== 'cancelled') showToast(e.message, 'error'); }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(preview);
    showToast('Copied to clipboard.', 'success');
  };

  return (
    <Modal title="Export schema" wide footer={<>
      <button className="btn" onClick={saveExcel} style={{ marginRight: 'auto' }}>Excel data dictionary (.xlsx)</button>
      <button className="btn" onClick={copy}>Copy</button>
      <button className="btn primary" onClick={save}>Save file…</button>
    </>}>
      <label className="lbl">Format</label>
      <select value={formatId} onChange={(e) => setFormatId(e.target.value)} style={{ width: '100%' }}>
        {EXPORT_FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
      <label className="lbl">Preview</label>
      <pre className="code" style={{ maxHeight: '48vh' }}>{preview}</pre>
    </Modal>
  );
}

// ---------------- AI review ----------------
function AiReviewModal({ review }) {
  const { closeModal, select, project } = useStore();
  const color = review.score >= 80 ? 'var(--green)' : review.score >= 55 ? 'var(--amber)' : 'var(--red)';
  return (
    <Modal title="✦ AI schema review" footer={<button className="btn primary" onClick={closeModal}>Done</button>}>
      <div className="row" style={{ gap: 16, marginBottom: 12 }}>
        <span className="score-ring" style={{ color }}>{review.score}<span style={{ fontSize: 13, color: 'var(--text-faint)' }}>/100</span></span>
        <p style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.5 }}>{review.summary}</p>
      </div>
      {(review.findings || []).map((f, i) => (
        <div className="finding" key={i}>
          <span className={`sev ${f.severity}`}>{f.severity}</span>
          <div>
            <div style={{ fontSize: 12.5 }}>
              {f.table && <a href="#" style={{ color: 'var(--accent)', marginRight: 6 }}
                onClick={(e) => { e.preventDefault(); const t = project.tables.find(t => t.name === f.table); if (t) { select(t.id); closeModal(); } }}>{f.table}</a>}
              {f.issue}
            </div>
            {f.fix && <div className="fix">→ {f.fix}</div>}
          </div>
        </div>
      ))}
    </Modal>
  );
}

// ---------------- AI docs ----------------
function AiDocsModal({ markdown }) {
  const { closeModal, showToast, project } = useStore();
  const save = async () => {
    try {
      await saveTextFile(`${project.meta.name.replace(/\s+/g, '-').toLowerCase()}-docs.md`, markdown);
      showToast('Documentation saved.', 'success');
    } catch (e) { if (e.message !== 'cancelled') showToast(e.message, 'error'); }
  };
  return (
    <Modal title="✦ AI-generated documentation" wide footer={<>
      <button className="btn" onClick={() => { navigator.clipboard.writeText(markdown); showToast('Copied.', 'success'); }}>Copy Markdown</button>
      <button className="btn primary" onClick={save}>Save .md…</button>
    </>}>
      <pre className="code" style={{ maxHeight: '55vh', whiteSpace: 'pre-wrap' }}>{markdown}</pre>
    </Modal>
  );
}
