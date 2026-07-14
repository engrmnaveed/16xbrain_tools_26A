# RAG Explorer

**See exactly how AI reads your data.** A cross-platform desktop app (macOS + Windows) by [16xBrains](https://16xbrains.com) that visualizes Retrieval-Augmented Generation: documents become a 3D galaxy of embeddings, queries fly into it, and retrieval beams show precisely which chunks ground the LLM's answer.

Built with Electron, React, Three.js, transformers.js (local embeddings), and OpenRouter (LLM layer).

---

## Features

- **3D Embedding Galaxy** — every chunk is a star, positioned by PCA-projected embeddings; documents form colored constellations. After a query the galaxy becomes a similarity heatmap with retrieval beams to the top-K chunks. Hover to preview, click to inspect.
- **Pipeline X-ray view** — the same run as animated stages: (HyDE expansion) → local embedding (with the real 384-dim vector rendered) → cosine search with live scores → grounded generation with [1][2] citations. Per-stage timings.
- **100% local embeddings** — `Xenova/all-MiniLM-L6-v2` via transformers.js. Documents never leave the machine; the ~25 MB model downloads once and is cached.
- **Deep OpenRouter AI integration** (any model — Claude, GPT, Gemini, Llama, DeepSeek, custom IDs):
  - Streaming grounded answers with inline citations (refuses to answer beyond context)
  - **Retrieval Auditor** — per-chunk relevance verdicts, coverage rating, one concrete tuning suggestion
  - **Chunking Advisor** — reads corpus samples, recommends strategy/size/overlap, one-click apply + re-index
  - **HyDE query expansion** — LLM writes a hypothetical answer passage that embeds closer to real document text
  - **Corpus-aware query suggestions** above the query bar
- **Real debugging controls** — chunking strategy (fixed / sentence-aware / paragraph), chunk size, overlap, top-K, score threshold. Every change re-indexes in seconds.
- **Ingestion** — PDF (pdf.js), Markdown, TXT, HTML, CSV. Plus a one-click realistic sample corpus.
- **Built-in docs** — full usage guide behind the `?` button.
- Corpus + settings persist locally between sessions.

## Project layout

```
├── electron/            # main process + preload (CommonJS)
│   ├── main.cjs         # window, file dialogs, local persistence IPC
│   └── preload.cjs      # contextBridge API (window.ragx)
├── src/
│   ├── engine/          # chunker, embedder, vectorStore, PCA projection, ingestion
│   ├── ai/              # OpenRouter client + the 5 AI assistants
│   ├── components/      # GalaxyView (Three.js), PipelineView, panels, modals
│   ├── store.js         # zustand store — orchestrates the whole pipeline
│   └── sampleDocs.js    # bundled demo corpus
├── tests/engine.test.mjs  # engine smoke tests (npm test)
├── site/rag-explorer.html # marketing + docs page for 16xbrains.com/tools
└── package.json           # electron-builder config included
```

## Run it

Requires **Node 20+**.

```bash
npm install
npm run dev        # Vite dev server + Electron with hot reload
```

Other commands:

```bash
npm test           # engine unit tests (no model download needed)
npm run start      # production build + run locally
```

First app launch downloads the embedding model (~25 MB) from HuggingFace; everything after that is offline (except optional OpenRouter calls).

## Package & publish

```bash
npm run dist:mac   # → release/RAG Explorer-1.0.0-arm64.dmg (+ x64)
npm run dist:win   # → release/RAG Explorer Setup 1.0.0.exe (NSIS installer)
npm run dist       # current platform
```

Notes:

- **Build on the target OS** (or use CI with a mac + windows matrix). Cross-building Windows on macOS works via electron-builder; macOS artifacts must be built on macOS.
- **macOS signing/notarization**: unsigned .dmg works but shows Gatekeeper warnings. For distribution set `CSC_LINK`/`CSC_KEY_PASSWORD` (Developer ID cert) and add `notarize: true` under `build.mac` with your Apple ID env vars (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
- **Windows signing**: optional; set `CSC_LINK` to a code-signing cert to avoid SmartScreen warnings.
- Suggested CI: GitHub Actions with `matrix: [macos-latest, windows-latest]` running `npm ci && npm run dist`, uploading `release/*` as artifacts.

## Publish on 16xbrains.com

1. Upload `site/rag-explorer.html` to the site (e.g. as `/tools/rag-explorer/index.html`). It's fully self-contained — inline CSS + a dependency-free animated hero. Add a "Tools" link to it from the main nav.
2. Upload the packaged installers to `/downloads/` (or link GitHub Releases) and update the two download hrefs in the page:
   - `RAG-Explorer-1.0.0-arm64.dmg` (macOS)
   - `RAG-Explorer-Setup-1.0.0.exe` (Windows)

## OpenRouter setup (in-app)

Settings (⚙) → paste an API key from [openrouter.ai/keys](https://openrouter.ai/keys) → pick a model. The key is stored locally in the app's userData folder and is only ever sent to `openrouter.ai`. Without a key the app still does full retrieval visualization — AI features simply stay dormant.

## Privacy model

| Data | Where it goes |
|---|---|
| Documents, chunks, embeddings | Local only, always |
| Embedding model | Downloaded once from HuggingFace CDN |
| Query + retrieved chunk texts | OpenRouter, only when AI features are used |
| API key, settings, corpus | Local app data folder |

## License

MIT © 16xBrains
