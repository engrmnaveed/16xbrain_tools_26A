import { create } from 'zustand';
import { chunkDocument, STRATEGIES } from './engine/chunker.js';
import { embedTexts, embedText, onModelProgress } from './engine/embedder.js';
import { VectorStore } from './engine/vectorStore.js';
import { pca3 } from './engine/projection.js';
import { ingestFiles, makeDocId } from './engine/ingest.js';
import { SAMPLE_DOCS } from './sampleDocs.js';
import * as ai from './ai/assistants.js';
import { suggestQueries } from './ai/assistants.js';

const bridge = typeof window !== 'undefined' && window.ragx
  ? window.ragx
  : { // browser-dev fallback
      openFiles: async () => [],
      storeLoad: async () => JSON.parse(localStorage.getItem('ragx') || 'null'),
      storeSave: async (d) => localStorage.setItem('ragx', JSON.stringify(d)),
      platform: 'web'
    };

const vectorStore = new VectorStore();

export const useStore = create((set, get) => ({
  // ---------- corpus ----------
  docs: [],
  chunks: [], // enriched with vector + pos
  isIndexing: false,
  indexProgress: null, // { done, total, phase }
  modelDownload: null, // { file, pct }

  // ---------- settings ----------
  settings: {
    apiKey: '',
    model: 'anthropic/claude-sonnet-4.5',
    topK: 5,
    strategy: 'sentence',
    chunkSize: 512,
    overlap: 64,
    useHyde: false,
    scoreThreshold: 0.25
  },

  // ---------- pipeline run ----------
  run: null,
  // run = { query, stage, stages: {embed:{...}, search:{...}, audit, generate},
  //         queryPos, top, all, answer, expansion, audit, error }

  // ---------- ui ----------
  view: 'galaxy', // 'galaxy' | 'pipeline'
  selectedChunk: null,
  showSettings: false,
  showDocs: false,
  suggestions: [],
  toast: null,

  setView: (view) => set({ view }),
  selectChunk: (selectedChunk) => set({ selectedChunk }),
  setShowSettings: (showSettings) => set({ showSettings }),
  setShowDocs: (showDocs) => set({ showDocs }),
  notify: (msg, kind = 'info') => {
    set({ toast: { msg, kind, ts: Date.now() } });
    setTimeout(() => {
      if (get().toast?.msg === msg) set({ toast: null });
    }, 4500);
  },

  // ---------- persistence ----------
  init: async () => {
    onModelProgress((p) => set({ modelDownload: p }));
    const saved = await bridge.storeLoad();
    if (saved?.settings) set({ settings: { ...get().settings, ...saved.settings } });
    if (saved?.docs?.length) {
      set({ docs: saved.docs });
      await get().reindex();
    }
  },

  persist: async () => {
    const { settings, docs } = get();
    await bridge.storeSave({ settings, docs });
  },

  saveSettings: async (patch) => {
    const prev = get().settings;
    const settings = { ...prev, ...patch };
    set({ settings });
    await get().persist();
    // Re-chunk if chunking params changed
    if (
      patch.strategy !== undefined && patch.strategy !== prev.strategy ||
      patch.chunkSize !== undefined && patch.chunkSize !== prev.chunkSize ||
      patch.overlap !== undefined && patch.overlap !== prev.overlap
    ) {
      await get().reindex();
    }
  },

  // ---------- corpus actions ----------
  loadSample: async () => {
    const docs = SAMPLE_DOCS.map((d) => ({
      id: makeDocId(), name: d.name, text: d.text, chars: d.text.length
    }));
    set({ docs: [...get().docs, ...docs] });
    await get().persist();
    await get().reindex();
  },

  addFiles: async () => {
    const files = await bridge.openFiles();
    if (!files.length) return;
    try {
      const docs = await ingestFiles(files);
      if (!docs.length) {
        get().notify('No readable text found in the selected files.', 'warn');
        return;
      }
      set({ docs: [...get().docs, ...docs] });
      await get().persist();
      await get().reindex();
    } catch (e) {
      get().notify(`Ingestion failed: ${e.message}`, 'error');
    }
  },

  removeDoc: async (docId) => {
    set({ docs: get().docs.filter((d) => d.id !== docId), run: null, selectedChunk: null });
    await get().persist();
    await get().reindex();
  },

  clearCorpus: async () => {
    vectorStore.clear();
    set({ docs: [], chunks: [], run: null, selectedChunk: null, suggestions: [] });
    await get().persist();
  },

  // ---------- indexing ----------
  reindex: async () => {
    const { docs, settings } = get();
    vectorStore.clear();
    if (!docs.length) {
      set({ chunks: [], run: null });
      return;
    }
    set({ isIndexing: true, run: null, selectedChunk: null });
    try {
      const options = { chunkSize: settings.chunkSize, overlap: settings.overlap };
      const allChunks = docs.flatMap((d) => chunkDocument(d, settings.strategy, options));
      set({ indexProgress: { done: 0, total: allChunks.length, phase: 'Embedding chunks' } });

      const vectors = await embedTexts(
        allChunks.map((c) => c.text),
        (done, total) => set({ indexProgress: { done, total, phase: 'Embedding chunks' } })
      );

      set({ indexProgress: { done: allChunks.length, total: allChunks.length, phase: 'Projecting to 3D' } });
      const { positions, project } = pca3(vectors);

      const chunks = allChunks.map((c, i) => ({ ...c, vector: vectors[i], pos: positions[i] }));
      vectorStore.addAll(chunks);
      set({ chunks, _project: project });
    } catch (e) {
      get().notify(`Indexing failed: ${e.message}`, 'error');
    } finally {
      set({ isIndexing: false, indexProgress: null, modelDownload: null });
    }
  },

  _project: null,

  corpusStats: () => {
    const { docs, chunks } = get();
    const lens = chunks.map((c) => c.text.length);
    return {
      documents: docs.length,
      chunks: chunks.length,
      avgChunkChars: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
      totalChars: docs.reduce((a, d) => a + d.chars, 0)
    };
  },

  // ---------- the pipeline ----------
  abortController: null,

  runQuery: async (query) => {
    const { settings, chunks, _project } = get();
    if (!chunks.length) {
      get().notify('Add documents first — try the sample corpus.', 'warn');
      return;
    }
    get().abortController?.abort();
    const abortController = new AbortController();
    set({ abortController, selectedChunk: null });

    const run = {
      query, stage: 'embed', startedAt: Date.now(),
      queryPos: null, top: [], all: [], answer: '', expansion: null, audit: null, error: null,
      timings: {}
    };
    set({ run: { ...run } });
    const update = (patch) => {
      run.timings = { ...run.timings, ...(patch.timings || {}) };
      Object.assign(run, patch);
      set({ run: { ...run } });
    };

    try {
      // Stage 0 (optional): AI query expansion (HyDE)
      let textToEmbed = query;
      if (settings.useHyde && settings.apiKey) {
        update({ stage: 'expand' });
        const t0 = performance.now();
        try {
          const expansion = await ai.expandQuery(settings.apiKey, settings.model, query);
          textToEmbed = `${query}\n${expansion.hypothetical}`;
          update({ expansion, timings: { expand: performance.now() - t0 } });
        } catch (e) {
          update({ expansion: { error: e.message }, timings: { expand: performance.now() - t0 } });
        }
      }

      // Stage 1: embed query
      update({ stage: 'embed' });
      let t = performance.now();
      const queryVector = await embedText(textToEmbed);
      const queryPos = _project ? _project(queryVector) : [0, 0, 0];
      update({ queryPos, queryVector, timings: { embed: performance.now() - t } });

      // Stage 2: vector search
      update({ stage: 'search' });
      t = performance.now();
      const { top, all } = vectorStore.search(queryVector, settings.topK);
      const kept = top.filter((c) => c.score >= settings.scoreThreshold);
      update({
        top: kept.length ? kept : top.slice(0, Math.min(2, top.length)),
        all: all.map(({ id, score }) => ({ id, score })),
        timings: { search: performance.now() - t }
      });

      // Stage 3: generate grounded answer (needs API key)
      if (settings.apiKey) {
        update({ stage: 'generate' });
        t = performance.now();
        await ai.answerWithContext(
          settings.apiKey, settings.model, query, run.top,
          (_tok, full) => update({ answer: full }),
          abortController.signal
        );
        update({ timings: { generate: performance.now() - t } });
      } else {
        update({
          answer:
            '*(No OpenRouter API key set — showing retrieval only. Add a key in Settings to generate grounded answers.)*'
        });
      }

      update({ stage: 'done' });
    } catch (e) {
      if (e.name !== 'AbortError') update({ stage: 'error', error: e.message });
    }
  },

  // AI: audit the current retrieval
  runAudit: async () => {
    const { settings, run } = get();
    if (!run?.top?.length || !settings.apiKey) return;
    set({ run: { ...run, auditLoading: true } });
    try {
      const audit = await ai.auditRetrieval(settings.apiKey, settings.model, run.query, run.top);
      set({ run: { ...get().run, audit, auditLoading: false } });
    } catch (e) {
      set({ run: { ...get().run, audit: { error: e.message }, auditLoading: false } });
    }
  },

  // AI: suggest queries from corpus
  loadSuggestions: async () => {
    const { settings, docs } = get();
    if (!docs.length || !settings.apiKey) return;
    try {
      const suggestions = await suggestQueries(settings.apiKey, settings.model, docs);
      set({ suggestions });
    } catch { /* non-critical */ }
  },

  // AI: chunking advisor
  chunkAdvice: null,
  chunkAdviceLoading: false,
  runChunkAdvisor: async () => {
    const { settings, docs } = get();
    if (!docs.length || !settings.apiKey) return;
    set({ chunkAdviceLoading: true, chunkAdvice: null });
    try {
      const advice = await ai.adviseChunking(
        settings.apiKey, settings.model, docs,
        settings.strategy,
        { chunkSize: settings.chunkSize, overlap: settings.overlap },
        get().corpusStats()
      );
      set({ chunkAdvice: advice, chunkAdviceLoading: false });
    } catch (e) {
      set({ chunkAdvice: { error: e.message }, chunkAdviceLoading: false });
    }
  },

  applyChunkAdvice: async () => {
    const a = get().chunkAdvice;
    if (!a || a.error) return;
    set({ chunkAdvice: null, showSettings: false });
    await get().saveSettings({
      strategy: STRATEGIES[a.strategy] ? a.strategy : 'sentence',
      chunkSize: Math.min(4000, Math.max(128, a.chunkSize || 512)),
      overlap: Math.min(512, Math.max(0, a.overlap ?? 64))
    });
  }
}));
