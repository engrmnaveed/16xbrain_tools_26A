import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { sqlLayout, docLayout, graphLayout, edgesForMode, cardHeight, CARD_W } from '../lib/layout.js';

const MODE_LABEL = { sql: 'RELATIONAL', doc: 'DOCUMENT', graph: 'GRAPH' };

function CardRows({ table, mode, docModel, graphModel }) {
  if (mode === 'doc') {
    const col = docModel.collections.find((c) => c.sourceTable === table.name);
    if (col) {
      const rows = col.fields.slice(0, 11);
      return (
        <div className="card-rows">
          {rows.map((f, i) => (
            <div className="card-row" key={i}>
              {f.type === 'ObjectId' && <span className="badge pk">_id</span>}
              {f.type.startsWith('ref') && <span className="badge fk">REF</span>}
              {f.type.startsWith('array<ref') && <span className="badge arr">[ ]REF</span>}
              {f.type === 'array<sub-document>' && <span className="badge arr">[{'{}'}]</span>}
              {f.type === 'sub-document' && <span className="badge sub">{'{}'}</span>}
              <span className="cname">{f.name}</span>
              <span className="ctype">{f.embedded ? `⇐ ${f.embedded}` : f.dissolvedFrom ? `⇐ ${f.dissolvedFrom}` : f.type}</span>
            </div>
          ))}
          {col.fields.length > 11 && <div className="card-more">+{col.fields.length - 11} more…</div>}
        </div>
      );
    }
  }
  if (mode === 'graph') {
    const node = graphModel.nodes.find((n) => n.sourceTable === table.name);
    if (node) {
      const rows = node.properties.slice(0, 9);
      return (
        <div className="card-rows">
          {rows.map((p, i) => (
            <div className="card-row" key={i}>
              {p.pk && <span className="badge pk">KEY</span>}
              {p.unique && !p.pk && <span className="badge warn">UNQ</span>}
              <span className="cname">{p.name}</span>
              <span className="ctype">{p.type.split('(')[0].toLowerCase()}</span>
            </div>
          ))}
          {node.properties.length > 9 && <div className="card-more">+{node.properties.length - 9} more…</div>}
        </div>
      );
    }
  }
  // sql (default)
  const rows = table.columns.slice(0, 9);
  return (
    <div className="card-rows">
      {rows.map((c, i) => (
        <div className="card-row" key={i}>
          {c.pk && <span className="badge pk">PK</span>}
          {c.fk && <span className="badge fk">FK</span>}
          <span className="cname">{c.name}</span>
          <span className="ctype">{c.type.split('(')[0]}</span>
        </div>
      ))}
      {table.columns.length > 9 && <div className="card-more">+{table.columns.length - 9} more…</div>}
    </div>
  );
}

function cardTitle(table, mode, docModel, graphModel) {
  if (mode === 'doc') {
    const col = docModel.collections.find((c) => c.sourceTable === table.name);
    if (col) return { title: col.name, kind: 'collection' };
    return { title: table.name, kind: 'absorbed' };
  }
  if (mode === 'graph') {
    const node = graphModel.nodes.find((n) => n.sourceTable === table.name);
    if (node) return { title: `(:${node.label})`, kind: 'node' };
    return { title: table.name, kind: 'edge' };
  }
  return { title: table.name, kind: table.junction ? 'junction' : 'table' };
}

