// ---------------------------------------------------------------------------
// 16xDataFlux — Layout Engine
// Computes per-mode positions for every source table so the canvas can
// CSS-transition ("morph") cards between SQL / Document / Graph views.
// ---------------------------------------------------------------------------

export const CARD_W = 250;
const HEADER_H = 40;
const ROW_H = 21;
const MAX_ROWS = 9;

export function cardHeight(table) {
  return HEADER_H + Math.min(table.columns.length, MAX_ROWS) * ROW_H + 12;
}
export function docCardHeight(collection) {
  return HEADER_H + Math.min(collection.fields.length, MAX_ROWS + 2) * ROW_H + 12;
}

/** Order tables: referenced-most first, junctions last */
function orderTables(schema) {
  const inDeg = new Map();
  for (const r of schema.relationships) inDeg.set(r.to, (inDeg.get(r.to) || 0) + 1);
  return [...schema.tables].sort((a, b) => {
    if (!!a.junction !== !!b.junction) return a.junction ? 1 : -1;
    return (inDeg.get(b.name) || 0) - (inDeg.get(a.name) || 0);
  });
}

/** SQL mode: masonry grid */
export function sqlLayout(schema) {
  const pos = new Map();
  const cols = Math.max(2, Math.min(4, Math.ceil(Math.sqrt(schema.tables.length))));
  const gapX = 70;
  const gapY = 46;
  const colHeights = new Array(cols).fill(30);
  for (const t of orderTables(schema)) {
    const ci = colHeights.indexOf(Math.min(...colHeights));
    const x = 40 + ci * (CARD_W + gapX);
    const y = colHeights[ci];
    pos.set(t.name, { x, y, scale: 1, opacity: 1, mode: 'sql' });
    colHeights[ci] += cardHeight(t) + gapY;
  }
  return { positions: pos, width: 40 + cols * (CARD_W + gapX), height: Math.max(...colHeights) + 40 };
}

/** Document mode: collections in grid; embedded/dissolved tables collapse into parents */
export function docLayout(schema, docModel) {
  const pos = new Map();
  const cols = Math.max(2, Math.min(3, Math.ceil(Math.sqrt(docModel.collections.length))));
  const gapX = 110;
  const gapY = 70;
  const colHeights = new Array(cols).fill(30);
  const collectionPos = new Map();

  for (const col of docModel.collections) {
    const ci = colHeights.indexOf(Math.min(...colHeights));
    const x = 60 + ci * (CARD_W + 40 + gapX);
    const y = colHeights[ci];
    collectionPos.set(col.name, { x, y });
    pos.set(col.sourceTable, { x, y, scale: 1, opacity: 1, mode: 'doc' });
    colHeights[ci] += docCardHeight(col) + gapY;
  }

  // Absorbed tables fly into their host collection and shrink away
  for (const t of schema.tables) {
    if (pos.has(t.name)) continue;
    let host = docModel.embeddedInto.get(t.name);
    // Walk up if host itself was embedded
    let guard = 0;
    while (host && !collectionPos.has(host) && guard++ < 10) {
      host = docModel.embeddedInto.get(host);
    }
    const hp = (host && collectionPos.get(host)) || { x: 60, y: 30 };
    pos.set(t.name, { x: hp.x + 40, y: hp.y + 60, scale: 0.12, opacity: 0, mode: 'doc', absorbedBy: host });
  }

  return {
    positions: pos,
    width: 60 + cols * (CARD_W + 40 + gapX),
    height: Math.max(...colHeights) + 40
  };
}

/** Graph mode: entity tables on a ring, junction tables become edge pills at midpoints */
export function graphLayout(schema, graphModel) {
  const pos = new Map();
  const entities = schema.tables.filter((t) => !t.junction);
  const n = Math.max(entities.length, 1);
  const R = Math.max(240, n * 62);
  const cx = R + 180;
  const cy = R + 120;
  const nodeCenter = new Map();

  entities.forEach((t, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = cx + R * Math.cos(angle) - 90;
    const y = cy + R * Math.sin(angle) - 45;
    pos.set(t.name, { x, y, scale: 1, opacity: 1, mode: 'graph' });
    nodeCenter.set(t.name, { x: x + 90, y: y + 45 });
  });

  // Junction tables morph into pills sitting on the midpoint of their edge
  for (const t of schema.tables) {
    if (!t.junction) continue;
    const fks = t.columns.filter((c) => c.fk);
    const a = nodeCenter.get(fks[0]?.fk.table);
    const b = nodeCenter.get(fks[1]?.fk.table);
    if (a && b) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      pos.set(t.name, { x: mx - 80, y: my - 20, scale: 1, opacity: 1, mode: 'graph', asEdge: true });
    } else {
      pos.set(t.name, { x: cx - 80, y: cy - 20, scale: 0.2, opacity: 0, mode: 'graph', asEdge: true });
    }
  }

  return { positions: pos, width: cx + R + 300, height: cy + R + 180, nodeCenter };
}

/** Edge list per mode, expressed between source table names */
export function edgesForMode(mode, schema, docModel, graphModel) {
  if (mode === 'sql') {
    return schema.relationships.map((r) => ({
      from: r.from, to: r.to, label: `${r.fromColumn} ⇒ ${r.toColumn}`,
      kind: 'fk', joinCost: true
    }));
  }
  if (mode === 'doc') {
    return docModel.remainingRefs.map((r) => ({
      from: r.from, to: r.to, label: 'ref', kind: 'ref', joinCost: false
    }));
  }
  // graph
  return graphModel.edges
    .filter((e) => !e.firstClass)
    .map((e) => ({
      from: e.fromTable, to: e.toTable, label: `:${e.type}`, kind: 'edge', joinCost: false
    }));
}
