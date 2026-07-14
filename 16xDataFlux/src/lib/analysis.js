// ---------------------------------------------------------------------------
// 16xDataFlux — Performance & Bottleneck Analysis
// JOIN-chain detection, unindexed-FK detection, hot-table scoring,
// estimated read amplification before/after modernization.
// ---------------------------------------------------------------------------

/** FKs that have no supporting index → classic bottleneck */
export function findUnindexedForeignKeys(schema) {
  const indexed = new Set();
  for (const idx of schema.indexes) {
    indexed.add(`${idx.table}.${idx.columns[0]}`);
  }
  // PK columns are implicitly indexed
  for (const t of schema.tables) {
    for (const c of t.columns) {
      if (c.pk || c.unique) indexed.add(`${t.name}.${c.name}`);
    }
  }
  const issues = [];
  for (const r of schema.relationships) {
    if (!indexed.has(`${r.from}.${r.fromColumn}`)) {
      issues.push({
        table: r.from,
        column: r.fromColumn,
        references: r.to,
        severity: 'high',
        message: `FK ${r.from}.${r.fromColumn} → ${r.to} has no index. Every JOIN on it forces a full table scan; DELETEs on ${r.to} lock-scan ${r.from}.`
      });
    }
  }
  return issues;
}

/** Longest JOIN chains needed to assemble a "page" of data in SQL */
export function findJoinChains(schema, maxDepth = 5) {
  const adj = new Map();
  for (const r of schema.relationships) {
    if (!adj.has(r.from)) adj.set(r.from, []);
    adj.get(r.from).push(r.to);
    if (!adj.has(r.to)) adj.set(r.to, []);
    adj.get(r.to).push(r.from);
  }
  let best = [];
  const seen = new Set();
  const dfs = (node, path) => {
    if (path.length > maxDepth) return;
    if (path.length > best.length) best = [...path];
    for (const nxt of adj.get(node) || []) {
      if (!path.includes(nxt)) dfs(nxt, [...path, nxt]);
    }
  };
  for (const t of schema.tables) {
    if (seen.has(t.name)) continue;
    dfs(t.name, [t.name]);
  }
  return best;
}

/** Tables involved in the most relationships = hot spots under load */
export function hotTables(schema) {
  const score = new Map();
  for (const r of schema.relationships) {
    score.set(r.to, (score.get(r.to) || 0) + 2); // being referenced is hotter
    score.set(r.from, (score.get(r.from) || 0) + 1);
  }
  return [...score.entries()]
    .map(([table, s]) => ({ table, score: s }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/**
 * Headline metrics for the report.
 * Read amplification: SQL page-load touches N tables via JOINs;
 * document model touches ~1 + remaining refs; graph touches the pattern only.
 */
export function modernizationReport(schema, docModel, graphModel) {
  const totalJoins = schema.relationships.length;
  const eliminated = docModel.eliminatedJoins.length;
  const remaining = docModel.remainingRefs.length;
  const chain = findJoinChains(schema);
  const unindexed = findUnindexedForeignKeys(schema);

  const sqlReads = Math.max(1, chain.length);
  const docReads = Math.max(1, Math.ceil(remaining / Math.max(1, docModel.collections.length)) + 1);

  return {
    totalJoins,
    eliminated,
    remaining,
    eliminationPct: totalJoins ? Math.round((eliminated / totalJoins) * 100) : 0,
    longestChain: chain,
    unindexedFks: unindexed,
    hotTables: hotTables(schema),
    collections: docModel.collections.length,
    graphNodes: graphModel.nodes.length,
    graphEdges: graphModel.edges.length,
    readAmplification: {
      sql: sqlReads,
      document: Math.min(docReads, sqlReads),
      graph: 1
    }
  };
}

/** Example "before" SQL query for the longest chain (for the report + AI) */
export function exampleJoinQuery(schema) {
  const chain = findJoinChains(schema);
  if (chain.length < 2) return null;
  const lines = [`SELECT *`, `FROM ${chain[0]}`];
  for (let i = 1; i < chain.length; i++) {
    const rel = schema.relationships.find(
      (r) =>
        (r.from === chain[i] && r.to === chain[i - 1]) ||
        (r.from === chain[i - 1] && r.to === chain[i])
    );
    if (!rel) continue;
    const [a, b] = rel.from === chain[i] ? [chain[i], chain[i - 1]] : [chain[i - 1], chain[i]];
    lines.push(`  JOIN ${chain[i]} ON ${a}.${rel.fromColumn} = ${b}.${rel.toColumn}`);
  }
  lines.push(`WHERE ${chain[0]}.id = ?;`);
  return { query: lines.join('\n'), tablesTouched: chain.length };
}
