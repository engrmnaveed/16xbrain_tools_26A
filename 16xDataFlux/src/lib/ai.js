// ---------------------------------------------------------------------------
// 16xDataFlux — Deep AI Integration (via OpenRouter, proxied through main proc)
// Not a bolt-on chatbox: the AI receives the full parsed schema, the
// deterministic engine's decisions, and the performance report as context,
// and powers five distinct features across the app.
// ---------------------------------------------------------------------------

const hasBridge = () => typeof window !== 'undefined' && window.dataflux;

function schemaContext(schema, docModel, graphModel, report) {
  return JSON.stringify(
    {
      tables: schema.tables.map((t) => ({
        name: t.name,
        junction: !!t.junction,
        columns: t.columns.map((c) => ({
          name: c.name, type: c.type, pk: c.pk, fk: c.fk ? `${c.fk.table}.${c.fk.column}` : null,
          onDelete: c.fk?.onDelete || null
        }))
      })),
      relationships: schema.relationships,
      indexes: schema.indexes,
      engineDecisions: {
        document: docModel?.decisions,
        graph: graphModel?.decisions
      },
      performanceReport: report
        ? {
            joinsEliminated: `${report.eliminated}/${report.totalJoins}`,
            longestJoinChain: report.longestChain,
            unindexedFks: report.unindexedFks.map((u) => `${u.table}.${u.column}`),
            hotTables: report.hotTables
          }
        : null
    },
    null,
    1
  );
}

const SYSTEM = `You are the embedded AI engine of 16xDataFlux, a database modernization mapper by 16xBrains. You are a principal data engineer. You receive a parsed SQL schema plus the deterministic transformation engine's decisions and performance analysis. Be precise, concrete, and concise. Refer to actual table/column names. Never invent tables that don't exist.`;

async function chat(messages, { json = false, maxTokens = 2048 } = {}) {
  if (!hasBridge()) return { error: 'NO_BRIDGE' };
  return window.dataflux.aiChat({ messages: [{ role: 'system', content: SYSTEM }, ...messages], json, maxTokens });
}

/** 1. Migration Strategy Advisor — full narrative assessment */
export function adviseMigrationStrategy(ctx) {
  return chat([
    {
      role: 'user',
      content: `Here is the workload context:\n${schemaContext(ctx.schema, ctx.docModel, ctx.graphModel, ctx.report)}\n\nProduce a migration strategy assessment with EXACTLY these markdown sections:\n## Verdict\nOne sentence: document store, graph, or hybrid — and why.\n## Key Wins\n3 bullets naming specific eliminated JOINs and what user-facing operation gets faster.\n## Risks & Mitigations\n2-3 bullets on real risks in THIS schema (consistency, unbounded arrays, fan-out writes).\n## Phased Rollout\nA numbered 3-phase plan (strangler-fig style) naming which tables move first and why.`
    }
  ], { maxTokens: 1600 });
}

/** 2. Per-table decision review — AI critiques one engine decision */
export function reviewDecision(ctx, tableName) {
  const d =
    ctx.docModel.decisions.find((x) => x.table === tableName) ||
    ctx.graphModel.decisions.find((x) => x.table === tableName);
  return chat([
    {
      role: 'user',
      content: `Context:\n${schemaContext(ctx.schema, ctx.docModel, ctx.graphModel, ctx.report)}\n\nThe engine decided for table "${tableName}": ${d?.action} — "${d?.detail}".\nIn under 120 words: do you agree? Mention one workload condition under which you would flip this decision, and what to measure to know.`
    }
  ], { maxTokens: 400 });
}

/** 3. Bottleneck explainer — turns a detected issue into an actionable note */
export function explainBottleneck(ctx, issue) {
  return chat([
    {
      role: 'user',
      content: `Context:\n${schemaContext(ctx.schema, ctx.docModel, ctx.graphModel, ctx.report)}\n\nDetected issue: ${issue.message}\nIn under 100 words: explain the concrete production symptom this causes (query pattern + what the user experiences), and give the exact CREATE INDEX statement to fix it in the interim before migration.`
    }
  ], { maxTokens: 350 });
}

/** 4. Migration script generator — produces runnable ETL skeleton */
export function generateMigrationScript(ctx, target) {
  const spec =
    target === 'graph'
      ? 'Neo4j: Cypher LOAD CSV / apoc statements creating constraints, nodes, then relationships'
      : 'MongoDB: a Node.js ETL script using the mysql2 and mongodb drivers that reads each SQL table and writes the designed collections, honouring the embed/reference decisions';
  return chat([
    {
      role: 'user',
      content: `Context:\n${schemaContext(ctx.schema, ctx.docModel, ctx.graphModel, ctx.report)}\n\nGenerate a runnable migration script skeleton for: ${spec}. Follow the engine's decisions exactly (embed what it embedded, reference what it referenced, dissolve junctions as designed). Include brief comments. Output ONLY a fenced code block.`
    }
  ], { maxTokens: 3000 });
}

/** 5. Inline schema Q&A — grounded assistant */
export function askSchema(ctx, history, question) {
  return chat(
    [
      {
        role: 'user',
        content: `You will answer questions about this specific modernization project. Context:\n${schemaContext(ctx.schema, ctx.docModel, ctx.graphModel, ctx.report)}`
      },
      { role: 'assistant', content: 'Understood. I have the schema, both target models, and the performance report loaded. Ask away.' },
      ...history,
      { role: 'user', content: question }
    ],
    { maxTokens: 1000 }
  );
}

/** 6. AI schema generator — describe a domain, get DDL back */
export async function generateSchemaFromDescription(description) {
  const res = await chat(
    [
      {
        role: 'user',
        content: `Generate a realistic legacy relational SQL schema (MySQL-flavoured DDL) for this domain: "${description}". 6–10 tables, proper PRIMARY KEY / FOREIGN KEY ... REFERENCES constraints, at least one junction table, a couple of CREATE INDEX statements, and at least one FK deliberately left unindexed. Output ONLY the SQL inside one fenced sql code block.`
      }
    ],
    { maxTokens: 2500 }
  );
  if (res.error) return res;
  const m = res.content.match(/```(?:sql)?\n([\s\S]*?)```/);
  return { ...res, sql: m ? m[1].trim() : res.content.trim() };
}

export function extractCode(text) {
  const m = (text || '').match(/```[\w]*\n([\s\S]*?)```/);
  return m ? m[1].trim() : text;
}