export default function Canvas({ schema, docModel, graphModel, mode, selected, onSelect, report }) {
  const [zoom, setZoom] = useState(0.85);
  const [pan, setPan] = useState({ x: 20, y: 10 });
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const layouts = useMemo(() => {
    if (!schema) return null;
    return {
      sql: sqlLayout(schema),
      doc: docLayout(schema, docModel),
      graph: graphLayout(schema, graphModel)
    };
  }, [schema, docModel, graphModel]);

  const layout = layouts?.[mode];
  const edges = useMemo(
    () => (schema ? edgesForMode(mode, schema, docModel, graphModel) : []),
    [schema, docModel, graphModel, mode]
  );

  // fit on new schema
  useEffect(() => {
    if (!layout) return;
    setZoom(0.8);
    setPan({ x: 20, y: 10 });
  }, [schema]); // eslint-disable-line

  const onMouseDown = useCallback((e) => {
    if (e.target.closest('.table-card') || e.target.closest('.graph-pill')) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
  }, [pan]);

  useEffect(() => {
    const move = (e) => {
      if (!dragRef.current) return;
      setPan({
        x: dragRef.current.px + (e.clientX - dragRef.current.sx),
        y: dragRef.current.py + (e.clientY - dragRef.current.sy)
      });
    };
    const up = () => { dragRef.current = null; setDragging(false); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  const onWheel = useCallback((e) => {
    const delta = e.deltaY > 0 ? -0.07 : 0.07;
    setZoom((z) => Math.min(1.6, Math.max(0.25, +(z + delta).toFixed(2))));
  }, []);

  if (!schema || !layout) {
    return (
      <div className="canvas-wrap">
        <div className="empty-state">
          <div className="big">⛁</div>
          <h2>No schema loaded</h2>
          <p>
            Pick a preset from the sidebar, paste your own <b>CREATE TABLE</b> DDL,
            or describe a domain and let AI generate a legacy schema for you.
            Then hit <b>Analyze & Morph</b>.
          </p>
        </div>
      </div>
    );
  }

  const centers = new Map();
  for (const t of schema.tables) {
    const p = layout.positions.get(t.name);
    if (!p) continue;
    centers.set(t.name, { x: p.x + CARD_W / 2, y: p.y + cardHeight(t) / 2, p });
  }

  const bannerText = {
    sql: <>Legacy <b className="sql">RELATIONAL</b> schema — every arrow is a JOIN paid at query time</>,
    doc: <>Morphed to <b className="doc">DOCUMENT</b> model — {report ? `${report.eliminated} of ${report.totalJoins}` : ''} JOINs eliminated by embedding</>,
    graph: <>Morphed to <b className="graph">GRAPH</b> model — JOINs replaced by index-free traversals</>
  }[mode];

  return (
    <div className="canvas-wrap">
      <div className="morph-banner">{bannerText}</div>
      <div
        className={`canvas-viewport ${dragging ? 'dragging' : ''}`}
        onMouseDown={onMouseDown}
        onWheel={onWheel}
      >
        <div
          className="canvas-inner"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <svg className="edge-svg" width={layout.width + 400} height={layout.height + 400}>
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </marker>
            </defs>
            {edges.map((e, i) => {
              const a = centers.get(e.from);
              const b = centers.get(e.to);
              if (!a || !b) return null;
              const hidden = a.p.opacity === 0 || b.p.opacity === 0;
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2 - Math.min(60, Math.abs(a.x - b.x) * 0.12 + 18);
              const color = e.kind === 'fk' ? 'rgba(245,158,11,0.55)' : e.kind === 'ref' ? 'rgba(56,189,248,0.5)' : 'rgba(139,92,246,0.6)';
              return (
                <g key={`${e.from}-${e.to}-${i}`} style={{ color, opacity: hidden ? 0 : 1, transition: 'opacity .6s' }}>
                  <path
                    className="edge-path"
                    d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
                    stroke={color}
                    markerEnd="url(#arr)"
                    strokeDasharray={e.kind === 'ref' ? '5 4' : undefined}
                  />
                  <text className={`edge-label ${e.joinCost ? 'edge-cost' : ''}`} x={mx} y={my + 12} textAnchor="middle">
                    {e.joinCost ? `⚠ JOIN · ${e.label}` : e.label}
                  </text>
                </g>
              );
            })}
          </svg>

          {schema.tables.map((t) => {
            const p = layout.positions.get(t.name);
            if (!p) return null;
            const { title, kind } = cardTitle(t, mode, docModel, graphModel);

            if (mode === 'graph' && p.asEdge) {
              const edge = graphModel.edges.find((e) => e.sourceTable === t.name);
              return (
                <div
                  key={t.name}
                  className="graph-pill"
                  style={{ transform: `translate(${p.x}px, ${p.y}px)`, opacity: p.opacity }}
                  onClick={() => onSelect(t.name)}
                  title={`Was junction table "${t.name}" — now a first-class relationship`}
                >
                  ─[:{edge ? edge.type : t.name.toUpperCase()}]→
                </div>
              );
            }

            return (
              <div
                key={t.name}
                className={`table-card mode-${mode} ${selected === t.name ? 'selected' : ''} ${p.opacity === 0 ? 'absorbed' : ''}`}
                style={{
                  transform: `translate(${p.x}px, ${p.y}px) scale(${p.scale})`,
                  opacity: p.opacity
                }}
                onClick={() => onSelect(t.name)}
              >
                <div className="card-head">
                  <span>{mode === 'doc' ? `📄 ${title}` : mode === 'graph' ? `⬡ ${title}` : `▦ ${title}`}</span>
                  <span className="kind">{kind}</span>
                </div>
                <CardRows table={t} mode={mode} docModel={docModel} graphModel={graphModel} />
              </div>
            );
          })}
        </div>
      </div>

      <div className="canvas-hud">
        {report && (
          <>
            <div className="hud-chip">JOINs: <b>{mode === 'sql' ? report.totalJoins : report.remaining}</b>{mode !== 'sql' && <span className="up">▼ {report.eliminationPct}%</span>}</div>
            <div className="hud-chip">Reads per page: <b>{report.readAmplification[mode === 'sql' ? 'sql' : mode === 'doc' ? 'document' : 'graph']}</b></div>
            <div className="hud-chip">{mode === 'sql' ? `${schema.tables.length} tables` : mode === 'doc' ? `${docModel.collections.length} collections` : `${graphModel.nodes.length} labels · ${graphModel.edges.length} edge types`}</div>
          </>
        )}
      </div>
      <div className="zoom-ctl">
        <button onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.1).toFixed(2)))}>−</button>
        <button onClick={() => { setZoom(0.8); setPan({ x: 20, y: 10 }); }} title="Reset view">⌂</button>
        <button onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}>+</button>
      </div>
    </div>
  );
}
