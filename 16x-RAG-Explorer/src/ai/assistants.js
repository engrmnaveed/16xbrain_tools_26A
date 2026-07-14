// Deep AI integration points — not a chat bolt-on.
// Each assistant is a focused, structured LLM call wired into a pipeline stage.

import { chat, chatStream, extractJson } from './openrouter.js';

// ---------- 1. Grounded answer with inline citations (final RAG stage) ----------
export function answerWithContext(apiKey, model, query, chunks, onToken, signal) {
  const context = chunks
    .map((c, i) => `[${i + 1}] (${c.docName}, similarity ${c.score.toFixed(3)})\n${c.text}`)
    .join('\n\n---\n\n');
  return chatStream(
    apiKey,
    model,
    [
      {
        role: 'system',
        content:
          'You are a retrieval-grounded assistant. Answer ONLY from the provided context chunks. ' +
          'Cite sources inline as [1], [2] matching chunk numbers. ' +
          'If the context does not contain the answer, say so plainly — never invent facts. ' +
          'Be concise and well-structured.'
      },
      { role: 'user', content: `Context chunks:\n\n${context}\n\nQuestion: ${query}` }
    ],
    onToken,
    { signal }
  );
}

// ---------- 2. Retrieval Quality Auditor (debugging stage) ----------
export async function auditRetrieval(apiKey, model, query, chunks) {
  const listing = chunks
    .map((c, i) => `[${i + 1}] score=${c.score.toFixed(3)} doc="${c.docName}"\n${c.text.slice(0, 400)}`)
    .join('\n\n');
  const raw = await chat(
    apiKey,
    model,
    [
      {
        role: 'system',
        content:
          'You are a RAG retrieval auditor. Judge each retrieved chunk for relevance to the query. ' +
          'Respond with JSON only: {"verdicts":[{"index":1,"relevant":true,"reason":"..."}],' +
          '"coverage":"full|partial|poor","missing":"what info seems missing, or null",' +
          '"advice":"one concrete tuning suggestion"}'
      },
      { role: 'user', content: `Query: ${query}\n\nRetrieved chunks:\n${listing}` }
    ],
    { json: true }
  );
  return extractJson(raw);
}

// ---------- 3. Query expansion / HyDE (pre-embedding stage) ----------
export async function expandQuery(apiKey, model, query) {
  const raw = await chat(
    apiKey,
    model,
    [
      {
        role: 'system',
        content:
          'Rewrite the user query as a short hypothetical passage (2-3 sentences) that would ' +
          'appear in a document answering it (HyDE technique). Respond with JSON only: ' +
          '{"hypothetical":"...","keywords":["...","..."]}'
      },
      { role: 'user', content: query }
    ],
    { json: true }
  );
  return extractJson(raw);
}

// ---------- 4. Corpus-aware query suggestions (onboarding / empty state) ----------
export async function suggestQueries(apiKey, model, docs) {
  const samples = docs
    .slice(0, 6)
    .map((d) => `# ${d.name}\n${d.text.slice(0, 600)}`)
    .join('\n\n');
  const raw = await chat(
    apiKey,
    model,
    [
      {
        role: 'system',
        content:
          'Given document excerpts, propose 4 diverse, specific questions a user could ask that ' +
          'these documents can answer. JSON only: {"questions":["..."]}'
      },
      { role: 'user', content: samples }
    ],
    { json: true }
  );
  return extractJson(raw).questions || [];
}

// ---------- 5. Chunking Strategy Advisor (settings stage) ----------
export async function adviseChunking(apiKey, model, docs, currentStrategy, currentOptions, stats) {
  const samples = docs.slice(0, 4).map((d) => `# ${d.name}\n${d.text.slice(0, 500)}`).join('\n\n');
  const raw = await chat(
    apiKey,
    model,
    [
      {
        role: 'system',
        content:
          'You are a RAG chunking expert. Given corpus samples, corpus stats, and the current strategy, ' +
          'recommend the best chunking setup. JSON only: ' +
          '{"strategy":"fixed|sentence|paragraph","chunkSize":512,"overlap":64,' +
          '"reasoning":"2-3 sentences explaining why for THIS corpus"}'
      },
      {
        role: 'user',
        content:
          `Current: strategy=${currentStrategy}, options=${JSON.stringify(currentOptions)}\n` +
          `Stats: ${JSON.stringify(stats)}\n\nCorpus samples:\n${samples}`
      }
    ],
    { json: true }
  );
  return extractJson(raw);
}
