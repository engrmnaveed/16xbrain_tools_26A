# 16xDataFlux — AI-Driven Database Modernization Mapper

Desktop tool by [16xBrains](https://16xbrains.com). Load a legacy SQL schema and watch it
visually **morph** into a modern document store (MongoDB-style) or property graph (Neo4j-style),
with JOIN-elimination analytics, indexing-bottleneck detection, and a deeply integrated AI layer
powered by any model on OpenRouter.

## Feature overview

**Deterministic core (works with no API key):**
- SQL DDL parser: `CREATE TABLE`, inline/table-level PK & FK, `UNIQUE`, `ON DELETE`, `CREATE INDEX`
- Document engine: embed vs reference heuristics (1:1 → sub-document, owned CASCADE children →
  embedded arrays, unbounded/shared tables → referenced collections, junction tables → dissolved into arrays)
- Graph engine: entity tables → node labels, FKs → typed edges, junction tables → first-class
  relationships with properties
- Animated morph canvas: cards fly, shrink, and dissolve between the three views; pan/zoom
- Analysis report: JOINs eliminated (count + %), worst-case JOIN chain with the actual SQL,
  unindexed foreign keys, hot tables, read amplification per model
- Export: full modernization blueprint as JSON; AI scripts saveable to disk
- 4 preset schemas (e-commerce, healthcare, social, banking) + open your own `.sql`

**AI layer (OpenRouter, any model — Claude, GPT-4o, Gemini, Llama…):**
1. **Strategy advisor** — phased migration plan grounded in the parsed schema + engine decisions
2. **Decision second-opinions** — click any engine decision for an AI critique with flip conditions
3. **Bottleneck explainer** — production symptom + interim `CREATE INDEX` fix per issue
4. **Migration script generator** — runnable MongoDB ETL (Node.js) or Neo4j Cypher skeleton
5. **Grounded assistant** — chat that answers about *your* loaded schema, not generically
6. **AI schema generator** — type a domain ("airline booking system"), get realistic legacy DDL

The AI never guesses blind: every call receives the parsed schema, the deterministic engine's
decisions and the performance report as context.

## Run it (development)

Requires Node.js 18+ (20+ recommended).

```bash
npm install
npm run dev        # Vite dev server + Electron with hot reload
```

## Test the core logic

```bash
npm test           # smoke-tests parser, both engines, analysis and layouts on all presets
```

## Build installers

```bash
npm run dist:mac   # → release/16xDataFlux-1.0.0.dmg   (arm64 + x64; run on macOS)
npm run dist:win   # → release/16xDataFlux Setup 1.0.0.exe  (NSIS; run on Windows)
npm run dist       # current platform
```

Notes:
- Build each installer on its native OS (or use a CI matrix — see below). Windows installers can
  also be cross-built on macOS with Wine, but native is more reliable.
- For distribution without scary warnings: sign + notarize on macOS (set `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `CSC_LINK` env vars for electron-builder) and code-sign on
  Windows (`CSC_LINK` / `CSC_KEY_PASSWORD`). Unsigned builds still run via right-click → Open
  (macOS) or "More info → Run anyway" (Windows SmartScreen).

Suggested GitHub Actions matrix:

```yaml
strategy:
  matrix:
    os: [macos-latest, windows-latest]
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: 20 }
  - run: npm ci && npm run dist
```

## OpenRouter setup (for AI features)

1. Get a key at https://openrouter.ai/keys
2. In the app: **🔑 Set API key** (top-right) → paste → pick a model → Save

The key is stored in the OS user-data directory (`app.getPath('userData')`) and only read by the
Electron **main process** — it is never exposed to the renderer/UI layer. All AI traffic goes
directly from your machine to `openrouter.ai`.

## Architecture

```
electron/main.cjs      window, secure settings store, OpenRouter proxy (IPC), file dialogs
electron/preload.cjs   contextBridge API (window.dataflux)
src/lib/sqlParser.js   DDL → schema model (tables, FKs, indexes, junction detection)
src/lib/nosqlTransform.js  schema → document model + per-table decisions
src/lib/graphTransform.js  schema → property graph + decisions, sample Cypher
src/lib/analysis.js    JOIN chains, unindexed FKs, hot tables, modernization report
src/lib/layout.js      per-mode positions powering the CSS-transition morph
src/lib/ai.js          the six AI features (all schema-grounded)
src/components/        Canvas (morph viz), Sidebar, Inspector (4 tabs), Modals (settings/docs)
website/dataflux.html  tool page for 16xbrains.com
```

Security posture: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, external
links forced to the system browser, API key isolated in the main process.

## Internal use at 16xBrains

Pre-migration design review: load a client's DDL → screenshot the morph for the proposal →
check unindexed FKs before quoting → export the blueprint JSON → hand the generated ETL
skeleton to the implementation team as the starting contract.
