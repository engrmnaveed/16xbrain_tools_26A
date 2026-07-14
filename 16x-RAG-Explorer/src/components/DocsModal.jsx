import { useStore } from '../store.js';

const SECTIONS = [
  {
    title: 'What is RAG Explorer?',
    body: `RAG (Retrieval-Augmented Generation) is how an AI answers questions from YOUR documents instead of guessing from its training data. RAG Explorer makes every step of that process visible: it turns your documents into a galaxy of meaning, shows your question flying into it, and highlights exactly which passages the AI reads before it answers.

Two audiences, one tool: show clients that answers are grounded in their real data (not hallucinated), and give engineers X-ray vision for debugging retrieval quality.`
  },
  {
    title: 'Quick start (60 seconds)',
    body: `1. Click "Load sample corpus" in the left panel — five realistic company documents are chunked and embedded locally.
2. Type a question like "How many vacation days do employees get?" and press Enter.
3. Watch the galaxy: the white pulsing point is your question; beams connect it to the chunks it retrieved. Warm colors = high similarity.
4. Switch to Pipeline view (top bar) to see the same run broken into stages with timings.
5. Add an OpenRouter API key in Settings to unlock grounded answers and all AI features.`
  },
  {
    title: 'Reading the galaxy',
    body: `Every star is one chunk of a document, positioned by a PCA projection of its 384-dimensional embedding — chunks that mean similar things sit close together, so documents form natural constellations (colored per document).

After a query: the view switches to a similarity heatmap. Deep blue = irrelevant, orange = warm, white-hot = retrieved into context. Beams connect the query to the top-K chunks. Hover any star for a preview; click to open the full chunk in the inspector.

Debugging tip: if the beams reach into the wrong constellation, your retrieval is off — try different chunking, enable HyDE, or rephrase. If the right chunks are near the query but not retrieved, raise Top K or lower the score threshold.`
  },
  {
    title: 'The pipeline stages',
    body: `Query expansion (optional, AI) — HyDE: an LLM writes a short hypothetical answer and that gets embedded instead of the raw query. Questions and answers are phrased differently; embedding a fake answer often lands closer to real document text.

Embed — a local sentence-transformer (all-MiniLM-L6-v2) turns text into a 384-dim vector on your machine. No document or query text leaves your computer for this step.

Vector search — cosine similarity between the query vector and every chunk vector. Top K above the threshold become the context. Scores are shown on every result.

Grounded generation — the chunks are injected into the prompt and the model (via OpenRouter) must answer only from them, citing [1], [2]… If context is insufficient, it says so instead of inventing an answer.`
  },
  {
    title: 'AI features (OpenRouter)',
    body: `Add a key in Settings (stored locally, only sent to openrouter.ai). Pick any model — Claude, GPT, Gemini, Llama, DeepSeek, or a custom model ID.

• Grounded answers with inline citations, streamed live.
• Retrieval Auditor — after a search, ask the AI to judge each retrieved chunk: relevant or off-target, what's missing, and one concrete tuning suggestion.
• Chunking Advisor (in Settings) — the AI reads samples of your corpus and recommends a strategy, chunk size and overlap, with reasoning. One click applies and re-indexes.
• Query suggestions — the AI reads your corpus and proposes questions it can actually answer.
• HyDE expansion — toggle in Settings.`
  },
  {
    title: 'Tuning retrieval (engineer notes)',
    body: `Chunking is the #1 lever. Too small: chunks lack context to be understood. Too large: multiple topics blur into one vector and similarity scores flatten. Start with sentence-aware at 512 chars, then compare.

Watch the score gap: a healthy retrieval shows a clear drop-off between relevant and irrelevant chunks. If all scores cluster around 0.3–0.5, your chunks are probably too long or the corpus needs cleaning.

Every setting change re-indexes instantly, so A/B testing a chunking strategy takes seconds: same query, different galaxy shape, different scores. The similarity heatmap makes regressions obvious.`
  },
  {
    title: 'Privacy & data',
    body: `Documents are parsed, chunked, and embedded entirely on this machine. The embedding model (~25 MB) is downloaded once from HuggingFace and cached.

Only when you use AI features are the query and the retrieved chunk texts (not whole documents) sent to OpenRouter. No key, no network calls. Corpus and settings persist locally in your app data folder.`
  }
];

export default function DocsModal() {
  const setShowDocs = useStore((s) => s.setShowDocs);
  return (
    <div className="modal-backdrop" onClick={() => setShowDocs(false)}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>How to use RAG Explorer</h2>
          <button className="btn-icon" onClick={() => setShowDocs(false)}>✕</button>
        </div>
        <div className="docs-content">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              {s.body.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
            </section>
          ))}
          <div className="docs-footer muted small">
            RAG Explorer · a 16xBrains tool · <a href="https://16xbrains.com" target="_blank" rel="noreferrer">16xbrains.com</a>
          </div>
        </div>
      </div>
    </div>
  );
}
