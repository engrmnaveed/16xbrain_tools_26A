import React, { useState } from 'react';
import { useStore } from '../state/store.js';
import { FIELD_TYPES, sanitizeName } from '../model/schema.js';
import { suggestFields, refineTableNote, hasAIKey } from '../ai/openrouter.js';

export default function Inspector() {
  const project = useStore(s => s.project);
  const selectedTableId = useStore(s => s.selectedTableId);
  const selectedRelationId = useStore(s => s.selectedRelationId);
  const table = project.tables.find(t => t.id === selectedTableId);
  const relation = project.relations.find(r => r.id === selectedRelationId);

  if (relation) return <RelationInspector relation={relation} />;
  if (!table) return null;
  return <TableInspector table={table} key={table.id} />;
}

function TableInspector({ table }) {
  const { updateTable, deleteTable, duplicateTable, addField, updateField, deleteField, moveField, addRelation, showToast, setAiBusy, aiBusy, project, mutate } = useStore();
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState(null);

  const onSuggest = async () => {
    if (!hasAIKey()) { showToast('Add your OpenRouter key in Settings → AI first.', 'error'); return; }
    setSuggesting(true); setAiBusy(true);
    try {
      const fields = await suggestFields(project, table);
      if (!fields.length) showToast('AI found nothing to add — table looks complete.', 'success');
      setSuggestions(fields.length ? fields : null);
    } catch (e) { showToast(e.message, 'error'); }
    finally { setSuggesting(false); setAiBusy(false); }
  };

  const acceptSuggestion = (f) => {
    addField(table.id, { ...f, id: undefined });
    setSuggestions(s => s ? s.filter(x => x !== f) : null);
  };

  const onAINote = async () => {
    if (!hasAIKey()) { showToast('Add your OpenRouter key in Settings → AI first.', 'error'); return; }
    setAiBusy(true);
    try {
      const note = await refineTableNote(project, table);
      updateTable(table.id, { note: note.trim() });
    } catch (e) { showToast(e.message, 'error'); }
    finally { setAiBusy(false); }
  };

  return (
    <div className="inspector">
      <div className="row">
        <input className="grow" type="text" value={table.name} style={{ fontWeight: 700, fontSize: 14 }}
          onChange={(e) => updateTable(table.id, { name: sanitizeName(e.target.value) })} />
        <button className="icon-btn" title="Duplicate table" onClick={() => duplicateTable(table.id)}>⧉</button>
        <button className="icon-btn danger" title="Delete table" onClick={() => deleteTable(table.id)}>✕</button>
      </div>

      <label className="lbl">Note</label>
      <div className="row">
        <textarea className="grow" rows={2} value={table.note} placeholder="What is this table for?"
          onChange={(e) => updateTable(table.id, { note: e.target.value })} />
        <button className="btn sm ai" title="Let AI describe this table" onClick={onAINote} disabled={aiBusy}>✦</button>
      </div>

      <div className="section-title">
        Fields ({table.fields.length})
        <span>
          <button className="btn sm ai" onClick={onSuggest} disabled={suggesting || aiBusy} title="AI-suggest missing fields">
            {suggesting ? <span className="spinner" /> : '✦ Suggest'}
          </button>{' '}
          <button className="btn sm" onClick={() => addField(table.id)}>+ Field</button>
        </span>
      </div>

      {suggestions && suggestions.length > 0 && (
        <div className="panel" style={{ padding: 10, borderColor: 'var(--accent2)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>AI suggestions — click ✓ to add</div>
          {suggestions.map((f, i) => (
            <div className="row" key={i} style={{ marginBottom: 4, fontSize: 12 }}>
              <span className="grow" style={{ fontFamily: 'var(--mono)' }}>
                {f.name} <span style={{ color: 'var(--text-faint)' }}>{f.type === 'enum' ? `enum(${f.enumValues.join(',')})` : f.type}</span>
              </span>
              <button className="icon-btn" style={{ color: 'var(--green)' }} onClick={() => acceptSuggestion(f)}>✓</button>
              <button className="icon-btn danger" onClick={() => setSuggestions(s => s.filter(x => x !== f))}>✕</button>
            </div>
          ))}
        </div>
      )}

      {table.fields.map((f, idx) => (
        <FieldCard key={f.id} f={f} table={table} idx={idx}
          onChange={(patch) => updateField(table.id, f.id, patch)}
          onDelete={() => deleteField(table.id, f.id)}
          onMove={(dir) => moveField(table.id, f.id, dir)} />
      ))}

      <div className="section-title">Add relation</div>
      <AddRelation table={table} />
    </div>
  );
}

function FieldCard({ f, table, idx, onChange, onDelete, onMove }) {
  const flag = (key, extra) => (
    <button className={'flag' + (f[key] ? (key === 'pk' ? ' pkon' : ' on') : '')}
      onClick={() => onChange({ [key]: !f[key], ...(key === 'pk' && !f.pk ? { nullable: false } : {}) })}>{extra || key}</button>
  );
  return (
    <div className="field-card">
      <div className="frow1">
        <input className="fname" type="text" value={f.name} onChange={(e) => onChange({ name: sanitizeName(e.target.value) })} />
        <select value={f.type} onChange={(e) => onChange({ type: e.target.value })}>
          {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button className="icon-btn" onClick={() => onMove(-1)} disabled={idx === 0} title="Move up">↑</button>
        <button className="icon-btn" onClick={() => onMove(1)} title="Move down">↓</button>
        <button className="icon-btn danger" onClick={onDelete} title="Delete field">✕</button>
      </div>
      <div className="flags">
        {flag('pk', 'PK')}
        {flag('unique')}
        <button className={'flag' + (!f.nullable ? ' on' : '')} onClick={() => onChange({ nullable: !f.nullable })}>required</button>
        {flag('indexed', 'index')}
      </div>
      <div className="field-extra">
        <input type="text" placeholder="default (now / uuid / autoincrement / literal)" value={f.default ?? ''}
          onChange={(e) => onChange({ default: e.target.value || null })} />
      </div>
      {f.type === 'enum' && (
        <div className="field-extra">
          <input type="text" placeholder="enum values, comma-separated" value={f.enumValues.join(', ')}
            onChange={(e) => onChange({ enumValues: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
        </div>
      )}
    </div>
  );
}

function AddRelation({ table }) {
  const { project, addRelation, showToast } = useStore();
  const [toTableId, setToTableId] = useState('');
  const [fromFieldId, setFromFieldId] = useState('');
  const [kind, setKind] = useState('one-many');
  const other = project.tables.filter(t => t.id !== table.id);
  const target = project.tables.find(t => t.id === toTableId);
  const targetPk = target?.fields.find(f => f.pk);

  const create = () => {
    if (!target || !targetPk) { showToast('Pick a target table with a primary key.', 'error'); return; }
    let ff = table.fields.find(f => f.id === fromFieldId);
    addRelation({
      fromTable: table.id, fromField: ff ? ff.id : null,
      toTable: target.id, toField: targetPk.id, kind
    });
    if (!ff) {
      // auto-create FK field then rewire the just-created relation
      const st = useStore.getState();
      st.mutate(p => {
        const t = p.tables.find(t => t.id === table.id);
        const fk = { id: 'f_' + Math.random().toString(36).slice(2, 10), name: `${target.name.replace(/s$/, '')}_id`, type: targetPk.type, pk: false, unique: kind === 'one-one', nullable: false, indexed: true, default: null, enumValues: [], note: '' };
        t.fields.push(fk);
        const r = p.relations[p.relations.length - 1];
        r.fromField = fk.id;
      });
    }
    showToast(`Relation ${table.name} → ${target.name} added.`, 'success');
  };

  return (
    <div className="panel" style={{ padding: 10 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <select className="grow" value={fromFieldId} onChange={(e) => setFromFieldId(e.target.value)}>
          <option value="">＋ auto-create FK field</option>
          {table.fields.filter(f => !f.pk).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="one-many">N : 1</option>
          <option value="one-one">1 : 1</option>
          <option value="many-many">N : M</option>
        </select>
      </div>
      <div className="row">
        <select className="grow" value={toTableId} onChange={(e) => setToTableId(e.target.value)}>
          <option value="">→ target table…</option>
          {other.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="btn sm primary" onClick={create} disabled={!toTableId}>Link</button>
      </div>
    </div>
  );
}

function RelationInspector({ relation }) {
  const { project, updateRelation, deleteRelation } = useStore();
  const ft = project.tables.find(t => t.id === relation.fromTable);
  const tt = project.tables.find(t => t.id === relation.toTable);
  const ff = ft?.fields.find(f => f.id === relation.fromField);
  const tf = tt?.fields.find(f => f.id === relation.toField);

  return (
    <div className="inspector">
      <h2>Relation</h2>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)', margin: '6px 0 12px' }}>
        {ft?.name}.{ff?.name} → {tt?.name}.{tf?.name}
      </p>
      <label className="lbl">Cardinality</label>
      <select value={relation.kind} onChange={(e) => updateRelation(relation.id, { kind: e.target.value })}>
        <option value="one-many">many-to-one (N:1)</option>
        <option value="one-one">one-to-one (1:1)</option>
        <option value="many-many">many-to-many (N:M)</option>
      </select>
      <label className="lbl">On delete</label>
      <select value={relation.onDelete} onChange={(e) => updateRelation(relation.id, { onDelete: e.target.value })}>
        <option value="cascade">cascade</option>
        <option value="restrict">restrict</option>
        <option value="set null">set null</option>
      </select>
      <div style={{ marginTop: 16 }}>
        <button className="btn danger" onClick={() => deleteRelation(relation.id)}>Delete relation</button>
      </div>
    </div>
  );
}
