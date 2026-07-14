// ---------------------------------------------------------------------------
// 16xDataFlux — SQL → Graph (Property Graph) Transformation Engine
// Entity tables → node labels; FK relationships → typed edges;
// junction tables → first-class edges (with properties). Cypher-flavoured.
// ---------------------------------------------------------------------------

function toLabel(name) {
  return name
    .replace(/ies$/, 'y')
    .replace(/s$/, '')
    .replace(/(^|_)([a-z])/g, (_, __, ch) => ch.toUpperCase());
}

function relVerb(fromTable, column) {
  const base = column.replace(/_id$/, '').toUpperCase();
  const map = {
    CUSTOMER: 'PLACED_BY', AUTHOR: 'AUTHORED_BY', OWNER: 'OWNED_BY',
    PARENT: 'CHILD_OF', FOLLOWER: 'FOLLOWS', FOLLOWEE: 'FOLLOWS',
    PATIENT: 'FOR_PATIENT', PHYSICIAN: 'SEEN_BY'
  };
  return map[base] || `HAS_${base}`;
}

/**
 * Transform parsed SQL schema → property graph model.
 * Returns { nodes, edges, decisions }
 */
export function toGraphModel(schema) {
  const nodes = [];
  const edges = [];
  const decisions = [];
  const junctionNames = new Set(schema.tables.filter((t) => t.junction).map((t) => t.name));

  for (const t of schema.tables) {
    if (t.junction) {
      const fks = t.columns.filter((c) => c.fk);
      if (fks.length === 2) {
        const [a, b] = fks;
        const props = t.columns
          .filter((c) => !c.fk && !c.pk)
          .map((c) => c.name);
        const verb = t.name.toUpperCase().replace(/S$/, '').replace(/^POST_/, 'TAGGED_');
        edges.push({
          type: verb,
          from: toLabel(a.fk.table),
          to: toLabel(b.fk.table),
          fromTable: a.fk.table,
          toTable: b.fk.table,
          properties: props,
          sourceTable: t.name,
          firstClass: true
        });
        decisions.push({
          table: t.name,
          action: 'edge',
          detail: `Junction table "${t.name}" becomes a first-class [:${verb}] relationship${props.length ? ` carrying properties (${props.join(', ')})` : ''}. Traversal replaces a 3-table JOIN.`
        });
      }
      continue;
    }

    const label = toLabel(t.name);
    nodes.push({
      label,
      sourceTable: t.name,
      properties: t.columns
        .filter((c) => !c.fk)
        .map((c) => ({ name: c.name, type: c.type, pk: c.pk, unique: c.unique }))
    });
    decisions.push({
      table: t.name,
      action: 'node',
      detail: `Entity table "${t.name}" becomes (:${label}) nodes. Primary key becomes a uniqueness constraint.`
    });
  }

  for (const r of schema.relationships) {
    if (junctionNames.has(r.from)) continue; // handled as first-class edges
    edges.push({
      type: relVerb(r.from, r.fromColumn),
      from: toLabel(r.from),
      to: toLabel(r.to),
      fromTable: r.from,
      toTable: r.to,
      properties: [],
      sourceColumn: r.fromColumn,
      firstClass: false
    });
  }

  return { nodes, edges, decisions };
}

/** Sample Cypher for the resulting model */
export function sampleCypher(graph) {
  const lines = ['// Uniqueness constraints'];
  for (const n of graph.nodes.slice(0, 6)) {
    const pk = n.properties.find((p) => p.pk);
    if (pk) lines.push(`CREATE CONSTRAINT FOR (n:${n.label}) REQUIRE n.${pk.name} IS UNIQUE;`);
  }
  lines.push('', '// Example traversal — no JOINs, just pattern matching:');
  const e = graph.edges.find((x) => x.firstClass) || graph.edges[0];
  if (e) {
    lines.push(
      `MATCH (a:${e.from})-[r:${e.type}]->(b:${e.to})`,
      `RETURN a, r, b LIMIT 25;`
    );
  }
  return lines.join('\n');
}
