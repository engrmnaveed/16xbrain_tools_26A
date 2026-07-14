// Smoke test for the deterministic core (run: node tests/smoke.mjs)
import { parseSchema, schemaStats } from '../src/lib/sqlParser.js';
import { toDocumentModel, collectionToJson } from '../src/lib/nosqlTransform.js';
import { toGraphModel, sampleCypher } from '../src/lib/graphTransform.js';
import { modernizationReport, exampleJoinQuery } from '../src/lib/analysis.js';
import { sqlLayout, docLayout, graphLayout, edgesForMode } from '../src/lib/layout.js';
import { PRESETS } from '../src/lib/presets.js';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) failures++;
};

for (const preset of PRESETS) {
  console.log(`\n=== Preset: ${preset.name} ===`);
  const schema = parseSchema(preset.sql);
  const stats = schemaStats(schema);
  check(`parses tables (${stats.tables})`, stats.tables >= 6);
  check(`finds relationships (${stats.relationships})`, stats.relationships >= 5);
  check(`no parse errors`, schema.errors.length === 0);

  const doc = toDocumentModel(schema);
  check(`document collections (${doc.collections.length})`, doc.collections.length > 0 && doc.collections.length < stats.tables);
  check(`eliminates joins (${doc.eliminatedJoins.length}/${stats.relationships})`, doc.eliminatedJoins.length > 0);
  check(`every table has a decision`, schema.tables.every((t) => doc.decisions.some((d) => d.table === t.name)));

  const graph = toGraphModel(schema);
  check(`graph nodes (${graph.nodes.length})`, graph.nodes.length > 0);
  check(`graph edges (${graph.edges.length})`, graph.edges.length > 0);

  const report = modernizationReport(schema, doc, graph);
  check(`report elimination pct (${report.eliminationPct}%)`, report.eliminationPct >= 0 && report.eliminationPct <= 100);
  check(`join chain found (${report.longestChain.length} tables)`, report.longestChain.length >= 2);

  const l1 = sqlLayout(schema), l2 = docLayout(schema, doc), l3 = graphLayout(schema, graph);
  check(`layouts cover all tables`, [l1, l2, l3].every((l) => schema.tables.every((t) => l.positions.has(t.name))));
  check(`edges computable in all modes`, ['sql', 'doc', 'graph'].every((m) => Array.isArray(edgesForMode(m, schema, doc, graph))));

  check(`sample json renders`, collectionToJson(doc.collections[0]).length > 10);
  check(`sample cypher renders`, sampleCypher(graph).includes('MATCH'));
  const jq = exampleJoinQuery(schema);
  check(`example join query`, !!jq && jq.query.includes('JOIN'));
}

// Junction detection specifics (social preset)
const social = parseSchema(PRESETS.find((p) => p.id === 'social').sql);
check('\nfollows detected as junction', social.tables.find((t) => t.name === 'follows')?.junction === true);
check('post_hashtags detected as junction', social.tables.find((t) => t.name === 'post_hashtags')?.junction === true);
const socialGraph = toGraphModel(social);
check('junctions become first-class edges', socialGraph.edges.filter((e) => e.firstClass).length >= 2);

console.log(failures ? `\n${failures} FAILURES` : '\nAll smoke tests passed ✔');
process.exit(failures ? 1 : 0);
