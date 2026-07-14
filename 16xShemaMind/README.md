# SchemaMind

**AI-assisted data schema design studio** — brainstorm to production-class schema, in one place.
A [16xbrains](https://16xbrains.com) tool. Desktop app for macOS and Windows (Electron + React + Vite).

---

## What it does

- **Visual ER designer** — draggable table nodes on an infinite canvas, crow's-foot-style relation edges (1:1, N:1, N:M), zoom/pan/fit, auto-layout, live validation (duplicate names, missing PKs, broken refs).
- **SchemaScript** — the whole schema is also a plain-text DSL. Edit either the diagram or the script; they stay in sync. Line-numbered errors, live validation, ⌘/Ctrl+Enter to apply.
- **Plain-English design (AI)** — type *"a food delivery app with restaurants, menus, orders and riders"* and get a normalized schema on the canvas.
- **Deep AI assistance via OpenRouter** (no chatbox — actions live where you work):
  - ✦ Suggest missing fields per table (accept individually)
  - ✦ Full schema review with score + severity-ranked findings
  - ✦ Detect missing relations
  - ✦ Generate onboarding documentation (Markdown)
  - Works with any OpenRouter model id (Claude, GPT, Gemini, Llama, DeepSeek…).
- **Import**: SQL DDL (PostgreSQL/MySQL/SQLite), JSON samples (nested → related tables), CSV, Excel workbooks, SchemaScript/DBML-like text, SchemaMind project files.
- **Export**: PostgreSQL / MySQL / SQLite DDL, Mongoose models, MongoDB collection validators, Prisma schema, TypeScript interfaces, JSON Schema, DBML, Markdown data dictionary, Excel data-dictionary workbook.
- **Random data generator** — name-aware and type-aware fake data (emails, prices, cities, slugs…), FK values sampled from real parent rows in dependency order (referential integrity guaranteed), seeded/reproducible, per-table row counts. Export JSON / CSV / Excel / SQL INSERTs / Mongo `insertMany`.
- **JSON workbench** — collapsible tree viewer, schema inference from any payload.
- **Local-first** — projects are single portable `.schemamind.json` files. No accounts, no cloud. The only network traffic is your own OpenRouter calls.

## Requirements

- Node.js ≥ 18 (20+ recommended) and npm

## Run in development

```bash
npm install
npm run dev        # starts Vite + Electron with hot reload
```

## Run the core tests

```bash
npm test           # DSL, importers, exporters, data generator (no deps needed)
```

## Build installers

```bash
npm run dist:mac   # .dmg + .zip (arm64 + x64)  — run on macOS
npm run dist:win   # NSIS installer + portable .exe (x64) — run on Windows
npm run dist       # current platform
```

Output lands in `release/`. Notes:

- **macOS signing/notarization**: unsigned builds run locally (right-click → Open). For distribution, set `CSC_LINK`/`CSC_KEY_PASSWORD` and add a `notarize` config with your Apple ID team — see electron-builder docs.
- **Windows**: unsigned builds trigger SmartScreen; sign with a code-signing cert via `CSC_LINK` when publishing.
- **Cross-building** Windows installers from macOS generally works; building macOS from Windows does not. CI (GitHub Actions with a matrix of `macos-latest` / `windows-latest` running `npm run dist`) is the smoothest release path.

## Using AI features

1. Get a key at `openrouter.ai/keys`.
2. In the app: **Settings → AI**, paste the key, pick a model (default `anthropic/claude-sonnet-4.5`).
3. The key is stored in local app storage on your machine and sent only to OpenRouter.

## Project layout

```
electron/         main process + preload (dialogs, menus, file I/O)
src/model/        core schema model, type system, validation, topo-sort
src/dsl/          SchemaScript parser + serializer (two-way)
src/io/           importers (SQL/JSON/CSV/Excel), exporters (10 formats), file bridge
src/datagen/      seeded, relation-aware fake data generator
src/ai/           OpenRouter client + task prompts (English→schema, review, suggest…)
src/components/   React UI (canvas, inspector, script, data, JSON, docs, settings)
tests/            node-based smoke tests for all core engines
site/             the tools page for 16xbrains.com
```

## SchemaScript in 20 seconds

```
table users {
  id uuid pk
  email string unique !null
  role enum(admin, member) default(member)
  created_at datetime default(now) index
}

table orders {
  id int pk default(autoincrement)
  total decimal !null
}

ref orders.user_id > users.id          // N:1  (FK auto-created if missing)
ref profiles.user_id - users.id        // 1:1
ref posts.id <> tags.id                // N:M
```

Types: `uuid int bigint float decimal string text boolean date datetime time json binary enum` ·
Modifiers: `pk unique !null index default(…) note("…")`

---

© 16xbrains — MIT license.
