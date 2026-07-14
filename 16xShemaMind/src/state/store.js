import { create } from 'zustand';
import { createProject, createTable, createField, createRelation, autoLayout } from '../model/schema.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const MAX_HISTORY = 100;

export const useStore = create((set, get) => ({
  project: createProject(),
  filePath: null,
  dirty: false,
  selectedTableId: null,
  selectedRelationId: null,
  view: 'canvas',            // canvas | script | data | json | docs | settings
  modal: null,               // { type: 'import'|'export'|'ai-review'|..., props }
  toast: null,
  aiBusy: false,
  past: [],
  future: [],

  // ---- history-wrapped mutation ----
  mutate(fn, { record = true } = {}) {
    const { project, past } = get();
    const next = clone(project);
    fn(next);
    next.meta.updatedAt = new Date().toISOString();
    set({
      project: next,
      dirty: true,
      ...(record ? { past: [...past.slice(-MAX_HISTORY), clone(project)], future: [] } : {})
    });
  },

  undo() {
    const { past, future, project } = get();
    if (!past.length) return;
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [clone(project), ...future], dirty: true });
  },
  redo() {
    const { past, future, project } = get();
    if (!future.length) return;
    set({ project: future[0], future: future.slice(1), past: [...past, clone(project)], dirty: true });
  },

  // ---- project lifecycle ----
  newProject(name) {
    set({ project: createProject(name), filePath: null, dirty: false, past: [], future: [], selectedTableId: null, selectedRelationId: null });
  },
  loadProject(data, filePath = null) {
    set({ project: data, filePath, dirty: false, past: [], future: [], selectedTableId: null, selectedRelationId: null });
  },
  replaceSchema(tables, relations, { merge = false } = {}) {
    get().mutate(p => {
      if (merge) {
        p.tables.push(...tables);
        p.relations.push(...relations);
      } else {
        p.tables = tables;
        p.relations = relations;
      }
      autoLayout(p);
    });
  },
  setFilePath(fp) { set({ filePath: fp, dirty: false }); },
  markSaved() { set({ dirty: false }); },

  // ---- table / field / relation ops ----
  addTable(partial = {}) {
    let id = null;
    get().mutate(p => {
      const t = createTable({ x: 120 + (p.tables.length % 5) * 60, y: 100 + (p.tables.length % 7) * 50, ...partial });
      t.name = uniqueName(p, partial.name || 'new_table');
      p.tables.push(t);
      id = t.id;
    });
    set({ selectedTableId: id, selectedRelationId: null });
    return id;
  },
  updateTable(tableId, patch) {
    get().mutate(p => { const t = p.tables.find(t => t.id === tableId); if (t) Object.assign(t, patch); });
  },
  moveTable(tableId, x, y, record = false) {
    get().mutate(p => { const t = p.tables.find(t => t.id === tableId); if (t) { t.x = x; t.y = y; } }, { record });
  },
  deleteTable(tableId) {
    get().mutate(p => {
      p.tables = p.tables.filter(t => t.id !== tableId);
      p.relations = p.relations.filter(r => r.fromTable !== tableId && r.toTable !== tableId);
    });
    set({ selectedTableId: null });
  },
  duplicateTable(tableId) {
    get().mutate(p => {
      const t = p.tables.find(t => t.id === tableId);
      if (!t) return;
      const copy = clone(t);
      copy.id = createTable().id;
      copy.name = uniqueName(p, t.name + '_copy');
      copy.x += 40; copy.y += 40;
      copy.fields = copy.fields.map(f => ({ ...f, id: createField().id }));
      p.tables.push(copy);
    });
  },

  addField(tableId, partial = {}) {
    get().mutate(p => {
      const t = p.tables.find(t => t.id === tableId);
      if (t) t.fields.push(createField({ name: `field_${t.fields.length + 1}`, ...partial }));
    });
  },
  updateField(tableId, fieldId, patch) {
    get().mutate(p => {
      const t = p.tables.find(t => t.id === tableId);
      const f = t && t.fields.find(f => f.id === fieldId);
      if (f) Object.assign(f, patch);
    });
  },
  deleteField(tableId, fieldId) {
    get().mutate(p => {
      const t = p.tables.find(t => t.id === tableId);
      if (t) t.fields = t.fields.filter(f => f.id !== fieldId);
      p.relations = p.relations.filter(r => r.fromField !== fieldId && r.toField !== fieldId);
    });
  },
  moveField(tableId, fieldId, dir) {
    get().mutate(p => {
      const t = p.tables.find(t => t.id === tableId);
      if (!t) return;
      const i = t.fields.findIndex(f => f.id === fieldId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= t.fields.length) return;
      [t.fields[i], t.fields[j]] = [t.fields[j], t.fields[i]];
    });
  },

  addRelation(partial) {
    get().mutate(p => { p.relations.push(createRelation(partial)); });
  },
  updateRelation(relId, patch) {
    get().mutate(p => { const r = p.relations.find(r => r.id === relId); if (r) Object.assign(r, patch); });
  },
  deleteRelation(relId) {
    get().mutate(p => { p.relations = p.relations.filter(r => r.id !== relId); });
    set({ selectedRelationId: null });
  },

  autoLayoutAll() { get().mutate(p => autoLayout(p)); },

  // ---- UI ----
  select(tableId) { set({ selectedTableId: tableId, selectedRelationId: null }); },
  selectRelation(relId) { set({ selectedRelationId: relId, selectedTableId: null }); },
  setView(view) { set({ view }); },
  openModal(type, props = {}) { set({ modal: { type, props } }); },
  closeModal() { set({ modal: null }); },
  setAiBusy(b) { set({ aiBusy: b }); },
  showToast(message, kind = 'info') {
    set({ toast: { message, kind, ts: Date.now() } });
    setTimeout(() => { if (get().toast && Date.now() - get().toast.ts >= 3800) set({ toast: null }); }, 4000);
  }
}));

function uniqueName(project, base) {
  let name = base, i = 2;
  const has = (n) => project.tables.some(t => t.name.toLowerCase() === n.toLowerCase());
  while (has(name)) name = `${base}_${i++}`;
  return name;
}
