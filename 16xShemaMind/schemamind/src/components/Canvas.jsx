import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useStore } from '../state/store.js';

const NODE_W = 220;
const HEAD_H = 33;
const ROW_H = 23;
const MAX_ROWS = 12;

function nodeHeight(t) {
  const rows = Math.min(t.fields.length, MAX_ROWS);
  const more = t.fields.length > MAX_ROWS ? 20 : 0;
  return HEAD_H + rows * ROW_H + more + 4;
}

export default function Canvas() {
  const project = useStore(s => s.project);
  const selectedTableId = useStore(s => s.selectedTableId);
  const selectedRelationId = useStore(s => s.selectedRelationId);
  const select = useStore(s => s.select);
  const selectRelation = useStore(s => s.selectRelation);
  const moveTable = useStore(s => s.moveTable);
  const addTable = useStore(s => s.addTable);
  const autoLayoutAll = useStore(s => s.autoLayoutAll);
  const mutate = useStore(s => s.mutate);

  const wrapRef = useRef(null);
  const [cam, setCam] = useState({ x: 0, y: 0, z: 1 });
  const dragRef = useRef(null); // { type: 'node'|'pan', ... }

  const toWorld = useCallback((cx, cy) => {
    const rect = wrapRef.current.getBoundingClientRect();
    return { x: (cx - rect.left - cam.x) / cam.z, y: (cy - rect.top - cam.y) / cam.z };
  }, [cam]);

  // ---- panning / node dragging ----
  const onPointerDown = (e) => {
    if (e.target.closest('.tnode')) return;
    dragRef.current = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: cam.x, oy: cam.y };
    wrapRef.current.classList.add('panning');
  };
  const startNodeDrag = (e, t) => {
    e.stopPropagation();
    select(t.id);
    const w = toWorld(e.clientX, e.clientY);
    dragRef.current = { type: 'node', id: t.id, dx: w.x - t.x, dy: w.y - t.y, moved: false };
  };

  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.type === 'pan') {
        setCam(c => ({ ...c, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
      } else if (d.type === 'node') {
        const w = toWorld(e.clientX, e.clientY);
        d.moved = true;
        moveTable(d.id, Math.round((w.x - d.dx) / 8) * 8, Math.round((w.y - d.dy) / 8) * 8, false);
      }
    };
    const up = () => {
      const d = dragRef.current;
      if (d?.type === 'node' && d.moved) {
        // commit with a history record (re-set same position, recorded)
        const t = useStore.getState().project.tables.find(t => t.id === d.id);
        if (t) moveTable(d.id, t.x, t.y, true);
      }
      dragRef.current = null;
      wrapRef.current?.classList.remove('panning');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [toWorld, moveTable]);

  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey) {
      const rect = wrapRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      setCam(c => {
        const z = Math.min(2.5, Math.max(0.25, c.z * (e.deltaY < 0 ? 1.1 : 0.9)));
        const k = z / c.z;
        return { x: mx - (mx - c.x) * k, y: my - (my - c.y) * k, z };
      });
    } else {
      setCam(c => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
    }
  };

  const zoomBy = (f) => setCam(c => ({ ...c, z: Math.min(2.5, Math.max(0.25, c.z * f)) }));
  const zoomFit = () => {
    if (!project.tables.length) { setCam({ x: 0, y: 0, z: 1 }); return; }
    const minX = Math.min(...project.tables.map(t => t.x)) - 60;
    const minY = Math.min(...project.tables.map(t => t.y)) - 60;
    const maxX = Math.max(...project.tables.map(t => t.x + NODE_W)) + 60;
    const maxY = Math.max(...project.tables.map(t => t.y + nodeHeight(t))) + 60;
    const rect = wrapRef.current.getBoundingClientRect();
    const z = Math.min(1.2, Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY)));
    setCam({ x: -minX * z + (rect.width - (maxX - minX) * z) / 2, y: -minY * z + (rect.height - (maxY - minY) * z) / 2, z });
  };

  const onDoubleClick = (e) => {
    if (e.target.closest('.tnode')) return;
    const w = toWorld(e.clientX, e.clientY);
    addTable({ x: Math.round(w.x / 8) * 8 - NODE_W / 2, y: Math.round(w.y / 8) * 8 - 20 });
  };

  // ---- edges ----
  const edges = project.relations.map(r => {
    const ft = project.tables.find(t => t.id === r.fromTable);
    const tt = project.tables.find(t => t.id === r.toTable);
    if (!ft || !tt) return null;
    const fIdx = Math.min(ft.fields.findIndex(f => f.id === r.fromField), MAX_ROWS - 1);
    const tIdx = Math.min(tt.fields.findIndex(f => f.id === r.toField), MAX_ROWS - 1);
    const fy = ft.y + HEAD_H + (Math.max(0, fIdx) + 0.5) * ROW_H;
    const ty = tt.y + HEAD_H + (Math.max(0, tIdx) + 0.5) * ROW_H;
    // choose sides
    const fromRight = tt.x > ft.x + NODE_W / 2;
    const x1 = fromRight ? ft.x + NODE_W : ft.x;
    const x2 = fromRight ? tt.x : tt.x + NODE_W;
    const c = Math.max(40, Math.abs(x2 - x1) / 2);
    const path = `M ${x1} ${fy} C ${x1 + (fromRight ? c : -c)} ${fy}, ${x2 + (fromRight ? -c : c)} ${ty}, ${x2} ${ty}`;
    const label = r.kind === 'one-one' ? '1:1' : r.kind === 'many-many' ? 'N:M' : 'N:1';
    return { r, path, mx: (x1 + x2) / 2, my: (fy + ty) / 2 - 6, label };
  }).filter(Boolean);

  const fkFieldIds = new Set(project.relations.map(r => r.fromField));

  return (
    <div className="canvas-wrap" ref={wrapRef} onPointerDown={onPointerDown} onWheel={onWheel}
      onDoubleClick={onDoubleClick} onClick={(e) => { if (!e.target.closest('.tnode') && !e.target.closest('path')) select(null); }}>

      <div className="canvas-toolbar">
        <button className="btn sm" onClick={() => addTable()}>+ Table</button>
        <button className="btn sm" onClick={autoLayoutAll} disabled={!project.tables.length}>Auto layout</button>
        <button className="btn sm" onClick={zoomFit} disabled={!project.tables.length}>Fit</button>
      </div>

      <div style={{ position: 'absolute', transformOrigin: '0 0', transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`, inset: 0 }}>
        <svg className="edges" width="1" height="1">
          {edges.map(({ r, path, mx, my, label }) => (
            <g key={r.id}>
              <path className={'edge' + (selectedRelationId === r.id ? ' sel' : '')} d={path}
                onClick={(e) => { e.stopPropagation(); selectRelation(r.id); }} style={{ pointerEvents: 'stroke' }} />
              <text x={mx} y={my} textAnchor="middle">{label}</text>
            </g>
          ))}
        </svg>

        {project.tables.map(t => (
          <div key={t.id} className={'tnode' + (t.id === selectedTableId ? ' sel' : '')}
            style={{ left: t.x, top: t.y, width: NODE_W }}
            onClick={(e) => { e.stopPropagation(); select(t.id); }}>
            <div className="thead" onPointerDown={(e) => startNodeDrag(e, t)}
              style={t.color ? { borderTop: `3px solid ${t.color}` } : undefined}>
              <span className="tname">{t.name}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 10 }}>{t.fields.length}</span>
            </div>
            {t.fields.slice(0, MAX_ROWS).map(f => (
              <div className="trow" key={f.id}>
                {f.pk && <span className="key pk">PK</span>}
                {!f.pk && fkFieldIds.has(f.id) && <span className="key fk">FK</span>}
                <span className="fname">{f.name}</span>
                <span className="ftype">{f.type}{!f.nullable && !f.pk ? '*' : ''}</span>
              </div>
            ))}
            {t.fields.length > MAX_ROWS && <div className="more">… {t.fields.length - MAX_ROWS} more fields</div>}
          </div>
        ))}
      </div>

      <div className="canvas-zoom">
        <button className="icon-btn" onClick={() => zoomBy(0.85)}>−</button>
        <span>{Math.round(cam.z * 100)}%</span>
        <button className="icon-btn" onClick={() => zoomBy(1.18)}>+</button>
      </div>
      <div className="canvas-hint">double-click canvas: new table · drag header: move · ⌘/ctrl+scroll: zoom</div>
    </div>
  );
}
